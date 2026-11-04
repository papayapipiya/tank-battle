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
// （stages.js 已經退了場：地形改由 mapgen.js 依 mapId 生成，順序要跟 index.html 一致）
const files = [
  'constants.js', 'input.js', 'audio.js', 'sprites.js', 'mapgen.js', 'map.js',
  'entities.js', 'ai.js', 'powerups.js', 'renderer.js', 'game.js',
];
const src = files
  .map(f => fs.readFileSync(path.join(__dirname, 'js', f), 'utf8'))
  .join('\n;\n');

const tests = `
(function () {
  let pass = 0, fail = 0;
  // extra 是診斷字串：這條以前只印 PASS/FAIL，偶發失敗時看不到現場
  // （state、demoRound、reason 全部沒留），只能靠猜。現在失敗就把手動
  // 傳進去的快照印出來，下次再紅一眼就能定位。
  function T(name, cond, extra) {
    if (cond) { pass++; console.log('PASS  ' + name); }
    else {
      fail++;
      console.log('FAIL  ' + name + (extra !== undefined ? '  ⟨' + extra + '⟩' : ''));
    }
  }
  const D = window.__drive;

  // ══════ 新幾何（18×42／9:21／隨機地形）的測試工具 ══════
  // 地形從「35 張手刻關卡」改成 mapgen 依 mapId 生成之後，任何
  // 「(r,c) 這一格一定是磚」那種寫死座標的斷言都撐不過換一張圖。
  // 所以幾何類測試一律改寫成兩種寫法：
  //   ① 不變量：要塞牆 20 格、點對稱 756 格、出生點淨空、開路走得通……
  //      這些對 255 張圖全部成立，換圖不會紅。
  //   ② 需要精確地形時（彈道、格鬥節奏），先把圖清空再自己蓋一個靶場，
  //      不要拿隨機圖去賭「這一列剛好是空的」。
  const blankMap = m => {
    for (let cy = 0; cy < GRID_H; cy++)
      for (let cx = 0; cx < GRID_W; cx++) m.cells[cy][cx] = CELL_TYPE.EMPTY;
    return m;
  };
  /** 蓋一個 tile（1 tile = 2×2 cells；坦克剛好也是 2×2） */
  const setTile = (m, tc, tr, v) => {
    for (let dy = 0; dy < 2; dy++)
      for (let dx = 0; dx < 2; dx++) m.cells[tr * 2 + dy][tc * 2 + dx] = v;
  };
  const setAll = (m, v) => {
    for (let cy = 0; cy < GRID_H; cy++)
      for (let cx = 0; cx < GRID_W; cx++) m.cells[cy][cx] = v;
    return m;
  };
  /** 乾淨靶場：整張圖全空，只有兩座要塞（藍＝底邊、紅＝頂邊） */
  const rangeMap = () => {
    const m = new GameMap(0);
    blankMap(m);
    m.bases = [];
    m._addBase(BASE_CELL_X, BASE_CELL_Y, false);                                  // bases[0] = 藍（下）
    m._addBase(DEMO_BASE_CELLS[TEAM.RED].cx, DEMO_BASE_CELLS[TEAM.RED].cy, true); // bases[1] = 紅（上）
    return m;
  };
  /** tile 級 BFS：坦克是 2×2 cells，用 cell 找路會得到「車開不過去的隧道」 */
  const tileReachAny = (m, from, targets) => {
    const goal = new Set(targets.map(([c, r]) => r * TILE_W + c));
    const seen = new Set([from[1] * TILE_W + from[0]]);
    const q = [from];
    while (q.length) {
      const [c, r] = q.shift();
      if (goal.has(r * TILE_W + c)) return true;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nc >= TILE_W || nr < 0 || nr >= TILE_H) continue;
        const k = nr * TILE_W + nc;
        if (seen.has(k) || !MapGen.tileOpen(m.cells, nc, nr)) continue;
        seen.add(k); q.push([nc, nr]);
      }
    }
    return false;
  };
  /** 攻到對面要塞門口：老鷹那一 tile 排的內側兩格之外（與 map.js 的 approach 同式） */
  const approachTiles = b => {
    const tr = b.cy / 2 + (b.rot ? 2 : -2);
    const out = [];
    for (let c = Math.floor((b.cx - 2) / 2); c <= Math.floor((b.cx + 3) / 2); c++) out.push([c, tr]);
    return out;
  };
  const cellsOf = m => m.cells.map(row => row.join('')).join('/');

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
  // 以前這一段直接讀手刻 stage 1 的 ".##.##.##.##."；地形隨機化之後那一格
  // 是不是磚取決於 mapId，斷言會變成擲硬幣。改成自己蓋一個磚 tile 再打半格。
  const m1 = new GameMap(0);
  blankMap(m1);
  setTile(m1, 1, 2, CELL_TYPE.BRICK);      // tile(1,2) → cells x 2..3、y 4..5
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
  const mEmpty = blankMap(new GameMap(0));
  const tk = new Tank(32, 65, DIR.UP, true, {});
  tk.spawnTimer = 0;
  tk.tryMove(DIR.RIGHT, mEmpty, []);
  T('turn snaps y 65 -> 64', tk.y === 64 && tk.dir === DIR.RIGHT);

  // ── 死角不原地旋轉：四面全堵住時，AI 應保持同一個朝向 ──
  // 舊行為：_pickDirection 在無路可走時回傳 opposite，tryMove 又走不動，
  // 下一幀再轉回去 → 每幀 180° 翻面（實測可連轉 9～11 幀）。
  const mBox = setAll(new GameMap(0), CELL_TYPE.STEEL);
  for (let cy = 4; cy < 6; cy++) for (let cx = 4; cx < 6; cx++) mBox.cells[cy][cx] = 0;
  const boxTank = new Tank(32, 32, DIR.UP, false, {});
  boxTank.spawnTimer = 0;
  boxTank.aiShootTimer = 999999;
  const boxGame = {
    map: mBox,
    foesOf: () => [], ownBaseOf: () => null, foeBaseOf: () => null,
    allTanks: () => [boxTank], frozenFor: () => false, bullets: [],
  };
  const boxDirs = new Set();
  for (let i = 0; i < 20; i++) {
    EnemyAI.update(boxTank, boxGame);
    boxDirs.add(boxTank.dir);
  }
  T('boxed AI: no in-place spinning', boxDirs.size === 1 &&
    boxTank.x === 32 && boxTank.y === 32);

  // ── 老鷹：坦克不可通行、子彈即毀 ──
  // 座標從常數推，不寫死：老鷹現在在 cell (BASE_CELL_X, BASE_CELL_Y) = (8,40)。
  const bm = new GameMap(0);
  const bb = bm.bases[0];
  T('base blocks tank', bm.tankBlocked(bb.cx * CELL, bb.cy * CELL));
  const rb = bm.bulletHit((bb.cx + 1) * CELL, (bb.cy + 1) * CELL, 1);
  T('bullet kills base', rb.baseHit && bm.baseDestroyed);

  // ── 冰面滑行：放開按鍵繼續滑，離冰即停（冰設在 G.map 上）──
  for (let cy = 8; cy < 12; cy++) for (let cx = 8; cx < 12; cx++) G.map.cells[cy][cx] = 5;
  G.player.x = 64; G.player.y = 72; // center (72,80) → cell (9,10) ICE
  G.player.spawnTimer = 0;
  G.player.slideDir = DIR.RIGHT;
  G.moveDir = null;
  const ix0 = G.player.x;
  G.updatePlaying();
  T('ice: slides without input', G.player.x > ix0);
  G.player.x = 120; // 離開冰面（FIELD_W=144，坦克最右只能到 128）
  G.updatePlaying();
  const ix1 = G.player.x;
  G.updatePlaying();
  T('ice: stops off ice', G.player.x === ix1);
  G.setupStage(1); G.state = 'playing'; G.player.spawnTimer = 0;

  // ── 鏟子鋼牆還原 ──
  // 以前點名 cells[22][10] 那一格（手刻關卡的固定牆位）。要塞牆現在由
  // GameMap.ringCells 算出來，所以改成「ring 的每一格都要變鋼、還要變回磚」
  // —— 這比逐格寫死更嚴：少蓋一格就會紅。
  const m2 = new GameMap(0);
  const ring2 = m2.bases[0].ring;
  T('fortress ring has 20 cells', ring2.length === 20);
  T('fortress ring is brick at load',
    ring2.every(([rx, ry]) => m2.cells[ry][rx] === CELL_TYPE.BRICK));
  m2.shovelOn();
  T('shovel: ring steel', ring2.every(([rx, ry]) => m2.cells[ry][rx] === CELL_TYPE.STEEL));
  m2.shovelOff();
  T('shovel: ring reverts to brick',
    ring2.every(([rx, ry]) => m2.cells[ry][rx] === CELL_TYPE.BRICK));

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

  // ══════ 隨機地形產生器（取代 35 張手刻關卡）══════
  // 使用者要「地圖隨機」。實作是 mapId → 固定種子 → 固定地形，
  // 所以這裡驗的是「每一張圖都要成立的不變量」，不是某一張圖長什麼樣。
  console.log('-- mapgen invariants');
  const IDS = [];
  for (let i = 0; i < 24; i++) IDS.push(i);
  IDS.push(100, 199, 250, MAP_VARIANTS - 1);

  let eagleOk = true, ringOk = true, spawnOk = true, symOk = true, routeOk = true;
  let tileAlignedOk = true, densityMin = 1, densityMax = 0;
  const sigs = new Set();
  for (const id of IDS) {
    const sm = new GameMap(id, { demo: true });
    sigs.add(cellsOf(sm));

    // ① 兩座老鷹 2×2 完好，位置就是常數說的那兩處
    for (const b of sm.bases)
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++)
          if (sm.cells[b.cy + dy][b.cx + dx] !== CELL_TYPE.BASE) eagleOk = false;
    if (sm.bases.length !== 2 || sm.bases[TEAM.BLUE].cy !== BASE_CELL_Y ||
        sm.bases[TEAM.RED].cy !== 0) eagleOk = false;

    // ② 要塞牆 20 格全在（開路不準挖自家牆，挖穿了防守方就無家可守）
    for (const b of sm.bases)
      for (const [rx, ry] of b.ring)
        if (sm.cells[ry][rx] !== CELL_TYPE.BRICK) ringOk = false;

    // ③ 八個出生點淨空（坦克 16×16，卡在自己出生點等於開局少一台）
    for (const team of DEMO_SPAWNS)
      for (const sp of team) if (sm.tankBlocked(sp.x, sp.y)) spawnOk = false;

    // ④ 180° 點對稱：全部 756 格逐格比 ⇒ 兩隊面對的地形幾何完全等價
    for (let cy = 0; cy < GRID_H; cy++)
      for (let cx = 0; cx < GRID_W; cx++)
        if (sm.cells[cy][cx] !== sm.cells[GRID_H - 1 - cy][GRID_W - 1 - cx]) symOk = false;

    // ⑤ 開路是真路：每一個出生 tile 都要能以 tile 級走到「對面要塞門口」。
    //    隨機圖偶爾會長出封死的口袋，那種局只有 time 一個結果。
    for (const sp of DEMO_SPAWNS[TEAM.BLUE])
      if (!tileReachAny(sm, [sp.x / TILE_PX, sp.y / TILE_PX], approachTiles(sm.bases[TEAM.RED])))
        routeOk = false;
    for (const sp of DEMO_SPAWNS[TEAM.RED])
      if (!tileReachAny(sm, [sp.x / TILE_PX, sp.y / TILE_PX], approachTiles(sm.bases[TEAM.BLUE])))
        routeOk = false;

    // ⑥ 產生器本身是 tile 級的（cell 級鏡像會切出 8px 的牆，16px 的車開不過去）
    const raw = MapGen.cells(id, true);
    for (let tr = 0; tr < TILE_H; tr++)
      for (let tc = 0; tc < TILE_W; tc++) {
        const v = raw[tr * 2][tc * 2];
        if (raw[tr * 2][tc * 2 + 1] !== v || raw[tr * 2 + 1][tc * 2] !== v ||
            raw[tr * 2 + 1][tc * 2 + 1] !== v) tileAlignedOk = false;
      }

    // ⑦ 疏密度：實心地形（磚／鋼／水）佔比。太稀＝一望即知的空地，
    //    太密＝只剩開路挖出來的四條走道，觀戰看起來像停車場而不是戰場。
    let solid = 0;
    for (let cy = 0; cy < GRID_H; cy++)
      for (let cx = 0; cx < GRID_W; cx++) {
        const v = raw[cy][cx];
        if (v === CELL_TYPE.BRICK || v === CELL_TYPE.STEEL || v === CELL_TYPE.WATER) solid++;
      }
    const frac = solid / (GRID_W * GRID_H);
    densityMin = Math.min(densityMin, frac); densityMax = Math.max(densityMax, frac);
  }
  T('mapgen: 每張圖兩座老鷹都在（藍 cy=' + BASE_CELL_Y + '／紅 cy=0）且 2×2 完好', eagleOk);
  T('mapgen: 要塞牆 20 格沒被開路挖穿', ringOk);
  T('mapgen: 八個出生點全部淨空', spawnOk);
  T('mapgen: ' + IDS.length + ' 張圖逐格點對稱（756 格全比）', symOk);
  T('mapgen: 每個出生點都有 tile 級的路通到對面要塞門口', routeOk);
  T('mapgen: 產生器以 tile 為單位（不會長出 8px 的半格牆）', tileAlignedOk);
  T('mapgen: 實心地形密度在可玩範圍（' + (densityMin * 100).toFixed(0) + '%～' +
    (densityMax * 100).toFixed(0) + '%，要求 8%～55%）',
    densityMin >= 0.08 && densityMax <= 0.55,
    (densityMin * 100).toFixed(1) + '% / ' + (densityMax * 100).toFixed(1) + '%');
  T('mapgen: 同一個 mapId 永遠同一張圖、不同 id 長得不一樣',
    cellsOf(new GameMap(7, { demo: true })) === cellsOf(new GameMap(7, { demo: true })) &&
    sigs.size >= IDS.length - 2, sigs.size + ' 種／' + IDS.length + ' 張');

  // mapId 空間是 0..MAP_VARIANTS-1，超出要環繞（HUD 的「地圖 N／255」、
  // ◀▶ 瀏覽、--stages 驗證都建立在這個邊界上）
  T('mapgen: mapId 環繞（255→0、-1→254、300→45）',
    new GameMap(MAP_VARIANTS).mapId === 0 &&
    new GameMap(-1).mapId === MAP_VARIANTS - 1 &&
    new GameMap(MAP_VARIANTS + 45).mapId === 45);
  T('mapgen: 單人模式只有一座老鷹（觀戰才有兩座）',
    new GameMap(3).bases.length === 1 &&
    new GameMap(3, { demo: true }).bases.length === 2);
  // 單人：老鷹在底邊、敵人生生點在頂邊、玩家在底邊靠老鷹那一側
  let spSpawnOk = true;
  for (const id of IDS) {
    const sm = new GameMap(id);
    for (const spx of ENEMY_SPAWNS) if (sm.tankBlocked(spx, 0)) spSpawnOk = false;
    if (sm.tankBlocked(PLAYER_SPAWN.x, PLAYER_SPAWN.y)) spSpawnOk = false;
    if (sm.bases[0].cy !== BASE_CELL_Y) spSpawnOk = false;
  }
  T('mapgen: 單人地圖的老鷹／三個敵出生點／玩家出生點全部就位', spSpawnOk);
  T('幾何: 9:21 直立戰場（9×21 tile = 18×42 cell = 144×336 px）',
    TILE_W === 9 && TILE_H === 21 && GRID_W === 18 && GRID_H === 42 &&
    GRID_W * CELL === FIELD_W && GRID_H * CELL === FIELD_H &&
    TILE_W * 2 === GRID_W && TILE_H * 2 === GRID_H,
    GRID_W + '×' + GRID_H + '／' + FIELD_W + '×' + FIELD_H);
  T('幾何: MAX_SCAN_CELLS 取較長那一軸（彈道安全掃到底邊才不會漏）',
    MAX_SCAN_CELLS === Math.max(GRID_W, GRID_H) && MAX_SCAN_CELLS === GRID_H,
    MAX_SCAN_CELLS);

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
  T('demo: opening center spawns enabled in browser', G.demoOpeningCenter === true);
  T('demo: two bases', G.map.bases.length === 2);
  T('demo: bases bottom+top',
    G.map.bases[TEAM.BLUE].cy === BASE_CELL_Y && G.map.bases[TEAM.RED].cy === 0 &&
    G.map.bases[TEAM.BLUE].cx === BASE_CELL_X && G.map.bases[TEAM.RED].cx === BASE_CELL_X,
    G.map.bases.map(b => b.cx + ',' + b.cy).join(' '));
  T('demo: 本局地圖編號在 0..MAP_VARIANTS-1 之內（每輪隨機抽）',
    G.demoStageIndex >= 0 && G.demoStageIndex < MAP_VARIANTS, String(G.demoStageIndex));

  // 180° 點對稱：cell[y][x] === cell[GRID_H-1-y][GRID_W-1-x] ⇒ 兩隊面對的地形完全等價
  //（只有上下鏡像會殘留左右不對稱，讓一隊的家門口天生比較好守）
  let sym = true;
  for (let cy = 0; cy < GRID_H; cy++)
    for (let cx = 0; cx < GRID_W; cx++)
      if (G.map.cells[cy][cx] !== G.map.cells[GRID_H - 1 - cy][GRID_W - 1 - cx]) sym = false;
  T('demo: map is 180° point-symmetric', sym);

  let spawnClear = true;
  for (const pts of DEMO_SPAWNS)
    for (const sp of pts) if (G.map.tankBlocked(sp.x, sp.y)) spawnClear = false;
  T('demo: all team spawns clear', spawnClear);
  // 出生點兩條硬性約束（以前踩過坑：x=40 那種「卡在兩個 tile 中間」的點，
  // 第一台車會在一 tile 寬的通道口卡死；不對稱則讓一隊的家門口天生比較好守）
  T('出生點: 四點都對齊 tile（x 是 16 的倍數）且成點對稱（x ↔ FIELD_W-TANK_PX-x）',
    DEMO_SPAWN_XS.every(x => x % TILE_PX === 0) &&
    DEMO_SPAWN_XS.every(x => DEMO_SPAWN_XS.indexOf(FIELD_W - TANK_PX - x) >= 0) &&
    DEMO_SPAWNS[TEAM.BLUE].every((sp, i) => sp.x === DEMO_SPAWNS[TEAM.RED][i].x &&
      sp.y === FIELD_H - TANK_PX - DEMO_SPAWNS[TEAM.RED][i].y),
    DEMO_SPAWN_XS.join(','));
  T('出生點: 不落在老鷹那一欄（否則 _clearBox 會把自家老鷹鏟掉）',
    DEMO_SPAWN_XS.every(x => {
      const c0 = x / CELL, c1 = c0 + 1;
      return c1 < BASE_CELL_X || c0 > BASE_CELL_X + 1;
    }), DEMO_SPAWN_XS.join(','));
  T('demo: no human player tank', G.player === null);

  D.frames(95);
  T('demo: enters DEMO', G.state === 'demo');

  // ⚠ v7 起「兩台車貼身就先解決對方」是最高優先，開局那兩台從相鄰的老鷹側
  //   出生，幾百幀內就可能互撞打出 breach。以前這裡寫成「D.frames(600) 之後
  //   還在看部署，再等本局結束」，等於假設一局至少撐得過 600 幀 —— 那個假設
  //   現在不成立了，所以「demo: auto next round」會偶發紅：結果畫面（300 幀）
  //   已經被前面那段 frames 吃掉一半，後面再補 DEMO_RESULT_FRAMES+5 就衝過
  //   DEMO_INTRO（90 幀）直接開打，斷言拿到的是 'demo' 不是 'demo_intro'。
  //   改成「等到某個狀態出現」推進，不寫死幀數算術；觀察也從開局第一幀就累計，
  //   這樣再快的結局也不會因為「看晚了」而誤紅。
  const waitUntil = (pred, maxFrames) => {
    let n = 0;
    while (!pred() && n < maxFrames) { D.frames(1); observe(); n++; }
    return n;
  };
  let sawBothOnField = false, sawBothPoolsDraining = false, sawHud = false;
  let tagsOk = true, roundFrames = 0, sawOverField = false;
  function observe() {
    if (G.state !== 'demo') return;
    roundFrames++;
    // 開場一次出滿 4 台 ≠ 可以無限堆：每一幀都不能超過場上上限，
    // 「打完才補」這條守則在 v8 之後更重要（不然 20 台會一次壓滿全場）。
    if (G.teams.some(tm => tm.tanks.length > DEMO_MAX_ON_FIELD)) sawOverField = true;
    if (G.teams[0].tanks.length > 0 && G.teams[1].tanks.length > 0) sawBothOnField = true;
    if (G.teams[0].pool < DEMO_TANKS_PER_TEAM && G.teams[1].pool < DEMO_TANKS_PER_TEAM)
      sawBothPoolsDraining = true;
    if (G.lives > 0 && G.iconsLeft > 0 && G.teams[TEAM.RED].tanks.length > 0) sawHud = true;
    if (!G.tanks.every(t => t.team === (t.isPlayer ? TEAM.BLUE : TEAM.RED))) tagsOk = false;
  }

  // v8：「紅藍的坦克一開始就全部出來，四台」—— 開場就不是 1 vs 1，
  // 而是每隊把四個出生點全部填滿（4 vs 4），所以這裡查的是「滿場 + 對稱首發」：
  //   · 兩隊各 4 台，位置正好是自家的四個出生點（不重疊、不卡牆）
  //   · 每隊「第一台出車的點」仍是自家老鷹旁的中央對稱點（x=32／96），兩隊相差 64
  //     —— 中央開局那條規則還在，只是它現在決定的是 4 台裡的第 1 台。
  // 逐幀推進到「剛好兩隊都出滿」的那一刻再檢查，避免 AI 已經把車開走造成位移。
  let openingGuard = 0;
  while (G.teams.some(tm => tm.tanks.length < DEMO_MAX_ON_FIELD) && openingGuard++ < 240) {
    D.frames(1); observe();
  }
  const opening = G.tanks.filter(t => t.alive).map(t => ({ team: t.team, x: t.x, y: t.y }));
  const fullField = G.teams.every(tm => tm.tanks.length === DEMO_MAX_ON_FIELD);
  const onOwnRow = G.tanks.every(t => t.y === (t.team === TEAM.BLUE ? FIELD_H - TANK_PX : 0));
  const xsOf = id => G.teams[id].tanks.map(t => t.x).sort((a, b) => a - b).join(',');
  const allPoints = DEMO_SPAWN_XS.join(',');
  const blue0 = G.teams[TEAM.BLUE].tanks[0];
  const red0 = G.teams[TEAM.RED].tanks[0];
  // 中央一對 = 四個出生點裡靠中軸的那兩個（避開老鷹欄位 64..79）
  const CENTRE_XS = [DEMO_SPAWN_XS[1], DEMO_SPAWN_XS[2]];
  T('v8: 開場兩隊各出滿 4 台（不再 1 台 1 台慢慢擠）',
    fullField && G.tanks.length === DEMO_MAX_ON_FIELD * 2, JSON.stringify(opening));
  T('v8: 4 台正好站滿自家四個出生點、各就自家底邊（不重疊也不卡牆）',
    onOwnRow && xsOf(TEAM.BLUE) === allPoints && xsOf(TEAM.RED) === allPoints,
    '藍 ' + xsOf(TEAM.BLUE) + '／紅 ' + xsOf(TEAM.RED) + '（應為 ' + allPoints + '）');
  T('demo: opening tanks spawn beside own eagles',
    !!blue0 && !!red0 &&
    [blue0.x, red0.x].every(x => CENTRE_XS.indexOf(x) >= 0) &&
    Math.abs(blue0.x - red0.x) === CENTRE_XS[1] - CENTRE_XS[0] &&
    blue0.y === FIELD_H - TANK_PX && red0.y === 0,
    JSON.stringify(opening));
  T('v8: 場上第一幀就同時有兩隊的車（開局沒有「只有一邊有人」的空窗）',
    G.state === 'demo' && G.teams[0].tanks.length > 0 && G.teams[1].tanks.length > 0,
    G.state + '／藍 ' + G.teams[0].tanks.length + ' 紅 ' + G.teams[1].tanks.length);

  // 在「還在打」的期間逐幀觀察雙方部署；這些旗標比以前的單點檢查強：
  // 它要求條件在本局的某一幀真的出現過，而不是恰好在第 600 幀被撞到。
  waitUntil(() => G.state !== 'demo', DEMO_ROUND_CAP + 200);
  T('demo: both teams field tanks', sawBothOnField);
  T('v8: 每一幀場上都不超過 4 台（開場出滿 ≠ 無限堆人）', !sawOverField);
  T('demo: team tags consistent', tagsOk);
  T('demo: both pools draining', sawBothPoolsDraining);
  T('demo: HUD mirrors both sides', sawHud);

  T('demo: round resolves', G.state === 'demo_result',
    G.state + '/在場 ' + roundFrames + ' 幀');
  T('demo: combat happened',
    G.teams[0].kills + G.teams[1].kills > 0 || G.map.bases.some(b => b.dead),
    'kills=' + G.teams[0].kills + '/' + G.teams[1].kills);
  // v6 起沒有「平手」這個出口：時鐘到與兵力耗盡都直接判防守方（紅）贏，
  // 進攻方（藍）只剩摧毀紅隊老鷹一條路。所以 winner 一定是某一隊，
  // 而且「藍隊贏」與「reason === breach」必須同時成立。
  T('demo: v6 每局一定有獲勝隊伍',
    G.demoWinner !== null &&
    (G.demoWinner.id === TEAM.BLUE || G.demoWinner.id === TEAM.RED));
  T('demo: v6 藍隊只能靠 breach 取勝',
    (G.demoWinner.id === TEAM.BLUE) === (G.demoResult.reason === 'breach'),
    G.demoWinner.id + '/' + G.demoResult.reason);

  // 結果畫面自己倒數完就自動開下一輪；等它出現，不去算「還剩幾幀」。
  waitUntil(() => G.state === 'demo_intro', DEMO_RESULT_FRAMES + 60);
  T('demo: auto next round', G.state === 'demo_intro' && G.demoRound === 2,
    G.state + '/round=' + G.demoRound);

  // 開場與結算這兩段也準暫停（滑鼠面板同一條清單）。
  // 以前 pausable 只有 PLAYING／DEMO，觀戰時想把「誰贏、為什麼」那張畫面
  // 停住看清楚，按 P 與按面板上的暫停都毫無反應。
  D.press('p');
  T('demo: 開場那 90 幀也停得下來', G.state === 'paused' && G.pauseReturn === 'demo_intro',
    G.state + '/' + G.pauseReturn);
  D.frames(200);
  T('demo: 停住時不會自己溜去下一輪', G.state === 'paused', G.state);
  D.press('p');
  T('demo: 解 pause 回到原本那一段（不是跳回 PLAYING）', G.state === 'demo_intro', G.state);
  G.state = 'demo_result'; G.stateTimer = 200;
  D.press('p');
  T('demo: 結算畫面停得下來', G.state === 'paused' && G.pauseReturn === 'demo_result',
    G.state + '/' + G.pauseReturn);
  D.press('p');
  const stAfter = G.state;
  D.frames(30);
  T('demo: 結算停住時 stateTimer 不減（解開才繼續倒數）',
    stAfter === 'demo_result' && G.stateTimer > 160, stAfter + '/' + G.stateTimer);

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

  // ══════ 地圖隨機：每輪抽圖／R 重打本輪／📌 鎖圖 ══════
  // 使用者要「地圖隨機」，但「隨機」有兩種完全不同的需求會被搞混：
  //   · 一直看下去要換圖（不然觀察者看不出改進是地形造成的）
  //   · 「重看剛剛那一場」不能換圖（R 鍵、結算後重打本輪）—— 換了就沒有對照組
  // 再加上訓練端依賴的「指定 mapId ⇒ 必然同一張圖」，三條分開釘。
  console.log('-- 地圖隨機');
  {
    G.state = 'title'; G.demoMode = false; G.setupStage(1);
    G.demoMapPinned = null;
    const drawn = [];
    for (let i = 0; i < 8; i++) {
      G.startDemo(true);
      drawn.push({ id: G.demoStageIndex, mid: G.map.mapId, sig: cellsOf(G.map) });
    }
    T('隨機: 連續 8 輪抽到 0..MAP_VARIANTS-1 之內、而且不止一張圖',
      drawn.every(d => d.id >= 0 && d.id < MAP_VARIANTS) &&
      new Set(drawn.map(d => d.id)).size > 1,
      drawn.map(d => d.id).join(','));
    T('隨機: 抽到的編號跟實際地形一致（G.map.mapId === demoStageIndex）',
      drawn.every(d => d.mid === d.id) && new Set(drawn.map(d => d.sig)).size > 1);

    // R／重打本輪：nextRound=false ⇒ 沿用這一輪那張圖
    const last = drawn[drawn.length - 1];
    G.startDemo(false);
    T('R 鍵語意: 重開本輪沿用同一張圖（不然「重看剛剛那一場」變成換圖、失去對照組）',
      G.demoStageIndex === last.id && cellsOf(G.map) === last.sig,
      G.demoStageIndex + ' vs ' + last.id);

    // 指定編號：訓練考題（ai/arena.js 每局都給 o.stage）依賴可重現性
    const roundBefore = G.demoRound;
    G.startDemo(true, 42);
    const sig42a = cellsOf(G.map);
    G.startDemo(true, 42);
    T('指定編號: 同一個 stage 必然同一張圖（訓練分數可比的前提）',
      G.demoStageIndex === 42 && G.map.mapId === 42 && cellsOf(G.map) === sig42a);
    T('指定編號: 不讓 demoRound 遞增（考題固定時「第幾代」要由訓練端自己管）',
      G.demoRound === roundBefore, G.demoRound + ' vs ' + roundBefore);
    G.startDemo(true, MAP_VARIANTS + 3);
    T('指定編號: 超出 MAP_VARIANTS 會環繞（258→3）',
      G.demoStageIndex === 3 && G.map.mapId === 3, String(G.demoStageIndex));

    // 鎖圖：右欄「📌 固定這張圖」
    G.demoMapPinned = 77;
    let pinnedAllSame = true;
    for (let i = 0; i < 5; i++) { G.startDemo(true); if (G.demoStageIndex !== 77) pinnedAllSame = false; }
    T('鎖圖: 固定 77 之後每一輪都停在 77', pinnedAllSame, String(G.demoStageIndex));
    G.startDemo(true, 130);   // 鎖著的時候 ◀▶ 改的是「固定到哪一張」
    T('鎖圖: 鎖住時換圖 ⇒ 把鎖一起搬過去（不是只重開這一次）',
      G.demoStageIndex === 130 && G.demoMapPinned === 130,
      G.demoStageIndex + '/' + G.demoMapPinned);
    G.demoMapPinned = null;
    G.startDemo(true);
    T('鎖圖: 解鎖後回到每輪隨機',
      G.demoMapPinned === null && G.demoStageIndex !== 130, String(G.demoStageIndex));

    // 難度曲線取模：編號 254 的地圖不能當成「第 255 關」而永遠跑最硬的一組
    const realPickType = EnemyAI.pickType;
    const asked = [];
    const probe = id => {
      asked.length = 0;
      EnemyAI.pickType = n => { asked.push(n); return realPickType.call(EnemyAI, n); };
      G.startDemo(true, id);
      return asked[0];
    };
    const nHard = probe(MAP_VARIANTS - 1), nPeak = probe(ENEMY_DIFF_CURVE - 1), nFirst = probe(0);
    EnemyAI.pickType = realPickType;
    T('難度曲線: 出兵組合依「編號 % ENEMY_DIFF_CURVE」取樣（255 張圖分散在整條曲線上）',
      nHard === ((MAP_VARIANTS - 1) % ENEMY_DIFF_CURVE) + 1 &&
      nPeak === ENEMY_DIFF_CURVE && nFirst === 1 && asked.length > 0,
      '編號 254→n=' + nHard + '／20→n=' + nPeak + '／0→n=' + nFirst);
    G.state = 'title'; G.demoMode = false; G.setupStage(1);
  }

  // ══════ v6 規則層：角色、30 秒時鐘、唯一勝利條件 ══════
  // 使用者這輪定的四條規則逐條釘成測試。之後誰改常數、誰把終局判定
  // 挪個位置，這裡要先紅，而不是等訓練跑完才發現尺歪了。
  console.log('-- v6 rules');
  T('v6: 時鐘 30 秒 × 60 fps === DEMO_ROUND_CAP（1800 幀）',
    DEMO_ATTACK_SECONDS * TARGET_FPS === DEMO_ROUND_CAP && DEMO_ROUND_CAP === 1800,
    DEMO_ATTACK_SECONDS + 's × ' + TARGET_FPS + ' = ' + DEMO_ROUND_CAP);
  T('v6: 藍=進攻、紅=防守（席位寫死在常數，不是靠習慣）',
    DEMO_ATTACK_TEAM === TEAM.BLUE && DEMO_DEFENSE_TEAM === TEAM.RED &&
    demoRoleOf(DEMO_ATTACK_TEAM) === DEMO_ROLES.ATTACK &&
    demoRoleOf(DEMO_DEFENSE_TEAM) === DEMO_ROLES.DEFENSE &&
    demoRoleOf(TEAM.BLUE) === 'attack' && demoRoleOf(TEAM.RED) === 'defense');
  T('v6: 進攻方補人比較快（100 幀 < 防守方 150 幀）',
    DEMO_TEAM_SPAWN_INTERVALS[TEAM.BLUE] === DEMO_ATTACK_SPAWN_INTERVAL &&
    DEMO_TEAM_SPAWN_INTERVALS[TEAM.BLUE] < DEMO_TEAM_SPAWN_INTERVALS[TEAM.RED],
    DEMO_TEAM_SPAWN_INTERVALS.join(' / '));

  // 重新開一局（soak 可能把上一局打到結果畫面）
  G.state = 'title'; G.demoMode = false; G.setupStage(1);
  D.press('t');
  // 時鐘是在「切換到 DEMO」那一幀被設成 30 秒的，所以直接走狀態機驗，
  // 不被開局動畫吃掉的幾幀干擾。
  G.state = 'demo_intro'; G.stateTimer = 1; G.update();
  T('v6: 進入新的一局時，時鐘從 1800 幀（30 秒）開始倒數',
    G.state === 'demo' && G.demoCap === DEMO_ROUND_CAP, G.demoCap);
  T('v6: 隊伍出生間隔真的按角色分配（藍 100／紅 150）',
    G.teams[TEAM.BLUE].spawnEvery === DEMO_ATTACK_SPAWN_INTERVAL &&
    G.teams[TEAM.RED].spawnEvery === DEMO_SPAWN_INTERVAL);

  // ① 時間到 → 紅隊贏
  G.demoCap = 1; G.update();
  T('v6: 30 秒到沒破局 → 紅隊贏、reason=time',
    G.state === 'demo_result' && G.demoWinner.id === TEAM.RED &&
    G.demoResult.reason === 'time' && G.demoResult.text === DEMO_END_TEXT.time,
    G.demoWinner.id + '/' + G.demoResult.reason);

  // ② 雙方兵力耗盡而紅鷹還在 → 同樣判紅隊（不再比積分）
  G.state = 'title'; G.demoMode = false; G.setupStage(1);
  D.press('t'); D.frames(95);
  G.demoCap = 1200;
  G.tanks.length = 0; G.bullets.length = 0; G.powerUps.length = 0;
  for (const tm of G.teams) { tm.pool = 0; tm.tanks.length = 0; }
  G.update();
  T('v6: 兵力耗盡而紅鷹還在 → 紅隊贏、reason=pool',
    G.state === 'demo_result' && G.demoWinner.id === TEAM.RED &&
    G.demoResult.reason === 'pool', G.demoResult.reason);

  // ③ 紅隊老鷹被毀 = 藍隊唯一贏法；④ 藍隊老鷹被毀 = 紅隊贏（反破解也算）
  G.state = 'title'; G.demoMode = false; G.setupStage(1);
  D.press('t'); D.frames(95);
  G.demoCap = 1200; G.onDemoBaseHit(G.map.bases[TEAM.RED]);
  T('v6: 紅鷹被毀 → 藍隊贏、reason=breach',
    G.demoWinner.id === TEAM.BLUE && G.demoResult.reason === 'breach' &&
    G.demoResult.text === DEMO_END_TEXT.breach,
    G.demoWinner.id + '/' + G.demoResult.reason);

  G.state = 'title'; G.demoMode = false; G.setupStage(1);
  D.press('t'); D.frames(95);
  G.demoCap = 1200; G.onDemoBaseHit(G.map.bases[TEAM.BLUE]);
  T('v6: 藍鷹被毀（含防守方反破解）→ 紅隊贏、reason=counter',
    G.demoWinner.id === TEAM.RED && G.demoResult.reason === 'counter');

  // ⑤ 連跑 3 局完整對局：勝隊與終局原因的對應必須永遠符合規則，
  //    而且「時間到／兵力耗盡」一定判紅隊（不再比積分）、
  //    每一局都在 30 秒硬上限內收場（不會出現拖著不打完的局）。
  let ruleOk = true, ruleSeen = [], maxRoundFrames = 0, rounds = 0, guard = 0;
  G.state = 'title'; G.demoMode = false;
  while (rounds < 3 && guard++ < 6000) {
    if (G.state === 'title') D.press('t');
    let lead = 0;
    while (G.state !== 'demo' && lead++ < 200) D.frames(1);
    if (G.state !== 'demo') { ruleOk = false; break; }
    let frames = 0;
    while (G.state === 'demo' && frames < DEMO_ROUND_CAP + 20) { G.update(); frames++; }
    if (G.state !== 'demo_result') { ruleOk = false; break; }
    rounds++;
    maxRoundFrames = Math.max(maxRoundFrames, frames);
    ruleSeen.push(G.demoResult.reason + ':' + G.demoWinner.id);
    const r = G.demoResult.reason, w = G.demoWinner.id;
    if (r === 'time' || r === 'pool' || r === 'counter') { if (w !== TEAM.RED) ruleOk = false; }
    else if (r === 'breach') { if (w !== TEAM.BLUE) ruleOk = false; }
    else ruleOk = false;
    if (w === TEAM.BLUE && r !== 'breach') ruleOk = false;   // 藍隊只有一種贏法
    if (rounds < 3) D.press('Enter');
  }
  T('v6: 連跑 3 局，勝隊與終局原因完全符合規則（藍只可能因 breach 贏）',
    ruleOk && rounds === 3, ruleSeen.join(' '));
  T('v6: 每一局都在 30 秒硬上限內收場（最長 ' + maxRoundFrames + ' 幀 ≤ ' + DEMO_ROUND_CAP + '）',
    maxRoundFrames <= DEMO_ROUND_CAP, maxRoundFrames);

  // ══════ v6 彈道安全：不準打到自己要塞＋要塞牆 ══════
  // 規則 AI（js/ai.js）與網路端（ai/controller.js）共用同一套幾何判斷。
  // ⚠ 這一段全部跑在 rangeMap()（清空＋只留兩座要塞）上，不用 G.map：
  //   地形隨機之後，「第 12 欄這一列剛好是空的」這種前提不再成立，
  //   拿隨機圖去驗彈道會得到「看運氣紅」的測試。幾何關係要自己造。
  console.log('-- v6 ballistics');
  {
    const m = rangeMap();
    const ownBlue = m.bases[TEAM.BLUE], ownRed = m.bases[TEAM.RED];
    // 只當作「開火前的問句」用，不需要真的 Tank：給個 team/dir/center 就夠
    const gun = (team, dir, cx, cy) => ({
      team, dir, center: () => ({ x: cx * CELL + 4, y: cy * CELL + 4 }),
    });
    const game = { map: m };
    // 新幾何：藍鷹在 cell (8..9, 40..41)，磚環 rows 38..39（帶）＋ rows 40..41（左右護牆）
    const EAGLE_COL = BASE_CELL_X;                        // 8
    const BAND_BLUE = BASE_CELL_Y - 1;                    // 39（要塞牆靠場內那一排）
    const ABOVE_RING = BASE_CELL_Y - 3;                   // 37（牆外一格，站這裡朝下看得到牆）
    const clear = (c0, c1, r0, r1, v) => {
      for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) m.cells[cy][cx] = v;
    };

    T('B6: isFortressWall 認得出全部 20 格要塞牆（它看座標清單，不看磚還在不在）',
      ownBlue.ring.length === 20 &&
      ownBlue.ring.every(([rx, ry]) => m.isFortressWall(ownBlue, rx, ry)) &&
      ownRed.ring.every(([rx, ry]) => m.isFortressWall(ownRed, rx, ry)) &&
      m.isFortressWall(ownBlue, EAGLE_COL, ABOVE_RING) === false);

    // ① 正對自家老鷹、中間是要塞牆 → 收手
    T('B6: 正對自家鷹、路徑先撞要塞牆 → 不準開火',
      EnemyAI._ownBaseInFront(gun(TEAM.BLUE, DIR.DOWN, EAGLE_COL, ABOVE_RING), game) === true,
      '檢查 cell (' + EAGLE_COL + ',' + ABOVE_RING + ') 朝下');

    // ② 路徑上是一般磚牆 → 放行（不能把「會削到牆」當成不準開火的理由）
    setTile(m, EAGLE_COL / 2, (ABOVE_RING - 3) / 2, CELL_TYPE.BRICK);   // tile(4,17) → cells 8..9, 34..35
    T('B6: 前面是一般磚牆、老鷹在更遠的地方 → 這槍準開',
      EnemyAI._ownBaseInFront(gun(TEAM.BLUE, DIR.DOWN, EAGLE_COL, 30), game) === false);
    setTile(m, EAGLE_COL / 2, (ABOVE_RING - 3) / 2, CELL_TYPE.EMPTY);

    // ③ 要塞牆被打掉、老鷹露出來 → 依然禁（看的是老鷹，不是牆還在不在）
    clear(6, 11, BASE_CELL_Y - 2, BASE_CELL_Y - 1, CELL_TYPE.EMPTY);
    clear(6, 7, BASE_CELL_Y, BASE_CELL_Y + 1, CELL_TYPE.EMPTY);
    clear(10, 11, BASE_CELL_Y, BASE_CELL_Y + 1, CELL_TYPE.EMPTY);
    T('B6: 要塞牆破了、能直看到老鷹 → 一樣不準開火',
      EnemyAI._ownBaseInFront(gun(TEAM.BLUE, DIR.DOWN, EAGLE_COL, ABOVE_RING), game) === true);

    // ④ 水／樹林不擋子彈 → 不能當成「這一槍安全」
    const ringBlue = ownBlue.ring;
    const setRing = v => { for (const [rx, ry] of ringBlue) m.cells[ry][rx] = v; };
    setRing(CELL_TYPE.WATER);
    T('B6: 中間隔著水（子彈照飛）→ 仍然不準開火',
      EnemyAI._ownBaseInFront(gun(TEAM.BLUE, DIR.DOWN, EAGLE_COL, ABOVE_RING), game) === true);
    setRing(CELL_TYPE.FOREST);
    T('B6: 中間隔著樹林（子彈照飛）→ 仍然不準開火',
      EnemyAI._ownBaseInFront(gun(TEAM.BLUE, DIR.DOWN, EAGLE_COL, ABOVE_RING), game) === true);
    setRing(CELL_TYPE.STEEL);
    T('B6: 鏟子把牆變成鋼，仍是自家要塞 → 不準開火',
      EnemyAI._ownBaseInFront(gun(TEAM.BLUE, DIR.DOWN, EAGLE_COL, ABOVE_RING), game) === true);
    setRing(CELL_TYPE.BRICK);

    // ⑤ 同一條線上如果是敵隊老鷹 → 這槍有意義，必須放行
    const redSide = gun(TEAM.BLUE, DIR.UP, EAGLE_COL, ABOVE_RING);
    T('B6: 朝敵隊老鷹開火（彈道上沒有自家要塞）→ 放行',
      EnemyAI._ownBaseInFront(redSide, game) === false);

    // ⑥ 四個方向都要查得對：藍隊老鷹在底邊，只有朝上（背對自家鷹）才算安全
    T('B6: 同一台車朝上（離開自家鷹）→ 準開火',
      EnemyAI._ownBaseInFront(gun(TEAM.BLUE, DIR.UP, EAGLE_COL, ABOVE_RING), game) === false);
    T('B6: 紅隊（老鷹在頂邊）朝上打自家鷹 → 一樣不準',
      EnemyAI._ownBaseInFront(gun(TEAM.RED, DIR.UP, EAGLE_COL, 6), game) === true);
    // 長場（42 格高）才看得出來的坑：掃射上限若取寬（18），從場中間朝下看
    // 自家老鷹只掃到一半（18 格＝144px），長場的下面一半根本沒檢查，規則等於沒上。
    T('B6: 場中間朝下也掃得到自家鷹（MAX_SCAN_CELLS 用較長那一軸）',
      EnemyAI._ownBaseInFront(gun(TEAM.BLUE, DIR.DOWN, EAGLE_COL, 10), game) === true,
      '起點 cell (8,10) → 要塞牆在 row 38（27 格遠）');

    // ⑦ 規則 AI 真的會收手：停在自家鷹正上方、每幀都把射擊與冷卻歸零，
    //    面朝自家老鷹跑 300 幀，不該出現任何一顆往自家去的子彈。
    //    同時補一條反向測試：同一台車把槍口轉離老鷹就必須照樣會開火，
    //    否則「安全閘」很容易寫成「永遠不準射擊」，那 AI 就變木樁了。
    const range = rangeMap();
    const drive = (dir, n) => {
      const t = new Tank(EAGLE_COL * CELL, 280, dir, false, {});
      t.spawnTimer = 0; t.team = TEAM.BLUE;
      const bullets = [];
      const g2 = {
        map: range, tanks: [t], bullets,
        foesOf: () => [], allTanks: () => [t], frozenFor: () => false,
        ownBaseOf: () => GameMap.baseCenter(range.bases[TEAM.BLUE]),
        foeBaseOf: () => GameMap.baseCenter(range.bases[TEAM.RED]),
      };
      const fired = [];
      for (let i = 0; i < n; i++) {
        t.aiShootTimer = 0; t.cooldown = 0; t.spawnTimer = 0;
        t.x = EAGLE_COL * CELL; t.y = 280; t.dir = dir;
        EnemyAI.update(t, g2);
        for (const b of bullets) if (b.owner === t) fired.push(b.dir);
        bullets.length = 0;
      }
      return fired;
    };
    const towardOwn = drive(DIR.DOWN, 300).filter(d => d === DIR.DOWN).length;
    T('B6: 規則 AI 面朝自家鷹 300 幀 → 一顆往自家的子彈都沒打出去',
      towardOwn === 0, towardOwn);
    const away = drive(DIR.UP, 300).filter(d => d === DIR.UP).length;
    T('B6: 同一台車把槍口轉離老鷹 → 照樣會開火（安全閘沒有變成永遠禁射）',
      away > 0, away);

    // ⑧ 單人模式的敵人沒有「自己家的老鷹」，新規則必須完全不打理它，
    //    否則單人回歸會被這條新規則改寫行為。
    const spMap = new GameMap(0);
    T('B6: 單人模式（敵車沒有 own base）→ 判定恆為安全，行為不變',
      spMap.bases.length === 1 && spMap.bases[TEAM.RED] === undefined &&
      EnemyAI._ownBaseInFront(gun(TEAM.RED, DIR.DOWN, EAGLE_COL, ABOVE_RING), { map: spMap }) === false);
  }

  // ══════ v7 規則一：自己人打爆自家老鷹（要記錄）══════
  // 使用者：「加入一個判定標準，自己人把自己的老鷹打死，要記錄，
  //          然後列入訓練標準，避免自己殺自己。」
  // 這一節管「記錄」這一段：js/map.js 記住兇手隊伍 → js/game.js 把它變成
  // 結局欄位（ownGoal／killerTeam／覆寫文案）。訓練標準那一段在
  // ai/fitness.js，由 test-train.js 的「F v7」那幾條守著。
  console.log('-- v7 own goal');
  {
    const mkShooter = (team, x, y, dir) => {
      const t = new Tank(x, y, dir, false, {});
      t.team = team; t.spawnTimer = 0; t.aiShootTimer = 999999;
      return t;
    };
    // 把要塞牆清掉，讓子彈直接落在老鷹那 2×2 格上（要驗的是歸因，不是拆牆）
    const openRing = (m, base) => {
      for (const [rx, ry] of base.ring) m.cells[ry][rx] = CELL_TYPE.EMPTY;
    };
    // 隨機地形會在老鷹正上方那欄留下別磚塊，子彈先撞它就不算「打到老鷹」。
    // 所以要把整條射擊線清乾淨（唯獨留下老鷹那 2×2）—— 驗的是歸因邏輯，
    // 不是「這一張圖剛好沒有牆」。
    const openColumn = (m, col) => {
      for (let cy = 0; cy < GRID_H; cy++)
        for (let dx = 0; dx < 2; dx++) {
          const cc = col + dx;
          if (m.cellAt(cc, cy) !== CELL_TYPE.BASE) m.cells[cy][cc] = CELL_TYPE.EMPTY;
        }
      return m;
    };
    // 座標從常數推（老鷹欄 = BASE_CELL_X*CELL = 64，站在家門正上方 3 格）
    const EAGLE_X = BASE_CELL_X * CELL;
    const SELF_GUN_Y = (BASE_CELL_Y - 5) * CELL;    // 280：藍鷹上方、要塞牆外側
    const FOE_GUN_Y = 2 * TILE_PX;                  // 32：紅鷹下方、拆掉的要塞牆外側
    // ① 藍隊子彈打爆藍隊老鷹 = 自破（終局原因仍是既有的四種之一）
    G.state = 'title'; G.demoMode = false; G.setupStage(1);
    D.press('t'); D.frames(95);
    G.demoCap = 1200;
    let m = G.map, blueBase = m.bases[TEAM.BLUE];
    openRing(m, blueBase);
    openColumn(m, BASE_CELL_X);
    G.tanks.length = 0; G.bullets.length = 0; G.powerUps.length = 0;
    const selfGun = mkShooter(TEAM.BLUE, EAGLE_X, SELF_GUN_Y, DIR.DOWN);
    G.tanks.push(selfGun);
    const selfShot = selfGun.shoot(G.bullets);
    G.bullets.push(selfShot);
    T('v7: （setup）藍隊車朝自家老鷹開出一顆子彈',
      !!selfShot && selfShot.owner === selfGun && selfShot.dir === DIR.DOWN,
      selfShot ? selfShot.x + ',' + selfShot.y : 'shoot() 回 null');
    for (let i = 0; i < 8 && G.state === 'demo'; i++) G.update();
    T('v7: 自己人的子彈打爆自家老鷹 → base.killedBy 記的是自己隊',
      blueBase.dead === true && blueBase.killedBy === TEAM.BLUE,
      'dead=' + blueBase.dead + ' killedBy=' + blueBase.killedBy);
    T('v7: 自破不發明新的終局出口（reason 仍是 breach/counter/time/pool 之一）',
      G.state === 'demo_result' && G.demoResult.reason === 'counter' &&
      Object.keys(DEMO_END_TEXT).indexOf(G.demoResult.reason) >= 0,
      G.state + '/' + (G.demoResult && G.demoResult.reason));
    T('v7: 自破要看得出來 —— ownGoal／killerTeam／覆寫文案一起上場',
      G.demoResult.ownGoal === true && G.demoResult.killerTeam === TEAM.BLUE &&
      G.demoResult.text === DEMO_OWN_GOAL_TEXT.counter &&
      G.demoResult.text !== DEMO_END_TEXT.counter, JSON.stringify(G.demoResult));
    T('v7: 勝負不受影響：打爆自己家的那一隊就是輸家',
      G.demoWinner.id === TEAM.RED, G.demoWinner.id);

    // ② 同一格老鷹、同一條彈道，兇手換成敵隊（藍車打紅鷹）→ 正經戰功，不是自破
    G.state = 'title'; G.demoMode = false; G.setupStage(1);
    D.press('t'); D.frames(95);
    G.demoCap = 1200;
    m = G.map; const redBase = m.bases[TEAM.RED];
    openRing(m, redBase);
    openColumn(m, BASE_CELL_X);
    G.tanks.length = 0; G.bullets.length = 0; G.powerUps.length = 0;
    const foeGun = mkShooter(TEAM.BLUE, EAGLE_X, FOE_GUN_Y, DIR.UP);
    G.tanks.push(foeGun);
    const foeShot = foeGun.shoot(G.bullets);
    G.bullets.push(foeShot);
    for (let i = 0; i < 12 && G.state === 'demo'; i++) G.update();
    T('v7: 敵隊打爆紅隊老鷹 → killedBy 是藍隊，ownGoal 不成立',
      redBase.dead === true && redBase.killedBy === TEAM.BLUE &&
      G.demoResult.ownGoal === false && G.demoResult.killerTeam === null &&
      G.demoResult.text === DEMO_END_TEXT.breach,
      'dead=' + redBase.dead + ' killedBy=' + redBase.killedBy + ' ' + JSON.stringify(G.demoResult));

    // ③ 沒有兇手記錄（炸彈道具、舊存檔、直接呼叫事件）→ 一律不算自破。
    //    寧可漏記，不可把敵人的戰功栽贓給自己人。
    G.state = 'title'; G.demoMode = false; G.setupStage(1);
    D.press('t'); D.frames(95);
    G.demoCap = 1200;
    G.onDemoBaseHit(G.map.bases[TEAM.RED]);
    T('v7: 查無兇手 → 不算自破（不栽贓），文案維持原版',
      G.demoResult.ownGoal === false && G.demoResult.killerTeam === null &&
      G.demoResult.text === DEMO_END_TEXT.breach, JSON.stringify(G.demoResult));

    // ④ 文案表只覆寫既有的 reason，不新增第三套結局語彙
    T('v7: DEMO_OWN_GOAL_TEXT 的鍵一定是 DEMO_END_TEXT 的子集（只有老鷹被毀才談自破）',
      Object.keys(DEMO_OWN_GOAL_TEXT).length === 2 &&
      Object.keys(DEMO_OWN_GOAL_TEXT).every(k => Object.keys(DEMO_END_TEXT).indexOf(k) >= 0),
      JSON.stringify(Object.keys(DEMO_OWN_GOAL_TEXT)));

    // ⑤ 單人模式照舊：只有一座老鷹，而且 killedBy 是「被打到才記」的欄位
    //    （不是開局就預填 0，否則舊存檔／單人局會被誤判成自破）。
    G.state = 'title'; G.demoMode = false; G.setupStage(1);
    D.frames(95);
    T('v7: 單人模式仍然只有一座老鷹、killedBy 是事件發生才寫入的欄位',
      G.map.bases.length === 1 && G.demoMode === false &&
      !('killedBy' in G.map.bases[0]) && G.map.bases[0].dead === false,
      G.map.bases.length + ' 座／' + JSON.stringify(G.map.bases[0]));
  }

  // ══════ v7 規則二：兩台坦克太接近 → 先解決對方坦克 ══════
  // 使用者：「紅藍的坦克如果太過接近，目標要修改成先解決對方的坦克。」
  // 規則端在 js/ai.js（_nearestFoe / _goal / _pickDirection 的優先順序），
  // 計量端在 ai/arena.js 的 duelKills（test-train.js 的「A v7」「F v7」）。
  console.log('-- v7 duel');
  {
    const emptyMap = blankMap(new GameMap(0));
    const tank = (team, x, y, dir) => {
      const t = new Tank(x, y, dir, false, {});
      t.team = team; t.spawnTimer = 0;
      return t;
    };
    // 迷你 game：只要 AI 問得到的那幾個介面，不必把整局跑起來
    const gOf = (tanks) => ({
      map: emptyMap, tanks,
      foesOf: t => tanks.filter(f => f.team !== t.team),
      ownBaseOf: () => null, foeBaseOf: () => null,
      allTanks: () => tanks, frozenFor: () => false,
    });

    // 座標重排到 144 寬的場內（以前 9:21 之前的正方形場放得下 x=208，現在會出界）
    const me = tank(TEAM.RED, 32, 96, DIR.UP);
    const near = tank(TEAM.BLUE, 64, 96, DIR.DOWN);    // 中心距 32 < 40 → 貼身
    const far = tank(TEAM.BLUE, 128, 96, DIR.DOWN);    // 中心距 96 → 還在半徑外
    const mate = tank(TEAM.RED, 32, 200, DIR.DOWN);    // 同隊（再近也不算敵），放在不相鄰的位置
    const duelG = gOf([me, near, mate]);
    const noDuelG = gOf([me, far, mate]);

    T('v7: 貼身偵測只看敵隊、只認活車（中心距 < AI_DUEL_RADIUS）',
      EnemyAI._nearestFoe(me, duelG) === near,
      JSON.stringify(EnemyAI._nearestFoe(me, duelG) && { x: near.x, y: near.y }));
    T('v7: 超出半徑就不算貼身（半徑一大「格鬥」就變成常態，攻防會被無限期推遲）',
      EnemyAI._nearestFoe(me, noDuelG) === null);
    T('v7: 兩個敵車都在範圍內 → 挑最近的那一台',
      (() => {
        const closer = tank(TEAM.BLUE, 48, 96, DIR.DOWN);   // 中心距 16
        return EnemyAI._nearestFoe(me, gOf([me, closer, near, mate])) === closer;
      })(), 'near=' + near.x + ' closer=' + (48));
    T('v7: 出生無敵中（spawnTimer>0）或已陣亡的車不進入格鬥名單',
      (() => {
        const ghost = tank(TEAM.BLUE, 64, 96, DIR.DOWN);    // 中心距 32：範圍內，但還在出生動畫
        ghost.spawnTimer = 30;
        const dead = tank(TEAM.BLUE, 48, 96, DIR.DOWN);     // 中心距 16：範圍內，但已陣亡
        dead.alive = false;
        const withGhost = EnemyAI._nearestFoe(me, gOf([me, dead, ghost]));
        return withGhost === null;
      })());
    T('v7: 目標層第一優先就是那台敵車（座標＝敵車、duel 旗標為真）',
      (() => {
        const goal = EnemyAI._goal(me, duelG, EnemyAI._nearestFoe(me, duelG));
        return !!goal && goal.duel === true && goal.x === near.x && goal.y === near.y;
      })(), JSON.stringify(EnemyAI._goal(me, duelG, near)));
    T('v7: 沒貼身時目標層不會憑空變成格鬥（維持回防／追擊／衝基地／巡邏）',
      (() => {
        const goal = EnemyAI._goal(me, noDuelG, null);
        return goal === undefined || goal.duel === undefined;
      })());
    // 換向層：貼身敵車在右側 → 想去的方向就是右（這才是「目標改掉」看得見的證據）
    T('v7: 貼身時「想去哪」跟著敵車走（右側的敵車 → 朝右，不是朝原本的老鷹方向）',
      EnemyAI._pickDirection(me, duelG, false, false, near) === DIR.RIGHT,
      'want=' + EnemyAI._pickDirection(me, duelG, false, false, near));
    T('v7: 貼身格鬥的重新決策比平常快（AI_DUEL_REPICK < 平常的 40 幀下限）',
      AI_DUEL_REPICK < 40 && AI_DUEL_SHOOT > 0.55,
      AI_DUEL_REPICK + ' 幀／命中率 ' + AI_DUEL_SHOOT);

    // 行為層（一）：兩台車中心距 32（在 AI_DUEL_RADIUS 之內）、都背對彼此。
    // 舊的目標順序（回防 → 擲骰追擊）會讓兩台車各走各的；v7 的目標是「那台敵車」，
    // 所以它們必須反身朝對方擠過去（32 → 頂住 16）。
    // 這裡只跑 EnemyAI.update，不跑子彈物理 —— 「貼身真的會打死人」由
    // test-train.js 的「A v7：規則 AI 互打會真的產生貼身殲滅」負責。
    // 子彈也不留在場上（每幀清空），否則兩台車會互相打死，看不到「貼身對峙」這段。
    emptyMap.bases = [];                       // 這一段不談要塞，把彈道閘關掉免得混淆
    const run = (ax, ay, adir, bx, by, bdir, n, driveB = true) => {
      const a = tank(TEAM.BLUE, ax, ay, adir);
      const b = tank(TEAM.RED, bx, by, bdir);
      const g2 = gOf([a, b]);
      g2.bullets = [];
      const out = { minGap: 9999, shots: 0, onAxis: 0, cool: 9999, duelFrames: 0 };
      for (let i = 0; i < n; i++) {
        for (const t of [a, b]) {
          if (!t.alive || (t === b && !driveB)) continue;
          t.cooldown = 0; t.spawnTimer = 0;   // 只拆冷卻；aiShootTimer 是被驗的節奏
          EnemyAI.update(t, g2);
          t.tick();
          out.cool = Math.min(out.cool, t.aiShootTimer);
        }
        for (const bullet of g2.bullets) {
          out.shots++;
          if (bullet.dir === DIR.LEFT || bullet.dir === DIR.RIGHT) out.onAxis++;
        }
        g2.bullets.length = 0;
        if (!a.alive || !b.alive) break;
        const gap = Math.hypot(a.x - b.x, a.y - b.y);
        out.minGap = Math.min(out.minGap, gap);
        if (gap < AI_DUEL_RADIUS) out.duelFrames++;
      }
      return out;
    };

    const away = run(96, 104, DIR.LEFT, 128, 104, DIR.RIGHT, 120);
    T('v7: 背對彼此但已貼身的兩台車會反身朝對方擠過去（不會各走各的）',
      away.minGap <= TANK_PX + 6, '最小間距 ' + away.minGap.toFixed(1) + '（起點 32）');

    // 行為層（二）：貼身面對面真的會按格鬥節奏開火。
    // 場景刻意做成「巷道裡被夾死的一對」：上下兩道鋼牆把車鎖在同一條橫巷，
    // 藍車背後也封死，紅車充當靜止的敵車。這樣四面全走不通，
    // _pickDirection 會走「維持目前朝向」那條路（見 js/ai.js 的防鬼畜旋轉註解），
    // 藍車就不會先垂直閃開、把射擊線弄丟 —— 否則頂到車之後它必然往上下閃，
    // 一離開同軸，射擊率就掉回 0.04，驗到的其實是幾何而非節奏。
    // 「貼身真的會打死人」由 test-train.js 的 A v7 在真實幀流裡量，
    // 這裡只驗：同軸＋貼身 → 射的是 8～15 幀節奏、子彈沿軸飛出。
    const lane = blankMap(new GameMap(0));
    lane.bases = [];
    for (let c = 0; c < GRID_W; c++) {
      lane.cells[12][c] = CELL_TYPE.STEEL;      // 巷子上沿
      lane.cells[15][c] = CELL_TYPE.STEEL;      // 巷子下沿
    }
    for (let r = 13; r <= 14; r++) {
      lane.cells[r][11] = CELL_TYPE.STEEL;      // 藍車背後
    }
    const pinned = (() => {
      const a = tank(TEAM.BLUE, 96, 104, DIR.RIGHT);
      const b = tank(TEAM.RED, 112, 104, DIR.LEFT);
      const g2 = Object.assign(gOf([a, b]), { map: lane });
      g2.bullets = [];
      const out = { shots: 0, onAxis: 0, cool: 9999, duelFrames: 0, gap: 9999 };
      for (let i = 0; i < 120; i++) {
        a.cooldown = 0; a.spawnTimer = 0;
        EnemyAI.update(a, g2);
        a.tick();
        out.cool = Math.min(out.cool, a.aiShootTimer);
        for (const bullet of g2.bullets) {
          out.shots++;
          if (bullet.dir === DIR.LEFT || bullet.dir === DIR.RIGHT) out.onAxis++;
        }
        g2.bullets.length = 0;
        const gap = Math.hypot(a.x - b.x, a.y - b.y);
        out.gap = Math.min(out.gap, gap);
        if (gap < AI_DUEL_RADIUS) out.duelFrames++;
      }
      out.dir = a.dir;
      return out;
    })();
    T('v7: 貼身面對面 → 開火次數符合格鬥節奏（不是平常的 25～75 幀偶發射擊）',
      pinned.shots >= 6 && pinned.onAxis >= pinned.shots * 0.8,
      '子彈 ' + pinned.shots + '／正軸 ' + pinned.onAxis + '／朝向 ' + pinned.dir);
    T('v7: 格鬥期間射擊冷卻縮到 8～15 幀（把先手讓給對面就不是「先解決對方」）',
      pinned.duelFrames > 0 && pinned.cool <= AI_DUEL_REPICK + 7,
      '格鬥 ' + pinned.duelFrames + ' 幀／最低冷卻 ' + pinned.cool);
  }

  // ══════ 批次二（G）：規則 AI 的角色化目標 ══════
  // 9:21 之後場高 336，原本 56px 的回防半徑只剩 1/6 場高，紅隊等到敵車貼到
  // 牆腳才動身（探針實測：紅隊 44.8% 的幀在對方半場閒晃、本業占比 0.7%）。
  // 這一節驗三件事各自成立：屏蔽半徑攔人、空場時站到防線上、進攻席只被
  // 「走廊上真的擋路」的車改道 —— 外加單人模式那條路完全沒被動到。
  console.log('-- batch2 role goals');
  {
    const mk = (team, x, y, dir) => {
      const t = new Tank(x, y, dir, false, {});
      t.team = team; t.spawnTimer = 0;
      return t;
    };
    const field = blankMap(new GameMap(0));
    field.bases = [];                 // 要塞由下面的靶場座標提供，別拿隨機圖賭位置
    const RED_EAGLE  = { x: 64, y: 24 };    // 紅＝防守席，老鷹在頂邊
    const BLUE_EAGLE = { x: 80, y: 312 };   // 藍＝進攻席，老鷹在底邊
    /** demo=false 就是單人模式：敵人沒有自己要塞（js/game.js ownBaseOf 同形） */
    const gOf = (tanks, demo = true) => ({
      map: field, tanks,
      foesOf: t => tanks.filter(f => f.team !== t.team),
      ownBaseOf: t => (demo ? (t.team === TEAM.RED ? RED_EAGLE : BLUE_EAGLE) : null),
      foeBaseOf: t => (t.team === TEAM.RED ? BLUE_EAGLE : RED_EAGLE),
      allTanks: () => tanks,
      frozenFor: () => false,
    });
    // 擲骰那兩條分支（清障／舊的追擊比率）只能靠注入亂數才驗得準
    const withRandom = (v, fn) => {
      const real = Math.random;
      Math.random = () => v;
      try { return fn(); } finally { Math.random = real; }
    };

    T('G: 屏蔽半徑與防線都由場高推出來（場放大後 56px 不再是「半場」）',
      DEMO_SCREEN_RADIUS === Math.round(FIELD_H / 3) &&
      DEMO_HOLD_LINE === Math.round(FIELD_H / 6) &&
      DEMO_SCREEN_RADIUS > DEMO_THREAT_RADIUS &&
      DEMO_HOLD_LINE < DEMO_SCREEN_RADIUS &&
      DEMO_HOLD_LINE < FIELD_H / 2,
      '屏蔽 ' + DEMO_SCREEN_RADIUS + '／防線 ' + DEMO_HOLD_LINE + '／場高 ' + FIELD_H);

    // ① 攔截：敵車已進 1/3 場，但還在門前 56px 之外 —— 舊的半徑看不到它
    {
      const red = mk(TEAM.RED, 16, 200, DIR.UP);
      const intruder = mk(TEAM.BLUE, 64, 120, DIR.DOWN);
      const d = intruder.distTo(RED_EAGLE.x, RED_EAGLE.y);
      const goal = EnemyAI._goal(red, gOf([red, intruder]), null);
      T('G: 防守席攔截到屏蔽半徑（距老鷹 96px > 門前 56px 也攔，不是等它貼牆）',
        d > DEMO_THREAT_RADIUS && d < DEMO_SCREEN_RADIUS &&
        !!goal && goal.defend === true && goal.x === intruder.x && goal.y === intruder.y,
        '距老鷹 ' + d.toFixed(1) + '／goal ' + JSON.stringify(goal));
    }

    // ② 空場：沒有敵車進屏蔽半徑 → 站到防線上，而且各守自己的橫座標
    {
      const red = mk(TEAM.RED, 16, 200, DIR.UP);
      const far = mk(TEAM.BLUE, 100, 300, DIR.UP);
      const goal = EnemyAI._goal(red, gOf([red, far]), null);
      T('G: 空場時防守席站到防線上（y＝老鷹＋DEMO_HOLD_LINE）',
        !!goal && goal.hold === true && goal.y === RED_EAGLE.y + DEMO_HOLD_LINE,
        JSON.stringify(goal));
      T('G: 上防線時保持自己的橫座標（四台車擠同一格會互相頂死在牆邊）',
        !!goal && goal.x === red.x, 'want x=' + (goal && goal.x) + '／mine ' + red.x);
      const onLine = mk(TEAM.RED, 16, RED_EAGLE.y + DEMO_HOLD_LINE, DIR.UP);
      T('G: 已經在防線上就順勢巡邏（不得原地旋轉／上下翻面是使用者紅線）',
        EnemyAI._goal(onLine, gOf([onLine, far]), null) === undefined);
      const deep = mk(TEAM.BLUE, 16, 200, DIR.UP);
      // 敵車在屏蔽半徑之外（距老鷹 188）→ 防線上的車不動身，
      // 前壓進對方半場就等於把家放空，這是原本 0.7% 本業占比的由來。
      const watcher = mk(TEAM.RED, 16, RED_EAGLE.y + DEMO_HOLD_LINE, DIR.UP);
      T('G: 防守席不跨過屏蔽半徑追進對方半場（攔不到就守住防線，不是前壓）',
        deep.distTo(RED_EAGLE.x, RED_EAGLE.y) > DEMO_SCREEN_RADIUS &&
        EnemyAI._goal(watcher, gOf([watcher, deep]), null) === undefined,
        '距老鷹 ' + deep.distTo(RED_EAGLE.x, RED_EAGLE.y).toFixed(1));
    }

    // ③ 優先級：門前那台比屏蔽半徑裡那台更急（老鷹被拆掉就立刻輸）
    {
      const red = mk(TEAM.RED, 100, 200, DIR.UP);
      const atGate = mk(TEAM.BLUE, 64, 60, DIR.DOWN);      // 距老鷹 36
      const inScreen = mk(TEAM.BLUE, 20, 110, DIR.DOWN);   // 距老鷹 ≈ 96
      const goal = EnemyAI._goal(red, gOf([red, atGate, inScreen]), null);
      T('G: 門前（DEMO_THREAT_RADIUS）那台優先於屏蔽半徑裡較遠的那台',
        !!goal && goal.x === atGate.x && goal.y === atGate.y &&
        atGate.distTo(RED_EAGLE.x, RED_EAGLE.y) < inScreen.distTo(RED_EAGLE.x, RED_EAGLE.y),
        'goal ' + JSON.stringify(goal));
    }

    // ④ 進攻席（批次五 J，收斂後）：位移只認對方主堡；「先打敵車」落在射擊層。
    //    批次五初版把追車寫成位移的預設目標，240 局實測破局率 31.7% → 18.3%，
    //    縮小追車範圍（只排背後／只過中線）也只回到 20.4% —— 所以位移退回去了。
    //    數與定義都在「node audit-hunt.js 240」，規則是「_shotTarget」那條沒動。
    {
      const blue = mk(TEAM.BLUE, 80, 200, DIR.UP);
      const roamer = mk(TEAM.RED, 8, 100, DIR.DOWN);       // 離藍車 123px：遠到不是格鬥
      const g1 = gOf([blue, roamer]);
      const goal = EnemyAI._goal(blue, g1, null);
      T('J: 進攻席的位移只認主堡——附近有敵車也不改道（追車已由 240 局量掉）',
        EnemyAI._nearestFoe(blue, g1) === null &&
        !!goal && goal.assault === true && goal.x === RED_EAGLE.x && goal.y === RED_EAGLE.y &&
        goal.hunt === undefined, JSON.stringify(goal));
      const two = mk(TEAM.BLUE, 80, 200, DIR.UP);
      const byFoeBase = mk(TEAM.RED, 8, 60, DIR.DOWN);     // 離紅鷹近、離藍車遠（157px）
      const byMe = mk(TEAM.RED, 80, 152, DIR.DOWN);        // 離藍車 48px（超過貼身 40）
      const g2 = gOf([two, byFoeBase, byMe]);
      T('J: 貼身圈外（>40px）的車再近也不追 —— 位移目標仍是主堡',
        EnemyAI._nearestFoe(two, g2) === null &&
        (() => { const q = EnemyAI._goal(two, g2, null); return !!q && q.assault === true && q.x === RED_EAGLE.x; })(),
        JSON.stringify(EnemyAI._goal(two, g2, null)));
      // 但是「打」的順序沒動：同軸前方真的有車時，這一槍仍先給車（下面 ⑤ 那一段）。
      const chaser = mk(TEAM.BLUE, 80, 150, DIR.UP);        // 中心 (88,158)：距紅鷹 136
      const behind = mk(TEAM.RED, 80, 210, DIR.DOWN);       // 中心 (88,218)：距藍車 60、在身後
      const ahead = mk(TEAM.RED, 80, 60, DIR.DOWN);         // 中心 (88,68)：距藍車 90、距紅鷹 48
      const gWay = gOf([chaser, behind, ahead]);
      T('J: 不追 ≠ 不打 —— 前面那台即使不该去追，同軸照樣是它的射擊優先權仍在車那一邊',
        EnemyAI._goal(chaser, gWay, null).assault === true &&
        EnemyAI._shotTarget(chaser, gWay) === 'tank',
        JSON.stringify(EnemyAI._shotTarget(chaser, gWay)));
      const gBack = gOf([chaser, behind]);
      T('J: 背後那台可以被「同軸向前」那條規則打到嗎？不能——它在身後，選靶照樣回 null',
        EnemyAI._shotTarget(chaser, gBack) === null,
        'dir=UP／foe y=' + (behind.y + 8) + ' vs 車 y=' + (chaser.y + 8));
      // 已經到家門口（≤56px）→ 位移與射擊在這裡會合：都改拆鷹
      const atGate = mk(TEAM.BLUE, 56, 56, DIR.UP);        // 中心 (64,64)：距紅鷹 40 ≤ 56
      const g3 = gOf([atGate, roamer]);
      T('J: 貼到對方主堡門口（≤AI_ASSAULT_RADIUS）→ 目標仍然是主堡，而且這一槍改瞄堡',
        EnemyAI._nearestFoe(atGate, g3) === null &&
        EnemyAI._foeBaseClose(atGate, RED_EAGLE) === true &&
        (() => { const q = EnemyAI._goal(atGate, g3, null); return !!q && q.assault === true && q.x === RED_EAGLE.x; })() &&
        EnemyAI._shotTarget(atGate, g3) === 'base',
        JSON.stringify(EnemyAI._goal(atGate, g3, null)) + '／shot=' + EnemyAI._shotTarget(atGate, g3));
      const halfway = mk(TEAM.BLUE, 80, 200, DIR.UP);      // 中心 (88,208)：距紅鷹 185 > 56
      T('J: 還沒到門口就不算「貼到主堡」—— 同一台敵車在前，半路不改瞄主堡',
        EnemyAI._foeBaseClose(halfway, RED_EAGLE) === false &&
        halfway.distTo(RED_EAGLE.x, RED_EAGLE.y) > AI_ASSAULT_RADIUS);
      const own = mk(TEAM.BLUE, BLUE_EAGLE.x, BLUE_EAGLE.y, DIR.UP);
      const ownGoal = EnemyAI._goal(own, gOf([own, roamer]), null);
      T('J: 進攻席絕不會站防線（守家只在「敵車已進自家門前」時發生）',
        !!ownGoal && ownGoal.assault === true && ownGoal.hold === undefined,
        JSON.stringify(ownGoal));
      const alone = mk(TEAM.BLUE, 80, 200, DIR.UP);
      const goal4 = EnemyAI._goal(alone, gOf([alone]), null);
      T('J: 場上沒有活敵車 → 壓向主堡，不要追不到人就原地發呆',
        !!goal4 && goal4.assault === true && goal4.x === RED_EAGLE.x && goal4.y === RED_EAGLE.y,
        JSON.stringify(goal4));
      const watcher = mk(TEAM.BLUE, 80, 200, DIR.UP);
      const ghost = mk(TEAM.RED, 80, 210, DIR.DOWN);
      ghost.spawnTimer = 20;                               // 出生無敵：追過去是白費
      const goal5 = EnemyAI._goal(watcher, gOf([watcher, ghost]), null);
      T('J: 三種局面（有活車／只有無敵中的車／沒人）→ 位移目標同一個，都是主堡',
        !!goal5 && goal5.assault === true && goal5.x === RED_EAGLE.x &&
        EnemyAI._goal(alone, gOf([alone]), null).assault === true &&
        EnemyAI._goal(two, g2, null).x === RED_EAGLE.x, JSON.stringify(goal5));
      // 三處同一把尺：進攻端的「門口」、防守端的「牆腳回防」、arena 的家門口計量
      T('J: 突襲門檻就是牆腳那把尺（AI_ASSAULT_RADIUS＝DEMO_THREAT_RADIUS＝56px）',
        AI_ASSAULT_RADIUS === DEMO_THREAT_RADIUS && AI_ASSAULT_RADIUS === 7 * CELL,
        'AI_ASSAULT_RADIUS=' + AI_ASSAULT_RADIUS);
      T('J: 批次二那條「擋路清障」已經整條拿掉（不留兩套預設互相蓋）',
        EnemyAI._blocker === undefined && typeof AI_BLOCK_REACH === 'undefined' &&
        typeof AI_ATTACK_CLEAR_SHARE === 'undefined');
      // 批次五初版的「追全場最近那台」（_nearestLivingFoe）同樣整條刪除：
      // 留著它等於留著一條隨時可以被誤接回去的支線，而 240 局的數已經說它該斷。
      T('J: 位移層追車的那支碼也拿掉了（_nearestLivingFoe 不存在，射擊層才是打車的地方）',
        EnemyAI._nearestLivingFoe === undefined);
      // 批次五只動「進攻席要不要改打人」這件事，防守席的移動目標一條都沒換。
      // 這一項是 G 那顆取樣釘子（兩席壓進敵半場的比例）的因果版：實測探針
      // （node audit-goals.js）量到紅隊在敵半場的幀全部來自 defend／hold／
      // duel 這三種「它本來就在那裡」的目標點，沒有一幀是 hunt／assault ——
      // 也就是「先打敵車」沒有把守家的車變成一路追到對方門口的前壓車。
      const guard = mk(TEAM.RED, 16, BLUE_EAGLE.y - 40, DIR.DOWN);  // 紅車跑到對方半場深處
      const prey = mk(TEAM.BLUE, 80, 200, DIR.UP);                  // 離紅車很遠（>112）的敵車
      const guardGoal = EnemyAI._goal(guard, gOf([guard, prey]), null);
      T('J: 防守席永遠拿不到 hunt／assault（批次五的改瞄只給進攻席，守家還是守家）',
        !!guardGoal && guardGoal.hunt === undefined && guardGoal.assault === undefined &&
        guardGoal.hold === true, JSON.stringify(guardGoal));
    }

    // ⑤ 開火選靶（批次五 J）：同軸有敵車就打車；同軸只有主堡、而且已貼到門口才拆鷹。
    {
      const foe = mk(TEAM.RED, 56, 40, DIR.DOWN);          // 中心 (64,48)：擋在藍車與紅鷹之間
      const off = mk(TEAM.RED, 120, 120, DIR.DOWN);        // 另一條走廊（不同軸）
      // 車和老鷹在同一條走廊上（紅鷹 x=64）、而且藍車已進門口：這一槍要挑人，不是挑地
      const linedBoth = mk(TEAM.BLUE, 56, 64, DIR.UP);     // 中心 (64,72)：距紅鷹 48 ≤ 56
      T('J: 同軸有敵車 → 這一槍瞄車，就算對方主堡也在同一條線上（車壓過堡）',
        EnemyAI._shotTarget(linedBoth, gOf([linedBoth, foe])) === 'tank',
        'got ' + EnemyAI._shotTarget(linedBoth, gOf([linedBoth, foe])));
      const atGate = mk(TEAM.BLUE, 56, 40, DIR.UP);        // 中心 (64,48)：距紅鷹 24 ≤ 56
      T('J: 已貼到門口、同軸只有主堡 → 改瞄主堡（base）',
        EnemyAI._shotTarget(atGate, gOf([atGate, off])) === 'base');
      const far = mk(TEAM.BLUE, 56, 200, DIR.UP);          // 中心 (64,208)：正對紅鷹但距 184
      T('J: 正對對方主堡卻還在門外（>56px）→ 這一槍沒有目標（舊版會在這裡開槍）',
        EnemyAI._shotTarget(far, gOf([far, off])) === null,
        '距紅鷹 ' + far.distTo(RED_EAGLE.x, RED_EAGLE.y).toFixed(0));
      const chaser = mk(TEAM.BLUE, 56, 200, DIR.UP);
      const gh = mk(TEAM.RED, 56, 150, DIR.DOWN); gh.spawnTimer = 20;
      const dd = mk(TEAM.RED, 56, 150, DIR.DOWN); dd.alive = false;
      T('J: 出生無敵中／已陣亡的敵車不當射擊目標（同軸也不算，否則為幽靈開槍）',
        EnemyAI._shotTarget(chaser, gOf([chaser, gh])) === null &&
        EnemyAI._shotTarget(chaser, gOf([chaser, dd])) === null);
      const facingBack = mk(TEAM.BLUE, 56, 200, DIR.RIGHT);   // 中心 (64,208)，朝右
      const behindFoe = mk(TEAM.RED, 8, 200, DIR.DOWN);       // 中心 (16,208)：同橫線、在背後
      T('J: 「同軸」要含方向：敵車在朝向的相反側不算前方（否則打自己身後）',
        EnemyAI._shotTarget(facingBack, gOf([facingBack, behindFoe])) === null,
        'dir=RIGHT／foe x=' + behindFoe.x);
    }

    // ⑥ 單人模式（沒有自己要塞）：舊的 40% 追／30% 打／巡邏一條都沒變
    {
      const enemy = mk(TEAM.RED, 64, 200, DIR.UP);
      const near = mk(TEAM.BLUE, 64, 240, DIR.DOWN);
      const away = mk(TEAM.BLUE, 8, 60, DIR.DOWN);
      const g3 = gOf([enemy, near, away], false);
      const chase = withRandom(0.2, () => EnemyAI._goal(enemy, g3, null));
      const strike = withRandom(0.5, () => EnemyAI._goal(enemy, g3, null));
      const patrol = withRandom(0.9, () => EnemyAI._goal(enemy, g3, null));
      T('G: 單人模式擲到追擊 → 最近那台（舊行為，角色化不碰它）',
        !!chase && chase.x === near.x && chase.y === near.y &&
        chase.assault === undefined && chase.defend === undefined,
        JSON.stringify(chase));
      T('G: 單人模式擲到打老鷹 → 玩家要塞（沒有 hold／push 旗標）',
        !!strike && strike.x === BLUE_EAGLE.x && strike.y === BLUE_EAGLE.y &&
        strike.assault === undefined, JSON.stringify(strike));
      T('G: 單人模式擲到巡邏 → 沒有目標（維持原本的第三條路）',
        patrol === undefined, JSON.stringify(patrol));
    }

    // ⑦ 防線本身：紅的往下推、藍的往上推，永遠夾在場內
    {
      const top = EnemyAI._holdLine(RED_EAGLE);
      const bottom = EnemyAI._holdLine(BLUE_EAGLE);
      T('G: 防線從老鷹往中場那一側推（用位置判斷，不看 team）',
        top === RED_EAGLE.y + DEMO_HOLD_LINE && bottom === BLUE_EAGLE.y - DEMO_HOLD_LINE &&
        top < FIELD_H / 2 && bottom > FIELD_H / 2,
        top + '／' + bottom + '／中場 ' + FIELD_H / 2);
      const edge = EnemyAI._holdLine({ x: 64, y: 8 });
      const edgeB = EnemyAI._holdLine({ x: 64, y: FIELD_H - 8 });
      T('G: 老鷹貼到場邊時防線仍留在場內（不然整隊被推出戰場）',
        edge >= TANK_PX && edgeB <= FIELD_H - TANK_PX, edge + '／' + edgeB);
    }
  }

  // ══════ 批次四（I）：開火節拍跟著「家裡有沒有事」 ══════
  // ladder 實測（ai/balance.js --mode ladder --terms）把防守席翻出來：純規則 AI
  // 一局只開 16.2 槍、擊殺 6.63，同一席換成隨機亂反而是開火 198.7 槍、擊殺 11.8，
  // 連 winRate 都從 75% 升到 88% —— 所以「愈隨機愈高分」不是尺歪，是老師真的打得
  // 比隨機差。修法只動兩件事：多久試一槍（節拍）與不同軸時值不值得開槍（壓制機率），
  // 轉向規則一條沒動。這一節把那張節拍表釘死在測試裡，免得日後又被「平均 50 幀冷卻」
  // 類似的改動無聲地退回去。
  console.log('-- batch4 fire cadence');
  {
    const mk = (team, x, y, dir) => {
      const t = new Tank(x, y, dir, false, {});
      t.team = team; t.spawnTimer = 0; t.cooldown = 0;
      t.aiShootTimer = 0; t.aiDirTimer = 0; t.aiWanted = null;
      return t;
    };
    const field = blankMap(new GameMap(0));
    field.bases = [];                 // 靶場不擺要塞：彈道安全閘不會干擾這一節
    const RED_EAGLE  = { x: 64, y: 24 };
    const BLUE_EAGLE = { x: 80, y: 312 };
    /** demo=false 就是單人模式（敵人沒有自己要塞），與批次二那節同一個形狀 */
    const gOf = (tanks, demo = true) => ({
      map: field, tanks, bullets: [],
      foesOf: t => tanks.filter(f => f.team !== t.team),
      ownBaseOf: t => (demo ? (t.team === TEAM.RED ? RED_EAGLE : BLUE_EAGLE) : null),
      foeBaseOf: t => (t.team === TEAM.RED ? BLUE_EAGLE : RED_EAGLE),
      allTanks: () => tanks,
      frozenFor: () => false,
    });
    const withRandom = (v, fn) => {
      const real = Math.random;
      Math.random = () => v;
      try { return fn(); } finally { Math.random = real; }
    };
    /** 驅動一幀（亂數固定成 v），回傳「這一幀打出去幾顆子彈」 */
    const step = (tank, game, v) => withRandom(v, () => {
      game.bullets.length = 0;
      tank.aiShootTimer = 0; tank.cooldown = 0;
      EnemyAI.update(tank, game);
      return game.bullets.length;
    });
    /** 驅動一幀，回傳「下一槍排在幾幀之後」 */
    const nextShotIn = (tank, game) => (step(tank, game, 0), tank.aiShootTimer);

    // ① 分級本身：貼身 ＞ 屏蔽圈 ＞ 自家半場 ＞ 沒事
    {
      const red = mk(TEAM.RED, 100, 200, DIR.UP);        // 中心 (108,208)
      const atScreen = mk(TEAM.BLUE, 64, 120, DIR.DOWN); // 中心 (72,128)：距紅鷹 104 < 112
      const g1 = gOf([red, atScreen]);
      T('I: 敵車進到自家屏蔽半徑（還沒貼身）→ 警戒 screen',
        EnemyAI._nearestFoe(red, g1) === null &&
        EnemyAI._alertLevel(red, g1, null) === 'screen',
        '距紅鷹 ' + Math.hypot(72 - 64, 128 - 24).toFixed(0) + '／屏蔽 ' + DEMO_SCREEN_RADIUS);
      const atHome = mk(TEAM.BLUE, 64, 158, DIR.DOWN);   // 中心 (72,166)：在紅半場、屏蔽圈外
      const g2 = gOf([red, atHome]);
      T('I: 敵車只踏進自家半場（屏蔽圈外）→ home（走廊還在自己手上，先壓制）',
        EnemyAI._alertLevel(red, g2, null) === 'home',
        '距紅鷹 ' + Math.hypot(72 - 64, 166 - 24).toFixed(0));
      const far = mk(TEAM.BLUE, 100, 300, DIR.UP);       // 在藍隊自己的半場
      const g3 = gOf([red, far]);
      T('I: 場上沒有車進自家半場 → idle（沒事的防守車不該拿到格鬥級節拍）',
        EnemyAI._alertLevel(red, g3, null) === 'idle', '敵車 y=' + far.y);
      // 同一台敵車同時在貼身與屏蔽圈裡 → 看誰贏
      const hug = mk(TEAM.RED, 64, 130, DIR.UP);         // 中心 (72,138)
      const close = mk(TEAM.BLUE, 64, 110, DIR.DOWN);    // 中心 (72,118)：距本車 20、距紅鷹 94
      const g4 = gOf([hug, close]);
      T('I: 貼身優先於屏蔽圈（duel 覆蓋 screen，v7 那條規則的排序不能倒）',
        EnemyAI._nearestFoe(hug, g4) !== null &&
        EnemyAI._alertLevel(hug, g4, EnemyAI._nearestFoe(hug, g4)) === 'duel' &&
        EnemyAI._alertLevel(hug, g4, null) === 'screen');
      T('I: 單人模式（敵車沒有自己要塞）→ 恆 idle，行為不受這一版影響',
        EnemyAI._alertLevel(red, gOf([red, atScreen], false), null) === 'idle');
    }

    // ② 節拍表：家裏愈有事 → 愈快試下一槍（舊版不分情況，一律 25～75 幀）
    {
      const near = () => mk(TEAM.BLUE, 64, 120, DIR.DOWN);
      const a = mk(TEAM.RED, 100, 200, DIR.UP);
      T('I: screen 級 → 下一槍排在 ' + AI_SCREEN_SHOOT_GAP + ' 幀後（舊版平均 50 幀，一局只剩十幾槍）',
        nextShotIn(a, gOf([a, near()])) === AI_SCREEN_SHOOT_GAP, a.aiShootTimer);
      const b = mk(TEAM.RED, 100, 200, DIR.UP);
      const home = mk(TEAM.BLUE, 64, 158, DIR.DOWN);
      T('I: home 級 → ' + AI_HOME_SHOOT_GAP + ' 幀（比 screen 鬆、比沒事緊）',
        nextShotIn(b, gOf([b, home])) === AI_HOME_SHOOT_GAP, b.aiShootTimer);
      const c = mk(TEAM.RED, 100, 200, DIR.UP);
      const quiet = mk(TEAM.BLUE, 100, 300, DIR.UP);
      T('I: idle 級維持原本那條 25～75 的擲骰（沒事不要亂開槍，spray 項在量的就是這個）',
        nextShotIn(c, gOf([c, quiet])) === 25, c.aiShootTimer);
      const d = mk(TEAM.RED, 64, 130, DIR.UP);
      const duel = mk(TEAM.BLUE, 64, 110, DIR.DOWN);
      T('I: duel 級仍是 8 幀起（格鬥那條沒被這一版動過）',
        nextShotIn(d, gOf([d, duel])) === 8, d.aiShootTimer);
      T('I: 節拍與壓制機率隨警戒單調：screen 比 home 急、home 比 idle 急',
        AI_SCREEN_SHOOT_GAP < AI_HOME_SHOOT_GAP && AI_HOME_SHOOT_GAP < 25 &&
        AI_SCREEN_BLIND > AI_HOME_BLIND && AI_HOME_BLIND > 0.04 &&
        AI_SCREEN_SHOOT_JITTER > 0 && AI_HOME_SHOOT_JITTER > 0,
        AI_SCREEN_SHOOT_GAP + '+' + AI_SCREEN_SHOOT_JITTER + '／' +
        AI_HOME_SHOOT_GAP + '+' + AI_HOME_SHOOT_JITTER + '／25+50｜擲骰 ' +
        AI_SCREEN_BLIND + '／' + AI_HOME_BLIND + '／0.04');
    }

    // ③ 不同軸也值得一槍（壓制、封走廊）—— 只在「家裡有事」那兩級成立
    {
      const t1 = mk(TEAM.RED, 100, 200, DIR.UP);
      const t2 = mk(TEAM.RED, 100, 200, DIR.UP);
      const near = () => mk(TEAM.BLUE, 64, 120, DIR.DOWN);
      const roll = AI_SCREEN_BLIND - 0.05;
      T('I: screen 級＋不同軸 → 擲中 ' + AI_SCREEN_BLIND + ' 就開槍（防守席那門炮不再是裝飾）',
        EnemyAI._shotTarget(t1, gOf([t1, near()])) === null &&
        step(t2, gOf([t2, near()]), roll) === 1, '擲 ' + roll.toFixed(2));
      const t3 = mk(TEAM.RED, 100, 200, DIR.UP);
      const far = mk(TEAM.BLUE, 100, 300, DIR.UP);
      T('I: 同樣的擲骰、同樣不同軸，idle 級照舊不開槍（偶發 0.04 那條沒被放大）',
        step(t3, gOf([t3, far]), roll) === 0, '擲 ' + roll.toFixed(2) + ' > 0.04');
      const t4 = mk(TEAM.RED, 100, 200, DIR.UP);
      const home = mk(TEAM.BLUE, 64, 158, DIR.DOWN);
      T('I: home 級的壓制擲在 ' + AI_HOME_BLIND + '（比 screen 鬆：半場有車不等於在打我家）',
        step(t4, gOf([t4, home]), AI_HOME_BLIND - 0.05) === 1 &&
        step(t4, gOf([t4, home]), AI_HOME_BLIND + 0.05) === 0);
    }

    // ④ 同軸的走廊槍：從 0.55 拉到 0.8 ，但仍是一擲骰
    {
      const foe = () => mk(TEAM.BLUE, 64, 120, DIR.DOWN);
      const a = mk(TEAM.RED, 64, 200, DIR.UP);
      const b = mk(TEAM.RED, 64, 200, DIR.UP);
      T('I: 同軸（走廊上真的有東西）→ 擲中 ' + AI_LINE_SHOOT + ' 就打（舊版 0.55）',
        EnemyAI._shotTarget(a, gOf([a, foe()])) === 'tank' &&
        step(b, gOf([b, foe()]), AI_LINE_SHOOT - 0.05) === 1);
      const c = mk(TEAM.RED, 64, 200, DIR.UP);
      T('I: 沒有改成必中 —— 擲輸仍不打，accuracy 那一項還有訊號可量',
        step(c, gOf([c, foe()]), AI_LINE_SHOOT + 0.05) === 0 && AI_LINE_SHOOT < 1);
    }

    // ⑤ 「用移動把自己擺進敵車那條走廊」嘗試過、量過之後刪了（實測把防守車從防線上
    //    拉走：p=0 均分 66.98 → 63.02，反轉幅度 −8.18 → −10.92）。留這條不是為了驗
    //    「代碼不在」，是為了記住它為什麼不在：誰想加回來，先量「會不會把車從它本來
    //    該站的位置帶走」，再把這條改成新的期望值。
    T('I: 對齊走廊那組規則（_laneDir／_shotLaneOpen）不在碼裡（量過、更差、已刪）',
      EnemyAI._laneDir === undefined && EnemyAI._shotLaneOpen === undefined);
  }

  // ══════ 競賽感（唯讀展示欄位）════════
  // game.js 為了觀戰面板新增的三個唯讀欄位：team.shots（耗彈）、G.killEvents
  // （擊殺播報）、t.serial（隊伍內出場編號）。訓練端不讀、規則不碰，
  // 這裡釘住的是「它們量得對」跟「它們不會反過來影響行為」（其餘測試全過即是）。
  console.log('-- 競賽感（唯讀展示）');
  {
    G.state = 'title'; G.demoMode = false; G.setupStage(1);
    G.startDemo(true, 0);
    T('競賽感: 開輪歸零（每隊 shots=0、killEvents=[]）',
      G.teams.every(t => t.shots === 0) && Array.isArray(G.killEvents) && G.killEvents.length === 0);
    T('競賽感: 開場 4 台都有隊伍內編號 serial（1 起、不重複）',
      G.teams.every(tm => {
        const nums = tm.tanks.map(t => t.serial).sort((a, b) => a - b);
        return nums.length === 4 && nums.every((n, i) => n === i + 1);
      }),
      G.teams.map(tm => tm.tanks.map(t => t.serial).join(',')).join(' / '));

    // 子彈誕生即計數：計量塊在 updateDemo 開頭，所以「掛進 bullets 的那一發」
    // 在同一次 update 裡剛好被數一次 —— 本幀其他車新開的砲要等下一幀才計。
    G.state = 'demo';
    const shooter = G.teams[0].tanks.find(t => t.alive);
    shooter.cooldown = 0; shooter.spawnTimer = 0;
    const before = G.teams[0].shots;
    const b = shooter.shoot(G.bullets);
    if (b) G.bullets.push(b);
    G.update();
    T('競賽感: 新子彈誕生 → 只有開火者那一隊 +1（同發不重複、不記到對手）',
      !!b && G.teams[0].shots === before + 1 && G.teams[1].shots === 0 && b.countedShot === true,
      'b=' + !!b + ' 藍 ' + before + '→' + G.teams[0].shots + '／紅 ' + G.teams[1].shots);

    // 打一場 soak：AI 滿場開火之後，兩隊都該有耗彈、事件都要長得像樣
    let kcrash = false;
    try { for (let i = 0; i < 600; i++) { G.update(); Renderer.tickFx(); } }
    catch (e) { kcrash = true; console.log(e.stack); }
    T('競賽感: 600 幀 soak 不炸（唯讀欄位不會反過來弄壞主迴圈）', !kcrash);
    T('競賽感: soak 後兩隊都有耗彈（子彈誕生即計數，不是事後回推）',
      G.teams.every(t => t.shots > 0), G.teams.map(t => t.shots).join('/'));
    T('競賽感: killEvents 每筆都有幀號＋雙方隊伍＋編號（Kill feed 的素材齊）',
      G.killEvents.length > 0 && G.killEvents.every(ev =>
        Number.isInteger(ev.frame) && ev.frame >= 0 &&
        (ev.killerTeam === 0 || ev.killerTeam === 1) &&
        (ev.victimTeam === 0 || ev.victimTeam === 1) &&
        Number.isInteger(ev.killerSerial) && Number.isInteger(ev.victimSerial)),
      '共 ' + G.killEvents.length + ' 筆');

    // 擊殺歸因：直接叫 creditKill（跟炸彈路徑同一個入口），驗「誰打爆誰」記得準
    const ks = G.teams[0].tanks.find(t => t.alive);
    const vs = G.teams[1].tanks.find(t => t.alive);
    const kBefore = G.killEvents.length;
    G.creditKill(ks, vs);
    const ev = G.killEvents[G.killEvents.length - 1];
    T('競賽感: creditKill 記下「誰在哪一幀打爆誰」（炸彈路徑同一個入口）',
      G.killEvents.length === kBefore + 1 && ev.killerTeam === 0 && ev.victimTeam === 1 &&
      ev.killerSerial === ks.serial && ev.victimSerial === vs.serial && ev.frame === G.frame);
    T('競賽感: 單人模式不生擊殺事件（creditKill 的 demoMode 閘）', (() => {
      G.state = 'title'; G.demoMode = false; G.setupStage(1);
      G.state = 'playing'; G.player.spawnTimer = 0; G.spawnEnemy();   // 敵人按節奏登場，直接補一台（跟 bomb 測試同一招）
      const p = G.player, e = G.enemies.find(t => t.alive);
      if (!p || !e) return false;
      const n = G.killEvents ? G.killEvents.length : 0;   // 觀戰遺留的事件不算數，比對的是「有沒有新增」
      G.creditKill(p, e);
      return (!G.killEvents || G.killEvents.length === n);
    })());
  }

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
