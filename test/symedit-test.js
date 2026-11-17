// Symbol editor model: KiCad library symbols read, edited and written back.
//   node test/symedit-test.js /path/to/kicad-symbols
const fs = require('fs'), path = require('path');
global.KiCore = require('../js/kicad-core.js');
const S = require('../js/symedit.js');
const E = require('../js/edit.js');
const K = global.KiCore;
const src = process.argv[2];
let fail = 0;
const ok = (name, cond, info) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!cond) fail++; };
const libSym = (lib, name) => {
  const text = fs.readFileSync(path.join(src, lib + '.kicad_sym'), 'utf8');
  const root = K.parseSexpr(text, true);
  const n = root.find((x) => Array.isArray(x) && x[0] === 'symbol' && x[1] === name);
  return text.slice(n.s, n.e);
};
// the symbol, flattened onto its parent when it extends one (as the editor gets it)
const parentOf = (lib, t) => { const m = /\(extends "([^"]+)"\)/.exec(t); return m ? libSym(lib, m[1]) : null; };
// what the schematic sees: units, pins (number, type, position, angle) and graphics count per unit/style
const sig = (text) => {
  const sch = `(kicad_sch (version 20231120) (generator "t") (uuid "00000000-0000-0000-0000-000000000001") (paper "A4") (lib_symbols (symbol "L:X"${text.replace(/^\(symbol "[^"]*"/, '')}))`;
  const sh = K.parseSchematic(sch, 't.kicad_sch');
  const L = sh.libSymbols['L:X'];
  const out = { units: L.unitCount, items: [] };
  for (const u of L.units) for (const it of u.items) out.items.push([u.unit, u.style, it.t, it.t === 'pin' ? [it.number, it.type, it.p.map((v) => Math.round(v * 1000)), it.a, it.len, it.name, it.shape] : '']);
  out.items.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
  return JSON.stringify(out);
};
// ---- round trips through the model keep what KiCad draws
for (const [lib, name] of [['Device', 'R'], ['Relay', 'G5V-1'], ['Amplifier_Operational', 'LM358'], ['74xx', '74LS00'], ['MCU_ST_STM32F1', 'STM32F103C8Tx'], ['Connector', 'Conn_01x04_Pin'], ['power', 'GND'], ['Switch', 'SW_DPDT_x2'], ['Transistor_BJT', 'BC547'], ['Interface_CAN_LIN', 'MCP2551-I-P']]) {
  let t; try { t = libSym(lib, name); } catch (e) { ok(`${lib}:${name} found`, false); continue; }
  let m, back;
  const par = parentOf(lib, t);
  try { m = S.parse(t, par); back = S.serialize(m); if (par) t = par; } catch (e) { ok(`${lib}:${name} round trip`, false, e.message); continue; }
  const same = sig(t) === sig(back);
  ok(`${lib}:${name} round trip keeps units, pins and graphics`, same, same ? `${m.units} unit(s), ${S.pinCount(m)} pins${m.deMorgan ? ', De Morgan' : ''}` : sig(t).slice(0, 300) + '\n   vs ' + sig(back).slice(0, 300));
}
// ---- fields survive
{
  const t0 = libSym('Relay', 'G5V-1'); const m = S.parse(t0, parentOf('Relay', t0));
  const t = S.serialize(m);
  ok('reference, value, description, footprint kept', /\(property "Reference" "K"/.test(t) && /\(property "Value" "G5V-1"/.test(t) && /\(property "Footprint" "Relay_THT:Relay_SPDT_Omron_G5V-1"/.test(t) && /property "Description"/.test(t));
  ok('keywords and footprint filters kept', /ki_keywords/.test(t) && /ki_fp_filters/.test(t));
}
// ---- alternate pin functions survive
{
  let t = libSym('MCU_ST_STM32F1', 'STM32F103C8Tx');
  const m = S.parse(t, parentOf('MCU_ST_STM32F1', t)); t = parentOf('MCU_ST_STM32F1', t) || t;
  const withAlts = m.items.filter((i) => i.t === 'pin' && i.alts.length);
  ok('alternate pin functions read', withAlts.length > 10, withAlts.length + ' pins with alternates');
  const back = S.serialize(m);
  ok('alternate pin functions written', (back.match(/\(alternate /g) || []).length === (t.match(/\(alternate /g) || []).length);
}
// ---- build a part from nothing: two units, De Morgan, every pin type and shape
{
  const m = S.blank('VALVE_DRIVER');
  m.ref = 'U'; m.units = 2; m.deMorgan = true; m.interchangeable = false;
  m.items.push({ t: 'rect', a: [-5.08, 5.08], b: [5.08, -5.08], w: 0.254, fill: 'background', unit: 0, style: 1 });
  m.items.push({ t: 'circle', c: [0, 0], r: 2.54, w: 0.254, fill: 'none', unit: 0, style: 2 });
  m.items.push({ t: 'arc', a: [-2.54, 0], m: [0, 2.54], b: [2.54, 0], w: 0, fill: 'none', unit: 1, style: 0 });
  m.items.push({ t: 'poly', pts: [[-2.54, -2.54], [0, -1.27], [2.54, -2.54]], w: 0, fill: 'outline', unit: 2, style: 0 });
  m.items.push({ t: 'text', s: 'DRV', p: [0, 3.81], angle: 0, size: 1.27, unit: 0, style: 0 });
  S.PIN_TYPES.forEach((ty, i) => m.items.push({ t: 'pin', type: ty, shape: S.PIN_SHAPES[i % S.PIN_SHAPES.length], p: [-7.62, r(3.81 - i * 2.54 / 2)], angle: 0, len: 2.54, name: 'P' + i, num: String(i + 1), unit: i < 6 ? 1 : 2, style: 0, hide: false, alts: i === 0 ? [{ name: 'PWM', type: 'output', shape: 'line' }] : [] }));
  function r(v) { return Math.round(v / 1.27) * 1.27; }
  // fix positions onto the grid and away from each other
  m.items.filter((i) => i.t === 'pin').forEach((p, k) => { p.p = [-7.62, 5.08 - (k % 6) * 2.54]; if (k >= 6) { p.p = [7.62, 5.08 - (k - 6) * 2.54]; p.angle = 180; } });
  const probs = S.check(m);
  ok('new part passes its checks', !probs.length, probs.join('; '));
  const t = S.serialize(m);
  const lib = E.symbolLibText([t]);
  let tree = null; try { tree = K.parseSexpr(lib); } catch (e) { /* */ }
  ok('library file parses', !!tree && tree[0] === 'kicad_symbol_lib');
  const again = S.parse(t);
  ok('read back: 2 units, De Morgan, 12 pins', again.units === 2 && again.deMorgan && S.pinCount(again) === 12);
  ok('every pin type kept', S.PIN_TYPES.every((ty) => again.items.some((i) => i.t === 'pin' && i.type === ty)));
  ok('pin shapes kept', again.items.some((i) => i.t === 'pin' && i.shape === 'clock') && again.items.some((i) => i.t === 'pin' && i.shape === 'inverted'));
  ok('units locked (not interchangeable)', /ki_locked/.test(t) && again.interchangeable === false);
  ok('De Morgan sub-symbols written', /"VALVE_DRIVER_0_1"/.test(t) && /"VALVE_DRIVER_0_2"/.test(t) && /"VALVE_DRIVER_1_0"/.test(t));
  ok('alternate written', /\(alternate "PWM" output line\)/.test(t));
  // place it in a schematic and check the pins land on the grid
  const P0 = K.buildProject([{ path: 'a.kicad_sch', text: '(kicad_sch (version 20231120) (generator "t") (uuid "00000000-0000-0000-0000-000000000002") (paper "A4") (lib_symbols) (sheet_instances (path "/" (page "1"))))' }]);
  const r1 = E.addLibSymbol(P0, P0.root.sheet, P0.root, { lib: 'My_Parts', name: 'VALVE_DRIVER', text: t, parentText: null }, [50.8, 50.8]);
  const P1 = K.buildProject([{ path: 'a.kicad_sch', text: r1.text }]);
  const sym = P1.root.sheet.symbols[0];
  ok('placed in a schematic', sym && K.symbolPins(sym).length === 6, sym && K.symbolPins(sym).length + ' pins on unit A');
  ok('placed pins on the grid', K.symbolPins(sym).every((p) => p.pos.every((v) => Math.abs(v / 1.27 - Math.round(v / 1.27)) < 1e-6)));
}
// ---- checks catch mistakes
{
  const m = S.blank('X');
  m.items.push({ t: 'pin', type: 'input', shape: 'line', p: [0, 0], angle: 0, len: 2.54, name: 'A', num: '1', unit: 0, style: 0, alts: [] });
  m.items.push({ t: 'pin', type: 'input', shape: 'line', p: [0, -2.54], angle: 0, len: 2.54, name: 'B', num: '1', unit: 0, style: 0, alts: [] });
  m.items.push({ t: 'pin', type: 'input', shape: 'line', p: [0.5, -5.08], angle: 0, len: 2.54, name: 'C', num: '3', unit: 0, style: 0, alts: [] });
  const probs = S.check(m);
  ok('duplicate pin number found', probs.some((x) => /used twice/.test(x)));
  ok('off-grid pin found', probs.some((x) => /off the 1.27/.test(x)));
}
// ---- editing helpers
{
  const pin = { t: 'pin', type: 'input', shape: 'line', p: [-7.62, 2.54], angle: 0, len: 2.54, name: 'IN1', num: '3', unit: 0, style: 0, alts: [] };
  const n = S.nextPin(pin);
  ok('repeat pin steps down and counts up', n.p[1] === 0 && n.num === '4' && n.name === 'IN2');
  const m = { items: [pin] };
  ok('hit a pin', S.hitTest(m, [-6.5, 2.6], 0.6) === 0 && S.hitTest(m, [3, 3], 0.6) === -1);
  const c = S.clone(pin); S.rotateItem(c, [0, 0]);
  ok('rotate a pin', c.angle === 90 && c.p[0] === -2.54 && c.p[1] === -7.62, JSON.stringify(c.p));
  const box = S.boxFrom(S.blank('BOX'), E.parsePinLines('1 A input L\n2 B output R'), E);
  ok('box from a pin list', box.items.filter((i) => i.t === 'pin').length === 2 && box.items.some((i) => i.t === 'rect'));
}
console.log(fail ? fail + ' FAILED' : 'all passed');
process.exit(fail ? 1 : 0);
