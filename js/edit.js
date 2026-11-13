/* Schematic editing engine. Every operation turns into small text splices on the original
 * .kicad_sch source (using the token spans recorded by the parser), so untouched parts of the
 * file stay byte-for-byte identical and GitHub diffs show only real changes. New items are
 * written in KiCad 8/9 format. */
(function (root) {
  'use strict';
  const K = root.KiCore || (typeof require !== 'undefined' ? require('./kicad-core.js') : null);
  const GRID = 1.27;

  // ------------------------------------------------------------------ formatting
  function fnum(v) {
    let r = Math.round(v * 10000) / 10000;
    if (Object.is(r, -0) || Math.abs(r) < 1e-9) r = 0;
    return String(r);
  }
  function qstr(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"'; }
  function uuid() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    const b = new Uint8Array(16);
    if (root.crypto && root.crypto.getRandomValues) root.crypto.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  let SNAP = GRID;   // the editing grid; KiCad's N / Shift+N switch it
  const snap = (v) => Math.round(v / SNAP) * SNAP;
  function setSnapGrid(g) { SNAP = g > 0 ? g : GRID; }
  function snapGrid() { return SNAP; }
  const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3;

  // ------------------------------------------------------------------ splicing
  class Splicer {
    constructor(text) { this.text = text; this.ops = []; }
    replace(s, e, str) { this.ops.push([s, e, str]); }
    insert(pos, str) { this.ops.push([pos, pos, str]); }
    apply() {
      const ops = this.ops.slice().sort((a, b) => b[0] - a[0] || b[1] - a[1]);
      let t = this.text, lastStart = Infinity;
      for (const [s, e, str] of ops) {
        if (e > lastStart) throw new Error('Internal edit conflict; nothing was changed.');
        t = t.slice(0, s) + str + t.slice(e);
        lastStart = s;
      }
      return t;
    }
  }
  function indentAt(text, pos) {
    let i = pos;
    while (i > 0 && (text[i - 1] === '\t' || text[i - 1] === ' ')) i--;
    return text.slice(i, pos);
  }
  function lineStart(text, pos) {
    let i = pos;
    while (i > 0 && (text[i - 1] === '\t' || text[i - 1] === ' ')) i--;
    return i;
  }
  // Range that removes a node together with its own line, when it sits alone on that line.
  function nodeRange(text, node) {
    let s = node.s, e = node.e;
    const ls = lineStart(text, s);
    if (ls === 0 || text[ls - 1] === '\n') {
      let j = e;
      while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
      if (text[j] === '\n') { s = ls; e = j + 1; }
      else if (j >= text.length) { s = ls; e = j; }
    }
    return [s, e];
  }
  function setTok(sp, node, idx, str) { const t = K.tokSpan(sp.text, node, idx); if (!t) throw new Error('Internal edit error: token not found; nothing was changed.'); sp.replace(t[0], t[1], str); }
  function setXY(sp, node, x, y) { setTok(sp, node, 1, fnum(x)); setTok(sp, node, 2, fnum(y)); }
  function atNode(node) { return K.find(node, 'at'); }
  // Where new top-level items go: just before sheet_instances / embedded_fonts, else before the closing paren.
  function insertPoint(sheet) {
    const rootNode = sheet.root, text = sheet.text;
    const before = K.find(rootNode, 'sheet_instances') || K.find(rootNode, 'symbol_instances') || K.find(rootNode, 'embedded_fonts');
    if (before) return lineStart(text, before.s);
    return lineStart(text, rootNode.e - 1);
  }
  function block(lines, ind) { return lines.map((l) => ind + l).join('\n') + '\n'; }

  // ------------------------------------------------------------------ templates (KiCad 8/9 style)
  function wireLines(a, b, id) {
    return ['(wire', '\t(pts', `\t\t(xy ${fnum(a[0])} ${fnum(a[1])}) (xy ${fnum(b[0])} ${fnum(b[1])})`, '\t)', '\t(stroke', '\t\t(width 0)', '\t\t(type default)', '\t)', `\t(uuid ${qstr(id || uuid())})`, ')'];
  }
  function junctionLines(p) {
    return ['(junction', `\t(at ${fnum(p[0])} ${fnum(p[1])})`, '\t(diameter 0)', '\t(color 0 0 0 0)', `\t(uuid ${qstr(uuid())})`, ')'];
  }
  function noConnectLines(p) { return ['(no_connect', `\t(at ${fnum(p[0])} ${fnum(p[1])})`, `\t(uuid ${qstr(uuid())})`, ')']; }
  const SPIN_ANGLE = { right: 0, up: 90, left: 180, bottom: 270 };
  function justifyFor(kind, spin) {
    const right = spin === 'left' || spin === 'bottom';
    if (kind === 'local') return right ? '(justify right bottom)' : '(justify left bottom)';
    return right ? '(justify right)' : '(justify left)';
  }
  function labelLines(kind, name, p, spin, shape) {
    const head = { local: 'label', global: 'global_label', hier: 'hierarchical_label' }[kind];
    const lines = [`(${head} ${qstr(name)}`];
    if (kind !== 'local') lines.push(`\t(shape ${shape || (kind === 'hier' ? 'input' : 'bidirectional')})`);
    lines.push(`\t(at ${fnum(p[0])} ${fnum(p[1])} ${SPIN_ANGLE[spin] || 0})`);
    if (kind === 'global') lines.push('\t(fields_autoplaced yes)');
    lines.push('\t(effects', '\t\t(font', '\t\t\t(size 1.27 1.27)', '\t\t)', '\t\t' + justifyFor(kind, spin), '\t)', `\t(uuid ${qstr(uuid())})`);
    if (kind === 'global') {
      const off = spin === 'left' ? -5 : spin === 'right' ? 5 : 0;
      lines.push(`\t(property "Intersheetrefs" "\${INTERSHEET_REFS}"`, `\t\t(at ${fnum(p[0] + off)} ${fnum(p[1])} 0)`, '\t\t(effects', '\t\t\t(font', '\t\t\t\t(size 1.27 1.27)', '\t\t\t)', '\t\t\t' + justifyFor('global', spin), '\t\t\t(hide yes)', '\t\t)', '\t)');
    }
    lines.push(')');
    return lines;
  }

  // ------------------------------------------------------------------ geometry helpers
  function connectionPoints(sheet) {
    // Every place a wire end can attach on this sheet.
    const pts = [];
    sheet.symbols.forEach((s) => K.symbolPins(s).forEach((p) => pts.push({ p: p.pos, kind: 'pin' })));
    sheet.wires.forEach((w) => { pts.push({ p: w.a, kind: 'wire' }); pts.push({ p: w.b, kind: 'wire' }); });
    sheet.labels.forEach((l) => pts.push({ p: l.p, kind: 'label' }));
    sheet.sheets.forEach((s) => s.pins.forEach((p) => pts.push({ p: p.p, kind: 'sheetpin' })));
    sheet.junctions.forEach((j) => pts.push({ p: j.p, kind: 'junction' }));
    sheet.entries.forEach((e) => { pts.push({ p: e.a, kind: 'entry' }); pts.push({ p: e.b, kind: 'entry' }); });
    return pts;
  }
  const interior = (p, w) => K.onSegment(p, w.a, w.b) && !same(p, w.a) && !same(p, w.b);

  // ------------------------------------------------------------------ operations
  // Each returns { path, text } for the changed sheet (or throws with a readable message).

  function setSymbolFields(sheet, sym, inst, changes) {
    // changes: { fields: {name: value}, add: [{name, value}], dnp: bool|undefined, ref: string|undefined }
    const sp = new Splicer(sheet.text);
    const text = sheet.text;
    for (const p of sym.props) {
      if (p.name === 'Reference') continue;
      if (changes.fields && Object.prototype.hasOwnProperty.call(changes.fields, p.name) && changes.fields[p.name] !== p.value) setTok(sp, p.src, 2, qstr(changes.fields[p.name]));
    }
    if (changes.ref !== undefined) {
      const rp = sym.props.find((p) => p.name === 'Reference');
      if (rp) setTok(sp, rp.src, 2, qstr(changes.ref));
      const insts = K.find(sym.src, 'instances');
      if (insts) for (const pr of K.findAll(insts, 'project')) for (const pa of K.findAll(pr, 'path')) {
        if (pa[1] !== inst.path) continue;
        const r = K.find(pa, 'reference');
        if (r) setTok(sp, r, 1, qstr(changes.ref));
      }
    }
    if (changes.dnp !== undefined && changes.dnp !== sym.dnp) {
      const d = K.find(sym.src, 'dnp');
      if (d) setTok(sp, d, 1, changes.dnp ? 'yes' : 'no');
      else {
        const after = K.find(sym.src, 'on_board') || K.find(sym.src, 'in_bom') || K.find(sym.src, 'unit');
        if (after) sp.insert(after.e, '\n' + indentAt(text, after.s) + `(dnp ${changes.dnp ? 'yes' : 'no'})`);
      }
    }
    if (changes.add && changes.add.length) {
      const last = sym.props.length ? sym.props[sym.props.length - 1].src : null;
      const ind = last ? indentAt(text, last.s) : '\t\t';
      let out = '';
      for (const f of changes.add) {
        if (!f.name) continue;
        out += '\n' + ['(property ' + qstr(f.name) + ' ' + qstr(f.value || ''), `\t(at ${fnum(sym.p[0])} ${fnum(sym.p[1])} 0)`, '\t(effects', '\t\t(font', '\t\t\t(size 1.27 1.27)', '\t\t)', '\t\t(hide yes)', '\t)', ')'].map((l) => ind + l).join('\n');
      }
      if (out) sp.insert(last ? last.e : K.find(sym.src, 'uuid').e, out);
    }
    return { path: sheet.path, text: sp.apply() };
  }

  /** Sets one field to the same value on several symbols of a sheet (added hidden if missing;
   *  an empty value removes it). Used for the Loom field. */
  function setFieldMany(sheet, syms, name, value) {
    const text = sheet.text;
    const sp = new Splicer(text);
    let n = 0;
    for (const sym of syms) {
      const p = sym.props.find((x) => x.name === name);
      if (p) {
        if (!value) { const r = nodeRange(text, p.src); sp.replace(r[0], r[1], ''); n++; }
        else if (p.value !== value) { setTok(sp, p.src, 2, qstr(value)); n++; }
        continue;
      }
      if (!value) continue;
      const last = sym.props.length ? sym.props[sym.props.length - 1].src : null;
      const ind = last ? indentAt(text, last.s) : '\t\t';
      const lines = ['(property ' + qstr(name) + ' ' + qstr(value), `\t(at ${fnum(sym.p[0])} ${fnum(sym.p[1])} 0)`, '\t(effects', '\t\t(font', '\t\t\t(size 1.27 1.27)', '\t\t)', '\t\t(hide yes)', '\t)', ')'];
      sp.insert(last ? last.e : K.find(sym.src, 'uuid').e, '\n' + lines.map((l) => ind + l).join('\n'));
      n++;
    }
    if (!n) return null;
    return { path: sheet.path, text: sp.apply() };
  }

  function renameLabel(sheet, label, name) {
    const sp = new Splicer(sheet.text);
    setTok(sp, label.src, 1, qstr(name));
    return { path: sheet.path, text: sp.apply() };
  }

  function editText(sheet, item, value) {
    const sp = new Splicer(sheet.text);
    setTok(sp, item.src, 1, qstr(value));
    return { path: sheet.path, text: sp.apply() };
  }

  // Move wire endpoints from old to new positions, keeping wires orthogonal by adding a corner.
  // Right-angle paths for stretched and bridging wires: an L either way round, else a Z with
  // its middle leg moved out step by step, never landing on or running along anything else.
  function makeRouter(sheet, moves, skip) {
    const occupied = [];
    for (const c of connectionPoints(sheet)) if (!moves.some((m) => same(m.from, c.p))) occupied.push(c.p);
    for (const m of moves) occupied.push(m.to);
    const lines = sheet.wires.concat(sheet.buses).filter((w) => !(skip && skip.has(w)));
    const overlaps = (u, v) => lines.some((w) => {
      const horiz = Math.abs(u[1] - v[1]) < 1e-3 && Math.abs(w.a[1] - w.b[1]) < 1e-3 && Math.abs(u[1] - w.a[1]) < 1e-3;
      const vert = Math.abs(u[0] - v[0]) < 1e-3 && Math.abs(w.a[0] - w.b[0]) < 1e-3 && Math.abs(u[0] - w.a[0]) < 1e-3;
      if (!horiz && !vert) return false;
      const k = horiz ? 0 : 1;
      const lo = Math.max(Math.min(u[k], v[k]), Math.min(w.a[k], w.b[k])), hi = Math.min(Math.max(u[k], v[k]), Math.max(w.a[k], w.b[k]));
      return hi - lo > 1e-3;
    });
    const bad = (pts) => {
      for (let i = 1; i < pts.length - 1; i++) if (occupied.some((q) => same(q, pts[i]))) return true;
      for (let i = 0; i + 1 < pts.length; i++) {
        const u = pts[i], v = pts[i + 1];
        if (occupied.some((q) => K.onSegment(q, u, v) && !same(q, u) && !same(q, v))) return true;
        if (overlaps(u, v)) return true;
      }
      return false;
    };
    const clean = (pts) => pts.filter((p, i) => i === 0 || !same(p, pts[i - 1]));
    return {
      path(from, to, horizFirst) {
        if (Math.abs(from[0] - to[0]) < 1e-3 || Math.abs(from[1] - to[1]) < 1e-3) return [from, to];
        const c1 = [to[0], from[1]], c2 = [from[0], to[1]];
        const cands = horizFirst === false ? [[from, c2, to], [from, c1, to]] : [[from, c1, to], [from, c2, to]];
        const mx = snap((from[0] + to[0]) / 2), my = snap((from[1] + to[1]) / 2);
        for (let k = 0; k <= 12; k++) for (const sgn of k ? [1, -1] : [1]) {
          const x = mx + sgn * k * GRID * 2, y = my + sgn * k * GRID * 2;
          cands.push([from, [x, from[1]], [x, to[1]], to], [from, [from[0], y], [to[0], y], to]);
        }
        for (const c of cands) if (!bad(c)) { const out = clean(c); for (const q of out) occupied.push(q); return out; }
        return null;
      },
      claim(pts) { for (const q of pts) occupied.push(q); }
    };
  }
  function rubberBand(sp, sheet, moves, movedWires) {
    const text = sheet.text;
    const byWire = new Map();
    const isBus = new Set(sheet.buses);
    const lineFor = (w) => (isBus.has(w) ? busLines : wireLines);
    for (const w of sheet.wires.concat(sheet.buses)) {
      if (movedWires && movedWires.has(w)) continue;
      let a = w.a, b = w.b, ch = false;
      // Each end follows the first move that starts there (moves can swap places, e.g. a mirror).
      const ma = moves.find((m) => same(w.a, m.from)), mb = moves.find((m) => same(w.b, m.from));
      if (ma) { a = ma.to; ch = true; }
      if (mb) { b = mb.to; ch = true; }
      if (ch) byWire.set(w, [a, b]);
    }
    const ins = [];
    // Corners must not land on (or run along) anything else, or they'd short it.
    const router = makeRouter(sheet, moves, new Set([...(movedWires || []), ...byWire.keys()]));
    for (const [, [a, b]] of byWire) router.claim([a, b]);
    const emit = (w, pts) => { for (let i = 0; i + 1 < pts.length; i++) ins.push(lineFor(w)(pts[i], pts[i + 1])); };
    // Something already connects in the middle of this wire (a label, a T-junction, a pin...)?
    const midConnected = (w) => connectionPoints(sheet).some((c) => interior(c.p, w));
    for (const [w, [a, b]] of byWire) {
      if (midConnected(w)) {
        // Leave the wire alone and bridge each moved end with a new stub wire instead.
        for (const m of moves) {
          for (const end of [w.a, w.b]) {
            if (!same(end, m.from)) continue;
            emit(w, router.path(m.from, m.to, Math.abs(w.a[1] - w.b[1]) < 1e-3) || [m.from, m.to]);
          }
        }
        continue;
      }
      const pts = K.find(w.src, 'pts');
      const xys = K.findAll(pts, 'xy');
      if (same(a, b)) { const r = nodeRange(text, w.src); sp.replace(r[0], r[1], ''); continue; }
      const orthogonal = Math.abs(a[0] - b[0]) < 1e-3 || Math.abs(a[1] - b[1]) < 1e-3;
      if (orthogonal || xys.length !== 2) {
        setXY(sp, xys[w.seg], a[0], a[1]);
        setXY(sp, xys[w.seg + 1], b[0], b[1]);
      } else {
        // Was horizontal: run horizontal from the fixed end, then turn. Was vertical: the reverse.
        const wasHoriz = Math.abs(w.a[1] - w.b[1]) < 1e-3;
        const fixedA = same(a, w.a);
        const fixed = fixedA ? a : b, moving = fixedA ? b : a;
        const pts = router.path(fixed, moving, wasHoriz);
        if (!pts) {
          // No clear right-angle path: leave this wire diagonal (still connected).
          setXY(sp, xys[0], a[0], a[1]);
          setXY(sp, xys[1], b[0], b[1]);
          continue;
        }
        setXY(sp, xys[0], pts[0][0], pts[0][1]);
        setXY(sp, xys[1], pts[1][0], pts[1][1]);
        emit(w, pts.slice(1));
      }
    }
    return ins;
  }

  // Labels, junctions and no-connect flags sitting on a moved pin or wire end come along too.
  function dragAttached(sp, sheet, moves, skip) {
    // Power symbols and flags plugged straight onto a moved pin travel with it.
    for (const s of sheet.symbols) {
      if (!s.lib || !s.lib.power || (skip && skip.has(s))) continue;
      const pins = K.symbolPins(s);
      if (pins.length !== 1) continue;
      const m = moves.find((mv) => same(mv.from, pins[0].pos));
      if (m) symbolMoveSplices(sp, sheet, s, [m.to[0] - m.from[0], m.to[1] - m.from[1]]);
    }
    for (const j of sheet.junctions.concat(sheet.noConnects)) {
      if (skip && skip.has(j)) continue;
      const m = moves.find((mv) => same(mv.from, j.p));
      if (m) setXY(sp, atNode(j.src), m.to[0], m.to[1]);
    }
    for (const l of sheet.labels) {
      if (skip && skip.has(l)) continue;
      const m = moves.find((mv) => same(mv.from, l.p));
      if (!m) continue;
      const d = [m.to[0] - l.p[0], m.to[1] - l.p[1]];
      setXY(sp, atNode(l.src), m.to[0], m.to[1]);
      for (const p of l.props) { const pa = atNode(p.src); if (pa) setXY(sp, pa, p.p[0] + d[0], p.p[1] + d[1]); }
    }
  }

  function symbolMoveSplices(sp, sheet, sym, d) {
    const a = atNode(sym.src);
    setXY(sp, a, sym.p[0] + d[0], sym.p[1] + d[1]);
    for (const p of sym.props) { const pa = atNode(p.src); if (pa) setXY(sp, pa, p.p[0] + d[0], p.p[1] + d[1]); }
  }

  /** Move items by d (mm). items: [{type:'symbol', sym} | {type:'sheet', sheet} | {type:'label', label} | {type:'wire', wire} (a wire or bus) | {type:'junction'|'nc'|'text', item}] */
  function moveItems(sheet, items, d, opts) {
    opts = opts || {};
    const sp = new Splicer(sheet.text);
    const moves = [];
    const movedWires = new Set();
    for (const it of items) {
      if (it.type === 'symbol') {
        symbolMoveSplices(sp, sheet, it.sym, d);
        for (const p of K.symbolPins(it.sym)) moves.push({ from: p.pos, to: [p.pos[0] + d[0], p.pos[1] + d[1]] });
      } else if (it.type === 'label') {
        const l = it.label;
        setXY(sp, atNode(l.src), l.p[0] + d[0], l.p[1] + d[1]);
        for (const p of l.props) { const pa = atNode(p.src); if (pa) setXY(sp, pa, p.p[0] + d[0], p.p[1] + d[1]); }
      } else if (it.type === 'wire') {
        const w = it.wire;
        movedWires.add(w);
        const xys = K.findAll(K.find(w.src, 'pts'), 'xy');
        setXY(sp, xys[w.seg], w.a[0] + d[0], w.a[1] + d[1]);
        setXY(sp, xys[w.seg + 1], w.b[0] + d[0], w.b[1] + d[1]);
        moves.push({ from: w.a, to: [w.a[0] + d[0], w.a[1] + d[1]] }, { from: w.b, to: [w.b[0] + d[0], w.b[1] + d[1]] });
      } else if (it.type === 'sheet') {
        // A hierarchical sheet: its box, fields and pins move; wires on its pins stretch.
        shiftCoords(sp, it.sheet.src, d);
        for (const p of it.sheet.pins) moves.push({ from: p.p, to: [p.p[0] + d[0], p.p[1] + d[1]] });
      } else if (it.type === 'node') {
        shiftCoords(sp, it.node, d);
      } else if (it.item) {
        const a = atNode(it.item.src);
        setXY(sp, a, it.item.p[0] + d[0], it.item.p[1] + d[1]);
      }
    }
    let extra = [];
    if (opts.keepWires !== false && moves.length) {
      const all = sheet.wires.concat(sheet.buses);
      const fixed = all.filter((w) => !movedWires.has(w));
      // A wire that T-joins the middle of a moved wire follows it.
      for (const w of fixed) for (const q of [w.a, w.b]) {
        if (moves.some((m) => same(m.from, q))) continue;
        for (const mw of movedWires) if (interior(q, mw)) { moves.push({ from: q, to: [q[0] + d[0], q[1] + d[1]] }); break; }
      }
      // A moved end that sat on the middle of a wire that stays put gets a bridge back to it.
      const isBusW = new Set(sheet.buses);
      const bridged = [], stay = new Set(), moving = new Set(items.map((it) => it.item).filter(Boolean));
      const bridgeRouter = makeRouter(sheet, moves, movedWires);
      for (const m of moves.slice()) {
        if (fixed.some((w) => same(w.a, m.from) || same(w.b, m.from))) continue;   // stretched below
        const host = fixed.find((w) => interior(m.from, w));
        if (!host) continue;
        const lines = isBusW.has(host) ? busLines : wireLines;
        const pts = bridgeRouter.path(m.from, m.to, Math.abs(host.a[1] - host.b[1]) >= 1e-3) || [m.from, [m.to[0], m.from[1]], m.to];
        for (let i = 0; i + 1 < pts.length; i++) if (!same(pts[i], pts[i + 1])) extra.push(lines(pts[i], pts[i + 1]));
        bridged.push(m.from);
        const keep = sheet.junctions.find((j) => same(j.p, m.from) && !moving.has(j));
        if (keep) stay.add(keep); else extra.push(junctionLines(m.from));
      }
      extra = extra.concat(rubberBand(sp, sheet, moves, movedWires));
      dragAttached(sp, sheet, moves, new Set(items.map((it) => it.item || it.label || it.sym).filter(Boolean).concat(Array.from(stay))));
    }
    if (extra.length) { const ip = insertPoint(sheet); sp.insert(ip, extra.map((l) => block(l, '\t')).join('')); }
    return { path: sheet.path, text: sp.apply() };
  }

  function orientationFor(m) {
    for (const mir of [null, 'x', 'y']) for (const ang of [0, 90, 180, 270]) {
      const t = K.symTransform(ang, mir);
      if (t[0] === m[0] && t[1] === m[1] && t[2] === m[2] && t[3] === m[3]) return { angle: ang, mirror: mir };
    }
    return { angle: 0, mirror: null };
  }
  // KiCad applies incremental rotations/mirrors after the existing transform.
  function compose(t, m) {
    return [m[0] * t[0] + m[2] * t[1], m[1] * t[0] + m[3] * t[1], m[0] * t[2] + m[2] * t[3], m[1] * t[2] + m[3] * t[3]];
  }
  const OPS = { rotate: [0, 1, -1, 0], mirrorX: [1, 0, 0, -1], mirrorY: [-1, 0, 0, 1] };

  /** Rotate (counter-clockwise, like KiCad's R) or mirror a symbol about its anchor. */
  function transformSymbol(sheet, sym, op, opts) {
    opts = opts || {};
    const sp = new Splicer(sheet.text);
    const newM = compose(OPS[op], sym.m);
    const o = orientationFor(newM);
    const a = atNode(sym.src);
    if (a.length > 3) setTok(sp, a, 3, String(o.angle)); else sp.insert(K.tokSpan(sp.text, a, 2)[1], ' ' + o.angle);
    const mir = K.find(sym.src, 'mirror');
    if (o.mirror) {
      if (mir) setTok(sp, mir, 1, o.mirror);
      else sp.insert(a.e, '\n' + indentAt(sheet.text, a.s) + `(mirror ${o.mirror})`);
    } else if (mir) {
      const r = nodeRange(sheet.text, mir); sp.replace(r[0], r[1], '');
    }
    // Fields keep their place relative to the symbol body
    for (const p of sym.props) {
      const pa = atNode(p.src); if (!pa) continue;
      const rel = K.tfInv(sym.m, [p.p[0] - sym.p[0], p.p[1] - sym.p[1]]);
      const q = K.tf(newM, rel);
      setXY(sp, pa, sym.p[0] + q[0], sym.p[1] + q[1]);
    }
    const tmp = Object.assign({}, sym, { m: newM, _pins: null });
    const oldPins = K.symbolPins(sym), newPins = K.symbolPins(tmp);
    const moves = oldPins.map((p, i) => ({ from: p.pos, to: newPins[i].pos })).filter((mv) => !same(mv.from, mv.to));
    let extra = [];
    if (opts.keepWires !== false && moves.length) {
      extra = rubberBand(sp, sheet, moves);
      dragAttached(sp, sheet, moves, new Set([sym]));
    }
    if (extra.length) sp.insert(insertPoint(sheet), extra.map((l) => block(l, '\t')).join(''));
    return { path: sheet.path, text: sp.apply() };
  }

  function rotateLabel(sheet, label) {
    const order = ['right', 'up', 'left', 'bottom'];
    const spin = order[(order.indexOf(label.spin) + 1) % 4];
    const sp = new Splicer(sheet.text);
    const a = atNode(label.src);
    if (a.length > 3) setTok(sp, a, 3, String(SPIN_ANGLE[spin])); else sp.insert(K.tokSpan(sp.text, a, 2)[1], ' ' + SPIN_ANGLE[spin]);
    const fx = K.find(label.src, 'effects');
    const just = fx && K.find(fx, 'justify');
    const jtext = justifyFor(label.kind === 'directive' ? 'global' : label.kind, spin);
    if (just) sp.replace(just.s, just.e, jtext);
    else if (fx) sp.insert(fx.e - 1, ' ' + jtext);
    return { path: sheet.path, text: sp.apply() };
  }

  /** Delete items; junctions left with fewer than three connections are tidied away. */
  function deleteItems(sheet, items) {
    const sp = new Splicer(sheet.text);
    const removed = new Set();
    const nodes = [];
    for (const it of items) {
      const n = it.type === 'symbol' ? it.sym.src : it.type === 'label' ? it.label.src : it.type === 'wire' ? it.wire.src : it.type === 'sheet' ? it.sheet.src : it.item && it.item.src;
      if (n && !removed.has(n)) { removed.add(n); nodes.push(n); }
    }
    // Orphaned junctions
    const gone = new Set(items.filter((i) => i.type === 'wire').map((i) => i.wire));
    const goneSyms = new Set(items.filter((i) => i.type === 'symbol').map((i) => i.sym));
    for (const j of sheet.junctions) {
      if (removed.has(j.src)) continue;
      let n = 0;
      for (const w of sheet.wires) { if (gone.has(w)) continue; if (same(w.a, j.p) || same(w.b, j.p)) n++; else if (interior(j.p, w)) n += 2; }
      for (const s of sheet.symbols) { if (goneSyms.has(s)) continue; for (const p of K.symbolPins(s)) if (same(p.pos, j.p)) n++; }
      for (const w of sheet.buses.concat(sheet.entries)) { if (removed.has(w.src)) continue; if (same(w.a, j.p) || same(w.b, j.p)) n++; else if (interior(j.p, w)) n += 2; }
      if (n < 3) { removed.add(j.src); nodes.push(j.src); }
    }
    for (const n of nodes) { const r = nodeRange(sheet.text, n); sp.replace(r[0], r[1], ''); }
    return { path: sheet.path, text: sp.apply() };
  }

  function nextReference(project, ref) {
    const m = /^(.*?)(\d+)$/.exec(ref.replace(/\?$/, ''));
    const prefix = m ? m[1] : ref.replace(/\?$/, '');
    let max = 0;
    for (const inst of project.instances) for (const r of inst.refs) {
      if (r.ref.startsWith(prefix)) { const t = r.ref.slice(prefix.length); if (/^\d+$/.test(t)) { const n = parseInt(t, 10); if (n > max) max = n; } }
    }
    return { prefix, next: max + 1 };
  }

  /** Duplicate a placed symbol, offset by d, with fresh UUIDs and the next free reference. */
  function copySymbol(project, sheet, inst, sym, d) {
    const src = sheet.text.slice(sym.src.s, sym.src.e);
    const node = K.parseSexpr(src, true);
    const sp = new Splicer(src);
    const u = K.find(node, 'uuid'); if (u) setTok(sp, u, 1, qstr(uuid()));
    for (const pn of K.findAll(node, 'pin')) { const pu = K.find(pn, 'uuid'); if (pu) setTok(sp, pu, 1, qstr(uuid())); }
    const a = atNode(node); setXY(sp, a, sym.p[0] + d[0], sym.p[1] + d[1]);
    const ref0 = inst.refs[sheet.symbols.indexOf(sym)].ref;
    const { prefix, next } = nextReference(project, ref0);
    // One reference per placement of this sheet file (reused sheets get one each)
    const placements = project.instances.filter((i) => i.sheet === sheet);
    const refs = new Map();
    let n = next;
    for (const pl of placements) refs.set(pl.path, prefix + n++);
    const myRef = refs.get(inst.path) || prefix + next;
    for (const p of K.findAll(node, 'property')) {
      const pa = atNode(p); if (pa) setXY(sp, pa, num(p, pa, 1) + d[0], num(p, pa, 2) + d[1]);
      if (p[1] === 'Reference') setTok(sp, p, 2, qstr(myRef));
    }
    const insts = K.find(node, 'instances');
    if (insts) {
      const ind = indentAt(src, insts.s);
      const proj = K.find(insts, 'project');
      const projName = proj ? proj[1] : project.name;
      const unit = String(sym.unit || 1);
      const lines = ['(instances', `\t(project ${qstr(projName)}`];
      for (const pl of placements) lines.push(`\t\t(path ${qstr(pl.path)}`, `\t\t\t(reference ${qstr(refs.get(pl.path))})`, `\t\t\t(unit ${unit})`, '\t\t)');
      lines.push('\t)', ')');
      sp.replace(insts.s, insts.e, lines.map((l, i) => (i ? ind : '') + l).join('\n'));
    }
    const copyText = sp.apply();
    const top = new Splicer(sheet.text);
    const ip = insertPoint(sheet);
    const ind = indentAt(sheet.text, sym.src.s);
    top.insert(ip, ind + copyText + '\n');
    return { path: sheet.path, text: top.apply(), ref: myRef, at: [sym.p[0] + d[0], sym.p[1] + d[1]] };
    function num(p, pa, i) { return parseFloat(pa[i]); }
  }

  /** Add a polyline of wires; splits existing wires where the new ends land and adds junctions. */
  function addWires(sheet, points) {
    const segs = [];
    for (let i = 0; i + 1 < points.length; i++) if (!same(points[i], points[i + 1])) segs.push([points[i], points[i + 1]]);
    return addWireSegs(sheet, segs);
  }
  /** Add separate wire segments [[a, b], ...] (a stencil's arms), with the same splitting and junctions. */
  function addWireSegs(sheet, segs) {
    segs = segs.filter(([a, b]) => !same(a, b));
    if (!segs.length) throw new Error('Draw at least one segment.');
    const sp = new Splicer(sheet.text);
    const newLines = [];
    const conn = connectionPoints(sheet);
    // Split new segments at existing connection points that fall inside them
    const finalSegs = [];
    for (const [a, b] of segs) {
      const inner = conn.filter((c) => interior(c.p, { a, b })).map((c) => c.p);
      const uniq = [];
      for (const p of inner) if (!uniq.some((q) => same(q, p))) uniq.push(p);
      uniq.sort((p, q) => Math.hypot(p[0] - a[0], p[1] - a[1]) - Math.hypot(q[0] - a[0], q[1] - a[1]));
      let prev = a;
      for (const p of uniq) { finalSegs.push([prev, p]); prev = p; }
      finalSegs.push([prev, b]);
    }
    for (const [a, b] of finalSegs) newLines.push(wireLines(a, b));
    // Split existing wires where a new end lands mid-segment
    const ends = [];
    for (const [a, b] of finalSegs) for (const p of [a, b]) if (!ends.some((q) => same(q, p))) ends.push(p);
    const splitDone = new Set();
    for (const p of ends) {
      for (const w of sheet.wires) {
        if (splitDone.has(w) || !interior(p, w)) continue;
        splitDone.add(w);
        const xys = K.findAll(K.find(w.src, 'pts'), 'xy');
        setXY(sp, xys[w.seg + 1], p[0], p[1]);
        newLines.push(wireLines(p, w.b));
      }
    }
    // Junctions where three or more things meet
    for (const p of ends) {
      if (sheet.junctions.some((j) => same(j.p, p))) continue;
      let n = 0;
      for (const [a, b] of finalSegs) { if (same(a, p)) n++; if (same(b, p)) n++; }
      for (const w of sheet.wires) { if (same(w.a, p) || same(w.b, p)) n++; else if (interior(p, w)) n += 2; }
      for (const s of sheet.symbols) for (const pin of K.symbolPins(s)) if (same(pin.pos, p)) n++;
      if (n >= 3) newLines.push(junctionLines(p));
    }
    sp.insert(insertPoint(sheet), newLines.map((l) => block(l, '\t')).join(''));
    return { path: sheet.path, text: sp.apply() };
  }

  function addLabel(sheet, kind, name, p, spin, shape) {
    if (!name) throw new Error('Give the label a name.');
    const sp = new Splicer(sheet.text);
    const lines = [labelLines(kind, name, p, spin || 'right', shape)];
    // KiCad expects labels on a wire end, so split a wire that the label sits in the middle of.
    for (const w of sheet.wires) {
      if (!interior(p, w)) continue;
      const xys = K.findAll(K.find(w.src, 'pts'), 'xy');
      setXY(sp, xys[w.seg + 1], p[0], p[1]);
      lines.push(wireLines(p, w.b));
      break;
    }
    sp.insert(insertPoint(sheet), lines.map((l) => block(l, '\t')).join(''));
    return { path: sheet.path, text: sp.apply() };
  }

  function addNoConnect(sheet, p) {
    if (sheet.noConnects.some((n) => same(n.p, p))) throw new Error('There is already a no-connect flag there.');
    const sp = new Splicer(sheet.text);
    sp.insert(insertPoint(sheet), block(noConnectLines(p), '\t'));
    return { path: sheet.path, text: sp.apply() };
  }
  function addJunction(sheet, p) {
    if (sheet.junctions.some((j) => same(j.p, p))) throw new Error('There is already a junction there.');
    const sp = new Splicer(sheet.text);
    sp.insert(insertPoint(sheet), block(junctionLines(p), '\t'));
    return { path: sheet.path, text: sp.apply() };
  }
  /** Re-read a sheet from edited text, so the next step of a multi-step edit sees the change. */
  function reparse(sheet, r) { return K.parseSchematic(r.text, sheet.path); }

  /**
   * Make things placed at pts connect to wires running through them: each wire with one of the
   * points inside it is split there (KiCad joins wires only at their ends), and a junction is added
   * where three or more wire ends and pins now meet.
   */
  function connectAt(sheet, pts) {
    const sp = new Splicer(sheet.text);
    const lines = [];
    const cuts = new Map();
    for (const p of pts) for (const w of sheet.wires) {
      if (!interior(p, w)) continue;
      const l = cuts.get(w) || []; if (!l.some((q) => same(q, p))) l.push(p); cuts.set(w, l);
    }
    for (const [w, list] of cuts) {
      list.sort((p, q) => Math.hypot(p[0] - w.a[0], p[1] - w.a[1]) - Math.hypot(q[0] - w.a[0], q[1] - w.a[1]));
      const xys = K.findAll(K.find(w.src, 'pts'), 'xy');
      setXY(sp, xys[w.seg + 1], list[0][0], list[0][1]);
      for (let i = 0; i < list.length; i++) lines.push(wireLines(list[i], i + 1 < list.length ? list[i + 1] : w.b));
    }
    for (const p of pts) {
      if (sheet.junctions.some((j) => same(j.p, p))) continue;
      let n = 0;
      for (const w of sheet.wires) { if (same(w.a, p) || same(w.b, p)) n++; else if (interior(p, w)) n += 2; }
      for (const s of sheet.symbols) for (const pin of K.symbolPins(s)) if (same(pin.pos, p)) n++;
      if (n >= 3 && !lines.some((l) => l[0] === '(junction' && l[1].includes(`${fnum(p[0])} ${fnum(p[1])}`))) lines.push(junctionLines(p));
    }
    if (!lines.length) return { path: sheet.path, text: sheet.text };
    sp.insert(insertPoint(sheet), lines.map((l) => block(l, '\t')).join(''));
    return { path: sheet.path, text: sp.apply() };
  }

  /** Cut the stretch of wire w between pa and pb (both on it), so a two-pin part dropped there sits in series. */
  function insertInWire(sheet, w, pa, pb) {
    const t = (p) => Math.hypot(p[0] - w.a[0], p[1] - w.a[1]);
    const [p, q] = t(pa) <= t(pb) ? [pa, pb] : [pb, pa];
    if (!K.onSegment(p, w.a, w.b) || !K.onSegment(q, w.a, w.b)) throw new Error('The part does not fit on that wire.');
    const sp = new Splicer(sheet.text);
    const xys = K.findAll(K.find(w.src, 'pts'), 'xy');
    const keepA = !same(w.a, p), keepB = !same(q, w.b);
    const out = [];
    if (keepA) { setXY(sp, xys[w.seg + 1], p[0], p[1]); if (keepB) out.push(wireLines(q, w.b)); }
    else if (keepB) setXY(sp, xys[w.seg], q[0], q[1]);
    else { const r = nodeRange(sheet.text, w.src); sp.replace(r[0], r[1], ''); }
    if (out.length) sp.insert(insertPoint(sheet), out.map((l) => block(l, '\t')).join(''));
    return { path: sheet.path, text: sp.apply() };
  }

  // ------------------------------------------------------------------ copy and paste
  /**
   * Copy items from a sheet: items are [{type:'symbol', sym, ref, unit} | {type:'wire'|'label'|'junction'|'nc'|'node', obj}].
   * Returns a clipboard: the items' own text, the library symbols they use and their bounding origin.
   */
  function copyItems(sheet, items) {
    const out = { version: sheet.version, items: [], libs: {}, origin: null };
    let ox = Infinity, oy = Infinity;
    const grow = (p) => { if (p) { ox = Math.min(ox, p[0]); oy = Math.min(oy, p[1]); } };
    const ls = K.find(sheet.root, 'lib_symbols');
    for (const it of items) {
      const o = it.type === 'symbol' ? it.sym : it.obj;
      if (!o || !o.src) continue;
      const text = sheet.text.slice(o.src.s, o.src.e);
      const entry = { type: it.type, text };
      if (it.type === 'symbol') {
        entry.ref = it.ref; entry.unit = o.unit || 1;
        const lib = o.libName || o.libId;
        const node = ls && K.findAll(ls, 'symbol').find((s) => s[1] === lib);
        if (node && !out.libs[lib]) out.libs[lib] = sheet.text.slice(node.s, node.e);
        grow(o.p);
      } else if (it.type === 'wire') { grow(o.a); grow(o.b); }
      else if (o.p) grow(o.p);
      else {
        const walk = (n) => { if (!Array.isArray(n)) return; if (COORD_KEYS.includes(n[0]) && n.length >= 3) grow([parseFloat(n[1]), parseFloat(n[2])]); else n.forEach(walk); };
        walk(o.src);
      }
      out.items.push(entry);
    }
    out.origin = isFinite(ox) ? [snap(ox), snap(oy)] : [0, 0];
    return out;
  }

  /** Paste a clipboard onto a sheet so its origin lands at p: new UUIDs, the next free references, library symbols added. */
  function pasteItems(project, sheet, inst, clip, p) {
    if (!clip || !clip.items.length) throw new Error('Nothing has been copied yet.');
    const d = [p[0] - clip.origin[0], p[1] - clip.origin[1]];
    const sp = new Splicer(sheet.text);
    // library symbols the copy needs
    const ls = K.find(sheet.root, 'lib_symbols');
    const missing = Object.keys(clip.libs).filter((k) => !sheet.libSymbols[k]);
    if (missing.length) {
      const blockText = missing.map((k) => pretty(clip.libs[k], 2)).join('\n') + '\n';
      if (ls && ls.length > 1) sp.insert(lineStart(sheet.text, ls.e - 1), blockText);
      else if (ls) sp.replace(ls.s, ls.e, '(lib_symbols\n' + blockText + '\t)');
      else sp.insert(insertPoint(sheet), '\t(lib_symbols\n' + blockText + '\t)\n');
    }
    // new references: one per copied reference (units of one part stay together), per placement of this sheet
    const placements = project.instances.filter((i) => i.sheet === sheet);
    const counters = new Map();
    const nextFor = (old) => {
      const power = old.startsWith('#');
      const m = /^(.*?)(\d+)$/.exec(old.replace(/\?$/, ''));
      const prefix = m ? m[1] : old.replace(/\?$/, '');
      let n = counters.get(prefix);
      if (n === undefined) n = nextReference(project, prefix + '0').next;
      counters.set(prefix, n + 1);
      return prefix + (power ? String(n).padStart(2, '0') : n);
    };
    const refMap = new Map();   // old ref -> Map(placement path -> new ref)
    const newRefs = [];
    const uuids = [];
    const projName = projectNameFor(project, sheet);
    const chunks = [];
    for (const it of clip.items) {
      const node = K.parseSexpr(it.text, true);
      const isp = new Splicer(it.text);
      const walk = (n, top) => {
        if (!Array.isArray(n)) return;
        if (n[0] === 'uuid' && n.s !== undefined && n.length >= 2) { const id = uuid(); setTok(isp, n, 1, qstr(id)); if (top) uuids.push(id); return; }
        if (n[0] === 'instances') return;
        if (COORD_KEYS.includes(n[0]) && n.s !== undefined && n.length >= 3) { setXY(isp, n, parseFloat(n[1]) + d[0], parseFloat(n[2]) + d[1]); return; }
        for (const c of n) walk(c, false);
      };
      for (const c of node) walk(c, true);
      if (it.type === 'symbol') {
        let refs = refMap.get(it.ref);
        if (!refs) { refs = new Map(); for (const pl of placements) refs.set(pl.path, nextFor(it.ref)); refMap.set(it.ref, refs); }
        const mine = refs.get(inst.path) || refs.values().next().value || nextFor(it.ref);
        if (!newRefs.includes(mine)) newRefs.push(mine);
        for (const pr of K.findAll(node, 'property')) if (pr[1] === 'Reference') setTok(isp, pr, 2, qstr(mine));
        const insts = K.find(node, 'instances');
        if (insts) {
          const ind = indentAt(it.text, insts.s);
          const lines = ['(instances', `\t(project ${qstr(projName)}`];
          for (const pl of placements) lines.push(`\t\t(path ${qstr(pl.path)}`, `\t\t\t(reference ${qstr(refs.get(pl.path))})`, `\t\t\t(unit ${it.unit || 1})`, '\t\t)');
          lines.push('\t)', ')');
          isp.replace(insts.s, insts.e, lines.map((l, i) => (i ? ind : '') + l).join('\n'));
        }
      }
      chunks.push('\t' + isp.apply() + '\n');
    }
    sp.insert(insertPoint(sheet), chunks.join(''));
    return { path: sheet.path, text: sp.apply(), refs: newRefs, uuids, d };
  }


  // ------------------------------------------------------------------ library parts
  // Pretty-print an S-expression the way KiCad writes files: one list per line, tab indented;
  // lists of atoms stay on one line, and pts keeps its xy points together.
  function pretty(text, depth) {
    const lines = [];
    const emit = (s, d) => lines.push('\t'.repeat(d) + s);
    function walk(src, d) {
      const items = splitTop(src);
      if (!items.some((x) => x[0] === '(')) { emit('(' + items.join(' ') + ')', d); return; }
      if (items[0] === 'pts') {
        emit('(pts', d);
        const xs = items.slice(1);
        for (let i = 0; i < xs.length; i += 6) emit(xs.slice(i, i + 6).join(' '), d + 1);
        emit(')', d);
        return;
      }
      const atoms = [];
      let i = 0;
      while (i < items.length && items[i][0] !== '(') atoms.push(items[i++]);
      emit('(' + atoms.join(' '), d);
      for (; i < items.length; i++) { if (items[i][0] === '(') walk(items[i], d + 1); else emit(items[i], d + 1); }
      emit(')', d);
    }
    walk(text.trim(), depth || 0);
    return lines.join('\n');
  }
  // Top-level items of one list's text: atoms (strings kept quoted) and sub-lists as raw text.
  function splitTop(src) {
    const out = [];
    let i = 1, n = src.length - 1;
    while (i < n) {
      const c = src[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      const s = i;
      if (c === '(') {
        let depth = 0, inS = false;
        for (; i < n + 1; i++) {
          const ch = src[i];
          if (inS) { if (ch === '\\') i++; else if (ch === '"') inS = false; continue; }
          if (ch === '"') inS = true; else if (ch === '(') depth++; else if (ch === ')') { depth--; if (!depth) { i++; break; } }
        }
      } else if (c === '"') {
        i++;
        for (; i < n; i++) { if (src[i] === '\\') { i++; continue; } if (src[i] === '"') { i++; break; } }
      } else {
        while (i < n && !/[\s()]/.test(src[i])) i++;
      }
      out.push(src.slice(s, i));
    }
    return out;
  }
  // Make a library symbol self-contained under its schematic name ("Lib:Name"): resolve
  // "extends" from the parent, rename units, and drop syntax older KiCad versions don't know.
  function flattenLibSymbol(lib, name, text, parentText, version) {
    let items = splitTop(text);
    let body = items.slice(2);
    const ext = body.find((x) => /^\(extends\s/.test(x));
    if (ext) {
      if (!parentText) throw new Error(`${name} is based on another symbol that wasn't found.`);
      const pItems = splitTop(parentText);
      const pName = JSON.parse(pItems[1]);
      const own = body.filter((x) => !/^\(extends\s/.test(x));
      const ownHead = new Set(own.map((x) => (/^\((\w+)/.exec(x) || [])[1]));
      const fromParent = pItems.slice(2).filter((x) => { const h = (/^\((\w+)/.exec(x) || [])[1]; return h === 'symbol' ? true : h === 'property' ? false : !ownHead.has(h); })
        .map((x) => (/^\(symbol\s/.test(x) ? x.replace(/^\(symbol\s+"([^"]*)"/, (m, n) => '(symbol ' + qstr(n.startsWith(pName + '_') ? name + n.slice(pName.length) : n)) : x));
      const order = ['power', 'pin_numbers', 'pin_names', 'exclude_from_sim', 'in_bom', 'on_board', 'property', 'symbol', 'embedded_fonts'];
      const rank = (x) => { const h = (/^\((\w+)/.exec(x) || [])[1]; const r = order.indexOf(h); return r < 0 ? 5.5 : r; };
      body = own.concat(fromParent).map((x, i) => [x, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]);
    }
    if (version && version < 20241004) body = body.filter((x) => !/^\(embedded_fonts\s/.test(x));
    let out = '(symbol ' + qstr(lib + ':' + name) + ' ' + body.join(' ') + ')';
    if (version && version < 20231120) {
      // KiCad 7: bare "hide" flags, no exclude_from_sim
      out = out.replace(/\(exclude_from_sim (yes|no)\)\s*/g, '').replace(/\(hide yes\)/g, 'hide').replace(/\(hide no\)/g, '');
    }
    return out;
  }
  /** Units a library symbol defines (unit 0 holds pins shared by all units). */
  function libUnits(flatText) {
    const units = new Set();
    for (const x of splitTop(flatText)) { const m = /^\(symbol\s+"[^"]*?_(\d+)_(\d+)"/.exec(x); if (m && m[1] !== '0') units.add(+m[1]); }
    return units.size ? Array.from(units).sort((a, b) => a - b) : [1];
  }
  function pinNumbersFor(flatText, unit) {
    const nums = [];
    for (const x of splitTop(flatText)) {
      const m = /^\(symbol\s+"[^"]*?_(\d+)_(\d+)"/.exec(x);
      if (!m || (m[1] !== '0' && +m[1] !== unit)) continue;
      const re = /\(number\s+"((?:[^"\\]|\\.)*)"/g; let r;
      while ((r = re.exec(x))) if (!nums.includes(r[1])) nums.push(r[1]);
    }
    return nums;
  }
  function projectNameFor(project, sheet) {
    for (const s of sheet.symbols) { const n = s.src && K.find(s.src, 'instances'); const pr = n && K.find(n, 'project'); if (pr) return pr[1]; }
    return project.name;
  }
  /**
   * Place a part from a library: embeds the symbol in lib_symbols (once per sheet file) and adds
   * an instance at p with the next free reference. entry: {lib, name, text, parentText}.
   */
  function addLibSymbol(project, sheet, inst, entry, p, opts) {
    opts = opts || {};
    const libId = entry.lib + ':' + entry.name;
    const flat = flattenLibSymbol(entry.lib, entry.name, entry.text, entry.parentText, sheet.version);
    const sp = new Splicer(sheet.text);
    const ls = K.find(sheet.root, 'lib_symbols');
    if (!sheet.libSymbols[libId]) {
      const block = pretty(flat, 2) + '\n';
      if (ls && ls.length > 1) sp.insert(lineStart(sheet.text, ls.e - 1), block);
      else if (ls) sp.replace(ls.s, ls.e, '(lib_symbols\n' + block + '\t)');
      else sp.insert(insertPoint(sheet), '\t(lib_symbols\n' + block + '\t)\n');
    }
    const items = splitTop(flat).slice(2);
    const units = libUnits(flat);
    const unit = opts.unit || units[0];
    const refProp = items.find((x) => /^\(property\s+"Reference"/.test(x));
    const refDefault = refProp ? JSON.parse(splitTop(refProp)[2]) : 'U';
    const power = items.some((x) => /^\(power\b/.test(x));
    let myRef, refs = new Map();
    const placements = project.instances.filter((i) => i.sheet === sheet);
    if (opts.ref) { myRef = opts.ref; for (const pl of placements) refs.set(pl.path, opts.ref); }
    else {
      const base = power ? '#PWR' : refDefault.replace(/\?$/, '');
      const { prefix, next } = nextReference(project, base + '0');
      let n = next;
      for (const pl of placements) refs.set(pl.path, prefix + (power ? String(n++).padStart(2, '0') : n++));
      myRef = refs.get(inst.path) || prefix + next;
    }
    const v8 = !sheet.version || sheet.version >= 20231120;
    const L = ['(symbol', `\t(lib_id ${qstr(libId)})`, `\t(at ${fnum(p[0])} ${fnum(p[1])} 0)`, `\t(unit ${unit})`];
    if (v8) L.push('\t(exclude_from_sim no)');
    const flag = (k, d) => { const x = items.find((y) => new RegExp('^\\(' + k + '\\s').test(y)); return x ? splitTop(x)[1] : d; };
    L.push(`\t(in_bom ${flag('in_bom', 'yes')})`, `\t(on_board ${flag('on_board', 'yes')})`, `\t(dnp no)`, `\t(uuid ${qstr(uuid())})`);
    for (const pr of items.filter((x) => /^\(property\s/.test(x))) {
      const parts = splitTop(pr);
      const pname = JSON.parse(parts[1]);
      if (pname.startsWith('ki_')) continue;
      let val = JSON.parse(parts[2]);
      if (pname === 'Reference') val = myRef;
      const rest = parts.slice(3).map((x) => {
        if (/^\(at\s/.test(x)) { const a = splitTop(x); return `(at ${fnum(p[0] + parseFloat(a[1]))} ${fnum(p[1] - parseFloat(a[2]))} ${a[3] || 0})`; }
        return x;
      });
      if (!rest.some((x) => /^\(at\s/.test(x))) rest.unshift(`(at ${fnum(p[0])} ${fnum(p[1])} 0)`);
      L.push(pretty(`(property ${qstr(pname)} ${qstr(val)} ${rest.join(' ')})`, 1));
    }
    for (const num of pinNumbersFor(flat, unit)) L.push(`\t(pin ${qstr(num)}`, `\t\t(uuid ${qstr(uuid())})`, '\t)');
    L.push('\t(instances', `\t\t(project ${qstr(projectNameFor(project, sheet))}`);
    for (const pl of placements) L.push(`\t\t\t(path ${qstr(pl.path)}`, `\t\t\t\t(reference ${qstr(refs.get(pl.path))})`, `\t\t\t\t(unit ${unit})`, '\t\t\t)');
    L.push('\t\t)', '\t)', ')');
    sp.insert(insertPoint(sheet), L.map((l) => '\t' + l.replace(/\n/g, '\n\t')).join('\n') + '\n');
    return { path: sheet.path, text: sp.apply(), ref: myRef, unit, units, at: p.slice() };
  }
  /** Place another unit of a multi-unit part already in the design (e.g. a relay's contacts). */
  function addUnit(project, sheet, inst, sym, unit, p) {
    const lib = sym.libName || sym.libId;
    const lsNode = K.find(sheet.root, 'lib_symbols');
    const node = lsNode && K.findAll(lsNode, 'symbol').find((s) => s[1] === lib);
    if (!node) throw new Error('The part definition is missing from this sheet.');
    const text = sheet.text.slice(node.s, node.e);
    const i = lib.indexOf(':');
    const entry = { lib: i < 0 ? '' : lib.slice(0, i), name: i < 0 ? lib : lib.slice(i + 1), text: text.replace(/^\(symbol\s+"[^"]*"/, '(symbol ' + qstr(i < 0 ? lib : lib.slice(i + 1))) };
    const ref = inst.refs[sheet.symbols.indexOf(sym)].ref;
    const r = addLibSymbol(project, sheet, inst, entry, p, { unit, ref });
    return r;
  }

  // ------------------------------------------------------------------ drawing (graphics and text)
  const strokeLines = (st) => ['\t(stroke', `\t\t(width ${fnum(st && st.width || 0)})`, `\t\t(type ${st && st.type || 'default'})`].concat(st && st.color ? [`\t\t(color ${st.color.join(' ')})`] : []).concat(['\t)']);
  const fillLines = (st) => ['\t(fill', `\t\t(type ${st && st.fill || 'none'})`, '\t)'];
  /** kind: line (pts), rect (a, b), circle (c, r), arc (a, m, b), text (p, text, size, angle, bold, italic) */
  function addGraphic(sheet, kind, g, style) {
    let L;
    const xy = (q) => `(xy ${fnum(q[0])} ${fnum(q[1])})`;
    if (kind === 'line') {
      if (g.pts.length < 2) throw new Error('Tap at least two points.');
      L = ['(polyline', '\t(pts', '\t\t' + g.pts.map(xy).join(' '), '\t)', ...strokeLines(style), `\t(uuid ${qstr(uuid())})`, ')'];
    } else if (kind === 'rect') {
      L = ['(rectangle', `\t(start ${fnum(Math.min(g.a[0], g.b[0]))} ${fnum(Math.min(g.a[1], g.b[1]))})`, `\t(end ${fnum(Math.max(g.a[0], g.b[0]))} ${fnum(Math.max(g.a[1], g.b[1]))})`, ...strokeLines(style), ...fillLines(style), `\t(uuid ${qstr(uuid())})`, ')'];
    } else if (kind === 'circle') {
      if (!(g.r > 0)) throw new Error('Make the circle bigger.');
      L = ['(circle', `\t(center ${fnum(g.c[0])} ${fnum(g.c[1])})`, `\t(radius ${fnum(g.r)})`, ...strokeLines(style), ...fillLines(style), `\t(uuid ${qstr(uuid())})`, ')'];
    } else if (kind === 'arc') {
      L = ['(arc', `\t(start ${fnum(g.a[0])} ${fnum(g.a[1])})`, `\t(mid ${fnum(g.m[0])} ${fnum(g.m[1])})`, `\t(end ${fnum(g.b[0])} ${fnum(g.b[1])})`, ...strokeLines(style), ...fillLines({ fill: 'none' }), `\t(uuid ${qstr(uuid())})`, ')'];
    } else if (kind === 'text') {
      if (!g.text) throw new Error('Type some text.');
      const sz = fnum(g.size || 1.27);
      const font = ['\t\t(font', `\t\t\t(size ${sz} ${sz})`].concat(g.bold ? ['\t\t\t(bold yes)'] : []).concat(g.italic ? ['\t\t\t(italic yes)'] : []).concat(style && style.color ? [`\t\t\t(color ${style.color.join(' ')})`] : []).concat(['\t\t)']);
      L = [`(text ${qstr(g.text)}`].concat(!sheet.version || sheet.version >= 20231120 ? ['\t(exclude_from_sim no)'] : [])
        .concat([`\t(at ${fnum(g.p[0])} ${fnum(g.p[1])} ${g.angle || 0})`, '\t(effects', ...font, '\t\t(justify left bottom)', '\t)', `\t(uuid ${qstr(uuid())})`, ')']);
    } else throw new Error('Unknown shape ' + kind);
    if (sheet.version && sheet.version < 20231120) L = L.map((l) => l.replace(/\(bold yes\)/, 'bold').replace(/\(italic yes\)/, 'italic'));
    const sp = new Splicer(sheet.text);
    sp.insert(insertPoint(sheet), block(L, '\t'));
    return { path: sheet.path, text: sp.apply() };
  }
  /** Move any graphic or text node by d (every coordinate list inside it shifts). */
  function moveNode(sheet, node, d) {
    const sp = new Splicer(sheet.text);
    shiftCoords(sp, node, d);
    return { path: sheet.path, text: sp.apply() };
  }
  const COORD_KEYS = ['at', 'xy', 'start', 'mid', 'end', 'center'];
  function shiftCoords(sp, node, d) {
    const walk = (n) => {
      if (!Array.isArray(n)) return;
      if (COORD_KEYS.includes(n[0]) && n.s !== undefined && n.length >= 3) { setXY(sp, n, parseFloat(n[1]) + d[0], parseFloat(n[2]) + d[1]); return; }
      for (const c of n) walk(c);
    };
    walk(node);
  }
  function deleteNode(sheet, node) {
    const sp = new Splicer(sheet.text);
    const r = nodeRange(sheet.text, node);
    sp.replace(r[0], r[1], '');
    return { path: sheet.path, text: sp.apply() };
  }
  /** Replace a graphic's stroke (and fill) with a new style. */
  function styleNode(sheet, node, style) {
    const sp = new Splicer(sheet.text);
    const ind = indentAt(sheet.text, node.s) + '\t';
    const st = K.find(node, 'stroke');
    if (st) sp.replace(st.s, st.e, strokeLines(style).map((l, i) => (i ? ind : '') + l.slice(1)).join('\n'));
    const fl = K.find(node, 'fill');
    if (fl && node[0] !== 'arc' && node[0] !== 'polyline') sp.replace(fl.s, fl.e, fillLines(style).map((l, i) => (i ? ind : '') + l.slice(1)).join('\n'));
    return { path: sheet.path, text: sp.apply() };
  }

  // ------------------------------------------------------------------ cable details
  // A cable's details live in a KiCad directive label (net class flag) on one of its wires, as
  // fields Cable_Type, Cable_PN, Cable_Size, Cable_Colour and Cable_Length. KiCad keeps them, shows
  // the visible one, and lists them in the label's properties. No Netclass field is set.
  const CABLE_FIELDS = ['Cable_Label', 'Cable_Type', 'Cable_PN', 'Cable_Size', 'Cable_Colour', 'Cable_Length'];   // Cable_Label: the text shown on the drawing
  function cableFieldLines(name, value, at, angle, hide, v8) {
    const eff = v8 ? ['\t(effects', '\t\t(font', '\t\t\t(size 1.27 1.27)', '\t\t\t(italic yes)', '\t\t)', '\t\t(justify left)'].concat(hide ? ['\t\t(hide yes)'] : []).concat(['\t)'])
      : [`\t(effects (font (size 1.27 1.27) italic) (justify left)${hide ? ' hide' : ''})`];
    return [`(property ${qstr(name)} ${qstr(value)}`, `\t(at ${fnum(at[0])} ${fnum(at[1])} ${angle})`].concat(eff, [')']);
  }
  // The flag is a short stem with a dot beside the wire, and the visible text runs along the wire
  // from the dot. Side 'a' is above a horizontal wire or left of a vertical one (reading upwards);
  // side 'b' is below or to the right, for when 'a' would clash with something.
  function cableSideOf(label) { return label.angle === 180 || label.angle === 270 ? 'b' : 'a'; }
  function cableTextAt(p, vertical, side) {
    const L = 1.27, d = side === 'b' ? 1 : -1;
    return vertical ? [p[0] + d * L, p[1] - 0.762] : [p[0] + 0.762, p[1] + d * L];
  }
  function cableFlagLines(p, vertical, fields, v8, id, extra, side) {
    const L = 1.27;
    const angle = vertical ? (side === 'b' ? 270 : 90) : (side === 'b' ? 180 : 0);
    const just = side === 'b' ? '(justify right bottom)' : '(justify left bottom)';
    const at = cableTextAt(p, vertical, side);
    const fangle = vertical ? 90 : 0;
    const shown = CABLE_FIELDS.find((f) => fields[f]);
    const lines = ['(netclass_flag ""', `\t(length ${fnum(L)})`, '\t(shape dot)', `\t(at ${fnum(p[0])} ${fnum(p[1])} ${angle})`];
    if (v8) lines.push('\t(effects', '\t\t(font', '\t\t\t(size 1.27 1.27)', '\t\t)', '\t\t' + just, '\t)');
    else lines.push(`\t(effects (font (size 1.27 1.27)) ${just})`);
    lines.push(`\t(uuid ${qstr(id || uuid())})`);
    for (const f of CABLE_FIELDS) if (fields[f]) for (const l of cableFieldLines(f, fields[f], at, fangle, f !== shown, v8)) lines.push('\t' + l);
    for (const x of extra || []) lines.push('\t' + x);
    lines.push(')');
    return lines;
  }
  /** Adds a cable flag at p (on wire w, which is split there if p is inside it; a bus is left whole). */
  function addCableFlag(sheet, w, p, fields, side, onBus) {
    const v8 = !sheet.version || sheet.version >= 20231120;
    const vertical = Math.abs(w.a[0] - w.b[0]) < 1e-3;
    const sp = new Splicer(sheet.text);
    const out = [cableFlagLines(p, vertical, fields, v8, null, null, side || 'a')];
    // A flag anywhere along a bus is on it (as in KiCad), so a bus isn't split.
    if (!onBus && interior(p, w)) {
      const xys = K.findAll(K.find(w.src, 'pts'), 'xy');
      setXY(sp, xys[w.seg + 1], p[0], p[1]);
      out.push(wireLines(p, w.b));
    }
    sp.insert(insertPoint(sheet), out.map((l) => block(l, '\t')).join(''));
    return { path: sheet.path, text: sp.apply() };
  }
  /** Rewrites an existing cable flag with new values (and the in-line layout); other fields it has are kept. */
  function setCableFields(sheet, label, fields, side) {
    const v8 = !sheet.version || sheet.version >= 20231120;
    const text = sheet.text;
    const vertical = label.angle === 90 || label.angle === 270;
    const extra = label.props.filter((p) => !CABLE_FIELDS.includes(p.name)).map((p) => text.slice(p.src.s, p.src.e).replace(/\n\s*/g, ' '));
    const r = nodeRange(text, label.src);
    const ind = indentAt(text, label.src.s);
    const sp = new Splicer(text);
    sp.replace(r[0], r[1], block(cableFlagLines(label.p, vertical, fields, v8, label.uuid, extra, side || cableSideOf(label)), ind));
    return { path: sheet.path, text: sp.apply() };
  }



  // ------------------------------------------------------------------ buses and hierarchical sheets
  function busLines(a, b) {
    return ['(bus', '\t(pts', `\t\t(xy ${fnum(a[0])} ${fnum(a[1])}) (xy ${fnum(b[0])} ${fnum(b[1])})`, '\t)', '\t(stroke', '\t\t(width 0)', '\t\t(type default)', '\t)', `\t(uuid ${qstr(uuid())})`, ')'];
  }
  function busEntryLines(p, size) {
    return ['(bus_entry', `\t(at ${fnum(p[0])} ${fnum(p[1])})`, `\t(size ${fnum(size[0])} ${fnum(size[1])})`, '\t(stroke', '\t\t(width 0)', '\t\t(type default)', '\t)', `\t(uuid ${qstr(uuid())})`, ')'];
  }
  /** Draw bus segments; existing buses are split where a new end lands on them, with a junction. */
  function addBusSegs(sheet, segs) {
    segs = segs.filter(([a, b]) => !same(a, b));
    if (!segs.length) throw new Error('Draw at least one bus segment.');
    const sp = new Splicer(sheet.text);
    const out = segs.map(([a, b]) => busLines(a, b));
    const ends = [];
    for (const [a, b] of segs) for (const p of [a, b]) if (!ends.some((q) => same(q, p))) ends.push(p);
    const split = new Set();
    for (const p of ends) for (const w of sheet.buses) {
      if (split.has(w) || !interior(p, w)) continue;
      split.add(w);
      const xys = K.findAll(K.find(w.src, 'pts'), 'xy');
      setXY(sp, xys[w.seg + 1], p[0], p[1]);
      out.push(busLines(p, w.b));
    }
    for (const p of ends) {
      if (sheet.junctions.some((j) => same(j.p, p))) continue;
      let n = 0;
      for (const [a, b] of segs) { if (same(a, p)) n++; if (same(b, p)) n++; }
      for (const w of sheet.buses) { if (same(w.a, p) || same(w.b, p)) n++; else if (interior(p, w)) n += 2; }
      if (n >= 3) out.push(junctionLines(p));
    }
    sp.insert(insertPoint(sheet), out.map((l) => block(l, '\t')).join(''));
    return { path: sheet.path, text: sp.apply() };
  }
  function addBusEntry(sheet, p, size) {
    const sp = new Splicer(sheet.text);
    sp.insert(insertPoint(sheet), block(busEntryLines(p, size), '\t'));
    return { path: sheet.path, text: sp.apply() };
  }
  /** KiCad's "Unfold from bus": an entry off the bus at p, a short wire and a label with the member's name. */
  function unfoldFromBus(sheet, p, member, vertical) {
    const e = [2.54, 2.54];
    const b = [p[0] + e[0], p[1] + e[1]];
    const end = vertical ? [b[0] + 5.08, b[1]] : [b[0], b[1] + 5.08];
    const sp = new Splicer(sheet.text);
    const lines = [busEntryLines(p, e), wireLines(b, end), labelLines('local', member, end, vertical ? 'right' : 'bottom')];
    sp.insert(insertPoint(sheet), lines.map((l) => block(l, '\t')).join(''));
    return { path: sheet.path, text: sp.apply() };
  }

  const NEW_SHEET_VERSION = 20231120;
  function newSheetText(paper) {
    return ['(kicad_sch', `\t(version ${NEW_SHEET_VERSION})`, '\t(generator "eeschema")', '\t(generator_version "8.0")', `\t(uuid ${qstr(uuid())})`, `\t(paper ${qstr(paper || 'A4')})`, '\t(lib_symbols)', ')'].join('\n') + '\n';
  }
  function sheetPinLines(name, shape, p, side) {
    const ang = { right: 0, top: 90, left: 180, bottom: 270 }[side] ?? 180;   // ?? not ||: right is 0
    const just = side === 'right' || side === 'bottom' ? 'right' : 'left';
    return [`(pin ${qstr(name)} ${shape || 'input'}`, `\t(at ${fnum(p[0])} ${fnum(p[1])} ${ang})`, '\t(effects', '\t\t(font', '\t\t\t(size 1.27 1.27)', '\t\t)', `\t\t(justify ${just})`, '\t)', `\t(uuid ${qstr(uuid())})`, ')'];
  }
  /**
   * Add a hierarchical sheet to parent at o.p (top-left) with o.size, named o.name, using file o.file
   * (relative to the parent). The file is created when the project doesn't have it. Returns results.
   */
  function addSheet(project, parent, o) {
    const insts = project.instances.filter((i) => i.sheet === parent);
    if (!insts.length) throw new Error('This sheet is not part of the project hierarchy.');
    const pages = project.instances.map((i) => parseInt(i.page, 10)).filter((n) => isFinite(n));
    let next = (pages.length ? Math.max.apply(null, pages) : 1) + 1;
    const proj = projectNameFor(project, parent);
    const sid = uuid();
    const named = parent.sheets.length && parent.sheets[0].props.some((p) => p.name === 'Sheet name') ? ['Sheet name', 'Sheet file'] : ['Sheetname', 'Sheetfile'];
    const [x, y] = o.p, [w, hgt] = o.size;
    const prop = (n, v, at, just) => [`(property ${qstr(n)} ${qstr(v)}`, `\t(at ${fnum(at[0])} ${fnum(at[1])} 0)`, '\t(effects', '\t\t(font', '\t\t\t(size 1.27 1.27)', '\t\t)', `\t\t(justify ${just})`, '\t)', ')'];
    const lines = ['(sheet', `\t(at ${fnum(x)} ${fnum(y)})`, `\t(size ${fnum(w)} ${fnum(hgt)})`, '\t(fields_autoplaced yes)', '\t(stroke', '\t\t(width 0.1524)', '\t\t(type solid)', '\t)', '\t(fill', '\t\t(color 0 0 0 0.0000)', '\t)', `\t(uuid ${qstr(sid)})`]
      .concat(prop(named[0], o.name, [x, y - 0.7116], 'left bottom').map((l) => '\t' + l))
      .concat(prop(named[1], o.file, [x, y + hgt + 0.5884], 'left top').map((l) => '\t' + l))
      .concat(['\t(instances', `\t\t(project ${qstr(proj)}`])
      .concat(insts.map((i) => [`\t\t\t(path ${qstr(i.path)}`, `\t\t\t\t(page ${qstr(String(next++))})`, '\t\t\t)'].join('\n')))
      .concat(['\t\t)', '\t)', ')']);
    const sp = new Splicer(parent.text);
    sp.insert(insertPoint(parent), block(lines, '\t'));
    const results = [{ path: parent.path, text: sp.apply() }];
    const childPath = K.joinPath(K.dirname(parent.path), o.file);
    if (!project.instances.some((i) => i.sheet.path === childPath) && !(o.existing && o.existing(childPath))) { const pz = K.find(parent.root, 'paper'); results.push({ path: childPath, text: newSheetText(pz ? pz[1] : 'A4') }); }
    return { results, uuid: sid, childPath };
  }
  /** Add pins to a sheet symbol. pins: [{ name, shape, p, side }] */
  function addSheetPins(parent, sheetObj, pins) {
    const sp = new Splicer(parent.text);
    const ind = indentAt(parent.text, sheetObj.src.s) + '\t';
    const anchor = K.find(sheetObj.src, 'instances') || null;
    const txt = pins.map((pn) => block(sheetPinLines(pn.name, pn.shape, pn.p, pn.side), ind)).join('');
    if (anchor) sp.insert(lineStart(parent.text, anchor.s), txt);
    else sp.insert(lineStart(parent.text, sheetObj.src.e - 1), txt);
    return { path: parent.path, text: sp.apply() };
  }
  /** Free spots for new pins down one side of a sheet symbol, 2.54 mm apart, avoiding pins already there. */
  function sheetPinSpots(sheetObj, side, n) {
    const [x, y] = sheetObj.p, [w, hh] = sheetObj.size;
    const taken = sheetObj.pins.map((p) => p.p);
    const out = [];
    for (let k = 1; out.length < n; k++) {
      const yy = snap(y + k * 2.54);
      if (yy > y + hh - 1.27) break;
      const p = [side === 'right' ? x + w : x, yy];
      if (!taken.some((q) => same(q, p)) && !out.some((q) => same(q, p))) out.push(p);
    }
    return out;
  }


  // ------------------------------------------------------------------ simple symbol editor: box parts
  const PIN_TYPES = ['passive', 'input', 'output', 'bidirectional', 'tri_state', 'power_in', 'power_out', 'open_collector', 'open_emitter', 'unspecified', 'no_connect', 'free'];
  /** Parse pin lines "number name [type] [L|R]" (tabs or spaces). */
  function parsePinLines(text) {
    const alias = { in: 'input', out: 'output', bidir: 'bidirectional', io: 'bidirectional', tri: 'tri_state', pwr: 'power_in', power: 'power_in', 'power-in': 'power_in', 'power-out': 'power_out', oc: 'open_collector', nc: 'no_connect', pas: 'passive' };
    const pins = [];
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.trim(); if (!line) continue;
      const tok = line.split(/\t|\s+/);
      const num = tok.shift();
      let side = 'L', type = 'passive';
      for (let k = 0; k < 2 && tok.length > (k === 0 ? 0 : 0); k++) {
        const last = tok[tok.length - 1]; if (last === undefined) break;
        const lw = last.toLowerCase();
        if (/^[lr]$/.test(lw)) { side = lw.toUpperCase(); tok.pop(); continue; }
        if (PIN_TYPES.includes(lw) || alias[lw]) { type = PIN_TYPES.includes(lw) ? lw : alias[lw]; tok.pop(); continue; }
        break;
      }
      pins.push({ num, name: tok.join(' ') || '~', type, side });
    }
    return pins;
  }
  /** A KiCad library symbol: a box with pins down the left and right. def: { name, ref, value, pins, fields: {Footprint, Datasheet, Description, ...}, keywords } */
  function boxSymbol(def) {
    const P = 2.54, q = qstr, f = fnum;
    const L = def.pins.filter((p) => p.side !== 'R'), R = def.pins.filter((p) => p.side === 'R');
    const n = Math.max(L.length, R.length, 1);
    const longL = Math.max(0, ...L.map((p) => p.name === '~' ? 0 : p.name.length)), longR = Math.max(0, ...R.map((p) => p.name === '~' ? 0 : p.name.length));
    const inner = Math.max(2.54 * 2, (longL + longR) * 0.85 + (L.length && R.length ? 2.54 : 1.27));
    const tipR = Math.ceil((-1.27 + inner + 3.81) / P) * P, right = tipR - 3.81;
    const ys = (k) => Array.from({ length: k }, (_, i) => (Math.floor((n - 1) / 2) - i) * P);
    const yL = ys(L.length), yR = ys(R.length);
    const top = Math.floor((n - 1) / 2) * P + P, bottom = (Math.floor((n - 1) / 2) - (n - 1)) * P - P;
    const font = (x) => `(effects (font (size 1.27 1.27))${x || ''})`;
    const prop = (k, v, x, y, extra) => `(property ${q(k)} ${q(v)} (at ${f(x)} ${f(y)} 0) ${font(extra)})`;
    const pin = (p, x, y, ang) => `(pin ${p.type || 'passive'} line (at ${f(x)} ${f(y)} ${ang}) (length 3.81) (name ${q(p.name || '~')} ${font()}) (number ${q(p.num)} ${font()}))`;
    const fields = [prop('Reference', def.ref || 'U', -1.27, top + 1.27, ' (justify left)'), prop('Value', def.value || def.name, -1.27, bottom - 1.27, ' (justify left)')];
    const hide = Object.entries(Object.assign({ Footprint: '', Datasheet: '~' }, def.fields || {}));
    hide.forEach(([k, v], i) => fields.push(prop(k, v === '' && k === 'Datasheet' ? '~' : v, 0, bottom - 2.54 - i * 1.27, ' (hide yes)')));
    if (def.keywords) fields.push(prop('ki_keywords', def.keywords, 0, 0, ' (hide yes)'));
    const body = `(rectangle (start -1.27 ${f(top)}) (end ${f(right)} ${f(bottom)}) (stroke (width 0.254) (type default)) (fill (type background)))`;
    const pins = L.map((p, i) => pin(p, -5.08, yL[i], 0)).concat(R.map((p, i) => pin(p, tipR, yR[i], 180)));
    return `(symbol ${q(def.name)} (pin_names (offset 1.016)) (exclude_from_sim no) (in_bom yes) (on_board yes) ${fields.join(' ')} ` +
      `(symbol ${q(def.name + '_0_1')} ${body}) (symbol ${q(def.name + '_1_1')} ${pins.join(' ')}))`;
  }
  function symbolLibText(symbols) {
    return pretty('(kicad_symbol_lib (version 20231120) (generator "loomline") (generator_version "1") ' + symbols.join(' ') + ')') + '\n';
  }

  // ------------------------------------------------------------------ KiCad tools: annotate, find & replace, autoplace
  /** Set references on several symbols in one file. list: [{ sym, path (instance path), ref, prop (true: also the Reference field) }] */
  function setReferences(sheet, list) {
    const sp = new Splicer(sheet.text);
    const propDone = new Set();
    for (const c of list) {
      if (c.prop && !propDone.has(c.sym)) {
        propDone.add(c.sym);
        const rp = c.sym.props.find((p) => p.name === 'Reference');
        if (rp) setTok(sp, rp.src, 2, qstr(c.ref));
      }
      const insts = K.find(c.sym.src, 'instances');
      if (insts) for (const pr of K.findAll(insts, 'project')) for (const pa of K.findAll(pr, 'path')) {
        if (pa[1] !== c.path) continue;
        const r = K.find(pa, 'reference');
        if (r) setTok(sp, r, 1, qstr(c.ref));
      }
    }
    return { path: sheet.path, text: sp.apply() };
  }

  /** Plan an annotation of the whole project. opts: { all: renumber everything, sheetBase: start each sheet at page × 100 }.
   *  Returns { changes: [{ inst, si, from, to }], results: [{path, text}] }. Units of one part keep one reference. */
  function annotate(project, opts) {
    opts = opts || {};
    const insts = project.instances.slice().sort((a, b) => a.order - b.order);
    const items = [];
    insts.forEach((inst, ii) => inst.sheet.symbols.forEach((sym, si) => {
      const ref = (inst.refs[si] && inst.refs[si].ref) || '';
      const m = /^(#?[A-Za-z_]*[A-Za-z_])(\d+|\?)?$/.exec(ref) || /^(.*?)(\d+|\?)?$/.exec(ref);
      items.push({ inst, ii, si, sym, ref, prefix: m[1] || 'U', num: m[2] && m[2] !== '?' ? +m[2] : null, unit: sym.unit || 1, x: sym.p[0], y: sym.p[1] });
    }));
    // Keep: valid refs, with each (ref, unit) only once. Units sharing a ref stay one part.
    const used = new Map();   // prefix -> Set(numbers)
    const seenUnit = new Set();
    const keep = new Set();
    const useNum = (pre, n) => { if (!used.has(pre)) used.set(pre, new Set()); used.get(pre).add(n); };
    if (!opts.all) for (const it of items) {
      if (it.num === null) continue;
      const key = it.ref + '#' + it.unit;
      if (seenUnit.has(key)) continue;
      seenUnit.add(key); keep.add(it); useNum(it.prefix, it.num);
    }
    // Groups to number, in page order then left to right, top to bottom (KiCad's "sort by X").
    const todo = items.filter((it) => !keep.has(it)).sort((a, b) => a.ii - b.ii || a.x - b.x || a.y - b.y);
    const groups = [];
    const byOld = new Map();
    for (const it of todo) {
      // In "renumber all", the units of one old part stay together (if their units differ).
      const k = opts.all && it.num !== null ? it.prefix + '|' + it.ref : null;
      let g = k && byOld.get(k);
      if (g && g.items.some((x) => x.unit === it.unit)) g = null;
      if (!g) { g = { prefix: it.prefix, items: [], page: it.inst.page }; groups.push(g); if (k) byOld.set(k, g); }
      g.items.push(it);
    }
    const changes = [];
    for (const g of groups) {
      const set = used.get(g.prefix) || new Set();
      let n = opts.sheetBase ? (parseInt(g.page, 10) || 1) * 100 + 1 : 1;
      while (set.has(n)) n++;
      useNum(g.prefix, n);
      const to = g.prefix + n;
      for (const it of g.items) if (it.ref !== to) changes.push({ inst: it.inst, si: it.si, sym: it.sym, from: it.ref, to });
    }
    const byFile = new Map();
    for (const c of changes) {
      const sh = c.inst.sheet;
      if (!byFile.has(sh)) byFile.set(sh, []);
      byFile.get(sh).push({ sym: c.sym, path: c.inst.path, ref: c.to, prop: true });
    }
    const results = Array.from(byFile, ([sh, list]) => setReferences(sh, list));
    return { changes, results };
  }

  /** Find text in labels, text items and symbol fields. opts: { find, replace, labels, texts, fields, refs, matchCase, whole }.
   *  Returns { hits: [{ kind, where, before, after }], result: {path, text} | null } for one sheet. */
  function replaceInSheet(sheet, opts) {
    const esc = opts.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(opts.whole ? '\\b' + esc + '\\b' : esc, opts.matchCase ? 'g' : 'gi');
    const sp = new Splicer(sheet.text);
    const hits = [];
    const visit = (kind, where, node, idx, value) => {
      if (value === undefined || value === null) return;
      re.lastIndex = 0;
      if (!re.test(value)) return;
      re.lastIndex = 0;
      const after = value.replace(re, () => opts.replace);
      hits.push({ kind, where, before: value, after });
      if (opts.replace !== undefined && opts.replace !== null && after !== value) setTok(sp, node, idx, qstr(after));
    };
    if (opts.labels) for (const l of sheet.labels) visit('label', l.kind + ' label', l.src, 1, l.text);
    if (opts.texts) { for (const t of sheet.texts) visit('text', 'text', t.src, 1, t.s); for (const t of sheet.textBoxes) if (t.src) visit('text', 'text box', t.src, 1, t.s); }
    if (opts.fields) for (const sym of sheet.symbols) for (const p of sym.props) {
      if (p.name.startsWith('ki_')) continue;
      if (p.name === 'Reference' && !opts.refs) continue;
      if (p.name === 'Reference') {
        // References live in the instance data as well; leave those to Annotate unless asked.
        continue;
      }
      visit('field', p.name, p.src, 2, p.value);
    }
    const changed = opts.replace !== undefined && opts.replace !== null && hits.some((x) => x.after !== x.before);
    return { hits, result: changed ? { path: sheet.path, text: sp.apply() } : null };
  }

  /** Put a symbol's visible fields in tidy places. place: { [fieldName]: { p: [x, y], justify: 'left'|'right'|'center' } } */
  function placeFields(sheet, sym, place) {
    const sp = new Splicer(sheet.text);
    const text = sheet.text;
    for (const p of sym.props) {
      const want = place[p.name];
      if (!want) continue;
      const a = atNode(p.src);
      if (a) { setXY(sp, a, want.p[0], want.p[1]); if (a.length > 3) setTok(sp, a, 3, '0'); }
      const eff = K.find(p.src, 'effects');
      if (!eff) continue;
      const j = K.find(eff, 'justify');
      const others = j ? j.slice(1).filter((t) => t !== 'left' && t !== 'right') : [];
      const toks = (want.justify && want.justify !== 'center' ? [want.justify] : []).concat(others);
      if (j) {
        if (toks.length) sp.replace(j.s, j.e, '(justify ' + toks.join(' ') + ')');
        else { const r = nodeRange(text, j); sp.replace(r[0], r[1], ''); }
      } else if (toks.length) {
        const font = K.find(eff, 'font');
        const at = font ? font.e : eff.e - 1;
        sp.insert(at, (font && text.slice(font.e, eff.e).includes('\n') ? '\n' + indentAt(text, font.s) : ' ') + '(justify ' + toks.join(' ') + ')');
      }
    }
    return { path: sheet.path, text: sp.apply() };
  }

  root.KiEdit = {
    CABLE_FIELDS, addCableFlag, setCableFields, cableSideOf, cableTextAt,
    GRID, snap, same, fnum, qstr, uuid, connectionPoints,
    setSymbolFields, setFieldMany, renameLabel, editText, moveItems, transformSymbol, rotateLabel, deleteItems, copySymbol, addWires, addWireSegs, addLabel, addNoConnect, addJunction, nextReference,
    reparse, connectAt, insertInWire, copyItems, pasteItems,
    flattenLibSymbol, addLibSymbol, addUnit, libUnits, addGraphic, moveNode, deleteNode, styleNode, pretty,
    setSnapGrid, snapGrid, setReferences, annotate, replaceInSheet, placeFields,
    addBusSegs, addBusEntry, unfoldFromBus, addSheet, addSheetPins, sheetPinSpots, newSheetText,
    PIN_TYPES, parsePinLines, boxSymbol, symbolLibText
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.KiEdit;
})(typeof globalThis !== 'undefined' ? globalThis : this);
