/* Loomline — app shell: loading (GitHub, local files, sample), navigation,
 * selection, inspector, search and settings. */
(function () {
  'use strict';
  const K = window.KiCore, R = window.KiRender;
  const $ = (id) => document.getElementById(id);
  const VERSION = '1.8.5';

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
      // While drawing, a quick second tap is another point, not a zoom.
      if (state.mode === 'wire' || state.mode === 'label' || state.mode === 'draw') { setTimeout(() => onCanvasTap(wp, 'touch'), 30); return; }
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
  function openProject(files, source, opts) {
    const t0 = performance.now();
    const project = K.buildProject(files);
    state.project = project;
    state.source = source;
    state.files = files.map((f) => ({ path: f.path, text: f.text }));
    state.base = new Map(files.map((f) => [f.path, f.text]));
    state.undo = []; state.redo = [];
    setMode('select');
    state.scenes.clear(); state.views.clear();
    state.sel = null;
    state.index = buildIndex(project);
    state.compare = null;
    analyzeNow();
    $('welcome').hidden = true;
    closeDrawers();
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
    renderEditUI();
    installLoad();
    if (!(opts && opts.noRestore)) offerRestore();
    console.info('Opened', project.name, Math.round(performance.now() - t0) + ' ms', project.nets.length + ' nets');
  }

  function updateHeader() {
    const p = state.project, s = state.source;
    $('projName').textContent = p ? p.name : 'Loomline';
    $('netCount').textContent = p ? p.nets.filter((n) => !n.bus && (n.named || n.pins.length > 1)).length : 0;
    $('partCount').textContent = p && state.index ? state.index.parts.length : 0;
    let rev = 'No project open';
    if (s && s.kind === 'github') rev = `${s.ref} · ${s.head.sha.slice(0, 7)} · ${ago(s.projCommit ? s.projCommit.date : s.head.date)}`;
    else if (s && s.kind === 'local') rev = 'From this device';
    else if (s && s.kind === 'sample') rev = 'Sample · KiCad demo';
    $('projRev').textContent = rev;
    document.title = p ? p.name + ' · Loomline' : 'Loomline';
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
    if (state.mode === 'wire') { wireTap(wp, type); return; }
    if (state.mode === 'label') { labelTap(wp, type); return; }
    if (state.mode === 'draw') { drawTap(wp, type); return; }
    if (state.mode === 'move') return;
    const mk = view.markerAt(wp[0] * view.scale + view.ox, wp[1] * view.scale + view.oy, type === 'mouse' ? 12 : 20);
    if (mk && mk.issue) { pickIssue(mk.issue, false); return; }
    const hit = view.hitTest(wp, type === 'mouse' ? 8 : 16);
    if (!hit) { clearSelection(); return; }
    if (hit.type === 'net') {
      const net = state.project.nets[state.inst.netOf[hit.g]];
      if (net) selectNet(net, itemFromTag(hit.it));
    } else if (hit.type === 'symbol') selectSymbol(state.inst, hit.si);
    else if (hit.type === 'sheet') selectSheet(state.inst, hit.idx);
    else if (hit.type === 'graphic') selectGraphic(state.inst, hit.it);
  }
  function applyHighlight() {
    const s = state.sel, inst = state.inst;
    updateAnnot();
    if (!s || !inst) { view.setHighlight(null); return; }
    if (s.type === 'net') { const its = traceIts(s, inst); if (its) view.setHighlight(null, -1, -1, null, its); else view.setHighlight(groupsFor(s.net, inst), -1, -1); }
    else if (s.type === 'symbol') view.setHighlight(null, s.inst === inst ? s.si : -1, -1);
    else if (s.type === 'sheet') view.setHighlight(null, -1, s.inst === inst ? s.idx : -1);
    else if (s.type === 'graphic') view.setHighlight(null, -1, -1, s.inst === inst ? s.it : null);
  }
  function selectNet(net, item) {
    state.sel = { type: 'net', net, item: item || null };
    if (traceStep && item) startTrace(state.sel, false);
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
  // ---- step-by-step tracing: follow a net from the tapped wire to the first connector, then on
  let traceStep = Store.pref('traceStep') === true;
  let traceBy = Store.pref('traceBy') === 'conn' ? 'conn' : 'section';   // steps end at every pin and branch, or only at connectors
  function startNodeOf(inst, item) {
    if (!item) return -1;
    const sh = inst.sheet;
    const o = item.type === 'wire' ? sh.wires[item.idx] : item.type === 'label' ? sh.labels[item.idx] : item.type === 'junction' ? sh.junctions[item.idx]
      : item.type === 'nc' ? sh.noConnects[item.idx] : item.type === 'pin' ? (sh.symbols[item.si] && K.symbolPins(sh.symbols[item.si])[item.pi]) : null;
    return o && o.node !== undefined ? o.node : -1;
  }
  function startTrace(s, render) {
    const node = startNodeOf(state.inst, s.item);
    if (node < 0) return false;
    s.step = { inst: state.inst.idx, node, k: 0 };
    s._tr = null;
    if (!traceOf(s)) { s.step = null; return false; }
    if (render) { applyHighlight(); renderSelectionUI(); }
    return true;
  }
  function traceOf(s) {
    if (!s || s.type !== 'net' || !s.step) return null;
    const P = state.project;
    if (!s._tr || s._tr.P !== P || s._tr.by !== traceBy) {
      const inst = P.instances[s.step.inst];
      let tr = null;
      try { tr = inst ? Loom.traceSteps(P, inst, s.step.node, { by: traceBy }) : null; } catch (e) { console.error(e); }
      s._tr = { P, by: traceBy, tr: tr && tr.steps.length ? tr : null };
      if (s._tr.tr) s.step.k = Math.min(s.step.k, s._tr.tr.steps.length - 1);
    }
    return s._tr.tr;
  }
  function traceIts(s, inst, only) {
    const tr = traceOf(s); if (!tr) return null;
    const its = new Set();
    const from = only ? s.step.k : 0;
    for (let k = from; k <= s.step.k; k++) {
      const set = tr.steps[k].items.get(inst.idx); if (!set) continue;
      for (const n of set) { const t = tr.tagOf(inst.idx, n); if (t) its.add(t); }
    }
    return its;
  }
  function itsBox(inst, its) {
    const S = sceneFor(inst);
    let bb = null;
    const grow = (b) => { bb = bb ? [Math.min(bb[0], b[0]), Math.min(bb[1], b[1]), Math.max(bb[2], b[2]), Math.max(bb[3], b[3])] : b.slice(); };
    for (const list of [S.strokes, S.circles, S.hitLabels]) for (const o of list) if (o.it && its.has(o.it)) grow(o.bb);
    if (!bb) return null;
    const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2, w = Math.max(bb[2] - bb[0], 70) + 10, hh = Math.max(bb[3] - bb[1], 45) + 10;
    return [cx - w / 2, cy - hh / 2, cx + w / 2, cy + hh / 2];
  }
  // Shows the newest step: on this sheet if it reaches here, otherwise on the sheet it reaches most.
  function showTraceStep(s) {
    const tr = traceOf(s); if (!tr) return;
    const step = tr.steps[s.step.k];
    let inst = step.items.has(state.inst.idx) ? state.inst : null;
    if (!inst) { let best = -1; for (const [ii, set] of step.items) if (set.size > best) { best = set.size; inst = state.project.instances[ii]; } }
    if (!inst) return;
    if (inst !== state.inst) { showInstance(inst); toast(`Continues on sheet ${inst.page}: ${instLabel(inst)}`); }
    applyHighlight();
    const b = itsBox(inst, traceIts(s, inst, true));
    if (b) view.animateTo(b);
  }
  function traceMove(d) {
    const s = state.sel, tr = traceOf(s); if (!tr) return;
    const k = Math.max(0, Math.min(tr.steps.length - 1, s.step.k + d));
    if (k === s.step.k) return;
    s.step.k = k;
    renderSelectionUI();
    showTraceStep(s);
  }
  function setTraceStep(on) {
    traceStep = on; Store.pref('traceStep', on);
    const s = state.sel;
    if (s && s.type === 'net') { if (on) startTrace(s, false); else { s.step = null; s._tr = null; } applyHighlight(); renderSelectionUI(); }
  }
  function traceSummary(s) {
    const tr = traceOf(s); if (!tr) return '';
    const n = tr.steps.length, k = s.step.k, step = tr.steps[k];
    if (n === 1) return 'Step 1 of 1 · whole net · ';
    const conns = step.stops.filter((x) => x.kind === 'conn' || x.kind === 'pin').map((x) => x.ref + '.' + x.number);
    const tees = step.stops.filter((x) => x.kind === 'junction').length;
    const jump = step.stops.find((x) => x.kind === 'jump');
    const parts = [];
    if (k < n - 1) {
      const to = conns.slice(0, 3).concat(tees ? [tees === 1 ? 'a junction' : tees + ' junctions'] : []);
      if (to.length) parts.push('to ' + to.join(', ') + (conns.length > 3 ? ` +${conns.length - 3}` : ''));
      if (jump) parts.push('⇢ ' + jump.name + ' elsewhere');
    } else parts.push('whole net');
    const away = Array.from(step.items.keys()).filter((ii) => ii !== state.inst.idx).map((ii) => state.project.instances[ii].page);
    if (away.length) parts.push('also p' + away.slice(0, 3).join(', p'));
    return `Step ${k + 1} of ${n} · ` + parts.join(' · ') + ' · ';
  }
  function traceActions(s) {
    const tr = traceOf(s);
    if (tr) {
      const last = tr.steps.length - 1;
      return [
        { label: 'CONTINUE', icon: 'i-next', primary: true, disabled: s.step.k >= last, run: () => traceMove(1) },
        { label: 'BACK', icon: 'i-undo', disabled: s.step.k === 0, run: () => traceMove(-1) },
        { label: 'ALL', icon: 'i-net', run: () => setTraceStep(false) }
      ];
    }
    return startNodeOf(state.inst, s.item) >= 0 && !s.net.bus ? [{ label: 'STEP', icon: 'i-steps', run: () => setTraceStep(true) }] : [];
  }

  // ---- cable details: a KiCad net class flag with Cable_* fields on one wire of a section
  function cableSection(inst, node) {
    let tr = null;
    try { tr = Loom.traceSteps(state.project, inst, node, { by: 'section', maxSteps: 1 }); } catch (e) { console.error(e); }
    const items = tr && tr.steps.length ? (tr.steps[0].items.get(inst.idx) || new Set()) : new Set();
    const sh = inst.sheet;
    const flags = sh.labels.filter((l) => Loom.isCableFlag(l) && items.has(l.node));
    const wires = sh.wires.filter((w) => items.has(w.node));
    return { items, flags, wires };
  }
  function cableOfSel(s) {
    if (!s || s.type !== 'net' || !s.item) return null;
    const o = itemObj(s.item);
    if (s.item.type === 'label' && o && o.kind === 'directive') return { flags: [o], flag: o, wires: [], label: o };
    if (s.item.type !== 'wire' || !o) return null;
    if (!s._cable || s._cable.P !== state.project) { const c = cableSection(state.inst, o.node); s._cable = { P: state.project, c: Object.assign(c, { flag: c.flags[0] || null }) }; }
    return s._cable.c;
  }
  function cableText(f) {
    return [f.Cable_Type, f.Cable_PN, f.Cable_Size, f.Cable_Colour, f.Cable_Length].filter(Boolean).join(' · ');
  }
  // Values already used in this project, offered as suggestions (and to fill the rest from a known part number).
  function knownCables() {
    const seen = new Map();
    for (const inst of state.project.instances) for (const l of inst.sheet.labels) if (Loom.isCableFlag(l)) { const f = Loom.cableFields(l); const k = f.Cable_PN || f.Cable_Type; if (k && !seen.has(k)) seen.set(k, f); }
    return Array.from(seen.values());
  }
  // Where a new cable tag goes: on one of the section's wires, near the middle of the longest, on
  // whichever side (and as little way along) keeps its text clear of other text, tags, parts and wires.
  function cableSpot(wires, shown) {
    const S = sceneFor(state.inst);
    const obst = [];
    for (const t of S.texts) if (t.role !== 'frameText') obst.push(t.bb);
    for (const sy of S.syms) obst.push(sy.body || sy.bb);
    for (const st of S.strokes) if (st.role === 'wire' || st.role === 'bus' || st.role === 'directive' || st.role === 'sheet') obst.push(st.bb);
    for (const c of S.circles) if (c.role === 'directive') obst.push(c.bb);
    const tw = 0.75 * 1.27 * String(shown || '').length + 1.2;     // rough italic text width, mm
    const boxFor = (p, vertical, side) => {
      const a = E.cableTextAt(p, vertical, side), hh = 0.95;
      return vertical ? [a[0] - hh, a[1] - tw, a[0] + hh, p[1] + 0.2] : [p[0] - 0.2, a[1] - hh, a[0] + tw, a[1] + hh];
    };
    const hits = (b) => obst.reduce((n, o) => n + (o[0] < b[2] && o[2] > b[0] && o[1] < b[3] && o[3] > b[1] ? 1 : 0), 0);
    const ortho = (w) => Math.abs(w.a[0] - w.b[0]) < 1e-3 || Math.abs(w.a[1] - w.b[1]) < 1e-3;
    const list = wires.slice().sort((a, b) => Math.hypot(b.b[0] - b.a[0], b.b[1] - b.a[1]) - Math.hypot(a.b[0] - a.a[0], a.b[1] - a.a[1]));
    let best = null;
    for (const w of list) {
      const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
      if (!ortho(w) || len < 2 * E.GRID) continue;
      const vertical = Math.abs(w.a[0] - w.b[0]) < 1e-3;
      const steps = Math.floor(len / E.GRID), mid = Math.round(steps / 2);
      // Middle first, then outwards in 2-grid steps; each spot tries side a, then side b.
      for (let k = 0; k <= steps; k += 2) for (const dir of k ? [1, -1] : [1]) {
        const n = mid + dir * k;
        if (n < 1 || n > steps - 1) continue;
        const t = n * E.GRID / len;
        const p = [w.a[0] + (w.b[0] - w.a[0]) * t, w.a[1] + (w.b[1] - w.a[1]) * t];
        for (const side of ['a', 'b']) {
          const score = hits(boxFor(p, vertical, side)) * 100000 + k + (side === 'b' ? 1 : 0) + (w === list[0] ? 0 : 5);
          if (!best || score < best.score) best = { w, p, side, score };
          if (score < 100000 && w === list[0] && k === 0) return best;   // the obvious spot is clear
        }
      }
      if (best && best.score < 100000) return best;
    }
    if (best) return best;
    const w = list[0]; if (!w) return null;
    return { w, p: [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2], side: 'a' };
  }
  function cableDialog(s) {
    const c = cableOfSel(s); if (!c) return;
    const sh = state.inst.sheet;
    const cur = c.flag ? Loom.cableFields(c.flag) : {};
    const known = knownCables();
    const LABELS = { Cable_Type: ['Type', 'e.g. Spec 55 / Tefzel, CAN bus, 2-core screened'], Cable_PN: ['Product code', 'e.g. 55A0811-20-9'], Cable_Size: ['Core size', 'e.g. 0.75 mm² or 20 AWG'], Cable_Colour: ['Colour / marking', 'e.g. white, ID sleeve 101'], Cable_Length: ['Length', 'e.g. 3.2 m'] };
    const inputs = {};
    const rows = Loom.CABLE.map((f) => {
      const listId = 'dl_' + f;
      const vals = Array.from(new Set(known.map((k) => k[f]).filter(Boolean))).sort();
      const inp = h('input', { class: 'input', value: cur[f] || '', placeholder: LABELS[f][1], spellcheck: 'false', autocomplete: 'off', list: vals.length && f !== 'Cable_Length' ? listId : null });
      inputs[f] = inp;
      return h('div', { class: 'fieldrow' }, h('label', { text: LABELS[f][0] }), inp, vals.length && f !== 'Cable_Length' ? h('datalist', { id: listId }, ...vals.map((v) => h('option', { value: v }))) : null);
    });
    // Picking a known product code or type fills in what that cable already has.
    const fill = (key) => () => {
      const v = inputs[key].value.trim();
      const m = known.filter((x) => x[key] && x[key] === v);
      if (m.length !== 1) return;   // a type used with several product codes doesn't pick one for you
      const k = m[0];
      for (const f of ['Cable_Type', 'Cable_PN', 'Cable_Size']) if (!inputs[f].value.trim() && k[f]) inputs[f].value = k[f];
    };
    inputs.Cable_PN.addEventListener('change', fill('Cable_PN'));
    inputs.Cable_Type.addEventListener('change', fill('Cable_Type'));
    const net = s.net;
    const ends = c.flag || (c.wires[0]) ? Loom.sectionEnds(state.project, state.inst, (c.flag || c.wires[0]).node) : [];
    const where = h('p', { class: 'hint', text: `Section of ${K.plainText(K.unescape(net.shortName))}${ends.length ? ': ' + ends.join(' → ') : ''}. Saved in the schematic as a net class flag on the wire, so KiCad keeps it too.` });
    const save = () => {
      const f = {}; for (const k of Loom.CABLE) f[k] = inputs[k].value.trim();
      const empty = !Loom.CABLE.some((k) => f[k]);
      closeDialog();
      if (c.flag) {
        if (empty) run('Remove cable details', () => E.deleteItems(sh, [{ type: 'label', label: c.flag }]), { anchor: null });
        else run('Cable details', () => E.setCableFields(sh, c.flag, f));
        return;
      }
      if (empty) return;
      const spot = cableSpot(c.wires, f.Cable_Type || Loom.CABLE.map((k) => f[k]).find(Boolean));
      if (!spot) { banner('err', 'Tap a wire to add cable details.'); return; }
      run('Cable details', () => E.addCableFlag(sh, spot.w, spot.p, f, spot.side));
    };
    const acts = [{ label: 'CANCEL', run: closeDialog }];
    if (c.flag) acts.unshift({ label: 'REMOVE', run: () => { closeDialog(); run('Remove cable details', () => E.deleteItems(sh, [{ type: 'label', label: c.flag }]), { anchor: null }); } });
    acts.push({ label: 'SAVE', primary: true, run: save });
    openDialog(c.flag ? 'CABLE DETAILS' : 'ADD CABLE DETAILS', [where, ...rows], acts);
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
  const TAB_TITLES = { sheets: 'SHEETS', nets: 'NET NAVIGATOR', parts: 'PARTS', info: 'PROPERTIES', check: 'DESIGN CHECK', install: 'INSTALL', reports: 'REPORTS', compare: 'COMPARE REVISIONS' };
  state.tab = 'sheets';
  state.panelOpen = false;
  function setPanel(open) {
    state.panelOpen = open;
    $('panel').hidden = !open;
    for (const b of document.querySelectorAll('.rail-btn[data-tab]')) b.setAttribute('aria-pressed', String(open && b.dataset.tab === state.tab));
    if (open) renderPanel();
    if (open && state.tab === 'install' && !show.install) setShow('install', true);
    if (open && state.tab === 'install') scheduleSync(0);
    requestAnimationFrame(() => view.resize());
  }
  function showTab(tab, open) {
    state.tab = tab;
    $('panelTitle').textContent = TAB_TITLES[tab] || '';
    if (open && !state.panelOpen) setPanel(true);
    else {
      if (tab === 'install' && state.panelOpen) { if (!show.install) setShow('install', true); scheduleSync(0); } for (const b of document.querySelectorAll('.rail-btn[data-tab]')) b.setAttribute('aria-pressed', String(state.panelOpen && b.dataset.tab === tab)); renderPanel(); }
  }
  // On a phone the panel covers the drawing, so close it after a pick.
  function afterPick() { if (!wideLayout() && state.panelOpen) setPanel(false); }
  for (const b of document.querySelectorAll('.rail-btn[data-tab]')) b.addEventListener('click', () => {
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
    else if (state.tab === 'check') renderCheck(body);
    else if (state.tab === 'install') renderInstall(body);
    else if (state.tab === 'reports') renderReports(body);
    else if (state.tab === 'compare') renderCompare(body);
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
    const wrows = state.A && state.A.wiresByNet.get(net.id);
    if (wrows && wrows.length) {
      const wr = h('div', { class: 'rows' });
      for (const w of wrows) {
        const x = ist(w.key);
        wr.append(h('button', { class: 'row', onclick: () => { goToPin(w.a); afterPick(); } },
          h('span', { class: 'main' }, h('span', { class: 'wno', text: w.no || '–' }), h('span', { class: 'nm', text: `${pinText(w.a)} → ${pinText(w.b)}` })),
          h('span', { class: 'meta', text: x.tested ? 'tested' : x.fitted ? 'fitted' : '' })));
      }
      body.append(section('Wires (from → to)', `${wrows.length} · no. ${state.A.wireNo[net.id]}`, wr));
    }
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
      add('Sheet', inst.namePath + ' (page ' + inst.page + ', zone ' + Loom.zoneOf(inst, sym.p) + ')');
      body.append(section('Fields', null, dl));
      const units = state.A && state.A.xref.get(inst.idx + ':' + s.si);
      if (units && units.length) {
        const ur = h('div', { class: 'rows' });
        for (const u of units) ur.append(h('button', { class: 'row', onclick: () => { selectSymbol(u.inst, u.si, true); afterPick(); } },
          h('span', { class: 'main' }, h('span', { class: 'ref', text: ref + u.unit }), h('span', { class: 'nm', text: instLabel(u.inst) })), h('span', { class: 'meta', text: 'p' + u.page + ' · ' + u.zone })));
        body.append(section('Other units', 'cross-reference', ur));
      }
      const pins = K.symbolPins(sym).slice().sort((a, b) => K.naturalCmp(a.number, b.number));
      const pr = h('div', { class: 'rows' });
      for (const pin of pins) {
        const net = P.nets[inst.netOf[pin.group]];
        const wno = net && state.A ? state.A.wireNo[net.id] : null;
        pr.append(h('button', { class: 'row', onclick: () => { selectNet(net); } },
          h('span', { class: 'main' }, h('span', { class: 'pin', text: pin.number }), h('span', { class: 'nm' }, pin.name && pin.name !== '~' ? markup(pin.name) : '')),
          h('span', { class: 'net' }, wno && !net.named ? h('span', { class: 'wno', text: wno }) : null, markup(net ? net.shortName : '–'))));
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

  // ------------------------------------------------------------------ editing
  // Every edit rewrites only the affected lines of the .kicad_sch text (see edit.js), then the
  // project is rebuilt from the edited text. Undo/redo swap whole file texts.
  const E = window.KiEdit;
  state.mode = 'select';
  state.wire = { anchors: [], flips: [] };
  const fileText = (path) => { const f = state.files.find((x) => x.path === path); return f ? f.text : null; };
  const setFileText = (path, text) => { const f = state.files.find((x) => x.path === path); if (f) f.text = text; };
  function pendingFiles() { return state.files ? state.files.filter((f) => state.base.get(f.path) !== f.text) : []; }
  function itemFromTag(it) {
    if (!it) return null;
    const c = it[0], rest = it.slice(1);
    if (c === 'W') return { type: 'wire', idx: +rest };
    if (c === 'L') return { type: 'label', idx: +rest };
    if (c === 'J') return { type: 'junction', idx: +rest };
    if (c === 'N') return { type: 'nc', idx: +rest };
    if (c === 'P') { const [si, pi] = rest.split(':').map(Number); return { type: 'pin', si, pi }; }
    return null;
  }
  const uuidOf = (o) => (o && (o.uuid || (o.src && (K.find(o.src, 'uuid') || [])[1]))) || null;
  function itemObj(item, sheet) {
    sheet = sheet || state.inst.sheet;
    if (!item) return null;
    if (item.type === 'wire') return sheet.wires[item.idx];
    if (item.type === 'label') return sheet.labels[item.idx];
    if (item.type === 'junction') return sheet.junctions[item.idx];
    if (item.type === 'nc') return sheet.noConnects[item.idx];
    if (item.type === 'pin') { const s = sheet.symbols[item.si]; return s ? K.symbolPins(s)[item.pi] : null; }
    return null;
  }
  // Remember what is selected by UUID so it survives the rebuild after an edit.
  function selectionAnchor() {
    const s = state.sel; if (!s || !state.inst) return null;
    const sh = state.inst.sheet;
    if (s.type === 'symbol') return { type: 'symbol', uuid: sh.symbols[s.si] && sh.symbols[s.si].uuid };
    if (s.type === 'sheet') return { type: 'sheet', uuid: sh.sheets[s.idx] && sh.sheets[s.idx].uuid };
    if (s.type === 'graphic') { const o = graphicObj(s.it, sh); return { type: 'graphic', kind: s.it[0], uuid: o && uuidOf(o) }; }
    if (s.type === 'net' && s.item) { const o = itemObj(s.item); return { type: 'net', item: s.item.type, uuid: uuidOf(o), p: o && (o.p || o.pos || o.a), pin: s.item.type === 'pin' ? { sym: sh.symbols[s.item.si].uuid, pi: s.item.pi } : null }; }
    if (s.type === 'net') return { type: 'netname', name: s.net.name };
    return null;
  }
  function restoreSelection(a) {
    state.sel = null;
    if (!a) return;
    const sh = state.inst.sheet, P = state.project;
    if (a.type === 'symbol') { const si = sh.symbols.findIndex((x) => x.uuid === a.uuid); if (si >= 0) state.sel = { type: 'symbol', inst: state.inst, si }; }
    else if (a.type === 'sheet') { const idx = sh.sheets.findIndex((x) => x.uuid === a.uuid); if (idx >= 0) state.sel = { type: 'sheet', inst: state.inst, idx }; }
    else if (a.type === 'graphic' && a.uuid) { const list = a.kind === 'T' ? sh.texts : a.kind === 'B' ? sh.textBoxes : sh.graphics; const idx = list.findIndex((o) => uuidOf(o) === a.uuid); if (idx >= 0) state.sel = { type: 'graphic', inst: state.inst, it: a.kind + idx }; }
    else if (a.type === 'netname') { const n = P.nets.find((x) => x.name === a.name); if (n) state.sel = { type: 'net', net: n, item: null }; }
    else if (a.type === 'net') {
      let item = null, g = -1;
      if (a.pin) { const si = sh.symbols.findIndex((x) => x.uuid === a.pin.sym); if (si >= 0) { item = { type: 'pin', si, pi: a.pin.pi }; const p = K.symbolPins(sh.symbols[si])[a.pin.pi]; g = p ? p.group : -1; } }
      else {
        const list = a.item === 'wire' ? sh.wires : a.item === 'label' ? sh.labels : a.item === 'junction' ? sh.junctions : sh.noConnects;
        const idx = list.findIndex((o) => uuidOf(o) && uuidOf(o) === a.uuid);
        if (idx >= 0) { item = { type: a.item, idx }; g = list[idx].group; }
      }
      if (g >= 0) state.sel = { type: 'net', net: P.nets[state.inst.netOf[g]], item };
    }
  }
  function rebuild(anchor) {
    const instPath = state.inst ? state.inst.path : null;
    const view0 = { scale: view.scale, ox: view.ox, oy: view.oy };
    const project = K.buildProject(state.files);
    state.project = project;
    state.index = buildIndex(project);
    analyzeNow();
    if (state.compare) state.compare.diff = Loom.diff(state.compare.P0, state.compare.A0, project, state.A);
    state.scenes.clear();
    const inst = project.instances.find((i) => i.path === instPath) || project.root;
    state.inst = null;
    showInstance(inst, true);
    view.scale = view0.scale; view.ox = view0.ox; view.oy = view0.oy;
    restoreSelection(anchor);
    applyHighlight();
    updateHeader();
    renderSelectionUI();
    renderEditUI();
    if (state.mode === 'wire') updateWireOverlay();
  }
  function commitEdit(results, label, opts) {
    results = [].concat(results).filter(Boolean);
    const changes = results.map((r) => ({ path: r.path, before: fileText(r.path), after: r.text })).filter((c) => c.before !== c.after);
    if (!changes.length) return false;
    const anchor = opts && opts.anchor !== undefined ? opts.anchor : selectionAnchor();
    const before = state.project;
    for (const c of changes) setFileText(c.path, c.after);
    state.undo.push({ label, changes, anchor });
    state.redo = [];
    rebuild(anchor);
    persistEdits();
    if (opts && opts.checkMerges) warnMerges(before, state.project, label);
    return true;
  }
  function run(label, fn, opts) {
    try { const r = fn(); if (r) commitEdit(r, label, opts); return r; }
    catch (e) { banner('err', e.message || String(e)); console.error(e); return null; }
  }
  function undo() {
    const h = state.undo.pop(); if (!h) return;
    for (const c of h.changes) setFileText(c.path, c.before);
    state.redo.push(h);
    rebuild(h.anchor);
    persistEdits();
    toast('Undid: ' + h.label);
  }
  function redo() {
    const h = state.redo.pop(); if (!h) return;
    for (const c of h.changes) setFileText(c.path, c.after);
    state.undo.push(h);
    rebuild(h.anchor);
    persistEdits();
    toast('Redid: ' + h.label);
  }
  $('btnUndo').addEventListener('click', undo);
  $('btnRedo').addEventListener('click', redo);
  // Warn when a move or rotate makes pins touch something they didn't before.
  function warnMerges(P0, P1, label) {
    const before = new Map();
    P0.nets.forEach((n) => n.pins.forEach((p) => before.set(p.ref + '#' + p.number, n)));
    for (const n of P1.nets) {
      const olds = new Set();
      for (const p of n.pins) { const o = before.get(p.ref + '#' + p.number); if (o) olds.add(o); }
      if (olds.size > 1) {
        const names = Array.from(olds).slice(0, 3).map((o) => plain(o.name));
        banner('err', `${label} also connected ${names.join(' and ')}.`, [{ label: 'UNDO', primary: true, run: () => { undo(); banner(null); } }]);
        return;
      }
    }
  }
  function renderEditUI() {
    const n = pendingFiles().length;
    const count = state.undo ? state.undo.length : 0;
    $('chipEdits').hidden = !n;
    $('editCount').textContent = String(count || n);
    $('btnUndo').disabled = !(state.undo && state.undo.length);
    $('btnRedo').disabled = !(state.redo && state.redo.length);
  }
  async function persistEdits() {
    if (!state.source) return;
    const key = 'edits:' + state.source.key;
    const files = pendingFiles();
    if (!files.length) { await Store.del(key); return; }
    await Store.set(key, { base: state.source.head ? state.source.head.sha : '', at: Date.now(), count: state.undo.length, files: files.map((f) => ({ path: f.path, text: f.text })) });
  }
  async function offerRestore() {
    if (!state.source) return;
    const saved = await Store.get('edits:' + state.source.key);
    if (!saved || !saved.files || !saved.files.length) return;
    const sameBase = !state.source.head || saved.base === state.source.head.sha;
    const files = saved.files.filter((f) => state.base.has(f.path));
    if (!files.length) return;
    banner('old', `You have unsaved edits to ${files.length} sheet file${files.length === 1 ? '' : 's'} from ${new Date(saved.at).toLocaleString()}${sameBase ? '' : ' (made on an older revision)'}.`, [
      { label: 'RESTORE', primary: true, run: () => { banner(null); commitEdit(files.map((f) => ({ path: f.path, text: f.text })), 'Restore unsaved edits', { anchor: null }); } },
      { label: 'DISCARD', run: async () => { banner(null); await Store.del('edits:' + state.source.key); } }
    ]);
  }

  // ---- modes
  function setMode(mode) {
    if (state.mode === 'move' && mode !== 'move') { view.dragHandler = null; view.preview = null; }
    state.mode = mode;
    for (const b of document.querySelectorAll('.rail-btn.mode')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode || (mode === 'move' && b.dataset.mode === 'select')));
    if (mode !== 'wire') { state.wire = { anchors: [], flips: [] }; view.overlay = null; }
    if (mode === 'wire' || mode === 'label' || mode === 'draw') { view.overlay = { pts: [], dots: [] }; }
    if (mode === 'draw') state.draw = { tool: (state.draw && state.draw.tool) || 'part', pts: [], part: state.draw && state.draw.part };
    if (mode === 'draw' && state.draw.tool === 'part' && !state.draw.part) setTimeout(openPartPicker, 0);
    view.redraw();
    renderStatus();
    renderDrawBar();
  }
  for (const b of document.querySelectorAll('.rail-btn.mode')) b.addEventListener('click', () => {
    if (!state.project) return;
    if (b.dataset.mode !== 'select' && state.sel && state.mode === 'select') { state.sel = null; applyHighlight(); renderSelectionUI(); }
    setMode(b.dataset.mode);
  });

  // ---- snapping (pins, wire ends, along wires, then the 1.27 mm grid)
  function snapPoint(wp, type) {
    const sh = state.inst.sheet;
    const tol = (type === 'mouse' ? 10 : 22) / view.scale;
    let best = null, bd = tol;
    for (const c of E.connectionPoints(sh)) { const d = Math.hypot(c.p[0] - wp[0], c.p[1] - wp[1]); if (d < bd) { bd = d; best = { p: c.p.slice(), on: c.kind }; } }
    if (best) return best;
    for (const w of sh.wires) {
      const dx = w.b[0] - w.a[0], dy = w.b[1] - w.a[1], l2 = dx * dx + dy * dy; if (!l2) continue;
      let t = ((wp[0] - w.a[0]) * dx + (wp[1] - w.a[1]) * dy) / l2; t = Math.max(0, Math.min(1, t));
      const q = [w.a[0] + t * dx, w.a[1] + t * dy];
      const d = Math.hypot(q[0] - wp[0], q[1] - wp[1]);
      if (d < bd) {
        bd = d;
        // snap along the wire to the grid, staying on the wire
        const g = Math.abs(dy) < 1e-6 ? [E.snap(q[0]), w.a[1]] : Math.abs(dx) < 1e-6 ? [w.a[0], E.snap(q[1])] : q;
        best = { p: g, on: 'wiremid' };
      }
    }
    if (best) return best;
    return { p: [E.snap(wp[0]), E.snap(wp[1])], on: null };
  }

  // ---- wire tool
  function wirePolyline(anchors, flips) {
    const pts = anchors.length ? [anchors[0]] : [];
    for (let i = 1; i < anchors.length; i++) {
      const a = anchors[i - 1], b = anchors[i];
      if (Math.abs(a[0] - b[0]) > 1e-6 && Math.abs(a[1] - b[1]) > 1e-6) pts.push(flips[i] ? [a[0], b[1]] : [b[0], a[1]]);
      pts.push(b);
    }
    return pts;
  }
  function updateWireOverlay(ring) {
    const w = state.wire;
    view.overlay = { pts: wirePolyline(w.anchors, w.flips), dots: w.anchors.slice(), ring: ring || null };
    view.redraw();
    renderStatus();
  }
  function wireTap(wp, type) {
    const s = snapPoint(wp, type);
    const w = state.wire;
    if (w.anchors.length && E.same(w.anchors[w.anchors.length - 1], s.p)) { finishWire(); return; }
    w.anchors.push(s.p); w.flips.push(false);
    updateWireOverlay(s.on ? s.p : null);
    // Landing on something that conducts ends the wire, like KiCad.
    if (w.anchors.length > 1 && s.on && s.on !== 'label') finishWire();
  }
  function finishWire() {
    const w = state.wire;
    const pts = wirePolyline(w.anchors, w.flips);
    if (pts.length < 2) { toast('Tap at least two points to draw a wire.'); return; }
    const sh = state.inst.sheet;
    state.wire = { anchors: [], flips: [] };
    run('Draw wire', () => E.addWires(sh, pts), { anchor: null });
    updateWireOverlay();
  }
  function wireBack() { const w = state.wire; w.anchors.pop(); w.flips.pop(); updateWireOverlay(); }
  function wireFlip() { const w = state.wire; if (w.anchors.length > 1) { w.flips[w.flips.length - 1] = !w.flips[w.flips.length - 1]; updateWireOverlay(); } }

  // ---- label tool
  function labelTap(wp, type) {
    const s = snapPoint(wp, type);
    if (!s.on || s.on === 'label') { toast('Tap a wire, wire end or pin to place a label.'); return; }
    view.overlay = { pts: [], dots: [s.p], ring: s.p };
    view.redraw();
    // Point the label away from a wire that ends here
    const sh = state.inst.sheet;
    let spin = 'right';
    const w = sh.wires.find((x) => E.same(x.a, s.p) || E.same(x.b, s.p));
    if (w) { const o = E.same(w.a, s.p) ? w.b : w.a; if (Math.abs(o[1] - s.p[1]) < 1e-6) spin = o[0] > s.p[0] ? 'left' : 'right'; else spin = o[1] > s.p[1] ? 'up' : 'bottom'; }
    labelDialog({ p: s.p, spin });
  }
  function seg(name, options, value, onChange) {
    const box = h('div', { class: 'seg', role: 'group', 'aria-label': name });
    const set = (v) => { value = v; for (const b of box.children) b.setAttribute('aria-pressed', String(b.dataset.v === v)); onChange && onChange(v); };
    for (const [v, l] of options) box.append(h('button', { 'data-v': v, type: 'button', onclick: () => set(v), text: l }));
    set(value);
    return { el: box, get: () => value };
  }
  function labelDialog(o) {
    const last = Store.pref('labelKind') || 'local';
    const name = h('input', { class: 'input', id: 'lblName', placeholder: 'e.g. CAN_H', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', value: o.rename ? o.rename.text : '' });
    const body = [h('div', { class: 'field' }, h('label', { for: 'lblName', text: 'Net name' }), name)];
    let kind, shape, dir;
    if (!o.rename) {
      const shapeSel = h('select', { class: 'input', id: 'lblShape' }, ...[['bidirectional', 'Bidirectional'], ['input', 'Input'], ['output', 'Output'], ['tri_state', 'Tri-state'], ['passive', 'Passive']].map(([v, l]) => h('option', { value: v, text: l })));
      shapeSel.value = Store.pref('labelShape') || 'bidirectional';
      const shapeField = h('div', { class: 'field' }, h('label', { for: 'lblShape', text: 'Shape' }), shapeSel);
      kind = seg('Label type', [['local', 'LOCAL'], ['global', 'GLOBAL'], ['hier', 'HIER.']], last, (v) => { shapeField.hidden = v === 'local'; });
      shape = shapeSel;
      dir = seg('Direction', [['right', '→'], ['up', '↑'], ['left', '←'], ['bottom', '↓']], o.spin || 'right');
      body.push(h('div', { class: 'field' }, h('label', { text: 'Type' }), kind.el), shapeField, h('div', { class: 'field' }, h('label', { text: 'Text direction' }), dir.el),
        h('p', { class: 'hint', text: 'Local labels join wires with the same name on this sheet. Global labels join across every sheet. Hierarchical labels connect to a sheet pin on the parent sheet.' }));
    }
    const go = () => {
      const v = name.value.trim();
      if (!v) { name.focus(); return; }
      closeDialog();
      const sh = state.inst.sheet;
      if (o.rename) run('Rename label', () => E.renameLabel(sh, o.rename, v));
      else {
        Store.pref('labelKind', kind.get()); Store.pref('labelShape', shape.value);
        run('Add label ' + v, () => E.addLabel(sh, kind.get(), v, o.p, dir.get(), shape.value), { anchor: null });
      }
      if (state.mode === 'label') { view.overlay = { pts: [], dots: [] }; view.redraw(); }
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    openDialog(o.rename ? 'RENAME LABEL' : 'ADD LABEL', body, [{ label: 'CANCEL', run: () => { closeDialog(); if (state.mode === 'label') { view.overlay = { pts: [], dots: [] }; view.redraw(); } } }, { label: o.rename ? 'RENAME' : 'ADD', primary: true, run: go }]);
    setTimeout(() => name.focus(), 50);
  }

  // ---- dialogs and menus
  function openDialog(title, body, actions) {
    closeDialog();
    const wrap = h('div', { class: 'dialog-wrap', id: 'dialogWrap', onclick: (e) => { if (e.target === wrap) closeDialog(); } },
      h('div', { class: 'dialog', role: 'dialog', 'aria-label': title },
        h('div', { class: 'dialog-head' }, h('h2', { text: title }), h('button', { class: 'ib', 'aria-label': 'Close', onclick: closeDialog }, icon('i-close'))),
        h('div', { class: 'dialog-body' }, ...body),
        h('div', { class: 'dialog-foot' }, ...actions.map((a) => h('button', { class: 'btn' + (a.primary ? ' primary' : ''), onclick: a.run, disabled: a.disabled }, a.label)))));
    document.body.append(wrap);
    return wrap;
  }
  function closeDialog() { const d = $('dialogWrap'); if (d) d.remove(); }
  function openMenu(anchorEl, items) {
    closeMenu();
    const r = anchorEl.getBoundingClientRect();
    const m = h('div', { class: 'menu', id: 'menu' }, ...items.map((it) => it.sep ? h('div', { class: 'sep' }) : h('button', { class: (it.danger ? 'danger' : '') + (it.checked !== undefined ? ' toggle' : ''), 'aria-checked': it.checked === undefined ? null : String(!!it.checked), role: it.checked === undefined ? null : 'menuitemcheckbox', onclick: () => { closeMenu(); it.run(); } }, icon(it.icon), it.label)));
    document.body.append(m);
    const mh = m.offsetHeight, mw = m.offsetWidth;
    m.style.left = Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw)) + 'px';
    m.style.top = (r.top - mh - 6 >= 8 ? r.top - mh - 6 : Math.min(window.innerHeight - mh - 8, r.bottom + 6)) + 'px';
    setTimeout(() => document.addEventListener('pointerdown', menuAway, { once: true }), 0);
  }
  function menuAway(e) { const m = $('menu'); if (m && !m.contains(e.target)) closeMenu(); else if (m) document.addEventListener('pointerdown', menuAway, { once: true }); }
  function closeMenu() { const m = $('menu'); if (m) m.remove(); }

  // ---- symbol fields
  function fieldsDialog(inst, si) {
    const sh = inst.sheet, sym = sh.symbols[si];
    const ref = inst.refs[si].ref;
    const inputs = [];
    const refIn = h('input', { class: 'input', value: ref, autocapitalize: 'characters', spellcheck: 'false' });
    const rows = [h('div', { class: 'fieldrow' }, h('label', { text: 'Reference' }), refIn)];
    for (const p of sym.props) {
      if (p.name === 'Reference' || p.name.startsWith('ki_')) continue;
      const inp = h('input', { class: 'input', value: p.value, spellcheck: 'false' });
      inputs.push([p.name, inp, p.value]);
      rows.push(h('div', { class: 'fieldrow' }, h('label', { text: p.name }), inp));
    }
    const dnp = h('input', { type: 'checkbox', checked: sym.dnp });
    const newRows = h('div', { class: 'fieldlist' });
    const added = [];
    const addRow = () => {
      const n = h('input', { class: 'input', placeholder: 'Field name, e.g. MPN', spellcheck: 'false' });
      const v = h('input', { class: 'input', placeholder: 'Value', spellcheck: 'false' });
      added.push([n, v]);
      newRows.append(h('div', { class: 'fieldrow new' }, n, v));
      n.focus();
    };
    const save = () => {
      const fields = {};
      for (const [name, inp, old] of inputs) if (inp.value !== old) fields[name] = inp.value;
      const add = added.map(([n, v]) => ({ name: n.value.trim(), value: v.value })).filter((f) => f.name && !sym.props.some((p) => p.name === f.name));
      const newRef = refIn.value.trim();
      const changes = { fields, add, dnp: dnp.checked !== sym.dnp ? dnp.checked : undefined, ref: newRef && newRef !== ref ? newRef : undefined };
      if (changes.ref && state.index.parts.some((p) => p.ref === changes.ref)) { banner('err', `${changes.ref} is already used in this project.`); return; }
      closeDialog();
      run('Edit ' + ref, () => E.setSymbolFields(sh, sym, inst, changes));
    };
    openDialog('EDIT ' + ref, [...rows, h('label', { class: 'check' }, dnp, 'Do not populate (DNP)'), newRows,
      h('button', { class: 'btn small', type: 'button', onclick: addRow }, icon('i-plus'), 'ADD FIELD')],
      [{ label: 'CANCEL', run: closeDialog }, { label: 'SAVE', primary: true, run: save }]);
  }

  // ---- move tool (drag anywhere; snaps to the grid)
  function startMove(target) {
    state.moveTarget = target;
    setMode('move');
    const snapD = (d) => [E.snap(d[0]), E.snap(d[1])];
    const tagFor = () => {
      const t = state.moveTarget, sh = state.inst.sheet;
      if (t.type === 'symbol') return { sym: sh.symbols.findIndex((x) => x.uuid === t.uuid), its: null };
      if (t.type === 'graphic') { const list = t.kind === 'T' ? sh.texts : t.kind === 'B' ? sh.textBoxes : sh.graphics; return { sym: -1, its: new Set([t.kind + list.findIndex((o) => uuidOf(o) === t.uuid)]) }; }
      const list = t.type === 'label' ? sh.labels : sh.wires;
      const idx = list.findIndex((o) => uuidOf(o) === t.uuid);
      return { sym: -1, its: new Set([(t.type === 'label' ? 'L' : 'W') + idx]) };
    };
    view.dragHandler = {
      move: (d) => { const tg = tagFor(); view.preview = { sym: tg.sym, its: tg.its, d: snapD(d) }; view.redraw(); },
      end: (d) => {
        view.preview = null;
        const sd = snapD(d);
        if (!sd[0] && !sd[1]) { view.redraw(); return; }
        const t = state.moveTarget, sh = state.inst.sheet;
        if (t.type === 'graphic') {
          const list = t.kind === 'T' ? sh.texts : t.kind === 'B' ? sh.textBoxes : sh.graphics;
          const o = list.find((x) => uuidOf(x) === t.uuid);
          if (!o) { setMode('select'); return; }
          run('Move ' + t.name, () => E.moveNode(sh, o.src, sd));
          return;
        }
        let item;
        if (t.type === 'symbol') item = { type: 'symbol', sym: sh.symbols.find((x) => x.uuid === t.uuid) };
        else if (t.type === 'label') item = { type: 'label', label: sh.labels.find((x) => uuidOf(x) === t.uuid) };
        else item = { type: 'wire', wire: sh.wires.find((x) => uuidOf(x) === t.uuid) };
        if (!item.sym && !item.label && !item.wire) { setMode('select'); return; }
        run('Move ' + t.name, () => E.moveItems(sh, [item], sd), { checkMerges: true });
      }
    };
    renderStatus();
  }

  // ---- actions on the selection
  function selectionActions() {
    const s = state.sel, sh = state.inst && state.inst.sheet;
    if (!s || !sh) return [];
    const A = installActions();
    if (s.type === 'symbol') {
      const sym = sh.symbols[s.si], ref = s.inst.refs[s.si].ref;
      A.push({ label: 'EDIT', icon: 'i-edit', run: () => fieldsDialog(s.inst, s.si) });
      A.push({ label: 'MOVE', icon: 'i-move', run: () => startMove({ type: 'symbol', uuid: sym.uuid, name: ref }) });
      A.push({ label: 'ROTATE', icon: 'i-rotate', run: () => run('Rotate ' + ref, () => E.transformSymbol(sh, sym, 'rotate'), { checkMerges: true }) });
      A.push({ label: 'COPY', icon: 'i-copy2', run: () => copyPart(s.inst, s.si) });
      const missing = missingUnits(s.inst, s.si);
      if (missing.length) A.push({ label: 'ADD UNIT', icon: 'i-plus', run: () => addMissingUnit(s.inst, s.si, missing[0]) });
      A.push({ label: 'DELETE', icon: 'i-trash', danger: true, run: () => run('Delete ' + ref, () => E.deleteItems(sh, [{ type: 'symbol', sym }]), { anchor: null }) });
      A.push({ label: 'MIRROR ↔', icon: 'i-mirror', run: () => run('Mirror ' + ref, () => E.transformSymbol(sh, sym, 'mirrorY'), { checkMerges: true }) });
      A.push({ label: 'MIRROR ↕', icon: 'i-mirror', run: () => run('Mirror ' + ref, () => E.transformSymbol(sh, sym, 'mirrorX'), { checkMerges: true }) });
      A.push({ label: 'ZOOM', icon: 'i-target', run: zoomToSelection });
    } else if (s.type === 'net') {
      const it = s.item, o = itemObj(it);
      const ta = traceActions(s);
      A.unshift(...ta);
      if (it && it.type === 'label' && o && o.kind === 'directive') {
        A.push({ label: 'CABLE', icon: 'i-cable', run: () => cableDialog(s) });
        if (Loom.isCableFlag(o)) A.push({ label: 'FLIP SIDE', icon: 'i-flip', run: () => run('Flip cable tag', () => E.setCableFields(sh, o, Loom.cableFields(o), E.cableSideOf(o) === 'a' ? 'b' : 'a')) });
        A.push({ label: 'MOVE', icon: 'i-move', run: () => startMove({ type: 'label', uuid: uuidOf(o), name: 'cable flag' }) });
        A.push({ label: 'DELETE', icon: 'i-trash', danger: true, run: () => run('Delete cable flag', () => E.deleteItems(sh, [{ type: 'label', label: o }]), { anchor: null }) });
      } else if (it && it.type === 'label' && o) {
        A.push({ label: 'RENAME', icon: 'i-edit', run: () => labelDialog({ rename: o }) });
        A.push({ label: 'MOVE', icon: 'i-move', run: () => startMove({ type: 'label', uuid: uuidOf(o), name: 'label ' + o.text }) });
        A.push({ label: 'ROTATE', icon: 'i-rotate', run: () => run('Rotate label', () => E.rotateLabel(sh, o)) });
        A.push({ label: 'DELETE', icon: 'i-trash', danger: true, run: () => run('Delete label ' + o.text, () => E.deleteItems(sh, [{ type: 'label', label: o }]), { anchor: null }) });
      } else if (it && it.type === 'wire' && o) {
        const wno = state.A && state.A.wireNo[s.net.id];
        A.splice(ta.length, 0, { label: 'CABLE', icon: 'i-cable', run: () => cableDialog(s) });
        if (wno && !s.net.named) A.push({ label: 'FIX NO.', icon: 'i-number', run: () => fixWireNumber(o, wno) });
        A.push({ label: 'MOVE', icon: 'i-move', run: () => startMove({ type: 'wire', uuid: uuidOf(o), name: 'wire' }) });
        A.push({ label: 'DELETE', icon: 'i-trash', danger: true, run: () => run('Delete wire', () => E.deleteItems(sh, [{ type: 'wire', wire: o }]), { anchor: null }) });
      } else if (it && (it.type === 'junction' || it.type === 'nc') && o) {
        A.push({ label: 'DELETE', icon: 'i-trash', danger: true, run: () => run('Delete ' + (it.type === 'nc' ? 'no-connect flag' : 'junction'), () => E.deleteItems(sh, [{ type: it.type, item: o }]), { anchor: null }) });
      } else if (it && it.type === 'pin' && o) {
        const lonely = !sh.wires.some((w) => E.same(w.a, o.pos) || E.same(w.b, o.pos)) && !sh.noConnects.some((n) => E.same(n.p, o.pos));
        if (lonely) A.push({ label: 'NO-CONN', icon: 'i-nc', run: () => run('No-connect flag', () => E.addNoConnect(sh, o.pos)) });
        A.push({ label: 'WIRE', icon: 'i-wire', run: () => { setMode('wire'); state.wire = { anchors: [o.pos.slice()], flips: [false] }; updateWireOverlay(o.pos); } });
      }
      A.push({ label: 'ZOOM', icon: 'i-target', run: zoomToSelection });
      if (s.net.inst.size > 1) A.push({ label: 'NEXT SHEET', icon: 'i-next', run: () => nextSheetForNet(s.net) });
    } else if (s.type === 'sheet') {
      const sheet = sh.sheets[s.idx];
      const child = s.inst.children.find((c) => c.sheetSym === sheet);
      A.push({ label: 'ENTER', icon: 'i-open', run: () => child && showInstance(child) });
    } else if (s.type === 'graphic') {
      const o = graphicObj(s.it, sh);
      if (o) {
        const name = graphicName(s.it, o);
        if (s.it[0] === 'T') A.push({ label: 'EDIT', icon: 'i-edit', run: () => textDialog({ edit: o }) });
        else if (s.it[0] === 'G') A.push({ label: 'STYLE', icon: 'i-style', run: () => styleDialog(o) });
        A.push({ label: 'MOVE', icon: 'i-move', run: () => startMove({ type: 'graphic', kind: s.it[0], uuid: uuidOf(o), name: name.toLowerCase() }) });
        A.push({ label: 'DELETE', icon: 'i-trash', danger: true, run: () => run('Delete ' + name.toLowerCase(), () => E.deleteNode(sh, o.src), { anchor: null }) });
        if (!uuidOf(o)) A.splice(A.findIndex((x) => x.label === 'MOVE'), 1);
      }
    }
    return A;
  }
  function copyPart(inst, si) {
    const sh = inst.sheet, sym = sh.symbols[si];
    const r = run('Copy ' + inst.refs[si].ref, () => E.copySymbol(state.project, sh, inst, sym, [5.08, 5.08]), { anchor: null });
    if (!r) return;
    // Select the copy and go straight into move mode so it can be placed.
    const sh2 = state.inst.sheet;
    const ni = state.inst.refs.findIndex((x) => x.ref === r.ref);
    if (ni >= 0) { state.sel = { type: 'symbol', inst: state.inst, si: ni }; applyHighlight(); renderSelectionUI(); startMove({ type: 'symbol', uuid: sh2.symbols[ni].uuid, name: r.ref }); toast(`${r.ref} added. Drag to place it, then DONE.`); }
  }

  // ---- saving
  $('chipEdits').addEventListener('click', () => saveDialog());
  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'schematic'; }
  // Lines added/removed, counted as a multiset (close to what GitHub's diff shows)
  function lineDiff(a, b) {
    const count = new Map();
    for (const l of a.split('\n')) count.set(l, (count.get(l) || 0) + 1);
    let add = 0;
    for (const l of b.split('\n')) { const c = count.get(l) || 0; if (c > 0) count.set(l, c - 1); else add++; }
    let del = 0;
    for (const c of count.values()) del += c;
    return { del, add };
  }
  function saveDialog() {
    const files = pendingFiles();
    if (!files.length) { toast('No unsaved edits.'); return; }
    const list = h('div', { class: 'difflist' });
    for (const f of files) { const d = lineDiff(state.base.get(f.path), f.text); list.append(h('div', null, f.path + '  ', h('span', { class: 'add', text: '+' + d.add }), ' ', h('span', { class: 'del', text: '−' + d.del }))); }
    const labels = (state.undo || []).map((u) => u.label);
    const summary = labels.length ? Array.from(new Set(labels)).slice(0, 6).join('; ') : 'Schematic edits';
    const discard = { label: 'DISCARD EDITS', run: () => {
      if (!discard.armed) { discard.armed = true; toast('Tap DISCARD EDITS again to throw away all unsaved edits.'); return; }
      closeDialog();
      for (const f of state.files) f.text = state.base.get(f.path);
      state.undo = []; state.redo = [];
      rebuild(null); persistEdits(); toast('Edits discarded');
    } };
    const s = state.source;
    if (s && s.kind === 'github') {
      const now = new Date();
      const stamp = now.toISOString().slice(0, 10).replace(/-/g, '') + '-' + String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
      const onWork = /^(tracer|loomline)\//.test(s.ref);
      const branch = h('input', { class: 'input', id: 'svBranch', value: onWork ? s.ref : `loomline/${slug(state.project.name)}-${stamp}`, spellcheck: 'false', autocapitalize: 'off' });
      const msg = h('textarea', { class: 'input', id: 'svMsg', spellcheck: 'true' });
      msg.value = `${state.project.name}: ${summary}\n\nEdited with Loomline.`;
      const prBox = h('input', { type: 'checkbox', checked: true });
      const base = onWork ? (state.prBase || 'main') : s.ref;
      openDialog('SAVE TO GITHUB', [
        h('p', { class: 'hint', text: `Commits your edits to a branch of ${s.repo}. Open a pull request so they can be reviewed in GitHub and merged into ${base}. Open the files in KiCad before merging to check them.` }),
        section('Changed files', String(files.length), list),
        h('div', { class: 'field' }, h('label', { for: 'svBranch', text: 'Branch' }), branch),
        h('div', { class: 'field' }, h('label', { for: 'svMsg', text: 'Commit message' }), msg),
        h('label', { class: 'check' }, prBox, `Open a pull request into ${base}`)
        , h('button', { class: 'btn small', type: 'button', onclick: () => { closeDialog(); startCompare({ kind: 'edits' }); } }, icon('i-compare'), 'REVIEW CHANGES')
      ], [discard, { label: 'CANCEL', run: closeDialog }, { label: 'COMMIT', primary: true, run: () => saveToGitHub(branch.value.trim(), msg.value.trim(), prBox.checked, base) }]);
    } else {
      openDialog('SAVE EDITS', [
        h('p', { class: 'hint', text: 'This project was opened from files, so the edited .kicad_sch files are downloaded as a ZIP. Copy them over the originals and open them in KiCad.' }),
        section('Changed files', String(files.length), list),
        h('button', { class: 'btn small', type: 'button', onclick: () => { closeDialog(); startCompare({ kind: 'edits' }); } }, icon('i-compare'), 'REVIEW CHANGES')
      ], [discard, { label: 'CANCEL', run: closeDialog }, { label: 'DOWNLOAD ZIP', primary: true, run: () => { downloadZip(files); closeDialog(); } }]);
    }
  }
  function downloadZip(files) {
    const blob = Zip.writeZip(files.map((f) => ({ path: f.path, text: f.text })));
    const a = h('a', { href: URL.createObjectURL(blob), download: slug(state.project.name) + '-edited.zip' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    for (const f of files) state.base.set(f.path, f.text);
    persistEdits(); renderEditUI();
    toast('Downloaded ' + files.length + ' file' + (files.length === 1 ? '' : 's'));
  }
  async function saveToGitHub(branch, message, openPR, base) {
    if (!/^[\w.\/-]+$/.test(branch) || branch.endsWith('/') || branch.includes('..')) { banner('err', 'Use letters, numbers, dashes and slashes for the branch name.'); return; }
    if (!message) { banner('err', 'Write a short commit message.'); return; }
    const s = state.source, files = pendingFiles();
    closeDialog();
    loading('Saving to GitHub…');
    try {
      const res = await GitHub.commitFiles(state.token, s.repo, { branch, parentSha: s.head.sha, baseTree: s.head.tree, message, files: files.map((f) => ({ path: f.path, text: f.text })) });
      let pr = null;
      if (openPR) pr = await GitHub.ensurePullRequest(state.token, s.repo, { branch, base, title: message.split('\n')[0], body: message.split('\n').slice(2).join('\n') + '\n\nFiles: ' + files.map((f) => '`' + f.path + '`').join(', ') });
      // The committed text is now the baseline; cache it for offline use.
      const shas = {};
      for (const f of files) { const sha = await GitHub.gitBlobSha(f.text); shas[f.path] = sha; await Store.set('blob:' + sha, f.text); state.base.set(f.path, f.text); }
      const head = { sha: res.sha, tree: res.tree, message, date: res.date, author: 'you' };
      if (!/^(tracer|loomline)\//.test(s.ref)) state.prBase = s.ref;
      Store.pref('prBase', state.prBase || base);
      s.ref = branch; s.head = head; s.projCommit = head; s.pinned = false;
      state.gh.ref = branch; Store.pref('gh', state.gh);
      state.ghHead = head;
      const proj = state.ghProjects && state.ghProjects.find((p) => p.key === s.projKey);
      if (proj) {
        for (const f of proj.files) if (shas[f.path]) f.sha = shas[f.path];
        await Store.set('manifest:' + s.repo + ':' + s.projKey, { head, ref: branch, files: proj.files, projCommit: head, at: Date.now() });
      }
      state.undo = []; state.redo = [];
      await persistEdits();
      updateHeader(); renderEditUI();
      loading(null);
      banner('info', `Saved to ${branch}` + (pr ? ` · pull request #${pr.number}${pr.existed ? ' updated' : ' opened'}` : '') + '.', pr ? [{ label: 'OPEN PR', primary: true, run: () => window.open(pr.url, '_blank', 'noopener') }] : []);
    } catch (e) {
      loading(null);
      banner('err', e.message || String(e));
    }
  }

  // ---- Status bar (bottom), like the KiCad Editor app
  function statusAction(label, ico, fn, disabled, cls) {
    return h('button', { class: 'sa' + (cls ? ' ' + cls : ''), onclick: fn, disabled: !!disabled }, icon(ico), label);
  }
  function putActions(acts, list) {
    const max = window.matchMedia('(max-width: 760px)').matches ? 3 : 6;
    const shown = list.length > max ? list.slice(0, max - 1) : list;
    for (const a of shown) acts.append(statusAction(a.label, a.icon, a.run, a.disabled, a.danger ? 'danger' : a.primary ? 'primary' : ''));
    if (list.length > max) {
      const rest = list.slice(max - 1);
      const more = statusAction('MORE', 'i-more', () => openMenu(more, rest));
      acts.append(more);
    }
  }
  function renderStatus() {
    const s = state.sel, P = state.project;
    const ico = $('statusIco'), t1 = $('st1'), t2 = $('st2'), acts = $('statusActions');
    acts.replaceChildren();
    ico.classList.remove('trace', 'part');
    t1.classList.remove('trace');
    $('status').classList.toggle('editing', state.mode !== 'select');
    const setIco = (id) => { ico.firstElementChild.setAttribute('href', '#' + id); };
    if (!P) { setIco('i-hand'); t1.textContent = 'No project open'; t2.textContent = 'Connect GitHub or open files'; return; }
    if (state.mode === 'wire') {
      const n = state.wire.anchors.length;
      setIco('i-wire');
      t1.textContent = n ? 'Drawing wire' : 'Wire';
      t2.textContent = n ? 'Tap corners · tap a pin or wire to finish' : 'Tap a pin, wire end or empty grid to start';
      const L = [];
      if (n > 1) L.push({ label: 'FINISH', icon: 'i-check', primary: true, run: finishWire });
      if (n > 1) L.push({ label: 'FLIP', icon: 'i-flip', run: wireFlip });
      if (n) L.push({ label: 'BACK', icon: 'i-undo', run: wireBack });
      L.push({ label: 'DONE', icon: 'i-close', run: () => setMode('select') });
      putActions(acts, L);
      return;
    }
    if (state.mode === 'draw') { renderDrawStatus(setIco, t1, t2, acts); return; }
    if (state.mode === 'label') {
      setIco('i-tag');
      t1.textContent = 'Label';
      t2.textContent = 'Tap a wire or pin end to name that net';
      putActions(acts, [{ label: 'DONE', icon: 'i-close', run: () => setMode('select') }]);
      return;
    }
    if (state.mode === 'move') {
      setIco('i-move');
      t1.textContent = 'Moving ' + (state.moveTarget ? state.moveTarget.name : '');
      t2.textContent = 'Drag anywhere to move it · snaps to 1.27 mm';
      const L = [];
      const t = state.moveTarget;
      if (t && t.type === 'symbol') L.push({ label: 'ROTATE', icon: 'i-rotate', run: () => { const sh = state.inst.sheet, sym = sh.symbols.find((x) => x.uuid === t.uuid); if (sym) run('Rotate ' + t.name, () => E.transformSymbol(sh, sym, 'rotate'), { checkMerges: true }); } });
      L.push({ label: 'DONE', icon: 'i-check', primary: true, run: () => setMode('select') });
      putActions(acts, L);
      return;
    }
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
      const it = s.item, o = itemObj(it);
      const what = it && o ? (it.type === 'label' ? 'Label · ' : it.type === 'wire' ? 'Wire · ' : it.type === 'pin' ? `Pin ${o.number} · ` : it.type === 'nc' ? 'No-connect · ' : it.type === 'junction' ? 'Junction · ' : '') : '';
      const wno = state.A && state.A.wireNo[net.id];
      const cab = cableOfSel(s), cf = cab && cab.flag ? Loom.cableFields(cab.flag) : null;
      t2.textContent = (cf ? cableText(cf) + ' · ' : '') + traceSummary(s) + what + (wno && !net.named ? `Wire ${wno} · ` : '') + (net.bus ? `Bus · ${(net.members || []).length} members` : `${net.pins.length} pin${net.pins.length === 1 ? '' : 's'}`) + ` · ${sheets} sheet${sheets === 1 ? '' : 's'}`;
    } else if (s.type === 'symbol') {
      const inst = s.inst, sym = inst.sheet.symbols[s.si], ref = inst.refs[s.si].ref;
      const unit = sym.lib && sym.lib.unitCount > 1 ? K.unitLetter(inst.refs[s.si].unit || sym.unit) : '';
      const val = K.unescape((sym.props.find((p) => p.name === 'Value') || {}).value || '');
      const fp = ((sym.props.find((p) => p.name === 'Footprint') || {}).value || '').split(':').pop();
      setIco('i-chip'); ico.classList.add('part');
      t1.textContent = ref + unit + (val ? '  ' + val : '');
      t2.textContent = (sym.dnp ? 'DNP · ' : '') + (fp || sym.libId);
    } else if (s.type === 'sheet') {
      const sheet = s.inst.sheet.sheets[s.idx];
      setIco('i-hier'); ico.classList.add('part');
      t1.textContent = sheet.name;
      t2.textContent = sheet.file + ' · ' + sheet.pins.length + ' pins';
    } else if (s.type === 'graphic') {
      const o = graphicObj(s.it, s.inst.sheet);
      setIco(s.it[0] === 'G' ? 'i-draw' : 'i-text'); ico.classList.add('part');
      t1.textContent = graphicName(s.it, o);
      t2.textContent = s.it[0] === 'G' && o ? `Drawing · line ${o.st && o.st.w ? o.st.w + ' mm' : 'default'}${o.st && o.st.type && o.st.type !== 'default' && o.st.type !== 'solid' ? ' · ' + o.st.type.replace('_', '-') : ''}` : 'Text on the drawing';
    }
    const L = selectionActions();
    L.push({ label: 'CLEAR', icon: 'i-close', run: clearSelection });
    putActions(acts, L);
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
    if (s.type === 'net' && traceOf(s)) { showTraceStep(s); return; }
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
        refSel.replaceChildren(...list.filter((b) => b !== INSTALL_BRANCH).map((b) => h('option', { value: b, selected: b === gh.ref, text: b })));
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
          for (const c of list) hist.append(h('div', { class: 'row-split' + (c.sha === s.head.sha ? ' current' : '') },
            h('button', { class: 'row', onclick: async () => { closeDrawers(); await connectAndOpen(s.projKey, { commit: c, pinned: true }); } },
              h('span', { class: 'main' }, h('span', { class: 'nm2' }, h('b', { text: firstLine(c.message) }), h('small', null, h('span', { class: 'mono', text: c.sha.slice(0, 7) }), ' · ' + (c.author || '') + ' · ' + ago(c.date))))),
            c.sha === s.head.sha ? null : h('button', { class: 'btn small', title: 'Compare the open revision with this one', onclick: () => { closeDrawers(); startCompare({ kind: 'commit', commit: c }); } }, icon('i-compare'), 'COMPARE')));
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
    const tog = (k, text) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!show[k], onchange: (e) => setShow(k, e.target.checked) }), text);
    body.append(section('Display', null, seg, h('label', { class: 'check' }, grid, 'Show grid'), h('label', { class: 'check' }, dim, 'Fade everything except the highlighted net'),
      tog('wireNos', 'Wire numbers'), tog('xrefs', 'Cross-references between part units'), tog('markers', 'Design check markers'), tog('install', 'Colour wires by install status')));
    if (state.project) body.append(section('Tools', null, h('div', { class: 'actions' },
      h('button', { class: 'btn small', onclick: () => { closeDrawers(); showTab('reports', true); } }, icon('i-report'), 'Reports'),
      h('button', { class: 'btn small', onclick: () => { closeDrawers(); showTab('compare', true); } }, icon('i-compare'), 'Compare revisions'))));
    body.append(section('Storage', null,
      h('p', { class: 'hint', text: 'Downloaded schematics are kept on this device so the last revision opens offline.' }),
      h('button', { class: 'btn small', onclick: async () => { await Store.clearPrefix('blob:'); await Store.clearPrefix('tree:'); await Store.clearPrefix('manifest:'); toast('Downloaded schematics cleared'); } }, 'Clear downloaded schematics')));
    body.append(h('p', { class: 'hint', text: `Loomline ${VERSION}. Reads KiCad 6–9 schematics; nothing is uploaded anywhere except requests to GitHub.` }));
  }

  // ================================================================== DRAW mode: parts and shapes
  // PART places a symbol from the library; LINE, RECT, CIRCLE, ARC and TEXT add KiCad graphics.
  const DRAW_TOOLS = [['part', 'PART', 'i-part'], ['line', 'LINE', 'i-line'], ['rect', 'RECT', 'i-rect'], ['circle', 'CIRCLE', 'i-circle'], ['arc', 'ARC', 'i-arc'], ['text', 'TEXT', 'i-text']];
  const COLOURS = { default: null, red: [200, 0, 0, 1], blue: [0, 0, 194, 1], green: [0, 132, 0, 1], black: [0, 0, 0, 1] };
  function drawStyle() { return Object.assign({ width: 0, type: 'default', fill: 'none', colour: 'default' }, Store.pref('drawStyle') || {}); }
  const styleFor = (st) => ({ width: st.width, type: st.type, fill: st.fill, color: COLOURS[st.colour] || null });
  function graphicObj(it, sh) {
    sh = sh || state.inst.sheet;
    const i = +it.slice(1);
    return it[0] === 'G' ? sh.graphics[i] : it[0] === 'T' ? sh.texts[i] : it[0] === 'B' ? sh.textBoxes[i] : null;
  }
  function graphicName(it, o) {
    if (!o) return 'Drawing';
    if (it[0] === 'T') return 'Text “' + plain(o.s).slice(0, 40) + '”';
    if (it[0] === 'B') return 'Text box';
    return { polyline: 'Line', rectangle: 'Rectangle', circle: 'Circle', arc: 'Arc', bezier: 'Curve' }[o.kind] || 'Drawing';
  }
  function selectGraphic(inst, it) {
    state.sel = { type: 'graphic', inst, it };
    applyHighlight();
    renderSelectionUI();
  }
  const gridSnap = (wp) => [E.snap(wp[0]), E.snap(wp[1])];
  function setDrawTool(tool) {
    state.draw = { tool, pts: [], part: state.draw && state.draw.part };
    view.overlay = { pts: [], dots: [] };
    view.redraw();
    if (tool === 'part' && !state.draw.part) openPartPicker();
    renderStatus();
  }
  function drawOverlay(extra) {
    const d = state.draw, pts = d.pts.slice();
    const ov = { pts: [], dots: pts.slice(), shapes: [] };
    if (d.tool === 'line') ov.pts = pts.concat(extra ? [extra] : []);
    else if (d.tool === 'rect' && pts.length) { const a = pts[0], b = extra || a; ov.pts = [a, [b[0], a[1]], b, [a[0], b[1]], a]; }
    else if (d.tool === 'circle' && pts.length) { const c = pts[0], q = extra || c, r = Math.hypot(q[0] - c[0], q[1] - c[1]); ov.pts = Array.from({ length: 49 }, (_, i) => [c[0] + r * Math.cos(i * Math.PI / 24), c[1] + r * Math.sin(i * Math.PI / 24)]); }
    else if (d.tool === 'arc') ov.pts = pts.concat(extra ? [extra] : []);
    if (extra) ov.ring = extra;
    view.overlay = ov;
    view.redraw();
  }
  function drawTap(wp, type) {
    const d = state.draw, sh = state.inst.sheet;
    const p = gridSnap(wp);
    const st = styleFor(drawStyle());
    if (d.tool === 'part') {
      if (!d.part) { openPartPicker(); return; }
      placePart(d.part, p);
      return;
    }
    if (d.tool === 'text') { textDialog({ p }); return; }
    d.pts.push(p);
    if (d.tool === 'rect' && d.pts.length === 2) { const [a, b] = d.pts; d.pts = []; if (a[0] === b[0] || a[1] === b[1]) { toast('Tap two opposite corners.'); drawOverlay(); return; } run('Add rectangle', () => E.addGraphic(sh, 'rect', { a, b }, st), { anchor: null }); }
    else if (d.tool === 'circle' && d.pts.length === 2) { const [c, q] = d.pts; d.pts = []; run('Add circle', () => E.addGraphic(sh, 'circle', { c, r: Math.hypot(q[0] - c[0], q[1] - c[1]) }, st), { anchor: null }); }
    else if (d.tool === 'arc' && d.pts.length === 3) { const [a, m, b] = d.pts; d.pts = []; const cross = (m[0] - a[0]) * (b[1] - a[1]) - (m[1] - a[1]) * (b[0] - a[0]); if (Math.abs(cross) < 1e-6) { toast('The three points are in a line; tap a middle point off the line.'); drawOverlay(); return; } run('Add arc', () => E.addGraphic(sh, 'arc', { a, m, b }, st), { anchor: null }); }
    drawOverlay();
    renderStatus();
  }
  function finishLine() {
    const d = state.draw;
    if (d.pts.length < 2) { toast('Tap at least two points.'); return; }
    const pts = d.pts; d.pts = [];
    run('Add line', () => E.addGraphic(state.inst.sheet, 'line', { pts }, styleFor(drawStyle())), { anchor: null });
    drawOverlay(); renderStatus();
  }
  function renderDrawStatus(setIco, t1, t2, acts) {
    const d = state.draw, tool = DRAW_TOOLS.find((x) => x[0] === d.tool) || DRAW_TOOLS[0];
    setIco(tool[2]);
    const n = d.pts.length;
    const hints = {
      part: d.part ? `Tap where ${d.part.name} goes` : 'Choose a part to place',
      line: n ? 'Tap the next point · FINISH when done' : 'Tap the first point',
      rect: n ? 'Tap the opposite corner' : 'Tap one corner',
      circle: n ? 'Tap a point on the edge' : 'Tap the centre',
      arc: ['Tap where the arc starts', 'Tap a point the arc passes through', 'Tap where the arc ends'][n] || '',
      text: 'Tap where the text goes'
    };
    t1.textContent = 'Draw · ' + tool[1].toLowerCase();
    t2.textContent = hints[d.tool];
    const L = [];
    if (d.tool === 'line' && n > 1) L.push({ label: 'FINISH', icon: 'i-check', primary: true, run: finishLine });
    if (n) L.push({ label: 'BACK', icon: 'i-undo', run: () => { d.pts.pop(); drawOverlay(); renderStatus(); } });
    if (d.tool === 'part') L.push({ label: d.part ? 'CHANGE' : 'CHOOSE', icon: 'i-part', primary: !d.part, run: openPartPicker });
    const last = d.tool === 'part' && d.last && state.inst.sheet.symbols.find((x) => x.uuid === d.last.uuid);
    if (last) L.push({ label: 'ROTATE', icon: 'i-rotate', run: () => { run('Rotate ' + d.last.ref, () => E.transformSymbol(state.inst.sheet, last, 'rotate'), { anchor: null }); const i = state.inst.sheet.symbols.findIndex((x) => x.uuid === d.last.uuid); view.setHighlight(null, i, -1); } });
    if (d.tool !== 'part') L.push({ label: 'STYLE', icon: 'i-style', run: () => styleDialog(null) });
    L.push({ label: 'DONE', icon: 'i-close', run: () => setMode('select') });
    putActions(acts, L);
    renderDrawBar();
  }
  function renderDrawBar() {
    const bar = $('drawBar');
    bar.hidden = state.mode !== 'draw';
    if (bar.hidden) return;
    bar.replaceChildren(...DRAW_TOOLS.map(([k, l, ic]) => h('button', { class: 'dt', 'aria-pressed': String(state.draw.tool === k), title: l, onclick: () => setDrawTool(k) }, icon(ic), h('span', { text: l }))));
  }
  // ---- line style (new shapes, or the selected one)
  function styleDialog(target) {
    const cur = target ? { width: target.st ? target.st.w || 0 : 0, type: target.st && target.st.type || 'default', fill: target.fl && target.fl.type || 'none', colour: 'default' } : drawStyle();
    const w = seg('Line width', [['0', 'DEFAULT'], ['0.25', '0.25'], ['0.5', '0.5'], ['1', '1 MM']], String(cur.width || 0));
    const t = seg('Line type', [['default', 'SOLID'], ['dash', 'DASH'], ['dot', 'DOT'], ['dash_dot', 'DASH-DOT']], cur.type === 'solid' ? 'default' : cur.type);
    const f = seg('Fill', [['none', 'NONE'], ['background', 'FILLED']], cur.fill === 'background' ? 'background' : 'none');
    const c = seg('Colour', [['default', 'DEFAULT'], ['red', 'RED'], ['blue', 'BLUE'], ['green', 'GREEN'], ['black', 'BLACK']], cur.colour || 'default');
    openDialog(target ? 'LINE STYLE' : 'STYLE FOR NEW SHAPES', [
      h('div', { class: 'field' }, h('label', { text: 'Line width' }), w.el),
      h('div', { class: 'field' }, h('label', { text: 'Line type' }), t.el),
      h('div', { class: 'field' }, h('label', { text: 'Fill (rectangles and circles)' }), f.el),
      h('div', { class: 'field' }, h('label', { text: 'Colour' }), c.el)
    ], [{ label: 'CANCEL', run: closeDialog }, { label: 'APPLY', primary: true, run: () => {
      const st = { width: +w.get(), type: t.get(), fill: f.get(), colour: c.get() };
      closeDialog();
      if (target) run('Restyle ' + graphicName('G', target).toLowerCase(), () => E.styleNode(state.inst.sheet, target.src, styleFor(st)));
      else { Store.pref('drawStyle', st); toast('New shapes use this style.'); }
    } }]);
  }
  // ---- text
  function textDialog(o) {
    const ed = o.edit;
    const txt = h('textarea', { class: 'input', id: 'txtValue', rows: 3, spellcheck: 'true' });
    txt.value = ed ? K.unescape(ed.s) : '';
    const body = [h('div', { class: 'field' }, h('label', { for: 'txtValue', text: 'Text' }), txt)];
    let size, bold, italic, ang;
    if (!ed) {
      const last = Store.pref('textStyle') || {};
      size = seg('Size', [['1.27', 'SMALL'], ['2', 'MEDIUM'], ['2.54', 'LARGE'], ['3.81', 'TITLE']], last.size || '1.27');
      ang = seg('Direction', [['0', 'ACROSS'], ['90', 'UP']], last.angle || '0');
      bold = h('input', { type: 'checkbox', checked: !!last.bold });
      italic = h('input', { type: 'checkbox', checked: !!last.italic });
      body.push(h('div', { class: 'field' }, h('label', { text: 'Size' }), size.el), h('div', { class: 'field' }, h('label', { text: 'Direction' }), ang.el),
        h('label', { class: 'check' }, bold, 'Bold'), h('label', { class: 'check' }, italic, 'Italic'));
    }
    const go = () => {
      const v = txt.value.trim();
      if (!v) { txt.focus(); return; }
      closeDialog();
      const sh = state.inst.sheet;
      if (ed) run('Edit text', () => E.editText(sh, ed, v));
      else {
        const ts = { size: size.get(), angle: ang.get(), bold: bold.checked, italic: italic.checked };
        Store.pref('textStyle', ts);
        run('Add text', () => E.addGraphic(sh, 'text', { p: o.p, text: v, size: +ts.size, angle: +ts.angle, bold: ts.bold, italic: ts.italic }, styleFor(drawStyle())), { anchor: null });
      }
    };
    openDialog(ed ? 'EDIT TEXT' : 'ADD TEXT', body, [{ label: 'CANCEL', run: closeDialog }, { label: ed ? 'SAVE' : 'ADD', primary: true, run: go }]);
    setTimeout(() => txt.focus(), 50);
  }

  // ---- part library: index, per-library files (cached on the device), picker with preview
  const LIB_BASE = 'library/';
  const libState = { index: null, loading: null, files: new Map() };
  async function loadLibIndex() {
    if (libState.index) return libState.index;
    if (libState.loading) return libState.loading;
    libState.loading = (async () => {
      let idx = null;
      try { const r = await fetch(LIB_BASE + 'index.json', { cache: 'no-cache' }); if (r.ok) { idx = await r.json(); Store.set('lib:index', idx); } } catch (e) { /* offline */ }
      if (!idx) idx = await Store.get('lib:index');
      if (!idx) throw new Error('The part library could not be loaded. Connect to the internet once to download it.');
      idx.hay = idx.rows.map((r) => (r[1] + ' ' + r[2] + ' ' + r[3] + ' ' + idx.libs[r[0]].name).toLowerCase());
      libState.index = idx;
      return idx;
    })();
    try { return await libState.loading; } finally { libState.loading = null; }
  }
  async function loadLibFile(lib) {
    if (libState.files.has(lib)) return libState.files.get(lib);
    const idx = await loadLibIndex();
    const meta = idx.libs.find((l) => l.name === lib);
    if (!meta) throw new Error(`${lib} isn't in the part library.`);
    let bundle = null;
    try {
      const r = await fetch(LIB_BASE + (meta.dir || 'kicad/') + meta.file);
      if (r.ok) {
        const raw = new Uint8Array(await r.arrayBuffer());
        // Some servers decompress .gz on the way; only inflate when the gzip magic bytes are there.
        const txt = raw[0] === 0x1f && raw[1] === 0x8b ? await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).text() : new TextDecoder().decode(raw);
        bundle = JSON.parse(txt);
        Store.set('libbundle:' + (meta.dir || '') + meta.file, bundle);
      }
    } catch (e) { /* offline */ }
    if (!bundle) bundle = await Store.get('libbundle:' + (meta.dir || '') + meta.file);
    if (!bundle) throw new Error(`The ${meta.cat} parts aren't on this device yet. Connect to the internet once to download them.`);
    for (const [name, data] of Object.entries(bundle.libs)) libState.files.set(name, data);
    return libState.files.get(lib);
  }
  async function libEntry(lib, name) {
    const f = await loadLibFile(lib);
    const text = f.symbols[name];
    if (!text) throw new Error(`${lib}:${name} isn't in the library.`);
    const ext = /\(extends "((?:[^"\\]|\\.)*)"\)/.exec(text);
    return { lib, name, text, parentText: ext ? f.symbols[ext[1]] : null };
  }
  const BLANK_SHEET = '(kicad_sch\n\t(version 20250114)\n\t(generator "loomline")\n\t(generator_version "1")\n\t(uuid "00000000-0000-4000-8000-000000000001")\n\t(paper "A4")\n\t(lib_symbols)\n\t(sheet_instances\n\t\t(path "/"\n\t\t\t(page "1")\n\t\t)\n\t)\n)\n';
  function previewScene(entry) {
    const P0 = K.buildProject([{ path: 'preview.kicad_sch', text: BLANK_SHEET }]);
    const r = E.addLibSymbol(P0, P0.root.sheet, P0.root, entry, [100, 100]);
    const P1 = K.buildProject([{ path: 'preview.kicad_sch', text: r.text }]);
    return { scene: R.buildScene(P1, P1.root), units: r.units };
  }
  function openPartPicker() {
    closePicker();
    const recent = Store.pref('recentParts') || [];
    const q = h('input', { class: 'input', type: 'search', placeholder: 'Search 10,000 parts: relay, pushbutton, fuse, Conn_01x04…', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    const cats = h('div', { class: 'chips catbar' });
    const list = h('div', { class: 'rows plist' });
    const canvas = h('canvas', { class: 'pcanvas' });
    const info = h('div', { class: 'pinfo' }, h('p', { class: 'hint', text: 'Pick a part to see it here.' }));
    const place = h('button', { class: 'btn primary', disabled: true }, icon('i-part'), 'PLACE');
    const wrap = h('div', { class: 'picker-wrap', id: 'pickerWrap', role: 'dialog', 'aria-label': 'Add a part' },
      h('div', { class: 'report-head' }, h('div', { class: 'titles' }, h('b', { text: 'ADD A PART' }), h('small', { id: 'pickCount', text: 'Loading the library…' })),
        h('button', { class: 'ib', 'aria-label': 'Close', onclick: closePicker }, icon('i-close'))),
      h('div', { class: 'picker-body' },
        h('div', { class: 'pick-left' }, q, cats, list),
        h('div', { class: 'pick-right' }, h('div', { class: 'pprev' }, canvas), info, h('div', { class: 'actions' }, place))));
    document.body.append(wrap);
    let pv = null, chosen = null, cat = state.pickCat || 'All';
    const show = async (row) => {
      const idx = libState.index, lib = idx.libs[row[0]].name, name = row[1];
      for (const b of list.querySelectorAll('.row.current')) b.classList.remove('current');
      const el = list.querySelector(`[data-k="${CSS.escape(lib + ':' + name)}"]`); if (el) el.classList.add('current');
      info.replaceChildren(h('p', { class: 'hint', text: 'Loading ' + lib + '…' }));
      try {
        const entry = await libEntry(lib, name);
        const { scene, units } = previewScene(entry);
        if (!pv) pv = new R.SchematicView(canvas, {});
        pv.setTheme(view.dark); pv.showGrid = false;
        pv.setScene(scene, true);
        const sy = scene.syms[0];
        requestAnimationFrame(() => { pv.resize(); pv.fit(sy ? sy.bb : scene.page, 16); });
        chosen = entry;
        place.disabled = false;
        info.replaceChildren(
          h('div', { class: 'title small', text: name }),
          h('div', { class: 'sub mono', text: lib + ' · ref ' + (row[4] || '?') + ' · ' + row[6] + ' pin' + (row[6] === 1 ? '' : 's') + (units.length > 1 ? ' · ' + units.length + ' units' : '') }),
          row[2] ? h('p', { class: 'pdesc', text: row[2] }) : null,
          row[3] ? h('p', { class: 'hint', text: 'Keywords: ' + row[3] }) : null);
      } catch (e) { info.replaceChildren(h('p', { class: 'err-text', text: e.message })); }
    };
    place.addEventListener('click', () => {
      if (!chosen) return;
      const rec = [chosen.lib + ':' + chosen.name].concat(recent.filter((x) => x !== chosen.lib + ':' + chosen.name)).slice(0, 20);
      Store.pref('recentParts', rec);
      state.draw = { tool: 'part', pts: [], part: chosen };
      closePicker();
      if (state.mode !== 'draw') setMode('draw');
      renderStatus();
      toast(`Tap the drawing where ${chosen.name} goes.`);
    });
    const fill = () => {
      const idx = libState.index; if (!idx) return;
      const terms = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      list.replaceChildren();
      let rows = [];
      if (!terms.length && cat === 'All' && recent.length) {
        const byKey = new Map(idx.rows.map((r) => [idx.libs[r[0]].name + ':' + r[1], r]));
        rows = recent.map((k) => byKey.get(k)).filter(Boolean);
        if (rows.length) list.append(h('div', { class: 'row group' }, h('span', { class: 'main' }, h('span', { class: 'nm', text: 'Recently used' }))));
      }
      if (!rows.length || terms.length || cat !== 'All') {
        const scored = [];
        const q0 = terms.join(' ');
        idx.rows.forEach((r, i) => {
          if (cat !== 'All' && idx.libs[r[0]].cat !== cat) return;
          const hay = idx.hay[i];
          if (!terms.every((t) => hay.includes(t))) return;
          const nm = r[1].toLowerCase();
          const sc = !terms.length ? 3 : nm === q0 ? 0 : nm.startsWith(terms[0]) ? 1 : nm.includes(terms[0]) ? 2 : 3;
          scored.push([sc, r]);
        });
        scored.sort((a, b) => a[0] - b[0] || K.naturalCmp(a[1][1], b[1][1]));
        $('pickCount').textContent = `${scored.length.toLocaleString()} match${scored.length === 1 ? '' : 'es'} in ${idx.rows.length.toLocaleString()} parts`;
        rows = scored.slice(0, 150).map((x) => x[1]);
        if (scored.length > 150) setTimeout(() => list.append(h('div', { class: 'row' }, h('span', { class: 'meta', text: `${scored.length - 150} more; type more to narrow the list` }))), 0);
      } else $('pickCount').textContent = `${idx.rows.length.toLocaleString()} parts in ${idx.libs.length} libraries`;
      for (const r of rows) {
        const lib = idx.libs[r[0]].name;
        list.append(h('button', { class: 'row', 'data-k': lib + ':' + r[1], onclick: () => show(r) },
          h('span', { class: 'main' }, h('span', { class: 'nm2' }, h('b', { text: r[1] }), h('small', { text: (r[2] || '').slice(0, 90) }))),
          h('span', { class: 'meta', text: lib })));
      }
      if (!rows.length) list.append(h('div', { class: 'row' }, h('span', { class: 'meta', text: 'No parts match. Try a shorter word, or another category.' })));
    };
    q.addEventListener('input', fill);
    loadLibIndex().then((idx) => {
      const names = ['All'].concat(Array.from(new Set(idx.libs.map((l) => l.cat))));
      for (const c of names) cats.append(h('button', { class: 'chip' + (c === cat ? ' on' : ''), onclick: (e) => { cat = c; state.pickCat = c; for (const b of cats.children) b.classList.toggle('on', b === e.currentTarget); fill(); } }, c));
      fill();
      setTimeout(() => q.focus(), 50);
    }).catch((e) => { $('pickCount').textContent = e.message; });
  }
  function closePicker() { const w = $('pickerWrap'); if (w) w.remove(); }
  function placePart(entry, p) {
    const sh = state.inst.sheet;
    const r = run('Add ' + entry.name, () => E.addLibSymbol(state.project, sh, state.inst, entry, p), { anchor: null });
    if (!r) return;
    const ni = state.inst.refs.findIndex((x, i) => x.ref === r.ref && state.inst.sheet.symbols[i].unit === r.unit && E.same(state.inst.sheet.symbols[i].p, r.at));
    if (ni >= 0) {
      state.draw.last = { uuid: state.inst.sheet.symbols[ni].uuid, ref: r.ref };
      view.setHighlight(null, ni, -1);
      renderStatus();
      toast(`${r.ref} placed${r.units.length > 1 ? ` (unit A of ${r.units.length}; select it and tap ADD UNIT for the others)` : ''}. Tap again for another.`);
    }
  }
  function missingUnits(inst, si) {
    const sym = inst.sheet.symbols[si];
    if (!sym.lib || sym.lib.unitCount < 2) return [];
    const ref = inst.refs[si].ref;
    const have = new Set();
    for (const i of state.project.instances) i.sheet.symbols.forEach((s, k) => { if (i.refs[k].ref === ref) have.add(i.refs[k].unit || s.unit); });
    const out = [];
    for (let u = 1; u <= sym.lib.unitCount; u++) if (!have.has(u)) out.push(u);
    return out;
  }
  function addMissingUnit(inst, si, unit) {
    const sh = inst.sheet, sym = sh.symbols[si];
    const b = symBox(inst, si) || [sym.p[0], sym.p[1], sym.p[0], sym.p[1]];
    const p = [E.snap(b[2] + 10), E.snap(sym.p[1])];
    const r = run('Add unit ' + K.unitLetter(unit), () => E.addUnit(state.project, sh, inst, sym, unit, p), { anchor: null });
    if (!r) return;
    const ni = state.inst.refs.findIndex((x, i) => x.ref === r.ref && (x.unit || state.inst.sheet.symbols[i].unit) === unit);
    if (ni >= 0) { state.sel = { type: 'symbol', inst: state.inst, si: ni }; applyHighlight(); startMove({ type: 'symbol', uuid: state.inst.sheet.symbols[ni].uuid, name: r.ref + K.unitLetter(unit) }); toast(`${r.ref}${K.unitLetter(unit)} added. Drag it into place, then DONE.`); }
  }

  // ================================================================== Loomline: analysis features
  // Wire numbers, cross-references, design checks, reports, revision compare and the install log.
  // All of it is derived from the open project by loom.js and drawn as annotations by render.js.
  const show = Object.assign({ wireNos: true, xrefs: true, markers: true, install: false }, Store.pref('show') || {});
  state.show = show;
  function setShow(k, v) { show[k] = v; Store.pref('show', show); updateAnnot(); if (state.panelOpen) { state._keepScroll = true; renderPanel(); } }
  const COL = { wireNo: ['#1f5f8b', '#8cc3ec'], xref: ['#7a3d8f', '#d29be6'], fitted: '#2a7ab0', tested: '#1e9e5a', partial: '#e39b00', added: '#1e9e5a', changed: '#e39b00', net: '#9b3fc4', ahead: ['#f0c9a8', '#6b4a33'], stop: '#e8590c' };

  function analyzeNow() {
    try { state.A = Loom.analyze(state.project); } catch (e) { console.error(e); state.A = null; }
    renderCheckBadge();
  }
  function renderCheckBadge() {
    const b = $('checkBadge'); if (!b) return;
    const A = state.A, errs = A ? A.issues.filter((i) => i.sev === 'error').length : 0, all = A ? A.issues.length : 0;
    b.hidden = !all;
    b.textContent = String(errs || all);
    b.className = 'badge' + (errs ? ' bad' : ' warn');
  }

  // ---- drawing annotations for the current sheet
  function updateAnnot() {
    const P = state.project, inst = state.inst, A = state.A;
    if (!P || !inst || !A) { view.setAnnot(null); return; }
    const S = sceneFor(inst);
    const d = view.dark ? 1 : 0;
    const an = { groupColor: new Map(), symMarks: new Map(), tags: [], markers: [] };
    if (show.wireNos) {
      const best = new Map();
      for (const s of S.strokes) {
        if (s.role !== 'wire' || s.g < 0 || s.p.length < 4) continue;
        const net = P.nets[inst.netOf[s.g]];
        if (!net || net.named) continue;
        const no = A.wireNo[net.id]; if (!no) continue;
        const len = Math.hypot(s.p[2] - s.p[0], s.p[3] - s.p[1]);
        const b = best.get(net.id); if (!b || len > b.len) best.set(net.id, { len, p: s.p, no });
      }
      for (const b of best.values()) {
        const [x0, y0, x1, y1] = b.p;
        const horiz = Math.abs(y1 - y0) <= Math.abs(x1 - x0);
        an.tags.push(horiz ? { x: (x0 + x1) / 2, y: y0 - 0.3, text: b.no, color: COL.wireNo[d], size: 1, ha: 'center', va: 'bottom', box: false }
          : { x: x0 + 0.5, y: (y0 + y1) / 2, text: b.no, color: COL.wireNo[d], size: 1, ha: 'left', va: 'center', box: false });
      }
    }
    if (show.xrefs) for (const sy of S.syms) {
      const others = A.xref.get(inst.idx + ':' + sy.si);
      if (!others || !others.length) continue;
      const ref = inst.refs[sy.si].ref;
      const txt = others.map((u) => `${ref}${u.unit} ${u.inst === inst ? '' : 'p' + u.page + ' '}${u.zone}`).join('   ');
      const b = sy.body || sy.bb;
      an.tags.push({ x: (b[0] + b[2]) / 2, y: b[3] + 0.6, text: '⇄ ' + txt, color: COL.xref[d], size: 0.95, ha: 'center', va: 'top' });
    }
    if (show.markers) for (const is of A.issues) if (is.inst === inst.idx) an.markers.push({ x: is.p[0], y: is.p[1], sev: is.sev, issue: is, current: state.curIssue && state.curIssue.msg === is.msg && state.curIssue.p === is.p });
    const cmp = state.compare && state.compare.diff;
    if (cmp) {
      for (const n of cmp.nets) { const net = P.nets[n.net]; if (net) for (const g of groupsFor(net, inst)) an.groupColor.set(g, COL.net); }
      for (const pt of cmp.parts) if (pt.e) for (const u of pt.e.units) if (u.inst === inst) an.symMarks.set(u.si, { color: pt.kind === 'added' ? COL.added : COL.changed, dash: pt.kind === 'changed' });
    } else if (show.install && state.ilog) {
      const netCol = new Map();
      for (const [nid, rows] of A.wiresByNet) {
        if (!rows.length) continue;
        let f = 0, t = 0;
        for (const r of rows) { const x = ist(r.key); if (x.fitted) f++; if (x.tested) t++; }
        const c = t === rows.length ? COL.tested : f === rows.length ? COL.fitted : f || t ? COL.partial : null;
        if (c) netCol.set(nid, c);
      }
      for (let g = 0; g < inst.netOf.length; g++) { const c = netCol.get(inst.netOf[g]); if (c) an.groupColor.set(g, c); }
      for (const sy of S.syms) {
        const x = ist('P:' + inst.refs[sy.si].ref);
        if (x.tested || x.fitted) an.symMarks.set(sy.si, { color: x.tested ? COL.tested : COL.fitted });
      }
    }
    const s = state.sel, tr = s && s.type === 'net' && traceOf(s);
    if (tr) {
      if (s.step.k < tr.steps.length - 1) for (const g of groupsFor(s.net, inst)) an.groupColor.set(g, COL.ahead[d]);
      for (const st of tr.steps[s.step.k].stops) if ((st.kind === 'conn' || st.kind === 'pin') && st.inst === inst.idx) an.symMarks.set(st.si, { color: COL.stop, dash: true });
    }
    view.setAnnot(an);
  }

  $('btnLayers').addEventListener('click', (e) => {
    if (!state.project) return;
    openMenu(e.currentTarget, [
      { label: 'Wire numbers', icon: show.wireNos ? 'i-check' : 'i-none', checked: show.wireNos, run: () => setShow('wireNos', !show.wireNos) },
      { label: 'Cross-references', icon: show.xrefs ? 'i-check' : 'i-none', checked: show.xrefs, run: () => setShow('xrefs', !show.xrefs) },
      { label: 'Check markers', icon: show.markers ? 'i-check' : 'i-none', checked: show.markers, run: () => setShow('markers', !show.markers) },
      { label: 'Install status', icon: show.install ? 'i-check' : 'i-none', checked: show.install, run: () => setShow('install', !show.install) },
      { label: 'Trace in steps', icon: traceStep ? 'i-check' : 'i-none', checked: traceStep, run: () => setTraceStep(!traceStep) },
      { label: 'Steps stop only at connectors', icon: traceBy === 'conn' ? 'i-check' : 'i-none', checked: traceBy === 'conn', run: () => { traceBy = traceBy === 'conn' ? 'section' : 'conn'; Store.pref('traceBy', traceBy); const s = state.sel; if (s && s.step) { s.step.k = 0; applyHighlight(); renderSelectionUI(); } } },
      { label: 'Grid dots', icon: view.showGrid ? 'i-check' : 'i-none', checked: view.showGrid, run: () => { view.showGrid = !view.showGrid; Store.pref('grid', view.showGrid); view.redraw(); renderScale(); } },
      { sep: true },
      { label: 'Reports', icon: 'i-report', run: () => showTab('reports', true) },
      { label: 'Compare revisions', icon: 'i-compare', run: () => showTab('compare', true) }
    ]);
  });

  // ---- fixed wire numbers: a local label on the wire holds the number from then on
  function fixWireNumber(wire, no) {
    const sh = state.inst.sheet;
    const horiz = Math.abs(wire.a[1] - wire.b[1]) < 1e-6;
    const lo = horiz ? Math.min(wire.a[0], wire.b[0]) : Math.min(wire.a[1], wire.b[1]);
    const hi = horiz ? Math.max(wire.a[0], wire.b[0]) : Math.max(wire.a[1], wire.b[1]);
    let m = E.snap((lo + hi) / 2);
    if (m < lo || m > hi) m = lo;
    const p = horiz ? [m, wire.a[1]] : [wire.a[0], m];
    if (!horiz && Math.abs(wire.a[0] - wire.b[0]) > 1e-6) { toast('Fix numbers on straight wires.'); return; }
    run('Fix wire number ' + no, () => E.addLabel(sh, 'local', no, p, horiz ? 'right' : 'up', 'passive'));
    toast(`Wire ${no} is now a label, so it keeps its number.`);
  }

  // ---- design check
  function renderCheck(body) {
    const A = state.A; if (!A) return;
    const errs = A.issues.filter((i) => i.sev === 'error').length, warns = A.issues.length - errs;
    body.append(h('div', { class: 'chips' },
      h('span', { class: 'chip ' + (errs ? 'bad' : 'ok'), text: `${errs} error${errs === 1 ? '' : 's'}` }),
      h('span', { class: 'chip ' + (warns ? 'warn' : 'ok'), text: `${warns} warning${warns === 1 ? '' : 's'}` })));
    body.append(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: show.markers, onchange: (e) => setShow('markers', e.target.checked) }), 'Show markers on the drawing'));
    if (!A.issues.length) body.append(h('p', { class: 'empty', text: 'No problems found. The checks run again after every edit.' }));
    else {
      const rows = h('div', { class: 'rows' });
      for (const is of A.issues.slice(0, 600)) {
        const cur = state.curIssue && state.curIssue.msg === is.msg && state.curIssue.p === is.p;
        rows.append(h('button', { class: 'row issue ' + is.sev + (cur ? ' current' : ''), onclick: () => { pickIssue(is, true); afterPick(); } },
          h('span', { class: 'main' }, h('span', { class: 'sev', 'aria-label': is.sev === 'error' ? 'Error' : 'Warning' }), h('span', { class: 'nm', text: is.msg })),
          h('span', { class: 'meta', text: 'p' + is.page + ' · ' + is.zone })));
      }
      if (A.issues.length > 600) rows.append(h('div', { class: 'row' }, h('span', { class: 'meta', text: `${A.issues.length - 600} more in the Design check report` })));
      body.append(section('Problems', String(A.issues.length), rows));
    }
    body.append(h('p', { class: 'hint', text: 'Checks for unconnected pins, wire ends that touch nothing, labels that reach no pins, global labels used once, sheet pins without a hierarchical label, duplicate or unannotated references, missing values, and outputs driving each other. It covers the common mistakes; run ERC in KiCad before release.' }));
  }
  function pickIssue(is, zoom) {
    const inst = state.project.instances[is.inst];
    if (inst !== state.inst) showInstance(inst);
    state.curIssue = is;
    if (is.si !== undefined && is.si >= 0 && inst.sheet.symbols[is.si]) { state.sel = { type: 'symbol', inst, si: is.si }; applyHighlight(); renderSelectionUI(); }
    else updateAnnot();
    if (zoom) view.animateTo([is.p[0] - 10, is.p[1] - 7, is.p[0] + 10, is.p[1] + 7]);
    toast(is.msg);
    if (state.panelOpen && state.tab === 'check') { state._keepScroll = true; renderPanel(); }
  }

  // ---- reports
  function download(name, text, type) {
    const blob = new Blob([text], { type: type || 'text/plain' });
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  function revisionText() {
    const s = state.source;
    const rev = s && s.kind === 'github' ? `${s.repo} · ${s.ref} · ${s.head.sha.slice(0, 7)}` : s && s.kind === 'sample' ? 'Sample' : 'Files from this device';
    return rev + (pendingFiles().length ? ' + unsaved edits' : '');
  }
  const pinText = (p) => (p.fullRef || p.ref) + '.' + p.number;
  const whenText = (f) => f && f.v ? `${f.by || ''} ${f.at ? new Date(f.at).toLocaleString() : ''}`.trim() : '';
  const REPORTS = [
    { id: 'wires', title: 'Wire list', desc: 'Every wire with its number and both ends (from / to), for making up and labelling looms.',
      make: (P, A) => { const t = Loom.wireList(P, A); return { sections: [t], count: t.rows.length + ' wires' }; } },
    { id: 'looms', title: 'Loom list', desc: 'The same wires grouped by the two parts they join, connectors first.',
      make: (P, A) => {
        const L = Loom.looms(P, A);
        return { group: 'Between', count: L.length + ' runs', sections: L.map((g) => ({ heading: `${g.a} ↔ ${g.b}`, sub: g.wires.length + ' wire' + (g.wires.length === 1 ? '' : 's'), cols: ['Wire', 'From', 'To', 'Net'], rows: g.wires.map((w) => [w.no || '', pinText(w.a), pinText(w.b), K.plainText(K.unescape(w.net.name))]) })) };
      } },
    { id: 'conn', title: 'Connector pin-outs', desc: 'Pin, wire number, net and destination for every connector and terminal strip.',
      make: (P, A) => {
        const C = Loom.connectors(P, A);
        return { group: 'Connector', count: C.length + ' connectors', sections: C.map((c) => ({ heading: c.ref, sub: [c.value, c.footprint, 'page ' + c.page].filter(Boolean).join(' · '), cols: ['Pin', 'Name', 'Wire', 'Net', 'Goes to'], rows: c.rows.map((r) => [r.pin, r.name, r.wire, r.net, r.to]) })) };
      } },
    { id: 'plcio', title: 'PLC I/O list', desc: 'Every I/O module (Beckhoff terminals from the Loomline library) and each channel: terminal points, signal, wire number and what it connects to, plus spare channels and the E-bus budget.',
      make: (P, A) => {
        const io = Loom.plcIO(P, A);
        const mods = { heading: 'Modules', cols: ['Ref', 'Order code', 'Type', 'Channels', 'Used', 'Spare', 'E-bus mA', 'Page'], rows: io.modules.map((m) => [m.ref, m.code, m.type, m.channels, m.used, m.channels - m.used, m.ebus, m.page]) };
        const chans = { heading: 'Channels', cols: ['Module', 'Order code', 'Channel', 'Terminal points', 'Signal', 'Wire', 'Net', 'Connects to', 'Status'], rows: io.chans.map((c) => [c.ref, c.code, c.ch, c.points, c.signal, c.wire, c.net, c.to, c.used ? 'used' : 'spare']) };
        const budget = { heading: 'E-bus budget', cols: ['Supplied (mA)', 'Used by terminals with stated figures (mA)', 'Terminals without a figure'], rows: [[io.supply, io.ebus, io.ebusUnknown]] };
        const used = io.chans.filter((c) => c.used).length;
        return { group: 'Section', count: `${io.modules.length} modules · ${used}/${io.chans.length} channels used`, sections: io.modules.length ? [mods, chans, budget] : [{ heading: 'No I/O modules', cols: ['Note'], rows: [['Place Beckhoff terminals from the Beckhoff I/O category of Add a part; their channels are listed here.']] }] };
      } },
    { id: 'cables', title: 'Cable schedule', desc: 'Every cable section with details (type, product code, core size, colour, length) and its two ends, plus totals by cable type for ordering.',
      make: (P, A) => {
        const C = Loom.cables(P, A);
        if (!C.rows.length) return { count: 'no cables yet', sections: [{ heading: 'No cable details yet', cols: ['Note'], rows: [['Tap a wire, then CABLE, to give that section a type, product code, core size, colour and length.']] }] };
        const list = { heading: 'Cables', cols: ['Type', 'Product code', 'Size', 'Colour / marking', 'Length', 'Wire', 'From', 'To', 'Net', 'Page', 'Zone'], rows: C.rows.map((r) => [r.f.Cable_Type, r.f.Cable_PN, r.f.Cable_Size, r.f.Cable_Colour, r.f.Cable_Length, r.wire, r.from, r.to, r.net ? K.plainText(K.unescape(r.net.name)) : '', r.page, r.zone]) };
        const tot = { heading: 'Totals by cable', cols: ['Type', 'Product code', 'Size', 'Sections', 'Total length (m)', 'Sections without a length'], rows: C.totals.map((t) => [t.type, t.pn, t.size, t.n, Math.round(t.m * 100) / 100, t.unknown]) };
        const m = C.totals.reduce((a, t) => a + t.m, 0);
        return { group: 'Section', count: `${C.rows.length} sections · ${Math.round(m * 10) / 10} m`, sections: [list, tot] };
      } },
    { id: 'bom', title: 'Bill of materials', desc: 'Parts grouped by value and footprint, with manufacturer fields when the schematic has them.',
      make: (P, A) => { const t = Loom.bom(P, A); return { sections: [t], count: t.rows.reduce((n, r) => n + r[0], 0) + ' parts' }; } },
    { id: 'check', title: 'Design check', desc: 'Every problem the live check found, with page and zone.',
      make: (P, A) => { const t = Loom.issuesTable(P, A); return { sections: [t], count: t.rows.length + ' problems' }; } },
    { id: 'install', title: 'Install record', desc: 'Fitted and tested status for every wire and part, with who and when.',
      make: (P, A) => {
        const wires = { heading: 'Wires', cols: ['Wire', 'From', 'To', 'Fitted', 'Fitted by', 'Tested', 'Tested by', 'Note'], rows: A.wires.map((w) => { const x = ist(w.key), it = x.it || {}; return [w.no || '', pinText(w.a), pinText(w.b), x.fitted ? 'yes' : '', whenText(it.fitted), x.tested ? 'yes' : '', whenText(it.tested), it.note && it.note.v ? it.note.v : '']; }) };
        const parts = { heading: 'Parts', cols: ['Ref', 'Value', 'Fitted', 'Fitted by', 'Tested', 'Tested by', 'Note'], rows: Array.from(A.parts.values()).sort((a, b) => K.naturalCmp(a.ref, b.ref)).map((e) => { const x = ist('P:' + e.ref), it = x.it || {}; return [e.ref, K.unescape((e.sym.props.find((p) => p.name === 'Value') || {}).value || ''), x.fitted ? 'yes' : '', whenText(it.fitted), x.tested ? 'yes' : '', whenText(it.tested), it.note && it.note.v ? it.note.v : '']; }) };
        const f = A.wires.filter((w) => ist(w.key).fitted).length, t = A.wires.filter((w) => ist(w.key).tested).length;
        return { group: 'Section', count: `${f}/${A.wires.length} fitted · ${t} tested`, sections: [wires, parts] };
      } }
  ];
  function reportCsv(rep) {
    if (rep.sections.length === 1) return Loom.csv(rep.sections[0].cols, rep.sections[0].rows);
    const cols = [rep.group || 'Group', ...rep.sections[0].cols];
    const rows = [];
    for (const s of rep.sections) for (const r of s.rows) rows.push([s.heading, ...r]);
    // Sections can have different columns (install record); give each its own header row.
    if (rep.sections.some((s) => s.cols.join() !== rep.sections[0].cols.join())) return rep.sections.map((s) => Loom.csv([rep.group || 'Group', ...s.cols], s.rows.map((r) => [s.heading, ...r]))).join('\r\n');
    return Loom.csv(cols, rows);
  }
  function reportFile(r, ext) { return `${slug(state.project.name)}-${r.id}-${new Date().toISOString().slice(0, 10)}.${ext}`; }
  function exportCsv(r) {
    const rep = r.make(state.project, state.A);
    download(reportFile(r, 'csv'), '﻿' + reportCsv(rep), 'text/csv;charset=utf-8');
    toast('Downloaded ' + reportFile(r, 'csv'));
  }
  function openReport(r) {
    const P = state.project, rep = r.make(P, state.A);
    closeReport();
    const table = (s) => h('table', { class: 'rtable' }, h('thead', null, h('tr', null, ...s.cols.map((c) => h('th', { text: c })))),
      h('tbody', null, ...s.rows.slice(0, 5000).map((row) => h('tr', null, ...row.map((v) => h('td', { text: v === null || v === undefined ? '' : String(v) }))))));
    const bodyKids = [h('div', { class: 'rtitle' }, h('h1', { text: r.title }), h('p', { text: `${P.name} · ${revisionText()} · ${new Date().toLocaleString()} · ${rep.count}` }))];
    for (const s of rep.sections) {
      if (s.heading) bodyKids.push(h('h2', { class: 'rsec' }, s.heading, s.sub ? h('small', { text: '  ' + s.sub }) : null));
      bodyKids.push(s.rows.length ? table(s) : h('p', { class: 'hint', text: 'Nothing to list.' }));
    }
    const wrap = h('div', { class: 'report-wrap', id: 'reportWrap', role: 'dialog', 'aria-label': r.title },
      h('div', { class: 'report-head' },
        h('div', { class: 'titles' }, h('b', { text: r.title.toUpperCase() }), h('small', { text: rep.count })),
        h('button', { class: 'btn small', onclick: () => exportCsv(r) }, icon('i-download'), 'CSV'),
        h('button', { class: 'btn small', onclick: printReport }, icon('i-print'), 'PRINT / PDF'),
        h('button', { class: 'ib', 'aria-label': 'Close report', onclick: closeReport }, icon('i-close'))),
      h('div', { class: 'report-body' }, ...bodyKids));
    document.body.append(wrap);
  }
  function closeReport() { const w = $('reportWrap'); if (w) w.remove(); }
  function printReport() {
    document.body.classList.add('printing');
    const done = () => { document.body.classList.remove('printing'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    setTimeout(() => { window.print(); setTimeout(done, 1000); }, 50);
  }
  function renderReports(body) {
    body.append(h('p', { class: 'hint', text: 'Built from the open revision, including any unsaved edits. CSV opens in Excel or Sheets; PRINT / PDF uses the system print dialog, where you can save a PDF.' }));
    const list = h('div', { class: 'cards-list' });
    for (const r of REPORTS) {
      list.append(h('div', { class: 'rcard' },
        h('button', { class: 'rc-main', onclick: () => openReport(r) }, h('b', { text: r.title }), h('small', { text: r.desc })),
        h('div', { class: 'rc-actions' },
          h('button', { class: 'btn small', onclick: () => openReport(r) }, 'VIEW'),
          h('button', { class: 'btn small', onclick: () => exportCsv(r) }, icon('i-download'), 'CSV'))));
    }
    body.append(list);
  }

  // ---- revision compare
  async function startCompare(target) {
    const s = state.source;
    try {
      let P0, label;
      if (target.kind === 'edits') {
        P0 = K.buildProject(Array.from(state.base, ([path, text]) => ({ path, text })));
        label = 'the revision you opened (before your edits)';
      } else {
        const c = target.commit;
        loading('Loading ' + c.sha.slice(0, 7) + '…');
        const tree = await GitHub.kicadTree(state.token, s.repo, c.tree);
        const proj = groupProjects(tree.files).find((p) => p.key === s.projKey);
        if (!proj) throw new Error(`${state.project.name} isn't in ${c.sha.slice(0, 7)}.`);
        const texts = await pool(proj.files, 6, async (f) => ({ path: f.path, text: await GitHub.blobText(state.token, s.repo, f.sha) }));
        P0 = K.buildProject(texts);
        label = `${c.sha.slice(0, 7)} · ${firstLine(c.message)} (${ago(c.date)})`;
      }
      const A0 = Loom.analyze(P0);
      state.compare = { target, label, P0, A0, diff: Loom.diff(P0, A0, state.project, state.A) };
      loading(null);
      showTab('compare', true);
      updateAnnot();
      const n = state.compare.diff.count;
      banner('info', `Comparing with ${label}: ${n} change${n === 1 ? '' : 's'}.`, [{ label: 'EXIT', run: endCompare }]);
    } catch (e) { loading(null); banner('err', e.message || String(e)); }
  }
  function endCompare() {
    state.compare = null;
    banner(null);
    updateAnnot();
    if (state.panelOpen && state.tab === 'compare') renderPanel();
  }
  function renderCompare(body) {
    const c = state.compare, P = state.project, s = state.source;
    if (!c) {
      body.append(h('p', { class: 'hint', text: 'Pick a revision to compare with the one open now. Parts that were added or changed are outlined, and wires whose connections changed turn purple.' }));
      const rows = h('div', { class: 'rows' });
      if (pendingFiles().length) rows.append(h('button', { class: 'row', onclick: () => startCompare({ kind: 'edits' }) }, h('span', { class: 'main' }, h('span', { class: 'nm2' }, h('b', { text: 'Your unsaved edits' }), h('small', { text: 'Against the revision you opened' })))));
      if (s && s.kind === 'github' && state.token) {
        const hist = h('div', { class: 'rows' }, h('div', { class: 'row' }, h('span', { class: 'meta', text: 'Loading recent changes…' })));
        const fill = (list) => {
          hist.replaceChildren();
          for (const cm of list.filter((x) => x.sha !== s.head.sha)) hist.append(h('button', { class: 'row', onclick: () => startCompare({ kind: 'commit', commit: cm }) },
            h('span', { class: 'main' }, h('span', { class: 'nm2' }, h('b', { text: firstLine(cm.message) }), h('small', null, h('span', { class: 'mono', text: cm.sha.slice(0, 7) }), ' · ' + (cm.author || '') + ' · ' + ago(cm.date))))));
          if (!hist.childNodes.length) hist.append(h('div', { class: 'row' }, h('span', { class: 'meta', text: 'No earlier revisions of this project.' })));
        };
        if (state.history && state.history.key === s.key) fill(state.history.list);
        else GitHub.history(state.token, s.repo, s.ref, s.dir || '', 15).then((list) => { state.history = { key: s.key, list }; fill(list); }).catch((e) => hist.replaceChildren(h('div', { class: 'row' }, h('span', { class: 'meta', text: e.message }))));
        body.append(rows, section('Earlier revisions on ' + s.ref, null, hist));
      } else {
        body.append(rows);
        if (!pendingFiles().length) body.append(h('p', { class: 'empty', text: 'Open a project from GitHub to compare revisions, or make an edit to compare against what you opened.' }));
      }
      return;
    }
    const D = c.diff;
    body.append(h('div', { class: 'head' },
      h('div', { class: 'titles' }, h('div', { class: 'eyebrow', text: 'Comparing with' }), h('div', { class: 'title small', text: c.label })),
      h('button', { class: 'btn small', onclick: endCompare }, 'EXIT')));
    body.append(h('div', { class: 'legend nopad' }, h('span', null, h('span', { class: 'sw n' }), ' connection changed'), h('span', null, h('span', { class: 'sw t' }), ' part added'), h('span', null, h('span', { class: 'sw p' }), ' part changed')));
    const k = (kind) => D.parts.filter((p) => p.kind === kind).length;
    body.append(h('div', { class: 'chips' },
      h('span', { class: 'chip', text: `${k('added')} added` }), h('span', { class: 'chip', text: `${k('changed')} changed` }), h('span', { class: 'chip', text: `${k('removed')} removed` }),
      h('span', { class: 'chip trace', text: `${D.nets.length} connection${D.nets.length === 1 ? '' : 's'}` })));
    if (!D.count) body.append(h('p', { class: 'empty', text: 'No electrical differences: the same parts, values and connections. (Moved wires and text don’t count.)' }));
    if (D.parts.length) {
      const rows = h('div', { class: 'rows' });
      for (const pt of D.parts) {
        const detail = pt.kind === 'changed' ? pt.changes.map((x) => `${x.field}: ${x.from || '–'} → ${x.to || '–'}`).join(' · ') : pt.kind === 'removed' ? 'was on page ' + pt.page : pt.value;
        rows.append(h(pt.e ? 'button' : 'div', { class: 'row diff ' + pt.kind, onclick: pt.e ? () => { selectSymbol(pt.e.units[0].inst, pt.e.units[0].si, true); afterPick(); } : null },
          h('span', { class: 'main' }, h('span', { class: 'kind', text: pt.kind.toUpperCase() }), h('span', { class: 'ref', text: pt.ref }), h('span', { class: 'nm', text: detail }))));
      }
      body.append(section('Parts', String(D.parts.length), rows));
    }
    if (D.nets.length) {
      const rows = h('div', { class: 'rows' });
      for (const n of D.nets) {
        const net = P.nets[n.net];
        const detail = n.kind === 'renamed' ? `renamed from ${n.oldName}` : n.kind === 'split' ? `${n.moved.join(', ')} cut off from ${n.oldName}` : n.kind === 'new' ? 'new: ' + n.added.join(', ') :
          [n.added.length ? '+ ' + n.added.join(', ') : '', n.removed.length ? '− ' + n.removed.join(', ') : ''].filter(Boolean).join('   ');
        rows.append(h('button', { class: 'row diff net', onclick: () => { if (!net) return; selectNet(net); const here = net.inst.has(state.inst.idx) ? state.inst : P.instances[Array.from(net.inst.keys()).sort((a, b) => P.instances[a].order - P.instances[b].order)[0]]; goToNetOn(here, net); afterPick(); } },
          h('span', { class: 'main' }, h('span', { class: 'nm2' }, h('b', null, markup(n.name)), h('small', { text: detail })))));
      }
      body.append(section('Connections', String(D.nets.length), rows));
    }
  }

  // ---- install log: fitted / tested per wire and part, shared through a branch of the repository
  const INSTALL_BRANCH = 'loomline-install';
  state.ilog = null;
  state.ilogView = { what: 'wires', filter: 'all', q: '', limit: 300 };
  const ilogPath = (s) => 'install/' + (s.projKey.replace(/\.kicad_pro$/i, '').replace(/\/+$/, '') || 'root') + '.json';
  function ist(key) {
    const it = state.ilog && state.ilog.items[key];
    return { fitted: !!(it && it.fitted && it.fitted.v), tested: !!(it && it.tested && it.tested.v), it };
  }
  function mergeItems(base, over) {
    const out = Object.assign({}, base);
    for (const k in over) {
      const a = out[k] || {}, b = over[k], m = Object.assign({}, a);
      for (const f of ['fitted', 'tested', 'note']) if (b[f] && (!a[f] || Date.parse(b[f].at) >= Date.parse(a[f].at))) m[f] = b[f];
      out[k] = m;
    }
    return out;
  }
  const ilogSaved = (L) => ({ items: L.items, pending: L.pending, sha: L.sha || null, syncedAt: L.syncedAt || 0 });
  async function installLoad() {
    const s = state.source;
    if (!s) { state.ilog = null; return; }
    const storeKey = 'install:' + s.key;
    const saved = (await Store.get(storeKey)) || { items: {}, pending: {}, sha: null, syncedAt: 0 };
    if (state.source !== s) return;
    state.ilog = Object.assign(saved, { storeKey, status: s.kind === 'github' ? 'idle' : 'local', error: '' });
    updateAnnot();
    refreshInstallUI();
    if (s.kind === 'github' && state.token) scheduleSync(0);
  }
  function setInstall(keys, field, value) {
    const L = state.ilog; if (!L || !keys.length) return;
    const at = new Date().toISOString(), by = state.ghLogin || Store.pref('ghLogin') || 'this device';
    for (const k of keys) {
      const v = { v: value, by, at };
      L.items[k] = Object.assign({}, L.items[k], { [field]: v });
      L.pending[k] = Object.assign({}, L.pending[k], { [field]: v });
    }
    Store.set(L.storeKey, ilogSaved(L));
    updateAnnot();
    refreshInstallUI();
    scheduleSync();
  }
  function serializeLog(s, items) {
    const keys = Object.keys(items).sort(K.naturalCmp);
    return '{\n  "format": "loomline-install/1",\n  "project": ' + JSON.stringify(s.projKey) + ',\n  "items": {\n' +
      keys.map((k) => '    ' + JSON.stringify(k) + ': ' + JSON.stringify(items[k])).join(',\n') + '\n  }\n}\n';
  }
  let syncTimer = 0, syncing = false, syncAgain = false;
  function scheduleSync(ms) { clearTimeout(syncTimer); syncTimer = setTimeout(installSync, ms === undefined ? 1500 : ms); }
  async function installSync() {
    const L = state.ilog, s = state.source;
    if (!L || !s || s.kind !== 'github' || !state.token) return;
    if (syncing) { syncAgain = true; return; }
    syncing = true; L.status = 'syncing'; refreshInstallStatus();
    const path = ilogPath(s);
    try {
      if (!state.ghLogin) { try { state.ghLogin = (await GitHub.user(state.token)).login; Store.pref('ghLogin', state.ghLogin); } catch (e) { /* optional */ } }
      for (let attempt = 0; ; attempt++) {
        const remote = await GitHub.readFile(state.token, s.repo, INSTALL_BRANCH, path);
        let data = { items: {} };
        if (remote) { try { data = JSON.parse(remote.text); } catch (e) { throw new Error('The install log on GitHub is damaged (' + path + ' on ' + INSTALL_BRANCH + ').'); } }
        const sent = Object.assign({}, L.pending);
        const keys = Object.keys(sent);
        const merged = mergeItems(data.items || {}, sent);
        if (keys.length) {
          let f = 0, t = 0, u = 0;
          for (const k of keys) { if (sent[k].fitted) sent[k].fitted.v ? f++ : u++; if (sent[k].tested) sent[k].tested.v ? t++ : u++; }
          const what = [f ? f + ' fitted' : '', t ? t + ' tested' : '', u ? u + ' cleared' : ''].filter(Boolean).join(', ') || keys.length + ' notes';
          try {
            L.sha = await GitHub.writeFile(state.token, s.repo, INSTALL_BRANCH, path, serializeLog(s, merged), remote && remote.sha, `${state.project.name}: ${what}${state.ghLogin ? ' by ' + state.ghLogin : ''}`);
          } catch (e) { if ((e.status === 409 || e.status === 422) && attempt < 2) continue; throw e; }
          for (const k of keys) if (L.pending[k] === sent[k]) delete L.pending[k];
        } else L.sha = remote ? remote.sha : null;
        L.items = mergeItems(merged, L.pending);
        L.syncedAt = Date.now(); L.status = 'ok'; L.error = '';
        break;
      }
    } catch (e) {
      L.status = 'error';
      L.error = e.status === 403 || e.status === 404 ? `Saved on this device. Sharing needs a token that can write to ${s.repo}.`
        : !e.status ? 'Offline. Saved on this device; it syncs when GitHub can be reached.' : e.message;
    }
    await Store.set(L.storeKey, ilogSaved(L));
    syncing = false;
    if (state.ilog === L) { updateAnnot(); refreshInstallUI(); }
    if (syncAgain) { syncAgain = false; scheduleSync(300); }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.ilog && (show.install || state.tab === 'install')) scheduleSync(500); });
  setInterval(() => { if (document.visibilityState === 'visible' && state.panelOpen && state.tab === 'install') scheduleSync(0); }, 2 * 60 * 1000);
  function installStatusText() {
    const L = state.ilog, s = state.source;
    if (!L) return '';
    const n = Object.keys(L.pending).length;
    if (L.status === 'local') return 'Kept on this device. Open the project from GitHub to share the log with the team.';
    if (!state.token) return 'Kept on this device. Connect GitHub to share it.';
    if (L.status === 'syncing') return 'Syncing with GitHub…';
    if (L.status === 'error') return L.error + (n ? ` ${n} change${n === 1 ? '' : 's'} waiting.` : '');
    if (n) return `${n} change${n === 1 ? '' : 's'} waiting to sync.`;
    return L.syncedAt ? `Shared on ${s.repo} · branch ${INSTALL_BRANCH} · synced ${ago(new Date(L.syncedAt).toISOString())}` : 'Not synced yet.';
  }
  function refreshInstallStatus() { const el = $('ilogStatus'); if (el) el.textContent = installStatusText(); }
  function refreshInstallUI() {
    refreshInstallStatus();
    if (state.panelOpen && state.tab === 'install') { state._keepScroll = true; renderPanel(); }
    if (state.sel && show.install) renderStatus();
  }
  function installActions() {
    if (!show.install || !state.ilog || !state.A || state.mode !== 'select') return [];
    const s = state.sel; let keys = [];
    if (s.type === 'net') keys = (state.A.wiresByNet.get(s.net.id) || []).map((r) => r.key);
    else if (s.type === 'symbol') keys = ['P:' + s.inst.refs[s.si].ref];
    if (!keys.length) return [];
    const allF = keys.every((k) => ist(k).fitted), allT = keys.every((k) => ist(k).tested);
    const n = keys.length > 1 ? ` (${keys.length})` : '';
    return [
      { label: allF ? 'FITTED ✓' : 'FITTED' + n, icon: 'i-check', primary: !allF, run: () => setInstall(keys, 'fitted', !allF) },
      { label: allT ? 'TESTED ✓' : 'TESTED' + n, icon: 'i-check', primary: !allT && allF, run: () => setInstall(keys, 'tested', !allT) }
    ];
  }
  function renderInstall(body) {
    const A = state.A, L = state.ilog, P = state.project, V = state.ilogView;
    if (!A || !L) { body.append(h('p', { class: 'empty', text: 'Open a project to log its install.' })); return; }
    const wires = A.wires, parts = Array.from(A.parts.values()).sort((a, b) => K.naturalCmp(a.ref, b.ref));
    const cnt = (keys) => { let f = 0, t = 0; for (const k of keys) { const x = ist(k); if (x.fitted) f++; if (x.tested) t++; } return { f, t, n: keys.length }; };
    const cw = cnt(wires.map((w) => w.key)), cp = cnt(parts.map((e) => 'P:' + e.ref));
    const bar = (label, c) => h('div', { class: 'progress' },
      h('div', { class: 'pl' }, h('b', { text: label }), h('span', { text: `${c.f}/${c.n} fitted · ${c.t} tested` })),
      h('div', { class: 'pb' }, h('i', { class: 'f', style: `width:${c.n ? (100 * c.f / c.n).toFixed(1) : 0}%` }), h('i', { class: 't', style: `width:${c.n ? (100 * c.t / c.n).toFixed(1) : 0}%` })));
    body.append(bar('Wires', cw), bar('Parts', cp));
    body.append(h('div', { class: 'syncline' }, h('span', { id: 'ilogStatus', text: installStatusText() }),
      state.source && state.source.kind === 'github' && state.token ? h('button', { class: 'ib', 'aria-label': 'Sync now', title: 'Sync now', onclick: () => scheduleSync(0) }, icon('i-sync')) : null));
    body.append(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: show.install, onchange: (e) => setShow('install', e.target.checked) }), 'Colour wires and parts on the drawing'),
      h('div', { class: 'legend' }, h('span', null, h('span', { class: 'sw f' }), ' fitted'), h('span', null, h('span', { class: 'sw t' }), ' tested'), h('span', null, h('span', { class: 'sw p' }), ' partly done')));
    const what = seg('Show', [['wires', 'WIRES'], ['parts', 'PARTS']], V.what, (v) => { if (v !== V.what) { V.what = v; V.limit = 300; state._keepScroll = false; renderPanel(); } });
    const filt = seg('Filter', [['all', 'ALL'], ['fit', 'TO FIT'], ['test', 'TO TEST'], ['done', 'DONE']], V.filter, (v) => { if (v !== V.filter) { V.filter = v; V.limit = 300; renderPanel(); } });
    const q = h('input', { class: 'input', type: 'search', placeholder: V.what === 'wires' ? 'Filter: wire no., part, pin, net' : 'Filter: reference or value', value: V.q, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    body.append(what.el, filt.el, q);
    const list = h('div', { class: 'rows ilist' });
    const pass = (k) => { const x = ist(k); return V.filter === 'all' || (V.filter === 'fit' && !x.fitted) || (V.filter === 'test' && x.fitted && !x.tested) || (V.filter === 'done' && x.tested); };
    const toggles = (key) => { const x = ist(key); return [
      h('button', { class: 'tg f' + (x.fitted ? ' on' : ''), 'aria-pressed': String(x.fitted), title: x.it && x.it.fitted ? whenText(x.it.fitted) : 'Mark fitted', onclick: () => setInstall([key], 'fitted', !x.fitted) }, 'FIT'),
      h('button', { class: 'tg t' + (x.tested ? ' on' : ''), 'aria-pressed': String(x.tested), title: x.it && x.it.tested ? whenText(x.it.tested) : 'Mark tested', onclick: () => setInstall([key], 'tested', !x.tested) }, 'TEST')]; };
    const fill = () => {
      V.q = q.value;
      const terms = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      list.replaceChildren();
      let shown = 0, total = 0;
      if (V.what === 'wires') {
        const groups = new Map();
        for (const w of wires) {
          if (!pass(w.key)) continue;
          const hay = `${w.no} ${pinText(w.a)} ${pinText(w.b)} ${w.a.name || ''} ${w.b.name || ''} ${K.plainText(w.net.name)}`.toLowerCase();
          if (!terms.every((t) => hay.includes(t))) continue;
          const gk = w.a.ref === w.b.ref ? w.a.ref + ' (jumpers)' : w.a.ref + ' ↔ ' + w.b.ref;
          if (!groups.has(gk)) groups.set(gk, []);
          groups.get(gk).push(w);
          total++;
        }
        const ordered = Array.from(groups).sort((x, y) => y[1].length - x[1].length || K.naturalCmp(x[0], y[0]));
        for (const [gk, ws] of ordered) {
          if (shown >= V.limit) break;
          const c = cnt(ws.map((w) => w.key));
          list.append(h('div', { class: 'row group' }, h('span', { class: 'main' }, h('span', { class: 'nm', text: gk })), h('span', { class: 'meta', text: `${c.f}/${c.n} fitted · ${c.t} tested` })));
          for (const w of ws) {
            if (shown++ >= V.limit) break;
            list.append(h('div', { class: 'irow' },
              h('button', { class: 'iw', onclick: () => { selectNet(w.net); goToPin(w.a); afterPick(); } },
                h('span', { class: 'wno', text: w.no || '–' }), h('span', { class: 'ends', text: `${pinText(w.a)} → ${pinText(w.b)}` })),
              ...toggles(w.key)));
          }
        }
      } else {
        for (const e of parts) {
          const key = 'P:' + e.ref;
          if (!pass(key)) continue;
          const val = K.unescape((e.sym.props.find((p) => p.name === 'Value') || {}).value || '');
          if (!terms.every((t) => (e.ref + ' ' + val).toLowerCase().includes(t))) continue;
          total++;
          if (shown++ >= V.limit) continue;
          list.append(h('div', { class: 'irow' },
            h('button', { class: 'iw', onclick: () => { selectSymbol(e.units[0].inst, e.units[0].si, true); afterPick(); } }, h('span', { class: 'wno', text: e.ref }), h('span', { class: 'ends', text: val })),
            ...toggles(key)));
        }
      }
      if (total > V.limit) list.append(h('button', { class: 'row', onclick: () => { V.limit += 500; fill(); } }, h('span', { class: 'meta', text: `Show more (${total - V.limit} hidden)` })));
      if (!total) list.append(h('div', { class: 'row' }, h('span', { class: 'meta', text: 'Nothing matches.' })));
    };
    q.addEventListener('input', fill);
    fill();
    body.append(list);
    body.append(h('p', { class: 'hint', text: 'Ticks are saved on this device straight away and shared through the ' + INSTALL_BRANCH + ' branch of the repository, which holds only the install log, so the whole team sees the same progress. Tap a wire to find it on the drawing; with a wire or part selected, FITTED and TESTED are also in the bottom bar.' }));
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
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (e.key === 'Escape' && state.mode !== 'select') { setMode('select'); return; }
    if (e.key === 'Escape' && $('dialogWrap')) { closeDialog(); return; }
    if (e.key === 'Escape' && $('reportWrap')) { closeReport(); return; }
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
  state.prBase = Store.pref('prBase') || null;
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
  window.__tracer = { state, view, selectNet, selectSymbol, showInstance, openProject, snapPoint: (w) => snapPoint(w, 'touch') };
})();
