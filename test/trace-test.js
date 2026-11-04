// Step-by-step tracing: from a wire on each of the biggest connector nets, the steps must cover
// the whole net exactly once.   node test/trace-test.js /path/to/kicad/demos/pic_programmer
const fs = require('fs'), path = require('path');
global.KiCore = require('../js/kicad-core.js');
const L = require('../js/loom.js');
const K = global.KiCore;
const dir = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => /\.kicad_(sch|pro)$/.test(f)).map((f) => ({ path: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
const P = K.buildProject(files);
let fail = 0;
const nets = P.nets.filter((n) => !n.bus && n.pins.some((p) => /^(J|P|X|CN|TB)\d/.test(p.ref))).sort((a, b) => b.pins.length - a.pins.length).slice(0, 10);
for (const net of nets) {
  const [ii, groups] = net.inst.entries().next().value;
  const inst = P.instances[ii];
  const w = inst.sheet.wires.find((x) => groups.includes(x.group));
  if (!w) continue;
  const tr = L.traceSteps(P, inst, w.node, { by: process.env.BY || "section" });
  let got = 0, want = 0;
  for (const s of tr.steps) for (const set of s.items.values()) got += set.size;
  for (const [i, gs] of net.inst) for (const g of gs) want += P.instances[i].sheet.groups[g].items.length;
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${net.name}: ${tr.steps.length} steps, ${got}/${want} items, stops ${tr.steps.map((s) => s.stops.map((x) => x.kind === 'conn' || x.kind === 'pin' ? x.ref + '.' + x.number : x.kind === 'junction' ? 'T' : '>' + x.name).join(',')).join(' | ')}`);
}
console.log(fail ? fail + ' FAILED' : 'ALL PASSED');
process.exit(fail ? 1 : 0);
