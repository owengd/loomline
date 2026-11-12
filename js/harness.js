/* Loomline harness builder: the looms to be made, worked out from the schematic.
 *
 * A loom is every part with the same Loom field (e.g. Loom = 331-1A): its connectors, and any
 * resistors, splices or labels that are built into it. Its wires are the connections between
 * those parts. A net that reaches several parts of one loom becomes the shortest chain of wires
 * between them (as on the drawing: parts on one sheet first, then from sheet to sheet).
 * Pins on parts that aren't in the loom (the device a plug mates with) are where the loom ends.
 *
 * Cable details come from Loomline cable tags (KiCad net class flags with Cable_* fields):
 *   - a tag on a wire describes that core (its colour is in Cable_Colour);
 *   - a tag on a bus describes the whole cable, and its members are the cores in order
 *     (CAN_X[1..4]: member 1 is core 1). Core colours then come from the cable list.
 */
(function (root) {
  'use strict';
  const K = root.KiCore || (typeof require !== 'undefined' ? require('./kicad-core.js') : null);
  const Loom = root.Loom || (typeof require !== 'undefined' ? require('./loom.js') : null);
  const plain = (s) => K.plainText(K.unescape(String(s || '')));
  const ncmp = (a, b) => K.naturalCmp(String(a), String(b));
  const prop = (sym, name) => { const f = sym.props.find((p) => p.name === name); return f ? K.unescape(f.value || '').trim() : ''; };
  const propI = (sym, re) => { const f = sym.props.find((p) => re.test(p.name) && p.value); return f ? K.unescape(f.value).trim() : ''; };
  const pinLabel = (p) => p.name && p.name !== '~' && p.name !== p.number ? plain(p.name) : '';
  const FIELD = 'Loom';
  const loomOfSym = (sym) => prop(sym, FIELD);
  const r2 = (v) => Math.round(v * 100) / 100;
  const catalogue = () => (root.CABLE_CATALOGUE || []);
  const catFor = (pn) => pn ? catalogue().find((c) => c.pn === pn) : null;
  const coreCount = (f, cat) => { if (cat && cat.cores) return cat.cores.filter((c) => !/^screen/i.test(c)).length; const m = /(\d+)\s*core/i.exec(f.Cable_Type || ''); return m ? +m[1] : null; };

  /** Every loom in the project. Returns { looms: [...], names, field } */
  function build(P, A) {
    const loomOf = new Map();               // ref -> loom name
    for (const e of A.parts.values()) { const n = loomOfSym(e.sym); if (n) loomOf.set(e.ref, n); }
    const looms = new Map();
    const get = (name) => { let L = looms.get(name); if (!L) looms.set(name, L = { name, parts: [], wires: [], cables: [], issues: [], pins: new Map() }); return L; };
    for (const [ref, name] of loomOf) get(name).parts.push(A.parts.get(ref));

    // ---- cable tags per net
    const memberNet = new Map();            // inst|name -> net (bus members)
    for (const n of P.nets) if (!n.bus) for (const nm of n.names || []) if (nm.member || nm.kind === 'local' || nm.kind === 'hier' || nm.kind === 'global') { const k = nm.inst + '|' + nm.name; if (!memberNet.has(k)) memberNet.set(k, n); }
    const tags = new Map();                 // net id -> [{ cable, core }]
    const cables = new Map();               // key -> cable record
    const addTag = (net, t) => { let a = tags.get(net.id); if (!a) tags.set(net.id, a = []); a.push(t); };
    for (const inst of P.instances) {
      if (inst.orphan) continue;
      for (const l of inst.sheet.labels) {
        if (!Loom.isCableFlag(l)) continue;
        const net = P.nets[inst.netOf[l.group]]; if (!net) continue;
        const f = Loom.cableFields(l), cat = catFor(f.Cable_PN);
        const key = inst.idx + ':' + (l.uuid || l.p.join(','));
        const rec = { key, f, cat, bus: !!net.bus, net, inst, label: l, page: inst.page, zone: Loom.zoneOf(inst, l.p), m: lengthM(f.Cable_Length), cores: coreCount(f, cat) };
        cables.set(key, rec);
        if (net.bus) {
          (net.members || []).forEach((mb, i) => {
            const mn = mb.net >= 0 ? P.nets[mb.net] : memberNet.get(inst.idx + '|' + mb.name);
            if (mn) addTag(mn, { cable: rec, core: i, colour: cat && cat.cores ? cat.cores[i] || '' : '' });
          });
        } else {
          addTag(net, { cable: rec, core: null, colour: f.Cable_Colour, ends: drawnPins(inst, l.p) });
        }
      }
    }
    const tagFor = (net, a, b) => {
      const list = tags.get(net.id) || [];
      if (!list.length) return null;
      const pa = pinKey(a), pb = pinKey(b);
      const hit = list.find((t) => t.ends && (t.ends.includes(pa) || t.ends.includes(pb)));
      if (hit) return hit;
      const bus = list.filter((t) => t.cable.bus);
      return bus.length === 1 ? bus[0] : null;
    };

    // ---- wires: for each net, the shortest chain through the pins of each loom on it
    const order = (p) => P.instances[p.inst].order;
    for (const n of P.nets) {
      if (n.bus) continue;
      const pins = n.pins.filter((p) => !P.instances[p.inst].orphan);
      const by = new Map();
      for (const p of pins) {
        const L = loomOf.get(p.ref); if (!L) continue;
        let a = by.get(L); if (!a) by.set(L, a = []);
        if (!a.some((q) => q.ref === p.ref && q.number === p.number)) a.push(p);
      }
      for (const [name, lp] of by) {
        const L = get(name);
        const others = pins.filter((p) => loomOf.get(p.ref) !== name);
        for (const p of lp) L.pins.set(pinKey(p), { pin: p, net: n, ends: others });
        if (lp.length < 2) continue;
        const pos = lp.map((p) => A.pinPos(p));
        const cost = (i, j) => {
          const a = lp[i], b = lp[j];
          if (a.ref === b.ref) return 0.5;
          const d = Math.abs(pos[i][0] - pos[j][0]) + Math.abs(pos[i][1] - pos[j][1]);
          return a.inst === b.inst ? d : 1e6 + Math.abs(order(a) - order(b)) * 1e4 + d;
        };
        const inT = new Uint8Array(lp.length), best = new Float64Array(lp.length).fill(Infinity), from = new Int32Array(lp.length).fill(-1);
        best[0] = 0;
        for (let it = 0; it < lp.length; it++) {
          let u = -1;
          for (let i = 0; i < lp.length; i++) if (!inT[i] && (u < 0 || best[i] < best[u])) u = i;
          inT[u] = 1;
          if (from[u] >= 0) {
            let a = lp[from[u]], b = lp[u];
            if (ncmp(a.ref, b.ref) > 0 || (a.ref === b.ref && ncmp(a.number, b.number) > 0)) [a, b] = [b, a];
            const t = tagFor(n, a, b);
            L.wires.push({ no: A.wireNo[n.id] || '', net: n, signal: plain(n.shortName), a, b, tag: t, colour: t ? t.colour || '' : '', cable: t ? t.cable : null, core: t ? t.core : null });
          }
          for (let i = 0; i < lp.length; i++) if (!inT[i]) { const c = cost(u, i); if (c < best[i]) { best[i] = c; from[i] = u; } }
        }
      }
    }

    // ---- per loom: parts, cables, pin-outs, checks
    const out = [];
    for (const L of looms.values()) {
      L.parts.sort((a, b) => ncmp(a.ref, b.ref));
      L.wires.sort((x, y) => ncmp(x.no, y.no) || ncmp(x.a.ref, y.a.ref) || ncmp(x.a.number, y.a.number));
      L.wires.forEach((w, i) => { w.id = i + 1; });
      const inLoom = new Set(L.parts.map((e) => e.ref));
      // Cables: every tagged cable that carries one of the loom's wires.
      const cm = new Map();
      for (const w of L.wires) {
        if (!w.cable) continue;
        let c = cm.get(w.cable.key);
        if (!c) cm.set(w.cable.key, c = Object.assign({}, w.cable, { wires: [], ends: new Set() }));
        c.wires.push(w); c.ends.add(w.a.ref); c.ends.add(w.b.ref);
      }
      L.cables = Array.from(cm.values()).map((c) => Object.assign(c, { ends: Array.from(c.ends).sort(ncmp) })).sort((a, b) => ncmp(a.ends.join(), b.ends.join()) || ncmp(a.f.Cable_PN, b.f.Cable_PN));
      L.loose = L.wires.filter((w) => !w.cable);
      // What each part plugs into: the part outside the loom that most of its pins reach.
      for (const e of L.parts) {
        const count = new Map();
        for (const v of L.pins.values()) if (v.pin.ref === e.ref) for (const o of (v.wired = wiredTo(P, v.pin))) { const r = o.replace(/\.[^.]*$/, ''); if (!inLoom.has(r)) count.set(r, (count.get(r) || 0) + 1); }
        const best = Array.from(count).sort((a, b) => b[1] - a[1] || ncmp(a[0], b[0]))[0];
        e._mates = best ? best[0] : '';
      }
      L.partRows = L.parts.map((e) => ({
        ref: e.ref, value: prop(e.sym, 'Value'), mpn: propI(e.sym, /^(mpn|manufacturer[ _]?part[ _]?(number|no)?|mfr\.? ?part|part ?number)$/i),
        maker: propI(e.sym, /^(manufacturer|mfr|make)$/i), desc: prop(e.sym, 'Description') || (e.sym.lib && e.sym.lib.props && e.sym.lib.props.ki_description) || '',
        footprint: prop(e.sym, 'Footprint').split(':').pop(), mates: e._mates, connector: e.connector,
        page: e.units[0].page, sheet: plain(e.units[0].inst.name || ''), e }));
      // Pin-outs: every pin of every part in the loom.
      const wiresAt = new Map();
      for (const w of L.wires) for (const p of [w.a, w.b]) { const k = pinKey(p); let a = wiresAt.get(k); if (!a) wiresAt.set(k, a = []); a.push(w); }
      L.pinouts = L.parts.map((e) => {
        const rows = [];
        const seen = new Set();
        for (const u of e.units) for (const pin of K.symbolPins(u.sym)) {
          const k = e.ref + '.' + pin.number; if (seen.has(k)) continue; seen.add(k);
          const v = L.pins.get(k), ws = wiresAt.get(k) || [];
          const net = v ? v.net : P.nets[u.inst.netOf[pin.group]];
          const to = ws.map((w) => pinKey(w.a) === k ? w.b : w.a).map((p) => p.ref + '.' + p.number);
          const dev = v && v.wired ? v.wired.filter((o) => !inLoom.has(o.replace(/\.[^.]*$/, ''))) : [];
          rows.push({ pin: pin.number, name: pinLabel(pin), wire: ws.map((w) => w.no).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(', '), colour: ws.map((w) => w.colour).filter(Boolean).join(' + '),
            signal: net && (net.named || net.pins.length > 1) ? plain(net.shortName) : '', to: to.join(', '), mates: dev.slice(0, 3).join(', ') + (dev.length > 3 ? ` +${dev.length - 3}` : ''), wires: ws.length, used: !!(ws.length || dev.length) });
        }
        rows.sort((a, b) => ncmp(a.pin, b.pin));
        return { ref: e.ref, value: prop(e.sym, 'Value'), mates: e._mates, page: e.units[0].page, rows };
      });
      // Cut list: identical cables (same product, colours, length and ends) on one line with a quantity.
      const cuts = new Map();
      for (const c of L.cables) {
        const colours = c.wires.map((w) => w.colour).filter(Boolean).join(', ');
        const k = [c.f.Cable_PN, c.f.Cable_Type, c.f.Cable_Size, colours, c.m == null ? c.f.Cable_Length : c.m, c.ends.join('~')].join('|');
        let g = cuts.get(k);
        if (!g) cuts.set(k, g = { pn: c.f.Cable_PN, type: c.f.Cable_Type, size: c.f.Cable_Size, length: c.f.Cable_Length, m: c.m, ends: c.ends.join(' ↔ '), cores: c.cores, used: 0, colours, qty: 0, page: c.page, cables: [] });
        g.qty++; g.used += c.wires.length; g.cables.push(c);
      }
      L.cut = Array.from(cuts.values()).sort((a, b) => ncmp(a.ends, b.ends) || ncmp(a.pn || a.type, b.pn || b.type) || ncmp(a.colours, b.colours));
      L.cut.forEach((g, i) => { g.id = 'C' + (i + 1); for (const c of g.cables) c.id = g.id; });
      const totals = new Map();
      for (const c of L.cut) { const k = c.pn || c.type || c.colours || '?'; let t = totals.get(k); if (!t) totals.set(k, t = { pn: c.pn, type: c.type || (c.pn ? '' : c.colours), size: c.size, n: 0, m: 0, unknown: 0 }); t.n += c.qty; if (c.m == null) t.unknown += c.qty; else t.m += c.m * c.qty; }
      L.totals = Array.from(totals.values()).sort((a, b) => ncmp(a.pn || a.type, b.pn || b.type));
      L.metres = L.totals.reduce((a, t) => a + t.m, 0);
      // Checks: what's missing before it can be built.
      if (!L.wires.length) L.issues.push('No wires: only one part has this loom name, or its parts aren\'t connected to each other.');
      if (L.loose.length) L.issues.push(`${L.loose.length} wire${L.loose.length === 1 ? ' has' : 's have'} no cable details (tap the wire or bus, then CABLE).`);
      const noLen = L.cables.filter((c) => c.m == null).length;
      if (noLen) L.issues.push(`${noLen} cable${noLen === 1 ? ' has' : 's have'} no length.`);
      const noPn = L.partRows.filter((r) => !r.mpn && !r.value).length;
      if (noPn) L.issues.push(`${noPn} part${noPn === 1 ? ' has' : 's have'} no value or part number.`);
      for (const c of L.cables) if (c.cores && c.wires.length > c.cores) L.issues.push(`${c.id} (${c.f.Cable_PN || c.f.Cable_Type}) carries ${c.wires.length} wires but has ${c.cores} cores.`);
      const multi = Array.from(wiresAt).filter(([, ws]) => ws.length > 2).map(([k]) => k);
      if (multi.length) L.issues.push(`Three or more wires in one pin: ${multi.slice(0, 4).join(', ')}${multi.length > 4 ? '…' : ''} (needs a splice).`);
      out.push(L);
    }
    out.sort((a, b) => ncmp(a.name, b.name));
    // Connectors outside any loom that are wired to one: probably meant to be in it.
    const nearly = new Map();
    // Only connectors wired straight to a loom pin on the drawing: a net that reaches across the
    // boat through labels would list every connector on it.
    for (const L of out) for (const v of L.pins.values()) for (const ok of v.wired || []) {
      const ref = ok.replace(/\.[^.]*$/, ''), e = A.parts.get(ref);
      if (!e || !e.connector || loomOf.has(ref)) continue;
      let s = nearly.get(ref); if (!s) nearly.set(ref, s = { ref, looms: new Set(), page: e.units[0].page, value: prop(e.sym, 'Value') });
      s.looms.add(L.name);
    }
    const suggestions = Array.from(nearly.values()).map((s) => Object.assign(s, { looms: Array.from(s.looms) })).sort((a, b) => ncmp(a.ref, b.ref));
    return { looms: out, suggestions, field: FIELD };
  }
  const pinKey = (p) => p.ref + '.' + p.number;
  // Drawn connectivity on one sheet: wires joined end to end (or a wire end on another wire),
  // without labels. Which pins a tagged wire runs between, and which device a plug is wired to.
  const drawnCache = new WeakMap();
  function drawnOf(inst) {
    let d = drawnCache.get(inst); if (d) return d;
    const sh = inst.sheet, W = sh.wires, on = (q, w) => K.onSegment(q, w.a, w.b);
    const up = W.map((_, i) => i), find = (i) => { while (up[i] !== i) i = up[i] = up[up[i]]; return i; };
    const key = (q) => Math.round(q[0] * 100) + ',' + Math.round(q[1] * 100);
    const ends = new Map();
    W.forEach((w, i) => { for (const q of [w.a, w.b]) { const k = key(q); const o = ends.get(k); if (o === undefined) ends.set(k, i); else up[find(i)] = find(o); } });
    // A wire end landing part way along another wire (KiCad joins those too).
    W.forEach((w, i) => { for (const q of [w.a, w.b]) for (let j = 0; j < W.length; j++) if (j !== i && find(i) !== find(j) && on(q, W[j])) up[find(i)] = find(j); });
    const pinComp = new Map(), compPins = new Map();
    sh.symbols.forEach((sym, si) => {
      const ref = inst.refs[si] && inst.refs[si].ref; if (!ref || !sym.lib || sym.lib.power) return;
      for (const pin of K.symbolPins(sym)) {
        let c = ends.get(key(pin.pos));
        if (c === undefined) for (let j = 0; j < W.length; j++) if (on(pin.pos, W[j])) { c = j; break; }
        if (c === undefined) continue;
        c = find(c);
        const pk = ref + '.' + pin.number;
        pinComp.set(pk, c);
        let a = compPins.get(c); if (!a) compPins.set(c, a = []); if (!a.includes(pk)) a.push(pk);
      }
    });
    d = { find, W, on, pinComp, compPins };
    drawnCache.set(inst, d);
    return d;
  }
  function drawnPins(inst, p) {
    const d = drawnOf(inst);
    const i = d.W.findIndex((w) => d.on(p, w));
    return i < 0 ? [] : (d.compPins.get(d.find(i)) || []).slice();
  }
  // The pins wired straight to pin p (on its own sheet).
  function wiredTo(P, p) {
    const d = drawnOf(P.instances[p.inst]), k = pinKey(p), c = d.pinComp.get(k);
    return c === undefined ? [] : (d.compPins.get(c) || []).filter((x) => x !== k);
  }
  function lengthM(s) {
    const m = /(-?[\d.,]+)\s*(mm|cm|m|ft|')?/i.exec(String(s || '')); if (!m) return null;
    const v = parseFloat(m[1].replace(',', '.')); if (!isFinite(v)) return null;
    const u = (m[2] || 'm').toLowerCase();
    return u === 'mm' ? v / 1000 : u === 'cm' ? v / 100 : u === 'ft' || u === "'" ? v * 0.3048 : v;
  }

  // ---------------------------------------------------------------- tables
  const lenText = (c) => c.length || (c.m != null ? r2(c.m) + ' m' : '');
  function tables(L, what) {
    const S = [];
    const cableById = new Map(L.cables.map((c) => [c.key, c.id]));
    if (what.parts) {
      S.push({ key: 'parts', heading: 'Connectors and parts', sub: L.parts.length + ' parts', cols: ['Ref', 'Value', 'Part number', 'Manufacturer', 'Description', 'Plugs into', 'Page'],
        rows: L.partRows.map((r) => [r.ref, r.value, r.mpn, r.maker, r.desc, r.mates, r.page]) });
      if (L.totals.length) S.push({ key: 'cable-totals', heading: 'Cable to order', sub: 'Each cable once', cols: ['Product code', 'Type', 'Size', 'Cables', 'Total length (m)', 'Cables without a length'],
        rows: L.totals.map((t) => [t.pn, t.type, t.size, t.n, r2(t.m), t.unknown]) });
    }
    if (what.cut) S.push({ key: 'cut', heading: 'Cable cut list', sub: L.cut.length ? L.cables.length + ' cables · ' + r2(L.metres) + ' m' : 'No cable details yet', cols: ['Cable', 'Qty', 'Product code', 'Type', 'Size', 'Cut length', 'Between', 'Cores used', 'Core colours', 'Page'],
      rows: L.cut.map((c) => [c.id, c.qty, c.pn, c.type, c.size, lenText(c), c.ends, c.cores ? `${c.used / c.qty} of ${c.cores}` : c.used / c.qty, c.colours, c.page])
        .concat(L.loose.length ? [['—', L.loose.length, '', 'Single wires (no cable details)', '', '', '', '', '', '']] : []) });
    if (what.wires) S.push({ key: 'wires', heading: 'Wire list', sub: L.wires.length + ' wires', cols: ['#', 'Wire', 'From', 'From pin', 'To', 'To pin', 'Cable', 'Core / colour', 'Signal'],
      rows: L.wires.map((w) => [w.id, w.no, w.a.ref, w.a.number + (pinLabel(w.a) ? ' ' + pinLabel(w.a) : ''), w.b.ref, w.b.number + (pinLabel(w.b) ? ' ' + pinLabel(w.b) : ''),
        w.cable ? (cableById.get(w.cable.key) || '') : '', w.colour, w.signal]) });
    if (what.pinouts) for (const p of L.pinouts) S.push({ key: 'pins-' + p.ref, heading: p.ref + (p.value ? ' · ' + p.value : ''), sub: [p.mates ? 'plugs into ' + p.mates : '', 'page ' + p.page].filter(Boolean).join(' · '),
      cols: ['Pin', 'Name', 'Wire', 'Colour', 'Signal', 'Goes to', 'Mates with'], rows: p.rows.map((r) => [r.pin, r.name, r.wire, r.colour, r.signal, r.to, r.mates]) });
    return S;
  }

  // ---------------------------------------------------------------- flat drawing
  // Parts are boxes with their pin tables; cables (or bundles of single wires) are lines between
  // them, laid out as a tree from the part with most connections, left to right.
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  function drawing(L, meta) {
    meta = meta || {};
    const ROW = 15, HEAD = 40, BW = 270, GAPX = 300, GAPY = 34, PAD = 30;
    // Edges between parts: one per cable, plus one per pair of parts joined by untagged wires.
    // One line per pair of parts: the bundle of cables and wires between them.
    const edges = new Map();
    for (const w of L.wires) {
      if (w.a.ref === w.b.ref) continue;
      const k = [w.a.ref, w.b.ref].sort(ncmp).join('~');
      let e = edges.get(k); if (!e) edges.set(k, e = { a: w.a.ref, b: w.b.ref, wires: [], cables: new Map() });
      e.wires.push(w);
      if (w.cable) e.cables.set(w.cable.key, L.cables.find((c) => c.key === w.cable.key) || w.cable);
    }
    const E = Array.from(edges.values());
    for (const e of E) {
      const cs = Array.from(e.cables.values()), loose = e.wires.filter((w) => !w.cable).length;
      const multi = cs.filter((c) => c.cores > 1), single = cs.length - multi.length;
      const lens = Array.from(new Set(cs.map(lenText).filter(Boolean)));
      e.label = multi.length === 1 && !single && !loose ? [multi[0].id, multi[0].f.Cable_PN || multi[0].f.Cable_Type, lenText(multi[0])].filter(Boolean).join(' · ')
        : [multi.length ? multi.length + ' cable' + (multi.length === 1 ? '' : 's') : '', single ? single + ' single wire' + (single === 1 ? '' : 's') : '', loose ? loose + ' untagged' : '', lens.length === 1 ? lens[0] : lens.length ? lens.length + ' lengths' : ''].filter(Boolean).join(' · ');
      e.loose = !cs.length;
    }
    const refs = L.parts.map((e) => e.ref);
    const adj = new Map(refs.map((r) => [r, []]));
    for (const e of E) { if (adj.has(e.a) && adj.has(e.b)) { adj.get(e.a).push(e); adj.get(e.b).push(e); } }
    // Spanning forest: roots are the best-connected parts.
    const placed = new Map(), kids = new Map(), treeE = new Set();
    const roots = [];
    const byDeg = refs.slice().sort((a, b) => adj.get(b).length - adj.get(a).length || ncmp(a, b));
    for (const r of byDeg) {
      if (placed.has(r)) continue;
      roots.push(r); placed.set(r, 0);
      const q = [r];
      while (q.length) {
        const u = q.shift();
        for (const e of adj.get(u).slice().sort((x, y) => ncmp(x.a === u ? x.b : x.a, y.a === u ? y.b : y.a))) {
          const v = e.a === u ? e.b : e.a;
          if (placed.has(v)) continue;
          placed.set(v, placed.get(u) + 1); treeE.add(e);
          let k = kids.get(u); if (!k) kids.set(u, k = []); k.push({ v, e });
          q.push(v);
        }
      }
    }
    const pin = new Map(L.pinouts.map((p) => [p.ref, p]));
    const rowsOf = (r) => (pin.get(r) ? pin.get(r).rows.filter((x) => x.used) : []);
    const hOf = (r) => HEAD + Math.max(1, rowsOf(r).length) * ROW + 10;
    // Tidy tree: each subtree gets the height its leaves need.
    const pos = new Map();
    let y0 = PAD + 50;
    const sub = (r) => { const ks = kids.get(r) || []; const own = hOf(r); const ch = ks.reduce((s, k) => s + sub(k.v) + GAPY, -GAPY); return Math.max(own, ks.length ? ch : 0); };
    const lay = (r, x, y) => {
      const ks = kids.get(r) || [];
      const total = sub(r);
      pos.set(r, { x, y: y + (total - hOf(r)) / 2, h: hOf(r) });
      let yy = y;
      for (const k of ks) { lay(k.v, x + BW + GAPX, yy); yy += sub(k.v) + GAPY; }
    };
    for (const r of roots) { lay(r, PAD, y0); y0 += sub(r) + GAPY * 2; }
    let W = 0, H = 0;
    for (const p of pos.values()) { W = Math.max(W, p.x + BW + PAD); H = Math.max(H, p.y + p.h + PAD); }
    W = Math.max(W, 900); H = Math.max(H + 70, 400);
    const out = [];
    out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="IBM Plex Sans Condensed, IBM Plex Sans, Arial, sans-serif" font-size="11" class="loom-drawing">`);
    out.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>`);
    out.push(`<text x="${PAD}" y="${PAD + 8}" font-size="20" font-weight="600" fill="#111">Loom ${esc(L.name)}</text>`);
    out.push(`<text x="${PAD}" y="${PAD + 28}" font-size="11" fill="#555">${esc([meta.project, meta.revision, meta.date].filter(Boolean).join(' · '))} · ${L.parts.length} parts · ${L.wires.length} wires · ${L.cables.length} cables${L.metres ? ' · ' + r2(L.metres) + ' m' : ''}</text>`);
    // Edges first, so boxes sit on top.
    const anchor = (r, side) => { const p = pos.get(r); return [side === 'r' ? p.x + BW : p.x, p.y + Math.min(p.h / 2, HEAD / 2 + 8)]; };
    const drawn = new Map();
    for (const e of E) {
      const pa = pos.get(e.a), pb = pos.get(e.b); if (!pa || !pb) continue;
      const [l, r] = pa.x <= pb.x ? [e.a, e.b] : [e.b, e.a];
      const same = pos.get(l).x === pos.get(r).x;
      const k = [l, r].join('~'); const n = drawn.get(k) || 0; drawn.set(k, n + 1);
      const off = n * 12;
      const A1 = anchor(l, same ? 'r' : 'r'), B1 = anchor(r, same ? 'r' : 'l');
      A1[1] += off; B1[1] += off;
      const tree = treeE.has(e);
      const col = e.loose ? '#8a6d00' : '#1f4e79';
      let path, lx, ly;
      if (same) { const xx = A1[0] + 24 + off; path = `M${A1[0]},${A1[1]} H${xx} V${B1[1]} H${B1[0]}`; lx = xx + 4; ly = (A1[1] + B1[1]) / 2; }
      else { const mx = A1[0] + 24 + off; path = `M${A1[0]},${A1[1]} H${mx} V${B1[1]} H${B1[0]}`; lx = mx + 8; ly = B1[1] - 6; }
      out.push(`<path d="${path}" fill="none" stroke="${col}" stroke-width="${tree ? 3 : 2}" ${tree ? '' : 'stroke-dasharray="6 4"'}/>`);
      const nos = e.wires.map((w) => w.no).filter(Boolean);
      out.push(`<text x="${lx}" y="${ly}" fill="${col}" font-weight="600">${esc(clip(e.label, 40))}</text>`);
      out.push(`<text x="${lx}" y="${ly + 13}" fill="#444" font-size="10">${esc(clip(e.wires.length + ' wire' + (e.wires.length === 1 ? '' : 's') + (nos.length ? ': ' + nos.join(', ') : ''), 46))}</text>`);
    }
    for (const r of refs) {
      const p = pos.get(r); if (!p) continue;
      const pr = L.partRows.find((x) => x.ref === r) || {};
      out.push(`<g><rect x="${p.x}" y="${p.y}" width="${BW}" height="${p.h}" rx="4" fill="#f7f9fc" stroke="#222" stroke-width="1.2"/>`);
      out.push(`<rect x="${p.x}" y="${p.y}" width="${BW}" height="${HEAD - 6}" rx="4" fill="#e3ebf5" stroke="none"/>`);
      out.push(`<text x="${p.x + 8}" y="${p.y + 15}" font-size="13" font-weight="600" fill="#111">${esc(r)}</text>`);
      out.push(`<text x="${p.x + BW - 8}" y="${p.y + 15}" text-anchor="end" fill="#333">${esc(clip(pr.mpn || pr.value || '', 30))}</text>`);
      out.push(`<text x="${p.x + 8}" y="${p.y + 29}" font-size="10" fill="#555">${esc(clip([pr.mates ? 'plugs into ' + pr.mates : '', pr.sheet].filter(Boolean).join(' · '), 44))}</text>`);
      const rows = rowsOf(r);
      const cx = [p.x + 8, p.x + 36, p.x + 96, p.x + 168];
      let yy = p.y + HEAD + 6;
      out.push(`<text x="${cx[0]}" y="${yy}" font-size="9" fill="#777">PIN</text><text x="${cx[1]}" y="${yy}" font-size="9" fill="#777">WIRE</text><text x="${cx[2]}" y="${yy}" font-size="9" fill="#777">COLOUR</text><text x="${cx[3]}" y="${yy}" font-size="9" fill="#777">SIGNAL</text>`);
      for (const x of rows) {
        yy += ROW;
        out.push(`<text x="${cx[0]}" y="${yy}" font-weight="600">${esc(x.pin)}</text><text x="${cx[1]}" y="${yy}">${esc(clip(x.wire === x.signal ? '' : x.wire, 10))}</text><text x="${cx[2]}" y="${yy}">${esc(clip(shortCol(x.colour), 12))}</text><text x="${cx[3]}" y="${yy}">${esc(clip(x.signal, 18))}</text>`);
      }
      if (!rows.length) out.push(`<text x="${cx[0]}" y="${yy + ROW}" fill="#999">no pins used</text>`);
      out.push('</g>');
    }
    out.push(`<text x="${PAD}" y="${H - 14}" font-size="9" fill="#777">Solid lines: cables in the loom's tree. Dashed: further cables that close a loop. Lengths are cut lengths from the cable details; breakout positions aren't drawn to scale.</text>`);
    out.push('</svg>');
    return { svg: out.join('\n'), width: W, height: H };
  }
  const shortCol = (c) => String(c || '').replace(/(^|\+ )(Core|Pair) \d+ /g, '$1').replace(/ stripe/g, '');
  const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

  root.Harness = { build, tables, drawing, FIELD, loomOfSym, lengthM };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.Harness;
})(typeof globalThis !== 'undefined' ? globalThis : this);
