/* audit-intensity.js — 診斷腳本：現在這場對戰到底「激烈」到什麼程度（批次六的起手式）
   ═══════════════════════════════════════════════════════════
   為什麼要這支：使用者問的是「要讓對戰更激烈，該怎麼修正、怎麼計分更好」。
   這句話裡藏著一個必須先量的東西 —— 「不激烈」有四種完全不同的病：
     (1) 兩隊根本沒碰到彼此（各走各的，隔著半張地圖對射）；
     (2) 碰到了但不開火（繞著走、卡牆、省子彈）；
     (3) 開了火但打不掉（命中太差，兵力池見底才收場）；
     (4) 打得掉但收不了尾（能砍到 4 比 1 卻不去拆老鷹，拖到 30 秒時間到）。
   這四種病對應的修法互斥：(1) 是幾何／目標層，(2)(3) 是射擊與火力節拍，
   (4) 才是計分。所以先量、再談改 —— 現行碼一個字都不動。

   量法：同一組（地圖, 種子）成對跑三種對局，把差異歸給「誰在開車」而不是「抽到哪張圖」：
     model 藍＝訓練好的進攻冠軍、紅＝訓練好的防守冠軍（＝觀戰頁預設那一格）
     rule  藍紅都是規則 AI（老師對打，也就是暖啟動的老師）
     mixed 藍＝模型、紅＝規則（右欄 ③ 的「藍網路・紅規則」）
   ⚠ 三種模式讀的是同一批考題：stage = i % MAP_VARIANTS、seed = 30000 + i*977，
     跟 ai/balance.js、measure-breach.js 同一把尺，所以 240 局的破局率標準誤差 ±3.2%
     這條也適用在這裡 —— 小於 3 個百分點的差異不要解讀。

   激烈度拆成可看的原始量（不自己發明單一指數）：
     終局方式分佈：breach（藍破網）／counter（紅反殺）／time（拖到時間到）／pool（兵力耗盡）
     終局秒數：平均與中位；以及「打完 30 秒鐘還沒結果」的占比 —— 這一項直接決定觀感，
       因為拖滿的局在畫面上就是兩隊互相繞。
     每場交換量：擊殺、開火、對敵造成的傷害、結束時雙方在場車數、剩餘兵力池。
     逐幀接觸度（這支腳本獨有的東西，用包 engine.step 取樣，不改任何碼）：
       ≤40px（規則 AI 自己那把尺 AI_DUEL_RADIUS，也就是「貼身格鬥」的定義）
       ≤80px（同一格內的對峙）／≤120px（開得槍的距離）
       互射幀＝兩隊同時都有子彈在飛的幀
       包圍幀＝至少 2 台藍車在紅鷹 ≤56px 內
       藍隊最接近紅鷹的距離（全場最小值）——「有沒有打到家門口」的硬證據
   跑法：node audit-intensity.js [每模式局數，預設 120]
   ═══════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const { Arena } = require('./ai/arena');
const { Genome } = require('./ai/neat');

const N = Number(process.argv[2] || 120);
const arena = new Arena({ maxFrames: 2400 });
const R = arena.R;
const G = arena.game;
const DUEL = R.AI_DUEL_RADIUS || 40;      // 40px：規則 AI 認為「太接近，先解決這台」的尺
const NEAR = 80, RANGE = 120;             // 對峙／開得槍的距離
const ASSAULT = R.AI_ASSAULT_RADIUS || 56; // 家門口
const FPS = 60;

/** 讀某席的冠軍快照，回傳競技場要的注入規格 */
function seatOf(role) {
  const f = path.join(__dirname, 'ai', `trained-${role}.json`);
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (j.role !== role) throw new Error(`${f} 的席位是 ${j.role}，不是 ${role}`);
  return { kind: 'policy', policy: Genome.fromJSON(j.genome).toPolicy(), gen: j.generation };
}
const BLUE_MODEL = seatOf('attack'), RED_MODEL = seatOf('defense');

/* ── 逐幀取樣：包一層 engine.step，arena.run 每幀都會經過這裡 ── */
const eng = arena.engine;
const origStep = eng.step.bind(eng);
let sink = null;
eng.step = (n) => {
  const r = origStep(n);
  if (sink) sink(G);
  return r;
};
const live = a => a.filter(t => t.alive && !(t.spawnTimer > 0));
const bulletsOf = (g, team) => g.bullets.filter(b => b.alive && b.owner && b.owner.team === team).length;

function sampleFrame(g) {
  const blue = live(g.tanks.filter(t => t.team === 0));
  const red = live(g.tanks.filter(t => t.team === 1));
  const out = { contact: Infinity };
  for (const b of blue) for (const f of red) {
    const d = b.distTo(f.x, f.y);
    if (d < out.contact) out.contact = d;
  }
  const eagle = g.map.bases[1];
  const ex = (eagle.cx + 1) * R.CELL, ey = (eagle.cy + 1) * R.CELL;
  out.toEagle = blue.length ? Math.min(...blue.map(b => b.distTo(ex, ey))) : Infinity;
  out.siege = blue.filter(b => b.distTo(ex, ey) <= ASSAULT).length;
  out.bothOnField = blue.length > 0 && red.length > 0;
  out.exchange = bulletsOf(g, 0) > 0 && bulletsOf(g, 1) > 0;
  out.nBlue = blue.length; out.nRed = red.length;
  return out;
}

function runOne(mode, i) {
  // 考題跟 measure-breach.js 完全同一組（stage = i % 255、seed = 30000 + i*977），
  // 所以這裡的破局率可以直接拿去對它那支腳本的數字，不必重新解釋尺。
  const stage = i % R.MAP_VARIANTS, seed = 30000 + i * 977;
  const spec = mode === 'model' ? { blue: BLUE_MODEL, red: RED_MODEL }
    : mode === 'rule' ? { blue: 'rule', red: 'rule' }
      : { blue: BLUE_MODEL, red: 'rule' };
  const acc = {
    frames: 0, duel: 0, near: 0, range: 0, exchange: 0, onField: 0, siege: 0,
    minContact: Infinity, minToEagle: Infinity, tot: 0,
  };
  sink = (g) => {
    const s = sampleFrame(g);
    acc.frames++;
    if (s.bothOnField) {
      acc.onField++;
      if (s.contact <= DUEL) acc.duel++;
      if (s.contact <= NEAR) acc.near++;
      if (s.contact <= RANGE) acc.range++;
      if (s.contact < acc.minContact) acc.minContact = s.contact;
    }
    if (s.exchange) acc.exchange++;
    if (s.siege >= 2) acc.siege++;
    if (s.toEagle < acc.minToEagle) acc.minToEagle = s.toEagle;
  };
  let rep;
  try { rep = arena.run(Object.assign({ stage, seed }, spec)); }
  finally { sink = null; }
  const t0 = rep.teams[0], t1 = rep.teams[1];
  return {
    end: rep.end || '?', winner: rep.winner, frames: rep.frames,
    kills: [t0.kills, t1.kills], shots: [t0.shots, t1.shots],
    damage: [t0.damageDone || 0, t1.damageDone || 0],
    deaths: [t0.deaths, t1.deaths], survivors: [t0.survivors, t1.survivors],
    pool: [t0.poolLeft, t1.poolLeft], score: [t0.score, t1.score],
    duelPct: acc.duel / Math.max(1, acc.onField), nearPct: acc.near / Math.max(1, acc.onField),
    rangePct: acc.range / Math.max(1, acc.onField),
    exPct: acc.exchange / Math.max(1, acc.frames),
    siegePct: acc.siege / Math.max(1, acc.frames),
    onFieldPct: acc.onField / Math.max(1, acc.frames),
    minContact: acc.minContact, minToEagle: acc.minToEagle,
  };
}

const med = a => { const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const avg = a => a.reduce((x, v) => x + v, 0) / Math.max(1, a.length);
const pc = v => (100 * v).toFixed(1) + '%';
const sec = f => (f / FPS).toFixed(1) + 's';
const px = v => Number.isFinite(v) ? v.toFixed(0) + 'px' : '—';

function report(mode, games) {
  const ends = {};
  for (const g of games) ends[g.end] = (ends[g.end] || 0) + 1;
  const timeOut = (ends.time || 0) + (ends.pool || 0);
  const f = games.map(g => g.frames);
  console.log(`\n【${mode}】${games.length} 局（藍＝${mode === 'rule' ? '規則' : '進攻模型 第' + BLUE_MODEL.gen + '代'}／紅＝${mode === 'model' ? '防守模型 第' + RED_MODEL.gen + '代' : '規則'}）`);
  console.log(`  終局方式：${Object.entries(ends).map(([k, v]) => `${k === 'breach' ? '藍破網' : k === 'counter' ? '紅反殺' : k === 'time' ? '時間到' : k === 'pool' ? '兵力耗盡' : k} ${v}`).join('｜')}`);
  console.log(`  → 沒有決出勝負（時間到＋兵力耗盡）＝${pc(timeOut / games.length)}；平均終局 ${sec(avg(f))}、中位 ${sec(med(f))}、拖滿 30 秒的占 ${pc(f.filter(x => x >= 1800).length / games.length)}、10 秒內就結束的占 ${pc(f.filter(x => x <= 600).length / games.length)}`);
  const k = games.map(g => g.kills[0] + g.kills[1]), s = games.map(g => g.shots[0] + g.shots[1]);
  const d = games.map(g => g.damage[0] + g.damage[1]), sv = games.map(g => g.survivors[0] + g.survivors[1]);
  const pl = games.map(g => g.pool[0] + g.pool[1]);
  console.log(`  每場交換：擊殺 ${avg(k).toFixed(1)}（藍 ${avg(games.map(g => g.kills[0])).toFixed(1)}／紅 ${avg(games.map(g => g.kills[1])).toFixed(1)}）｜開火 ${avg(s).toFixed(1)}｜對敵傷害 ${avg(d).toFixed(0)}｜結束時在場 ${avg(sv).toFixed(1)} 台｜剩兵力池 ${avg(pl).toFixed(1)}`);
  console.log(`  每分鐘：擊殺 ${(avg(k) / (avg(f) / FPS) * 60).toFixed(1)} 台｜傷害 ${(avg(d) / (avg(f) / FPS) * 60).toFixed(0)}`);
  // 「每 1 台擊殺要開幾發」＝1／命中率。這一項把「開了火但打不掉」那種病單獨隔出來，
  // 因為它跟「有沒有接觸」無關：亂槍的隊伍開火數很高、擊殺卻上不去。
  console.log(`  火力效率：每 1 台擊殺要開 ${(avg(s) / Math.max(0.001, avg(k))).toFixed(1)} 發（藍 ${(avg(games.map(g => g.shots[0])) / Math.max(0.001, avg(games.map(g => g.kills[0])))).toFixed(1)}／紅 ${(avg(games.map(g => g.shots[1])) / Math.max(0.001, avg(games.map(g => g.kills[1])))).toFixed(1)}）`);
  console.log(`  接觸度（對峙幀裡兩隊最近車的距離）：≤${DUEL}px ${pc(avg(games.map(g => g.duelPct)))}｜≤${NEAR}px ${pc(avg(games.map(g => g.nearPct)))}｜≤${RANGE}px ${pc(avg(games.map(g => g.rangePct)))}`);
  console.log(`  全場最近距離的中位：${px(med(games.map(g => g.minContact)))}｜藍隊最接近紅鷹：${px(med(games.map(g => g.minToEagle)))}`);
  console.log(`  互射幀占比 ${pc(avg(games.map(g => g.exPct)))}｜包圍紅鷹（≥2 台進 ≤${ASSAULT}px）幀占比 ${pc(avg(games.map(g => g.siegePct)))}｜雙方都在場的幀占比 ${pc(avg(games.map(g => g.onFieldPct)))}`);
  console.log(`  適應度：藍 ${avg(games.map(g => g.score[0])).toFixed(1)}／紅 ${avg(games.map(g => g.score[1])).toFixed(1)}`);
}

console.log(`激烈度探針：每模式 ${N} 局，同一組考題（地圖 0..${R.MAP_VARIANTS - 1} 輪迴 × 固定種子）`);
const byMode = {};
for (const mode of ['model', 'rule', 'mixed']) {
  byMode[mode] = [];
  for (let i = 0; i < N; i++) {
    byMode[mode].push(runOne(mode, i));
    if ((i + 1) % 40 === 0) process.stdout.write(`  ${mode} ${i + 1}/${N}\n`);
  }
  report(mode, byMode[mode]);
}

/* 成對差異：同一考題下，「模型上場」比「老師自己打」激烈多少（正＝模型更激烈） */
const pair = (a, b, key) => avg(b.map(key)) - avg(a.map(key));
console.log('\n【成對差異】同一批考題，model 減 rule：');
for (const [label, key] of [
  ['擊殺／場', g => g.kills[0] + g.kills[1]],
  ['開火／場', g => g.shots[0] + g.shots[1]],
  ['對敵傷害／場', g => g.damage[0] + g.damage[1]],
  ['終局秒', g => g.frames / FPS],
  ['≤40px 格鬥幀占比', g => g.duelPct],
  ['互射幀占比', g => g.exPct],
  ['包圍紅鷹幀占比', g => g.siegePct],
  ['沒決出勝負的比例', g => (g.end === 'time' || g.end === 'pool' ? 1 : 0)],
]) {
  const dv = pair(byMode.rule, byMode.model, key);
  console.log(`  ${label.padEnd(18)} ${dv >= 0 ? '+' : ''}${Math.abs(dv) < 1 ? dv.toFixed(3) : dv.toFixed(1)}`);
}
