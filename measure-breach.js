/* measure-breach.js — 新戰場幾何下的實測破局率
   ═══════════════════════════════════════════════════════════
   為什麼要跑這支：30 秒進攻倒數（`DEMO_ATTACK_SECONDS`）是在 26×26 正方形
   戰場上定的，兩隊家門口當時隔 184px；換成 18×42 的 9:21 直立長場之後是
   312px。距離多了 70%，「規則 AI 來不來得及在 30 秒內打爆紅鷹」是一個
   **必須量**的數字——不能靠直覺改倒數秒數，也不能只看「測試有沒有紅」。

   這支唯讀：不改規則、不寫 checkpoint、不碰即時看板資料。
   跑 N 局（每局一張不同的隨機地圖，跟訓練端同一條 `arena.run` 路徑），
   統計終局種類、破局所用的幀數、以及倒數內完成的比率。

   跑法：node measure-breach.js [局數，預設 120]
   ═══════════════════════════════════════════ */
'use strict';

const { Arena } = require('./ai/arena');

const GAMES = Number(process.argv[2] || 120);
const arena = new Arena();
const R = arena.R;
const ATTACK_FRAMES = R.DEMO_ATTACK_SECONDS * R.TARGET_FPS;

const tally = {};
const byMap = new Map();
let framesSum = 0, cappedCount = 0;
const breachFrames = [];

for (let i = 0; i < GAMES; i++) {
  const stage = i % R.MAP_VARIANTS;
  const r = arena.run({ stage, seed: 30000 + i * 977 });
  tally[r.end] = (tally[r.end] || 0) + 1;
  framesSum += r.frames;
  if (r.capped) cappedCount++;
  if (r.end === 'breach') breachFrames.push(r.frames);
  const m = byMap.get(r.stage) || { games: 0, breach: 0, held: 0 };
  m.games++;
  if (r.end === 'breach') m.breach++; else m.held++;
  byMap.set(r.stage, m);
  process.stdout.write('.');
}
console.log('');

const pct = n => (100 * n).toFixed(1) + '%';
console.log(`\n局數 ${GAMES}｜每局一張不同的隨機地圖（共 ${R.MAP_VARIANTS} 張）`);
console.log(`場均 ${(framesSum / GAMES).toFixed(0)} 幀｜無頭引擎保險絲斷掉（capped）${cappedCount} 局`);
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1]))
  console.log(`  ${String(k).padEnd(8)} ${String(v).padStart(4)}  ${pct(v / GAMES)}`);

const breach = tally.breach || 0;
console.log(`\n藍隊（進攻席）實測破局率：${pct(breach / GAMES)}｜紅隊取勝（time／pool／counter）：` +
  `${pct(((tally.time || 0) + (tally.pool || 0) + (tally.counter || 0)) / GAMES)}`);
if (breachFrames.length) {
  const s = breachFrames.slice().sort((a, b) => a - b);
  const within = s.filter(f => f <= ATTACK_FRAMES).length;
  console.log(`破局用的幀數：中位 ${s[Math.floor(s.length / 2)]}（${(s[Math.floor(s.length / 2)] / R.TARGET_FPS).toFixed(1)} 秒）` +
    `、最快 ${s[0]}、最慢 ${s[s.length - 1]}`);
  console.log(`⚠ 口徑：倒數 ${R.DEMO_ATTACK_SECONDS} 秒（=${ATTACK_FRAMES} 幀）從 DEMO_INTRO 結束才開始計，` +
    `而這裡的 frames 含開場那 ~70 幀前置 → 理論上限 ${ATTACK_FRAMES} + 前置。` +
    `超過 ${ATTACK_FRAMES} 的 ${breachFrames.length - within} 局就是那段前置，不是「倒數之後還在打」。`);
}
const maps = [...byMap.values()];
const withBreach = maps.filter(m => m.breach > 0).length;
console.log(`\n${byMap.size} 張地圖裡 ${withBreach} 張至少破過一次局（${pct(withBreach / byMap.size)}）；` +
  `每張圖平均 ${(maps.reduce((a, m) => a + m.games, 0) / byMap.size).toFixed(1)} 局 —— ` +
  `單張圖的破局率樣本太小，只能看整體。`);
