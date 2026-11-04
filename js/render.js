/* Canvas renderer and touch view for KiCad schematics. Builds a flat scene of
 * primitives per sheet instance (in millimetres), then draws it with culling,
 * net highlighting and screen-space text. */
(function (root) {
  'use strict';
  const K = root.KiCore;

  const FONT = '"Plex Condensed", "Roboto Condensed", "Arial Narrow", sans-serif';
  const EM = 1.4;            // font px per mm of KiCad text height (cap height ≈ text size)
  const LINE = 0.1524;       // KiCad default line width (6 mil)
  const BUS = 0.3048;
  const PITCH = 1.62;        // line spacing in text heights

  const PALETTES = {
    light: {
      bg: '#f7f6f1', paper: '#fffffc', frame: '#9a6b5f', frameText: '#7a5248',
      wire: '#008f2a', bus: '#1f3fa8', junction: '#008f2a', body: '#8c1d1d', bodyfill: '#fffbd2',
      pin: '#8c1d1d', pinnum: '#a33a2a', pinname: '#006a6a', ref: '#006a6a', value: '#006a6a', field: '#7d2f8a',
      llabel: '#1c1c1c', glabel: '#8c1d1d', hlabel: '#7a5a00', sheet: '#7d2f8a', sheetname: '#006a6a', sheetfile: '#7a5a00',
      sheetpin: '#7a5a00', note: '#1f2fb8', nc: '#1f3fa8', directive: '#7d2f8a', rule: '#7d2f8a',
      hl: '#ff5a1f', hlHalo: 'rgba(255,90,31,0.22)', sel: '#ff5a1f', selFill: 'rgba(255,90,31,0.10)', flash: 'rgba(255,90,31,0.35)'
    },
    dark: {
      bg: '#14181d', paper: '#1a1f25', frame: '#7c5d57', frameText: '#9b7c75',
      wire: '#4cc46e', bus: '#7b96ff', junction: '#4cc46e', body: '#d97a73', bodyfill: '#2a2820',
      pin: '#d97a73', pinnum: '#e3988b', pinname: '#5cc8c8', ref: '#5cc8c8', value: '#5cc8c8', field: '#c48ad3',
      llabel: '#e6e8ea', glabel: '#e88a80', hlabel: '#d9b45c', sheet: '#c48ad3', sheetname: '#5cc8c8', sheetfile: '#d9b45c',
      sheetpin: '#d9b45c', note: '#8aa6ff', nc: '#7b96ff', directive: '#c48ad3', rule: '#c48ad3',
      hl: '#ff8a3d', hlHalo: 'rgba(255,138,61,0.25)', sel: '#ff8a3d', selFill: 'rgba(255,138,61,0.12)', flash: 'rgba(255,138,61,0.4)'
    }
  };

  // ---------------------------------------------------------------- text measuring
  const measureCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const mctx = measureCanvas ? measureCanvas.getContext('2d') : null;
  const widthCache = new Map();
  function w100(s, bold) {
    const k = (bold ? 'b' : 'n') + s;
    let w = widthCache.get(k);
    if (w === undefined) {
      if (mctx) { mctx.font = (bold ? '600 ' : '400 ') + '100px ' + FONT; w = mctx.measureText(s).width; }
      else w = s.length * 55;
      widthCache.set(k, w);
    }
    return w;
  }
  function textWidthMM(str, size, bold) {
    let w = 0;
    for (const r of K.markupRuns(str)) w += w100(r.t, bold) * (r.sub || r.sup ? 0.7 : 1);
    return w / 100 * size * EM;
  }
  function clearMeasureCache() { widthCache.clear(); }

  // KiCad's RotatePoint for multiples of 90° (y-down coordinates)
  function rot(p, deg) {
    const d = ((deg % 360) + 360) % 360;
    if (d === 90) return [p[1], -p[0]];
    if (d === 180) return [-p[0], -p[1]];
    if (d === 270) return [-p[1], p[0]];
    return [p[0], p[1]];
  }

  // ---------------------------------------------------------------- scene building
  function buildScene(project, inst) {
    const sh = inst.sheet;
    const S = { strokes: [], circles: [], texts: [], fills: [], images: [], syms: [], sheets: [], hitLabels: [], bbox: null, inst };
    const minmax = (pts) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
      return [x0, y0, x1, y1];
    };
    const flat = (pts) => { const a = new Float64Array(pts.length * 2); pts.forEach((p, i) => { a[2 * i] = p[0]; a[2 * i + 1] = p[1]; }); return a; };
    const colorCss = (c) => c ? `rgba(${c[0]},${c[1]},${c[2]},${c[3] === undefined ? 1 : c[3]})` : null;
    const stroke = (pts, w, role, o) => {
      if (pts.length < 2) return;
      o = o || {};
      S.strokes.push({ p: flat(pts), w: w > 0 ? w : (role === 'bus' ? BUS : LINE), role, g: o.g === undefined ? -1 : o.g, sym: o.sym === undefined ? -1 : o.sym, sheet: o.sheet === undefined ? -1 : o.sheet, dash: o.dash || null, color: o.color || null, bb: minmax(pts), closed: !!o.closed, kind: o.kind || '' });
    };
    const fillPoly = (pts, role, o) => {
      o = o || {};
      S.fills.push({ p: flat(pts), role, color: o.color || null, sym: o.sym === undefined ? -1 : o.sym, g: o.g === undefined ? -1 : o.g, bb: minmax(pts) });
    };
    const circle = (c, r, w, role, o) => {
      o = o || {};
      S.circles.push({ c, r, w: w > 0 ? w : LINE, role, fill: o.fill || null, fillColor: o.fillColor || null, g: o.g === undefined ? -1 : o.g, sym: o.sym === undefined ? -1 : o.sym, bb: [c[0] - r, c[1] - r, c[0] + r, c[1] + r], kind: o.kind || '' });
    };
    // Adds a (possibly multi-line) text block. Anchor is in world mm.
    const text = (x, y, str, size, vert, ha, va, role, o) => {
      if (str === undefined || str === null || str === '') return;
      o = o || {};
      const lines = String(str).split('\n');
      const H = size + (lines.length - 1) * size * PITCH;
      const start = va === 'top' ? 0 : va === 'center' ? -H / 2 : -H;
      lines.forEach((line, i) => {
        const ty = start + i * size * PITCH + size;
        const ax = vert ? x + ty : x, ay = vert ? y : y + ty;
        const w = textWidthMM(line, size, o.bold);
        // bounding box for culling / hit testing
        let x0, x1;
        if (ha === 'left') { x0 = 0; x1 = w; } else if (ha === 'right') { x0 = -w; x1 = 0; } else { x0 = -w / 2; x1 = w / 2; }
        const bb = vert ? [ax - size * 1.1, ay - x1, ax + size * 0.25, ay - x0] : [ax + x0, ay - size * 1.1, ax + x1, ay + size * 0.25];
        S.texts.push({ x: ax, y: ay, s: line, runs: K.markupRuns(line), size, vert: !!vert, ha, role, color: o.color || null, bold: !!o.bold, italic: !!o.italic, g: o.g === undefined ? -1 : o.g, sym: o.sym === undefined ? -1 : o.sym, sheet: o.sheet === undefined ? -1 : o.sheet, bb, w });
      });
    };
    const ctxVars = { inst, project: project, pageCount: project.pageCount, projectName: project.name };
    const resolve = (s, extra) => K.unescape(K.resolveVars(s, extra ? Object.assign({}, ctxVars, extra) : ctxVars));

    // ---- page frame and title block
    const [PW, PH] = sh.paper;
    S.page = [0, 0, PW, PH];
    const frame = (x0, y0, x1, y1, w) => stroke([[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]], w || LINE, 'frame');
    const m = 10, m2 = 12;
    frame(m, m, PW - m, PH - m);
    frame(m2, m2, PW - m2, PH - m2);
    const zone = 50;
    const nx = Math.max(1, Math.round((PW - 2 * m) / zone)), ny = Math.max(1, Math.round((PH - 2 * m) / zone));
    for (let i = 0; i < nx; i++) {
      const xa = m + (PW - 2 * m) * i / nx, xb = m + (PW - 2 * m) * (i + 1) / nx;
      if (i > 0) { stroke([[xa, m], [xa, m2]], LINE, 'frame'); stroke([[xa, PH - m], [xa, PH - m2]], LINE, 'frame'); }
      text((xa + xb) / 2, m + 1, String(i + 1), 1.3, false, 'center', 'center', 'frameText');
      text((xa + xb) / 2, PH - m - 1, String(i + 1), 1.3, false, 'center', 'center', 'frameText');
    }
    for (let j = 0; j < ny; j++) {
      const ya = m + (PH - 2 * m) * j / ny, yb = m + (PH - 2 * m) * (j + 1) / ny;
      if (j > 0) { stroke([[m, ya], [m2, ya]], LINE, 'frame'); stroke([[PW - m, ya], [PW - m2, ya]], LINE, 'frame'); }
      const L = String.fromCharCode(65 + (j % 26));
      text(m + 1, (ya + yb) / 2, L, 1.3, false, 'center', 'center', 'frameText');
      text(PW - m - 1, (ya + yb) / 2, L, 1.3, false, 'center', 'center', 'frameText');
    }
    {
      const tb = sh.titleBlock;
      const bx1 = PW - m2, by1 = PH - m2, bx0 = bx1 - 110, by0 = by1 - 32;
      frame(bx0, by0, bx1, by1);
      const rows = [by1 - 4, by1 - 8, by1 - 14, by1 - 20, by1 - 24, by1 - 28];
      for (const y of [by1 - 5, by1 - 10, by1 - 18, by1 - 23, by1 - 27]) stroke([[bx0, y], [bx1, y]], LINE, 'frame');
      stroke([[bx0 + 60, by1 - 10], [bx0 + 60, by1 - 5]], LINE, 'frame');
      stroke([[bx0 + 90, by1 - 10], [bx0 + 90, by1 - 5]], LINE, 'frame');
      const t = (x, y, s, sz, bold) => text(x, y, s, sz || 1.27, false, 'left', 'center', 'frameText', { bold });
      t(bx0 + 1.5, by1 - 2.5, 'Id: ' + inst.page + '/' + project.pageCount);
      t(bx0 + 1.5, by1 - 7.5, 'Size: ' + (Object.keys(K.PAPER).find((k) => K.PAPER[k][0] === Math.max(PW, PH) && K.PAPER[k][1] === Math.min(PW, PH)) || 'User'));
      t(bx0 + 61.5, by1 - 7.5, 'Date: ' + resolve(tb.date || ''));
      t(bx0 + 91.5, by1 - 7.5, 'Rev: ' + resolve(tb.rev || ''));
      t(bx0 + 1.5, by1 - 14, 'Title: ' + resolve(tb.title || ''), 2, true);
      t(bx0 + 1.5, by1 - 20.5, 'File: ' + K.basename(sh.path));
      t(bx0 + 1.5, by1 - 25, 'Sheet: ' + inst.namePath);
      t(bx0 + 1.5, by1 - 29.5, resolve(tb.company || ''), 1.5, true);
      void rows;
    }

    // ---- images (embedded PNG/JPEG); decoded lazily by the view
    for (const im of sh.images) S.images.push({ p: im.p, scale: im.scale, data: im.data, img: null, w: 0, h: 0 });

    // ---- free graphics
    const graphicStroke = (it, o) => {
      const dash = it.st && it.st.type && it.st.type !== 'default' && it.st.type !== 'solid' ? it.st.type : null;
      if (it.t === 'poly') {
        if (it.fl && it.fl.type === 'color' && it.fl.color) fillPoly(it.pts, 'custom', { color: colorCss(it.fl.color) });
        stroke(it.pts, it.st.w, it.role || 'note', Object.assign({ dash, color: colorCss(it.st.color) }, o));
      } else if (it.t === 'circle') {
        circle(it.c, it.r, it.st.w, 'note', Object.assign({ fillColor: it.fl && it.fl.type === 'color' ? colorCss(it.fl.color) : null }, o));
      }
    };
    for (const g of sh.graphics) graphicStroke(g);

    // ---- text and text boxes
    for (const t of sh.texts) {
      const a = ((Math.round(t.a) % 180) + 180) % 180;
      text(t.p[0], t.p[1], resolve(t.s), t.fx.h, a === 90, t.fx.ha, t.fx.va === 'center' ? 'center' : t.fx.va, 'note', { color: colorCss(t.fx.color), bold: t.fx.bold, italic: t.fx.italic });
    }
    for (const tb of sh.textBoxes) {
      const [x, y] = tb.p, [w, h] = tb.size;
      const pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
      if (tb.fl && tb.fl.type === 'color' && tb.fl.color) fillPoly(pts, 'custom', { color: colorCss(tb.fl.color) });
      if (tb.st.w >= 0 && tb.st.type !== 'none') stroke(pts, tb.st.w, 'note', { color: colorCss(tb.st.color) });
      const mg = tb.margins || [tb.fx.h * 0.75, tb.fx.h * 0.75, tb.fx.h * 0.75, tb.fx.h * 0.75];
      const ha = tb.fx.ha, va = tb.fx.va === 'center' && !tb.fx._explicitV ? 'top' : tb.fx.va;
      const tx = ha === 'left' ? x + mg[0] : ha === 'right' ? x + w - mg[2] : x + w / 2;
      const ty = va === 'top' ? y + mg[1] : va === 'bottom' ? y + h - mg[3] : y + h / 2;
      text(tx, ty, resolve(tb.s), tb.fx.h, false, ha, va, 'note', { color: colorCss(tb.fx.color), bold: tb.fx.bold });
    }

    // ---- wires, buses, entries, junctions, no-connects
    for (const w of sh.wires) stroke([w.a, w.b], w.st.w, 'wire', { g: w.group, color: colorCss(w.st.color), dash: w.st.type !== 'default' && w.st.type !== 'solid' ? w.st.type : null, kind: 'wire' });
    for (const b of sh.buses) stroke([b.a, b.b], b.st.w, 'bus', { g: b.group, color: colorCss(b.st.color), kind: 'bus' });
    for (const e of sh.entries) stroke([e.a, e.b], e.st.w, 'wire', { g: e.group, kind: 'wire' });
    for (const j of sh.junctions) { const r = (j.d > 0 ? j.d : 0.9144) / 2; circle(j.p, r, 0, j.bus ? 'bus' : 'junction', { fill: j.bus ? 'bus' : 'junction', g: j.group, kind: 'junction' }); }
    for (const nc of sh.noConnects) {
      const s = 0.6096, [x, y] = nc.p;
      stroke([[x - s, y - s], [x + s, y + s]], LINE, 'nc', { g: nc.group, kind: 'nc' });
      stroke([[x - s, y + s], [x + s, y - s]], LINE, 'nc', { g: nc.group, kind: 'nc' });
    }

    // ---- symbols
    sh.symbols.forEach((sym, si) => {
      const lib = sym.lib;
      const ref = inst.refs[si].ref;
      const unitLabel = lib && lib.unitCount > 1 ? K.unitLetter(inst.refs[si].unit || sym.unit) : '';
      const P = (p) => { const q = K.tf(sym.m, p); return [sym.p[0] + q[0], sym.p[1] + q[1]]; };
      const flipText = sym.m[1] !== 0; // eeschema: transform.y1 != 0 toggles text orientation
      const items = K.libItemsFor(lib, sym.unit, sym.style);
      const body = [];
      for (const it of items) {
        if (it.t === 'poly') {
          const pts = it.pts.map(P);
          body.push(...pts);
          if (it.fl.type === 'background') fillPoly(pts, 'bodyfill', { sym: si });
          else if (it.fl.type === 'outline') fillPoly(pts, 'body', { sym: si });
          else if (it.fl.type === 'color' && it.fl.color) fillPoly(pts, 'custom', { sym: si, color: colorCss(it.fl.color) });
          stroke(pts, it.st.w, 'body', { sym: si, color: colorCss(it.st.color), dash: it.st.type !== 'default' && it.st.type !== 'solid' ? it.st.type : null });
        } else if (it.t === 'circle') {
          const c = P(it.c);
          body.push([c[0] - it.r, c[1] - it.r], [c[0] + it.r, c[1] + it.r]);
          circle(c, it.r, it.st.w, 'body', { sym: si, fill: it.fl.type === 'background' ? 'bodyfill' : it.fl.type === 'outline' ? 'body' : null, fillColor: it.fl.type === 'color' ? colorCss(it.fl.color) : null });
        } else if (it.t === 'text') {
          if (it.fx.hide) continue;
          placeText(it.p, it.a, it.fx, resolve(it.s, { sym, ref }), 'body', si, true);
        } else if (it.t === 'textbox') {
          const a = P(it.a), b = P(it.b);
          const pts = [a, [b[0], a[1]], b, [a[0], b[1]], a];
          body.push(a, b);
          if (it.fl.type === 'background') fillPoly(pts, 'bodyfill', { sym: si });
          stroke(pts, it.st.w, 'body', { sym: si });
          text(Math.min(a[0], b[0]) + 0.5, Math.min(a[1], b[1]) + 0.5, resolve(it.s, { sym, ref }), it.fx.h, false, 'left', 'top', 'body', { sym: si });
        }
      }
      // pins
      const pins = K.symbolPins(sym);
      for (const pin of pins) {
        body.push(pin.pos, pin.root);
        if (pin.hide) continue;
        drawPin(pin, sym, si, lib);
      }
      // fields
      for (const f of sym.props) {
        if (f.fx.hide || !f.value) continue;
        let val = f.name === 'Reference' ? ref + unitLabel : resolve(f.value, { sym, ref, unitLabel });
        if (f.showName) val = f.name + ': ' + val;
        if (!val) continue;
        const role = f.name === 'Reference' ? 'ref' : f.name === 'Value' ? 'value' : 'field';
        // Field (at) is stored in sheet coordinates; recover the untransformed text position.
        const rel = K.tfInv(sym.m, [f.p[0] - sym.p[0], f.p[1] - sym.p[1]]);
        placeText(rel, f.a, f.fx, val, role, si, false, f.name);
      }
      const bb = body.length ? minmax(body) : [sym.p[0] - 1, sym.p[1] - 1, sym.p[0] + 1, sym.p[1] + 1];
      S.syms.push({ si, bb, sym, ref, power: !!(lib && lib.power) });

      function placeText(localP, angle, fx, str, role, symIdx, isLibText, fieldName) {
        // Mirrors SCH_FIELD::GetBoundingBox: build the text box in symbol space, transform, use its centre.
        const size = fx.h;
        const a = ((Math.round(angle > 360 ? angle / 10 : angle) % 180) + 180) % 180;
        const lines = String(str).split('\n');
        const w = Math.max(...lines.map((l) => textWidthMM(l, size, fx.bold)));
        const h = size + (lines.length - 1) * size * PITCH;
        const dx = fx.ha === 'left' ? w / 2 : fx.ha === 'right' ? -w / 2 : 0;
        const dy = fx.va === 'top' ? h / 2 : fx.va === 'bottom' ? -h / 2 : 0;
        const off = rot([dx, dy], a); // RotatePoint around the text position
        const cLocal = [localP[0] + off[0], localP[1] + off[1]];
        const c = P(cLocal);
        let vert = a === 90;
        if (flipText) vert = !vert;
        text(c[0], c[1], str, size, vert, 'center', 'center', role, { sym: symIdx, color: colorCss(fx.color), bold: fx.bold, italic: fx.italic });
        void isLibText; void fieldName;
      }
    });

    function drawPin(pin, sym, si, lib) {
      const lp = pin.lib;
      const p0 = pin.root, pos = pin.pos, d = pin.dir; // d points from connection point toward the body
      const out = [-d[0], -d[1]]; // from root outwards
      const g = pin.group;
      const r = 0.635 * 0.6; // inversion bubble radius
      const clock = 0.635 * 0.6;
      const tri = (a, b, c) => stroke([a, b, c], LINE, 'pin', { sym: si, g });
      const shape = lp.shape || 'line';
      if (lp.type === 'no_connect') {
        stroke([p0, pos], LINE, 'pin', { sym: si, g, kind: 'pin' });
      } else if (shape === 'inverted' || shape === 'inverted_clock') {
        circle([p0[0] + out[0] * r, p0[1] + out[1] * r], r, LINE, 'pin', { sym: si, g });
        stroke([[p0[0] + out[0] * 2 * r, p0[1] + out[1] * 2 * r], pos], LINE, 'pin', { sym: si, g, kind: 'pin' });
      } else {
        stroke([p0, pos], LINE, 'pin', { sym: si, g, kind: 'pin' });
      }
      if (shape === 'clock' || shape === 'inverted_clock' || shape === 'clock_low' || shape === 'edge_clock_high') {
        const n = [out[1], -out[0]];
        tri([p0[0] + n[0] * clock, p0[1] + n[1] * clock], [p0[0] - out[0] * clock, p0[1] - out[1] * clock], [p0[0] - n[0] * clock, p0[1] - n[1] * clock]);
      }
      if (shape === 'input_low' || shape === 'clock_low') {
        const n = out[1] === 0 ? [0, -1] : [-1, 0];
        tri([p0[0] + out[0] * 2 * r, p0[1] + out[1] * 2 * r], [p0[0] + out[0] * 2 * r + n[0] * 2 * r, p0[1] + out[1] * 2 * r + n[1] * 2 * r], p0);
      }
      if (shape === 'output_low') {
        const n = out[1] === 0 ? [0, -1] : [-1, 0];
        stroke([[p0[0] + n[0] * 2 * r, p0[1] + n[1] * 2 * r], [p0[0] + out[0] * 2 * r, p0[1] + out[1] * 2 * r]], LINE, 'pin', { sym: si, g });
      }
      // pin texts
      const horiz = Math.abs(d[1]) < 0.5;
      const vert = !horiz;
      const showName = !lib.pinNamesHide && lp.name && lp.name !== '~';
      const showNum = !lib.pinNumbersHide && lp.number !== '';
      const offset = lib.pinNameOffset;
      const margin = 0.2;
      const mid = [(p0[0] + pos[0]) / 2, (p0[1] + pos[1]) / 2];
      // "above" the pin line: -y for horizontal pins, -x for vertical pins (rotated text)
      const up = horiz ? [0, -1] : [-1, 0];
      const inward = d; // from pin end toward the body
      // Horizontal-ness of "inward" in the text frame: for vertical text, text +x is world -y.
      const alongText = horiz ? inward[0] : -inward[1];
      if (offset > 0) {
        if (showName) {
          const at = [p0[0] + inward[0] * offset, p0[1] + inward[1] * offset];
          text(at[0], at[1], lp.name, lp.nameFx.h, vert, alongText > 0 ? 'left' : 'right', 'center', 'pinname', { sym: si });
        }
        if (showNum) text(mid[0] + up[0] * margin, mid[1] + up[1] * margin, lp.number, lp.numFx.h, vert, 'center', 'bottom', 'pinnum', { sym: si });
      } else {
        if (showName) text(mid[0] + up[0] * margin, mid[1] + up[1] * margin, lp.name, lp.nameFx.h, vert, 'center', 'bottom', 'pinname', { sym: si });
        if (showNum) text(mid[0] - up[0] * margin, mid[1] - up[1] * margin, lp.number, lp.numFx.h, vert, 'center', 'top', 'pinnum', { sym: si });
      }
    }

    // ---- labels
    const intersheet = intersheetRefs(project);
    for (const l of sh.labels) {
      const size = l.fx.h;
      const [x, y] = l.p;
      const g = l.group;
      const name = resolve(l.text);
      const vert = l.spin === 'up' || l.spin === 'bottom';
      const spinRot = { left: 0, up: -90, right: 180, bottom: 90 }[l.spin];
      if (l.kind === 'local') {
        const dist = 0.15 * size + LINE;
        const ax = vert ? x - dist : x, ay = vert ? y : y - dist;
        const ha = l.spin === 'right' || l.spin === 'up' ? 'left' : 'right';
        text(ax, ay, name, size, vert, ha, 'bottom', 'llabel', { g, bold: l.fx.bold, italic: l.fx.italic, color: colorCss(l.fx.color) });
        const t = S.texts[S.texts.length - 1];
        S.hitLabels.push({ bb: t ? t.bb : [x - 1, y - 1, x + 1, y + 1], g, label: l });
      } else if (l.kind === 'global') {
        const margin = 0.375 * size;
        const half = size / 2 + margin;
        const tw = textWidthMM(name, size, l.fx.bold);
        const X = tw + 2 * margin + LINE, Y = half + LINE;
        let pts = [[0, 0], [0, -Y], [-X, -Y], [-X, 0], [-X, Y], [0, Y]];
        let xo = 0;
        if (l.shape === 'input') { xo = -half; pts[0][0] += half; }
        else if (l.shape === 'output') pts[3][0] -= half;
        else if (l.shape === 'bidirectional' || l.shape === 'tri_state') { xo = -half; pts[0][0] += half; pts[3][0] -= half; }
        pts = pts.map((p) => { const q = rot([p[0] + xo, p[1]], spinRot); return [q[0] + x, q[1] + y]; });
        pts.push(pts[0]);
        stroke(pts, LINE, 'glabel', { g, kind: 'label', closed: true, color: colorCss(l.fx.color) });
        let horizOff = margin;
        if (l.shape === 'input' || l.shape === 'bidirectional' || l.shape === 'tri_state') horizOff += size * 0.75;
        const vo = size * 0.0715;
        const off = { left: [-horizOff, vo], up: [vo, -horizOff], right: [horizOff, vo], bottom: [vo, horizOff] }[l.spin];
        const ha = l.spin === 'right' || l.spin === 'up' ? 'left' : 'right';
        text(x + off[0], y + off[1], name, size, vert, ha, 'center', 'glabel', { g, bold: l.fx.bold, italic: l.fx.italic, color: colorCss(l.fx.color) });
        const bb = [Infinity, Infinity, -Infinity, -Infinity];
        for (const p of pts) { bb[0] = Math.min(bb[0], p[0]); bb[1] = Math.min(bb[1], p[1]); bb[2] = Math.max(bb[2], p[0]); bb[3] = Math.max(bb[3], p[1]); }
        S.hitLabels.push({ bb, g, label: l });
        const isr = l.props.find((p) => p.name === 'Intersheetrefs' || p.name === 'Intersheet References');
        if (isr && !isr.fx.hide) {
          const pages = intersheet.get(l.netName || name);
          if (pages && pages.length) {
            const a = ((Math.round(isr.a) % 180) + 180) % 180;
            text(isr.p[0], isr.p[1], '[' + pages.join(',') + ']', isr.fx.h, a === 90, isr.fx.ha, isr.fx.va, 'glabel', { g, italic: isr.fx.italic });
          }
        }
      } else if (l.kind === 'hier') {
        hierShape(x, y, l.shape, l.spin, size, g, 'hlabel', false);
        const dist = 0.15 * size + l.fx.w;
        const off = { left: [-dist, 0], right: [dist, 0], up: [0, -dist], bottom: [0, dist] }[l.spin];
        const ha = l.spin === 'right' || l.spin === 'up' ? 'left' : 'right';
        text(x + off[0], y + off[1], name, size, vert, ha, 'center', 'hlabel', { g, bold: l.fx.bold, italic: l.fx.italic, color: colorCss(l.fx.color) });
        const t = S.texts[S.texts.length - 1];
        const bb = t ? [Math.min(t.bb[0], x - size), Math.min(t.bb[1], y - size), Math.max(t.bb[2], x + size), Math.max(t.bb[3], y + size)] : [x - 1, y - 1, x + 1, y + 1];
        S.hitLabels.push({ bb, g, label: l });
      } else if (l.kind === 'directive') {
        const s = 0.508, L = l.length;
        const R = (p) => { const q = rot(p, spinRot); return [q[0] + x, q[1] + y]; };
        if (l.shape === 'diamond') stroke([[0, 0], [0, L - s], [-2 * s, L], [0, L + s], [2 * s, L], [0, L - s]].map(R), LINE, 'directive', { g });
        else if (l.shape === 'rectangle') { const q = s * 0.8; stroke([[0, 0], [0, L - q], [-2 * q, L - q], [-2 * q, L + q], [2 * q, L + q], [2 * q, L - q], [0, L - q]].map(R), LINE, 'directive', { g }); }
        else {
          const rr = l.shape === 'dot' ? s * 0.7 : s;
          stroke([[0, 0], [0, L - rr]].map(R), LINE, 'directive', { g });
          circle(R([0, L]), rr, LINE, 'directive', { g, fill: l.shape === 'dot' ? 'directive' : null });
        }
        for (const f of l.props) {
          if (f.fx.hide || !f.value) continue;
          const a = ((Math.round(f.a) % 180) + 180) % 180;
          text(f.p[0], f.p[1], resolve(f.value), f.fx.h, a === 90, f.fx.ha, f.fx.va, 'directive', { g, italic: f.fx.italic });
        }
        S.hitLabels.push({ bb: [x - 1.5, y - 1.5 - L, x + 1.5, y + 1.5 + L], g, label: l });
      }
    }

    function hierShape(x, y, shape, spin, size, g, role, sheetPin) {
      const T = {
        input: { left: [0, 0, -1, -1, -2, -1, -2, 1, -1, 1, 0, 0], up: [0, 0, 1, -1, 1, -2, -1, -2, -1, -1, 0, 0], right: [0, 0, 1, 1, 2, 1, 2, -1, 1, -1, 0, 0], bottom: [0, 0, 1, 1, 1, 2, -1, 2, -1, 1, 0, 0] },
        output: { left: [-2, 0, -1, 1, 0, 1, 0, -1, -1, -1, -2, 0], up: [0, -2, 1, -1, 1, 0, -1, 0, -1, -1, 0, -2], right: [2, 0, 1, -1, 0, -1, 0, 1, 1, 1, 2, 0], bottom: [0, 2, 1, 1, 1, 0, -1, 0, -1, 1, 0, 2] },
        bidirectional: { left: [0, 0, -1, -1, -2, 0, -1, 1, 0, 0], up: [0, 0, -1, -1, 0, -2, 1, -1, 0, 0], right: [0, 0, 1, -1, 2, 0, 1, 1, 0, 0], bottom: [0, 0, -1, 1, 0, 2, 1, 1, 0, 0] },
        passive: { left: [0, -1, -2, -1, -2, 1, 0, 1, 0, -1], up: [1, 0, 1, -2, -1, -2, -1, 0, 1, 0], right: [0, -1, 2, -1, 2, 1, 0, 1, 0, -1], bottom: [1, 0, 1, 2, -1, 2, -1, 0, 1, 0] }
      };
      let sh2 = shape === 'tri_state' ? 'bidirectional' : shape;
      if (sheetPin) sh2 = sh2 === 'input' ? 'output' : sh2 === 'output' ? 'input' : sh2;
      const t = (T[sh2] || T.passive)[spin] || T.passive.left;
      const hs = size / 2;
      const pts = [];
      for (let i = 0; i < t.length; i += 2) pts.push([x + t[i] * hs, y + t[i + 1] * hs]);
      stroke(pts, LINE, role, { g, kind: 'label', closed: true });
    }

    // ---- sheet symbols
    sh.sheets.forEach((s, idx) => {
      const [x, y] = s.p, [w, h] = s.size;
      const pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
      if (s.fl && s.fl.color && s.fl.color[3] > 0) fillPoly(pts, 'custom', { color: colorCss(s.fl.color) });
      stroke(pts, s.st.w > 0 ? s.st.w : LINE * 1.5, 'sheet', { sheet: idx, color: colorCss(s.st.color) });
      for (const f of s.props) {
        if (f.fx.hide || !f.value) continue;
        const isName = f.name === 'Sheetname' || f.name === 'Sheet name';
        const isFile = f.name === 'Sheetfile' || f.name === 'Sheet file';
        const val = isFile ? 'File: ' + f.value : isName ? f.value : resolve(f.value);
        const a = ((Math.round(f.a) % 180) + 180) % 180;
        text(f.p[0], f.p[1], val, f.fx.h, a === 90, f.fx.ha, f.fx.va, isName ? 'sheetname' : isFile ? 'sheetfile' : 'field', { sheet: idx, bold: f.fx.bold });
      }
      for (const pin of s.pins) {
        const size = pin.fx.h;
        hierShape(pin.p[0], pin.p[1], pin.shape, pin.spin, size, pin.group, 'sheetpin', true);
        const dist = 0.15 * size + pin.fx.w;
        const off = { left: [-dist, 0], right: [dist, 0], up: [0, -dist], bottom: [0, dist] }[pin.spin];
        const vert = pin.spin === 'up' || pin.spin === 'bottom';
        const ha = pin.spin === 'right' || pin.spin === 'up' ? 'left' : 'right';
        text(pin.p[0] + off[0], pin.p[1] + off[1], K.unescape(pin.name), size, vert, ha, 'center', 'sheetpin', { g: pin.group });
        const t = S.texts[S.texts.length - 1];
        if (t) S.hitLabels.push({ bb: [Math.min(t.bb[0], pin.p[0] - size), Math.min(t.bb[1], pin.p[1] - size), Math.max(t.bb[2], pin.p[0] + size), Math.max(t.bb[3], pin.p[1] + size)], g: pin.group, sheetPin: pin });
      }
      S.sheets.push({ idx, bb: [x, y, x + w, y + h], sheet: s });
    });

    // ---- scene bbox
    let bb = [0, 0, PW, PH];
    const grow = (b) => { if (!b || !isFinite(b[0])) return; bb = [Math.min(bb[0], b[0]), Math.min(bb[1], b[1]), Math.max(bb[2], b[2]), Math.max(bb[3], b[3])]; };
    for (const s of S.strokes) grow(s.bb);
    S.bbox = bb;
    // Content bbox (ignores the page frame) for fitting
    let cb = null;
    const growC = (b) => { if (!b || !isFinite(b[0])) return; cb = cb ? [Math.min(cb[0], b[0]), Math.min(cb[1], b[1]), Math.max(cb[2], b[2]), Math.max(cb[3], b[3])] : b.slice(); };
    for (const s of S.strokes) if (s.role !== 'frame') growC(s.bb);
    for (const t of S.texts) if (t.role !== 'frameText') growC(t.bb);
    S.contentBox = cb || [0, 0, PW, PH];
    return S;
  }

  function intersheetRefs(project) {
    if (project._isr) return project._isr;
    const m = new Map();
    for (const inst of project.instances) for (const l of inst.sheet.labels) {
      if (l.kind !== 'global') continue;
      const n = l.netName || l.text;
      let s = m.get(n); if (!s) m.set(n, s = new Set());
      s.add(inst.page);
    }
    const out = new Map();
    for (const [k, v] of m) out.set(k, Array.from(v).sort(K.naturalCmp));
    project._isr = out;
    return out;
  }

  // ---------------------------------------------------------------- view
  class SchematicView {
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.opts = opts || {};
      this.scene = null;
      this.scale = 3; this.ox = 0; this.oy = 0;
      this.pal = PALETTES.light;
      this.hlGroups = null;  // Set of group ids highlighted on this sheet
      this.selSym = -1; this.selSheet = -1;
      this.dimOthers = true;
      this.flash = null;
      this.pointers = new Map();
      this._raf = 0;
      this._bindInput();
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(canvas.parentElement || canvas);
      this.resize();
    }
    setTheme(dark) { this.pal = dark ? PALETTES.dark : PALETTES.light; this.dark = !!dark; this.redraw(); }
    setScene(scene, keepView) {
      this.scene = scene;
      for (const im of scene.images) this._loadImage(im);
      if (!keepView) this.fit();
      this.redraw();
    }
    _loadImage(im) {
      if (im.img || im.loading || !im.data) return;
      im.loading = true;
      const img = new Image();
      img.onload = () => { im.img = img; im.w = img.naturalWidth; im.h = img.naturalHeight; this.redraw(); };
      const head = im.data.slice(0, 8);
      const mime = head.startsWith('/9j') ? 'image/jpeg' : 'image/png';
      img.src = 'data:' + mime + ';base64,' + im.data;
    }
    setHighlight(groups, symIdx, sheetIdx) {
      this.hlGroups = groups && groups.size ? groups : null;
      this.selSym = symIdx === undefined ? -1 : symIdx;
      this.selSheet = sheetIdx === undefined ? -1 : sheetIdx;
      this.redraw();
    }
    flashBox(bb) {
      this.flash = { bb, t0: performance.now() };
      const tick = () => { this.redraw(); if (this.flash && performance.now() - this.flash.t0 < 1600) requestAnimationFrame(tick); else { this.flash = null; this.redraw(); } };
      requestAnimationFrame(tick);
    }
    resize() {
      const r = this.canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      this.dpr = dpr;
      const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
      const first = !this.cssW;
      const cx = this.cssW ? this.cssW / 2 : 0, cy = this.cssH ? this.cssH / 2 : 0;
      if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
      if (!first && this.scene) {
        // keep the centre fixed
        this.ox += r.width / 2 - cx; this.oy += r.height / 2 - cy;
      }
      this.cssW = r.width; this.cssH = r.height;
      if (first && this.scene) this.fit();
      this.redraw();
    }
    fit(box, pad) {
      if (!this.scene) return;
      const b = box || this.scene.contentBox || this.scene.page;
      const insets = (this.opts.getInsets && this.opts.getInsets()) || { top: 0, right: 0, bottom: 0, left: 0 };
      const W = this.cssW - insets.left - insets.right, H = this.cssH - insets.top - insets.bottom;
      const bw = Math.max(b[2] - b[0], 1), bh = Math.max(b[3] - b[1], 1);
      const p = pad === undefined ? 24 : pad;
      let s = Math.min((W - 2 * p) / bw, (H - 2 * p) / bh);
      if (box) s = Math.min(s, 12);
      this.scale = Math.max(0.2, Math.min(s, 80));
      this.ox = insets.left + W / 2 - (b[0] + b[2]) / 2 * this.scale;
      this.oy = insets.top + H / 2 - (b[1] + b[3]) / 2 * this.scale;
      this.redraw();
    }
    animateTo(box) {
      const s0 = this.scale, x0 = this.ox, y0 = this.oy;
      this.fit(box, 48);
      const s1 = this.scale, x1 = this.ox, y1 = this.oy;
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      this.scale = s0; this.ox = x0; this.oy = y0;
      const t0 = performance.now(), D = 320;
      const step = () => {
        const t = Math.min(1, (performance.now() - t0) / D), e = 1 - Math.pow(1 - t, 3);
        // interpolate in log-scale for zoom so it feels even
        const ls = Math.log(s0) + (Math.log(s1) - Math.log(s0)) * e;
        const s = Math.exp(ls);
        // keep the box centre moving linearly in world space
        const cw0 = [(this.cssW / 2 - x0) / s0, (this.cssH / 2 - y0) / s0];
        const cw1 = [(this.cssW / 2 - x1) / s1, (this.cssH / 2 - y1) / s1];
        const cw = [cw0[0] + (cw1[0] - cw0[0]) * e, cw0[1] + (cw1[1] - cw0[1]) * e];
        this.scale = s; this.ox = this.cssW / 2 - cw[0] * s; this.oy = this.cssH / 2 - cw[1] * s;
        this._drawNow();
        if (t < 1) requestAnimationFrame(step); else { this.scale = s1; this.ox = x1; this.oy = y1; this.redraw(); }
      };
      requestAnimationFrame(step);
    }
    zoomBy(f, cx, cy) {
      if (cx === undefined) { cx = this.cssW / 2; cy = this.cssH / 2; }
      const ns = Math.max(0.15, Math.min(this.scale * f, 120));
      f = ns / this.scale;
      this.ox = cx - (cx - this.ox) * f; this.oy = cy - (cy - this.oy) * f;
      this.scale = ns;
      this.redraw();
    }
    toWorld(x, y) { return [(x - this.ox) / this.scale, (y - this.oy) / this.scale]; }
    redraw() { if (this._raf) return; this._raf = requestAnimationFrame(() => { this._raf = 0; this._drawNow(); }); }

    // ---------------------------------------------------- input
    _bindInput() {
      const c = this.canvas;
      c.style.touchAction = 'none';
      c.addEventListener('pointerdown', (e) => {
        c.setPointerCapture(e.pointerId);
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() });
        if (this.pointers.size === 1) { this._moved = false; this._tapStart = performance.now(); }
        if (this.pointers.size === 2) { this._pinch = this._pinchState(); this._moved = true; this._beginInteraction(); }
      });
      c.addEventListener('pointermove', (e) => {
        const p = this.pointers.get(e.pointerId);
        if (!p) return;
        const rect = c.getBoundingClientRect();
        if (this.pointers.size === 1) {
          const dx = e.clientX - p.x, dy = e.clientY - p.y;
          if (!this._moved && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > (e.pointerType === 'mouse' ? 3 : 8)) this._moved = true;
          if (this._moved) { this._beginInteraction(); this.ox += dx; this.oy += dy; this.redraw(); }
          p.x = e.clientX; p.y = e.clientY;
        } else if (this.pointers.size === 2) {
          p.x = e.clientX; p.y = e.clientY;
          const now = this._pinchState();
          const prev = this._pinch;
          if (prev && prev.d > 0) {
            const f = now.d / prev.d;
            const cx = now.cx - rect.left, cy = now.cy - rect.top;
            this.ox += now.cx - prev.cx; this.oy += now.cy - prev.cy;
            this.zoomBy(f, cx, cy);
          }
          this._pinch = now;
        }
      });
      const end = (e) => {
        const p = this.pointers.get(e.pointerId);
        if (!p) return;
        this.pointers.delete(e.pointerId);
        if (this.pointers.size === 1) { const r = this.pointers.values().next().value; r.x0 = r.x; r.y0 = r.y; this._pinch = null; }
        if (this.pointers.size === 0) {
          this._pinch = null;
          this._endInteraction();
          if (!this._moved && e.type === 'pointerup') {
            const rect = c.getBoundingClientRect();
            const x = e.clientX - rect.left, y = e.clientY - rect.top;
            const now = performance.now();
            if (this._lastTap && now - this._lastTap.t < 320 && Math.hypot(x - this._lastTap.x, y - this._lastTap.y) < 30) {
              this._lastTap = null;
              if (this.opts.onDoubleTap) this.opts.onDoubleTap(this.toWorld(x, y), x, y);
              else this.zoomBy(2, x, y);
            } else {
              this._lastTap = { t: now, x, y };
              if (this.opts.onTap) this.opts.onTap(this.toWorld(x, y), e.pointerType, x, y);
            }
          }
        }
      };
      c.addEventListener('pointerup', end);
      c.addEventListener('pointercancel', end);
      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        this._beginInteraction();
        clearTimeout(this._wheelEnd);
        this._wheelEnd = setTimeout(() => this._endInteraction(), 160);
        const rect = c.getBoundingClientRect();
        if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
          const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018));
          this.zoomBy(f, e.clientX - rect.left, e.clientY - rect.top);
        } else { this.ox -= e.deltaX; this.oy -= e.deltaY; this.redraw(); }
      }, { passive: false });
    }
    _pinchState() {
      const ps = Array.from(this.pointers.values());
      if (ps.length < 2) return null;
      return { cx: (ps[0].x + ps[1].x) / 2, cy: (ps[0].y + ps[1].y) / 2, d: Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y) };
    }

    // While panning or pinching, move a snapshot of the last full frame instead of redrawing
    // every primitive; the full redraw happens when the fingers lift.
    _beginInteraction() {
      if (this._snap) return;
      const c = this.canvas;
      if (!c.width || !c.height) return;
      const snap = document.createElement('canvas');
      snap.width = c.width; snap.height = c.height;
      snap.getContext('2d').drawImage(c, 0, 0);
      this._snap = { canvas: snap, scale: this.scale, ox: this.ox, oy: this.oy };
    }
    _endInteraction() {
      if (!this._snap) return;
      this._snap = null;
      this.redraw();
    }

    // ---------------------------------------------------- hit testing
    hitTest(wp, tolPx) {
      const S = this.scene;
      if (!S) return null;
      const tol = (tolPx || 14) / this.scale;
      let best = null;
      const consider = (d, hit, bias) => { const sc = d - (bias || 0) * tol; if (d <= tol && (!best || sc < best.sc)) best = Object.assign({ sc, d }, hit); };
      const segDist = (p, ax, ay, bx, by) => {
        const dx = bx - ax, dy = by - ay; const l2 = dx * dx + dy * dy;
        let t = l2 ? ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
        return Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy));
      };
      for (const s of S.strokes) {
        if (s.g < 0) continue;
        const b = s.bb;
        if (wp[0] < b[0] - tol || wp[0] > b[2] + tol || wp[1] < b[1] - tol || wp[1] > b[3] + tol) continue;
        let d = Infinity;
        for (let i = 0; i + 3 < s.p.length; i += 2) d = Math.min(d, segDist(wp, s.p[i], s.p[i + 1], s.p[i + 2], s.p[i + 3]));
        consider(d, { type: 'net', g: s.g, kind: s.kind }, s.kind === 'pin' ? 0.35 : 0);
      }
      for (const c of S.circles) if (c.g >= 0) consider(Math.max(0, Math.hypot(wp[0] - c.c[0], wp[1] - c.c[1]) - c.r), { type: 'net', g: c.g, kind: c.kind }, 0.2);
      for (const h of S.hitLabels) {
        const b = h.bb;
        const dx = Math.max(b[0] - wp[0], 0, wp[0] - b[2]), dy = Math.max(b[1] - wp[1], 0, wp[1] - b[3]);
        consider(Math.hypot(dx, dy), { type: 'net', g: h.g, kind: 'label' }, 0.3);
      }
      if (best) return best;
      // symbols: smallest box containing the point
      let sym = null, area = Infinity;
      for (const s of S.syms) {
        const b = s.bb, pad = 0.6;
        if (wp[0] >= b[0] - pad && wp[0] <= b[2] + pad && wp[1] >= b[1] - pad && wp[1] <= b[3] + pad) {
          const a = (b[2] - b[0]) * (b[3] - b[1]);
          if (a < area) { area = a; sym = s; }
        }
      }
      // symbol text (reference/value) also selects its symbol
      if (!sym) for (const t of S.texts) {
        if (t.sym < 0) continue;
        const b = t.bb;
        if (wp[0] >= b[0] && wp[0] <= b[2] && wp[1] >= b[1] && wp[1] <= b[3]) { sym = S.syms.find((s) => s.si === t.sym); break; }
      }
      if (sym) return { type: 'symbol', si: sym.si };
      for (const s of S.sheets) {
        const b = s.bb;
        if (wp[0] >= b[0] && wp[0] <= b[2] && wp[1] >= b[1] && wp[1] <= b[3]) return { type: 'sheet', idx: s.idx };
      }
      return null;
    }

    // ---------------------------------------------------- drawing
    _drawNow() {
      const ctx = this.ctx, S = this.scene, P = this.pal;
      const dpr = this.dpr;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = P.bg;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      if (!S) return;
      if (this._snap) {
        const sn = this._snap, k = this.scale / sn.scale;
        ctx.setTransform(k, 0, 0, k, dpr * (this.ox - sn.ox * k), dpr * (this.oy - sn.oy * k));
        ctx.drawImage(sn.canvas, 0, 0);
        // Re-render properly if the zoom has drifted far from the snapshot.
        if (k > 2.2 || k < 0.45) { this._snap = null; this._drawNow(); this._beginInteraction(); }
        return;
      }
      const sc = this.scale;
      ctx.setTransform(dpr * sc, 0, 0, dpr * sc, dpr * this.ox, dpr * this.oy);
      const view = [(-this.ox) / sc, (-this.oy) / sc, (this.cssW - this.ox) / sc, (this.cssH - this.oy) / sc];
      const vis = (b) => !(b[2] < view[0] || b[0] > view[2] || b[3] < view[1] || b[1] > view[3]);
      const px = 1 / sc;
      // paper
      ctx.fillStyle = P.paper;
      ctx.fillRect(S.page[0], S.page[1], S.page[2], S.page[3]);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';

      const hl = this.hlGroups, selSym = this.selSym, selSheet = this.selSheet;
      const anyHl = !!hl || selSym >= 0 || selSheet >= 0;
      const dim = anyHl && this.dimOthers ? (this.dark ? 0.32 : 0.28) : 1;
      const isHl = (o) => (hl && o.g >= 0 && hl.has(o.g)) || (selSym >= 0 && o.sym === selSym) || (selSheet >= 0 && o.sheet === selSheet);
      const col = (o) => o.color || P[o.role] || P.note;

      // images
      for (const im of S.images) {
        if (!im.img) continue;
        const w = im.w * im.scale * 25.4 / 300, h = im.h * im.scale * 25.4 / 300;
        const b = [im.p[0] - w / 2, im.p[1] - h / 2, im.p[0] + w / 2, im.p[1] + h / 2];
        if (!vis(b)) continue;
        ctx.globalAlpha = dim;
        ctx.drawImage(im.img, b[0], b[1], w, h);
      }
      // fills
      for (const f of S.fills) {
        if (!vis(f.bb)) continue;
        ctx.globalAlpha = isHl(f) ? 1 : (f.role === 'bodyfill' ? Math.max(dim, 0.55) : dim);
        ctx.fillStyle = f.color || P[f.role] || P.bodyfill;
        this._path(f.p, true);
        ctx.fill();
      }
      // selected symbol / sheet backdrop
      if (selSym >= 0) {
        const s = S.syms.find((x) => x.si === selSym);
        if (s) { ctx.globalAlpha = 1; ctx.fillStyle = P.selFill; const b = s.bb, p = 0.8; ctx.fillRect(b[0] - p, b[1] - p, b[2] - b[0] + 2 * p, b[3] - b[1] + 2 * p); }
      }
      if (selSheet >= 0) {
        const s = S.sheets.find((x) => x.idx === selSheet);
        if (s) { ctx.globalAlpha = 1; ctx.fillStyle = P.selFill; const b = s.bb; ctx.fillRect(b[0], b[1], b[2] - b[0], b[3] - b[1]); }
      }
      const later = [];
      // strokes
      for (const s of S.strokes) {
        if (!vis(s.bb)) continue;
        if (anyHl && isHl(s)) { later.push(s); continue; }
        ctx.globalAlpha = s.role === 'frame' ? Math.min(1, dim + 0.3) : dim;
        ctx.strokeStyle = col(s);
        ctx.lineWidth = Math.max(s.w, (s.role === 'bus' ? 2 : 1.1) * px);
        this._dash(s.dash, px);
        this._path(s.p, false);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      for (const c of S.circles) {
        if (!vis(c.bb)) continue;
        if (anyHl && isHl(c)) { later.push(c); continue; }
        ctx.globalAlpha = dim;
        this._circle(c, P, px, false);
      }
      // text
      const texts = [];
      for (const t of S.texts) {
        if (!vis(t.bb)) continue;
        if (anyHl && isHl(t)) { later.push(t); continue; }
        texts.push(t);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      for (const t of texts) { ctx.globalAlpha = t.role === 'frameText' ? Math.min(1, dim + 0.3) : dim; this._text(t, col(t)); }

      // highlighted items on top
      if (later.length) {
        ctx.globalAlpha = 1;
        ctx.setTransform(dpr * sc, 0, 0, dpr * sc, dpr * this.ox, dpr * this.oy);
        // halo
        ctx.strokeStyle = P.hlHalo;
        for (const o of later) {
          if (o.p && o.g >= 0) { ctx.lineWidth = Math.max(o.w * 2.5, 9 * px); this._path(o.p, false); ctx.stroke(); }
          else if (o.c && o.g >= 0) { ctx.fillStyle = P.hlHalo; ctx.beginPath(); ctx.arc(o.c[0], o.c[1], Math.max(o.r * 1.8, 6 * px), 0, Math.PI * 2); ctx.fill(); }
        }
        for (const o of later) {
          if (o.p) {
            const net = o.g >= 0 && hl && hl.has(o.g);
            ctx.strokeStyle = net ? P.hl : col(o);
            ctx.lineWidth = Math.max(o.w * (net ? 1.6 : 1.2), (net ? 2.6 : 1.4) * px);
            this._dash(o.dash, px);
            this._path(o.p, false);
            ctx.stroke();
          } else if (o.c) {
            const net = o.g >= 0 && hl && hl.has(o.g);
            this._circle(o, P, px, net);
          }
        }
        ctx.setLineDash([]);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        for (const o of later) if (o.runs) this._text(o, o.g >= 0 && hl && hl.has(o.g) ? P.hl : col(o), true);
      }
      // flash ring
      if (this.flash) {
        const t = (performance.now() - this.flash.t0) / 1600;
        const b = this.flash.bb;
        const cx = ((b[0] + b[2]) / 2) * sc + this.ox, cy = ((b[1] + b[3]) / 2) * sc + this.oy;
        const r0 = Math.max((b[2] - b[0]) * sc, (b[3] - b[1]) * sc) / 2 + 10;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.globalAlpha = Math.max(0, 1 - t);
        ctx.strokeStyle = P.hl; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(cx, cy, r0 + 30 * t, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    _dash(type, px) {
      const ctx = this.ctx;
      if (!type) { ctx.setLineDash([]); return; }
      const u = Math.max(0.5, 3 * px);
      if (type === 'dash') ctx.setLineDash([u * 3, u * 2]);
      else if (type === 'dot') ctx.setLineDash([u * 0.3, u * 1.5]);
      else if (type === 'dash_dot') ctx.setLineDash([u * 3, u * 1.5, u * 0.3, u * 1.5]);
      else if (type === 'dash_dot_dot') ctx.setLineDash([u * 3, u * 1.5, u * 0.3, u * 1.5, u * 0.3, u * 1.5]);
      else ctx.setLineDash([]);
    }
    _path(p, close) {
      const ctx = this.ctx;
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
      if (close) ctx.closePath();
    }
    _circle(c, P, px, net) {
      const ctx = this.ctx;
      ctx.beginPath();
      ctx.arc(c.c[0], c.c[1], Math.max(c.r, (c.kind === 'junction' ? 1.6 : 0.5) * px), 0, Math.PI * 2);
      if (c.fill || c.fillColor) { ctx.fillStyle = net ? P.hl : (c.fillColor || P[c.fill]); ctx.fill(); }
      if (!c.fill || c.fill === 'bodyfill') {
        ctx.strokeStyle = net ? P.hl : (P[c.role] || P.note);
        ctx.lineWidth = Math.max(c.w, 1.1 * px);
        ctx.stroke();
      }
    }
    _text(t, color, bright) {
      const ctx = this.ctx, sc = this.scale, dpr = this.dpr;
      const fpx = t.size * EM * sc;
      if (fpx < (bright ? 2.5 : 3.2)) return;
      const sx = t.x * sc + this.ox, sy = t.y * sc + this.oy;
      ctx.setTransform(dpr, 0, 0, dpr, sx * dpr, sy * dpr);
      if (t.vert) ctx.rotate(-Math.PI / 2);
      const weight = t.bold ? '600 ' : bright ? '500 ' : '400 ';
      const style = t.italic ? 'italic ' : '';
      const total = t.w * sc;
      let x = t.ha === 'left' ? 0 : t.ha === 'right' ? -total : -total / 2;
      ctx.fillStyle = color;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      for (const r of t.runs) {
        const small = r.sub || r.sup;
        const f = small ? fpx * 0.7 : fpx;
        ctx.font = style + weight + f.toFixed(2) + 'px ' + FONT;
        const yOff = r.sub ? fpx * 0.25 : r.sup ? -fpx * 0.4 : 0;
        ctx.fillText(r.t, x, yOff);
        const w = w100(r.t, t.bold) / 100 * f;
        if (r.over) {
          ctx.fillRect(x, -t.size * sc * 1.18, w, Math.max(1, fpx * 0.07));
        }
        x += w;
      }
    }
  }

  root.KiRender = { buildScene, SchematicView, PALETTES, clearMeasureCache, textWidthMM };
})(typeof globalThis !== 'undefined' ? globalThis : this);
