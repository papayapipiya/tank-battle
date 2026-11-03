/* ai/split.js — 把「一個什麼都會的模型」拆成「進攻模型＋防守模型」兩族
   ═══════════════════════════════════════════════════════════
   使用者的方向修正：藍＝進攻、紅＝防守，各自有各自的訓練模型。
   舊的 runs/warm-v2.json 是 v5 時代的單模型（同一隻網路藍紅各坐一次取平均），
   它的冠軍確實「會打」，所以拿它當兩個新族群的種子，而不是丟掉重練。

   為什麼不是 `--seed-from` 那份模仿種子？
     因為 loadWarmSeed 只準收「tank-battle-imitation-seed」：那種檔存的是符號化
     端點，會照當前的創新歷史重新登記號碼。舊冠軍帶的是另一本帳的創新號，
     直接塞進一本新 history 會讓 crossover 把兩條不同的邊當成同一條 ——
     那種錯幾十代之後才顯形。所以這裡的做法是「把來源的創新歷史一起搬過來」：
     號碼的對應關係保持原樣，族群由同一份冠軍變異而出。

   兩族的差別只在角色（seat／評判標準／對手），不在網路起點：
     · attack  → 藍席，只有打掉紅隊老鷹才算贏，標準 termsFor('attack') 項
     · defense → 紅席，撐過 30 秒 或 打掉藍隊老鷹就贏，標準 termsFor('defense') 項
   同一份種子、兩把不同的尺 —— 這正是「各自有各自的訓練模型」的含義。

   用法：
     node ai/split.js                             # 用預設來源與預設輸出兩份檔
     node ai/split.js --from runs/warm-v2.json --gens-note "v6 開機"
     node ai/split.js --pop 24 --force            # 覆寫已存在的兩份 v6 存檔
     node ai/split.js --role attack               # 只產生進攻族

   產生完就能接：
     node ai/evolve.js --resume runs/attack-v6.json  --gens 20 --vs ai/trained-defense.json
     node ai/evolve.js --resume runs/defense-v6.json --gens 20 --vs ai/trained-attack.json
   （實際上是 ai/auto-train.js 在交替跑這兩條，見該檔說明）
   ═══════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const { NEAT, Genome, InnovationHistory } = require('./neat');
const { Arena } = require('./arena');
const Observation = require('./observation');
const { ACTION_COUNT } = require('./actions');
const { evaluatePolicy, SCORING_VERSION, ROLES, ROLE_LABEL, termsFor } = require('./fitness');
const Checkpoint = require('./checkpoint');
const Ledger = require('./ledger');
const { mulberry32, hashSeed } = require('./rng');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_FROM = path.join(ROOT, 'runs', 'warm-v2.json');
const DEFAULT_OUT = {
  attack: path.join(ROOT, 'runs', 'attack-v6.json'),
  defense: path.join(ROOT, 'runs', 'defense-v6.json'),
};

const HELP = `ai/split.js — 由舊的單模型存檔產生「進攻／防守」兩個族群

  node ai/split.js [--from runs/warm-v2.json] [--pop 24] [--role attack|defense|both] [--force]

  來源沒有冠軍（沒練過）時會拒絕：兩族都需要一個「會開車」的起點，
  從隨機權重分出來的兩族只是兩個隨機數，看不出角色差異。`;

function rel(p) { return path.relative(ROOT, p).replace(/\\/g, '/'); }

function parse(argv) {
  const o = { from: DEFAULT_FROM, pop: null, role: 'both', force: false, note: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 需要一個值`);
      return v;
    };
    switch (a) {
      case '--from': o.from = path.resolve(take()); break;
      case '--pop': o.pop = Number(take()); break;
      case '--role': o.role = take(); break;
      case '--force': o.force = true; break;
      case '--gens-note': o.note = take(); break;
      case '--help': case '-h': o.help = true; break;
      default: throw new Error(`unknown arg: ${a}`);
    }
  }
  if (!['both', ROLES.ATTACK, ROLES.DEFENSE].includes(o.role))
    throw new Error(`--role 只能是 both／attack／defense（收到 ${o.role}）`);
  if (o.pop !== null && (!Number.isInteger(o.pop) || o.pop < 2))
    throw new Error(`--pop 要是 ≥2 的整數（收到 ${o.pop}）`);
  return o;
}

/**
 * 一個角色 → 一份合法的 checkpoint。
 * @param {object} src 已 load 的來源存檔
 * @param {string} role 'attack' | 'defense'
 */
function build(src, role, o) {
  const champGenome = src.champion.genome;
  const srcCfg = src.config || {};
  const cfg = {
    stages: (srcCfg.stages && srcCfg.stages.length ? srcCfg.stages : [0, 1]).slice(),
    seeds: srcCfg.seeds || 2,
    opponent: 'rule',                       // 沒有 --vs 時的預設；交替訓練由外層覆寫
    pop: o.pop || (srcCfg.pop || src.neat.population.length) || 24,
    maxFrames: 2400,                        // v6：規則上一局最多 1890 幀
    role,
    seats: 1,                               // 單座位：只坐自己那一席
  };

  // ── 創新歷史整個搬過來（不是只搬基因組）──
  // 冠軍的每條邊都帶著「來源那本帳」的創新號；沿用同一本帳，
  // 之後 mutateAddConn／mutateAddNode 要號碼時才會繼續往後編，不會撞號。
  const rand = mulberry32(hashSeed(0x5ed5, role === ROLES.DEFENSE ? 1 : 0, cfg.pop));
  const neat = new NEAT({
    obsDim: Observation.OBS_DIM, nOut: ACTION_COUNT,
    hist: InnovationHistory.fromJSON(src.neat.hist), rand,
  });
  const seed = Genome.fromJSON(champGenome);
  neat.initializeFrom(seed, cfg.pop);

  // ── 起始成績照新的尺重量（v6 的分跟來源的 v5 分不是同一個單位）──
  // 這一圈局不記進 meta.episodes：那是「評審校準」，不是訓練。
  const arena = new Arena({ maxFrames: cfg.maxFrames });
  let sum = 0, games = 0;
  for (const stage of cfg.stages) {
    for (let s = 0; s < cfg.seeds; s++) {
      const r = evaluatePolicy(arena, seed.toPolicy(), {
        stage, seed: hashEval(stage, s), opponent: 'rule', role, maxFrames: cfg.maxFrames,
      });
      sum += r.score; games++;
    }
  }
  const start = sum / games;

  const at = new Date().toISOString();
  const fingerprint = Ledger.fingerprint(champGenome);
  const state = {
    kind: Checkpoint.KIND,
    formatVersion: Checkpoint.FORMAT_VERSION,
    updatedAt: at,
    role,
    obsSpec: Observation.OBS_SPEC,
    scoringVersion: SCORING_VERSION,
    config: cfg,
    episodes: 0,
    champion: {
      generation: 0, fitness: start, scoringVersion: SCORING_VERSION,
      role, genome: champGenome,
    },
    championLog: [{ generation: 0, fitness: start, fingerprint, at, session: 1 }],
    sessions: [{
      startedAt: at, finishedAt: at,
      source: 'split',
      from: rel(o.from),
      file: rel(DEFAULT_OUT[role]),
      role, stages: cfg.stages.slice(),
      args: { pop: cfg.pop, seeds: cfg.seeds, opponent: 'rule', vs: null, role, seats: 1,
        maxFrames: cfg.maxFrames, gens: 0, episodes: null, rngSeed: null, saveEvery: 2 },
      fromGeneration: 0, toGeneration: 0, fromEpisodes: 0, toEpisodes: 0,
      generations: 0, episodes: 0, best: start, mean: start, species: null,
      elapsedSec: 0, scoringVersion: SCORING_VERSION,
      championFitness: start, championFingerprint: fingerprint,
      // 分裂這一筆要留在檔案裡：日後履歷上「這個模型練了幾次」的第一段
      // 必須能說清楚「它不是從零長出來的，是從某某存檔第 N 代的冠軍拆出來的」。
      split: {
        from: rel(o.from),
        fromGeneration: src.neat.generation,
        fromFitness: src.champion.fitness,
        fromScoringVersion: src.champion.scoringVersion || src.scoringVersion || null,
        fromFingerprint: fingerprint,      // 同一份基因組，指紋當然相同
        games,                             // 重評用了幾場校準局
        note: o.note || null,
      },
    }],
    assessments: [],
    neat: neat.toJSON(),
  };
  return { state, cfg, start, games, fingerprint, neat };
}

/** 跟 ai/evolve.js 的 evalSeed 同一把 salt：起始分數才跟之後的代數可比 */
function hashEval(stage, s) { return hashSeed(0x5eed, stage, s); }

function main(argv) {
  const o = parse(argv);
  if (o.help) { console.log(HELP); return; }
  if (!Checkpoint.exists(o.from))
    throw new Error(`讀不到來源 ${rel(o.from)}（--from 指定別份存檔）`);
  const src = Checkpoint.load(o.from, Observation.OBS_SPEC);   // 觀測規格不合會直接拒絕
  if (!src.champion || !src.champion.genome)
    throw new Error(`${rel(o.from)} 裡沒有冠軍基因組：分裂的前提是要有一隻「已經會打」的網路`);

  console.log(`來源 ${rel(o.from)}｜第 ${src.neat.generation} 代｜` +
    `fitness ${Number(src.champion.fitness).toFixed(2)}（算分 v${src.champion.scoringVersion || src.scoringVersion || '?'}）｜` +
    `考題 ${JSON.stringify((src.config && src.config.stages) || [])}×${(src.config && src.config.seeds) || '?'} 種子`);
  console.log(`來源是單模型（藍紅各坐一次取平均）；拆成兩族後各自只坐自己那一席，用兩套不同的評判標準。\n`);

  const roles = o.role === 'both' ? [ROLES.ATTACK, ROLES.DEFENSE] : [o.role];
  for (const role of roles) {
    const out = DEFAULT_OUT[role];
    if (fs.existsSync(out) && !o.force)
      throw new Error(`${rel(out)} 已存在（加 --force 覆蓋；那是另一段獨立的訓練史，別把它當接續檔）`);
    const r = build(src, role, o);
    Checkpoint.save(out, r.state);
    console.log(`  ${role}（${ROLE_LABEL[role]}｜${role === 'defense' ? '紅' : '藍'}席）` +
      `→ ${rel(out)}：族群 ${r.cfg.pop}，評判標準 ${termsFor(role).length} 項，` +
      `起始分 ${r.start.toFixed(2)}（${r.games} 場校準局按 v${SCORING_VERSION} 重量，` +
      `與來源的舊分 ${Number(src.champion.fitness).toFixed(2)} 不是同一個單位）`);
  }
  console.log(`\n下一步（交替自我對弈，由 ai/auto-train.js 自動跑）：`);
  console.log(`  node ai/auto-train.js --gens 20`);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (e) { console.error(`✗ ${e.message}`); process.exitCode = 1; }
}

module.exports = { parse, build, DEFAULT_FROM, DEFAULT_OUT };
