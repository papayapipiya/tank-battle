/* ai/imitate.js — 行為複製：把規則 AI 的示範擬合成 NEAT 基因組
   ═══════════════════════════════════════════════════════════
   這層存在的理由（使用者的判斷，實測也站得住）：
   「應該先用一個基本邏輯去累計數據，再用 NEAT 自進化」——
   從隨機噪點開始演化，前幾十代都在重學「會動」這件事，
   而且那段期間最容易掉進「卡牆掃射」這種結論好看、過程是壞的局部最優。

   做法：
     1. ai/teacher.js 收規則 AI 每幀的（觀測 → 決定）
     2. 這裡用 softmax cross-entropy + SGD 擬合一個 D→H→5 的網路
     3. 把擬合出的權重「折疊成 NEAT 基因組」（含標準化：網路看的是原始觀測）
     4. node ai/evolve.js --seed-from runs/seed.json 讓 NEAT 從這裡往上進化

   ⚠ 折疊是必須的：模型內部用標準化後的輸入（7×7 地形格是 0..9 的整數碼，
     跟 ±1 的相對距離混在一起會被大數值主導），但基因組吃的是原始觀測。
     所以 w' = w / sd、b' = b − Σ w·mu/sd，把標準化塞進權重裡。
   ═══════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');

const Observation = require('./observation');
const { ACTION_COUNT, ACTION_NAMES } = require('./actions');
const { Genome, InnovationHistory } = require('./neat');
const { mulberry32 } = require('./rng');
const Teacher = require('./teacher');
// 角色名稱的單一真相在 ai/fitness.js（評判標準就是照它分的），
// 這裡只借用標籤與「隊伍→角色」的換算，不再另寫一份 attack=藍 的對應。
const { ROLE_LABEL } = require('./fitness');

const W_CLAMP = 6;                 // 與 neat.js mutateWeights 的上下限一致

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * 輸入尺度：每欄用 max(sd, 1) 當除數。
 * ⚠ 這裡刻意「不」把低變異欄位放大：基因組吃的是原始觀測，
 *   折疊後的權重是 w/sd。實測有幾欄（例如 7×7 裡少見的地形碼）sd ≈ 0.03，
 *   除下去會得到 |w| ≈ 30 的邊，而 NEAT 的 mutateWeights 一律把權重壓回 ±6 ——
 *   第一代變異就把種子打回原形（genome 準確率 26%，比亂猜好不了多少）。
 *   觀測本身已經大致在 [-1,1]，地形碼 0..9，所以 scale 設下限 1
 *   既不會讓大數值欄位主導，也保證折疊後的權重不超出 NEAT 的範圍。
 */
function featureStats(samples, dim) {
  const mu = new Float64Array(dim), sd = new Float64Array(dim);
  for (const s of samples) for (let j = 0; j < dim; j++) mu[j] += s.obs[j];
  const n = Math.max(1, samples.length);
  for (let j = 0; j < dim; j++) mu[j] /= n;
  for (const s of samples) for (let j = 0; j < dim; j++) { const d = s.obs[j] - mu[j]; sd[j] += d * d; }
  const scale = new Float64Array(dim);
  for (let j = 0; j < dim; j++) {
    sd[j] = Math.sqrt(sd[j] / n);
    scale[j] = sd[j] < 1e-6 ? 1 : Math.max(sd[j], 1);
    if (sd[j] < 1e-6) mu[j] = 0;                     // 常數欄位：別讓它把 bias 拖跑
  }
  return { mu, sd, scale };
}

/**
 * 訓練 D→H(tanh)→K(softmax)。純 JS、無相依，資料全在記憶體。
 * @param {object[]} samples
 */
function fit(samples, o = {}) {
  const D = Observation.OBS_DIM, K = ACTION_COUNT;
  const H = o.hidden || 16;
  const rand = mulberry32(o.seed || 20261031);
  const { mu, sd, scale } = featureStats(samples, D);

  // Xavier：輸入維度 80 時用 1/sqrt(D)，不然初始 logits 會大到把 tanh 推到飽和
  const s1 = 1 / Math.sqrt(D), s2 = 1 / Math.sqrt(H);
  const W1 = [], b1 = [], W2 = [], b2 = new Float64Array(K);
  for (let k = 0; k < H; k++) {
    const row = new Float64Array(D);
    for (let j = 0; j < D; j++) row[j] = (rand() * 2 - 1) * s1;
    W1.push(row); b1.push((rand() * 2 - 1) * s1);
  }
  for (let c = 0; c < K; c++) {
    const row = new Float64Array(H);
    for (let k = 0; k < H; k++) row[k] = (rand() * 2 - 1) * s2;
    W2.push(row);
  }

  // 類別不均衡：規則 AI 開火的比例遠低於轉向，不加權就會學成「從不開火」
  const cnt = new Array(K).fill(0);
  for (const s of samples) cnt[s.label]++;
  const cw = cnt.map(v => (v ? Math.sqrt(samples.length / (K * v)) : 0));
  const cwSum = cw.reduce((a, v) => a + v, 0) / K || 1;
  for (let c = 0; c < K; c++) cw[c] /= cwSum;

  // 事件加權（ai/teacher.js 的分層取樣之外，再給「卡牆轉向」一點額外加價）：
  // 那一類樣本決定了上場後會不會頂著牆開火，錯一幀的代價比「繼續直走」高得多。
  const ew = Object.assign({ stuck: 2, fire: 1, freeTurn: 1, keep: 1 }, o.eventWeights || {});

  const idx = [...samples.keys()];
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  const hold = idx.slice(0, Math.max(50, Math.floor(idx.length * 0.15)));
  const train = idx.slice(hold.length);

  const xs = new Float64Array(D), a1 = new Float64Array(H), z2 = new Float64Array(K), dz2 = new Float64Array(K);
  const gW1 = W1.map(() => new Float64Array(D)), gb1 = new Float64Array(H);
  const gW2 = W2.map(() => new Float64Array(H)), gb2 = new Float64Array(K);

  const fwd = i => {
    const s = samples[i];
    for (let j = 0; j < D; j++) xs[j] = (s.obs[j] - mu[j]) / scale[j];
    for (let k = 0; k < H; k++) {
      let z = b1[k]; const row = W1[k];
      for (let j = 0; j < D; j++) z += row[j] * xs[j];
      a1[k] = Math.tanh(z);
    }
    let mx = -Infinity;
    for (let c = 0; c < K; c++) { let z = b2[c]; const row = W2[c]; for (let k = 0; k < H; k++) z += row[k] * a1[k]; z2[c] = z; if (z > mx) mx = z; }
    let sum = 0;
    for (let c = 0; c < K; c++) { z2[c] = Math.exp(z2[c] - mx); sum += z2[c]; }
    for (let c = 0; c < K; c++) z2[c] /= sum;
  };
  const predict = fwd;                      // 復用：z2 此時是 softmax 機率
  const argmax = () => { let b = 0; for (let c = 1; c < K; c++) if (z2[c] > z2[b]) b = c; return b; };

  const epochs = o.epochs === undefined ? 18 : o.epochs;
  const lr0 = o.lr === undefined ? 0.35 : o.lr;
  const batch = o.batch || 32;
  const l2 = o.l2 === undefined ? 1e-5 : o.l2;
  const acc = i => { predict(i); return argmax() === samples[i].label ? 1 : 0; };
  const score = list => { let n = 0; for (const i of list) n += acc(i); return n / Math.max(1, list.length); };

  const curve = [];
  for (let e = 0; e < epochs; e++) {
    const lr = lr0 * (1 - e / epochs) + 0.01;
    for (let b0 = 0; b0 < train.length; b0 += batch) {
      const n = Math.min(batch, train.length - b0);
      gW1.forEach(g => g.fill(0)); gW2.forEach(g => g.fill(0));
      gb1.fill(0); gb2.fill(0);
      for (let t = 0; t < n; t++) {
        const i = train[b0 + t], s = samples[i];
        fwd(i);
        const w = cw[s.label] * (ew[s.event] === undefined ? 1 : ew[s.event]);
        for (let c = 0; c < K; c++) dz2[c] = ((c === s.label ? z2[c] - 1 : z2[c]) * w) / n;
        for (let c = 0; c < K; c++) {
          const g = gW2[c]; gb2[c] += dz2[c];
          for (let k = 0; k < H; k++) g[k] += dz2[c] * a1[k];
        }
        for (let k = 0; k < H; k++) {
          let da = 0;
          for (let c = 0; c < K; c++) da += W2[c][k] * dz2[c];
          const dz1 = da * (1 - a1[k] * a1[k]);
          gb1[k] += dz1;
          const g = gW1[k];
          for (let j = 0; j < D; j++) g[j] += dz1 * xs[j];
        }
      }
      const upd = (row, g, div) => {
        for (let q = 0; q < row.length; q++)
          row[q] = clamp(row[q] - lr * g[q] / div - lr * l2 * row[q], -W_CLAMP, W_CLAMP);
      };
      for (let k = 0; k < H; k++) upd(W1[k], gW1[k], n);
      for (let c = 0; c < K; c++) upd(W2[c], gW2[c], n);
      for (let k = 0; k < H; k++) b1[k] = clamp(b1[k] - lr * gb1[k] / n, -W_CLAMP, W_CLAMP);
      for (let c = 0; c < K; c++) b2[c] = clamp(b2[c] - lr * gb2[c] / n, -W_CLAMP, W_CLAMP);
    }
    if (!o.quiet) curve.push({ epoch: e + 1, train: score(train.slice(0, 400)), holdout: score(hold) });
  }

  return { D, K, H, mu, sd, scale, W1, b1, W2, b2,
    accuracy: { holdout: score(hold), train: score(train.slice(0, 800)) },
    holdSamples: hold.map(i => samples[i]),
    classWeights: cw, curve, holdoutN: hold.length, trainN: train.length };
}

/**
 * 把尺度折進權重（基因組吃原始觀測），並依「折疊後的絕對值」排序修剪。
 * @returns {{D,K,nodes:object[],links:object[],outBias:number[],maxAbsWeight:number}}
 */
function foldAndPrune(m, o = {}) {
  const { D, K, H, mu, scale, W1, b1, W2, b2 } = m;
  const maxLinks = o.maxLinks === undefined ? 420 : o.maxLinks;
  const b1e = new Float64Array(H), W1e = W1.map(r => new Float64Array(D));
  let maxAbs = 0;
  for (let k = 0; k < H; k++) {
    let adj = 0;
    for (let j = 0; j < D; j++) {
      const v = W1[k][j] / scale[j];
      W1e[k][j] = v; adj += v * mu[j];
      if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
    }
    b1e[k] = clamp(b1[k] - adj, -W_CLAMP, W_CLAMP);
  }
  const cand = [];
  for (let k = 0; k < H; k++) {
    for (let j = 0; j < D; j++) if (Math.abs(W1e[k][j]) > 1e-4) cand.push({ in: j, out: 'h' + k, w: W1e[k][j], a: Math.abs(W1e[k][j]) });
    for (let c = 0; c < K; c++) if (Math.abs(W2[c][k]) > 1e-4) cand.push({ in: 'h' + k, out: 'c' + c, w: W2[c][k], a: Math.abs(W2[c][k]) });
  }
  cand.sort((x, y) => y.a - x.a);
  const kept = cand.slice(0, maxLinks);
  // 留邊要「兩端都留」：只留進不留出的 hidden 節點等於懸空。
  // ⚠ 端點一律用符號（'h3' / 'c2'），不寫裸整數 —— 輸出節點在基因組裡的 id
  //   是 D+2，曾經在這裡寫成 2，於是所有 h→c 邊指到感測器 2 號上，
  //   拓撲排序出現環 → activate 退回插入序 → 輸出層永遠只吃到 bias，
  //   基因組變成「100% 向下」的廢種子（準確率 28%，紙上模型卻 95%）。
  const used = new Set();
  for (const l of kept) {
    if (typeof l.in === 'string' && l.in[0] === 'h') used.add(l.in);
    if (typeof l.out === 'string' && l.out[0] === 'h') used.add(l.out);
  }
  const keys = [...used].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const nodes = keys.map(k => ({ key: k, bias: b1e[Number(k.slice(1))] }));
  const links = kept.filter(l =>
    (typeof l.in !== 'string' || l.in[0] !== 'h' || used.has(l.in)) &&
    (typeof l.out !== 'string' || l.out[0] !== 'h' || used.has(l.out)));
  return { D, K, nodes, links, linksAvailable: cand.length, outBias: Array.from(b2), maxAbsWeight: maxAbs };
}

/**
 * 用「真的會跑在遊戲裡的那條路」量準確率：genome.toPolicy()（含 tanh 輸出層
 * 與 abstain 門檻）。修剪/折疊只要出錯，這裡就會立刻掉下來 ——
 * 實測過一個只靠紙上權重算的檢查放過了 ±6 clamp 造成的 70% 準確率損失。
 */
function genomeAccuracy(genome, samples) {
  const pol = genome.toPolicy();
  let ok = 0, nul = 0;
  const hist = new Array(ACTION_COUNT).fill(0);
  for (const s of samples) {
    const a = pol(s.obs);
    if (a === null) { nul++; continue; }
    hist[a]++;
    if (a === s.label) ok++;
  }
  const n = Math.max(1, samples.length);
  return { accuracy: ok / n, abstain: nul / n, share: hist.map(v => v / n), names: ACTION_NAMES };
}

/** 'h3' → 該 hidden 的 id、'c2' → 輸出節點 D+2、整數 → 感測器 id */
function endpoint(key, idOf, D) {
  if (typeof key === 'number') return key < D ? key : undefined;
  if (key[0] === 'c') return D + Number(key.slice(1));
  return idOf.get(key);
}

/**
 * 結構不變量：違反任何一條，基因組在紙上看不出來、進場卻變成廢種子。
 *  （實測踩過：h→c 的邊寫成節點 2 而不是 D+2，邊全指到感測器上，
 *    拓撲排序退化成插入序，輸出層只吃到 bias → 100% 同一個動作。）
 */
function validateGenome(g) {
  const ids = new Set(g.nodes.map(n => n.id));
  for (const l of g.links.values())
    if (!ids.has(l.in) || !ids.has(l.out))
      throw new Error(`imitate: 邊 ${l.in}>${l.out} 指向不存在的節點`);
  for (let c = 0; c < g.nOut; c++) {
    const id = g.obsDim + c;
    if (![...g.links.values()].some(l => l.out === id && l.enabled))
      throw new Error(`imitate: 輸出 ${c} 沒有任何啟用的入邊 → 這一代基因組只會輸出 bias`);
  }
  const indeg = new Map(g.nodes.map(n => [n.id, 0]));
  const out = new Map(g.nodes.map(n => [n.id, []]));
  for (const l of g.links.values()) {
    if (!l.enabled) continue;
    indeg.set(l.out, indeg.get(l.out) + 1);
    out.get(l.in).push(l.out);
  }
  const q = g.nodes.filter(n => indeg.get(n.id) === 0).map(n => n.id);
  let seen = 0;
  while (q.length) {
    const cur = q.shift(); seen++;
    for (const nx of out.get(cur)) if (indeg.set(nx, indeg.get(nx) - 1).get(nx) === 0) q.push(nx);
  }
  if (seen !== g.nodes.length)
    throw new Error(`imitate: 基因組有環或邊指進感測器（只排得出的節點 ${seen}/${g.nodes.length}）`);
  return g;
}

/** 折疊後的模型 → 一個合法 NEAT 基因組（用傳進來的創新歷史正式登記編號） */
function toGenome(pruned, hist, rand) {
  return buildGenome({
    D: pruned.D, K: pruned.K, outBias: pruned.outBias,
    hidden: pruned.nodes, links: pruned.links,
  }, hist, rand, 'imitate');
}

/**
 * 載入種子檔，並把權重「重建」到目標創新歷史裡。
 * 不能直接 Genome.fromJSON 就用：存檔裡的 innovation 號是 imitate.js 自己
 * 那本帳的號碼，跟訓練用的 history 對不上 —— 硬塞會讓 crossover 把
 * 不同的邊當成同一條（這是 NEAT 最隱蔽的那類錯）。
 */
function importSeed(file, hist, rand) {
  const j = typeof file === 'string' ? JSON.parse(fs.readFileSync(file, 'utf8')) : file;
  if (j.kind !== 'tank-battle-imitation-seed')
    throw new Error(`imitate: ${j.kind} 不是模仿種子檔（請用 node ai/imitate.js 產生）`);
  if (j.obsSpec && j.obsSpec.version !== Observation.OBS_SPEC.version)
    throw new Error(
      `imitate: 種子觀測規格 v${j.obsSpec.version}（${j.obsSpec.dim} 欄）與現行 ` +
      `v${Observation.OBS_SPEC.version}（${Observation.OBS_SPEC.dim} 欄）不符 —— ` +
      `欄位一變，種子的權重就接到別的感測器上。重跑 node ai/imitate.js 收新種子。`);
  return buildGenome(j.seed, hist, rand, 'seed-import');
}

function buildGenome(s, hist, rand, tag) {
  const g = new Genome();
  g.obsDim = s.D; g.nOut = s.K; g.nodeBase = s.D + s.K;
  for (let i = 0; i < s.D; i++) g.nodes.push({ id: i, kind: 'sensor', bias: 0 });
  for (let c = 0; c < s.K; c++) g.nodes.push({ id: s.D + c, kind: 'output', bias: s.outBias[c] });
  const idOf = new Map();
  s.hidden.forEach((h, i) => {
    const id = hist.claimNodeId(g.nodeBase, tag + ':' + i);
    idOf.set(h.key, id);
    g.nodes.push({ id, kind: 'hidden', bias: h.bias });
  });
  for (const l of s.links) {
    const a = endpoint(l.in, idOf, s.D), b = endpoint(l.out, idOf, s.D);
    if (a === undefined || b === undefined) continue;
    g.addLink(a, b, hist, rand, clamp(l.w, -W_CLAMP, W_CLAMP));
  }
  g.invalidate();
  return validateGenome(g);
}

/** 把 pruned 模型存成種子檔（含原始準確率與老師資料的統計） */
function exportSeed(pruned, meta) {
  return Object.assign({
    kind: 'tank-battle-imitation-seed',
    version: 1,
    obsSpec: Observation.OBS_SPEC,
    generatedAt: new Date().toISOString(),
    seed: {
      D: pruned.D, K: pruned.K,
      outBias: pruned.outBias,
      hidden: pruned.nodes.map(n => ({ key: n.key, bias: n.bias })),
      links: pruned.links.map(l => ({ in: l.in, out: l.out, w: l.w })),
    },
  }, meta);
}

const HELP = `用法：node ai/imitate.js [選項]

  --role attack|defense
                  只收這一席老師的示範（批次二 G3）。js/ai.js 的 _goal 現在認角色：
                  藍（attack）壓老鷹、紅（defense）守門前，兩隊教的不是同一件事。
                  不給就兩隊混收 —— 混收擬合出來的是「中性駕駛的平均」，
                  暖啟動會把剛拆開的分工糊回去（--seed-from 時角色不符會被拒絕）。
  --stages a,b        收示範資料要用哪些地圖（預設 0,1,2）
  --games N           每張地圖打幾局規則 vs 規則（預設 3）
  --keep-share X      「繼續直走」那種平凡幀留幾成（0..1，預設 0.2）
  --free-turn-share X 沒被擋卻轉向（老師隨機重選方向）留幾成（預設 0.45）
  --hidden N          模仿網路的 hidden 數（預設 16）
  --epochs N          擬合回合（預設 18）
  --lr X              學習率（預設 0.35）
  --max-links N       折疊後保留幾條邊（預設 420）
  --out FILE          種子輸出路徑（預設 runs/seed.json）
  --no-save-samples   （預設不存樣本）
  --quiet

產生種子之後（角色要對得上）：
  node ai/imitate.js --role attack  --out runs/seed-attack.json
  node ai/imitate.js --role defense --out runs/seed-defense.json
  node ai/evolve.js --seed-from runs/seed-attack.json --role attack --gens 30 --out runs/attack.json
  node ai/monitor.js --ckpt runs/seed-attack.json      # 先確認「第一天就會開車」`;

function main(argv) {
  const o = { stages: [0, 1, 2], games: 3, hidden: 16, epochs: 18, lr: 0.35,
    maxLinks: 420, out: path.join('runs', 'seed.json'), quiet: false, role: null,
    shares: { keep: 0.2, freeTurn: 0.45 } };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], nx = () => argv[++i];
    if (a === '--stages') o.stages = nx().split(',').map(s => Number(s.trim())).filter(Number.isFinite);
    else if (a === '--games') o.games = Number(nx());
    else if (a === '--role') {
      o.role = nx();
      if (o.role !== 'attack' && o.role !== 'defense')
        throw new Error(`--role 只接受 attack／defense，收到「${o.role}」（不給這個選項就是兩隊混收）`);
    }
    else if (a === '--keep-share') o.shares.keep = Number(nx());
    else if (a === '--free-turn-share') o.shares.freeTurn = Number(nx());
    else if (a === '--stride') { o.shares.keep = 1 / Math.max(1, Number(nx())); }   // 舊選項：等價於全事件同一留率
    else if (a === '--hidden') o.hidden = Number(nx());
    else if (a === '--epochs') o.epochs = Number(nx());
    else if (a === '--lr') o.lr = Number(nx());
    else if (a === '--max-links') o.maxLinks = Number(nx());
    else if (a === '--out') o.out = nx();
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--help') { console.log(HELP); return 0; }
    else throw new Error('unknown arg ' + a);
  }

  console.log(`收老師示範：地圖 ${o.stages.join(',')}｜每圖 ${o.games} 局｜` +
    `席位 ${o.role ? ROLE_LABEL[o.role] + '（只收這一隊的老師）' : '兩隊混收'}｜` +
    `留率 繼續走 ${(o.shares.keep * 100).toFixed(0)}%、自由轉向 ${(o.shares.freeTurn * 100).toFixed(0)}%、卡牆轉向與開火 100%`);
  const data = Teacher.collect({
    stages: o.stages, gamesPerStage: o.games, shares: o.shares, role: o.role,
  });
  const ev = data.meta.eventsSeen, evk = data.meta.eventsKept;
  const evName = data.meta.eventNames;
  console.log(`  ${data.meta.games} 局、${data.meta.rawFrames} 個決定幀 → ${data.samples.length} 筆樣本（${Observation.OBS_DIM} 欄觀測）`);
  console.log('  事件組成的變化：' + Object.keys(ev).map(k =>
    `${evName[k]} ${evk[k]}/${ev[k]}（占樣本 ${(100 * evk[k] / Math.max(1, data.samples.length)).toFixed(1)}%）`).join('、'));
  console.log(`  老師動作分佈：` + data.meta.labelNames
    .map((n, i) => `${n} ${(100 * data.meta.labelShare[i]).toFixed(1)}%`).join(' '));

  const m = fit(data.samples, o);
  const pruned = foldAndPrune(m, o);
  const hist = new InnovationHistory();
  const genome = toGenome(pruned, hist, mulberry32(1));
  // 準確率一律用「會跑進遊戲的那個基因組」量，不用紙上權重：
  // 折疊、修剪、±6 clamp、tanh 輸出層、abstain 門檻每一關都可能吃掉行為。
  // 而且分成兩組量 —— 同一個觀測刻意有「走」與「開火」兩個標籤（見 teacher 的 aim 事件），
  // 混在一起看會把雙標籤誤判成擬合失敗。
  const hold = m.holdSamples;
  const holdTeacher = hold.filter(s => s.event !== 'aim');
  const holdAim = hold.filter(s => s.event === 'aim');
  const gs = genomeAccuracy(genome, holdTeacher);
  const gsAim = genomeAccuracy(genome, holdAim);
  console.log(`擬合：hidden ${m.H}、訓練 ${m.trainN} 筆 / 保留 ${m.holdoutN} 筆、折疊後最大權重 ${pruned.maxAbsWeight.toFixed(2)}`);
  console.log(`  移動忠實度（${holdTeacher.length} 筆老師決定）：修剪 ${pruned.links.length} 條邊 → 基因組 ${(100 * gs.accuracy).toFixed(1)}%` +
    `（含 aim 雙標籤的整體 ${(100 * m.accuracy.holdout).toFixed(1)}%、abstain ${(100 * gs.abstain).toFixed(1)}%）`);
  console.log(`  射擊覆蓋（${holdAim.length} 筆「有射擊線」）：基因組肯開火 ${(100 * gsAim.accuracy).toFixed(1)}%`);
  console.log(`  基因組動作分佈：` + gs.names.map((n, i) => `${n} ${(100 * gs.share[i]).toFixed(1)}%`).join(' '));
  if (!o.quiet) for (const c of m.curve.filter((_, i) => i % 3 === 2))
    console.log(`    epoch ${c.epoch}: train ${(100 * c.train).toFixed(1)}% hold ${(100 * c.holdout).toFixed(1)}%`);

  const file = exportSeed(pruned, {
    // 種子是「哪一席的老師」練出來的：--seed-from 會拿它跟本次訓練的 --role 對，
    // 對不上就拒絕（拿防守種子暖啟動進攻族群，等於第一天就把分工糊回去）。
    role: o.role || null,
    roleLabel: o.role ? ROLE_LABEL[o.role] : '兩隊混收',
    accuracy: { holdout: m.accuracy.holdout, train: m.accuracy.train, genome: gs.accuracy,
      genomeAbstain: gs.abstain, genomeMovement: gs.accuracy, fireCoverage: gsAim.accuracy,
      aimSamples: holdAim.length },
    teacher: data.meta,
    hyper: { hidden: m.H, epochs: o.epochs, lr: o.lr, maxLinks: o.maxLinks },
    genome: genome.toJSON(),
    genomeNodes: genome.nodes.length, genomeLinks: genome.links.size,
  });
  fs.mkdirSync(path.dirname(o.out), { recursive: true });
  fs.writeFileSync(o.out, JSON.stringify(file));
  // 同時產一份「瀏覽器/monitor 看得懂」的基因組檔
  const jsPath = o.out.replace(/\.json$/i, '') + '.genome.json';
  fs.writeFileSync(jsPath, JSON.stringify({
    kind: 'tank-battle-genome', version: 1, obsSpec: Observation.OBS_SPEC,
    role: o.role || null,
    generation: 0, fitness: 0, championGeneration: 0, episodes: 0,
    note: '模仿學習種子（還沒經過 NEAT 進化）' +
      (o.role ? `・${ROLE_LABEL[o.role]}席的老師` : '・兩隊混收（不建議拿去暖啟動單一族群）'),
    genome: genome.toJSON(),
  }));
  console.log(`\n種子 → ${o.out}（${genome.nodes.length} 節點 / ${genome.links.size} 邊）`);
  console.log(`基因組 → ${jsPath}`);
  if (gs.accuracy < 0.6)
    console.log(`⚠ 基因組只複製了老師 ${(100 * gs.accuracy).toFixed(0)}% 的決定 —— 先加樣本（--games）或放寬 --max-links 再訓練，` +
      `否則暖啟動等於換個地方亂猜。`);
  console.log(`下一步：node ai/evolve.js --seed-from ${o.out} --gens 30 --out runs/neat-warm.json`);
  return 0;
}

module.exports = { fit, foldAndPrune, genomeAccuracy, toGenome, buildGenome, importSeed, exportSeed,
  featureStats, validateGenome, main, HELP };

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)) || 0; }
  catch (e) { console.error(e.stack); process.exitCode = 1; }
}
