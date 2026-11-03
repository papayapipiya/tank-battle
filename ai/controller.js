/* ai/controller.js — 把外部 policy 接到坦克上
   ═══════════════════════════════════════════════════════════
   原本只有玩家坦克讀鍵盤、其餘坦克跑 EnemyAI。
   這層把「誰決定這台車怎麼動」抽成 controller：

     rule    → EnemyAI（現況行為，預設）
     policy  → 外部 policy（NEAT 基因組、隨機策略、錄製的人類操作…）

   ⚠ 行為等價性：沒有指定 controller 時，遊戲碼走的還是原本那條路；
     單人模式的玩家仍由 game.updatePlaying() 直接讀鍵盤（不經這層），
     所以既有 57 項回歸測試不受影響。

   ⚠ controller 跑在 Node 側（vm 之外），拿不到 bundle 作用域的 const，
     所以 EnemyAI 與亂數函數都由 game 物件傳進來（game.AI / game.rand）。
   ═══════════════════════════════════════════════════════════ */
(function (root) {      // IIFE：見 ai/actions.js 頭部說明
'use strict';

const hasRequire = typeof require === 'function' && typeof module !== 'undefined';
const Observation = hasRequire ? require('./observation') : window.AIObservation;
const ACTIONS = hasRequire ? require('./actions').ACTIONS : window.AIActions.ACTIONS;

/** 觀測 front 段的起點：最後 LEN.front 欄依序是 UP/RIGHT/DOWN/LEFT 走不通=1 */
const FRONT_BASE = () => Observation.OBS_DIM - Observation.LEN.front;

// 與 js/constants.js 同步（本檔跑在 vm 外，拿不到 bundle 裡的 const）。
// ⚠ 這裡只留「查不到 map 時」的後備值（測試用的假 map）。
//   真正的邊界一律從 map.cells 現讀：`map.cells.length` 就是高、
//   `map.cells[0].length` 就是寬 —— 9:21 之後寬高不同，把 26 這種數
//   抄進這支碼，改地圖時一定只改到一半（而且不會報錯）。
const CELL_PX = 8, GRID_W_FB = 18, GRID_H_FB = 42;
const CT = { BRICK: 1, STEEL: 2, WATER: 3 };
const UNIT = [[0, -1], [1, 0], [0, 1], [-1, 0]];        // DIR.UP / RIGHT / DOWN / LEFT

/** 這張 map 的 cell 尺寸（寬, 高）；假 map 沒有 cells 時退回後備常數 */
function gridOf(map) {
  const rows = map && map.cells;
  if (Array.isArray(rows) && Array.isArray(rows[0])) return [rows[0].length, rows.length];
  return [GRID_W_FB, GRID_H_FB];
}

/** 這一格會不會擋子彈？只有磚、鋼，以及出界。
    ⚠ 水與樹林**不擋子彈**（js/map.js bulletHit 的真相），
    以前把水當成「擋住 → 這一槍安全」，等於允許坦克隔著水打自家老鷹。 */
function stopsBullet(t) { return t === CT.BRICK || t === CT.STEEL; }

/** 這一格是不是「要塞的牆」——老鷹外圍那圈磚（鏟子變成鋼也算） */
function fortressWallAt(map, own, cx, cy) {
  if (map.isFortressWall) return map.isFortressWall(own, cx, cy);
  // 測試／外部 map stub 可能沒有 ring 查詢；退回直接查 ringKeys。
  // 走到這裡代表該格已經確定是磚或鋼，不需要再確認是否實心。
  // 索引換算的寬度要跟 js/map.js 建 ringKeys 時用的同一個數（現讀 map.cells），
  // 否則「第 30 列」在兩邊會落到不同的格，判定隨機地錯。
  const [gw] = gridOf(map);
  return !!(own.ringKeys && own.ringKeys.has(cy * gw + cx));
}

/**
 * 子彈沿目前朝向飛出去，會不會傷到「自己家的要塞」？
 * ═══════════════════════════════════════════════════════════
 * 使用者規則（v6）：自己人要避開對自己要塞的開火 ——
 * 打到老鷹本體，或打到老鷹外圍那圈要塞牆，都算傷到要塞，一律不準開。
 * 但如果彈道算過之後證明碰不到要塞與要塞牆（中途被別的磚／鋼／邊界擋掉，
 * 或是這條線先撞到敵家老鷹），那一槍照樣可以打。
 *
 * 坦克 16×16 常常蓋在要塞格旁，所以連出發格一起查。
 * ⚠ 「拆自己家」只準有一個定義：老師標示（ai/teacher.js）、訓練計量
 *   （ai/arena.js）、監測（ai/telemetry.js）、規則 AI（js/ai.js）
 *   全部走同一條幾何判斷，否則會變成「訓練罰一套、網頁報一套」。
 * @returns {boolean} true = 這一槍會傷到自家要塞，不給開
 */
function ownBaseInFront(tank, game) {
  const map = game.map;
  const own = map.bases && map.bases[tank.team];
  if (!own) return false;                    // 單人模式的敵人沒有自家基地
  const v = UNIT[tank.dir];
  const c = tank.center();
  let x = c.x + v[0] * 10, y = c.y + v[1] * 10;
  const [gw, gh] = gridOf(map);
  // 上限取較長那一軸：橫向掃 18 格就到頭的話，直式長場的下半部等於沒檢查。
  for (let k = 0; k <= Math.max(gw, gh); k++) {
    const cx = Math.floor(x / CELL_PX), cy = Math.floor(y / CELL_PX);
    if (cx < 0 || cx >= gw || cy < 0 || cy >= gh) return false;   // 出界，子彈消失
    const b = map.baseAtCell(cx, cy);
    if (b) return b === own;                 // 先撞到敵家老鷹 → 這槍有意義
    if (stopsBullet(map.cellAt(cx, cy)))
      return fortressWallAt(map, own, cx, cy);   // 擋住了：是要塞牆就禁，一般牆安全
    x += v[0] * CELL_PX; y += v[1] * CELL_PX;
  }
  return false;
}

/**
 * 反射層：把「網路挑的方向」改成「走得到的方向」。
 * ═══════════════════════════════════════════════════════════
 * 為什麼要有這一層（不是偷吃步，是暖啟動的另一半）：
 * 網路對同一個觀測永遠給同一個答案，所以一旦它在「正前方是牆」的狀態下
 * 輸出「前進」，那一幀動不了、下一幀觀測幾乎沒變 → 又輸出「前進」。
 * 這個是吸態：實測把這層關掉（FRONT_BASE 索引算錯時等於沒擋）的模仿種子，
 * 86% 的在場幀卡在原地不動，而觀測裡明明就有 blocked 旗標
 * （離線忠實度 82.8%，代表它「知道」前面是牆）。
 * 規則 AI 不會掉進去，因為它每幀都重讀 _dirOpen 並當場換向 ——
 * 這層做的就是把那個「當場換向」留成硬邏輯，把寶貴的演化預算
 * 留給「該往哪打、何時開火」這類真正需要學習的決策。
 * 順序：先轉垂直方向（左→右），最後才回頭；全走不通就維持原結論。
 */
function escapeBlocked(obs, action, dir, banned = -1) {
  const b = FRONT_BASE();
  // banned：環境規則額外封住的方向（目前是「往前還走得通時不準直接回頭」）。
  // 反射層和 moveAsAI 用同一條規則，否則網路會每幀選一個已被否決的方向、
  // 車子原地站著不動 —— 不轉了，但也不積極。
  const blockedAt = d => d === banned || obs[b + d] > 0.5;
  const want = action === ACTIONS.FIRE ? dir : action;
  if (!blockedAt(want)) return action;
  for (const d of [(want + 1) % 4, (want + 3) % 4, (want + 2) % 4])
    if (!blockedAt(d)) return d;
  // 四面堵死（被車團團圍住）：方向鍵維持原向，不要每幀翻面；
  // 射擊仍可保留，擋不住子彈。真正「轉了必須走」的保證在 tank.moveAsAI。
  return action === ACTIONS.FIRE ? ACTIONS.FIRE : dir;
}

/**
 * 安全閘：網路想開火，但槍線上第一個撞到的居然是自己家的老鷹 → 不給開。
 * ═══════════════════════════════════════════════════════════
 * 這跟「該何時射擊」不同類：那是要學的東西（老師用 shotWanted 標了、
 * 適應度用 spray／零傷害比例在罰），而「把自家打死」是純損失，
 * 規則 AI 也早就用同一個 predicate 擋掉（js/ai.js 的 _ownBaseInFront）。
 * 讓網路花幾代去學「別拆自己家」，等於用演化預算買一個本來就不該下單的錯誤；
 * 況且老鷹被己方子彈打到也算輸 —— 代價不對稱。
 * 攔下來的這一幀退回「維持現向、前進、不開火」，正是老師在同局面下的決定。
 */
function fireIsSafe(tank, game) {
  return !ownBaseInFront(tank, game);
}

/** 把動作翻成遊戲原本的指令並執行（dir=null 表示維持現向） */
function applyCommand(tank, game, cmd) {
  // 不要先 `tank.dir = cmd.dir`：moveAsAI 需要知道「這是轉向」，
  // 若轉了卻一步都走不了，它會把朝向還原（禁止原地上下/左右翻面）。
  const dir = (cmd.dir === null || cmd.dir === undefined) ? tank.dir : cmd.dir;
  const moved = tank.moveAsAI(dir, game.map, game.allTanks());
  tank.moving = moved;
  if (moved) tank.slideDir = tank.dir;
  if (cmd.fire) {
    const b = tank.shoot(game.bullets);
    if (b) game.bullets.push(b);
  }
  return moved;
}

function runRule(tank, game) {
  game.AI.update(tank, game);
  tank.tick();
}

/**
 * 外部決策器。
 * @param policy (obs: Float64Array, tank) => 0..4 | null（null = 本幀交給規則 AI）
 * @param opts   { jitter: 0..1 }  機率性退回規則 AI，用來打散完全決定的對局
 */
class PolicyController {
  constructor(policy, opts = {}) {
    this.kind = 'policy';
    this.policy = policy;
    this.jitter = opts.jitter || 0;
    this.reflex = opts.reflex !== false;      // 預設啟用「走不通就換方向」反射，見 escapeBlocked
    this.obs = new Float64Array(Observation.OBS_DIM);
    this.lastAction = null;
    this.actions = [];        // 動作序列（統計「是不是全程同一類」）
    this.frames = 0;
    this.safetyClamps = 0;    // 被 fireIsSafe 攔下的開火次數（為何要攔見上方 fireIsSafe 的說明）
  }

  step(tank, game) {
    if (!tank.alive) return;
    if (tank.spawnTimer > 0 || game.frozenFor(tank)) { tank.tick(); return; }

    Observation.build(tank, game, this.obs);
    let action = this.policy(this.obs, tank);
    if (action && typeof action === 'object') action = action.action;

    if (action === null || action === undefined ||
        (this.jitter > 0 && game.rand() < this.jitter)) {
      // abstain 這一幀是規則 AI 在代步 → lastAction 必須清空，
      // 否則 telemetry 會把「上一幀的射擊」算到這一幀頭上，
      // 「卡牆時還在開火」會被虚報。
      this.lastAction = null;
      runRule(tank, game);                       // 還不會決定 → 用現況 AI 打底
      return;
    }

    // frames = 「網路真的自己決策」的幀數。原本在 abstain 判斷之前就 +1，
    // 等於把規則 AI 代步的幀也算成網路的功勞 → 控制權會報成 100%。
    this.frames++;
    const banned = tank.reverseBanned ? tank.reverseBanned(game.map, game.allTanks()) : -1;
    if (this.reflex) action = escapeBlocked(this.obs, action, tank.dir, banned);
    let fire = action === ACTIONS.FIRE;
    if (fire && this.reflex && !fireIsSafe(tank, game)) {
      // 拆自己家的那一槍攔掉：改吃「網路除了射擊以外最好的移動結論」，
      // 並讓它照樣躲開走不通的方向。計數留給監測，用來確認這層真的有在擋。
      this.safetyClamps = (this.safetyClamps || 0) + 1;
      action = escapeBlocked(this.obs, tank.dir, tank.dir, banned);
      fire = false;
    }
    this.lastAction = action;
    if (this.actions.length < 100000) this.actions.push(action);
    applyCommand(tank, game, { dir: fire ? null : action, fire });
    tank.tick();
  }

  /** 動作多樣性：最常被選的那類佔多少（1 = 全程同一類，當癱瘓看待） */
  dominance() {
    if (!this.actions.length) return 1;
    const hist = new Array(5).fill(0);
    for (const a of this.actions) hist[a]++;
    return Math.max(...hist) / this.actions.length;
  }

  reset() { this.lastAction = null; this.actions.length = 0; this.frames = 0; this.safetyClamps = 0; }
}

/** 隨機策略：驗證「介面通了但還沒學習」的基準線 */
function randomPolicy() {
  const c = {
    kind: 'random',
    actions: [],
    frames: 0,
    lastAction: null,      // 給 telemetry 讀：每幀「實際下出去的動作」都要留痕
    step(tank, game) {
      if (!tank.alive) return;
      if (tank.spawnTimer > 0 || game.frozenFor(tank)) { tank.tick(); return; }
      const dir = Math.floor(game.rand() * 4);
      const fire = game.rand() < 0.15;
      this.lastAction = fire ? ACTIONS.FIRE : dir;
      this.actions.push(this.lastAction);
      this.frames++;
      applyCommand(tank, game, { dir: fire ? null : dir, fire });
      tank.tick();
    },
    reset() { this.actions.length = 0; this.frames = 0; this.lastAction = null; },
  };
  return c;
}

/** 任何自帶 step() 的 controller：確保有 actions/frames 給 arena 統計 */
function instrument(c) {
  c.actions = c.actions || [];
  c.frames = c.frames || 0;
  return c;
}

/** 依 spec 建立 controller；spec 為 null 表示沿用現況規則 AI */
function makeController(spec) {
  if (!spec) return null;
  if (spec === 'rule') return null;
  if (spec === 'random') return instrument(randomPolicy());
  if (typeof spec === 'function') return new PolicyController(spec);
  if (spec.kind === 'policy') return new PolicyController(spec.policy, spec);
  return instrument(spec);
}

const AIController = { PolicyController, makeController, randomPolicy, applyCommand,
  runRule, escapeBlocked, fireIsSafe, ownBaseInFront, ACTIONS };

if (typeof module !== 'undefined' && module.exports) module.exports = AIController;
else root.AIController = AIController;
})(typeof window !== 'undefined' ? window : globalThis);
