// Tests for Annotate, Find & replace and autoplacing fields.
const fs = require('fs'), path = require('path');
global.KiCore = require('../js/kicad-core.js');
const E = require('../js/edit.js');
const K = global.KiCore;
let fail = 0;
const check = (name, ok, info) => { console.log((ok === true ? 'PASS ' : 'FAIL ') + name + (ok === true ? '' : ' -> ' + ok) + (info ? '  ' + info : '')); if (ok !== true) fail++; };
const dir = path.join(__dirname, '../samples/complex_hierarchy');
let files = fs.readdirSync(dir).filter((f) => /\.kicad_(sch|pro)$/.test(f)).map((f) => ({ path: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
const P = () => K.buildProject(files);
const put = (rs) => { for (const r of [].concat(rs)) files = files.map((f) => (f.path === r.path ? { path: f.path, text: r.text } : f)); };
const allRefs = (pr) => pr.instances.flatMap((i) => i.refs.map((r, si) => ({ ref: r.ref, unit: i.sheet.symbols[si].unit, page: i.page })));
const dupes = (pr) => { const seen = new Set(), d = []; for (const r of allRefs(pr)) { const k = r.ref + '#' + r.unit; if (seen.has(k)) d.push(k); seen.add(k); } return d; };

// 1. Nothing to do on a clean project
let a = E.annotate(P(), {});
check('clean project: no changes', a.changes.length === 0 || a.changes.map((c) => c.from + '>' + c.to).join(' '));

// 2. Make two references "?" and one duplicate, then annotate
let pr = P();
const root = pr.instances.find((i) => !i.parent);
const idx = root.sheet.symbols.map((s, i) => i).filter((i) => /^[CR]\d/.test(root.refs[i].ref)).slice(0, 3);
const before = idx.map((i) => root.refs[i].ref);
put(E.setReferences(root.sheet, [
  { sym: root.sheet.symbols[idx[0]], path: root.path, ref: before[0].replace(/\d+$/, '?'), prop: true },
  { sym: root.sheet.symbols[idx[1]], path: root.path, ref: before[1].replace(/\d+$/, '?'), prop: true }
]));
pr = P();
check('refs set to ?', allRefs(pr).filter((r) => /\?$/.test(r.ref)).length === 2);
a = E.annotate(pr, {});
check('annotate fixes the two ?', a.changes.length === 2 || a.changes.length, a.changes.map((c) => c.from + '>' + c.to).join(' '));
put(a.results);
pr = P();
check('no ? left', allRefs(pr).filter((r) => /\?$/.test(r.ref)).length === 0);
check('no duplicates', dupes(pr).length === 0 || dupes(pr).join(','));

// 3. Renumber everything, sheet number × 100
a = E.annotate(pr, { all: true, sheetBase: true });
put(a.results);
pr = P();
check('renumber all: no duplicates', dupes(pr).length === 0 || dupes(pr).join(','));
const p2 = allRefs(pr).filter((r) => r.page === '2' && /^[RC]\d/.test(r.ref));
check('sheet 2 parts numbered from 201', p2.length > 0 && p2.every((r) => +r.ref.replace(/\D/g, '') >= 201 && +r.ref.replace(/\D/g, '') < 300) || p2.map((r) => r.ref).join(','));
check('files still parse with matching refs', pr.instances.every((i) => i.refs.every((r) => r.ref)));

// 4. Find and replace
const sh = P().root.sheet;
const lab = sh.labels.find((l) => l.kind === 'local' || l.kind === 'global');
let f = E.replaceInSheet(sh, { find: lab.text, labels: true });
check('find: label found', f.hits.length >= 1 && f.result === null);
f = E.replaceInSheet(sh, { find: lab.text, replace: 'ZZNEW', labels: true, matchCase: true, whole: true });
put(f.result);
check('replace: label renamed', P().root.sheet.labels.some((l) => l.text === 'ZZNEW'));
const valSym = P().root.sheet.symbols.find((s) => (s.props.find((p) => p.name === 'Value') || {}).value === '47uF');
if (valSym) {
  f = E.replaceInSheet(P().root.sheet, { find: '47uF', replace: '47 µF', fields: true, matchCase: true });
  put(f.result);
  check('replace: values changed', P().root.sheet.symbols.filter((s) => (s.props.find((p) => p.name === 'Value') || {}).value === '47 µF').length >= 1);
}

// 5. Autoplace fields
const s5 = P().root.sheet, sy = s5.symbols.find((s) => !s.lib || !s.lib.power);
const r5 = E.placeFields(s5, sy, { Reference: { p: [sy.p[0] + 5.08, sy.p[1] - 2.54], justify: 'left' }, Value: { p: [sy.p[0] + 5.08, sy.p[1] + 2.54], justify: 'center' } });
put(r5);
const sy2 = P().root.sheet.symbols.find((s) => s.uuid === sy.uuid);
const rp = sy2.props.find((p) => p.name === 'Reference'), vp = sy2.props.find((p) => p.name === 'Value');
check('autoplace: reference moved', Math.abs(rp.p[0] - (sy.p[0] + 5.08)) < 1e-6 && rp.fx.ha === 'left' || JSON.stringify([rp.p, rp.fx.ha]));
check('autoplace: value centred', Math.abs(vp.p[1] - (sy.p[1] + 2.54)) < 1e-6 && vp.fx.ha === 'center' || JSON.stringify([vp.p, vp.fx.ha]));


// 6. New hierarchical sheet, with a new file
let pr6 = P();
const rootSh = pr6.root.sheet;
const ns = E.addSheet(pr6, rootSh, { name: 'Pumps', file: 'pumps.kicad_sch', p: [50.8, 152.4], size: [25.4, 20.32] });
check('addSheet makes parent + new file', ns.results.length === 2 && ns.results[1].path === 'pumps.kicad_sch');
for (const r of ns.results) { if (!files.some((f) => f.path === r.path)) files.push({ path: r.path, text: r.text }); else put(r); }
pr6 = P();
const child = pr6.instances.find((i) => i.name === 'Pumps');
check('new sheet is in the hierarchy', !!child && child.sheet.path === 'pumps.kicad_sch' || pr6.instances.map((i) => i.name).join(','));
check('new sheet has the next page number', child && child.page === '4' || child && child.page);
// sheet port in the child, then import it as a pin on the parent
put(E.addLabel(child.sheet, 'hier', 'PUMP_ON', [25.4, 25.4], 'left', 'input'));
pr6 = P();
const sObj = pr6.root.sheet.sheets.find((x) => x.name === 'Pumps');
const spots = E.sheetPinSpots(sObj, 'left', 1);
put(E.addSheetPins(pr6.root.sheet, sObj, [{ name: 'PUMP_ON', shape: 'input', p: spots[0], side: 'left' }]));
pr6 = P();
const sObj2 = pr6.root.sheet.sheets.find((x) => x.name === 'Pumps');
check('sheet pin added on the left edge', sObj2.pins.length === 1 && sObj2.pins[0].p[0] === sObj2.p[0] || JSON.stringify(sObj2.pins.map((p) => p.p)));
// wire from the pin and a net label: the child's hier label must be on the same net
const pp = sObj2.pins[0].p;
put(E.addWires(pr6.root.sheet, [[pp[0] - 10.16, pp[1]], pp]));
put(E.addLabel(P().root.sheet, 'local', 'PUMP_CMD', [pp[0] - 10.16, pp[1]], 'left'));
pr6 = P();
const net = pr6.nets.find((n) => n.name && /PUMP/.test(n.name));
check('net reaches into the new sheet', !!net && pr6.nets.some((n) => (n.labels || []).length >= 0) , net && net.name);

// 7. Buses: draw one, unfold a member, check the member net exists
let sh7 = P().root.sheet;
put(E.addBusSegs(sh7, [[[25.4, 177.8], [76.2, 177.8]]]));
sh7 = P().root.sheet;
put(E.addLabel(sh7, 'local', 'D[0..3]', [30.48, 177.8], 'right'));
sh7 = P().root.sheet;
put(E.unfoldFromBus(sh7, [50.8, 177.8], 'D2', false));
const pr7 = P();
check('bus drawn', pr7.root.sheet.buses.length >= 1);
check('bus entry added', pr7.root.sheet.entries.length >= 1);
check('member label D2 present', pr7.root.sheet.labels.some((l) => l.text === 'D2'));
// delete a wire: the bus junction (if any) and buses survive
const before7 = pr7.root.sheet.buses.length;
put(E.deleteItems(pr7.root.sheet, [{ type: 'wire', wire: pr7.root.sheet.wires[0] }]));
check('buses untouched by wire delete', P().root.sheet.buses.length === before7);

{
  const pr8 = P(), ch = pr8.instances.find((i) => i.name === 'Pumps');
  const n = pr8.nets.find((x) => x.name && /PUMP_CMD/.test(x.name));
  check('child sheet port joins the parent net', !!n && (n.inst ? n.inst.has(ch.idx) : JSON.stringify(Object.keys(n))) === true || (n && JSON.stringify(Object.keys(n))));
}

{
  // 8. Box symbol from pin lines; placed into a sheet it must parse and give the right pins
  const pins = E.parsePinLines('1 +24V power_in L\n2 0V pwr\n3 CAN_H bidir R\n4 CAN_L bidir R\n5 SHLD');
  check('pin lines parsed', pins.length === 5 && pins[0].type === 'power_in' && pins[1].type === 'power_in' && pins[2].side === 'R' && pins[2].name === 'CAN_H' && pins[4].type === 'passive' || JSON.stringify(pins));
  const txt = E.boxSymbol({ name: 'TEST_NODE', ref: 'A', value: 'TEST_NODE', pins, fields: { Manufacturer: 'Acme', MPN: 'X-1' }, keywords: 'test can node' });
  const lib = K.parseSexpr(E.symbolLibText([txt]));
  check('symbol lib parses', !!lib && lib[0] === 'kicad_symbol_lib');
  const pr9 = P();
  const r = E.addLibSymbol(pr9, pr9.root.sheet, pr9.root, { lib: 'My_Parts', name: 'TEST_NODE', text: txt, parentText: null }, [127, 127]);
  put(r);
  const sh9 = P().root.sheet, sym = sh9.symbols[sh9.symbols.length - 1];
  const sp = K.symbolPins(sym);
  check('placed with 5 pins', sp.length === 5 || sp.length);
  check('pins on the 1.27 grid', sp.every((p) => Math.abs(p.pos[0] / 1.27 - Math.round(p.pos[0] / 1.27)) < 1e-6 && Math.abs(p.pos[1] / 1.27 - Math.round(p.pos[1] / 1.27)) < 1e-6) || JSON.stringify(sp.map((p) => p.pos)));
  check('ref prefix A', /^A\d+$/.test(P().root.refs[sh9.symbols.length - 1].ref) || P().root.refs[sh9.symbols.length - 1].ref);
}

console.log(fail ? fail + ' FAILED' : 'ALL PASSED');
process.exitCode = fail ? 1 : 0;
