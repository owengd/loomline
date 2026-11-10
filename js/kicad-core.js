/* KiCad schematic core: S-expression parser, schematic model, hierarchy and
 * net connectivity. No DOM dependencies, so it also runs under Node for tests.
 * Supports the KiCad 6+ .kicad_sch format (tested against 7, 8 and 9 files). */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // S-expression parser. Lists become arrays; atoms and strings become strings.
  // ---------------------------------------------------------------------------
  // Lists also carry their source span (.s, .e); the span of any child token is found on demand
  // with tokSpan(), so the editor can rewrite single tokens and leave the rest of the file
  // byte-for-byte untouched without the parser storing a span for every token.
  function parseSexpr(text, withPos) {
    const n = text.length;
    let i = 0, cur = null, result = null;
    const stack = [];
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 40) { // (
        const l = [];
        if (withPos) l.s = i;
        if (cur) cur.push(l); else if (!result) result = l;
        stack.push(cur); cur = l; i++;
      } else if (c === 41) { // )
        if (withPos && cur) cur.e = i + 1;
        cur = stack.pop(); i++;
      } else if (c === 34) { // "
        i++;
        let s = '', start = i;
        while (i < n) {
          const d = text.charCodeAt(i);
          if (d === 92) {
            s += text.slice(start, i);
            const e = text[i + 1];
            s += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
            i += 2; start = i;
          } else if (d === 34) break;
          else i++;
        }
        s += text.slice(start, i); i++;
        if (cur) cur.push(s);
      } else if (c <= 32) {
        i++;
      } else {
        const start = i;
        while (i < n) {
          const d = text.charCodeAt(i);
          if (d <= 32 || d === 40 || d === 41) break;
          i++;
        }
        if (cur) cur.push(text.slice(start, i));
      }
    }
    return result;
  }

  // Source span [start, end] of child idx of a list parsed with positions (idx 0 is its keyword).
  function tokSpan(text, node, idx) {
    let i = node.s + 1;
    const n = node.e - 1;
    for (let k = 0; k < node.length && i < n; k++) {
      while (i < n && text.charCodeAt(i) <= 32) i++;
      const child = node[k];
      let st = i;
      if (Array.isArray(child)) { st = child.s; i = child.e; }
      else if (text.charCodeAt(i) === 34) {
        i++;
        while (i < n) { const d = text.charCodeAt(i); if (d === 92) i += 2; else if (d === 34) break; else i++; }
        i++;
      } else {
        while (i < n) { const d = text.charCodeAt(i); if (d <= 32 || d === 40 || d === 41) break; i++; }
      }
      if (k === idx) return [st, i];
    }
    return null;
  }
  const isList = Array.isArray;
  function find(node, key) {
    if (!node) return null;
    for (let k = 1; k < node.length; k++) { const c = node[k]; if (isList(c) && c[0] === key) return c; }
    return null;
  }
  function findAll(node, key) {
    const out = [];
    if (!node) return out;
    for (let k = 1; k < node.length; k++) { const c = node[k]; if (isList(c) && c[0] === key) out.push(c); }
    return out;
  }
  function num(v, def) { const x = parseFloat(v); return isNaN(x) ? (def === undefined ? 0 : def) : x; }
  function boolTok(node, key) {
    // Matches both `key` atoms and `(key yes)` lists.
    if (!node) return false;
    for (let k = 1; k < node.length; k++) {
      const c = node[k];
      if (c === key) return true;
      if (isList(c) && c[0] === key) return c.length < 2 || c[1] === 'yes' || c[1] === 'true';
    }
    return false;
  }
  function strVal(node, key, def) { const f = find(node, key); return f && f.length > 1 ? f[1] : def; }
  function xy(node) { return [num(node[1]), num(node[2])]; }
  function at(node) { const a = find(node, 'at'); return a ? { x: num(a[1]), y: num(a[2]), a: num(a[3]) } : { x: 0, y: 0, a: 0 }; }
  function pts(node) {
    const p = find(node, 'pts'); const out = [];
    if (p) for (const c of findAll(p, 'xy')) out.push(xy(c));
    return out;
  }
  function colorOf(node) {
    const c = find(node, 'color');
    if (!c) return null;
    const r = num(c[1]), g = num(c[2]), b = num(c[3]), a = c.length > 4 ? num(c[4]) : 1;
    if (r === 0 && g === 0 && b === 0 && a === 0) return null;
    return [r, g, b, a];
  }
  function stroke(node) {
    const s = find(node, 'stroke');
    if (!s) return { w: 0, type: 'default', color: null };
    return { w: num(strVal(s, 'width', 0)), type: strVal(s, 'type', 'default'), color: colorOf(s) };
  }
  function fill(node) {
    const f = find(node, 'fill');
    if (!f) return { type: 'none', color: null };
    const t = strVal(f, 'type', null);
    const color = colorOf(f);
    if (t) return { type: t, color };
    // Sheets use (fill (color r g b a)) with no type.
    return color ? { type: 'color', color } : { type: 'none', color: null };
  }
  function effects(node) {
    const e = find(node, 'effects');
    const r = { h: 1.27, w: 1.27, bold: false, italic: false, color: null, ha: 'center', va: 'center', mirror: false, hide: false };
    if (!e) { r.hide = boolTok(node, 'hide'); return r; }
    const f = find(e, 'font');
    if (f) {
      const s = find(f, 'size');
      if (s) { r.h = num(s[1], 1.27); r.w = num(s[2], r.h); }
      r.bold = boolTok(f, 'bold'); r.italic = boolTok(f, 'italic');
      r.color = colorOf(f);
    }
    const j = find(e, 'justify');
    if (j) {
      for (let k = 1; k < j.length; k++) {
        const t = j[k];
        if (t === 'left' || t === 'right') r.ha = t;
        else if (t === 'top' || t === 'bottom') r.va = t;
        else if (t === 'mirror') r.mirror = true;
      }
    }
    r.hide = boolTok(e, 'hide') || boolTok(node, 'hide');
    return r;
  }
  function uuidOf(node) { return strVal(node, 'uuid', strVal(node, 'tstamp', '')); }

  // ---------------------------------------------------------------------------
  // Geometry helpers
  // ---------------------------------------------------------------------------
  function arcPoints(s, m, e, segs) {
    // Circle through three points, sampled from s through m to e.
    const ax = s[0], ay = s[1], bx = m[0], by = m[1], cx = e[0], cy = e[1];
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-12) return [s, e];
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
    const r = Math.hypot(ax - ux, ay - uy);
    const a0 = Math.atan2(ay - uy, ax - ux), a1 = Math.atan2(by - uy, bx - ux), a2 = Math.atan2(cy - uy, cx - ux);
    const norm = (a) => { while (a < 0) a += 2 * Math.PI; while (a >= 2 * Math.PI) a -= 2 * Math.PI; return a; };
    const ccwSpan = norm(a2 - a0), ccwMid = norm(a1 - a0);
    const span = ccwMid <= ccwSpan ? ccwSpan : ccwSpan - 2 * Math.PI;
    const n = segs || Math.max(8, Math.ceil(Math.abs(span) / (Math.PI / 24)));
    const out = [];
    for (let k = 0; k <= n; k++) { const a = a0 + span * k / n; out.push([ux + r * Math.cos(a), uy + r * Math.sin(a)]); }
    return out;
  }
  function bezierPoints(p) {
    if (p.length < 4) return p;
    const out = [];
    for (let k = 0; k <= 24; k++) {
      const t = k / 24, u = 1 - t;
      out.push([
        u * u * u * p[0][0] + 3 * u * u * t * p[1][0] + 3 * u * t * t * p[2][0] + t * t * t * p[3][0],
        u * u * u * p[0][1] + 3 * u * u * t * p[1][1] + 3 * u * t * t * p[2][1] + t * t * t * p[3][1]]);
    }
    return out;
  }
  function onSegment(p, a, b, eps) {
    eps = eps || 1e-4;
    const minx = Math.min(a[0], b[0]) - eps, maxx = Math.max(a[0], b[0]) + eps;
    const miny = Math.min(a[1], b[1]) - eps, maxy = Math.max(a[1], b[1]) + eps;
    if (p[0] < minx || p[0] > maxx || p[1] < miny || p[1] > maxy) return false;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return Math.hypot(p[0] - a[0], p[1] - a[1]) < eps;
    return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len < eps;
  }
  function key(p) { return Math.round(p[0] * 1000) + ',' + Math.round(p[1] * 1000); }

  // Symbol transform, matching eeschema's TRANSFORM: X = x1*x + y1*y, Y = x2*x + y2*y
  function symTransform(angle, mirror) {
    let m;
    switch (((Math.round(angle) % 360) + 360) % 360) {
      case 90: m = [0, 1, -1, 0]; break;
      case 180: m = [-1, 0, 0, -1]; break;
      case 270: m = [0, -1, 1, 0]; break;
      default: m = [1, 0, 0, 1];
    }
    const apply = (t) => [
      m[0] * t[0] + m[2] * t[1], m[1] * t[0] + m[3] * t[1],
      m[0] * t[2] + m[2] * t[3], m[1] * t[2] + m[3] * t[3]];
    if (mirror === 'x') m = apply([1, 0, 0, -1]);
    else if (mirror === 'y') m = apply([-1, 0, 0, 1]);
    return m;
  }
  function tf(m, p) { return [m[0] * p[0] + m[1] * p[1], m[2] * p[0] + m[3] * p[1]]; }
  function tfInv(m, p) {
    const det = m[0] * m[3] - m[1] * m[2];
    return [(m[3] * p[0] - m[1] * p[1]) / det, (-m[2] * p[0] + m[0] * p[1]) / det];
  }

  // ---------------------------------------------------------------------------
  // Text helpers
  // ---------------------------------------------------------------------------
  // Splits KiCad markup (~{overbar}, _{sub}, ^{super}) into runs.
  function markupRuns(s) {
    const runs = [];
    let i = 0, buf = '';
    const flush = (o) => { if (buf) runs.push({ t: buf, over: !!(o && o.over), sub: !!(o && o.sub), sup: !!(o && o.sup) }); buf = ''; };
    while (i < s.length) {
      const c = s[i];
      if ((c === '~' || c === '_' || c === '^') && s[i + 1] === '{') {
        let depth = 1, j = i + 2;
        while (j < s.length && depth) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; if (depth) j++; }
        flush();
        const inner = s.slice(i + 2, j);
        buf = inner.replace(/[~_^]\{|\}/g, '');
        flush({ over: c === '~', sub: c === '_', sup: c === '^' });
        i = j + 1;
      } else { buf += c; i++; }
    }
    flush();
    return runs;
  }
  function plainText(s) { return markupRuns(s).map((r) => r.t).join(''); }

  // ---------------------------------------------------------------------------
  // Library symbols
  // ---------------------------------------------------------------------------
  function parseLibItem(c, out) {
    const t = c[0];
    const st = stroke(c), fl = fill(c);
    const inv = (p) => [p[0], -p[1]];
    if (t === 'polyline') out.push({ t: 'poly', pts: pts(c).map(inv), st, fl });
    else if (t === 'rectangle') {
      const a = inv(xy(find(c, 'start'))), b = inv(xy(find(c, 'end')));
      out.push({ t: 'poly', pts: [a, [b[0], a[1]], b, [a[0], b[1]], a], st, fl, closed: true });
    } else if (t === 'circle') {
      out.push({ t: 'circle', c: inv(xy(find(c, 'center'))), r: num(strVal(c, 'radius', 0)), st, fl });
    } else if (t === 'arc') {
      const s = find(c, 'start'), m = find(c, 'mid'), e = find(c, 'end');
      if (s && m && e) out.push({ t: 'poly', pts: arcPoints(inv(xy(s)), inv(xy(m)), inv(xy(e))), st, fl });
    } else if (t === 'bezier') {
      out.push({ t: 'poly', pts: bezierPoints(pts(c).map(inv)), st, fl });
    } else if (t === 'text') {
      const a = at(c);
      let ang = a.a; if (ang > 360) ang /= 10;
      out.push({ t: 'text', s: c[1], p: [a.x, -a.y], a: ang, fx: effects(c) });
    } else if (t === 'text_box') {
      const a = at(c), sz = find(c, 'size');
      const p0 = [a.x, -a.y], p1 = [a.x + num(sz && sz[1]), -a.y - num(sz && sz[2])];
      out.push({ t: 'textbox', s: c[1], a: p0, b: p1, st, fl, fx: effects(c) });
    } else if (t === 'pin') {
      const a = at(c);
      const nameN = find(c, 'name'), numN = find(c, 'number');
      const alts = findAll(c, 'alternate').map((x) => ({ name: x[1], type: x[2] }));
      out.push({
        t: 'pin', type: c[1], shape: c[2], p: [a.x, -a.y], a: a.a,
        len: num(strVal(c, 'length', 2.54)), hide: boolTok(c, 'hide'),
        name: nameN ? nameN[1] : '', number: numN ? numN[1] : '',
        nameFx: effects(nameN), numFx: effects(numN), alts
      });
    }
  }
  function parseLibSymbol(node) {
    const sym = {
      name: node[1], power: false, extends: strVal(node, 'extends', null),
      pinNameOffset: 0.508, pinNamesHide: false, pinNumbersHide: false,
      props: {}, units: [], unitCount: 1, dupPinJumpers: boolTok(node, 'duplicate_pin_numbers_are_jumpers'), jumperGroups: []
    };
    const pw = find(node, 'power');
    if (pw) sym.power = pw[1] === 'local' ? 'local' : 'global';
    const pn = find(node, 'pin_names');
    if (pn) { const o = find(pn, 'offset'); if (o) sym.pinNameOffset = num(o[1]); sym.pinNamesHide = boolTok(pn, 'hide'); }
    const pnum = find(node, 'pin_numbers');
    if (pnum) sym.pinNumbersHide = boolTok(pnum, 'hide');
    for (const p of findAll(node, 'property')) sym.props[p[1]] = p[2];
    const jg = find(node, 'jumper_pin_groups');
    if (jg) for (let k = 1; k < jg.length; k++) if (isList(jg[k])) sym.jumperGroups.push(jg[k].filter((x) => typeof x === 'string'));
    for (const sub of findAll(node, 'symbol')) {
      const m = /_(\d+)_(\d+)$/.exec(sub[1]);
      const unit = m ? +m[1] : 0, style = m ? +m[2] : 0;
      const items = [];
      for (let k = 2; k < sub.length; k++) if (isList(sub[k])) parseLibItem(sub[k], items);
      sym.units.push({ unit, style, items });
      if (unit > sym.unitCount) sym.unitCount = unit;
    }
    // Graphics directly under the symbol (rare) count as unit 0.
    const direct = [];
    for (let k = 2; k < node.length; k++) {
      const c = node[k];
      if (isList(c) && ['polyline', 'rectangle', 'circle', 'arc', 'bezier', 'text', 'pin', 'text_box'].includes(c[0])) parseLibItem(c, direct);
    }
    if (direct.length) sym.units.push({ unit: 0, style: 0, items: direct });
    return sym;
  }
  function libItemsFor(lib, unit, style) {
    const out = [];
    if (!lib) return out;
    for (const u of lib.units) {
      if ((u.unit === 0 || u.unit === unit) && (u.style === 0 || u.style === style)) for (const it of u.items) out.push(it);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Schematic file
  // ---------------------------------------------------------------------------
  const PAPER = {
    A5: [210, 148], A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841],
    A: [279.4, 215.9], B: [431.8, 279.4], C: [558.8, 431.8], D: [863.6, 558.8], E: [1117.6, 863.6],
    USLetter: [279.4, 215.9], USLegal: [355.6, 215.9], USLedger: [431.8, 279.4],
    GERBER: [812.8, 812.8]
  };

  function parseProps(node) {
    return findAll(node, 'property').map((p) => {
      const a = at(p);
      return { name: p[1], value: p[2] || '', p: [a.x, a.y], a: a.a, fx: effects(p), showName: boolTok(p, 'show_name'), src: p };
    });
  }

  function parseSchematic(text, path) {
    const t = parseSexpr(text, true);
    if (!t || t[0] !== 'kicad_sch') throw new Error('Not a KiCad 6+ schematic (.kicad_sch): ' + path);
    const sh = {
      path, text, root: t, uuid: strVal(t, 'uuid', ''), version: +strVal(t, 'version', 0),
      paper: [297, 210], titleBlock: { comments: {} }, libSymbols: {},
      wires: [], buses: [], entries: [], junctions: [], noConnects: [], labels: [], symbols: [], sheets: [],
      texts: [], textBoxes: [], graphics: [], images: [], busAliases: {},
      legacySymbolInstances: {}, legacySheetInstances: {}
    };
    const paper = find(t, 'paper');
    if (paper) {
      if (paper[1] === 'User') sh.paper = [num(paper[2]), num(paper[3])];
      else if (PAPER[paper[1]]) sh.paper = PAPER[paper[1]].slice();
      if (paper.includes('portrait')) sh.paper = [Math.min(...sh.paper), Math.max(...sh.paper)];
    }
    const tb = find(t, 'title_block');
    if (tb) {
      sh.titleBlock.title = strVal(tb, 'title', '');
      sh.titleBlock.date = strVal(tb, 'date', '');
      sh.titleBlock.rev = strVal(tb, 'rev', '');
      sh.titleBlock.company = strVal(tb, 'company', '');
      for (const c of findAll(tb, 'comment')) sh.titleBlock.comments[c[1]] = c[2];
    }
    const ls = find(t, 'lib_symbols');
    if (ls) for (const s of findAll(ls, 'symbol')) { const l = parseLibSymbol(s); sh.libSymbols[l.name] = l; }
    for (const name in sh.libSymbols) {
      const l = sh.libSymbols[name];
      if (l.extends && !l.units.length) {
        const parentName = Object.keys(sh.libSymbols).find((n) => n === l.extends || n.endsWith(':' + l.extends));
        if (parentName) l.units = sh.libSymbols[parentName].units, l.unitCount = sh.libSymbols[parentName].unitCount;
      }
    }

    for (let k = 1; k < t.length; k++) {
      const c = t[k];
      if (!isList(c)) continue;
      switch (c[0]) {
        case 'wire': case 'bus': {
          const p = pts(c);
          for (let q = 0; q + 1 < p.length; q++) (c[0] === 'wire' ? sh.wires : sh.buses).push({ a: p[q], b: p[q + 1], st: stroke(c), uuid: uuidOf(c), src: c, seg: q });
          break;
        }
        case 'bus_entry': {
          const a = at(c), s = find(c, 'size');
          sh.entries.push({ a: [a.x, a.y], b: [a.x + num(s && s[1]), a.y + num(s && s[2])], st: stroke(c), src: c });
          break;
        }
        case 'junction': {
          const a = at(c);
          sh.junctions.push({ p: [a.x, a.y], d: num(strVal(c, 'diameter', 0)), color: colorOf(c), src: c });
          break;
        }
        case 'no_connect': { const a = at(c); sh.noConnects.push({ p: [a.x, a.y], src: c }); break; }
        case 'label': case 'global_label': case 'hierarchical_label': case 'netclass_flag': case 'directive_label': {
          const a = at(c);
          const fx = effects(c);
          let ang = ((Math.round(a.a) % 360) + 360) % 360;
          // KeepUpright, then derive spin style from angle + justification, as eeschema does.
          const vertical = ang === 90 || ang === 270;
          let spin;
          if (vertical) spin = fx.ha === 'right' ? 'bottom' : 'up';
          else spin = fx.ha === 'right' ? 'left' : 'right';
          const kind = { label: 'local', global_label: 'global', hierarchical_label: 'hier', netclass_flag: 'directive', directive_label: 'directive' }[c[0]];
          sh.labels.push({
            kind, text: c[1] || '', p: [a.x, a.y], spin, fx,
            shape: strVal(c, 'shape', kind === 'hier' ? 'input' : 'passive'),
            length: num(strVal(c, 'length', 2.54)),
            props: parseProps(c), uuid: uuidOf(c), src: c, angle: ((Math.round(a.a) % 360) + 360) % 360
          });
          break;
        }
        case 'symbol': {
          const a = at(c);
          const mir = find(c, 'mirror');
          const sym = {
            libId: strVal(c, 'lib_id', ''), libName: strVal(c, 'lib_name', null),
            p: [a.x, a.y], angle: a.a, mirror: mir ? mir[1] : null,
            unit: +strVal(c, 'unit', 1), style: +strVal(c, 'body_style', strVal(c, 'convert', 1)),
            dnp: boolTok(c, 'dnp'), inBom: strVal(c, 'in_bom', 'yes') === 'yes', onBoard: strVal(c, 'on_board', 'yes') === 'yes',
            uuid: uuidOf(c), props: parseProps(c), instances: [], pinAlts: {}, src: c
          };
          for (const pn of findAll(c, 'pin')) { const alt = strVal(pn, 'alternate', null); if (alt) sym.pinAlts[pn[1]] = alt; }
          const inst = find(c, 'instances');
          if (inst) for (const pr of findAll(inst, 'project')) for (const pa of findAll(pr, 'path')) {
            sym.instances.push({ project: pr[1], path: pa[1], ref: strVal(pa, 'reference', null), unit: +strVal(pa, 'unit', sym.unit) });
          }
          sym.m = symTransform(sym.angle, sym.mirror);
          sym.lib = sh.libSymbols[sym.libName || sym.libId] || sh.libSymbols[sym.libId] || null;
          sh.symbols.push(sym);
          break;
        }
        case 'sheet': {
          const a = at(c), s = find(c, 'size');
          const props = parseProps(c);
          const prop = (n1, n2) => { const p = props.find((x) => x.name === n1 || x.name === n2); return p ? p.value : ''; };
          const sheet = {
            p: [a.x, a.y], size: [num(s && s[1]), num(s && s[2])], uuid: uuidOf(c), props,
            name: prop('Sheetname', 'Sheet name'), file: prop('Sheetfile', 'Sheet file'),
            st: stroke(c), fl: fill(c), pins: [], instances: [], dnp: boolTok(c, 'dnp'), src: c
          };
          for (const pn of findAll(c, 'pin')) {
            const pa = at(pn);
            const side = { 0: 'right', 90: 'top', 180: 'left', 270: 'bottom' }[((Math.round(pa.a) % 360) + 360) % 360] || 'left';
            const spin = { right: 'left', left: 'right', top: 'bottom', bottom: 'up' }[side];
            sheet.pins.push({ name: pn[1], shape: pn[2] || 'input', p: [pa.x, pa.y], side, spin, fx: effects(pn), uuid: uuidOf(pn), src: pn });
          }
          const inst = find(c, 'instances');
          if (inst) for (const pr of findAll(inst, 'project')) for (const pa of findAll(pr, 'path')) sheet.instances.push({ project: pr[1], path: pa[1], page: strVal(pa, 'page', '') });
          sh.sheets.push(sheet);
          break;
        }
        case 'text': {
          const a = at(c);
          sh.texts.push({ s: c[1] || '', p: [a.x, a.y], a: a.a, fx: effects(c), src: c });
          break;
        }
        case 'text_box': {
          const a = at(c), s = find(c, 'size'), m = find(c, 'margins');
          sh.textBoxes.push({ s: c[1] || '', p: [a.x, a.y], size: [num(s && s[1]), num(s && s[2])], a: a.a, st: stroke(c), fl: fill(c), fx: effects(c), margins: m ? [num(m[1]), num(m[2]), num(m[3]), num(m[4])] : null, src: c });
          break;
        }
        case 'table': {
          for (const cells of findAll(c, 'cells')) for (const cell of findAll(cells, 'table_cell')) {
            const a = at(cell), s = find(cell, 'size'), m = find(cell, 'margins');
            sh.textBoxes.push({ s: cell[1] || '', p: [a.x, a.y], size: [num(s && s[1]), num(s && s[2])], a: a.a, st: { w: 0.1524, type: 'solid', color: null }, fl: fill(cell), fx: effects(cell), margins: m ? [num(m[1]), num(m[2]), num(m[3]), num(m[4])] : null });
          }
          break;
        }
        case 'polyline': sh.graphics.push({ t: 'poly', pts: pts(c), st: stroke(c), fl: fill(c), src: c, kind: 'polyline' }); break;
        case 'rectangle': {
          const a = xy(find(c, 'start')), b = xy(find(c, 'end'));
          sh.graphics.push({ t: 'poly', pts: [a, [b[0], a[1]], b, [a[0], b[1]], a], st: stroke(c), fl: fill(c), closed: true, src: c, kind: 'rectangle' });
          break;
        }
        case 'circle': sh.graphics.push({ t: 'circle', c: xy(find(c, 'center')), r: num(strVal(c, 'radius', 0)), st: stroke(c), fl: fill(c), src: c, kind: 'circle' }); break;
        case 'arc': {
          const s = find(c, 'start'), m = find(c, 'mid'), e = find(c, 'end');
          if (s && m && e) sh.graphics.push({ t: 'poly', pts: arcPoints(xy(s), xy(m), xy(e)), st: stroke(c), fl: fill(c), src: c, kind: 'arc' });
          break;
        }
        case 'bezier': sh.graphics.push({ t: 'poly', pts: bezierPoints(pts(c)), st: stroke(c), fl: fill(c), src: c, kind: 'bezier' }); break;
        case 'rule_area': {
          const pl = find(c, 'polyline');
          if (pl) sh.graphics.push({ t: 'poly', pts: pts(pl), st: Object.assign(stroke(pl), { type: 'dash' }), fl: { type: 'none' }, role: 'rule' });
          break;
        }
        case 'image': {
          const a = at(c), d = find(c, 'data');
          if (d) sh.images.push({ p: [a.x, a.y], scale: num(strVal(c, 'scale', 1), 1), data: d.slice(1).filter((x) => typeof x === 'string').join('') });
          break;
        }
        case 'bus_alias': {
          const m = find(c, 'members');
          sh.busAliases[c[1]] = m ? m.slice(1) : [];
          break;
        }
        case 'symbol_instances': {
          for (const pa of findAll(c, 'path')) sh.legacySymbolInstances[pa[1]] = { ref: strVal(pa, 'reference', null), unit: +strVal(pa, 'unit', 1) };
          break;
        }
        case 'sheet_instances': {
          for (const pa of findAll(c, 'path')) sh.legacySheetInstances[pa[1]] = strVal(pa, 'page', '');
          break;
        }
      }
    }
    buildLocalConnectivity(sh);
    return sh;
  }

  // ---------------------------------------------------------------------------
  // Pins of a placed symbol, in sheet coordinates.
  // ---------------------------------------------------------------------------
  function symbolPins(sym) {
    if (sym._pins) return sym._pins;
    const out = [];
    for (const it of libItemsFor(sym.lib, sym.unit, sym.style)) {
      if (it.t !== 'pin') continue;
      const p = tf(sym.m, it.p);
      const ang = ((Math.round(it.a) % 360) + 360) % 360;
      const dirL = ang === 0 ? [1, 0] : ang === 90 ? [0, -1] : ang === 180 ? [-1, 0] : [0, 1];
      const d = tf(sym.m, dirL);
      const pos = [sym.p[0] + p[0], sym.p[1] + p[1]];
      const rootP = [pos[0] + d[0] * it.len, pos[1] + d[1] * it.len];
      out.push({ lib: it, pos, root: rootP, dir: d, number: it.number, name: it.name, type: it.type, hide: it.hide });
    }
    sym._pins = out;
    return out;
  }

  // ---------------------------------------------------------------------------
  // Local (single sheet file) connectivity: groups of items that touch.
  // ---------------------------------------------------------------------------
  function UF(n) { const p = new Int32Array(n); for (let i = 0; i < n; i++) p[i] = i; return p; }
  function ufFind(p, a) { while (p[a] !== a) { p[a] = p[p[a]]; a = p[a]; } return a; }
  function ufUnion(p, a, b) { a = ufFind(p, a); b = ufFind(p, b); if (a !== b) p[b] = a; }

  function buildLocalConnectivity(sh) {
    // Every connectable thing gets a node index. cat: 'bus' | 'net' | 'flex'
    const nodes = [];
    const add = (kind, ref, cat) => { nodes.push({ kind, ref, cat }); return nodes.length - 1; };
    const pointMap = new Map();
    const at = (p, n) => { const k = key(p); let l = pointMap.get(k); if (!l) pointMap.set(k, l = []); l.push(n); };

    sh.wires.forEach((w, i) => { w.node = add('wire', i, 'net'); at(w.a, w.node); at(w.b, w.node); });
    sh.buses.forEach((w, i) => { w.node = add('bus', i, 'bus'); at(w.a, w.node); at(w.b, w.node); });
    // The end of a bus entry that lands on a bus belongs to the bus, so it must not short
    // together the wires of other entries that touch the bus at the same spot.
    const onBus = (p) => sh.buses.some((b) => onSegment(p, b.a, b.b));
    sh.entries.forEach((e, i) => {
      e.node = add('entry', i, 'net');
      if (!onBus(e.a)) at(e.a, e.node);
      if (!onBus(e.b)) at(e.b, e.node);
    });
    sh.junctions.forEach((j, i) => { j.node = add('junction', i, 'flex'); at(j.p, j.node); });
    sh.noConnects.forEach((nc, i) => { nc.node = add('nc', i, 'net'); at(nc.p, nc.node); });
    sh.labels.forEach((l, i) => { l.node = add('label', i, 'flex'); at(l.p, l.node); });
    sh.symbols.forEach((s, si) => {
      symbolPins(s).forEach((pin, pi) => { pin.node = add('pin', [si, pi], 'net'); at(pin.pos, pin.node); });
    });
    sh.sheets.forEach((s, si) => s.pins.forEach((pin, pi) => { pin.node = add('sheetpin', [si, pi], 'flex'); at(pin.p, pin.node); }));

    // Junctions, labels and sheet pins also join lines that pass through them.
    const passItems = [];
    sh.junctions.forEach((j) => passItems.push([j.p, j.node]));
    sh.labels.forEach((l) => passItems.push([l.p, l.node]));
    sh.sheets.forEach((s) => s.pins.forEach((pin) => passItems.push([pin.p, pin.node])));
    for (const [p, n] of passItems) {
      for (const w of sh.wires) if (onSegment(p, w.a, w.b)) at(p, w.node);
      for (const w of sh.buses) if (onSegment(p, w.a, w.b)) at(p, w.node);
    }
    // Bus entries that touch a bus mid-segment are not joined to it (net side only).

    const uf = UF(nodes.length);
    for (const list of pointMap.values()) {
      if (list.length < 2) continue;
      const uniq = Array.from(new Set(list));
      const hasBus = uniq.some((n) => nodes[n].cat === 'bus');
      let firstBus = -1, firstNet = -1;
      for (const n of uniq) {
        const cat = nodes[n].cat;
        if (cat === 'bus' || (cat === 'flex' && hasBus)) { if (firstBus < 0) firstBus = n; else ufUnion(uf, firstBus, n); }
        else { if (firstNet < 0) firstNet = n; else ufUnion(uf, firstNet, n); }
      }
    }
    // Jumper pins inside one symbol
    sh.symbols.forEach((s) => {
      if (!s.lib) return;
      const pins = symbolPins(s);
      if (s.lib.dupPinJumpers) {
        const byNum = {};
        for (const p of pins) (byNum[p.number] = byNum[p.number] || []).push(p.node);
        for (const k in byNum) for (let q = 1; q < byNum[k].length; q++) ufUnion(uf, byNum[k][0], byNum[k][q]);
      }
      for (const g of s.lib.jumperGroups) {
        const ns = pins.filter((p) => g.includes(p.number)).map((p) => p.node);
        for (let q = 1; q < ns.length; q++) ufUnion(uf, ns[0], ns[q]);
      }
    });

    // Point lists, kept for step-by-step tracing (which items touch which points).
    sh.pointLists = []; sh.pointKeys = [];
    nodes.forEach((n) => { n.pts = []; });
    for (const [k, list] of pointMap) {
      const uniq = Array.from(new Set(list)), pi = sh.pointLists.length;
      sh.pointLists.push(uniq); sh.pointKeys.push(k);
      for (const n of uniq) nodes[n].pts.push(pi);
    }

    // Assign compact group ids.
    const groupOfRoot = new Map();
    const groups = [];
    nodes.forEach((n, i) => {
      const r = ufFind(uf, i);
      let g = groupOfRoot.get(r);
      if (g === undefined) { g = groups.length; groupOfRoot.set(r, g); groups.push({ id: g, bus: false, items: [] }); }
      n.group = g;
      groups[g].items.push(i);
      if (n.cat === 'bus') groups[g].bus = true;
    });
    // A group with a bus segment and flex-only items is a bus; flex-only groups at a bus point are bus too.
    sh.nodes = nodes;
    sh.groups = groups;
    const setG = (obj) => { obj.group = nodes[obj.node].group; };
    sh.wires.forEach(setG); sh.buses.forEach(setG); sh.entries.forEach(setG); sh.junctions.forEach(setG);
    sh.noConnects.forEach(setG); sh.labels.forEach(setG);
    sh.symbols.forEach((s) => symbolPins(s).forEach(setG));
    sh.sheets.forEach((s) => s.pins.forEach(setG));
    sh.junctions.forEach((j) => { j.bus = groups[j.group].bus; });
  }

  // ---------------------------------------------------------------------------
  // Bus name expansion
  // ---------------------------------------------------------------------------
  // Finds a bus group "PREFIX{A B C}" while ignoring markup braces such as I2C_{SYS}.
  function parseBusGroup(n) {
    if (!n || n[n.length - 1] !== '}') return null;
    let depth = 0;
    for (let i = n.length - 1; i >= 0; i--) {
      if (n[i] === '}') depth++;
      else if (n[i] === '{') {
        depth--;
        if (depth === 0) {
          const prev = i > 0 ? n[i - 1] : '';
          if (prev === '~' || prev === '_' || prev === '^' || prev === '$') return null;
          return { prefix: n.slice(0, i), body: n.slice(i + 1, n.length - 1) };
        }
      }
    }
    return null;
  }
  function splitGroupBody(b) {
    const out = []; let depth = 0, cur = '';
    for (const ch of b) {
      if (ch === '{') depth++; else if (ch === '}') depth--;
      if (depth === 0 && (ch === ' ' || ch === ',' || ch === '\t')) { if (cur) out.push(cur); cur = ''; } else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  }
  function isBusName(n) { return /\[\d+\.\.\d+\]$/.test(n) || !!parseBusGroup(n); }
  function expandBus(name, aliases) { return expandBusKeyed(name, aliases).map((m) => m.name); }

  // ---------------------------------------------------------------------------
  // Project: hierarchy, instances, nets
  // ---------------------------------------------------------------------------
  function dirname(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
  function basename(p) { const i = p.lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1); }
  function joinPath(dir, rel) {
    const parts = (dir ? dir.split('/') : []).concat(rel.replace(/\\/g, '/').split('/'));
    const out = [];
    for (const s of parts) { if (s === '' || s === '.') continue; if (s === '..') out.pop(); else out.push(s); }
    return out.join('/');
  }
  // Legacy (KiCad 6) instance paths omit the root sheet uuid.
  function legacyPath(p) { const i = p.indexOf('/', 1); return i < 0 ? '/' : p.slice(i); }
  // One shared collator: localeCompare with options builds a new one on every call.
  const collator = typeof Intl !== 'undefined' ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }) : null;
  function naturalCmp(a, b) { return collator ? collator.compare(String(a), String(b)) : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' }); }

  /**
   * files: [{path, text}] — .kicad_sch files, plus an optional .kicad_pro (JSON) for text variables / root detection.
   * Returns a project with instances (sheet tree) and nets.
   */
  const parseCache = new Map();
  function buildProject(files, opts) {
    opts = opts || {};
    const sheetsByPath = {};
    const errors = [];
    let pro = null, proPath = null;
    for (const f of files) {
      if (/\.kicad_sch$/i.test(f.path)) {
        // A sheet file that hasn't changed since the last build is reused as parsed: after an edit
        // only the edited file is read again. (Parsed sheets are not changed once built.)
        const hit = parseCache.get(f.path);
        if (hit && hit.text === f.text) { sheetsByPath[f.path] = hit.sheet; continue; }
        try { sheetsByPath[f.path] = parseSchematic(f.text, f.path); parseCache.set(f.path, { text: f.text, sheet: sheetsByPath[f.path] }); }
        catch (e) { errors.push({ path: f.path, message: e.message }); }
      } else if (/\.kicad_pro$/i.test(f.path)) {
        try { pro = JSON.parse(f.text); proPath = f.path; } catch (e) { /* ignore */ }
      }
    }
    const paths = Object.keys(sheetsByPath);
    if (!paths.length) throw new Error(errors.length ? errors[0].message : 'No .kicad_sch files found.');
    const byBase = {};
    for (const p of paths) { const b = basename(p).toLowerCase(); (byBase[b] = byBase[b] || []).push(p); }
    const resolve = (fromPath, rel) => {
      if (!rel) return null;
      const j = joinPath(dirname(fromPath), rel);
      if (sheetsByPath[j]) return j;
      const lower = j.toLowerCase();
      const ci = paths.find((p) => p.toLowerCase() === lower);
      if (ci) return ci;
      const b = byBase[basename(rel).toLowerCase()];
      return b ? b[0] : null;
    };
    const referenced = new Set();
    for (const p of paths) for (const s of sheetsByPath[p].sheets) { const r = resolve(p, s.file); s.resolved = r; if (r) referenced.add(r); }

    let rootPath = null;
    if (proPath) {
      const cand = proPath.replace(/\.kicad_pro$/i, '.kicad_sch');
      if (sheetsByPath[cand]) rootPath = cand;
    }
    const roots = paths.filter((p) => !referenced.has(p));
    if (!rootPath) {
      rootPath = roots.sort((a, b) => sheetsByPath[b].sheets.length - sheetsByPath[a].sheets.length || a.length - b.length)[0] || paths[0];
    }
    const extraRoots = roots.filter((p) => p !== rootPath);
    const projectName = basename(rootPath).replace(/\.kicad_sch$/i, '');
    const textVars = (pro && pro.text_variables) || {};

    // Instance tree
    const instances = [];
    const makeInst = (sheet, parent, sheetSym, uuidPath, namePath, depth) => {
      const inst = {
        idx: instances.length, sheet, parent, sheetSym, path: uuidPath, namePath, depth, children: [],
        name: sheetSym ? sheetSym.name : (parent ? '' : 'Root'), page: '',
        scope: parent ? parent.scope : instances.length
      };
      instances.push(inst);
      if (parent) parent.children.push(inst);
      if (depth > 32) return inst;
      for (const s of sheet.sheets) {
        if (!s.resolved) continue;
        const child = sheetsByPath[s.resolved];
        // Guard against recursive hierarchies.
        let a = inst, loop = false; while (a) { if (a.sheet === child) { loop = true; break; } a = a.parent; }
        if (loop) continue;
        makeInst(child, inst, s, uuidPath + '/' + s.uuid, namePath + s.name + '/', depth + 1);
      }
      return inst;
    };
    const rootSheet = sheetsByPath[rootPath];
    const rootInst = makeInst(rootSheet, null, null, '/' + rootSheet.uuid, '/', 0);
    rootInst.name = projectName;
    for (const p of extraRoots) {
      const sh = sheetsByPath[p];
      const r = makeInst(sh, null, null, '/' + sh.uuid, '/' + basename(p).replace(/\.kicad_sch$/i, '') + '/', 0);
      r.name = basename(p).replace(/\.kicad_sch$/i, '');
      r.orphan = true;
    }
    // Page numbers
    let fallbackPage = 1;
    for (const inst of instances) {
      let page = '';
      if (!inst.parent) page = rootSheet.legacySheetInstances['/'] || (inst === rootInst ? '1' : '');
      else {
        const parentPath = inst.parent.path;
        const e = inst.sheetSym.instances.find((x) => x.path === parentPath) || (inst.sheetSym.instances.length === 1 ? inst.sheetSym.instances[0] : null);
        if (e) page = e.page;
        if (!page) page = rootSheet.legacySheetInstances[legacyPath(inst.path)] || '';
      }
      inst.page = page || String(fallbackPage);
      fallbackPage++;
    }
    const instSorted = instances.slice().sort((a, b) => naturalCmp(a.page, b.page));
    instSorted.forEach((x, i) => { x.order = i; });
    const pageCount = instances.length;

    // Symbol references per instance
    const projName = projectName;
    for (const inst of instances) {
      inst.refs = inst.sheet.symbols.map((s) => {
        let e = s.instances.filter((x) => x.path === inst.path);
        if (e.length > 1) e = e.filter((x) => x.project === projName).concat(e);
        if (e.length && e[0].ref) return { ref: e[0].ref, unit: e[0].unit || s.unit };
        const lg = rootSheet.legacySymbolInstances[legacyPath(inst.path).replace(/\/$/, '') + '/' + s.uuid];
        if (lg && lg.ref) return { ref: lg.ref, unit: lg.unit };
        const rp = s.props.find((p) => p.name === 'Reference');
        return { ref: rp ? rp.value : '?', unit: s.unit };
      });
    }

    // ---------------------------------------------------------------- nets
    // Project-wide bus aliases (sheet files and, for KiCad 9+, the project file)
    const aliases = {};
    for (const p of paths) Object.assign(aliases, sheetsByPath[p].busAliases);
    const proAliases = pro && pro.schematic && pro.schematic.bus_aliases;
    if (proAliases && typeof proAliases === 'object') for (const k in proAliases) if (Array.isArray(proAliases[k])) aliases[k] = proAliases[k];

    const nodeIndex = new Map();
    const nodeList = [];
    for (const inst of instances) for (const g of inst.sheet.groups) { nodeIndex.set(inst.idx + ':' + g.id, nodeList.length); nodeList.push({ inst, g }); }
    const parent = [];
    for (let i = 0; i < nodeList.length; i++) parent.push(i);
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
    const virtualNode = () => { parent.push(parent.length); return parent.length - 1; };
    const nidx = (inst, g) => nodeIndex.get(inst.idx + ':' + g);

    const globalNames = new Map(); // name -> node
    const joinName = (map, name, n, inst) => {
      // Sheet files outside the main hierarchy keep their global names to themselves.
      if (map === globalNames) name = inst.scope + '|' + name;
      const e = map.get(name); if (e === undefined) map.set(name, n); else union(e, n);
    };
    const globalGet = (inst, name) => globalNames.get(inst.scope + '|' + name);
    const isPowerSym = (s) => s.lib && s.lib.power;
    const valueOf = (s) => { const v = s.props.find((p) => p.name === 'Value'); return v ? v.value : ''; };

    // 1. Names attached to groups; labels, hierarchical labels and local power share a sheet's local scope.
    for (const inst of instances) {
      const sh = inst.sheet;
      const local = new Map();
      inst.localNames = local;
      inst.groupLabels = sh.groups.map(() => []);
      for (const l of sh.labels) {
        if (l.kind === 'directive' || !l.text) continue;
        const name = netName(resolveVars(l.text, { inst, project: { textVars } }));
        l.netName = name;
        const bus = sh.groups[l.group].bus;
        const n = nidx(inst, l.group);
        const ns = (bus ? 'bus:' : '') + name;
        inst.groupLabels[l.group].push({ kind: l.kind, name });
        if (l.kind === 'global') joinName(globalNames, ns, n, inst);
        else joinName(local, ns, n, inst);
      }
      sh.symbols.forEach((s) => {
        const power = isPowerSym(s);
        for (const pin of symbolPins(s)) {
          if (pin.type !== 'power_in') continue;
          if (power) {
            const name = netName(valueOf(s) || pin.name);
            inst.groupLabels[pin.group].push({ kind: power === 'local' ? 'localpower' : 'power', name });
            joinName(power === 'local' ? local : globalNames, name, nidx(inst, pin.group), inst);
          } else if (pin.hide && pin.name && pin.name !== '~') {
            const name = netName(pin.name);
            inst.groupLabels[pin.group].push({ kind: 'hiddenpower', name });
            joinName(globalNames, name, nidx(inst, pin.group), inst);
          }
        }
      });
    }
    // A local label that shares its name with a global label or power net on the same sheet joins it.
    for (const inst of instances) {
      const present = new Set();
      inst.groupLabels.forEach((labels) => { for (const lb of labels) if (lb.kind === 'global' || lb.kind === 'power' || lb.kind === 'hiddenpower') present.add(lb.name); });
      for (const name of present) {
        const ln = inst.localNames.get(name);
        const gn = globalGet(inst, name);
        if (ln !== undefined && gn !== undefined) union(ln, gn);
      }
    }
    // 2. Hierarchy: sheet pins connect to same-named hierarchical labels in the child sheet.
    for (const C of instances) {
      if (!C.parent) continue;
      const P = C.parent;
      for (const sp of C.sheetSym.pins) {
        const name = netName(sp.name);
        sp.netName = name;
        P.groupLabels[sp.group].push({ kind: 'sheetpin', name, child: C.idx });
        const pn = nidx(P, sp.group);
        for (const hl of C.sheet.labels) if (hl.kind === 'hier' && hl.netName === name) union(pn, nidx(C, hl.group));
      }
    }
    // 3. Bus members. Each connected bus gets one virtual node per member; members are matched by
    //    vector index (D3 ~ DATA3) or by group member name (I2C.SDA ~ BUS.SDA).
    const busMember = new Map(); // busRoot|key -> virtual node
    const busNameLinks = [];
    const memberLinks = [];
    for (const inst of instances) {
      inst.sheet.groups.forEach((g) => {
        if (!g.bus) return;
        const n = nidx(inst, g.id);
        const busNames = inst.groupLabels[g.id].filter((lb) => isBusName(lb.name) || aliases[lb.name]);
        // Labels drive member names; a sheet pin only does when no label names the bus.
        const labelled = busNames.some((lb) => lb.kind !== 'sheetpin');
        for (const lb of busNames) {
          const names = !labelled || lb.kind !== 'sheetpin';
          for (const m of expandBusKeyed(lb.name, aliases)) memberLinks.push([n, m.key, m.name, inst, lb.kind === 'global', names, lb.kind]);
        }
      });
    }
    // Hierarchical labels and sheet pins that sit on plain wires but carry bus names are treated the same way.
    const rootsSnapshot = memberLinks.map(([n]) => find(n));
    memberLinks.forEach(([, k, name, inst, isGlobal, names, srcKind], i) => {
      const id = rootsSnapshot[i] + '|' + k;
      let v = busMember.get(id);
      if (v === undefined) busMember.set(id, v = virtualNode());
      // A bus member is a net name in the bus label's scope, so DQ[0..7] and DQ[0..31] share DQ0..DQ7.
      if (!names) return;
      busNameLinks.push({ v, kind: isGlobal ? 'global' : srcKind === 'sheetpin' ? 'sheetpin' : srcKind === 'hier' ? 'hier' : 'local', name, inst });
      if (isGlobal) joinName(globalNames, name, v, inst); else joinName(inst.localNames, name, v, inst);
      const gn = globalGet(inst, name); if (gn !== undefined) union(v, gn);
    });

    // 4. Collect nets
    const nets = [];
    const netOfRoot = new Map();
    for (const inst of instances) inst.netOf = new Int32Array(inst.sheet.groups.length).fill(-1);
    nodeList.forEach((nd, i) => {
      const r = find(i);
      let id = netOfRoot.get(r);
      if (id === undefined) {
        id = nets.length; netOfRoot.set(r, id);
        nets.push({ id, bus: false, pins: [], names: [], inst: new Map(), noConnect: false, name: '' });
      }
      const net = nets[id];
      nd.inst.netOf[nd.g.id] = id;
      if (nd.g.bus) net.bus = true;
      let l = net.inst.get(nd.inst.idx); if (!l) net.inst.set(nd.inst.idx, l = []);
      l.push(nd.g.id);
    });
    for (const bl of busNameLinks) {
      const id = netOfRoot.get(find(bl.v));
      if (id !== undefined) nets[id].names.push({ inst: bl.inst.idx, depth: bl.inst.depth, namePath: bl.inst.namePath, kind: bl.kind, name: bl.name, member: true });
    }
    for (const inst of instances) {
      const sh = inst.sheet;
      sh.symbols.forEach((s, si) => {
        const ref = inst.refs[si].ref;
        const fullRef = s.lib && s.lib.unitCount > 1 ? ref + unitLetter(inst.refs[si].unit) : ref;
        const power = isPowerSym(s);
        const pins = symbolPins(s);
        const nameCount = {};
        for (const pin of pins) nameCount[pin.name] = (nameCount[pin.name] || 0) + 1;
        for (const pin of pins) {
          const net = nets[inst.netOf[pin.group]];
          if (power || ref.startsWith('#')) { if (power) net.hasPower = true; continue; }
          net.pins.push({ inst: inst.idx, sym: si, ref, fullRef, number: pin.number, name: pin.name, type: pin.type, uniqueName: nameCount[pin.name] === 1 });
        }
      });
      sh.noConnects.forEach((nc) => { nets[inst.netOf[nc.group]].noConnect = true; });
      inst.groupLabels.forEach((labels, g) => {
        const net = nets[inst.netOf[g]];
        for (const lb of labels) net.names.push(Object.assign({ inst: inst.idx, depth: inst.depth, namePath: inst.namePath }, lb));
      });
    }
    const prio = { global: 7, power: 7, hiddenpower: 6, localpower: 5, local: 4, hier: 3, sheetpin: 2 };
    for (const net of nets) {
      let best = null, bestScore = -1;
      for (const n of net.names) {
        const score = (prio[n.kind] || 0) * 1e7 - n.depth * 1e5 - instances[n.inst].order;
        if (score > bestScore || (score === bestScore && naturalCmp(n.name, best.name) < 0)) { best = n; bestScore = score; }
      }
      net.pins.sort((a, b) => naturalCmp(a.ref, b.ref) || naturalCmp(a.number, b.number));
      if (best) {
        const scoped = best.kind === 'local' || best.kind === 'hier' || best.kind === 'localpower' || best.kind === 'sheetpin';
        net.name = scoped ? best.namePath + best.name : best.name;
        net.shortName = best.name;
        net.named = true;
      } else if (net.pins.length) {
        const p = net.pins.find((x) => x.type !== 'passive' && x.type !== 'power_in') || net.pins[0];
        const pinName = p.name && p.name !== '~' && p.name !== p.number && p.uniqueName ? plainText(unescape(p.name)) : 'Pad' + p.number;
        net.name = (net.pins.length === 1 && !net.bus ? 'unconnected-(' : 'Net-(') + p.fullRef + '-' + pinName + ')';
        net.shortName = net.name;
      } else {
        net.name = net.bus ? 'Unnamed bus' : 'Unnamed net';
        net.shortName = net.name;
      }
      net.sheetCount = net.inst.size;
    }
    const nodeNet = (n) => { if (n === undefined) return null; const nd = nodeList[n]; return nd ? nets[nd.inst.netOf[nd.g.id]] : null; };
    for (const net of nets) {
      if (!net.bus) continue;
      const seen = new Map();
      for (const n of net.names) {
        if (!isBusName(n.name) && !aliases[n.name]) continue;
        for (const m of expandBusKeyed(n.name, aliases)) {
          if (seen.has(m.name)) continue;
          const inst = instances[n.inst];
          const target = nodeNet(inst.localNames.get(m.name)) || nodeNet(globalGet(inst, m.name));
          seen.set(m.name, target ? target.id : -1);
        }
      }
      net.members = Array.from(seen, ([name, id]) => ({ name, net: id }));
    }
    return {
      name: projectName, rootPath, files: paths, sheetsByPath, instances, instSorted, root: rootInst, nets, errors, textVars, pageCount, aliases
    };
  }

  function unescape(s) {
    if (!s || s.indexOf('{') < 0) return s;
    const map = { dblquote: '"', quote: "'", lt: '<', gt: '>', backslash: '\\', slash: '/', bar: '|', comma: ',', colon: ':', space: ' ', dollar: '$', tab: '\t', return: '\n', brace: '{' };
    return s.replace(/(^|[^$~^_])\{([a-z]+)\}/g, (m, pre, t) => (map[t] !== undefined ? pre + map[t] : m));
  }
  function unitLetter(u) {
    let s = '';
    u = Math.max(1, u | 0);
    while (u > 0) { u--; s = String.fromCharCode(65 + (u % 26)) + s; u = Math.floor(u / 26); }
    return s;
  }
  function netName(s) { return unescape(s || '').trim(); }

  function expandBusKeyed(name, aliases, depth) {
    depth = depth || 0;
    const out = [];
    if (depth > 4) return out;
    const grp = parseBusGroup(name);
    if (grp) {
      const pfx = grp.prefix;
      for (const item of splitGroupBody(grp.body)) {
        const subs = aliases && aliases[item] ? [].concat(...aliases[item].map((mem) => expandBusKeyed(mem, aliases, depth + 1))) : expandBusKeyed(item, aliases, depth + 1);
        for (const m of subs) out.push({ name: pfx ? pfx + '.' + m.name : m.name, key: 'g:' + m.name });
      }
      return out;
    }
    const vec = /^(.*?)\[(\d+)\.\.(\d+)\]$/.exec(name);
    if (vec) {
      const a = +vec[2], b = +vec[3];
      const step = a <= b ? 1 : -1;
      // KiCad matches vector members by position, so D[0..7] and DATA[8..15] line up member by member.
      let pos = 0;
      for (let k = a; step > 0 ? k <= b : k >= b; k += step) out.push({ name: vec[1] + k, key: 'v:' + (pos++) });
      return out;
    }
    if (aliases && aliases[name]) {
      for (const mem of aliases[name]) for (const m of expandBusKeyed(mem, aliases, depth + 1)) out.push({ name: m.name, key: 'g:' + m.name });
      return out;
    }
    out.push({ name, key: 'g:' + name });
    return out;
  }

  // ---------------------------------------------------------------------------
  // Text variables
  // ---------------------------------------------------------------------------
  function resolveVars(s, ctx) {
    if (!s || s.indexOf('${') < 0) return s;
    return s.replace(/\$\{([^}]+)\}/g, (m, name) => {
      const v = lookupVar(name, ctx);
      return v === undefined || v === null ? m : String(v);
    });
  }
  function lookupVar(name, ctx) {
    const inst = ctx.inst, proj = ctx.project || {};
    const sym = ctx.sym, ref = ctx.ref;
    if (sym) {
      const up = name.toUpperCase();
      if (up === 'REFERENCE') return ref;
      if (up === 'UNIT') return ctx.unitLabel || '';
      const f = sym.props.find((p) => p.name.toUpperCase() === up);
      if (f && f.value.indexOf('${' + name + '}') < 0) return f.value;
    }
    if (inst) {
      const tb = inst.sheet.titleBlock;
      switch (name) {
        case 'SHEETNAME': return inst.parent ? inst.name : '';
        case 'SHEETPATH': return inst.namePath;
        case '#': return inst.page;
        case '##': return ctx.pageCount || '';
        case 'TITLE': return tb.title;
        case 'ISSUE_DATE': return tb.date;
        case 'REVISION': return tb.rev;
        case 'COMPANY': return tb.company;
        case 'FILENAME': return basename(inst.sheet.path);
        case 'FILEPATH': return inst.sheet.path;
        case 'PROJECTNAME': return ctx.projectName;
        case 'CURRENT_DATE': return new Date().toISOString().slice(0, 10);
        case 'INTERSHEET_REFS': return ctx.intersheet || '';
      }
      const cm = /^COMMENT(\d)$/.exec(name);
      if (cm) return tb.comments[cm[1]] || '';
      if (inst.sheetSym) {
        const f = inst.sheetSym.props.find((p) => p.name === name);
        if (f) return f.value;
      }
    }
    if (proj.textVars && proj.textVars[name] !== undefined) return proj.textVars[name];
    return undefined;
  }

  const api = {
    find, findAll, onSegment, key, tokSpan,
    parseSexpr, parseSchematic, buildProject, symbolPins, libItemsFor, symTransform, tf, tfInv,
    markupRuns, plainText, resolveVars, unescape, unitLetter, expandBusKeyed, expandBus, isBusName, naturalCmp, basename, dirname, joinPath, PAPER
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KiCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
