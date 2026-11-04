/* ═══════════════════════════════════════════
   mapgen.js — 程序化地形產生器（取代 35 張手刻關卡）

   使用者要的三件事：地圖 9:21、放大、**隨機**。
   「隨機」在這裡不是「每次開頁亂到不知道哪裡」，而是
   **mapId → 固定種子 → 固定地形**：

     · 同一個 mapId 在任何機器、任何時間都長出同一張圖
       —— 訓練端的 (stage, seed) 可重現性、HUD 的「地圖 N」、
          ◀▶ 瀏覽、R 鍵重開本輪，全部依賴這一條。
     · 想要不一樣的戰場就換 mapId；一共有 MAP_VARIANTS 張。

   ⚠ 本檔**絕不能出現 `Math.random()`** 這個字面字串：
      ai/engine.js 載入 bundle 時會把它整串替換成 sandbox 的 __rand()，
      那樣地形就變成「跟著對局種子跑」，同一個 mapId 每次長得不一樣，
      訓練分數與重現性會一起失效，而且不會報錯。
      所以這裡自帶一個純函數的 32-bit hash／mulberry32。

   產生流程（全部在 tile 空間做，1 tile = 2×2 cells = 16×16 px）：
     1. 只生成上半部（tile row 0..10），下半部用「點對稱」鏡像過去
        ⇒ 兩隊面對的地形幾何完全等价，不會有一邊的家門口天生好守。
     2. 依權重隨機蓋「圖樣」（磚牆段／L 形／鋼塊／水塘／樹林／冰原）。
     3. map.js 接著蓋老鷹＋要塞磚環、淨空出生點。
     4. 最後回到這裡做 **tile 級 Dijkstra 開路**：
        從每一個出生 tile 出發，必須走得到「敵方要塞外側那一排」，
        走不通就沿最便宜的路徑把地磚挖空（優先挖磚，其次鋼／水）。
        注意節點是 tile 而不是 cell：坦克是 2×2 cells，挖 1 cell 寬的
        隧道車根本開不過去，那種「連通了」是假的。

   地形代碼沿用 CELL_TYPE（constants.js），本檔在 bundle 內，直接引用。
   ═══════════════════════════════════════════ */

const MapGen = (() => {

  // ── 純函數亂數：同一個 seed 永遠得到同一串 ──
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** mapId → 種子：先打散再給 PRNG，避免「相鄰的地圖長得差不多」 */
  function seedOf(mapId) {
    let h = ((mapId >>> 0) ^ 0x5e504799) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
    return (h ^ (h >>> 15)) >>> 0;
  }

  /** 從 rand 裡按權重抽一個（weights 不需要加總成 1） */
  function pick(weights, rand) {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = rand() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r < 0) return i;
    }
    return weights.length - 1;
  }

  // ── 圖樣（motif）：以 tile 為單位的形狀，offsets = [[dc, dr, type], ...] ──
  const B = CELL_TYPE.BRICK, S = CELL_TYPE.STEEL, W = CELL_TYPE.WATER,
        F = CELL_TYPE.FOREST, I = CELL_TYPE.ICE;

  const MOTIFS = [
    // 橫向／縱向磚牆（2～4 tile）：最經典的迷宮骨幹
    { w: 3, off: [[0, 0, B], [1, 0, B], [2, 0, B]], weight: 16 },
    { w: 2, off: [[0, 0, B], [1, 0, B]], weight: 14 },
    { w: 3, off: [[0, 0, B], [0, 1, B], [0, 2, B]], weight: 14 },
    { w: 2, off: [[0, 0, B], [0, 1, B]], weight: 12 },
    // L 形：製造「繞路」而不是一整面牆
    { w: 2, off: [[0, 0, B], [1, 0, B], [1, 1, B]], weight: 12 },
    // 十字／田字碉堡（中心鋼塊 = 要 L4 火力才拆得掉）
    { w: 2, off: [[0, 0, B], [1, 0, B], [0, 1, B], [1, 1, B], [0, 0, S]], weight: 6 },
    // 水塘：擋車不擋彈，子彈能飛過去 → 天然射擊線
    { w: 2, off: [[0, 0, W], [1, 0, W]], weight: 8 },
    { w: 2, off: [[0, 0, W], [0, 1, W]], weight: 7 },
    { w: 1, off: [[0, 0, W]], weight: 5 },
    // 樹林：會擋視線（蓋在車上面），用來藏車
    { w: 2, off: [[0, 0, F], [1, 0, F], [0, 1, F], [1, 1, F]], weight: 9 },
    { w: 2, off: [[0, 0, F], [1, 0, F]], weight: 7 },
    // 冰原：打滑 = AI 最難處理的地形，少量點綴
    { w: 2, off: [[0, 0, I], [1, 0, I]], weight: 5 },
    { w: 1, off: [[0, 0, I]], weight: 4 },
    // 雙鋼柱：只有 L4 拆得開的「硬節點」，讓火力升級真的有價值
    { w: 2, off: [[0, 0, S], [0, 2, S]], weight: 3 },
  ];

  /**
   * tile 網格（TILE_H 列 × TILE_W 行），值 = CELL_TYPE。
   * @param {number} mapId
   * @param {boolean} symmetric true＝觀戰/訓練：上半部生成後點對稱鏡像；
   *                            false＝單人：整張自由生成（沒有對稱義務）。
   */
  function tiles(mapId, symmetric) {
    const grid = Array.from({ length: TILE_H }, () => new Array(TILE_W).fill(CELL_TYPE.EMPTY));
    const rand = mulberry32(seedOf(mapId));
    const maxRow = symmetric ? Math.floor(TILE_H / 2) : TILE_H - 1;   // 0..10 / 0..20
    // 老鷹所在的 tile 一律留空：map.js 會蓋牆，但生成器不該在這裡塞東西。
    // 對稱模式要同時擋 (4,0) 和 (4,20) —— 但產生器只寫上半部，
    // 所以真正會踩到的是 (4,0)，它的鏡像正好是紅／藍兩座老鷹。
    const eagleCol = (TILE_W - 1) / 2;
    const isEagleTile = (c, r) => c === eagleCol && (r === TILE_H - 1 || (symmetric && r === 0));

    /* 疏密度：以「可自由擺放的 tile 數」為準，而不是固定個數。
       9:21 之後上半部只有 99 格（11×9），原本照 13×13 猜的 26～39 個圖樣
       會蓋掉六成地面 —— 場上變成一整片磚牆、只有開路挖出來的四條走道，
       觀戰看起來像停車場而不是戰場。這裡以「圖樣數 ÷ 可擺放格數」當密度旋
       鈕：0.10～0.16 × 99 ≈ 10～16 個圖樣，每個平均蓋 3.15 格（含重疊），
       實際地磚約 28～35%，跟手刻關卡同一個數量級。
       單人模式（整張自由生成）面績剛好 doubled，所以同一個公式自動加倍。 */
    const area = (maxRow + 1) * TILE_W;
    const stamps = Math.round(area * (0.10 + rand() * 0.06));
    for (let i = 0; i < stamps; i++) {
      const m = MOTIFS[pick(MOTIFS.map(x => x.weight), rand)];
      const spanR = Math.max(...m.off.map(o => o[1]));
      const dc = Math.floor(rand() * (TILE_W - m.w + 1));
      // 對稱模式只允許落在上半部（含中央那一排）；單人可以落在整張
      const dr = Math.floor(rand() * (maxRow - spanR + 1));
      for (const [ox, oy, type] of m.off) {
        const c = dc + ox, r = dr + oy;
        if (c < 0 || c >= TILE_W || r < 0 || r >= TILE_H) continue;
        if (isEagleTile(c, r)) continue;
        grid[r][c] = type;
      }
    }

    // ── 中央那一排（seam）：對稱模式下它自己鏡射回自己 ──
    // tile(10, c) ↔ tile(10, 8-c)，所以這排必須左右對稱。
    // 實作：把左半鏡像到右半，再把正中央那一格強行清空，
    // 留一條橫向通道，不然中線可能被整排堵死變成兩半場。
    if (symmetric) {
      const seam = Math.floor(TILE_H / 2);
      for (let c = 0; c < Math.floor(TILE_W / 2); c++)
        grid[seam][TILE_W - 1 - c] = grid[seam][c];
      grid[seam][Math.floor(TILE_W / 2)] = CELL_TYPE.EMPTY;
      // 下半部＝上半部的點對稱：tile(r, c) → tile(TILE_H-1-r, TILE_W-1-c)。
      // 在 tile 級做，展開到 cell 級之後「上下左右都鏡像」才不會因為
      // 半個 tile 落在中線上而破洞（cell 級鏡像會切出 8px 的牆，坦克 16px
      // 走不過去，看起來就像「莫名的一小塊磚」）。
      for (let r = 0; r < seam; r++)
        for (let c = 0; c < TILE_W; c++)
          grid[TILE_H - 1 - r][TILE_W - 1 - c] = grid[r][c];
    }
    return grid;
  }

  /** tile 網格 → cell 網格（1 tile = 2×2 cells） */
  function cells(mapId, symmetric) {
    const t = tiles(mapId, symmetric);
    const out = Array.from({ length: GRID_H }, () => new Array(GRID_W).fill(CELL_TYPE.EMPTY));
    for (let r = 0; r < TILE_H; r++) {
      for (let c = 0; c < TILE_W; c++) {
        const v = t[r][c];
        if (v === CELL_TYPE.EMPTY) continue;
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) out[r * 2 + dy][c * 2 + dx] = v;
      }
    }
    // 對稱模式的保證：cells[GRID_H-1-y][GRID_W-1-x] === cells[y][x]
    // 對全部 756 格成立（tile 級點對稱 ⇒ cell 級點對稱）。
    // test-harness.js 有一條測試逐格盯這個等式。
    return out;
  }

  /** tile 是否整块可行動（坦克走得過：空／樹林／冰；磚水鋼老鷹都不行） */
  function tileOpen(cells_, tc, tr) {
    for (let dy = 0; dy < 2; dy++)
      for (let dx = 0; dx < 2; dx++) {
        const v = cells_[tr * 2 + dy][tc * 2 + dx];
        if (v !== CELL_TYPE.EMPTY && v !== CELL_TYPE.FOREST && v !== CELL_TYPE.ICE)
          return false;
      }
    return true;
  }

  /** 進這個 tile 要付出多少「開挖代價」；回傳 -1 = 這 tile 不準挖 */
  function tileCost(cells_, tc, tr, forbidden) {
    let cost = 0;
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const cx = tc * 2 + dx, cy = tr * 2 + dy;
        if (forbidden && forbidden.has(cy * GRID_W + cx)) return -1;   // 要塞牆／老鷹：絕不挖
        const v = cells_[cy][cx];
        if (v === CELL_TYPE.EMPTY || v === CELL_TYPE.FOREST || v === CELL_TYPE.ICE) continue;
        // 磚 = 1（子彈就拆得掉，挖開它最不心疼）；鋼／水 = 6（不到萬不得已不要動）
        cost += (v === CELL_TYPE.BRICK) ? 1 : 6;
      }
    }
    return cost;
  }

  const KEY = (c, r) => r * TILE_W + c;

  /**
   * 「每一台車都真的有路可走」：從 sources 各自的 tile 出發，
   * Dijkstra 找一條到 targets 任一格最便宜的路，然後把沿路的tile挖空。
   *
   * ⚠ 為什麼一定要挖：隨機地形會（少見但必然地）長出「把敵方要塞整個圍死」
   *   或「把某個出生點封在口袋裡」的圖。那種局只有 `time` 一個結果，
   *   觀戰變成看兩隊在自家門口繞圈，訓練端也會把「攻不進去」誤學成
   *   「防守很好」—— 那是地圖的錯，不是網路的錯。
   *
   * @param {number[][]} cells_ 會直接被改寫（挖開的 tile → EMPTY）
   * @param {object} o
   *   o.sources  [[tc, tr], ...] 出生 tile（每一個都要有路）
   *   o.targets  [[tc, tr], ...] 終點 tile 集合（任一格到達即可）
   *   o.forbidden Set<cellKey>  不準挖的 cell（要塞牆＋老鷹）
   *   o.mirror   true ⇒ 每挖一格，連它的 180° 對稱格一起挖
   *              （觀戰／訓練用地圖專用：只挖藍隊那條路會讓下半場跟上半場
   *               不再鏡像，「兩隊地形幾何完全等价」這條前提就破了。）
   * @returns {number} 實際挖開了幾格（給測試與除錯用）
   */
  function carveRoutes(cells_, o) {
    const targetSet = new Set(o.targets.map(([c, r]) => KEY(c, r)));
    const mirror = !!o.mirror;
    const digTile = (c, r) => {
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const cx = c * 2 + dx, cy = r * 2 + dy;
          if (o.forbidden && o.forbidden.has(cy * GRID_W + cx)) continue;
          if (cells_[cy][cx] !== CELL_TYPE.EMPTY) cells_[cy][cx] = CELL_TYPE.EMPTY;
        }
    };
    let dug = 0;
    for (const src of o.sources) {
      const start = KEY(src[0], src[1]);
      // dist[]：到每個 tile 的最小開挖代價；prev[]：回溯路徑用
      const dist = new Map([[start, 0]]);
      const prev = new Map();
      const heap = [[0, start]];
      let hit = null;
      while (heap.length) {
        // tile 只有 189 個，直接線性取最小值：比寫 heap 更不容易出錯，
        // 而且這張圖小到「每張地圖多跑幾次 Dijkstra」在訓練迴圈裡仍只是零頭。
        let bi = 0;
        for (let i = 1; i < heap.length; i++) if (heap[i][0] < heap[bi][0]) bi = i;
        const [d, k] = heap.splice(bi, 1)[0];
        if (dist.get(k) !== d) continue;          // 已有一條更便宜的路到這裡
        if (targetSet.has(k)) { hit = k; break; }
        const c = k % TILE_W, r = (k - c) / TILE_W;
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nc = c + dc, nr = r + dr;
          if (nc < 0 || nc >= TILE_W || nr < 0 || nr >= TILE_H) continue;
          const cost = tileCost(cells_, nc, nr, o.forbidden);
          if (cost < 0) continue;
          const nd = d + cost;
          const nk = KEY(nc, nr);
          if (nd < (dist.has(nk) ? dist.get(nk) : Infinity)) {
            dist.set(nk, nd); prev.set(nk, k); heap.push([nd, nk]);
          }
        }
      }
      if (hit === null) continue;   // 理論上不會發生（場外沒有牆）；交給上層的 fallback
      if (dist.get(hit) === 0) continue;   // 本來就走得到，不亂動地形
      let k = hit;
      while (k !== undefined && k !== start) {
        const c = k % TILE_W, r = (k - c) / TILE_W;
        digTile(c, r); dug++;
        // 對稱那一份：tile (c,r) ↔ (TILE_W-1-c, TILE_H-1-r)。
        // 出生點與目標點本身成點對稱（見 constants.js 的 DEMO_SPAWNS 註解），
        // 所以鏡像過去剛好就是「紅隊那台車要走的同一條路」，不必再跑一次 Dijkstra
        // —— 就算再跑一次，兩邊在「同價路徑」上的取捨也可能不同，那個差異正是
        //   對稱性的殺手。挖同一份、鏡像同一份，才叫真的對稱。
        if (mirror) { digTile(TILE_W - 1 - c, TILE_H - 1 - r); dug++; }
        k = prev.get(k);
      }
    }
    return dug;
  }

  return { cells, tiles, carveRoutes, tileOpen, seedOf, mulberry32 };
})();
