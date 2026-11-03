/* ai/balance.js — 攻守平衡度探針（唯讀量測，不改規則、不寫存檔）
   ═══════════════════════════════════════════════════════════
   為什麼要這支：使用者問的是「藍（進攻）與紅（防守）起步的平衡度能不能更接近」。
   這個問題不能用直覺回答，因為失衡有三種完全不同的來源，混在一起看就永遠調不對：

     ① 計分面：兩套標準在「一樣程度的表現」下給不一樣的分數
        → 兩族各自的階梯高度不同，代數同樣漲 100 代，一邊是真進步、一邊是漲尺。
     ② 勝負面：模型進步換來的「贏」的比率不一樣
        → 邊際貢獻不同等時，交替演化（--vs 對方的冠軍）會有一直壓著另一邊。
     ③ 取樣面：一項獎勵多久才發一次（breach 是稀有事件，holdWin 是預設結果）
        → 稀有事件要更多考題才選得準；考題固定 8 場時，進攻族的排序幾乎是噪音。

   所以這裡跑的是一個「技能矩陣」而不是單一對打：
     rand·rand  兩邊都隨機按鍵 —— 零技能的起點線（① 最乾淨的測量：幾何點對稱、
                兩隊一樣爛，分數卻不一樣高時，那個差就是尺的偏置，不是實力差）
     rule·rule  兩邊都是規則 AI —— 同技能基準線（也是 measure-breach.js 那組數字的來源）
     atk·rule   只有藍隊换上進攻模型 —— 進攻族的邊際貢獻
     rule·def   只有紅隊换上防守模型 —— 防守族的邊際貢獻
     atk·def    兩族冠軍對打 —— 訓練場現在實際看到的局面

   ⚠ 這支程式刻意唯讀：
     · 不寫 runs/*.json、不匯出快照、不碰 live-data —— 全自動訓練正在跑，
       那些檔案是它的產物，探針沒有資格動。
     · 不 import 任何「自己另算一套」的計量：分數一律走 ai/fitness.js 的 scoreOf，
       對局一律走 ai/arena.js 的 run()，基因組一律走 ai/evolve.js 的 loadOpponent()。
       訓練怎麼算、這裡就怎麼算，否則報出來的平衡度跟訓練場看到的不是同一件事。

   跑法：
     node ai/balance.js                         # 8 張隨機地圖 × 3 種子 × 5 個局面
     node ai/balance.js --maps 12 --seeds 2     # 換地圖覆蓋率（局數不變）
     node ai/balance.js --json runs/balance.json # 留一份資料給報告/網頁
     node ai/balance.js --cell atk·def          # 只跑某一個局面
     node ai/balance.js --mode ladder           # 技能階梯（要多少實力才脫離 0 分地板）
     node ai/balance.js --mode ceiling          # 只算尺的上限，不跑對局（零 CPU 競爭）
   研究報告：BALANCE-RESEARCH.md
   ═══════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const { Arena } = require('./arena');
const { scoreOf, TERMS, termsFor, weightOf, ROLES, ROLE_LABEL, SCORING_VERSION, HALF_FIELD_PX } = require('./fitness');
const { loadOpponent } = require('./evolve');
const { mulberry32 } = require('./rng');

const ROOT = path.resolve(__dirname, '..');
const SNAP = {
  attack: path.join(ROOT, 'ai', 'trained-attack.json'),
  defense: path.join(ROOT, 'ai', 'trained-defense.json'),
};

/* 逐項的歸組：這一項到底在量「本業」還是量「通用戰鬥力」。
   objective＝勝負本身／process＝該角色的推進或攔截痕跡／
   combat＝兩套標準都留的通用交戰項／discipline＝紀律負分。
   ⚠ 這組標籤只用於「分數是從哪來的」這件事後分析，不影響任何計分。 */
const GROUP = {
  breach: 'objective', timeoutFail: 'objective', holdWin: 'objective', holdGate: 'objective',
  ownBaseAlive: 'objective', speed: 'objective',
  foeHalf: 'process', penetration: 'process', foeWall: 'process',
  // v10 的三項本業占比：探針的「本業推進占比」驗收的就是它們（目標 ≥20%）
  besiege: 'process', denial: 'process',
  defense: 'process', halfDefense: 'process',
  teamwork: 'combat', killPer1k: 'combat', duelKill: 'combat', damagePer1k: 'combat',
  accuracy: 'combat', powerup: 'combat', firepowerUp: 'combat', death: 'combat',
  stalemate: 'discipline', ownBaseCellLost: 'discipline', selfBaseShot: 'discipline',
  ownEagleBySelf: 'discipline', wallPin: 'discipline', monotony: 'discipline', spray: 'discipline',
};
const GROUP_LABEL = { objective: '勝負', process: '本業推進', combat: '通用交戰', discipline: '紀律' };

const CELLS = [
  { key: 'rand·rand', blue: 'random', red: 'random', label: '兩邊隨機按鍵（零技能起點）' },
  { key: 'rule·rule', blue: 'rule', red: 'rule', label: '兩邊規則 AI（同技能基準線）' },
  { key: 'atk·rule', blue: 'attack', red: 'rule', label: '只有藍隊换上進攻模型' },
  { key: 'rule·def', blue: 'rule', red: 'defense', label: '只有紅隊换上防守模型' },
  { key: 'atk·def', blue: 'attack', red: 'defense', label: '兩族冠軍對打（訓練場現況）' },
];

/* ── 小統計工具 ─────────────────────────────────────────── */
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))); };
const q = (a, p) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const pct = x => (100 * x).toFixed(1) + '%';
const num = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(d));
const pad = (s, w) => String(s).padEnd(w);
const padL = (s, w) => String(s).padStart(w);

/** 一個數組 → 一行可讀的分佈摘要 */
function dist(a, d = 2) {
  if (!a.length) return '—';
  return `中位 ${num(q(a, 0.5), d)}、均值 ${num(mean(a), d)}、` +
    `p10 ${num(q(a, 0.10), d)}、p90 ${num(q(a, 0.90), d)}、σ ${num(sd(a), d)}`;
}

/* ── CLI ────────────────────────────────────────────────── */
function parseArgs(argv) {
  const o = { maps: 8, seeds: 3, stageBase: 0, json: null, cell: null, mode: 'matrix', terms: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], nx = () => argv[++i];
    if (a === '--maps') o.maps = Number(nx());
    else if (a === '--seeds') o.seeds = Number(nx());
    else if (a === '--stage') o.stageBase = Number(nx());
    else if (a === '--cell') o.cell = nx();
    else if (a === '--mode') o.mode = nx();
    else if (a === '--terms') o.terms = true;
    else if (a === '--json') o.json = path.resolve(nx());
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`balance: 不認識的參數 ${a}`);
  }
  if (!Number.isInteger(o.maps) || o.maps < 1) throw new Error('--maps 要是正整數');
  if (!Number.isInteger(o.seeds) || o.seeds < 1) throw new Error('--seeds 要是正整數');
  if (o.mode !== 'matrix' && o.mode !== 'ladder' && o.mode !== 'ceiling')
    throw new Error(`--mode：${o.mode} 不是模式（matrix／ladder／ceiling）`);
  if (o.cell && !CELLS.some(c => c.key === o.cell))
    throw new Error(`--cell：${o.cell} 不是局面（可選 ${CELLS.map(c => c.key).join('／')}）`);
  if (o.terms && o.mode !== 'ladder')
    throw new Error('--terms：只有 --mode ladder 有逐項分解可看（階梯才需要問「分數差在哪一項」）');
  return o;
}

const HELP = `node ai/balance.js [--mode matrix] [--maps 8] [--seeds 3] [--stage 0] [--cell atk·def] [--terms] [--json FILE]

  探針只讀：不改規則、不寫 checkpoint、不匯出快照，跟訓練同時跑不會互相踩到寫檔。
  --mode matrix  五個局面（rand·rand／rule·rule／atk·rule／rule·def／atk·def）的技能矩陣，
                 看「同技能不同分」與「模型邊際貢獻」。
  --mode ladder  技能階梯：把一隊的控制權依機率 p 在「規則 AI」與「隨機亂按」之間混合，
                 量兩個角色各自要多少實力才脫離 0 分地板 —— 那才是「起步的平衡度」。
  --mode ceiling 天花板分解：不打對局，把「每項都打滿」的合成成績餵進同一支 scoreOf，
                 看兩套尺各自的上限、以及「只打仗不做本業」能拿到其中多少。
  --terms        （ladder 專用）每格再附「逐項貢獻」與關鍵計量，並在結尾印 p 首尾的變化量。
                 階梯出現反向（愈不會打的反而分愈高）時，這一列才說得出分數從哪裡來的。
  地圖：從 --stage 起算連續 --maps 張隨機地形（每張都對兩隊點對稱）。`;

/* ── 一局 → 一筆樣本 ─────────────────────────────────────── */
function sampleGame(arena, cell, stage, seed) {
  const R = arena.R;
  const rep = arena.run({ stage, seed, blue: cell.blue, red: cell.red });
  const maxFrames = 2400;                       // 與 evaluatePolicy 同一把尺
  const rows = [0, 1].map(id => scoreOf(rep.teams[id], rep, id, {
    role: id === 0 ? ROLES.ATTACK : ROLES.DEFENSE, maxFrames,
  }));
  const conv = id => {
    const s = rep.teams[id];
    const m = new Map(rows[id].rows.map(r => [r.key, r.contribution]));
    const field = Math.max(1, s.fieldFrames);
    return {
      score: rows[id].final, sum: rows[id].sum,
      won: rep.winner === id,
      contrib: m,
      foeHalfShare: (s.foeHalfFrames || 0) / field,
      engageShare: (s.duelFrames || 0) / field,
      blockedShare: (s.blockedFrames || 0) / field,
      abstainShare: Math.max(0, 1 - (s.framesDecided || 0) / field),
      penetration: s.foeBaseMinDist,
      interceptions: (s.baseDefenseDamage || 0) + (s.halfDefenseDamage || 0),
      kills: s.kills, deaths: s.deaths, duelKills: s.duelKills || 0,
      shots: s.shots, damageDone: s.damageDone,
      ownWallLost: s.ownBaseCellsLost || 0, foeWallLost: s.foeWallLost || 0,
      // v11 的尺要看「在哪裡開的槍」，所以探針要把 near／far 分開印。
      // 只印總數的話，前後兩次快照會看到一樣的拆牆格數、卻不一樣的分數，
      // 那種「分數動了但過程沒動」最難解释。
      foeWallNear: s.foeWallNear || 0, foeWallFar: s.foeWallFar || 0,
      selfShots: s.selfBaseShots || 0,
      ownGoal: !!s.ownBaseKilledBySelf, foeOwnGoal: !!s.foeBaseOwnGoal,
      poolLeft: s.poolLeft, survivors: s.survivors,
      fieldFrames: s.fieldFrames,
    };
  };
  return {
    stage, seed, frames: rep.frames, end: rep.end, winner: rep.winner, capped: rep.capped,
    timedOut: rep.timedOut, blue: conv(0), red: conv(1),
  };
}

/* ── 一個局面 → 彙總 ─────────────────────────────────────── */
function summarize(cellKey, samples, termKeys) {
  const n = samples.length;
  const ends = {};
  for (const s of samples) ends[s.end] = (ends[s.end] || 0) + 1;
  const breach = (ends.breach || 0) / n;
  const redWin = samples.filter(s => s.winner === 1).length / n;
  const blueWin = samples.filter(s => s.winner === 0).length / n;

  const side = role => (role === 'attack' ? 'blue' : 'red');
  const out = { key: cellKey, games: n, ends, breach, blueWin, redWin, roles: {}, terms: {} };
  for (const role of [ROLES.ATTACK, ROLES.DEFENSE]) {
    const k = side(role);
    const arr = f => samples.map(f);
    const scores = samples.map(s => s[k].score);
    const wins = samples.filter(s => s[k].won).map(s => s[k].score);
    const losses = samples.filter(s => !s[k].won).map(s => s[k].score);
    const termMean = {};
    for (const key of termKeys) termMean[key] = mean(samples.map(s => s[k].contrib.get(key) || 0));
    const posTotal = termKeys.reduce((a, key) => a + Math.max(0, termMean[key]), 0);
    const groupMean = {};
    for (const key of termKeys) {
      const g = GROUP[key];
      groupMean[g] = (groupMean[g] || 0) + termMean[key];
    }
    const groupPositive = {};
    for (const key of termKeys) {
      const g = GROUP[key];
      groupPositive[g] = (groupPositive[g] || 0) + Math.max(0, termMean[key]);
    }
    out.roles[role] = {
      score: scores,
      scoreMean: mean(scores), scoreSd: sd(scores), scoreMedian: q(scores, 0.5),
      scoreP10: q(scores, 0.1), scoreP90: q(scores, 0.9),
      zeroRate: scores.filter(v => v === 0).length / n,
      winRate: samples.filter(s => s[k].won).length / n,
      winScoreMean: wins.length ? mean(wins) : 0,
      loseScoreMean: losses.length ? mean(losses) : 0,
      posTotal,
      alignShare: posTotal ? (groupPositive.objective || 0) / posTotal : 0,
      processShare: posTotal ? (groupPositive.process || 0) / posTotal : 0,
      combatShare: posTotal ? (groupPositive.combat || 0) / posTotal : 0,
      groupMean,
      proc: {
        foeHalfShare: arr(s => s[k].foeHalfShare),
        engageShare: arr(s => s[k].engageShare),
        blockedShare: arr(s => s[k].blockedShare),
        abstainShare: arr(s => s[k].abstainShare),
        penetration: samples.map(s => s[k].penetration).filter(v => v !== null && Number.isFinite(v)),
        interceptions: arr(s => s[k].interceptions),
        kills: arr(s => s[k].kills), deaths: arr(s => s[k].deaths),
        duelKills: arr(s => s[k].duelKills),
        shots: arr(s => s[k].shots), damageDone: arr(s => s[k].damageDone),
        ownWallLost: arr(s => s[k].ownWallLost), foeWallLost: arr(s => s[k].foeWallLost),
        foeWallNear: arr(s => s[k].foeWallNear), foeWallFar: arr(s => s[k].foeWallFar),
        selfShots: arr(s => s[k].selfShots),
        ownGoalRate: samples.filter(s => s[k].ownGoal).length / n,
        foeOwnGoalRate: samples.filter(s => s[k].foeOwnGoal).length / n,
        frames: samples.map(s => s.frames),
        cappedRate: samples.filter(s => s.capped).length / n,
      },
    };
    out.terms[role] = termMean;
  }
  return out;
}

/* ── 印出 ───────────────────────────────────────────────── */
function printCell(sum, termKeys) {
  const cell = CELLS.find(c => c.key === sum.key);
  console.log(`\n┌─ 局面 ${sum.key}　${cell ? cell.label : ''}　${sum.games} 局`);
  const ends = Object.entries(sum.ends).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}（${pct(v / sum.games)}）`).join('、');
  console.log(`│  終局：${ends}`);
  console.log(`│  勝負：藍 ${pct(sum.blueWin)}｜紅 ${pct(sum.redWin)}`);
  for (const role of [ROLES.ATTACK, ROLES.DEFENSE]) {
    const r = sum.roles[role], p = r.proc;
    console.log(`│`);
    console.log(`│  【${ROLE_LABEL[role]}席】分數 ${dist(r.score)}` +
      `｜零分 ${pct(r.zeroRate)}｜獲勝 ${pct(r.winRate)}`);
    console.log(`│    贏局均分 ${num(r.winScoreMean)}｜輸局均分 ${num(r.loseScoreMean)}` +
      `｜分數來源：勝負 ${pct(r.alignShare)}、本業 ${pct(r.processShare)}、通用交戰 ${pct(r.combatShare)}`);
    console.log(`│    壓進敵半場 ${pct(mean(p.foeHalfShare))}｜貼身交戰 ${pct(mean(p.engageShare))}` +
      `｜卡住 ${pct(mean(p.blockedShare))}｜網路決策率 ${pct(1 - mean(p.abstainShare))}` +
      `（0%＝這一隊全程由規則 AI 開車）`);
    console.log(`│    最接近敵鷹 ${dist(p.penetration, 1)} px｜攔截傷害 ${num(mean(p.interceptions))} hp` +
      `｜擊殺 ${num(mean(p.kills), 1)}／戰死 ${num(mean(p.deaths), 1)}` +
      // v11 的折扣要看「近／遠」兩堆，所以這裡不能只印總數（同一個總數可以
      // 是「貼臉拆 6 格」或「隔空啃 6 格」，分數差 4 倍）。
      `｜拆敵牆 ${num(mean(p.foeWallLost), 1)} 格` +
      `（近 ${num(mean(p.foeWallNear), 1)}／遠 ${num(mean(p.foeWallFar), 1)}）`);
    console.log(`│    拆自家牆 ${num(mean(p.ownWallLost), 1)} 格、自家老鷹被自己打爆 ${pct(p.ownGoalRate)}` +
      `｜對方自破 ${pct(p.foeOwnGoalRate)}｜局均 ${num(mean(p.frames), 0)} 幀`);
  }
  // 逐項貢獻：只用進攻席那張表（兩套標準項次不同，各自印）
  for (const role of [ROLES.ATTACK, ROLES.DEFENSE]) {
    const rows = termKeys
      .map(k => [k, sum.terms[role][k]])
      .filter(([, v]) => Math.abs(v) > 0.005);
    rows.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    console.log(`│`);
    console.log(`│  ${ROLE_LABEL[role]}席逐項均値（每局，依大小排序）：`);
    const w = Math.max(...rows.map(([k]) => k.length), 12);
    for (const [k, v] of rows)
      console.log(`│    ${pad(k, w)} ${padL(num(v), 8)}  ${GROUP_LABEL[GROUP[k]] || ''}`);
  }
  console.log(`└─${'─'.repeat(60)}`);
}

function printBalance(sums, arena, o) {
  const by = k => sums.find(s => s.key === k);
  const rr = by('rule·rule'), nn = by('rand·rand');
  const ar = by('atk·rule'), rd = by('rule·def'), hh = by('atk·def');
  console.log('\n═══ 平衡度指標 ═══════════════════════════════════');

  const line = (label, a, b, note) =>
    console.log(`  ${pad(label, 26)} ${padL(num(a), 8)}  ${padL(num(b), 8)}   ${note || ''}`);

  console.log(`  ${pad('', 26)} ${padL('藍（進攻）', 8)}  ${padL('紅（防守）', 8)}`);
  if (nn) line('零技能均分（rand·rand）', nn.roles.attack.scoreMean, nn.roles.defense.scoreMean,
    '幾何點對稱＋兩邊一樣爛 → 這一欄的差＝尺本身的偏置');
  if (rr) line('同技能均分（rule·rule）', rr.roles.attack.scoreMean, rr.roles.defense.scoreMean,
    '兩隊都跑規則 AI 時的給分差');
  if (rr) line('同技能中位分', rr.roles.attack.scoreMedian, rr.roles.defense.scoreMedian);
  if (hh) line('冠軍對打均分（atk·def）', hh.roles.attack.scoreMean, hh.roles.defense.scoreMean);
  if (hh) line('獲勝時均分', hh.roles.attack.winScoreMean, hh.roles.defense.winScoreMean,
    '「贏一場」在兩套標準裡各值多少');
  if (hh) line('目標對齊占比', hh.roles.attack.alignShare, hh.roles.defense.alignShare,
    '勝負項佔正分比例');
  if (hh) line('本業推進占比', hh.roles.attack.processShare, hh.roles.defense.processShare,
    '推進／攔截項佔正分比例');
  if (hh) line('通用交戰占比', hh.roles.attack.combatShare, hh.roles.defense.combatShare,
    '擊殺／傷害／道具這類不問角色的項次');

  console.log('');
  if (rr && ar) {
    const up = (ar.breach - rr.breach) / Math.max(0.0001, 1 - rr.breach);
    line('進攻模型的破局增量', up, 0, `breach ${pct(rr.breach)} → ${pct(ar.breach)}（相對剩下的空間）`);
  }
  if (rr && rd) {
    const up = (rd.redWin - rr.redWin) / Math.max(0.0001, 1 - rr.redWin);
    line('防守模型的守成增量', 0, up, `紅勝 ${pct(rr.redWin)} → ${pct(rd.redWin)}`);
  }
  if (rr && ar && rd) {
    const a = (ar.roles.attack.scoreMean - rr.roles.attack.scoreMean);
    const d = (rd.roles.defense.scoreMean - rr.roles.defense.scoreMean);
    line('換上自己族模型的加分', a, d, '同一個基準線出發，兩族各拿到多少分 → 階梯高度差');
  }
  if (rr && ar && rd) {
    const da = ar.breach - rr.breach;
    const dd = rd.redWin - rr.redWin;
    const ea = da ? (ar.roles.attack.scoreMean - rr.roles.attack.scoreMean) / da : NaN;
    const ed = dd ? (rd.roles.defense.scoreMean - rr.roles.defense.scoreMean) / dd : NaN;
    line('每換 1% 勝負率的加分', ea, ed, '獎勵對「勝利」的彈性：差太多就會一邊先衝出去');
  }

  console.log('');
  const examGames = Math.max(1, o.maps * o.seeds);
  for (const role of [ROLES.ATTACK, ROLES.DEFENSE]) {
    const src = hh || rr;
    if (!src) continue;
    const r = src.roles[role];
    const sigmaMean = r.scoreSd / Math.sqrt(examGames);
    const headline = role === ROLES.ATTACK ? 'breach 發放率' : 'holdWin 發放率';
    const rate = role === ROLES.ATTACK ? src.breach : src.redWin;
    line(`${ROLE_LABEL[role]}席取樣信噪比`, r.scoreSd, sigmaMean,
      `每局 σ ${num(r.scoreSd)} → ${examGames} 場考題的均值 σ ${num(sigmaMean)}（均分 ${num(r.scoreMean)}）；` +
      `${headline} ${pct(rate)}`);
  }
  console.log('\n  ⚠ 口徑：分數用 ai/fitness.js 的 scoreOf（算分 v' + SCORING_VERSION +
    '）、maxFrames 2400，與訓練端 evaluatePolicy 完全同式；' +
    '地圖是 js/mapgen.js 的隨機地形，種子獨立於考題。');
}

/* ── 技能階梯（ladder）：起步平衡度的直接測量 ─────────────────
   矩陣告訴你「現在兩族差多少」，但這支問的是更前面的一件事：
   「一個還不會打的角色，要長到多少實力才開始拿到分數」。

   做法是把一隊的控制權在「規則 AI」與「隨機亂按」之間做機率混合：
   policy 每幀以機率 p 自己亂按、否則回 null（＝這一幀交回規則 AI 代步，
   那正是 PolicyController 的 abstain 路徑，訓練端一開始也走這條）。
   於是 p 就是一條可以連續調節的技能軸：p=0 完全是規則 AI、p=1 完全是亂按。

   為什麼這能回答「起步」：適應度有兩道地板（負分不記錄 → 0、整局躺平 → 0），
   一個還不會打的基因池很可能整池 0 分 —— 那時候選擇壓力等於沒有，
   演化只會原地漂。兩個角色如果離開 0 分地板所需要的「最低實力」不一樣，
   一個族從第 1 代就在爬階梯、另一個族前幾十代都在地板上乘涼，
   這就是使用者看到的「一邊起步比較快」，跟實力無關，跟尺有關。 */
const LADDER_PS = [0, 0.05, 0.1, 0.2, 0.35, 0.55, 0.8, 1];

/** 混合控制器：每幀以 p 的機率亂按一個動作，否則 abstain 交回規則 AI */
function blendSpec(p, seedValue) {
  const rng = mulberry32(seedValue);
  return {
    kind: 'policy',
    policy: () => (rng() < p ? Math.floor(rng() * 5) : null),
  };
}

function runLadder(arena, o) {
  const R = arena.R;
  const games = o.maps * o.seeds;
  const out = [];
  console.log(`\n技能階梯：p ＝ 每幀自己亂按的機率（0＝純規則 AI、1＝純隨機）`);
  console.log(`每格 ${games} 局（地圖 ${o.stageBase}..${o.stageBase + o.maps - 1} × ${o.seeds} 種子）；` +
    `被掃描的那隊換控制器，對面恆為規則 AI`);
  console.log(`\n  ${pad('p', 6)}│${padL(' 藍（進攻）', 46)}│${padL('紅（防守）', 46)}`);
  console.log(`  ${pad('', 6)}│ ${pad('均分', 8)}${pad('中位', 8)}${padL('脫地板率', 10)}${pad('破局率', 10)}│ ` +
    `${pad('均分', 8)}${pad('中位', 8)}${padL('脫地板率', 10)}${pad('守成率', 10)}`);

  for (const p of LADDER_PS) {
    const row = { p, attack: {}, defense: {} };
    for (const role of [ROLES.ATTACK, ROLES.DEFENSE]) {
      const sweepTeam = role === ROLES.ATTACK ? 0 : 1;
      const scores = []; const other = [];
      let wins = 0, offs = 0, headline = 0, combatShare = 0, engage = 0;
      // --terms：逐項貢獻與關鍵計量的平均。要問的不是「誰分高」，是「分從哪一項來的」。
      const termAcc = new Map();
      const METRICS = ['screenFrames', 'baseDefenseDamage', 'halfDefenseDamage', 'foeHalfFrames',
        'kills', 'deaths', 'shots', 'blockedFrames', 'duelFrames', 'ownBaseCellsLost',
        'foeWallLost', 'foeWallNear', 'foeWallFar'];
      const metAcc = Object.fromEntries(METRICS.map(k => [k, 0]));
      let minDist = Infinity;
      for (let m = 0; m < o.maps; m++) {
        const stage = (o.stageBase + m) % R.MAP_VARIANTS;
        for (let s = 0; s < o.seeds; s++) {
          const seed = 91_000 + stage * 263 + s * 29;
          const blend = blendSpec(p, seed);
          const rep = arena.run({
            stage, seed,
            blue: sweepTeam === 0 ? blend : 'rule',
            red: sweepTeam === 1 ? blend : 'rule',
          });
          const mine = scoreOf(rep.teams[sweepTeam], rep, sweepTeam, { role, maxFrames: 2400 });
          const foe = scoreOf(rep.teams[1 - sweepTeam], rep, 1 - sweepTeam, {
            role: sweepTeam === 0 ? ROLES.DEFENSE : ROLES.ATTACK, maxFrames: 2400,
          });
          scores.push(mine.final); other.push(foe.final);
          if (rep.winner === sweepTeam) wins++;
          if (mine.final > 0) offs++;
          // 「本業有沒有發生」的證據：進攻看 breach、防守看 holdWin（靠自己贏，不是對方自破）
          const hv = mine.rows.find(r => r.key === (role === ROLES.ATTACK ? 'breach' : 'holdWin'));
          if (hv && hv.contribution > 0) headline++;
          const posSum = mine.rows.reduce((a, r) => a + Math.max(0, r.contribution), 0);
          const jobSum = mine.rows
            .filter(r => GROUP[r.key] === 'objective' || GROUP[r.key] === 'process')
            .reduce((a, r) => a + Math.max(0, r.contribution), 0);
          if (posSum > 0) combatShare += 1 - jobSum / posSum; else combatShare += 0;
          engage += (rep.teams[sweepTeam].duelFrames || 0) / Math.max(1, rep.teams[sweepTeam].fieldFrames);
          if (o.terms) {
            for (const r of mine.rows) termAcc.set(r.key, (termAcc.get(r.key) || 0) + r.contribution);
            const t = rep.teams[sweepTeam];
            for (const k of METRICS) metAcc[k] += t[k] || 0;
            if (Number.isFinite(t.foeBaseMinDist)) minDist = Math.min(minDist, t.foeBaseMinDist);
          }
        }
      }
      row[role] = {
        mean: mean(scores), median: q(scores, 0.5), offFloorRate: offs / games,
        winRate: wins / games, headlineRate: headline / games,
        genericShare: combatShare / games, engageShare: engage / games,
        otherMean: mean(other), sd: sd(scores), scores,
      };
      if (o.terms) {
        row[role].terms = Object.fromEntries([...termAcc.entries()].map(([k, v]) => [k, v / games]));
        row[role].mets = Object.fromEntries(METRICS.map(k => [k, metAcc[k] / games]));
        row[role].mets.foeBaseMinDist = minDist === Infinity ? null : minDist;
      }
    }
    const a = row.attack, d = row.defense;
    console.log(`  ${pad(num(p, 2), 6)}│ ${pad(num(a.mean), 8)}${pad(num(a.median), 8)}` +
      `${padL(pct(a.offFloorRate), 10)}${padL(pct(a.headlineRate), 10)}│ ` +
      `${pad(num(d.mean), 8)}${pad(num(d.median), 8)}${padL(pct(d.offFloorRate), 10)}${padL(pct(d.headlineRate), 10)}`);
    out.push(row);
  }

  // 門檻：第一個「多數局面已經離開 0 分地板」的 p，以及「本業項開始發放」的 p
  const first = (role, test) => { const r = out.find(test); return r ? num(r.p, 2) : '未達成'; };
  console.log('');
  console.log(`  脫地板門檻（≥50% 的局面拿到正分）：進攻 p=${first('attack', r => r.attack.offFloorRate >= 0.5)}` +
    `｜防守 p=${first('defense', r => r.defense.offFloorRate >= 0.5)}`);
  console.log(`  本業門檻（≥20% 的局面發出勝負項）：進攻 p=${first('attack', r => r.attack.headlineRate >= 0.2)}` +
    `｜防守 p=${first('defense', r => r.defense.headlineRate >= 0.2)}`);
  console.log(`  最低技能就開分（≥20% 脫地板）：進攻 p=${first('attack', r => r.attack.offFloorRate >= 0.2)}` +
    `｜防守 p=${first('defense', r => r.defense.offFloorRate >= 0.2)}`);
  console.log('\n  讀法：兩行的 p 愈接近，兩族「起步」就越平衡；差愈大，那個需要更高技能才開分的族' +
    '會先卡在地板上（選擇壓力為 0），另一族則早就開始爬階梯。');
  if (o.terms) printTermDelta(out);
  if (o.json) {
    fs.mkdirSync(path.dirname(o.json), { recursive: true });
    fs.writeFileSync(o.json, JSON.stringify({
      kind: 'tank-battle-balance-ladder', version: 1, generatedAt: new Date().toISOString(),
      context: {
        maps: o.maps, seedsPerMap: o.seeds, stageBase: o.stageBase,
        scoringVersion: SCORING_VERSION, terms: !!o.terms,
      },
      rows: out.map(r => ({
        p: r.p,
        attack: Object.assign({}, r.attack, { scores: undefined }),
        defense: Object.assign({}, r.defense, { scores: undefined }),
      })),
    }, null, 1));
    console.log(`資料已寫入 ${path.relative(ROOT, o.json).replace(/\\/g, '/')}`);
  }
  return out;
}

/**
 * --terms 的結論區：把「p 最低那一格」與「p 最高那一格」的逐項平均貢獻相減。
 * 為什麼看差值而不是看絕對值：階梯要的是「技能愈高分數愈高」這條單調線，
 * 一旦它反向（純隨機比純規則 AI 還高），能指出來的一定是某幾項的差值，
 * 光看均分只能發現「不對」，看不出「哪一項在發錢」。
 * ⚠ 這裡的 p 軸是「每幀自己亂按的機率」：p=0＝純規則 AI（技能最高）、p=1＝純隨機。
 */
function printTermDelta(out) {
  const first = out[0], last = out[out.length - 1];
  for (const role of [ROLES.ATTACK, ROLES.DEFENSE]) {
    const a = first[role], b = last[role];
    if (!a.terms || !b.terms) continue;
    const keys = new Set([...Object.keys(a.terms), ...Object.keys(b.terms)]);
    const deltas = [...keys]
      .map(k => [k, (b.terms[k] || 0) - (a.terms[k] || 0)])
      .sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]));
    console.log('\n  ── 逐項貢獻（' + (role === ROLES.ATTACK ? '藍（進攻席）' : '紅（防守席）') +
      `）：p=${num(first.p, 2)} 純規則 AI → p=${num(last.p, 2)} 純隨機`);
    console.log('    ' + pad('項目', 16) + padL('p=' + num(first.p, 2), 10) + padL('p=' + num(last.p, 2), 10) + padL('Δ', 10));
    for (const [k, d] of deltas) {
      if (Math.abs(d) < 0.5 && Math.abs((a.terms[k] || 0)) < 0.5) continue;
      console.log('    ' + pad(k, 16) + padL(num(a.terms[k]), 10) + padL(num(b.terms[k]), 10) +
        padL((d >= 0 ? '+' : '') + num(d), 10));
    }
    console.log('    ' + pad('→ 均分', 16) + padL(num(a.mean), 10) + padL(num(b.mean), 10) +
      padL((b.mean - a.mean >= 0 ? '+' : '') + num(b.mean - a.mean), 10));
    const MK = ['screenFrames', 'baseDefenseDamage', 'halfDefenseDamage', 'foeHalfFrames',
      'kills', 'shots', 'blockedFrames', 'foeWallLost', 'foeWallNear', 'foeWallFar'];
    console.log('    關鍵計量（每局平均）：');
    for (const k of MK)
      console.log('      ' + pad(k, 18) + padL(num(a.mets[k], 1), 10) + padL(num(b.mets[k], 1), 10) +
        padL((b.mets[k] - a.mets[k] >= 0 ? '+' : '') + num(b.mets[k] - a.mets[k], 1), 10));
    console.log('      ' + pad('離敵鷹最近 px', 18) + padL(num(a.mets.foeBaseMinDist, 0), 10) +
      padL(num(b.mets.foeBaseMinDist, 0), 10));
  }
  console.log('\n  ⚠ 判準：技能軸是單調的，所以「p=0（最會打）的均分」不該低於「p=1（亂按）」。' +
    '哪一欄在 p=1 還比較高，那一項就是「不會打也能領薪」的來源，下一版要改的就是它。');
}

/* ── 天花板（ceiling）：不打對局，直接量「尺」的形狀 ───────────
   矩陣與階梯都要跑幾百局，它們量的是「實績」；這一支量的是另一件事：
   兩套標準各自的上限長什麼樣子 —— 一個拼盡全力的進攻者值幾分、
   一個拼盡全力的防守者值幾分，以及「完全不执行本業、只把仗打漂亮」
   能拿到其中多大比例。

   為什麼這跟平衡度有關：演化是按分數排序的，不是按意圖排序的。
   如果通用交戰項（擊殺／傷害／道具／協同）在某一族的天花板裡佔比很高，
   那個族的基因池不需要學會「攻城」或「攔截」就能往上爬 ——
   它起步的方向就不是使用者要的那件事，而另一族可能是。
   這種偏差在實測分數裡看不出來（兩邊都在漲），只有在分解天花板時才裸露。

   做法：把一份「每項都打滿」的合成成績餵給 scoreOf（同一支算分碼，
   沒有第二套邏輯），再按 GROUP 把逐項貢獻加回三軸。
   ⚠ 欄位名稱對齊 ai/arena.js 的逐隊統計；arena 加欄時這份要跟著補，
     否則新的計量永遠不會出現在天花板上，看起來就像「上限變低了」。

   跑法：node ai/balance.js --mode ceiling            （不用跑對局，秒級）
   ═══════════════════════════════════════════════════════════ */

/** 一個「每項都打滿」的逐隊成績。數字的取法：讓每個 value() 都撞到 cap／1。 */
function saturatedStat() {
  return {
    fieldFrames: 1000, actN: 1000, dominance: 0.40, blockedFrames: 0,
    foeHalfFrames: 500,                  // 50% → foeHalf 滿
    foeBaseMinDist: 0,                   // 貼到敵鷹中心 → penetration 滿
    foeWallLost: 8,                      // 舊尺（v10）用的總數欄位，留著給對照
    // v11 的 foeWall 讀的是 near／far，不再是 Lost：一個「每項都打滿」的進攻者
    // 当然是貼到門口才拆的（near 8、far 0）。少了這兩欄，ceiling 會印出
    // 「進攻天花板變低了」，而那是計量沒補齊，不是尺改壞了。
    foeWallNear: 8, foeWallFar: 0,
    besiegeFrames: 1000 * 0.15,          // v10 besiege：15% 貼門口就是滿
    screenFrames: 1000 * 0.30,           // v10 門前占比：30% → holdGate 的另一半也滿
    baseDefenseDamage: 5,                // defense 封在 GATE_HP_FULL＝5 hp
    halfDefenseDamage: 6,                // halfDefense 封在 HALF_HP_FULL＝6 hp（攔截合計 11）
    supportFrames: 250,                  // 25% → teamwork 滿
    kills: 40, duelKills: 4,             // v10 封頂改 24／1000 幀（多給不會再漲，留著當防呆）
    damageDone: 40,                      // damagePer1k 封在 24
    shots: 26,                           // 40/26 ≈ 1.54 → accuracy 封在 1.5；且不觸發 spray
    powerups: 12, firepowerUp: 12,       // 兩個 per1k 項的封頂值
    deaths: 0, ownBaseCellsLost: 0, selfBaseShots: 0,
    ownBaseAlive: true, ownBaseKilledBySelf: false, foeBaseOwnGoal: false,
    // v10 的「主動取勝」：防守席要看到 foeBaseKilled 才拿得到 holdWin 的滿檔（45）
    // 與 speed；只撐過時鐘那一檔是 0.4（18），兩種贏法不同分正是這版的重點。
    foeBaseKilled: true,
  };
}

/** 一筆天花板快照：全天花板、三軸分解、逐項貢獻 */
function ceilingFor(role) {
  const teamId = role === ROLES.ATTACK ? 0 : 1;
  const s = saturatedStat();
  // teams 放同一份「打滿」的成績：拒止讀的是對手的 foeHalfFrames，
  // 給 0 才表示「對手壓不進來」，這是防守席天花板該有的前提，
  // 少了這一段 denial 會被算成 0 分、天花板就少一整項。
  const quiet = { fieldFrames: 1000, foeHalfFrames: 0, screenFrames: 0 };
  const teams = [];
  teams[teamId] = s;            // 自己＝打滿的成績
  teams[1 - teamId] = quiet;    // 對手＝一幀都壓不進來
  const rep = { winner: teamId, timedOut: false, capped: false, frames: 60, teams, end: 'counter' };
  const out = scoreOf(s, rep, teamId, { role, maxFrames: 2400 });
  const pos = out.rows.filter(r => r.contribution > 0);
  const byGroup = {};
  for (const g of ['objective', 'process', 'combat', 'discipline']) {
    byGroup[g] = out.rows
      .filter(r => GROUP[r.key] === g)
      .reduce((a, r) => a + Math.max(0, r.contribution), 0);
  }
  const total = pos.reduce((a, r) => a + r.contribution, 0);
  return { role, final: out.final, total, byGroup, rows: out.rows, job: byGroup.objective + byGroup.process };
}

function runCeiling(o) {
  const ceil = { attack: ceilingFor(ROLES.ATTACK), defense: ceilingFor(ROLES.DEFENSE) };

  console.log(`\n天花板分解（合成成績每項打滿，算分走 ai/fitness.js 的 scoreOf・v${SCORING_VERSION}）`);
  for (const role of [ROLES.ATTACK, ROLES.DEFENSE]) {
    const c = ceil[role];
    console.log(`\n┌ ${ROLE_LABEL[role]}席的天花板：逐項貢獻 ${num(c.total)}／地板後 ${num(c.final)}`);
    console.log(`│ ${pad('軸', 12)} ${padL('分', 8)} ${padL('佔天花板', 10)}  這一軸代表什麼`);
    const desc = {
      objective: '勝負本身（破局／守住／自家老鷹／速度）',
      process: '本業推進（壓進敵半場、拆牆、家門口與半場攔截）',
      combat: '不問角色的戰鬥數據（擊殺、傷害、道具、協同）',
      discipline: '紀律項（在天花板裡都是 0，見下方地板深度）',
    };
    for (const g of ['objective', 'process', 'combat', 'discipline'])
      console.log(`│ ${pad(GROUP_LABEL[g], 12)} ${padL(num(c.byGroup[g]), 8)} ` +
        `${padL(pct(c.byGroup[g] / Math.max(1, c.total)), 10)}  ${desc[g]}`);
    console.log(`│ 本業（勝負＋推進／攔截）${num(c.job)}｜只做本業的上限 ${pct(c.job / Math.max(1, c.total))}`);
    console.log(`│ ⚠ 「只打人、完全不做本業」的上限＝${num(c.byGroup.combat)} 分` +
      `（${pct(c.byGroup.combat / Math.max(1, c.total))}）—— 一個從不攻城、也從不回防的個體` +
      `靠戰鬥數據最多能爬到這裡`);
    console.log('│');
    console.log(`│ ${pad('項次', 18)} ${padL('權重', 7)} ${padL('滿值', 7)} ${padL('貢獻', 8)}`);
    for (const r of ceil[role].rows.slice().sort((a, b) => b.contribution - a.contribution)) {
      if (r.contribution <= 0) continue;
      console.log(`│ ${pad(r.key, 18)} ${padL(num(r.weight, 1), 7)} ${padL(num(r.value, 2), 7)} ${padL(num(r.contribution), 8)}`);
    }
    console.log(`└${'─'.repeat(60)}`);
  }

  const a = ceil.attack, d = ceil.defense;
  console.log(`\n同一份「每項打滿」的成績，兩套尺各給多少：` +
    `進攻 ${num(a.total)}｜防守 ${num(d.total)}｜差 ${num(a.total - d.total)}` +
    `（${num(100 * (a.total - d.total) / Math.max(1, d.total), 1)}%）`);
  console.log(`本業佔自己天花板的比例：進攻 ${pct(a.job / Math.max(1, a.total))}｜防守 ${pct(d.job / Math.max(1, d.total))}`);
  console.log(`→ 這一行才是「尺」的失衡：比例低的族，靠不相關的事就能拿到同量級的分數，` +
    `起步時被選下來的基因不一定朝本業走。`);

  // 地板深度：紀律項全觸發時能扣到哪裡（配合「負分不記錄 → 0」那條地板）
  const neg = role => termsFor(role).filter(t => weightOf(t, role) < 0);
  console.log(`\n地板深度（紀律／失敗項全部觸發時能扣多少，未封頂的項目以「每單位」計）：`);
  for (const role of [ROLES.ATTACK, ROLES.DEFENSE]) {
    const list = neg(role);
    const bounded = list.filter(t => !['death', 'ownBaseCellLost', 'selfBaseShot'].includes(t.key))
      .reduce((x, t) => x + weightOf(t, role), 0);
    console.log(`  ${ROLE_LABEL[role]}席：有上限的負分合計 ${num(bounded, 1)}｜` +
      list.filter(t => ['death', 'ownBaseCellLost', 'selfBaseShot'].includes(t.key))
        .map(t => `${t.key} ${weightOf(t, role)}/個`).join('｜'));
  }
  console.log(`  讀法：負分合計的絕對值若接近甚至超過本業天花板，早期族群會整片落在 0 地板以下 ——` +
    `那一區裡的個體全部同分（0），選擇壓力消失，演化只能靠漂移。階梯模式的「脫地板率」量的是同一件事的後果。`);

  if (o.json) {
    fs.mkdirSync(path.dirname(o.json), { recursive: true });
    fs.writeFileSync(o.json, JSON.stringify({
      kind: 'tank-battle-balance-ceiling', version: 1, generatedAt: new Date().toISOString(),
      context: { scoringVersion: SCORING_VERSION, halfFieldPx: HALF_FIELD_PX },
      ceilings: Object.fromEntries(Object.entries(ceil).map(([role, c]) => [role, {
        total: c.total, final: c.final, job: c.job, byGroup: c.byGroup,
        rows: c.rows.map(r => ({ key: r.key, group: GROUP[r.key], weight: r.weight, value: r.value, contribution: r.contribution })),
      }])),
    }, null, 1));
    console.log(`\n資料已寫入 ${path.relative(ROOT, o.json).replace(/\\/g, '/')}（未動任何訓練檔案）`);
  }
  return ceil;
}

/* ── 主程式 ─────────────────────────────────────────────── */
function main(argv) {
  const o = parseArgs(argv);
  if (o.help) { console.log(HELP); return; }

  // 天花板模式不碰引擎、不打對局（只算 scoreOf），所以不必建立 Arena ——
  // 訓練正在跑時這支是零 CPU 競爭的，隨時可以插進去量一次。
  if (o.mode === 'ceiling') {
    console.log(`ai/balance.js — 計分天花板分解（唯讀・不跑對局）｜算分 v${SCORING_VERSION}`);
    runCeiling(o);
    return;
  }

  const arena = new Arena();
  const R = arena.R;

  if (o.mode === 'ladder') {
    console.log(`ai/balance.js — 技能階梯（起步平衡度）｜${R.GRID_W}×${R.GRID_H}、` +
      `倒數 ${R.DEMO_ATTACK_SECONDS}s、算分 v${SCORING_VERSION}`);
    runLadder(arena, o);
    return;
  }

  // 換模型：ai/trained-*.json（自動訓練每代匯出的那份快照，
  // 也就是訓練場現在互相當對手用的同一隻網路 —— 用存檔裡的冠軍會量到比較新的個體，
  // 那樣「探針看到的平衡度」和「訓練場感受到的」就不是同一件事）。
  const specs = {};
  for (const role of ['attack', 'defense']) {
    if (fs.existsSync(SNAP[role])) specs[role] = loadOpponent(SNAP[role], `--${role}`);
    else specs[role] = null;
  }
  const resolve = v => (v === 'attack' || v === 'defense' ? (specs[v] || 'rule') : v);
  const cells = CELLS.filter(c => !o.cell || c.key === o.cell)
    .map(c => Object.assign({}, c, { blue: resolve(c.blue), red: resolve(c.red) }));

  console.log(`ai/balance.js — 攻守平衡度探針`);
  console.log(`幾何 ${R.GRID_W}×${R.GRID_H} cells（${R.FIELD_W}×${R.FIELD_H}px，半場 ${HALF_FIELD_PX}px）` +
    `｜倒數 ${R.DEMO_ATTACK_SECONDS}s＝${R.DEMO_ROUND_CAP} 幀｜開場一次 ${R.DEMO_MAX_ON_FIELD} 台` +
    `｜出兵間隔 進攻 ${R.DEMO_ATTACK_SPAWN_INTERVAL}／防守 ${R.DEMO_SPAWN_INTERVAL} 幀` +
    // 批次二之後，「紅隊攔不攔得到」取決於屏蔽半徑與防線，不是門前 56px。
    // 探針若不印出這幾個數，前後兩次快照就分不出是規則改了還是尺改了。
    // 批次五（J）換掉了「擋路清障」那條規則，改成打敵車／打主堡的切換門檻，
    // 這裡跟著印新的尺：舊名一印，前後對照會誤讀成規則沒動。
    `｜回防半徑 ${R.DEMO_THREAT_RADIUS}px｜屏蔽 ${R.DEMO_SCREEN_RADIUS}px` +
    `｜防線 老鷹前 ${R.DEMO_HOLD_LINE}px｜突襲門檻 ${R.AI_ASSAULT_RADIUS}px` +
    `｜貼身 ${R.AI_DUEL_RADIUS}px`);
  for (const role of ['attack', 'defense']) {
    const s = specs[role];
    console.log(`${ROLE_LABEL[role]}模型：${s ? `${path.relative(ROOT, s.file).replace(/\\/g, '/')}（第 ${s.generation ?? '?'} 代・快照分 ${num(s.fitness)}）` : '無快照 → 退回規則 AI'}`);
  }
  console.log(`考題：地圖 ${o.stageBase}..${o.stageBase + o.maps - 1}（每張點對稱）× ${o.seeds} 種子` +
    `｜局面 ${cells.length} 個｜共 ${cells.length * o.maps * o.seeds} 局`);

  const termKeys = [...new Set(TERMS.map(t => t.key))];

  const sums = [];
  for (const cell of cells) {
    const samples = [];
    for (let m = 0; m < o.maps; m++) {
      const stage = (o.stageBase + m) % R.MAP_VARIANTS;
      for (let s = 0; s < o.seeds; s++) {
        samples.push(sampleGame(arena, cell, stage, 77_000 + stage * 131 + s * 17));
        process.stdout.write('.');
      }
    }
    console.log('');
    const sum = summarize(cell.key, samples, termKeys);
    sum.samples = samples;
    sums.push(sum);
    printCell(sum, termKeys);
  }

  printBalance(sums, arena, o);

  if (o.json) {
    fs.mkdirSync(path.dirname(o.json), { recursive: true });
    fs.writeFileSync(o.json, JSON.stringify({
      kind: 'tank-battle-balance', version: 1,
      generatedAt: new Date().toISOString(),
      context: {
        scoringVersion: SCORING_VERSION, halfFieldPx: HALF_FIELD_PX,
        grid: [R.GRID_W, R.GRID_H], attackSeconds: R.DEMO_ATTACK_SECONDS,
        roundCap: R.DEMO_ROUND_CAP, spawnIntervals: [R.DEMO_ATTACK_SPAWN_INTERVAL, R.DEMO_SPAWN_INTERVAL],
        threatRadius: R.DEMO_THREAT_RADIUS, duelRadius: R.AI_DUEL_RADIUS,
        // 批次二（G）的角色化參數＋批次五（J）的突襲門檻：
        // 前後對照要靠這幾項判定「規則變了」而非「尺變了」
        screenRadius: R.DEMO_SCREEN_RADIUS, holdLine: R.DEMO_HOLD_LINE,
        assaultRadius: R.AI_ASSAULT_RADIUS,
        maxOnField: R.DEMO_MAX_ON_FIELD, maps: o.maps, seedsPerMap: o.seeds, stageBase: o.stageBase,
        models: Object.fromEntries(['attack', 'defense'].map(r => [r, specs[r]
          ? { file: path.relative(ROOT, specs[r].file).replace(/\\/g, '/'), generation: specs[r].generation, fitness: specs[r].fitness }
          : null])),
      },
      cells: sums.map(s => ({
        key: s.key, games: s.games, ends: s.ends, breach: s.breach,
        blueWin: s.blueWin, redWin: s.redWin,
        roles: Object.fromEntries(Object.entries(s.roles).map(([role, r]) => [role, {
          scoreMean: r.scoreMean, scoreMedian: r.scoreMedian, scoreSd: r.scoreSd,
          scoreP10: r.scoreP10, scoreP90: r.scoreP90, zeroRate: r.zeroRate,
          winRate: r.winRate, winScoreMean: r.winScoreMean, loseScoreMean: r.loseScoreMean,
          alignShare: r.alignShare, processShare: r.processShare, combatShare: r.combatShare,
          proc: {
            foeHalfShare: mean(r.proc.foeHalfShare), engageShare: mean(r.proc.engageShare),
            blockedShare: mean(r.proc.blockedShare), abstainShare: mean(r.proc.abstainShare),
            penetrationMedian: q(r.proc.penetration, 0.5), interceptionsMean: mean(r.proc.interceptions),
            killsMean: mean(r.proc.kills), deathsMean: mean(r.proc.deaths),
            ownWallLostMean: mean(r.proc.ownWallLost), foeWallLostMean: mean(r.proc.foeWallLost),
            // v11：foeWall 那項現在按 near／far 計價，前後對照要能看出
            // 「同樣 2 格牆，是貼臉拆的還是隔空啃的」。
            foeWallNearMean: mean(r.proc.foeWallNear), foeWallFarMean: mean(r.proc.foeWallFar),
            ownGoalRate: r.proc.ownGoalRate, foeOwnGoalRate: r.proc.foeOwnGoalRate,
            framesMean: mean(r.proc.frames), cappedRate: r.proc.cappedRate,
          },
        }])),
        terms: s.terms,
        games_: s.samples.map(x => ({
          stage: x.stage, seed: x.seed, end: x.end, winner: x.winner, frames: x.frames,
          blue: { score: x.blue.score, kills: x.blue.kills, deaths: x.blue.deaths, penetration: x.blue.penetration, foeHalfShare: x.blue.foeHalfShare, interceptions: x.blue.interceptions },
          red: { score: x.red.score, kills: x.red.kills, deaths: x.red.deaths, penetration: x.red.penetration, foeHalfShare: x.red.foeHalfShare, interceptions: x.red.interceptions },
        })),
      })),
    }, null, 1));
    console.log(`\n資料已寫入 ${path.relative(ROOT, o.json).replace(/\\/g, '/')}（唯讀探針，未動任何訓練檔案）`);
  }
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (e) { console.error(e.stack || String(e)); process.exitCode = 1; }
}

// ceilingFor 一併匯出：test-train.js 要用「同一把尺」驗兩席的本業上限，
// 而不是在測試裡另寫一套加權（那會變成改權重時一邊過、一邊不過）。
// blendSpec 也匯出：「防守席的老師是不是愈隨機愈高分」這一條，測的是 ladder
// 兩個端點的差，所以混合控制器必須跟探針用同一支（含它內部那顆 rng），
// 不能用 arena 的 'random' 代替。兩者不是同一件事：
//   · blendSpec(1)（＝ladder 的 p=1）每幀在「亂按一個動作」與「交回規則 AI」之間
//     擲骰，動作走 PolicyController，所以 v6 的彈道閘（ownBaseInFront）照樣生效
//     —— 那是「有紀律、零技能」的駕駛，96 局實測開火 190.7 槍／局、防守均分 74.53。
//   · arena 的 'random' 是 ai/controller.js 的 randomPolicy()：每幀另挑方向、
//     15% 機率開火，**不走彈道閘**，於是它一路把自己的老鷹打爆。同一組 12 局考題
//     實測 12/12 全是 `ownBaseKilledBySelf`、平均約 180 幀就終局，防守分整臂趴在
//     0 地板。它量的是「自爆」，不是「不會打」，拿來跟老師比會得出 79.6 − 0.0
//     這種假結論（批次四真的踩過，所以這一條改成直接測它、釘在測試裡）。
module.exports = { main, parseArgs, CELLS, sampleGame, summarize, GROUP, ceilingFor, saturatedStat, blendSpec };
