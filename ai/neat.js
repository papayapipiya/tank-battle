/* ai/neat.js — 最小但完整的 NEAT（創新歷史 + 物種化 + 結構變異）
   ═══════════════════════════════════════════════════════════
   為什麼自己寫：npm 上的 neat-js / neat-javascript 都沒有
   exportState/importState，無法定位「把第 37 代接回第 38 代」這件事，
   而「今天跑 100 場、明天繼續」正是要落地的能力。

   三個不能省的設計：

   1. 創新歷史（innovation history）
      同一條 in→out 邊永遠拿到同一個 innovation 編號，
      所以「兩代之間的同一条邊」可比；這是 crossover 能對齊、
      物種距離有意義的前提。少了它 NEAT 就退化成一堆隨機權重的遺演算法。
   2. 分裂節點的編號也取自歷史
      hidden node id = nodeBase + (被分裂邊的創新號)，
      因此兩個基因組在不同時間做同一個分裂會拿到同一個 node id，
      crossover 才不會把它當成兩個不同節點、長出重複的邊。
   3. 快照可續
      toJSON() 寫出 population + species + innovation history + generation。
      缺任何一項，隔天載入就會長出重複的邊，讓後續所有比較失效。
   ═══════════════════════════════════════════════════════════ */
(function (root) {      // IIFE：見 ai/actions.js 頭部說明（瀏覽器端要掛 window）
'use strict';

const DEFAULTS = {
  popSize: 24,
  // 每個基因組每代的結構變異機率
  pAddNode: 0.04,
  pAddConn: 0.15,
  pToggle: 0.10,
  pWeightPerturb: 0.75,
  weightStep: 0.35,
  weightInit: 0.8,
  pBiasPerturb: 0.6,
  // 適配度距離
  compat: { excess: 1.0, disjoint: 0.9, weight: 0.3, threshold: 3.5 },
  speciesSurvive: 0.4,
  elitePerSpecies: 1,
  stagnationGenerations: 12,
  // 輸出全低於此線 → 這個基因組「還不會開槍」，本幀交給規則 AI 打底
  abstainThreshold: -0.85,
};

let _idSeq = 0;

/* ══ 個體好壞的唯一判準 ═════════════════════════════════════
   「誰比較強」在 NEAT 裡被問了六次（crossover 的強親、物種內排序、停滯判定、
   物種入選、名額分配、本代最佳）。四捨五入、地板、負分歸零之後，
   早期世代常出現「整代都是 0 分」，六處各自實作「> fitness」就會各自退化：
   排序變成插入序、父母變成抽籤，而使用者看到的曲線完全平坦。
   全部收進這一組函式，次鍵（原始未封頂加總）只需要在這一處決定。
   ⚠ tie 不進適應度、不進任何顯示數字，只回答「同分時誰先」。 */
function compareGenomes(a, b) {
  if (a.fitness !== b.fitness) return b.fitness - a.fitness;   // 分高者先
  return (b.tie || 0) - (a.tie || 0);                          // 同分：原始分高者先
}

/** a 是否比 b 強（嚴格）：次鍵要差出一個明顯的量才算，避免浮點抖動換來換去 */
function betterGenome(a, b) {
  if (a.fitness !== b.fitness) return a.fitness > b.fitness;
  return (a.tie || 0) > (b.tie || 0) + TIE_EPS;
}

/** 次鍵判定的容差：分數本身是 0.01 級別的數字，小於它就當作真的並列 */
const TIE_EPS = 1e-6;

function meanOf(xs) {
  return xs.length ? xs.reduce((a, v) => a + v, 0) / xs.length : 0;
}

/**
 * 一個物種能分到的「名額權重」。
 * 有分時照舊用 fitness（跟歷史行爲完全一致）；整族都被地板壓到 0 分時，
 * 改用原始分當權重 —— 否則 total=0 會走「平均分配」，把還在看板的努力抹平。
 * 負的原始分（打自家老鷹那種）一律當 0，不準它搶名額。
 */
function speciesShare(sp) {
  const b = sp.members[0];
  if (!b) return 0;
  if (b.fitness > 0) return b.fitness;
  return Math.max(0, b.tie || 0);
}

class Genome {
  constructor() {
    this.id = ++_idSeq;
    this.obsDim = 0;
    this.nOut = 0;
    this.nodeBase = 0;          // 第一個 hidden id = nodeBase + 節點創新號
    this.nodes = [];            // [{ id, kind, bias }]
    this.links = new Map();     // "in>out" -> { in, out, innovation, weight, enabled }
    this.fitness = 0;
    // 同分時的排序次鍵（「地板之前的原始加總」，由 ai/evolve.js 在評分時附上）。
    // fitness 才是那把對外展示的尺，可能被地板壓成 0；這時個體之間全數並列，
    // 選擇退化為抽籤。tie 讓「還沒開分」的世代仍然分得出高低，
    // 而且不會出現在任何分數畫面上（不影響 best／mean／curva）。
    this.tie = 0;
    this._order = null;
    this._in = null;
  }

  static seed(obsDim, nOut, hist, rand, connCount = 10) {
    const g = new Genome();
    g.obsDim = obsDim; g.nOut = nOut; g.nodeBase = obsDim + nOut;
    for (let i = 0; i < obsDim; i++) g.nodes.push({ id: i, kind: 'sensor', bias: 0 });
    for (let o = 0; o < nOut; o++) g.nodes.push({ id: obsDim + o, kind: 'output', bias: rand() * 2 - 1 });
    for (let k = 0; k < connCount; k++) {
      const a = Math.floor(rand() * obsDim);
      const b = obsDim + Math.floor(rand() * nOut);
      g.addLink(a, b, hist, rand);
    }
    return g;
  }

  node(id) { return this.nodes.find(n => n.id === id); }
  key(a, b) { return a + '>' + b; }
  invalidate() { this._order = null; this._in = null; }

  addLink(a, b, hist, rand, weight) {
    const k = this.key(a, b);
    if (this.links.has(k)) return this.links.get(k);
    const link = {
      in: a, out: b,
      innovation: hist.connInnovation(a, b),
      weight: weight === undefined ? (rand() * 2 - 1) * DEFAULTS.weightInit : weight,
      enabled: true,
    };
    this.links.set(k, link);
    this.invalidate();
    return link;
  }

  /** 感測器不接受輸入；輸出層不互連；不允許自環（環路另由 reachable 擋） */
  static legal(a, b) {
    if (a === b) return false;
    if (b.kind === 'sensor') return false;
    if (a.kind === 'output' && b.kind === 'output') return false;
    return true;
  }

  mutateAddLink(hist, rand) {
    // 80 個感測器 + 5 個動作的結構下，「隨機取兩點」有 94% 機率落在
    // sensor→sensor（非法），等於結構變異幾乎白抽。
    // 先定「終點必須是可接收輸入的節點」，再隨機取起點，
    // 新邊才真的長得出來（實測：改前 15 代停在 10 條邊，改後會持續成長）。
    const targets = this.nodes.filter(n => n.kind !== 'sensor');
    if (!targets.length) return false;
    for (let tries = 0; tries < 20; tries++) {
      const b = targets[Math.floor(rand() * targets.length)];
      const a = this.nodes[Math.floor(rand() * this.nodes.length)];
      if (!Genome.legal(a, b)) continue;
      if (this.links.has(this.key(a.id, b.id))) continue;
      if (this.reachable(b.id, a.id)) continue;          // 會形成迴圈
      this.addLink(a.id, b.id, hist, rand);
      return true;
    }
    return false;
  }

  reachable(from, to) {
    const seen = new Set();
    const stack = [from];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === to) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const l of this.links.values()) if (l.in === cur) stack.push(l.out);
    }
    return false;
  }

  /** 拆一條邊、中間插入 hidden node */
  mutateAddNode(hist, rand) {
    const enabled = [...this.links.values()].filter(l => l.enabled);
    if (!enabled.length) return false;
    const l = enabled[Math.floor(rand() * enabled.length)];
    // 節點 id 取自「被分裂那條邊的創新號」⇒ 兩個基因組各自做同一個分裂，
    // 會得到同一個 node id，crossover 才認得是同一個節點。
    const newId = this.nodeBase + hist.nodeInnovationFor(l.innovation);
    if (this.node(newId)) return false;
    l.enabled = false;
    this.nodes.push({ id: newId, kind: 'hidden', bias: rand() * 2 - 1 });
    // 分裂前後語義保持一致：in→new 權重 1、new→out 繼承原權重。
    // 兩條新邊都向同一個「基因計數器」要號碼（edgeInnovations），
    // 絕不能复用被分裂邊的創新號 —— 否則一個號碼對應兩條邊，
    // crossover 對齊和物種距離都會錯亂（test-neat.js 會抓到）。
    this.links.set(this.key(l.in, newId),
      { in: l.in, out: newId, innovation: hist.connInnovation(l.in, newId), weight: 1, enabled: true });
    this.links.set(this.key(newId, l.out),
      { in: newId, out: l.out, innovation: hist.connInnovation(newId, l.out), weight: l.weight, enabled: true });
    this.invalidate();
    return true;
  }

  mutateToggle(rand) {
    const ls = [...this.links.values()];
    if (ls.length < 2) return;
    const l = ls[Math.floor(rand() * ls.length)];
    if (l.enabled && ls.filter(x => x.enabled).length <= 1) return;   // 不讓網路完全斷電
    l.enabled = !l.enabled;
    this.invalidate();
  }

  mutateWeights(rand) {
    for (const l of this.links.values()) {
      if (rand() < DEFAULTS.pWeightPerturb) {
        l.weight += (rand() * 2 - 1) * DEFAULTS.weightStep;
        if (rand() < 0.04) l.weight = (rand() * 2 - 1) * DEFAULTS.weightInit;
        l.weight = Math.max(-6, Math.min(6, l.weight));
      }
    }
    for (const n of this.nodes) {
      if (n.kind !== 'sensor' && rand() < DEFAULTS.pBiasPerturb)
        n.bias = Math.max(-6, Math.min(6, n.bias + (rand() * 2 - 1) * DEFAULTS.weightStep));
    }
  }

  mutate(hist, rand) {
    const r = rand();
    if (r < DEFAULTS.pAddNode) this.mutateAddNode(hist, rand);
    else if (r < DEFAULTS.pAddNode + DEFAULTS.pAddConn) this.mutateAddLink(hist, rand);
    else if (r < DEFAULTS.pAddNode + DEFAULTS.pAddConn + DEFAULTS.pToggle) this.mutateToggle(rand);
    this.mutateWeights(rand);
    this.invalidate();
  }

  /** 依 innovation 對齊的 crossover：較不適應者的獨有基因一律丟棄（標準 NEAT） */
  crossover(other, rand) {
    // 「誰是強親」用同一個判準（同分看原始次鍵）。
    // 原本只比 fitness：兩個都被地板壓成 0 時 eq 恆真，強弱變成硬擲骰，
    // 而 0 分世代裡「其實比較會打」的那隻沒有比較容易被傳下去。
    const strong = betterGenome(this, other) ? this
      : betterGenome(other, this) ? other
        : (rand() < 0.5 ? this : other);   // 真的完全並列才擲骰
    const weak = strong === this ? other : this;
    const child = new Genome();
    child.obsDim = strong.obsDim; child.nOut = strong.nOut; child.nodeBase = strong.nodeBase;
    child.nodes = strong.nodes.map(n => ({ ...n }));
    for (const n of weak.nodes) if (!child.node(n.id)) child.nodes.push({ ...n });
    for (const [k, l] of strong.links) {
      const w = weak.links.get(k);
      child.links.set(k, w ? { ...l, weight: rand() < 0.5 ? l.weight : w.weight } : { ...l });
    }
    child.invalidate();
    return child;
  }

  /** lazy 建：拓撲序 + 每個節點的入邊索引 */
  ensureGraph() {
    if (this._order) return;
    const inEdges = new Map(this.nodes.map(n => [n.id, []]));
    const indeg = new Map(this.nodes.map(n => [n.id, 0]));
    for (const l of this.links.values()) {
      if (!l.enabled) continue;
      if (!inEdges.has(l.out)) { l.enabled = false; continue; }   // 邊指向已不存在的節點：直接停用而非崩潰
      inEdges.get(l.out).push(l);
      indeg.set(l.out, indeg.get(l.out) + 1);
    }
    const q = this.nodes.filter(n => indeg.get(n.id) === 0).map(n => n.id);
    const out = [];
    while (q.length) {
      const cur = q.shift();
      out.push(cur);
      for (const l of this.links.values()) {
        if (!l.enabled || l.in !== cur) continue;
        indeg.set(l.out, indeg.get(l.out) - 1);
        if (indeg.get(l.out) === 0) q.push(l.out);
      }
    }
    this._order = out.length === this.nodes.length ? out : this.nodes.map(n => n.id);
    this._in = inEdges;
  }

  /** 前推：obs → nOut 個輸出（tanh） */
  activate(obs, out) {
    this.ensureGraph();
    const act = this._act || (this._act = new Map());
    for (const n of this.nodes) act.set(n.id, n.id < this.obsDim ? obs[n.id] : n.bias);
    for (const id of this._order) {
      const es = this._in.get(id);
      if (!es || !es.length) continue;
      const n = this.node(id);
      // bias 必須進加權和。原本 bias 只在「完全沒有入邊」時當作初始值，
      // 節點一旦接上邊就被 tanh(sum) 整個蓋掉 —— 於是 mutateWeights
      // 擾動 bias 是白改，想用模仿學習餵一個「外來」基因組也根本塞不進去
      // （訓練出來的閥值沒有落點）。
      let sum = n.bias;
      for (const l of es) sum += (act.get(l.in) || 0) * l.weight;
      act.set(id, n.kind === 'sensor' ? sum : Math.tanh(sum));
    }
    for (let i = 0; i < this.nOut; i++) out[i] = act.get(this.obsDim + i) || 0;
    return out;
  }

  /** 可直接餵給 PolicyController 的 policy；回傳 null = 本幀交給規則 AI */
  toPolicy() {
    const g = this, out = new Array(g.nOut);
    const thr = DEFAULTS.abstainThreshold;
    return obs => {
      g.activate(obs, out);
      let best = 0;
      for (let i = 1; i < g.nOut; i++) if (out[i] > out[best]) best = i;
      return out[best] < thr ? null : best;
    };
  }

  toJSON() {
    return {
      id: this.id, obsDim: this.obsDim, nOut: this.nOut, nodeBase: this.nodeBase,
      fitness: this.fitness, tie: this.tie || 0,
      nodes: this.nodes.map(n => ({ ...n })),
      links: [...this.links.values()].map(l => ({ ...l })),
    };
  }

  static fromJSON(j) {
    const g = new Genome();
    g.id = j.id; g.obsDim = j.obsDim; g.nOut = j.nOut; g.nodeBase = j.nodeBase;
    g.fitness = j.fitness || 0;
    // 次鍵要跟著存檔走：--resume 之後如果 reset 成 0，「0 分世代仍能排序」
    // 這件事就只在開機的第一天成立，隔天接續又變回抽籤。
    // 舊存檔沒這個欄位 → 0（跟當時的行為一致，不會憑空造出順序）。
    g.tie = j.tie || 0;
    g.nodes = j.nodes.map(n => ({ ...n }));
    g.links = new Map(j.links.map(l => [g.key(l.in, l.out), { ...l }]));
    g.invalidate();
    return g;
  }

  /**
   * 結構副本，但發一個新的個體 id。
   * id 不能沿用：NEAT 存盤時物種記的是「成員的 id」（toJSON/fromJSON 靠 id 找回
   * 基因組），同一批暖啟動種子若全是同一個 id，接續時 byId 會互相覆蓋，
   * 物種直接塌成一個個體。
   */
  clone() {
    const g = Genome.fromJSON(this.toJSON());
    g.id = ++_idSeq;
    g.fitness = 0;
    g.tie = 0;        // 次鍵跟 fitness 一樣是「這一世代的成績」，新個體還沒考過就不能有
    return g;
  }
}

class InnovationHistory {
  constructor() {
    this.connByKey = new Map();     // "in>out" -> innovation
    this.connByOrig = new Map();    // 被分裂的邊創新號 -> 新節點創新號
    this.nextConn = 0;
    this.nextNodeInno = 1;
  }
  connInnovation(a, b) {
    const k = a + '>' + b;
    let v = this.connByKey.get(k);
    if (v === undefined) { v = this.nextConn++; this.connByKey.set(k, v); }
    return v;
  }
  nodeInnovationFor(connInno) {
    let v = this.connByOrig.get(connInno);
    if (v === undefined) { v = this.nextNodeInno++; this.connByOrig.set(connInno, v); }
    return v;
  }
  /**
   * 向歷史要一個「沒被用過的 hidden node id」。
   * 外來基因組（模仿學習種子、別的 checkpoint 匯入的冠軍）不能自己亂編 id ——
   * 亂編會和日後 mutateAddNode 長出的節點撞號，crossover 就把兩個節點當同一個。
   * 走 nodeInnovationFor 等於正式登記：nextNodeInno 會跟著前進。
   */
  claimNodeId(nodeBase, key) { return nodeBase + this.nodeInnovationFor(key); }
  toJSON() {
    return {
      nextConn: this.nextConn, nextNodeInno: this.nextNodeInno,
      connByKey: [...this.connByKey], connByOrig: [...this.connByOrig],
    };
  }
  static fromJSON(j) {
    const h = new InnovationHistory();
    h.nextConn = j.nextConn; h.nextNodeInno = j.nextNodeInno;
    h.connByKey = new Map(j.connByKey); h.connByOrig = new Map(j.connByOrig);
    return h;
  }
}

/** 物種距離：(多餘 + 不相交) / 基因數 + 平均權重差 */
function compatibility(a, b, c = DEFAULTS.compat) {
  const la = [...a.links.values()].sort((x, y) => x.innovation - y.innovation);
  const lb = [...b.links.values()].sort((x, y) => x.innovation - y.innovation);
  const maxA = la.length ? la[la.length - 1].innovation : -1;
  const maxB = lb.length ? lb[lb.length - 1].innovation : -1;
  let excess = 0, disjoint = 0, matched = 0, weightDiff = 0;
  let i = 0, j = 0;
  while (i < la.length && j < lb.length) {
    if (la[i].innovation === lb[j].innovation) {
      weightDiff += Math.abs(la[i].weight - lb[j].weight); matched++; i++; j++;
    } else if (la[i].innovation < lb[j].innovation) {
      if (la[i].innovation > maxB) excess++; else disjoint++;
      i++;
    } else {
      if (lb[j].innovation > maxA) excess++; else disjoint++;
      j++;
    }
  }
  // 尾端：超過對方最大創新號算 excess，否則 disjoint
  while (i < la.length) { if (la[i].innovation > maxB) excess++; else disjoint++; i++; }
  while (j < lb.length) { if (lb[j].innovation > maxA) excess++; else disjoint++; j++; }
  const n = Math.max(la.length, lb.length, 1);
  return c.excess * excess / n + c.disjoint * disjoint / n + c.weight * weightDiff / Math.max(matched, 1);
}

class Species {
  constructor(rep, id) {
    this.id = id;
    this.members = rep ? [rep] : [];
    this.representative = rep;
    this.bestFitness = rep ? rep.fitness : 0;
    this.bestTie = rep ? (rep.tie || 0) : 0;   // 0 分世代的「有沒有在進步」只能看這個
    this.stall = 0;
    this.offspring = 1;
  }
}

class NEAT {
  constructor(o = {}) {
    this.obsDim = o.obsDim;
    this.nOut = o.nOut;
    this.hist = o.hist || new InnovationHistory();
    this.population = o.population || [];
    this.species = o.species || [];
    this.generation = o.generation || 0;
    this.rand = o.rand || Math.random;
    this.speciesSeq = o.speciesSeq || 0;
    this.best = o.best || null;              // Genome
    this.bestFitness = o.bestFitness ?? -Infinity;
    this.history = o.history || [];
  }

  initialize(popSize = DEFAULTS.popSize) {
    this.population = [];
    for (let i = 0; i < popSize; i++)
      this.population.push(Genome.seed(this.obsDim, this.nOut, this.hist, this.rand));
    return this;
  }

  /**
   * 暖啟動：整個族群從同一個「已經會開車」的基因組長出來，而不是 80×5 的隨機權重。
   * ═══════════════════════════════════════════════════════════
   * 為什麼要這個（對應「不應該從頭訓練到尾」）：
   * 從零演化時，第一代要同時運氣好找到「會動的網路」才有意義的分數可排；
   * 觀測 85 欄、隨機權重的 argmax 幾乎固定落在同一兩個動作，
   * 於是前幾十代都在撿「卡牆掃射」這種垃圾分（實測 gen 50 冠軍 92% 決策是射擊、
   * 55% 在場幀頂在牆上）。模仿學習把「往哪走、何時開火」的合理行為先做進權重，
   * NEAT 只需要在此之上優化「打得好不好」，省掉的是最貴的探索錯誤。
   *
   * 族群構成刻意做成階梯：
   *   i=0    未變異的種子 —— 第一代就能量出模仿基準的真實成績，
   *          也讓「暖啟動的行為有沒有被變異洗掉」變成可觀察的事，不是信仰。
   *   其餘   1~3 次 mutate，拉出一條「離老師多遠」的光譜，
   *          物種分化才有材料；全同一份複本的話第一代等於只考一個人。
   * 注意 mutate() 一定會碰權重，所以想要忠實度必須留一個零變異個體。
   */
  initializeFrom(seed, popSize = DEFAULTS.popSize) {
    this.population = [];
    for (let i = 0; i < popSize; i++) {
      const g = seed.clone();
      const kicks = i === 0 ? 0 : 1 + (i % 3);
      for (let k = 0; k < kicks; k++) g.mutate(this.hist, this.rand);
      this.population.push(g);
    }
    return this;
  }

  speciate() {
    this.species = [];
    for (const g of this.population) {
      let placed = false;
      for (const sp of this.species) {
        if (compatibility(g, sp.representative) < DEFAULTS.compat.threshold) {
          sp.members.push(g); placed = true; break;
        }
      }
      if (!placed) this.species.push(new Species(g, this.speciesSeq++));
    }
    for (const sp of this.species) sp.representative = sp.members[0];
    return this.species;
  }

  /** evaluate(population, gen) → 分數陣列。回傳本代統計。
      ⚠ 呼叫端可以在 evaluate 裡把 g.tie（未封頂的原始分）附在同一批個體上，
        這裡只覆寫 fitness，次鍵留給下面的比較用。 */
  evolve(evaluate) {
    const scores = evaluate(this.population, this.generation);
    this.population.forEach((g, i) => { g.fitness = Math.max(0, scores[i]); });

    this.speciate();
    for (const sp of this.species) {
      sp.members.sort(compareGenomes);
      sp.representative = sp.members[0];
      const top = sp.members[0];
      // 「這個物種還有沒有在進步」：分數沒動但原始分還在漲，同樣算有進展。
      // 只認 fitness 的話，被地板壓住的族群會連續 stagnationGenerations 代
      // 被判定停滯 → 成員被裁到 3，等於在最需要族群多樣性的時候自我阉割。
      const progressed = top.fitness > sp.bestFitness + 1e-9 ||
        (Math.abs(top.fitness - sp.bestFitness) <= 1e-9 &&
          (top.tie || 0) > (sp.bestTie || 0) + TIE_EPS);
      if (progressed) { sp.bestFitness = top.fitness; sp.bestTie = top.tie || 0; sp.stall = 0; }
      else {
        sp.stall++;
        // 停滯的物種縮編，把名額讓給還在進步的
        if (sp.stall > DEFAULTS.stagnationGenerations && sp.members.length > 3)
          sp.members.length = Math.max(3, Math.floor(sp.members.length * 0.6));
      }
    }

    // 入選門檻跟總權重都走 speciesShare：有分照舊，全 0 分時用原始分當依據，
    // 才不會讓「還沒開分但明顯比較像樣」的族群整個被踢出交配池。
    const pool = this.species.filter(sp => sp.members.length && speciesShare(sp) > 0);
    const use = pool.length ? pool : this.species;
    const total = use.reduce((a, sp) => a + speciesShare(sp), 0);
    const size = this.population.length;
    for (const sp of use)
      sp.offspring = total > 0
        ? Math.max(1, Math.round(size * speciesShare(sp) / total))
        : Math.max(1, Math.round(size / use.length));

    const next = [];
    for (const sp of use) {
      const parents = sp.members.slice(0, Math.max(1, Math.ceil(sp.members.length * DEFAULTS.speciesSurvive)));
      // 同種內 crossover；跨種只在同一物種只剩一個父母時發生
      const kin = parents.length > 1 ? parents : this.population;
      for (let e = 0; e < DEFAULTS.elitePerSpecies && next.length < size; e++)
        next.push(Genome.fromJSON(parents[e % parents.length].toJSON()));
      let guard = 0;
      while (next.length < Math.min(size, sp.offspring + DEFAULTS.elitePerSpecies) && guard++ < 64) {
        const a = parents[Math.floor(this.rand() * parents.length)];
        const b = kin[Math.floor(this.rand() * kin.length)];
        const child = (a !== b && this.rand() < 0.7) ? a.crossover(b, this.rand) : Genome.fromJSON(a.toJSON());
        child.mutate(this.hist, this.rand);
        next.push(child);
      }
    }
    let gi = 0;
    while (next.length < size) {
      const a = this.population[gi++ % this.population.length];
      const child = Genome.fromJSON(a.toJSON());
      child.mutate(this.hist, this.rand);
      next.push(child);
    }

    // 本代代表：先比分數，同分再比原始分（整代 0 分時這一行才選得出「比較像樣的那隻」，
    // 否則 this.best 是「第一個最大值」= 族群裡恰好排最前的個體，純看插入序）。
    const evaluated = this.population;
    let top = 0;
    for (let i = 1; i < evaluated.length; i++) {
      if (betterGenome(evaluated[i], evaluated[top])) top = i;
    }
    const bestG = evaluated[top];
    if (bestG.fitness > this.bestFitness) { this.bestFitness = bestG.fitness; this.best = bestG; }
    // 原始分要在換掉族群之前取（換完之後population是還沒考過的子代）
    const rawMean = meanOf(evaluated.map(g => g.tie || 0));
    const zeroRate = scores.filter(v => v <= 0).length / scores.length;
    this.population = next;
    this.generation++;
    const rec = {
      gen: this.generation,
      best: scores[top],
      mean: scores.reduce((a, v) => a + v, 0) / scores.length,
      // raw  = 本代「未封頂加總」的平均，zero = 拿到 0 分的個體占比。
      // 這一對是「地板下面還有沒有在長」的唯一證據：best 曲線平在 0 不等於族群沒進步，
      // 可能只是還沒有人拿到那張入場券；看板上那條平線到底是停滯還是憋著力，靠這個分。
      raw: rawMean,
      zero: zeroRate,
      species: this.species.length,
      maxLinks: Math.max(...this.population.map(g => g.links.size)),
      maxNodes: Math.max(...this.population.map(g => g.nodes.length)),
    };
    this.history.push(rec);
    return rec;
  }

  toJSON() {
    return {
      version: 1, obsDim: this.obsDim, nOut: this.nOut,
      generation: this.generation, speciesSeq: this.speciesSeq,
      bestFitness: this.bestFitness === -Infinity ? null : this.bestFitness,
      best: this.best ? this.best.toJSON() : null,
      history: this.history,
      hist: this.hist.toJSON(),
      population: this.population.map(g => g.toJSON()),
      species: this.species.map(sp => ({
        id: sp.id, bestFitness: sp.bestFitness, bestTie: sp.bestTie || 0,
        stall: sp.stall, offspring: sp.offspring,
        members: sp.members.map(m => m.id),
      })),
    };
  }

  static fromJSON(j) {
    const pop = j.population.map(Genome.fromJSON);
    const byId = new Map(pop.map(g => [g.id, g]));
    const n = new NEAT({
      obsDim: j.obsDim, nOut: j.nOut, hist: InnovationHistory.fromJSON(j.hist),
      population: pop, generation: j.generation, speciesSeq: j.speciesSeq,
      history: j.history || [],
    });
    n.bestFitness = j.bestFitness === null ? -Infinity : j.bestFitness;
    n.best = j.best ? Genome.fromJSON(j.best) : null;
    n.species = (j.species || []).map(sp => {
      const members = sp.members.map(id => byId.get(id)).filter(Boolean);
      const s = new Species(members[0] || pop[0], sp.id);
      s.members = members.length ? members : [pop[0]];
      s.representative = s.members[0];
      s.bestFitness = sp.bestFitness; s.stall = sp.stall; s.offspring = sp.offspring;
      // 次鍵也要接得回來：少了它，--resume 的第一代會把「停滯計數」建立在
      // 一個被清零的基準上，明明還在長原始分的族群会被误判停滯而縮編。
      s.bestTie = sp.bestTie || 0;
      return s;
    });
    return n;
  }
}

const AINeat = {
  NEAT, Genome, InnovationHistory, Species, compatibility, DEFAULTS,
  // 「誰比較強」的判準要跟訓練端共用：evolve.js 選本代最佳、履歷挑冠軍都要用同一把尺，
  // 各寫一次「> fitness」就會出現「物種排序認次鍵、紀錄冠軍不認」的那種分裂。
  compareGenomes, betterGenome, speciesShare,
};

// 瀏覽器只需要 Genome.activate/toPolicy，但整份一起掛最省事，
// 而且保證網頁上跑的跟訓練端是同一套前推實作。
if (typeof module !== 'undefined' && module.exports) module.exports = AINeat;
else root.AINeat = AINeat;
})(typeof window !== 'undefined' ? window : globalThis);
