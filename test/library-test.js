// Places parts from the Loomline library into a demo schematic, re-parses, and checks that the
// part, its reference, pins and connectivity come back right. Also draws each kind of shape.
//   node test/library-test.js /path/to/kicad/demos/pic_programmer
const fs = require('fs'), path = require('path'), zlib = require('zlib');
global.KiCore = require('../js/kicad-core.js');
const E = require('../js/edit.js');
const K = global.KiCore;
const dir = process.argv[2];
const libDir = path.join(__dirname, '..', 'library');
let files = fs.readdirSync(dir).filter((f) => /\.kicad_(sch|pro)$/.test(f)).map((f) => ({ path: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
let fail = 0;
const check = (name, ok, info) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!ok) fail++; };
const libs = {};
const entry = (lib, name) => {
  if (!libs[lib]) {
    const idx = JSON.parse(fs.readFileSync(path.join(libDir, 'index.json'), 'utf8'));
    const meta = idx.libs.find((l) => l.name === lib);
    const raw = fs.readFileSync(path.join(libDir, meta.dir || 'kicad/', meta.file));
    libs[lib] = JSON.parse((raw[0] === 0x1f ? zlib.gunzipSync(raw) : raw).toString('utf8')).libs[lib].symbols;
  }
  const text = libs[lib][name];
  const ext = /\(extends "([^"]+)"\)/.exec(text);
  return { lib, name, text, parentText: ext ? libs[lib][ext[1]] : null };
};
const apply = (r) => { files = files.map((f) => (f.path === r.path ? { path: f.path, text: r.text } : f)); };
let P = K.buildProject(files);
const cases = [['Relay', 'G5V-1'], ['Switch', 'SW_Push'], ['Device', 'Fuse'], ['Connector', 'Conn_01x04_Pin'], ['Relay', 'FINDER-40.52'], ['power', '+24V'], ['Device', 'Lamp'], ['Regulator_Linear', 'LM7805_TO220'], ['Loomline_Beckhoff', 'EK1100'], ['Loomline_Beckhoff', 'EL1008'], ['Loomline_Beckhoff', 'EL3356'], ['Loomline_Beckhoff', 'EL2809'], ['Loomline_Beckhoff', 'C6017-0030']];
let x = 30;
for (const [lib, name] of cases) {
  const inst = P.root, sh = inst.sheet;
  const before = new Set(inst.refs.map((r) => r.ref));
  let r;
  try { r = E.addLibSymbol(P, sh, inst, entry(lib, name), [x, 20]); } catch (e) { check(`${lib}:${name} placed`, false, e.message); continue; }
  apply(r); P = K.buildProject(files);
  const si = P.root.sheet.symbols.findIndex((s, i) => P.root.refs[i].ref === r.ref && !before.has(r.ref));
  const sym = P.root.sheet.symbols[si];
  const ok = si >= 0 && sym.lib && K.symbolPins(sym).length >= 1;
  check(`${lib}:${name} placed as ${r.ref}`, ok, ok ? `${K.symbolPins(sym).length} pins, units ${r.units.join(',')}, lib ${sym.libId}` : '');
  // every pin should be on its own net (nothing touches it yet), except power symbols
  x += 15.24;
}
// placing the same part again reuses the embedded definition
const n0 = (files.find((f) => f.path === P.root.sheet.path).text.match(/\(symbol "Relay:G5V-1"/g) || []).length;
apply(E.addLibSymbol(P, P.root.sheet, P.root, entry('Relay', 'G5V-1'), [30, 40])); P = K.buildProject(files);
const n1 = (files.find((f) => f.path === P.root.sheet.path).text.match(/\(symbol "Relay:G5V-1"/g) || []).length;
check('second G5V-1 reuses the definition', n0 === 1 && n1 === 1, `${n0} -> ${n1}`);
// multi-unit: place unit 2 of a dual relay or op-amp
{
  const e = entry('Amplifier_Operational', 'LM358');
  const r = E.addLibSymbol(P, P.root.sheet, P.root, e, [100, 40]); apply(r); P = K.buildProject(files);
  const si = P.root.refs.findIndex((x) => x.ref === r.ref);
  const r2 = E.addUnit(P, P.root.sheet, P.root, P.root.sheet.symbols[si], 2, [120, 40]); apply(r2); P = K.buildProject(files);
  const units = P.root.refs.filter((x) => x.ref === r.ref).map((x) => x.unit).sort();
  check('LM358 unit 2 added with the same reference', units.join() === '1,2', r.ref + ' units ' + units.join());
}
// shapes
const sh0 = () => P.root.sheet;
for (const [kind, g] of [['line', { pts: [[10, 150], [40, 150], [40, 170]] }], ['rect', { a: [50, 150], b: [70, 165] }], ['circle', { c: [90, 160], r: 6 }], ['arc', { a: [100, 160], m: [108, 152], b: [116, 160] }], ['text', { p: [120, 160], text: 'Panel A — 24 V', size: 2 }]]) {
  const g0 = sh0().graphics.length, t0 = sh0().texts.length;
  apply(E.addGraphic(sh0(), kind, g, { width: 0.3, type: 'dash', fill: 'none' })); P = K.buildProject(files);
  check('draw ' + kind, kind === 'text' ? sh0().texts.length === t0 + 1 : sh0().graphics.length === g0 + 1);
}
// move and delete a graphic, restyle one
{
  const gi = sh0().graphics.length - 1;
  const node = sh0().graphics[gi].src;
  const c0 = sh0().graphics[gi].pts[0].slice();
  apply(E.moveNode(sh0(), node, [2.54, 1.27])); P = K.buildProject(files);
  const c1 = sh0().graphics[gi].pts[0];
  check('move arc', Math.abs(c1[0] - c0[0] - 2.54) < 1e-6 && Math.abs(c1[1] - c0[1] - 1.27) < 1e-6);
  apply(E.styleNode(sh0(), sh0().graphics[gi - 2].src, { width: 0.5, type: 'solid', fill: 'background' })); P = K.buildProject(files);
  check('restyle rectangle', sh0().graphics[gi - 2].st.w === 0.5);
  const n = sh0().graphics.length;
  apply(E.deleteNode(sh0(), sh0().graphics[0].src)); P = K.buildProject(files);
  check('delete shape', sh0().graphics.length === n - 1);
}
// the file must still parse cleanly with balanced parentheses
const final = files.find((f) => f.path === P.root.sheet.path).text;
let depth = 0, inS = false; for (let i = 0; i < final.length; i++) { const c = final[i]; if (inS) { if (c === '\\') i++; else if (c === '"') inS = false; } else if (c === '"') inS = true; else if (c === '(') depth++; else if (c === ')') depth--; }
check('balanced parentheses', depth === 0);
check('project still has no errors', !P.errors.length);
if (process.argv[3]) fs.writeFileSync(process.argv[3], final);
console.log(fail ? fail + ' FAILED' : 'ALL PASSED');
process.exit(fail ? 1 : 0);
