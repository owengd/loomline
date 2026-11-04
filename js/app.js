/* Schematic Tracer — app shell: loading (GitHub, local files, sample), navigation,
 * selection, inspector, search and settings. */
(function () {
  'use strict';
  const K = window.KiCore, R = window.KiRender;
  const $ = (id) => document.getElementById(id);
  const VERSION = '1.2.0';

  // ------------------------------------------------------------------ DOM helper
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'style') el.style.cssText = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const icon = (id) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#' + id); s.append(u); return s; };
  // Render KiCad markup (~{overbar}) safely as DOM.
  function markup(str) {
    const span = h('span');
    for (const r of K.markupRuns(K.unescape(String(str || '')))) {
      if (r.over) span.append(h('span', { class: 'ov', text: r.t }));
      else if (r.sub) span.append(h('sub', { text: r.t }));
      else if (r.sup) span.append(h('sup', { text: r.t }));
      else span.append(document.createTextNode(r.t));
    }
    return span;
  }
  const plain = (s) => K.plainText(K.unescape(String(s || '')));
  function ago(iso) {
    if (!iso) return '';
    const d = new Date(iso), s = (Date.now() - d.getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    if (s < 86400 * 14) return Math.round(s / 86400) + ' days ago';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  }
  const firstLine = (m) => String(m || '').split('\n')[0];

  // ------------------------------------------------------------------ state
  const state = {
    project: null, inst: null, sel: null, source: null,
    scenes: new Map(), views: new Map(), index: null,
    token: null, gh: Store.pref('gh') || { repo: '', ref: '', remember: true },
    ghProjects: null, ghHead: null, ghError: null, history: null, localProjects: null,
  };
  try { state.token = Store.pref('ghToken') || sessionStorage.getItem('st.ghToken') || null; } catch (e) { state.token = Store.pref('ghToken'); }

  // ------------------------------------------------------------------ view
  const narrow = () => window.matchMedia('(max-width: 759.98px)').matches;
  const view = new R.SchematicView($('canvas'), {
    // Deferred so the click that follows a touch can't land on a button this tap reveals.
    onTap: (wp, type) => setTimeout(() => onCanvasTap(wp, type), 30),
    onDoubleTap: (wp, x, y) => {
      const hit = view.hitTest(wp, 10);
      if (hit && hit.type === 'sheet') openChildSheet(hit.idx);
      else view.zoomBy(2, x, y);
    },
    onView: () => { if (!state._scaleRaf) state._scaleRaf = requestAnimationFrame(() => { state._scaleRaf = 0; renderScale(); }); }
  });

  // ------------------------------------------------------------------ theme
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    const t = Store.pref('theme') || 'auto';
    if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
    const dark = t === 'dark' || (t === 'auto' && mq.matches);
    view.setTheme(dark);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = dark ? '#1d1f22' : '#f7f5f0';
  }
  mq.addEventListener && mq.addEventListener('change', applyTheme);
  view.dimOthers = Store.pref('dim') === true;
  view.showGrid = Store.pref('grid') !== false;
  applyTheme();
  if (document.fonts && document.fonts.load) {
    Promise.all([document.fonts.load('16px "Plex Condensed"'), document.fonts.load('600 16px "Plex Condensed"')]).then(() => {
      R.clearMeasureCache();
      if (state.project) { state.scenes.clear(); showInstance(state.inst, true); }
    }).catch(() => {});
  }

  // ------------------------------------------------------------------ ui feedback
  let toastTimer = 0;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }
  function loading(msg) { $('loading').hidden = !msg; if (msg) $('loadingMsg').textContent = msg; }
  function banner(kind, msg, actions) {
    const b = $('banner');
    if (!msg) { b.hidden = true; return; }
    b.className = 'banner ' + (kind || 'info');
    $('bannerMsg').textContent = msg;
    const a = $('bannerActions'); a.replaceChildren();
    for (const act of actions || []) a.append(h('button', { class: 'btn small' + (act.primary ? ' primary' : ''), onclick: act.run, text: act.label }));
    a.append(h('button', { class: 'iconbtn', 'aria-label': 'Dismiss', onclick: () => { b.hidden = true; } }, icon('i-close')));
    b.hidden = false;
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied ' + text); }
    catch (e) { toast(text); }
  }

  // ------------------------------------------------------------------ loading projects
  function openProject(files, source) {
    const t0 = performance.now();
    const project = K.buildProject(files);
    state.project = project;
    state.source = source;
    state.scenes.clear(); state.views.clear();
    state.sel = null;
    state.index = buildIndex(project);
    $('welcome').hidden = true;
    updateHeader();
    const hash = readHash();
    let inst = project.root;
    if (hash.p && source && hash.p === source.key && hash.s) inst = project.instances.find((i) => i.namePath === hash.s) || inst;
    showInstance(inst);
    renderSelectionUI();
    if (hash.p && source && hash.p === source.key) {
      if (hash.n) { const net = project.nets.find((n) => n.name === hash.n); if (net) selectNet(net); }
      else if (hash.r) { const hit = findRef(hash.r); if (hit) selectSymbol(hit.inst, hit.si, true); }
    }
    if (project.errors.length) banner('err', `${project.errors.length} file(s) could not be read: ${project.errors.map((e) => K.basename(e.path)).join(', ')}`);
    console.info('Opened', project.name, Math.round(performance.now() - t0) + ' ms', project.nets.length + ' nets');
  }

  function updateHeader() {
    const p = state.project, s = state.source;
    $('projName').textContent = p ? p.name : 'Schematic Tracer';
    $('netCount').textContent = p ? p.nets.filter((n) => !n.bus && (n.named || n.pins.length > 1)).length : 0;
    $('partCount').textContent = p && state.index ? state.index.parts.length : 0;
    let rev = 'No project open';
    if (s && s.kind === 'github') rev = `${s.ref} · ${s.head.sha.slice(0, 7)} · ${ago(s.projCommit ? s.projCommit.date : s.head.date)}`;
    else if (s && s.kind === 'local') rev = 'From this device';
    else if (s && s.kind === 'sample') rev = 'Sample · KiCad demo';
    $('projRev').textContent = rev;
    document.title = p ? p.name + ' · Schematic Tracer' : 'Schematic Tracer';
  }

  async function loadSample() {
    loading('Opening sample…');
    try {
      const names = ['complex_hierarchy.kicad_pro', 'complex_hierarchy.kicad_sch', 'ampli_ht.kicad_sch'];
      const files = [];
      for (const n of names) {
        const r = await fetch('samples/complex_hierarchy/' + n);
        if (!r.ok) throw new Error('Sample file missing: ' + n);
        files.push({ path: 'complex_hierarchy/' + n, text: await r.text() });
      }
      openProject(files, { kind: 'sample', key: 'sample' });
      Store.pref('last', { kind: 'sample' });
    } catch (e) { banner('err', e.message); }
    loading(null);
  }

  // ---------------------------------------------------- local files
  $('fileInput').addEventListener('change', async (e) => {
    const list = Array.from(e.target.files || []);
    e.target.value = '';
    if (!list.length) return;
    loading('Reading files…');
    try {
      const files = [];
      for (const f of list) {
        if (/\.zip$/i.test(f.name)) {
          const entries = await Zip.readZip(await f.arrayBuffer(), (p) => /\.kicad_(sch|pro)$/i.test(p) && !/(^|\/)(_autosave-|~)|-backups\//.test(p));
          for (const en of entries) files.push({ path: en.path, text: new TextDecoder().decode(await en.bytes()) });
        } else if (/\.kicad_(sch|pro)$/i.test(f.name)) {
          files.push({ path: f.webkitRelativePath || f.name, text: await f.text() });
        }
      }
      if (!files.some((f) => /\.kicad_sch$/i.test(f.path))) throw new Error('No KiCad schematics (.kicad_sch) in what you picked. KiCad 5 .sch files need to be opened and saved in KiCad 6 or newer first.');
      const groups = groupProjects(files.map((f) => ({ path: f.path, text: f.text })));
      if (groups.length === 1) openLocal(groups[0], files);
      else { state.localProjects = { groups, files }; loading(null); openDrawer('drawerProjects'); renderProjects(); return; }
    } catch (err) { banner('err', err.message); }
    loading(null);
  });
  function openLocal(group, files) {
    const set = new Set(group.files.map((f) => f.path));
    const chosen = files.filter((f) => set.has(f.path));
    openProject(chosen, { kind: 'local', key: 'local:' + group.key, name: group.name });
    Store.set('local:last', { name: group.name, key: group.key, files: chosen });
    Store.pref('last', { kind: 'local' });
  }
  async function reopenLocal() {
    const saved = await Store.get('local:last');
    if (!saved || !saved.files) return false;
    openProject(saved.files, { kind: 'local', key: 'local:' + saved.key, name: saved.name });
    return true;
  }

  // ---------------------------------------------------- GitHub
  function setToken(token, remember) {
    state.token = token || null;
    try { sessionStorage.setItem('st.ghToken', token || ''); } catch (e) { /* ignore */ }
    Store.pref('ghToken', remember && token ? token : null);
  }
  async function pool(items, n, fn) {
    const out = new Array(items.length); let i = 0;
    const workers = Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } });
    await Promise.all(workers);
    return out;
  }
  async function ghRefresh(opts) {
    opts = opts || {};
    const { repo } = state.gh;
    if (!repo || !state.token) return null;
    state.ghError = null;
    if (!state.gh.ref) {
      const info = await GitHub.repo(state.token, repo);
      state.gh.ref = info.default_branch; Store.pref('gh', state.gh);
    }
    const head = opts.commit || await GitHub.head(state.token, repo, state.gh.ref);
    const tree = await GitHub.kicadTree(state.token, repo, head.tree);
    state.ghHead = head;
    state.ghProjects = groupProjects(tree.files);
    state.ghTruncated = tree.truncated;
    return head;
  }
  async function openGitHubProject(key, opts) {
    opts = opts || {};
    const repo = state.gh.repo;
    const proj = state.ghProjects && state.ghProjects.find((p) => p.key === key);
    if (!proj) throw new Error('That project is no longer in ' + repo + '@' + state.gh.ref + '.');
    let done = 0;
    const need = proj.files;
    loading(`Downloading ${need.length} file${need.length === 1 ? '' : 's'}…`);
    const texts = await pool(need, 6, async (f) => {
      const t = await GitHub.blobText(state.token, repo, f.sha);
      done++; $('loadingMsg').textContent = `Downloading files… ${done}/${need.length}`;
      return { path: f.path, text: t };
    });
    let projCommit = null;
    try { projCommit = (await GitHub.history(state.token, repo, state.ghHead.sha, proj.dir || '', 1))[0] || null; } catch (e) { /* optional */ }
    const source = { kind: 'github', repo, ref: state.gh.ref, key: 'gh:' + repo + ':' + key, projKey: key, dir: proj.dir, head: state.ghHead, projCommit, pinned: !!opts.pinned };
    openProject(texts, source);
    state.history = null;
    if (!opts.pinned) {
      Store.set('manifest:' + repo + ':' + key, { head: state.ghHead, ref: state.gh.ref, files: need, projCommit, at: Date.now() });
      Store.pref('last', { kind: 'github', key });
      banner(null);
    } else {
      banner('old', `Viewing an older revision ${state.ghHead.sha.slice(0, 7)} from ${new Date(state.ghHead.date).toLocaleDateString()}.`, [{ label: 'Back to latest', primary: true, run: () => connectAndOpen(key) }]);
    }
  }
  async function connectAndOpen(key, opts) {
    loading('Checking GitHub for the latest revision…');
    try {
      await ghRefresh(opts);
      if (!key && state.ghProjects.length === 1) key = state.ghProjects[0].key;
      if (key && state.ghProjects.some((p) => p.key === key)) await openGitHubProject(key, opts);
      else { loading(null); openDrawer('drawerProjects'); }
      renderProjects();
    } catch (e) {
      state.ghError = e.message;
      // Offline / failure: fall back to the last downloaded copy.
      if (key && (!e.status || e.status >= 500)) {
        const ok = await openCachedGitHub(key, e.status ? e.message : 'GitHub could not be reached.');
        if (!ok) banner('err', e.message);
      } else banner('err', e.message);
      renderProjects();
    }
    loading(null);
  }
  async function openCachedGitHub(key, reason) {
    const repo = state.gh.repo;
    const man = await Store.get('manifest:' + repo + ':' + key);
    if (!man) return false;
    const texts = [];
    for (const f of man.files) {
      const t = await Store.get('blob:' + f.sha);
      if (typeof t !== 'string') return false;
      texts.push({ path: f.path, text: t });
    }
    state.ghHead = man.head;
    const proj = { dir: man.files[0] ? K.dirname(man.files[0].path) : '' };
    openProject(texts, { kind: 'github', repo, ref: man.ref, key: 'gh:' + repo + ':' + key, projKey: key, dir: proj.dir, head: man.head, projCommit: man.projCommit, offline: true });
    banner('old', `Offline copy from ${new Date(man.at).toLocaleString()}. ${reason || ''}`.trim(), [{ label: 'Retry', run: () => connectAndOpen(key) }]);
    return true;
  }
  // Check for a newer commit when the app comes back to the foreground.
  let lastCheck = 0;
  async function checkForUpdate() {
    const s = state.source;
    if (!s || s.kind !== 'github' || s.pinned || !state.token || Date.now() - lastCheck < 60000) return;
    lastCheck = Date.now();
    try {
      const head = await GitHub.head(state.token, s.repo, s.ref);
      if (head.sha === s.head.sha) return;
      const tree = await GitHub.kicadTree(state.token, s.repo, head.tree);
      const groups = groupProjects(tree.files);
      const now = groups.find((p) => p.key === s.projKey);
      const before = state.ghProjects && state.ghProjects.find((p) => p.key === s.projKey);
      const sig = (p) => p ? p.files.map((f) => f.path + '@' + f.sha).sort().join('|') : '';
      if (sig(now) !== sig(before)) {
        banner('info', `New revision on ${s.ref}: “${firstLine(head.message)}” (${ago(head.date)}).`, [{ label: 'Load it', primary: true, run: () => connectAndOpen(s.projKey) }]);
      }
    } catch (e) { /* stay quiet when offline */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(); });
  setInterval(() => { if (document.visibilityState === 'visible') checkForUpdate(); }, 5 * 60 * 1000);

  // ------------------------------------------------------------------ navigation
  function sceneFor(inst) {
    let s = state.scenes.get(inst.idx);
    if (!s) {
      s = R.buildScene(state.project, inst);
      state.scenes.set(inst.idx, s);
      if (state.scenes.size > 8) state.scenes.delete(state.scenes.keys().next().value);
    }
    return s;
  }
  function showInstance(inst, keepView) {
    if (!inst) return;
    if (state.inst && state.inst !== inst) state.views.set(state.inst.idx, { scale: view.scale, ox: view.ox, oy: view.oy });
    const same = state.inst === inst;
    state.inst = inst;
    const scene = sceneFor(inst);
    const v = state.views.get(inst.idx);
    view.setScene(scene, true);
    if (keepView && same) { /* keep */ } else if (v) { view.scale = v.scale; view.ox = v.ox; view.oy = v.oy; } else view.fit();
    applyHighlight();
    $('sheetPage').textContent = inst.page + '/' + state.project.pageCount;
    $('sheetName').textContent = inst.parent ? inst.name : (inst.orphan ? inst.name : 'Root');
    $('btnSheets').title = inst.namePath + ' · ' + K.basename(inst.sheet.path);
    $('btnUp').disabled = !inst.parent;
    writeHash();
    renderStatus();
    if (state.panelOpen && state.tab !== 'info') { state._keepScroll = true; renderPanel(); }
  }
  function openChildSheet(sheetIdx) {
    const child = state.inst.children.find((c) => c.sheetSym === state.inst.sheet.sheets[sheetIdx]);
    if (child) { showInstance(child); toast('Opened ' + child.name); }
    else toast('That sheet’s file is not in this project.');
  }
  function netBoxOn(inst, net) {
    const groups = groupsFor(net, inst);
    if (!groups.size) return null;
    const S = sceneFor(inst);
    let bb = null;
    const grow = (b) => { bb = bb ? [Math.min(bb[0], b[0]), Math.min(bb[1], b[1]), Math.max(bb[2], b[2]), Math.max(bb[3], b[3])] : b.slice(); };
    for (const s of S.strokes) if (s.g >= 0 && groups.has(s.g)) grow(s.bb);
    for (const c of S.circles) if (c.g >= 0 && groups.has(c.g)) grow(c.bb);
    for (const l of S.hitLabels) if (groups.has(l.g)) grow(l.bb);
    return bb;
  }
  function groupsFor(net, inst) {
    const set = new Set(net.inst.get(inst.idx) || []);
    if (net.bus && net.members) for (const m of net.members) if (m.net >= 0) for (const g of state.project.nets[m.net].inst.get(inst.idx) || []) set.add(g);
    return set;
  }

  // ------------------------------------------------------------------ selection
  function onCanvasTap(wp, type) {
    if (!state.project) return;
    const hit = view.hitTest(wp, type === 'mouse' ? 8 : 16);
    if (!hit) { clearSelection(); return; }
    if (hit.type === 'net') {
      const net = state.project.nets[state.inst.netOf[hit.g]];
      if (net) selectNet(net);
    } else if (hit.type === 'symbol') selectSymbol(state.inst, hit.si);
    else if (hit.type === 'sheet') selectSheet(state.inst, hit.idx);
  }
  function applyHighlight() {
    const s = state.sel, inst = state.inst;
    if (!s || !inst) { view.setHighlight(null); return; }
    if (s.type === 'net') view.setHighlight(groupsFor(s.net, inst), -1, -1);
    else if (s.type === 'symbol') view.setHighlight(null, s.inst === inst ? s.si : -1, -1);
    else if (s.type === 'sheet') view.setHighlight(null, -1, s.inst === inst ? s.idx : -1);
  }
  function selectNet(net) {
    state.sel = { type: 'net', net };
    applyHighlight();
    if (state.panelOpen && (state.tab === 'info' || state.tab === 'parts')) showTab('nets');
    renderSelectionUI();
    writeHash();
  }
  function selectSymbol(inst, si, focus) {
    if (inst !== state.inst) showInstance(inst);
    state.sel = { type: 'symbol', inst, si };
    applyHighlight();
    if (state.panelOpen && state.tab === 'nets') showTab('info');
    renderSelectionUI();
    writeHash();
    if (focus) { const b = symBox(inst, si); if (b) { view.animateTo(b); view.flashBox(b); } }
  }
  function selectSheet(inst, idx) {
    state.sel = { type: 'sheet', inst, idx };
    applyHighlight();
    if (state.panelOpen && state.tab === 'nets') showTab('info');
    renderSelectionUI();
  }
  function clearSelection() {
    state.sel = null;
    applyHighlight();
    renderSelectionUI();
    writeHash();
  }
  function symBox(inst, si) { const s = sceneFor(inst).syms.find((x) => x.si === si); return s ? s.bb : null; }
  function goToNetOn(inst, net) {
    if (inst !== state.inst) showInstance(inst);
    applyHighlight();
    const b = netBoxOn(inst, net);
    if (b) view.animateTo(b);
  }
  function goToPin(p) {
    const inst = state.project.instances[p.inst];
    if (inst !== state.inst) showInstance(inst);
    const sym = inst.sheet.symbols[p.sym];
    const pin = K.symbolPins(sym).find((x) => x.number === p.number);
    const b = pin ? [Math.min(pin.pos[0], pin.root[0]) - 2, Math.min(pin.pos[1], pin.root[1]) - 2, Math.max(pin.pos[0], pin.root[0]) + 2, Math.max(pin.pos[1], pin.root[1]) + 2] : symBox(inst, p.sym);
    if (b) {
      const sb = symBox(inst, p.sym) || b;
      const box = [Math.min(b[0], sb[0]), Math.min(b[1], sb[1]), Math.max(b[2], sb[2]), Math.max(b[3], sb[3])];
      view.animateTo(box);
      view.flashBox(b);
    }
  }

  // ------------------------------------------------------------------ side panel + tool rail
  // The rail on the right (bottom on phones) opens a panel next to it, like the KiCad Editor app.
  const wideLayout = () => window.matchMedia('(min-width: 761px)').matches;
  const TAB_TITLES = { sheets: 'SHEETS', nets: 'NET NAVIGATOR', parts: 'PARTS', info: 'PROPERTIES' };
  state.tab = 'sheets';
  state.panelOpen = false;
  function setPanel(open) {
    state.panelOpen = open;
    $('panel').hidden = !open;
    for (const b of document.querySelectorAll('.rail-btn')) b.setAttribute('aria-pressed', String(open && b.dataset.tab === state.tab));
    if (open) renderPanel();
    requestAnimationFrame(() => view.resize());
  }
  function showTab(tab, open) {
    state.tab = tab;
    $('panelTitle').textContent = TAB_TITLES[tab] || '';
    if (open && !state.panelOpen) setPanel(true);
    else { for (const b of document.querySelectorAll('.rail-btn')) b.setAttribute('aria-pressed', String(state.panelOpen && b.dataset.tab === tab)); renderPanel(); }
  }
  // On a phone the panel covers the drawing, so close it after a pick.
  function afterPick() { if (!wideLayout() && state.panelOpen) setPanel(false); }
  for (const b of document.querySelectorAll('.rail-btn')) b.addEventListener('click', () => {
    const tab = b.dataset.tab;
    if (tab === 'more') { openDrawer('drawerProjects'); return; }
    if (state.panelOpen && state.tab === tab) setPanel(false); else showTab(tab, true);
  });
  $('panelClose').addEventListener('click', () => setPanel(false));

  function section(title, extra, ...kids) {
    return h('div', { class: 'section' }, h('h3', null, h('span', { text: title }), extra ? h('span', { text: extra }) : null), ...kids);
  }
  function instLabel(inst) { return inst.parent ? inst.name : inst.orphan ? inst.name + ' (not in hierarchy)' : 'Root'; }
  function renderPanel() {
    if (!state.panelOpen) return;
    const body = $('panelBody');
    const top = body.scrollTop;
    body.replaceChildren();
    if (!state.project) { body.append(h('p', { class: 'empty', text: 'Open a project first.' })); return; }
    if (state.tab === 'sheets') renderHierarchy(body);
    else if (state.tab === 'nets') renderNetNavigator(body);
    else if (state.tab === 'parts') renderParts(body);
    else renderProperties(body);
    if (state._keepScroll) body.scrollTop = top;
    state._keepScroll = false;
  }
  // ---- Parts tab
  function renderParts(body) {
    const input = h('input', { class: 'input', type: 'search', placeholder: 'Filter: ref, value, footprint', value: state.partFilter || '', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    const list = h('div', { class: 'rows' });
    const sel = state.sel && state.sel.type === 'symbol' ? state.sel : null;
    const fill = () => {
      const q = input.value.trim().toLowerCase();
      state.partFilter = input.value;
      list.replaceChildren();
      const terms = q.split(/\s+/).filter(Boolean);
      const all = state.index.parts.filter((p) => terms.every((t) => p.hay.includes(t)));
      for (const p of all.slice(0, 300)) list.append(h('button', { class: 'row' + (sel && sel.inst === p.inst && sel.si === p.si ? ' current' : ''), onclick: () => { selectSymbol(p.inst, p.si, true); afterPick(); } },
        h('span', { class: 'main' }, h('span', { class: 'ref', text: p.ref + p.unit }), h('span', { class: 'nm', text: p.val })),
        h('span', { class: 'meta', text: 'p' + p.inst.page })));
      if (all.length > 300) list.append(h('div', { class: 'row' }, h('span', { class: 'meta', text: `${all.length - 300} more; type to narrow the list` })));
      if (!all.length) list.append(h('div', { class: 'row' }, h('span', { class: 'meta', text: 'No parts match.' })));
    };
    input.addEventListener('input', fill);
    fill();
    body.append(input, list);
  }

  // ---- Hierarchy tab
  function renderHierarchy(body) {
    const P = state.project;
    const net = state.sel && state.sel.type === 'net' ? state.sel.net : null;
    const tree = h('div', { class: 'rows tree' });
    const orphans = [];
    const walk = (inst) => {
      if (inst.orphan) { orphans.push(inst); return; }
      const count = net && net.inst.has(inst.idx) ? net.inst.get(inst.idx).length : 0;
      tree.append(h('button', { class: 'row' + (inst === state.inst ? ' current' : ''), style: `padding-left:${10 + inst.depth * 16}px`, onclick: () => { showInstance(inst); if (net && count) goToNetOn(inst, net); afterPick(); } },
        h('span', { class: 'pg', text: inst.page }),
        h('span', { class: 'nm2' }, h('b', { text: inst.parent ? inst.name : P.name }), h('small', { text: inst.parent ? K.basename(inst.sheet.path) : K.basename(inst.sheet.path) })),
        count ? h('span', { class: 'count', title: 'Highlighted net on this sheet', text: count }) : h('span')));
      for (const c of inst.children) walk(c);
    };
    for (const inst of P.instances) if (!inst.parent) walk(inst);
    body.append(section('Schematic hierarchy', P.instances.filter((i) => !i.orphan).length + ' sheets', tree));
    if (orphans.length) {
      const o = h('div', { class: 'rows tree' });
      const walkO = (inst) => {
        o.append(h('button', { class: 'row' + (inst === state.inst ? ' current' : ''), style: `padding-left:${10 + inst.depth * 16}px`, onclick: () => { showInstance(inst); afterPick(); } },
          h('span', { class: 'pg', text: '–' }), h('span', { class: 'nm2' }, h('b', { text: inst.name }), h('small', { text: K.basename(inst.sheet.path) })), h('span')));
        for (const c of inst.children) walkO(c);
      };
      orphans.forEach(walkO);
      body.append(section('Not in hierarchy', null, h('p', { class: 'hint', text: 'Schematic files in this folder that no sheet uses. KiCad ignores them; their nets are kept separate.' }), o));
    }
  }

  // ---- Net Navigator tab
  function renderNetNavigator(body) {
    const P = state.project;
    const s = state.sel;
    if (!s || s.type !== 'net') { renderNetList(body); return; }
    const net = s.net;
    const sheets = Array.from(net.inst.keys()).map((i) => P.instances[i]).sort((a, b) => a.order - b.order);
    body.append(h('div', { class: 'head' },
      h('div', { class: 'titles' },
        h('div', { class: 'eyebrow' }, h('span', { class: 'swatch' }), net.bus ? 'Highlighted bus' : 'Highlighted net'),
        h('div', { class: 'title net' }, markup(net.shortName)),
        h('div', { class: 'sub', text: [net.name !== net.shortName ? net.name : null, net.bus ? `${(net.members || []).length} members` : `${net.pins.length} pin${net.pins.length === 1 ? '' : 's'}`, `${sheets.length} sheet${sheets.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ') })),
      h('button', { class: 'iconbtn', 'aria-label': 'Copy net name', onclick: () => copy(plain(net.name)) }, icon('i-copy')),
      h('button', { class: 'iconbtn', 'aria-label': 'Clear highlight', onclick: clearSelection }, icon('i-close'))));
    const kinds = new Set(net.names.map((n) => n.kind));
    const chips = h('div', { class: 'chips' });
    if (kinds.has('power') || kinds.has('hiddenpower')) chips.append(h('span', { class: 'chip trace', text: 'Power' }));
    if (kinds.has('global')) chips.append(h('span', { class: 'chip', text: 'Global label' }));
    if (kinds.has('hier') || kinds.has('sheetpin')) chips.append(h('span', { class: 'chip', text: 'Crosses sheets' }));
    if (net.noConnect) chips.append(h('span', { class: 'chip', text: 'No-connect flag' }));
    if (!net.bus && net.pins.length === 1 && !net.noConnect && !net.hasPower) chips.append(h('span', { class: 'chip warn', text: 'Only one pin' }));
    if (chips.childNodes.length) body.append(chips);
    const names = new Map();
    for (const n of net.names) { if (!names.has(n.name)) names.set(n.name, new Set()); names.get(n.name).add(n.kind); }
    if (names.size > 1) {
      const c = h('div', { class: 'chips' });
      const label = { global: 'global', local: 'label', hier: 'hier. label', sheetpin: 'sheet pin', power: 'power', localpower: 'local power', hiddenpower: 'hidden pin' };
      for (const [n, ks] of names) c.append(h('span', { class: 'chip', title: Array.from(ks).map((k) => label[k] || k).join(', ') }, markup(n)));
      body.append(section('Also named', null, c));
    }
    body.append(h('div', { class: 'actions' }, h('button', { class: 'btn small', onclick: () => copyLink() }, icon('i-link'), 'Copy link')));
    if (net.bus) {
      const mr = h('div', { class: 'rows' });
      for (const m of net.members || []) {
        const mn = m.net >= 0 ? P.nets[m.net] : null;
        mr.append(h(mn ? 'button' : 'div', { class: 'row', onclick: mn ? () => selectNet(mn) : null },
          h('span', { class: 'main' }, h('span', { class: 'nm' }, markup(m.name))), h('span', { class: 'meta', text: mn ? `${mn.pins.length} pins` : 'not used' })));
      }
      body.append(section('Members', String((net.members || []).length), mr));
    }
    // Like KiCad's Net Navigator: the net's items grouped by sheet
    const tree = h('div', { class: 'rows' });
    for (const inst of sheets) {
      tree.append(h('button', { class: 'row group' + (inst === state.inst ? ' current' : ''), onclick: () => { goToNetOn(inst, net); afterPick(); } },
        h('span', { class: 'main' }, h('span', { class: 'pin', text: inst.page }), h('span', { class: 'nm', text: instLabel(inst) })),
        h('span', { class: 'meta', text: inst === state.inst ? 'this sheet' : 'go' })));
      for (const p of net.pins.filter((x) => x.inst === inst.idx)) {
        tree.append(h('button', { class: 'row indent', onclick: () => { goToPin(p); afterPick(); } },
          h('span', { class: 'main' }, h('span', { class: 'ref', text: p.fullRef || p.ref }), h('span', { class: 'pin', text: p.number }), h('span', { class: 'nm' }, p.name && p.name !== '~' && p.name !== p.number ? markup(p.name) : '')),
          h('span', { class: 'meta', text: (p.type || '').replace('_', ' ') })));
      }
      const labels = net.names.filter((n) => n.inst === inst.idx && !n.member && ['global', 'local', 'hier', 'power', 'localpower'].includes(n.kind));
      const seen = new Set();
      for (const l of labels) {
        const k = l.kind + l.name; if (seen.has(k)) continue; seen.add(k);
        const kindText = { global: 'global label', local: 'label', hier: 'hierarchical label', power: 'power', localpower: 'local power' }[l.kind];
        tree.append(h('div', { class: 'row indent' }, h('span', { class: 'main' }, h('span', { class: 'nm' }, markup(l.name))), h('span', { class: 'meta', text: kindText })));
      }
    }
    body.append(section('Items by sheet', null, tree));
  }
  // With nothing highlighted, the navigator lists every net so you can pick one.
  function renderNetList(body) {
    const P = state.project;
    const input = h('input', { class: 'input filter', type: 'search', placeholder: 'Filter nets', value: state.netFilter || '', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    const list = h('div', { class: 'rows' });
    const fill = () => {
      const q = input.value.trim().toLowerCase();
      state.netFilter = input.value;
      list.replaceChildren();
      const all = state.index.nets.filter((n) => n.net.named && (!q || n.hay.includes(q)));
      for (const n of all.slice(0, 250)) list.append(h('button', { class: 'row', onclick: () => { selectNet(n.net); const here = n.net.inst.has(state.inst.idx) ? state.inst : P.instances[Array.from(n.net.inst.keys()).sort((a, b) => P.instances[a].order - P.instances[b].order)[0]]; goToNetOn(here, n.net); afterPick(); } },
        h('span', { class: 'main' }, h('span', { class: 'nm' }, markup(n.net.name))), h('span', { class: 'meta', text: n.net.bus ? 'bus' : n.net.pins.length + ' pins' })));
      if (all.length > 250) list.append(h('div', { class: 'row' }, h('span', { class: 'meta', text: `${all.length - 250} more; type to narrow the list` })));
      if (!all.length) list.append(h('div', { class: 'row' }, h('span', { class: 'meta', text: 'No named nets match.' })));
    };
    input.addEventListener('input', fill);
    fill();
    body.append(h('p', { class: 'hint', text: 'Tap a wire on the schematic, or pick a net below, to highlight it.' }), input, list);
  }

  // ---- Properties tab
  function renderProperties(body) {
    const s = state.sel, P = state.project;
    if (!s || s.type === 'net') {
      body.append(h('p', { class: 'empty', text: s ? 'A net is highlighted. Tap a part or sheet to see its properties.' : 'Tap a part or sheet on the schematic to see its properties.' }));
      return;
    }
    if (s.type === 'symbol') {
      const inst = s.inst, sym = inst.sheet.symbols[s.si], ref = inst.refs[s.si].ref, lib = sym.lib;
      const unit = lib && lib.unitCount > 1 ? K.unitLetter(inst.refs[s.si].unit || sym.unit) : '';
      const prop = (n) => { const f = sym.props.find((p) => p.name === n); return f ? K.unescape(K.resolveVars(f.value, { inst, sym, ref })) : ''; };
      body.append(h('div', { class: 'head' },
        h('div', { class: 'titles' }, h('div', { class: 'eyebrow', text: lib && lib.power ? 'Power symbol' : 'Symbol' }), h('div', { class: 'title', text: ref + unit }), h('div', { class: 'sub', text: prop('Value') })),
        h('button', { class: 'iconbtn', 'aria-label': 'Copy reference', onclick: () => copy(ref) }, icon('i-copy')),
        h('button', { class: 'iconbtn', 'aria-label': 'Clear selection', onclick: clearSelection }, icon('i-close'))));
      const chips = h('div', { class: 'chips' });
      if (sym.dnp) chips.append(h('span', { class: 'chip warn', text: 'Do not populate' }));
      if (!sym.inBom) chips.append(h('span', { class: 'chip', text: 'Not in BOM' }));
      if (!sym.onBoard) chips.append(h('span', { class: 'chip', text: 'Not on board' }));
      if (unit) chips.append(h('span', { class: 'chip', text: `Unit ${unit} of ${lib.unitCount}` }));
      if (chips.childNodes.length) body.append(chips);
      body.append(h('div', { class: 'actions' },
        h('button', { class: 'btn small', onclick: () => { if (inst !== state.inst) showInstance(inst); const b = symBox(inst, s.si); if (b) { view.animateTo(b); view.flashBox(b); } afterPick(); } }, icon('i-target'), 'Zoom to symbol'),
        h('button', { class: 'btn small', onclick: () => copyLink() }, icon('i-link'), 'Copy link')));
      const dl = h('dl', { class: 'props' });
      const add = (k, v, link) => { if (!v || v === '~') return; dl.append(h('dt', { text: k }), h('dd', null, link && /^https?:\/\//i.test(v) ? h('a', { href: v, target: '_blank', rel: 'noopener', text: v }) : v)); };
      add('Reference', ref + unit);
      add('Value', prop('Value'));
      add('Footprint', prop('Footprint'));
      add('Datasheet', prop('Datasheet'), true);
      add('Description', prop('Description') || (lib && lib.props.ki_description) || '');
      for (const f of sym.props) {
        if (['Reference', 'Value', 'Footprint', 'Datasheet', 'Description'].includes(f.name) || f.name.startsWith('ki_') || f.name.startsWith('Sim.')) continue;
        add(f.name, K.unescape(K.resolveVars(f.value, { inst, sym, ref })), true);
      }
      add('Library link', sym.libId);
      add('Sheet', inst.namePath + ' (page ' + inst.page + ')');
      body.append(section('Fields', null, dl));
      const pins = K.symbolPins(sym).slice().sort((a, b) => K.naturalCmp(a.number, b.number));
      const pr = h('div', { class: 'rows' });
      for (const pin of pins) {
        const net = P.nets[inst.netOf[pin.group]];
        pr.append(h('button', { class: 'row', onclick: () => { selectNet(net); } },
          h('span', { class: 'main' }, h('span', { class: 'pin', text: pin.number }), h('span', { class: 'nm' }, pin.name && pin.name !== '~' ? markup(pin.name) : '')),
          h('span', { class: 'net' }, markup(net ? net.shortName : '–'))));
      }
      body.append(section('Pins', String(pins.length) + ' · tap to highlight', pr));
    } else if (s.type === 'sheet') {
      const inst = s.inst, sheet = inst.sheet.sheets[s.idx];
      const child = inst.children.find((c) => c.sheetSym === sheet);
      body.append(h('div', { class: 'head' },
        h('div', { class: 'titles' }, h('div', { class: 'eyebrow', text: 'Hierarchical sheet' }), h('div', { class: 'title', text: sheet.name || '(unnamed sheet)' }), h('div', { class: 'sub', text: sheet.file + (child ? ' · page ' + child.page : '') })),
        h('button', { class: 'iconbtn', 'aria-label': 'Clear selection', onclick: clearSelection }, icon('i-close'))));
      body.append(h('div', { class: 'actions' }, h('button', { class: 'btn primary small', disabled: !child, onclick: () => { if (child) { showInstance(child); afterPick(); } } }, icon('i-open'), child ? 'Enter sheet' : 'File not found')));
      const pr = h('div', { class: 'rows' });
      for (const pin of sheet.pins) {
        const net = P.nets[inst.netOf[pin.group]];
        pr.append(h('button', { class: 'row', onclick: () => selectNet(net) },
          h('span', { class: 'main' }, h('span', { class: 'nm' }, markup(pin.name))), h('span', { class: 'meta', text: pin.shape.replace('_', ' ') })));
      }
      if (sheet.pins.length) body.append(section('Sheet pins', String(sheet.pins.length) + ' · tap to highlight', pr));
    }
  }

  // ---- Status bar (bottom), like the KiCad Editor app
  function statusAction(label, ico, fn, disabled) {
    return h('button', { class: 'sa', onclick: fn, disabled: !!disabled }, icon(ico), label);
  }
  function renderStatus() {
    const s = state.sel, P = state.project;
    const ico = $('statusIco'), t1 = $('st1'), t2 = $('st2'), acts = $('statusActions');
    acts.replaceChildren();
    ico.classList.remove('trace', 'part');
    t1.classList.remove('trace');
    const setIco = (id) => { ico.firstElementChild.setAttribute('href', '#' + id); };
    if (!P) { setIco('i-hand'); t1.textContent = 'No project open'; t2.textContent = 'Connect GitHub or open files'; return; }
    if (!s) {
      setIco('i-hand');
      t1.textContent = 'Nothing selected';
      t2.textContent = 'Drag to pan, tap a wire to trace';
      acts.append(statusAction('FIT', 'i-fit', () => view.fit()));
      return;
    }
    if (s.type === 'net') {
      const net = s.net;
      setIco('i-net'); ico.classList.add('trace'); t1.classList.add('trace');
      t1.replaceChildren(markup(net.shortName));
      const sheets = net.inst.size;
      t2.textContent = (net.bus ? `Bus · ${(net.members || []).length} members` : `${net.pins.length} pin${net.pins.length === 1 ? '' : 's'}`) + ` · ${sheets} sheet${sheets === 1 ? '' : 's'}` + (net.name !== net.shortName ? ' · ' + plain(net.name) : '');
      acts.append(statusAction('ZOOM', 'i-target', () => zoomToSelection()));
      if (sheets > 1) acts.append(statusAction('NEXT', 'i-next', () => nextSheetForNet(net)));
      acts.append(statusAction('CLEAR', 'i-close', clearSelection));
    } else if (s.type === 'symbol') {
      const inst = s.inst, sym = inst.sheet.symbols[s.si], ref = inst.refs[s.si].ref;
      const unit = sym.lib && sym.lib.unitCount > 1 ? K.unitLetter(inst.refs[s.si].unit || sym.unit) : '';
      const val = K.unescape((sym.props.find((p) => p.name === 'Value') || {}).value || '');
      const fp = ((sym.props.find((p) => p.name === 'Footprint') || {}).value || '').split(':').pop();
      setIco('i-chip'); ico.classList.add('part');
      t1.textContent = ref + unit + (val ? '  ' + val : '');
      t2.textContent = fp || sym.libId;
      acts.append(statusAction('ZOOM', 'i-target', () => zoomToSelection()), statusAction('CLEAR', 'i-close', clearSelection));
    } else if (s.type === 'sheet') {
      const sheet = s.inst.sheet.sheets[s.idx];
      const child = s.inst.children.find((c) => c.sheetSym === sheet);
      setIco('i-hier'); ico.classList.add('part');
      t1.textContent = sheet.name;
      t2.textContent = sheet.file + ' · ' + sheet.pins.length + ' pins';
      acts.append(statusAction('ENTER', 'i-open', () => child && showInstance(child), !child), statusAction('CLEAR', 'i-close', clearSelection));
    }
  }
  $('statusMain').addEventListener('click', () => {
    if (!state.project) { openDrawer('drawerProjects'); return; }
    const s = state.sel;
    showTab(!s ? 'sheets' : s.type === 'net' ? 'nets' : 'info', true);
  });
  function nextSheetForNet(net) {
    const P = state.project;
    const list = Array.from(net.inst.keys()).map((i) => P.instances[i]).sort((a, b) => a.order - b.order);
    const i = list.indexOf(state.inst);
    const next = list[(i + 1) % list.length];
    goToNetOn(next, net);
    toast(`Sheet ${next.page}: ${instLabel(next)}`);
  }
  function zoomToSelection() {
    const s = state.sel; if (!s) return;
    if (s.type === 'net') { const here = s.net.inst.has(state.inst.idx) ? state.inst : state.project.instances[s.net.inst.keys().next().value]; goToNetOn(here, s.net); }
    else if (s.type === 'symbol') { if (s.inst !== state.inst) showInstance(s.inst); const b = symBox(s.inst, s.si); if (b) { view.animateTo(b); view.flashBox(b); } }
    else if (s.type === 'sheet' && s.inst === state.inst) { const b = sceneFor(s.inst).sheets.find((x) => x.idx === s.idx); if (b) view.animateTo(b.bb); }
  }
  // Scale chip (bottom left): a ruler one grid-dot apart, like the reference app
  function renderScale() {
    const chip = $('scaleChip');
    if (!state.project) { chip.hidden = true; return; }
    chip.hidden = false;
    chip.classList.toggle('off', !view.showGrid);
    const step = view.gridStep || 1.27;
    const px = Math.max(8, Math.min(140, step * view.scale));
    $('scaleRuler').style.width = px.toFixed(0) + 'px';
    $('scaleText').textContent = view.showGrid ? `dots ${step < 10 ? step.toFixed(2) : step.toFixed(1)} mm` : `${step < 10 ? step.toFixed(2) : step.toFixed(1)} mm · grid off`;
  }
  $('scaleChip').addEventListener('click', () => { view.showGrid = !view.showGrid; Store.pref('grid', view.showGrid); view.redraw(); renderScale(); });

  function renderSelectionUI() {
    renderStatus();
    if (state.panelOpen) { state._keepScroll = state.tab === 'sheets'; renderPanel(); }
  }

  // ------------------------------------------------------------------ drawers
  function openDrawer(id) {
    $(id).hidden = false;
    $('scrim').hidden = false;
    if (id === 'drawerProjects') renderProjects();
  }
  function closeDrawers() { $('drawerProjects').hidden = true; $('scrim').hidden = true; }
  $('scrim').addEventListener('click', closeDrawers);
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeDrawers));
  $('btnProjects').addEventListener('click', () => openDrawer('drawerProjects'));
  $('btnTitle').addEventListener('click', () => openDrawer('drawerProjects'));
  $('btnSettings').addEventListener('click', () => openDrawer('drawerProjects'));
  $('btnSheets').addEventListener('click', () => { if (state.project) showTab('sheets', true); });
  $('chipNets').addEventListener('click', () => { if (state.project) showTab('nets', true); });
  $('chipParts').addEventListener('click', () => { if (state.project) showTab('parts', true); });
  $('btnUp').addEventListener('click', () => { if (state.inst && state.inst.parent) showInstance(state.inst.parent); });

  function renderProjects() {
    const body = $('projectsBody'); body.replaceChildren();
    // --- local multi-project chooser
    if (state.localProjects) {
      const rows = h('div', { class: 'rows' });
      for (const g of state.localProjects.groups) rows.append(h('button', { class: 'row', onclick: () => { openLocal(g, state.localProjects.files); state.localProjects = null; closeDrawers(); } },
        h('span', { class: 'main' }, h('span', { class: 'nm', text: g.name })), h('span', { class: 'meta', text: g.dir || '/' })));
      body.append(section('Projects in your files', String(state.localProjects.groups.length), rows));
    }
    // --- GitHub
    const gh = state.gh;
    const ghSec = h('div', { class: 'section' }, h('h3', null, h('span', { text: 'GitHub' })));
    if (!state.token || !gh.repo) {
      const repoIn = h('input', { class: 'input', id: 'ghRepo', placeholder: 'your-org/schematics', value: gh.repo || '', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' });
      const refIn = h('input', { class: 'input', id: 'ghRef', placeholder: 'default branch', value: gh.ref || '', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' });
      const tokIn = h('input', { class: 'input', id: 'ghToken', type: 'password', placeholder: 'github_pat_… or ghp_…', autocomplete: 'off', spellcheck: 'false' });
      const rem = h('input', { type: 'checkbox', id: 'ghRemember', checked: gh.remember !== false });
      const err = h('p', { class: 'err-text', hidden: !state.ghError, text: state.ghError || '' });
      const go = h('button', { class: 'btn primary', onclick: async () => {
        const repo = repoIn.value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/$/, '');
        const token = tokIn.value.trim() || state.token;
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { err.hidden = false; err.textContent = 'Enter the repository as owner/name, for example team-australia/electronics.'; return; }
        if (!token) { err.hidden = false; err.textContent = 'Paste a fine-grained token with Contents: Read-only access to that repository.'; return; }
        state.gh = { repo, ref: refIn.value.trim(), remember: rem.checked };
        Store.pref('gh', state.gh);
        setToken(token, rem.checked);
        state.ghProjects = null;
        await connectAndOpen(null);
      } }, icon('i-git'), 'Connect');
      ghSec.append(
        h('div', { class: 'field' }, h('label', { for: 'ghRepo', text: 'Repository' }), repoIn),
        h('div', { class: 'field' }, h('label', { for: 'ghRef', text: 'Branch or tag (optional)' }), refIn),
        h('div', { class: 'field' }, h('label', { for: 'ghToken', text: 'Access token' }), tokIn),
        h('label', { class: 'check' }, rem, 'Remember the token on this device'),
        h('p', { class: 'hint' }, 'Create it at github.com → Settings → Developer settings → Fine-grained tokens. Resource owner: your organisation. Repository access: only the schematics repo. Permissions: ', h('code', { text: 'Contents: Read-only' }), '. If you are an outside collaborator on the repository rather than an org member, GitHub only allows a classic token with the ', h('code', { text: 'repo' }), ' scope.'),
        err, go);
    } else {
      const card = h('div', { class: 'repo-card' });
      const refSel = h('select', { class: 'input', 'aria-label': 'Branch', onchange: (e) => { state.gh.ref = e.target.value; Store.pref('gh', state.gh); connectAndOpen(state.source && state.source.projKey); } }, h('option', { value: gh.ref, text: gh.ref || 'default branch' }));
      GitHub.branches(state.token, gh.repo).then((list) => {
        refSel.replaceChildren(...list.map((b) => h('option', { value: b, selected: b === gh.ref, text: b })));
      }).catch(() => {});
      card.append(h('div', { class: 'top' }, h('span', { class: 'rname', text: gh.repo }),
        h('button', { class: 'iconbtn', 'aria-label': 'Check for the latest revision', onclick: () => connectAndOpen(state.source && state.source.kind === 'github' ? state.source.projKey : null) }, icon('i-refresh'))),
        h('div', { class: 'field' }, h('label', { text: 'Branch' }), refSel));
      if (state.ghHead) card.append(h('div', { class: 'commit' }, h('span', { class: 'msg', text: firstLine(state.ghHead.message) }), h('span', null, h('span', { class: 'sha', text: state.ghHead.sha.slice(0, 7) }), ' · ', state.ghHead.author || '', ' · ', ago(state.ghHead.date))));
      if (state.ghError) card.append(h('p', { class: 'err-text', text: state.ghError }));
      ghSec.append(card);
      if (state.ghProjects) {
        const rows = h('div', { class: 'rows' });
        for (const p of state.ghProjects) {
          const cur = state.source && state.source.kind === 'github' && state.source.projKey === p.key;
          rows.append(h('button', { class: 'row' + (cur ? ' current' : ''), onclick: async () => { closeDrawers(); loading('Opening ' + p.name + '…'); try { await openGitHubProject(p.key); } catch (e) { banner('err', e.message); } loading(null); } },
            h('span', { class: 'main' }, h('span', { class: 'nm2' }, h('b', { text: p.name }), h('small', { class: 'mono', text: p.dir || '/' }))),
            h('span', { class: 'meta', text: p.files.filter((f) => /\.kicad_sch$/i.test(f.path)).length + ' sheets' })));
        }
        if (!state.ghProjects.length) rows.append(h('div', { class: 'row' }, h('span', { class: 'nm', text: 'No KiCad projects found on this branch.' })));
        ghSec.append(section('Projects', String(state.ghProjects.length), rows));
        if (state.ghTruncated) ghSec.append(h('p', { class: 'hint', text: 'This repository is very large and GitHub returned a partial file list, so some projects may be missing.' }));
      } else if (!state.ghError) ghSec.append(h('button', { class: 'btn', onclick: () => connectAndOpen(null) }, icon('i-refresh'), 'Load project list'));
      // History for the open project
      if (state.source && state.source.kind === 'github') {
        const hist = h('div', { class: 'rows' });
        const s = state.source;
        const fill = (list) => {
          hist.replaceChildren();
          for (const c of list) hist.append(h('button', { class: 'row' + (c.sha === s.head.sha ? ' current' : ''), onclick: async () => { closeDrawers(); await connectAndOpen(s.projKey, { commit: c, pinned: true }); } },
            h('span', { class: 'main' }, h('span', { class: 'nm2' }, h('b', { text: firstLine(c.message) }), h('small', null, h('span', { class: 'mono', text: c.sha.slice(0, 7) }), ' · ' + (c.author || '') + ' · ' + ago(c.date))))));
        };
        if (state.history && state.history.key === s.key) fill(state.history.list);
        else {
          hist.append(h('div', { class: 'row' }, h('span', { class: 'nm', text: 'Loading recent changes…' })));
          GitHub.history(state.token, s.repo, s.ref, s.dir || '', 15).then((list) => { state.history = { key: s.key, list }; fill(list); })
            .catch((e) => { hist.replaceChildren(h('div', { class: 'row' }, h('span', { class: 'nm', text: e.message }))); });
        }
        ghSec.append(section('Recent changes to ' + (state.project ? state.project.name : 'this project'), null, hist));
      }
      ghSec.append(h('div', { class: 'actions' },
        h('button', { class: 'btn small quiet', onclick: () => { setToken(null, false); state.ghProjects = null; state.ghHead = null; renderProjects(); toast('Token removed from this device'); } }, 'Disconnect'),
        h('button', { class: 'btn small quiet', onclick: () => { state.gh.repo = ''; Store.pref('gh', state.gh); state.ghProjects = null; renderProjects(); } }, 'Change repository')));
    }
    body.append(ghSec);
    // --- local
    body.append(section('From this device', null,
      h('p', { class: 'hint' }, 'Choose ', h('code', { text: '.kicad_sch' }), ' files (plus the ', h('code', { text: '.kicad_pro' }), ' if you have it), or a ZIP of the project folder.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => $('fileInput').click() }, icon('i-file'), 'Choose files'),
        h('button', { class: 'btn quiet', onclick: () => { closeDrawers(); loadSample(); } }, 'Open sample'))));
    // --- settings
    const theme = Store.pref('theme') || 'auto';
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Theme' });
    for (const [v, l] of [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']]) seg.append(h('button', { 'aria-pressed': String(theme === v), onclick: () => { Store.pref('theme', v); applyTheme(); renderProjects(); }, text: l }));
    const dim = h('input', { type: 'checkbox', checked: view.dimOthers, onchange: (e) => { view.dimOthers = e.target.checked; Store.pref('dim', e.target.checked); view.redraw(); } });
    const grid = h('input', { type: 'checkbox', checked: view.showGrid, onchange: (e) => { view.showGrid = e.target.checked; Store.pref('grid', e.target.checked); view.redraw(); } });
    body.append(section('Display', null, seg, h('label', { class: 'check' }, grid, 'Show grid'), h('label', { class: 'check' }, dim, 'Fade everything except the highlighted net')));
    body.append(section('Storage', null,
      h('p', { class: 'hint', text: 'Downloaded schematics are kept on this device so the last revision opens offline.' }),
      h('button', { class: 'btn small', onclick: async () => { await Store.clearPrefix('blob:'); await Store.clearPrefix('tree:'); await Store.clearPrefix('manifest:'); toast('Downloaded schematics cleared'); } }, 'Clear downloaded schematics')));
    body.append(h('p', { class: 'hint', text: `Schematic Tracer ${VERSION}. Reads KiCad 6–9 schematics; nothing is uploaded anywhere except requests to GitHub.` }));
  }

  // ------------------------------------------------------------------ search
  function buildIndex(P) {
    const parts = [], nets = [], sheets = [];
    for (const inst of P.instances) {
      inst.sheet.symbols.forEach((s, si) => {
        const ref = inst.refs[si].ref;
        if (!s.lib || s.lib.power || ref.startsWith('#')) return;
        const unit = s.lib.unitCount > 1 ? K.unitLetter(inst.refs[si].unit || s.unit) : '';
        const val = (s.props.find((p) => p.name === 'Value') || {}).value || '';
        const fp = (s.props.find((p) => p.name === 'Footprint') || {}).value || '';
        const extra = s.props.filter((p) => !['Reference', 'Datasheet'].includes(p.name)).map((p) => p.value).join(' ');
        parts.push({ ref, unit, val: K.unescape(val), fp, inst, si, hay: (ref + unit + ' ' + ref + ' ' + val + ' ' + extra).toLowerCase() });
      });
      sheets.push({ inst, hay: (inst.name + ' ' + inst.namePath + ' ' + inst.sheet.path).toLowerCase() });
    }
    for (const n of P.nets) {
      if (!n.named && !n.pins.length) continue;
      const alt = Array.from(new Set(n.names.map((x) => x.name))).join(' ');
      nets.push({ net: n, hay: (plain(n.name) + ' ' + plain(alt)).toLowerCase() });
    }
    parts.sort((a, b) => K.naturalCmp(a.ref + a.unit, b.ref + b.unit));
    nets.sort((a, b) => K.naturalCmp(a.net.name, b.net.name));
    return { parts, nets, sheets };
  }
  function findRef(ref) {
    const r = state.index && state.index.parts.find((p) => p.ref + p.unit === ref || p.ref === ref);
    return r ? { inst: r.inst, si: r.si } : null;
  }
  function openSearch() {
    if (!state.project) return;
    $('search').hidden = false; $('scrim').hidden = false;
    const inp = $('searchInput'); inp.value = state.lastQuery || ''; runSearch(); setTimeout(() => inp.focus(), 30);
  }
  function closeSearch() { $('search').hidden = true; if ($('drawerProjects').hidden) $('scrim').hidden = true; }
  $('btnSearch').addEventListener('click', openSearch);
  $('searchClose').addEventListener('click', closeSearch);
  $('scrim').addEventListener('click', closeSearch);
  $('searchInput').addEventListener('input', () => runSearch());
  $('searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const first = $('results').querySelector('button.row'); if (first) first.click(); }
    if (e.key === 'Escape') closeSearch();
  });
  function runSearch() {
    const q = $('searchInput').value.trim().toLowerCase();
    state.lastQuery = $('searchInput').value;
    const out = $('results'); out.replaceChildren();
    const I = state.index; if (!I) return;
    if (!q) { out.append(h('p', { class: 'hint', text: 'Try a reference (U3), a value (10k), a footprint, a net (CAN_H) or a sheet name.' })); return; }
    const terms = q.split(/\s+/);
    const match = (hay) => terms.every((t) => hay.includes(t));
    const score = (key) => { key = key.toLowerCase(); return key === q ? 0 : key.startsWith(q) ? 1 : 2; };
    const parts = I.parts.filter((p) => match(p.hay)).sort((a, b) => score(a.ref + a.unit) - score(b.ref + b.unit)).slice(0, 40);
    const nets = I.nets.filter((n) => match(n.hay)).sort((a, b) => score(a.net.shortName) - score(b.net.shortName) || a.net.name.length - b.net.name.length).slice(0, 40);
    const sheets = I.sheets.filter((s) => match(s.hay)).slice(0, 20);
    if (parts.length) {
      const rows = h('div', { class: 'rows' });
      for (const p of parts) rows.append(h('button', { class: 'row', onclick: () => { closeSearch(); selectSymbol(p.inst, p.si, true); } },
        h('span', { class: 'main' }, h('span', { class: 'ref', text: p.ref + p.unit }), h('span', { class: 'nm', text: p.val })),
        h('span', { class: 'meta', text: 'p' + p.inst.page })));
      out.append(section('Parts', String(parts.length), rows));
    }
    if (nets.length) {
      const rows = h('div', { class: 'rows' });
      for (const n of nets) rows.append(h('button', { class: 'row', onclick: () => {
        closeSearch(); selectNet(n.net);
        const target = n.net.inst.has(state.inst.idx) ? state.inst : state.project.instances[Array.from(n.net.inst.keys()).sort((a, b) => state.project.instances[a].order - state.project.instances[b].order)[0]];
        goToNetOn(target, n.net);
      } },
        h('span', { class: 'main' }, h('span', { class: 'nm' }, markup(n.net.name))),
        h('span', { class: 'meta', text: n.net.bus ? 'bus' : n.net.pins.length + ' pins' })));
      out.append(section('Nets', String(nets.length), rows));
    }
    if (sheets.length) {
      const rows = h('div', { class: 'rows' });
      for (const s of sheets) rows.append(h('button', { class: 'row', onclick: () => { closeSearch(); showInstance(s.inst); } },
        h('span', { class: 'main' }, h('span', { class: 'pin', text: s.inst.page }), h('span', { class: 'nm', text: s.inst.parent ? s.inst.name : state.project.name })),
        h('span', { class: 'meta', text: s.inst.namePath })));
      out.append(section('Sheets', String(sheets.length), rows));
    }
    if (!parts.length && !nets.length && !sheets.length) out.append(h('p', { class: 'hint', text: 'Nothing matches “' + $('searchInput').value + '” in this project.' }));
  }

  // ------------------------------------------------------------------ deep links
  function readHash() {
    const out = {};
    try { new URLSearchParams(location.hash.slice(1)).forEach((v, k) => { out[k] = v; }); } catch (e) { /* ignore */ }
    return out;
  }
  function writeHash() {
    const s = state.source; if (!s || !state.inst) return;
    const p = new URLSearchParams();
    p.set('p', s.key);
    p.set('s', state.inst.namePath);
    if (state.sel && state.sel.type === 'net') p.set('n', state.sel.net.name);
    if (state.sel && state.sel.type === 'symbol') p.set('r', state.sel.inst.refs[state.sel.si].ref);
    try { history.replaceState(null, '', '#' + p.toString()); } catch (e) { /* ignore */ }
  }
  function copyLink() { writeHash(); copy(location.href); }

  // ------------------------------------------------------------------ controls
  $('btnFit').addEventListener('click', () => view.fit());
  $('wConnect').addEventListener('click', () => openDrawer('drawerProjects'));
  $('wOpen').addEventListener('click', () => $('fileInput').click());
  $('wSample').addEventListener('click', loadSample);
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === '/' || (e.key === 'f' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); openSearch(); }
    else if (e.key === 'Escape') { if (!$('search').hidden) closeSearch(); else if (!$('scrim').hidden) closeDrawers(); else clearSelection(); }
    else if (e.key === 'Backspace' && state.inst && state.inst.parent) showInstance(state.inst.parent);
    else if (e.key === '+' || e.key === '=') view.zoomBy(1.4);
    else if (e.key === '-') view.zoomBy(1 / 1.4);
    else if (e.key === '0') view.fit();
  });
  // ------------------------------------------------------------------ boot
  renderStatus();
  renderScale();
  async function boot() {
    const last = Store.pref('last');
    if (last && last.kind === 'github' && state.gh.repo && state.token) { await connectAndOpen(last.key); if (state.project) return; }
    if (last && last.kind === 'github' && state.gh.repo && !state.token) {
      // Token not remembered: still open the cached copy offline.
      if (await openCachedGitHub(last.key, 'Reconnect GitHub to check for newer revisions.')) return;
    }
    if (last && last.kind === 'local' && await reopenLocal()) return;
    if (last && last.kind === 'sample') { await loadSample(); return; }
    $('welcome').hidden = false;
  }
  boot();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.__tracer = { state, view, selectNet, selectSymbol, showInstance, openProject };
})();
