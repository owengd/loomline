// KiCad-style ERC rules in the design check: builds small schematics that break each rule and
// checks the check reports it (and that a clean drawing stays clean).
//   node test/erc-test.js
global.KiCore = require('../js/kicad-core.js');
const K = global.KiCore;
const E = require('../js/edit.js');
const Loom = require('../js/loom.js');
let fail = 0;
const ok = (name, cond, info) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!cond) fail++; };

// A two-pin part whose pins are both numbered 1 (as some connector symbols are drawn), and a resistor.
const base = `(kicad_sch (version 20231120) (generator "eeschema") (uuid "11111111-1111-1111-1111-111111111111") (paper "A4")
	(lib_symbols
		(symbol "T:DUP" (in_bom yes) (on_board yes)
			(property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
			(property "Value" "DUP" (at 0 0 0) (effects (font (size 1.27 1.27))))
			(symbol "DUP_1_1"
				(pin passive line (at -5.08 0 0) (length 2.54) (name "A" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
				(pin passive line (at -5.08 -5.08 0) (length 2.54) (name "B" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
			)
		)
	)
	(symbol (lib_id "T:DUP") (at 101.6 101.6 0) (unit 1) (in_bom yes) (on_board yes) (uuid "22222222-2222-2222-2222-222222222222")
		(property "Reference" "U1" (at 101.6 96.52 0) (effects (font (size 1.27 1.27))))
		(property "Value" "DUP" (at 101.6 99.06 0) (effects (font (size 1.27 1.27))))
	)
)
`;
const path = 'erc.kicad_sch';
const build = (text) => { const P = K.buildProject([{ path, text }]); const A = Loom.analyze(P); return { P, A, codes: A.issues.map((i) => i.code) }; };
let sh = K.parseSchematic(base, path);
const apply = (r) => { sh = K.parseSchematic(r.text, path); return r.text; };

// Pins of U1 are at (96.52, 101.6) [A] and (96.52, 106.68) [B]: give each its own net.
apply(E.addWireSegs(sh, [[[96.52, 101.6], [88.9, 101.6]], [[96.52, 106.68], [88.9, 106.68]]]));
apply(E.addLabel(sh, 'local', 'NA', [88.9, 101.6], 'left'));
let t = apply(E.addLabel(sh, 'local', 'NB', [88.9, 106.68], 'left'));
let r = build(t);
ok('same pin number on two nets is reported', r.codes.includes('duppin'), r.A.issues.filter((i) => i.code === 'duppin').map((i) => i.msg).join(' | '));

// A label in empty space
t = apply(E.addLabel(sh, 'local', 'FLOATING', [150, 150], 'right'));
r = build(t);
ok('label touching nothing is reported', r.codes.includes('lbldangle'));

// Two names on one wire
apply(E.addWireSegs(sh, [[[120, 120], [130, 120]]]));
apply(E.addLabel(sh, 'local', 'ONE', [120, 120], 'left'));
t = apply(E.addLabel(sh, 'local', 'TWO', [130, 120], 'right'));
r = build(t);
ok('two names on one wire is reported', r.codes.includes('names'));

// A group bus carrying two different prefixes (KiCad won't join X.H to Y.H)
apply(E.addBusSegs(sh, [[[60, 60], [80, 60]]]));
apply(E.addLabel(sh, 'local', 'CAN_A{V H L GND}', [60, 60], 'left'));
t = apply(E.addLabel(sh, 'local', 'CAN_B{V H L GND}', [80, 60], 'right'));
r = build(t);
ok('group buses with different prefixes are reported', r.codes.includes('busname'), (r.A.issues.find((i) => i.code === 'busname') || {}).msg);

// The same thing with numbered buses is fine
let sh2 = K.parseSchematic(base, path);
const a2 = (x) => { sh2 = K.parseSchematic(x.text, path); return x.text; };
a2(E.addBusSegs(sh2, [[[60, 60], [80, 60]]]));
a2(E.addLabel(sh2, 'local', 'CAN_A[1..4]', [60, 60], 'left'));
let t2 = a2(E.addLabel(sh2, 'local', 'CAN_B[1..4]', [80, 60], 'right'));
r = build(t2);
ok('numbered buses with different names are not flagged as bus names', !r.codes.includes('busname'));

// A wire ending on a bus without an entry
t = apply(E.addWireSegs(sh, [[[70, 60], [70, 70]]]));
r = build(t);
ok('wire meeting a bus without an entry is reported', r.codes.includes('buswire'));

// Off-grid wire end
t = apply(E.addWireSegs(sh, [[[140.3, 40], [150, 40]]]));
r = build(t);
ok('off-grid wire end is reported', r.codes.includes('grid'));

// The sample project stays free of the new kinds
const fs = require('fs'), dir = __dirname + '/../samples/complex_hierarchy';
const files = fs.readdirSync(dir).filter((f) => /\.kicad_(sch|pro)$/.test(f)).map((f) => ({ path: f, text: fs.readFileSync(dir + '/' + f, 'utf8') }));
const PS = K.buildProject(files), AS = Loom.analyze(PS);
const newKinds = ['duppin', 'names', 'busname', 'lbldangle', 'buswire', 'power', 'unit'];
const found = AS.issues.filter((i) => newKinds.includes(i.code));
ok('KiCad demo project has none of the new problems', found.length === 0, found.slice(0, 3).map((i) => i.msg).join(' | '));

console.log(fail ? fail + ' failed' : 'all passed');
process.exit(fail ? 1 : 0);
