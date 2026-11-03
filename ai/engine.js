/* ai/engine.js — 無頭遊戲引擎（訓練／測試／觀戰共用）
   ═══════════════════════════════════════════════════════════
   跟 test-harness.js 不同的是這裡把「邏輯幀」當作一等公民：

     · 不用 requestAnimationFrame 的 timestep 累加器，直接呼叫
       game.updatePlaying() / game.updateDemo()，所以「跑了幾幀」
       是精確的，不會因為渲染耗時而飄移。
     · 渲染（draw / Renderer / HUD）整個關掉 —— 訓練時是純邏輯。
     · Math.random() 在載入時被換成 sandbox.__rand，因此可以對
       每個對局設定種子，重現同一盤棋。
     · 類別（GameMap / Tank / EnemyAI …）是 bundle 作用域的 const，
       外部看不到的；統一從 __expose 取，避免各處重複打补丁。
   ═══════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { mulberry32 } = require('./rng');

// index.html 的載入順序
// （js/stages.js 的 35 張手刻關卡已經刪掉：地形改由 js/mapgen.js 依 mapId 生成，
//   所以 mapgen.js 一定要在 map.js 之前，GameMap.load 會直接呼叫 MapGen）
const GAME_FILES = [
  'constants.js', 'input.js', 'audio.js', 'sprites.js', 'mapgen.js', 'map.js',
  'entities.js', 'ai.js', 'powerups.js', 'renderer.js', 'game.js',
];

const EXPOSE = '__expose = { Game, GameMap, Tank, Bullet, EnemyAI, PowerUp,'
  + ' Renderer, Sprites, UI, Input, Audio, MapGen,'
  // 幾何：9:21 之後寬高是兩個數，舊的 GRID/FIELD_PX 已從 constants.js 消失。
  // 訓練端全部要改成 GRID_W/GRID_H、FIELD_W/FIELD_H —— 少改一處不會報錯，
  // 只會「用寬比高」，於是一半的判定默默跑錯。
  + ' DIR, DIR_VEC, CELL_TYPE, CELL, GRID_W, GRID_H, TILE_W, TILE_H, TILE_PX,'
  + ' FIELD_W, FIELD_H, MAX_SCAN_CELLS, TANK_PX, SCALE, SPRITE_SS,'
  + ' STATE, T, TEAM, ENEMY_TYPE, ENEMY_STATS, POWERUP_TYPE, ARMOR_HP_COLORS,'
  + ' ENEMY_SPAWNS, PLAYER_SPAWN, DEMO_SPAWNS, DEMO_BASE_CELLS,'
  + ' MAP_VARIANTS, ENEMY_DIFF_CURVE,'
  + ' ENEMIES_PER_STAGE, MAX_ENEMIES_ON_FIELD, SPAWN_INTERVAL_MIN, SPAWN_INTERVAL_STEP,'
  + ' SPAWN_INTERVAL_FLOOR, SCORE_EXTRA_LIFE, SCORE_POWERUP,'
  + ' DEMO_TANKS_PER_TEAM, DEMO_MAX_ON_FIELD, DEMO_SPAWN_INTERVAL, DEMO_RESULT_FRAMES,'
  + ' DEMO_POWERUP_INTERVAL, DEMO_THREAT_RADIUS, DEMO_ROUND_CAP,'
  // 批次二（G）的兩個場高比例半徑：探針（ai/balance.js）要把「紅隊到底被叫回多遠」
  // 印出來當解讀依據，所以它必須跟 js/ai.js 讀同一個數，不能再抄一份。
  + ' DEMO_SCREEN_RADIUS, DEMO_HOLD_LINE,'
  + ' DEMO_ROLES, DEMO_ATTACK_TEAM, DEMO_DEFENSE_TEAM, DEMO_ATTACK_SECONDS,'
  + ' DEMO_ATTACK_SPAWN_INTERVAL, DEMO_TEAM_SPAWN_INTERVALS, demoRoleOf, DEMO_END_TEXT,'
  // 規則 AI 的行為參數也要能被訓練端讀到：
  // 「貼身格鬥」的半徑如果在 js/ai.js 和 ai/arena.js 各寫一份，
  // 調其中一邊就會變成「AI 以為的近距離」和「計量認為的近距離」不一樣。
  // 批次五（J）的 AI_ASSAULT_RADIUS（打敵車／打主堡的切換門檻）同理：
  // 它沿用 DEMO_THREAT_RADIUS 那把 56px 的尺，探針與計分都得讀同一個數。
  + ' AI_DUEL_RADIUS, AI_BACK_AFTER, AI_ASSAULT_RADIUS,'
  // 批次四（I）的火力節拍表：訓練端與探針要能把「老師一局開幾槍」跟「節拍是多少」
  // 放在一起讀，所以這些常數也只能有一份（在 js/ai.js），這裡只是接出去。
  + ' AI_DUEL_SHOOT, AI_DUEL_REPICK, AI_LINE_SHOOT,'
  + ' AI_SCREEN_SHOOT_GAP, AI_SCREEN_SHOOT_JITTER, AI_SCREEN_BLIND,'
  + ' AI_HOME_SHOOT_GAP, AI_HOME_SHOOT_JITTER, AI_HOME_BLIND,'
  + ' FIREPOWER, PLAYER_SPEED, TARGET_FPS, FRAME_MS, boxesOverlap };';

/** 讀出遊戲原始碼（單一 bundle 字串） */
function readBundle(jsDir) {
  return GAME_FILES
    .map(f => fs.readFileSync(path.join(jsDir, f), 'utf8'))
    .join('\n;\n');
}

/**
 * 建立一個無頭引擎實例。
 * @param {object} o
 *   o.jsDir   遊戲 js 目錄（預設 <repo>/js）
 *   o.seed    亂數種子（預設 1）
 *   o.stage   開機後停在哪一關（預設 1）
 */
function createEngine(o = {}) {
  const jsDir = o.jsDir || path.join(__dirname, '..', 'js');
  const listeners = {};
  const rafQueue = [];
  let ts = 0;

  const noopCtx = () => new Proxy({}, { get: () => () => {}, set: () => true });
  const canvasStub = () => ({ width: 0, height: 0, getContext: noopCtx });
  const elStub = () => ({ textContent: '', innerHTML: '', style: {}, classList: { add() {}, remove() {} } });
  const storage = {};

  const sandbox = {
    console, Math, JSON, Date, Object, Array, Set, Map,
    String, Number, Boolean, Error, Float64Array, Float32Array, Uint8Array, isNaN, isFinite, parseInt, parseFloat,
    performance: { now: () => ts },
    requestAnimationFrame: fn => { rafQueue.push(fn); return rafQueue.length; },
    cancelAnimationFrame() {},
    localStorage: {
      getItem: k => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
    },
    __rand: Math.random,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.document = {
    getElementById: id => (id === 'gameCanvas' ? canvasStub() : elStub()),
    createElement: tag => (tag === 'canvas' ? canvasStub() : elStub()),
    querySelector: () => elStub(),
    addEventListener() {},
  };
  sandbox.addEventListener = (type, fn) => { (listeners[type] ||= []).push(fn); };
  vm.createContext(sandbox);

  // 無頭：渲染與 HUD 整個撲掉，訓練迴圈只剩規則運算
  let src = readBundle(jsDir);
  src = src.split('Math.random()').join('__rand()');
  src += '\n;' + EXPOSE;
  src += '\n;__installStubs = function () {'
    + '  const noop = function () {};'
    + '  Game.prototype.draw = noop;'
    + '  for (const k of ["init", "clear", "clearFx", "drawMap", "drawForestOverlay",'
    + '                   "drawTank", "drawBullet", "drawPowerUp", "drawFx", "tickFx",'
    + '                   "overlay", "spawnExplosion", "spawnPopup"]) Renderer[k] = noop;'
    + '  UI.init = noop; UI.update = noop;'
    + '};';
  // 把 Node 側的 ai/ 模組掛進 sandbox，讓遊戲碼能建立 controller
  sandbox.__AI = Object.assign({}, o.aiModules || {});
  src += '\n;window.AI = (typeof __AI !== "undefined" && __AI) || null;';
  vm.runInContext(src, sandbox, { filename: 'bundle.js' });
  vm.runInContext('__installStubs();', sandbox, { filename: 'stubs.js' });
  (listeners.DOMContentLoaded || []).forEach(fn => { try { fn(); } catch (e) { e.bundleLoad = true; throw e; } });

  const R = sandbox.__expose;
  const game = sandbox.__game;
  if (!game) throw new Error('engine: 遊戲未啟動（__game 不存在）');

  const engine = {
    sandbox,
    game,
    R,                                   // 類別與常數參考
    get seedValue() { return sandbox.__seedValue; },

    /** 換亂數種子；同一種子 ⇒ 同一盤棋 */
    setSeed(seed) {
      sandbox.__seedValue = seed >>> 0;
      sandbox.__rand = mulberry32(seed >>> 0);
      return engine;
    },

    /** 精確推進 n 個邏輯幀：走遊戲自己的狀態機，只繞開渲染與 timestep */
    step(n = 1) {
      for (let i = 0; i < n; i++) {
        ts += 1000 / 60;
        game.inputUpdate();
        game.update();
        game.stepFx();
      }
      return engine;
    },

    /** 一直跑到 predicate 成立或上限幀到；回傳實際跑的幀數 */
    until(predicate, maxFrames = 20000) {
      let f = 0;
      while (f < maxFrames && !predicate()) { engine.step(1); f++; }
      return f;
    },

    /** 注入鍵盤（給需要人類輸入路徑的測試用） */
    key(k, type = 'keydown') {
      (listeners[type] || []).forEach(fn => fn({ key: k, preventDefault() {} }));
      return engine;
    },

    /** 推進真實的 rAF 迴圈（只在需要驗證主迴圈本身時用） */
    rafFrames(n) {
      for (let i = 0; i < n; i++) { ts += 1000 / 60; const fn = rafQueue.shift(); if (fn) fn(ts); }
      return engine;
    },
  };

  engine.setSeed(o.seed ?? 1);
  return engine;
}

module.exports = { createEngine, GAME_FILES, readBundle };
