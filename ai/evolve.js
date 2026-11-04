/* ai/evolve.js — 訓練迴圈 CLI（v6 起：一個程序只練一個角色）
   ═══════════════════════════════════════════════════════════
   用法：
     node ai/evolve.js --role attack  --gens 20 --pop 24 --stages 0,1 --out runs/attack-v6.json
     node ai/evolve.js --role defense --gens 20 --vs ai/trained-attack.json --out runs/defense-v6.json
     node ai/evolve.js --report runs/attack-v6.json
     node ai/evolve.js --status runs/defense-v6.json        # 不打一局，只問還在跑嗎

   「今天跑 100 場、明天接著跑」：
     第 1 天  node ai/evolve.js --role attack --gens 20 --out runs/attack-v6.json
     第 2 天  node ai/evolve.js --resume runs/attack-v6.json --gens 20
   同一份 --out 就是進度；--resume 會把 population / species /
   innovation history / generation／角色全部接回去（理由見 ai/checkpoint.js）。

   ⚠ v6 之後「座位」不是中性的了
   ─────────────────────────────────
   使用者把方向改成藍＝進攻、紅＝防守，兩隊各自有各自的模型。
   所以一支族群只坐自己那一席（attack→藍、defense→紅），不再「同一隻
   網路藍紅各坐一次取平均」：那樣等於用另一種工作的成績稀釋本工作的成績。
   席位固定帶來的偏置，改由「考題＝多地圖 × 多種子」分攤。

   一代之後的成本算法：
     pop × stages × seeds × 1（單座位）
     = 24 × 2 × 2 = 96 場/代，實測 ~25 ms/場 ⇒ 約 3 秒/代。
   ═══════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const { NEAT, Genome, betterGenome } = require('./neat');
const { Arena } = require('./arena');
const Observation = require('./observation');
const { ACTION_COUNT } = require('./actions');
const { evaluatePolicy, SCORING_VERSION, ROLES, ROLE_LABEL, termsFor } = require('./fitness');
const Checkpoint = require('./checkpoint');
const { mulberry32, hashSeed } = require('./rng');
const Ledger = require('./ledger');
const Live = require('./live');

const HELP = `
tank-battle NEAT 訓練（v6：進攻／防守兩個模型各練各的）

  node ai/evolve.js --role attack  --gens 20 --pop 24 --stages 0,1 --seeds 2 --out runs/attack-v6.json
  node ai/evolve.js --role defense --gens 20 --vs ai/trained-attack.json --out runs/defense-v6.json
  node ai/evolve.js --seed-from runs/seed.json --role attack --gens 30 --out runs/attack.json   # 暖啟動
  node ai/evolve.js --resume runs/attack-v6.json --gens 20                    # 明天接續（角色存在檔裡）
  node ai/evolve.js --report runs/attack-v6.json                              # 看收斂曲線 + 實戰勝率
  node ai/evolve.js --export runs/attack-v6.json --to ai/trained-attack.json  # 匯出冠軍給瀏覽器觀戰
  node ai/evolve.js --resume runs/defense-v6.json --gens 20 --export-to ai/trained-defense.json
  node ai/evolve.js --status runs/defense-v6.json                   # 只問一句：還在跑嗎

  --role X        attack｜進攻（坐藍席，30 秒內必須打掉紅隊老鷹才算贏）
                  defense｜防守（坐紅席，撐過 30 秒 或 打掉藍隊老鷹就贏）
                  預設 attack；--resume 時存檔已記角色，會沿用它（給錯就直接報錯）
  --vs FILE       對手改成另一個角色的冠軍（匯出的基因組或 checkpoint 都行）。
                  交替自我對弈靠這個：練防守時把最新進攻冠軍放進藍席，
                  練進攻時把最新防守冠軍放進紅席。沒給才用 --opponent。

  --ref FILE      另一把「永不更新」的參考尺：每代另用同一份凍結快照打一次考題，
                  分數只記進觀測（meta.reference），不進適應度、不影響選擇。
                  預設找「對面那席」的凍結模型（練進攻→ai/refs/reference-defense.json，
                  練防守→ai/refs/reference-attack.json，跟 --vs 同一邊），找不到就只用規則 AI；
                  --no-ref 完全關閉。用途：交替演化的對手每輪都在變（實測同一隻網路
                  56.77 → 20.16 只是對面變強了），有固定尺才分得開「真進步」跟「換尺」。
  --ref-every N   每幾代量一次參考尺（預設 1；N 愈大愈省場數、曲線愈粗）

  --status FILE   讀存檔回報「第幾代／幾場／最後落盤幾秒前」，不打任何一局，
                  所以可以邊開觀戰頁邊查另一支正在跑的訓練

  --export-to FILE  訓練結束時自動把冠軍匯出到該檔（等於幫觀戰頁面更新快照）
  --export-every N  每 N 代就刷新 --export-to（自動跟隨用；預設只在結束時）
                    不給這參數時，ai/trained-attack.json 會一直停在舊快照，
                    網頁上的代數／適應度也就不會變

  --gens N        本次跑幾代；0 = 只受 --episodes 限制（預設 0）
  --episodes N    本次最多跑幾場 arena（預設不設；兩個上限至少要給一個）
  --pop N         族群大小（預設 24）
  --stages a,b    評估用哪些地圖編號（0..254 = js/constants.js 的 MAP_VARIANTS-1，預設 0,1）。
                  地形由 js/mapgen.js 依編號生成：同一個編號在任何機器上同一張圖。
                  續練時明確給這個參數＝換考題（把沒練過的地圖加進來）；
                  舊冠軍會先在新考題重評，換圖前後的分數不可直接比
  --seeds N       每張地圖幾個種子（預設 2）
  --opponent X    rule | random | best（best = 跟目前冠軍自我對弈；被 --vs 覆寫）
  --seed-from F   從模仿種子（node ai/imitate.js 產的 runs/seed.json）暖啟動整個族群
  --save-every N  每幾代落盤（預設 2）
  --seed N        隨機種子（重現整次訓練用）
  --max-frames N  無頭引擎的保險絲幀數（預設 2400；規則上一局最多 1890 幀）
  --no-live       不寫 ai/live-data.js（測試／批次用；正常訓練會每代更新即時看板）
`;

/** `--role` 的拼法容忍度：中英、大小寫、a／d 縮寫都認，但不認「雙方都要」 */
function normalizeRole(v) {
  const s = String(v || '').trim().toLowerCase();
  if (['attack', 'a', 'att', '進攻', '進攻'].includes(s)) return ROLES.ATTACK;
  if (['defense', 'defence', 'd', 'def', '防御', '防守'].includes(s)) return ROLES.DEFENSE;
  if (!v) return ROLES.ATTACK;             // 沒給就練進攻，但會另外印一行說明
  throw new Error(`--role：${v} 不是角色（只能是 attack／進攻 或 defense／防守）`);
}

function parseArgs(argv) {
  const o = {
    gens: 0, episodes: null, pop: 24, stages: [0, 1], stagesSet: false, seeds: 1,
    opponent: 'rule', out: 'runs/neat.json', resume: null,
    seedFrom: null, role: null, vs: null,
    ref: null, noRef: false, refEvery: 1,
    report: null, export: null, to: 'ai/trained.json',
    exportTo: null, exportEvery: 0, status: null,
    saveEvery: 2, seed: 20261031, maxFrames: 2400, quiet: false, live: true,
  };
  const num = v => Number(v);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => argv[++i];
    switch (a) {
      case '--gens': o.gens = num(take()); break;
      case '--episodes': o.episodes = num(take()); break;
      case '--pop': o.pop = num(take()); break;
      // stagesSet 要單獨記：--resume 預設沿用 checkpoint 的考題，
      // 只有使用者「明確」打了 --stages 才準換圖 —— 否則每次接續都會
      // 被 CLI 的預設 [0,1] 悄悄蓋掉上一輪的考題。
      case '--stages':
        o.stages = String(take()).split(',').map(s => Number(s.trim()));
        o.stagesSet = true; break;
      case '--seeds': o.seeds = num(take()); break;
      case '--opponent': o.opponent = take(); break;
      case '--role': o.role = normalizeRole(take()); break;
      case '--vs': o.vs = take(); break;
      case '--ref': o.ref = take(); break;
      case '--no-ref': o.noRef = true; break;
      case '--ref-every': o.refEvery = num(take()); break;
      case '--seed-from': o.seedFrom = take(); break;
      case '--out': o.out = take(); break;
      case '--resume': o.resume = take(); o.out = o.resume; break;
      case '--save-every': o.saveEvery = num(take()); break;
      case '--seed': o.seed = num(take()); break;
      case '--max-frames': o.maxFrames = num(take()); break;
      case '--report': o.report = take(); break;
      case '--status': o.status = take(); break;
      case '--export': o.export = take(); break;
      case '--to': o.to = take(); break;
      case '--export-to': o.exportTo = take(); break;
      case '--export-every': o.exportEvery = num(take()); break;
      case '--quiet': o.quiet = true; break;
      case '--no-live': o.live = false; break;
      case '--help': case '-h': o.help = true; break;
      default: throw new Error(`unknown arg: ${a}`);
    }
  }
  return o;
}

/** 關卡清單：整數、在範圍內、去重。1.5 或 99 這種不能默默吞掉。 */
function normalizeStages(list, max) {
  const out = [];
  for (const s of list) {
    if (!Number.isInteger(s) || s < 0 || s >= max)
      throw new Error(`--stages：${s} 不是有效關卡（可用 0..${max - 1}）`);
    if (!out.includes(s)) out.push(s);
  }
  if (!out.length) out.push(0);
  return out;
}

/** 評估種子：刻意不含 generation —— 否則每代考題不同，best 曲線就不可比 */
function evalSeed(stage, s) { return hashSeed(0x5eed, stage, s); }

/**
 * 本段訓練的考題 = 地圖 × 種子，一次算好、整段共用（共種子配對）。
 * ═══════════════════════════════════════════════════════════
 * 為什麼要把它變成一個清單而不是一個巢狀迴圈：
 *   「同一代所有個體吃同一組 (stage, seed)」原本是隱含性質（evalSeed 是純函數），
 *   隱含性質不會被測試盯住，也無法被別的程式引用。變成 exam 之後：
 *     · 重評、每代評估、參考尺用的是同一份卷，不會各算各的；
 *     · 履歷／看板能列出「這 8 場是哪些圖、哪些種子」，逐場差值才解得開；
 *     · 未來要加「逐場配對比較」有現成的結構可用。
 * 種子固定用 0x5eed 混入 (stage, s)：同一張圖的不同種子才是真的不同局，
 * 而改 --stages／--seeds 一定走冠軍重評（examChange），分數不會跨卷硬比。
 */
function buildExam(cfg) {
  const out = [];
  for (const stage of cfg.stages)
    for (let s = 0; s < cfg.seeds; s++)
      out.push({ stage, seed: evalSeed(stage, s), s });
  if (!out.length) throw new Error('考題是空的：--stages／--seeds 至少要各給 1');
  return out;
}

function championSpec(champ) {
  return champ ? { kind: 'policy', policy: Genome.fromJSON(champ.genome).toPolicy() } : 'rule';
}

/**
 * 讀「對手的基因組」→ arena 的 controller spec。
 * ═══════════════════════════════════════════════════════════
 * 交替自我對弈（--vs）要的就是這個：練防守時把進攻方最新的冠軍放進藍席，
 * 練進攻時把防守方最新的冠軍放進紅席。兩種檔都吃 ——
 *   · 匯出的快照（tank-battle-genome，ai/trained-*.json）—— 自動訓練用的那條路
 *   · checkpoint（tank-battle-neat-checkpoint，runs/*.json）—— 手動練完想直接拿
 * 觀測規格不合就在這裡擋掉：欄位變了舊基因組全部作廢，
 * 硬上場不會報錯、只會練出一個「看起來在進步」的假曲線。
 */
function loadOpponent(file, label = '--vs') {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs))
    throw new Error(`${label}：讀不到 ${file}（對手要用另一個角色匯出的冠軍，如 ai/trained-defense.json）`);
  const j = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const genome = j.kind === Checkpoint.KIND ? (j.champion && j.champion.genome) : j.genome;
  if (!genome)
    throw new Error(`${label}：${file} 裡面沒有基因組（要嘛是 champion.genome，要嘛是 genome）`);
  const spec = j.obsSpec || null;
  if (spec && spec.version !== Observation.OBS_SPEC.version)
    throw new Error(`${label}：${file} 的觀測規格 v${spec.version}（${spec.dim} 欄）與現行 ` +
      `v${Observation.OBS_SPEC.version}（${Observation.OBS_DIM} 欄）不符，那份冠軍已作廢`);
  const cfg = j.config || (j.provenance && j.provenance.config) || {};
  return {
    kind: 'policy',
    policy: Genome.fromJSON(genome).toPolicy(),
    // 對手的「身分」：交替演化時同一個檔名每輪內容都不同，只比路徑會漏判換尺。
    fingerprint: (() => { try { return Ledger.fingerprint(genome); } catch { return null; } })(),
    // 帶出來只為顯示與履歷：對面坐的是哪個角色、第幾代、快照分數
    role: j.role || cfg.role || null,
    generation: j.neat ? j.neat.generation : (j.generation ?? null),
    fitness: j.champion ? j.champion.fitness : (j.fitness ?? null),
    file: abs,
  };
}

/**
 * 「這一份分數是拿誰當尺量的」—— 交替自我對弈一定要記這個。
 * ═══════════════════════════════════════════════════════════
 * 冠軍的數字只跟「當時的對手」比才有意義：打規則 AI 拿 91.6，改成打對面
 * 訓練過的冠軍大概只剩 60。尺換了卻不重評，舊那個 91.6 會一直壓著新世代
 * （bestSoFar 永遠贏不了它），於是代數一路上漲、冠軍幾十代不動 ——
 * 使用者看到的就是「玩了很多場，數字都沒增加」。
 * key 給程式比對（含對手基因組指紋，對面換代就會不同），label 給人和履歷看。
 */
function opponentRuler(external, opponent) {
  if (external) {
    const fp = String(external.fingerprint || '?').slice(0, 12);
    return {
      key: `vs:${relOf(external.file)}#${fp}`,
      label: `對面冠軍 ${relOf(external.file)}` +
        `（${ROLE_LABEL[external.role] || external.role || '?'} 第 ${external.generation ?? '?'} 代` +
        `・指紋 ${fp}）`,
      external: true,
    };
  }
  const who = opponent === 'best' ? 'self' : opponent === 'random' ? 'random' : 'rule';
  return {
    key: who,
    label: opponent === 'best' ? '自己的冠軍（自我對弈，尺每代都在動）'
      : opponent === 'random' ? '隨機操作' : '遊戲內建規則 AI',
    external: false,
  };
}

/** 舊存檔沒記 ruler 時的推導：只能從 config 的 vs／opponent 反推一把大概的尺。 */
function rulerFromConfig(cfg) {
  if (cfg && cfg.vs) return { key: `vs:${cfg.vs}`, label: `對面冠軍 ${cfg.vs}（舊存檔未記指紋）`, external: true };
  const who = (cfg && cfg.opponent) || 'rule';
  return opponentRuler(null, who);
}

/** 對手是谁：--vs 的基因組 > --opponent best（自我對弈）> random > rule */
function makeOpponentResolver(o, meta, cfg) {
  const external = o.vs ? loadOpponent(o.vs) : null;
  const ruler = opponentRuler(external, cfg.opponent);
  if (external) {
    const away = external.role
      ? `${ROLE_LABEL[external.role] || external.role}` : '角色未記錄';
    if (!o.quiet)
      console.log(`對手：外部基因組 ${relOf(external.file)}（${away}｜第 ${external.generation} 代｜` +
        `快照分 ${external.fitness === null ? '—' : Number(external.fitness).toFixed(2)}）`);
    return Object.assign(() => external, { ruler });
  }
  return Object.assign(
    () => (cfg.opponent === 'best' && meta.champion ? championSpec(meta.champion)
      : cfg.opponent === 'random' ? 'random' : 'rule'),
    { ruler });
}

/**
 * 固定參考尺（解決「曲線上漲是真進步還是尺變了」）。
 * ═══════════════════════════════════════════════════════════
 * 交替演化打的對手是「對面最新的冠軍」，那把尺每輪都在動：實測過同一隻網路
 * 56.77 → 20.16，只是對面變強了。排序仍要用活對手（協同演化才是我們要的訓練），
 * 但判讀趨勢需要兩把「永遠不動的尺」：
 *   1) 遊戲內建規則 AI（--opponent rule 的那把，最軟也最穩）
 *   2) 一份凍結的快照（--ref 給的檔案；訓練途中絕對不改它）
 * 每代拿「本代最佳個體」各跑一遍考題，結果存進 meta.reference.history，
 * 看板與履歷用它當第二條曲線。這純粹是觀測：不進適應度、不影響選擇。
 * 成本：2 × 場數（8 場考題 → 每代多 16 場，約 +8%）。
 */
function makeReference(o, cfg, exam, arena) {
  const rulers = [{ key: 'rule', label: '遊戲內建規則 AI', spec: 'rule' }];
  if (o.ref) {
    const ext = loadOpponent(o.ref, '--ref');
    const fp = String(ext.fingerprint || '?').slice(0, 12);
    rulers.push({
      key: `ref:${relOf(ext.file)}#${fp}`,
      label: `凍結快照 ${relOf(ext.file)}（${ROLE_LABEL[ext.role] || ext.role || '?'} ` +
        `第 ${ext.generation ?? '?'} 代・指紋 ${fp}・永不更新）`,
      spec: ext,
    });
  }
  return {
    scoringVersion: SCORING_VERSION,
    role: cfg.role,
    exam: exam.map(e => ({ stage: e.stage, seed: e.seed, s: e.s })),
    rulers: rulers.map(r => ({ key: r.key, label: r.label })),
    note: o.ref
      ? '兩把尺都不參與選擇：rule 是最軟的基準，ref 是凍結的對手機（內容永不改）。' +
        '曲線上下波動但這兩條同向，就是真的變強／變弱；只有活對手動、這兩條不動＝換尺。'
      : '未給 --ref：只有規則 AI 一把基準尺（凍結快照能分辨「換尺」與「變強」，建議給）。',
    history: [],
    /** 本代最佳個體在固定尺上的成績（只觀測，绝不回傳進 fitness） */
    measure(genome) {
      const row = { gen: null, at: new Date().toISOString(), scores: {} };
      const policy = genome.toPolicy();
      for (const r of rulers) {
        let sum = 0;
        for (const ex of exam) {
          sum += evaluatePolicy(arena, policy, {
            stage: ex.stage, seed: ex.seed, opponent: r.spec,
            role: cfg.role, maxFrames: cfg.maxFrames,
          }).score;
        }
        row.scores[r.key] = Math.round((sum / exam.length) * 100) / 100;
      }
      return row;
    },
  };
}

function relOf(file) {
  const r = path.relative(process.cwd(), file);
  return (r || file).replace(/\\/g, '/');
}

/**
 * 落盤。除了族群本身，還要把「訓練過的次數」寫進去 ——
 * 這是履歷（ai/ledger.js）唯一的資料來源，少了它隔天就只能從
 * generation／episodes 反推一個總數，看不出今天到底跑了幾段、
 * 每段跑了幾代幾場、從哪裡接續過來。
 */
function persist(o, neat, meta) {
  const s = meta.sessions && meta.sessions[meta.sessions.length - 1];
  if (s) {
    const h = neat.history[neat.history.length - 1];
    s.finishedAt = new Date().toISOString();
    s.generations = neat.generation - s.fromGeneration;
    s.episodes = meta.episodes - s.fromEpisodes;
    s.toGeneration = neat.generation;
    s.toEpisodes = meta.episodes;
    s.best = h ? h.best : null;
    s.mean = h ? h.mean : null;
    s.species = h ? h.species : null;
    s.elapsedSec = meta.sessionT0 ? (Date.now() - meta.sessionT0) / 1000 : null;
    s.championFitness = meta.champion ? meta.champion.fitness : null;
    s.championFingerprint = meta.champion ? Ledger.fingerprint(meta.champion.genome) : null;
  }
  Checkpoint.save(o.out, {
    kind: Checkpoint.KIND,
    formatVersion: Checkpoint.FORMAT_VERSION,
    updatedAt: new Date().toISOString(),
    // 角色要蓋在「檔案」這一層（不只是 config 裡）：
    // 進攻與防守是兩本獨立的帳，誤把 --resume 指到另一族的存檔，
    // 會讓整個族群帶著錯誤的行爲假設繼續演化 —— 所以要能在最外面一眼看到。
    role: meta.config && meta.config.role ? meta.config.role : null,
    obsSpec: Observation.OBS_SPEC,
    scoringVersion: SCORING_VERSION,
    config: meta.config,
    episodes: meta.episodes,
    champion: meta.champion,
    championLog: meta.championLog || [],
    sessions: meta.sessions || [],
    assessments: meta.assessments || [],
    // 固定參考尺的觀測序列（不參與選擇）：不寫進存檔的話，--resume 每開機一次
    // 就從零開始，那條「尺有沒有飄」的曲線就永遠拼不起來。
    reference: meta.reference || undefined,
    neat: neat.toJSON(),
  });
}

/**
 * 讀暖啟動種子 → 一個對「本次訓練的創新歷史」合法的 Genome。
 * ═══════════════════════════════════════════════════════════
 * 只接受 imitation-seed 這一種檔：它的種子段存的是「符號化端點」
 * （h0/c2 這種），importSeed 會照當前的 hist 重新登記創新號與節點 id。
 * 匯出的基因組檔（tank-battle-genome / checkpoint）存的是「別本帳的創新號」，
 * 直接塞進新 history 會讓 crossover 把不同的邊當成同一條 ——
 * 那種錯要幾十代之後才顯形，所以寧可一開始就拒絕。
 * @param {string} expectedRole 本次訓練的席位（批次二 G3）。種子是「哪一席的老師」
 *        練出來的必須對得上：v10 之後 js/ai.js 的 _goal 認角色，防守種子教的是
 *        「站門口」，拿去暖啟動進攻族群只會讓第一代就在錯的行為附近搜尋。
 *        舊種子檔沒有 role 欄位（兩隊混收的中性老師）→ 放行但會警告。
 */
function loadWarmSeed(file, hist, rand, expectedRole) {
  if (!fs.existsSync(file))
    throw new Error(`--seed-from：讀不到 ${file}（先跑 node ai/imitate.js 產生模仿種子）`);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (j.kind !== 'tank-battle-imitation-seed')
    throw new Error(
      `--seed-from：${file} 的 kind=${j.kind}，不是模仿種子。` +
      `匯出的基因組帶著另一本創新歷史的號碼，換一本帳會讓變異/交叉認錯邊。` +
      `要暖啟動請用 node ai/imitate.js 的輸出（預設 runs/seed.json）；` +
      `要接續同一輪訓練請用 --resume。`);
  if (j.role && expectedRole && j.role !== expectedRole)
    throw new Error(`--seed-from：${file} 是「${j.role}」席老師練的種子，本次訓練的席位是` +
      `「${expectedRole}」—— 兩席的老師從 v10 批次二之後教的是不同的事（壓老鷹 vs 守門前），` +
      `拿錯席的種子暖啟動等於把分工糊回去。請改用 ` +
      `node ai/imitate.js --role ${expectedRole} --out runs/seed-${expectedRole}.json`);
  if (!j.role && expectedRole)
    console.warn(`⚠ ${file} 沒有 role 欄位（兩隊混收的舊種子）：暖啟動${expectedRole}族群前` +
      `建議先跑 node ai/imitate.js --role ${expectedRole} 收一席專用的老師`);
  return require('./imitate').importSeed(j, hist, rand);   // 只在真的要暖啟動時才載入擬合層
}

function train(o) {
  const arena = new Arena();
  // 可用的地圖數從遊戲本體讀，不在這裡另抄一份常數。
  // （地形改成 MapGen 依 mapId 生成之後，分界就是 js/constants.js 的 MAP_VARIANTS；
  //   旧的 arena.R.STAGES 已經不存在了。）
  if (!o.resume || o.stagesSet) o.stages = normalizeStages(o.stages, arena.R.MAP_VARIANTS);
  const rand = mulberry32(o.seed);
  let neat, meta, examChange = null, priorRuler = null;

  if (o.resume && o.seedFrom)
    throw new Error('--resume 已經帶著整個族群，不能再給 --seed-from（要用種子重開一輪就別加 --resume）');
  if (o.resume) {
    const j = Checkpoint.load(o.resume, Observation.OBS_SPEC);
    neat = NEAT.fromJSON(j.neat);
    neat.rand = rand;
    meta = {
      episodes: j.episodes || 0, champion: j.champion || null, config: j.config || null,
      // 舊檔沒有 sessions／championLog 時給空陣列：履歷會把那段標成「推導」，
      // 但這裡絕不編一筆假的時間軸進檔案 —— 沒觀測到的東西不寫。
      sessions: Array.isArray(j.sessions) ? j.sessions.slice() : [],
      championLog: Array.isArray(j.championLog) ? j.championLog.slice() : [],
      // 考績是 --verify 寫進存檔的；續練落盤時必須原樣帶回去，
      // 否則「練完一輪，考績就不見了」——看板上也不會有實戰成績。
      assessments: Array.isArray(j.assessments) ? j.assessments.slice() : [],
      // 參考尺的舊紀錄先原樣帶回來（下面確認尺沒換才接到新曲線前面）。
      reference: j.reference && typeof j.reference === 'object' ? j.reference : null,
    };
    if (!meta.config) throw new Error('checkpoint 缺少 config，無法接續');
    // ── 角色接續：存檔說了算 ──────────────────────────────
    // 兩族共用一個 evolve 程式，但「進攻的族群」跟「防守的族群」是兩本獨立的帳。
    // 若讓 --resume 指錯檔（把防守存檔當進攻接續），演化不會報錯，只會練出
    // 一個看起來在動、實際上用另一套標準打分的水貨 —— 所以這裡寧可硬擋。
    const ckptRole = j.role || meta.config.role || null;
    if (o.role && ckptRole && o.role !== ckptRole)
      throw new Error(`--role ${o.role}（${ROLE_LABEL[o.role]}）與存檔 ${o.resume} 的角色 ` +
        `${ckptRole}（${ROLE_LABEL[ckptRole] || '?'}）不同：進攻／防守是兩個族群，` +
        `要接續這一份就別給 --role（或給 ${ckptRole}），要重開另一族請換 --out`);
    if (!o.role) o.role = ckptRole || ROLES.ATTACK;
    // 「這一份存檔的分數原本是拿誰當尺量的」要在 cfg 被本次的 --vs 覆寫之前抄下來。
    // 交替自我對弈每輪都會換對手（對面又變強了一代），不記這筆就看不出來
    // 換了尺 —— 換了尺不重評，冠軍就永遠不會被換掉（見 opponentRuler 的說明）。
    priorRuler = meta.champion
      ? (meta.champion.measuredAgainst
        ? { key: meta.champion.measuredAgainst, label: meta.champion.measuredAgainstLabel || null }
        : rulerFromConfig(meta.config))
      : rulerFromConfig(meta.config);
    // 續練可以換考題（例如把沒練過的地圖加進來）。換了圖就是換了一把尺：
    // 舊 champion 的分數要重評，履歷也要記下「這一段前後不可比」。
    if (o.stagesSet) {
      const before = (meta.config.stages || []).slice();
      const same = before.length === o.stages.length && before.every((v, i) => v === o.stages[i]);
      if (!same) {
        meta.config = Object.assign({}, meta.config, { stages: o.stages.slice() });
        examChange = { before, after: o.stages.slice() };
      }
    }
    if (!o.quiet)
      console.log(`接續 ${o.resume}：第 ${neat.generation} 代，歷史上架 ${meta.episodes} 場，` +
        `最佳 ${(meta.champion ? meta.champion.fitness : 0).toFixed(2)}` +
        `（${ROLE_LABEL[o.role]}｜考題 ${meta.config.stages.length} 圖 × ${meta.config.seeds} 種子 × 1 座位）` +
        `${meta.champion && meta.champion.scoringVersion !== SCORING_VERSION
          ? `｜算分 v${meta.champion.scoringVersion ?? '?'} → v${SCORING_VERSION}，冠軍先重評` : ''}` +
        `${meta.sessions.length ? `｜已有 ${meta.sessions.length} 段訓練紀錄` : '｜（舊存檔，無逐段紀錄）'}`);
  } else {
    neat = new NEAT({ obsDim: Observation.OBS_DIM, nOut: ACTION_COUNT, rand });
    if (o.seedFrom) {
      const seed = loadWarmSeed(o.seedFrom, neat.hist, rand, o.role || ROLES.ATTACK);
      neat.initializeFrom(seed, o.pop);
      if (!o.quiet) {
        const en = [...seed.links.values()].filter(l => l.enabled).length;
        console.log(`暖啟動：${o.seedFrom} → 族群 ${o.pop} 全部由這份種子變異而來` +
          `（種子 ${seed.nodes.length} 節點／${seed.links.size} 邊，啟用 ${en}）`);
      }
    } else {
      neat.initialize(o.pop);
    }
    meta = {
      episodes: 0, champion: null,
      config: Object.assign(
        // role／seats 是 v6 雙模型的座標：seats=1 代表「只坐自己那一席」，
        // 場數預算（每代 pop×圖×種子×seats）與履歷都讀它，不能靠猜。
        { stages: o.stages, seeds: o.seeds, opponent: o.opponent, pop: o.pop,
          maxFrames: o.maxFrames, role: o.role || ROLES.ATTACK, seats: 1 },
        o.seedFrom ? { seedFrom: o.seedFrom } : null),
      sessions: [], championLog: [],
      assessments: [],
    };
  }

  const cfg = meta.config;
  o.role = cfg.role;                       // 接續時以存檔為準，下面一律讀 o.role
  cfg.role = o.role;
  cfg.seats = 1;
  if (o.vs) cfg.vs = relOf(path.resolve(o.vs));   // 對手是哪一份檔，履歷要講得出來
  else if (cfg.vs) {
    // 上一次接續有 --vs、這一次沒有：要把舊路徑清掉。不然履歷會寫著
    // 「對手＝對面的冠軍」，實際上卻在打規則 AI —— 分數變好看了，原因卻是假的。
    delete cfg.vs;
    if (!o.quiet) console.log(`本次未給 --vs：對手回到存檔預設 ${cfg.opponent || 'rule'}（重評與履歷都按這把尺走）`);
  }

  // 對手在第幾代、是誰 —— 只在開機時決定一次（--vs 的檔案在訓練途中不動）。
  // 交替自我對弈由外層（ai/auto-train.js）負責在兩段之間換檔，所以這裡
  // 不重讀：一代之內對手必須是同一隻，否則適應度曲線會把「對手變弱了」
  // 讀成「我的族群變強了」。
  const opponentOf = makeOpponentResolver(o, meta, cfg);
  // 落盤時要講得出「這一族的分數是打誰打出來的」：下次接續（或別的程式讀檔）
  // 才知道尺有沒有換。對手是外部基因組時，指紋會隨對面每輪訓練變動。
  cfg.opponentRuler = opponentOf.ruler.key;
  cfg.opponentRulerLabel = opponentOf.ruler.label;
  // 考題清單：開機算一次，整段訓練（重評、每代評估、參考尺）都用同一份。
  // 這是「共種子配對」的實作點 —— 逐代重建不會變內容，但把「全員同卷」
  // 寫成一個看得見的資料結構，後面的參考尺與逐場差值才對得齊。
  const exam = buildExam(cfg);

  // 參考尺用的凍結快照：--ref 沒給就找「對面那一席」的凍結模型 ——
  // 練進攻時對手坐紅席，所以參考尺是凍結的防守模型；反過來同理（跟 --vs 同邊）。
  // 拿錯邊不會報錯，但會把「同一個角色自己」放進對手席，那把尺量的就不是對手了。
  // 找不到不是錯 —— 規則 AI 那把尺仍然量得出「比新手強多少」，
  // 只是分不開「換尺」跟「變強」。絕對不要把預設指向 ai/trained-*.json：
  // 那個檔每輪訓練都被覆寫，拿它當參考尺就等於沒有尺。
  if (!o.noRef && !o.ref) {
    const foeRole = cfg.role === ROLES.ATTACK ? ROLES.DEFENSE : ROLES.ATTACK;
    const guess = path.join(__dirname, 'refs', `reference-${foeRole}.json`);
    if (fs.existsSync(guess)) o.ref = guess;
  }
  if (!o.noRef && o.ref && !fs.existsSync(path.resolve(o.ref)))
    throw new Error(`--ref：讀不到 ${o.ref}（參考尺要的是「永不更新」的凍結快照，` +
      `不要用會被訓練覆寫的 ai/trained-*.json）`);
  const reference = o.noRef ? null : makeReference(o, cfg, exam, arena);
  // 接續訓練：舊的參考紀錄只有在「尺和考題都一樣」時才接得上去。
  // 換了 --ref 快照或加了新地圖還硬接，那條曲線會把兩把尺畫成一條 ——
  // 看起來像「參考分突然掉了一截」，其實又是換單位。
  if (reference && meta.reference && Array.isArray(meta.reference.history)) {
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    if (same(meta.reference.rulers, reference.rulers) && same(meta.reference.exam, reference.exam)) {
      reference.history = meta.reference.history.slice(-1500);
      reference.historyFromGeneration = reference.history.length
        ? reference.history[0].gen : null;
    } else if (!o.quiet) {
      console.log('⚠ 參考尺或考題與上段不同：參考分從本代重新記（舊那段是別把尺，不併在同一條線）');
    }
  }
  meta.reference = reference;
  if (reference && !o.quiet) {
    console.log(`參考尺（不進適應度，每 ${Math.max(1, o.refEvery)} 代量一次）：` +
      reference.rulers.map(r => r.label).join('｜'));
  }
  // 尺換了＝冠軍的分數要重評。規則 AI → 對面訓練過的冠軍，差的是整整一個
  // 數量級；同一路徑但對面換了代（指紋不同）也算換尺，因為對手真的不一樣了。
  const opponentChange = !!(meta.champion && priorRuler && priorRuler.key !== opponentOf.ruler.key);
  if (!o.quiet && opponentChange)
    console.log(`對手換了：${priorRuler.label || priorRuler.key} → ${opponentOf.ruler.label}` +
      `（冠軍分先按新對手重評，不然舊數字會一直壓著新世代）`);
  if (!o.quiet)
    console.log(`角色：${ROLE_LABEL[o.role]}（${o.role === ROLES.ATTACK ? '藍席，只有打掉紅隊老鷹才算贏' : '紅席，撐過 30 秒 或 打掉藍隊老鷹就贏'}）` +
      `｜評判標準 ${require('./fitness').termsFor(o.role).length} 項（算分 v${SCORING_VERSION}）`);
  // 即時看板：寫的是「記憶體裡的現在」，不是等落盤才更新。
  // 預設每代覆寫 ai/live-data.js，ai/live.html 每幾秒重讀一次 →
  // 開著網頁就能看到代數往上跑，不必等到 saveEvery 的存檔間隔。
  // 看板寫失敗只警告一次，不影響訓練（Live.tryWrite 已吞錯，這裡再保險一層）。
  const liveWrite = running => {
    if (!o.live || !meta || !neat) return;
    try { Live.writeFromTrainer(Live.DEFAULT_OUT, o.out, meta, neat, running); }
    catch (e) {
      if (!o.quiet) console.warn(`⚠ 即時看板資料產生失敗：${e.message}`);
    }
  };
  // 不管正常結束、丟錯、還是 Ctrl+C（SIGINT 會走 exit），都把看板標成停止。
  // 少了這一步，網頁會一直停在「訓練中」——它只看得到檔案，看不到程序死掉了。
  if (o.live) process.once('exit', () => liveWrite(false));
  // 本次開機＝一「段」訓練。從這裡開始記，落盤時才說得清
  // 「今天跑了幾代幾場、從哪裡接續、花多少時間、這段結束時 champion 是哪一隻」。
  meta.sessionT0 = Date.now();
  meta.sessions.push({
    startedAt: new Date().toISOString(),
    source: o.resume ? 'resume' : (o.seedFrom ? 'seed-from' : 'cold'),
    from: o.resume || o.seedFrom || null,
    file: o.out,
    // 這一族練的是哪個角色：兩本帳混看時（runs/*.json 全掃）沒有這個欄位，
    // 進攻的分數和防守的分數會被畫在同一張收斂圖上 —— 那兩套標準根本不同。
    role: cfg.role,
    stages: cfg.stages.slice(),
    // 記「實際跑的 cfg」，不是 CLI 的預設值：續練時 o.seeds 預設 1，
    // 但 checkpoint 可能用 2 —— 寫 o.seeds 會讓履歷騙人（曾經如此）。
    args: {
      gens: o.gens, episodes: o.episodes, pop: cfg.pop, seeds: cfg.seeds,
      opponent: cfg.opponent, vs: cfg.vs || null, role: cfg.role, seats: 1,
      maxFrames: cfg.maxFrames, rngSeed: o.seed, saveEvery: o.saveEvery,
    },
    // 換考題是「單位換了」：fromGeneration 之後的 best／mean 不能跟之前直接比。
    // 沒換圖時這兩個欄位不寫（undefined 會被 JSON.stringify 丟掉）。
    examBefore: examChange ? examChange.before : undefined,
    examChanged: !!examChange,
    // 這一段的分數是打誰打出來的（規則 AI／對面冠軍／隨機／自己）。
    // 交替演化時它每段都不同 —— 沒有這一行，兩段訓練看起來像同一把尺。
    opponentRuler: opponentOf.ruler.key,
    opponentRulerLabel: opponentOf.ruler.label,
    opponentBefore: opponentChange ? (priorRuler.label || priorRuler.key) : undefined,
    opponentChanged: !!opponentChange,
    fromGeneration: neat.generation,
    fromEpisodes: meta.episodes,
    // 這一段的分數用哪一版算分規則算：跨版本接續（v1 的存檔接上 v2 的碼）時，
    // 收斂曲線會在接縫處跳一下 —— 那不是變聰明，是單位換了。網頁要能分開畫。
    scoringVersion: SCORING_VERSION,
    node: process.version,
  });
  // 單座位（v6）：pop × 圖 × 種子 × cfg.seats。
  // cfg.seats 讀存檔而不是寫死 2 —— 舊的 v5 存檔是「同一隻網路藍紅各坐一次」，
  // 它的 meta.episodes 是按 2 座位累計的；混用時場數要說得清是怎麼算的。
  const perGen = neat.population.length * cfg.stages.length * cfg.seeds * cfg.seats;

  // 換圖、換算分版本、換對手：舊冠軍的分數不是同一把尺，先重評。
  // 不重評的話，舊分數（另一個地圖組／另一版算分／別的對手）會一直壓著新世代 ——
  // 新考題可能天生分數比較低，於是「再也沒有冠軍」；或天生比較高，
  // 於是「第一代就破紀錄」。三種都是換單位，不是變聰明。
  // 校準局不計入 meta.episodes：場數是訓練預算的單位。
  const staleScoring = !!(meta.champion && meta.champion.scoringVersion !== SCORING_VERSION);
  const reasons = [];
  if (examChange) reasons.push('exam');
  if (opponentChange) reasons.push('opponent');
  if (staleScoring) reasons.push('scoring');
  if (meta.champion && reasons.length) {
    const champGenome = Genome.fromJSON(meta.champion.genome);
    const opp = opponentOf();
    let sum = 0, games = 0;
    for (const ex of exam) {
      sum += evaluatePolicy(arena, champGenome.toPolicy(), {
        stage: ex.stage, seed: ex.seed, opponent: opp,
        role: cfg.role, maxFrames: cfg.maxFrames,
      }).score;
      games += cfg.seats;
    }
    const fresh = sum / exam.length;
    const old = meta.champion.fitness;
    const fromVersion = meta.champion.scoringVersion ?? null;
    meta.champion.fitness = fresh;
    meta.champion.scoringVersion = SCORING_VERSION;
    meta.champion.role = cfg.role;
    // 重評之後這個數字屬於哪一把尺：指紋＋路徑，跟對手的實際基因組綁在一起，
    // 檔名沒變但對面又練強一代時，key 一樣會不同。
    meta.champion.measuredAgainst = opponentOf.ruler.key;
    meta.champion.measuredAgainstLabel = opponentOf.ruler.label;
    meta.champion.rescoredAt = new Date().toISOString();
    meta.sessions[meta.sessions.length - 1].championRescore = {
      before: old, after: fresh, games,
      reasons, reason: reasons.join('+'),
      fromVersion, toVersion: SCORING_VERSION,
      // 換尺的兩端寫清楚，履歷才不用猜：對手從什麼換成什麼。
      opponentBefore: opponentChange ? (priorRuler.label || priorRuler.key) : undefined,
      opponentAfter: opponentChange ? opponentOf.ruler.label : undefined,
    };
    if (!o.quiet) {
      if (examChange) {
        console.log(`考題變更：地圖 ${JSON.stringify(examChange.before)} → ${JSON.stringify(examChange.after)}` +
          `（每代 ${perGen} 場）`);
      }
      const why = [];
      if (examChange) why.push('換圖');
      if (opponentChange) why.push('換對手');
      if (staleScoring) why.push(`算分 v${fromVersion ?? '?'} → v${SCORING_VERSION}`);
      console.log(`  舊冠軍${examChange ? '在新考題' : ''}重新評分 ${old.toFixed(2)} → ${fresh.toFixed(2)}` +
        `（${games} 場校準，不計入訓練場數；${why.join('＋')}前後的分數不是同一把尺）` +
        `｜改用${ROLE_LABEL[cfg.role]}標準：${termsFor(cfg.role).length} 項`);
    }
  } else if (meta.champion && !meta.champion.measuredAgainst) {
    // 尺沒換、但舊檔完全沒記「打誰打出這分」：補記一筆，下次接續才比得出來。
    meta.champion.measuredAgainst = opponentOf.ruler.key;
    meta.champion.measuredAgainstLabel = opponentOf.ruler.label;
  }

  // 開跑先寫一次：網頁一打開就看得到「第幾代、這次要跑幾代、考題是什麼」，
  // 不用等第一代跑完（4 圖 × 2 種子 ≈ 半分鐘）。
  liveWrite(true);

  // 兩種工作流共用一個迴圈：
  //   --gens N        → 「今天演化 N 代」（場數只當保險絲）
  //   --episodes N    → 「今天只跑 N 場」，能跑幾代算幾代
  // 兩個都給時取較嚴的那個；若場數連一代都不夠，起碼把一代跑完，
  // 免得使用者下錯參數白等一小時。
  let budget = o.episodes === null ? Infinity : o.episodes;
  const gens = o.gens > 0 ? o.gens : Infinity;
  // 兩個上限都沒給 → 會無限演化成「看起來當機」。硬性要求至少綁一個。
  if (budget === Infinity && gens === Infinity)
    throw new Error('no limit: 請至少給一個上限 —— --gens N（本次跑 N 代）或 --episodes N（今天跑 N 場）');
  if (budget !== Infinity && budget < perGen) {
    if (!o.quiet) console.warn(`⚠ 場數上限 ${budget} 不足一代（${perGen} 場/代）；本次把一代跑完。`);
    budget = perGen;
  }
  if (!o.quiet && !o.resume)
    console.log(`設定：角色=${cfg.role}（${ROLE_LABEL[cfg.role]}） gens=${Number.isFinite(gens) ? gens : '看場數'} ` +
      `episodes=${Number.isFinite(budget) ? budget : '不限'} ` +
      `pop=${neat.population.length} stages=${JSON.stringify(cfg.stages)} seeds=${cfg.seeds} ` +
      `座位=${cfg.seats} 對手=${cfg.vs ? `vs ${cfg.vs}` : cfg.opponent} → ${perGen} 場/代`);

  const t0 = Date.now();
  let done = 0;
  let exportWarned = false;
  // 場數上限管的是「本次開機跑幾場」，不是「歷史上總共跑過幾場」。
  // 用 meta.episodes（跨天累加）當基準的話，第二天 --episodes 100 會被
  // 「昨天已經 8640 場」比掉 → 一代都不跑，直接落地原地。這是「明天接著跑」
  // 最關鍵的一條路徑，所以另設 used 只記本次。
  let used = 0;

  while (done < gens && used + perGen <= budget) {
    const opp = opponentOf();
    // 共種子配對：族群裡每一隻都吃同一組考題（exam 在開機時算一次、世代間不變）。
    // 場數是 pop × 考題，不是「各自抽題」—— 各自抽題的話兩隻網路的分數差裡
    // 混著「抽到難圖」的成分，選擇其實在挑運氣。
    // 無頭引擎的 __rand 由 seed 決定（js/*.js 裡的 Math.random 在載入時被換成
    // __rand），所以 (stage, seed, 控制器組合) 完全決定結果 → 逐場差值才有意義。
    const scores = [];
    const ties = [];
    neat.population.forEach((g, i) => {
      let sum = 0, raw = 0;
      for (const ex of exam) {
        const r = evaluatePolicy(arena, g.toPolicy(), {
          stage: ex.stage, seed: ex.seed, opponent: opp,
          role: cfg.role, maxFrames: cfg.maxFrames,
        });
        sum += r.score;
        raw += r.raw;
      }
      // 次鍵：未封頂的原始均分。0 分的一代裡它是唯一還分得出高低的量（見 ai/neat.js）。
      g.tie = raw / exam.length;
      scores.push(sum / exam.length);
      ties.push(g.tie);
    });

    // 評分當下的最佳個體（evolve 之後 population 會被換掉，索引不再對應）。
    // 注意：這時 g.fitness 還是「上一代」的值（neat.evolve 還沒覆寫），
    // 所以要拿本代的 scores/ties 比，不能直接用 betterGenome(個體)。
    let bi = 0;
    for (let i = 1; i < scores.length; i++) {
      if (scores[i] > scores[bi] || (scores[i] === scores[bi] && ties[i] > ties[bi] + 1e-6)) bi = i;
    }
    if (!Number.isFinite(scores[bi])) throw new Error(`適應度算出 ${scores[bi]}，檢查 fitness/arena 欄位`);
    const scoredBest = neat.population[bi];
    const bestSoFar = scores[bi];

    // 固定參考尺：拿「本代最佳」再打一次那兩把永遠不動的尺。
    // 用本代最佳而不是歷史冠軍 —— 要的是「這代長成的東西在固定尺上幾分」，
    // 拿冠軍量會每代都量同一隻genome，曲線變成直線。
    // 這些場數不計進 meta.episodes（跟重評的校準局同一條約定：
    // 場數是訓練預算的單位，純觀測的分數不該佔預算）。
    if (reference && neat.generation % Math.max(1, o.refEvery) === 0) {
      const row = reference.measure(scoredBest);
      row.gen = neat.generation + 1;          // rec.gen 是 evolve 之後的值，這裡對齊同一代
      reference.history.push(row);
      if (reference.history.length > 1500)
        reference.history.splice(0, reference.history.length - 1500);
    }

    const rec = neat.evolve(() => scores);
    meta.episodes += perGen;
    used += perGen;
    // 代數計數要在 quiet 判斷「外面」。放進 if (!quiet) 會讓 --quiet 跑成
    // 死迴圈（done 永遠是 0，--gens 形同不存在）—— 測試就是這麼卡住的。
    done++;

    if (!meta.champion || bestSoFar > meta.champion.fitness) {
      // scoringVersion 要跟 fitness 一起記：分數本身只是個數字，
      // 「這分數是用哪一版算分規則得出的」才是它能不能跟別份成績比的依據。
      // （v1 的傷害計量漏掉致命一擊，同一隻網路在 v2 下分數會比較高。）
      meta.champion = {
        generation: neat.generation, fitness: bestSoFar,
        scoringVersion: SCORING_VERSION, role: cfg.role, genome: scoredBest.toJSON(),
        // 這一筆是「打誰」打出了 bestSoFar。缺了它，接續時就分不清
        // 舊冠軍跟本代是不是同一把尺量的（交替演化每輪都在換尺）。
        measuredAgainst: opponentOf.ruler.key,
        measuredAgainstLabel: opponentOf.ruler.label,
      };
      // 冠軍血緣：什麼時候換人、換成哪一隻（指紋）。
      // 只看適應度曲線分不出「同一隻撐到最後」跟「一路換對象」，
      // 對使用者判斷「還在進步嗎」是兩件不同的事。
      meta.championLog.push({
        generation: neat.generation, fitness: bestSoFar,
        fingerprint: Ledger.fingerprint(meta.champion.genome),
        at: new Date().toISOString(),
        session: meta.sessions.length,
        measuredAgainst: opponentOf.ruler.key,
      });
    }
    // 歷史最佳要回填，否則 --opponent best 會拿「本代峰值」而不是「歷代峰值」當對手
    neat.best = Genome.fromJSON(meta.champion.genome);
    neat.bestFitness = meta.champion.fitness;

    if (!o.quiet) {
      const el = (Date.now() - t0) / 1000;
      // 參考尺的數字只有「本代有量」時才掛在後面；--ref-every >1 時不要印上一代的舊值。
      const refRow = reference && reference.history.length &&
        reference.history[reference.history.length - 1].gen === neat.generation
        ? reference.history[reference.history.length - 1] : null;
      const refTxt = refRow ? '  參考尺=' + reference.rulers
        .map(r => `${r.key.split(':')[0]}:${refRow.scores[r.key]}`).join(' ') : '';
      console.log(`gen ${neat.generation}  best=${rec.best.toFixed(2)}  mean=${rec.mean.toFixed(2)}  ` +
        `原始分=${rec.raw.toFixed(2)}  0分占比=${Math.round(rec.zero * 100)}%  ` +
        `species=${rec.species}  net=${rec.maxNodes}n/${rec.maxLinks}e  ` +
        `場=${meta.episodes}  ${el.toFixed(1)}s${done > 1 ? ` (${(el / done).toFixed(1)}s/gen)` : ''}${refTxt}`);
    }
    // 自動跟隨：指定的話，每 N 代就把「這一刻的冠軍」寫成瀏覽器快照。
    // 這裡先落盤再匯出，讓 session 的 toGeneration／完成時間也一起更新；
    // 匯出失敗只警告一次，不能因為寫不動網頁檔就中斷訓練。
    const exportDue = !!(o.exportTo && o.exportEvery > 0 &&
      neat.generation % o.exportEvery === 0);
    if (exportDue) persist(o, neat, meta);
    else if (done % Math.max(1, o.saveEvery) === 0) persist(o, neat, meta);
    // 看板每代更新（跟 checkpoint 的 saveEvery 無關）：網頁要的是「現在第幾代」，
    // 不是「兩代前落盤的數字」。
    liveWrite(true);
    if (exportDue) {
      try { exportTrainerSnapshot(meta, neat, o.out, o.exportTo); }
      catch (e) {
        if (!o.quiet && !exportWarned) {
          exportWarned = true;
          console.warn(`⚠ 觀戰快照更新失敗（之後不再重複警告）：${e.message}`);
        }
      }
    }
  }

  persist(o, neat, meta);
  liveWrite(false);
  // 訓練完順手刷新瀏覽器用的那份基因組。少了這一步，網頁上讀到的還是
  // 上一次匯出的舊快照 —— 「玩了很多場，代數跟適應度都沒增加」就是這麼來的：
  // 觀戰頁面只讀 ai/trained.js，它不會、也不能回頭訓練。
  if (o.exportTo) exportChampion({ export: o.out, to: o.exportTo });
  if (!o.quiet) {
    console.log(`\n本次 ${((Date.now() - t0) / 1000).toFixed(1)}s，${done} 代 ${used} 場，` +
      `歷史累計 ${meta.episodes} 場，演化到第 ${neat.generation} 代。`);
    console.log(`進度：${o.out}`);
    console.log(`明天：node ai/evolve.js --resume ${o.out} --episodes 100` +
      `${o.exportTo ? ` --export-to ${o.exportTo}` : ''}`);
  }
}

function report(o) {
  const j = Checkpoint.load(o.report, Observation.OBS_SPEC);
  const n = NEAT.fromJSON(j.neat);
  const champ = Genome.fromJSON(j.champion.genome);
  const cfg = j.config;
  const role = j.role || cfg.role || ROLES.ATTACK;
  const seat = role === ROLES.DEFENSE ? 1 : 0;      // 進攻→藍席，防守→紅席
  console.log(`角色 ${role}（${ROLE_LABEL[role]}｜坐${seat === 0 ? '藍' : '紅'}席，評判標準 ${termsFor(role).length} 項）`);
  console.log(`關卡 ${cfg.stages.join(',')}｜對手 ${cfg.vs ? `基因組 ${cfg.vs}` : cfg.opponent}` +
    `｜族群 ${cfg.pop}｜座位 ${cfg.seats ?? 1}｜觀測 v${j.obsSpec.version}（${j.obsSpec.dim} 欄）`);
  console.log(`演化到第 ${n.generation} 代｜${j.episodes} 場｜最佳適應度 ${j.champion.fitness.toFixed(2)}（第 ${j.champion.generation} 代）`);
  const en = [...champ.links.values()].filter(l => l.enabled).length;
  console.log(`冠軍網路：${champ.nodes.length} 節點／${champ.links.size} 邊（啟用 ${en}）`);
  console.log('\n  gen   best   mean  species');
  for (const r of n.history.slice(-15))
    console.log(`  ${String(r.gen).padStart(4)}  ${r.best.toFixed(2).padStart(6)}  ${r.mean.toFixed(2).padStart(6)}  ${String(r.species).padStart(6)}`);

  // 考績：只在「自己的席位」上跟規則 AI 打，用的是另一把從未參與評估的種子。
  // v5 在這裡藍紅各打一輪來消座位偏置；v6 兩個角色是兩種工作，
  // 把防守模型塞進藍席「它進攻很爛」不叫缺點，那根本不是它的任務。
  const arena = new Arena({ maxFrames: cfg.maxFrames || 2400 });
  const pol = { kind: 'policy', policy: champ.toPolicy() };
  let win = 0, tot = 0, decided = 0, onField = 0;
  const ends = {};
  for (const stage of cfg.stages) for (let s = 0; s < 4; s++) {
    const seed = hashSeed(0xc0ffee, stage, s);
    const rep = arena.run({
      stage, seed,
      blue: seat === 0 ? pol : 'rule',
      red: seat === 0 ? 'rule' : pol,
    });
    const t = rep.teams[seat];
    win += (rep.winner === seat ? 1 : 0);
    ends[rep.end || '?'] = (ends[rep.end || '?'] || 0) + 1;
    decided += t.framesDecided; onField += t.fieldFrames;
    tot += 1;
  }
  const endText = Object.entries(ends)
    .map(([k, v]) => `${k === 'breach' ? '藍破網' : k === 'counter' ? '紅反殺' : k === 'time' ? '時間到' : k === 'pool' ? '兵力耗盡' : k} ${v}`)
    .join('｜');
  console.log(`\n冠軍在${seat === 0 ? '藍（進攻）' : '紅（防守）'}席對「規則 AI」的勝率：${win}/${tot} = ` +
    `${(100 * win / tot).toFixed(0)}%（未參與評估的新種子）`);
  console.log(`   終局方式：${endText}`);
  // 「越玩越聰明」要看的是網路真正掌握了多少控制權：
  // abstain（policy 回傳 null）的那幀其實是規則 AI 在代步，這個比例必須高報出來，
  // 否則會把「規則 AI 的成績」誤宣成「學出來的成績」。
  console.log(`控制權：在場 ${onField} 幀中網路自己決策 ${decided} 幀 = ` +
    `${(100 * decided / Math.max(1, onField)).toFixed(0)}%（其餘由規則 AI 代步）`);
}

/**
 * 把一份「像 checkpoint 的物件」整理成瀏覽器要的基因組 payload。
 * 檔案版（--export）與記憶體版（訓練中每 N 代自動匯出）都走這裡，
 * 避免兩條路的欄位悄悄分叉 —— 自動跟隨的頁面讀到的必須是同一種格式。
 */
function genomePayload(j, sourceFile, exportedAt = new Date().toISOString()) {
  // 算分規則的版本一定要跟著匯出：ai/arena.js 修正「致命一擊不計入傷害」之前
  // 存的分數（v1）跟現在（v2）不是同一個單位，同一隻網路在 v2 下會拿比較高的分。
  // 不標版本的話，觀戰面板上「適應度 119」會被人拿來跟新訓練的數字比，然後誤會
  // 「玩很多場怎麼沒增加」。
  const scoringVersion = (j.champion && j.champion.scoringVersion) || j.scoringVersion || 1;
  // 角色：v6 起一份快照只屬於一個角色。觀戰頁（js/watch.js）靠這個欄位
  // 決定把這份網路放進藍席（進攻）還是紅席（防守）—— 沒有它就只能猜，
  // 猜錯的代價是「練防守的模型在那邊亂衝」，畫面上看起來像練壞了。
  const role = j.role || (j.champion && j.champion.role)
    || (j.config && j.config.role)
    || (j.provenance && j.provenance.config && j.provenance.config.role) || null;
  return {
    kind: 'tank-battle-genome',
    version: 3,
    role,
    roleLabel: role ? (ROLE_LABEL[role] || role) : null,
    seat: role === ROLES.DEFENSE ? 1 : 0,      // 0=藍（進攻）、1=紅（防守）
    obsSpec: j.obsSpec,
    scoringVersion,
    generation: j.neat.generation,
    fitness: j.champion.fitness,
    championGeneration: j.champion.generation,
    // 這一分是打誰打出來的：快照被匯出後就脫離存檔了，面板與履歷若拿它跟
    // 「本代曲線」放在一起比，需要先知道兩者的尺有沒有不同。
    opponentRuler: j.champion.measuredAgainstLabel || j.champion.measuredAgainst || null,
    episodes: j.episodes,
    // 匯出時間：這是「快照」的時間戳。觀戰頁面永遠顯示這一刻的狀態，
    // 不跑訓練它就不會變 —— 寫進檔案是為了讓面板有地方取證。
    exportedAt,
    // 訓練履歷跟著基因組一起出去：瀏覽器按 Y 開戰時，那顆徽章要能講得出
    // 「這隻是第幾代、跑過幾段訓練、總共幾場」，而不是只有一個適應度數字。
    provenance: {
      sourceFile,
      updatedAt: j.updatedAt || null,
      scoringVersion,
      config: j.config || null,
      sessions: Array.isArray(j.sessions) ? j.sessions : [],
      inferredSessions: !Array.isArray(j.sessions) || j.sessions.length === 0,
      championLog: Array.isArray(j.championLog) ? j.championLog : [],
      growth: (j.neat.history || []).map(h => ({ gen: h.gen, best: h.best, mean: h.mean, species: h.species })),
    },
    assessments: Array.isArray(j.assessments) ? j.assessments : [],
    genome: j.champion.genome,
  };
}

function writeGenomePayload(payload, to, o = {}) {
  const [jsonPath, jsPath] = Ledger.writeGenome(payload, to);
  if (o.quiet) return payload;
  const ss = payload.provenance.sessions.length;
  console.log(`匯出${payload.roleLabel ? `「${payload.roleLabel}」` : ''}冠軍基因組 → ${jsonPath} + ${jsPath}`);
  console.log(`   （第 ${payload.generation} 代，fitness ${Number(payload.fitness).toFixed(2)}，` +
    `算分 v${payload.scoringVersion}，` +
    `觀測 v${payload.obsSpec.version}／${payload.obsSpec.dim} 欄，` +
    `${ss ? `${ss} 段訓練／${payload.episodes} 場` : `舊存檔無逐段紀錄（${payload.episodes} 場）`}）`);
  console.log(`瀏覽器觀戰：開 index.html（自動模式會自己讀 ai/trained-attack.js／ai/trained-defense.js ` +
    `兩個模型，藍＝進攻、紅＝防守）`);
  console.log(`訓練次數＋評判標準的完整履歷：node ai/ledger.js --ckpt ${payload.provenance.sourceFile}`);
  return payload;
}

function exportChampion(o) {
  const j = Checkpoint.load(o.export, Observation.OBS_SPEC);
  return writeGenomePayload(genomePayload(j, o.export), o.to);
}

/** 訓練中直接從記憶體匯出：不必等落盤，也不會讀到兩代前的快照 */
function exportTrainerSnapshot(meta, neat, sourceFile, to, o = {}) {
  if (!meta || !meta.champion || !neat) return null;
  const payload = genomePayload({
    obsSpec: Observation.OBS_SPEC,
    scoringVersion: SCORING_VERSION,
    role: meta.config && meta.config.role,
    updatedAt: new Date().toISOString(),
    config: meta.config,
    episodes: meta.episodes,
    champion: meta.champion,
    championLog: meta.championLog || [],
    sessions: meta.sessions || [],
    assessments: meta.assessments || [],
    neat: { generation: neat.generation, history: neat.history },
  }, sourceFile);
  return writeGenomePayload(payload, to, { quiet: true });
}

/**
 * 「怎麼確認有在跑」——開著觀戰頁的同時，用這條查訓練端的脈搏。
 * 只讀存檔，不打任何一局，所以跟正在跑的訓練程序共用檔案也不會拖慢它。
 */
function status(o) {
  const j = Checkpoint.load(o.status, Observation.OBS_SPEC);
  const upd = Date.parse(j.updatedAt || '');
  const age = Number.isFinite(upd) ? (Date.now() - upd) / 1000 : null;
  const sess = Array.isArray(j.sessions) ? j.sessions : [];
  const cur = sess[sess.length - 1];
  const cfg = j.config || {};
  const seats = cfg.seats || 1;
  const perGen = (j.neat && j.neat.population ? j.neat.population.length : cfg.pop || 0) *
    (cfg.stages || []).length * (cfg.seeds || 0) * seats;
  console.log(`訓練檔 ${o.status}`);
  console.log(`   角色：${j.role || cfg.role || '未記錄（舊存檔，v6 之前的單模型訓練）'}` +
    `${j.role || cfg.role ? `（${ROLE_LABEL[j.role || cfg.role] || '?'}｜坐${(j.role || cfg.role) === 'defense' ? '紅' : '藍'}席）` : ''}`);
  console.log(`   目前：第 ${j.neat.generation} 代｜累計 ${j.episodes} 場｜` +
    `最佳 ${j.champion ? Number(j.champion.fitness).toFixed(2) : '—'}` +
    `（第 ${j.champion ? j.champion.generation : '?'} 代）｜種族 ${j.neat.history.length ? j.neat.history[j.neat.history.length - 1].species : '—'}`);
  console.log(`   考題：地圖 ${JSON.stringify(cfg.stages || [])}×${cfg.seeds || '?'} 種子×${seats} 座位｜` +
    `對手 ${cfg.vs ? `基因組 ${cfg.vs}` : cfg.opponent}` +
    `｜族群 ${cfg.pop}｜每代約 ${perGen} 場`);
  console.log(`   最後落盤：${j.updatedAt || '未記錄'}` +
    (age === null ? '' : `（${age < 60 ? `${Math.round(age)} 秒前` : `${(age / 60).toFixed(1)} 分前`}）`));
  // 「幾秒前」是唯一的活著證據：預設每 2 代寫一次盤，17～20 秒/代 ⇒ 正常約 40 秒內會看到一次更新。
  if (age === null) console.log(`   判定：存檔裡沒有時間戳，無法判斷（舊存檔）`);
  else if (age < 180) console.log(`   判定：${age < 60 ? '剛剛有落盤，應該還在跑' : '3 分鐘內有落盤，可能還在跑'}` +
    `（每 ${cfg.saveEvery || 2} 代落一次盤；剛結束時這行也會這樣說，再等一下就會變成「已停止」）`);
  else console.log(`   判定：已停止超過 3 分鐘。若你沒按 Ctrl+C，就是那支 node 結束或掛了；` +
    `看 runs/*.log 最後幾行就知道停在哪`);
  if (cur) {
    console.log(`   這一段：第 ${cur.fromGeneration} → ${cur.toGeneration} 代｜${cur.episodes} 場｜` +
      `${cur.elapsedSec ? (cur.elapsedSec / 60).toFixed(1) + ' 分' : '進行中'}｜來源 ${cur.source}` +
      `${cur.scoringVersion ? `｜算分 v${cur.scoringVersion}` : ''}`);
  }
  console.log(`   完整履歷：node ai/ledger.js --ckpt ${o.status}`);
  console.log(`   邊看邊練：另開一個視窗跑訓練，本頁只讀檔；` +
    `訓練結束後重新整理 index.html 才會換成新快照（--export-to 才會更新瀏覽器那份）`);
}

function main(argv) {
  const o = parseArgs(argv);
  // --export-every 只有搭配 --export-to 才有意義；打錯成「--export-every 1 卻忘了
  // --export-to」時若默默忽略，觀戰頁就會一直停在舊快照，而使用者以為自動跟隨開著。
  if (!Number.isInteger(o.exportEvery) || o.exportEvery < 0)
    throw new Error(`--export-every：${o.exportEvery} 不是非負整數`);
  if (o.exportEvery > 0 && !o.exportTo)
    throw new Error('--export-every 需要同時給 --export-to FILE（否則沒有檔案可刷新）');
  if (o.help) console.log(HELP);
  else if (o.report) report(o);
  else if (o.status) status(o);
  else if (o.export) exportChampion(o);
  else train(o);
}

/* 只在「被當 CLI 直接跑」時才訓練。
   少了這層 guard，require('./evolve') 就會當場執行為空的 argv ——
   印出 HELP、把 process.exitCode 設成 1，測試檔案莫名其妙就紅了。 */
if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    if (e.message && (/^unknown arg/.test(e.message) || /^no limit/.test(e.message)
      || /^--seed-from/.test(e.message) || /^--resume/.test(e.message)
      || /^--role/.test(e.message) || /^--vs/.test(e.message)
      || /^--export-every/.test(e.message))) {
      console.log(HELP);
      console.error('✗ ' + e.message);
    } else console.error(e.stack);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, main, train, loadWarmSeed, loadOpponent, normalizeRole, evalSeed };
