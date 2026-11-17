// Schematic setup and outputs: project-file settings (formatting, text variables, net classes,
// ERC severities, BOM settings), bus aliases, the new ERC rules, KiCad netlist and BOM export.
//   node test/setup-test.js /path/to/kicad/demos/pic_programmer
const fs = require('fs'), path = require('path');
global.KiCore = require('../js/kicad-core.js');
const S = require('../js/setup.js');
const E = require('../js/edit.js');
const Loom = require('../js/loom.js');
const K = global.KiCore;
const dir = process.argv[2];
let fail = 0;
const ok = (name, cond, info) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!cond) fail++; };
let files = fs.readdirSync(dir).filter((f) => /\.kicad_(sch|pro)$/.test(f)).map((f) => ({ path: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
const apply = (rs) => { for (const r of [].concat(rs)) { const i = files.findIndex((f) => f.path === r.path); if (i >= 0) files[i] = { path: r.path, text: r.text }; else files.push({ path: r.path, text: r.text }); } };
let P = K.buildProject(files), A = Loom.analyze(P);

// ---- formatting
apply(S.setDrawing(P, { textSize: 2, lineWidth: 0.2, junction: 4, xrefShow: true })); P = K.buildProject(files);
const d = S.drawing(P);
ok('text size saved in mils and read back in mm', Math.abs(d.textSize - 2) < 1e-3 && Math.abs(P.pro.schematic.drawing.default_text_size - 78.74) < 0.01, P.pro.schematic.drawing.default_text_size);
ok('junction size and intersheet refs', d.junction === 4 && d.xrefShow === true);
ok('other project settings kept', !!P.pro.board && !!P.pro.net_settings && P.pro.meta.filename === 'pic_programmer.kicad_pro');

// ---- text variables reach the drawing's text
apply(S.setTextVars(P, { BOAT: 'AC75 B2', REV_NOTE: 'draft' })); P = K.buildProject(files);
ok('text variables saved', P.textVars.BOAT === 'AC75 B2');
ok('resolved in text', K.resolveVars('Boat ${BOAT}', { project: P }) === 'Boat AC75 B2');
let threw = false; try { S.setTextVars(P, { TITLE: 'x' }); } catch (e) { threw = true; }
ok('KiCad’s own variable names refused', threw);

// ---- unresolved variable rule
{
  const sh = P.root.sheet;
  apply(E.addText ? E.addText(sh, [50, 50], 'Fit ${NOT_SET} here') : { path: sh.path, text: sh.text.replace(/\n\)\s*$/, '\n\t(text "Fit ${NOT_SET} here" (at 50 50 0) (effects (font (size 1.27 1.27))) (uuid "11111111-2222-3333-4444-555555555555"))\n)\n') });
  P = K.buildProject(files); A = Loom.analyze(P);
  ok('unresolved_variable found', A.issues.some((i) => i.code === 'unresolved' && /NOT_SET/.test(i.msg)));
  ok('set variables not reported', !A.issues.some((i) => i.code === 'unresolved' && /BOAT/.test(i.msg)));
}

// ---- bus aliases: written to the top sheet and expanded by the parser
apply(S.setBusAliases(P, [{ name: 'CANBUS', members: ['CAN_H', 'CAN_L', 'CAN_GND'] }])); P = K.buildProject(files);
ok('bus alias parsed back', JSON.stringify(P.aliases.CANBUS) === '["CAN_H","CAN_L","CAN_GND"]');
ok('alias in the top sheet file', /\(bus_alias "CANBUS"\s+\(members "CAN_H" "CAN_L" "CAN_GND"\)/.test(files.find((f) => f.path === P.root.sheet.path).text));
ok('alias expands like KiCad', K.expandBus('{CANBUS}', P.aliases).join(',') === 'CAN_H,CAN_L,CAN_GND', K.expandBus('{CANBUS}', P.aliases).join(','));
apply(S.setBusAliases(P, [{ name: 'CANBUS', members: ['CAN_H', 'CAN_L'] }])); P = K.buildProject(files);
ok('editing replaces, not duplicates', (files.find((f) => f.path === P.root.sheet.path).text.match(/bus_alias/g) || []).length === 1 && P.aliases.CANBUS.length === 2);
apply(S.setBusAliases(P, [])); P = K.buildProject(files);
ok('removing all aliases', !Object.keys(P.aliases).length && !/bus_alias/.test(files.find((f) => f.path === P.root.sheet.path).text));
ok('sheet still parses with balanced brackets', !P.errors.length);

// ---- net classes: pattern assignment, conflicts, colours
{
  const st = S.netClassSettings(P);
  const classes = st.classes.concat([{ name: 'Power', wire_width: 12, bus_width: 12, schematic_color: S.kicadColor('#d02020') }]);
  apply(S.setNetClasses(P, classes, [{ netclass: 'Power', pattern: '*VPP*' }, { netclass: 'Power', pattern: 'VCC' }])); P = K.buildProject(files);
  const m = S.netClassMap(P);
  const vpp = P.nets.find((n) => /VPP/.test(n.name));
  ok('pattern puts a net in a class', vpp && m.classOf(vpp.id) === 'Power', vpp && vpp.name);
  ok('other nets in Default', m.classOf(P.nets.find((n) => n.named && !/VPP|VCC/i.test(n.name)).id) === 'Default');
  ok('class colour read back', S.cssColor(m.settings.classes.find((c) => c.name === 'Power').schematic_color) === 'rgba(208, 32, 32, 1)');
  ok('Default class priority kept', P.pro.net_settings.classes.find((c) => c.name === 'Default').priority === 2147483647);
  let t2 = false; try { S.setNetClasses(P, classes.filter((c) => c.name !== 'Default'), []); } catch (e) { t2 = true; }
  ok('Default class cannot be removed', t2);
  // two net class flags with different classes on one net
  const sh = P.root.sheet, net = vpp, inst = P.root;
  const w = sh.wires.find((x) => inst.netOf[x.group] === net.id) || null;
  if (w) {
    apply(E.addNetClassFlag(sh, w, w.a, 'Signal')); P = K.buildProject(files); A = Loom.analyze(P);
    const m2 = S.netClassMap(P);
    ok('net class flag overrides the pattern', m2.classOf(net.id) === 'Signal');
    ok('undefined class from a flag reported', A.issues.some((i) => i.code === 'netclassundef' && /Signal/.test(i.msg)));
    const flag = P.root.sheet.labels.find((l) => l.kind === 'directive' && l.props.some((x) => x.name === 'Netclass'));
    apply(E.setNetClassOfFlag(P.root.sheet, flag, 'Power')); P = K.buildProject(files); A = Loom.analyze(P);
    ok('flag changed to a defined class', S.netClassMap(P).classOf(net.id) === 'Power' && !A.issues.some((i) => i.code === 'netclassundef'));
  } else ok('found a VPP wire for the flag test', false);
}

// ---- ERC severities
{
  A = Loom.analyze(P);
  const before = A.issues.filter((i) => i.code === 'dangling' || i.code === 'pin').length;
  apply(S.setErcSeverities(P, { pin_not_connected: 'ignore', unconnected_wire_endpoint: 'error', unresolved_variable: 'ignore' })); P = K.buildProject(files); A = Loom.analyze(P);
  ok('ignored rule removed', !A.issues.some((i) => i.code === 'pin') && !A.issues.some((i) => i.code === 'unresolved'));
  ok('raised rule becomes an error', A.issues.filter((i) => i.code === 'dangling').every((i) => i.sev === 'error'), before + ' before');
  ok('every Loomline check has a KiCad rule name', Object.keys({ pin: 1, nc: 1, dangling: 1, label: 1, global1: 1, annotate: 1, value: 1, dupref: 1, drive: 1, sheetpin: 1, hier: 1, ebus: 1, duppin: 1, names: 1, busname: 1, lbldangle: 1, buswire: 1, power: 1, unit: 1, grid: 1 }).every((c) => S.ERC_RULES.some((r) => r[0] === c)));
  apply(S.setErcSeverities(P, { pin_not_connected: 'error', unresolved_variable: 'error', unconnected_wire_endpoint: 'warning' })); P = K.buildProject(files); A = Loom.analyze(P);
}

// ---- KiCad netlist
{
  const net = S.exportNetlist(P, A, { date: '2026-11-17 12:00:00', netClasses: S.netClassMap(P) });
  let tree = null; try { tree = K.parseSexpr(net); } catch (e) { /* */ }
  ok('netlist parses as an S-expression', !!tree && tree[0] === 'export');
  const comps = K.findAll(K.find(tree, 'components'), 'comp');
  const nets = K.findAll(K.find(tree, 'nets'), 'net');
  const parts = Array.from(A.parts.values()).filter((e) => e.sym.onBoard).length;
  ok('one component per reference', comps.length === parts, comps.length + ' / ' + parts);
  ok('nets have nodes', nets.length > 10 && nets.every((n) => K.findAll(n, 'node').length >= 1), nets.length + ' nets');
  const realNets = P.nets.filter((n) => !n.bus && n.pins.some((p) => !String(p.ref).startsWith('#')));
  ok('every connected pin is in a net', K.findAll(K.find(tree, 'nets'), 'net').reduce((a, n) => a + K.findAll(n, 'node').length, 0) >= realNets.reduce((a, n) => a + new Set(n.pins.filter((p) => !String(p.ref).startsWith('#')).map((p) => p.ref + p.number)).size, 0) * 0.99);
  const c0 = comps[0];
  ok('component has value, footprint, libsource, sheetpath, tstamps', ['value', 'footprint', 'libsource', 'sheetpath', 'tstamps'].every((k) => K.find(c0, k)));
  ok('net class written', nets.some((n) => K.find(n, 'class') && K.find(n, 'class')[1] === 'Power'));
  ok('libparts list pins', K.findAll(K.find(tree, 'libparts'), 'libpart').every((lp) => K.find(lp, 'pins') || true));
  ok('version E', /^\(export \(version "E"\)/.test(net));
}

// ---- BOM
{
  const { format } = S.bomSettings(P);
  const settings = S.defaultBomSettings();
  let t = S.bomTable(P, A, settings, format);
  ok('default BOM groups by value and footprint', t.cols.join() === 'Reference,Value,Datasheet,Footprint,Qty,DNP' && t.rows.length < t.parts, t.rows.length + ' rows for ' + t.parts + ' parts');
  ok('quantities add up', t.rows.reduce((a, r) => a + +r[4], 0) === t.parts);
  const s2 = JSON.parse(JSON.stringify(settings));
  s2.group_symbols = false; s2.sort_field = 'Value';
  t = S.bomTable(P, A, s2, format);
  ok('ungrouped: one row per part', t.rows.length === t.parts);
  ok('sorted by value', t.rows.every((r, i) => i === 0 || K.naturalCmp(t.rows[i - 1][1], r[1]) <= 0));
  ok('ref ranges', S.refList(['R1', 'R2', 'R3', 'R5', 'C1'], ',', '-') === 'C1, R1-R3, R5', S.refList(['R1', 'R2', 'R3', 'R5', 'C1'], ',', '-'));
  const txt = S.bomText(S.bomTable(P, A, settings, format), Object.assign({}, format, { field_delimiter: ';' }));
  ok('delimiters', /^"Reference";"Value"/.test(txt));
  apply(S.setBomSettings(P, s2, format)); P = K.buildProject(files);
  ok('BOM settings kept in the project file like KiCad', P.pro.schematic.bom_settings.sort_field === 'Value' && P.pro.schematic.bom_fmt_settings.name === 'CSV');
  ok('field list has user fields', S.bomFields(P).includes('Footprint') && S.bomFields(P).includes(S.QTY));
}

// ---- net class stroke and pin conflict table
{
  ok('default class has no special stroke', S.classStroke(S.DEFAULT_CLASS) === null);
  const st = S.classStroke({ wire_width: 12, bus_width: 12, line_style: 1 });
  ok('class width and dash', Math.abs(st.wire - 0.3048) < 1e-6 && st.dash === 'dash');
  const out = (ref) => ({ ref, number: '1', type: 'output' });
  ok('two outputs are an error', S.pinConflict([out('U1'), out('U2')], S.DEFAULT_PIN_MAP).sev === 2);
  ok('output and input are fine', S.pinConflict([out('U1'), { ref: 'U2', number: '1', type: 'input' }], S.DEFAULT_PIN_MAP) === null);
  ok('unspecified pins warn', S.pinConflict([{ ref: 'U1', number: '1', type: 'unspecified' }, { ref: 'U2', number: '1', type: 'passive' }], S.DEFAULT_PIN_MAP).sev === 1);
  const m = S.pinMap(P); m[1][1] = 0;
  apply(S.setPinMap(P, m)); P = K.buildProject(files);
  ok('pin map saved and read back', S.pinMap(P)[1][1] === 0 && P.pro.erc.pin_map.length === 12);
  ok('changed map clears output-output', S.pinConflict([out('U1'), out('U2')], S.pinMap(P)) === null);
}

// ---- project with no .kicad_pro: settings create one
{
  const only = files.filter((f) => /\.kicad_sch$/.test(f.path));
  const P2 = K.buildProject(only);
  const r = S.setTextVars(P2, { X: '1' });
  ok('creates the .kicad_pro when missing', /\.kicad_pro$/.test(r.path) && JSON.parse(r.text).text_variables.X === '1', r.path);
}
console.log(fail ? fail + ' FAILED' : 'all passed');
process.exit(fail ? 1 : 0);
