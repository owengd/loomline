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
  const snap = (v) => Math.round(v / GRID) * GRID;
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
  function setTok(sp, node, idx, str) { const t = node.t[idx]; sp.replace(t[0], t[1], str); }
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
  function rubberBand(sp, sheet, moves, movedWires) {
    const text = sheet.text;
    const byWire = new Map();
    for (const w of sheet.wires) {
      if (movedWires && movedWires.has(w)) continue;
      let a = w.a, b = w.b, ch = false;
      // Each end follows the first move that starts there (moves can swap places, e.g. a mirror).
      const ma = moves.find((m) => same(w.a, m.from)), mb = moves.find((m) => same(w.b, m.from));
      if (ma) { a = ma.to; ch = true; }
      if (mb) { b = mb.to; ch = true; }
      if (ch) byWire.set(w, [a, b]);
    }
    const ins = [];
    // Points a new corner must not land on, or it would short something.
    const occupied = [];
    for (const c of connectionPoints(sheet)) if (!moves.some((m) => same(m.from, c.p))) occupied.push(c.p);
    for (const m of moves) occupied.push(m.to);
    for (const [, [a, b]] of byWire) occupied.push(a, b);
    const clashes = (p, segs) => occupied.some((q) => same(q, p)) || segs.some(([u, v]) => occupied.some((q) => K.onSegment(q, u, v) && !same(q, u) && !same(q, v)));
    // Something already connects in the middle of this wire (a label, a T-junction, a pin...)?
    const midConnected = (w) => connectionPoints(sheet).some((c) => interior(c.p, w));
    for (const [w, [a, b]] of byWire) {
      if (midConnected(w)) {
        // Leave the wire alone and bridge each moved end with a new stub wire instead.
        for (const m of moves) {
          for (const end of [w.a, w.b]) {
            if (!same(end, m.from)) continue;
            const corner = Math.abs(m.from[1] - m.to[1]) < 1e-3 || Math.abs(m.from[0] - m.to[0]) < 1e-3 ? null : [m.to[0], m.from[1]];
            if (corner && !clashes(corner, [[m.from, corner], [corner, m.to]])) { occupied.push(corner); ins.push(wireLines(m.from, corner), wireLines(corner, m.to)); }
            else ins.push(wireLines(m.from, m.to));
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
        const corner = wasHoriz ? [moving[0], fixed[1]] : [fixed[0], moving[1]];
        if (clashes(corner, [[fixed, corner], [corner, moving]])) {
          // A tidy corner would touch something else, so leave this wire diagonal (still connected).
          setXY(sp, xys[0], a[0], a[1]);
          setXY(sp, xys[1], b[0], b[1]);
          continue;
        }
        occupied.push(corner);
        setXY(sp, xys[0], fixed[0], fixed[1]);
        setXY(sp, xys[1], corner[0], corner[1]);
        if (!same(corner, moving)) ins.push(wireLines(corner, moving));
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

  /** Move items by d (mm). items: [{type:'symbol', sym} | {type:'label', label} | {type:'wire', wire} | {type:'junction'|'nc'|'text', item}] */
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
      } else if (it.item) {
        const a = atNode(it.item.src);
        setXY(sp, a, it.item.p[0] + d[0], it.item.p[1] + d[1]);
      }
    }
    let extra = [];
    if (opts.keepWires !== false && moves.length) {
      extra = rubberBand(sp, sheet, moves, movedWires);
      dragAttached(sp, sheet, moves, new Set(items.map((it) => it.item || it.label || it.sym).filter(Boolean)));
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
    if (a.length > 3) setTok(sp, a, 3, String(o.angle)); else sp.insert(a.t[2][1], ' ' + o.angle);
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
    if (a.length > 3) setTok(sp, a, 3, String(SPIN_ANGLE[spin])); else sp.insert(a.t[2][1], ' ' + SPIN_ANGLE[spin]);
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
      if (r.ref.startsWith(prefix)) { const n = parseInt(r.ref.slice(prefix.length), 10); if (!isNaN(n) && String(n) === r.ref.slice(prefix.length) && n > max) max = n; }
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

  root.KiEdit = {
    GRID, snap, same, fnum, qstr, uuid, connectionPoints,
    setSymbolFields, renameLabel, editText, moveItems, transformSymbol, rotateLabel, deleteItems, copySymbol, addWires, addLabel, addNoConnect, nextReference
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.KiEdit;
})(typeof globalThis !== 'undefined' ? globalThis : this);
