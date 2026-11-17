/* Loomline symbol editor model (KiCad's Symbol Editor): read a KiCad library symbol into an
 * editable model, edit it (pins of any type, shape and direction; rectangles, circles, arcs,
 * lines, text; several units; De Morgan body style; alternate pin functions), and write it back
 * as a KiCad 8 library symbol. Coordinates are KiCad library coordinates (mm, y up).
 * Pure functions: run the same in the browser and in node tests. */
(function (root) {
  'use strict';
  const K = root.KiCore;
  const PIN_TYPES = ['input', 'output', 'bidirectional', 'tri_state', 'passive', 'free', 'unspecified', 'power_in', 'power_out', 'open_collector', 'open_emitter', 'no_connect'];
  const PIN_TYPE_NAMES = ['Input', 'Output', 'Bidirectional', 'Tri-state', 'Passive', 'Free', 'Unspecified', 'Power input', 'Power output', 'Open collector', 'Open emitter', 'Not connected'];
  const PIN_SHAPES = ['line', 'inverted', 'clock', 'inverted_clock', 'input_low', 'clock_low', 'output_low', 'edge_clock_high', 'non_logic'];
  const PIN_SHAPE_NAMES = ['Line', 'Inverted', 'Clock', 'Inverted clock', 'Input low', 'Clock low', 'Output low', 'Falling edge clock', 'Non-logic'];
  const FILLS = ['none', 'outline', 'background'];
  const GRID = 1.27;
  const r4 = (v) => Math.round(v * 10000) / 10000;
  const f = (v) => { const r = r4(v); return String(Object.is(r, -0) ? 0 : r); };
  const q = (s) => '"' + String(s === undefined || s === null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const num = (v, d) => { const n = parseFloat(v); return isFinite(n) ? n : d; };

  function blank(name) {
    return {
      name: name || 'NEW_PART', ref: 'U', value: name || 'NEW_PART',
      fields: { Footprint: '', Datasheet: '~', Description: '' }, keywords: '', fpFilters: '',
      units: 1, interchangeable: false, deMorgan: false, power: false,
      pinNameOffset: 0.508, hidePinNames: false, hidePinNumbers: false, inBom: true, onBoard: true, excludeFromSim: false,
      fieldPos: {}, items: []
    };
  }

  // ---------------------------------------------------------------- read a KiCad symbol
  function strokeW(n) { const s = K.find(n, 'stroke'); const w = s && K.find(s, 'width'); return w ? num(w[1], 0) : 0; }
  function fillOf(n) { const fl = K.find(n, 'fill'); const t = fl && K.find(fl, 'type'); return t && FILLS.includes(t[1]) ? t[1] : 'none'; }
  function xy(n) { return n ? [num(n[1], 0), num(n[2], 0)] : [0, 0]; }
  function isHidden(n) { const e = K.find(n, 'effects'); return !!(e && (e.includes('hide') || K.boolTok(e, 'hide'))); }
  /** text: one KiCad library symbol, "(symbol "NAME" …)". parentText: the symbol it extends, if any. */
  function parse(text, parentText) {
    const tree = K.parseSexpr(text, true);
    const node = Array.isArray(tree) && tree[0] === 'symbol' ? tree : tree.find((x) => Array.isArray(x) && x[0] === 'symbol');
    if (!node) throw new Error('That is not a KiCad symbol.');
    // a derived symbol (extends) takes its drawing from the parent
    const ext = K.find(node, 'extends');
    let drawNode = node, drawText = text;
    if (ext && parentText) { const pt = K.parseSexpr(parentText, true); drawNode = pt[0] === 'symbol' ? pt : pt.find((x) => Array.isArray(x) && x[0] === 'symbol'); drawText = parentText; }
    const m = blank(String(node[1]).split(':').pop());
    const props = {};
    for (const p of K.findAll(node, 'property')) {
      props[p[1]] = p[2] || '';
      const at = K.find(p, 'at');
      const ef = K.find(p, 'effects'), jj = ef && K.find(ef, 'justify');
      if (at) m.fieldPos[p[1]] = { p: [num(at[1], 0), num(at[2], 0)], a: num(at[3], 0), hide: isHidden(p) || K.boolTok(p, 'hide'), just: jj ? jj.slice(1).filter((x) => typeof x === 'string').join(' ') : '' };
    }
    if (ext && parentText) for (const p of K.findAll(drawNode, 'property')) if (!(p[1] in props)) props[p[1]] = p[2] || '';
    m.ref = (props.Reference || 'U').replace(/\?$/, '');
    m.value = props.Value || m.name;
    m.keywords = props.ki_keywords || '';
    m.fpFilters = props.ki_fp_filters || '';
    m.fields = {};
    for (const [k, v] of Object.entries(props)) if (!['Reference', 'Value', 'ki_keywords', 'ki_fp_filters', 'ki_locked'].includes(k)) m.fields[k] = k === 'ki_description' ? undefined : v;
    if (props.ki_description && !m.fields.Description) m.fields.Description = props.ki_description;
    for (const k of Object.keys(m.fields)) if (m.fields[k] === undefined) delete m.fields[k];
    if (!('Footprint' in m.fields)) m.fields.Footprint = '';
    if (!('Datasheet' in m.fields)) m.fields.Datasheet = '~';
    const pn = K.find(drawNode, 'pin_names');
    if (pn) { const o = K.find(pn, 'offset'); if (o) m.pinNameOffset = num(o[1], 0.508); m.hidePinNames = pn.includes('hide') || K.boolTok(pn, 'hide'); }
    const pnum = K.find(drawNode, 'pin_numbers');
    if (pnum) m.hidePinNumbers = pnum.includes('hide') || K.boolTok(pnum, 'hide');
    m.power = !!K.find(node, 'power') || !!K.find(drawNode, 'power');
    m.inBom = !(K.find(node, 'in_bom') && K.find(node, 'in_bom')[1] === 'no');
    m.onBoard = !(K.find(node, 'on_board') && K.find(node, 'on_board')[1] === 'no');
    m.excludeFromSim = !!(K.find(node, 'exclude_from_sim') && K.find(node, 'exclude_from_sim')[1] === 'yes');
    m.interchangeable = !('ki_locked' in props);   // KiCad marks units that can't be swapped with ki_locked
    m.unitNames = {};
    let units = 1, styles = 1;
    for (const sub of K.findAll(drawNode, 'symbol')) {
      const mm = /_(\d+)_(\d+)$/.exec(sub[1]);
      const unit = mm ? +mm[1] : 0, style = mm ? +mm[2] : 0;
      units = Math.max(units, unit); styles = Math.max(styles, style);
      const un = K.find(sub, 'unit_name'); if (un && unit) m.unitNames[unit] = un[1];
      for (let k = 2; k < sub.length; k++) {
        const c = sub[k]; if (!Array.isArray(c)) continue;
        const base = { unit, style };   // style as written; normalised below
        const it = readItem(c, drawText);
        if (it) m.items.push(Object.assign(it, base));
      }
    }
    m.units = units;
    m.deMorgan = styles > 1;
    m.name = String(node[1]).split(':').pop();
    return m;
  }
  function readItem(c, srcText) {
    switch (c[0]) {
      case 'rectangle': return { t: 'rect', a: xy(K.find(c, 'start')), b: xy(K.find(c, 'end')), w: strokeW(c), fill: fillOf(c) };
      case 'circle': return { t: 'circle', c: xy(K.find(c, 'center')), r: num((K.find(c, 'radius') || [])[1], 1), w: strokeW(c), fill: fillOf(c) };
      case 'arc': return { t: 'arc', a: xy(K.find(c, 'start')), m: xy(K.find(c, 'mid')), b: xy(K.find(c, 'end')), w: strokeW(c), fill: fillOf(c) };
      case 'polyline': { const pts = K.findAll(K.find(c, 'pts') || [], 'xy').map(xy); return pts.length >= 2 ? { t: 'poly', pts, w: strokeW(c), fill: fillOf(c) } : null; }
      case 'text': {
        const at = K.find(c, 'at'), e = K.find(c, 'effects'), font = e && K.find(e, 'font'), sz = font && K.find(font, 'size');
        return { t: 'text', s: c[1] || '', p: [num(at && at[1], 0), num(at && at[2], 0)], angle: num(at && at[3], 0) / 10, size: sz ? num(sz[1], 1.27) : 1.27 };
      }
      case 'pin': {
        const at = K.find(c, 'at'), len = K.find(c, 'length'), nm = K.find(c, 'name'), no = K.find(c, 'number');
        const alts = K.findAll(c, 'alternate').map((a) => ({ name: a[1] || '', type: a[2] || 'passive', shape: a[3] || 'line' }));
        return { t: 'pin', type: c[1] || 'passive', shape: c[2] || 'line', p: [num(at && at[1], 0), num(at && at[2], 0)], angle: ((Math.round(num(at && at[3], 0)) % 360) + 360) % 360, len: num(len && len[1], 2.54), name: nm ? nm[1] : '~', num: no ? no[1] : '', hide: c.includes('hide') || K.boolTok(c, 'hide'), alts };
      }
      default: return { t: 'raw', text: srcText && c.s !== undefined ? srcText.slice(c.s, c.e) : null };
    }
  }

  // ---------------------------------------------------------------- write a KiCad symbol
  const fillLine = (fl) => `(fill (type ${FILLS.includes(fl) ? fl : 'none'}))`;
  const strokeLine = (w) => `(stroke (width ${f(w || 0)}) (type default))`;
  const font = (sz, x) => `(effects (font (size ${f(sz || 1.27)} ${f(sz || 1.27)}))${x || ''})`;
  function writeItem(it) {
    switch (it.t) {
      case 'rect': return `(rectangle (start ${f(it.a[0])} ${f(it.a[1])}) (end ${f(it.b[0])} ${f(it.b[1])}) ${strokeLine(it.w)} ${fillLine(it.fill)})`;
      case 'circle': return `(circle (center ${f(it.c[0])} ${f(it.c[1])}) (radius ${f(it.r)}) ${strokeLine(it.w)} ${fillLine(it.fill)})`;
      case 'arc': return `(arc (start ${f(it.a[0])} ${f(it.a[1])}) (mid ${f(it.m[0])} ${f(it.m[1])}) (end ${f(it.b[0])} ${f(it.b[1])}) ${strokeLine(it.w)} ${fillLine(it.fill)})`;
      case 'poly': return `(polyline (pts ${it.pts.map((p) => `(xy ${f(p[0])} ${f(p[1])})`).join(' ')}) ${strokeLine(it.w)} ${fillLine(it.fill)})`;
      case 'text': return `(text ${q(it.s)} (at ${f(it.p[0])} ${f(it.p[1])} ${Math.round((it.angle || 0) * 10)}) ${font(it.size)})`;
      case 'pin': return `(pin ${PIN_TYPES.includes(it.type) ? it.type : 'passive'} ${PIN_SHAPES.includes(it.shape) ? it.shape : 'line'} (at ${f(it.p[0])} ${f(it.p[1])} ${it.angle || 0}) (length ${f(it.len)})${it.hide ? ' (hide yes)' : ''} (name ${q(it.name === undefined || it.name === null ? '~' : it.name)} ${font(1.27)}) (number ${q(it.num)} ${font(1.27)})${(it.alts || []).filter((a) => a.name).map((a) => ` (alternate ${q(a.name)} ${a.type || 'passive'} ${a.shape || 'line'})`).join('')})`;
      case 'raw': return it.text || '';
      default: return '';
    }
  }
  function bbox(m, unit, style) {
    const pts = [];
    for (const it of m.items) {
      if (unit && it.unit && it.unit !== unit) continue;
      if (style && it.style && it.style !== style) continue;
      if (it.t === 'rect') pts.push(it.a, it.b);
      else if (it.t === 'circle') pts.push([it.c[0] - it.r, it.c[1] - it.r], [it.c[0] + it.r, it.c[1] + it.r]);
      else if (it.t === 'arc') pts.push(it.a, it.m, it.b);
      else if (it.t === 'poly') pts.push(...it.pts);
      else if (it.t === 'text') pts.push(it.p);
      else if (it.t === 'pin') pts.push(it.p, pinEnd(it));
    }
    if (!pts.length) return [-2.54, -2.54, 2.54, 2.54];
    return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
  }
  /** The body end of a pin (its "at" point is the connection end; the angle points from it into the body). */
  function pinEnd(it) {
    const a = it.angle || 0, d = a === 0 ? [1, 0] : a === 90 ? [0, 1] : a === 180 ? [-1, 0] : [0, -1];
    return [it.p[0] + d[0] * it.len, it.p[1] + d[1] * it.len];
  }
  function serialize(m) {
    const name = String(m.name || 'NEW_PART').replace(/[\s:"]+/g, '_');
    const bb = bbox(m);
    const refAt = (m.fieldPos.Reference && m.fieldPos.Reference.p) || [bb[0], bb[3] + 1.27];
    const valAt = (m.fieldPos.Value && m.fieldPos.Value.p) || [bb[0], bb[1] - 1.27];
    const prop = (k, v, at, hide, just) => `(property ${q(k)} ${q(v)} (at ${f(at[0])} ${f(at[1])} 0) ${font(1.27, (just ? ` (justify ${just})` : '') + (hide ? ' (hide yes)' : ''))})`;
    const jus = (k, d) => (m.fieldPos[k] && m.fieldPos[k].just !== undefined ? m.fieldPos[k].just : d);
    const props = [prop('Reference', m.power ? '#PWR' : (m.ref || 'U'), refAt, m.power || (m.fieldPos.Reference && m.fieldPos.Reference.hide), jus('Reference', 'left')), prop('Value', m.value || name, valAt, m.fieldPos.Value && m.fieldPos.Value.hide, jus('Value', 'left'))];
    const fields = Object.assign({ Footprint: '', Datasheet: '~', Description: '' }, m.fields || {});
    let k = 0;
    for (const [key, val] of Object.entries(fields)) {
      if (!key) continue;
      const pos = m.fieldPos[key];
      props.push(prop(key, key === 'Datasheet' && !val ? '~' : val, pos ? pos.p : [0, bb[1] - 2.54 - 1.27 * k++], pos ? pos.hide : true, pos ? pos.just : ''));
    }
    if (m.keywords) props.push(prop('ki_keywords', m.keywords, [0, 0], true));
    if (m.fpFilters) props.push(prop('ki_fp_filters', m.fpFilters, [0, 0], true));
    if (m.units > 1 && !m.interchangeable) props.push(prop('ki_locked', '', [0, 0], true));
    const head = [`(symbol ${q(name)}`];
    if (m.power) head.push('(power)');
    if (m.hidePinNumbers) head.push('(pin_numbers (hide yes))');
    head.push(`(pin_names (offset ${f(m.pinNameOffset === undefined ? 0.508 : m.pinNameOffset)})${m.hidePinNames ? ' (hide yes)' : ''})`);
    head.push(`(exclude_from_sim ${m.excludeFromSim ? 'yes' : 'no'})`, `(in_bom ${m.inBom === false ? 'no' : 'yes'})`, `(on_board ${m.onBoard === false ? 'no' : 'yes'})`);
    // group items into KiCad's sub-symbols NAME_unit_style
    const groups = new Map();
    for (const it of m.items) {
      if (!m.deMorgan && it.style === 2) continue;   // De Morgan turned off: its alternate body goes
      const unit = Math.min(it.unit || 0, m.units || 1);
      const style = it.style === undefined ? 1 : it.style;
      const key = unit + '_' + style;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    // KiCad keeps graphics (_x_0/_0_1) before pins (_1_1); order by unit then style
    const keys = Array.from(groups.keys()).sort((a, b) => { const [ua, sa] = a.split('_').map(Number), [ub, sb] = b.split('_').map(Number); return ua - ub || sa - sb; });
    const subs = keys.map((key) => `(symbol ${q(name + '_' + key)}${m.unitNames && m.unitNames[+key.split('_')[0]] ? ` (unit_name ${q(m.unitNames[+key.split('_')[0]])})` : ''} ${groups.get(key).map(writeItem).filter(Boolean).join(' ')})`);
    // a unit with no items still needs to exist for KiCad to count it
    for (let u = 1; u <= (m.units || 1); u++) if (m.units > 1 && !keys.some((key) => key.startsWith(u + '_'))) subs.push(`(symbol ${q(name + '_' + u + '_1')})`);
    return head.join(' ') + ' ' + props.join(' ') + ' ' + subs.join(' ') + ')';
  }

  // ---------------------------------------------------------------- checks
  function check(m) {
    const out = [];
    if (!m.name || !String(m.name).trim()) out.push('Give the part a name.');
    const pins = m.items.filter((i) => i.t === 'pin');
    if (!pins.length && !m.power) out.push('There are no pins yet.');
    // the same number twice in one unit and body style (KiCad: duplicate pin)
    const seen = new Map();
    for (const p of pins) {
      if (!p.num) { out.push(`A pin (${p.name || 'no name'}) has no number.`); continue; }
      const units = m.units > 1 && !p.unit ? Array.from({ length: m.units }, (_, i) => i + 1) : [p.unit || 0];
      for (const u of units) {
        const k = u + '/' + (p.style || 0) + '/' + p.num;
        if (seen.has(k) && !(seen.get(k)[0] === p.p[0] && seen.get(k)[1] === p.p[1])) out.push(`Pin number ${p.num} is used twice${m.units > 1 ? ' in unit ' + String.fromCharCode(64 + (u || 1)) : ''}.`);
        seen.set(k, p.p);
      }
      const off = (v) => Math.abs(v / GRID - Math.round(v / GRID)) > 1e-3;
      if (off(p.p[0]) || off(p.p[1])) out.push(`Pin ${p.num} is off the 1.27 mm grid, so wires won't connect to it.`);
    }
    for (let u = 1; m.units > 1 && u <= m.units; u++) if (!pins.some((p) => !p.unit || p.unit === u) && !m.items.some((i) => i.unit === u)) out.push(`Unit ${String.fromCharCode(64 + u)} is empty.`);
    return Array.from(new Set(out));
  }

  // ---------------------------------------------------------------- hit testing (for the editor)
  function distSeg(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }
  function arcPts(it) {
    // circle through three points, sampled
    const [ax, ay] = it.a, [bx, by] = it.m, [cx, cy] = it.b;
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-9) return [it.a, it.m, it.b];
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
    const r = Math.hypot(ax - ux, ay - uy);
    let a0 = Math.atan2(ay - uy, ax - ux), a1 = Math.atan2(cy - uy, cx - ux), am = Math.atan2(by - uy, bx - ux);
    const norm = (x) => { while (x < 0) x += 2 * Math.PI; while (x >= 2 * Math.PI) x -= 2 * Math.PI; return x; };
    let sweep = norm(a1 - a0);
    if (norm(am - a0) > sweep) sweep = sweep - 2 * Math.PI;
    const n = 24, out = [];
    for (let i = 0; i <= n; i++) { const t = a0 + sweep * i / n; out.push([ux + r * Math.cos(t), uy + r * Math.sin(t)]); }
    return out;
  }
  /** Index of the item under p (library coords), or -1. visible(it) filters by unit/style. */
  function hitTest(m, p, tol, visible) {
    let best = -1, bd = tol;
    m.items.forEach((it, i) => {
      if (visible && !visible(it)) return;
      let d = Infinity;
      if (it.t === 'pin') d = Math.min(distSeg(p, it.p, pinEnd(it)), Math.hypot(p[0] - it.p[0], p[1] - it.p[1]) * 0.7);
      else if (it.t === 'rect') {
        const [x0, y0] = [Math.min(it.a[0], it.b[0]), Math.min(it.a[1], it.b[1])], [x1, y1] = [Math.max(it.a[0], it.b[0]), Math.max(it.a[1], it.b[1])];
        d = Math.min(distSeg(p, [x0, y0], [x1, y0]), distSeg(p, [x1, y0], [x1, y1]), distSeg(p, [x1, y1], [x0, y1]), distSeg(p, [x0, y1], [x0, y0]));
        if (it.fill !== 'none' && p[0] > x0 && p[0] < x1 && p[1] > y0 && p[1] < y1) d = Math.min(d, tol * 0.9);
      } else if (it.t === 'circle') { const r = Math.hypot(p[0] - it.c[0], p[1] - it.c[1]); d = Math.abs(r - it.r); if (it.fill !== 'none' && r < it.r) d = Math.min(d, tol * 0.9); }
      else if (it.t === 'arc') { const pts = arcPts(it); for (let k = 1; k < pts.length; k++) d = Math.min(d, distSeg(p, pts[k - 1], pts[k])); }
      else if (it.t === 'poly') for (let k = 1; k < it.pts.length; k++) d = Math.min(d, distSeg(p, it.pts[k - 1], it.pts[k]));
      else if (it.t === 'text') { const w = (it.s || '').length * (it.size || 1.27) * 0.6, h = it.size || 1.27; d = Math.abs(p[0] - it.p[0]) < w / 2 + 0.5 && Math.abs(p[1] - it.p[1]) < h / 2 + 0.5 ? tol * 0.8 : Infinity; }
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }
  /** Move an item by d (library coords). */
  function moveItem(it, d) {
    const mv = (p) => [r4(p[0] + d[0]), r4(p[1] + d[1])];
    if (it.t === 'rect' || it.t === 'arc') { it.a = mv(it.a); it.b = mv(it.b); if (it.m) it.m = mv(it.m); }
    else if (it.t === 'circle') it.c = mv(it.c);
    else if (it.t === 'poly') it.pts = it.pts.map(mv);
    else if (it.t === 'text' || it.t === 'pin') it.p = mv(it.p);
  }
  /** Rotate an item 90° anticlockwise about c (KiCad's R in the symbol editor). */
  function rotateItem(it, c) {
    const rot = (p) => [r4(c[0] - (p[1] - c[1])), r4(c[1] + (p[0] - c[0]))];
    if (it.t === 'rect' || it.t === 'arc') { it.a = rot(it.a); it.b = rot(it.b); if (it.m) it.m = rot(it.m); }
    else if (it.t === 'circle') it.c = rot(it.c);
    else if (it.t === 'poly') it.pts = it.pts.map(rot);
    else if (it.t === 'text') { it.p = rot(it.p); it.angle = ((it.angle || 0) + 90) % 180; }
    else if (it.t === 'pin') { it.p = rot(it.p); it.angle = ((it.angle || 0) + 90) % 360; }
  }
  /** A pin that follows `prev` (KiCad's repeat): one grid step on along the side, number and name counting up. */
  function nextPin(prev, step) {
    const p = clone(prev);
    const s = step || 2.54;
    const vertical = prev.angle === 0 || prev.angle === 180;
    p.p = vertical ? [prev.p[0], r4(prev.p[1] - s)] : [r4(prev.p[0] + s), prev.p[1]];
    const inc = (v) => { const m = /^(.*?)(\d+)(\D*)$/.exec(v || ''); return m ? m[1] + (+m[2] + 1) + m[3] : v; };
    p.num = inc(prev.num);
    p.name = prev.name && prev.name !== '~' ? inc(prev.name) : prev.name;
    p.alts = [];
    return p;
  }
  /** Replace the drawing with a box and the pins down its sides (the quick way to start a part). pins: [{num, name, type, side}] */
  function boxFrom(m, pins, E) {
    const text = E.boxSymbol({ name: m.name, ref: m.ref, value: m.value, pins, fields: {} });
    const b = parse(text);
    const out = clone(m);
    out.items = b.items.map((it) => Object.assign(it, { unit: 0, style: 0 }));
    delete out.fieldPos.Reference; delete out.fieldPos.Value;
    return out;
  }
  function pinCount(m) { return new Set(m.items.filter((i) => i.t === 'pin').map((p) => p.num)).size; }

  const api = { PIN_TYPES, PIN_TYPE_NAMES, PIN_SHAPES, PIN_SHAPE_NAMES, FILLS, GRID, blank, parse, serialize, check, bbox, pinEnd, hitTest, moveItem, rotateItem, nextPin, boxFrom, arcPts, pinCount, clone };
  root.SymEdit = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
