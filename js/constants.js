/* ═══════════════════════════════════════════
   constants.js — 所有常數與列舉（單一真相來源）

   座標系統（原版 Battle City 規格）：
   - 邏輯單位 = 像素，1 子格(cell) = 8px
   - 戰場 = 26×26 cells = 208×208 px
   - 坦克 = 2×2 cells = 16×16 px
   - 磚牆以 1 cell（8×8）為最小破壞單位
   - 畫布 416×416（SCALE=2）；貼圖另以 SPRITE_SS=2 的细节解析度繪製，
     故 1 個美術像素 = 1 個裝置像素（SCALE / SPRITE_SS = 1）
   ═══════════════════════════════════════════ */

const CELL = 8;               // 1 sub-cell = 8 logical px
const GRID = 26;              // 26×26 cells
const FIELD_PX = GRID * CELL; // 208×208 logical px
const SCALE = 2;              // canvas = FIELD_PX × SCALE = 416
const SPRITE_SS = 2;          // 貼圖細節倍率：native = 邏輯尺寸 × SPRITE_SS

const TANK_PX = 2 * CELL;     // tank is 16×16 px (2×2 cells)
const BULLET_PX = 4;          // bullet visual/collision box

// ── Cell values in the 26×26 map ──
const CELL_TYPE = Object.freeze({
  EMPTY:  0,
  BRICK:  1,   // destructible per-cell
  STEEL:  2,   // destructible only by L4 firepower
  WATER:  3,   // blocks tanks, not bullets
  FOREST: 4,   // passable, hides tanks
  ICE:    5,   // passable, slippery
  BASE:   6,   // eagle — one hit = game over
});

// ── Directions (bit flags, easy opposite = dir ^ 2) ──
const DIR = Object.freeze({ UP: 0, RIGHT: 1, DOWN: 2, LEFT: 3 });
const DIR_VEC = Object.freeze([
  { dx: 0, dy: -1 },
  { dx: 1, dy:  0 },
  { dx: 0, dy:  1 },
  { dx: -1, dy: 0 },
]);

// ── Eagle (2×2 cells at bottom center) ──
const BASE_CELL_X = 12;       // cells (12..13, 24..25)
const BASE_CELL_Y = 24;

// ── Spawn points (top edge, px = top-left of 16px tank box) ──
const ENEMY_SPAWNS  = Object.freeze([0, 96, 192]);
const PLAYER_SPAWN  = Object.freeze({ x: 64, y: 192 });

// ══════════ A.I. 對戰（觀戰模式）══════════
// 兩隊各守一座老鷹：藍隊在下（既有基地位），紅隊在上（鏡像位）。
// 出生點對稱分佈在各自底邊，x=64/128 避開中央 px 96..111 的基地。
const TEAM = Object.freeze({ BLUE: 0, RED: 1 });

const DEMO_BASE_CELLS = Object.freeze([
  { cx: BASE_CELL_X, cy: BASE_CELL_Y },   // 藍隊（下）
  { cx: BASE_CELL_X, cy: 0 },             // 紅隊（上，鏡像）
]);

const DEMO_SPAWN_XS = Object.freeze([0, 64, 128, 192]);
const DEMO_SPAWNS = Object.freeze([
  DEMO_SPAWN_XS.map(x => ({ x, y: FIELD_PX - TANK_PX })), // 藍：底邊
  DEMO_SPAWN_XS.map(x => ({ x, y: 0 })),                  // 紅：頂邊
]);

const DEMO_TANKS_PER_TEAM  = 20;   // 每隊可出動的坦克池
const DEMO_MAX_ON_FIELD    = 4;    // 場上同時數量（與單人版一致）
const DEMO_SPAWN_INTERVAL  = 150;  // 出生間隔幀
const DEMO_RESULT_FRAMES   = 300;  // 結果畫面停留
const DEMO_POWERUP_INTERVAL = 600; // 場上道具補充間隔
const DEMO_THREAT_RADIUS   = 56;   // 敵車進入自家基地此距離內 → 回防攔截
const DEMO_ROUND_CAP       = 5400; // 一輪最多 90 秒，到時比積分

// ── Enemy types ──
const ENEMY_TYPE = Object.freeze({ BASIC: 0, FAST: 1, POWER: 2, ARMOR: 3 });
const ENEMY_STATS = Object.freeze({
  [ENEMY_TYPE.BASIC]: { hp: 1, speed: 1.0,  bulletSpeed: 4, score: 100, body: '#c8a84b', name: '輕型' },
  [ENEMY_TYPE.FAST]:  { hp: 1, speed: 2.0,  bulletSpeed: 4, score: 200, body: '#7fb0d8', name: '裝甲車' },
  [ENEMY_TYPE.POWER]: { hp: 1, speed: 1.0,  bulletSpeed: 8, score: 300, body: '#d88fc0', name: '速射' },
  [ENEMY_TYPE.ARMOR]: { hp: 4, speed: 0.75, bulletSpeed: 4, score: 400, body: '#9ad89a', name: '重型' },
});
// ARMOR tank color per remaining HP (4→1: green → yellow → orange → white)
const ARMOR_HP_COLORS = Object.freeze(['#ffffff', '#f0a040', '#e8d878', '#9ad89a']);

// ── Player firepower levels ──
const FIREPOWER = Object.freeze({
  L1: 1,   // slow bullet, 1 on screen
  L2: 2,   // fast bullet, 1 on screen
  L3: 3,   // fast bullet, 2 on screen
  L4: 4,   // + destroys steel
});
const PLAYER_SPEED = 1.5;

// ── Power-ups ──
const POWERUP_TYPE = Object.freeze({
  STAR: 0, BOMB: 1, CLOCK: 2, SHOVEL: 3, SHIELD: 4, TANK: 5,
});

// ── Game rules ──
const ENEMIES_PER_STAGE   = 20;
const MAX_ENEMIES_ON_FIELD = 4;
const FLASH_KILL_INDICES  = Object.freeze([4, 11, 18]); // 1-based kills that carried power-ups
const SPAWN_INTERVAL_MIN  = 120;   // frames, stage 1
const SPAWN_INTERVAL_STEP = 4;     // −frames per stage
const SPAWN_INTERVAL_FLOOR = 60;
const SCORE_EXTRA_LIFE    = 20000;
const SCORE_POWERUP       = 500;

// ── Timers (frames @60fps) ──
const T = Object.freeze({
  SPAWN_ANIM:   60,    // spawn star animation, invincible
  PLAYER_RESPAWN_SHIELD: 180, // 3 s
  CLOCK_FREEZE: 600,   // 10 s
  SHIELD:       600,   // 10 s
  SHOVEL:      1200,   // 20 s
  POWERUP_BLINK: 480,  // power-up disappears after 8 s if untouched
  STAGE_INTRO:  90,
  STAGE_CLEAR:  180,
});

// ── Game states ──
const STATE = Object.freeze({
  TITLE:       'title',
  STAGE_INTRO: 'stage_intro',
  PLAYING:     'playing',
  PAUSED:      'paused',
  STAGE_CLEAR: 'stage_clear',
  GAME_OVER:   'game_over',
  DEMO_INTRO:  'demo_intro',
  DEMO:        'demo',
  DEMO_RESULT: 'demo_result',
});

const TARGET_FPS = 60;
const FRAME_MS = 1000 / TARGET_FPS;
