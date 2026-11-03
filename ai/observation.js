/* ai/observation.js — 遊戲狀態 → 定長度數值向量
   ═══════════════════════════════════════════════════════════
   ⚠ 鐵律：觀測量一但定稿就不能改。維度變了，先前訓練出的基因組全部作廢。
     所以這裡把規格寫成 OBS_SPEC（含 version），checkpoints 會記錄它，
     載入時規格不符會直接失敗，而不是靜默重訓。

   設計原則（先求能跑通的最小集合，不要一上場就 200 維豪華觀測）：
     · 局部 7×7 網格 —— 沒有它就學不會避牆跟躲子彈，這是核心
     · 最近敵車 + 射擊線品質 —— 對齊才開火，比塞整個 enemy list 便宜
     · 全域只留「雙方還剩多少」—— 讓 AI 知道該衝還是該守

   v1 → v2（新增 front 段，附加在最尾端）：
     模仿學習（ai/teacher.js + ai/imitate.js）上場後還是 86% 的幀頂在牆上。
     原因不在模型不準（離線重現老師 94%），而在「該不該轉彎」這件事，
     v1 只能要網路自己從 7×7 網格 ＋ 朝向 one-hot 裡算出「正前方堵不堵」——
     那是方向與格位的乘性條件，16 個隱藏神經元學不動，
     於是最優解退化成「別轉」（老師 70% 的幀本來就是繼續直走）。
     現在直接把規則 AI 判卡住的那個條件（EnemyAI._dirOpen）餵進去，
     「頂到牆 → 轉到開的方向」就變成一個查表級的特徵。
     新欄位一律加在尾端：前 80 欄的語意保持不變，舊基因組即使版本擋掉，
     要除錯也比重新對欄位容易。
   ═══════════════════════════════════════════════════════════ */
(function (root) {      // IIFE：瀏覽器多檔共用全域作用域，理由見 ai/actions.js 頭部
'use strict';

const GRID_R = 3;                        // 視野半徑（cell）
const GRID_SIDE = GRID_R * 2 + 1;        // 7
const CELL_PX = 8;                       // 與 js/constants.js 的 CELL 一致（此檔在 vm 外，拿不到那些 const）
const TANK_PX = 16;                      // 同上：坦克 box 邊長
// DIR 順序 UP/RIGHT/DOWN/LEFT（同 js/constants.js 的 DIR_VEC）
const DIR_UNIT = [[0, -1], [1, 0], [0, 1], [-1, 0]];

// 網格編碼（0 留給「什麼都沒有」）
const TERRAIN_CODE = Object.freeze({
  EMPTY: 0, BRICK: 1, STEEL: 2, WATER: 3, FOREST: 4, ICE: 5, BASE: 6,
  ALLY: 7, FOE: 8, BULLET: 9,
});

const TERRAIN_CODES = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 };

// 各段長度
const LEN = Object.freeze({
  self: 8,
  grid: GRID_SIDE * GRID_SIDE,
  foe: 7,
  aim: 4,
  base: 6,
  global: 6,
  front: 5,                              // 四向可走 + 正前方是否堵住（v2）
});

const OBS_DIM = Object.values(LEN).reduce((a, b) => a + b, 0);

const OBS_SPEC = Object.freeze({
  version: 2,
  gridRadius: GRID_R,
  dim: OBS_DIM,
  segments: LEN,
});

/** box 是否碰到 (cx,cy) 這個 8×8 cell */
function touchesCell(b, cx, cy) {
  return b.x < (cx + 1) * 8 && b.x + b.w > cx * 8 &&
         b.y < (cy + 1) * 8 && b.y + b.h > cy * 8;
}

/**
 * 以 (x,y) 為左上角放一台坦克，會不會撞上「別台活車」。
 * 與 Tank._hitsAnyTank 同一條規則（含出生無敵期的車，牠們照樣擋路）。
 */
function hitsOtherTank(x, y, tank, tanks) {
  for (const t of tanks) {
    if (t === tank || !t.alive) continue;
    const b = t.box;
    if (x < b.x + b.w && x + TANK_PX > b.x && y < b.y + b.h && y + TANK_PX > b.y) return true;
  }
  return false;
}

/** 把格內所有重疊物件收齊：子彈 > 坦克 > 地形 */
function codeAtCell(map, cx, cy, tank, present, bullets) {
  for (const b of bullets) {
    if (b.alive && touchesCell(b.box, cx, cy)) {
      return b.owner.team === tank.team ? TERRAIN_CODE.ALLY : TERRAIN_CODE.FOE;
    }
  }
  for (const t of present) {
    if (t !== tank && t.alive && t.spawnTimer <= 0 && touchesCell(t.box, cx, cy)) {
      return t.team === tank.team ? TERRAIN_CODE.ALLY : TERRAIN_CODE.FOE;
    }
  }
  return TERRAIN_CODES[map.cells[cy]?.[cx]] ?? 0;
}

/** 沿 facing 方向找第一個目標；回傳 [存在?, 歸一化距離] */
function lineScan(c, dir, targets, range) {
  const axis = (dir === 1 || dir === 3) ? 'x' : 'y';
  const cross = axis === 'x' ? 'y' : 'x';
  const sign = (dir === 1 || dir === 2) ? 1 : -1;
  let best = Infinity;
  for (const t of targets) {
    if (Math.abs(t[cross] - c[cross]) > 5) continue;
    const along = (t[axis] - c[axis]) * sign;
    if (along > 0 && along < best) best = along;
  }
  if (!Number.isFinite(best) || best > range) return [0, 0];
  return [1, Math.min(1, best / range)];
}

/**
 * 產生一台坦克的觀測向量（Float64Array，長度恆為 OBS_DIM）。
 * @param tank  觀測主體
 * @param game  提供 map / foesOf / ownBaseOf / foeBaseOf / teams 的對象
 * @param out   可重複使用的輸出緩衝
 */
function build(tank, game, out = new Float64Array(OBS_DIM)) {
  const c = tank.center();
  const foes = game.foesOf(tank);
  const ownBase = game.ownBaseOf(tank);
  const foeBase = game.foeBaseOf(tank);
  const bullets = game.bullets;
  const map = game.map;
  // 網格裡要看到同隊車（會擋路），所以不能只塞 foes
  const present = game.allTanks();

  let i = 0;
  const put = v => { out[i++] = v; };

  // ── self：位置、朝向、冷卻、在場子彈 ──
  // ⚠ 尺度（104／208／192／160）是 26×26 時代標定的，9:21 之後「故意不改」：
  //   改了就是換感測器 ⇒ OBS_SPEC 要升版 ⇒ 所有舊 checkpoint 在載入時被硬擋
  //   （ai/checkpoint.js、evolve.js、ledger.js、monitor.js、js/watch.js 五處都查），
  //   等於把進攻／防守那兩條 ~845 代、16 萬場的血緣歸零。
  //   換幾何本身已經由 SCORING_VERSION 9 觸發「冠軍重評」，尺還是同一把。
  //   代價：y 現在最大約 (328-104)/104 ≈ 2.15，超出舊訓練分佈（[0,1] 附近），
  //   所以前幾代會看到「對下半場反應鈍」——那是要被訓練過去的分佈偏移，
  //   不是 bug。想真正重標定感測器，就另做一輪 obs v3 並從頭練。
  put((c.x - 104) / 104);
  put((c.y - 104) / 104);
  put(tank.dir === 0 ? 1 : 0);
  put(tank.dir === 1 ? 1 : 0);
  put(tank.dir === 2 ? 1 : 0);
  put(tank.dir === 3 ? 1 : 0);
  put(Math.min(1, tank.cooldown / 8));
  put(Math.min(1, tank.firepower / 4));

  // ── local grid：以自身 cell 為中心的 7×7 ──
  // 邊界從 map 現讀（9:21 ⇒ 寬 18、高 42）。寫死 26 的話，
  // 「界外視同硬牆」會在地圖下半部錯誤地當成場內，網路看到的路就不存在。
  const GW = map.cells[0] ? map.cells[0].length : 18;
  const GH = map.cells.length;
  const scx = Math.floor(c.x / 8), scy = Math.floor(c.y / 8);
  for (let dy = -GRID_R; dy <= GRID_R; dy++) {
    for (let dx = -GRID_R; dx <= GRID_R; dx++) {
      const cx = scx + dx, cy = scy + dy;
      put(cx < 0 || cx >= GW || cy < 0 || cy >= GH
        ? TERRAIN_CODE.STEEL                       // 界外視同硬牆
        : codeAtCell(map, cx, cy, tank, present, bullets));
    }
  }

  // ── nearest foe：自身座標系的相對位置 + 狀態 ──
  const fwd = [{ dx: 0, dy: -1 }, { dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }][tank.dir];
  const rgt = { dx: -fwd.dy, dy: fwd.dx };
  let near = null, nd = Infinity;
  for (const f of foes) {
    if (!f.alive || f.spawnTimer > 0) continue;
    const fc = f.center();
    const d = Math.hypot(fc.x - c.x, fc.y - c.y);
    if (d < nd) { nd = d; near = fc; }
  }
  if (near) {
    put(((near.x - c.x) * fwd.dx + (near.y - c.y) * fwd.dy) / 208);
    put(((near.x - c.x) * rgt.dx + (near.y - c.y) * rgt.dy) / 208);
    put(Math.min(1, nd / 208));
    put(nd === 0 ? 0 : ((near.x - c.x) >= 0 ? 1 : -1));
    put(nd === 0 ? 0 : ((near.y - c.y) >= 0 ? 1 : -1));
    put(Math.min(1, (nd - 8) / 192));               // 0 = 貼臉
    put(foes.length / 8);
  } else {
    for (let k = 0; k < 7; k++) put(0);
  }

  // ── aim：正前方有沒有可打的東西 ──
  const foeCenters = foes.filter(f => f.alive && f.spawnTimer <= 0).map(f => f.center());
  const [foeHit, foeDist] = lineScan(c, tank.dir, foeCenters, 160);
  put(foeHit); put(foeDist);
  const baseTargets = foeBase ? [foeBase] : [];
  const [baseHit, baseDist] = lineScan(c, tank.dir, baseTargets, 160);
  put(baseHit); put(baseDist);

  // ── bases：自家／敵家老鷹的相對位置 ──
  for (const b of [ownBase, foeBase]) {
    if (b) {
      put((b.x - c.x) / 208);
      put((b.y - c.y) / 208);
      put(1);
    } else {
      put(0); put(0); put(0);                       // 單人模式的 AI 沒有自家基地；敵基地被毀同理
    }
  }

  // ── global：雙方戰力對比 ──
  if (game.demoMode && game.teams) {
    const mine = game.teams[tank.team], foe = game.teams[1 - tank.team];
    put((mine.pool + mine.tanks.length) / 20);
    put(mine.tanks.length / 4);
    put(mine.score / 5000);
    put((foe.pool + foe.tanks.length) / 20);
    put(foe.tanks.length / 4);
    put(foe.score / 5000);
  } else {
    put(Math.max(0, (game.iconsLeft || 0) / 20));
    put((game.enemies ? game.enemies.length : 0) / 4);
    put(0);
    put(Math.max(0, (game.lives || 0) / 5));
    put(game.player && game.player.alive ? 1 : 0);
    put(0);
  }

  // ── front：四向「下一步走不走得通」（v2，模仿學習的關鍵訊號）──
  //   判定方式刻意與 EnemyAI._dirOpen 完全相同：以整格 CELL 為探測距離、
  //   地形用 map.tankBlocked、再補上「被別台車擋死」。老師每次轉彎都是
  //   讀這個條件，把它原封不動放進觀測，網路才可能學會「頂到牆 → 轉向」。
  const blocked = [0, 0, 0, 0];
  for (let d = 0; d < 4; d++) {
    const nx = tank.x + DIR_UNIT[d][0] * CELL_PX;
    const ny = tank.y + DIR_UNIT[d][1] * CELL_PX;
    blocked[d] = (map.tankBlocked(nx, ny) || hitsOtherTank(nx, ny, tank, present)) ? 1 : 0;
  }
  for (let d = 0; d < 4; d++) put(blocked[d]);
  // 第 5 欄是「正前方堵不堵」：它是上面四欄的其中一欄被朝向選出來，
  // 但「朝向 one-hot × 四向旗標」是乘性條件，網路要繞一圈才得到；
  // 直接餵進去，「該不該轉彎」就退化成一個加權和能表達的閾值。
  const curDir = tank.dir >= 0 && tank.dir < 4 ? tank.dir : 0;
  put(blocked[curDir]);

  if (i !== OBS_DIM) throw new Error(`observation: 維度漂移 ${i} != ${OBS_DIM}`);
  return out;
}

const AIObservation = {
  build, OBS_SPEC, OBS_DIM, LEN, GRID_R, GRID_SIDE, TERRAIN_CODE,
};

if (typeof module !== 'undefined' && module.exports) module.exports = AIObservation;
else root.AIObservation = AIObservation;
})(typeof window !== 'undefined' ? window : globalThis);
