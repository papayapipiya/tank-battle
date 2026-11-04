/* measure-termsigma.js — 逐項「選得動嗎」探針（尺上每一項先量它有沒有梯度，再決定要不要動它）
   目的：激烈度驗收沒過，但尺已經把 speed 壓到榜外，所以要問的不是「哪項分高」，
   而是「哪項分在族群裡根本不動」——一項如果每局都發同樣的數（σ≈0）或每局都踩滿，
   它在選擇上就是常數，等於沒有那一項。
   跑法：node measure-termsigma.js [局數，預設 24]
   ⚠ 唯讀：只讀 ai/trained-*.json，不寫任何檔案（可以在訓練旁邊跑）。
   考題與 audit-intensity.js／measure-breach.js 同一組：stage = i % 255、seed = 30000 + 977i。
*/
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.basename(__dirname) === 'runs' ? path.join(__dirname, '..') : __dirname;
const { Arena } = require(path.join(ROOT, 'ai/arena'));
const { Genome } = require(path.join(ROOT, 'ai/neat'));
const F = require(path.join(ROOT, 'ai/fitness'));

const N = Number(process.argv[2] || 24);
const arena = new Arena({ maxFrames: 2400 });
const R = arena.R;

function seatOf(role) {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'ai', `trained-${role}.json`), 'utf8'));
  if (j.role !== role) throw new Error(`trained-${role}.json 席位是 ${j.role}`);
  return { kind: 'policy', policy: Genome.fromJSON(j.genome).toPolicy(), gen: j.generation };
}
const BLUE = seatOf('attack'), RED = seatOf('defense');
console.log(`逐項 σ 探針：藍＝進攻模型 第${BLUE.gen}代／紅＝防守模型 第${RED.gen}代，` +
  `${N} 局（算分 v${F.SCORING_VERSION}，考題同 audit-intensity）`);

const samples = { attack: {}, defense: {} };
const frames = [], killsAll = [], shotsAll = [];
for (let i = 0; i < N; i++) {
  const rep = arena.run({ stage: i % R.MAP_VARIANTS, seed: 30000 + i * 977, blue: BLUE, red: RED });
  frames.push(rep.frames);
  killsAll.push(rep.teams[0].kills + rep.teams[1].kills);
  shotsAll.push(rep.teams[0].shots + rep.teams[1].shots);
  for (const [id, role] of [[0, 'attack'], [1, 'defense']]) {
    const out = F.scoreOf(rep.teams[id], rep, id, { role, maxFrames: 2400 });
    for (const row of out.rows || []) {
      const b = (samples[role][row.key] = samples[role][row.key] || { money: [], raw: [], weight: row.weight });
      b.money.push(Number(row.contribution) || 0);
      b.raw.push(Number(row.value) || 0);
    }
  }
}
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))); };
const med = a => { const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

console.log(`局長：中位 ${(med(frames) / 60).toFixed(1)}s、平均 ${(mean(frames) / 60).toFixed(1)}s、` +
  `10 秒內 ${(100 * frames.filter(f => f <= 600).length / N).toFixed(1)}%`);
console.log(`交換：每場擊殺 ${mean(killsAll).toFixed(1)}（中位 ${med(killsAll).toFixed(1)}）、` +
  `開火 ${mean(shotsAll).toFixed(1)}、每 1 殺 ${(mean(shotsAll) / Math.max(0.001, mean(killsAll))).toFixed(1)} 發`);

for (const role of ['attack', 'defense']) {
  const rows = Object.entries(samples[role]).map(([k, b]) => {
    const m = mean(b.money);
    // 「踩滿」讀的是未加權的 value（0..1）：這一項的門是否每局都開到底；
    // 「零分」讀的是 contribution，罰分項每局都罰滿也算踩滿。
    const full = b.raw.filter(v => Math.abs(Math.abs(v) - 1) < 1e-9).length / b.raw.length;
    const zero = b.money.filter(v => Math.abs(v) < 1e-9).length / b.money.length;
    return { k, w: b.weight, mean: m, sd: sd(b.money), full, zero };
  }).sort((a, b) => Math.abs(b.mean) - Math.abs(a.mean));
  console.log(`\n【${role}】逐項（依｜均值｜排序）  項＝每次貢獻的分｜σ（同局间的離散）｜踩滿率｜零分率`);
  for (const r of rows) {
    if (Math.abs(r.mean) < 0.05 && r.zero > 0.98) continue;
    const dead = (r.sd < 0.5 || r.full >= 0.95) ? '  ← 選擇上等於常數' : '';
    console.log('  ' + r.k.padEnd(15) + r.mean.toFixed(2).padStart(8) +
      '｜σ ' + r.sd.toFixed(2).padStart(6) + '｜踩滿 ' + (100 * r.full).toFixed(0).padStart(3) + '%' +
      '｜零分 ' + (100 * r.zero).toFixed(0).padStart(3) + '%' + dead);
  }
}
