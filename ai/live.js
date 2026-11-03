/* ai/live.js — 即時看板的資料層
   ═══════════════════════════════════════════════════════════
   為什麼不是「HTML 直接讀 checkpoint」：
   file:// 下瀏覽器擋 fetch()／XHR 讀本機檔案（CORS），但 <script src>
   可以。所以資料一律寫成同一目錄的 live-data.js（window.__LIVE__ = …），
   ai/live.html 用 <script> 重新載入 —— 不用起伺服器、雙擊就能看。

   兩種資料來源，欄位刻意一樣：
   1) 訓練程序自己每代呼叫 writeFromTrainer()（ai/evolve.js 已接）。
      它知道「還在跑」還是「跑完了」，所以 running 是確定的布林值，
      更新頻率＝每代一次。
   2) 另外監看 checkpoint：node ai/live.js --watch runs/warm-v2.json
      只看到「檔案有變」，所以 running 留 null（網頁顯示「檔案監看」，
      不會謊稱訓練中）。適合訓練已經在跑、來不及接 (1) 的情況。

   ⚠ 這裡只做「呈現用的摘要」，不重算適應度、不跑模擬：
     分數全部照抄 checkpoint／記憶體裡的數字，所以看板不會比訓練本身更貴，
     也不會出現「看板算一套、訓練算另一套」。
   ═══════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const Observation = require('./observation');
const { fingerprint } = require('./ledger');

const KIND = 'tank-battle-live';
// v6 之後訓練檔是兩份（進攻／防守各一）。看板一次只監看一族，
// 預設給較常先看的那個；另一族用 `node ai/live.js --watch runs/defense-v6.json --out ...`。
const DEFAULT_CHECKPOINT = path.join('runs', 'attack-v6.json');
const DEFAULT_OUT = path.join(__dirname, 'live-data.js');

/* ── 原子寫檔：跟 checkpoint.js 同一個理由（Windows 上 rename 會被防毒／
      索引服務偶發卡住），但這裡失敗不能影響訓練，所以呼叫端用 tryWrite。 ── */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function atomicWrite(file, text) {
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, text);
  for (let i = 0; i < 6; i++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      sleep(20 * (i + 1));
      try { fs.unlinkSync(file); } catch { /* 不存在或仍被鎖 */ }
    }
  }
  fs.copyFileSync(tmp, file);
  try { fs.unlinkSync(tmp); } catch { /* 留著不影響正確性 */ }
}

function rel(file) {
  const r = path.relative(process.cwd(), file);
  return (r || file).replace(/\\/g, '/');
}

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

function loadAny(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (j.kind !== 'tank-battle-neat-checkpoint' && j.kind !== 'tank-battle-genome')
    throw new Error(`live: ${rel(file)} 不是本專案的 checkpoint／基因組（kind=${j.kind}）`);
  return j;
}

function genomeSummary(g) {
  if (!g) return null;
  const links = g.links || [];
  return {
    nodes: (g.nodes || []).length,
    links: links.length,
    enabledLinks: links.filter(l => l.enabled).length,
    fingerprint: fingerprint(g),
  };
}

function compactSession(st, i) {
  return {
    index: st.index || i + 1,
    source: st.source || (st.inferred ? 'unknown' : 'session'),
    from: st.from || st.file || null,
    startedAt: st.startedAt || null,
    finishedAt: st.finishedAt || null,
    fromGeneration: st.fromGeneration ?? null,
    fromEpisodes: st.fromEpisodes ?? null,
    toGeneration: st.toGeneration ?? null,
    toEpisodes: st.toEpisodes ?? null,
    generations: st.generations ?? null,
    episodes: st.episodes ?? null,
    elapsedSec: st.elapsedSec ?? null,
    best: st.best ?? null,
    mean: st.mean ?? null,
    species: st.species ?? null,
    stages: st.stages || null,
    role: st.role || (st.args && st.args.role) || null,
    vs: (st.args && st.args.vs) || null,
    examBefore: st.examBefore || null,
    examChanged: !!st.examChanged,
    // 這一段打的是誰：交替演化每段換對手＝每段換一把尺。
    // 沒帶出去的話，段界那一步往下掉會被讀成「練壞了」，其實是對面變強了。
    opponentRuler: st.opponentRuler || null,
    opponentRulerLabel: st.opponentRulerLabel || null,
    opponentBefore: st.opponentBefore || null,
    opponentChanged: !!st.opponentChanged,
    scoringVersion: st.scoringVersion ?? null,
    championRescore: st.championRescore || null,
    targetGens: st.args && Number(st.args.gens) > 0 ? Number(st.args.gens) : null,
    targetEpisodes: st.args && Number(st.args.episodes) > 0 ? Number(st.args.episodes) : null,
  };
}

/**
 * 固定參考尺（meta.reference）→ 看板要的摘要。
 * 這一段只是照抄訓練端量的數字：看板的契約是「不重算適應度、不跑模擬」，
 * 所以「同分排序用的原始分」這類由 ai/neat.js 附在 history 上的欄位能直接顯示，
 * 而參考尺的分數必須由 ai/evolve.js 那側真的跑過才看得到。
 * 沒有參考資料（舊存檔／--no-ref）就回傳 null，網頁那一區整個不畫 ——
 * 不能拿 0 當「參考分是 0」，那是把「沒量過」畫成「量到很爛」。
 */
function compactReference(ref) {
  if (!ref || !Array.isArray(ref.rulers) || !ref.rulers.length) return null;
  const hist = (Array.isArray(ref.history) ? ref.history : []).slice(-600);
  const last = hist[hist.length - 1] || null;
  return {
    role: ref.role || null,
    scoringVersion: ref.scoringVersion ?? null,
    games: Array.isArray(ref.exam) ? ref.exam.length : null,
    maps: Array.isArray(ref.exam) ? [...new Set(ref.exam.map(e => e.stage))].sort((a, b) => a - b) : [],
    note: ref.note || null,
    rulers: ref.rulers.map(r => ({ key: r.key, label: r.label })),
    latest: last ? { gen: last.gen, at: last.at, scores: last.scores } : null,
    history: hist.map(h => ({ gen: h.gen, scores: h.scores })),
  };
}

/**
 * checkpoint（或匯出的基因組）→ 看板 payload。
 * @param {object} j 已 parse 的 JSON
 * @param {string} file 來源檔（顯示用）
 * @param {object} o { running, mode, mtime }
 */
function fromCheckpoint(j, file, o = {}) {
  const now = Date.now();
  const isGenome = j.kind === 'tank-battle-genome';
  const cfg = (isGenome ? (j.provenance && j.provenance.config) : j.config) || {};
  const histRaw = isGenome
    ? ((j.provenance && j.provenance.growth) || [])
    : ((j.neat && j.neat.history) || []);
  const history = histRaw.map(h => ({
    gen: h.gen, best: h.best, mean: h.mean, species: h.species ?? null,
    // raw  = 未封頂的原始均分，zero = 本代拿到 0 分的個體占比。
    // 沒有這兩行，「best 平在 0」在圖上跟「真的停滯」長得一模一樣：
    // 早期世代的族群可能一直在長（raw 上揚），只是還沒有人拿到入場券。
    raw: h.raw ?? null, zero: h.zero ?? null,
  }));
  const sessionsRaw = isGenome ? ((j.provenance && j.provenance.sessions) || []) : (j.sessions || []);
  const sessions = sessionsRaw.map(compactSession);
  const champ = isGenome
    ? {
        generation: j.championGeneration ?? j.generation,
        fitness: j.fitness,
        scoringVersion: j.scoringVersion ?? null,
        measuredAgainst: j.opponentRuler || null,
        genome: j.genome,
      }
    : (j.champion || null);
  const gen = isGenome ? (j.generation || 0) : (j.neat ? j.neat.generation : 0);
  const episodes = j.episodes || 0;
  const last = history[history.length - 1] || null;
  const lastSession = sessionsRaw[sessionsRaw.length - 1] || null;
  let session = null;
  if (lastSession) {
    const fromGen = lastSession.fromGeneration ?? 0;
    const fromEp = lastSession.fromEpisodes ?? 0;
    const started = lastSession.startedAt ? Date.parse(lastSession.startedAt) : null;
    session = {
      index: lastSession.index || sessionsRaw.length,
      source: lastSession.source || null,
      from: lastSession.from || lastSession.file || null,
      startedAt: lastSession.startedAt || null,
      fromGeneration: fromGen,
      fromEpisodes: fromEp,
      doneGens: Math.max(0, gen - fromGen),
      targetGens: lastSession.args && Number(lastSession.args.gens) > 0 ? Number(lastSession.args.gens) : null,
      doneEpisodes: Math.max(0, episodes - fromEp),
      targetEpisodes: lastSession.args && Number(lastSession.args.episodes) > 0 ? Number(lastSession.args.episodes) : null,
      elapsedSec: lastSession.elapsedSec ??
        (started && Date.now() - started > 0 ? (Date.now() - started) / 1000 : null),
      best: last ? last.best : (lastSession.best ?? null),
      mean: last ? last.mean : (lastSession.mean ?? null),
      examBefore: lastSession.examBefore || null,
      examChanged: !!lastSession.examChanged,
      opponentRuler: lastSession.opponentRuler || null,
      opponentRulerLabel: lastSession.opponentRulerLabel || null,
      opponentBefore: lastSession.opponentBefore || null,
      opponentChanged: !!lastSession.opponentChanged,
      championRescore: lastSession.championRescore || null,
      scoringVersion: lastSession.scoringVersion ?? null,
    };
  }
  const stages = cfg.stages || [];
  // v6 起一支族群只坐自己那一席，所以每代場數 = pop × 圖 × 種子 × seats。
  // seats 從存檔讀（舊檔沒這個欄位 → 當 1：新碼跑出來的都是單座位，
  // 唯一會看到 seats=2 的是 v5 之前落盤的存檔，它在 config 裡也沒記，
  // 所以寧願少報也不能假報 —— 場數是使用者判斷「跑了多少」的單位）。
  const seats = cfg.seats || 1;
  const role = j.role || cfg.role || null;
  const perGen = sessionsRaw.length && cfg.pop && stages.length && cfg.seeds
    ? cfg.pop * stages.length * cfg.seeds * seats : null;
  return {
    kind: KIND,
    at: new Date().toISOString(),
    file: rel(file),
    mode: o.mode || 'checkpoint',
    running: o.running === undefined || o.running === null ? null : !!o.running,
    checkpointMtime: iso(o.mtime || mtimeOf(file)),
    // 角色是這一族的身分，不是一個選項：ai/live.html 用它決定標題寫
    // 「進攻模型」還是「防守模型」，也用它避免把兩族的曲線畫在同一張圖上。
    role,
    roleLabel: role ? (role === 'defense' ? '防守' : role === 'attack' ? '進攻' : role) : null,
    seat: role === 'defense' ? 1 : role === 'attack' ? 0 : null,
    gen,
    episodes,
    perGen,
    scoringVersion: j.scoringVersion ?? (champ && champ.scoringVersion) ?? null,
    obsSpec: j.obsSpec || Observation.OBS_SPEC,
    config: {
      stages, seeds: cfg.seeds ?? null, opponent: cfg.opponent || null,
      vs: cfg.vs || null, seats, role,
      // 「這一段的分數是打誰量的」：交替演化每段都不同，看板少了它就無法解釋段界的下掉。
      opponentRuler: cfg.opponentRuler || null,
      opponentRulerLabel: cfg.opponentRulerLabel || null,
      pop: cfg.pop ?? null, maxFrames: cfg.maxFrames ?? null, seedFrom: cfg.seedFrom || null,
    },
    history: history.slice(-3000),
    best: champ ? champ.fitness : (last ? last.best : null),
    bestGen: champ ? champ.generation ?? null : null,
    mean: last ? last.mean : null,
    species: last ? last.species : null,
    champion: champ ? Object.assign({
      generation: champ.generation ?? null,
      fitness: champ.fitness ?? null,
      scoringVersion: champ.scoringVersion ?? null,
      rescoredAt: champ.rescoredAt || null,
      measuredAgainst: champ.measuredAgainstLabel || champ.measuredAgainst || null,
    }, genomeSummary(champ.genome)) : null,
    sessions,
    session,
    assessments: (j.assessments || []).slice(-5),
    // 固定參考尺：曲線上漲是真進步還是「對手換了」，靠這一段判讀。
    reference: compactReference(j.reference),
  };
}

/** 訓練程序用：直接吃記憶體裡的 meta／neat，拿到最即時的數字與確定的 running */
function fromTrainer(file, meta, neat, running) {
  const pseudo = {
    kind: 'tank-battle-neat-checkpoint',
    obsSpec: Observation.OBS_SPEC,
    scoringVersion: require('./fitness').SCORING_VERSION,
    config: meta.config,
    episodes: meta.episodes,
    champion: meta.champion,
    sessions: meta.sessions || [],
    assessments: meta.assessments || [],
    reference: meta.reference || null,
    neat: { generation: neat.generation, history: neat.history },
  };
  return fromCheckpoint(pseudo, file, { running, mode: 'trainer' });
}

function serialize(data) {
  return '/* 自動產生：訓練程序每代覆寫（或 node ai/live.js）。請勿手改。 */\n' +
    'window.__LIVE__ = ' + JSON.stringify(data) + ';\n';
}

let warned = false;

/** 給訓練用：寫失敗只警告一次，絕不讓看板把訓練搞掛 */
function tryWrite(out, data) {
  try { atomicWrite(out, serialize(data)); return true; }
  catch (e) {
    if (!warned) {
      warned = true;
      console.warn(`⚠ 即時看板資料寫不進去（${rel(out)}）：${e.message}｜訓練繼續，不影響落盤`);
    }
    return false;
  }
}

function writeFromTrainer(out, file, meta, neat, running) {
  return tryWrite(out, fromTrainer(file, meta, neat, running));
}

/* ── CLI：--once / --watch ─────────────────────────────────── */

function once(file, out) {
  const j = loadAny(file);
  const data = fromCheckpoint(j, file, {
    mode: 'snapshot', running: j.kind === 'tank-battle-genome' ? false : null,
  });
  atomicWrite(out, serialize(data));
  console.log(`即時看板資料：${rel(out)}`);
  console.log(`  來源 ${rel(file)}｜第 ${data.gen} 代｜${data.episodes} 場｜` +
    `最佳 ${data.best == null ? '—' : Number(data.best).toFixed(2)}｜` +
    `收斂點 ${data.history.length} 筆｜${data.champion ? '冠軍 ' + data.champion.fingerprint : '尚無冠軍'}`);
  console.log(`  打開 ${rel(path.join(__dirname, 'live.html'))} 就會看到（這是靜態快照；` +
    `要跟著訓練更新請跑 ai/evolve.js，或用 --watch 監看 checkpoint）`);
}

function watch(file, out, intervalSec) {
  console.log(`監看 ${rel(file)} → ${rel(out)}（每 ${intervalSec}s 比對一次 mtime；Ctrl+C 停止）`);
  let lastMtime = 0;
  let lastErr = '';
  const tick = () => {
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs === lastMtime) return;
      lastMtime = st.mtimeMs;
      const j = loadAny(file);
      const data = fromCheckpoint(j, file, { mode: 'watch', running: null, mtime: st.mtimeMs });
      atomicWrite(out, serialize(data));
      console.log(`[${new Date().toLocaleTimeString('zh-Hant', { hour12: false })}] ` +
        `第 ${data.gen} 代｜${data.episodes} 場｜最佳 ${data.best == null ? '—' : Number(data.best).toFixed(2)}｜` +
        `第 ${data.history.length} 筆`);
      lastErr = '';
    } catch (e) {
      // 檔案正在被換掉時可能讀到半截；只印一次同樣的錯，避免洗版。
      // mtime 要退回 0，否則這個時間戳已經被「消費」掉，下一次輪詢看到
      // 同一個 mtime 就不會重試，整筆更新會被跳過。
      lastMtime = 0;
      if (e.message !== lastErr) { lastErr = e.message; console.warn(`讀取失敗：${e.message}`); }
    }
  };
  tick();
  for (;;) { sleep(Math.max(1, intervalSec) * 1000); tick(); }
}

const HELP = `ai/live.js — 產生 ai/live.html 讀的即時資料（window.__LIVE__）

用法：
  node ai/live.js [--once] [runs/warm-v2.json]        # 寫一次 ai/live-data.js
  node ai/live.js --watch [runs/warm-v2.json]         # 監看 checkpoint，有變就覆寫
  node ai/live.js --watch --interval 2                # 每 2 秒比對一次
  node ai/live.js --out ai/live-data.js               # 換輸出位置

備註：
  · 正常訓練時不需要這支程式：ai/evolve.js 每代會自己覆寫 live-data.js。
  · --watch 只用 checkpoint 的 mtime 判斷「檔案有動」，不知道訓練是否還活著，
    所以網頁會標成「檔案監看」而不是「訓練中」。
  · 產出是 <script> 而不是 JSON：file:// 下瀏覽器不準 fetch() 讀本機檔。`;

function parse(argv) {
  const o = { file: null, out: DEFAULT_OUT, watch: false, interval: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--watch') o.watch = true;
    else if (a === '--once') o.watch = false;
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--interval') o.interval = Number(argv[++i]) || 3;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('-')) throw new Error(`unknown arg: ${a}`);
    else o.file = a;
  }
  if (!o.file) o.file = DEFAULT_CHECKPOINT;
  return o;
}

function main(argv) {
  const o = parse(argv);
  if (o.help) { console.log(HELP); return; }
  if (o.watch) watch(o.file, o.out, o.interval);
  else once(o.file, o.out);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (e) { console.error(`✗ ${e.message}`); process.exitCode = 1; }
}

module.exports = {
  KIND, DEFAULT_OUT, fromCheckpoint, fromTrainer, serialize,
  tryWrite, writeFromTrainer, once, watch, loadAny, compactReference,
};
