/* test-neat.js — NEAT 核心不變量（結構合法、創新歷史一致、快照可續） */
const { NEAT, Genome, InnovationHistory, compatibility, DEFAULTS } = require('./ai/neat');

let pass = 0, fail = 0;
function T(name, ok, extra) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}
const lcg = (() => { let s = 12345; return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); })();

const OBS = 12, OUT = 5;
const hist = new InnovationHistory();

// 1) 種子基因組：結構合法、能前推
const g0 = Genome.seed(OBS, OUT, hist, lcg, 10);
T('seed: 有 sensor+output', g0.nodes.length === OBS + OUT);
T('seed: 邊數 ≤ 請求數', g0.links.size > 0 && g0.links.size <= 10, g0.links.size);
const o1 = g0.activate(new Float64Array(OBS).fill(0.3), new Array(OUT));
T('seed: activate 回傳 5 個 tanh 值', o1.length === OUT && o1.every(v => v >= -1 && v <= 1));
T('seed: 相同輸入 → 相同輸出', JSON.stringify(g0.activate(new Float64Array(OBS).fill(0.3), new Array(OUT))) === JSON.stringify(o1));

// 2) 創新歷史：同一條邊永遠同一個編號
const inno = hist.connInnovation(3, 8);
T('history: 同邊重複查詢得同號', hist.connInnovation(3, 8) === inno);

// 3) 反覆變異：不出現環 / 不出現懸掛邊 / node id 唯一
let cycle = 0, dupId = 0, dangling = 0, partialOrder = 0;
const g = Genome.seed(OBS, OUT, hist, lcg, 10);
for (let i = 0; i < 4000; i++) {
  g.mutate(hist, lcg);
  const ids = g.nodes.map(n => n.id);
  if (new Set(ids).size !== ids.length) dupId++;
  for (const l of g.links.values()) {
    if (!g.node(l.in) || !g.node(l.out)) dangling++;
  }
  g.invalidate();
  g.ensureGraph();
  if (g._order.length !== g.nodes.length) partialOrder++;
  const pos = new Map(); g._order.forEach((id, k) => pos.set(id, k));
  for (const l of g.links.values()) if (l.enabled && pos.has(l.in) && pos.has(l.out) && pos.get(l.in) >= pos.get(l.out)) cycle++;
}
T('mutate ×4000: node id 唯一', dupId === 0, dupId);
T('mutate ×4000: 邊都指向存在的節點', dangling === 0, dangling);
T('mutate ×4000: enabled 邊符合拓撲序（無環）', cycle === 0, cycle);
T('mutate ×4000: 拓撲序涵蓋全部節點', partialOrder === 0, partialOrder);
T('mutate: 網路長出結構', g.links.size > 10 && g.nodes.length > OBS + OUT, `${g.nodes.length}n/${g.links.size}e`);

// 4) 分裂後的節點 id 由創新號決定 → 兩個獨立基因組做同樣分裂會得到同一個 id
const h2 = new InnovationHistory();
const a1 = Genome.seed(OBS, OUT, h2, lcg, 4);
const target = [...a1.links.values()].find(l => l.enabled);
a1.mutateAddNode({ nodeInnovationFor: nno => h2.nodeInnovationFor(nno), connInnovation: h2.connInnovation.bind(h2) }, () => 0.0);
const newNode = a1.nodes.find(n => n.kind === 'hidden');
T('split: hidden id = nodeBase + 創新號', !!newNode && newNode.id === a1.nodeBase + h2.nodeInnovationFor(target.innovation), newNode && newNode.id);

// 5) crossover：子代基因集合 ⊆ 雙親並集，且權重取自雙親
const p1 = Genome.seed(OBS, OUT, hist, lcg, 12); p1.fitness = 5;
const p2 = Genome.seed(OBS, OUT, hist, lcg, 12); p2.fitness = 3;
const kid = p1.crossover(p2, lcg);
const union = new Set([...p1.links.keys(), ...p2.links.keys()]);
T('crossover: 子代邊都在雙親並集內', [...kid.links.keys()].every(k => union.has(k)));
T('crossover: 適應度較低者的獨有邊被丟棄',
  [...kid.links.keys()].every(k => p1.links.has(k)),
  [...kid.links.keys()].filter(k => !p1.links.has(k)).join(','));
const wOk = [...kid.links.values()].every(l => {
  const q = p1.links.get(l.in + '>' + l.out), r = p2.links.get(l.in + '>' + l.out);
  return !r || Math.abs(l.weight - q.weight) < 1e-12 || Math.abs(l.weight - r.weight) < 1e-12;
});
T('crossover: 權重必取自其中一個親代', wOk);

// 6) 適配度距離
T('compat: 自己對自己是 0', compatibility(g0, g0) === 0, compatibility(g0, g0));
const clone = Genome.fromJSON(g0.toJSON());
clone.links.forEach(l => { l.weight += 0.1; });
T('compat: 純權重差異有正距離', compatibility(g0, clone) > 0.01, compatibility(g0, clone));
const far = Genome.seed(OBS, OUT, hist, lcg, 30);
T('compat: 結構差異越大距離越大', compatibility(g0, far) > compatibility(g0, clone),
  `${compatibility(g0, far).toFixed(3)} vs ${compatibility(g0, clone).toFixed(3)}`);

// 7) 快照往返：population/species/innovation history/generation 四樣都要活下來
const n = new NEAT({ obsDim: OBS, nOut: OUT, rand: lcg });
n.initialize(16);
const fakeEval = pop => pop.map(() => 1 + lcg());
const rec1 = n.evolve(fakeEval);
const rec2 = n.evolve(fakeEval);
const json = JSON.parse(JSON.stringify(n.toJSON()));
const n2 = NEAT.fromJSON(json);
T('snapshot: generation 連續', n2.generation === n.generation, `${n2.generation} vs ${n.generation}`);
T('snapshot: population 數量一致', n2.population.length === n.population.length);
T('snapshot: 每個個體結構一致',
  n2.population.every((g, i) => g.links.size === n.population[i].links.size && g.nodes.length === n.population[i].nodes.length));
T('snapshot: 權重逐一一致',
  n2.population.every((g, i) => [...g.links.values()].every(l => {
    const o = n.population[i].links.get(l.in + '>' + l.out);
    return o && Math.abs(o.weight - l.weight) < 1e-12;
  })));
T('snapshot: innovation history 保留', n2.hist.nextConn === n.hist.nextConn && n2.hist.nextNodeInno === n.hist.nextNodeInno);
T('snapshot: species 劃分保留', n2.species.length === n.species.length, `${n2.species.length} vs ${n.species.length}`);
T('snapshot: bestFitness 保留', n2.bestFitness === n.bestFitness);
// 載入後繼續演化：不得長出重複邊（創新歷史若丟失就會）
const beforeKeys = new Set();
for (let i = 0; i < 6; i++) n2.evolve(fakeEval);
let dupInnov = 0;
const seen = new Map();
for (const g of n2.population) for (const l of g.links.values()) {
  const prev = seen.get(l.innovation);
  if (prev !== undefined && prev !== l.in + '>' + l.out) dupInnov++;
  seen.set(l.innovation, l.in + '>' + l.out);
}
T('resume: 一個創新號只對應一條邊', dupInnov === 0, dupInnov);
T('resume: nextConn 單調成長', n2.hist.nextConn >= n.hist.nextConn);

// 8) policy：abstain 時回傳 null（讓規則 AI 打底）
const silent = new Genome();
silent.obsDim = OBS; silent.nOut = OUT; silent.nodeBase = OBS + OUT;
silent.nodes = [...Array(OBS).keys()].map(i => ({ id: i, kind: 'sensor', bias: 0 }))
  .concat([...Array(OUT).keys()].map(o => ({ id: OBS + o, kind: 'output', bias: -1 })));
const pol = silent.toPolicy();
T('policy: 無輸入且 bias 低 → abstain', pol(new Float64Array(OBS)) === null);
const shout = Genome.fromJSON(silent.toJSON());
shout.nodes.filter(x => x.kind === 'output').forEach((x, i) => { x.bias = i; });
T('policy: 有正 bias → 給出動作', shout.toPolicy()(new Float64Array(OBS)) === 4);

/* ══ 9) 0 分世代的次鍵（tie）═══════════════════════════════════
   背景：計分有四道地板（躺平→0、負分→0、自破→0、家被拆→封頂），
   早期族群動不動整代被壓成 0 分。0 和 0 之間沒有順序 → 排序退回插入序、
   父母退回抽籤，「選擇壓力 = 0」；而原始未封頂的分（tie）其實一直有高低。
   這一節盯的就是：次鍵只在並列時出場，並且真的能改變選擇。 */
const { compareGenomes, betterGenome, speciesShare } = require('./ai/neat');

const mk = (fit, tie) => { const x = Genome.fromJSON(g0.toJSON()); x.fitness = fit; x.tie = tie; return x; };

const hi = mk(0, 500), lo = mk(0, -200);
T('tie: 全 0 分時原始分高的算強', betterGenome(hi, lo) && !betterGenome(lo, hi));
T('tie: 有分時次鍵不準插手', betterGenome(mk(1, -9999), mk(0.5, 9999)) &&
  !betterGenome(mk(0, 9999), mk(1, -9999)));
T('tie: 完全並列（同分同原始分）誰都不算強',
  !betterGenome(mk(3, 7), mk(3, 7)) && !betterGenome(mk(3, 7 + 1e-9), mk(3, 7)));
T('tie: compareGenomes 是 betterGenome 的排序版（同向）',
  compareGenomes(lo, hi) > 0 && compareGenomes(mk(5, 0), mk(4, 9999)) < 0);
T('tie: toJSON/fromJSON 帶得回來（--resume 不能把它歸零）',
  Genome.fromJSON(hi.toJSON()).tie === 500);
T('tie: 舊存檔沒這個欄位 → 0（不憑空造出順序）',
  (() => { const j = hi.toJSON(); delete j.tie; return Genome.fromJSON(j).tie === 0; })());
T('tie: clone() 連次鍵一起歸零（新個體還沒考過）', g0.clone().tie === 0 && g0.clone().fitness === 0);
T('tie: speciesShare 有分用分、0 分用原始分、負的不算',
  speciesShare({ members: [mk(12, 999)] }) === 12 &&
  speciesShare({ members: [mk(0, 80)] }) === 80 &&
  speciesShare({ members: [mk(0, -400)] }) === 0);

// 真跑一代：整代 0 分，只有原始分有高低
const nz = new NEAT({ obsDim: OBS, nOut: OUT, rand: lcg });
nz.population = [lo, hi, mk(0, 120), mk(0, -5)];     // 第一位故意是低分的（插入序陷阱）
const recZero = nz.evolve(pop => { pop.forEach(g => { g.fitness = 0; }); return pop.map(() => 0); });
T('零分世代: 物種把原始分高的排最前（不再看插入序）',
  nz.species[0].members[0].tie === Math.max(lo.tie, hi.tie, 120, -5), nz.species[0].members.map(m => m.tie));
T('零分世代: 本代最佳是原始分那隻，不是第一個 0', nz.best.tie === 500, nz.best && nz.best.tie);
T('零分世代: rec.zero 回報「整代都是 0 分」', recZero.zero === 1, recZero.zero);
T('零分世代: rec.raw 把地板下面的差異記下來', recZero.raw > 0 && recZero.raw < 500, recZero.raw);

// 停滯判定：同一代之內，「分數全 0 但原始分比入種的代表高」要算有進展。
// ⚠ 這裡刻意不宣稱「跨代記得停滯」：speciate() 每代把 this.species 整個重建
//   （ai/neat.js 的 `this.species = []`），所以 bestFitness／bestTie／stall
//   每代都從「本代第一個被放進來的成員」重新起算 —— 實測 40 代全 0 分，
//   見過的最大 stall 是 1，而門檻 stagnationGenerations = 12，
//   等於「停滯物種縮編」這一段從這個專案開始就沒跑過（跟 fitness 同病，不是 tie 造成的）。
//   這一條是既有實作的既有事實，改它會動到族群動態（等於突然引入一種從未生效的淘汰），
//   所以測試把它釘住、不自作主張修；要修應該單獨評估。
const nz2 = new NEAT({ obsDim: OBS, nOut: OUT, rand: lcg });
nz2.population = [mk(0, 10), mk(0, 20), mk(0, 30), mk(0, 40)];   // 插入序第一位是低分的
nz2.evolve(pop => { pop.forEach(g => { g.fitness = 0; }); return pop.map(() => 0); });
T('零分世代: 原始分比「入種代表」高就不算停滯（stall 歸零）',
  nz2.species[0].stall === 0 && nz2.species[0].bestTie >= 40,
  `stall=${nz2.species[0].stall} bestTie=${nz2.species[0].bestTie}`);
T('零分世代: stall 上限是 1（物種每代重建 → 縮編門檻永遠碰不到）', (() => {
  const m = new NEAT({ obsDim: OBS, nOut: OUT, rand: lcg });
  m.initialize(6);
  let mx = 0;
  for (let i = 0; i < 40; i++) {
    m.evolve(() => new Array(m.population.length).fill(0));
    for (const sp of m.species) mx = Math.max(mx, sp.stall);
  }
  return mx === 1 && mx < DEFAULTS.stagnationGenerations;
})());
// 存檔往返：bestTie 跟著 bestFitness 一起寫（雖然目前每代會被重建丟掉，
// 但存檔資料要完整 —— 哪天物種身份開始保留，次鍵歷史才接得回去）
const nzr = NEAT.fromJSON(JSON.parse(JSON.stringify(nz2.toJSON())));
T('零分世代: 物種的 bestTie 進得了存檔', nzr.species[0].bestTie === nz2.species[0].bestTie,
  `${nzr.species[0].bestTie} vs ${nz2.species[0].bestTie}`);

// crossover：同分時強親 = 原始分高那隻（丟棄的是弱親的獨有邊）
const pa = mk(0, 900), pb = mk(0, 10);
pa.addLink(0, OBS, hist, lcg);
pb.addLink(1, OBS + 1, hist, lcg);
const kidAB = pa.crossover(pb, () => 0.1);
const onlyFromWeak = [...pb.links.keys()].filter(k => !pa.links.has(k));
T('零分世代: crossover 的強親是原始分高的（弱親獨有邊被丟掉）',
  onlyFromWeak.every(k => !kidAB.links.has(k)), onlyFromWeak.join(','));

console.log('---');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
