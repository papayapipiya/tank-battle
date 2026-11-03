/* ai/ledger.js — 訓練結果的「履歷」
   ═══════════════════════════════════════════════════════════
   觀戰頁看的是一場仗，`ai/monitor.html` 看的是「這一輪怎麼打」，
   這個檔回答的是另外兩個問題：

     1. 它到底被訓練過幾次？
        幾段工作階段（今天跑一次＝一段）、每段跑了幾代幾場、
        從哪裡接續過來（冷開機／模仿種子／上次的存檔）、
        花了多少時間、冠軍是在第幾代被刷新的。
     2. 它是被什麼標準評出來的？
        適應度的每一項（權重＋算式＋上限＋存在理由）、過程懲罰的門檻、
        紅旗清單、座位公平的四項修正、歸一化協議、
        以及「考題」-vs-「考績」用的種子是不是分開的。

   兩份東西都必須出自同一支碼，否則「展示給使用者看的評判標準」
   跟「實際在用的那個」會分岔 —— 所以：
     · 評判標準 = ai/fitness.js 的 TERMS（就是算分那份）＋ ai/telemetry.js 的 RULES
     · 訓練次數 = checkpoint 裡的 sessions（由 ai/evolve.js 每次開機追加）

   ⚠ 舊存檔（還沒有 sessions 的那批）不會被編故事：
     ledger 會從 neat.history／episodes／updatedAt「推導」出一段，
     並明確標成 inferred=true，網頁與文字版都要看得出那是推導的。
   ═══════════════════════════════════════════════════════════ */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const Checkpoint = require('./checkpoint');
const Observation = require('./observation');
const { Genome } = require('./neat');
const { TERMS, WEIGHTS, explainFitness, SCORING_VERSION, SCORING_VERSION_NOTE,
  termsFor, weightOf, formulaOf, ROLE_LABEL, HALF_FIELD_PX,
  WALL_CELL_CAP, WALL_FAR_SHARE } = require('./fitness');
const { RULES } = require('./telemetry');
const { hashSeed } = require('./rng');
const ACTION_NAMES = require('./actions').ACTION_NAMES;

const LEDGER_KIND = 'tank-battle-training-ledger';
const GENOME_KIND = 'tank-battle-genome';
const SEED_KIND = 'tank-battle-imitation-seed';
/** 考題種子（訓練時評估用的那一把）與考績種子（驗證用的新題目）必須分開 */
const TRAIN_SEED_SALT = 0x5eed;
const ASSESS_SEED_SALT = 0xc0ffee;

/* v6 的結束方式：短標籤給文字版用，順序固定（不要把 0 次的項目排中間）。
   對應 js/constants.js 的 DEMO_END_TEXT，那邊是給畫面看的長句。 */
const DEMO_END_ORDER = ['breach', 'counter', 'time', 'pool'];
const DEMO_END_LABEL = {
  breach: '打穿紅鷹',
  counter: '藍鷹被破',
  time: '30 秒時間到',
  pool: '兵力耗盡',
};

/* ── 身分：把基因組壓成一個短指紋 ───────────────────────── */

/**
 * 一律用「相對專案根」的路徑：--all 掃出來的是 C:\Users\...\runs\day1.json
 * 那種長絕對路徑，塞進網頁與匯出檔既難讀又洩漏本機目錄結構。
 * 根目錄之外的檔（測試用的 tmp）才保留原樣。
 */
function rel(p) {
  const abs = path.resolve(p);
  const r = path.relative(path.join(__dirname, '..'), abs).replace(/\\/g, '/');
  return r.startsWith('..') ? abs.replace(/\\/g, '/') : r;
}

/** 空值也要能丟進來的 rel（session.from 常常是 null，直接 rel(null) 會炸） */
function relOf(p) { return p ? rel(p) : null; }

/** 這一族是不是「從舊的單模型冠軍拆出來的」—— ai/split.js 會留這一筆 */
function splitInfo(list) {
  const s = (list || []).find(x => x && x.source === 'split');
  return s && s.split ? s.split : null;
}

function splitLabel(sp) {
  return `由 ${relOf(sp.from)} 第 ${sp.fromGeneration} 代的冠軍拆出來` +
    `（舊算分 v${sp.fromScoringVersion ?? '?'} 下的 ${Number(sp.fromFitness).toFixed(1)} 分，` +
    `指紋 ${sp.fromFingerprint || '?'}）`;
}

/**
 * 拓撲＋權重 → sha1 前 12 碼。
 * 用途：跨 session 追蹤「冠軍還是同一隻嗎」——適應度相同不代表同一個個體。
 * 排除 node id（同一隻網路的 id 可能因交叉而變），只留拓撲與數值。
 */
function fingerprint(genomeJSON) {
  const g = typeof genomeJSON.toJSON === 'function' ? genomeJSON.toJSON() : genomeJSON;
  const links = (g.links || []).map(l => [l.in, l.out, !!l.enabled, +(l.weight).toFixed(6)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  // 節點只留「種類 + bias」（不含 id）：id 在不同存檔之間可能被重排，
  // 拿它當節點身分會把同一隻網路算成兩隻。邊則用 id 對当端點——
  // 同一血緣的 id 是穩定的，變異／接續不會重新編號，所以能拿來判「是不是同一隻」。
  const nodes = (g.nodes || []).map(n => [n.kind || n.type, n.bias === undefined ? null : +n.bias.toFixed(6)])
    .sort();
  const h = crypto.createHash('sha1').update(JSON.stringify({ nodes, links }));
  return h.digest('hex').slice(0, 12);
}

/* ── 評判標準（直接從算分的模組讀，不在這裡重寫一遍） ──── */

/** 評量協議：鐵律的文字版，每條都指回實作位置 */
function protocol() {
  return [
    {
      name: '一局可重現',
      rule: '(地圖, 種子, 控制器組合) 完全決定結果；同樣的三元組要逐位元組相同',
      where: 'ai/arena.js + ai/engine.js（vm 沙盒載入真正的遊戲碼，打樁 DOM/canvas/localStorage/rAF）',
    },
    {
      name: '流量項逐幀歸一化',
      rule: '擊殺／傷害／開火／道具全部換算成「每 1000 在場幀」；在場幀扣掉出生無敵與被凍結的幀',
      where: 'ai/fitness.js 的 per1k()、ai/arena.js 的 fieldFrames',
    },
    {
      name: '席位固定、角色各練各的',
      rule: `v6 起不再「兩席各打一次取平均」：藍席永遠是進攻模型、紅席永遠是防守模型，` +
        `一個族群只在自己的席位上被評（config.seats=1）。兩個角色問的是不同的事，` +
        `平均會把兩把尺混成一把；席位殘留的統計偏由「多地圖 × 多種子」分攤`,
      where: 'ai/fitness.js 的 evaluatePolicy()、ai/evolve.js 的 --role／--vs',
    },
    {
      name: '交替自我對弈',
      rule: '練這一族時，對手＝另一族「這一刻的冠軍」（ai/auto-train.js 每輪交換 --vs）。' +
        '對手在變強，所以分數不是絕對實力；跨輪比較要連同考績勝率一起看',
      where: 'ai/auto-train.js 的 sessionArgs()、ai/evolve.js 的 loadOpponent()',
    },
    {
      name: '換對手先把舊冠軍重評',
      rule: '冠軍那筆分數屬不屬於「打誰」記在 champion.measuredAgainst（路徑＋對手基因組指紋）。' +
        '接續時只要這把尺跟本次對手不同，就先拿新對手把冠軍重打 stages×seeds 場（校準局不計入訓練場數）再生世代。' +
        '少了這一步，停在「打規則 AI 91.6」的舊數字會永遠壓著「打對面冠軍 30 分」的新世代 —— ' +
        '代數一直漲、冠軍卻幾十代不動，看起來就是訓練沒在動',
      where: 'ai/evolve.js 的 opponentRuler()／makeOpponentResolver()、championRescore.reasons 含 opponent',
    },
    {
      name: '地圖點對稱',
      rule: 'cells[y][x] === cells[25-y][25-x]，兩邊的家門口地形一模一樣',
      where: 'js/map.js（觀戰地圖由下半部鏡像產生上半部）',
    },
    {
      name: '出兵同幀（但節奏刻意不對稱）',
      rule: '兩隊首發在同一幀（早期實作讓紅隊晚 25 幀出兵，是系統性偏置）。' +
        'v6 起補兵間隔依角色不同：進攻 100 幀、防守 150 幀 —— 這不是測量偏差，' +
        '是規則本身給進攻方的時間窗，30 秒鐘要換成推進壓力',
      where: 'js/game.js、js/constants.js 的 DEMO_TEAM_SPAWN_INTERVALS',
    },
    {
      name: '同幀結算隨機翻轉',
      rule: '每幀隨機翻轉 tanks 的處理順序。固定藍先紅後曾讓所有「同幀互毀」都由藍隊獲勝（實測 200 局 58.5%），修正後 200 局 100:100',
      where: 'js/game.js',
    },
    {
      name: '過程懲罰只套在網路身上',
      rule: '卡牆／動作單一／無效彈三項只在「這一隊真的有 policy 在決策」時生效；純規則 AI 不受誤傷',
      where: 'ai/fitness.js 的 hasPolicy gate',
    },
    {
      name: '地板（不是階梯）',
      rule: '整局躺平 → 封頂 0；自家老鷹被毀 → 封頂在「守住老鷹」的固定分之下（仍保留同儕梯度）；負分不記錄（下限 0）',
      where: 'ai/fitness.js 的 floors',
    },
    {
      name: '觀測規格鎖',
      rule: `OBS_SPEC 目前 v${Observation.OBS_SPEC.version}／${Observation.OBS_DIM} 欄；載入時版本不符直接拒絕，不靜默重訓`,
      where: 'ai/observation.js + ai/checkpoint.js 的 load()',
    },
    {
      name: '考題與考績分開',
      rule: `訓練時評估用的種子來自 salt 0x${TRAIN_SEED_SALT.toString(16)}（ai/evolve.js 的 evalSeed），` +
        `驗成果用的是另一把從未參與評估的種子（salt 0x${ASSESS_SEED_SALT.toString(16)}）——` +
        `同一把種子量出來的「勝率」是背題，不是會打`,
      where: 'ai/evolve.js 的 evalSeed() / report()、ai/ledger.js 的 verify()',
    },
  ];
}

/** 完整的評判標準：權重表（就是算分那份）＋紅旗＋協議＋歸一化說明 */
function rubric() {
  const documented = new Set(TERMS.map(t => t.key));
  const undocumented = Object.keys(WEIGHTS).filter(k => !documented.has(k));
  // v6 起同一個 key 在兩個角色上可以有不同的權重與算式，甚至一邊有一邊沒有。
  // 展現在網頁上時不能只報「權重 14」——要說清楚那是進攻的 14 還是防守的 14，
  // 否則使用者拿防守的分去比進攻的分，會誤會模型練壞了（單位本來就不同）。
  const roleText = roles => (roles.length === 2 ? '兩邊' : roles[0] === 'attack' ? '僅進攻' : '僅防守');
  const wText = (a, d) => (a !== null && d !== null
    ? (a === d ? String(a) : `進攻 ${a}／防守 ${d}`)
    : String(a !== null ? a : d));
  const fText = (a, d) => (a && d && a !== d ? `進攻：${a}\n防守：${d}` : (a || d));
  const termRow = t => {
    const wA = t.roles.includes('attack') ? weightOf(t, 'attack') : null;
    const wD = t.roles.includes('defense') ? weightOf(t, 'defense') : null;
    const fA = t.roles.includes('attack') ? formulaOf(t, 'attack') : null;
    const fD = t.roles.includes('defense') ? formulaOf(t, 'defense') : null;
    return {
      key: t.key, label: t.label, roles: t.roles, roleText: roleText(t.roles),
      weight: wA !== null ? wA : wD, weightAttack: wA, weightDefense: wD, weightText: wText(wA, wD),
      formula: fA || fD, formulaAttack: fA, formulaDefense: fD, formulaText: fText(fA, fD),
      cap: t.cap || null, gate: t.gate || null, why: t.why,
      kind: (wA !== null ? wA : wD) < 0 ? '懲罰' : '加分',
    };
  };
  return {
    obsSpec: Observation.OBS_SPEC,
    actions: ACTION_NAMES,
    // 算分規則版本：同一隻網路在 v1（傷害漏算致命一擊）跟 v2 下分數不同單位，
    // 所以「評判標準」本身也有版本，不能只報權重不報版本。
    scoringVersion: SCORING_VERSION,
    // 半場尺（penetration／foeHalf 等項的分母）。v9 之後它是 FIELD_H/2＝168，
    // 而頁面要拿它跟「離敵鷹最近距離」並排顯示；把 104 這種數字抄進 HTML，
    // 換一次戰場形狀就會變成「畫面上的尺跟算分的尺不是同一把」。
    halfFieldPx: HALF_FIELD_PX,
    // 兩個角色是兩把不同的尺：項次、權重、算式都可能不一樣。
    roles: {
      attack: { label: '進攻（藍席）', terms: termsFor('attack').map(termRow) },
      defense: { label: '防守（紅席）', terms: termsFor('defense').map(termRow) },
    },
    terms: TERMS.map(termRow),
    redFlags: RULES.map(r => ({
      id: r.id, label: r.label, limit: r.limit, why: r.why, fix: r.fix,
    })),
    protocol: protocol(),
    // 有權重卻沒寫進 TERMS = 展示給使用者的標準少了一項，這是真的錯
    undocumented,
  };
}

/* ── 訓練次數：讀 session（舊檔則明確標成推導） ─────────── */

function isoAgo(iso) { return iso ? Date.parse(iso) : null; }

/** 權重顯示：符號跟數字一起對齊（先 pad 數字再加 +/- 會錯開一整格） */
function fmtWeight(w, width = 5) {
  return (w > 0 ? '+' : w < 0 ? '-' : ' ') + String(Math.abs(w)).padStart(width - 1);
}

function fmtDur(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '—';
  const s = Math.round(sec);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return `${m} 分 ${rs} 秒`;
  return `${Math.floor(m / 60)} 小時 ${m % 60} 分`;
}

/**
 * checkpoint → 一團工作階段。
 * @returns {{list: object[], inferred: boolean}}
 */
function sessionsOf(j) {
  if (Array.isArray(j.sessions) && j.sessions.length)
    return {
      // from／file 是「使用者當初打的路徑」，Windows 會帶反斜線；
      // 統一成 / 再顯示，不然網頁上會看到 runs\\warm-v2.json 這種雙反斜線。
      list: j.sessions.map((s, i) => Object.assign({ index: i + 1 }, s, {
        from: s.from ? String(s.from).replace(/\\/g, '/') : s.from,
        file: s.file ? String(s.file).replace(/\\/g, '/') : s.file,
      })),
      inferred: false,
    };
  // 舊存檔：只能從「最終狀態 + 收斂曲線長度」反推，沒有時間軸與來源
  const hist = (j.neat && j.neat.history) || [];
  const gens = j.neat ? j.neat.generation : 0;
  return {
    list: [{
      index: 1,
      inferred: true,
      source: j.config && j.config.seedFrom ? 'seed-from' : 'cold',
      from: (j.config && j.config.seedFrom) || null,
      startedAt: null,
      finishedAt: j.updatedAt || null,
      fromGeneration: 0,
      fromEpisodes: 0,
      generations: gens,
      episodes: j.episodes || 0,
      toGeneration: gens,
      toEpisodes: j.episodes || 0,
      best: hist.length ? hist[hist.length - 1].best : null,
      mean: hist.length ? hist[hist.length - 1].mean : null,
      elapsedSec: null,
    }],
    inferred: true,
  };
}

/** 哪幾段換過考題（地圖組）。換圖＝換尺，那段前後的 best／mean 不能直接比。 */
function examChangesOf(list) {
  return (list || []).filter(x =>
    x.examChanged || (x.examBefore && JSON.stringify(x.examBefore) !== JSON.stringify(x.stages)));
}

/** 哪幾段用的是舊版算分。跨版本＝換尺，跟換圖一樣不可比。 */
function scoringChangesOf(list) {
  return (list || []).filter(x => x.scoringVersion && x.scoringVersion !== SCORING_VERSION);
}

/**
 * 哪幾段換了對手（尺）。
 * 交替自我對弈每段都把「對面這一刻的冠軍」放進來，對手每輪都在變強，
 * 所以同一個分數在前期跟後期不是同一件事 —— 曲線往下掉可能只是對面變強了。
 * 舊檔沒有 opponentRuler 時看不出換沒換，這欄就是空的（不編資料）。
 */
function rulerChangesOf(list) {
  return (list || []).filter(x =>
    x.opponentChanged || (x.opponentBefore && x.opponentRuler &&
      x.opponentBefore !== x.opponentRuler));
}

/* ── 單檔 → 履歷 ─────────────────────────────────────────── */

function describeGenome(g) {
  const links = g.links || [];
  const kindOf = n => n.kind || n.type;
  return {
    nodes: (g.nodes || []).length,
    links: links.length,
    enabledLinks: links.filter(l => l.enabled).length,
    hidden: (g.nodes || []).filter(n => kindOf(n) === 'hidden').length,
  };
}

/** 任何一種存檔（checkpoint / 匯出基因組 / 模仿種子）→ 履歷物件 */
function resumeOf(file, opts = {}) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`讀不到 ${rel(abs)}`);
  const j = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const spec = j.obsSpec;
  if (spec && spec.version !== Observation.OBS_SPEC.version)
    throw new Error(`${rel(abs)} 的觀測規格 v${spec.version}（${spec.dim} 欄）與現行 ` +
      `v${Observation.OBS_SPEC.version}（${Observation.OBS_DIM} 欄）不符 —— 這是一份舊規格的成績單，` +
      `數字不能跟現在的放在一起比`);

  // 算分版本：v1（ai/arena.js 的傷害差分漏掉致命一擊）跟 v2 的分數不是同一個單位，
  // 同一隻網路在 v2 下會拿比較高的分。舊存檔沒標版本 → 一律當 v1，
  // 寧可多標一次「不能直接比」，也不要讓使用者把兩個單位的數字排在一起看。
  const scoringVersion = j.scoringVersion ||
    (j.champion && j.champion.scoringVersion) ||
    (j.provenance && j.provenance.scoringVersion) || 1;

  // 角色（v6 雙模型）：進攻與防守是兩把不同的尺，混在同一份履歷裡而不標角色，
  // 使用者會拿防守的 90 分去跟進攻的 150 分比，然後得到一個錯誤的結論。
  // 舊檔（v5 以前的單模型）沒有這個欄位 → null，頁面顯示「單模型（v5 前）」。
  const cfgEarly = j.config || (j.provenance && j.provenance.config) || {};
  const role = j.role || (j.champion && j.champion.role) || cfgEarly.role || null;

  // 「這分數是打誰打出來的」（v6 交替演化）。缺了這行，91.6 分是打規則 AI、
  // 60 分是打對面冠軍，兩件事會被讀成同一件事。
  const champRec = j.champion || null;
  const championMeasuredAgainst = j.opponentRuler ||
    (champRec && (champRec.measuredAgainstLabel || champRec.measuredAgainst)) ||
    (j.config && (j.config.opponentRulerLabel || j.config.opponentRuler)) || null;

  const base = {
    file: rel(abs),
    kind: j.kind || 'unknown',
    role,
    roleLabel: role ? (ROLE_LABEL[role] || role) : null,
    obsSpec: spec || null,
    scoring: {
      version: scoringVersion, current: SCORING_VERSION,
      comparable: scoringVersion === SCORING_VERSION,
      note: scoringVersion === SCORING_VERSION ? null
        : `這份適應度是在算分 v${scoringVersion} 下算的，跟現行 v${SCORING_VERSION} 不同單位，不能直接比高低` +
          `。現行那一版改的是：${SCORING_VERSION_NOTE}`,
    },
    rubric: opts.rubric === false ? null : rubric(),
    assessments: Array.isArray(j.assessments) ? j.assessments : [],
    championMeasuredAgainst,
  };

  if (j.kind === SEED_KIND) {
    const g = j.genome;
    const t = (j.teacher || {});
    return Object.assign(base, {
      label: `${path.basename(file)}｜模仿種子（還沒經過 NEAT）`,
      identity: {
        generation: 0, championGeneration: 0,
        fitness: j.accuracy ? j.accuracy.genome : null, fitnessKind: '模仿忠實度',
        episodes: 0, structure: describeGenome(g),
        fingerprint: fingerprint(g),
      },
      lineage: {
        origin: 'imitation',
        originLabel: `行為複製自規則 AI（${t.games || 0} 局、${t.rawFrames || 0} 個決定幀 → ${t.kept || 0} 筆樣本）`,
        seedFrom: null, chain: [],
      },
      counts: {
        sessions: 1,
        sessionList: [{
          index: 1, inferred: false, source: 'imitation',
          startedAt: j.generatedAt || null,
          finishedAt: j.generatedAt || null,
          generations: 0, episodes: t.games || 0,
          games: t.games || 0, rawFrames: t.rawFrames || 0, samples: t.kept || 0,
        }],
        sessionsInferred: false,
        generations: 0, episodes: 0, wallSec: null,
      },
      fidelity: j.accuracy || null,
      config: null,
      growth: [],
    });
  }

  if (j.kind === GENOME_KIND) {
    const g = j.genome;
    const prov = j.provenance || null;          // --export 帶過來的原始紀錄
    // 匯出檔把演化史改名成 provenance.growth，sessionsOf() 認的是 checkpoint 的
    // neat.history。這裡先接回同一個形狀，否則舊匯出檔推導出來的時間軸會顯示
    // 「0 代 0 場」——明明有 80 代 15360 場，卻像完全沒訓練過。
    const s = sessionsOf(prov ? {
      sessions: prov.sessions,
      config: prov.config,
      updatedAt: prov.updatedAt,
      episodes: j.episodes,
      neat: {
        generation: j.generation,
        history: (prov.growth || []).map(h => ({ gen: h.gen, best: h.best, mean: h.mean, species: h.species })),
      },
    } : j);
    return Object.assign(base, {
      label: `${path.basename(file)}｜${role ? `${ROLE_LABEL[role] || role}模型 ` : ''}匯出的冠軍（第 ${j.generation} 代）`,
      identity: {
        generation: j.generation, championGeneration: j.championGeneration,
        fitness: j.fitness, fitnessKind: '適應度',
        episodes: j.episodes || 0, structure: describeGenome(g),
        fingerprint: fingerprint(g),
      },
      lineage: {
        origin: splitInfo(s.list) ? 'split'
          : prov && prov.config && prov.config.seedFrom ? 'warm' : (prov ? 'cold' : 'unknown'),
        originLabel: splitInfo(s.list) ? splitLabel(splitInfo(s.list))
          : prov && prov.config && prov.config.seedFrom
            ? `暖啟動自模仿種子 ${prov.config.seedFrom}`
            : prov ? '冷開機（隨機權重）' : '匯出檔沒有帶 provenance（舊版 --export 的產物）',
        seedFrom: prov && prov.config ? prov.config.seedFrom || null : null,
        split: splitInfo(s.list) || null,
        chain: s.list.map(x => ({ index: x.index, source: x.source, from: relOf(x.from), generations: x.generations, episodes: x.episodes })),
      },
      counts: {
        sessions: s.list.length, sessionList: s.list, sessionsInferred: s.inferred,
        generations: j.generation, episodes: j.episodes || 0,
        wallSec: s.list.reduce((a, x) => a + (x.elapsedSec || 0), 0) || null,
        perGeneration: j.episodes && j.generation ? j.episodes / j.generation : null,
        stagnationGens: Number.isFinite(j.championGeneration) ? j.generation - j.championGeneration : null,
        examChanges: examChangesOf(s.list),
        scoringChanges: scoringChangesOf(s.list),
        rulerChanges: rulerChangesOf(s.list),
      },
      config: prov ? prov.config : null,
      growth: prov && prov.growth ? prov.growth : [],
      championLog: prov && prov.championLog ? prov.championLog : [],
    });
  }

  if (j.kind === Checkpoint.KIND) {
    const champG = j.champion ? j.champion.genome : null;
    const s = sessionsOf(j);
    // session.from 是命令列原樣傳進來的絕對路徑（ai/auto-train.js 給的就是）；
    // 履歷裡出現 C:\Users\... 既難讀又洩漏本機目錄，一律壓成專案相對路徑。
    for (const x of s.list) if (x.from) x.from = relOf(x.from);
    const hist = (j.neat && j.neat.history) || [];
    const cfg = j.config || {};
    const perGen = (j.neat && j.neat.population ? j.neat.population.length : cfg.pop || 0) *
      (cfg.stages || []).length * (cfg.seeds || 0) * (cfg.seats || 1);
    return Object.assign(base, {
      label: `${path.basename(file)}｜${role ? `${ROLE_LABEL[role] || role}模型 ` : ''}第 ${j.neat.generation} 代`,
      identity: {
        generation: j.neat.generation,
        championGeneration: j.champion ? j.champion.generation : null,
        fitness: j.champion ? j.champion.fitness : null, fitnessKind: '適應度',
        episodes: j.episodes || 0,
        structure: champG ? describeGenome(champG) : null,
        fingerprint: champG ? fingerprint(champG) : null,
      },
      lineage: {
        origin: splitInfo(s.list) ? 'split' : cfg.seedFrom ? 'warm' : 'cold',
        originLabel: splitInfo(s.list) ? splitLabel(splitInfo(s.list))
          : cfg.seedFrom ? `暖啟動自模仿種子 ${cfg.seedFrom}` : '冷開機（隨機權重）',
        seedFrom: cfg.seedFrom || null,
        split: splitInfo(s.list) || null,
        chain: s.list.map(x => ({
          index: x.index, source: x.source || (x.inferred ? 'unknown' : 'session'),
          from: relOf(x.from), generations: x.generations, episodes: x.episodes,
          finishedAt: x.finishedAt || null, inferred: !!x.inferred,
        })),
      },
      counts: {
        sessions: s.list.length, sessionList: s.list, sessionsInferred: s.inferred,
        generations: j.neat.generation, episodes: j.episodes || 0,
        wallSec: s.list.reduce((a, x) => a + (x.elapsedSec || 0), 0) || null,
        perGeneration: perGen || null,
        species: hist.length ? hist[hist.length - 1].species : null,
        stagnationGens: j.champion ? j.neat.generation - j.champion.generation : null,
        examChanges: examChangesOf(s.list),
        scoringChanges: scoringChangesOf(s.list),
      },
      config: cfg,
      growth: hist.map(h => ({ gen: h.gen, best: h.best, mean: h.mean, species: h.species })),
      championLog: Array.isArray(j.championLog) ? j.championLog : [],
    });
  }

  throw new Error(`${rel(abs)} 的 kind=${j.kind}，不是本專案的訓練產物` +
    `（要嘛是 checkpoint、要嘛是 --export 的基因組、要嘛是 ai/imitate.js 的種子）`);
}

/** 單檔 → 履歷，但把「這份檔根本讀不了」變成一筆記錄而不是整批失敗。
    --all／--html 會掃整個 runs/，裡面難得有舊觀測規格（v1／80 欄）的存檔；
    讓一顆舊檔炸掉整份報告，等於最該被看到的「已作廢」資訊反而看不到。 */
function safeResume(file, opts) {
  try { return resumeOf(file, opts); }
  catch (e) {
    let spec = null;
    try { spec = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')).obsSpec || null; } catch (e2) { /* 不是 JSON 就當未知 */ }
    // reason 讓頁面分得開「舊規格作廢」跟「檔案真的壞了」：
    // 前者是預期中的歷史包袱（該被看見，但不該像錯誤一樣嚇人），
    // 後者才需要使用者去處理。
    const stale = !!(spec && spec.version !== Observation.OBS_SPEC.version);
    return { file: rel(file), error: String(e.message || e), obsSpec: spec, unreadable: true,
      reason: stale ? 'obs' : 'other' };
  }
}

/** 一次扫多個檔案（逗號分隔） */
function resumesOf(spec) {
  return String(spec).split(',').map(s => s.trim()).filter(Boolean).map(f => resumeOf(f));
}

/** --all：把 runs/ 裡所有 checkpoint 加上 ai/trained.json 排好序丟進來 */
function discover(root = path.join(__dirname, '..')) {
  const out = [];
  const runs = path.join(root, 'runs');
  if (fs.existsSync(runs)) {
    for (const f of fs.readdirSync(runs)) {
      if (!/\.json$/i.test(f)) continue;
      const full = path.join(runs, f);
      try {
        const j = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (j.kind === Checkpoint.KIND) out.push(full);
      } catch (e) { /* 半寫的檔案、log 之類的，跳過就好 */ }
    }
  }
  const trained = path.join(root, 'ai', 'trained.json');
  if (fs.existsSync(trained)) {
    try {
      const j = JSON.parse(fs.readFileSync(trained, 'utf8'));
      if (j.kind === GENOME_KIND || j.kind === SEED_KIND) out.push(trained);
    } catch (e) { /* 同上 */ }
  }
  const seed = path.join(root, 'runs', 'seed.json');
  if (fs.existsSync(seed)) out.unshift(seed);
  return out;
}

/* ── 考績：真的跟規則 AI 打一場，把結果寫回檔案 ────────── */

/**
 * @param {string} file checkpoint 或匯出檔
 * @param {object} o { stages:[..], seedsPerStage, maxFrames }
 */
function verify(file, o = {}) {
  const { Arena } = require('./arena');
  const abs = path.resolve(file);
  const j = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const champGenome = j.kind === Checkpoint.KIND ? (j.champion && j.champion.genome) : j.genome;
  if (!champGenome) throw new Error(`ledger --verify：${file} 裡面沒有冠軍基因組`);
  if (j.obsSpec && j.obsSpec.version !== Observation.OBS_SPEC.version)
    throw new Error(`ledger --verify：${file} 的觀測規格 v${j.obsSpec.version} 與現行不符，拒絕考核`);

  const cfg = j.kind === Checkpoint.KIND ? (j.config || {}) : (j.provenance && j.provenance.config) || {};
  const stages = o.stages || cfg.stages || [0, 1, 2];
  const per = o.seedsPerStage || 4;
  const arena = new Arena({ maxFrames: o.maxFrames || cfg.maxFrames || 2400 });
  const pol = { kind: 'policy', policy: Genome.fromJSON(champGenome).toPolicy() };
  // 考績也要坐在自己的席位上：v5 那種「藍紅各打一輪取平均」在 v6 沒有意義 ——
  // 防守模型被塞進藍席打進攻，輸了不是它練壞，是考錯科。
  const role = o.role || j.role || cfg.role || null;
  const seat = role === 'defense' ? 1 : 0;

  let win = 0, tot = 0, dec = 0, fld = 0, blk = 0, shots = 0, kills = 0, capped = 0, frames = 0;
  const ends = {};
  for (const stage of stages) {
    for (let s = 0; s < per; s++) {
      // 這把 salt 只出現在考核，訓練時的評估用的是另一把（0x5eed）——
      // 否則「勝率」量的是背題，不是會打。
      const seed = hashSeed(ASSESS_SEED_SALT, stage, s);
      const r = arena.run({
        stage, seed,
        blue: seat === 0 ? pol : 'rule',
        red: seat === 0 ? 'rule' : pol,
      });
      const t = r.teams[seat];
      win += (r.winner === seat ? 1 : 0);
      ends[r.end || '?'] = (ends[r.end || '?'] || 0) + 1;
      dec += t.framesDecided; fld += t.fieldFrames; blk += t.blockedFrames || 0;
      shots += t.shots; kills += t.kills; frames += r.frames;
      if (r.capped) capped++;
      tot += 1;
    }
  }
  const rec = {
    at: new Date().toISOString(),
    role, seat,
    stages, gamesPerSeat: per, games: tot, opponent: 'rule',
    seedSalt: '0x' + ASSESS_SEED_SALT.toString(16),
    policyWins: win, winRate: win / tot,
    ends,
    controlShare: fld ? dec / fld : null,
    blockedShare: fld ? blk / fld : null,
    shots, kills, shotsPerKill: kills ? shots / kills : null,
    avgFrames: frames / tot, capped,
    genomeFingerprint: fingerprint(champGenome),
    obsSpec: Observation.OBS_SPEC,
  };
  const list = Array.isArray(j.assessments) ? j.assessments : [];
  list.push(rec);
  j.assessments = list;

  const written = writeBack(abs, j);
  return { record: rec, written, assessments: list.length };
}

/** 把物件原樣寫回檔案；匯出檔要連同 .js 一起刷新，否則瀏覽器拿到的是舊的一份 */
function writeBack(abs, j) {
  const tmp = abs + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(j, null, j.kind === Checkpoint.KIND ? 1 : 0));
  fs.renameSync(tmp, abs);
  const out = [abs];
  const jsPath = abs.replace(/\.json$/i, '.js');
  if (j.kind === GENOME_KIND && fs.existsSync(jsPath)) {
    fs.writeFileSync(jsPath, genomeScript(j));
    out.push(jsPath);
  }
  return out;
}

/** 給瀏覽器用的「賦值檔」內容（file:// 不能 fetch，只能 <script src>） */
function genomeScript(payload) {
  // 兩個角色各寫一份快照（trained-attack.js／trained-defense.js），但兩份都賦值
  // 同一個 window.TRAINED_GENOME —— 同一頁裡後面載入的那份會蓋掉前面的。
  // 所以額外掛一個角色別名：觀戰頁讀別名就能同時握住兩族的網路，
  // TRAINED_GENOME 保留給舊頁面（讀「最後載入的那一份」，行為跟以前一樣）。
  const alias = payload.role === 'attack' ? 'TRAINED_GENOME_ATTACK'
    : payload.role === 'defense' ? 'TRAINED_GENOME_DEFENSE' : null;
  return `/* 由 node ai/evolve.js --export 產生，請勿手改。\n` +
    `   ${payload.roleLabel ? `【${payload.roleLabel}模型】` : ''}第 ${payload.generation} 代｜` +
    `最佳適應度 ${Number(payload.fitness).toFixed(2)}｜${payload.episodes} 場` +
    `｜${(payload.provenance && payload.provenance.sessions || []).length} 段訓練｜算分 v${payload.scoringVersion ?? '?'} */\n` +
    `window.TRAINED_GENOME = ${JSON.stringify(payload)};\n` +
    (alias ? `window.${alias} = window.TRAINED_GENOME;\n` : '');
}

/** --export 與 ledger 共用：寫 .json + .js，兩份內容一定一致 */
function writeGenome(payload, to) {
  const jsPath = /\.json$/i.test(to) ? to.replace(/\.json$/i, '.js') : to + '.js';
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const body = JSON.stringify(payload);
  fs.writeFileSync(to, body);
  fs.writeFileSync(jsPath, genomeScript(payload));
  return [to, jsPath];
}

/* ── 拿一份基因組真的打一局，把「這一局的分是怎麼湊出來的」列出來 ── */

/** 任何一種存檔 → 冠軍/種子 genome（要跑 arena 時用） */
function genomeOf(file) {
  const j = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const g = j.kind === Checkpoint.KIND ? (j.champion && j.champion.genome) : j.genome;
  if (!g) throw new Error(`ledger: ${file} 裡面沒有基因組`);
  return { j, genome: g };
}

/**
 * 逐項拆解出自 ai/fitness.js 的同一支算分碼（explainFitness），
 * 所以網頁上列的「這一項貢獻多少」跟演化時實際用的分數一定對得上。
 * @param {string} file
 * @param {object} o { stage, maxFrames }
 */
function breakdownOf(file, o = {}) {
  const { Arena } = require('./arena');
  const { j, genome } = genomeOf(file);
  const cfg = j.kind === Checkpoint.KIND ? (j.config || {}) : (j.provenance && j.provenance.config) || {};
  const stage = o.stage !== undefined ? o.stage : ((cfg.stages && cfg.stages[0]) || 0);
  const maxFrames = o.maxFrames || cfg.maxFrames || 2400;
  // 拆解要落在「這個角色自己的席位」上：v6 之後把防守模型塞進藍席去拆，
  // 列出來的會是一套用錯尺的數字（它根本沒有 breach 那一項）。
  const role = o.role || j.role || cfg.role || null;
  const seat = role === 'defense' ? 1 : 0;
  const arena = new Arena({ maxFrames });
  const seed = hashSeed(ASSESS_SEED_SALT, stage, 999);   // 考績那把，不是訓練時背過的那把
  const pol = { kind: 'policy', policy: Genome.fromJSON(genome).toPolicy() };
  const rep = arena.run({
    stage, seed,
    blue: seat === 0 ? pol : 'rule',
    red: seat === 0 ? 'rule' : pol,
  });
  const t = rep.teams[seat];
  const ex = explainFitness(t, rep, seat, { maxFrames, role });
  return {
    at: new Date().toISOString(),
    file: rel(file),
    role, roleLabel: role ? (ROLE_LABEL[role] || role) : null, seat,
    stage, seed, maxFrames,
    // 拆解是「現在」跑的，所以永遠是現行算分版本 —— 跟存檔裡那個 fitness
    // 可能不同版本，這正是履歷要標出來的地方。
    scoringVersion: SCORING_VERSION,
    winner: rep.winner === null ? '和局'
      : (rep.winner === seat ? '網路勝' : '對手（規則 AI）勝'),
    end: rep.end || null, endText: rep.endText || null,
    frames: rep.frames, capped: rep.capped,
    total: ex.total,
    items: ex.items.map(i => ({
      key: i.key, label: i.label, weight: i.weight, formula: i.formula,
      value: i.value, contribution: i.contribution, gate: i.gate, cap: i.cap,
    })),
    floors: ex.floors,
    stats: {
      fieldFrames: t.fieldFrames, kills: t.kills, deaths: t.deaths, shots: t.shots,
      damageDone: t.damageDone, blockedShare: ex.blockedShare, dominance: t.dominance,
      powerups: t.powerups, ownBaseAlive: t.ownBaseAlive, ownBaseCellsLost: t.ownBaseCellsLost,
      baseDefenseDamage: t.baseDefenseDamage || 0, baseDefenseKills: t.baseDefenseKills || 0,
      halfDefenseDamage: t.halfDefenseDamage || 0,
      supportFrames: t.supportFrames || 0,
      supportShare: t.fieldFrames ? (t.supportFrames || 0) / t.fieldFrames : 0,
      // v6 進攻／防守的過程計量：面板上「這一局的分是怎麼湊出來的」要能對上算式
      foeHalfFrames: t.foeHalfFrames || 0,
      foeHalfShare: t.fieldFrames ? (t.foeHalfFrames || 0) / t.fieldFrames : 0,
      foeBaseMinDist: t.foeBaseMinDist === undefined ? null : t.foeBaseMinDist,
      foeWallLost: t.foeWallLost || 0,
      // v11：拆牆依「開火那瞬間離敵鷹多遠」分堆（≤56px 算近）。舊快照沒這兩個欄位，
      // 一律退回 0 —— 顯示端會改拿 foeWallLost 並註明是舊口徑，不會憑空變出分堆數據。
      foeWallNear: t.foeWallNear || 0,
      foeWallFar: t.foeWallFar || 0,
      selfBaseShots: t.selfBaseShots || 0,
      // v7：使用者點名要記錄的兩件事 —— 近身敢不敢接戰、有沒有把自己家打爆。
      duelKills: t.duelKills || 0,
      duelFrames: t.duelFrames || 0,
      duelShare: t.fieldFrames ? (t.duelFrames || 0) / t.fieldFrames : 0,
      ownBaseKilledBySelf: !!t.ownBaseKilledBySelf,
      foeBaseOwnGoal: !!t.foeBaseOwnGoal,
      winByMerit: !!ex.winByMerit,
    },
  };
}

/** 文字版：這一局的逐項貢獻 */
function printBreakdown(b) {
  console.log(`\n   ▍實例拆解：${b.file}${b.roleLabel ? `（${b.roleLabel}模型，坐${b.seat === 0 ? '藍' : '紅'}席）` : ''}` +
    ` 在關卡 ${b.stage} 打一局（${b.frames} 幀，${b.winner}${b.endText ? `｜${b.endText}` : ''}）`);
  console.log(`     在場 ${b.stats.fieldFrames} 幀｜擊殺 ${b.stats.kills}｜陣亡 ${b.stats.deaths}｜` +
    `開火 ${b.stats.shots} 發（造成 ${b.stats.damageDone} hp）｜卡牆 ${(100 * b.stats.blockedShare).toFixed(0)}%` +
    `｜家門口攔截 ${b.stats.baseDefenseDamage} hp／${b.stats.baseDefenseKills} 殺｜` +
    `半場攔截 ${b.stats.halfDefenseDamage} hp｜` +
    `協同 ${(100 * (b.stats.supportShare || 0)).toFixed(1)}%`);
  // 角色專屬的過程計量：進攻看「有沒有真的壓進去」，防守看「攔了幾次」；
  // 這兩組數字是 v6 兩套標準的分歧點，不列出來就看不出分數是從哪兒來的。
  // v11 的拆牆分堆：近／遠才有計分意義（遠距離每格只算 0.25），
  // 但 v10 以前的快照只有 foeWallLost，那種就標明是舊口徑、不假裝有分堆。
  const wall = (b.stats.foeWallNear || b.stats.foeWallFar)
    ? `拆掉敵牆 近 ${b.stats.foeWallNear}／遠 ${b.stats.foeWallFar} 格（遠每格算 ${WALL_FAR_SHARE}，近滿 ${WALL_CELL_CAP} 格才打頂）`
    : `拆掉敵牆 ${b.stats.foeWallLost} 格（舊快照：未分近／遠）`;
  console.log(`     ${b.role === 'defense' ? '消極門檻用的攔截總量' : '推進'}：` +
    (b.role === 'defense'
      ? `家門口 ${b.stats.baseDefenseDamage} ＋ 半場 ${b.stats.halfDefenseDamage} ＝ ` +
        `${b.stats.baseDefenseDamage + b.stats.halfDefenseDamage} hp（6 hp 才算滿）`
      : `敵半場 ${(100 * (b.stats.foeHalfShare || 0)).toFixed(0)}% 的在場幀｜` +
        `離敵鷹最近 ${b.stats.foeBaseMinDist === null ? '—（無人在場）' : `${b.stats.foeBaseMinDist.toFixed(0)} px`}｜` +
        wall) +
    `｜打到自己要塞的開火 ${b.stats.selfBaseShots} 發`);
  // v7 的兩項新記錄單獨一行：它們是使用者直接點名的行為準則，
  // 混在「推進／攔截」那行會被當成普通統計數字掃過去。
  console.log(`     貼身殲滅 ${b.stats.duelKills} 台（貼身 ${(100 * (b.stats.duelShare || 0)).toFixed(0)}% 的在場幀）` +
    `｜自家老鷹被自己人打爆：${b.stats.ownBaseKilledBySelf ? '有（本局歸 0 分）' : '沒有'}` +
    (b.stats.foeBaseOwnGoal ? '｜對手自破 → 這局的贏不算戰功' : ''));
  const sign = v => (v >= 0 ? '+' : '') + v.toFixed(1);
  const width = Math.max(...b.items.map(i => i.label.length));
  for (const i of b.items)
    console.log(`     ${sign(i.contribution).padStart(7)}  ${i.label.padEnd(width, ' ')}｜${i.value.toFixed ? i.value.toFixed(3) : i.value} × ${i.weight}`);
  for (const f of b.floors)
    console.log(`     地板：${f.label}（${f.from.toFixed(1)} → ${f.to.toFixed(1)}）`);
  console.log(`     合計 ${b.total.toFixed(2)}`);
}

/* ── 給網頁的資料 ───────────────────────────────────────── */

function writeData(files, out, o = {}) {
  const data = {
    kind: LEDGER_KIND,
    generatedAt: new Date().toISOString(),
    obsSpec: Observation.OBS_SPEC,
    rubric: rubric(),
    resumes: files.map(f => {
      const r = safeResume(f);
      if (r.unreadable) return r;
      if (o.breakdown !== false) {
        try { r.breakdown = breakdownOf(f, { stage: o.stage }); }
        catch (e) { r.breakdownError = String(e.message || e); }
      }
      return r;
    }),
  };
  fs.writeFileSync(out,
    `/* 由 node ai/ledger.js --html 產生，請勿手改（資料內容代表產生當下的存檔狀態）。\n` +
    `   來源：\n${files.map(f => ` *   ${f.replace(/\\/g, '/')}`).join('\n')}\n */\n` +
    `window.TANK_LEDGER = ${JSON.stringify(data)};\n`);
  return { out, count: data.resumes.length };
}

/* ── 文字版履歷 ─────────────────────────────────────────── */

function print(r) {
  const c = r.counts, id = r.identity, L = r.lineage;
  console.log(`\n━━ 訓練履歷：${r.label}`);
  console.log(`   檔案 ${r.file}`);
  // 角色必須出現在最上面：v6 起兩個模型的分數不是同一把尺，
  // 先讓人看見「這是進攻模型」，才不會拿 151 分去比 91 分。
  if (r.role) console.log(`   角色 ${r.roleLabel || r.role}｜${r.role === 'defense' ? '紅席：守住老鷹，30 秒沒被打通就算贏' : '藍席：只有摧毀紅隊老鷹才算贏'}`);
  console.log(`   血緣 ${L.originLabel}`);
  console.log(`   網路 ${id.structure ? `${id.structure.nodes} 節點／${id.structure.links} 邊（啟用 ${id.structure.enabledLinks}）` : '—'}` +
    `｜指紋 ${id.fingerprint}｜觀測 v${r.obsSpec ? r.obsSpec.version : '?'}（${r.obsSpec ? r.obsSpec.dim : '?'} 欄）`);

  console.log(`\n   ▍訓練次數`);
  console.log(`     工作階段 ${c.sessions} 段` +
    (c.sessionsInferred ? '（⚠ 這是一份舊存檔，沒有逐段紀錄，下面是從存檔狀態推導的）' : '') +
    `｜累計演化 ${c.generations} 代｜累計 ${c.episodes} 場`);
  if (c.wallSec) console.log(`     累計時數 ${fmtDur(c.wallSec)}${c.perGeneration ? `｜每代 ${c.perGeneration} 場` : ''}`);
  for (const st of c.sessionList) {
    const src = st.source === 'resume' ? `接續 ${st.from || st.file || ''}`
      : st.source === 'seed-from' ? `從模仿種子 ${st.from} 重開`
      : st.source === 'split' ? `由舊單模型冠軍拆族（${st.from || (st.split && st.split.from) || ''}）`
      : st.source === 'imitation' ? '收老師示範（模仿學習）'
      : st.source === 'cold' ? '冷開機（隨機權重）' : (st.source || '—');
    console.log(`     ${String(st.index).padStart(2)}. ${st.startedAt ? st.startedAt.slice(0, 19).replace('T', ' ') : '(開始時間未知)'} → ` +
      `${st.finishedAt ? st.finishedAt.slice(0, 19).replace('T', ' ') : '(未記)'}` +
      `｜${src}` +
      (st.source === 'imitation'
        ? `｜${st.games} 局、${st.rawFrames} 個決定幀 → ${st.samples} 筆樣本`
        : `｜${st.generations} 代 ${st.episodes} 場`) +
      `${st.elapsedSec ? `｜${fmtDur(st.elapsedSec)}` : ''}` +
      `${st.inferred ? '｜推導' : ''}`);
    if (st.best !== undefined && st.best !== null)
      console.log(`         本段末了 best ${Number(st.best).toFixed(2)}／mean ` +
        `${st.mean === null || st.mean === undefined ? '—' : Number(st.mean).toFixed(2)}` +
        `｜第 ${st.fromGeneration || 0} 代 → 第 ${st.toGeneration} 代`);
    // 換圖不是「變笨」：新地圖天生分數不同。要有這句話，否則
    // 曲線在接縫處掉下去會非常像退步。
    if (st.source === 'split' && st.split) {
      const sp = st.split;
      console.log(`         由 ${sp.from} 第 ${sp.fromGeneration} 代冠軍拆出` +
        `（舊算分 v${sp.fromScoringVersion ?? '?'} 下 ${Number(sp.fromFitness).toFixed(2)} 分，` +
        `${sp.games || 0} 場重評成現行 v${SCORING_VERSION} 的 ${Number(st.best).toFixed(2)} 分）` +
        `｜這一族從這裡起算，前面的代數不屬於它`);
    }
    if (st.examBefore && JSON.stringify(st.examBefore) !== JSON.stringify(st.stages))
      console.log(`         考題換圖 ${JSON.stringify(st.examBefore)} → ${JSON.stringify(st.stages)}` +
        `｜這一段前後的 best／mean 不是同一把尺`);
    // 交替演化每輪換對手＝每輪換尺。不講這句話，「分數掉了一截」看起來像退步，
    // 實際上比較對象換成了更強的那一隻。
    if (st.opponentBefore && st.opponentRuler && st.opponentBefore !== st.opponentRuler)
      console.log(`         對手換了 ${st.opponentBefore} → ${st.opponentRulerLabel || st.opponentRuler}` +
        `｜本段分數按新對手量，跟前一段不可直接比`);
    if (st.championRescore) {
      const rs = st.championRescore;
      const parts = [];
      const why = rs.reasons || (rs.reason ? rs.reason.split('+') : []);
      if (why.includes('exam')) parts.push('換考題');
      if (why.includes('opponent')) parts.push('換對手');
      if (why.includes('scoring')) parts.push(`算分 v${rs.fromVersion ?? '?'} → v${rs.toVersion}`);
      console.log(`         舊冠軍重評 ${Number(rs.before).toFixed(2)} → ` +
        `${Number(rs.after).toFixed(2)}（${rs.games} 場校準，不計訓練場數` +
        `${parts.length ? `；${parts.join('＋')}` : ''}）`);
    }
  }
  // 模仿種子還沒被評過「冠軍」，這條對它沒有意義（會印出第 0 代那種怪話）
  if (id.championGeneration && id.generation) {
    console.log(`     歷史冠軍在第 ${id.championGeneration} 代刷新` +
      (c.stagnationGens !== null && c.stagnationGens !== undefined
        ? `，之後 ${c.stagnationGens} 代沒有再進步` : ''));
    if (c.examChanges && c.examChanges.length)
      console.log(`     ⚠ 中間換過 ${c.examChanges.length} 次考題：停滯代數橫跨不同地圖組，不能整段當成同一把尺`);
    if (c.scoringChanges && c.scoringChanges.length) {
      const vs = [...new Set(c.scoringChanges.map(x => x.scoringVersion))].join('／');
      console.log(`     ⚠ ${c.scoringChanges.length} 段用舊版算分（v${vs}）：與現行 v${SCORING_VERSION} 不可直接比，停滯代數要分段看`);
    }
    // 換對手＝換尺，而且是「每段都換」的那種：停滯代數跨了幾次換對手，
    // 就等於橫跨好幾把尺，數字本身不能當成「多久沒進步」。
    if (c.rulerChanges && c.rulerChanges.length)
      console.log(`     ⚠ 中間換過 ${c.rulerChanges.length} 次對手（交替演化必然大於 0）：` +
        `對面每輪都在變強，分數往下走可能是尺變嚴，不是本族變笨`);
  }
  if (r.championLog && r.championLog.length) {
    console.log(`     冠軍刷新史：` + r.championLog.map(x => `第 ${x.generation} 代 ${x.fitness.toFixed(1)}`).join(' → '));
  }
  // 冠軍那把尺要講得出來：91.6 分「打規則 AI」跟 60 分「打對面第 30 代冠軍」
  // 是兩件事，使用者拿它跟本代曲線比之前需要先知道。
  if (r.championMeasuredAgainst)
    console.log(`     冠軍分數是打誰打出來的：${r.championMeasuredAgainst}`);
  // 模仿忠實度是「跟老師的動作像不像」，不是 arena 算出來的分，
  // 掛上算分版本只會讓人以為它也受 v1/v2 影響。
  console.log(`     ${id.fitnessKind} ${id.fitness === null ? '—' : Number(id.fitness).toFixed(2)}` +
    (id.fitnessKind === '適應度'
      ? `（算分 v${r.scoring.version}${r.scoring.comparable ? '' : `｜⚠ ${r.scoring.note}`}）`
      : ''));

  if (r.config) {
    const k = r.config;
    const seats = k.seats || 1;
    console.log(`\n   ▍考題（訓練時用它被評分）`);
    console.log(`     地圖 ${JSON.stringify(k.stages || [])}｜每圖 ${k.seeds} 種子×${seats} 座位｜對手 ${k.opponent}` +
      (k.vs ? `（--vs ${k.vs}，對面的冠軍）` : '') +
      `｜族群 ${k.pop}｜幀上限 ${k.maxFrames}`);
    // 交替自我對弈時「對手會變強」，分數的含義跟著變：
    // 這句話要主動說，否則對手升級導致本代分數下降會被讀成退步。
    if (k.vs) console.log(`     ⚠ 交替演化：對面每輪也在訓練，同一分在前期跟後期不等於同一個實力`);
    if (k.opponentRulerLabel)
      console.log(`     最近這一段是打誰量的：${k.opponentRulerLabel}`);
    // 尺本身改過什麼要在這裡講一句：曲線在 v7→v8 那種接縫處跳一下，
    // 使用者需要知道「是戰場變了」還是「車變弱了」。
    console.log(`     現行尺：${SCORING_VERSION_NOTE}`);
  }

  if (r.assessments.length) {
    console.log(`\n   ▍考績（沒參與評估的新種子，實戰打規則 AI）`);
    for (const a of r.assessments) {
      console.log(`     ${a.at.slice(0, 19).replace('T', ' ')}` +
        `${a.role ? `｜${a.role === 'defense' ? '防守（紅席）' : '進攻（藍席）'}` : '｜舊版：兩座位都考'}` +
        `｜地圖 ${JSON.stringify(a.stages)}` +
        `｜勝 ${a.policyWins}/${a.games} = ${(100 * a.winRate).toFixed(0)}%` +
        `｜控制權 ${a.controlShare === null ? '—' : (100 * a.controlShare).toFixed(0) + '%'}` +
        `｜卡牆 ${a.blockedShare === null ? '—' : (100 * a.blockedShare).toFixed(1) + '%'}` +
        `｜每擊殺耗彈 ${a.shotsPerKill ? a.shotsPerKill.toFixed(1) : '—'}` +
        `｜打到上限 ${a.capped} 局`);
      // 勝負怎麼結束比勝率更能看出模型在幹嘛：進攻模型「全是 time」就是打不進去，
      // 防守模型「全是 breach」就是守不住。舊記錄沒有 end，就不硬编。
      if (a.ends) {
        const e = DEMO_END_ORDER.filter(k => a.ends[k])
          .map(k => `${DEMO_END_LABEL[k]} ${a.ends[k]}`);
        if (e.length) console.log(`         結束方式：${e.join('／')}`);
      }
    }
  } else {
    console.log(`\n   ▍考績：還沒有實戰記錄。跑 node ai/ledger.js --verify ${r.file}`);
  }

  // 有角色就只報那個角色的標準（兩套尺混在一起報，等於沒報）；
  // 舊存檔沒有角色，才退回「全部項次」並說明兩邊混算。
  const rub = r.rubric;
  const show = r.role && rub.roles ? [[r.roleLabel || r.role, rub.roles[r.role].terms]] : [['全部（舊版未分角色）', rub.terms]];
  for (const [name, terms] of show) {
    console.log(`\n   ▍評判標準・${name}（${terms.length} 項計分 ＋ ${rub.redFlags.length} 條紅旗，算分 v${rub.scoringVersion}）`);
    for (const t of terms)
      console.log(`     ${fmtWeight(t.weight)}  ${t.label.padEnd(12, ' ')}｜${t.formula}` +
        `${t.cap ? `（${t.cap}）` : ''}${t.gate ? `［${t.gate}］` : ''}`);
  }
  console.log(`     紅旗：${rub.redFlags.map(f => `${f.label}（${f.limit}）`).join('、')}`);
  console.log(`     協議：${rub.protocol.map(p => p.name).join('、')}`);
  if (rub.undocumented.length)
    console.log(`     ✗ 有權重沒寫進標準表：${rub.undocumented.join(',')} —— 展示出來的評判標準會少項，要補 ai/fitness.js 的 TERMS`);
}

/* ── CLI ────────────────────────────────────────────────── */

const HELP = `
tank-battle 訓練履歷（訓練次數 + 評判標準）

  node ai/ledger.js --ckpt runs/warm.json              # 文字版履歷
  node ai/ledger.js --ckpt a.json,b.json               # 多份一次（比對用）
  node ai/ledger.js --all                              # 掃 runs/ 與 ai/trained.json
  node ai/ledger.js --verify runs/warm.json            # 跑一輪實戰考績並寫回檔案
  node ai/ledger.js --ckpt runs/warm.json --breakdown   # 順帶拆一局給你看各項貢獻
  node ai/ledger.js --html                             # 寫 ai/ledger-data.js 給 ai/ledger.html
  node ai/ledger.js --rubric                           # 只印評判標準（算分那支碼讀出來的）

  --stages 0,1,2      考績要用哪些地圖（預設沿用該檔的訓練考題）
  --stage N           --breakdown 要用哪張地圖（預設考題第一張）
  --seeds N           考績每張地圖幾個新種子（預設 4）
  --role attack|defense
                      考績要用哪個角色（預設讀該檔存的角色；舊檔沒有角色就用進攻）
  --out FILE          --html 的輸出（預設 ai/ledger-data.js）
  --json              輸出機器可讀 JSON`;

/** 選項值容許中英／縮寫；不認得就直接報錯，不要默默當成進攻。
 *  ⚠ 別名表正簡都收（進攻／进攻、攻擊／攻击、防禦／防御）：這裡不是專案文字，
 *     是「使用者可能這樣打」的入口，全改成繁體會把簡別名弄丟。 */
function roleArg(v) {
  const s = String(v || '').toLowerCase();
  if (/^(attack|att|a|進攻|进攻|攻擊|攻击|攻擊方|攻击方)$/.test(s)) return 'attack';
  if (/^(defense|defence|def|d|防守|防禦|防御)$/.test(s)) return 'defense';
  throw new Error(`--role：看不懂「${v}」，要用 attack（進攻／藍席）或 defense（防守／紅席）`);
}

function parseArgs(argv) {
  const o = { ckpt: null, all: false, verify: null, html: false, rubric: false, json: false,
    breakdown: false, stages: null, stage: null, seeds: null, role: null,
    out: path.join(__dirname, 'ledger-data.js') };
  // 用「while + 手動 i」而不是 for：吃到選項值時要能把那一格一起跳掉，
  // 否則下一個迴圈會把 runs/warm.json 當成選項名而報 unknown arg。
  let i = 0;
  const nx = () => argv[++i];
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--ckpt') o.ckpt = nx();
    else if (a === '--all') o.all = true;
    else if (a === '--verify') o.verify = nx();
    else if (a === '--html') o.html = true;
    else if (a === '--rubric') o.rubric = true;
    else if (a === '--json') o.json = true;
    else if (a === '--breakdown') o.breakdown = true;
    else if (a === '--stages') o.stages = nx().split(',').map(s => Number(s.trim())).filter(Number.isFinite);
    else if (a === '--stage') o.stage = Number(nx());
    else if (a === '--seeds') o.seeds = Number(nx());
    else if (a === '--role') o.role = roleArg(nx());
    else if (a === '--out') o.out = nx();
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown arg: ${a}`);
    i++;
  }
  return o;
}

function main(argv) {
  const o = parseArgs(argv);
  if (o.help) { console.log(HELP); return 0; }

  if (o.rubric) {
    const r = rubric();
    console.log(`評判標準（讀自 ai/fitness.js 的 TERMS 與 ai/telemetry.js 的 RULES，就是算分那支碼）`);
    // v6：進攻（藍席）跟防守（紅席）是兩把不同的尺，項次、權重、算式都可能不一樣。
    for (const key of ['attack', 'defense']) {
      const set = r.roles[key];
      console.log(`\n【${set.label}・計分項 ${set.terms.length}】`);
      for (const t of set.terms)
        console.log(`  ${fmtWeight(t.weight)}  ${t.label.padEnd(14, ' ')} ${t.formula}` +
          `${t.cap ? `（${t.cap}）` : ''}${t.gate ? `［${t.gate}］` : ''}`);
    }
    console.log(`\n【紅旗 ${r.redFlags.length}】`);
    for (const f of r.redFlags) console.log(`  ${f.label}：門檻 ${f.limit}\n    為什麼：${f.why}\n    修法：${f.fix}`);
    console.log(`\n【評量協議 ${r.protocol.length}】`);
    for (const p of r.protocol) console.log(`  ${p.name}：${p.rule}\n    實作：${p.where}`);
    if (r.undocumented.length) console.log(`\n✗ 有權重沒進標準表：${r.undocumented.join(',')}`);
    return 0;
  }

  if (o.verify) {
    const v = verify(o.verify, { stages: o.stages, seedsPerStage: o.seeds, role: o.role });
    const a = v.record;
    const seat = a.role ? (a.role === 'defense' ? '紅席（防守）' : '藍席（進攻）') : '兩座位都考';
    console.log(`考績（${seat}｜地圖 ${JSON.stringify(a.stages)}、每圖 ${a.gamesPerSeat} 個新種子 = ${a.games} 局，對手規則 AI）`);
    console.log(`  勝率 ${a.policyWins}/${a.games} = ${(100 * a.winRate).toFixed(0)}%` +
      `｜控制權 ${(100 * a.controlShare).toFixed(0)}%｜卡牆 ${(100 * a.blockedShare).toFixed(1)}%` +
      `｜每擊殺耗彈 ${a.shotsPerKill ? a.shotsPerKill.toFixed(1) : '—'}｜打到上限 ${a.capped} 局`);
    if (a.ends) console.log(`  結束方式：${DEMO_END_ORDER.filter(k => a.ends[k]).map(k => `${DEMO_END_LABEL[k]} ${a.ends[k]}`).join('／') || '—'}`);
    console.log(`  已寫進 ${v.written.join(' + ')}（第 ${v.assessments} 次考績）`);
    return 0;
  }

  const files = o.ckpt ? String(o.ckpt).split(',').map(s => s.trim()).filter(Boolean)
    : o.all || o.html ? discover() : null;
  if (!files || !files.length) { console.log(HELP); return 1; }

  if (o.html) {
    const w = writeData(files, o.out, { stage: o.stage });
    console.log(`履歷資料 → ${w.out}（${w.count} 份基因組，每份附一局逐項拆解）`);
    console.log(`打開 ai/ledger.html 即可看到訓練次數與評判標準（file:// 直接開，不需要伺服器）`);
    return 0;
  }

  const list = files.map(f => safeResume(f));
  const bdStage = o.stage === null ? undefined : o.stage;
  if (o.breakdown) for (const f of files) {
    try { printBreakdown(breakdownOf(f, { stage: bdStage })); }
    catch (e) { console.log(`\n   ▍實例拆解 ${f} 失敗：${e.message}`); }
  }
  if (o.json) {
    const ok = list.find(r => !r.unreadable);
    const payload = { kind: LEDGER_KIND, obsSpec: Observation.OBS_SPEC, rubric: ok ? ok.rubric : rubric(), resumes: list };
    if (o.breakdown) payload.breakdowns = files.map(f => {
      try { return breakdownOf(f, { stage: bdStage }); }
      catch (e) { return { file: f.replace(/\\/g, '/'), error: String(e.message || e) }; }
    });
    console.log(JSON.stringify(payload, null, 1));
  } else for (const r of list) {
    if (r.unreadable) {
      console.log(`\n━━ ${r.reason === 'obs' ? '舊觀測規格，作廢' : '讀不了'}，跳過：${r.file}\n   ${r.error}`);
      continue;
    }
    print(r);
  }
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (e) {
    if (/unknown arg/.test(e.message)) { console.log(HELP); console.error('✗ ' + e.message); }
    else console.error('✗ ' + e.message);
    process.exitCode = 1;
  }
}

module.exports = {
  fingerprint, rubric, protocol, sessionsOf, resumeOf, resumesOf, safeResume, discover, rel,
  genomeOf, breakdownOf, printBreakdown,
  verify, writeBack, writeGenome, writeData, print, main, parseArgs, fmtWeight,
  LEDGER_KIND, GENOME_KIND, SEED_KIND, TRAIN_SEED_SALT, ASSESS_SEED_SALT, fmtDur, isoAgo,
};
