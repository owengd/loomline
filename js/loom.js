/* Loomline analysis: wire numbers, from/to wire list, unit cross-references, design checks,
 * reports (BOM, connector pin-outs, loom list) and revision comparison. Pure functions of a
 * project built by kicad-core, so they run the same in the browser and in node tests. */
(function (root) {
  'use strict';
  const K = root.KiCore;
  const plain = (s) => K.plainText(K.unescape(String(s || '')));
  const ncmp = (a, b) => K.naturalCmp(String(a), String(b));

  // Drawing-frame zone (KiCad's border: 50 mm zones, rows A.. top to bottom, columns 1.. left to right)
  function zoneOf(inst, p) {
    const [PW, PH] = inst.sheet.paper, m = 10;
    const nx = Math.max(1, Math.round((PW - 2 * m) / 50)), ny = Math.max(1, Math.round((PH - 2 * m) / 50));
    const c = Math.min(nx, Math.max(1, Math.floor((p[0] - m) / ((PW - 2 * m) / nx)) + 1));
    const r = Math.min(ny - 1, Math.max(0, Math.floor((p[1] - m) / ((PH - 2 * m) / ny))));
    return String.fromCharCode(65 + (r % 26)) + c;
  }
  const isConnector = (sym, ref) => /^(J|P|X|XS|XP|XJ|XT|CN|CON|TB|TS|SK|PL)\d/i.test(ref) || /connector|terminal/i.test(sym.libId || '');
  const prop = (sym, name) => { const f = sym.props.find((p) => p.name === name); return f ? K.unescape(f.value || '') : ''; };

  function analyze(P) {
    const pinCache = new Map();   // symbol -> Map(pin number -> position)
    const pinOf = (p) => {
      const sym = P.instances[p.inst].sheet.symbols[p.sym];
      let m = pinCache.get(sym);
      if (!m) { m = new Map(); for (const pin of K.symbolPins(sym)) if (!m.has(pin.number)) m.set(pin.number, pin.pos); pinCache.set(sym, m); }
      return m.get(p.number) || [0, 0];
    };
    const A = { wireNo: new Array(P.nets.length).fill(null), wires: [], wiresByNet: new Map(), xref: new Map(), parts: new Map(), issues: [], pinPos: pinOf };

    // ---- parts (one entry per reference, units merged). Sheet files outside the hierarchy are ignored, like KiCad.
    for (const inst of P.instances) {
      if (inst.orphan) continue;
      inst.sheet.symbols.forEach((sym, si) => {
        const ref = inst.refs[si].ref;
        if (!sym.lib || sym.lib.power || ref.startsWith('#')) return;
        let e = A.parts.get(ref);
        if (!e) A.parts.set(ref, e = { ref, units: [], sym, inst, si, connector: isConnector(sym, ref) });
        e.units.push({ inst, si, sym, unit: sym.lib.unitCount > 1 ? K.unitLetter(inst.refs[si].unit || sym.unit) : '', page: inst.page, zone: zoneOf(inst, sym.p) });
      });
    }
    for (const e of A.parts.values()) if (e.units.length > 1 || (e.sym.lib && e.sym.lib.unitCount > 1)) {
      e.units.sort((a, b) => ncmp(a.unit, b.unit));
      for (const u of e.units) A.xref.set(u.inst.idx + ':' + u.si, e.units.filter((x) => x !== u));
    }

    // ---- wire numbers: a label's name when the net has one, otherwise <page><nn> by position
    const shortCount = new Map();
    for (const n of P.nets) if (n.named && !n.bus) shortCount.set(plain(n.shortName), (shortCount.get(plain(n.shortName)) || 0) + 1);
    const used = new Set(shortCount.keys()), taken = new Set();
    const byPage = new Map();
    for (const n of P.nets) {
      if (n.bus) continue;
      if (n.named) {
        let s = plain(n.shortName);
        // The same local name on several sheets (a reused sheet): add the sheet number.
        if (shortCount.get(s) > 1) {
          const first = Array.from(n.inst.keys()).map((i) => P.instances[i]).sort((x, y) => x.order - y.order)[0];
          s = first ? s + '.' + (first.order + 1) : plain(n.name);
        }
        let no = s, k = 2;
        while (taken.has(no)) no = s + '·' + k++;
        taken.add(no);
        A.wireNo[n.id] = no;
        continue;
      }
      if (n.pins.length < 2) continue;
      let first = null;
      for (const p of n.pins) {
        const inst = P.instances[p.inst], pos = pinOf(p);
        const k = [inst.order, Math.round(pos[1] / 2.54), pos[0]];
        if (!first || k[0] < first.k[0] || (k[0] === first.k[0] && (k[1] < first.k[1] || (k[1] === first.k[1] && k[2] < first.k[2])))) first = { k, inst };
      }
      if (!byPage.has(first.inst)) byPage.set(first.inst, []);
      byPage.get(first.inst).push({ n, k: first.k });
    }
    let widest = 0;
    for (const list of byPage.values()) widest = Math.max(widest, list.length);
    const mult = widest > 99 ? 1000 : 100;
    for (const [inst, list] of byPage) {
      list.sort((a, b) => a.k[1] - b.k[1] || a.k[2] - b.k[2]);
      // Sheet number in page order (page labels can repeat or be text).
      const page = inst.order + 1;
      let seq = 1;
      for (const it of list) {
        let no;
        do { no = String(page * mult + seq++); } while (used.has(no) || taken.has(no));
        taken.add(no);
        A.wireNo[it.n.id] = no;
      }
    }

    // ---- from/to wire list: each net's pins joined by the shortest drawing distance
    for (const n of P.nets) {
      if (n.bus || n.pins.length < 2) continue;
      const pins = n.pins.filter((p) => !P.instances[p.inst].orphan);
      if (pins.length < 2) continue;
      const inTree = new Uint8Array(pins.length), best = new Float64Array(pins.length).fill(Infinity), from = new Int32Array(pins.length).fill(-1);
      // Positions and sheet order looked up once per pin (big nets such as 0 V compare every pair).
      const px = new Float64Array(pins.length), py = new Float64Array(pins.length), ord = new Float64Array(pins.length);
      pins.forEach((p, i) => { const q = pinOf(p); px[i] = q[0]; py[i] = q[1]; ord[i] = P.instances[p.inst].order; });
      const cost = (i, j) => {
        const a = pins[i], b = pins[j];
        if (a.ref === b.ref) return a.inst === b.inst ? 0.5 : 1;    // pins of one part (stacked pins, units)
        const d = Math.abs(px[i] - px[j]) + Math.abs(py[i] - py[j]);
        return a.inst === b.inst ? d : 1e6 + Math.abs(ord[i] - ord[j]) * 1e4 + d;
      };
      best[0] = 0;
      const rows = [];
      for (let it = 0; it < pins.length; it++) {
        let u = -1;
        for (let i = 0; i < pins.length; i++) if (!inTree[i] && (u < 0 || best[i] < best[u])) u = i;
        inTree[u] = 1;
        if (from[u] >= 0) {
          let a = pins[from[u]], b = pins[u];
          if (a.ref === b.ref && a.number === b.number) continue;
          if (ncmp(a.ref, b.ref) > 0 || (a.ref === b.ref && ncmp(a.number, b.number) > 0)) [a, b] = [b, a];
          rows.push({ net: n, no: A.wireNo[n.id], a, b, key: `W:${a.ref}.${a.number}~${b.ref}.${b.number}`, sameSheet: a.inst === b.inst });
        }
        for (let i = 0; i < pins.length; i++) if (!inTree[i]) { const c = cost(u, i); if (c < best[i]) { best[i] = c; from[i] = u; } }
      }
      A.wiresByNet.set(n.id, rows);
      A.wires.push(...rows);
    }
    // Numbered wires first, in number order, then named ones alphabetically.
    const numeric = (s) => /^\d+$/.test(s || '');
    A.wires.sort((x, y) => (numeric(y.no) - numeric(x.no)) || ncmp(x.no || '', y.no || '') || ncmp(x.a.ref, y.a.ref) || ncmp(x.a.number, y.a.number));

    A.issues = check(P, A);
    return A;
  }

  // ---------------------------------------------------------------- design checks
  function check(P, A) {
    const out = [];
    const add = (sev, code, msg, inst, p, extra) => out.push(Object.assign({ sev, code, msg, inst: inst.idx, page: inst.page, zone: zoneOf(inst, p), p }, extra || {}));
    // References: unannotated, duplicated, missing value
    const seen = new Map();
    for (const inst of P.instances) {
      if (inst.orphan) continue;
      inst.sheet.symbols.forEach((sym, si) => {
        const ref = inst.refs[si].ref;
        if (!sym.lib || sym.lib.power || ref.startsWith('#')) return;
        if (/\?$/.test(ref)) { add('warn', 'annotate', `${ref} is not annotated`, inst, sym.p, { ref, si }); return; }
        const unit = inst.refs[si].unit || sym.unit || 1;
        const k = ref + '#' + unit;
        if (seen.has(k)) {
          const o = seen.get(k);
          add('error', 'dupref', `Duplicate reference ${ref}${sym.lib.unitCount > 1 ? K.unitLetter(unit) : ''} (also on page ${o.inst.page})`, inst, sym.p, { ref, si });
        } else seen.set(k, { inst, si });
        const v = prop(sym, 'Value');
        if (!v || v === '~') add('warn', 'value', `${ref} has no value`, inst, sym.p, { ref, si });
      });
    }
    // Pins: unconnected, and driver conflicts
    const outTypes = new Set(['output', 'power_out']);
    for (const inst of P.instances) {
      if (inst.orphan) continue;
      inst.sheet.symbols.forEach((sym, si) => {
        const ref = inst.refs[si].ref;
        if (!sym.lib || sym.lib.power || ref.startsWith('#')) return;
        // Spare channels on I/O modules are normal; don't flag them.
        if (prop(sym, 'IO_Type')) return;
        for (const pin of K.symbolPins(sym)) {
          if (pin.type === 'no_connect') continue;
          const net = P.nets[inst.netOf[pin.group]];
          if (!net || net.noConnect || net.named || net.hasPower || net.pins.length > 1) continue;
          const sev = pin.type === 'input' || pin.type === 'power_in' ? 'error' : 'warn';
          add(sev, 'pin', `${ref} pin ${pin.number}${pin.name && pin.name !== '~' && pin.name !== pin.number ? ' (' + plain(pin.name) + ')' : ''} is not connected`, inst, pin.pos, { ref, si, pin: pin.number });
        }
      });
    }
    for (const net of P.nets) {
      if (net.bus) continue;
      const drivers = net.pins.filter((p) => outTypes.has(p.type));
      const outs = drivers.filter((p) => p.type === 'output');
      if (drivers.length > 1 && (outs.length > 1 || drivers.length > outs.length && outs.length)) {
        const p = drivers[1], inst = P.instances[p.inst];
        add('error', 'drive', `${drivers.slice(0, 3).map((d) => d.ref + '.' + d.number).join(', ')} all drive ${plain(net.name)}`, inst, A.pinPos(p), { net: net.id });
      }
      if (net.noConnect && net.pins.length > 1) {
        const inst = P.instances[net.inst.keys().next().value];
        const nc = inst.sheet.noConnects.find((x) => inst.netOf[x.group] === net.id);
        add('warn', 'nc', `No-connect flag on ${plain(net.name)}, which is connected`, inst, nc ? nc.p : [0, 0], { net: net.id });
      }
    }
    // Labels: nets that reach no pins, global labels used once
    const globals = new Map();
    for (const inst of P.instances) for (const l of inst.sheet.labels) {
      if (l.kind === 'global' && l.netName) { if (!globals.has(l.netName)) globals.set(l.netName, []); globals.get(l.netName).push({ inst, l }); }
    }
    const reported = new Set();
    for (const inst of P.instances) for (const l of inst.sheet.labels) {
      if (l.kind === 'directive' || !l.text) continue;
      const net = P.nets[inst.netOf[l.group]];
      if (!net || net.bus || net.pins.length || net.hasPower || reported.has(net.id)) continue;
      if ((inst.sheet.groups[l.group] || { items: [] }).items.length <= 1) continue;   // reported as not on a wire below
      reported.add(net.id);
      add('warn', 'label', `Label ${plain(l.netName || l.text)} connects to no pins`, inst, l.p, { net: net.id });
    }
    for (const [name, list] of globals) if (list.length === 1 && !reported.has(list[0].inst.netOf[list[0].l.group])) {
      add('warn', 'global1', `Global label ${plain(name)} appears only once`, list[0].inst, list[0].l.p);
    }
    // Hierarchy: sheet pins and hierarchical labels must pair up
    for (const C of P.instances) {
      if (!C.parent) continue;
      const hier = new Set(C.sheet.labels.filter((l) => l.kind === 'hier').map((l) => l.netName));
      const pins = new Set(C.sheetSym.pins.map((p) => p.netName || plain(p.name)));
      for (const sp of C.sheetSym.pins) if (!hier.has(sp.netName || plain(sp.name))) add('error', 'sheetpin', `Sheet pin ${plain(sp.name)} has no hierarchical label in ${C.name}`, C.parent, sp.p);
      for (const l of C.sheet.labels) if (l.kind === 'hier' && !pins.has(l.netName)) add('error', 'hier', `Hierarchical label ${plain(l.netName)} has no sheet pin on ${C.name}`, C, l.p);
    }
    // Wires: ends that touch nothing
    const doneSheets = new Set();
    for (const inst of P.instances) {
      const sh = inst.sheet;
      if (doneSheets.has(sh)) continue;
      doneSheets.add(sh);
      const pts = new Map();
      const put = (p) => { const k = K.key(p); pts.set(k, (pts.get(k) || 0) + 1); };
      sh.symbols.forEach((s) => K.symbolPins(s).forEach((p) => put(p.pos)));
      sh.wires.forEach((w) => { put(w.a); put(w.b); });
      sh.labels.forEach((l) => put(l.p));
      sh.sheets.forEach((s) => s.pins.forEach((p) => put(p.p)));
      sh.junctions.forEach((j) => put(j.p));
      sh.noConnects.forEach((n) => put(n.p));
      sh.entries.forEach((e) => { put(e.a); put(e.b); });
      for (const w of sh.wires) {
        if (w.bus) continue;
        for (const end of [w.a, w.b]) {
          if ((pts.get(K.key(end)) || 0) > 1) continue;
          if (sh.wires.some((o) => o !== w && K.onSegment(end, o.a, o.b))) continue;
          // A labelled stub (label part-way along, free end beyond it) is a common drawing style.
          if (sh.labels.some((l) => K.onSegment(l.p, w.a, w.b))) continue;
          add('warn', 'dangling', 'Wire end is not connected', inst, end);
        }
      }
    }
    // ---- KiCad ERC rules (the ones that matter for looms and hierarchy)
    const sheetDone = new Set();
    const firstInst = new Map();
    for (const inst of P.instances) if (!inst.orphan && !firstInst.has(inst.sheet)) firstInst.set(inst.sheet, inst);
    for (const inst of P.instances) {
      if (inst.orphan) continue;
      const sh = inst.sheet, once = !sheetDone.has(sh);
      sheetDone.add(sh);
      // Same pin number on different nets (KiCad: duplicate_pins). KiCad joins pins by number in the
      // netlist, so two pins numbered 1 on different nets short them together on the board/loom.
      sh.symbols.forEach((sym, si) => {
        const ref = inst.refs[si].ref;
        if (!sym.lib || sym.lib.power || ref.startsWith('#')) return;
        const byNum = new Map();
        for (const pin of K.symbolPins(sym)) {
          if (!pin.number) continue;
          const net = inst.netOf[pin.group];
          if (!byNum.has(pin.number)) byNum.set(pin.number, []);
          byNum.get(pin.number).push({ pin, net });
        }
        for (const [num, list] of byNum) {
          if (list.length < 2 || new Set(list.map((x) => x.net)).size < 2) continue;
          const names = Array.from(new Set(list.map((x) => plain(x.pin.name)).filter((n) => n && n !== '~')));
          add('error', 'duppin', `${ref} has more than one pin ${num}${names.length ? ' (' + names.join(', ') + ')' : ''} on different nets; KiCad joins them`, inst, list[1].pin.pos, { ref, si, pin: num });
        }
      });
      if (!once) continue;
      // Labels and buses, once per sheet file
      sh.groups.forEach((g, gi) => {
        const labs = inst.groupLabels[gi] || [];
        // Two different label names on one wire or bus (KiCad: multiple_net_names)
        const names = Array.from(new Set(labs.filter((l) => l.kind === 'local' || l.kind === 'global').map((l) => l.name)));
        if (names.length > 1) {
          const l0 = sh.labels.find((l) => l.group === gi && l.kind !== 'directive');
          add('warn', 'names', `${names.slice(0, 3).map(plain).join(' and ')} are on the same ${g.bus ? 'bus' : 'wire'}; KiCad keeps only one name`, inst, l0 ? l0.p : [0, 0]);
        }
        // Group buses with different prefixes (KiCad joins group members only when the whole name matches)
        if (g.bus) {
          const groupsN = labs.map((l) => l.name).filter((n) => /\{.*\}$/.test(n));
          const prefixes = Array.from(new Set(groupsN.map((n) => n.replace(/\{.*$/, ''))));
          if (prefixes.length > 1) {
            const l0 = sh.labels.find((l) => l.group === gi && /\{/.test(l.text)) || null;
            const sp = !l0 && sh.sheets.map((s) => s.pins.find((p) => p.group === gi)).find(Boolean);
            add('error', 'busname', `Bus joins ${groupsN.slice(0, 3).map(plain).join(', ')}: KiCad only connects group members whose full names match (${prefixes[0]}.X is not ${prefixes[1]}.X). Use one name, or numbered buses such as NAME[1..4]`, inst, l0 ? l0.p : sp ? sp.p : [0, 0]);
          }
        }
      });
      // A label that touches nothing (KiCad: label_dangling)
      for (const l of sh.labels) {
        if (l.kind === 'directive' || !l.text) continue;
        const items = sh.groups[l.group] ? sh.groups[l.group].items : [];
        if (items.length <= 1) add('error', 'lbldangle', `Label ${plain(l.text)} is not on a wire, bus or pin`, inst, l.p);
      }
      // Wires and pins that meet a bus without a bus entry (KiCad: bus_to_net_conflict)
      const entryEnds = [];
      sh.entries.forEach((e) => { entryEnds.push(e.a, e.b); });
      const onBus = (p) => sh.buses.some((b) => K.onSegment(p, b.a, b.b));
      const isEntryEnd = (p) => entryEnds.some((q) => Math.abs(q[0] - p[0]) < 1e-3 && Math.abs(q[1] - p[1]) < 1e-3);
      for (const w of sh.wires) for (const end of [w.a, w.b]) if (onBus(end) && !isEntryEnd(end)) add('error', 'buswire', 'A wire meets a bus without a bus entry', inst, end);
      sh.symbols.forEach((sym, si) => { for (const pin of K.symbolPins(sym)) if (onBus(pin.pos)) add('error', 'buswire', `${inst.refs[si].ref} pin ${pin.number} is on a bus`, inst, pin.pos, { ref: inst.refs[si].ref, si }); });
      // Off the 1.27 mm connection grid (KiCad: endpoint_off_grid)
      const off = (v) => Math.abs(v / 1.27 - Math.round(v / 1.27)) > 0.002;
      const offP = (p) => off(p[0]) || off(p[1]);
      for (const w of sh.wires.concat(sh.buses)) for (const end of [w.a, w.b]) if (offP(end)) { add('warn', 'grid', 'Wire end is off the 1.27 mm connection grid', inst, end); break; }
      sh.symbols.forEach((sym, si) => { const bad = K.symbolPins(sym).find((pin) => offP(pin.pos)); if (bad) add('warn', 'grid', `${inst.refs[si].ref} pins are off the 1.27 mm connection grid`, inst, bad.pos, { ref: inst.refs[si].ref, si }); });
    }
    // Power inputs with nothing to power them (KiCad: power_pin_not_driven)
    for (const net of P.nets) {
      if (net.bus || net.hasPower) continue;
      const ins = net.pins.filter((p) => p.type === 'power_in');
      if (!ins.length || net.pins.some((p) => p.type === 'power_out')) continue;
      const p = ins[0], inst = P.instances[p.inst];
      add('error', 'power', `${p.ref} ${p.number ? 'pin ' + p.number + (p.name && p.name !== '~' && p.name !== p.number ? ' (' + plain(p.name) + ')' : '') : 'pin ' + plain(p.name || '?')} is a power input with no power source on its net`, inst, A.pinPos(p), { ref: p.ref, net: net.id });
    }
    // Units of a multi-unit part that are not placed anywhere (KiCad: missing_unit)
    const units = new Map();
    for (const inst of P.instances) {
      if (inst.orphan) continue;
      inst.sheet.symbols.forEach((sym, si) => {
        if (!sym.lib || !(sym.lib.unitCount > 1) || sym.lib.power) return;
        const ref = inst.refs[si].ref; if (/\?$/.test(ref)) return;
        if (!units.has(ref)) units.set(ref, { inst, sym, si, n: sym.lib.unitCount, have: new Set() });
        units.get(ref).have.add(inst.refs[si].unit || sym.unit || 1);
      });
    }
    for (const [ref, u] of units) {
      const missing = [];
      for (let k = 1; k <= u.n; k++) if (!u.have.has(k)) missing.push(K.unitLetter(k));
      if (missing.length) add('warn', 'unit', `${ref} has unit${missing.length === 1 ? '' : 's'} ${missing.join(', ')} not placed`, u.inst, u.sym.p, { ref, si: u.si });
    }
    // E-bus budget: terminals' stated consumption against the couplers' and power terminals' supply
    try {
      const io = plcIO(P, A);
      if (io.supply && io.ebus > io.supply) {
        const first = io.modules.find((m) => m.ebus && m.ebus[0] === '+');
        const e = first && A.parts.get(first.ref);
        if (e) add('warn', 'ebus', `E-bus load ${io.ebus} mA is more than the ${io.supply} mA supplied; add an EL9410 power terminal`, e.units[0].inst, e.sym.p, { ref: e.ref, si: e.units[0].si });
      }
    } catch (err) { /* not a PLC design */ }
    const rank = { error: 0, warn: 1 };
    out.sort((a, b) => rank[a.sev] - rank[b.sev] || P.instances[a.inst].order - P.instances[b.inst].order || a.p[1] - b.p[1] || a.p[0] - b.p[0]);
    return out;
  }

  // ---------------------------------------------------------------- reports
  const pinLabel = (p) => p.name && p.name !== '~' && p.name !== p.number ? plain(p.name) : '';
  const extraFields = /^(mpn|manufacturer|mfr|mfr\.? ?part|manufacturer[ _]part[ _]number|part ?number|supplier|supplier ?ref|stock ?code|description)$/i;
  function bom(P, A) {
    const groups = new Map();
    const extras = new Set();
    for (const e of A.parts.values()) {
      const s = e.sym;
      if (!s.inBom) continue;
      const fields = {};
      for (const f of s.props) if (extraFields.test(f.name) && f.value && f.value !== '~') { fields[f.name] = K.unescape(f.value); extras.add(f.name); }
      const v = prop(s, 'Value'), fp = prop(s, 'Footprint');
      const k = [v, fp, s.libId, s.dnp ? 'dnp' : '', JSON.stringify(fields)].join('|');
      let g = groups.get(k);
      if (!g) groups.set(k, g = { refs: [], value: v, footprint: fp, lib: s.libId, dnp: !!s.dnp, fields, description: prop(s, 'Description') || (s.lib && s.lib.props && s.lib.props.ki_description) || '' });
      g.refs.push(e.ref);
    }
    const rows = Array.from(groups.values());
    for (const g of rows) g.refs.sort(ncmp);
    rows.sort((a, b) => ncmp(a.refs[0], b.refs[0]));
    const cols = ['Qty', 'References', 'Value', 'Footprint', 'Description', ...Array.from(extras).filter((x) => !/^description$/i.test(x)), 'DNP'];
    return { cols, rows: rows.map((g) => [g.refs.length, g.refs.join(', '), g.value, g.footprint.split(':').pop(), g.fields.Description || g.description, ...cols.slice(5, -1).map((c) => g.fields[c] || ''), g.dnp ? 'DNP' : '']) };
  }
  function wireList(P, A) {
    const cols = ['Wire', 'From', 'From pin', 'To', 'To pin', 'Net', 'Pages'];
    return { cols, rows: A.wires.map((w) => [w.no || '', w.a.fullRef || w.a.ref, w.a.number + (pinLabel(w.a) ? ' ' + pinLabel(w.a) : ''), w.b.fullRef || w.b.ref, w.b.number + (pinLabel(w.b) ? ' ' + pinLabel(w.b) : ''), plain(w.net.name), Array.from(new Set([P.instances[w.a.inst].page, P.instances[w.b.inst].page])).join(', ')]), keys: A.wires.map((w) => w.key) };
  }
  function connectors(P, A) {
    const out = [];
    for (const e of Array.from(A.parts.values()).filter((x) => x.connector).sort((a, b) => ncmp(a.ref, b.ref))) {
      const rows = [];
      for (const u of e.units) {
        for (const pin of K.symbolPins(u.sym)) {
          const net = P.nets[u.inst.netOf[pin.group]];
          const others = net ? net.pins.filter((p) => !(p.ref === e.ref && p.number === pin.number)) : [];
          const conn = net && others.length ? others.slice(0, 4).map((p) => p.ref + '.' + p.number).join(', ') + (others.length > 4 ? ` +${others.length - 4}` : '') : (net && net.noConnect ? 'no connect' : '');
          rows.push({ pin: pin.number, name: pinLabel(pin), wire: net ? A.wireNo[net.id] || '' : '', net: net && (net.named || net.pins.length > 1) ? plain(net.name) : '', to: conn });
        }
      }
      rows.sort((a, b) => ncmp(a.pin, b.pin));
      out.push({ ref: e.ref, value: prop(e.sym, 'Value'), footprint: prop(e.sym, 'Footprint').split(':').pop(), page: e.units[0].page, rows });
    }
    return out;
  }
  // Wires grouped by the pair of parts they join: a loom (cable) list.
  function looms(P, A) {
    const m = new Map();
    for (const w of A.wires) {
      if (w.a.ref === w.b.ref) continue;
      const k = w.a.ref + '~' + w.b.ref;
      let g = m.get(k);
      if (!g) {
        const ea = A.parts.get(w.a.ref), eb = A.parts.get(w.b.ref);
        m.set(k, g = { a: w.a.ref, b: w.b.ref, connectors: (ea && ea.connector ? 1 : 0) + (eb && eb.connector ? 1 : 0), wires: [] });
      }
      g.wires.push(w);
    }
    return Array.from(m.values()).sort((x, y) => y.connectors - x.connectors || y.wires.length - x.wires.length || ncmp(x.a, y.a));
  }
  function issuesTable(P, A) {
    return { cols: ['Severity', 'Page', 'Zone', 'Problem'], rows: A.issues.map((i) => [i.sev === 'error' ? 'Error' : 'Warning', i.page, i.zone, i.msg]) };
  }


  // ---------------------------------------------------------------- PLC I/O list
  // Modules are parts with an IO_Type field (the Loomline Beckhoff library sets it); channels come
  // from their pin names (DI3, AO1, AI2+, R1+, UD+, REL1 NO…).
  function channelOf(name) {
    let m;
    if ((m = /^(DI|DO|AI|AO)(\d+)([+-]?)$/.exec(name))) return { id: m[1] + m[2], kind: m[1], main: m[3] !== '-' };
    if ((m = /^REL(\d+)\s*(NO|NC|C)?$/.exec(name))) return { id: 'REL' + m[1], kind: 'RELAY', main: m[2] === 'NO' };
    if ((m = /^R(L?)(\d+)([+-])$/.exec(name))) return { id: 'RTD' + m[2], kind: 'RTD', main: !m[1] && m[3] === '+' };
    if ((m = /^(UD|UREF|UV)([+-])$/.exec(name))) return { id: 'BR1', kind: 'BRIDGE', main: m[1] === 'UD' && m[2] === '+' };
    if ((m = /^AI(\d+) ([UI])$/.exec(name))) return { id: 'AI' + m[1], kind: 'AI', main: m[2] === 'U' };
    if ((m = /^([AB])([12])$/.exec(name))) return { id: 'PWM' + m[1], kind: 'PWM', main: m[2] === '1' };
    if ((m = /^(TxD|RxD)([+-])$/.exec(name))) return { id: 'COM1', kind: 'SERIAL', main: m[1] === 'TxD' && m[2] === '+' };
    if ((m = /^CAN_(H|L)$/.exec(name))) return { id: 'CAN1', kind: 'CAN', main: m[1] === 'H' };
    return null;
  }
  function plcIO(P, A) {
    const modules = [], chans = [];
    let ebus = 0, ebusUnknown = 0, supply = 0;
    for (const e of Array.from(A.parts.values()).sort((a, b) => ncmp(a.ref, b.ref))) {
      const type = prop(e.sym, 'IO_Type');
      if (!type) continue;
      const code = prop(e.sym, 'MPN') || prop(e.sym, 'Value');
      const eb = prop(e.sym, 'Ebus_mA'), sup = prop(e.sym, 'Ebus_supply_mA');
      if (sup) supply += +sup || 0;
      else if (eb) ebus += +eb || 0;
      else if (type !== 'IPC') ebusUnknown++;   // an Industrial PC is not on the E-bus
      const byCh = new Map();
      for (const u of e.units) for (const pin of K.symbolPins(u.sym)) {
        const c = channelOf(pin.name || '');
        if (!c) continue;
        let ch = byCh.get(c.id);
        if (!ch) byCh.set(c.id, ch = { id: c.id, kind: c.kind, pins: [], net: null, u });
        const net = P.nets[u.inst.netOf[pin.group]];
        ch.pins.push(pin.number);
        if (c.main || !ch.net) ch.net = net;
        if (net && (net.pins.length > 1 || net.named)) ch.used = true;
      }
      const list = Array.from(byCh.values()).sort((a, b) => ncmp(a.id, b.id));
      for (const ch of list) {
        const others = ch.net ? ch.net.pins.filter((p) => p.ref !== e.ref) : [];
        chans.push({ ref: e.ref, code, type, ch: ch.id, kind: ch.kind, points: ch.pins.sort(ncmp).join(', '), signal: prop(e.sym, 'IO_Signal'),
          wire: ch.net ? A.wireNo[ch.net.id] || '' : '', net: ch.net && (ch.net.named || ch.net.pins.length > 1) ? plain(ch.net.name) : '',
          to: others.slice(0, 4).map((p) => p.ref + '.' + p.number).join(', ') + (others.length > 4 ? ` +${others.length - 4}` : ''), used: !!ch.used, page: ch.u.page });
      }
      modules.push({ ref: e.ref, code, type, desc: prop(e.sym, 'Description') || prop(e.sym, 'Value'), channels: list.length, used: list.filter((c) => c.used).length, ebus: sup ? '+' + sup : eb, page: e.units[0].page });
    }
    return { modules, chans, ebus, ebusUnknown, supply };
  }
  // ---------------------------------------------------------------- step-by-step tracing
  // Splits a net into steps from a starting item, the way a run is followed on the boat: a step
  // follows drawn wires (and same-sheet labels and sheet pins, which are the same conductor) and
  // stops at off-page jumps (global labels, power symbols) and, with opts.by 'conn', at connector
  // or terminal pins; by default ('section') at every pin and every branch point.
  // The next step carries on through those. Returns { steps: [{ items: Map(instIdx -> Set(node)),
  // stops: [{ inst, kind: 'conn' | 'jump', ref, number, name, si }] }], tagOf } or null.
  const nodeTag = (n) => n.kind === 'wire' ? 'W' + n.ref : n.kind === 'junction' ? 'J' + n.ref : n.kind === 'label' ? 'L' + n.ref : n.kind === 'nc' ? 'N' + n.ref
    : n.kind === 'entry' ? 'E' + n.ref : n.kind === 'pin' ? 'P' + n.ref[0] + ':' + n.ref[1] : n.kind === 'sheetpin' ? 'HP' + n.ref[0] + ':' + n.ref[1] : null;
  function traceSteps(P, startInst, startNode, opts) {
    opts = opts || {};
    const maxSteps = opts.maxSteps || 500;
    const bySection = opts.by !== 'conn';
    const sheetOf = (ii) => P.instances[ii].sheet;
    const nodeAt = (ii, n) => sheetOf(ii).nodes[n];
    const sn = nodeAt(startInst.idx, startNode); if (!sn) return null;
    const netId = startInst.netOf[sn.group];
    const net = P.nets[netId]; if (!net || net.bus) return null;
    const connCache = new Map();
    const pinInfo = (ii, n) => {
      const nd = nodeAt(ii, n); if (nd.kind !== 'pin') return null;
      const inst = P.instances[ii], si = nd.ref[0], sym = inst.sheet.symbols[si];
      const pin = K.symbolPins(sym)[nd.ref[1]];
      const ref = inst.refs[si].ref;
      const k = ii + ':' + si;
      let conn = connCache.get(k);
      if (conn === undefined) connCache.set(k, conn = !!(sym.lib && !sym.lib.power && !ref.startsWith('#') && isConnector(sym, ref)));
      return { inst, si, sym, pin, ref, conn, power: !!(sym.lib && sym.lib.power) };
    };
    // Off-page jump points in this net: power symbol pins and global labels, on every sheet.
    const jumps = [];
    for (const [ii, groups] of net.inst) {
      const sh = sheetOf(ii), gs = new Set(groups);
      sh.labels.forEach((l) => { if (l.kind === 'global' && gs.has(l.group)) jumps.push([ii, l.node]); });
      sh.symbols.forEach((sym, si) => { if (sym.lib && sym.lib.power) for (const pin of K.symbolPins(sym)) if (gs.has(pin.group)) jumps.push([ii, pin.node]); });
    }
    const isJump = (ii, n) => { const nd = nodeAt(ii, n); if (nd.kind === 'label') return sheetOf(ii).labels[nd.ref].kind === 'global'; const pi = pinInfo(ii, n); return !!(pi && pi.power); };
    // Same-conductor links: local labels of one name on a sheet, sheet pins and hierarchical labels.
    const links = (ii, n) => {
      const inst = P.instances[ii], sh = inst.sheet, nd = sh.nodes[n], out = [];
      if (nd.kind === 'label') {
        const l = sh.labels[nd.ref];
        if (l.kind === 'local') sh.labels.forEach((o) => { if (o !== l && o.kind === 'local' && o.netName === l.netName) out.push([ii, o.node]); });
        if (l.kind === 'hier' && inst.parent && inst.sheetSym) inst.sheetSym.pins.forEach((sp) => { if (sp.netName === l.netName) out.push([inst.parent.idx, sp.node]); });
      } else if (nd.kind === 'sheetpin') {
        const sp = sh.sheets[nd.ref[0]].pins[nd.ref[1]];
        const child = inst.children && inst.children.find((c) => c.sheetSym === sh.sheets[nd.ref[0]]);
        if (child) child.sheet.labels.forEach((l) => { if (l.kind === 'hier' && l.netName === sp.netName) out.push([child.idx, l.node]); });
      }
      return out;
    };
    const seen = new Set(), ptDone = new Set();
    const steps = [];
    let seeds = [[startInst.idx, startNode]], freePts = [];
    // Pins joined inside a connector (same number on both sides, or a jumper group).
    const jumperPins = (ii, n) => {
      const pi = pinInfo(ii, n), lib = pi && pi.sym.lib; if (!lib) return [];
      const pins = K.symbolPins(pi.sym), num = pi.pin.number;
      const grp = (lib.jumperGroups || []).find((g) => g.includes(num));
      return pins.filter((q) => q !== pi.pin && ((lib.dupPinJumpers && q.number === num) || (grp && grp.includes(q.number)))).map((q) => q.node);
    };
    let jumped = false;
    while ((seeds.length || freePts.length) && steps.length < maxSteps) {
      const step = { items: new Map(), stops: [] };
      const nextSeeds = [], nextPts = [];
      const queue = [];
      const take = (ii, n) => {
        const k = ii + ':' + n; if (seen.has(k)) return false; seen.add(k);
        let set = step.items.get(ii); if (!set) step.items.set(ii, set = new Set()); set.add(n);
        return true;
      };
      const expandPoint = (ii, pt, free) => {
        const list = sheetOf(ii).pointLists[pt];
        if (!free && bySection) {
          // One cable section at a time: a pin, or a branch (three or more wire ends), ends the step.
          const k = sheetOf(ii).pointKeys[pt];
          let deg = 0, junc = -1;
          const pins = [];
          for (const m of list) {
            const nd = nodeAt(ii, m);
            if (nd.kind === 'wire' || nd.kind === 'entry') {
              const w = nd.kind === 'wire' ? sheetOf(ii).wires[nd.ref] : sheetOf(ii).entries[nd.ref];
              deg += K.key(w.a) === k || K.key(w.b) === k ? 1 : 2;
            } else if (nd.kind === 'junction') junc = m;
            else if (nd.kind === 'pin' && !seen.has(ii + ':' + m)) { const pi = pinInfo(ii, m); if (pi && !pi.power) pins.push(m); }
          }
          if (pins.length || (deg >= 3 && !seen.has(ii + ':' + junc))) {
            for (const m of pins) {
              take(ii, m);
              const pi = pinInfo(ii, m);
              step.stops.push({ inst: ii, kind: pi.conn ? 'conn' : 'pin', ref: pi.ref, number: pi.pin.number, name: pi.pin.name, si: pi.si });
              if (pi.conn) for (const q of jumperPins(ii, m)) nextSeeds.push([ii, q]);
            }
            if (deg >= 3) { if (junc >= 0) take(ii, junc); step.stops.push({ inst: ii, kind: 'junction', key: k }); }
            nextPts.push([ii, pt]);
            return;
          }
        } else if (!free) {
          // A connector pin not yet passed stops the step here; the rest of the point waits.
          const conns = list.filter((m) => { const pi = pinInfo(ii, m); return pi && pi.conn && !seen.has(ii + ':' + m); });
          if (conns.length) {
            for (const m of conns) {
              take(ii, m);
              const pi = pinInfo(ii, m);
              step.stops.push({ inst: ii, kind: 'conn', ref: pi.ref, number: pi.pin.number, name: pi.pin.name, si: pi.si });
              for (const q of jumperPins(ii, m)) nextSeeds.push([ii, q]);
            }
            nextPts.push([ii, pt]);
            return;
          }
        }
        for (const m of list) if (take(ii, m)) queue.push([ii, m]);
      };
      for (const [ii, n] of seeds) if (take(ii, n)) queue.push([ii, n]);
      for (const [ii, pt] of freePts) { ptDone.add(ii + ':' + pt); expandPoint(ii, pt, true); }
      while (queue.length) {
        const [ii, n] = queue.shift();
        const nd = nodeAt(ii, n);
        for (const pt of nd.pts) { const k = ii + ':' + pt; if (ptDone.has(k)) continue; ptDone.add(k); expandPoint(ii, pt, false); }
        for (const [jj, m] of links(ii, n)) if (take(jj, m)) queue.push([jj, m]);
        if (isJump(ii, n)) {
          const l = nd.kind === 'label' ? sheetOf(ii).labels[nd.ref] : null;
          const name = l ? l.netName : (pinInfo(ii, n) || {}).sym && (pinInfo(ii, n).sym.props.find((p) => p.name === 'Value') || {}).value;
          let any = false;
          for (const [jj, m] of jumps) if (!seen.has(jj + ':' + m)) { nextSeeds.push([jj, m]); any = true; }
          if (any && !jumped) step.stops.push({ inst: ii, kind: 'jump', name: plain(name || net.shortName) });
          if (any) jumped = true;
        }
      }
      seeds = nextSeeds; freePts = nextPts;
      if (!seeds.length && !freePts.length) {
        // Parts of the net joined some other way (bus members, jumpers): carry on from them.
        for (const [ii, groups] of net.inst) for (const g of groups) {
          const items = sheetOf(ii).groups[g].items;
          if (!items.some((m) => seen.has(ii + ':' + m))) seeds.push([ii, items[0]]);
        }
        if (seeds.length && step.items.size) step.stops.push({ inst: startInst.idx, kind: 'jump', name: plain(net.shortName) });
      }
      if (step.items.size) steps.push(step);
      else if (!seeds.length && !freePts.length) break;
    }
    return { net, steps, tagOf: (ii, n) => nodeTag(nodeAt(ii, n)) };
  }

  // ---------------------------------------------------------------- cable schedule
  // Cable details are KiCad directive labels (net class flags) with Cable_* fields on a wire; each
  // describes the cable section it sits on (between pins and branch points).
  const CABLE = ['Cable_Type', 'Cable_PN', 'Cable_Size', 'Cable_Colour', 'Cable_Length'];
  const isCableFlag = (l) => l.kind === 'directive' && l.props.some((p) => CABLE.includes(p.name) && p.value);
  // The tag shown on the drawing: core colour, gauge, and how many cores the cable has, e.g.
  // "White/Blue 26 AWG 4 core". Falls back to the type when there's nothing to build it from.
  function cableLabel(f) {
    const col = String(f.Cable_Colour || '').trim()
      .replace(/^(Core|Pair)\s*\d+\s*/i, '').replace(/\s*stripe$/i, '').replace(/^Screen.*$/i, 'Screen').replace(/^Centre.*$/i, 'Centre');
    const size = String(f.Cable_Size || '').trim();
    const m = /(\d+)\s*core/i.exec(f.Cable_Type || '');
    const cores = m ? m[1] + ' core' : '';
    const parts = [col, size, cores].filter(Boolean);
    if (!size && !cores) return [col, f.Cable_Type].filter(Boolean).join(' ') || f.Cable_PN || '';
    return parts.join(' ');
  }
  const cableFields = (l) => { const o = {}; for (const f of CABLE) { const p = l.props.find((x) => x.name === f); o[f] = p ? K.unescape(p.value) : ''; } return o; };
  function lengthMetres(s) {
    const m = /(-?[\d.,]+)\s*(mm|cm|m|ft|')?/i.exec(String(s || '')); if (!m) return null;
    const v = parseFloat(m[1].replace(',', '.')); if (!isFinite(v)) return null;
    const u = (m[2] || 'm').toLowerCase();
    return u === 'mm' ? v / 1000 : u === 'cm' ? v / 100 : u === 'ft' || u === "'" ? v * 0.3048 : v;
  }
  function sectionEnds(P, inst, node) {
    const tr = traceSteps(P, inst, node, { by: 'section', maxSteps: 1 });
    if (!tr || !tr.steps.length) return [];
    return tr.steps[0].stops.filter((x) => x.inst === inst.idx).map((x) => {
      if (x.kind === 'junction') { const [a, b] = x.key.split(',').map((v) => +v / 1000); return 'junction ' + zoneOf(inst, [a, b]); }
      if (x.kind === 'jump') return '→ ' + x.name;
      return x.ref + '.' + x.number;
    });
  }
  function cables(P, A) {
    const rows = [];
    for (const inst of P.instances) {
      if (inst.orphan) continue;
      for (const l of inst.sheet.labels) {
        if (!isCableFlag(l)) continue;
        const f = cableFields(l);
        const net = P.nets[inst.netOf[l.group]];
        let ends = [];
        if (net && net.bus) ends = ['bus ' + plain(net.shortName)];   // a whole cable on a bus: the build tab lists its ends
        else try { ends = sectionEnds(P, inst, l.node); } catch (e) { ends = []; }
        rows.push({ inst, label: l, f, net, wire: net && A && A.wireNo[net.id] || '', from: ends[0] || '', to: ends.slice(1).join(', '), page: inst.page, zone: zoneOf(inst, l.p), m: lengthMetres(f.Cable_Length) });
      }
    }
    rows.sort((a, b) => ncmp(a.f.Cable_Type, b.f.Cable_Type) || ncmp(a.f.Cable_PN, b.f.Cable_PN) || a.page - b.page);
    // The cores of one cable are separate sections (one per conductor) between the same two parts,
    // with the same length. Group them into cable runs so a 4-core cable's length counts once.
    const endPart = (e) => String(e || '').replace(/\.[^.]*$/, '');
    const runs = new Map();
    for (const r of rows) {
      const ends = [endPart(r.from)].concat(String(r.to || '').split(', ').map(endPart)).filter(Boolean).sort();
      const k = [r.f.Cable_PN || r.f.Cable_Type, ends.join('~'), r.m == null ? '?' + r.inst.idx + ':' + r.label.uuid : r.m].join('|');
      let run = runs.get(k);
      if (!run) runs.set(k, run = { type: r.f.Cable_Type, pn: r.f.Cable_PN, size: r.f.Cable_Size, ends: ends.join(' ↔ '), m: r.m, length: r.f.Cable_Length, cores: [], page: r.page });
      run.cores.push(r.f.Cable_Colour || '?');
      r.run = run;
    }
    const totals = new Map();
    for (const run of runs.values()) {
      const k = [run.type, run.pn, run.size].join('|');
      let t = totals.get(k); if (!t) totals.set(k, t = { type: run.type, pn: run.pn, size: run.size, runs: 0, n: 0, m: 0, unknown: 0 });
      t.runs++; t.n += run.cores.length;
      if (run.m == null) t.unknown++; else t.m += run.m;
    }
    const runList = Array.from(runs.values()).sort((a, b) => ncmp(a.type, b.type) || ncmp(a.ends, b.ends));
    return { rows, runs: runList, totals: Array.from(totals.values()).sort((a, b) => ncmp(a.type, b.type)) };
  }

  // ---------------------------------------------------------------- comparison
  function partSig(P, A) {
    const m = new Map();
    for (const e of A.parts.values()) {
      const s = e.sym, f = {};
      for (const p of s.props) if (p.name !== 'Reference' && !p.name.startsWith('ki_') && !p.name.startsWith('Sim.')) f[p.name] = K.unescape(p.value || '');
      f['Symbol'] = s.libId;
      if (s.dnp) f['DNP'] = 'yes';
      m.set(e.ref, { fields: f, e });
    }
    return m;
  }
  function diff(P0, A0, P1, A1) {
    const s0 = partSig(P0, A0), s1 = partSig(P1, A1);
    const parts = [];
    for (const [ref, b] of s1) {
      const a = s0.get(ref);
      if (!a) { parts.push({ kind: 'added', ref, value: b.fields.Value || '', e: b.e }); continue; }
      const ch = [];
      for (const k of new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])) if ((a.fields[k] || '') !== (b.fields[k] || '')) ch.push({ field: k, from: a.fields[k] || '', to: b.fields[k] || '' });
      if (ch.length) parts.push({ kind: 'changed', ref, value: b.fields.Value || '', changes: ch, e: b.e });
    }
    for (const [ref, a] of s0) if (!s1.has(ref)) parts.push({ kind: 'removed', ref, value: a.fields.Value || '', page: a.e.units[0].page });
    parts.sort((x, y) => ncmp(x.ref, y.ref));
    const live = (ref) => s0.has(ref) && s1.has(ref);
    const pk = (p) => p.ref + '.' + p.number;
    const net0 = new Map();
    const real = (P) => (p) => !P.instances[p.inst].orphan;
    for (const n of P0.nets) if (!n.bus) for (const p of n.pins) if (real(P0)(p)) net0.set(pk(p), n);
    // Match every new net to the old net it shares most pins with; the best match is its heir.
    const matches = [];
    const heir = new Map();
    for (const n of P1.nets) {
      if (n.bus || !n.pins.length) continue;
      const keys = n.pins.filter((p) => live(p.ref) && real(P1)(p)).map(pk);
      if (!keys.length) continue;
      const count = new Map();
      for (const k of keys) { const o = net0.get(k); if (o) count.set(o, (count.get(o) || 0) + 1); }
      let old = null, c = 0;
      for (const [o, v] of count) if (v > c) { old = o; c = v; }
      matches.push({ n, keys, old, c });
      if (old && (!heir.has(old) || heir.get(old).c < c)) heir.set(old, { n, c });
    }
    const nets = [];
    for (const { n, keys, old } of matches) {
      if (!old) { if (keys.length > 1) nets.push({ kind: 'new', net: n.id, name: plain(n.name), added: keys, removed: [] }); continue; }
      const oldKeys = old.pins.filter((p) => live(p.ref) && real(P0)(p)).map(pk);
      const S1 = new Set(keys), S0 = new Set(oldKeys);
      const added = keys.filter((k) => !S0.has(k));
      if (heir.get(old).n !== n) {
        // Part of an old net that was cut off from it
        nets.push({ kind: 'split', net: n.id, name: plain(n.name), oldName: plain(old.name), added, removed: [], moved: keys.filter((k) => S0.has(k)) });
        continue;
      }
      const removed = oldKeys.filter((k) => !S1.has(k));
      if (added.length || removed.length) nets.push({ kind: 'changed', net: n.id, name: plain(n.name), oldName: plain(old.name), added, removed });
      else if (plain(old.name) !== plain(n.name) && (old.named || n.named)) nets.push({ kind: 'renamed', net: n.id, name: plain(n.name), oldName: plain(old.name), added: [], removed: [] });
    }
    nets.sort((x, y) => ncmp(x.name, y.name));
    return { parts, nets, count: parts.length + nets.length };
  }

  // ---------------------------------------------------------------- CSV
  function csv(cols, rows) {
    const q = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return [cols, ...rows].map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
  }

  root.Loom = { analyze, check, zoneOf, isConnector, traceSteps, cables, isCableFlag, cableFields, cableLabel, sectionEnds, CABLE, bom, wireList, connectors, looms, issuesTable, plcIO, channelOf, diff, csv };
  if (typeof module !== 'undefined') module.exports = root.Loom;
})(typeof globalThis !== 'undefined' ? globalThis : this);
