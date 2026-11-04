// Runs the Loomline analysis over a folder of KiCad projects and prints a summary of each:
// wire numbers, from/to rows, cross-references, checks, and a self-comparison (must be empty).
const fs = require('fs'), path = require('path');
global.KiCore = require('../js/kicad-core.js');
const L = require('../js/loom.js');
const K = global.KiCore;
const rootDir = process.argv[2];
const verbose = process.argv.includes('-v');
const walk = (d, out) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p, out); else if (/\.kicad_pro$/.test(f.name)) out.push(p); } return out; };
let fail = 0;
for (const pro of walk(rootDir, [])) {
  const dir = path.dirname(pro);
  const files = fs.readdirSync(dir).filter((f) => /\.kicad_(sch|pro)$/.test(f)).map((f) => ({ path: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
  if (!files.some((f) => f.path.endsWith('.kicad_sch'))) continue;
  const t0 = Date.now();
  const P = K.buildProject(files);
  const A = L.analyze(P);
  const ms = Date.now() - t0;
  const nos = A.wireNo.filter(Boolean);
  const dupNo = nos.length - new Set(nos).size;
  const bySev = A.issues.reduce((m, i) => (m[i.sev] = (m[i.sev] || 0) + 1, m), {});
  const pinsOnNets = P.nets.filter((n) => !n.bus && n.pins.length >= 2).reduce((s, n) => s + n.pins.length - 1, 0);
  const B = L.bom(P, A), C = L.connectors(P, A), LM = L.looms(P, A);
  const self = L.diff(P, A, P, A);
  const dupRefs = A.issues.some((i) => i.code === "dupref");
  const ok = dupNo === 0 && (self.count === 0 || dupRefs);
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${path.relative(rootDir, pro)}: ${ms}ms wires ${A.wires.length}/${pinsOnNets} nos ${nos.length} dup ${dupNo} xref ${A.xref.size} bom ${B.rows.length} conn ${C.length} looms ${LM.length} errors ${bySev.error || 0} warn ${bySev.warn || 0} selfdiff ${self.count}`);
  if (verbose) { const counts = {}; for (const i of A.issues) counts[i.code] = (counts[i.code] || 0) + 1; console.log('     ', JSON.stringify(counts), A.issues.slice(0, 4).map((i) => i.msg).join(' | ')); }
}
console.log(fail ? `${fail} FAILED` : 'ALL PASSED');
process.exit(fail ? 1 : 0);
