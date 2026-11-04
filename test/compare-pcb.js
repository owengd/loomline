// Validates schematic connectivity against the pad nets stored in each demo's .kicad_pcb.
const fs = require('fs');
const path = require('path');
const K = require('../js/kicad-core.js');

const demoRoot = process.argv[2];
function walk(d, out) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const all = walk(demoRoot, []);
const pros = all.filter((p) => p.endsWith('.kicad_pro'));
let totalBad = 0;
for (const pro of pros) {
  const dir = path.dirname(pro);
  const files = all.filter((p) => p.startsWith(dir + path.sep) && /\.kicad_(sch|pro)$/.test(p))
    .filter((p) => !pros.some((o) => o !== pro && path.dirname(o).startsWith(dir + path.sep) && p.startsWith(path.dirname(o) + path.sep)))
    .map((p) => ({ path: path.relative(demoRoot, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') }));
  const proRel = path.relative(demoRoot, pro).split(path.sep).join('/');
  let proj;
  const t0 = Date.now();
  try { proj = K.buildProject(files); } catch (e) { console.log('FAIL', proRel, e.message); totalBad++; continue; }
  const ms = Date.now() - t0;
  const pcbPath = pro.replace(/\.kicad_pro$/, '.kicad_pcb');
  let summary = `${proRel}: ${proj.instances.length} sheets, ${proj.nets.filter((n) => !n.bus).length} nets, ${ms}ms`;
  if (proj.errors.length) summary += ' errors=' + proj.errors.map((e) => e.message).join(';');
  if (!fs.existsSync(pcbPath)) { console.log(summary + ' (no pcb)'); continue; }
  const pcb = K.parseSexpr(fs.readFileSync(pcbPath, 'utf8'));
  const pcbNet = new Map();
  const find = (n, k) => n.find((c) => Array.isArray(c) && c[0] === k);
  for (const fp of pcb.filter((c) => Array.isArray(c) && (c[0] === 'footprint' || c[0] === 'module'))) {
    let ref = null;
    for (const c of fp) {
      if (Array.isArray(c) && c[0] === 'property' && c[1] === 'Reference') ref = c[2];
      if (Array.isArray(c) && c[0] === 'fp_text' && c[1] === 'reference') ref = c[2];
    }
    if (!ref) continue;
    for (const pad of fp.filter((c) => Array.isArray(c) && c[0] === 'pad')) {
      const n = find(pad, 'net');
      if (!n) continue;
      const name = n[n.length - 1];
      if (/^unconnected-|^$/.test(name)) continue;
      const k = ref + '#' + pad[1];
      if (!pcbNet.has(k)) pcbNet.set(k, name);
    }
  }
  const mine = new Map();
  proj.nets.forEach((net) => net.pins.forEach((p) => { if (!proj.instances[p.inst].orphan && proj.instances[p.inst].scope === 0) mine.set(p.ref + '#' + p.number, net); }));
  // For each schematic net, which pcb nets do its pins land on (and vice versa)?
  const s2p = new Map(), p2s = new Map();
  for (const [k, pn] of pcbNet) {
    const sn = mine.get(k);
    if (!sn) continue;
    if (!s2p.has(sn.id)) s2p.set(sn.id, new Set()); s2p.get(sn.id).add(pn);
    if (!p2s.has(pn)) p2s.set(pn, new Set()); p2s.get(pn).add(sn.id);
  }
  const split = [...p2s].filter(([, s]) => s.size > 1);
  const merged = [...s2p].filter(([, s]) => s.size > 1);
  let nameMatch = 0, nameTotal = 0;
  for (const [sid, ps] of s2p) { if (ps.size !== 1) continue; nameTotal++; if ([...ps][0] === proj.nets[sid].name) nameMatch++; }
  summary += ` | pcb nets checked ${p2s.size}, split ${split.length}, merged ${merged.length}, names ${nameMatch}/${nameTotal}`;
  console.log(summary);
  if (process.env.V) {
    for (const [pn, s] of split.slice(0, 4)) console.log('   split', pn, '->', [...s].map((i) => proj.nets[i].name).join(' | '));
    for (const [sid, ps] of merged.slice(0, 4)) console.log('   merged', proj.nets[sid].name, '->', [...ps].join(' | '));
    if (process.env.V === '2') for (const [sid, ps] of s2p) if (ps.size === 1 && [...ps][0] !== proj.nets[sid].name) console.log('   name', proj.nets[sid].name, 'vs', [...ps][0]);
  }
  totalBad += split.length + merged.length;
}
console.log('TOTAL mismatches', totalBad);
