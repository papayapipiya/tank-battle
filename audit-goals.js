/* audit-goals.js — 診斷腳本：兩席的「行動目標類別」逐幀統計
   目的：G 那顆行為釘子量到紅隊壓進敵半場的比例變高（29.7%）時，要分得清
   這是不是批次五（先打敵車）造成的——把 _goal 每一幀回傳的標籤記下來，
   再按「那幀它在哪個半場」交叉，就知道紅隊那 29.7% 是從 defend／hold／
   還是沒有標籤的巡邏漂過去來的。
   跑法：node audit-goals.js [局數，預設 6] */
'use strict';

const { Arena } = require('./ai/arena');
const { hashSeed } = require('./ai/rng');

const N = Number(process.argv[2] || 6);
const arena = new Arena();
const E = arena.R.EnemyAI;
const mid = arena.R.FIELD_H / 2;

// 每一隊、每個標籤、每個半場各計多少幀。標籤取自 _goal 回傳物件的布林欄位
// （duel／defend／hold／assault／hunt）；回傳 undefined＝這幀沒有目標點（巡邏）。
const tally = {};
const bump = (team, tag, foeHalf) => {
  const k = `${team}|${tag}|${foeHalf ? '敵半場' : '自家半場'}`;
  tally[k] = (tally[k] || 0) + 1;
};

const origGoal = E._goal.bind(E);
E._goal = function (tank, game, duelFoe) {
  const g = origGoal(tank, game, duelFoe);
  const c = tank.center();
  const ownBase = game.ownBaseOf(tank);
  // 「敵半場」按 arena 的同一把尺判：以場高中線切（9:21 之後 FIELD_H/2＝168）。
  const foeHalf = ownBase ? (c.y > mid) === (ownBase.y * 8 + 4 < mid) : false;
  const tag = g ? (g.duel ? 'duel' : g.assault ? 'assault' : g.hunt ? 'hunt'
    : g.hold ? 'hold' : g.defend ? 'defend' : '其他目標點') : '無目標（巡邏）';
  bump(tank.team, tag, foeHalf);
  return g;
};

let blueHalf = 0, redHalf = 0, blueF = 0, redF = 0;
for (let i = 0; i < N; i++) {
  const stage = i % 2, seed = hashSeed(0xb2, stage, i);
  const r = arena.run({ stage, seed, blue: 'rule', red: 'rule', maxFrames: 1200 });
  const bf = r.teams[0].fieldFrames || 1, rf = r.teams[1].fieldFrames || 1;
  blueHalf += (r.teams[0].foeHalfFrames || 0) / bf;
  redHalf += (r.teams[1].foeHalfFrames || 0) / rf;
  blueF += bf; redF += rf;
}

console.log(`局數 ${N}｜藍壓進敵半場 ${(blueHalf / N * 100).toFixed(1)}%／紅 ${(redHalf / N * 100).toFixed(1)}%` +
  `（比值 ${(blueHalf / redHalf).toFixed(2)}×）`);
console.log('逐幀目標類別（team 0＝藍・進攻／1＝紅・防守）：');
for (const k of Object.keys(tally).sort()) console.log(`  ${k.padEnd(26)} ${tally[k]} 幀`);
