/* Loomline schematic setup (KiCad: File → Schematic Setup) and outputs.
 * Project-file settings kept in the .kicad_pro the way KiCad 8/9 keeps them: formatting defaults,
 * text variables, net classes and their patterns, ERC rule severities, BOM settings. Bus aliases
 * live in the top sheet (KiCad 8 format). Also the KiCad netlist (.net) and configurable BOM.
 * Pure functions of a project built by kicad-core, so they run in the browser and in node tests. */
(function (root) {
  'use strict';
  const K = root.KiCore;
  const plain = (s) => K.plainText(K.unescape(String(s || '')));
  const ncmp = (a, b) => K.naturalCmp(String(a), String(b));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const MIL = 0.0254;   // KiCad keeps schematic sizes in the project file in mils

  // ---------------------------------------------------------------- the project file
  const DEFAULT_CLASS = { name: 'Default', wire_width: 6, bus_width: 12, line_style: 0, schematic_color: 'rgba(0, 0, 0, 0.000)', pcb_color: 'rgba(0, 0, 0, 0.000)', clearance: 0.2, track_width: 0.2, via_diameter: 0.6, via_drill: 0.3, microvia_diameter: 0.3, microvia_drill: 0.1, diff_pair_gap: 0.25, diff_pair_width: 0.2, diff_pair_via_gap: 0.25, priority: 2147483647 };
  function proPathOf(P) { return P.proPath || String(P.rootPath || 'project.kicad_sch').replace(/\.kicad_sch$/i, '.kicad_pro'); }
  function blankPro(P) {
    const name = K.basename(proPathOf(P));
    return { board: { design_settings: {}, layer_presets: [], viewports: [] }, boards: [], libraries: { pinned_footprint_libs: [], pinned_symbol_libs: [] }, meta: { filename: name, version: 1 },
      net_settings: { classes: [clone(DEFAULT_CLASS)], meta: { version: 3 }, net_colors: null, netclass_assignments: null, netclass_patterns: [] },
      pcbnew: { last_paths: {}, page_layout_descr_file: '' }, schematic: { legacy_lib_dir: '', legacy_lib_list: [] }, sheets: [], text_variables: {} };
  }
  /** Change the project file: fn(pro) edits a copy. Creates the .kicad_pro when the project has none. */
  function editPro(P, fn) {
    const pro = P.pro ? clone(P.pro) : blankPro(P);
    fn(pro);
    return { path: proPathOf(P), text: JSON.stringify(pro, null, 2) + '\n' };
  }

  // ---------------------------------------------------------------- formatting
  const JUNCTION_SIZES = ['None', 'Smallest', 'Small', 'Default', 'Large', 'Largest'];
  function drawing(P) {
    const d = (P.pro && P.pro.schematic && P.pro.schematic.drawing) || {};
    return {
      textSize: (d.default_text_size || 50) * MIL,             // mm
      lineWidth: (d.default_line_thickness || 6) * MIL,         // mm
      pinSymbolSize: (d.pin_symbol_size || 25) * MIL,
      labelOffset: d.label_size_ratio !== undefined ? d.label_size_ratio : 0.375,
      textOffset: d.text_offset_ratio !== undefined ? d.text_offset_ratio : 0.15,
      junction: d.junction_size_choice !== undefined ? d.junction_size_choice : 3,
      xrefShow: !!d.intersheets_ref_show, xrefShort: !!d.intersheets_ref_short,
      xrefPrefix: d.intersheets_ref_prefix !== undefined ? d.intersheets_ref_prefix : '[', xrefSuffix: d.intersheets_ref_suffix !== undefined ? d.intersheets_ref_suffix : ']'
    };
  }
  function setDrawing(P, o) {
    return editPro(P, (pro) => {
      const s = pro.schematic = pro.schematic || {};
      const d = s.drawing = s.drawing || {};
      const mils = (mm) => Math.round(mm / MIL * 100) / 100;
      if (o.textSize !== undefined) d.default_text_size = mils(o.textSize);
      if (o.lineWidth !== undefined) d.default_line_thickness = mils(o.lineWidth);
      if (o.pinSymbolSize !== undefined) d.pin_symbol_size = mils(o.pinSymbolSize);
      if (o.labelOffset !== undefined) d.label_size_ratio = o.labelOffset;
      if (o.textOffset !== undefined) d.text_offset_ratio = o.textOffset;
      if (o.junction !== undefined) d.junction_size_choice = o.junction;
      if (o.xrefShow !== undefined) d.intersheets_ref_show = !!o.xrefShow;
      if (o.xrefShort !== undefined) d.intersheets_ref_short = !!o.xrefShort;
      if (o.xrefPrefix !== undefined) d.intersheets_ref_prefix = o.xrefPrefix;
      if (o.xrefSuffix !== undefined) d.intersheets_ref_suffix = o.xrefSuffix;
    });
  }

  // ---------------------------------------------------------------- text variables
  const RESERVED_VARS = /^(SHEETNAME|SHEETPATH|#|##|TITLE|ISSUE_DATE|REVISION|COMPANY|FILENAME|FILEPATH|PROJECTNAME|CURRENT_DATE|INTERSHEET_REFS|COMMENT\d|REFERENCE|VALUE|FOOTPRINT|UNIT|DNP|NET_NAME|NET_CLASS|SHORT_NET_NAME|PIN_NAME|OP|QUANTITY)$/i;
  function textVars(P) { return Object.assign({}, (P.pro && P.pro.text_variables) || {}); }
  function setTextVars(P, vars) {
    for (const k of Object.keys(vars)) {
      if (!/^[A-Za-z_][\w.-]*$/.test(k)) throw new Error(`“${k}” can't be a variable name: use letters, numbers and _ (start with a letter).`);
      if (RESERVED_VARS.test(k)) throw new Error(`${k} is one of KiCad's own variables; choose another name.`);
    }
    return editPro(P, (pro) => { pro.text_variables = Object.assign({}, vars); });
  }

  // ---------------------------------------------------------------- bus aliases (KiCad 8: in the top sheet)
  function busAliases(P) {
    const out = [];
    const root = P.root && P.root.sheet;
    const seen = new Set();
    for (const path of [root && root.path].concat(P.files || [])) {
      const sh = path && P.sheetsByPath[path]; if (!sh) continue;
      for (const [name, members] of Object.entries(sh.busAliases || {})) if (!seen.has(name)) { seen.add(name); out.push({ name, members: members.slice(), path }); }
    }
    const pa = P.pro && P.pro.schematic && P.pro.schematic.bus_aliases;
    if (pa) for (const [name, members] of Object.entries(pa)) if (!seen.has(name) && Array.isArray(members)) { seen.add(name); out.push({ name, members: members.slice(), path: 'project' }); }
    return out;
  }
  const qstr = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  /** Replace every bus alias in the project with `list` ([{name, members}]), all kept in the top sheet. */
  function setBusAliases(P, list) {
    const names = new Set();
    for (const a of list) {
      if (!/^[^\s{}[\]/]+$/.test(a.name)) throw new Error(`“${a.name}” can't be an alias name: no spaces, braces, brackets or slashes.`);
      if (names.has(a.name)) throw new Error(`${a.name} is defined twice.`);
      names.add(a.name);
      if (!a.members.length) throw new Error(`${a.name} has no members.`);
    }
    const out = [];
    const rootPath = P.root.sheet.path;
    for (const path of P.files) {
      const sh = P.sheetsByPath[path]; if (!sh) continue;
      const nodes = sh.text ? K.parseSexpr(sh.text, true).filter((n) => Array.isArray(n) && n[0] === 'bus_alias') : [];
      if (!nodes.length && path !== rootPath) continue;
      let t = sh.text;
      // remove old ones (last first so offsets stay right), with their line
      for (const n of nodes.slice().reverse()) {
        let s = n.s, e = n.e;
        while (s > 0 && (t[s - 1] === '\t' || t[s - 1] === ' ')) s--;
        if (t[e] === '\n') e++;
        t = t.slice(0, s) + t.slice(e);
      }
      if (path === rootPath && list.length) {
        const top = K.parseSexpr(t, true);
        const after = top.find((n) => Array.isArray(n) && n[0] === 'lib_symbols') || top.find((n) => Array.isArray(n) && n[0] === 'paper') || top.find((n) => Array.isArray(n) && n[0] === 'uuid');
        const block = list.map((a) => `\t(bus_alias ${qstr(a.name)}\n\t\t(members ${a.members.map(qstr).join(' ')})\n\t)`).join('\n');
        let at = after ? after.e : t.indexOf('\n') + 1;
        t = t.slice(0, at) + '\n' + block + t.slice(at);
      }
      if (t !== sh.text) out.push({ path, text: t });
    }
    // KiCad 9 projects may keep them in the project file: clear those so there is one list
    if (P.pro && P.pro.schematic && P.pro.schematic.bus_aliases && Object.keys(P.pro.schematic.bus_aliases).length) out.push(editPro(P, (pro) => { pro.schematic.bus_aliases = {}; }));
    return out;
  }

  // ---------------------------------------------------------------- net classes
  function netClassSettings(P) {
    const ns = (P.pro && P.pro.net_settings) || {};
    const classes = (ns.classes && ns.classes.length ? ns.classes : [DEFAULT_CLASS]).map((c) => Object.assign(clone(DEFAULT_CLASS), c));
    if (!classes.some((c) => c.name === 'Default')) classes.unshift(clone(DEFAULT_CLASS));
    return { classes, patterns: (ns.netclass_patterns || []).map((p) => ({ netclass: p.netclass, pattern: p.pattern })) };
  }
  function setNetClasses(P, classes, patterns) {
    const names = new Set();
    for (const c of classes) {
      if (!c.name || !c.name.trim()) throw new Error('Every net class needs a name.');
      if (names.has(c.name)) throw new Error(`There are two net classes called ${c.name}.`);
      names.add(c.name);
    }
    if (!names.has('Default')) throw new Error('The Default net class must stay.');
    for (const p of patterns) if (!names.has(p.netclass)) throw new Error(`Pattern ${p.pattern} uses ${p.netclass}, which isn't a net class.`);
    return editPro(P, (pro) => {
      const ns = pro.net_settings = pro.net_settings || { meta: { version: 3 } };
      const old = new Map((ns.classes || []).map((c) => [c.name, c]));
      ns.classes = classes.map((c, i) => Object.assign({}, clone(DEFAULT_CLASS), old.get(c.was || c.name) || {}, c, { priority: c.name === 'Default' ? 2147483647 : i }));
      for (const c of ns.classes) delete c.was;
      ns.netclass_patterns = patterns.filter((p) => p.pattern && p.pattern.trim()).map((p) => ({ netclass: p.netclass, pattern: p.pattern.trim() }));
      if (!ns.meta) ns.meta = { version: 3 };
    });
  }
  function wildcard(pat) {
    const re = '^' + String(pat).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
    try { return new RegExp(re, 'i'); } catch (e) { return /^$/; }
  }
  const DIRECTIVE_FIELD = /^(net ?class|netclass)$/i;
  /** Which class each net is in: directive labels (net class flags) first, then patterns, else Default. */
  function netClassMap(P) {
    const st = netClassSettings(P);
    const byNet = new Map(), conflicts = [];
    const fromLabel = new Map();
    for (const inst of P.instances) {
      if (inst.orphan) continue;
      for (const l of inst.sheet.labels) {
        if (l.kind !== 'directive') continue;
        const f = (l.props || []).find((x) => DIRECTIVE_FIELD.test(x.name));
        if (!f || !f.value) continue;
        const nid = inst.netOf[l.group];
        if (nid === undefined || nid < 0) continue;
        const prev = fromLabel.get(nid);
        if (prev && prev.name !== f.value) conflicts.push({ net: nid, names: [prev.name, f.value], inst, p: l.p });
        else if (!prev) fromLabel.set(nid, { name: f.value, inst, p: l.p });
      }
    }
    const pats = st.patterns.map((p) => ({ re: wildcard(p.pattern), netclass: p.netclass }));
    for (const n of P.nets) {
      if (fromLabel.has(n.id)) { byNet.set(n.id, fromLabel.get(n.id).name); continue; }
      if (!n.named) continue;
      const full = plain(n.name), short = plain(n.shortName);
      const hit = pats.find((p) => p.re.test(full) || p.re.test(short));
      if (hit) byNet.set(n.id, hit.netclass);
    }
    return { settings: st, byNet, conflicts, fromLabel, classOf: (nid) => byNet.get(nid) || 'Default' };
  }
  /** rgba(r, g, b, a) → css, or null when KiCad's "no colour" (alpha 0). */
  function cssColor(s) {
    const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/.exec(s || '');
    if (!m || (m[4] !== undefined && +m[4] === 0)) return null;
    return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${m[4] === undefined ? 1 : m[4]})`;
  }
  function kicadColor(hex) {
    if (!hex) return 'rgba(0, 0, 0, 0.000)';
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    return m ? `rgb(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)})` : 'rgba(0, 0, 0, 0.000)';
  }
  function hexOf(s) {
    const c = cssColor(s); if (!c) return '';
    const m = /(\d+), (\d+), (\d+)/.exec(c);
    return '#' + [m[1], m[2], m[3]].map((v) => (+v).toString(16).padStart(2, '0')).join('');
  }

  // ---------------------------------------------------------------- ERC severities
  // Loomline check code → KiCad rule name (rules KiCad doesn't have are kept as loomline_…).
  const ERC_RULES = [
    ['pin', 'pin_not_connected', 'Pin not connected'],
    ['notdriven', 'pin_not_driven', 'Input pin not driven by any output'],
    ['power', 'power_pin_not_driven', 'Power input pin not driven'],
    ['drive', 'pin_to_pin', 'Outputs driving each other (pin conflicts)'],
    ['nc', 'no_connect_connected', 'No-connect flag on a connected net'],
    ['ncdangle', 'no_connect_dangling', 'No-connect flag not on a pin'],
    ['dangling', 'unconnected_wire_endpoint', 'Wire end not connected'],
    ['junction4', 'four_way_junction', 'Four wires meeting at one junction'],
    ['lbldangle', 'label_dangling', 'Label not connected to anything'],
    ['global1', 'single_global_label', 'Global label used only once'],
    ['localglobal', 'same_local_global_label', 'Local and global labels with the same name'],
    ['similar', 'similar_labels', 'Labels differing only in upper/lower case'],
    ['names', 'multiple_net_names', 'More than one name on a net'],
    ['sheetpin', 'hier_label_mismatch', 'Sheet pin with no hierarchical label'],
    ['hier', 'hier_label_mismatch', 'Hierarchical label with no sheet pin'],
    ['dupsheet', 'duplicate_sheet_names', 'Duplicate sheet names in one sheet'],
    ['buswire', 'bus_to_net_conflict', 'Wire or pin connected to a bus without an entry'],
    ['annotate', 'unannotated', 'Symbol not annotated'],
    ['dupref', 'duplicate_reference', 'Duplicate reference'],
    ['duppin', 'loomline_duplicate_pins', 'Same pin number on different nets'],
    ['unit', 'missing_unit', 'Units of a part not placed'],
    ['unitval', 'unit_value_mismatch', 'Units of a part with different values'],
    ['unitfp', 'different_unit_footprint', 'Units of a part with different footprints'],
    ['netclass', 'conflicting_netclasses', 'Two net classes on one net'],
    ['netclassundef', 'undefined_netclass', 'Net class flag naming an undefined class'],
    ['unresolved', 'unresolved_variable', 'Text variable that has no value'],
    ['grid', 'endpoint_off_grid', 'Off the 1.27 mm connection grid'],
    ['label', 'loomline_label_no_pins', 'Label that reaches no pins'],
    ['value', 'loomline_missing_value', 'Part with no value'],
    ['busname', 'loomline_bus_group_names', 'Bus groups KiCad won’t join'],
    ['ebus', 'loomline_ebus_budget', 'Beckhoff E-bus power budget']
  ];
  const RULE_OF = new Map(ERC_RULES.map((r) => [r[0], r[1]]));
  function ercSeverities(P) {
    const rs = (P.pro && P.pro.erc && P.pro.erc.rule_severities) || {};
    return Object.assign({}, rs);
  }
  function setErcSeverities(P, map) {
    return editPro(P, (pro) => {
      const e = pro.erc = pro.erc || {};
      e.rule_severities = Object.assign({}, e.rule_severities || {}, map);
      if (!e.meta) e.meta = { version: 0 };
    });
  }
  /** Apply the project's ERC severities to Loomline's own check results. */
  // KiCad's own defaults for rules that aren't errors or warnings out of the box
  const KICAD_DEFAULTS = { four_way_junction: 'ignore' };
  function severityOf(rule, rs) { return (rs && rs[rule]) || KICAD_DEFAULTS[rule] || null; }
  function applySeverities(issues, P) {
    const rs = Object.assign({}, KICAD_DEFAULTS, (P.pro && P.pro.erc && P.pro.erc.rule_severities) || {});
    const out = [];
    for (const is of issues) {
      const rule = RULE_OF.get(is.code);
      const s = rule && rs[rule];
      if (s === 'ignore') continue;
      out.push(s === 'error' ? Object.assign({}, is, { sev: 'error' }) : s === 'warning' ? Object.assign({}, is, { sev: 'warn' }) : is);
    }
    const rank = { error: 0, warn: 1 };
    return out.sort((a, b) => rank[a.sev] - rank[b.sev]);
  }

  // ---------------------------------------------------------------- KiCad netlist (.net)
  const sx = (s) => '"' + String(s === undefined || s === null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
  const propOf = (sym, name) => { const f = sym.props.find((p) => p.name === name); return f ? f.value || '' : ''; };
  function sheetTstamps(P, inst) {
    const rootUuid = '/' + (P.root.sheet.uuid || '');
    let p = inst.path || '/';
    if (p.startsWith(rootUuid)) p = p.slice(rootUuid.length);
    return (p || '') + '/';
  }
  function exportNetlist(P, A, opts) {
    opts = opts || {};
    const L = [];
    const now = opts.date || new Date().toISOString().replace('T', ' ').slice(0, 19);
    L.push('(export (version "E")');
    L.push('  (design');
    L.push(`    (source ${sx(P.rootPath)})`);
    L.push(`    (date ${sx(now)})`);
    L.push(`    (tool ${sx(opts.tool || 'Loomline')})`);
    const insts = P.instances.filter((i) => !i.orphan).sort((a, b) => a.order - b.order);
    insts.forEach((inst, i) => {
      const tb = inst.sheet.titleBlock || { comments: {} };
      L.push(`    (sheet (number ${sx(i + 1)}) (name ${sx(inst.namePath)}) (tstamps ${sx(sheetTstamps(P, inst))})`);
      L.push('      (title_block');
      L.push(`        (title ${sx(tb.title || '')})`, `        (company ${sx(tb.company || '')})`, `        (rev ${sx(tb.rev || '')})`, `        (date ${sx(tb.date || '')})`, `        (source ${sx(K.basename(inst.sheet.path))})`);
      for (let c = 1; c <= 9; c++) L.push(`        (comment (number ${sx(c)}) (value ${sx((tb.comments || {})[c] || '')}))`);
      L.push('      ))');
    });
    L.push('  )');
    // components: one per reference (units merged), in reference order
    L.push('  (components');
    const parts = Array.from(A.parts.values()).sort((a, b) => ncmp(a.ref, b.ref));
    const libparts = new Map();
    for (const e of parts) {
      const s = e.sym, inst = e.units[0].inst;
      if (!s.onBoard && !opts.includeNotOnBoard) continue;
      const [lib, part] = (s.libId || ':').split(':');
      const desc = propOf(s, 'Description') || (s.lib && s.lib.props && (s.lib.props.Description || s.lib.props.ki_description)) || '';
      L.push(`    (comp (ref ${sx(e.ref)})`);
      L.push(`      (value ${sx(K.unescape(propOf(s, 'Value')))})`);
      const fp = propOf(s, 'Footprint'); if (fp) L.push(`      (footprint ${sx(fp)})`);
      const ds = propOf(s, 'Datasheet'); if (ds) L.push(`      (datasheet ${sx(ds)})`);
      if (desc) L.push(`      (description ${sx(desc)})`);
      const extra = s.props.filter((p) => !/^(Reference|Value|Footprint|Datasheet|Description)$/.test(p.name) && !/^ki_/.test(p.name));
      if (extra.length) L.push('      (fields', ...extra.map((p) => `        (field (name ${sx(p.name)}) ${sx(K.unescape(p.value))})`), '      )');
      L.push(`      (libsource (lib ${sx(lib)}) (part ${sx(part || lib)}) (description ${sx(desc)}))`);
      L.push(`      (property (name "Sheetname") (value ${sx(inst.parent ? inst.name : 'Root')}))`);
      L.push(`      (property (name "Sheetfile") (value ${sx(K.basename(inst.sheet.path))}))`);
      if (s.dnp) L.push('      (property (name "dnp") (value ""))');
      if (!s.inBom) L.push('      (property (name "exclude_from_bom") (value ""))');
      L.push(`      (sheetpath (names ${sx(inst.namePath)}) (tstamps ${sx(sheetTstamps(P, inst))}))`);
      L.push(`      (tstamps ${e.units.map((u) => sx(u.sym.uuid)).join(' ')}))`);
      if (!libparts.has(s.libId)) libparts.set(s.libId, { lib, part: part || lib, sym: s, desc });
    }
    L.push('  )');
    L.push('  (libparts');
    for (const lp of Array.from(libparts.values()).sort((a, b) => ncmp(a.lib + ':' + a.part, b.lib + ':' + b.part))) {
      const s = lp.sym;
      L.push(`    (libpart (lib ${sx(lp.lib)}) (part ${sx(lp.part)})`);
      L.push(`      (description ${sx(lp.desc)})`);
      L.push(`      (docs ${sx(propOf(s, 'Datasheet') || '~')})`);
      const filt = s.lib && s.lib.props && s.lib.props.ki_fp_filters;
      if (filt) L.push('      (footprints', ...filt.split(/\s+/).filter(Boolean).map((f) => `        (fp ${sx(f)})`), '      )');
      L.push('      (fields', ...['Reference', 'Value', 'Footprint', 'Datasheet', 'Description'].map((n) => `        (field (name ${sx(n)}) ${sx(n === 'Reference' ? propOf(s, n).replace(/[\d?]+$/, '') : n === 'Description' ? lp.desc : propOf(s, n))})`), '      )');
      const seen = new Set(), pins = [];
      // every unit's pins, from the library definition (body style 1)
      for (const u of (s.lib && s.lib.units) || []) if (u.style <= 1) for (const it of u.items) if (it.t === 'pin' && it.number && !seen.has(it.number)) { seen.add(it.number); pins.push(it); }
      pins.sort((a, b) => ncmp(a.number, b.number));
      if (pins.length) L.push('      (pins', ...pins.map((p) => `        (pin (num ${sx(p.number)}) (name ${sx(p.name || '~')}) (type ${sx(p.type || 'passive')}))`), '      )');
      L.push('    )');
    }
    L.push('  )');
    L.push('  (libraries');
    L.push('  )');
    // nets: KiCad numbers them from 1, sorted by name
    const nets = P.nets.filter((n) => !n.bus && n.pins.some((p) => !P.instances[p.inst].orphan));
    nets.sort((a, b) => ncmp(plain(a.name), plain(b.name)));
    const ncm = opts.netClasses || null;
    L.push('  (nets');
    nets.forEach((n, i) => {
      const cls = ncm ? ncm.classOf(n.id) : 'Default';
      L.push(`    (net (code ${sx(i + 1)}) (name ${sx(K.unescape(n.name))}) (class ${sx(cls)})`);
      const done = new Set();
      for (const p of n.pins) {
        if (P.instances[p.inst].orphan) continue;
        const sym = P.instances[p.inst].sheet.symbols[p.sym];
        if (!sym || !sym.lib || sym.lib.power || String(p.ref).startsWith('#')) continue;
        if (!sym.onBoard && !opts.includeNotOnBoard) continue;
        const k = p.ref + '#' + p.number; if (done.has(k)) continue; done.add(k);
        const fn = p.name && p.name !== '~' ? ` (pinfunction ${sx(p.name)})` : '';
        L.push(`      (node (ref ${sx(p.ref)}) (pin ${sx(p.number)})${fn} (pintype ${sx(p.type || 'passive')}))`);
      }
      L[L.length - 1] += ')';
    });
    L.push('  )');
    L.push(')');
    return L.join('\n') + '\n';
  }

  // ---------------------------------------------------------------- BOM (KiCad's Symbol Fields Table export)
  const QTY = '${QUANTITY}', DNP = '${DNP}', ITEM = '${ITEM_NUMBER}';
  const isQty = (n) => n === QTY || n === 'Quantity';   // older KiCad projects call it Quantity
  const BASE_FIELDS = ['Reference', 'Value', 'Footprint', 'Datasheet', 'Description'];
  function bomFields(P) {
    const names = new Set(BASE_FIELDS);
    for (const inst of P.instances) for (const s of inst.sheet.symbols) {
      if (!s.lib || s.lib.power) continue;
      for (const f of s.props) if (!/^ki_/.test(f.name) && f.name !== 'Intersheetrefs') names.add(f.name);
    }
    return [QTY, DNP, ITEM].concat(Array.from(names));
  }
  function defaultBomSettings() {
    return {
      fields_ordered: [
        { name: 'Reference', label: 'Reference', show: true, group_by: false },
        { name: 'Value', label: 'Value', show: true, group_by: true },
        { name: 'Datasheet', label: 'Datasheet', show: true, group_by: false },
        { name: 'Footprint', label: 'Footprint', show: true, group_by: true },
        { name: QTY, label: 'Qty', show: true, group_by: false },
        { name: DNP, label: 'DNP', show: true, group_by: true }
      ],
      filter_string: '', group_symbols: true, exclude_dnp: false, include_excluded_from_bom: false, name: '', sort_asc: true, sort_field: 'Reference'
    };
  }
  const defaultBomFormat = () => ({ field_delimiter: ',', keep_line_breaks: false, keep_tabs: false, name: 'CSV', ref_delimiter: ',', ref_range_delimiter: '', string_delimiter: '"' });
  function bomSettings(P) {
    const s = P.pro && P.pro.schematic || {};
    return { settings: Object.assign(defaultBomSettings(), s.bom_settings || {}), format: Object.assign(defaultBomFormat(), s.bom_fmt_settings || {}) };
  }
  function setBomSettings(P, settings, format) {
    return editPro(P, (pro) => { const s = pro.schematic = pro.schematic || {}; s.bom_settings = clone(settings); s.bom_fmt_settings = clone(format); });
  }
  // R1, R2, R3, R5 → R1-R3, R5 when a range separator is set
  function refList(refs, sep, range) {
    refs = refs.slice().sort(ncmp);
    if (!range) return refs.join(sep === ',' ? ', ' : sep);
    const out = [];
    let i = 0;
    while (i < refs.length) {
      const m = /^(.*?)(\d+)$/.exec(refs[i]);
      let j = i;
      if (m) while (j + 1 < refs.length) { const n = /^(.*?)(\d+)$/.exec(refs[j + 1]); if (n && n[1] === m[1] && +n[2] === +/(\d+)$/.exec(refs[j])[1] + 1) j++; else break; }
      out.push(j - i >= 2 ? refs[i] + range + refs[j] : refs.slice(i, j + 1).join(sep === ',' ? ', ' : sep));
      i = j + 1;
    }
    return out.join(sep === ',' ? ', ' : sep);
  }
  function bomTable(P, A, settings, format) {
    settings = Object.assign(defaultBomSettings(), settings || {});
    format = Object.assign(defaultBomFormat(), format || {});
    const filter = settings.filter_string ? wildcard('*' + settings.filter_string + '*') : null;
    const items = [];
    for (const e of A.parts.values()) {
      const s = e.sym;
      if (!s.inBom && !settings.include_excluded_from_bom) continue;
      if (s.dnp && settings.exclude_dnp) continue;
      const vals = {};
      for (const f of s.props) vals[f.name] = K.unescape(f.value || '');
      vals.Reference = e.ref;
      if (!vals.Description) vals.Description = (s.lib && s.lib.props && (s.lib.props.Description || s.lib.props.ki_description)) || '';
      vals[DNP] = s.dnp ? 'DNP' : '';
      if (filter && !filter.test(e.ref) && !filter.test(vals.Value || '')) continue;
      items.push({ ref: e.ref, vals });
    }
    const fields = settings.fields_ordered.filter((f) => f.show);
    const groupBy = settings.fields_ordered.filter((f) => f.group_by && f.name !== 'Reference' && !isQty(f.name) && f.name !== ITEM).map((f) => f.name);
    let groups;
    if (settings.group_symbols && groupBy.length) {   // like KiCad: no group-by fields, no grouping
      const m = new Map();
      for (const it of items) {
        const k = groupBy.map((n) => it.vals[n] || '').join('\u0001');
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(it);
      }
      groups = Array.from(m.values());
    } else groups = items.map((it) => [it]);
    const rows = groups.map((g) => {
      g.sort((a, b) => ncmp(a.ref, b.ref));
      return fields.map((f) => {
        if (f.name === 'Reference') return refList(g.map((x) => x.ref), format.ref_delimiter, format.ref_range_delimiter);
        if (isQty(f.name)) return String(g.length);
        if (f.name === ITEM) return '';
        // the same in every member, or the values joined
        const vs = Array.from(new Set(g.map((x) => x.vals[f.name] || '')));
        return vs.length === 1 ? vs[0] : vs.filter(Boolean).join(', ');
      });
    });
    const si = fields.findIndex((f) => f.name === settings.sort_field);
    const order = rows.map((r, i) => i).sort((a, b) => (si < 0 ? 0 : isQty(fields[si].name) ? +rows[a][si] - +rows[b][si] : ncmp(rows[a][si], rows[b][si])) || ncmp(groups[a][0].ref, groups[b][0].ref));
    if (!settings.sort_asc) order.reverse();
    const out = order.map((i) => rows[i]);
    const it = fields.findIndex((f) => f.name === ITEM);
    if (it >= 0) out.forEach((r, i) => { r[it] = String(i + 1); });
    return { cols: fields.map((f) => f.label || f.name), rows: out, parts: items.length };
  }
  function bomText(table, format) {
    format = Object.assign(defaultBomFormat(), format || {});
    const fd = format.field_delimiter === '\\t' ? '\t' : format.field_delimiter, q = format.string_delimiter;
    const cell = (v) => {
      let s = String(v === undefined || v === null ? '' : v);
      if (!format.keep_tabs) s = s.replace(/\t/g, ' ');
      if (!format.keep_line_breaks) s = s.replace(/\r?\n/g, ' ');
      return q ? q + s.split(q).join(q + q) + q : s;
    };
    return [table.cols].concat(table.rows).map((r) => r.map(cell).join(fd)).join('\r\n') + '\r\n';
  }

  const api = {
    MIL, JUNCTION_SIZES, ERC_RULES, DEFAULT_CLASS, QTY, DNP, ITEM, isQty,
    proPathOf, editPro, drawing, setDrawing, textVars, setTextVars, busAliases, setBusAliases,
    netClassSettings, setNetClasses, netClassMap, wildcard, cssColor, kicadColor, hexOf,
    ercSeverities, setErcSeverities, applySeverities, severityOf, KICAD_DEFAULTS,
    exportNetlist, bomFields, bomSettings, setBomSettings, defaultBomSettings, bomTable, bomText, refList
  };
  root.Setup = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
