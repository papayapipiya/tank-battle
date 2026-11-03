/* ai/teacher.js — 把「會玩的規則 AI」變成可學習的示範資料
   ═══════════════════════════════════════════════════════════
   為什麼要這一層：
   純隨機起步的 NEAT 得先花幾十代學會「別撞牆、要動」，才有力氣學打仗。
   那段空白期剛好是局部最優的溫床 —— 實測第 50 代冠軍 92% 的決策是
   「射擊」、55% 的在場幀頂在牆上，勝率卻還有 75%。
   js/ai.js 那套規則 AI 本來就會避牆、會轉彎、會等射擊線，
   把它每幀的（觀測 → 決定）記錄下來，就是免費的老師。

   產出的每一筆樣本：
     obs    Float64Array(OBS_DIM)  與 policy 看到的完全同一份觀測
     dir    0..3                   老師這一幀要的朝向（卡住時規則 AI 立刻換向）
     fire   0/1                    這一幀有沒有開槍
     label  0..4                   壓成現有 5 動作空間的類別（開槍優先）
     event  'stuck' | 'freeTurn' | 'fire' | 'keep'
                                  —— 老師這一幀在幹嘛，取樣權重就看這個欄位

   ⚠ label 只用 5 類會丟掉「邊開槍邊移動」：現在的動作空間裡
     FIRE 與轉向互斥（這正是卡牆掃射的根源）。所以 dir / fire 分開留著，
     將來把動作空間換成 8 類時，這份資料不用重收。

   ⚠ 取樣不能「每幀都收」（第一版的教訓）
     實測把老師的資料原樣餵給網路，離線準確率 94%，上場卻 86% 的幀頂在牆上。
     原因是資料裡 7 成以上是「維持原向繼續走」的平凡幀，網路只要學會
     「別轉」就能拿到很高準確率 —— 而「別轉」在遊戲裡就是直線撞牆。
     現在按事件分層取樣：
       stuck    —— 這一幀位置完全沒改變（老師的 tryMove 失敗，它當場換向）：
                   這就是要學的核心，全留
       fire     —— 開火的幀本來就稀少（老師只有 0.2% 的幀開槍），全留
       freeTurn —— 還在走卻換向：混了「追目標的轉向」（可學）跟
                   aiDirTimer 到期的隨機重選（不可學），只留一部分
       keep     —— 繼續直走：個數最多但資訊量最低，留 keepShare

     ⚠ 「正前方堵不堵」（觀測 v2 最後一欄）不能拿來當事件分類的依據：
       它以整個 CELL（8px）為探測距離，比坦克一幀走的 1~2px 遠得多，
       所以「還有 6px 才撞到牆、目前照樣能走」的幀也被算成 blocked。
       第一版這樣分，結果 83062 幀裡有 32409 幀被標成「卡牆」，
       而它們的 label 絕大多數是「繼續直走」—— 分層完全失效。
       判定事件一律看「這一幀到底動了沒有」（位置差分），
       8px 預警只留在觀測裡當特徵，不當取樣條件。
     射擊另外補標（event='aim'）：老師的開火是擲骰子來的（8 萬幀只有 132 幀），
     照著複製會擬合出「從不開火」的種子 —— 0 發子彈、0 傷害，比卡牆更糟。
     所以移動跟老師學，開火用「同軸 + 前方 + 中間沒擋子彈的東西 + 冷卻好」
     這條基本邏輯自己標。
     取樣用 controller 自己的整數雜湊，不碰 game.rand()：
     多抽一個隨機數會把整局的出生與道具序列挪走，資料就不是那個老師了。
   ═══════════════════════════════════════════════════════════ */
'use strict';

const hasRequire = typeof require === 'function';
const Observation = hasRequire ? require('./observation') : window.AIObservation;
const { ACTIONS, ACTION_NAMES } = hasRequire ? require('./actions') : window.AIActions;
const { ownBaseInFront } = hasRequire ? require('./controller') : window.AIController;

/** 事件類型的取樣預設權重（0..1） */
const DEFAULT_SHARES = Object.freeze({ stuck: 1, fire: 1, aim: 1, freeTurn: 0.45, keep: 0.2 });

const EVENT_NAMES = {
  stuck: '卡牆轉向', freeTurn: '自由轉向', fire: '老師開火', aim: '有射擊線', keep: '繼續走',
};

// 與 js/constants.js 同步的幾個值（本檔跑在 vm 外，拿不到 bundle 裡的 const）
// 地圖的寬高不在這裡抄：9:21 之後是兩個不一樣的數，一律從 map.cells 現讀
// （見 rayClear）。抄一份只會變成「老師以為的邊界」跟地圖的邊界不同。
const CELL = 8;
const GRID_W_FB = 18, GRID_H_FB = 42;
const CT = { EMPTY: 0, BRICK: 1, STEEL: 2, WATER: 3, FOREST: 4, ICE: 5, BASE: 6 };
const UNIT = [[0, -1], [1, 0], [0, 1], [-1, 0]];       // DIR.UP / RIGHT / DOWN / LEFT

/** 這張 map 的 cell 尺寸（寬, 高） */
function gridOf(map) {
  const rows = map && map.cells;
  if (Array.isArray(rows) && Array.isArray(rows[0])) return [rows[0].length, rows.length];
  return [GRID_W_FB, GRID_H_FB];
}

/** 0..1 的確定性雜湊：同一台車、同一個序號，永遠得到同一個結果 */
function hashUnit(seed, n) {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ n, 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * 沿射擊線（軸對齊）從起點 cell 走到終點 cell，終點本身不計。
 * @returns {{clear:boolean, brick:number}} clear=false 表示這發子彈到不了目標
 *   （中途有鋼牆／水域／界外／某隻老鷹）。brick = 中途要啃掉的磚格數，
 *   子彈會停在第一塊磚上 —— 所以 brick>0 就代表「打不到人」，
 *   但啃磚仍是有效的地形傷害，所以另外當一個較低的優先級用。
 */
function rayClear(map, cx0, cy0, cx1, cy1) {
  const [gw, gh] = gridOf(map);
  const dx = Math.sign(cx1 - cx0), dy = Math.sign(cy1 - cy0);
  let cx = cx0, cy = cy0, brick = 0;
  for (let guard = 0; guard < gw + gh; guard++) {
    cx += dx; cy += dy;
    if (cx === cx1 && cy === cy1) return { clear: brick === 0, brick };
    if (cx < 0 || cx >= gw || cy < 0 || cy >= gh) return { clear: false, brick };
    const v = map.cells[cy]?.[cx];
    if (v === CT.STEEL || v === CT.WATER || v === CT.BASE) return { clear: false, brick };
    if (v === CT.BRICK) brick++;
    if ((dx > 0 && cx > cx1) || (dx < 0 && cx < cx1) ||
        (dy > 0 && cy > cy1) || (dy < 0 && cy < cy1)) return { clear: brick === 0, brick };
  }
  return { clear: brick === 0, brick };
}

/**
 * 「這一幀該不該開火」—— 自己算，不等老師。
 * ⚠ 為什麼不直接複製老師的射擊決定：js/ai.js 是 aiShootTimer 到期才掷骰子
 *   （對準了也只有 55% 開火），實測 83062 個決定幀裡只有 132 幀真的開槍。
 *   資料裡幾乎沒有射擊，擬合出來的種子乾脆整個放棄開火 —— 上場 0 發子彈、
 *   0 點傷害，這比卡牆更致命。
 *   所以射擊這一欄改用「基本邏輯」自己標：同軸、面前、中間沒有擋子彈的東西、
 *   冷卻好 → 就該開火。移動仍然跟老師學。
 * @returns {null|'foe'|'base'}
 */
function shotWanted(tank, game) {
  const map = game.map;
  if (ownBaseInFront(tank, game)) return null;
  const c = tank.center();
  const v = UNIT[tank.dir];
  const scx = Math.floor(c.x / CELL), scy = Math.floor(c.y / CELL);
  const along = p => (p.x - c.x) * v[0] + (p.y - c.y) * v[1];
  const cands = [];
  for (const f of game.foesOf(tank)) {
    if (!f.alive || f.spawnTimer > 0) continue;
    cands.push({ kind: 'foe', fc: f.center() });
  }
  const fb = game.foeBaseOf(tank);
  if (fb && !map.bases[1 - tank.team]?.dead) cands.push({ kind: 'base', fc: fb });

  // 只留「射擊線上、且在前方」的候選，由近而遠：近的這根線被鋼牆擋住時，
  // 同一條線上更遠的自然也打不到，逐個試第一個打通的就是該打的目標。
  const onLine = cands.filter(t => along(t.fc) > 0 &&
    Math.abs((t.fc.x - c.x) * v[1] - (t.fc.y - c.y) * v[0]) < CELL)
    .sort((a, b) => along(a.fc) - along(b.fc));

  for (const t of onLine) {
    const r = rayClear(map, scx, scy, Math.floor(t.fc.x / CELL), Math.floor(t.fc.y / CELL));
    if (r.clear) return t.kind;
  }
  // ⚠ 不要退化成「前方有磚就開一槍」：本圖磚格密到幾乎每一幀都成立，
  //   實測那樣標出來 58% 的樣本是 FIRE，把資料集變成掃射機器（準確率掉到 55%），
  //   而且正是監測要抓的那個亂開火行為。
  //   拆牆留給 NEAT 自己發現（適應度裡有 brick_destroyed 的分），
  //   老師的資料只教「打得到人才開槍」。
  return null;
}

/**
 * 一個「只記錄、不干預」的 controller：照樣跑規則 AI，
 * 但把每幀的觀測與決定存進 sink。
 * @param {(rec:object)=>void} sink
 * @param {object} o { shares:{blocked,fire,freeTurn,keep}, seedBase }
 */
function makeTeacherController(sink, o = {}) {
  const obs = new Float64Array(Observation.OBS_DIM);
  const shares = Object.assign({}, DEFAULT_SHARES, o.shares || {});
  const seedBase = o.seedBase | 0;
  let n = 0;
  const c = {
    kind: 'teacher',
    actions: [],            // 給 arena 的統計用（動作分佈、dominance）
    frames: 0,
    lastAction: null,
    events: null,           // 事件計數（供 collect 彙整取樣前後的比例）
    step(tank, game) {
      if (!tank.alive) return;
      if (tank.spawnTimer > 0 || game.frozenFor(tank)) { tank.tick(); return; }
      Observation.build(tank, game, obs);
      const dirBefore = tank.dir;
      const px = tank.x, py = tank.y;
      const blockedAhead = obs[Observation.OBS_DIM - 1] > 0.5;   // v2 觀測的最後一欄
      const before = game.bullets.length;
      game.AI.update(tank, game);                 // 老師自己做決定
      const fire = game.bullets.length > before ? 1 : 0;
      tank.tick();
      const moved = (tank.x !== px || tank.y !== py) ? 1 : 0;
      const dir = tank.dir >= 0 && tank.dir < 4 ? tank.dir : 0;
      const turned = dir !== dirBefore;
      const label = fire ? ACTIONS.FIRE : dir;
      c.lastAction = label;
      c.actions.push(label);
      c.frames++;

      // 事件分層。順序有講究：「被擋住又開槍」算 stuck —— 那一幀的價值在轉彎，
      // 開火隨處可得，轉向的時機才是稀貨。
      const event = !moved ? 'stuck' : fire ? 'fire' : turned ? 'freeTurn' : 'keep';
      c.events[event]++;
      if (sink && hashUnit(seedBase, n) < shares[event]) {
        sink({ obs: Float64Array.from(obs), dir, fire, label, event,
          team: tank.team, turned: turned ? 1 : 0, moved, blockedAhead: blockedAhead ? 1 : 0 });
      }
      n++;

      // 另外補一筆「有射擊線 → FIRE」的樣本（見 shotWanted 頭部）。
      // 只在老師這幀不需要轉彎（走得動、沒轉向）時補：FIRE 意味著「維持現向」，
      // 拿它去覆蓋一幀「必須轉彎」的決定，等於自己把卡牆教回去。
      // 同一個觀測因此有兩個標籤（走 / 開火）——這是刻意留的模糊：
      // 下一幀冷卻還沒好時只剩「走」那筆，網路就自然學會打完一發收手。
      if (sink && !turned && moved && tank.cooldown <= 0 && shotWanted(tank, game)) {
        c.events.aim++;
        sink({ obs: Float64Array.from(obs), dir, fire: 1, label: ACTIONS.FIRE, event: 'aim',
          team: tank.team, turned: 0, moved, blockedAhead: blockedAhead ? 1 : 0 });
      }
    },
    reset() {
      c.actions.length = 0; c.frames = 0; c.lastAction = null; n = 0;
      c.events = { stuck: 0, freeTurn: 0, fire: 0, aim: 0, keep: 0 };
    },
  };
  c.reset();
  return c;
}

/**
 * 收示範資料：規則 AI 對規則 AI 打幾局。
 * @param {object} o { stages:[..], gamesPerStage, maxFrames, shares, seedBase, role }
 *   role='attack'／'defense'（批次二 G3）：只留那一席的老師樣本。
 *   ═══════════════════════════════════════════════════════
 *   為什麼要分開收：`js/ai.js` 的 `_goal` 從 v10 批次二開始認角色（藍壓老鷹、
 *   紅守門前），所以「藍隊的老師」跟「紅隊的老師」教的已經是兩件不同的事。
 *   把兩隊混成一份資料去擬合，得到的是那個中性駕駛的平均 ——
 *   暖啟動會把剛拆開的分工又糊回去（探針實測：混收的種子本業占比只有 0.5%）。
 *   對局本身還是照打（兩隊互相才是對手），只是取樣時只收要的那一席。
 *   ═══════════════════════════════════════════════════════
 */
function collect(o = {}) {
  const { Arena } = require('./arena');
  const { hashSeed } = require('./rng');
  const { roleOfTeam, ROLES } = require('./fitness');
  const stages = o.stages || [0, 1, 2];
  const per = o.gamesPerStage === undefined ? 2 : o.gamesPerStage;
  const maxFrames = o.maxFrames || 4000;
  const shares = Object.assign({}, DEFAULT_SHARES, o.shares || {});
  const role = o.role || null;
  if (role && role !== ROLES.ATTACK && role !== ROLES.DEFENSE)
    throw new Error(`teacher: --role 只接受 ${ROLES.ATTACK}／${ROLES.DEFENSE}，收到 ${role}`);
  const samples = [];
  const arena = new Arena({ maxFrames });
  // 只有「一幀一個類別」的四種計入總幀數；aim 是另外補的標籤，不屬於某一幀
  const seen = { stuck: 0, freeTurn: 0, fire: 0, keep: 0 };
  let games = 0;
  for (const stage of stages) {
    for (let i = 0; i < per; i++) {
      // sink 只累加「留下的」，seen 用 controller 自己記的全量事件計數補起來
      const sink = rec => { if (!role || roleOfTeam(rec.team) === role) samples.push(rec); };
      const t0 = makeTeacherController(sink, { shares, seedBase: (stage * 977 + i * 31) | 0 });
      const t1 = makeTeacherController(sink, { shares, seedBase: (stage * 977 + i * 31 + 7) | 0 });
      arena.run({ stage, seed: hashSeed(o.seedBase || 0x7ea5, stage, i), blue: t0, red: t1, maxFrames });
      // 指定 role 時「全量事件」也只算那一席，否則 rawFrames 會把另一隊算進來，
      // 留率（kept/raw）看起來莫名偏低，而那個比例正是判斷取樣有沒有失效的依據。
      const own = role === ROLES.DEFENSE ? t1.events : role === ROLES.ATTACK ? t0.events
        : null;
      for (const k of Object.keys(seen))
        seen[k] += own ? own[k] : t0.events[k] + t1.events[k];
      games++;
    }
  }
  const hist = new Array(5).fill(0);
  for (const s of samples) hist[s.label]++;
  const evKept = { stuck: 0, freeTurn: 0, fire: 0, aim: 0, keep: 0 };
  for (const s of samples) evKept[s.event]++;
  return {
    samples,
    meta: {
      games, rawFrames: Object.values(seen).reduce((a, b) => a + b, 0), kept: samples.length,
      stages, maxFrames, shares, role,
      obsDim: Observation.OBS_DIM,
      eventsSeen: seen, eventsKept: evKept,
      labelHist: hist,
      labelShare: hist.map(v => v / Math.max(1, samples.length)),
      labelNames: ACTION_NAMES,
      eventNames: EVENT_NAMES,
    },
  };
}

module.exports = { makeTeacherController, collect, DEFAULT_SHARES, EVENT_NAMES };
