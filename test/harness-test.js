// Harness builder: looms from the Loom field, wires between loom parts, cable tags on wires and
// buses, cut list, pin-outs and the flat drawing.
//   node test/harness-test.js
global.KiCore = require('../js/kicad-core.js');
const K = global.KiCore;
const E = require('../js/edit.js');
global.Loom = require('../js/loom.js');
require('../js/cables.js');
const H = require('../js/harness.js');
let fail = 0;
const ok = (name, cond, info) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!cond) fail++; };

const pin = (n, y, x, a) => `(pin passive line (at ${x} ${y} ${a}) (length 2.54) (name "P${n}" (effects (font (size 1.27 1.27)))) (number "${n}" (effects (font (size 1.27 1.27)))))`;
const sym = (lib, ref, x, y, val, uuid) => `	(symbol (lib_id "${lib}") (at ${x} ${y} 0) (unit 1) (in_bom yes) (on_board yes) (uuid "${uuid}")
		(property "Reference" "${ref}" (at ${x} ${y - 4} 0) (effects (font (size 1.27 1.27))))
		(property "Value" "${val}" (at ${x} ${y - 2} 0) (effects (font (size 1.27 1.27))))
	)`;
const base = `(kicad_sch (version 20231120) (generator "eeschema") (uuid "11111111-1111-1111-1111-111111111111") (paper "A3")
	(lib_symbols
		(symbol "T:CONN4" (in_bom yes) (on_board yes)
			(property "Reference" "J" (at 0 0 0) (effects (font (size 1.27 1.27))))
			(property "Value" "CONN4" (at 0 0 0) (effects (font (size 1.27 1.27))))
			(symbol "CONN4_1_1" ${[1, 2, 3, 4].map((n) => pin(n, -(n - 1) * 2.54, -5.08, 0)).join(' ')})
		)
		(symbol "T:DEV4" (in_bom yes) (on_board yes)
			(property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
			(property "Value" "DEV4" (at 0 0 0) (effects (font (size 1.27 1.27))))
			(symbol "DEV4_1_1" ${[1, 2, 3, 4].map((n) => pin(n, -(n - 1) * 2.54, 5.08, 180)).join(' ')})
		)
	)
${sym('T:DEV4', 'U1', 20.32, 50.8, 'Node', '22222222-2222-2222-2222-222222222221')}
${sym('T:CONN4', 'J1', 50.8, 50.8, 'M8 4 F', '22222222-2222-2222-2222-222222222222')}
${sym('T:CONN4', 'J2', 152.4, 50.8, 'M8 4 M', '22222222-2222-2222-2222-222222222223')}
${sym('T:CONN4', 'J3', 152.4, 101.6, 'M8 4 M', '22222222-2222-2222-2222-222222222224')}
${sym('T:CONN4', 'J9', 254, 50.8, 'Spare', '22222222-2222-2222-2222-222222222225')}
)
`;
const path = 'h.kicad_sch';
let sh = K.parseSchematic(base, path);
const apply = (r) => { sh = K.parseSchematic(r.text, path); return r.text; };
const ys = [0, 2.54, 5.08, 7.62].map((d) => 50.8 + d);
// U1 (the device) wired straight to J1: J1 is the plug that mates with it.
apply(E.addWireSegs(sh, ys.map((y) => [[25.4, y], [45.72, y]])));
// J1 and J2 share labels CAB1..4, and a bus CAB[1..4] carries the cable.
apply(E.addWireSegs(sh, ys.map((y) => [[147.32, y], [137.16, y]])));
ys.forEach((y, i) => apply(E.addLabel(sh, 'local', 'CAB' + (i + 1), [45.72, y], 'left')));
ys.forEach((y, i) => apply(E.addLabel(sh, 'local', 'CAB' + (i + 1), [137.16, y], 'left')));
apply(E.addBusSegs(sh, [[[76.2, 30.48], [116.84, 30.48]]]));
apply(E.addLabel(sh, 'local', 'CAB[1..4]', [76.2, 30.48], 'left'));
apply(E.addCableFlag(sh, sh.buses[0], [96.52, 30.48], { Cable_Type: '26AWG 4 Core', Cable_PN: 'M27500-26-SB-4-T23', Cable_Size: '26 AWG', Cable_Length: '1.2 m' }, 'a', true));
ok('bus is not split by the cable flag', sh.buses.length === 1);
// J3.1 joins CAB1 too, through a single tagged wire (daisy chain of the supply).
apply(E.addWireSegs(sh, [[[147.32, 101.6], [137.16, 101.6]]]));
apply(E.addLabel(sh, 'local', 'CAB1', [137.16, 101.6], 'left'));
const w = sh.wires.find((x) => Math.abs(x.a[1] - 101.6) < 0.01 && Math.abs(x.b[1] - 101.6) < 0.01);
apply(E.addCableFlag(sh, w, [142.24, 101.6], { Cable_Type: 'Single', Cable_PN: 'AS22759/32-22', Cable_Colour: 'Red', Cable_Length: '300 mm' }, 'a'));
// Loom fields
const syms = (refs) => sh.symbols.filter((s) => refs.includes(s.props.find((p) => p.name === 'Reference').value));
apply(E.setFieldMany(sh, syms(['J1', 'J2', 'J3']), 'Loom', '331-1A'));
if (process.env.HARNESS_OUT) require('fs').writeFileSync(process.env.HARNESS_OUT, sh.text);
let P = K.buildProject([{ path, text: sh.text }]), A = Loom.analyze(P), B = H.build(P, A);
ok('one loom found', B.looms.length === 1 && B.looms[0].name === '331-1A', B.looms.map((l) => l.name).join());
const L = B.looms[0];
ok('three parts in it', L.parts.map((e) => e.ref).join() === 'J1,J2,J3');
const wl = L.wires.map((x) => `${x.a.ref}.${x.a.number}-${x.b.ref}.${x.b.number}`);
ok('J1 to J2 on all four cores, J2.1 to J3.1', ['J1.1-J2.1', 'J1.2-J2.2', 'J1.3-J2.3', 'J1.4-J2.4', 'J2.1-J3.1'].every((x) => wl.includes(x)) && wl.length === 5, wl.join(' '));
ok('device pins are not wires', !wl.some((x) => x.includes('U1')));
const core2 = L.wires.find((x) => x.a.ref === 'J1' && x.a.number === '2');
ok('bus cable gives each member its core colour', core2 && core2.cable && /Blue/.test(core2.colour), core2 && core2.colour);
const jw = L.wires.find((x) => x.b.ref === 'J3');
ok('wire tag gives that wire its colour', jw && jw.colour === 'Red', jw && jw.colour);
ok('two cables in the cut list', L.cut.length === 2, JSON.stringify(L.cut.map((c) => [c.pn, c.length, c.ends, c.used])));
ok('total length 1.5 m', Math.abs(L.metres - 1.5) < 1e-6, L.metres);
const j1 = L.partRows.find((r) => r.ref === 'J1');
ok('J1 plugs into U1', j1 && j1.mates === 'U1', j1 && j1.mates);
ok('J2 plugs into nothing (only reached through labels)', L.partRows.find((r) => r.ref === 'J2').mates === '');
const po = L.pinouts.find((p) => p.ref === 'J2');
ok('J2 pin 1 has two wires (to J1 and J3)', po.rows[0].wires === 2, JSON.stringify(po.rows[0]));
ok('no missing-data warnings', !L.issues.length, L.issues.join(' | '));
const T = H.tables(L, { parts: true, cut: true, wires: true, pinouts: true });
ok('tables: parts, totals, cut, wires, three pin-outs', T.length === 7, T.map((t) => t.key).join());
const D = H.drawing(L, { project: 'test' });
ok('drawing has all three parts', ['J1', 'J2', 'J3'].every((r) => D.svg.includes('>' + r + '<')) && /<svg/.test(D.svg));
// J9 is not wired to the loom, U1 isn't a connector: no suggestions.
ok('no suggestions', !B.suggestions.length, B.suggestions.map((s) => s.ref).join());
// Without the bus tag the wires are loose and flagged.
apply(E.deleteItems(sh, [{ type: 'label', label: sh.labels.find((l) => l.kind === 'directive' && Math.abs(l.p[1] - 30.48) < 0.01) }]));
P = K.buildProject([{ path, text: sh.text }]); A = Loom.analyze(P);
const L2 = H.build(P, A).looms[0];
ok('untagged wires are reported', L2.loose.length === 4 && L2.issues.some((i) => /no cable details/.test(i)), L2.issues.join(' | '));
// Removing the field empties the loom.
apply(E.setFieldMany(sh, syms(['J1', 'J2', 'J3']), 'Loom', ''));
P = K.buildProject([{ path, text: sh.text }]); A = Loom.analyze(P);
ok('field removed: no looms', H.build(P, A).looms.length === 0);
console.log(fail ? fail + ' failed' : 'all passed');
process.exit(fail ? 1 : 0);
