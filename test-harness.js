/* test-harness.js — tank-battle 無頭回歸測試（新架構）
   Node 模擬瀏覽器環境，載入真實遊戲碼驅動幀與按鍵。
   Run:  node test-harness.js
*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ── Browser stubs ──
const listeners = {};
const rafQueue = [];
let ts = 0;

function makeCtx2D() {
  return new Proxy({}, {
    get(t, prop) { return (...a) => {}; },
    set() { return true; },
  });
}
function makeCanvas() {
  return { width: 0, height: 0, getContext: () => makeCtx2D() };
}
const mainCanvas = makeCanvas();
const fakeEl = () => ({ textContent: '', innerHTML: '', style: {} });
const storage = {};

const sandbox = {
  console, Math, JSON, Date, Object, Array,
  performance: { now: () => ts },
  requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
  localStorage: {
    getItem: (k) => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.document = {
  getElementById: (id) => (id === 'gameCanvas' ? mainCanvas : fakeEl()),
  createElement: (tag) => (tag === 'canvas' ? makeCanvas() : fakeEl()),
};
sandbox.addEventListener = (type, fn) => { (listeners[type] ||= []).push(fn); };
vm.createContext(sandbox);

// ── Drivers ──
sandbox.__drive = {
  frames(n) {
    for (let i = 0; i < n; i++) {
      ts += 17;
      const f = rafQueue.shift();
      if (f) f(ts);
    }
  },
  keyDown(k) { (listeners.keydown || []).forEach(fn => fn({ key: k, preventDefault() {} })); },
  keyUp(k)   { (listeners.keyup || []).forEach(fn => fn({ key: k, preventDefault() {} })); },
  press(k)   { this.keyDown(k); this.frames(1); this.keyUp(k); this.frames(1); },
};

// ── Load game scripts in index.html order ──
const files = [
  'constants.js', 'input.js', 'audio.js', 'sprites.js', 'stages.js', 'map.js',
  'entities.js', 'ai.js', 'powerups.js', 'renderer.js', 'game.js',
];
const src = files
  .map(f => fs.readFileSync(path.join(__dirname, 'js', f), 'utf8'))
  .join('\n;\n');

const tests = `
(function () {
  let pass = 0, fail = 0;
  function T(name, cond) {
    if (cond) { pass++; console.log('PASS  ' + name); }
    else      { fail++; console.log('FAIL  ' + name); }
  }
  const D = window.__drive;

  // ── boot → TITLE ──
  D.frames(2);
  const G = window.__game;
  T('boot: TITLE', G.state === 'title');

  // ── Enter → STAGE_INTRO → PLAYING ──
  D.press('Enter');
  T('enter: STAGE_INTRO', G.state === 'stage_intro');
  D.frames(T_STAGES_INTRO = 95);
  T('intro over: PLAYING', G.state === 'playing');

  // ── 暫停/恢復（soft-lock 回歸）──
  D.press('p');
  T('pause', G.state === 'paused');
  D.frames(5);
  T('stays paused', G.state === 'paused');
  D.press('p');
  T('resume', G.state === 'playing');

  // ── 玩家出生無敵結束後可動（往上走，右邊是老鷹磚環）──
  D.frames(65); // spawnTimer 60
  const py0 = G.player.y;
  D.keyDown('w'); D.frames(10); D.keyUp('w');
  T('player moves up', G.player.y < py0);

  // ── 1/4 格削磚：子彈只削掉覆蓋的 8×8 cells ──
  const m1 = new GameMap(0);
  // stage 1 row2: ".##.##.##.##." → tile(1,2)=brick → cells (2..3, 4..5)
  const before = m1.cells[4][2] === 1 && m1.cells[4][3] === 1 &&
                 m1.cells[5][2] === 1 && m1.cells[5][3] === 1;
  T('brick tile present', before);
  // 子彈打在 cell column 2、rows 4-5 交界：box 只覆蓋左半兩格
  m1.bulletHit(2 * 8 + 4, 40, 1);
  T('sub-cell: left column destroyed',
    m1.cells[4][2] === 0 && m1.cells[5][2] === 0);
  T('sub-cell: right column intact',
    m1.cells[4][3] === 1 && m1.cells[5][3] === 1);

  // ── grid-locked 轉向吸附 ──
  const mEmpty = new GameMap(0);
  for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID; c++) mEmpty.cells[r][c] = 0;
  const tk = new Tank(32, 65, DIR.UP, true, {});
  tk.spawnTimer = 0;
  tk.tryMove(DIR.RIGHT, mEmpty, []);
  T('turn snaps y 65 -> 64', tk.y === 64 && tk.dir === DIR.RIGHT);

  // ── 老鷹：坦克不可通行、子彈即毀 ──
  T('base blocks tank', m1.tankBlocked(96, 192));
  const rb = m1.bulletHit(104, 200, 1);
  T('bullet kills base', rb.baseHit && m1.baseDestroyed);

  // ── 冰面滑行：放開按鍵繼續滑，離冰即停（冰設在 G.map 上）──
  for (let cy = 8; cy < 12; cy++) for (let cx = 8; cx < 12; cx++) G.map.cells[cy][cx] = 5;
  G.player.x = 64; G.player.y = 72; // center (72,80) → cell (9,10) ICE
  G.player.spawnTimer = 0;
  G.player.slideDir = DIR.RIGHT;
  G.moveDir = null;
  const ix0 = G.player.x;
  G.updatePlaying();
  T('ice: slides without input', G.player.x > ix0);
  G.player.x = 160; // 離開冰面
  G.updatePlaying();
  const ix1 = G.player.x;
  G.updatePlaying();
  T('ice: stops off ice', G.player.x === ix1);
  G.setupStage(1); G.state = 'playing'; G.player.spawnTimer = 0;

  // ── 鏟子鋼牆還原 ──
  const m2 = new GameMap(0);
  m2.shovelOn();
  T('shovel: ring steel', m2.cells[22][10] === 2 && m2.cells[24][10] === 2 && m2.cells[23][14] === 2);
  m2.shovelOff();
  T('shovel: ring reverts to brick', m2.cells[22][10] === 1 && m2.cells[24][10] === 1);

  // ── 出生點阻擋 ──
  G.enemies = [];
  for (const spx of ENEMY_SPAWNS) {
    const e = new Tank(spx, 0, DIR.DOWN, false, {});
    e.spawnTimer = 0;
    G.enemies.push(e);
  }
  const st0 = G.spawnedTotal;
  G.spawnEnemy();
  T('spawn blocked when occupied', G.spawnedTotal === st0);
  G.enemies = [];

  // ── 擊殺計分 + 閃紅掉道具 + 獎命 ──
  G.iconsLeft = 20; G.score = 19900; G.lives = 3; G.nextExtraLife = 20000;
  const fe = new Tank(32, 32, DIR.DOWN, false, { score: 400, enemyType: 3, hp: 1 });
  fe.flashing = true; fe.spawnTimer = 0;
  G.onEnemyKilled(fe, true);
  T('kill: score +400', G.score === 20300);
  T('kill: icons 20->19', G.iconsLeft === 19);
  T('flash kill drops powerup', G.powerUps.length === 1);
  T('20k extra life', G.lives === 4);
  G.powerUps = [];

  // ── 炸彈：全滅且計入進度 ──
  G.enemies = [];
  for (let i = 0; i < 3; i++) {
    const e = new Tank(16 + i * 32, 16, DIR.DOWN, false, { score: 100, enemyType: 0 });
    e.spawnTimer = 0;
    G.enemies.push(e);
  }
  const sc0 = G.score;
  G.applyPowerUp({ type: POWERUP_TYPE.BOMB });
  T('bomb: all dead', G.enemies.every(e => !e.alive));
  T('bomb: icons 19->16', G.iconsLeft === 16);
  T('bomb: only pickup score', G.score === sc0 + 500);

  // ── 星星升火力 ──
  G.applyPowerUp({ type: POWERUP_TYPE.STAR });
  T('star: firepower 2', G.player.firepower === 2);
  T('star: fast bullets', G.player.shoot([]).speed === 8);

  // ── 玩家死亡重生 ──
  G.lives = 2;
  G.player.firepower = 4;
  G.onPlayerHit();
  T('death: lives 2->1', G.lives === 1);
  T('death: firepower reset', G.player.firepower === 1);
  T('death: respawn shield', G.player.shieldTimer > 0 && G.player.alive);

  // ── 老命用盡 → GAME_OVER → Enter → TITLE ──
  G.lives = 1;
  G.onPlayerHit();
  T('game over', G.state === 'game_over');
  D.press('Enter');
  T('enter: back to TITLE', G.state === 'title');

  // ── 全 35 關驗證 ──
  let stagesOk = true, spawnOk = true;
  for (let i = 0; i < 35; i++) {
    const sm = new GameMap(i);
    for (let dy = 0; dy < 2; dy++)
      for (let dx = 0; dx < 2; dx++)
        if (sm.cells[24 + dy][12 + dx] !== 6) stagesOk = false;
    if (sm.tankBlocked(64, 192)) spawnOk = false;
    for (const spx of [0, 96, 192]) if (sm.tankBlocked(spx, 0)) spawnOk = false;
  }
  T('35 stages: eagle at (12-13,24-25)', stagesOk);
  T('35 stages: all spawn points clear', spawnOk);

  // ── 過關流程 ──
  D.press('Enter'); D.frames(95); // TITLE → PLAYING
  G.iconsLeft = 0; G.enemies = []; G.player.spawnTimer = 0;
  G.updatePlaying();
  T('stage clear state', G.state === 'stage_clear');
  D.frames(185);
  T('next stage intro', G.state === 'stage_intro' && G.stage === 2);

  // ── soak：實戰 900 幀 ──
  D.frames(95);
  let crashed = false;
  try {
    D.keyDown('d'); D.keyDown('j'); D.frames(300);
    D.keyUp('d'); D.keyDown('w'); D.frames(300);
    D.keyUp('w'); D.keyUp('j'); D.keyDown('a'); D.keyDown(' '); D.frames(300);
    D.keyUp('a'); D.keyUp(' ');
  } catch (e) { crashed = true; console.log(e.stack); }
  T('soak: 900 frames no crash', !crashed);
  T('soak: state valid',
    ['title','stage_intro','playing','paused','stage_clear','game_over'].includes(G.state));

  // ══════ A.I. 對戰（觀戰模式）══════
  G.state = 'title'; G.demoMode = false; G.setupStage(1);
  D.press('t');
  T('T: demo_intro', G.state === 'demo_intro');
  T('demo: two bases', G.map.bases.length === 2);
  T('demo: bases bottom+top', G.map.bases[0].cy === 24 && G.map.bases[1].cy === 0);

  let sym = true;
  for (let cy = 0; cy < GRID / 2; cy++)
    for (let cx = 0; cx < GRID; cx++)
      if (G.map.cells[cy][cx] !== G.map.cells[GRID - 1 - cy][cx]) sym = false;
  T('demo: map vertically mirrored', sym);

  let spawnClear = true;
  for (const pts of DEMO_SPAWNS)
    for (const sp of pts) if (G.map.tankBlocked(sp.x, sp.y)) spawnClear = false;
  T('demo: all team spawns clear', spawnClear);
  T('demo: no human player tank', G.player === null);

  D.frames(95);
  T('demo: enters DEMO', G.state === 'demo');
  D.frames(600);
  T('demo: both teams field tanks',
    G.teams[0].tanks.length > 0 && G.teams[1].tanks.length > 0);
  T('demo: team tags consistent',
    G.tanks.every(t => t.team === (t.isPlayer ? TEAM.BLUE : TEAM.RED)));
  T('demo: both pools draining',
    G.teams[0].pool < DEMO_TANKS_PER_TEAM && G.teams[1].pool < DEMO_TANKS_PER_TEAM);
  T('demo: HUD mirrors both sides',
    G.lives > 0 && G.iconsLeft > 0 && G.teams[TEAM.RED].tanks.length > 0);

  let demoFrames = 0;
  while (G.state === 'demo' && demoFrames < DEMO_ROUND_CAP + 5) { G.update(); demoFrames++; }
  T('demo: round resolves', G.state === 'demo_result');
  T('demo: combat happened',
    G.teams[0].kills + G.teams[1].kills > 0 || G.map.bases.some(b => b.dead));
  T('demo: winner is a team or draw',
    G.demoWinner === null || G.demoWinner.id === TEAM.BLUE || G.demoWinner.id === TEAM.RED);

  D.frames(DEMO_RESULT_FRAMES + 5);
  T('demo: auto next round', G.state === 'demo_intro' && G.demoRound === 2);

  D.frames(95);
  D.press('Enter');
  T('demo: Enter back to TITLE', G.state === 'title' && !G.demoMode);
  T('demo: single player restored', !!G.player && G.map.bases.length === 1);

  D.press('t'); D.frames(95);
  let dcrash = false;
  try {
    for (let i = 0; i < 1200; i++) { G.update(); Renderer.tickFx(); }
  } catch (e) { dcrash = true; console.log(e.stack); }
  T('demo soak: 1200 frames no crash', !dcrash);
  T('demo soak: state valid',
    ['demo', 'demo_result', 'demo_intro'].includes(G.state));

  console.log('---');
  console.log(pass + ' passed, ' + fail + ' failed');
  if (fail > 0) throw new Error(fail + ' tests failed');
})();
`;

try {
  vm.runInContext(src, sandbox, { filename: 'bundle.js' });
  (listeners['DOMContentLoaded'] || []).forEach(fn => fn());
  if (!sandbox.__game) { console.error('FATAL: game did not boot'); process.exit(1); }
  vm.runInContext(tests, sandbox, { filename: 'tests.js' });
} catch (e) {
  console.error(e.stack || e);
  process.exit(1);
}
