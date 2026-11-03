/* audit-walls.js — 診斷腳本：逐幀比對「拆牆事件」「要塞牆现存格數」「鏟子」
   目的：arena 的 foeWallNear／foeWallFar（事件總量）跟結算用的 foeWallLost
   （现存差分）對不上時，要分得清是事件漏記、歸因記錯，還是鏟子把牆還原了。
   跑法：node audit-walls.js [stage] [seed] */
'use strict';
const { Arena } = require('./ai/arena');

const stage = Number(process.argv[2] ?? 5);
const seed = Number(process.argv[3] ?? 4242);

const a = new Arena();
const G = a.game, R = a.R;

const ringHoles = id => G.map.bases[id].ring
  .filter(([cx, cy]) => G.map.cells[cy][cx] === 0)
  .map(([cx, cy]) => `${cx},${cy}`);
const alive = id => G.map.bases[id].ring.length - ringHoles(id).length;

const events = [];
let frame = 0;
let shovelLog = [];

const origRecord = G.recordWallHit.bind(G);
G.recordWallHit = (b, cells) => {
  const before = (G.wallEvents || []).length;
  origRecord(b, cells);
  const list = G.wallEvents || [];
  for (let i = before; i < list.length; i++) {
    const ev = list[i];
    const c = { x: (G.map.bases[ev.baseIndex].cx + 1) * R.CELL,
      y: (G.map.bases[ev.baseIndex].cy + 1) * R.CELL };
    events.push({ f: frame, team: ev.team, base: ev.baseIndex, cells: ev.keys,
      dist: Math.round(Math.hypot(ev.fireX - c.x, ev.fireY - c.y)),
      near: R.EnemyAI.baseWithin({ x: ev.fireX, y: ev.fireY }, c, R.AI_ASSAULT_RADIUS) });
  }
};

// 鑊子要包在 prototype 上：startDemo 每輪都 new GameMap，包在當時那個實例上會失效。
for (const name of ['shovelOn', 'shovelOff']) {
  const fn = R.GameMap.prototype[name];
  R.GameMap.prototype[name] = function (...args) {
    shovelLog.push({ f: frame, key: name, arg: args[0] });
    return fn.apply(this, args);
  };
}

const engineStep = a.engine.step.bind(a.engine);
let lastAlive = null;
const diffs = [];
a.engine.step = (n) => {
  const r = engineStep(n);
  for (let k = 0; k < n; k++) {
    frame++;
    if (!G.map || !G.map.bases || G.map.bases.length < 2) { lastAlive = null; continue; }
    const now = [alive(0), alive(1)];
    if (lastAlive && (now[0] !== lastAlive[0] || now[1] !== lastAlive[1])) {
      diffs.push({ f: frame, now, prev: lastAlive,
        holes: [ringHoles(0).join(' '), ringHoles(1).join(' ')] });
    }
    lastAlive = now;
  }
  return r;
};

const rep = a.run({ stage, seed, blue: 'rule', red: 'rule' });
console.log(`stage ${stage}／seed ${seed}｜end ${rep.end}／幀 ${rep.frames}` +
  `｜事件 ${events.length} 筆`);
for (const e of events)
  console.log(`  幀 ${e.f}：隊 ${e.team} 拆要塞 ${e.base} 的 ${e.cells.length} 格［${e.cells.join(' ')}］｜離該鷹 ${e.dist}px → ${e.near ? '近' : '遠'}`);
console.log('现存變化（含鏟子還原）：');
for (const d of diffs)
  console.log(`  幀 ${d.f}：藍 ${d.prev[0]}→${d.now[0]}／紅 ${d.prev[1]}→${d.now[1]}` +
    `｜藍洞 ${d.holes[0]}｜紅洞 ${d.holes[1]}`);
console.log('鏟子：', JSON.stringify(shovelLog));
// 去重後「真的拆過幾格」：同一個要塞的同一格只算一次，跟 arena 的 wallSeen 同一條規則。
// 只算打進「對方要塞」的事件（arena 也這樣過濾：打自家牆不記進 foeWall）。
for (const t of [0, 1]) {
  const foe = 1 - t;
  const uniq = new Set();
  let raw = 0;
  for (const e of events) {
    if (e.team !== t || e.base !== foe) continue;
    raw += e.cells.length;
    for (const k of e.cells) uniq.add(e.base + ':' + k);
  }
  console.log(`隊 ${t} 拆敵牆：事件原始 ${raw} 格／去重後 ${uniq.size} 格`);
}
console.log('報告：藍 near', rep.teams[0].foeWallNear, 'far', rep.teams[0].foeWallFar,
  'foeWallLost', rep.teams[0].foeWallLost, 'ownLost', rep.teams[0].ownBaseCellsLost);
console.log('　　　紅 near', rep.teams[1].foeWallNear, 'far', rep.teams[1].foeWallFar,
  'foeWallLost', rep.teams[1].foeWallLost, 'ownLost', rep.teams[1].ownBaseCellsLost);
