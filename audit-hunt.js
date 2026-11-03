/* audit-hunt.js — 診斷腳本：把「追車」接回位移會賠多少破局率（批次五的證據鏈）
   ═══════════════════════════════════════════════════════════
   為什麼還要留這支：批次五初版依使用者那句「坦克攻擊目標＝1. 對方坦克 2. 當接近
   對方主堡」，把追車寫成**位移**的預設目標，結果 240 局實測進攻席破局率從 31.7%
   掉到 18.3%。收斂（只排在去老鷹路上那台）救回 2 個百分點＝誤差內，最後是
   「位移完全不追、打車交給射擊」才回到 31.7%。現行碼裡那條追車已經整條刪除
   （`EnemyAI._nearestLivingFoe` 不存在，有測試釘住），這支腳本負責回答兩件事：
     1. 現在這版到底是不是那個「不追」的檔位（基線應該複現 31.7%）；
     2. 誰想再把它接回去，跑一次就看到代價，不用重新推測。

   ⚠ 唯讀，而且只動**位移層**：包一層 `_goal`，把現行碼回傳的 assault 換成「去追某台車」。
     `_shotTarget`（開槍永遠先挑同軸的車）、`AI_DUEL_RADIUS`（貼身 ≤40px 先解決那台）、
     「敵車進自家牆腳 ≤56px 一律回防」、計分 v11 全部不動 ——
     所以它量的不是「要不要打車」，是「為了打車值得跑多遠」。
   跑法：node audit-hunt.js [每檔局數，預設 240]
   ═══════════════════════════════════════════ */
'use strict';

const { Arena } = require('./ai/arena');
const { scoreOf, ROLES, SCORING_VERSION } = require('./ai/fitness');

const N = Number(process.argv[2] || 240);
const arena = new Arena();
const R = arena.R;
const E = R.EnemyAI;
const HALF = R.FIELD_H / 2;          // 中線 y＝168
const CHASE_PX = R.HALF_FIELD_PX;    // 168px：使用者講的那句「距自己 ≤168px」
const BAND = 24;                     // 中線往對方那側的緩衝（24px＝3 格）
const MAX_FRAMES = 2400;             // 與 evaluatePolicy／balance 同一把尺

const isLive = f => f.alive && !(f.spawnTimer > 0);
function nearest(foes, ok, c) {
  let best = null, bd = Infinity;
  for (const f of foes) {
    if (!isLive(f) || !ok(f)) continue;
    const d = f.distTo(c.x, c.y);
    if (d < bd) { bd = d; best = f; }
  }
  return best;
}
/** 敵車是否已踏進「自己這側的半場～中線一帶」（含中線往對方那側 BAND 的緩衝） */
function crossedMidline(foe, tank) {
  const ownIsBottom = tank.y > HALF;                     // 藍在下（y 大）、紅在上
  return ownIsBottom ? foe.y > HALF - BAND : foe.y < HALF + BAND;
}

/* 每個檔位＝「哪些活敵車算值得去追」；不追（現行）就不包。
   只有現行碼回傳 assault（＝前面幾條優先規則都沒接走這幀）時才會被改成 hunt，
   所以貼身格鬥與回防那兩條不受影響，量出來的差異只屬於「位移要不要去追人」。 */
const VARIANTS = [
  {
    id: '現行（完全不追）',
    note: '位移只認主堡＝批次四的行為；打車交給 _shotTarget 與貼身格鬥。基線。'
  },
  {
    id: '只排背後那台', pick: (c, tank, foes, foeBase) => {
      const myGap = Math.hypot(foeBase.x - c.x, foeBase.y - c.y);
      return nearest(foes, f => f.distTo(foeBase.x, foeBase.y) < myGap, c);
    },
    note: '批次五第一次收斂：離對方主堡比自己遠的那台當沒看到。'
  },
  {
    id: '過中線 或 ≤168px', pick: (c, tank, foes) =>
      nearest(foes, f => crossedMidline(f, tank) || f.distTo(c.x, c.y) <= CHASE_PX, c),
    note: '使用者原話那版：敵車在自家半場～中線一帶、或離自己 ≤168px 才追。'
  },
  {
    id: '只追過中線的', pick: (c, tank, foes) => nearest(foes, f => crossedMidline(f, tank), c),
    note: '只有真的壓進自家半場那台才算威脅；對方門口那幾台一律不追。'
  },
  {
    id: '無限追（批次五初版）', pick: (c, tank, foes) => nearest(foes, () => true, c),
    note: '場上最近那台，多遠都去 —— 已知會追掉破局率的對照組。'
  }
];

const origGoal = E._goal;
const rows = [];

for (const v of VARIANTS) {
  let huntFrames = 0, goalFrames = 0;
  E._goal = function (tank, game, duelFoe) {
    let g = origGoal.call(this, tank, game, duelFoe);
    // 只動進攻席：把「壓堡」那個目標點換成「去追某台車」，其餘優先級原封不動。
    if (v.pick && tank.team === 0 && g && g.assault) {
      const foeBase = game.foeBaseOf(tank);
      if (!this._foeBaseClose(tank, foeBase)) {          // 已到家門口就別把人拉開
        const foe = v.pick(tank.center(), tank, game.foesOf(tank), foeBase);
        if (foe) g = { x: foe.x, y: foe.y, hunt: true };
      }
    }
    if (tank.team === 0) { goalFrames++; if (g && g.hunt) huntFrames++; }
    return g;
  };
  let breach = 0, scoreSum = 0, kills = 0, deaths = 0, wall = 0;
  let defScore = 0, held = 0, intercept = 0;
  for (let i = 0; i < N; i++) {
    const rep = arena.run({ stage: i % R.MAP_VARIANTS, seed: 30000 + i * 977 });
    if (rep.end === 'breach' && rep.winner === 0) breach++;
    const blue = scoreOf(rep.teams[0], rep, 0, { role: ROLES.ATTACK, maxFrames: MAX_FRAMES });
    scoreSum += blue.final;
    kills += rep.teams[0].kills; deaths += rep.teams[0].deaths;
    wall += (rep.teams[0].foeWallNear || 0) + (rep.teams[0].foeWallFar || 0);
    const red = scoreOf(rep.teams[1], rep, 1, { role: ROLES.DEFENSE, maxFrames: MAX_FRAMES });
    defScore += red.final;
    if (rep.end !== 'breach') held++;                 // 沒被破網＝守成本業
    intercept += (rep.teams[1].baseDefenseDamage || 0) + (rep.teams[1].halfDefenseDamage || 0);
    process.stdout.write('.');
  }
  rows.push({
    v, breach: breach / N, huntShare: huntFrames / Math.max(1, goalFrames),
    score: scoreSum / N, kd: `${(kills / N).toFixed(1)}/${(deaths / N).toFixed(1)}`,
    wall: wall / N, defScore: defScore / N, held: held / N, intercept: intercept / N
  });
}
E._goal = origGoal;

console.log('\n');
console.log(`追車範圍檔位對照｜每檔 ${N} 局（同一批地圖與種子）｜算分 v${SCORING_VERSION}`);
console.log('  檔位'.padEnd(24) + '破局率   hunt幀占比  進攻均分  擊殺/陣亡   拆牆格  守成率   攔截hp 防守均分 兩席比');
for (const r of rows) {
  console.log('  ' + r.v.id.padEnd(26) +
    (r.breach * 100).toFixed(1).padStart(5) + '%  ' +
    (r.huntShare * 100).toFixed(1).padStart(7) + '%  ' +
    r.score.toFixed(2).padStart(8) + '  ' + r.kd.padStart(9) + '  ' +
    r.wall.toFixed(2).padStart(6) + '  ' +
    (r.held * 100).toFixed(1).padStart(5) + '%  ' +
    r.intercept.toFixed(1).padStart(6) + '  ' +
    r.defScore.toFixed(2).padStart(8) + '  ' +
    (r.defScore / Math.max(0.01, r.score)).toFixed(2));
}
console.log('\n各檔位的定義：');
for (const r of rows) console.log('  ' + r.v.id.padEnd(26) + r.v.note);
const se = Math.sqrt(0.25 / N) * 100;
console.log(`\n⚠ 每檔 ${N} 局的破局率標準誤最多約 ±${se.toFixed(1)} 個百分點：` +
  `要認的差距得大於這個數（10 個百分點夠，3 個不夠）。`);
console.log('讀法：破局率是進攻席的本業，hunt 幀占比＝位移有多少花在追人而非壓堡；' +
  '「兩席比」＝防守均分／進攻均分，愈接近 1 就是 BALANCE-RESEARCH 那條主軸要的起步平衡。');
