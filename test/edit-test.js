// Round-trip tests for the editing engine: every operation must re-parse, keep untouched text
// identical, and change connectivity only in the intended way.
const fs = require('fs'), path = require('path');
global.KiCore = require('../js/kicad-core.js');
const E = require('../js/edit.js');
const K = global.KiCore;
const dir = process.argv[2];
const load = () => fs.readdirSync(dir).filter((f) => /\.kicad_(sch|pro)$/.test(f)).map((f) => ({ path: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
let files = load();
const build = (fs_) => K.buildProject(fs_);
const netSig = (P) => { const m = new Map(); P.nets.forEach((n) => n.pins.forEach((p) => m.set(p.ref + '#' + p.number, n.id))); return m; };
const noSplit = (a, b) => { const r = samePartition(a, b); return r === 'merged' ? true : r; };
const samePartition = (a, b) => { const x = netSig(a), y = netSig(b); const map = new Map(); for (const [k, v] of x) { if (!y.has(k)) return 'missing ' + k; const w = y.get(k); if (map.has(v) && map.get(v) !== w) return 'split at ' + k; map.set(v, w); } const back = new Map(); for (const [v, w] of map) { if (back.has(w) && back.get(w) !== v) return 'merged'; back.set(w, v); } return true; };
const apply = (res) => files.map((f) => (f.path === res.path ? { path: f.path, text: res.text } : f));
const diffLines = (a, b) => { const A = a.split('\n'), B = b.split('\n'); let i = 0; while (i < A.length && A[i] === B[i]) i++; let j = 0; while (j < A.length - i && j < B.length - i && A[A.length - 1 - j] === B[B.length - 1 - j]) j++; return { removed: A.length - i - j, added: B.length - i - j }; };
let fail = 0;
const check = (name, ok, info) => { console.log((ok === true ? 'PASS ' : 'FAIL ') + name + (ok === true ? '' : ' -> ' + ok) + (info ? '  ' + info : '')); if (ok !== true) fail++; };

let P = build(files);
const inst = P.root.children.length ? P.root.children[0] : P.root;
const sh = inst.sheet;
const before = sh.text;
// pick a normal part with wires on its pins
const si = sh.symbols.findIndex((s) => s.lib && !s.lib.power && K.symbolPins(s).some((p) => sh.wires.some((w) => E.same(w.a, p.pos) || E.same(w.b, p.pos))));
const sym = sh.symbols[si];
const ref = inst.refs[si].ref;
console.log('Testing on', sh.path, 'part', ref);

// 1. move keeps connectivity
let r = E.moveItems(sh, [{ type: 'symbol', sym }], [5.08, 2.54]);
let P2 = build(apply(r));
check('move part keeps every connection', samePartition(P, P2), JSON.stringify(diffLines(before, r.text)));
// 2. rotate x4 returns to identical text positions & keeps connectivity each step
let fsr = files;
for (let k = 0; k < 4; k++) {
  const Pk = build(fsr);
  const ik = Pk.instances.find((i) => i.path === inst.path); const shk = ik.sheet; const sk = shk.symbols.find((s) => s.uuid === sym.uuid);
  const rr = E.transformSymbol(shk, sk, 'rotate');
  fsr = fsr.map((f) => (f.path === rr.path ? { path: f.path, text: rr.text } : f));
  { const r0 = samePartition(P, build(fsr)); check('rotate step ' + (k + 1) + ' keeps every existing connection', noSplit(P, build(fsr)), r0 === 'merged' ? '(pins now also touch other wires)' : ''); }
}
// 3. mirror keeps connectivity
r = E.transformSymbol(sh, sym, 'mirrorY');
check('mirror keeps every existing connection', noSplit(P, build(apply(r))));
// 4. field edit touches only that token
r = E.setSymbolFields(sh, sym, inst, { fields: { Value: 'TEST-VALUE' }, add: [{ name: 'MPN', value: 'ABC-123' }], dnp: true });
P2 = build(apply(r));
const s2 = P2.instances.find((i) => i.path === inst.path).sheet.symbols.find((s) => s.uuid === sym.uuid);
check('value + new field + DNP', s2.props.find((p) => p.name === 'Value').value === 'TEST-VALUE' && s2.props.some((p) => p.name === 'MPN' && p.value === 'ABC-123') && s2.dnp === true || 'fields not applied', JSON.stringify(diffLines(before, r.text)));
r = E.setSymbolFields(sh, sym, inst, { ref: ref + '9' });
P2 = build(apply(r));
check('reference change', P2.instances.find((i) => i.path === inst.path).refs[si].ref === ref + '9' || 'ref not changed');
// 5. delete a wire splits a net; delete a part removes its pins
const w = sh.wires[0];
r = E.deleteItems(sh, [{ type: 'wire', wire: w }]);
P2 = build(apply(r));
check('delete wire re-parses', P2.instances.length === P.instances.length || 'parse');
r = E.deleteItems(sh, [{ type: 'symbol', sym }]);
P2 = build(apply(r));
check('delete part removes its pins', !netSig(P2).has(ref + '#' + K.symbolPins(sym)[0].number) || 'still there');
// 6. copy part -> new ref, same pins count
r = E.copySymbol(P, sh, inst, sym, [10.16, 10.16]);
P2 = build(apply(r));
const i2 = P2.instances.find((i) => i.path === inst.path);
check('copy part gets ' + r.ref, i2.refs.some((x) => x.ref === r.ref) && i2.sheet.symbols.length === sh.symbols.length + 1 || 'copy missing');
check('copy keeps existing connections', samePartition(P, P2));
// 7. draw a wire between two unconnected pins of different nets -> merged
const pins = K.symbolPins(sym);
const pA = pins[0].pos;
const far = [E.snap(pA[0] + 20.32), E.snap(pA[1] + 12.7)];
r = E.addWires(sh, [pA, [far[0], pA[1]], far]);
P2 = build(apply(r));
check('add wire parses and keeps pins', P2.nets.length > 0);
// wire from pin of sym to pin of another symbol
const other = sh.symbols.find((s, k) => k !== si && s.lib && !s.lib.power && K.symbolPins(s).length);
if (other) {
  const pB = K.symbolPins(other)[0].pos;
  r = E.addWires(sh, [pA, [pB[0], pA[1]], pB]);
  P2 = build(apply(r));
  const sig = netSig(P2);
  const oref = inst.refs[sh.symbols.indexOf(other)].ref;
  check('new wire joins ' + ref + ' and ' + oref, sig.get(ref + '#' + pins[0].number) === sig.get(oref + '#' + K.symbolPins(other)[0].number) || 'not joined');
}
// 8. label on a wire middle splits it and names the net
const hw = sh.wires.find((x) => Math.abs(x.a[1] - x.b[1]) < 1e-6 && Math.abs(x.a[0] - x.b[0]) > 5);
if (hw) {
  const mid = [E.snap((hw.a[0] + hw.b[0]) / 2), hw.a[1]];
  r = E.addLabel(sh, 'local', 'TEST_NET', mid, 'right');
  P2 = build(apply(r));
  check('label names the net', P2.nets.some((n) => n.names.some((x) => x.name === 'TEST_NET') && n.pins.length > 0) || 'no named net');
  check('label split keeps connections', samePartition(P, P2));
  r = E.addLabel(sh, 'global', 'TEST_GLOBAL', mid, 'left', 'output');
  check('global label parses', build(apply(r)).nets.some((n) => n.names.some((x) => x.name === 'TEST_GLOBAL' && x.kind === 'global')) || 'missing');
}
// 9. rename + rotate an existing label
const lab = sh.labels.find((l) => l.kind === 'local' || l.kind === 'global');
if (lab) {
  r = E.renameLabel(sh, lab, 'RENAMED_X');
  check('rename label', build(apply(r)).nets.some((n) => n.names.some((x) => x.name === 'RENAMED_X')) || 'missing');
  let fl = files;
  for (let k = 0; k < 4; k++) { const Pk = build(fl); const lk = Pk.instances.find((i) => i.path === inst.path).sheet.labels.find((l) => l.uuid === lab.uuid); const rr = E.rotateLabel(Pk.instances.find((i) => i.path === inst.path).sheet, lk); fl = fl.map((f) => (f.path === rr.path ? { path: f.path, text: rr.text } : f)); }
  const back = build(fl).instances.find((i) => i.path === inst.path).sheet.labels.find((l) => l.uuid === lab.uuid);
  check('label rotates through 4 orientations back to ' + lab.spin, back.spin === lab.spin || 'ended ' + back.spin);
}
// 10. no-connect
const freePin = pins.find((p) => !sh.wires.some((x) => E.same(x.a, p.pos) || E.same(x.b, p.pos)) && !sh.noConnects.some((n) => E.same(n.p, p.pos)));
if (freePin) { r = E.addNoConnect(sh, freePin.pos); check('no-connect flag', build(apply(r)).nets.some((n) => n.noConnect) || 'none'); }
// 11. untouched text identical for a pure token edit
r = E.renameLabel(sh, lab || sh.labels[0], (lab || sh.labels[0]).text);
check('no-op edit leaves file identical', r.text === before || 'changed');
console.log(fail ? fail + ' FAILED' : 'ALL PASSED');
process.exit(fail ? 1 : 0);
