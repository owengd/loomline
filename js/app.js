/* Loomline — app shell: loading (GitHub, local files, sample), navigation,
 * selection, inspector, search and settings. */
(function () {
  'use strict';
  const K = window.KiCore, R = window.KiRender;
  const $ = (id) => document.getElementById(id);
  const VERSION = '2.6.4';

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
      if (state.mode === 'wire' || state.mode === 'label' || state.mode === 'draw' || state.mode === 'box' || state.mode === 'paste') { setTimeout(() => onCanvasTap(wp, 'touch'), 30); return; }
      const hit = view.hitTest(wp, 10);
      if (hit && hit.type === 'sheet') openChildSheet(hit.idx);
      else view.zoomBy(2, x, y);
    },
    onView: () => { if (!state._scaleRaf) state._scaleRaf = requestAnimationFrame(() => { state._scaleRaf = 0; renderScale(); }); },
    dragFrom: (wp, type) => dragSelectionFrom(wp, type),
    onHover: (wp) => { state.mouse = wp; keyMoveHover(wp); hoverPreview(wp); hoverWire(wp); if (state.mode === 'measure' && state.measure && state.measure.a && !state.measure.b) measureDraw(snapPoint(wp, 'mouse').p); }
  });

  // ------------------------------------------------------------------ theme
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    const t = Store.pref('theme') || 'auto';
    if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
    const dark = t === 'dark' || (t === 'auto' && mq.matches);
    view.setTheme(dark);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = dark ? '#10151b' : '#1e2a38';
    if (typeof thumbCache !== 'undefined') { thumbCache.clear(); if (typeof renderDock === 'function' && !$('dock').hidden) renderDock(); }
  }
  mq.addEventListener && mq.addEventListener('change', applyTheme);
  view.dimOthers = Store.pref('dim') === true;
  view.showGrid = Store.pref('grid') !== false;
  if (Store.pref('rbIcons')) document.body.classList.add('rb-icons');
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
    state.navBack = []; state.navFwd = [];   // sheet history is per project
    setMode('select');
    state.scenes.clear(); state.views.clear();
    state.sel = null;
    state.index = buildIndex(project);
    state.compare = null;
    state.kicadErc = null;
    analyzeNow();
    restoreKicadErc();
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
  // The browser's password manager as a backup of the connection (repository + token). Some browsers
  // are set to delete site data on close; saved passwords are kept, so the app can reconnect from them.
  async function saveCredential(repo, token) {
    try { if (window.PasswordCredential && navigator.credentials) await navigator.credentials.store(new PasswordCredential({ id: repo, password: token, name: 'Loomline · ' + repo })); } catch (e) { /* not supported or refused */ }
  }
  async function restoreCredential(mediation) {
    try {
      if (!window.PasswordCredential || !navigator.credentials) return false;
      // A silent check must never hold up start-up (some browsers never answer it).
      const c = await Promise.race([navigator.credentials.get({ password: true, mediation }), new Promise((r) => setTimeout(() => r(null), mediation === 'silent' ? 1500 : 120000))]);
      if (!c || !c.password || !/^[\w.-]+\/[\w.-]+$/.test(c.id)) { if (mediation !== 'silent') toast('No saved Loomline connection in this browser yet.'); return false; }
      state.gh = { repo: c.id, ref: (state.gh && state.gh.repo === c.id && state.gh.ref) || '', remember: true };
      Store.pref('gh', state.gh);
      setToken(c.password, true);
      state.ghProjects = null;
      await connectAndOpen(Store.pref('last') && Store.pref('last').key);
      return !!state.project;
    } catch (e) { return false; }
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
    if (state.inst && inst !== state.inst && !state._navSkip && state.navBack && state.project && state.project.instances.includes(state.inst)) { state.navBack.push(state.inst.namePath); if (state.navBack.length > 50) state.navBack.shift(); state.navFwd = []; }
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
    navButtons();
    renderRibbon();   // Up a sheet and other buttons follow the sheet
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
    if (state.mode === 'box') { boxTap(wp, type); return; }
    if (state.mode === 'measure') { measureTap(wp, type); return; }
    if (state.mode === 'paste') { pasteAt(gridSnap(wp)); setMode('select'); return; }
    if (state.mode === 'move') { if (state.keyMove) { keyMoveDrop(wp); return; } setMode('select'); renderStatus(); }
    const mk = view.markerAt(wp[0] * view.scale + view.ox, wp[1] * view.scale + view.oy, type === 'mouse' ? 12 : 20);
    if (mk && mk.issue) { pickIssue(mk.issue, false); return; }
    const hit = view.hitTest(wp, type === 'mouse' ? 8 : 16);
    if (!hit) { clearSelection(); return; }
    if (hit.type === 'net' && hit.it && /^[UE]\d/.test(hit.it)) selectGraphic(state.inst, hit.it);
    else if (hit.type === 'net') {
      const net = state.project.nets[state.inst.netOf[hit.g]];
      if (net) selectNet(net, itemFromTag(hit.it));
    } else if (hit.type === 'symbol') selectSymbol(state.inst, hit.si);
    else if (hit.type === 'sheet') selectSheet(state.inst, hit.idx);
    else if (hit.type === 'graphic') selectGraphic(state.inst, hit.it);
  }
  function applyHighlight() {
    const s = state.sel, inst = state.inst;
    updateAnnot();
    if (!s || s.type !== 'multi') { view.mSyms = null; view.mIts = null; }
    if (!s || !inst) { view.setHighlight(null); return; }
    if (s.type === 'multi') { const r = multiResolve(s.m); view.setHighlight(null, -1, -1); view.setMulti(r.syms, r.its); return; }
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
    else if (!state.panelOpen && propsFollow()) showTab('info', true);
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
  // Sheets the traced net reaches, in page order
  function tracePages(s) {
    const tr = traceOf(s); if (!tr) return [];
    const set = new Set();
    for (const st of tr.steps) for (const ii of st.items.keys()) set.add(ii);
    return Array.from(set).map((ii) => state.project.instances[ii]).sort((a, b) => a.order - b.order);
  }
  // Jump to the next sheet the net continues on, moving the step on to where it first reaches that sheet.
  function traceNextPage(s) {
    const tr = traceOf(s); if (!tr) return;
    const pages = tracePages(s); if (pages.length < 2) return;
    const i = pages.indexOf(state.inst);
    const next = pages[(i + 1) % pages.length];
    const first = tr.steps.findIndex((st) => st.items.has(next.idx));
    if (first > s.step.k) s.step.k = first;
    showInstance(next);
    applyHighlight();
    renderSelectionUI();
    const b = itsBox(next, traceIts(s, next, false));
    if (b) view.animateTo(b);
    toast(`Page ${next.page}: ${instLabel(next)}`);
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
      const pg = tracePages(s);
      const A = [
        { label: 'BACK', icon: 'i-back', disabled: s.step.k === 0, run: () => traceMove(-1), trace: true },
        { label: 'STEP', icon: 'i-next', primary: true, disabled: s.step.k >= last, run: () => traceMove(1), trace: true }
      ];
      if (pg.length > 1) A.push({ label: 'NEXT PAGE', icon: 'i-hier', run: () => traceNextPage(s), trace: true });
      A.push({ label: 'ALL', icon: 'i-net', run: () => setTraceStep(false) });
      return A;
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
    // A bus: one cable, its members are the cores in order.
    if (s && s.type === 'graphic' && s.it && s.it[0] === 'U') {
      const sh = state.inst.sheet, o = graphicObj(s.it, sh); if (!o) return null;
      const flags = sh.labels.filter((l) => Loom.isCableFlag(l) && l.group === o.group);
      return { flags, flag: flags[0] || null, wires: sh.buses.filter((b) => b.group === o.group), bus: o };
    }
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
    for (const c of (window.CABLE_CATALOGUE || [])) seen.set(c.pn, { Cable_Type: c.type, Cable_PN: c.pn, Cable_Size: c.size, Cable_Colour: '', Cable_Length: '', desc: c.desc, cores: c.cores || [], cat: true });
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
      const vals = Array.from(new Set(known.map((k) => k[f]).filter(Boolean))).sort((a, b) => K.naturalCmp(a, b));
      const hintFor = (v) => { const k = known.find((x) => x[f] === v); return !k ? '' : f === 'Cable_PN' ? [k.Cable_Type, k.desc].filter(Boolean).join(' · ') : f === 'Cable_Type' ? k.Cable_PN : ''; };
      const inp = h('input', { class: 'input', value: cur[f] || '', placeholder: LABELS[f][1], spellcheck: 'false', autocomplete: 'off', list: vals.length && f !== 'Cable_Length' ? listId : null });
      inputs[f] = inp;
      return h('div', { class: 'fieldrow' }, h('label', { text: LABELS[f][0] }), inp, vals.length && f !== 'Cable_Length' ? h('datalist', { id: listId }, ...vals.map((v) => h('option', { value: v, label: hintFor(v) || null }))) : null);
    });
    // Picking a product code, or a type that only one product code has, fills in the rest.
    const apply = (k) => { for (const f of ['Cable_Type', 'Cable_PN', 'Cable_Size']) if (k[f]) inputs[f].value = k[f]; desc.textContent = k.desc || ''; setCores(k); };
    const fill = (key) => () => {
      const v = inputs[key].value.trim();
      const m = known.filter((x) => x[key] && x[key] === v);
      if (m.length === 1) apply(m[0]);   // a type used with several product codes doesn't pick one for you
    };
    // The catalogue as a plain list: easier than typing on a tablet.
    const cat = known.filter((k) => k.cat);
    const desc = h('p', { class: 'hint', text: (known.find((k) => k.Cable_PN && k.Cable_PN === cur.Cable_PN) || {}).desc || '' });
    const pick = h('select', { class: 'input', onchange: () => { const k = cat[+pick.value]; if (k) apply(k); } },
      h('option', { value: '', text: cat.length ? 'Choose from the cable list…' : 'No cable list' }),
      ...cat.map((k, i) => h('option', { value: String(i), text: `${k.Cable_Type} — ${k.Cable_PN}`, selected: k.Cable_PN === cur.Cable_PN })));
    // Which core of the cable this section is: fills Colour / marking with its number and colour.
    const coreSel = h('select', { class: 'input', onchange: () => { if (coreSel.value) inputs.Cable_Colour.value = coreSel.value; } });
    const setCores = (k) => {
      const list = (k && k.cores) || [];
      // A core picked for another cable no longer applies.
      const cv = inputs.Cable_Colour.value;
      if (list.length && /^(Core \d|Pair \d|Screen|Centre)/.test(cv) && !list.includes(cv)) inputs.Cable_Colour.value = '';
      coreSel.replaceChildren(h('option', { value: '', text: list.length ? 'Choose the core…' : 'Pick a cable from the list first' }),
        ...list.map((c) => h('option', { value: c, text: c, selected: c === inputs.Cable_Colour.value })));
      coreSel.disabled = !list.length;
    };
    setCores(cat.find((k) => k.Cable_PN === cur.Cable_PN));
    if (c.bus) rows.splice(Loom.CABLE.indexOf('Cable_Colour'), 1);   // each member's colour comes from the cable list
    rows.unshift(h('div', { class: 'fieldrow' }, h('label', { text: 'Cable list' }), pick), desc);
    if (!c.bus) rows.splice(2, 0, h('div', { class: 'fieldrow' }, h('label', { text: 'Core' }), coreSel));
    inputs.Cable_PN.addEventListener('change', fill('Cable_PN'));
    inputs.Cable_Type.addEventListener('change', fill('Cable_Type'));
    const net = s.net;
    let where;
    if (c.bus) {
      const bn = busName(c.bus);
      where = h('p', { class: 'hint', text: `The cable this bus${bn ? ' (' + bn + ')' : ''} carries. Its members are the cores in order (member 1 is core 1), and each takes its colour from the cable list. Saved in the schematic as a net class flag on the bus, so KiCad keeps it too.` });
    } else {
      const ends = c.flag || (c.wires[0]) ? Loom.sectionEnds(state.project, state.inst, (c.flag || c.wires[0]).node) : [];
      where = h('p', { class: 'hint', text: `Section of ${K.plainText(K.unescape(net.shortName))}${ends.length ? ': ' + ends.join(' → ') : ''}. Saved in the schematic as a net class flag on the wire, so KiCad keeps it too.` });
    }
    const save = () => {
      const f = {}; for (const k of Loom.CABLE) f[k] = inputs[k].value.trim();
      if (c.bus) f.Cable_Colour = '';
      if (Loom.CABLE.some((k) => f[k])) f.Cable_Label = Loom.cableLabel(f);
      const empty = !Loom.CABLE.some((k) => f[k]);
      closeDialog();
      if (c.flag) {
        if (empty) run('Remove cable details', () => E.deleteItems(sh, [{ type: 'label', label: c.flag }]), { anchor: null });
        else run('Cable details', () => E.setCableFields(sh, c.flag, f));
        return;
      }
      if (empty) return;
      const spot = cableSpot(c.wires, f.Cable_Label);
      if (!spot) { banner('err', 'Tap a wire to add cable details.'); return; }
      run('Cable details', () => E.addCableFlag(sh, spot.w, spot.p, f, spot.side, !!c.bus));
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
  const TAB_TITLES = { sheets: 'SHEETS', nets: 'NET NAVIGATOR', parts: 'PARTS', info: 'PROPERTIES', check: 'DESIGN CHECK', install: 'INSTALL', reports: 'REPORTS', build: 'BUILD LOOMS', compare: 'COMPARE REVISIONS' };
  state.tab = 'sheets';
  state.panelOpen = false;
  function setPanel(open) {
    state.panelOpen = open;
    $('panel').hidden = !open;
    for (const b of document.querySelectorAll('.rail-btn[data-tab]')) b.setAttribute('aria-pressed', String(open && b.dataset.tab === state.tab));
    // Opening the install log turns its colours on, which renders the panel; otherwise render it here (once)
    if (open && state.tab === 'install' && !show.install) setShow('install', true);
    else if (open) renderPanel();
    if (open && state.tab === 'install') scheduleSync(0);
    if (open && !wideLayout() && typeof dockOpen !== 'undefined' && dockOpen) { dockOpen = false; $('dock').hidden = true; $('railDock').setAttribute('aria-pressed', 'false'); }
    requestAnimationFrame(() => view.resize());
    renderRibbon();
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
    else if (state.tab === 'build') renderBuild(body);
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
    if (s.type === 'multi') {
      const r = multiResolve(s.m), sh = state.inst.sheet;
      body.append(h('div', { class: 'head' },
        h('div', { class: 'titles' }, h('div', { class: 'eyebrow', text: 'Selection' }), h('div', { class: 'title', text: r.items.length + ' items' }), h('div', { class: 'sub', text: multiSummary(s.m) })),
        h('button', { class: 'iconbtn', 'aria-label': 'Clear selection', onclick: clearSelection }, icon('i-close'))));
      body.append(h('div', { class: 'actions' }, ...selectionActions().filter((a) => a.label !== 'ADD MORE').map((a) => h('button', { class: 'btn small', onclick: a.run }, icon(a.icon), a.label))));
      const rows = h('div', { class: 'rows' });
      sh.symbols.forEach((sym, i) => { if (s.m.sym.has(sym.uuid)) rows.append(h('button', { class: 'row', onclick: () => selectSymbol(state.inst, i, true) }, h('span', { class: 'main' }, h('span', { class: 'ref', text: state.inst.refs[i].ref }), h('span', { class: 'nm', text: K.unescape((sym.props.find((p) => p.name === 'Value') || {}).value || '') })), h('span', { class: 'meta', text: sym.libId }))); });
      if (rows.childNodes.length) body.append(section('Parts', String(rows.childNodes.length), rows));
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
  // A null text removes the file (undoing the creation of a new sheet file); an unknown path adds one.
  const setFileText = (path, text) => {
    const i = state.files.findIndex((x) => x.path === path);
    if (i >= 0) { if (text === null || text === undefined) state.files.splice(i, 1); else state.files[i].text = text; }
    else if (text !== null && text !== undefined) state.files.push({ path, text });
  };
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
    if (s.type === 'multi') return { type: 'multi', m: s.m };
    return null;
  }
  function restoreSelection(a) {
    state.sel = null;
    if (!a) return;
    const sh = state.inst.sheet, P = state.project;
    if (a.type === 'symbol') { const si = sh.symbols.findIndex((x) => x.uuid === a.uuid); if (si >= 0) state.sel = { type: 'symbol', inst: state.inst, si }; }
    else if (a.type === 'sheet') { const idx = sh.sheets.findIndex((x) => x.uuid === a.uuid); if (idx >= 0) state.sel = { type: 'sheet', inst: state.inst, idx }; }
    else if (a.type === 'graphic' && a.uuid) { const list = a.kind === 'T' ? sh.texts : a.kind === 'B' ? sh.textBoxes : a.kind === 'U' ? sh.buses : a.kind === 'E' ? sh.entries : sh.graphics; const idx = list.findIndex((o) => uuidOf(o) === a.uuid); if (idx >= 0) state.sel = { type: 'graphic', inst: state.inst, it: a.kind + idx }; }
    else if (a.type === 'netname') { const n = P.nets.find((x) => x.name === a.name); if (n) state.sel = { type: 'net', net: n, item: null }; }
    else if (a.type === 'multi') { if (multiCount(a.m)) state.sel = { type: 'multi', inst: state.inst, m: a.m }; }
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
    if (state.undo.length > 200) state.undo.splice(0, state.undo.length - 200);   // keep memory in check on long sessions
    state.redo = [];
    rebuild(anchor);
    schedulePersist();
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
    schedulePersist();
    toast('Undid: ' + h.label);
  }
  function redo() {
    const h = state.redo.pop(); if (!h) return;
    for (const c of h.changes) setFileText(c.path, c.after);
    state.undo.push(h);
    rebuild(h.anchor);
    schedulePersist();
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
  // Saving the edited files to this device is debounced: a run of quick edits on a big project
  // writes once, and anything pending is written when the app is hidden or closed.
  let persistTimer = 0;
  function schedulePersist() { clearTimeout(persistTimer); persistTimer = setTimeout(() => { persistTimer = 0; persistEdits(); }, 600); }
  const flushPersist = () => { if (persistTimer) { clearTimeout(persistTimer); persistTimer = 0; persistEdits(); } };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushPersist(); });
  window.addEventListener('pagehide', flushPersist);
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
    const files = saved.files.filter((f) => state.base.has(f.path) || /\.kicad_sch$/i.test(f.path));
    if (!files.length) return;
    banner('old', `You have unsaved edits to ${files.length} sheet file${files.length === 1 ? '' : 's'} from ${new Date(saved.at).toLocaleString()}${sameBase ? '' : ' (made on an older revision)'}.`, [
      { label: 'RESTORE', primary: true, run: () => { banner(null); commitEdit(files.map((f) => ({ path: f.path, text: f.text })), 'Restore unsaved edits', { anchor: null }); } },
      { label: 'DISCARD', run: async () => { banner(null); await Store.del('edits:' + state.source.key); } }
    ]);
  }

  // ---- modes
  function setMode(mode) {
    if ((state.mode === 'move' && mode !== 'move') || (state.mode === 'box' && mode !== 'box')) { view.dragHandler = null; view.preview = null; state.boxStart = null; }
    if (mode !== 'move') state.keyMove = null;
    if (mode !== 'measure') state.measure = null;
    if (mode === 'measure') view.overlay = { pts: [], dots: [] };
    state.mode = mode;
    if (mode === 'box') view.dragHandler = boxDrag;
    if (mode === 'wire') setRibbonTab('wire', true);
    if (mode === 'draw' && state.draw && ['line', 'rect', 'circle', 'arc', 'text'].includes(state.draw.tool)) setRibbonTab('draw', true);
    for (const b of document.querySelectorAll('.rail-btn.mode')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode || (mode === 'move' && b.dataset.mode === 'select')));
    if (mode !== 'wire') { state.wire = { anchors: [], flips: [] }; view.overlay = null; state.wireKind = 'wire'; }
    if (mode === 'wire' || mode === 'label' || mode === 'draw') { view.overlay = { pts: [], dots: [] }; }
    if (mode === 'draw') state.draw = { tool: (state.draw && state.draw.tool) || 'part', pts: [], part: state.draw && state.draw.part, stencil: state.draw && state.draw.stencil };
    if (mode !== 'draw') markArmed(null);
    if (mode === 'draw' && state.draw.tool === 'part' && !state.draw.part) setTimeout(openPartPicker, 0);
    view.redraw();
    renderStatus();
    renderDrawBar();
    renderRibbon();
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
    for (const b of sh.buses) for (const q of [b.a, b.b]) { const d = Math.hypot(q[0] - wp[0], q[1] - wp[1]); if (d < bd) { bd = d; best = { p: q.slice(), on: 'bus' }; } }
    if (best) return best;
    for (const w of sh.wires.concat(sh.buses)) {
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
      const dx = b[0] - a[0], dy = b[1] - a[1];
      if (Math.abs(dx) > 1e-6 && Math.abs(dy) > 1e-6 && state.wirePosture !== 'free') {
        if (state.wirePosture === '45') {
          const d = Math.min(Math.abs(dx), Math.abs(dy)), diag = [a[0] + Math.sign(dx) * d, a[1] + Math.sign(dy) * d];
          const c = flips[i] ? [b[0] - Math.sign(dx) * d, b[1] - Math.sign(dy) * d] : diag;
          if (!E.same(c, a) && !E.same(c, b)) pts.push(c);
        } else pts.push(flips[i] ? [a[0], b[1]] : [b[0], a[1]]);
      }
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
  // Mouse users see the wire follow the pointer (KiCad style)
  function hoverWire(wp) {
    if (state.mode !== 'wire' || !state.wire.anchors.length) return;
    const w = state.wire, s = snapPoint(wp, 'mouse');
    view.overlay = { pts: wirePolyline(w.anchors.concat([s.p]), w.flips.concat([w.flips[w.flips.length - 1] || false])), dots: w.anchors.slice(), ring: s.on ? s.p : null };
    view.redraw();
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
    if (state.wireKind === 'bus') { const segs = []; for (let i = 1; i < pts.length; i++) segs.push([pts[i - 1], pts[i]]); run('Draw bus', () => E.addBusSegs(sh, segs), { anchor: null }); }
    else run('Draw wire', () => E.addWires(sh, pts), { anchor: null });
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
      kind = seg('Label type', [['local', 'NET LABEL'], ['global', 'OFF-SHEET'], ['hier', 'SHEET PORT']], o.kind || last, (v) => { shapeField.hidden = v === 'local'; });
      shape = shapeSel;
      dir = seg('Direction', [['right', '→'], ['up', '↑'], ['left', '←'], ['bottom', '↓']], o.spin || 'right');
      body.push(h('div', { class: 'field' }, h('label', { text: 'Type' }), kind.el), shapeField, h('div', { class: 'field' }, h('label', { text: 'Text direction' }), dir.el),
        h('p', { class: 'hint', text: 'Net labels join wires with the same name on this sheet. Off-sheet connectors (KiCad global labels) join across every sheet. Sheet ports (hierarchical labels) connect to a pin on the parent sheet.' }));
    }
    const go = () => {
      const v = name.value.trim();
      if (!v) { name.focus(); return; }
      closeDialog();
      const sh = state.inst.sheet;
      if (o.rename) run('Rename label', () => E.renameLabel(sh, o.rename, v));
      else {
        Store.pref('labelKind', kind.get()); Store.pref('labelShape', shape.value);
        if (run('Add label ' + v, () => E.addLabel(sh, kind.get(), v, o.p, dir.get(), shape.value), { anchor: null })) state.lastPlaced = { type: 'label', kind: kind.get(), text: v, p: o.p.slice(), spin: dir.get(), shape: shape.value, sheet: sh.path };
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
    // The menu scrolls when it is taller than the screen (CSS caps it); keep it on screen.
    const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    const mh = m.offsetHeight, mw = m.offsetWidth;
    m.style.left = Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw)) + 'px';
    m.style.top = (r.top - mh - 6 >= 8 ? r.top - mh - 6 : Math.max(8, Math.min(vh - mh - 8, r.bottom + 6))) + 'px';
    setTimeout(() => document.addEventListener('pointerdown', menuAway, { once: true }), 0);
  }
  function menuAway(e) { const m = $('menu'); if (m && !m.contains(e.target)) closeMenu(); else if (m) document.addEventListener('pointerdown', menuAway, { once: true }); }
  function closeMenu() { const m = $('menu'); if (m) m.remove(); }

  // ---- symbol fields
  function fieldsDialog(inst, si, focus) {
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
    if (focus) {
      const f = focus === 'Reference' ? refIn : (inputs.find(([n]) => n === focus) || [])[1];
      if (f) setTimeout(() => { f.focus(); f.select(); }, 60);
      else toast(ref + ' has no ' + focus + ' field.');
    }
  }

  // ---- move tool (drag anywhere; snaps to the grid)
  function startMove(target) {
    state.moveTarget = target;
    setMode('move');
    view.dragHandler = moveHandler(target);
    renderStatus();
  }
  // Pressing on the current selection and dragging moves it, without tapping MOVE first.
  function dragSelectionFrom(wp, type) {
    if (state.mode !== 'select' || !state.sel || !state.inst || !state.project) return null;
    const s = state.sel, sh = state.inst.sheet;
    const hit = view.hitTest(wp, type === 'mouse' ? 6 : 12);
    if (!hit) return null;
    let target = null;
    if (s.type === 'multi' && s.inst === state.inst) {
      const r = multiResolve(s.m);
      const on = (hit.type === 'symbol' && r.syms.has(hit.si)) || (hit.type === 'sheet' && r.its.has('H' + hit.idx)) || (hit.it && r.its.has(hit.it));
      if (on) target = { type: 'multi', name: r.items.length + ' items' };
    } else if (s.type === 'symbol' && s.inst === state.inst && hit.type === 'symbol' && hit.si === s.si) {
      const sym = sh.symbols[s.si]; target = { type: 'symbol', uuid: sym.uuid, name: s.inst.refs[s.si].ref };
    } else if (s.type === 'net' && hit.type === 'net' && hit.it) {
      // Any wire of the selected net can be grabbed and dragged; a label only if it is the tapped one.
      const it = itemFromTag(hit.it), o = it && itemObj(it);
      const sameNet = state.project.nets[state.inst.netOf[hit.g]] === s.net;
      if (it && o && it.type === 'wire' && sameNet) target = { type: 'wire', uuid: uuidOf(o), name: 'wire' };
      else if (it && o && s.item && it.type === 'label' && it.type === s.item.type && it.idx === s.item.idx) target = { type: 'label', uuid: uuidOf(o), name: 'label ' + o.text };
    }
    if (!target) return null;
    state.moveTarget = target;
    const h = moveHandler(target);
    return { move: h.move, end: (d) => { h.end(d); if (state.mode === 'move') setMode('select'); renderStatus(); }, cancel: () => { view.preview = null; view.redraw(); } };
  }
  function moveHandler(target) {
    // A single wire segment slides sideways only (a horizontal one up/down, a vertical one left/right),
    // so the wires either side just get longer or shorter and everything stays square.
    const axis = () => {
      const t = state.moveTarget;
      if (!t || t.type !== 'wire' || !state.inst) return null;
      const w = state.inst.sheet.wires.find((x) => uuidOf(x) === t.uuid);
      if (!w) return null;
      if (Math.abs(w.a[1] - w.b[1]) < 1e-3) return 'y';
      if (Math.abs(w.a[0] - w.b[0]) < 1e-3) return 'x';
      return null;
    };
    const snapD = (d) => { const ax = axis(); const r = [E.snap(d[0]), E.snap(d[1])]; if (ax === 'y') r[0] = 0; else if (ax === 'x') r[1] = 0; return r; };
    const tagFor = () => {
      const t = state.moveTarget, sh = state.inst.sheet;
      if (t.type === 'multi') { const r = state.sel && state.sel.type === 'multi' ? multiResolve(state.sel.m) : { syms: new Set(), its: new Set() }; return { sym: -1, syms: r.syms, its: r.its }; }
      if (t.type === 'symbol') return { sym: sh.symbols.findIndex((x) => x.uuid === t.uuid), its: null };
      if (t.type === 'graphic') { const list = t.kind === 'T' ? sh.texts : t.kind === 'B' ? sh.textBoxes : sh.graphics; return { sym: -1, its: new Set([t.kind + list.findIndex((o) => uuidOf(o) === t.uuid)]) }; }
      const list = t.type === 'label' ? sh.labels : sh.wires;
      const idx = list.findIndex((o) => uuidOf(o) === t.uuid);
      return { sym: -1, its: new Set([(t.type === 'label' ? 'L' : 'W') + idx]) };
    };
    return {
      move: (d) => { const tg = tagFor(); view.preview = { sym: tg.sym, syms: tg.syms || null, its: tg.its, d: snapD(d) }; view.redraw(); },
      end: (d) => {
        view.preview = null;
        const sd = snapD(d);
        if (!sd[0] && !sd[1]) { view.redraw(); return; }
        const t = state.moveTarget, sh = state.inst.sheet;
        if (t.type === 'multi') {
          if (!state.sel || state.sel.type !== 'multi') { setMode('select'); return; }
          const r = multiResolve(state.sel.m);
          run('Move ' + t.name, () => E.moveItems(sh, r.items, sd, { keepWires: t.keepWires !== false }), { checkMerges: true });
          return;
        }
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
        run('Move ' + t.name, () => E.moveItems(sh, [item], sd, { keepWires: t.keepWires !== false }), { checkMerges: true });
      }
    };
  }

  // ---- actions on the selection
  function selectionActions() {
    const s = state.sel, sh = state.inst && state.inst.sheet;
    if (!s || !sh) return [];
    const A = installActions();
    if (s.type === 'symbol') {
      const sym = sh.symbols[s.si], ref = s.inst.refs[s.si].ref;
      A.push({ label: 'EDIT', icon: 'i-edit', run: () => fieldsDialog(s.inst, s.si) });
      A.push({ label: 'LOOM', icon: 'i-tag', run: () => loomDialog([{ inst: s.inst, si: s.si }]) });
      A.push({ label: 'MOVE', icon: 'i-move', run: () => startMove({ type: 'symbol', uuid: sym.uuid, name: ref }) });
      A.push({ label: 'ROTATE', icon: 'i-rotate', run: () => run('Rotate ' + ref, () => E.transformSymbol(sh, sym, 'rotate'), { checkMerges: true }) });
      A.push({ label: 'DUPLICATE', icon: 'i-dup', run: () => copyPart(s.inst, s.si) });
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
        if (Loom.isCableFlag(o)) A.push({ label: 'FLIP SIDE', icon: 'i-flip', run: () => run('Flip cable tag', () => { const f = Loom.cableFields(o); f.Cable_Label = Loom.cableLabel(f); return E.setCableFields(sh, o, f, E.cableSideOf(o) === 'a' ? 'b' : 'a'); }) });
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
      if (child) A.push({ label: 'ADD PIN', icon: 'i-plus', run: () => addSheetPinDialog(s.inst, s.idx) }, { label: 'IMPORT PINS', icon: 'i-hlabel', run: () => importSheetPins(s.inst, s.idx) });
      A.push({ label: 'DELETE', icon: 'i-trash', danger: true, run: () => run('Delete sheet ' + sheet.name, () => E.deleteItems(sh, [{ type: 'sheet', sheet }]), { anchor: null }) });
    } else if (s.type === 'multi') {
      const r = multiResolve(s.m), n = r.items.length;
      A.push({ label: 'MOVE', icon: 'i-move', run: () => startMove({ type: 'multi', name: n + ' items' }) });
      if (r.syms.size) A.push({ label: 'LOOM', icon: 'i-tag', run: () => loomDialog(Array.from(r.syms).map((si) => ({ inst: state.inst, si }))) });
      A.push({ label: 'COPY', icon: 'i-copy2', run: copySel });
      A.push({ label: 'DUPLICATE', icon: 'i-dup', run: duplicateSel });
      A.push({ label: 'DELETE', icon: 'i-trash', danger: true, run: () => run(`Delete ${n} item${n === 1 ? '' : 's'}`, () => E.deleteItems(sh, r.items), { anchor: null }) });
      A.push({ label: 'ADD MORE', icon: 'i-box', run: () => setMode('box') });
    } else if (s.type === 'graphic') {
      const o = graphicObj(s.it, sh);
      if (o) {
        const name = graphicName(s.it, o);
        if (s.it[0] === 'U') A.push({ label: 'CABLE', icon: 'i-cable', run: () => cableDialog(s) }, { label: 'UNFOLD', icon: 'i-tee', run: () => unfoldDialog(o) });
        if (s.it[0] === 'T') A.push({ label: 'EDIT', icon: 'i-edit', run: () => textDialog({ edit: o }) });
        else if (s.it[0] === 'G') A.push({ label: 'STYLE', icon: 'i-style', run: () => styleDialog(o) });
        A.push({ label: 'MOVE', icon: 'i-move', run: () => startMove({ type: 'graphic', kind: s.it[0], uuid: uuidOf(o), name: name.toLowerCase() }) });
        A.push({ label: 'DELETE', icon: 'i-trash', danger: true, run: () => run('Delete ' + name.toLowerCase(), () => E.deleteNode(sh, o.src), { anchor: null }) });
        if (!uuidOf(o) || /^[UE]/.test(s.it)) { const mi = A.findIndex((x) => x.label === 'MOVE'); if (mi >= 0) A.splice(mi, 1); }
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
      state.files = state.files.filter((f) => state.base.has(f.path));
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
    const max = (window.matchMedia('(max-width: 760px)').matches ? 3 : 6) + (list.some((a) => a.trace) ? 1 : 0);
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
    if (immersive && immersive.on && (s || state.mode !== 'select')) peek('status');
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
      const what = state.wireKind === 'bus' ? 'bus' : 'wire';
      t1.textContent = n ? 'Drawing ' + what : what[0].toUpperCase() + what.slice(1);
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
    if (state.mode === 'box') {
      const n = s && s.type === 'multi' ? multiResolve(s.m).items.length : 0;
      setIco('i-box');
      t1.textContent = n ? `${n} selected` : 'Box select';
      t2.textContent = 'Drag a box round items · tap one to add or remove it · tap empty space to finish · two fingers pan';
      const L = [];
      if (n) L.push({ label: 'DONE', icon: 'i-check', primary: true, run: () => setMode('select') });
      L.push({ label: 'ALL', icon: 'i-selall', run: selectAll });
      if (n) L.push({ label: 'NONE', icon: 'i-close', run: () => { clearSelection(); renderStatus(); } });
      if (!n) L.push({ label: 'CANCEL', icon: 'i-close', run: () => setMode('select') });
      putActions(acts, L);
      return;
    }
    if (state.mode === 'measure') {
      const m = state.measure;
      setIco('i-line');
      t1.textContent = 'Measure';
      t2.textContent = m && m.a && m.b ? measureText(m.a, m.b) : m && m.a ? 'Tap the second point' : 'Tap the first point';
      putActions(acts, [{ label: 'DONE', icon: 'i-close', run: () => setMode('select') }]);
      return;
    }
    if (state.mode === 'paste') {
      setIco('i-paste');
      t1.textContent = 'Paste ' + clipText();
      t2.textContent = 'Tap where the top-left of the copy goes';
      putActions(acts, [{ label: 'CANCEL', icon: 'i-close', run: () => setMode('select') }]);
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
      t2.textContent = s.it[0] === 'U' ? 'Bus · ' + (busMembers(o).length ? busMembers(o).length + ' members · UNFOLD takes one out' : 'name it with a label like D[0..7]') : s.it[0] === 'E' ? 'Bus entry: joins a wire to a bus' : s.it[0] === 'G' && o ? `Drawing · line ${o.st && o.st.w ? o.st.w + ' mm' : 'default'}${o.st && o.st.type && o.st.type !== 'default' && o.st.type !== 'solid' ? ' · ' + o.st.type.replace('_', '-') : ''}` : 'Text on the drawing';
    } else if (s.type === 'multi') {
      const r = multiResolve(s.m);
      setIco('i-box'); ico.classList.add('part');
      t1.textContent = r.items.length + ' selected';
      t2.textContent = multiSummary(s.m);
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
    $('scaleText').textContent = (view.showGrid ? `dots ${step < 10 ? step.toFixed(2) : step.toFixed(1)} mm` : `${step < 10 ? step.toFixed(2) : step.toFixed(1)} mm · grid off`) + (E.snapGrid() !== 1.27 ? ` · snap ${E.snapGrid()}` : '');
  }
  $('scaleChip').addEventListener('click', () => { view.showGrid = !view.showGrid; Store.pref('grid', view.showGrid); view.redraw(); renderScale(); });

  function renderSelectionUI() {
    renderStatus();
    renderRibbon();
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
  $('btnBack').addEventListener('click', () => navGo(state.navBack, state.navFwd));
  // Mouse back / forward buttons (and keyboard Browser Back / Forward keys) step through sheets instead of leaving the app
  const navBlocked = () => !state.project || !!($('dialogWrap') || $('pickerWrap') || $('reportWrap') || $('fieldsWrap') || $('symEditor'));
  // Chrome sends these as pointer events; cancelling pointerdown also stops the browser's own back / forward
  // (and suppresses the mousedown / mouseup that would follow), so the step happens on pointerup.
  for (const ev of ['mousedown', 'mouseup', 'pointerdown', 'auxclick']) window.addEventListener(ev, (e) => { if ((e.button === 3 || e.button === 4) && state.project) { e.preventDefault(); e.stopPropagation(); } }, true);   // the drawing never sees them as a tap
  window.addEventListener('pointerup', (e) => {
    if (e.button !== 3 && e.button !== 4) return;
    if (!state.project) return;   // no project open: let the browser go back as usual
    e.preventDefault(); e.stopPropagation();
    if (navBlocked()) return;
    if (e.button === 3) navGo(state.navBack, state.navFwd); else navGo(state.navFwd, state.navBack);
  }, true);
  window.addEventListener('keydown', (e) => {
    if ((e.key !== 'BrowserBack' && e.key !== 'BrowserForward') || !state.project) return;
    e.preventDefault();
    if (!navBlocked()) { if (e.key === 'BrowserBack') navGo(state.navBack, state.navFwd); else navGo(state.navFwd, state.navBack); }
  }, true);
  $('btnFwd').addEventListener('click', () => navGo(state.navFwd, state.navBack));

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
      const repoIn = h('input', { class: 'input', id: 'ghRepo', name: 'username', placeholder: 'your-org/schematics', value: gh.repo || '', autocapitalize: 'off', autocomplete: 'username', spellcheck: 'false' });
      const refIn = h('input', { class: 'input', id: 'ghRef', placeholder: 'default branch', value: gh.ref || '', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' });
      // Repository + token are marked as a sign-in, so the browser's password manager can keep them:
      // they then survive a browser that clears site data when it closes.
      const tokIn = h('input', { class: 'input', id: 'ghToken', name: 'password', type: 'password', placeholder: 'github_pat_… or ghp_…', autocomplete: 'current-password', spellcheck: 'false' });
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
        if (rem.checked && state.source && state.source.kind === 'github') saveCredential(repo, token);
      } }, icon('i-git'), 'Connect');
      const form = h('form', { class: 'gh-form', autocomplete: 'on', onsubmit: (e) => { e.preventDefault(); go.click(); } });
      for (const el of [repoIn, refIn, tokIn]) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go.click(); } });
      const saved = window.PasswordCredential ? h('button', { class: 'btn small', type: 'button', onclick: () => restoreCredential('optional') }, icon('i-git'), 'USE SAVED TOKEN') : null;
      form.append(
        h('div', { class: 'field' }, h('label', { for: 'ghRepo', text: 'Repository' }), repoIn),
        h('div', { class: 'field' }, h('label', { for: 'ghRef', text: 'Branch or tag (optional)' }), refIn),
        h('div', { class: 'field' }, h('label', { for: 'ghToken', text: 'Access token' }), tokIn));
      ghSec.append(form, saved || '',
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
      h('button', { class: 'btn small', onclick: () => { closeDrawers(); printDialog(); } }, icon('i-print'), 'Print / PDF'),
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
    return it[0] === 'G' ? sh.graphics[i] : it[0] === 'T' ? sh.texts[i] : it[0] === 'B' ? sh.textBoxes[i] : it[0] === 'U' ? sh.buses[i] : it[0] === 'E' ? sh.entries[i] : null;
  }
  function graphicName(it, o) {
    if (!o) return 'Drawing';
    if (it[0] === 'T') return 'Text “' + plain(o.s).slice(0, 40) + '”';
    if (it[0] === 'B') return 'Text box';
    if (it[0] === 'U') return 'Bus' + (busName(o) ? ' ' + busName(o) : '');
    if (it[0] === 'E') return 'Bus entry';
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
    else if ((d.tool === 'rect' || d.tool === 'sheet') && pts.length) { const a = pts[0], b = extra || a; ov.pts = [a, [b[0], a[1]], b, [a[0], b[1]], a]; }
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
      placePart(d.part, wp, type);
      return;
    }
    if (d.tool === 'stencil') { if (d.stencil) placeStencil(d.stencil, wp, type); return; }
    if (d.tool === 'text') { textDialog({ p }); return; }
    if (d.tool === 'entry') {
      if (!sh.buses.some((b) => K.onSegment(p, b.a, b.b))) { toast('Tap on a bus. R turns the entry.'); return; }
      run('Add bus entry', () => E.addBusEntry(sh, p, ENTRY_DIRS[d.dir || 0]), { anchor: null });
      return;
    }
    d.pts.push(p);
    if (d.tool === 'sheet' && d.pts.length === 2) { const [a, b] = d.pts; d.pts = []; if (Math.abs(a[0] - b[0]) < 5 || Math.abs(a[1] - b[1]) < 5) { toast('Drag out a bigger box: tap two opposite corners.'); drawOverlay(); return; } drawOverlay(); sheetDialog(a, b); return; }
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
    setIco(d.tool === 'stencil' ? 'i-stencil' : tool[2]);
    const n = d.pts.length;
    const hints = {
      part: d.part ? `Tap where ${d.part.name} goes` : 'Choose a part to place',
      line: n ? 'Tap the next point · FINISH when done' : 'Tap the first point',
      rect: n ? 'Tap the opposite corner' : 'Tap one corner',
      circle: n ? 'Tap a point on the edge' : 'Tap the centre',
      arc: ['Tap where the arc starts', 'Tap a point the arc passes through', 'Tap where the arc ends'][n] || '',
      text: 'Tap where the text goes',
      entry: 'Tap on a bus to add an entry · R turns it',
      sheet: n ? 'Tap the opposite corner' : 'Tap one corner of the new sheet',
      stencil: d.stencil ? `Tap where the ${d.stencil.name.toLowerCase()} goes${d.stencil.kind === 'wire' ? ' · on a wire to join it' : ''}` : 'Pick a stencil'
    };
    t1.textContent = d.tool === 'entry' ? 'Bus entry' : d.tool === 'sheet' ? 'New sheet' : d.tool === 'stencil' && d.stencil ? 'Place · ' + d.stencil.name : d.tool === 'part' && d.part ? 'Place · ' + d.part.name : 'Draw · ' + tool[1].toLowerCase();
    t2.textContent = hints[d.tool];
    const L = [];
    if (d.tool === 'line' && n > 1) L.push({ label: 'FINISH', icon: 'i-check', primary: true, run: finishLine });
    if (n) L.push({ label: 'BACK', icon: 'i-undo', run: () => { d.pts.pop(); drawOverlay(); renderStatus(); } });
    if (d.tool === 'part') L.push({ label: d.part ? 'CHANGE' : 'CHOOSE', icon: 'i-part', primary: !d.part, run: openPartPicker });
    const last = d.tool === 'part' && d.last && state.inst.sheet.symbols.find((x) => x.uuid === d.last.uuid);
    if (last) L.push({ label: 'ROTATE', icon: 'i-rotate', run: () => { run('Rotate ' + d.last.ref, () => E.transformSymbol(state.inst.sheet, last, 'rotate'), { anchor: null }); const i = state.inst.sheet.symbols.findIndex((x) => x.uuid === d.last.uuid); view.setHighlight(null, i, -1); } });
    if (d.tool === 'entry') L.push({ label: 'TURN', icon: 'i-rotate', run: () => { d.dir = ((d.dir || 0) + 1) % 4; if (state.mouse) hoverPreview(state.mouse); } });
    if (d.tool !== 'part' && d.tool !== 'stencil' && d.tool !== 'entry' && d.tool !== 'sheet') L.push({ label: 'STYLE', icon: 'i-style', run: () => styleDialog(null) });
    if (d.tool === 'stencil' || d.tool === 'part') L.push({ label: 'STENCILS', icon: 'i-stencil', run: () => setDock(true) });
    L.push({ label: 'DONE', icon: 'i-close', run: () => setMode('select') });
    putActions(acts, L);
    renderDrawBar();
  }
  function renderDrawBar() {
    const bar = $('drawBar');
    // Shown only when the ribbon is folded away; otherwise its Draw tab has these tools.
    bar.hidden = state.mode !== 'draw' || ribbonOpen || !['line', 'rect', 'circle', 'arc', 'text'].includes(state.draw && state.draw.tool);
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
    let size, bold, italic, ang, colour;
    if (!ed) {
      const last = Store.pref('textStyle') || {};
      size = seg('Size', [['1.27', 'SMALL'], ['2', 'MEDIUM'], ['2.54', 'LARGE'], ['3.81', 'TITLE']], last.size || '1.27');
      ang = seg('Direction', [['0', 'ACROSS'], ['90', 'UP']], last.angle || '0');
      bold = h('input', { type: 'checkbox', checked: !!last.bold });
      italic = h('input', { type: 'checkbox', checked: !!last.italic });
      colour = seg('Colour', [['default', 'DEFAULT'], ['red', 'RED'], ['blue', 'BLUE'], ['green', 'GREEN'], ['black', 'BLACK']], last.colour || 'default');
      body.push(h('div', { class: 'field' }, h('label', { text: 'Size' }), size.el), h('div', { class: 'field' }, h('label', { text: 'Direction' }), ang.el),
        h('div', { class: 'field' }, h('label', { text: 'Colour' }), colour.el),
        h('label', { class: 'check' }, bold, 'Bold'), h('label', { class: 'check' }, italic, 'Italic'));
    }
    const go = () => {
      const v = txt.value.trim();
      if (!v) { txt.focus(); return; }
      closeDialog();
      const sh = state.inst.sheet;
      if (ed) run('Edit text', () => E.editText(sh, ed, v));
      else {
        const ts = { size: size.get(), angle: ang.get(), bold: bold.checked, italic: italic.checked, colour: colour.get() };
        Store.pref('textStyle', ts);
        run('Add text', () => E.addGraphic(sh, 'text', { p: o.p, text: v, size: +ts.size, angle: +ts.angle, bold: ts.bold, italic: ts.italic }, styleFor(Object.assign(drawStyle(), { colour: ts.colour }))), { anchor: null });
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
      try { const mp = await Store.get('myParts'); if (mp && mp.meta && Object.keys(mp.meta).length) mergeMyParts(idx, mp); } catch (e) { /* none */ }
      libState.index = idx;
      return idx;
    })();
    try { return await libState.loading; } finally { libState.loading = null; }
  }
  async function loadLibFile(lib) {
    if (libState.files.has(lib)) return libState.files.get(lib);
    if (lib === 'My_Parts') { const mp = await Store.get('myParts'); const f = { symbols: (mp && mp.symbols) || {} }; libState.files.set(lib, f); return f; }
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
  function openPartPicker(initial) {
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
      if (!terms.length && cat === 'All' && recent.length && !libOnly) {
        const byKey = new Map(idx.rows.map((r) => [idx.libs[r[0]].name + ':' + r[1], r]));
        rows = recent.map((k) => byKey.get(k)).filter(Boolean);
        if (rows.length) list.append(h('div', { class: 'row group' }, h('span', { class: 'main' }, h('span', { class: 'nm', text: 'Recently used' }))));
      }
      if (!rows.length || terms.length || cat !== 'All' || libOnly) {
        const scored = [];
        const q0 = terms.join(' ');
        idx.rows.forEach((r, i) => {
          if (libOnly ? idx.libs[r[0]].name !== libOnly : cat !== 'All' && idx.libs[r[0]].cat !== cat) return;
          const hay = idx.hay[i];
          if (!terms.every((t) => hay.includes(t))) return;
          const nm = r[1].toLowerCase();
          const sc = !terms.length ? 3 : nm === q0 ? 0 : nm.startsWith(terms[0]) ? 1 : nm.includes(terms[0]) ? 2 : 3;
          scored.push([sc, r]);
        });
        const own = (r) => (/^(Loomline_|My_Parts)/.test(idx.libs[r[0]].name) ? 0 : 1);
        scored.sort((a, b) => a[0] - b[0] || own(a[1]) - own(b[1]) || K.naturalCmp(a[1][1], b[1][1]));
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
    const libOnly = typeof initial === 'string' && initial.startsWith('lib:') ? initial.slice(4) : null;
    if (typeof initial === 'string' && !libOnly) q.value = initial;
    if (libOnly) q.placeholder = 'Search the ' + libOnly + ' symbols';
    loadLibIndex().then((idx) => {
      const names = ['All'].concat(Array.from(new Set(idx.libs.map((l) => l.cat))));
      for (const c of names) cats.append(h('button', { class: 'chip' + (c === cat ? ' on' : ''), onclick: (e) => { cat = c; state.pickCat = c; for (const b of cats.children) b.classList.toggle('on', b === e.currentTarget); fill(); } }, c));
      fill();
      setTimeout(() => q.focus(), 50);
    }).catch((e) => { $('pickCount').textContent = e.message; });
  }
  function closePicker() { const w = $('pickerWrap'); if (w) w.remove(); }
  function placePart(entry, wp, type) {
    const r = run('Add ' + entry.name, () => smartPlace(entry, wp, type), { anchor: null, checkMerges: true });
    if (!r) return;
    rememberStencil({ kind: 'part', lib: entry.lib, name: entry.name });
    if (r.uuid) state.lastPlaced = { type: 'symbol', uuid: r.uuid, sheet: state.inst.sheet.path };
    const ni = state.inst.sheet.symbols.findIndex((x) => x.uuid === r.uuid);
    if (ni >= 0) {
      if (state.draw) state.draw.last = { uuid: r.uuid, ref: r.ref };
      view.setHighlight(null, ni, -1);
      renderStatus();
      const how = r.how === 'series' ? ' in the wire' : r.how === 'tap' ? ' and connected' : '';
      toast(`${r.ref} placed${how}${r.units.length > 1 ? ` (unit A of ${r.units.length}; select it and tap ADD UNIT for the others)` : ''}. Tap again for another.`);
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

  // ================================================================== 2.0: multi-select, clipboard, stencils, ribbon
  // ---- multi selection (box select), kept by UUID so it survives the rebuild after each edit
  const MKINDS = ['sym', 'wire', 'label', 'junction', 'nc', 'graphic', 'sheet', 'bus', 'entry'];
  const emptyMulti = () => ({ sym: new Set(), wire: new Set(), label: new Set(), junction: new Set(), nc: new Set(), graphic: new Set(), sheet: new Set(), bus: new Set(), entry: new Set() });
  const multiCount = (m) => MKINDS.reduce((n, k) => n + m[k].size, 0);
  function multiResolve(m, inst) {
    inst = inst || state.inst;
    const sh = inst.sheet, out = { syms: new Set(), its: new Set(), items: [], copy: [] };
    sh.symbols.forEach((s, i) => { if (m.sym.has(s.uuid)) { out.syms.add(i); out.items.push({ type: 'symbol', sym: s }); out.copy.push({ type: 'symbol', sym: s, ref: inst.refs[i].ref }); } });
    for (const [k, list, t] of [['wire', sh.wires, 'W'], ['label', sh.labels, 'L'], ['junction', sh.junctions, 'J'], ['nc', sh.noConnects, 'N']]) {
      list.forEach((o, i) => {
        const u = uuidOf(o); if (!u || !m[k].has(u)) return;
        out.its.add(t + i);
        out.items.push(k === 'wire' ? { type: 'wire', wire: o } : k === 'label' ? { type: 'label', label: o } : { type: k, item: o });
        out.copy.push({ type: k, obj: o });
      });
    }
    for (const [list, t] of [[sh.graphics, 'G'], [sh.texts, 'T'], [sh.textBoxes, 'B']]) {
      list.forEach((o, i) => { const u = uuidOf(o); if (!u || !m.graphic.has(u)) return; out.its.add(t + i); out.items.push({ type: 'node', node: o.src, item: o }); out.copy.push({ type: 'node', obj: o }); });
    }
    // Hierarchical sheets (with their pins), buses and bus entries move and delete with the rest;
    // they aren't copied (a copied sheet would need its own file and instance).
    if (m.sheet) sh.sheets.forEach((o, i) => { if (!o.uuid || !m.sheet.has(o.uuid)) return; out.its.add('H' + i); o.pins.forEach((_, pi) => out.its.add('HP' + i + ':' + pi)); out.items.push({ type: 'sheet', sheet: o }); out.nocopy = (out.nocopy || 0) + 1; });
    if (m.bus) sh.buses.forEach((o, i) => { const u = uuidOf(o); if (!u || !m.bus.has(u)) return; out.its.add('U' + i); out.items.push({ type: 'wire', wire: o }); out.nocopy = (out.nocopy || 0) + 1; });
    if (m.entry) sh.entries.forEach((o, i) => { const u = uuidOf(o); if (!u || !m.entry.has(u)) return; out.its.add('E' + i); out.items.push({ type: 'node', node: o.src, item: o }); out.nocopy = (out.nocopy || 0) + 1; });
    return out;
  }
  function multiSummary(m) {
    const parts = [[m.sheet ? m.sheet.size : 0, 'sheet'], [m.sym.size, 'part'], [m.wire.size, 'wire'], [m.bus ? m.bus.size : 0, 'bus'], [m.entry ? m.entry.size : 0, 'bus entry'], [m.label.size, 'label'], [m.junction.size, 'junction'], [m.nc.size, 'no-connect'], [m.graphic.size, 'drawing item']];
    parts.forEach((x) => { if (x[1] === 'bus' && x[0] > 1) x[1] = 'buse'; if (x[1] === 'bus entry' && x[0] > 1) x[1] = 'bus entrie'; });
    return parts.filter(([n]) => n).map(([n, w]) => n + ' ' + w + (n === 1 ? '' : 's')).join(' · ') || 'Nothing';
  }
  function selectMulti(m) {
    if (!multiCount(m)) { clearSelection(); return; }
    state.sel = { type: 'multi', inst: state.inst, m };
    applyHighlight();
    renderSelectionUI();
    if (!state.panelOpen && propsFollow() && state.mode === 'select') showTab('info', true);
  }
  // Everything wholly inside box b = [x0, y0, x1, y1] on the current sheet
  function itemsInBox(b) {
    const sh = state.inst.sheet, S = sceneFor(state.inst), m = emptyMulti();
    const inP = (p) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
    const inB = (bb) => bb && bb[0] >= b[0] && bb[2] <= b[2] && bb[1] >= b[1] && bb[3] <= b[3];
    for (const sy of S.syms) { const bb = sy.body && (sy.body[2] - sy.body[0]) * (sy.body[3] - sy.body[1]) > 0.5 ? sy.body : sy.bb; const u = sh.symbols[sy.si] && sh.symbols[sy.si].uuid; if (u && inB(bb)) m.sym.add(u); }
    const addP = (k, list, f) => list.forEach((o) => { const u = uuidOf(o); if (u && f(o)) m[k].add(u); });
    addP('wire', sh.wires, (w) => inP(w.a) && inP(w.b));
    addP('label', sh.labels, (l) => inP(l.p));
    addP('junction', sh.junctions, (j) => inP(j.p));
    addP('nc', sh.noConnects, (n) => inP(n.p));
    addP('bus', sh.buses, (w) => inP(w.a) && inP(w.b));
    addP('entry', sh.entries, (e) => inP(e.a) && inP(e.b));
    for (const s of sh.sheets) if (s.uuid && inP(s.p) && inP([s.p[0] + s.size[0], s.p[1] + s.size[1]])) m.sheet.add(s.uuid);
    const gb = new Map();
    const grow = (it, bb) => { if (!it || !'GTB'.includes(it[0]) || !bb) return; const g = gb.get(it); gb.set(it, g ? [Math.min(g[0], bb[0]), Math.min(g[1], bb[1]), Math.max(g[2], bb[2]), Math.max(g[3], bb[3])] : bb.slice()); };
    for (const x of S.strokes) grow(x.it, x.bb);
    for (const x of S.circles) grow(x.it, x.bb);
    for (const x of S.texts) grow(x.it, x.bb);
    for (const x of S.fills) grow(x.it, x.bb);
    for (const [it, bb] of gb) if (inB(bb)) { const o = graphicObj(it, sh); const u = o && uuidOf(o); if (u) m.graphic.add(u); }
    return m;
  }
  function mergeMulti(a, b) { const m = emptyMulti(); for (const k of MKINDS) { for (const u of a[k]) m[k].add(u); for (const u of b[k]) m[k].add(u); } return m; }
  const curMulti = () => (state.sel && state.sel.type === 'multi' && state.sel.inst === state.inst ? state.sel.m : emptyMulti());
  const boxDrag = {
    move: (d) => {
      const a = view._dragStart;
      state.boxStart = a ? a.slice() : null;
      view.overlay = a ? { box: [a, [a[0] + d[0], a[1] + d[1]]] } : null;
      view.redraw();
    },
    end: (d) => {
      const a = state.boxStart; state.boxStart = null; view.overlay = null;
      if (!a) { view.redraw(); return; }
      const b = [a[0] + d[0], a[1] + d[1]];
      const box = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
      if (box[2] - box[0] < 0.5 && box[3] - box[1] < 0.5) { view.redraw(); return; }
      const got = itemsInBox(box);
      if (!multiCount(got)) { toast('Nothing lies wholly inside that box.'); view.redraw(); return; }
      selectMulti(mergeMulti(curMulti(), got));
    }
  };
  function boxTap(wp, type) {
    const hit = view.hitTest(wp, type === 'mouse' ? 8 : 16);
    if (!hit) { clearSelection(); setMode('select'); renderStatus(); return; }
    const sh = state.inst.sheet, m = mergeMulti(curMulti(), emptyMulti());
    let k = null, u = null;
    if (hit.type === 'symbol') { k = 'sym'; u = sh.symbols[hit.si].uuid; }
    else if (hit.type === 'sheet') { k = 'sheet'; u = sh.sheets[hit.idx] && sh.sheets[hit.idx].uuid; }
    else if (hit.it && /^U\d/.test(hit.it)) { k = 'bus'; u = uuidOf(graphicObj(hit.it, sh)); }
    else if (hit.it && /^E\d/.test(hit.it)) { k = 'entry'; u = uuidOf(graphicObj(hit.it, sh)); }
    else if (hit.type === 'graphic') { k = 'graphic'; u = uuidOf(graphicObj(hit.it, sh)); }
    else if (hit.type === 'net' && hit.it) {
      const it = itemFromTag(hit.it);
      if (it && it.type === 'pin') { k = 'sym'; u = sh.symbols[it.si].uuid; }
      else if (it) { k = it.type; u = uuidOf(itemObj(it)); }
    }
    if (!k || !u || !m[k]) return;
    if (m[k].has(u)) m[k].delete(u); else m[k].add(u);
    selectMulti(m);
  }
  function selectAll() {
    if (!state.inst) return;
    const m = itemsInBox([-1e6, -1e6, 1e6, 1e6]);
    selectMulti(m);
    toast(multiSummary(m));
  }
  function startBox() { if (!state.project) return; if (state.sel && state.sel.type !== 'multi') { state.sel = null; applyHighlight(); } setMode('box'); }

  // ---- clipboard: copy on one sheet, paste on any sheet of the project (or another project)
  const clipText = () => { const c = state.clip; if (!c) return ''; const n = c.items.length; return n + ' item' + (n === 1 ? '' : 's'); };
  function copyItemsOfSel() {
    const s = state.sel, sh = state.inst && state.inst.sheet;
    if (!s || !sh) return null;
    if (s.type === 'multi') return multiResolve(s.m).copy;
    if (s.type === 'symbol' && s.inst === state.inst) return [{ type: 'symbol', sym: sh.symbols[s.si], ref: s.inst.refs[s.si].ref }];
    if (s.type === 'graphic') { const o = graphicObj(s.it, sh); return o ? [{ type: 'node', obj: o }] : null; }
    if (s.type === 'net' && s.item && (s.item.type === 'wire' || s.item.type === 'label')) { const o = itemObj(s.item); return o ? [{ type: s.item.type, obj: o }] : null; }
    return null;
  }
  const canCopy = () => { const c = copyItemsOfSel(); return !!(c && c.length); };
  function copySel() {
    const items = copyItemsOfSel();
    if (!items || !items.length) { toast('Select something to copy first.'); return null; }
    state.clip = E.copyItems(state.inst.sheet, items);
    try { Store.set('clipboard', state.clip); } catch (e) { /* memory only */ }
    toast(`Copied ${clipText()}. Paste, then tap where it goes (on any sheet).`);
    renderRibbon();
    return state.clip;
  }
  function pasteAt(p) {
    if (!state.clip) { toast('Copy something first.'); return; }
    const r = run('Paste ' + clipText(), () => E.pasteItems(state.project, state.inst.sheet, state.inst, state.clip, p), { anchor: null, checkMerges: true });
    if (!r) return;
    const ids = new Set(r.uuids), sh = state.inst.sheet, m = emptyMulti();
    sh.symbols.forEach((o) => { if (ids.has(o.uuid)) m.sym.add(o.uuid); });
    for (const [k, list] of [['wire', sh.wires], ['label', sh.labels], ['junction', sh.junctions], ['nc', sh.noConnects], ['graphic', sh.graphics.concat(sh.texts, sh.textBoxes)]]) list.forEach((o) => { const u = uuidOf(o); if (u && ids.has(u)) m[k].add(u); });
    selectMulti(m);
    toast(`Pasted ${clipText()}${r.refs.length ? ' as ' + r.refs.slice(0, 4).join(', ') + (r.refs.length > 4 ? '…' : '') : ''}. MOVE to adjust.`);
  }
  function startPaste() {
    if (!state.clip) { toast('Copy something first.'); return; }
    if (state.sel) { state.sel = null; applyHighlight(); }
    setMode('paste');
  }
  function duplicateSel() {
    const c = copySel(); if (!c) return;
    pasteAt([c.origin[0] + 5.08, c.origin[1] + 5.08]);
  }
  Store.get('clipboard').then((c) => { if (c && c.items && !state.clip) state.clip = c; }).catch(() => {});

  // ---- smart placement: a part dropped on a wire goes in series (two pins) or taps it (one pin),
  // and one dropped on a pin or wire end connects its nearest pin there.
  const insideWire = (p, w) => K.onSegment(p, w.a, w.b) && !E.same(p, w.a) && !E.same(p, w.b);
  function smartPlace(entry, wp, type) {
    const P = state.project, inst = state.inst, sh0 = inst.sheet;
    const snapped = snapPoint(wp, type || 'touch'), p = snapped.p;
    const old = new Set(sh0.symbols.map((x) => x.uuid));
    let r = E.addLibSymbol(P, sh0, inst, entry, p);
    const info = { ref: r.ref, unit: r.unit, units: r.units, how: null };
    let sh = E.reparse(sh0, r);
    const mine = () => sh.symbols.find((x) => !old.has(x.uuid));
    let sym = mine();
    const pins = () => K.symbolPins(sym);
    const plain = { text: sh.text, sh };
    const wire = snapped.on === 'wiremid' ? sh0.wires.find((w) => K.onSegment(p, w.a, w.b)) : null;
    if (wire && pins().length === 2) {
      const horiz = Math.abs(wire.a[1] - wire.b[1]) < 1e-6, vert = Math.abs(wire.a[0] - wire.b[0]) < 1e-6;
      const aligned = () => { const [a, b] = pins().map((x) => x.pos); return horiz ? Math.abs(a[1] - b[1]) < 1e-6 && Math.abs(a[0] - b[0]) > 1e-6 : Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) > 1e-6; };
      if (horiz || vert) {
        if (!aligned()) { r = E.transformSymbol(sh, sym, 'rotate', { keepWires: false }); sh = E.reparse(sh, r); sym = mine(); }
        if (aligned()) {
          const [a, b] = pins().map((x) => x.pos);
          const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          const d = horiz ? [E.snap(p[0] - mid[0]), wire.a[1] - a[1]] : [wire.a[0] - a[0], E.snap(p[1] - mid[1])];
          if (Math.abs(d[0]) > 1e-6 || Math.abs(d[1]) > 1e-6) { r = E.moveItems(sh, [{ type: 'symbol', sym }], d, { keepWires: false }); sh = E.reparse(sh, r); sym = mine(); }
          const [qa, qb] = pins().map((x) => x.pos);
          const w2 = sh.wires.find((w) => uuidOf(w) === uuidOf(wire));
          if (w2 && K.onSegment(qa, w2.a, w2.b) && K.onSegment(qb, w2.a, w2.b)) { r = E.insertInWire(sh, w2, qa, qb); sh = E.reparse(sh, r); sym = mine(); info.how = 'series'; }
        }
        if (!info.how) { sh = plain.sh; sym = mine(); }
      }
    }
    if (!info.how && snapped.on && snapped.on !== 'label') {
      // bring the nearest pin onto the point
      let best = null, bd = Infinity;
      for (const pin of pins()) { const dd = Math.hypot(pin.pos[0] - p[0], pin.pos[1] - p[1]); if (dd < bd) { bd = dd; best = pin; } }
      if (best && bd > 1e-6) { r = E.moveItems(sh, [{ type: 'symbol', sym }], [p[0] - best.pos[0], p[1] - best.pos[1]], { keepWires: false }); sh = E.reparse(sh, r); sym = mine(); }
      if (best) info.how = 'tap';
    }
    // any pin now sitting inside a wire joins it
    const cuts = pins().map((x) => x.pos).filter((q) => sh.wires.some((w) => insideWire(q, w)));
    if (cuts.length) { r = E.connectAt(sh, cuts); sh = E.reparse(sh, r); sym = mine(); if (!info.how) info.how = 'tap'; }
    info.uuid = sym.uuid;
    return Object.assign({ path: sh0.path, text: sh.text }, info);
  }

  // ---- stencils
  const U = 2.54;
  const arm = (dx, dy) => [[0, 0], [dx * U, dy * U]];
  const WIRE_STENCILS = [
    { id: 'w-tool', kind: 'tool', name: 'Draw wire', desc: 'Free wire: tap each corner', icon: 'i-wire', run: () => setMode('wire') },
    { id: 'w-h', kind: 'wire', name: 'Straight →', desc: 'Wire, horizontal, from the tap to the right', segs: [[[0, 0], [4 * U, 0]]] },
    { id: 'w-v', kind: 'wire', name: 'Straight ↓', desc: 'Wire, vertical, from the tap down', segs: [[[0, 0], [0, 4 * U]]] },
    { id: 'w-rd', kind: 'wire', name: 'Corner ┌', desc: 'Right angle: right and down', segs: [arm(3, 0), arm(0, 3)] },
    { id: 'w-ld', kind: 'wire', name: 'Corner ┐', desc: 'Right angle: left and down', segs: [arm(-3, 0), arm(0, 3)] },
    { id: 'w-ru', kind: 'wire', name: 'Corner └', desc: 'Right angle: right and up', segs: [arm(3, 0), arm(0, -3)] },
    { id: 'w-lu', kind: 'wire', name: 'Corner ┘', desc: 'Right angle: left and up', segs: [arm(-3, 0), arm(0, -3)] },
    { id: 'w-td', kind: 'wire', name: 'Tee ┬', desc: 'T junction, branch down. Drop it on a wire to branch off it.', segs: [arm(-3, 0), arm(3, 0), arm(0, 3)] },
    { id: 'w-tu', kind: 'wire', name: 'Tee ┴', desc: 'T junction, branch up', segs: [arm(-3, 0), arm(3, 0), arm(0, -3)] },
    { id: 'w-tr', kind: 'wire', name: 'Tee ├', desc: 'T junction, branch right', segs: [arm(0, -3), arm(0, 3), arm(3, 0)] },
    { id: 'w-tl', kind: 'wire', name: 'Tee ┤', desc: 'T junction, branch left', segs: [arm(0, -3), arm(0, 3), arm(-3, 0)] },
    { id: 'w-x', kind: 'wire', name: 'Cross ┼', desc: 'Four-way junction (connected)', segs: [arm(-3, 0), arm(3, 0), arm(0, -3), arm(0, 3)] },
    { id: 'w-jump', kind: 'wire', name: 'Crossover', desc: 'Two wires crossing without connecting', segs: [[[-3 * U, 0], [3 * U, 0]], [[0, -3 * U], [0, 3 * U]]], jump: true },
    { id: 'w-j', kind: 'junction', name: 'Junction', desc: 'Junction dot: joins wires that cross here', icon: 'i-junction' },
    { id: 'w-nc', kind: 'nc', name: 'No-connect', desc: 'Marks a pin as deliberately unused', icon: 'i-nc' }
  ];
  const LABEL_STENCILS = [
    { id: 'l-net', kind: 'label', label: 'local', name: 'Net label', desc: 'Names a net on this sheet', icon: 'i-tag' },
    { id: 'l-glob', kind: 'label', label: 'global', name: 'Off-sheet', desc: 'Off-sheet connector (KiCad global label): joins the net across sheets', icon: 'i-glabel' },
    { id: 'l-hier', kind: 'label', label: 'hier', name: 'Sheet port', desc: 'Hierarchical label: a pin on the parent sheet', icon: 'i-hlabel' },
    { id: 'l-cable', kind: 'cable', name: 'Cable tag', desc: 'Cable type, product code, core colour and length on a wire', icon: 'i-cable' },
    { id: 'l-text', kind: 'text', name: 'Text', desc: 'A note on the drawing', icon: 'i-text' }
  ];
  const PART_GROUPS = [
    { id: 'power', title: 'Power', parts: ['power:+24V', 'power:+12V', 'power:+5V', 'power:GND', 'power:GNDPWR', 'power:Earth', 'power:+BATT', 'power:PWR_FLAG'] },
    { id: 'protect', title: 'Fuses & protection', parts: ['Device:Fuse', 'Device:Fuse_Small', 'Device:Polyfuse', 'Device:CircuitBreaker_1P', 'Device:CircuitBreaker_2P', 'Device:D_TVS', 'Device:Varistor', 'Device:D'] },
    { id: 'switch', title: 'Switches', parts: ['Switch:SW_Push', 'Switch:SW_Push_Open', 'Switch:SW_SPST', 'Switch:SW_SPDT', 'Switch:SW_Push_LED', 'Switch:SW_Push_DPDT', 'Switch:SW_Reed', 'Switch:SW_DIP_x01'] },
    { id: 'relay', title: 'Relays', parts: ['Relay:Relay_SPDT', 'Relay:Relay_DPDT', 'Relay:G5LE-1', 'Relay:FINDER-40.31', 'Relay:Relay_SPDT_Latching_1coil'] },
    { id: 'loads', title: 'Loads & indicators', parts: ['Device:LED', 'Device:Lamp', 'Device:Buzzer', 'Device:Heater', 'Device:Speaker', 'Motor:Motor_DC', 'Motor:Fan', 'Device:Battery'] },
    { id: 'conn', title: 'Connectors', parts: ['Connector_Generic:Conn_01x02', 'Connector_Generic:Conn_01x03', 'Connector_Generic:Conn_01x04', 'Connector_Generic:Conn_01x06', 'Connector_Generic:Conn_01x08', 'Connector:Screw_Terminal_01x02', 'Connector:Screw_Terminal_01x04', 'Connector:Conn_Coaxial', 'Connector:RJ45'] },
    { id: 'mine', title: 'My parts', lib: 'My_Parts' },
    { id: 'ourconn', title: 'Our connectors (Deutsch, ASC, M8/M12)', lib: 'Loomline_Connectors' },
    { id: 'passive', title: 'Passives', parts: ['Device:R', 'Device:C', 'Device:C_Polarized', 'Device:L', 'Device:D_Schottky', 'Device:Thermistor_NTC', 'Device:Antenna'] },
    { id: 'beckhoff', title: 'Beckhoff I/O', lib: 'Loomline_Beckhoff' },
    { id: 'hyd', title: 'Hydraulic valves', lib: 'Loomline_Hydraulics' }
  ];
  const stKey = (st) => st.kind === 'part' ? 'p:' + st.lib + ':' + st.name : 's:' + st.id;
  function stencilById(id) { return WIRE_STENCILS.concat(LABEL_STENCILS).find((x) => x.id === id); }
  function rememberStencil(st) {
    const k = stKey(st);
    const rec = (Store.pref('recentStencils') || []).filter((x) => x !== k);
    rec.unshift(k); Store.pref('recentStencils', rec.slice(0, 12));
    if (st.kind === 'part') { const rp = Store.pref('recentParts') || []; Store.pref('recentParts', [st.lib + ':' + st.name].concat(rp.filter((x) => x !== st.lib + ':' + st.name)).slice(0, 20)); }
  }
  function stencilFromKey(k) {
    if (k.startsWith('s:')) return stencilById(k.slice(2));
    const rest = k.slice(2), i = rest.indexOf(':');
    return i > 0 ? { kind: 'part', lib: rest.slice(0, i), name: rest.slice(i + 1) } : null;
  }
  // Stencil icon for wiring shapes, drawn from its own segments
  function wireIcon(st) {
    const pts = st.segs.flat();
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const sc = 16 / Math.max(x1 - x0, y1 - y0, 1e-6);
    const ox = 12 - (x0 + x1) / 2 * sc, oy = 12 - (y0 + y1) / 2 * sc;
    const T = (p) => [(p[0] * sc + ox).toFixed(1), (p[1] * sc + oy).toFixed(1)];
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'wire-ico');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', st.segs.map(([a, b]) => 'M' + T(a).join(' ') + 'L' + T(b).join(' ')).join(''));
    path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '2'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('fill', 'none');
    svg.append(path);
    if (st.segs.length >= 3) { const c = document.createElementNS(ns, 'circle'); const q = T([0, 0]); c.setAttribute('cx', q[0]); c.setAttribute('cy', q[1]); c.setAttribute('r', '2.4'); c.setAttribute('fill', 'currentColor'); svg.append(c); }
    if (st.jump) path.setAttribute('d', 'M3 12h5.5a3.5 3.5 0 0 1 7 0H21M12 3v18');   // drawn with a hop, as on paper
    const dot = document.createElementNS(ns, 'circle'); const a = T([0, 0]); dot.setAttribute('cx', a[0]); dot.setAttribute('cy', a[1]); dot.setAttribute('r', '1.2'); dot.setAttribute('fill', '#e2531a'); if (!st.jump && st.segs.length < 3) svg.append(dot);
    return svg;
  }
  // Part thumbnails: drawn once into a hidden canvas and kept as images
  var thumbCache = new Map();   // var: applyTheme may run before this line
  let thumbView = null, thumbBusy = Promise.resolve();
  function thumbFor(st) {
    const key = (view.dark ? 'd' : 'l') + stKey(st);
    if (thumbCache.has(key)) return Promise.resolve(thumbCache.get(key));
    thumbBusy = thumbBusy.then(async () => {
      if (thumbCache.has(key)) return thumbCache.get(key);
      const entry = await libEntry(st.lib, st.name);
      const { scene } = previewScene(entry);
      if (!thumbView) {
        const c = h('canvas', { style: 'position:fixed;left:-2000px;top:0;width:150px;height:100px;pointer-events:none', 'aria-hidden': 'true' });
        document.body.append(c);
        thumbView = new R.SchematicView(c, {});
      }
      thumbView.setTheme(view.dark); thumbView.showGrid = false;
      thumbView.setScene(scene, true);
      thumbView.resize();
      const sy = scene.syms[0];
      thumbView.fit(sy ? sy.bb : scene.page, 6);
      thumbView._drawNow();
      const url = thumbView.canvas.toDataURL('image/png');
      thumbCache.set(key, url);
      return url;
    }).catch(() => null);
    return thumbBusy;
  }
  let thumbObserver = null;
  function observeThumb(el, st) {
    if (!thumbObserver) thumbObserver = new IntersectionObserver((es) => {
      for (const e of es) {
        if (!e.isIntersecting) continue;
        thumbObserver.unobserve(e.target);
        const t = e.target, s = t._st;
        thumbFor(s).then((url) => { if (url) { const img = h('img', { src: url, alt: '' }); t.querySelector('.th').replaceChildren(img); } });
      }
    }, { root: $('dockBody'), rootMargin: '120px' });
    el._st = st;
    thumbObserver.observe(el);
  }
  // ---- the dock
  let dockOpen = false;
  const dockSections = new Set(Store.pref('dockSections') || ['recent', 'wires', 'labels', 'power']);
  const wideDock = () => window.matchMedia('(min-width: 761px)').matches;
  function setDock(open) {
    dockOpen = open;
    $('dock').hidden = !open;
    $('railDock').setAttribute('aria-pressed', String(open));
    if (open) { if (!wideDock() && state.panelOpen) setPanel(false); renderDock(); }
    Store.pref('dockOpen', open && wideDock());
    requestAnimationFrame(() => view.resize());
    renderRibbon();
  }
  $('railDock').addEventListener('click', () => setDock(!dockOpen));
  $('dockClose').addEventListener('click', () => setDock(false));
  $('dockSearch').addEventListener('input', () => renderDock());
  function tileFor(st) {
    const label = st.kind === 'part' ? st.name.replace(/^(SW|Conn|Relay)_/, '').replace(/_/g, ' ') : st.name;
    const th = h('span', { class: 'th' });
    if (st.kind === 'wire') th.append(wireIcon(st));
    else if (st.kind === 'part') th.append(h('span', { class: 'spinner', style: 'width:16px;height:16px;border-width:2px' }));
    else th.append(icon(st.icon));
    const armed = state.mode === 'draw' && state.draw && ((state.draw.tool === 'stencil' && state.draw.stencil && stKey(state.draw.stencil) === stKey(st)) || (state.draw.tool === 'part' && state.draw.part && st.kind === 'part' && state.draw.part.lib === st.lib && state.draw.part.name === st.name));
    const el = h('button', { class: 'tile', type: 'button', title: (st.kind === 'part' ? st.lib + ':' + st.name : st.name) + (st.desc ? '\n' + st.desc : ''), 'aria-pressed': String(!!armed), 'data-k': stKey(st) }, th, h('span', { class: 'tn', text: label }));
    if (st.kind === 'part') observeThumb(el, st);
    bindTile(el, st);
    return el;
  }
  function sectionEl(id, title, tiles, extra) {
    const open = dockSections.has(id) || !!$('dockSearch').value.trim();
    const head = h('button', { class: 'sg-head', type: 'button', 'aria-expanded': String(open) }, icon('i-chev'), h('span', { text: title }), h('span', { class: 'n', text: String(tiles.length) }));
    const grid = h('div', { class: 'sg-grid', hidden: !open });
    head.addEventListener('click', () => {
      const o = head.getAttribute('aria-expanded') !== 'true';
      head.setAttribute('aria-expanded', String(o)); grid.hidden = !o;
      if (o) dockSections.add(id); else dockSections.delete(id);
      Store.pref('dockSections', Array.from(dockSections));
      if (o && !grid.childNodes.length) fill();
    });
    const fill = () => { grid.replaceChildren(...tiles.map(tileFor)); if (extra) grid.append(extra); };
    if (open) fill();
    return h('section', { class: 'sg' }, head, grid);
  }
  async function renderDock() {
    if (!dockOpen) return;
    const body = $('dockBody'), q = $('dockSearch').value.trim().toLowerCase();
    const top = body.scrollTop;
    const match = (st) => !q || q.split(/\s+/).every((t) => (st.name + ' ' + (st.desc || '') + ' ' + (st.lib || '')).toLowerCase().includes(t));
    const out = [];
    const rec = (Store.pref('recentStencils') || []).map(stencilFromKey).filter(Boolean).filter(match);
    if (rec.length && !q) out.push(sectionEl('recent', 'Recently used', rec));
    const ws = WIRE_STENCILS.filter(match), ls = LABEL_STENCILS.filter(match);
    if (ws.length) out.push(sectionEl('wires', 'Wires & junctions', ws));
    if (ls.length) out.push(sectionEl('labels', 'Labels & connectors', ls));
    let idx = libState.index;
    if (!idx) { try { idx = await loadLibIndex(); } catch (e) { idx = null; } }
    for (const g of PART_GROUPS) {
      let list;
      if (g.lib) list = idx ? idx.rows.filter((r) => idx.libs[r[0]].name === g.lib).map((r) => ({ kind: 'part', lib: g.lib, name: r[1], desc: r[2] })) : [];
      else list = g.parts.map((k) => { const i = k.indexOf(':'); const row = idx && idx.rows.find((r) => r[1] === k.slice(i + 1) && idx.libs[r[0]].name === k.slice(0, i)); return { kind: 'part', lib: k.slice(0, i), name: k.slice(i + 1), desc: row ? row[2] : '' }; });
      list = list.filter(match);
      if (list.length) out.push(sectionEl(g.id, g.title, list));
    }
    if (q && idx) {
      const terms = q.split(/\s+/);
      const hits = [];
      for (let i = 0; i < idx.rows.length && hits.length < 48; i++) if (terms.every((t) => idx.hay[i].includes(t))) { const r = idx.rows[i]; hits.push({ kind: 'part', lib: idx.libs[r[0]].name, name: r[1], desc: r[2] }); }
      if (hits.length) out.push(sectionEl('lib', 'In the part library', hits));
    }
    const more = h('button', { class: 'btn small sg-more', type: 'button', onclick: () => openPartPicker() }, icon('i-part'), 'ALL 10,000 PARTS…');
    out.push(h('div', { class: 'sg-grid' }, more));
    if (!out.length) out.push(h('p', { class: 'empty', style: 'padding:12px', text: 'No stencils match.' }));
    body.replaceChildren(...out);
    body.scrollTop = top;
  }
  function markArmed(st) {
    for (const t of document.querySelectorAll('.tile[aria-pressed="true"]')) t.setAttribute('aria-pressed', 'false');
    if (st) for (const t of document.querySelectorAll(`.tile[data-k="${CSS.escape(stKey(st))}"]`)) t.setAttribute('aria-pressed', 'true');
  }
  // Tap a tile: it's armed, and every tap on the drawing places one. Drag a tile: it drops where you let go.
  async function armStencil(st) {
    if (!state.project) { toast('Open a project first.'); return; }
    if (st.kind === 'tool') { st.run(); return; }
    if (state.sel) { state.sel = null; applyHighlight(); }
    if (st.kind === 'part') {
      try {
        const entry = await libEntry(st.lib, st.name);
        state.draw = { tool: 'part', pts: [], part: entry };
      } catch (e) { banner('err', e.message); return; }
    } else state.draw = { tool: 'stencil', pts: [], stencil: st };
    setMode('draw');
    markArmed(st);
    if (!wideDock()) setDock(false);
    renderStatus();
  }
  async function dropStencil(st, wp) {
    if (!state.project) return;
    if (st.kind === 'tool') { st.run(); return; }
    if (st.kind === 'part') {
      try { const entry = await libEntry(st.lib, st.name); placePart(entry, wp, 'touch'); } catch (e) { banner('err', e.message); }
      return;
    }
    placeStencil(st, wp, 'touch');
  }
  function placeStencil(st, wp, type) {
    const sh = state.inst.sheet, s = snapPoint(wp, type), p = s.p;
    rememberStencil(st);
    if (st.kind === 'wire') {
      let segs = st.segs.map(([a, b]) => [[p[0] + a[0], p[1] + a[1]], [p[0] + b[0], p[1] + b[1]]]);
      // arms lying along an existing wire are already there (a tee dropped on a wire adds only its branch)
      segs = segs.filter(([a, b]) => !sh.wires.some((w) => K.onSegment(a, w.a, w.b) && K.onSegment(b, w.a, w.b)));
      if (!segs.length) { toast('That is already wired.'); return; }
      run('Add ' + st.name.toLowerCase(), () => E.addWireSegs(sh, segs), { anchor: null, checkMerges: true });
    } else if (st.kind === 'junction') {
      run('Add junction', () => E.addJunction(sh, p), { anchor: null });
    } else if (st.kind === 'nc') {
      if (s.on !== 'pin') { toast('Tap the end of an unused pin.'); return; }
      run('No-connect flag', () => E.addNoConnect(sh, p), { anchor: null });
    } else if (st.kind === 'label') {
      if (!s.on || s.on === 'label') { toast('Drop a label on a wire, wire end or pin.'); return; }
      view.overlay = { pts: [], dots: [p], ring: p }; view.redraw();
      let spin = 'right';
      const w = sh.wires.find((x) => E.same(x.a, p) || E.same(x.b, p));
      if (w) { const o = E.same(w.a, p) ? w.b : w.a; if (Math.abs(o[1] - p[1]) < 1e-6) spin = o[0] > p[0] ? 'left' : 'right'; else spin = o[1] > p[1] ? 'up' : 'bottom'; }
      labelDialog({ p, spin, kind: st.label });
    } else if (st.kind === 'cable') {
      const hit = view.hitTest(p, 6);
      const it = hit && hit.type === 'net' ? itemFromTag(hit.it) : null;
      if (!it || it.type !== 'wire') { toast('Drop the cable tag on a wire.'); return; }
      const net = state.project.nets[state.inst.netOf[hit.g]];
      selectNet(net, it);
      cableDialog(state.sel);
    } else if (st.kind === 'text') {
      textDialog({ p: gridSnap(wp) });
    }
  }
  // Mouse hover while a wiring stencil is armed: show where it would go
  function hoverPreview(wp) {
    if (state.project && state.mode === 'draw' && state.draw && state.draw.tool === 'entry') {
      const p = gridSnap(wp), e = ENTRY_DIRS[state.draw.dir || 0], on = state.inst.sheet.buses.some((b) => K.onSegment(p, b.a, b.b));
      view.overlay = { pts: [], dots: [], segs: [[p, [p[0] + e[0], p[1] + e[1]]]], ring: on ? p : null }; view.redraw(); return;
    }
    if (!state.project || state.mode !== 'draw' || !state.draw || state.draw.tool !== 'stencil' || !state.draw.stencil) return;
    const st = state.draw.stencil, s = snapPoint(wp, 'mouse');
    view.overlay = { pts: [], dots: [], segs: st.kind === 'wire' ? st.segs.map(([a, b]) => [[s.p[0] + a[0], s.p[1] + a[1]], [s.p[0] + b[0], s.p[1] + b[1]]]) : [], ring: s.on ? s.p : null };
    view.redraw();
  }
  // Drag from the dock: a horizontal move or a long press picks the tile up
  function bindTile(el, st) {
    let start = null, dragging = false, ghost = null, lp = 0, pid = null;
    const overCanvas = (x, y) => { const c = $('canvas').getBoundingClientRect(); const top = document.elementFromPoint(x, y); return x >= c.left && x <= c.right && y >= c.top && y <= c.bottom && (!top || top === $('canvas') || !$('dock').contains(top)) ? [x - c.left, y - c.top] : null; };
    const begin = (e) => {
      dragging = true;
      try { el.setPointerCapture(pid); } catch (err) { /* ignore */ }
      ghost = h('div', { class: 'drag-ghost' }, el.querySelector('.th').firstElementChild ? el.querySelector('.th').firstElementChild.cloneNode(true) : '', h('span', { text: st.name.slice(0, 14) }));
      document.body.append(ghost);
      move(e);
      if (navigator.vibrate) try { navigator.vibrate(12); } catch (err) { /* ignore */ }
    };
    const move = (e) => {
      ghost.style.left = e.clientX + 'px'; ghost.style.top = e.clientY + 'px';
      const c = overCanvas(e.clientX, e.clientY);
      if (c && st.kind !== 'tool') {
        const wp = view.toWorld(c[0], c[1]), s = snapPoint(wp, 'touch');
        view.overlay = { pts: [], dots: [], segs: st.kind === 'wire' ? st.segs.map(([a, b]) => [[s.p[0] + a[0], s.p[1] + a[1]], [s.p[0] + b[0], s.p[1] + b[1]]]) : [], ring: s.p };
      } else view.overlay = null;
      view.redraw();
    };
    const finish = (e, cancel) => {
      clearTimeout(lp);
      if (dragging) {
        const c = !cancel && overCanvas(e.clientX, e.clientY);
        if (ghost) ghost.remove(); ghost = null;
        view.overlay = state.mode === 'draw' ? { pts: [], dots: [] } : null; view.redraw();
        if (c) dropStencil(st, view.toWorld(c[0], c[1]));
        el._justDragged = true; setTimeout(() => { el._justDragged = false; }, 50);
      }
      dragging = false; start = null;
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.button) return;
      start = [e.clientX, e.clientY]; pid = e.pointerId; dragging = false;
      clearTimeout(lp);
      lp = setTimeout(() => { if (start && !dragging) begin(e); }, 420);
    });
    el.addEventListener('pointermove', (e) => {
      if (!start) return;
      if (dragging) { move(e); return; }
      const dx = e.clientX - start[0], dy = e.clientY - start[1];
      if (Math.hypot(dx, dy) > 10) { clearTimeout(lp); if (Math.abs(dx) > Math.abs(dy) * 1.2 || e.pointerType === 'mouse') begin(e); else start = null; }
    });
    el.addEventListener('pointerup', (e) => finish(e, false));
    el.addEventListener('pointercancel', (e) => finish(e, true));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    // Once a tile is picked up, a finger moving up or down drags it instead of scrolling the dock.
    el.addEventListener('touchmove', (e) => { if (dragging) e.preventDefault(); }, { passive: false });
    el.addEventListener('click', () => { if (!el._justDragged) armStencil(st); });
  }

  // ---- properties follow the selection on wide screens
  let propsFollowPref = Store.pref('propsFollow');
  const propsFollow = () => (propsFollowPref === undefined || propsFollowPref === null ? window.innerWidth >= 1100 : !!propsFollowPref) && wideLayout();

  // ---- the ribbon
  const RTABS = [['home', 'Home'], ['insert', 'Insert'], ['wire', 'Wire'], ['draw', 'Draw'], ['analyse', 'Analyse'], ['build', 'Build'], ['view', 'View']];
  state.rtab = Store.pref('rtab') || 'home';
  // On a phone held sideways there's little height, so the tools start folded (tap a tab to open them).
  var ribbonOpen = Store.pref('ribbonOpen') === undefined || Store.pref('ribbonOpen') === null ? window.innerHeight > 480 : Store.pref('ribbonOpen') !== false;
  function setRibbonTab(t, open) {
    state.rtab = t; Store.pref('rtab', t);
    if (open && !ribbonOpen) { ribbonOpen = true; Store.pref('ribbonOpen', true); }
    renderRibbon();
  }
  const selAct = (label) => selectionActions().find((a) => a.label === label);
  function drawToolBtn(k, label, ic) {
    return { label, icon: ic, on: state.mode === 'draw' && state.draw && state.draw.tool === k, run: () => { if (!state.project) return; if (state.sel) { state.sel = null; applyHighlight(); } state.draw = Object.assign({}, state.draw || {}, { tool: k, pts: [] }); if (state.mode !== 'draw') setMode('draw'); else setDrawTool(k); setRibbonTab('draw'); } };
  }
  function stencilBtn(id, label) {
    const st = stencilById(id);
    return { label: label || st.name, icon: st.icon || 'i-tee', svg: st.kind === 'wire' ? wireIcon(st) : null, on: state.mode === 'draw' && state.draw && state.draw.tool === 'stencil' && state.draw.stencil && state.draw.stencil.id === id, run: () => armStencil(st) };
  }
  function ribbonGroups(tab) {
    const P = !!state.project, s = state.sel;
    let SA = null;   // the selection's actions, worked out once per ribbon render
    const act = (lbl, label, ic) => { if (!SA) SA = P && state.sel ? selectionActions() : []; const a = SA.find((x) => x.label === lbl); return { label, icon: ic, disabled: !a, danger: lbl === 'DELETE', run: () => { const x = selAct(lbl); if (x) x.run(); } }; };
    const show2 = (k, label, ic) => ({ label, icon: ic, on: !!show[k], run: () => setShow(k, !show[k]) });
    if (tab === 'home') return [
      { title: 'Select', tools: [
        { label: 'Select', icon: 'i-hand', on: state.mode === 'select' || state.mode === 'move', run: () => setMode('select') },
        { label: 'Box select', icon: 'i-box', on: state.mode === 'box', run: startBox },
        { label: 'Select all', icon: 'i-selall', disabled: !P, run: () => { if (state.mode !== 'box') setMode('box'); selectAll(); } }] },
      { title: 'Clipboard', tools: [
        { label: 'Copy', icon: 'i-copy2', disabled: !P || !canCopy(), run: copySel },
        { label: 'Paste', icon: 'i-paste', disabled: !P || !state.clip, on: state.mode === 'paste', run: startPaste },
        { label: 'Duplicate', icon: 'i-dup', disabled: !P || !canCopy(), run: duplicateSel },
        act('DELETE', 'Delete', 'i-trash')] },
      { title: 'Arrange', tools: [act('MOVE', 'Move', 'i-move'), act('ROTATE', 'Rotate', 'i-rotate'), act('MIRROR ↔', 'Mirror ↔', 'i-mirror'), act('MIRROR ↕', 'Mirror ↕', 'i-mirror'), act('EDIT', 'Edit', 'i-edit')] },
      { title: 'Navigate', tools: [
        { label: 'Find', icon: 'i-search', disabled: !P, run: openSearch },
        { label: 'Fit', icon: 'i-fit', disabled: !P, run: () => view.fit() },
        { label: 'Zoom to', icon: 'i-target', disabled: !s, run: zoomToSelection },
        { label: 'Back sheet', icon: 'i-back', disabled: !navLive(state.navBack), run: () => navGo(state.navBack, state.navFwd) },
        { label: 'Forward sheet', icon: 'i-next', disabled: !navLive(state.navFwd), run: () => navGo(state.navFwd, state.navBack) },
        { label: 'Up a sheet', icon: 'i-up', disabled: !(state.inst && state.inst.parent), run: () => state.inst.parent && showInstance(state.inst.parent) }] }
    ];
    if (tab === 'insert') return [
      { title: 'Library', tools: [
        { label: 'Stencils', icon: 'i-stencil', on: dockOpen, run: () => setDock(!dockOpen) },
        { label: 'Add part', icon: 'i-part', disabled: !P, run: openPartPicker }] },
      { title: 'Hierarchy', tools: [{ label: 'New sheet', icon: 'i-hier', disabled: !P, on: state.mode === 'draw' && state.draw && state.draw.tool === 'sheet', run: startSheetTool }] },
      { title: 'Make', tools: [{ label: 'My parts', icon: 'i-chip', disabled: !P, run: (e) => myPartsMenu(e.currentTarget) }, { label: 'Blocks', icon: 'i-box', disabled: !P, run: (e) => blocksMenu(e.currentTarget) }] },
      { title: 'Connect', tools: [stencilBtn('l-net'), stencilBtn('l-glob'), stencilBtn('l-hier'),
        { label: 'Power', icon: 'i-power', disabled: !P, run: (e) => openMenu(e.currentTarget, PART_GROUPS[0].parts.map((k) => { const n = k.split(':')[1]; return { label: n, icon: 'i-power', run: () => armStencil({ kind: 'part', lib: 'power', name: n }) }; })) }] },
      { title: 'Annotate', tools: [stencilBtn('l-text'), stencilBtn('l-cable', 'Cable tag')] }
    ];
    if (tab === 'wire') return [
      { title: 'Wire', tools: [
        { label: 'Draw wire', icon: 'i-wire', on: state.mode === 'wire', run: () => { if (!P) return; if (state.sel) { state.sel = null; applyHighlight(); } setMode('wire'); } },
        stencilBtn('w-h', 'Straight →'), stencilBtn('w-v', 'Straight ↓'),
        { label: 'Draw bus', icon: 'i-wire', on: state.mode === 'wire' && state.wireKind === 'bus', run: startBus }, { label: 'Bus entry', icon: 'i-tee', on: state.mode === 'draw' && state.draw && state.draw.tool === 'entry', run: startEntry },
        { label: ({ 90: 'Angle 90°', 45: 'Angle 45°', free: 'Any angle' })[state.wirePosture] || 'Angle 90°', icon: 'i-line', run: () => { cyclePosture(); renderRibbon(); } }] },
      { title: 'Connections', tools: [stencilBtn('w-rd', 'Corner'), stencilBtn('w-td', 'Tee'), stencilBtn('w-x', 'Cross'), stencilBtn('w-jump', 'Crossover'), stencilBtn('w-j'), stencilBtn('w-nc')] },
      { title: 'More', tools: [{ label: 'All shapes', icon: 'i-stencil', on: dockOpen, run: () => { dockSections.add('wires'); Store.pref('dockSections', Array.from(dockSections)); setDock(true); } }, stencilBtn('l-cable', 'Cable tag')] }
    ];
    if (tab === 'draw') return [
      { title: 'Shapes', tools: [drawToolBtn('line', 'Line', 'i-line'), drawToolBtn('rect', 'Rectangle', 'i-rect'), drawToolBtn('circle', 'Circle', 'i-circle'), drawToolBtn('arc', 'Arc', 'i-arc')] },
      { title: 'Text', tools: [drawToolBtn('text', 'Text', 'i-text')] },
      { title: 'Style', tools: [{ label: 'Line style', icon: 'i-style', disabled: !P, run: () => { const g = state.sel && state.sel.type === 'graphic' && state.sel.it[0] === 'G' ? graphicObj(state.sel.it) : null; styleDialog(g); } }] }
    ];
    if (tab === 'analyse') {
      const tabBtn = (t, label, ic) => ({ label, icon: ic, disabled: !P, on: state.panelOpen && state.tab === t, run: () => { if (state.panelOpen && state.tab === t) setPanel(false); else showTab(t, true); } });
      return [
        { title: 'Browse', tools: [tabBtn('sheets', 'Sheets', 'i-hier'), tabBtn('nets', 'Nets', 'i-net'), tabBtn('parts', 'Parts', 'i-chip'), tabBtn('info', 'Properties', 'i-props')] },
        { title: 'Tools', tools: [{ label: 'Annotate', icon: 'i-number', disabled: !P, run: annotateDialog }, { label: 'Find & replace', icon: 'i-search', disabled: !P, run: replaceDialog },
          { label: 'Fields table', icon: 'i-report', disabled: !P, run: fieldsTable },
          { label: 'Measure', icon: 'i-line', disabled: !P, on: state.mode === 'measure', run: () => state.mode === 'measure' ? setMode('select') : startMeasure() },
          { label: 'Swap', icon: 'i-sync', disabled: !(s && s.type === 'multi'), run: swapSel }, { label: 'Autoplace', icon: 'i-text', disabled: !(s && s.type === 'symbol'), run: autoplaceSel },
          { label: 'Snap ' + E.snapGrid() + ' mm', icon: 'i-more', disabled: !P, run: () => { const i = GRIDS.indexOf(E.snapGrid()); stepGrid(i === GRIDS.length - 1 ? -i : 1); renderRibbon(); } }] },
        { title: 'Check & report', tools: [tabBtn('check', 'Design check', 'i-alert'), tabBtn('reports', 'Reports', 'i-report'), tabBtn('install', 'Install log', 'i-install'), tabBtn('compare', 'Compare', 'i-compare')] },
        { title: 'Output', tools: [{ label: 'Print / PDF', icon: 'i-print', disabled: !P, run: printDialog }] }
      ];
    }
    if (tab === 'build') {
      const B = P ? harness() : null, n = B ? B.looms.length : 0, ch = B ? chosenLooms(B) : [];
      const mk = (what, label, ic) => ({ label, icon: ic, disabled: !n, run: () => openBuild(what) });
      return [
        { title: 'Looms', tools: [
          { label: 'Looms', icon: 'i-cable', disabled: !P, on: state.panelOpen && state.tab === 'build', run: () => { if (state.panelOpen && state.tab === 'build') setPanel(false); else showTab('build', true); } },
          act('LOOM', 'Set loom', 'i-tag'), act('CABLE', 'Cable', 'i-cable')] },
        { title: n ? `Make · ${ch.length === n ? 'all ' + n + ' looms' : ch.map((L) => L.name).join(', ')}` : 'Make', tools: [
          mk(BUILD_ALL, 'Build pack', 'i-print'), mk({ drawing: true }, 'Drawing', 'i-draw'), mk({ parts: true }, 'Parts', 'i-chip'),
          mk({ cut: true }, 'Cut list', 'i-line'), mk({ wires: true }, 'Wire list', 'i-wire'), mk({ pinouts: true }, 'Pin-outs', 'i-number')] }
      ];
    }
    if (tab === 'view') return [
      { title: 'On the drawing', tools: [show2('wireNos', 'Wire nos.', 'i-number'), show2('xrefs', 'Cross-refs', 'i-link'), show2('markers', 'Check marks', 'i-alert'), show2('install', 'Install', 'i-install'),
        { label: 'Grid', icon: 'i-more', on: view.showGrid, run: () => { view.showGrid = !view.showGrid; Store.pref('grid', view.showGrid); view.redraw(); renderScale(); renderRibbon(); } }] },
      { title: 'Tracing', tools: [
        { label: 'In steps', icon: 'i-steps', on: traceStep, run: () => { setTraceStep(!traceStep); renderRibbon(); } },
        { label: 'Stop at conn.', icon: 'i-steps', on: traceBy === 'conn', run: () => { traceBy = traceBy === 'conn' ? 'section' : 'conn'; Store.pref('traceBy', traceBy); renderRibbon(); } },
        { label: 'Dim others', icon: 'i-dim', on: view.dimOthers, run: () => { view.dimOthers = !view.dimOthers; Store.pref('dim', view.dimOthers); view.redraw(); renderRibbon(); } }] },
      { title: 'Screen', tools: [
        { label: 'Properties', icon: 'i-props', on: propsFollow(), run: () => { propsFollowPref = !propsFollow(); Store.pref('propsFollow', propsFollowPref); toast(propsFollowPref ? 'The properties panel opens when you select a part.' : 'The properties panel stays closed until you open it.'); renderRibbon(); } },
        { label: immersive.on ? 'Exit full' : 'Full screen', icon: immersive.on ? 'i-shrink' : 'i-expand', run: () => { setImmersive(!immersive.on); renderRibbon(); } },
        { label: 'Tool labels', icon: 'i-text', on: !document.body.classList.contains('rb-icons'), run: () => { const on = document.body.classList.toggle('rb-icons'); Store.pref('rbIcons', on); renderRibbon(); requestAnimationFrame(() => view.resize()); } },
        { label: 'Keys', icon: 'i-info', run: showHotkeys },
        { label: 'Theme', icon: 'i-theme', run: () => { const order = ['auto', 'light', 'dark']; const t = order[(order.indexOf(Store.pref('theme') || 'auto') + 1) % 3]; Store.pref('theme', t); applyTheme(); toast('Theme: ' + t); renderRibbon(); } }] }
    ];
    return [];
  }
  function renderRibbon() {
    const rb = $('ribbon'); if (!rb) return;
    rb.classList.toggle('collapsed', !ribbonOpen);
    const tabs = $('rbTabs');
    tabs.replaceChildren(...RTABS.map(([k, l]) => h('button', { class: 'rb-tab', role: 'tab', 'aria-selected': String(state.rtab === k), onclick: () => {
      if (state.rtab === k) { ribbonOpen = !ribbonOpen; Store.pref('ribbonOpen', ribbonOpen); renderRibbon(); renderDrawBar(); requestAnimationFrame(() => view.resize()); return; }
      setRibbonTab(k, true); requestAnimationFrame(() => view.resize());
    } }, l)), h('span', { class: 'rb-spacer' }),
    h('button', { class: 'rb-toggle', 'aria-label': ribbonOpen ? 'Hide the tools' : 'Show the tools', title: ribbonOpen ? 'Hide the tools' : 'Show the tools', onclick: () => { ribbonOpen = !ribbonOpen; Store.pref('ribbonOpen', ribbonOpen); renderRibbon(); renderDrawBar(); requestAnimationFrame(() => view.resize()); } }, icon('i-chev')));
    if (!ribbonOpen) { $('rbTools').replaceChildren(); return; }
    const sc = $('rbTools').scrollLeft;
    $('rbTools').replaceChildren(...ribbonGroups(state.rtab).map((g) => h('div', { class: 'rg', role: 'group', 'aria-label': g.title },
      h('div', { class: 'rg-tools' }, ...g.tools.map((t) => h('button', { class: 'rt' + (t.danger ? ' danger' : ''), type: 'button', disabled: !!t.disabled, 'aria-pressed': t.on === undefined ? null : String(!!t.on), title: t.label + (RB_KEYS[t.label] ? '  (' + RB_KEYS[t.label] + ')' : ''), onclick: (e) => t.run(e) }, t.svg || icon(t.icon), h('span', { text: t.label })))),
      h('div', { class: 'rg-cap', text: g.title }))));
    $('rbTools').scrollLeft = sc;
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
    if (state.A && state.kicadErc && state.kicadErc.project === state.project.name) state.A.issues = state.A.issues.concat(kicadIssues(state.kicadErc));
    renderCheckBadge();
  }
  // ---- KiCad ERC report (File → ERC → Save… as .json in KiCad): shown with the app's own check
  const ercKey = () => 'kicadErc:' + (state.source && state.source.key || state.project.name);
  const kicadKinds = new Map();   // 'kicad:<type>' -> the description KiCad gives that test
  function kicadIssues(r) {
    const P = state.project, out = [];
    const byPath = new Map(P.instances.map((i) => [i.path, i])), byName = new Map(P.instances.map((i) => [i.namePath, i]));
    for (const sh of r.sheets) {
      const inst = byPath.get(sh.uuid_path) || byName.get(sh.path); if (!inst) continue;
      for (const v of sh.violations) {
        if (v.severity === 'exclusion' || v.excluded) continue;
        const it = (v.items || [])[0], p = it && it.pos ? [it.pos.x * r.scale, it.pos.y * r.scale] : [0, 0];
        const what = (v.items || []).map((x) => x.description).join('; ');
        kicadKinds.set('kicad:' + v.type, 'KiCad: ' + v.description);
        out.push({ sev: v.severity === 'error' ? 'error' : 'warn', code: 'kicad:' + v.type, kicadType: v.type, msg: 'KiCad: ' + v.description + (what ? ' – ' + what : ''), inst: inst.idx, page: inst.page, zone: Loom.zoneOf(inst, p), p });
      }
    }
    return out;
  }
  function loadKicadErc(file) {
    file.text().then((text) => {
      let d; try { d = JSON.parse(text); } catch (e) { banner('err', 'That is not a KiCad ERC report. In KiCad: Inspect → Electrical Rules Checker → Run ERC → Save…, and choose the .json format.'); return; }
      if (!d || !Array.isArray(d.sheets)) { banner('err', 'That file has no ERC results in it.'); return; }
      // KiCad writes positions in hundreds of the coordinate unit (mm)
      const scale = (d.coordinate_units || 'mm') === 'mm' ? 100 : 100 * 25.4 / 1000;
      const r = { project: state.project.name, file: file.name, date: d.date || '', kicad: d.kicad_version || '', scale, sheets: d.sheets.map((s) => ({ path: s.path, uuid_path: s.uuid_path, violations: s.violations || [] })) };
      const n = r.sheets.reduce((a, s) => a + s.violations.length, 0);
      const known = kicadIssues(r).length;
      state.kicadErc = r; Store.set(ercKey(), r).catch(() => {});
      analyzeNow(); updateAnnot(); if (state.panelOpen && state.tab === 'check') renderPanel();
      toast(`Loaded ${known} KiCad ERC result${known === 1 ? '' : 's'}` + (known < n ? ` (${n - known} on sheets this project doesn't have)` : ''));
    });
  }
  function clearKicadErc() { state.kicadErc = null; Store.del(ercKey()).catch(() => {}); analyzeNow(); updateAnnot(); if (state.panelOpen && state.tab === 'check') renderPanel(); }
  function restoreKicadErc() {
    const name = state.project && state.project.name; state.kicadErc = null;
    Store.get(ercKey()).then((r) => { if (r && state.project && state.project.name === name && r.project === name) { state.kicadErc = r; analyzeNow(); updateAnnot(); } }).catch(() => {});
  }
  // Kinds of problem that can be hidden from the check (some drawings never use no-connect flags)
  const CHECK_KINDS = { pin: 'Unconnected pins', nc: 'No-connect flag on a connected net', dangling: 'Loose wire ends', label: 'Labels with no pins', global1: 'Global labels used once', annotate: 'Not annotated', value: 'Missing values', dupref: 'Duplicate references', drive: 'Outputs driving each other', sheetpin: 'Sheet pins with no label', hier: 'Labels with no sheet pin', ebus: 'E-bus power',
    duppin: 'Same pin number on different nets', names: 'Two names on one wire or bus', busname: 'Bus names KiCad won\u2019t join', lbldangle: 'Labels not on a wire', buswire: 'Wires or pins touching a bus', power: 'Power inputs with no source', unit: 'Units not placed', grid: 'Off the connection grid' };
  const checkHide = new Set(Store.pref('checkHide') || ['grid']);   // off-grid is noisy on older drawings; on request
  const shownIssues = () => (state.A ? state.A.issues.filter((i) => !checkHide.has(i.code)) : []);
  function toggleCheckKind(code) {
    if (checkHide.has(code)) checkHide.delete(code); else checkHide.add(code);
    Store.pref('checkHide', Array.from(checkHide));
    renderCheckBadge(); updateAnnot();
    if (state.panelOpen) { state._keepScroll = true; renderPanel(); }
  }
  function renderCheckBadge() {
    const b = $('checkBadge'); if (!b) return;
    const A = state.A, I = shownIssues(), errs = I.filter((i) => i.sev === 'error').length, all = I.length;
    b.hidden = !all;
    b.textContent = String(errs || all);
    b.className = 'badge' + (errs ? ' bad' : ' warn');
  }

  // ---- drawing annotations for the current sheet
  function updateAnnot() {
    const inst = state.inst;
    if (!state.project || !inst || !state.A) { view.setAnnot(null); return; }
    view.setAnnot(annotFor(inst, sceneFor(inst), { wireNos: show.wireNos, xrefs: show.xrefs, markers: show.markers, live: true, dark: view.dark }));
  }
  /** Tags and colours drawn over a sheet. opt.live adds the on-screen extras (check marks, install, compare, trace). */
  function annotFor(inst, S, opt) {
    const P = state.project, A = state.A;
    const d = opt.dark ? 1 : 0;
    const an = { groupColor: new Map(), symMarks: new Map(), tags: [], markers: [] };
    if (opt.wireNos) {
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
    if (opt.xrefs) for (const sy of S.syms) {
      const others = A.xref.get(inst.idx + ':' + sy.si);
      if (!others || !others.length) continue;
      const ref = inst.refs[sy.si].ref;
      const txt = others.map((u) => `${ref}${u.unit} ${u.inst === inst ? '' : 'p' + u.page + ' '}${u.zone}`).join('   ');
      const b = sy.body || sy.bb;
      an.tags.push({ x: (b[0] + b[2]) / 2, y: b[3] + 0.6, text: '⇄ ' + txt, color: COL.xref[d], size: 0.95, ha: 'center', va: 'top' });
    }
    if (opt.live && opt.markers) for (const is of shownIssues()) if (is.inst === inst.idx) an.markers.push({ x: is.p[0], y: is.p[1], sev: is.sev, issue: is, current: state.curIssue && state.curIssue.msg === is.msg && state.curIssue.p === is.p });
    if (!opt.live) return an;
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
    return an;
  }

  $('btnLayers').addEventListener('click', (e) => {
    if (!state.project) return;
    openMenu(e.currentTarget, [
      { label: 'Wire numbers', icon: show.wireNos ? 'i-check' : 'i-none', checked: show.wireNos, run: () => setShow('wireNos', !show.wireNos) },
      { label: 'Cross-references', icon: show.xrefs ? 'i-check' : 'i-none', checked: show.xrefs, run: () => setShow('xrefs', !show.xrefs) },
      { label: 'Check markers', icon: show.markers ? 'i-check' : 'i-none', checked: show.markers, run: () => setShow('markers', !show.markers) },
      { label: 'Install status', icon: show.install ? 'i-check' : 'i-none', checked: show.install, run: () => setShow('install', !show.install) },
      { label: immersive.on ? 'Leave full screen' : 'Full screen', icon: immersive.on ? 'i-shrink' : 'i-expand', run: () => setImmersive(!immersive.on) },
      { label: 'Trace in steps', icon: traceStep ? 'i-check' : 'i-none', checked: traceStep, run: () => setTraceStep(!traceStep) },
      { label: 'Steps stop only at connectors', icon: traceBy === 'conn' ? 'i-check' : 'i-none', checked: traceBy === 'conn', run: () => { traceBy = traceBy === 'conn' ? 'section' : 'conn'; Store.pref('traceBy', traceBy); const s = state.sel; if (s && s.step) { s.step.k = 0; applyHighlight(); renderSelectionUI(); } } },
      { label: 'Grid dots', icon: view.showGrid ? 'i-check' : 'i-none', checked: view.showGrid, run: () => { view.showGrid = !view.showGrid; Store.pref('grid', view.showGrid); view.redraw(); renderScale(); } },
      { sep: true },
      { label: 'Print / export sheets', icon: 'i-print', run: printDialog },
      { label: 'Reports', icon: 'i-report', run: () => showTab('reports', true) },
      { label: 'Build looms', icon: 'i-cable', run: () => showTab('build', true) },
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
    const I = shownIssues();
    const errs = I.filter((i) => i.sev === 'error').length, warns = I.length - errs;
    body.append(h('div', { class: 'chips' },
      h('span', { class: 'chip ' + (errs ? 'bad' : 'ok'), text: `${errs} error${errs === 1 ? '' : 's'}` }),
      h('span', { class: 'chip ' + (warns ? 'warn' : 'ok'), text: `${warns} warning${warns === 1 ? '' : 's'}` })));
    body.append(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: show.markers, onchange: (e) => setShow('markers', e.target.checked) }), 'Show markers on the drawing'));
    // Filter: one switch per kind of problem found (or hidden)
    const counts = new Map();
    for (const is of A.issues) counts.set(is.code, (counts.get(is.code) || 0) + 1);
    const kindName = (c) => CHECK_KINDS[c] || kicadKinds.get(c) || c;
    const codes = Object.keys(CHECK_KINDS).concat(Array.from(kicadKinds.keys())).filter((c) => counts.has(c) || (checkHide.has(c) && CHECK_KINDS[c]));
    if (codes.length) {
      const f = h('div', { class: 'rows' });
      for (const c of codes) {
        const box = h('input', { type: 'checkbox', checked: !checkHide.has(c), onchange: () => toggleCheckKind(c) });
        f.append(h('label', { class: 'row check-kind' }, h('span', { class: 'main' }, box, h('span', { class: 'nm', text: kindName(c) })), h('span', { class: 'meta', text: String(counts.get(c) || 0) })));
      }
      body.append(section('Show these problems', checkHide.size ? checkHide.size + ' kind' + (checkHide.size === 1 ? '' : 's') + ' hidden' : 'all shown', f));
    }
    if (!I.length) body.append(h('p', { class: 'empty', text: A.issues.length ? 'Nothing to show: the problems found are all of kinds you have hidden.' : 'No problems found. The checks run again after every edit.' }));
    else {
      const rows = h('div', { class: 'rows' });
      for (const is of I.slice(0, 600)) {
        const cur = state.curIssue && state.curIssue.msg === is.msg && state.curIssue.p === is.p;
        rows.append(h('button', { class: 'row issue ' + is.sev + (cur ? ' current' : ''), onclick: () => { pickIssue(is, true); afterPick(); } },
          h('span', { class: 'main' }, h('span', { class: 'sev', 'aria-label': is.sev === 'error' ? 'Error' : 'Warning' }), h('span', { class: 'nm', text: is.msg })),
          h('span', { class: 'meta', text: 'p' + is.page + ' · ' + is.zone })));
      }
      if (I.length > 600) rows.append(h('div', { class: 'row' }, h('span', { class: 'meta', text: `${I.length - 600} more in the Design check report` })));
      body.append(section('Problems', String(I.length), rows));
    }
    const ercFile = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: (e) => { const f = e.target.files[0]; if (f) loadKicadErc(f); e.target.value = ''; } });
    const er = state.kicadErc;
    body.append(section('KiCad ERC report', er ? er.file : 'none loaded',
      h('p', { class: 'hint', text: er ? `From KiCad ${er.kicad}${er.date ? ', run ' + er.date : ''}. Its results are listed with the app's own, marked “KiCad:”. They don't update as you edit: run ERC in KiCad again and load the new report.` : 'In KiCad: Inspect → Electrical Rules Checker → Run ERC → Save… as .json, then load the file here to see KiCad\u2019s results on the drawing.' }),
      h('div', { class: 'actions' }, ercFile, h('button', { class: 'btn small', onclick: () => ercFile.click() }, icon('i-file'), er ? 'LOAD A NEWER REPORT' : 'LOAD KICAD REPORT'), er ? h('button', { class: 'btn small', onclick: clearKicadErc }, icon('i-close'), 'CLEAR') : null)));
    body.append(h('p', { class: 'hint', text: 'Checks as you edit, using KiCad\u2019s ERC rules for: unconnected pins, wire ends that touch nothing, labels that reach no pins or sit on no wire, two names on one wire, bus names KiCad won\u2019t join, wires meeting a bus without an entry, the same pin number on different nets, power inputs with no source, unplaced units, sheet pins without a hierarchical label, duplicate or unannotated references, missing values and outputs driving each other. Load KiCad\u2019s own report to see everything KiCad found.' }));
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
    { id: 'cables', title: 'Cable schedule', desc: 'Total cable length by type and product code (for ordering), each cable run, and every tagged core with its two ends.',
      make: (P, A) => {
        const C = Loom.cables(P, A);
        if (!C.rows.length) return { count: 'no cables yet', sections: [{ heading: 'No cable details yet', cols: ['Note'], rows: [['Tap a wire, then CABLE, to give that section a type, product code, core size, colour and length.']] }] };
        const list = { heading: 'Cables', cols: ['Type', 'Product code', 'Size', 'Colour / marking', 'Length', 'Wire', 'From', 'To', 'Net', 'Page', 'Zone'], rows: C.rows.map((r) => [r.f.Cable_Type, r.f.Cable_PN, r.f.Cable_Size, r.f.Cable_Colour, r.f.Cable_Length, r.wire, r.from, r.to, r.net ? K.plainText(K.unescape(r.net.name)) : '', r.page, r.zone]) };
        const r2 = (v) => Math.round(v * 100) / 100;
        const m = C.totals.reduce((a, t) => a + t.m, 0);
        const tot = { heading: 'Total length by cable', sub: 'Each cable run counted once, however many of its cores are tagged', cols: ['Type', 'Product code', 'Size', 'Cable runs', 'Total length (m)', 'Cores tagged', 'Runs without a length'],
          rows: C.totals.map((t) => [t.type, t.pn, t.size, t.runs, r2(t.m), t.n, t.unknown]).concat([['All cables', '', '', C.runs.length, r2(m), C.rows.length, C.totals.reduce((a, t) => a + t.unknown, 0)]]) };
        const runs = { heading: 'Cable runs', sub: 'Cores of one cable: same cable, same two ends, same length', cols: ['Type', 'Product code', 'Between', 'Length', 'Cores tagged', 'Page'],
          rows: C.runs.map((r) => [r.type, r.pn, r.ends, r.length || '', r.cores.join(', '), r.page]) };
        return { group: 'Section', count: `${C.runs.length} cable runs · ${Math.round(m * 10) / 10} m`, sections: [tot, runs, list] };
      } },
    { id: 'bom', title: 'Bill of materials', desc: 'Parts grouped by value and footprint, with manufacturer fields when the schematic has them.',
      make: (P, A) => { const t = Loom.bom(P, A); return { sections: [t], count: t.rows.reduce((n, r) => n + r[0], 0) + ' parts' }; } },
    { id: 'check', title: 'Design check', desc: 'Every problem the live check found, with page and zone.',
      make: (P, A) => { const t = Loom.issuesTable(P, Object.assign({}, A, { issues: shownIssues() })); return { sections: [t], count: t.rows.length + ' problems' + (checkHide.size ? ' (some kinds hidden)' : '') }; } },
    { id: 'install', title: 'Install record', desc: 'Fitted and tested status for every wire and part, with who and when.',
      make: (P, A) => {
        const wires = { heading: 'Wires', cols: ['Wire', 'From', 'To', 'Fitted', 'Fitted by', 'Tested', 'Tested by', 'Note'], rows: A.wires.map((w) => { const x = ist(w.key), it = x.it || {}; return [w.no || '', pinText(w.a), pinText(w.b), x.fitted ? 'yes' : '', whenText(it.fitted), x.tested ? 'yes' : '', whenText(it.tested), it.note && it.note.v ? it.note.v : '']; }) };
        const parts = { heading: 'Parts', cols: ['Ref', 'Value', 'Fitted', 'Fitted by', 'Tested', 'Tested by', 'Note'], rows: Array.from(A.parts.values()).sort((a, b) => K.naturalCmp(a.ref, b.ref)).map((e) => { const x = ist('P:' + e.ref), it = x.it || {}; return [e.ref, K.unescape((e.sym.props.find((p) => p.name === 'Value') || {}).value || ''), x.fitted ? 'yes' : '', whenText(it.fitted), x.tested ? 'yes' : '', whenText(it.tested), it.note && it.note.v ? it.note.v : '']; }) };
        const f = A.wires.filter((w) => ist(w.key).fitted).length, t = A.wires.filter((w) => ist(w.key).tested).length;
        return { group: 'Section', count: `${f}/${A.wires.length} fitted · ${t} tested`, sections: [wires, parts] };
      } }
  ];
  function reportCsv(rep) {
    rep = Object.assign({}, rep, { sections: rep.sections.filter((s) => !s.svg && !s.notes && s.cols && s.cols.length) });
    if (!rep.sections.length) return '';
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
    rep.sections.forEach((s, i) => {
      if (s.heading) bodyKids.push(h('h2', { class: 'rsec' + (s.loomHead ? ' rloom' + (i ? ' brk' : '') : '') }, s.heading, s.sub ? h('small', { text: '  ' + s.sub }) : null));
      if (s.svg) { const d = h('div', { class: 'rdraw' }); d.innerHTML = s.svg; bodyKids.push(d); return; }
      if (s.notes) { bodyKids.push(s.notes.length ? h('ul', { class: 'rnotes' }, ...s.notes.map((t) => h('li', { text: t }))) : h('p', { class: 'hint', text: s.okText || '' })); return; }
      bodyKids.push(s.rows.length ? table(s) : h('p', { class: 'hint', text: 'Nothing to list.' }));
    });
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

  // ---- build looms: a loom is every part with the same Loom field; the Build tab makes its pack
  const BUILD_OUT = [['drawing', 'Flat loom drawing'], ['parts', 'Connectors & parts'], ['cut', 'Cable cut list'], ['wires', 'Wire / termination list'], ['pinouts', 'Pin-out tables']];
  const BUILD_ALL = { drawing: true, parts: true, cut: true, wires: true, pinouts: true };
  state.buildSel = new Set(Store.pref('buildSel') || []);
  let buildOut = Object.assign({}, BUILD_ALL, Store.pref('buildOut') || {});
  let harnessCache = null;
  function harness() {
    if (!state.project || !state.A) return null;
    if (!harnessCache || harnessCache.A !== state.A) {
      let B;
      try { B = Harness.build(state.project, state.A); } catch (e) { console.error(e); B = { looms: [], suggestions: [], error: e.message || String(e) }; }
      harnessCache = { A: state.A, B };
    }
    return harnessCache.B;
  }
  // The looms ticked in the panel; none ticked means all of them.
  const chosenLooms = (B) => { const s = B.looms.filter((L) => state.buildSel.has(L.name)); return s.length ? s : B.looms; };
  const loomSummary = (L) => [`${L.parts.length} part${L.parts.length === 1 ? '' : 's'}`, `${L.wires.length} wire${L.wires.length === 1 ? '' : 's'}`, `${L.cables.length} cable${L.cables.length === 1 ? '' : 's'}`, L.metres ? `${Math.round(L.metres * 100) / 100} m` : ''].filter(Boolean).join(' · ');
  function buildReport(what) {
    const B = harness(), looms = chosenLooms(B);
    const picked = BUILD_OUT.filter(([k]) => what[k]);
    const one = looms.length === 1 ? looms[0].name : looms.length + ' looms';
    return { id: 'loom-' + slug(looms.length === 1 ? looms[0].name : 'pack') + (picked.length === 1 ? '-' + picked[0][0] : ''),
      title: (picked.length === 1 ? picked[0][1] : 'Loom build pack') + ' · ' + one,
      make: (P) => {
        const meta = { project: P.name, revision: revisionText(), date: new Date().toLocaleDateString() };
        const sections = [];
        for (const L of looms) {
          sections.push({ heading: 'Loom ' + L.name, sub: loomSummary(L), loomHead: true, notes: L.issues, okText: 'Nothing missing: every wire has cable details and every cable a length.' });
          if (what.drawing) sections.push({ heading: L.name + ' · flat drawing', svg: Harness.drawing(L, meta).svg });
          for (const t of Harness.tables(L, what)) sections.push(Object.assign({}, t, { heading: L.name + ' · ' + t.heading }));
        }
        return { group: 'Section', count: looms.map((L) => L.name).join(', '), sections };
      } };
  }
  function openBuild(what) {
    const B = harness(); if (!B || !B.looms.length) { toast('No looms yet: give connectors a Loom field first.'); return; }
    openReport(buildReport(what));
  }
  function goToPart(e) {
    const u = e.units[0]; if (!u) return;
    selectSymbol(u.inst, u.si);
    zoomToSelection();
  }
  function renderBuild(body) {
    const B = harness();
    if (!B) { body.append(h('p', { class: 'empty', text: 'Open a project first.' })); return; }
    body.append(h('p', { class: 'hint', text: 'A loom is every part with the same Loom field: the plugs, and anything built into the loom. Select a connector (or box-select several), then LOOM to put them in one. For cut lengths and core colours, tap a wire or bus, then CABLE.' }));
    if (B.error) body.append(h('p', { class: 'hint err', text: 'Couldn\'t work out the looms: ' + B.error }));
    if (!B.looms.length) body.append(h('p', { class: 'empty', text: 'No looms yet.' }));
    else {
      const sel = state.buildSel;
      const save = () => { Store.pref('buildSel', Array.from(sel)); renderRibbon(); };
      body.append(h('div', { class: 'loom-bar' },
        h('b', { text: `${B.looms.length} loom${B.looms.length === 1 ? '' : 's'}` }),
        h('span', { class: 'meta', text: sel.size && B.looms.some((L) => sel.has(L.name)) ? `${B.looms.filter((L) => sel.has(L.name)).length} chosen` : 'none ticked: all are made' }),
        h('button', { class: 'btn small', onclick: () => { for (const L of B.looms) sel.add(L.name); save(); renderPanel(); } }, 'ALL'),
        h('button', { class: 'btn small', onclick: () => { sel.clear(); save(); renderPanel(); } }, 'NONE')));
      const list = h('div', { class: 'cards-list' });
      for (const L of B.looms) {
        const cb = h('input', { type: 'checkbox', checked: sel.has(L.name), onchange: (e) => { if (e.target.checked) sel.add(L.name); else sel.delete(L.name); save(); renderPanel(); } });
        const det = h('details', { class: 'loom-det' }, h('summary', { text: L.issues.length ? `${L.issues.length} to sort out · parts` : 'Ready · parts' }),
          L.issues.length ? h('ul', { class: 'rnotes' }, ...L.issues.map((t) => h('li', { text: t }))) : null,
          h('div', { class: 'rows' }, ...L.partRows.map((r) => h('button', { class: 'row', onclick: () => goToPart(r.e) },
            h('span', { class: 'main' }, h('b', { text: r.ref }), h('span', { text: ' ' + (r.mpn || r.value || '') })),
            h('span', { class: 'meta', text: [r.mates ? '→ ' + r.mates : '', 'p' + r.page].filter(Boolean).join(' · ') })))));
        list.append(h('div', { class: 'rcard loom-card' + (L.issues.length ? ' warn' : '') },
          h('label', { class: 'loom-head' }, cb, h('span', { class: 'ln' }, h('b', { text: L.name }), h('small', { text: loomSummary(L) }))),
          det,
          h('div', { class: 'rc-actions' },
            h('button', { class: 'btn small', onclick: () => { state.buildSel = new Set([L.name]); Store.pref('buildSel', [L.name]); openBuild(buildOut); renderPanel(); renderRibbon(); } }, icon('i-print'), 'BUILD PACK'),
            h('button', { class: 'btn small', onclick: () => renameLoom(L) }, 'RENAME'))));
      }
      body.append(list);
      body.append(h('h3', { class: 'psub', text: 'Build pack' }));
      body.append(h('div', { class: 'checks' }, ...BUILD_OUT.map(([k, label]) => h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: !!buildOut[k], onchange: (e) => { buildOut[k] = e.target.checked; Store.pref('buildOut', buildOut); } }), label))));
      const ch = chosenLooms(B);
      body.append(h('div', { class: 'btnrow' },
        h('button', { class: 'btn primary', onclick: () => { if (!BUILD_OUT.some(([k]) => buildOut[k])) { toast('Tick at least one thing to make.'); return; } openBuild(buildOut); } }, icon('i-print'), ch.length === B.looms.length ? 'MAKE ALL' : `MAKE ${ch.length}`),
        h('button', { class: 'btn', onclick: () => { const r = buildReport(buildOut); exportCsv(r); } }, icon('i-download'), 'CSV')));
      body.append(h('p', { class: 'hint', text: 'Opens a printable pack: PRINT / PDF there saves it as a PDF. The CSV has the tables (not the drawing).' }));
    }
    if (B.suggestions && B.suggestions.length) {
      body.append(h('h3', { class: 'psub', text: 'Wired to a loom, but not in one' }));
      body.append(h('div', { class: 'rows' }, ...B.suggestions.map((sg) => h('div', { class: 'row' },
        h('span', { class: 'main' }, h('b', { text: sg.ref }), h('span', { text: ' ' + (sg.value || '') })),
        h('span', { class: 'meta', text: 'p' + sg.page }),
        h('button', { class: 'btn small', onclick: () => { const e = state.A.parts.get(sg.ref); if (e) loomDialog([{ inst: e.units[0].inst, si: e.units[0].si }], sg.looms[0]); } }, 'ADD TO ' + sg.looms[0])))));
    }
  }
  // Every unit of each part, so a multi-unit connector is in the loom whichever unit was tapped.
  function loomTargets(targets) {
    const out = [], seen = new Set();
    for (const t of targets) {
      const ref = t.inst.refs[t.si] && t.inst.refs[t.si].ref;
      const e = ref && state.A.parts.get(ref);
      for (const u of e ? e.units : [t]) { const k = u.inst.idx + ':' + u.si; if (!seen.has(k)) { seen.add(k); out.push({ inst: u.inst, si: u.si }); } }
    }
    return out;
  }
  function setLoom(targets, value, label) {
    const bySheet = new Map();
    for (const t of loomTargets(targets)) { const sh = t.inst.sheet, sym = sh.symbols[t.si]; let a = bySheet.get(sh); if (!a) bySheet.set(sh, a = []); if (!a.includes(sym)) a.push(sym); }
    run(label || (value ? 'Loom ' + value : 'Remove from loom'), () => Array.from(bySheet).map(([sh, syms]) => E.setFieldMany(sh, syms, Harness.FIELD, value)).filter(Boolean));
    if (state.panelOpen && state.tab === 'build') { state._keepScroll = true; renderPanel(); }
  }
  function loomDialog(targets, preset) {
    targets = targets.filter((t) => { const sym = t.inst.sheet.symbols[t.si]; return sym && sym.lib && !sym.lib.power; });
    if (!targets.length) { toast('Select a connector or part first.'); return; }
    const B = harness(), names = B ? B.looms.map((L) => L.name) : [];
    const refs = Array.from(new Set(targets.map((t) => t.inst.refs[t.si].ref))).sort(K.naturalCmp);
    const cur = Array.from(new Set(targets.map((t) => Harness.loomOfSym(t.inst.sheet.symbols[t.si])))).filter(Boolean);
    const inp = h('input', { class: 'input', value: preset || (cur.length === 1 ? cur[0] : ''), placeholder: 'e.g. 331-1A', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'characters', list: 'dl_looms' });
    const save = () => { const v = inp.value.trim(); if (!v) { toast('Type a loom name, or REMOVE.'); return; } closeDialog(); setLoom(targets, v); };
    openDialog('LOOM', [
      h('p', { class: 'hint', text: `${refs.slice(0, 12).join(', ')}${refs.length > 12 ? ` and ${refs.length - 12} more` : ''}${cur.length ? ' · now in ' + cur.join(', ') : ''}` }),
      h('div', { class: 'fieldrow' }, h('label', { text: 'Loom' }), inp, h('datalist', { id: 'dl_looms' }, ...names.map((n) => h('option', { value: n })))),
      h('p', { class: 'hint', text: 'Saved as a hidden Loom field on each part, so KiCad keeps it. Parts with the same loom name are made as one loom; their wires to each other are its wires.' })],
      [cur.length ? { label: 'REMOVE', run: () => { closeDialog(); setLoom(targets, ''); } } : null, { label: 'CANCEL', run: closeDialog }, { label: 'SAVE', primary: true, run: save }].filter(Boolean));
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    setTimeout(() => { inp.focus(); inp.select(); }, 60);
  }
  function renameLoom(L) {
    const inp = h('input', { class: 'input', value: L.name, spellcheck: 'false', autocomplete: 'off', autocapitalize: 'characters' });
    const save = () => {
      const v = inp.value.trim(); closeDialog();
      if (!v || v === L.name) return;
      const was = state.buildSel.delete(L.name); if (was) { state.buildSel.add(v); Store.pref('buildSel', Array.from(state.buildSel)); }
      setLoom(L.parts.map((e) => ({ inst: e.units[0].inst, si: e.units[0].si })), v, `Rename loom ${L.name} to ${v}`);
    };
    openDialog('RENAME LOOM', [h('div', { class: 'fieldrow' }, h('label', { text: 'Name' }), inp), h('p', { class: 'hint', text: `Changes the Loom field on its ${L.parts.length} parts.` })], [{ label: 'CANCEL', run: closeDialog }, { label: 'SAVE', primary: true, run: save }]);
    setTimeout(() => { inp.focus(); inp.select(); }, 60);
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
    // What is selected on the drawing: its wires (a net, cable or wire) or its part
    const selKeys = new Set();
    const sel = state.sel;
    if (sel && sel.type === 'net' && sel.net) for (const w of wires) { if (w.net === sel.net || (w.net && w.net.id === sel.net.id)) selKeys.add(w.key); }
    else if (sel && sel.type === 'symbol') { const r = sel.inst.refs[sel.si] && sel.inst.refs[sel.si].ref; if (r) selKeys.add('P:' + r); }
    else if (sel && sel.type === 'multi') { const r = multiResolve(sel.m); for (const it of r.items) if (it.type === 'symbol') { const i = state.inst.sheet.symbols.indexOf(it.sym); const ref = i >= 0 && state.inst.refs[i] ? state.inst.refs[i].ref : null; if (ref) selKeys.add('P:' + ref); } }
    const wireRow = (w) => h('div', { class: 'irow' + (selKeys.has(w.key) ? ' sel' : '') },
      h('button', { class: 'iw', onclick: () => { selectNet(w.net); goToPin(w.a); afterPick(); } },
        h('span', { class: 'wno', text: w.no || '–' }), h('span', { class: 'ends', text: `${pinText(w.a)} → ${pinText(w.b)}` })),
      ...toggles(w.key));
    const partRow = (e) => h('div', { class: 'irow' + (selKeys.has('P:' + e.ref) ? ' sel' : '') },
      h('button', { class: 'iw', onclick: () => { selectSymbol(e.units[0].inst, e.units[0].si, true); afterPick(); } }, h('span', { class: 'wno', text: e.ref }), h('span', { class: 'ends', text: K.unescape((e.sym.props.find((p) => p.name === 'Value') || {}).value || '') })),
      ...toggles('P:' + e.ref));
    const fill = () => {
      V.q = q.value;
      const terms = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      list.replaceChildren();
      // The selection is always listed first, whatever the filter, so its fitted / tested state is in view.
      if (selKeys.size) {
        const sw = wires.filter((w) => selKeys.has(w.key)), sp = parts.filter((e) => selKeys.has('P:' + e.ref));
        const c = cnt(Array.from(selKeys));
        const name = sw.length ? (K.plainText(sw[0].net.name) || 'Selected wire') : sp.map((e) => e.ref).join(', ');
        list.append(h('div', { class: 'row group selhead' }, h('span', { class: 'main' }, h('span', { class: 'nm', text: 'Selected · ' + name })), h('span', { class: 'meta', text: `${c.f}/${c.n} fitted · ${c.t} tested` })));
        if (sw.length > 1) list.append(h('div', { class: 'irow sel all' }, h('span', { class: 'iw', text: `All ${sw.length} wires` }),
          h('button', { class: 'tg f' + (c.f === c.n ? ' on' : ''), 'aria-pressed': String(c.f === c.n), onclick: () => setInstall(sw.map((w) => w.key), 'fitted', c.f !== c.n) }, 'FIT'),
          h('button', { class: 'tg t' + (c.t === c.n ? ' on' : ''), 'aria-pressed': String(c.t === c.n), onclick: () => setInstall(sw.map((w) => w.key), 'tested', c.t !== c.n) }, 'TEST')));
        for (const w of sw) list.append(wireRow(w));
        for (const e of sp) list.append(partRow(e));
      }
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
            list.append(wireRow(w));
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
          list.append(partRow(e));
        }
      }
      if (total > V.limit) list.append(h('button', { class: 'row', onclick: () => { V.limit += 500; fill(); } }, h('span', { class: 'meta', text: `Show more (${total - V.limit} hidden)` })));
      if (!total) list.append(h('div', { class: 'row' }, h('span', { class: 'meta', text: 'Nothing matches.' })));
    };
    q.addEventListener('input', fill);
    fill();
    body.append(list);
    // Bring the selection into view when it changes (not on every tick of a toggle)
    const selSig = Array.from(selKeys).join('|');
    if (selKeys.size && V.lastSel !== selSig) { V.lastSel = selSig; requestAnimationFrame(() => { const el = list.querySelector('.selhead'); if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' }); }); }
    if (!selKeys.size) V.lastSel = '';
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
  $('btnFit').addEventListener('click', () => { if (view.scene) view.fit(view.scene.page, 12); });
  $('wConnect').addEventListener('click', () => openDrawer('drawerProjects'));
  $('wOpen').addEventListener('click', () => $('fileInput').click());
  $('wSample').addEventListener('click', loadSample);
  // ------------------------------------------------------------------ KiCad tools: annotate, find & replace, measure, swap, autoplace, repeat
  const isTyping = () => { const a = document.activeElement; return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT'); };
  function uniqueSheets() { const seen = new Set(), out = []; for (const i of state.project.instances) if (!seen.has(i.sheet.path)) { seen.add(i.sheet.path); out.push(i); } return out; }

  // ---- Annotate (KiCad: Tools → Annotate Schematic)
  function annotateDialog() {
    if (!state.project) return;
    let plan = null, ready = false;
    const scope = seg('Which references', [['fix', 'NEW & DUPLICATES'], ['all', 'RENUMBER ALL']], Store.pref('annScope') || 'fix', () => { if (ready) preview(); });
    const base = seg('Numbering', [['seq', '1, 2, 3 …'], ['sheet', 'SHEET × 100']], Store.pref('annBase') || 'seq', () => { if (ready) preview(); });
    const out = h('div', { class: 'ann-preview' });
    ready = true;
    function preview() {
      plan = E.annotate(state.project, { all: scope.get() === 'all', sheetBase: base.get() === 'sheet' });
      const c = plan.changes;
      out.replaceChildren(h('p', { class: 'hint', text: c.length ? `${c.length} reference${c.length === 1 ? '' : 's'} will change:` : 'Every reference is already unique. Nothing to change.' }),
        ...(c.length ? [h('div', { class: 'ann-list' }, ...c.slice(0, 200).map((x) => h('div', {}, h('span', { class: 'mono', text: x.from || '(blank)' }), ' → ', h('b', { class: 'mono', text: x.to }), h('small', { text: '  page ' + x.inst.page }))))] : []));
    }
    preview();
    openDialog('ANNOTATE', [
      h('div', { class: 'field' }, h('label', { text: 'Which references' }), scope.el),
      h('div', { class: 'field' }, h('label', { text: 'Numbering' }), base.el),
      h('p', { class: 'hint', text: 'Like KiCad’s Annotate Schematic: parts numbered page by page, left to right. Units of one part keep the same reference. Sheet × 100 starts page 2 at 201, page 3 at 301.' }), out],
      [{ label: 'CANCEL', run: closeDialog }, { label: 'ANNOTATE', primary: true, run: () => {
        Store.pref('annScope', scope.get()); Store.pref('annBase', base.get());
        closeDialog();
        if (!plan || !plan.changes.length) { toast('Nothing to change.'); return; }
        if (run('Annotate ' + plan.changes.length + ' parts', () => plan.results, { anchor: null })) toast(`Annotated ${plan.changes.length} part${plan.changes.length === 1 ? '' : 's'}.`);
      } }]);
  }

  // ---- Find and replace (KiCad: Ctrl+Alt+F)
  function replaceDialog() {
    if (!state.project) return;
    const pre = state.sel && state.sel.type === 'net' && state.sel.item && state.sel.item.type === 'label' ? (itemObj(state.sel.item) || {}).text || '' : '';
    const find = h('input', { class: 'input', id: 'frFind', value: pre, autocomplete: 'off', spellcheck: 'false', placeholder: 'Text to find' });
    const repl = h('input', { class: 'input', id: 'frRepl', autocomplete: 'off', spellcheck: 'false', placeholder: 'Replace with (blank to remove)' });
    const box = (k, label, def) => { const c = h('input', { type: 'checkbox', checked: Store.pref('fr_' + k) !== undefined ? !!Store.pref('fr_' + k) : def, onchange: () => { Store.pref('fr_' + k, c.checked); preview(); } }); return [c, h('label', { class: 'check' }, c, label)]; };
    const [cLab, lLab] = box('labels', 'Labels', true), [cTxt, lTxt] = box('texts', 'Text', true), [cFld, lFld] = box('fields', 'Part fields (value, footprint, MPN…)', false);
    const [cCase, lCase] = box('case', 'Match case', false), [cWord, lWord] = box('word', 'Whole words', false);
    const out = h('div', { class: 'ann-preview' });
    let found = [];
    const opts = (rep) => ({ find: find.value, replace: rep, labels: cLab.checked, texts: cTxt.checked, fields: cFld.checked, matchCase: cCase.checked, whole: cWord.checked });
    function preview() {
      found = [];
      if (!find.value) { out.replaceChildren(h('p', { class: 'hint', text: 'Type something to find.' })); return; }
      for (const inst of uniqueSheets()) { const r = E.replaceInSheet(inst.sheet, opts(repl.value)); for (const x of r.hits) found.push({ inst, ...x }); }
      out.replaceChildren(h('p', { class: 'hint', text: found.length ? `${found.length} match${found.length === 1 ? '' : 'es'}:` : 'No matches.' }),
        ...(found.length ? [h('div', { class: 'ann-list' }, ...found.slice(0, 200).map((x) => h('div', {}, h('small', { text: x.where + ' · ' + x.inst.name + '  ' }), h('span', { class: 'mono', text: x.before }), ' → ', h('b', { class: 'mono', text: x.after }))))] : []));
    }
    find.addEventListener('input', preview); repl.addEventListener('input', preview);
    preview();
    openDialog('FIND AND REPLACE', [h('div', { class: 'field' }, h('label', { for: 'frFind', text: 'Find' }), find), h('div', { class: 'field' }, h('label', { for: 'frRepl', text: 'Replace with' }), repl),
      h('div', { class: 'checks' }, lLab, lTxt, lFld, lCase, lWord), out,
      h('p', { class: 'hint', text: 'Searches every sheet. Renaming a label renames its net. References are changed with Annotate or by editing the part.' })],
      [{ label: 'CANCEL', run: closeDialog }, { label: 'REPLACE ALL', primary: true, run: () => {
        if (!find.value || !found.length) { toast('Nothing to replace.'); return; }
        const results = uniqueSheets().map((i) => E.replaceInSheet(i.sheet, opts(repl.value)).result).filter(Boolean);
        const n = found.length; closeDialog();
        if (run(`Replace “${find.value}” (${n})`, () => results, { anchor: null })) toast(`Replaced ${n} match${n === 1 ? '' : 'es'}.`);
      } }]);
    setTimeout(() => { find.focus(); find.select(); }, 50);
  }

  // ---- Symbol fields table (KiCad: Tools → Edit Symbol Fields): every part's fields in one grid
  function fieldsTable() {
    if (!state.project) return;
    const P = state.project;
    // One row per part; units of a part (and repeats of a reused sheet) share the row.
    const parts = new Map();
    for (const inst of P.instances) inst.sheet.symbols.forEach((sym, si) => {
      const ref = inst.refs[si] && inst.refs[si].ref;
      if (!ref || ref.startsWith('#') || (sym.lib && sym.lib.power)) return;
      if (!parts.has(ref)) parts.set(ref, { ref, members: [], fields: {} });
      const row = parts.get(ref);
      row.members.push({ inst, si, sym });
      for (const p of sym.props) if (p.name !== 'Reference' && !p.name.startsWith('ki_') && !(p.name in row.fields)) row.fields[p.name] = p.value;
    });
    let rows = Array.from(parts.values()).sort((a, b) => K.naturalCmp(a.ref, b.ref));
    const freq = new Map();
    for (const r of rows) for (const k of Object.keys(r.fields)) freq.set(k, (freq.get(k) || 0) + 1);
    const fixed = ['Value', 'Footprint', 'Datasheet'];
    let cols = fixed.concat(Array.from(freq.keys()).filter((k) => !fixed.includes(k) && k !== 'Description').sort((a, b) => freq.get(b) - freq.get(a) || a.localeCompare(b)));
    if (freq.has('Description')) cols.push('Description');
    const edits = new Map();   // ref -> {field: value}
    let group = !!Store.pref('ftGroup'), filter = '', sortCol = null, sortDir = 1;
    const valOf = (r, c) => { const e = edits.get(r.ref); return e && c in e ? e[c] : (r.fields[c] !== undefined ? r.fields[c] : ''); };
    const groupKey = (r) => valOf(r, 'Value') + '\u0000' + valOf(r, 'Footprint') + '\u0000' + r.ref.replace(/\d+$/, '');
    const count = () => { let n = 0; for (const e of edits.values()) n += Object.keys(e).length; return n; };
    const head = h('div', { class: 'report-head' });
    const body = h('div', { class: 'report-body ft-body' });
    const wrap = h('div', { class: 'report-wrap', id: 'fieldsWrap', role: 'dialog', 'aria-label': 'Symbol fields' }, head, body);
    const applyBtn = h('button', { class: 'btn small primary', disabled: true, onclick: apply }, icon('i-check'), 'APPLY');
    const q = h('input', { class: 'input ft-filter', type: 'search', placeholder: 'Filter: R1, 10k, connector…', oninput: () => { filter = q.value.trim().toLowerCase(); render(); } });
    const grp = h('input', { type: 'checkbox', checked: group, onchange: () => { group = grp.checked; Store.pref('ftGroup', group); render(); } });
    head.append(h('div', { class: 'titles' }, h('b', { text: 'SYMBOL FIELDS' }), h('small', { id: 'ftCount', text: '' })), q,
      h('label', { class: 'check' }, grp, 'Group'),
      h('button', { class: 'btn small', onclick: addField }, icon('i-plus'), 'FIELD'),
      h('button', { class: 'btn small', onclick: csv }, icon('i-download'), 'CSV'),
      applyBtn,
      h('button', { class: 'ib', 'aria-label': 'Close', onclick: close }, icon('i-close')));
    function close() {
      if (count() && !close.armed) { close.armed = true; toast('Unapplied changes. Close again to throw them away, or tap APPLY.'); return; }
      wrap.remove();
    }
    function setVal(rs, c, v) {
      for (const r of rs) {
        const orig = r.fields[c] !== undefined ? r.fields[c] : '';
        const e = edits.get(r.ref) || {};
        if (v === orig) delete e[c]; else e[c] = v;
        if (Object.keys(e).length) edits.set(r.ref, e); else edits.delete(r.ref);
      }
      applyBtn.disabled = !count();
      applyBtn.lastChild.textContent = count() ? `APPLY ${count()}` : 'APPLY';
      close.armed = false;
    }
    function visibleRows() {
      let list = rows.filter((r) => !filter || r.ref.toLowerCase().includes(filter) || cols.some((c) => String(valOf(r, c)).toLowerCase().includes(filter)));
      if (sortCol) list = list.slice().sort((a, b) => sortDir * K.naturalCmp(sortCol === 'Reference' ? a.ref : valOf(a, sortCol), sortCol === 'Reference' ? b.ref : valOf(b, sortCol)) || K.naturalCmp(a.ref, b.ref));
      if (!group) return list.map((r) => ({ refs: r.ref, rs: [r] }));
      const m = new Map();
      for (const r of list) { const k = groupKey(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
      return Array.from(m.values()).map((rs) => ({ refs: refRange(rs.map((r) => r.ref)), rs }));
    }
    function refRange(refs) {
      refs.sort(K.naturalCmp);
      const out = []; let i = 0;
      while (i < refs.length) {
        const m0 = /^(.*?)(\d+)$/.exec(refs[i]); let j = i;
        if (m0) while (j + 1 < refs.length) { const m1 = /^(.*?)(\d+)$/.exec(refs[j + 1]); if (!m1 || m1[1] !== m0[1] || +m1[2] !== +m0[2] + (j + 1 - i)) break; j++; }
        out.push(j - i >= 2 ? refs[i] + '–' + refs[j] : refs.slice(i, j + 1).join(', ')); i = j + 1;
      }
      return out.join(', ');
    }
    function render() {
      const vr = visibleRows();
      $('ftCount').textContent = `${rows.length} parts · ${vr.length} row${vr.length === 1 ? '' : 's'}${group ? ' (grouped)' : ''}`;
      const th = (c) => h('th', { class: sortCol === c ? 'sorted' : '', onclick: () => { if (sortCol === c) sortDir = -sortDir; else { sortCol = c; sortDir = 1; } render(); } }, c, sortCol === c ? (sortDir > 0 ? ' ▲' : ' ▼') : '');
      const table = h('table', { class: 'rtable ft' }, h('thead', null, h('tr', null, th('Reference'), group ? h('th', { text: 'Qty' }) : null, ...cols.map(th))));
      const tb = h('tbody');
      vr.slice(0, 3000).forEach((row, ri) => {
        const tr = h('tr', null, h('td', { class: 'ref mono', text: row.refs }), group ? h('td', { text: String(row.rs.length) }) : null);
        cols.forEach((c, ci) => {
          const vals = new Set(row.rs.map((r) => valOf(r, c)));
          const mixed = vals.size > 1;
          const inp = h('input', { class: 'cell' + (row.rs.some((r) => edits.has(r.ref) && c in edits.get(r.ref)) ? ' changed' : ''), value: mixed ? '' : Array.from(vals)[0], placeholder: mixed ? '(several)' : '', spellcheck: 'false', 'data-r': ri, 'data-c': ci });
          inp.addEventListener('input', () => { setVal(row.rs, c, inp.value); inp.classList.add('changed'); });
          inp.addEventListener('keydown', (e) => {
            const go = (dr, dc) => { const n = tb.querySelector(`input[data-r="${ri + dr}"][data-c="${ci + dc}"]`); if (n) { e.preventDefault(); n.focus(); n.select(); } };
            if (e.key === 'ArrowDown' || e.key === 'Enter') go(1, 0); else if (e.key === 'ArrowUp') go(-1, 0);
          });
          inp.addEventListener('paste', (e) => {
            const t = (e.clipboardData || window.clipboardData).getData('text');
            if (!/[\t\n]/.test(t.replace(/\r?\n$/, ''))) return;
            e.preventDefault();
            t.replace(/\r/g, '').replace(/\n$/, '').split('\n').forEach((line, dr) => line.split('\t').forEach((v, dc) => {
              const n = tb.querySelector(`input[data-r="${ri + dr}"][data-c="${ci + dc}"]`);
              if (!n) return; n.value = v; n.dispatchEvent(new Event('input'));
            }));
          });
          tr.append(h('td', null, inp));
        });
        tb.append(tr);
      });
      table.append(tb);
      body.replaceChildren(h('p', { class: 'hint', text: 'Edit any cell; nothing changes until APPLY (one undo step). Group puts parts with the same value and footprint on one row, so one edit sets them all. Paste a block from Excel or Sheets into a cell to fill several. Tap a heading to sort.' }), table);
    }
    function addField() {
      const n = h('input', { class: 'input', placeholder: 'e.g. MPN, Manufacturer, Supplier', autocomplete: 'off' });
      openDialog('ADD A FIELD COLUMN', [h('div', { class: 'field' }, h('label', { text: 'Field name' }), n)], [{ label: 'CANCEL', run: closeDialog }, { label: 'ADD', primary: true, run: () => {
        const v = n.value.trim(); if (!v || v === 'Reference' || cols.includes(v)) { closeDialog(); return; }
        cols.push(v); closeDialog(); render();
      } }]);
      setTimeout(() => n.focus(), 50);
    }
    function csv() {
      const vr = visibleRows();
      const head = ['Reference'].concat(group ? ['Qty'] : [], cols);
      const data = vr.map((row) => [row.refs].concat(group ? [row.rs.length] : [], cols.map((c) => { const vals = new Set(row.rs.map((r) => valOf(r, c))); return vals.size > 1 ? '' : Array.from(vals)[0]; })));
      download(P.name + ' symbol fields.csv', '﻿' + Loom.csv(head, data), 'text/csv;charset=utf-8');
    }
    function apply() {
      // Group the changes by file; a reused sheet's symbol is one symbol, so it is set once.
      const bySheet = new Map();
      for (const [ref, e] of edits) {
        const r = parts.get(ref); if (!r) continue;
        for (const m of r.members) {
          const sh = m.inst.sheet;
          if (!bySheet.has(sh)) bySheet.set(sh, new Map());
          const per = bySheet.get(sh), key = m.sym.uuid;
          if (!per.has(key)) per.set(key, { m, e: {} });
          Object.assign(per.get(key).e, e);
        }
      }
      const results = [];
      for (const [sh0, per] of bySheet) {
        let sh = sh0, r = null;
        for (const { m, e } of per.values()) {
          const sym = sh.symbols.find((x) => x.uuid === m.sym.uuid); if (!sym) continue;
          const fields = {}, add = [];
          for (const [k, v] of Object.entries(e)) { if (sym.props.some((p) => p.name === k)) fields[k] = v; else if (v !== '') add.push({ name: k, value: v }); }
          r = E.setSymbolFields(sh, sym, m.inst, { fields, add });
          sh = E.reparse(sh, r);
        }
        if (r) results.push(r);
      }
      const n = count();
      if (!results.length) return;
      if (run(`Edit ${n} field${n === 1 ? '' : 's'}`, () => results, { anchor: null })) { toast(`Applied ${n} change${n === 1 ? '' : 's'}.`); wrap.remove(); }
    }
    closeReport(); const old = $('fieldsWrap'); if (old) old.remove();
    document.body.append(wrap);
    render();
  }

  // ---- Buses (KiCad: B draws a bus, Z a bus entry, C unfolds a member)
  function busName(o) {
    const sh = state.inst.sheet, P = state.project;
    if (!o || o.group === undefined) return '';
    const l = sh.labels.find((x) => x.group === o.group && (K.isBusName(x.text) || (P.aliases && P.aliases[x.text])));
    if (l) return l.text;
    for (const s of sh.sheets) for (const pn of s.pins) if (sh.buses.some((b) => b.group === o.group && K.onSegment(pn.p, b.a, b.b)) && K.isBusName(pn.name)) return pn.name;
    return '';
  }
  function busMembers(o) { const n = busName(o); return n ? K.expandBus(n, state.project.aliases || {}) : []; }
  function startBus() {
    if (!state.project) return;
    if (state.sel) { state.sel = null; applyHighlight(); renderSelectionUI(); }
    const m = state.mouse && state.mouse.slice();
    setMode('wire'); state.wireKind = 'bus'; renderStatus();
    if (m) wireTap(m, 'mouse');
  }
  function unfoldDialog(o) {
    const members = busMembers(o);
    if (!members.length) { toast('Name the bus first with a label like D[0..7] or {SDA SCL}.'); return; }
    const sh = state.inst.sheet, vertical = Math.abs(o.a[0] - o.b[0]) < 1e-3;
    let p = state.mouse && K.onSegment(gridSnap(state.mouse), o.a, o.b) ? gridSnap(state.mouse) : gridSnap([(o.a[0] + o.b[0]) / 2, (o.a[1] + o.b[1]) / 2]);
    const used = new Set(sh.labels.map((l) => l.text));
    const list = h('div', { class: 'chips unfold' }, ...members.map((m) => h('button', { class: 'chip' + (used.has(m) ? ' on' : ''), onclick: () => {
      closeDialog();
      run('Unfold ' + m, () => E.unfoldFromBus(sh, p, m, vertical), { anchor: null });
    } }, m)));
    openDialog('UNFOLD FROM BUS', [h('p', { class: 'hint', text: `Pick the member to bring out of ${busName(o)}. You get a bus entry, a short wire and the net label${state.mouse ? ', at the pointer' : ', at the middle of the bus'}. Highlighted ones are already labelled on this sheet.` }), list],
      [{ label: 'CANCEL', run: closeDialog }]);
  }
  var ENTRY_DIRS = [[2.54, 2.54], [2.54, -2.54], [-2.54, -2.54], [-2.54, 2.54]];
  function startEntry() {
    if (!state.project) return;
    if (state.sel) { state.sel = null; applyHighlight(); renderSelectionUI(); }
    state.draw = { tool: 'entry', pts: [], dir: (state.draw && state.draw.dir) || 0 };
    setMode('draw'); renderStatus();
  }

  // ---- Hierarchical sheets (KiCad: S draws a sheet; pins come from the sheet's ports)
  function startSheetTool() {
    if (!state.project) return;
    if (state.sel) { state.sel = null; applyHighlight(); renderSelectionUI(); }
    state.draw = { tool: 'sheet', pts: [] };
    setMode('draw'); renderStatus();
  }
  function sheetDialog(a, b) {
    const name = h('input', { class: 'input', id: 'shName', placeholder: 'e.g. Pumps', autocomplete: 'off', spellcheck: 'false' });
    const file = h('input', { class: 'input', id: 'shFile', placeholder: 'pumps.kicad_sch', autocomplete: 'off', spellcheck: 'false' });
    let typed = false;
    name.addEventListener('input', () => { if (!typed) file.value = name.value.trim() ? name.value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') + '.kicad_sch' : ''; });
    file.addEventListener('input', () => { typed = true; });
    const go = () => {
      const n = name.value.trim(); let f = file.value.trim();
      if (!n) { name.focus(); return; }
      if (!f) f = n.toLowerCase().replace(/[^a-z0-9_-]+/g, '_') + '.kicad_sch';
      if (!/\.kicad_sch$/i.test(f)) f += '.kicad_sch';
      if (state.inst.sheet.sheets.some((s) => s.name === n)) { banner('err', 'This sheet already has a sub-sheet called ' + n + '.'); return; }
      closeDialog();
      const p = [Math.min(a[0], b[0]), Math.min(a[1], b[1])], size = [Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])];
      const reuse = state.project.instances.some((i) => i.sheet.path === K.joinPath(K.dirname(state.inst.sheet.path), f));
      const r = run('Add sheet ' + n, () => E.addSheet(state.project, state.inst.sheet, { name: n, file: f, p, size }).results, { anchor: null });
      if (r) toast(reuse ? `Added ${n}, reusing ${f}.` : `Added ${n} with a new file ${f}. Double-tap it to open, then add sheet ports (H).`);
      setMode('select');
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    openDialog('NEW SHEET', [h('div', { class: 'field' }, h('label', { for: 'shName', text: 'Sheet name' }), name), h('div', { class: 'field' }, h('label', { for: 'shFile', text: 'File' }), file),
      h('p', { class: 'hint', text: 'A new file is created and saved with your next commit. Type the name of an existing sheet file to use it again (like KiCad’s reused sheets).' })],
      [{ label: 'CANCEL', run: () => { closeDialog(); drawOverlay(); } }, { label: 'ADD SHEET', primary: true, run: go }]);
    setTimeout(() => name.focus(), 50);
  }
  function childOf(inst, idx) { const sheet = inst.sheet.sheets[idx]; return inst.children.find((c) => c.sheetSym === sheet); }
  // Pins for every sheet port (hierarchical label) in the sub-sheet that has no pin yet: inputs left, the rest right.
  function importSheetPins(inst, idx) {
    const sheet = inst.sheet.sheets[idx], child = childOf(inst, idx);
    if (!child) { toast('That sheet’s file is not in this project.'); return; }
    const have = new Set(sheet.pins.map((p) => p.name));
    const want = [];
    for (const l of child.sheet.labels) if (l.kind === 'hier' && !have.has(l.text) && !want.some((w) => w.name === l.text)) want.push({ name: l.text, shape: l.shape || 'input' });
    if (!want.length) { toast('Every sheet port already has a pin.'); return; }
    const left = want.filter((w) => w.shape === 'input'), right = want.filter((w) => w.shape !== 'input');
    const ls = E.sheetPinSpots(sheet, 'left', left.length), rs = E.sheetPinSpots(sheet, 'right', right.length);
    if (ls.length < left.length || rs.length < right.length) { banner('err', 'The sheet is too short for all its pins. Make it taller in KiCad, or add the pins one at a time.'); return; }
    const pins = left.map((w, i) => ({ name: w.name, shape: w.shape, p: ls[i], side: 'left' })).concat(right.map((w, i) => ({ name: w.name, shape: w.shape, p: rs[i], side: 'right' })));
    if (run(`Import ${pins.length} sheet pin${pins.length === 1 ? '' : 's'}`, () => E.addSheetPins(inst.sheet, sheet, pins))) toast(`Added ${pins.length} pin${pins.length === 1 ? '' : 's'}: ${pins.map((p) => p.name).join(', ')}`);
  }
  // A new pin on the sheet and the matching sheet port inside it, in one step.
  function addSheetPinDialog(inst, idx) {
    const sheet = inst.sheet.sheets[idx], child = childOf(inst, idx);
    if (!child) { toast('That sheet’s file is not in this project.'); return; }
    const name = h('input', { class: 'input', id: 'spName', placeholder: 'e.g. PUMP_ON', autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false' });
    const shape = seg('Direction', [['input', 'INPUT'], ['output', 'OUTPUT'], ['bidirectional', 'BIDIR'], ['passive', 'PASSIVE']], 'input');
    const side = seg('Side', [['left', 'LEFT'], ['right', 'RIGHT']], 'left');
    const go = () => {
      const n = name.value.trim(); if (!n) { name.focus(); return; }
      if (sheet.pins.some((p) => p.name === n)) { banner('err', n + ' already has a pin on this sheet.'); return; }
      const spot = E.sheetPinSpots(sheet, side.get(), 1)[0];
      if (!spot) { banner('err', 'No room left on that side of the sheet.'); return; }
      closeDialog();
      const results = [E.addSheetPins(inst.sheet, sheet, [{ name: n, shape: shape.get(), p: spot, side: side.get() }])];
      if (!child.sheet.labels.some((l) => l.kind === 'hier' && l.text === n)) {
        const cs = child.sheet, taken = (p) => cs.labels.some((l) => E.same(l.p, p));
        let p = [25.4, 25.4]; while (taken(p)) p = [p[0], p[1] + 2.54];
        results.push(E.addLabel(cs, 'hier', n, p, 'right', shape.get()));
      }
      run('Add sheet pin ' + n, () => results);
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    openDialog('ADD SHEET PIN', [h('div', { class: 'field' }, h('label', { for: 'spName', text: 'Signal name' }), name), h('div', { class: 'field' }, h('label', { text: 'Direction' }), shape.el), h('div', { class: 'field' }, h('label', { text: 'Side' }), side.el),
      h('p', { class: 'hint', text: 'Adds the pin to the sheet and a matching sheet port (hierarchical label) inside it, so the net carries straight through.' })],
      [{ label: 'CANCEL', run: closeDialog }, { label: 'ADD PIN', primary: true, run: go }]);
    setTimeout(() => name.focus(), 50);
  }

  // ---- My parts: a simple symbol editor (box parts) kept on this device, in the part library as "My parts"
  const MY_LIB = 'My_Parts';
  async function myParts() { try { return (await Store.get('myParts')) || { symbols: {}, meta: {} }; } catch (e) { return { symbols: {}, meta: {} }; } }
  function mergeMyParts(idx, mp) {
    let li = idx.libs.findIndex((l) => l.name === MY_LIB);
    if (li < 0) { idx.libs.push({ name: MY_LIB, cat: 'My parts', n: 0, user: true }); li = idx.libs.length - 1; }
    idx.rows = idx.rows.filter((r) => r[0] !== li);
    for (const [name, m] of Object.entries(mp.meta)) idx.rows.unshift([li, name, m.desc || '', m.kw || '', m.ref || 'U', 1, m.pins || 0, 0]);
    idx.libs[li].n = Object.keys(mp.meta).length;
    idx.hay = idx.rows.map((r) => (r[1] + ' ' + r[2] + ' ' + r[3] + ' ' + idx.libs[r[0]].name).toLowerCase());
    libState.files.set(MY_LIB, { symbols: Object.assign({}, mp.symbols) });
  }
  function symbolEditor(start) {
    if (!state.project) return;
    // Start from the selected part (its pins and fields), or blank
    let pre = start || null;
    if (!pre && state.sel && state.sel.type === 'symbol') {
      const s = state.sel, sym = s.inst.sheet.symbols[s.si], pins = K.symbolPins(sym);
      const cx = pins.length ? pins.reduce((a, p) => a + p.pos[0], 0) / pins.length : sym.p[0];
      pre = { name: (sym.libName || sym.libId.split(':').pop()) + '_copy', ref: (s.inst.refs[s.si].ref.match(/^[A-Za-z#]+/) || ['U'])[0],
        pins: pins.map((p) => `${p.number} ${p.name && p.name !== '~' ? p.name : '~'} ${p.type || 'passive'} ${p.pos[0] > cx + 0.01 ? 'R' : 'L'}`).join('\n'),
        fields: Object.fromEntries(sym.props.filter((p) => !['Reference', 'Value'].includes(p.name) && !p.name.startsWith('ki_')).map((p) => [p.name, p.value])) };
    }
    pre = pre || { name: '', ref: 'U', pins: '1 +24V power_in L\n2 0V power_in L\n3 IN input L\n4 OUT output R', fields: {} };
    const inp = (id, ph, v) => h('input', { class: 'input', id, placeholder: ph, value: v || '', autocomplete: 'off', spellcheck: 'false' });
    const name = inp('seName', 'e.g. VALVE_DRIVER_4CH', pre.name), ref = inp('seRef', 'U', pre.ref);
    const fp = inp('seFp', 'Footprint (optional)', pre.fields.Footprint), ds = inp('seDs', 'https://… data sheet', pre.fields.Datasheet && pre.fields.Datasheet !== '~' ? pre.fields.Datasheet : '');
    const mfr = inp('seMfr', 'Manufacturer', pre.fields.Manufacturer), mpn = inp('seMpn', 'Part number (MPN)', pre.fields.MPN), desc = inp('seDesc', 'What it is, for the parts list', pre.fields.Description);
    const pinsTa = h('textarea', { class: 'input mono se-pins', id: 'sePins', rows: 10, spellcheck: 'false' }); pinsTa.value = pre.pins;
    const canvas = h('canvas', { class: 'pcanvas' });
    const msg = h('p', { class: 'hint' });
    let pv = null, current = null;
    const build = () => {
      const pins = E.parsePinLines(pinsTa.value);
      const nm = (name.value.trim() || 'NEW_PART').replace(/[\s:"]+/g, '_');
      const fields = { Footprint: fp.value.trim(), Datasheet: ds.value.trim() || '~' };
      if (desc.value.trim()) fields.Description = desc.value.trim();
      if (mfr.value.trim()) fields.Manufacturer = mfr.value.trim();
      if (mpn.value.trim()) fields.MPN = mpn.value.trim();
      for (const [k, v] of Object.entries(pre.fields || {})) if (!(k in fields) && !['Footprint', 'Datasheet', 'Description', 'Manufacturer', 'MPN'].includes(k) && v) fields[k] = v;
      const dupes = pins.map((p) => p.num).filter((n, i, a) => a.indexOf(n) !== i);
      msg.textContent = `${pins.length} pin${pins.length === 1 ? '' : 's'} · ${pins.filter((p) => p.side !== 'R').length} left, ${pins.filter((p) => p.side === 'R').length} right` + (dupes.length ? ` · pin number ${dupes[0]} is used twice` : '');
      msg.classList.toggle('err-text', !!dupes.length);
      current = { name: nm, ref: (ref.value.trim() || 'U').replace(/[^A-Za-z#_]/g, '') || 'U', pins, fields, desc: fields.Description || desc.value.trim(), dupes };
      current.text = E.boxSymbol({ name: nm, ref: current.ref, value: nm, pins, fields, keywords: [mfr.value, mpn.value, desc.value].join(' ').trim() });
      try {
        const { scene } = previewScene({ lib: MY_LIB, name: nm, text: current.text, parentText: null });
        if (!pv) pv = new R.SchematicView(canvas, {});
        pv.setTheme(view.dark); pv.showGrid = false; pv.setScene(scene, true);
        const sy = scene.syms[0]; requestAnimationFrame(() => { pv.resize(); pv.fit(sy ? sy.bb : scene.page, 16); });
      } catch (e) { msg.textContent = e.message; }
    };
    for (const el of [name, ref, fp, ds, mfr, mpn, desc, pinsTa]) el.addEventListener('input', build);
    const save = async (place) => {
      build();
      if (!name.value.trim()) { name.focus(); toast('Give the part a name.'); return; }
      if (!current.pins.length) { pinsTa.focus(); toast('Add at least one pin.'); return; }
      if (current.dupes.length) { toast('Two pins have the number ' + current.dupes[0] + '.'); return; }
      const mp = await myParts();
      mp.symbols[current.name] = current.text;
      mp.meta[current.name] = { desc: current.desc, kw: [mfr.value, mpn.value].join(' '), ref: current.ref, pins: current.pins.length, at: Date.now() };
      await Store.set('myParts', mp);
      const idx = await loadLibIndex(); mergeMyParts(idx, mp);
      wrap.remove();
      toast(`Saved ${current.name} to My parts.`);
      renderDock && renderDock();
      if (place) armStencil({ kind: 'part', lib: MY_LIB, name: current.name });
    };
    const download = () => { build(); downloadText(current.name + '.kicad_sym', E.symbolLibText([current.text])); };
    const field = (label, el) => h('div', { class: 'field' }, h('label', { for: el.id, text: label }), el);
    const wrap = h('div', { class: 'report-wrap', id: 'symEditor', role: 'dialog', 'aria-label': 'New part' },
      h('div', { class: 'report-head' }, h('div', { class: 'titles' }, h('b', { text: pre.name ? 'EDIT PART' : 'NEW PART' }), h('small', { text: 'Saved on this device under My parts' })),
        h('button', { class: 'btn small', onclick: download }, icon('i-download'), '.KICAD_SYM'),
        h('button', { class: 'btn small', onclick: () => save(false) }, icon('i-save'), 'SAVE'),
        h('button', { class: 'btn small primary', onclick: () => save(true) }, icon('i-part'), 'SAVE & PLACE'),
        h('button', { class: 'ib', 'aria-label': 'Close', onclick: () => wrap.remove() }, icon('i-close'))),
      h('div', { class: 'report-body se-body' },
        h('div', { class: 'se-form' },
          h('div', { class: 'se-row' }, field('Part name', name), field('Ref', ref)),
          field('Pins: one per line — number, name, then optional type and side (L or R)', pinsTa),
          h('p', { class: 'hint', text: 'Types: passive, input, output, bidir, power_in, power_out, oc, nc. Example: “3 CAN_H bidir R”. Paste a pin table from a data sheet: number and name columns work as they are.' }),
          field('Description', desc), h('div', { class: 'se-row' }, field('Manufacturer', mfr), field('MPN', mpn)), field('Footprint', fp), field('Data sheet link', ds)),
        h('div', { class: 'se-prev' }, h('div', { class: 'pprev' }, canvas), msg)));
    document.body.append(wrap);
    build();
    setTimeout(() => name.focus(), 60);
  }
  async function myPartsMenu(anchor) {
    const mp = await myParts(), names = Object.keys(mp.meta).sort(K.naturalCmp);
    const items = [{ label: 'New part…', icon: 'i-plus', run: () => symbolEditor() }];
    if (state.sel && state.sel.type === 'symbol') items.push({ label: 'New part from the selected one…', icon: 'i-copy', run: () => symbolEditor() });
    if (names.length) {
      items.push({ sep: true });
      for (const n of names.slice(0, 30)) items.push({ label: 'Place ' + n, icon: 'i-part', run: () => armStencil({ kind: 'part', lib: MY_LIB, name: n }) });
      items.push({ sep: true });
      items.push({ label: 'Edit a part…', icon: 'i-edit', run: () => pickName('EDIT WHICH PART?', names, async (n) => { const m = (await myParts()); symbolEditor(partToPre(n, m)); }) });
      items.push({ label: 'Delete a part…', icon: 'i-trash', run: () => pickName('DELETE WHICH PART?', names, async (n) => { const m = await myParts(); delete m.symbols[n]; delete m.meta[n]; await Store.set('myParts', m); const idx = await loadLibIndex(); mergeMyParts(idx, m); toast('Deleted ' + n + ' from My parts. Sheets that use it keep their copy.'); }) });
      items.push({ label: 'Download all as .kicad_sym', icon: 'i-download', run: () => downloadText('My_Parts.kicad_sym', E.symbolLibText(names.map((n) => mp.symbols[n]))) });
    }
    openMenu(anchor, items);
  }
  function partToPre(n, m) {
    const tree = K.parseSexpr(m.symbols[n]), props = {};
    for (const p of K.findAll(tree, 'property')) props[p[1]] = p[2];
    const pins = [];
    const walk = (node) => { for (const c of node) if (Array.isArray(c)) { if (c[0] === 'pin') { const at = K.find(c, 'at'); pins.push(`${(K.find(c, 'number') || [])[1]} ${(K.find(c, 'name') || [])[1] || '~'} ${c[1]} ${+at[3] === 180 ? 'R' : 'L'}`); } else walk(c); } };
    walk(tree);
    const fields = {}; for (const [k, v] of Object.entries(props)) if (!['Reference', 'Value', 'ki_keywords'].includes(k)) fields[k] = v;
    return { name: n, ref: props.Reference || 'U', pins: pins.join('\n'), fields };
  }
  function pickName(title, names, fn) {
    openDialog(title, [h('div', { class: 'chips unfold' }, ...names.map((n) => h('button', { class: 'chip', onclick: () => { closeDialog(); fn(n); } }, n)))], [{ label: 'CANCEL', run: closeDialog }]);
  }
  // ---- Print, PDF and SVG export of the sheets (KiCad: File → Print / Plot)
  let fontCssCache = null;
  async function embeddedFontCss() {   // the drawing font, inside each SVG so it looks the same anywhere
    if (fontCssCache !== null) return fontCssCache;
    const b64 = async (u) => { const b = new Uint8Array(await (await fetch(u)).arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
    try {
      const w = await Promise.all([400, 600].map((n) => b64('fonts/ibm-plex-sans-condensed-latin-' + n + '-normal.woff2')));
      fontCssCache = w.map((d, i) => `@font-face{font-family:"Plex Condensed";font-weight:${i ? 600 : 400};src:url(data:font/woff2;base64,${d}) format("woff2")}`).join('');
    } catch (e) { fontCssCache = ''; }
    return fontCssCache;
  }
  const sheetLabel = (inst) => inst.parent ? inst.name : (inst.orphan ? inst.name : 'Root');
  function outputSheets(which) {
    const P = state.project;
    return which === 'this' ? [state.inst] : P.instances.slice().sort((a, b) => a.order - b.order);
  }
  async function sheetSVGs(list, o) {
    const out = [];
    for (const inst of list) {
      const S = state.scenes.get(inst.idx) || R.buildScene(state.project, inst);
      await R.loadSceneImages(S);
      const an = state.A && (o.wireNos || o.xrefs) ? annotFor(inst, S, { wireNos: o.wireNos, xrefs: o.xrefs }) : null;
      out.push({ inst, S, svg: R.sceneToSVG(S, { mono: o.mono, annot: an, fontCss: o.fontCss, title: state.project.name + ' · ' + inst.page + ' · ' + sheetLabel(inst) }) });
    }
    return out;
  }
  async function printSheets(o) {
    const list = outputSheets(o.which);
    if (list.length > 3) toast('Preparing ' + list.length + ' sheets…');
    const sv = await sheetSVGs(list, o);
    const old = $('printSheets'); if (old) old.remove();
    const oldCss = $('printSheetsCss'); if (oldCss) oldCss.remove();
    const sizes = new Map(), wrap = h('div', { id: 'printSheets' });
    for (const x of sv) {
      const W = x.S.page[2], H = x.S.page[3], key = 'll' + Math.round(W * 10) + 'x' + Math.round(H * 10);
      sizes.set(key, [W, H]);
      const d = h('div', { class: 'psheet' }); d.style.page = key; d.style.width = W + 'mm'; d.style.height = H + 'mm';
      d.innerHTML = x.svg; wrap.append(d);
    }
    const css = h('style', { id: 'printSheetsCss' });
    css.textContent = [...sizes].map(([k, [W, H]]) => `@page ${k} { size: ${W}mm ${H}mm; margin: 0; }`).join('\n');
    document.head.append(css); document.body.append(wrap);
    document.body.classList.add('printing-sheets');
    try { await document.fonts.ready; } catch (e) { /* print anyway */ }
    const done = () => { document.body.classList.remove('printing-sheets'); wrap.remove(); css.remove(); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    setTimeout(() => window.print(), 60);
  }
  async function downloadSheetSVGs(o) {
    const list = outputSheets(o.which), P = state.project;
    const sv = await sheetSVGs(list, Object.assign({}, o, { fontCss: await embeddedFontCss() }));
    const base = slug(P.name), name = (x) => `${base}-p${slug(String(x.inst.page))}-${slug(sheetLabel(x.inst))}.svg`;
    if (sv.length === 1) { download(name(sv[0]), sv[0].svg, 'image/svg+xml'); toast('Downloaded ' + name(sv[0])); return; }
    const blob = Zip.writeZip(sv.map((x) => ({ path: name(x), text: x.svg })));
    const a = h('a', { href: URL.createObjectURL(blob), download: base + '-sheets-svg.zip' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Downloaded ' + sv.length + ' sheets as SVG (zip)');
  }
  function printDialog() {
    const P = state.project; if (!P) return;
    const n = P.instances.length;
    const pref = Store.pref('printOpts') || {};
    const which = seg('Sheets', [['this', 'THIS SHEET'], ['all', n === 1 ? 'ALL (1)' : 'ALL ' + n]], n === 1 ? 'this' : (pref.which || 'all'));
    const colour = seg('Colour', [['colour', 'COLOUR'], ['mono', 'BLACK & WHITE']], pref.mono ? 'mono' : 'colour');
    const wn = h('input', { type: 'checkbox', checked: pref.wireNos !== undefined ? pref.wireNos : !!show.wireNos });
    const xr = h('input', { type: 'checkbox', checked: pref.xrefs !== undefined ? pref.xrefs : !!show.xrefs });
    const opts = () => { const o = { which: which.get(), mono: colour.get() === 'mono', wireNos: wn.checked, xrefs: xr.checked }; Store.pref('printOpts', o); return o; };
    const go = (fn) => async () => { const o = opts(); closeDialog(); try { await fn(o); } catch (e) { console.error(e); toast('Could not export: ' + e.message); } };
    openDialog('PRINT / EXPORT', [
      h('div', { class: 'field' }, h('label', { text: 'Sheets' }), which.el),
      h('div', { class: 'field' }, h('label', { text: 'Colour' }), colour.el),
      h('label', { class: 'check' }, wn, 'Wire numbers'),
      h('label', { class: 'check' }, xr, 'Cross-references between part units'),
      h('p', { class: 'hint', text: 'PRINT / PDF opens the system print dialog: pick a printer, or Save as PDF. Each sheet prints on its own page at its KiCad paper size (A4, A3…), true to scale. SVG downloads vector drawings (a zip for several sheets) that open in a browser, Inkscape or Illustrator. Unsaved edits are included.' })
    ], [{ label: 'CANCEL', run: closeDialog }, { label: 'SVG', run: go(downloadSheetSVGs) }, { label: 'PRINT / PDF', primary: true, run: go(printSheets) }]);
  }
  function downloadText(name, text) { download(name, text, 'text/plain;charset=utf-8'); toast('Downloaded ' + name); }

  // ---- Design blocks (KiCad 9: Shift+B): named, reusable copies of a selection, kept on this device
  async function blocks() { try { return (await Store.get('designBlocks')) || {}; } catch (e) { return {}; } }
  function saveBlockDialog() {
    const items = copyItemsOfSel();
    if (!items || !items.length) { toast('Select what to save first (box-select a group of parts and wires).'); return; }
    const clip = E.copyItems(state.inst.sheet, items);
    const name = h('input', { class: 'input', id: 'blkName', placeholder: 'e.g. M12 sensor drop', autocomplete: 'off' });
    const go = async () => {
      const n = name.value.trim(); if (!n) { name.focus(); return; }
      const b = await blocks(); b[n] = { clip, at: Date.now(), from: state.project.name };
      await Store.set('designBlocks', b); closeDialog(); toast(`Saved design block “${n}”.`);
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    openDialog('SAVE DESIGN BLOCK', [h('div', { class: 'field' }, h('label', { for: 'blkName', text: 'Block name' }), name), h('p', { class: 'hint', text: `${clipTextOf(clip)} will be saved on this device. Place it on any sheet of any project with Shift+B or Insert → Blocks; parts get fresh references.` })],
      [{ label: 'CANCEL', run: closeDialog }, { label: 'SAVE', primary: true, run: go }]);
    setTimeout(() => name.focus(), 50);
  }
  function clipTextOf(c) { const n = c && c.items ? c.items.length : 0; return n + ' item' + (n === 1 ? '' : 's'); }
  async function placeBlock(n) {
    const b = await blocks(); if (!b[n]) return;
    state.clip = b[n].clip; renderRibbon(); startPaste();
    toast(`Tap where “${n}” goes.`);
  }
  async function blocksMenu(anchor) {
    const b = await blocks(), names = Object.keys(b).sort(K.naturalCmp);
    const items = [{ label: 'Save selection as a block…', icon: 'i-save', run: saveBlockDialog }];
    if (names.length) {
      items.push({ sep: true });
      for (const n of names.slice(0, 30)) items.push({ label: n, icon: 'i-box', run: () => placeBlock(n) });
      items.push({ sep: true });
      items.push({ label: 'Delete a block…', icon: 'i-trash', run: () => pickName('DELETE WHICH BLOCK?', names, async (n) => { const x = await blocks(); delete x[n]; await Store.set('designBlocks', x); toast('Deleted ' + n); }) });
      items.push({ label: 'Export blocks (to share)', icon: 'i-download', run: () => downloadText('loomline-design-blocks.json', JSON.stringify({ loomlineBlocks: 1, blocks: b }, null, 1)) });
    }
    items.push({ label: 'Import blocks…', icon: 'i-open', run: importBlocks });
    openMenu(anchor, items);
  }
  function importBlocks() {
    const f = h('input', { type: 'file', accept: '.json,application/json' });
    f.addEventListener('change', async () => {
      try {
        const data = JSON.parse(await f.files[0].text());
        if (!data || !data.blocks) throw new Error('That isn’t a Loomline blocks file.');
        const b = await blocks(); let n = 0;
        for (const [k, v] of Object.entries(data.blocks)) if (v && v.clip && v.clip.items) { b[k] = v; n++; }
        await Store.set('designBlocks', b); toast(`Imported ${n} block${n === 1 ? '' : 's'}.`);
      } catch (e) { banner('err', e.message); }
    });
    f.click();
  }

  // ---- Measure (KiCad: Ctrl+Shift+M)
  const fmtMm = (v) => (Math.round(v * 100) / 100).toFixed(2) + ' mm';
  function measureText(a, b) { const dx = b[0] - a[0], dy = b[1] - a[1]; return `${fmtMm(Math.hypot(dx, dy))}  ·  dx ${fmtMm(Math.abs(dx))}  dy ${fmtMm(Math.abs(dy))}`; }
  function startMeasure() { if (!state.project) return; if (state.sel) clearSelection(); state.measure = { a: null, b: null }; setMode('measure'); }
  function measureTap(wp, type) {
    const p = snapPoint(wp, type).p, m = state.measure || (state.measure = { a: null, b: null });
    if (!m.a || m.b) { m.a = p; m.b = null; } else m.b = p;
    measureDraw(m.b || p);
  }
  function measureDraw(to) {
    const m = state.measure; if (!m || !m.a) { view.overlay = { pts: [], dots: [] }; view.redraw(); renderStatus(); return; }
    const b = m.b || to;
    view.overlay = { pts: b ? [m.a, b] : [], dots: [m.a].concat(m.b ? [m.b] : []), ring: b || null };
    view.redraw();
    $('st2').textContent = b ? measureText(m.a, b) : 'Tap the second point';
  }

  // ---- Swap (KiCad: Alt+S) two parts or two labels
  function swapSel() {
    const s = state.sel;
    if (!s || s.type !== 'multi') { toast('Box-select two parts (or two labels) to swap them.'); return; }
    const r = multiResolve(s.m), its = r.items.filter((x) => x.type === 'symbol' || x.type === 'label');
    if (its.length !== 2 || its[0].type !== its[1].type) { toast('Select exactly two parts, or two labels, to swap.'); return; }
    const pos = (x) => (x.sym || x.label).p, a = pos(its[0]), b = pos(its[1]), d = [b[0] - a[0], b[1] - a[1]];
    const uid = (x) => x.type === 'symbol' ? x.sym.uuid : uuidOf(x.label);
    const u2 = uid(its[1]);
    run('Swap', () => {
      const sh = state.inst.sheet;
      const r1 = E.moveItems(sh, [its[0]], d, { keepWires: false });
      const sh2 = E.reparse(sh, r1);
      const second = its[1].type === 'symbol' ? { type: 'symbol', sym: sh2.symbols.find((x) => x.uuid === u2) } : { type: 'label', label: sh2.labels.find((x) => uuidOf(x) === u2) };
      return E.moveItems(sh2, [second], [-d[0], -d[1]], { keepWires: false });
    }, { checkMerges: true });
  }

  // ---- Autoplace fields (KiCad: O)
  function autoplaceSel() {
    if (!hoverSelect() || state.sel.type !== 'symbol') { toast('Point at a part or select it first.'); return; }
    const s = state.sel, sh = s.inst.sheet, sym = sh.symbols[s.si];
    const sc = sceneFor(s.inst).syms.find((q) => q.si === s.si);
    const body = sc && (sc.body && (sc.body[2] - sc.body[0]) * (sc.body[3] - sc.body[1]) > 0.5 ? sc.body : sc.bb);
    if (!body) return;
    const pins = K.symbolPins(sym).map((p) => p.pos);
    const all = pins.reduce((b, p) => [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])], body.slice());
    const shown = sym.props.filter((p) => !p.name.startsWith('ki_') && p.value !== '' && !(p.fx && p.fx.hide));
    const order = ['Reference', 'Value'];
    shown.sort((a, b) => (order.indexOf(a.name) + 1 || 9) - (order.indexOf(b.name) + 1 || 9));
    if (!shown.length) { toast('No visible fields to place.'); return; }
    const pitch = 2.54, cx = (body[0] + body[2]) / 2, cy = (body[1] + body[3]) / 2;
    const right = pins.some((p) => p[0] > body[2] + 0.1), top = pins.some((p) => p[1] < body[1] - 0.1), bottom = pins.some((p) => p[1] > body[3] + 0.1);
    const place = {};
    const r = (v) => Math.round(v / 0.635) * 0.635;
    if (!right) {
      const x = r(body[2] + 1.27), y0 = cy - (shown.length - 1) * pitch / 2;
      shown.forEach((p, i) => { place[p.name] = { p: [x, r(y0 + i * pitch)], justify: 'left' }; });
    } else if (!top && !bottom) {
      place[shown[0].name] = { p: [r(cx), r(body[1] - 1.905)], justify: 'center' };
      shown.slice(1).forEach((p, i) => { place[p.name] = { p: [r(cx), r(body[3] + 1.905 + i * pitch)], justify: 'center' }; });
    } else {
      const x = r(all[2] + 1.27), y0 = cy - (shown.length - 1) * pitch / 2;
      shown.forEach((p, i) => { place[p.name] = { p: [x, r(y0 + i * pitch)], justify: 'left' }; });
    }
    run('Autoplace fields of ' + s.inst.refs[s.si].ref, () => E.placeFields(sh, sym, place));
  }

  // ---- Repeat the last item with the label number counted on (KiCad: Insert)
  var REPEAT_STEP = [0, 2.54];
  function incrementName(t) { const m = /^(.*?)(\d+)(\D*)$/.exec(t); if (!m) return t; const n = String(+m[2] + 1).padStart(m[2].length, '0'); return m[1] + n + m[3]; }
  function repeatLast() {
    const L = state.lastPlaced;
    if (L && L.type === 'label' && L.sheet === state.inst.sheet.path) {
      const p = [L.p[0] + REPEAT_STEP[0], L.p[1] + REPEAT_STEP[1]], text = incrementName(L.text);
      if (run('Add label ' + text, () => E.addLabel(state.inst.sheet, L.kind, text, p, L.spin, L.shape), { anchor: null })) state.lastPlaced = Object.assign({}, L, { p, text });
      return;
    }
    if (L && L.type === 'symbol' && L.sheet === state.inst.sheet.path) {
      const sym = state.inst.sheet.symbols.find((x) => x.uuid === L.uuid);
      if (sym) {
        const before = new Set(state.inst.sheet.symbols.map((x) => x.uuid));
        if (run('Repeat ' + (sym.libName || sym.libId), () => E.copySymbol(state.project, state.inst.sheet, state.inst, sym, REPEAT_STEP), { anchor: null })) {
          const n = state.inst.sheet.symbols.find((x) => !before.has(x.uuid));
          if (n) state.lastPlaced = { type: 'symbol', uuid: n.uuid, sheet: state.inst.sheet.path };
        }
        return;
      }
    }
    const k = (Store.pref('recentStencils') || [])[0], st = k && stencilFromKey(k);
    if (!st) { toast('Nothing placed yet to repeat.'); return; }
    if (state.mouse) dropStencil(st, state.mouse.slice()); else armStencil(st);
  }

  // ---- Snap grid (KiCad: N / Shift+N)
  var GRIDS = [0.635, 1.27, 2.54, 5.08];
  E.setSnapGrid(GRIDS.includes(Store.pref('snapGrid')) ? Store.pref('snapGrid') : 1.27);
  function stepGrid(d) {
    const i = GRIDS.indexOf(E.snapGrid()), g = GRIDS[Math.max(0, Math.min(GRIDS.length - 1, (i < 0 ? 1 : i) + d))];
    E.setSnapGrid(g); Store.pref('snapGrid', g); renderScale();
    toast(`Snap grid ${g} mm (${Math.round(g / 0.0254)} mil)` + (g < 1.27 ? ' · pins sit on 1.27 mm, so wires may miss them' : ''));
  }

  // ---- Back / forward between sheets (KiCad: Alt+Left / Alt+Right)
  state.navBack = []; state.navFwd = [];
  function navGo(fromList, toList) {
    while (fromList.length) {
      const np = fromList.pop(), inst = state.project.instances.find((i) => i.namePath === np);
      if (!inst || inst === state.inst) continue;
      toList.push(state.inst.namePath);
      state._navSkip = true; showInstance(inst); state._navSkip = false;
      return;
    }
    toast('No more sheets that way.');
  }
  // Back / Forward light up only when there is a sheet that way (same as KiCad's toolbar arrows)
  function navLive(list) { return !!(state.project && list && list.some((np) => state.inst && np !== state.inst.namePath && state.project.instances.some((i) => i.namePath === np))); }
  function navButtons() {
    const b = $('btnBack'), f = $('btnFwd'); if (!b || !f) return;
    b.disabled = !navLive(state.navBack); f.disabled = !navLive(state.navFwd);
    const prev = (list) => { const np = list && list[list.length - 1]; const i = np && state.project && state.project.instances.find((x) => x.namePath === np); return i ? ' – ' + (i.parent ? i.name : 'Root') : ''; };
    b.title = 'Back to the previous sheet' + prev(state.navBack) + ' (Alt+←)';
    f.title = 'Forward to the next sheet' + prev(state.navFwd) + ' (Alt+→)';
  }

  // ---- Wire angle (KiCad: Shift+Space cycles 90°, 45° and free angle)
  var POSTURES = ['90', '45', 'free'];
  state.wirePosture = POSTURES.includes(Store.pref('wirePosture')) ? Store.pref('wirePosture') : '90';
  function cyclePosture() {
    state.wirePosture = POSTURES[(POSTURES.indexOf(state.wirePosture) + 1) % POSTURES.length];
    Store.pref('wirePosture', state.wirePosture);
    toast('Wires: ' + ({ 90: 'right angles', 45: '45° corners', free: 'any angle' })[state.wirePosture]);
    if (state.mode === 'wire') updateWireOverlay();
  }

  // ------------------------------------------------------------------ keyboard (KiCad 9 default hotkeys)
  // Same keys as KiCad's schematic editor, so desktop users can work the way they already do. With
  // nothing selected, a key acts on whatever is under the mouse pointer, like KiCad.
  const HOTKEYS = [
    ['Selection and editing', [
      ['E', 'Properties (edit fields, rename a label, text)'], ['M', 'Move: follows the mouse, click to drop (wires stay put)'], ['G', 'Drag: like move, wires stretch to follow'],
      ['R', 'Rotate'], ['X', 'Mirror horizontally'], ['Y', 'Mirror vertically'], ['V', 'Edit value'], ['U', 'Edit reference designator'], ['F', 'Edit footprint'],
      ['D', 'Show data sheet'], ['O', 'Autoplace fields'], ['Alt+S', 'Swap two selected parts or labels'], ['Del', 'Delete'], ['Ctrl+C', 'Copy'], ['Ctrl+X', 'Cut'], ['Ctrl+V', 'Paste'], ['Ctrl+D', 'Duplicate'],
      ['Ctrl+A', 'Select all'], ['Ctrl+Shift+A', 'Unselect all'], ['Ctrl+Z', 'Undo'], ['Ctrl+Y / Ctrl+Shift+Z', 'Redo'], ['Esc', 'Cancel the tool / clear the selection']]],
    ['Placing', [
      ['A', 'Add a symbol'], ['P', 'Add a power symbol'], ['W', 'Draw wires (starts at the pointer)'], ['J', 'Junction'], ['Q', 'No-connect flag'],
      ['L', 'Net label'], ['Ctrl+L', 'Global label (off-sheet)'], ['H', 'Hierarchical label (sheet port)'], ['T', 'Text'], ['I', 'Draw lines'], ['B', 'Draw a bus'], ['Z', 'Bus entry (R turns it)'], ['C', 'Unfold a member from the bus under the pointer'], ['S', 'New hierarchical sheet'], ['Shift+B', 'Design blocks: place a saved block or save the selection'],
      ['Ins', 'Repeat the last item (label numbers count on: IN1, IN2…)'], ['Shift+Space', 'Wire angle: 90°, 45° or any'], ['/', 'Switch wire posture (while drawing)'], ['Backspace', 'Undo the last wire segment (while drawing)'], ['End / Enter', 'Finish the wire or shape']]],
    ['Nets', [['`', 'Highlight the net under the pointer'], ['~', 'Clear net highlighting']]],
    ['View and sheets', [
      ['Home', 'Zoom to fit the sheet'], ['Ctrl+Home', 'Zoom to the objects'], ['F1 / F2', 'Zoom in / out at the pointer'], ['+ / -', 'Zoom in / out'],
      ['F4', 'Centre on the pointer'], ['Ctrl+F5', 'Zoom to the selection'], ['Arrows, Shift+Arrows', 'Pan'],
      ['PgDn / PgUp', 'Next / previous sheet'], ['Alt+Left / Alt+Right', 'Back / forward through sheets you visited (and the mouse’s back / forward buttons)'], ['N / Shift+N', 'Next / previous snap grid'], ['Alt+Backspace, Alt+Up', 'Leave sheet (up a sheet)'], ['Ctrl+H', 'Hierarchy (sheet list)']]],
    ['Project', [['Ctrl+F, /', 'Find'], ['Ctrl+Alt+F', 'Find and replace'], ['Ctrl+Shift+M', 'Measure'], ['Ctrl+S', 'Save edits'], ['Ctrl+P', 'Print, PDF or SVG of the sheets'], ['Ctrl+F1, ?', 'This list of keys']]]
  ];
  // Ribbon tooltips show the key
  const RB_KEYS = { 'Copy': 'Ctrl+C', 'Paste': 'Ctrl+V', 'Duplicate': 'Ctrl+D', 'Select all': 'Ctrl+A', 'Delete': 'Del', 'Move': 'M', 'Rotate': 'R',
    'Mirror ↔': 'X', 'Mirror ↕': 'Y', 'Edit': 'E', 'Find': 'Ctrl+F', 'Fit': 'Home', 'Zoom to': 'Ctrl+F5', 'Up a sheet': 'Alt+Backspace', 'Back sheet': 'Alt+←', 'Forward sheet': 'Alt+→', 'Add part': 'A',
    'Power': 'P', 'Draw wire': 'W', 'Line': 'I', 'Text': 'T', 'Net label': 'L', 'Off-sheet': 'Ctrl+L', 'Sheet port': 'H', 'Junction': 'J', 'No-connect': 'Q', 'Keys': 'Ctrl+F1', 'Find & replace': 'Ctrl+Alt+F', 'Measure': 'Ctrl+Shift+M', 'Swap': 'Alt+S', 'Autoplace': 'O', 'Draw bus': 'B', 'Bus entry': 'Z', 'New sheet': 'S', 'Blocks': 'Shift+B', 'Print / PDF': 'Ctrl+P' };
  function showHotkeys() {
    const body = HOTKEYS.map(([title, keys]) => h('div', { class: 'hk-group' }, h('h4', { text: title }),
      h('table', { class: 'hk' }, ...keys.map(([k, d]) => h('tr', {}, h('td', {}, ...k.split(/(, | \/ )/).map((p) => /^(, | \/ )$/.test(p) ? p : h('kbd', { text: p }))), h('td', { text: d }))))));
    openDialog('KEYBOARD SHORTCUTS', [h('p', { class: 'hint', text: 'The same keys as KiCad’s schematic editor. With nothing selected, a key acts on what is under the mouse pointer.' }), ...body],
      [{ label: 'CLOSE', primary: true, run: closeDialog }]);
  }
  const overCanvas = () => !!state.mouse && state.mode !== 'paste';
  // Nothing selected: select what is under the pointer (KiCad acts on the hovered item)
  function hoverSelect() {
    if (state.sel) return true;
    if (!state.mouse || !state.inst || (state.mode !== 'select' && state.mode !== 'move')) return false;
    const hit = view.hitTest(state.mouse, 8);
    if (!hit) return false;
    if (hit.type === 'net' && hit.it && /^[UE]\d/.test(hit.it)) selectGraphic(state.inst, hit.it);
    else if (hit.type === 'net') { const net = state.project.nets[state.inst.netOf[hit.g]]; if (net) selectNet(net, itemFromTag(hit.it)); }
    else if (hit.type === 'symbol') selectSymbol(state.inst, hit.si);
    else if (hit.type === 'sheet') selectSheet(state.inst, hit.idx);
    else if (hit.type === 'graphic') selectGraphic(state.inst, hit.it);
    return !!state.sel;
  }
  function keyAction(re, what) {
    if (!hoverSelect()) { toast('Point at something or select it first.'); return null; }
    const a = selectionActions().find((x) => re.test(x.label));
    if (!a) { toast(what + ' isn’t available for this item.'); return null; }
    a.run();
    return a;
  }
  function keyMoveStart(keep) {
    if (!keyAction(/^MOVE$/, 'Move')) return;
    if (state.mode !== 'move') return;
    if (state.moveTarget) state.moveTarget.keepWires = keep;
    if (state.mouse) { state.keyMove = { from: state.mouse.slice() }; toast((keep ? 'Drag: wires follow. ' : 'Move: wires stay put (G drags them along). ') + 'Click to drop, Esc cancels.'); }
  }
  function keyMoveHover(wp) {
    if (state.mode !== 'move' || !state.keyMove || !view.dragHandler) return;
    const f = state.keyMove.from; view.dragHandler.move([wp[0] - f[0], wp[1] - f[1]]);
  }
  function keyMoveDrop(wp) {
    const f = state.keyMove.from; state.keyMove = null;
    if (view.dragHandler) view.dragHandler.end([wp[0] - f[0], wp[1] - f[1]]);
    if (state.mode === 'move') setMode('select');
  }
  function editField(name) {
    if (!hoverSelect()) { toast('Point at a part or select it first.'); return; }
    const s = state.sel;
    if (s.type === 'symbol') fieldsDialog(s.inst, s.si, name);
    else keyAction(/^(EDIT|RENAME|STYLE|CABLE)$/, 'Editing');
  }
  function showDatasheet() {
    if (!hoverSelect() || state.sel.type !== 'symbol') { toast('Point at a part or select it first.'); return; }
    const s = state.sel, sym = s.inst.sheet.symbols[s.si], p = sym.props.find((x) => x.name === 'Datasheet'), url = p && p.value.trim();
    if (url && /^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener');
    else toast('No data sheet link on ' + s.inst.refs[s.si].ref + '.');
  }
  function keyPlace(id) {
    const st = stencilById(id); if (!st) return;
    const mouse = state.mouse && state.mouse.slice();
    armStencil(st);
    if (!mouse) return;
    const s = snapPoint(mouse, 'mouse');
    const onConductor = s.on && s.on !== 'label';
    if (st.kind === 'text' || ((st.kind === 'label' || st.kind === 'junction') && onConductor) || (st.kind === 'nc' && s.on === 'pin')) placeStencil(st, mouse, 'mouse');
  }
  function stepSheet(d) {
    const list = state.project.instances.slice().sort((a, b) => a.order - b.order), i = list.indexOf(state.inst), n = list[i + d];
    if (n) { showInstance(n); toast(n.page + '/' + state.project.pageCount + ' · ' + n.name); }
  }
  function mouseScreen() { return state.mouse ? [state.mouse[0] * view.scale + view.ox, state.mouse[1] * view.scale + view.oy] : [$('canvas').clientWidth / 2, $('canvas').clientHeight / 2]; }
  function panBy(dx, dy) { view.ox += dx; view.oy += dy; view.redraw(); }
  function hotkey(e) {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
      if (e.key === 'Escape' && t.closest && t.closest('#pickerWrap')) closePicker();
      else if (e.key === 'Escape' && t.closest && t.closest('#dialogWrap')) closeDialog();
      else if (e.key === 'Escape' && t.closest && t.closest('#fieldsWrap')) $('fieldsWrap').querySelector('.report-head .ib').click();
      return;
    }
    const ctrl = e.ctrlKey || e.metaKey, sh = e.shiftKey, alt = e.altKey, key = e.key, k = key.length === 1 ? key.toLowerCase() : key;
    const done = () => { e.preventDefault(); e.stopPropagation(); };
    const modal = $('dialogWrap') || $('pickerWrap') || $('reportWrap') || $('fieldsWrap') || $('symEditor') || !$('search').hidden;
    if (key === 'Escape') {
      if ($('dialogWrap')) { closeDialog(); return; }
      if ($('pickerWrap')) { closePicker(); return; }
      if ($('fieldsWrap')) { $('fieldsWrap').querySelector('.report-head .ib').click(); return; }
      if ($('symEditor')) { $('symEditor').remove(); return; }
      if ($('reportWrap')) { closeReport(); return; }
      if (!$('search').hidden) { closeSearch(); return; }
      if (state.mode !== 'select') { setMode('select'); return; }
      if (!$('scrim').hidden) closeDrawers(); else if (!state.sel && immersive.on) setImmersive(false); else clearSelection();
      return;
    }
    if ((ctrl && key === 'F1') || (key === '?' && !ctrl)) { done(); if (!$('dialogWrap')) showHotkeys(); return; }
    if (modal) return;
    if (ctrl && alt && (k === 'f' || e.code === 'KeyF') && !modal && state.project) { done(); replaceDialog(); return; }
    if (ctrl && (k === 'f' || k === 'g')) { done(); openSearch(); return; }
    if (!ctrl && !alt && key === '/' && state.mode !== 'wire') { done(); openSearch(); return; }
    if (!state.project) return;
    const P = state.project;
    // ---- with Ctrl / Cmd
    if (ctrl && !alt) {
      if (k === 'p' && !sh) { done(); printDialog(); return; }
      if (k === 'z') { done(); if (sh) redo(); else undo(); return; }
      if (k === 'y') { done(); redo(); return; }
      if (k === 's') { done(); const c = $('chipEdits'); if (c && !c.hidden) c.click(); else toast('No unsaved edits.'); return; }
      if (k === 'a' && sh) { done(); clearSelection(); return; }
      if (k === 'a') { done(); if (state.mode !== 'box') setMode('box'); selectAll(); return; }
      if (k === 'c' && !sh) { if (!hoverSelect() || !canCopy()) return; done(); copySel(); return; }
      if (k === 'x') { if (!hoverSelect() || !canCopy()) return; done(); copySel(); const a = selectionActions().find((x) => x.label === 'DELETE'); if (a) a.run(); return; }
      if (k === 'v') { if (!state.clip) return; done(); startPaste(); return; }
      if (k === 'd') { done(); if (hoverSelect() && canCopy()) duplicateSel(); else keyAction(/^DUPLICATE$/, 'Duplicate'); return; }
      if (k === 'l') { done(); keyPlace('l-glob'); return; }
      if (k === 'h') { done(); $('btnSheets').click(); return; }
      if (k === 'm' && sh) { done(); startMeasure(); return; }
      if (key === 'Home') { done(); view.fit(); return; }
      if (key === 'F5') { done(); if (state.sel) zoomToSelection(); return; }
      return;
    }
    // ---- with Alt
    if (alt) {
      if ((key === 'Backspace' || key === 'ArrowUp') && state.inst.parent) { done(); showInstance(state.inst.parent); return; }
      if (key === 'ArrowLeft') { done(); navGo(state.navBack, state.navFwd); return; }
      if (key === 'ArrowRight') { done(); navGo(state.navFwd, state.navBack); return; }
      if (e.code === 'KeyS') { done(); swapSel(); return; }
      return;
    }
    // ---- while drawing a wire or a shape
    if (state.mode === 'wire') {
      if (key === '/') { done(); wireFlip(); return; }
      if (key === 'Backspace') { done(); wireBack(); return; }
      if (key === 'End' || key === 'Enter') { done(); finishWire(); return; }
    }
    if (key === ' ' && sh) { done(); cyclePosture(); return; }
    if (state.mode === 'draw' && state.draw) {
      if ((key === 'End' || key === 'Enter') && state.draw.tool === 'line' && state.draw.pts.length > 1) { done(); finishLine(); return; }
      if (key === 'Backspace' && state.draw.pts.length) { done(); state.draw.pts.pop(); drawOverlay(); renderStatus(); return; }
    }
    if (state.mode === 'move' && state.keyMove && (key === 'Enter' || key === 'End') && state.mouse) { done(); keyMoveDrop(state.mouse); return; }
    // ---- plain keys
    switch (key) {
      case 'Delete': done(); keyAction(/^DELETE$/, 'Delete'); return;
      case 'Backspace': if (state.inst.parent) { done(); showInstance(state.inst.parent); } return;
      case 'Insert': done(); repeatLast(); return;
      case 'Home': done(); if (view.scene) view.fit(view.scene.page, 12); return;
      case 'F1': { done(); const m = mouseScreen(); view.zoomBy(1.4, m[0], m[1]); return; }
      case 'F2': { done(); const m = mouseScreen(); view.zoomBy(1 / 1.4, m[0], m[1]); return; }
      case 'F4': { done(); const m = mouseScreen(); panBy($('canvas').clientWidth / 2 - m[0], $('canvas').clientHeight / 2 - m[1]); return; }
      case 'PageDown': done(); stepSheet(1); return;
      case 'PageUp': done(); stepSheet(-1); return;
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
        done(); const st = (sh ? 0.5 : 0.15) * Math.min($('canvas').clientWidth, $('canvas').clientHeight);
        panBy(key === 'ArrowLeft' ? st : key === 'ArrowRight' ? -st : 0, key === 'ArrowUp' ? st : key === 'ArrowDown' ? -st : 0); return;
      }
      case '+': case '=': done(); view.zoomBy(1.4); return;
      case '-': done(); view.zoomBy(1 / 1.4); return;
      case '0': done(); view.fit(); return;
      case '`': {
        done(); const hit = state.mouse && view.hitTest(state.mouse, 8);
        if (hit && hit.type === 'net') { const net = P.nets[state.inst.netOf[hit.g]]; if (net) selectNet(net, itemFromTag(hit.it)); }
        else toast('Point at a wire, label or pin to highlight its net.');
        return;
      }
      case '~': done(); if (state.sel && state.sel.type === 'net') clearSelection(); return;
    }
    if (key.length !== 1) return;
    switch (k) {
      case 'e': done(); keyAction(/^(EDIT|RENAME|STYLE|CABLE|ENTER)$/, 'Properties'); return;
      case 'm': done(); keyMoveStart(false); return;
      case 'g': done(); keyMoveStart(true); return;
      case 'o': done(); autoplaceSel(); return;
      case 'n': done(); stepGrid(sh ? -1 : 1); return;
      case 'r': done(); if (state.mode === 'draw' && state.draw && state.draw.tool === 'entry') { state.draw.dir = ((state.draw.dir || 0) + 1) % 4; if (state.mouse) hoverPreview(state.mouse); } else keyAction(/^ROTATE$/, 'Rotate'); return;
      case 'x': done(); keyAction(/^MIRROR ↔$/, 'Mirror'); return;
      case 'y': done(); keyAction(/^MIRROR ↕$/, 'Mirror'); return;
      case 'v': done(); editField('Value'); return;
      case 'u': done(); editField('Reference'); return;
      case 'f': done(); editField('Footprint'); return;
      case 'd': done(); showDatasheet(); return;
      case 'a': done(); openPartPicker(); return;
      case 'p': done(); openPartPicker('lib:power'); return;
      case 'w': {
        done(); const m = state.mouse && state.mouse.slice();
        if (state.sel) { state.sel = null; applyHighlight(); renderSelectionUI(); }
        setMode('wire'); if (m) wireTap(m, 'mouse'); return;
      }
      case 'j': done(); keyPlace('w-j'); return;
      case 'q': done(); keyPlace('w-nc'); return;
      case 'l': done(); keyPlace('l-net'); return;
      case 'h': done(); keyPlace('l-hier'); return;
      case 't': done(); keyPlace('l-text'); return;
      case 'i': done(); if (state.sel) { state.sel = null; applyHighlight(); renderSelectionUI(); } state.draw = { tool: 'line', pts: [] }; setMode('draw'); setDrawTool('line'); return;
      case 'b': done(); if (sh) blocksMenu($('rbTools')); else startBus(); return;
      case 'z': done(); startEntry(); return;
      case 'c': {
        done();
        const hit = state.mouse && view.hitTest(state.mouse, 8), o = hit && hit.it && hit.it[0] === 'U' ? graphicObj(hit.it) : state.sel && state.sel.type === 'graphic' && state.sel.it[0] === 'U' ? graphicObj(state.sel.it) : null;
        if (o) unfoldDialog(o); else toast('Point at a bus to unfold a member from it.');
        return;
      }
      case 's': if (!sh) { done(); startSheetTool(); } return;
    }
  }
  window.addEventListener('keydown', hotkey);
  $('canvas').addEventListener('pointerleave', () => { state.mouse = null; });

  // ------------------------------------------------------------------ screen fitting
  // Dialogs and menus size to the visible area, so the on-screen keyboard never hides the field
  // being typed in; the field is scrolled into the middle of what's left.
  (function () {
    const vv = window.visualViewport; if (!vv) return;
    const fit = () => { const st = document.documentElement.style; st.setProperty('--vvh', Math.round(vv.height) + 'px'); st.setProperty('--vvt', Math.round(vv.offsetTop) + 'px'); };
    vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); fit();
  })();
  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (!t || !t.matches || !t.matches('input, select, textarea') || !t.closest('.dialog, .panel, .search')) return;
    const go = () => { try { t.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (err) { t.scrollIntoView(); } };
    setTimeout(go, 120); setTimeout(go, 450);   // again once the keyboard has finished opening
  });

  // Full screen: the top bar, tools and status bar slide away. A handle on each edge, or a swipe
  // in from an edge, brings them back for a few seconds; selecting something shows the status bar.
  var immersive = { on: false, timer: 0, fs: false };   // var: renderStatus may run before this line
  function setImmersive(on) {
    immersive.on = on;
    document.body.classList.toggle('immersive', on);
    document.body.classList.remove('peek', 'peek-status');
    $('btnFull').firstElementChild.firstElementChild.setAttribute('href', on ? '#i-shrink' : '#i-expand');
    $('btnFull').title = on ? 'Leave full screen' : 'Full screen: bars hide; swipe in from an edge or tap a handle to show them';
    const el = document.documentElement;
    if (on && !document.fullscreenElement && el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).then(() => { immersive.fs = true; }).catch(() => {});
    if (!on && document.fullscreenElement && immersive.fs) document.exitFullscreen().catch(() => {});
    if (!on) immersive.fs = false;
    if (on) toast('Full screen: swipe in from an edge, or tap a handle, to show the bars');
  }
  function peek(kind) {
    if (!immersive.on) return;
    const b = document.body.classList;
    if (kind === 'status') { if (!b.contains('peek')) b.add('peek-status'); } else { b.add('peek'); b.remove('peek-status'); }
    const top = $('topWrap'), st = $('status');
    document.documentElement.style.setProperty('--bar-top', (top ? top.offsetHeight : 56) + 'px');
    document.documentElement.style.setProperty('--bar-bottom', (st ? st.offsetHeight : 56) + 'px');
    clearTimeout(immersive.timer);
    immersive.timer = setTimeout(unpeekSoon, kind === 'status' ? 6000 : 4500);
  }
  function unpeekSoon() {
    // Not while a menu or dialog is open, or a mode (wire, label, draw, move) needs its buttons.
    if ($('menu') || $('dialogWrap') || state.mode !== 'select') { immersive.timer = setTimeout(unpeekSoon, 2000); return; }
    document.body.classList.remove('peek', 'peek-status');
  }
  $('btnFull').addEventListener('click', () => setImmersive(!immersive.on));
  $('edgeTop').addEventListener('click', () => peek('all'));
  $('edgeRight').addEventListener('click', () => peek('all'));
  $('edgeBottom').addEventListener('click', () => peek('all'));
  for (const sel of ['#topWrap', '#rail', '#status']) {
    const el = document.querySelector(sel);
    if (el) el.addEventListener('pointerdown', () => { if (immersive.on && (document.body.classList.contains('peek') || document.body.classList.contains('peek-status'))) { clearTimeout(immersive.timer); immersive.timer = setTimeout(unpeekSoon, 6000); } });
  }
  $('stage').addEventListener('pointerdown', () => { if (immersive.on && document.body.classList.contains('peek')) { clearTimeout(immersive.timer); document.body.classList.remove('peek'); } }, true);
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && immersive.on && immersive.fs) setImmersive(false); });
  // Swipe in from the top, right or bottom edge.
  (function () {
    let sx = 0, sy = 0, edge = null;
    window.addEventListener('touchstart', (e) => {
      edge = null; if (!immersive.on || e.touches.length !== 1) return;
      const t = e.touches[0], W = window.innerWidth, H = window.innerHeight, m = 22;
      sx = t.clientX; sy = t.clientY;
      edge = sy < m ? 'top' : sy > H - m ? 'bottom' : sx > W - m ? 'right' : null;
    }, { passive: true });
    window.addEventListener('touchmove', (e) => {
      if (!edge) return;
      const t = e.touches[0], dx = sx - t.clientX, dy = t.clientY - sy;
      if ((edge === 'top' && dy > 24) || (edge === 'bottom' && -dy > 24) || (edge === 'right' && dx > 24)) { peek('all'); edge = null; }
    }, { passive: true });
  })();

  // ------------------------------------------------------------------ boot
  renderStatus();
  renderScale();
  renderRibbon();
  if (Store.pref('dockOpen') && wideDock()) setDock(true);
  state.prBase = Store.pref('prBase') || null;
  // Ask the browser not to clear Loomline's storage when space runs low (cached sheets, install log, settings).
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persisted().then((p) => { if (!p) navigator.storage.persist(); }).catch(() => {}); } catch (e) { /* ignore */ }
  async function boot() {
    const last = Store.pref('last');
    // Settings gone (a browser that deletes site data on close)? Reconnect from the saved password, if any.
    if ((!state.gh.repo || !state.token) && !last && await restoreCredential('silent')) return;
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
  window.__tracer = { state, view, selectNet, selectSymbol, showInstance, openProject, snapPoint: (w) => snapPoint(w, 'touch'), armStencil, stencilById, copySel, startPaste, selectAll, setMode, multiResolve, undo };
})();
