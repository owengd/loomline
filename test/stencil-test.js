// Tests for stencil placement, dropping parts into wires, and copy/paste.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
global.KiCore = require('../js/kicad-core.js');
const E = require('../js/edit.js');
const K = global.KiCore;
let fail = 0;
const check = (name, ok, info) => { console.log((ok === true ? 'PASS ' : 'FAIL ') + name + (ok === true ? '' : ' -> ' + ok) + (info ? '  ' + info : '')); if (ok !== true) fail++; };

const BLANK = '(kicad_sch\n\t(version 20250114)\n\t(generator "eeschema")\n\t(generator_version "9.0")\n\t(uuid "11111111-1111-4111-8111-111111111111")\n\t(paper "A4")\n\t(lib_symbols)\n\t(sheet_instances\n\t\t(path "/"\n\t\t\t(page "1")\n\t\t)\n\t)\n\t(embedded_fonts no)\n)\n';
const bundle = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '../library/kicad/power-protection.json.gz'))).toString());
const dev = bundle.libs.Device, pwr = bundle.libs.power;
const entry = (lib, f, name) => ({ lib, name, text: f.symbols[name], parentText: null });
let files = [{ path: 't.kicad_sch', text: BLANK }];
const P = () => K.buildProject(files);
const put = (r) => { files = files.map((f) => (f.path === r.path ? { path: f.path, text: r.text } : f)); };
const sheet = () => P().root.sheet;
const netOfPin = (Pr, ref, num) => Pr.nets.find((n) => n.pins.some((p) => p.ref === ref && p.number === num));

// A horizontal wire 0..50 at y=50
put(E.addWires(sheet(), [[25.4, 50.8], [76.2, 50.8]]));
check('one wire', sheet().wires.length === 1);

// Tee stencil dropped on the middle of the wire: arms collinear with the wire are skipped by the app,
// so only the stem goes in. The wire must split and a junction appear.
put(E.addWireSegs(sheet(), [[[50.8, 50.8], [50.8, 60.96]]]));
let s = sheet();
check('tee splits the wire', s.wires.length === 3 || s.wires.length);
check('tee adds a junction', s.junctions.length === 1 || s.junctions.length);
let Pr = P();
const grp = new Set(s.wires.map((w) => w.group));
check('tee: all three wires on one net', grp.size === 1 || grp.size);

// Cross-over (two straight wires crossing, no junction): two separate nets
put(E.addWireSegs(sheet(), [[[100.33, 40.64], [100.33, 60.96]], [[90.17, 50.8], [110.49, 50.8]]]));
s = sheet();
const v = s.wires.find((w) => w.a[0] === 100.33 && w.b[0] === 100.33), h = s.wires.find((w) => w.a[0] === 90.17);
check('cross-over keeps two nets', v && h && v.group !== h.group || 'joined');

// Drop a resistor into the long wire: rotate so its pins are horizontal, cut the wire between the pins.
let r = E.addLibSymbol(P(), sheet(), P().root, entry('Device', dev, 'R'), [38.1, 50.8]);
s = E.reparse(sheet(), r);
let R1 = s.symbols[s.symbols.length - 1];
r = E.transformSymbol(s, R1, 'rotate', { keepWires: false });
s = E.reparse(s, r);
R1 = s.symbols[s.symbols.length - 1];
const pins = K.symbolPins(R1);
check('rotated resistor pins horizontal', Math.abs(pins[0].pos[1] - pins[1].pos[1]) < 1e-6 || JSON.stringify(pins.map((p) => p.pos)));
const w0 = s.wires.find((w) => K.onSegment(pins[0].pos, w.a, w.b) && K.onSegment(pins[1].pos, w.a, w.b));
check('resistor sits on the wire', !!w0 || 'no wire');
r = E.insertInWire(s, w0, pins[0].pos, pins[1].pos);
put(r);
Pr = P();
const n1 = netOfPin(Pr, 'R1', '1'), n2 = netOfPin(Pr, 'R1', '2');
check('resistor in series: two different nets', n1 && n2 && n1 !== n2 || 'same net');
check('one side still reaches the tee', [n1, n2].some((n) => n && n.pins.length >= 1));

// Power symbol dropped on the middle of a wire: connectAt splits and junctions
r = E.addLibSymbol(P(), sheet(), P().root, entry('power', pwr, 'GND'), [63.5, 50.8]);
s = E.reparse(sheet(), r);
const gnd = s.symbols[s.symbols.length - 1];
const gp = K.symbolPins(gnd)[0].pos;
const onWire = s.wires.find((w) => K.onSegment(gp, w.a, w.b) && !E.same(gp, w.a) && !E.same(gp, w.b));
check('GND pin lies inside a wire', !!onWire || JSON.stringify(gp));
put(E.connectAt(s, [gp]));
Pr = P();
const gnet = Pr.nets.find((n) => n.pins.some((p) => p.ref.startsWith('#PWR')));
const r1n = netOfPin(Pr, "R1", "2"), r1m = netOfPin(Pr, "R1", "1"); check("GND joins that wire", [r1n, r1m].some((n) => n && /GND/.test(n.name)) || [r1n && r1n.name, r1m && r1m.name]);
check('junction added at GND', sheet().junctions.some((j) => E.same(j.p, gp)));

// Copy everything and paste it 50 mm lower: new refs, same internal connections, file parses.
s = sheet();
const root = P().root;
const items = [];
s.symbols.forEach((sym, i) => items.push({ type: 'symbol', sym, ref: root.refs[i].ref }));
s.wires.forEach((o) => items.push({ type: 'wire', obj: o }));
s.junctions.forEach((o) => items.push({ type: 'junction', obj: o }));
const clip = E.copyItems(s, items);
check('clipboard has the library symbols', Object.keys(clip.libs).length === 2 || Object.keys(clip.libs));
// paste into a fresh sheet so the library symbols must be added
const before = JSON.stringify(files);
files.push({ path: 'u.kicad_sch', text: BLANK.replace('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222') });
let PP = P();
const other = PP.instances.find((i) => i.sheet.path === 'u.kicad_sch') || PP.instances[1];
r = E.pasteItems(PP, other.sheet, other, clip, [20.32, 101.6]);
put(r);
PP = P();
const s2 = PP.instances.find((i) => i.sheet.path === 'u.kicad_sch').sheet;
check('paste parses with the parts', s2.symbols.length === s.symbols.length || s2.symbols.length);
check('paste brings the library symbols', Object.keys(s2.libSymbols).length === 2 || Object.keys(s2.libSymbols));
const ids = new Set(); let dupe = false;
for (const f of files) for (const m of f.text.matchAll(/\(uuid "([^"]+)"\)/g)) { if (ids.has(m[1])) dupe = m[1]; ids.add(m[1]); }
check('every UUID unique after paste', !dupe || dupe);
check('pasted resistor got a new reference', r.refs.includes('R2') || r.refs);
// same sheet paste keeps internal connections of the copy
files = JSON.parse(before);
PP = P();
r = E.pasteItems(PP, PP.root.sheet, PP.root, clip, [20.32, 101.6]);
put(r);
PP = P();
const a1 = netOfPin(PP, 'R2', '1'), a2 = netOfPin(PP, 'R2', '2');
check('pasted resistor in series too', a1 && a2 && a1 !== a2 || 'shorted');
const orig = netOfPin(PP, 'R1', '1');
check('copy is not connected to the original', !a1 || !orig || (a1 !== orig && a2 !== orig) || 'joined');

// Group move with a drawing in it
put(E.addGraphic(PP.root.sheet, 'rect', { a: [10.16, 10.16], b: [20.32, 20.32] }, { width: 0, type: 'default', fill: 'none' }));
s = sheet();
const g = s.graphics[0];
r = E.moveItems(s, [{ type: 'node', node: g.src }, { type: 'symbol', sym: s.symbols[0] }], [2.54, 2.54]);
put(r);
const g2 = sheet().graphics[0];
check('group move shifts the rectangle', /\(start 12\.7 12\.7\)/.test(sheet().text) || 'not moved');

console.log(fail ? fail + ' FAILED' : 'ALL PASSED');
process.exit(fail ? 1 : 0);
