/* ai/monitor.js — 過程監測的「跑一輪 + 存一份給網頁」
   ═══════════════════════════════════════════════════════════
   telemetry.js 是逐幀記錄器與紅旗規則；這個檔是它的報告產線：

     node ai/monitor.js --ckpt runs/neat-v2.json --stage 0 --games 4

   對每個基因組跑同一批對局，藍座、紅座各跑一遍 —— 座位必須輪流，
   否則「勝率」裡混著地圖偏置。關鍵是「只彙總網路自己開的那一隊」：
   藍座時網路是藍隊、紅座時網路是紅隊，把兩座的紅隊資料合併進
   網路的過程指標，等於把規則 AI 的乾淨數據混進來，紅旗會變淡。

   產出兩份同樣的資料：
     · runs/monitor.json    —— 給工具/diff 用
     · ai/monitor-data.js   —— 給 ai/monitor.html 用

   ⚠ 為什麼要 .js 而不是讓網頁 fetch JSON：
     直接 double-click 開頁面是 file:// 協議，瀏覽器會把
     fetch('runs/monitor.json') 擋掉。所以資料寫成「賦值語句」，
     用 <script src> 讀。
   ═══════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');

const { Arena } = require('./arena');
const Checkpoint = require('./checkpoint');
const Observation = require('./observation');
const { Genome } = require('./neat');
const { RULES } = require('./telemetry');
const { hashSeed } = require('./rng');
const ACTION_NAMES = require('./actions').ACTION_NAMES;

/** 支援三種存檔：訓練 checkpoint、--export 的基因組檔、模仿學習種子 */
function loadGenome(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const spec = j.obsSpec;
  if (spec && spec.version !== Observation.OBS_SPEC.version)
    throw new Error(`monitor: ${file} 的觀測規格 v${spec.version}（${spec.dim} 欄）與現行 ` +
      `v${Observation.OBS_SPEC.version}（${Observation.OBS_DIM} 欄）不符 —— 舊基因組的權重接到別的感測器上，跑出來的數字沒有意義`);
  if (j.kind === 'tank-battle-imitation-seed') {
    return {
      genome: Genome.fromJSON(j.genome),
      label: `${path.basename(file)} 模仿種子（還沒進化）`,
      generation: 0,
      fitness: j.accuracy ? j.accuracy.genome : null,
      championGeneration: 0,
      episodes: 0,
      config: null,
      growth: [],
    };
  }
  if (j.kind === Checkpoint.KIND) {
    return {
      genome: Genome.fromJSON(j.champion.genome),
      label: `${path.basename(file)} 第 ${j.neat.generation} 代`,
      generation: j.neat.generation,
      fitness: j.champion.fitness,
      championGeneration: j.champion.generation,
      episodes: j.episodes,
      config: j.config,
      growth: (j.neat.history || []).map(h => ({ gen: h.gen, best: h.best, mean: h.mean, species: h.species })),
    };
  }
  if (j.kind === 'tank-battle-genome') {
    return {
      genome: Genome.fromJSON(j.genome),
      label: `${path.basename(file)} 第 ${j.generation} 代`,
      generation: j.generation,
      fitness: j.fitness,
      championGeneration: j.championGeneration,
      episodes: j.episodes,
      config: null,
      growth: [],
    };
  }
  throw new Error(`monitor: ${file} 不是本專案的訓練存檔（kind=${j.kind}）`);
}

const sum = a => a.reduce((x, v) => x + v, 0);

/** 取出這一批對局裡「指定隊伍」的逐局遙測，並把熱點格子掛上去 */
function rowsOf(games, teamId) {
  const out = [];
  for (const g of games) {
    const t = g.telemetry && g.telemetry.teams[teamId];
    if (!t) continue;
    const h = g.telemetry.heat.find(x => x.team === teamId);
    t.heatCells = h ? h.cells : [];
    t.terrain = g.telemetry.terrain;
    out.push(t);
  }
  return out;
}

/**
 * 把多局同角色的遙測合併成「一組過程指標 + 紅旗」。
 * @param {object[]} rows  telemetry.teams[] 的切片（同一角色，跨座位）
 * @param {object}  o      { role, label }
 */
function aggregate(rows, o = {}) {
  if (!rows.length) return null;
  const field = sum(rows.map(r => r.fieldFrames));
  const act = new Array(5).fill(0);
  let actN = 0;
  for (const r of rows) {
    if (!r.actionShare) continue;
    for (let i = 0; i < 5; i++) act[i] += r.actionShare[i] * r.actionN;
    actN += r.actionN;
  }
  const bd = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.bulletDeaths)) bd[k] = (bd[k] || 0) + v;
  const bdN = sum(Object.values(bd));
  const w = k => sum(rows.map(r => r[k] * r.fieldFrames)) / Math.max(1, field);
  const heat = new Map();
  for (const r of rows) for (const c of r.heatCells) {
    const k = c.x + ',' + c.y;
    heat.set(k, (heat.get(k) || 0) + c.f);
  }
  const s = {
    role: o.role || 'team',
    label: o.label || '',
    team: o.team === undefined ? null : o.team,
    episodes: rows.length,
    tanks: sum(rows.map(r => r.tanks)),
    ctrlTanks: sum(rows.map(r => r.ctrlTanks)),
    fieldFrames: field,
    actionN: actN,
    actionNames: ACTION_NAMES,
    actionShare: actN ? act.map(a => a / actN) : null,
    blockedShare: w('blockedShare'),
    fireWhileBlockedShare: w('fireWhileBlockedShare'),
    fireShare: w('fireShare'),
    abstainShare: w('abstainShare'),
    shots: sum(rows.map(r => r.shots)),
    bulletDeaths: bd,
    bulletDeathsN: bdN,
    unbreakableHitShare: bdN
      ? ((bd.steel || 0) + (bd.water || 0) + (bd.forest || 0) + (bd.ice || 0) + (bd.other || 0)) / bdN : 0,
    brickDestroyed: sum(rows.map(r => r.brickDestroyed)),
    borderHits: bd.boundary || 0,
    advancePx: sum(rows.map(r => r.advancePx)) / rows.length,
    distinctCells: sum(rows.map(r => r.distinctCells)) / rows.length,
    maxStay: Math.max(...rows.map(r => r.maxStay)),
    stuckTanks: sum(rows.map(r => r.stuckTanks)),
    kills: sum(rows.map(r => r.kills)),
    deaths: sum(rows.map(r => r.deaths)),
    ownBaseCellsLost: sum(rows.map(r => r.ownBaseCellsLost)),
    selfBaseShots: sum(rows.map(r => r.selfBaseShots || 0)),
    baseLost: rows.filter(r => !r.ownBaseAlive).length,
    won: rows.filter(r => r.won).length,
    heatCells: [...heat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 90)
      .map(([k, v]) => { const [x, y] = k.split(',').map(Number); return { x, y, f: v }; }),
  };
  // 紅旗以「合併後的過程指標」判：逐局判會因樣本太小而忽亮忽滅，
  // 這裡要的是「這一版基因組整體上像不像個健康選手」。
  s.flags = RULES.filter(r => { try { return r.test(s); } catch (e) { return false; } })
    .map(r => ({ id: r.id, label: r.label, value: String(r.value(s)), limit: r.limit, why: r.why, fix: r.fix }));
  return s;
}

function runGames(pol, o, seat) {
  const arena = new Arena({ maxFrames: o.maxFrames });
  const games = [];
  for (let i = 0; i < o.games; i++) {
    const seed = hashSeed(0x7e1e, o.stage, i);
    games.push(arena.run({
      stage: o.stage, seed,
      blue: seat === 0 ? pol : 'rule',
      red: seat === 1 ? pol : 'rule',
      maxFrames: o.maxFrames, record: true,
    }));
  }
  return games;
}

/** @param {{ckpt:string[],stage:number,games:number,maxFrames:number}} o */
function buildOne(file, o) {
  const g = loadGenome(file);
  const pol = { kind: 'policy', policy: g.genome.toPolicy() };
  const blue = runGames(pol, o, 0);       // 網路坐藍
  const red = runGames(pol, o, 1);        // 網路坐紅
  const policy = aggregate(rowsOf(blue, 0).concat(rowsOf(red, 1)), { role: 'policy', label: '訓練網路' });
  const foe = aggregate(rowsOf(blue, 1).concat(rowsOf(red, 0)), { role: 'rule', label: '規則 AI（對照）' });

  const games = blue.concat(red).map((r, i) => ({
    index: i,
    seat: i < o.games ? 'blue' : 'red',
    stage: r.stage, seed: r.seed, winner: r.winner, frames: r.frames, capped: r.capped,
    terrain: r.telemetry.terrain,
    grid: r.telemetry.grid,          // 這一局的地形（磚被打掉的進度各局不同）
    bases: r.telemetry.bases,
    policy: r.telemetry.teams[i < o.games ? 0 : 1],
    foe: r.telemetry.teams[i < o.games ? 1 : 0],
  }));
  const wins = blue.filter(r => r.winner === 0).length + red.filter(r => r.winner === 1).length;
  // 地形快照：網頁要能把「車卡在哪一格」畫在牆壁旁邊。
  // 只有熱點座標而沒有地形，看不出那是死角還是通道，紅旗就成了數字遊戲。
  const t0 = blue[0] && blue[0].telemetry;
  const batch = {
    label: g.label,
    source: file,
    generation: g.generation,
    fitness: g.fitness,
    championGeneration: g.championGeneration,
    episodes: g.episodes,
    growth: g.growth,
    map: t0 ? { grid: t0.grid, bases: t0.bases } : null,
    conclusion: {                     // 「結論面」：留著做對照，它不是重點
      games: games.length,
      policyWins: wins,
      winRate: games.length ? wins / games.length : 0,
      capped: games.filter(r => r.capped).length,
      avgFrames: sum(games.map(r => r.frames)) / Math.max(1, games.length),
      controlShare: policy ? 1 - policy.abstainShare : null,
    },
    policy, foe,
    profiles: [policy, foe].filter(Boolean),
    games,
  };
  batch.flagSummary = batch.policy && batch.policy.flags.length
    ? batch.policy.flags.map(f => f.label).join('、')
    : '✓ 無';
  return batch;
}

const HELP = `用法：node ai/monitor.js [選項]

  --ckpt A,B            要監測的存檔（checkpoint 或 --export 的基因組），逗號分隔可並排比較
  --stage N             地圖索引 0..254（預設 0；上限是 js/constants.js 的 MAP_VARIANTS-1）
  --games N             每個座位跑幾局（預設 4；藍紅各 N 局）
  --max-frames N        單局硬上限（預設 4000）
  --out FILE            JSON 輸出路徑（預設 runs/monitor.json）
  --no-html             不寫 ai/monitor-data.js

輸出：
  runs/monitor.json     完整過程數據
  ai/monitor-data.js    同一份資料的 <script> 版本，給 ai/monitor.html 直接開
  → 開網頁：ai/monitor.html（雙擊即可，資料已內嵌成 JS）

退出碼：0 = 全綠；2 = 至少一個基因組有紅旗（可接在訓練後當門禁）`;

/** 寫給網頁的賦值檔（file:// 下 fetch 會被擋，只能用 <script src>） */
function writeJs(target, data) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target,
    `/* 由 node ai/monitor.js 產生，請勿手改。生成時間 ${data.generatedAt} */\n` +
    `window.MONITOR_DATA = ${JSON.stringify(data)};\n`);
}

function main(argv) {
  const o = { ckpt: ['ai/trained.json'], stage: 0, games: 4, maxFrames: 4000,
    out: path.join('runs', 'monitor.json'), html: 'ai/monitor-data.js' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], nx = () => argv[++i];
    if (a === '--ckpt') o.ckpt = nx().split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--stage') o.stage = Number(nx());
    else if (a === '--games') o.games = Number(nx());
    else if (a === '--max-frames') o.maxFrames = Number(nx());
    else if (a === '--out') o.out = nx();
    else if (a === '--no-html') o.html = null;
    else if (a === '--help') { console.log(HELP); return 0; }
    else throw new Error('unknown arg ' + a);
  }

  console.log(`過程監測：地圖 ${o.stage}｜每座位 ${o.games} 局｜${o.ckpt.length} 個基因組並排`);
  const batches = [];
  for (const file of o.ckpt) {
    const b = buildOne(file, o);
    batches.push(b);
    console.log(`  ${b.label}｜勝率 ${(100 * b.conclusion.winRate).toFixed(0)}%、` +
      `控制權 ${b.conclusion.controlShare === null ? 'n/a' : (100 * b.conclusion.controlShare).toFixed(0) + '%'}｜紅旗：${b.flagSummary}`);
  }
  const data = {
    kind: 'tank-battle-monitor',
    generatedAt: new Date().toISOString(),
    obsSpec: Observation.OBS_SPEC,
    stage: o.stage,
    gamesPerSeat: o.games,
    maxFrames: o.maxFrames,
    weights: require('./fitness').WEIGHTS,
    rules: RULES.map(r => ({ id: r.id, label: r.label, limit: r.limit, why: r.why, fix: r.fix })),
    batches,
  };
  fs.mkdirSync(path.dirname(o.out), { recursive: true });
  fs.writeFileSync(o.out, JSON.stringify(data, null, 1));
  console.log(`\n過程數據 → ${o.out}`);
  if (o.html) {
    writeJs(o.html, data);
    console.log(`網頁資料 → ${o.html}（開 ai/monitor.html 看圖）`);
  }
  const dirty = batches.filter(b => b.policy && b.policy.flags.length);
  console.log(dirty.length
    ? `✗ ${dirty.length}/${batches.length} 個基因組有紅旗 —— 別把它當成「變強了」`
    : '✓ 全部通過過程檢查');
  return dirty.length ? 2 : 0;
}

module.exports = { main, buildOne, aggregate, rowsOf, loadGenome, HELP };

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)) === 2 ? 2 : 0; }
  catch (e) { console.error(e.stack); process.exitCode = 1; }
}
