// Builds Loomline's part library from a checkout of KiCad's official symbol library.
//   node tools/build-kicad-library.js /path/to/kicad-symbols
// Writes library/kicad/<category>.json.gz (each symbol's S-expression, whitespace collapsed) and
// library/index.json (one searchable row per symbol). Only libraries useful for electrical
// systems are included; edit LIBS to change that.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
global.KiCore = require('../js/kicad-core.js');
const K = global.KiCore;
const src = process.argv[2];
const out = path.join(__dirname, '..', 'library');
const LIBS = {
  // category: libraries
  'Switches & controls': ['Switch', 'Relay', 'Relay_SolidState', 'Driver_Relay', 'Triac_Thyristor'],
  'Power & protection': ['Device', 'power', 'Power_Protection', 'Power_Management', 'Battery_Management', 'Converter_ACDC', 'Converter_DCDC', 'Regulator_Linear', 'Transformer', 'Motor', 'Driver_Motor'],
  'Connectors': ['Connector', 'Connector_Generic', 'Connector_Audio', 'Jumper', 'Fiber_Optic'],
  'Signals & comms': ['Interface_CAN_LIN', 'Interface_Ethernet', 'Interface_CurrentLoop', 'Isolator', 'Amplifier_Operational', 'Timer', 'MCU_Module', 'RF_Module', 'RF_GPS', 'Display_Character', 'Audio'],
  'Sensors': ['Sensor', 'Sensor_Current', 'Sensor_Distance', 'Sensor_Humidity', 'Sensor_Magnetic', 'Sensor_Motion', 'Sensor_Pressure', 'Sensor_Proximity', 'Sensor_Temperature', 'Sensor_Voltage'],
  'Semiconductors': ['Diode', 'Diode_Bridge', 'LED', 'Transistor_BJT', 'Transistor_FET', 'Transistor_IGBT'],
  'Drawing': ['Mechanical', 'Graphic']
};
// Collapse whitespace outside strings; KiCad reads it back the same.
function minify(t) {
  let o = '', i = 0, inStr = false, ws = false;
  for (; i < t.length; i++) {
    const c = t[i];
    if (inStr) { o += c; if (c === '\\') { o += t[++i]; } else if (c === '"') inStr = false; continue; }
    if (c === '"') { if (ws && o && o[o.length - 1] !== '(') o += ' '; ws = false; inStr = true; o += c; continue; }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { ws = true; continue; }
    if (c === ')') { ws = false; o += c; continue; }
    if (ws && o && o[o.length - 1] !== '(') o += ' ';
    ws = false; o += c;
  }
  return o;
}
fs.mkdirSync(path.join(out, 'kicad'), { recursive: true });
const index = { source: 'KiCad symbol library 9.0.9 (CC-BY-SA 4.0 with the KiCad libraries exception)', libs: [], rows: [] };
let total = 0;
const bundles = {};
// GitHub's web uploader stalls on some gzip files; these bundles are stored as plain JSON
// (GitHub Pages still compresses them on the way to the tablet).
const PLAIN = new Set(['semiconductors', 'signals-comms']);
for (const [cat, libs] of Object.entries(LIBS)) for (const lib of libs) {
  const text = fs.readFileSync(path.join(src, lib + '.kicad_sym'), 'utf8');
  const root = K.parseSexpr(text, true);
  const version = (K.find(root, 'version') || [])[1];
  const syms = {}, info = {};
  for (const n of root) {
    if (!Array.isArray(n) || n[0] !== 'symbol') continue;
    const name = n[1];
    syms[name] = minify(text.slice(n.s, n.e));
    const prop = (k) => { const p = n.find((x) => Array.isArray(x) && x[0] === 'property' && x[1] === k); return p ? p[2] : ''; };
    const ext = K.find(n, 'extends');
    const units = new Set(), pins = new Set();
    for (const sub of n) if (Array.isArray(sub) && sub[0] === 'symbol') {
      const m = /_(\d+)_(\d+)$/.exec(sub[1]); if (m && m[1] !== '0') units.add(m[1]);
      for (const p of K.findAll(sub, 'pin')) { const num = K.find(p, 'number'); if (num) pins.add(num[1]); }
    }
    info[name] = { ref: prop('Reference'), desc: prop('Description'), kw: prop('ki_keywords'), ext: ext ? ext[1] : null, units: units.size || 1, pins: pins.size, power: !!K.find(n, 'power') };
  }
  // Derived symbols take units and pins from their parent
  for (const [name, i] of Object.entries(info)) if (i.ext && info[i.ext]) { i.units = info[i.ext].units; i.pins = info[i.ext].pins; if (!i.ref) i.ref = info[i.ext].ref; }
  const file = cat.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  (bundles[file] = bundles[file] || {})[lib] = { version, symbols: syms };
  const li = index.libs.length;
  index.libs.push({ name: lib, cat, file: file + (PLAIN.has(file) ? '.json' : '.json.gz'), n: Object.keys(syms).length });
  for (const [name, i] of Object.entries(info)) index.rows.push([li, name, i.desc, i.kw, i.ref, i.units, i.pins, i.power ? 1 : 0]);
  total += Object.keys(syms).length;
}
// One gzipped bundle per category: GitHub Pages serves .gz as-is and the app inflates it.
for (const [file, libs] of Object.entries(bundles)) {
  const json = JSON.stringify({ libs });
  if (PLAIN.has(file)) fs.writeFileSync(path.join(out, 'kicad', file + '.json'), json);
  else fs.writeFileSync(path.join(out, 'kicad', file + '.json.gz'), zlib.gzipSync(json, { level: 6 }));
}
fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify(index));
fs.copyFileSync(path.join(src, 'LICENSE.md'), path.join(out, 'kicad', 'LICENSE.md'));
console.log(index.libs.length + ' libraries, ' + total + ' symbols');
