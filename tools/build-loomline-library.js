// Builds Loomline's own symbol libraries (drawn to IEC 60617 conventions) and adds them to the
// app's part index.
//   node tools/build-loomline-library.js
// Writes library/loomline/<Lib>.kicad_sym (open these in KiCad on the desktop too) and
// library/loomline/<lib>.json (the same symbols for the app), and updates library/index.json.
const fs = require('fs'), path = require('path');
const out = path.join(__dirname, '..', 'library');
const VERSION = 20231120; // KiCad 8 symbol library format: opens in KiCad 8 and 9
const q = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const f = (v) => { const r = Math.round(v * 10000) / 10000; return String(Object.is(r, -0) ? 0 : r); };
const font = (size, extra) => `(effects (font (size ${size} ${size})${extra && extra.bold ? ' (bold yes)' : ''})${extra && extra.justify ? ` (justify ${extra.justify})` : ''}${extra && extra.hide ? ' (hide yes)' : ''})`;
const prop = (name, value, x, y, opts) => `(property ${q(name)} ${q(value)} (at ${f(x)} ${f(y)} 0) ${font(opts && opts.size || 1.27, opts)})`;

// ---- Beckhoff EtherCAT terminals: a box with one pin per terminal point, numbered as on the terminal
const TYPE_TEXT = { COUPLER: 'EtherCAT coupler', SUPPLY: 'Power supply', DI: 'Digital in', DO: 'Digital out', DIO: 'Digital in/out', RELAY: 'Relay out', AI: 'Analog in', AO: 'Analog out', RTD: 'RTD in', BRIDGE: 'Load cell in', IPC: 'Industrial PC', PWM: 'PWM valve out', SERIAL: 'Serial RS422/485', CAN: 'CANopen' };
function pinType(name) {
  if (/^NC$/.test(name)) return 'no_connect';
  if (/^(CAN_H|CAN_L)$/.test(name)) return 'bidirectional';
  if (/^TxD[+-]$/.test(name) || /^[AB][12]$/.test(name)) return 'output';
  if (/^RxD[+-]$/.test(name) || /^AI\d+ [UI]$/.test(name)) return 'input';
  if (/^(DI|AI|R|RL|UD|UREF)\d*[+-]?$/.test(name.replace(/\s.*/, ''))) return 'input';
  if (/^(DO|AO)\d+$/.test(name)) return 'output';
  return 'passive';
}
function channels(p) {
  const s = new Set();
  for (const n of p.pins) { const m = /^(DI|DO|AI|AO|REL)(\d+)/.exec(n); if (m) s.add(m[1] + m[2]); if (/^[AB][12]$/.test(n)) s.add('PWM' + n[0]); if (/^(TxD|RxD)/.test(n)) s.add('COM1'); if (/^CAN_[HL]$/.test(n)) s.add('CAN1'); if (/^R\d/.test(n)) s.add('RTD' + n.match(/\d+/)[0]); if (/^UD/.test(n)) s.add('BR1'); }
  return s.size;
}
function beckhoffSymbol(p, src) {
  const n = p.pins.length, half = n / 2;
  const yOf = (k) => 2.54 * (half - k + 1);           // terminal point k (1-based), top to bottom
  const top = yOf(1) + 2.54 * 2, bottom = yOf(n) - 2.54;
  const w = p.extra ? 10.16 : 7.62;
  const ch = channels(p);
  const head = p.head || (['COUPLER', 'SUPPLY', 'SERIAL', 'CAN'].includes(p.type) ? TYPE_TEXT[p.type] : `${ch} × ${TYPE_TEXT[p.type].toLowerCase()}`);
  const fields = [
    prop('Reference', 'A', 0, top + 3.81, { size: 1.27 }),
    prop('Value', p.code, 0, top + 1.27, { size: 1.27 }),
    prop('Footprint', '', 0, bottom - 2.54, { hide: true }),
    prop('Datasheet', 'https://www.beckhoff.com/' + p.code.toLowerCase(), 0, bottom - 2.54, { hide: true }),
    prop('Description', 'Beckhoff ' + p.code + ': ' + p.desc, 0, bottom - 2.54, { hide: true }),
    prop('Manufacturer', 'Beckhoff', 0, bottom - 2.54, { hide: true }),
    prop('MPN', p.code, 0, bottom - 2.54, { hide: true }),
    prop('IO_Type', p.type, 0, bottom - 2.54, { hide: true }),
    prop('IO_Signal', p.signal, 0, bottom - 2.54, { hide: true }),
    prop('IO_Channels', String(ch), 0, bottom - 2.54, { hide: true }),
    prop('Ebus_mA', p.ebus ? String(p.ebus) : '', 0, bottom - 2.54, { hide: true }),
    p.ebusSupply ? prop('Ebus_supply_mA', String(p.ebusSupply), 0, bottom - 2.54, { hide: true }) : '',
    prop('Source', src, 0, bottom - 2.54, { hide: true }),
    prop('ki_keywords', `Beckhoff EtherCAT terminal ${p.code} ${p.type} ${TYPE_TEXT[p.type]} PLC I/O`, 0, 0, { hide: true })
  ].filter(Boolean);
  const body = [
    `(rectangle (start ${f(-w)} ${f(top)}) (end ${f(w)} ${f(bottom)}) (stroke (width 0.254) (type default)) (fill (type background)))`,
    `(polyline (pts (xy ${f(-w)} ${f(top - 2.54)}) (xy ${f(w)} ${f(top - 2.54)})) (stroke (width 0) (type default)) (fill (type none)))`,
    `(text ${q(head)} (at 0 ${f(top - 1.27)} 0) ${font(1.27, {})})`
  ];
  const pins = p.pins.map((name, i) => `(pin ${pinType(name)} line (at ${f(-w - 2.54)} ${f(yOf(i + 1))} 0) (length 2.54) (name ${q(name)} ${font(1.27)}) (number ${q(p.nums ? p.nums[i] : String(i + 1))} ${font(1.27)}))`);
  (p.extra || []).forEach(([num, name], i) => pins.push(`(pin bidirectional line (at ${f(w + 2.54)} ${f(yOf(1) - 2.54 * i)} 180) (length 2.54) (name ${q(name)} ${font(1.27)}) (number ${q(num)} ${font(1.27)}))`));
  return `(symbol ${q(p.code)} (pin_names (offset 0.508)) (exclude_from_sim yes) (in_bom yes) (on_board yes) ${fields.join(' ')} ` +
    `(symbol ${q(p.code + '_0_1')} ${body.join(' ')}) (symbol ${q(p.code + '_1_1')} ${pins.join(' ')}))`;
}

// ---- Beckhoff Industrial PC: X101 power plug (and PE) on the left, network/USB/display ports on the right
function ipcSymbol(p, src) {
  const rows = Math.max(p.power.length + 1, p.ports.length);
  const yOf = (k) => 2.54 * (Math.floor(rows / 2) - k);         // row k (0-based), top to bottom
  const top = yOf(0) + 2.54 * 2, bottom = yOf(rows - 1) - 2.54, w = 12.7;
  const hidden = (n, v) => prop(n, v, 0, bottom - 2.54, { hide: true });
  const fields = [
    prop('Reference', 'A', 0, top + 3.81), prop('Value', p.code, 0, top + 1.27),
    hidden('Footprint', ''), hidden('Datasheet', p.datasheet), hidden('Description', 'Beckhoff ' + p.code + ': ' + p.desc),
    hidden('Manufacturer', 'Beckhoff'), hidden('MPN', p.code), hidden('IO_Type', p.type), hidden('IO_Signal', p.signal),
    hidden('IO_Channels', '0'), hidden('Options', p.options), hidden('Source', src),
    prop('ki_keywords', `Beckhoff Industrial PC IPC PLC controller TwinCAT ${p.code} C6017`, 0, 0, { hide: true })
  ];
  const yPE = yOf(p.power.length);                               // PE below the plug, after a one-row gap
  const body = [
    `(rectangle (start ${f(-w)} ${f(top)}) (end ${f(w)} ${f(bottom)}) (stroke (width 0.254) (type default)) (fill (type background)))`,
    `(polyline (pts (xy ${f(-w)} ${f(top - 2.54)}) (xy ${f(w)} ${f(top - 2.54)})) (stroke (width 0) (type default)) (fill (type none)))`,
    `(text ${q(TYPE_TEXT.IPC)} (at 0 ${f(top - 1.27)} 0) ${font(1.27, {})})`,
    `(text "X101" (at ${f(-w - 0.635)} ${f(yOf(0) + 2.54)} 0) ${font(1.27, { justify: 'right' })})`
  ];
  const pins = p.power.map(([num, name, type], i) => {
    const y = num === 'PE' ? yPE : yOf(i);
    return `(pin ${type} line (at ${f(-w - 2.54)} ${f(y)} 0) (length 2.54) (name ${q(name)} ${font(1.27)}) (number ${q(num)} ${font(1.27)}))`;
  });
  p.ports.forEach(([num, name], i) => pins.push(`(pin bidirectional line (at ${f(w + 5.08)} ${f(yOf(i))} 180) (length 5.08) (name ${q(name)} ${font(1.27)}) (number ${q(num)} ${font(1.27)}))`));
  return `(symbol ${q(p.code)} (pin_names (offset 0.508)) (exclude_from_sim yes) (in_bom yes) (on_board yes) ${fields.join(' ')} ` +
    `(symbol ${q(p.code + '_0_1')} ${body.join(' ')}) (symbol ${q(p.code + '_1_1')} ${pins.join(' ')}))`;
}

// ---- pretty printer (KiCad layout: one list per line, tab indented)
function splitTop(src) {
  const outp = []; let i = 1; const n = src.length - 1;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const s = i;
    if (c === '(') { let d = 0, inS = false; for (; i <= n; i++) { const ch = src[i]; if (inS) { if (ch === '\\') i++; else if (ch === '"') inS = false; continue; } if (ch === '"') inS = true; else if (ch === '(') d++; else if (ch === ')') { d--; if (!d) { i++; break; } } } }
    else if (c === '"') { i++; for (; i < n; i++) { if (src[i] === '\\') { i++; continue; } if (src[i] === '"') { i++; break; } } }
    else { while (i < n && !/[\s()]/.test(src[i])) i++; }
    outp.push(src.slice(s, i));
  }
  return outp;
}
function pretty(text, d) {
  const lines = [];
  (function walk(src, d) {
    const it = splitTop(src);
    if (!it.some((x) => x[0] === '(')) { lines.push('\t'.repeat(d) + '(' + it.join(' ') + ')'); return; }
    if (it[0] === 'pts') { lines.push('\t'.repeat(d) + '(pts'); lines.push('\t'.repeat(d + 1) + it.slice(1).join(' ')); lines.push('\t'.repeat(d) + ')'); return; }
    let i = 0; const atoms = []; while (i < it.length && it[i][0] !== '(') atoms.push(it[i++]);
    lines.push('\t'.repeat(d) + '(' + atoms.join(' '));
    for (; i < it.length; i++) { if (it[i][0] === '(') walk(it[i], d + 1); else lines.push('\t'.repeat(d + 1) + it[i]); }   // trailing atoms such as a bare hide
    lines.push('\t'.repeat(d) + ')');
  })(text, d || 0);
  return lines.join('\n');
}

function writeLib(libName, cat, file, symbols) {
  fs.mkdirSync(path.join(out, 'loomline'), { recursive: true });
  const body = Object.values(symbols).map((t) => pretty(t, 1)).join('\n');
  fs.writeFileSync(path.join(out, 'loomline', libName + '.kicad_sym'), `(kicad_symbol_lib\n\t(version ${VERSION})\n\t(generator "loomline")\n\t(generator_version "1")\n${body}\n)\n`);
  fs.writeFileSync(path.join(out, 'loomline', file), JSON.stringify({ libs: { [libName]: { version: VERSION, symbols } } }));
  return { name: libName, cat, dir: 'loomline/', file, n: Object.keys(symbols).length };
}

const B = require('./beckhoff-data.js');
const beckhoff = {};
const rows = [];
for (const p of B.parts) {
  if (p.ipc) {
    beckhoff[p.code] = ipcSymbol(p, B.source);
    rows.push([p.code, 'Beckhoff ' + p.code + ': ' + p.desc, 'Beckhoff Industrial PC IPC PLC controller CPU TwinCAT EtherCAT master', 'A', 1, p.power.length + p.ports.length, 0]);
    continue;
  }
  beckhoff[p.code] = beckhoffSymbol(p, B.source);
  rows.push([p.code, 'Beckhoff ' + p.code + ': ' + p.desc, `Beckhoff EtherCAT ${p.type} ${TYPE_TEXT[p.type]} PLC I/O terminal`, 'A', 1, p.pins.length + (p.extra || []).length, 0]);
}
const libs = [{ meta: writeLib('Loomline_Beckhoff', 'Beckhoff I/O', 'beckhoff.json', beckhoff), rows }];

// ---- Hydraulic solenoid cartridge valves (ISO 1219 valve graphic, electrical pins = the coil plug)
// Bucher WS22GD / WS22OD, data sheet 400-P-121110-EN (03.2021): 2/2 seat valve, size 5, direct acting,
// 350 bar, 30 l/min (with booster), cavity ALM M20x1.5. Coil plug M8x1 3-pin: pin 1 +V
// (48 / 24 / 12 V DC), pin 3 0 V, pin 4 not used. 12 V DC holding, 15 W.
const HYD = [
  { code: 'WS22GD', nc: true, desc: '2/2 cartridge seat valve, size 5, solenoid, direct acting, normally closed (de-energised closed), virtually leak-free both ways, 350 bar, 30 l/min with booster (15 l/min 1→2 without), cavity ALM M20x1.5' },
  { code: 'WS22OD', nc: false, desc: '2/2 cartridge seat valve, size 5, solenoid, direct acting, normally open (de-energised open), virtually leak-free both ways, 350 bar, 30 l/min with booster (15 l/min 1→2 without), cavity ALM M20x1.5' }
];
function hydSymbol(v) {
  const L = (pts, w, fill) => `(polyline (pts ${pts.map(([x, y]) => `(xy ${f(x)} ${f(y)})`).join(' ')}) (stroke (width ${w || 0.254}) (type default)) (fill (type ${fill || 'none'})))`;
  const R = (x0, y0, x1, y1, w) => `(rectangle (start ${f(x0)} ${f(y0)}) (end ${f(x1)} ${f(y1)}) (stroke (width ${w || 0.254}) (type default)) (fill (type none)))`;
  const T = (txt, x, y, size, just) => `(text ${q(txt)} (at ${f(x)} ${f(y)} 0) ${font(size || 1.27, just ? { justify: just } : {})})`;
  const arrowUp = (x, y) => L([[x - 0.6, y - 1.2], [x, y], [x + 0.6, y - 1.2], [x - 0.6, y - 1.2]], 0.15, 'outline');
  const arrowDn = (x, y) => L([[x - 0.6, y + 1.2], [x, y], [x + 0.6, y + 1.2], [x - 0.6, y + 1.2]], 0.15, 'outline');
  const H = 3.81;                       // half height of the valve boxes
  const sol = [-7.62, -2.54];           // solenoid actuator box x range
  const bxA = [-2.54, 5.08];            // box next to the solenoid: the energised position
  const bxB = [5.08, 12.7];             // box next to the spring: the rest (de-energised) position
  const open = (x0, x1) => { const c = (x0 + x1) / 2; return [L([[c, -H + 0.6], [c, H - 0.6]], 0.254), arrowUp(c, H - 0.4), arrowDn(c, -H + 0.4)]; };
  const shut = (x0, x1) => { const c = (x0 + x1) / 2; return [L([[c, H], [c, 1.27]]), L([[c - 1.27, 1.27], [c + 1.27, 1.27]]), L([[c, -H], [c, -1.27]]), L([[c - 1.27, -1.27], [c + 1.27, -1.27]])]; };
  const rest = v.nc ? shut : open, active = v.nc ? open : shut;
  const cB = (bxB[0] + bxB[1]) / 2;
  const body = [
    R(sol[0], -H + 1.27, sol[1], H - 1.27), L([[sol[0], -H + 1.27], [sol[1], H - 1.27]]),          // solenoid (ISO 1219)
    R(bxA[0], -H, bxA[1], H), R(bxB[0], -H, bxB[1], H),
    ...active(bxA[0], bxA[1]), ...rest(bxB[0], bxB[1]),
    L([[bxB[1], 0], [13.335, 1.27], [13.97, -1.27], [14.605, 1.27], [15.24, -1.27], [15.875, 1.27], [16.51, 0]]),  // spring
    L([[cB, H], [cB, H + 2.54]]), L([[cB, -H], [cB, -H - 2.54]]),                                      // hydraulic ports on the rest box
    T('2', cB + 1.27, H + 1.9, 1.27, 'left'), T('1', cB + 1.27, -H - 1.9, 1.27, 'left'),
    L([[-7.62, 2.54], [-10.16, 2.54]], 0.254), L([[-7.62, 0], [-10.16, 0]], 0.254),
    T('M8', -10.16, 4.445, 1.016, 'left')
  ];
  const top = H + 3.81, bottom = -H - 3.81;
  const hidden = (n, val) => prop(n, val, 0, bottom - 2.54, { hide: true });
  const fields = [
    prop('Reference', 'Y', 2.54, top + 2.54), prop('Value', v.code, 2.54, top),
    hidden('Footprint', ''), hidden('Datasheet', 'https://www.bucherhydraulics.com/ff/400-P-121110-en'),
    hidden('Description', 'Bucher Hydraulics ' + v.code + ': ' + v.desc),
    hidden('Manufacturer', 'Bucher Hydraulics'), hidden('MPN', v.code),
    hidden('Coil', '12 V DC holding (standard), 15 W, 100% duty; booster 48 V DC 4-5 ms, or 24 V DC switching pulse >= 70 ms'),
    hidden('Connector', 'M8x1 3-pin male: pin 1 +V, pin 3 0 V, pin 4 not used (option F: flying leads 1000 mm)'),
    hidden('Ordering', 'W S 22' + (v.nc ? 'G' : 'O') + ' D Z 5 - <design stage> <voltage> D; Z = M20x1.5, 5 = size, e.g. 12D = 12 V DC; V after size = FKM seals; confirm with Bucher'),
    hidden('Hydraulic', 'Ports 1 and 2; 350 bar; 30 l/min with booster, 15 l/min (1→2) without; cavity ALM M20x1.5, 50 Nm'),
    prop('ki_keywords', `Bucher hydraulic cartridge seat valve solenoid 2/2 ${v.nc ? 'normally closed NC' : 'normally open NO'} ${v.code} WS22`, 0, 0, { hide: true })
  ];
  const pins = [['1', '+V', 'passive', 2.54], ['3', '0V', 'passive', 0], ['4', 'n/c', 'no_connect', -2.54]]
    .map(([n, name, type, y]) => `(pin ${type} line (at ${f(-12.7)} ${f(y)} 0) (length 2.54) (name ${q(name)} ${font(1.016)}) (number ${q(n)} ${font(1.27)}))`);
  return `(symbol ${q(v.code)} (pin_names (offset 0.254) hide) (exclude_from_sim yes) (in_bom yes) (on_board yes) ${fields.join(' ')} ` +
    `(symbol ${q(v.code + '_0_1')} ${body.join(' ')}) (symbol ${q(v.code + '_1_1')} ${pins.join(' ')}))`;
}
const hyd = {}, hydRows = [];
for (const v of HYD) { hyd[v.code] = hydSymbol(v); hydRows.push([v.code, 'Bucher Hydraulics ' + v.code + ': ' + v.desc, 'Bucher hydraulic cartridge seat valve solenoid 2/2 ' + (v.nc ? 'normally closed NC' : 'normally open NO'), 'Y', 1, 3, 0]); }
libs.push({ meta: writeLib('Loomline_Hydraulics', 'Hydraulics', 'hydraulics.json', hyd), rows: hydRows });

// ---- merge into the app's index, Loomline libraries first
const idxPath = path.join(out, 'index.json');
const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
const keep = idx.libs.map((l, i) => [l, i]).filter(([l]) => !l.name.startsWith('Loomline_'));
const remap = new Map(keep.map(([, i], k) => [i, k + libs.length]));
const newRows = [];
libs.forEach(({ rows }, li) => rows.forEach((r) => newRows.push([li, ...r])));
for (const r of idx.rows) if (remap.has(r[0])) newRows.push([remap.get(r[0]), ...r.slice(1)]);
idx.libs = libs.map((l) => l.meta).concat(keep.map(([l]) => l));
idx.rows = newRows;
idx.loomline = 'Loomline libraries: drawn for Loomline from manufacturer documentation; see library/README.md';
fs.writeFileSync(idxPath, JSON.stringify(idx));
console.log(libs.map((l) => `${l.meta.name}: ${l.meta.n} symbols`).join(', ') + `; index now ${idx.rows.length} parts in ${idx.libs.length} libraries`);
