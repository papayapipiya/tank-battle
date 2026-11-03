/* ═══════════════════════════════════════════
   constants.js — 所有常數與列舉（單一真相來源）

   座標系統（2026-11-01：使用者指定「地圖改成 9:21、地圖放大、地圖隨機」）：
   - 邏輯單位 = 像素，1 子格(cell) = 8px
   - 戰場 = 18×42 cells = 144×336 px = 9×21 tile ⇒ 寬:高 = 9:21（直立長廊）
   - 坦克 = 2×2 cells = 16×16 px
   - 磚牆以 1 cell（8×8）為最小破壞單位
   - 畫布 288×672（SCALE=2）；貼圖另以 SPRITE_SS=2 的細節解析度繪製，
     故 1 個美術像素 = 1 個裝置像素（SCALE / SPRITE_SS = 1）
   - 「放大」由 css/style.css 的 #gameCanvas 負責：位圖只被 CSS **放大**
     （高度 clamp 的下限就是 1:1 的 672px），絕不縮小 —— `pixelated` 的畫布
     一旦往下採樣就會整行整列丟像素，地圖鋸齒、坦克邊緣抖。
   - 旧的 26×26（13×13 tile 正方形）整套換掉：所有引用拆成
     GRID_W/GRID_H、FIELD_W/FIELD_H。留一個同名 GRID 反而讓後面的程式
     默默拿寬去比高 —— 那種錯不會報錯，只會長出半張牆。
   ═══════════════════════════════════════════ */

const CELL = 8;               // 1 sub-cell = 8 logical px
const GRID_W = 18;            // 18 cells 寬 = 9 tiles
const GRID_H = 42;            // 42 cells 高 = 21 tiles
const TILE_W = GRID_W / 2;    // 9 tiles
const TILE_H = GRID_H / 2;    // 21 tiles
const FIELD_W = GRID_W * CELL;  // 144 邏輯 px
const FIELD_H = GRID_H * CELL;  // 336 邏輯 px
const SCALE = 2;              // canvas = 288×672，CSS 再依視窗高度放大
const SPRITE_SS = 2;          // 貼圖細節倍率：native = 邏輯尺寸 × SPRITE_SS

const TANK_PX = 2 * CELL;     // tank is 16×16 px (2×2 cells)
const TILE_PX = 2 * CELL;     // 1 個地形 tile = 16×16 px（尺寸剛好等於一台車）
const BULLET_PX = 4;          // bullet visual/collision box

/* 「沿直線一格一格掃到位」的步數上限 = 較長那一軸。
   9:21 之後寬 18、高 42 不再是同一個數，而彈道安全判定（js/ai.js、
   ai/controller.js、ai/teacher.js）掃的是「坦克正前方到場尾」——
   用寬當上限的話，豎著看自家老鷹只掃 18 格＝144px，長場的下面一半
   根本沒檢查，規則就等於沒上。三個實作共用同一個常數才不會各算各的。 */
const MAX_SCAN_CELLS = Math.max(GRID_W, GRID_H);

// ── Cell values in the 18×42 map ──
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
// 18 格寬 ⇒ 老鷹占 cell 8..9，中心正好落在 FIELD_W/2 = 72px 的中軸線上。
const BASE_CELL_X = (GRID_W - 2) / 2;   // 8
const BASE_CELL_Y = GRID_H - 2;         // 40（cell 40..41 = 底邊）

// ── Spawn points (top edge, px = top-left of 16px tank box) ──
// 144px 寬的場頂邊放三個出生點：0 / 64 / 128（每台車 16px，最右那個正好貼邊）。
const ENEMY_SPAWNS  = Object.freeze([0, 64, 128]);
// 玩家在底邊，x=32 避開老鷹的 cell 8..9（px 64..79）
const PLAYER_SPAWN  = Object.freeze({ x: 32, y: FIELD_H - TANK_PX });

// ══════════ A.I. 對戰（觀戰模式）══════════
// 兩隊各守一座老鷹：藍隊在下（既有基地位），紅隊在上（鏡像位）。
//
// 出生點有兩條硬性約束，亂給會產生「看不出來但會咬人」的 bug：
//   1) x 必須是 16 的倍數（= 對齊 tile）。坦克轉向只吸附到 8px 的 cell 邊界，
//      出生位置若卡在兩個 tile 中間（例如 x=40），實測會讓第一台車在
//      一 tile 寬的通道口卡住 —— 地形是 tile 級的，車也必須 tile 級才走得動。
//   2) 四點要成點對稱：鏡像是 x → FIELD_W - TANK_PX - x = 128 - x，
//      所以 0↔128、32↔96 互為對面那一隊的位置。少這一條，兩隊開局
//      面對的地形就不等价（這是 v6 之前修過的紅藍不對稱偏置）。
// 兩點都避開老鷹的 px 64..79（cell 8..9）—— 不然 _clearBox 會把老鷹鏟掉。
const TEAM = Object.freeze({ BLUE: 0, RED: 1 });

const DEMO_BASE_CELLS = Object.freeze([
  { cx: BASE_CELL_X, cy: BASE_CELL_Y },   // 藍隊（下）
  { cx: BASE_CELL_X, cy: 0 },             // 紅隊（上，鏡像）
]);

const DEMO_SPAWN_XS = Object.freeze([0, 32, 96, 128]);
const DEMO_SPAWNS = Object.freeze([
  DEMO_SPAWN_XS.map(x => ({ x, y: FIELD_H - TANK_PX })), // 藍：底邊
  DEMO_SPAWN_XS.map(x => ({ x, y: 0 })),                 // 紅：頂邊
]);

const DEMO_TANKS_PER_TEAM  = 20;   // 每隊可出動的坦克池
const DEMO_MAX_ON_FIELD    = 4;    // 場上同時數量（與單人版一致）
const DEMO_SPAWN_INTERVAL  = 150;  // 防守方（紅）出生間隔幀
const DEMO_RESULT_FRAMES   = 300;  // 結果畫面停留
const DEMO_POWERUP_INTERVAL = 600; // 場上道具補充間隔
const DEMO_THREAT_RADIUS   = 56;   // 敵車進入自家基地此距離內 → 回防攔截

/* ══════════ 批次二（G）：防守的「門前」要按場高算，不是拍腦袋 ══════════
   DEMO_THREAT_RADIUS=56 是 13×13 正方形場時代留下的數：那時候全場才 208px 高，
   56px ≈ 1/4 場。改成 9:21（336px）之後它只剩 1/6 場高，實測後果是
   「防守模型 44.8% 的在場幀待在敵半場、本業占比 0.7%」——
   不是它不想守，是沒有任何東西叫它留在門口：56px 內沒人時它就去做中性駕駛了。

     · DEMO_SCREEN_RADIUS = 場高 1/3（112px）
         紅隊「家門前」的屏蔽半徑。這個距離內的敵車一律去攔。
         不取 1/2 的原因：半徑一大就變成「整場都是我的責任」，
         跟原本的 40% 追擊沒兩樣，等於沒改。
     · DEMO_HOLD_LINE = 場高 1/6（56px）
         沒有威脅時站的位置：從自家老鷹往中場挪一格車長的 3.5 倍，
         正好是「子彈一發（4px/幀）要飛 14 幀」的距離，來得及攔也還沒出半場。
   兩個數都寫成 FIELD_H 的函數，之後再改地圖尺寸會自動跟著走 ——
   寫死就是下一次失衡的來源。 */
const DEMO_SCREEN_RADIUS = Math.round(FIELD_H / 3);   // 112px ≈ 1/3 場高
const DEMO_HOLD_LINE = Math.round(FIELD_H / 6);       //  56px：老鷹前方的防線

/* ══════════ 地圖：隨機產生，不再是 35 張手刻關卡 ══════════
   使用者要「地圖隨機」。實作方式是「一張一張編號的地形」，不是「每次開頁
   亂數到不知道哪裡」：mapId（0..MAP_VARIANTS-1）→ 固定種子 → 固定地形。

     · 觀戰：每一輪抽一個新的 mapId ⇒ 一直看下去不會重複同樣的戰場，
       但「重開本輪」仍會精確重現同一張圖（不然 R 鍵變成換圖）。
     · 單人：STAGE n → mapId = (n-1) % MAP_VARIANTS。
     · 訓練：考題 `--stages 0,1` 吃的就是 mapId ⇒ 同一份 checkpoint 的
       分數仍然可比（這是「今天跑 100 場、明天接得回去」的前提），
       而地形本身已經是完全隨機生成的。想換一批考題就換 mapId 清單，
       換了會觸發冠軍重評（見 ai/evolve.js 的 examChange）。

   為什麼要一個上限值而不是任意整數：`--stages` 的輸入驗證、HUD 的
   「地圖 N／255」顯示、◀▶ 的環繞都需要一個明確的邊界。 */
const MAP_VARIANTS = 255;

/* 出兵組成的難度曲線長度（js/ai.js 的 EnemyAI.pickType 在 n=21 封頂）。
   地形改成隨機編號 0..254 之後，直接把 mapId+1 餵給 pickType 會讓
   「編號 ≥ 20 的地圖」全數跑最硬的那一組；取模才能讓 255 張圖
   仍然分散在整條難度曲線上，而且同一張圖的出兵組合永遠一樣。 */
const ENEMY_DIFF_CURVE = 21;

/* ══════════ 攻守分工（使用者要的「修正一個方向」）══════════
   藍隊＝進攻方：唯一的贏法是摧毀紅隊老鷹，積分、擊殺都不算贏。
   紅隊＝防守方：守住老鷹就贏 —— 包含「30 秒到還沒有結果」這一種。

   兩隊各自有各自的訓練模型（ai/roles.js），不再是同一隻網路換座位。

   DEMO_ROUND_CAP 用 60 而不是 TARGET_FPS：TARGET_FPS 在本檔更後面才宣告，
   const 有暫時性死區，前面引用會直接 ReferenceError。
   test-harness.js 有一條測試盯 30 × TARGET_FPS === DEMO_ROUND_CAP，
   所以倍率真的改了也不會悄悄跑成 90 秒。 */
const DEMO_ROLES = Object.freeze({ ATTACK: 'attack', DEFENSE: 'defense' });
const DEMO_ATTACK_TEAM  = TEAM.BLUE;   // 進攻方坐哪一隊
const DEMO_DEFENSE_TEAM = TEAM.RED;    // 防守方坐哪一隊
const DEMO_ATTACK_SECONDS = 30;        // 超過就判防守方（紅）贏
const DEMO_ROUND_CAP = DEMO_ATTACK_SECONDS * 60;   // 1800 幀

/* 時鐘天生偏袒防守方（什麼都不做就能贏），所以出兵節奏補給進攻方：
   藍隊 100 幀（1.7 秒）一台、紅隊 150 幀（2.5 秒）一台。場上限 4 台不變，
   差的是「被打掉之後多久補上」，讓突破方有連續壓力而不是送完就沒。

   ⚠ 批次二（H）重新校準過的結論：這組 100／150 維持不動，而且是量出來的。
   把 `js/ai.js` 角色化之後重跑 `node ai/balance.js --mode matrix --maps 16`
   （48 局／局面，同圖同種子），四個組合的 rule·rule 結果：
     藍100／紅150 → 藍勝 31.3%，均分 60.30 vs 61.18（差 −1.4%）
     藍 90／紅150 → 藍勝 22.9%，均分 47.61 vs 66.78（差 −28.7%）
     藍100／紅170 → 藍勝 33.3%，均分 64.70 vs 53.88（差 +20.1%）
     藍 90／紅170 → 藍勝 35.4%，均分 63.93 vs 56.86（差 +12.4%）
   「給藍隊更快出兵」在這一版反而把藍隊推得更差（研究報告原本的建議是 100→90）：
   場上限還是 4 台，加快出兵只是讓更多車排隊撞進紅隊新的屏蔽線，
   換來的是自家門口的時間被吃掉。真正的勝負率仍偏紅（31／69），
   但那是 30 秒倒數的結構（報告 §I，留給使用者決定），不是出兵節奏。
   —— 調這種槓桿請連同 rule·rule 的均分差一起看，只看獲勝率會被倒數騙。 */
const DEMO_ATTACK_SPAWN_INTERVAL = 100;
const DEMO_TEAM_SPAWN_INTERVALS = Object.freeze(
  [DEMO_ATTACK_SPAWN_INTERVAL, DEMO_SPAWN_INTERVAL]);

/** 這一隊是進攻還是防守（單人模式的敵人回傳 null） */
function demoRoleOf(teamId) {
  if (teamId === DEMO_ATTACK_TEAM) return DEMO_ROLES.ATTACK;
  if (teamId === DEMO_DEFENSE_TEAM) return DEMO_ROLES.DEFENSE;
  return null;
}

/** 終局說明：哪一個條件先成立就寫哪一句（結算畫面與訓練報告共用） */
const DEMO_END_TEXT = Object.freeze({
  breach: `${DEMO_ATTACK_SECONDS} 秒內摧毀紅隊老鷹 —— 藍隊進攻成功`,
  counter: '藍隊老鷹被摧毀 —— 紅隊反守為攻',
  time: `時間到（${DEMO_ATTACK_SECONDS} 秒未破局）—— 紅隊防守成功`,
  pool: '雙方兵力耗盡而紅隊老鷹仍在 —— 紅隊防守成功',
});

/**
 * 「自己人打爆自家老鷹」的說明。
 * ⚠ 這不是一種新的 reason：終局條件還是那四個（breach／counter／time／pool），
 *   訓練端很多斷言都建立在「reason 只有這四種」上。兇手是誰是另一個維度，
 *   所以放在 demoResult.ownGoal + 這段覆寫文字，不去擴 reason 的集合。
 */
const DEMO_OWN_GOAL_TEXT = Object.freeze({
  breach: '紅隊老鷹被自己人打爆 —— 藍隊不戰而勝',
  counter: '藍隊老鷹被自己人打爆 —— 紅隊不戰而勝',
});

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
