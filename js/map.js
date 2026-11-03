/* ═══════════════════════════════════════════
   map.js — 18×42 cell 地形管理（9:21 直立戰場）

   - 地形由 js/mapgen.js 依 mapId 程序化生成（不再是 35 張手刻關卡）
   - 老鷹 (8..9, 40..41)，自動補磚環、淨空出生點
   - 磚牆以 cell（8×8）為最小破壞單位；地形的「形狀」以 tile（16×16）為單位
   - demo 模式：產生器只算上半部，下半部點對稱鏡像 ⇒ 兩隊地形幾荷完全等价
   - 基地以 this.bases 陣列管理（單人模式只有一座）
   - 生成完一定跑一次「坦克級開路」（_ensureRoutes）：
     隨機地形偶爾會長出封死的圖，那種局只有時間到一個結果。
   ═══════════════════════════════════════════ */

class GameMap {
  /**
   * @param {number} mapId 地形編號（0..MAP_VARIANTS-1，超出會環繞）
   * @param {object} opts  { demo: true } ⇒ 上下兩座老鷹＋點對稱地形
   */
  constructor(mapId = 0, opts = {}) {
    this.bases = [];
    this.load(mapId, !!opts.demo);
  }

  /**
   * 老鷹周圍那圈磚（要塞牆）的 cell 座標，以「基地左上 cell」為基準。
   * 原版是 3 tile 寬 × 2 tile 高的一塊，中間挖掉老鷹本身：
   *
   *     藍（下方，flip=false，基準 (8,40)）      紅（上方，flip=true，基準 (8,0)）
   *        ████ ████ ████  ← 帶 2（rows 38,39）     ← 先老鷹本體，牆在它下面
   *        ████ [老鷹] ████ ← 帶 1（rows 40,41）    ████ [老鷹] ████
   *        （底邊就是牆外，沒有第 3 排）              ████ ████ ████
   *
   * 兩邊都是 20 格；`flip` 只是把「那兩排厚牆」從老鷹上面換到下面。
   * 換算子（GRID_W=18、BASE_CELL_X=8）時左右各留 2 格（cx-2..cx+3），
   * 跟 26 格時代一模一樣，所以拆牆的節奏、鏟子道具的效果範圍都不用重調。
   */
  static ringCells(cx, cy, flip = false) {
    const out = [];
    // 兩排厚的頂牆：在老鷹「靠場內」那一側（下方基地＝上面，上方基地＝下面）
    const band = flip ? [cy + 2, cy + 3] : [cy - 2, cy - 1];
    for (const ry of band)
      for (let rx = cx - 2; rx <= cx + 3; rx++) out.push([rx, ry]);
    // 與老鷹同排的左右護牆
    for (const ry of [cy, cy + 1])
      for (const rx of [cx - 2, cx - 1, cx + 2, cx + 3]) out.push([rx, ry]);
    return out;
  }

  load(mapId, demo = false) {
    const id = ((mapId % MAP_VARIANTS) + MAP_VARIANTS) % MAP_VARIANTS;
    this.mapId = id;
    this.cells = MapGen.cells(id, demo);
    this.bases = [];

    if (demo) {
      this._addBase(BASE_CELL_X, BASE_CELL_Y, false);                                 // 藍（下）
      this._addBase(DEMO_BASE_CELLS[TEAM.RED].cx, DEMO_BASE_CELLS[TEAM.RED].cy, true); // 紅（上）
      // 兩隊出生點淨空（上下各 4 點，本身點對稱）
      for (const team of DEMO_SPAWNS)
        for (const sp of team) this._clearBox(sp.x, sp.y, TANK_PX, TANK_PX);
      this._ensureRoutes(demo);
      return;
    }

    // 單人基地（下方）
    this._addBase(BASE_CELL_X, BASE_CELL_Y, false);

    // 出生點淨空（敵×3 在頂邊、玩家×1 在底邊；本作沒有 2P 模式）
    for (const px of ENEMY_SPAWNS) this._clearBox(px, 0, TANK_PX, TANK_PX);
    this._clearBox(PLAYER_SPAWN.x, PLAYER_SPAWN.y, TANK_PX, TANK_PX);
    this._ensureRoutes(demo);
  }

  /**
   * 開路：確認「每一個出生點都有一條坦克真的開得過去的路，通到對面要塞外側」。
   *
   * 判定單位是 tile（16×16），不是 cell。坦克 2×2 cells，用 cell 找路會得到
   * 一堆「1 cell 寬的隧道」——圖上連通了、車卡在那裡，比封死更難查。
   * 挖的時候優先挖磚（子彈就拆得掉），鋼與水只有萬不得已才動，
   * 要塞牆與老鷹本身列為禁止（不然隨機開路會把人家的家直接挖穿）。
   */
  _ensureRoutes(demo) {
    // 禁止開挖的 cell：兩座要塞的牆 + 老鷹本體
    const forbidden = new Set();
    for (const b of this.bases) {
      for (const [rx, ry] of b.ring) forbidden.add(ry * GRID_W + rx);
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) forbidden.add((b.cy + dy) * GRID_W + (b.cx + dx));
    }

    // 要攻到「對面要塞門口」：老鷹那一 tile 排的內側兩格之外
    const approach = b => {
      const tr = b.cy / 2 + (b.rot ? 2 : -2);      // rot=Math.PI（真值）＝上方基地往下算
      const c0 = Math.floor((b.cx - 2) / 2), c1 = Math.floor((b.cx + 3) / 2);
      const out = [];
      for (let c = c0; c <= c1; c++) out.push([c, tr]);
      return out;
    };

    if (demo) {
      // 藍隊四個出生點 → 紅隊要塞外側（紅老鷹在 tile row 0，外側就是 row 2）
      // mirror：挖一條就等於挖兩條。只挖藍隊那條路的話，下半場會跟上半場
      // 不再鏡像 ——「兩隊面對的地形幾何完全等价」是觀戰與訓練的共同前提，
      // 破掉它的只會是「開路」這種看起來人畜無傷的步驟。
      const sources = DEMO_SPAWNS[TEAM.BLUE].map(sp => [sp.x / TILE_PX, sp.y / TILE_PX]);
      MapGen.carveRoutes(this.cells, {
        sources,
        targets: approach(this.bases[TEAM.RED]),
        forbidden,
        mirror: true,
      });
      return;
    }

    // 單人：敵生出生點（頂邊）→ 玩家老鷹外側（沒有對稱義務 ⇒ mirror=false）
    MapGen.carveRoutes(this.cells, {
      sources: ENEMY_SPAWNS.map(x => [x / TILE_PX, 0]),
      targets: approach(this.bases[0]),
      forbidden,
    });
  }

  /** 蓋上老鷹本體（蓋過任何生成資料）並登記基地 */
  _addBase(cx, cy, flip) {
    const ring = GameMap.ringCells(cx, cy, flip);
    // 磚環：原版每關必蓋，無條件覆蓋地形資料
    for (const [rx, ry] of ring) {
      if (this.inGrid(rx, ry)) this.cells[ry][rx] = CELL_TYPE.BRICK;
    }
    for (let dy = 0; dy < 2; dy++)
      for (let dx = 0; dx < 2; dx++)
        this.cells[cy + dy][cx + dx] = CELL_TYPE.BASE;

    // ringKeys：要塞牆（老鷹周圍那圈磚）的 cell 索引查表。
    // 射擊安全判定要分得出「打在一般磚牆上」和「打在自家要塞牆上」，
    // 後者是使用者明確禁止的：自己人不準傷到自己的要塞＋要塞的牆。
    //  Ring 是座標屬性的靜態清單（磚被打掉、鏟子變鋼都不改變「這是要塞牆」），
    //  所以開局算一次就好，之後逐幀 O(1) 查。
    this.bases.push({
      cx, cy,
      rot: flip ? Math.PI : 0,
      dead: false,
      ring,
      ringKeys: new Set(ring.map(([rx, ry]) => ry * GRID_W + rx)),
      shovelBackup: null,
    });
  }

  /** (cx,cy) 是不是這座基地的要塞牆格（磚還在不在都要看 cell 是否仍是實心） */
  isFortressWall(base, cx, cy) {
    if (!base || !base.ringKeys) return false;
    if (!base.ringKeys.has(cy * GRID_W + cx)) return false;
    const v = this.cellAt(cx, cy);
    return v === CELL_TYPE.BRICK || v === CELL_TYPE.STEEL;
  }

  /** (cx,cy) 落在哪座基地的要塞牆「位置」上（不看 cell 現值）。
      批次五（J）的拆牆計量要用：磚已經被打掉時 `isFortressWall` 回 false，
      所以那一格「算不算老鷹牆」必須在清空之前、用座標問，不能用現值問。 */
  wallOwner(cx, cy) {
    const k = cy * GRID_W + cx;
    for (const b of this.bases) if (b.ringKeys && b.ringKeys.has(k)) return b;
    return null;
  }

  /** 任一基地被毀（單人模式語意：老鷹掉了） */
  get baseDestroyed() { return this.bases.some(b => b.dead); }

  _clearBox(x, y, w, h) {
    for (let cy = Math.floor(y / CELL); cy < (y + h) / CELL; cy++)
      for (let cx = Math.floor(x / CELL); cx < (x + w) / CELL; cx++)
        if (this.inGrid(cx, cy)) this.cells[cy][cx] = CELL_TYPE.EMPTY;
  }

  inGrid(cx, cy) { return cx >= 0 && cx < GRID_W && cy >= 0 && cy < GRID_H; }

  cellAt(cx, cy) {
    if (!this.inGrid(cx, cy)) return CELL_TYPE.STEEL; // 界外視同硬牆
    return this.cells[cy][cx];
  }

  /** AABB (x,y,w,h) 是否撞到坦克不可通行的 cell */
  tankBlocked(x, y, w = TANK_PX, h = TANK_PX) {
    if (x < 0 || y < 0 || x + w > FIELD_W || y + h > FIELD_H) return true;
    const x0 = Math.floor(x / CELL), x1 = Math.floor((x + w - 1) / CELL);
    const y0 = Math.floor(y / CELL), y1 = Math.floor((y + h - 1) / CELL);
    for (let cy = y0; cy <= y1; cy++)
      for (let cx = x0; cx <= x1; cx++) {
        const v = this.cellAt(cx, cy);
        if (v === CELL_TYPE.BRICK || v === CELL_TYPE.STEEL ||
            v === CELL_TYPE.WATER || v === CELL_TYPE.BASE) return true;
      }
    return false;
  }

  /** 該 cell 屬於哪座基地（無則 null） */
  baseAtCell(cx, cy) {
    return this.bases.find(b =>
      cx >= b.cx && cx < b.cx + 2 && cy >= b.cy && cy < b.cy + 2) || null;
  }

  /** 基地中心（邏輯 px） */
  static baseCenter(base) {
    return { x: (base.cx + 1) * CELL, y: (base.cy + 1) * CELL };
  }

  /**
   * 子彈（中心 bx,by，4×4 box）撞地形。
   * 回傳 { hit, baseHit, base, wallCells } — hit=true 表示子彈應消失。
   * 磚 cell 直接削掉；鋼 cell 需 L4 火力；老鷹 cell → baseHit。
   * wallCells ＝ 這一發拆掉的「老鷹外圍那一圈」格數（[{base, cx, cy}]，
   *   一般磚牆不計）；v11 的拆牆計量靠它把近距離拆鷹跟遠距離啃牆分開算
   *   （見 ai/arena.js 的 foeWallNear／foeWallFar）。
   *
   * @param {number} [killerTeam] 開這發子彈的隊伍（js/entities.js 傳 owner.team）。
   *   記在 base.killedBy 上，為了分得出「被敵人打爆」跟「被自己人打爆」——
   *   後者是使用者明確要求要記錄、要罰的行為（見 ai/fitness.js ownEagleBySelf）。
   *   單人模式的老鷹被玩家自己打掉也算（bases[0] 是玩家那一側）。
   */
  bulletHit(bx, by, power, killerTeam = null) {
    const x0 = Math.floor((bx - 2) / CELL), x1 = Math.floor((bx + 1) / CELL);
    const y0 = Math.floor((by - 2) / CELL), y1 = Math.floor((by + 1) / CELL);

    let hit = false, baseHit = false, base = null;
    // 這一發拆掉的老鷹牆格（v11 拆計量要用；一般磚牆不會進這裡，
    // 因為 wallOwner 只認老鷹外圍那一圈座標）。null ＝ 沒拆到要塞牆。
    let wallCells = null;
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        if (!this.inGrid(cx, cy)) { hit = true; continue; }
        const v = this.cells[cy][cx];
        if (v === CELL_TYPE.BRICK) {
          const wb = this.wallOwner(cx, cy);        // ⚠ 要在清空「之前」問（見 wallOwner 註解）
          this.cells[cy][cx] = CELL_TYPE.EMPTY;
          hit = true;
          if (wb) (wallCells || (wallCells = [])).push({ base: wb, cx, cy });
        } else if (v === CELL_TYPE.STEEL) {
          hit = true;
          if (power >= FIREPOWER.L4) {
            const wb = this.wallOwner(cx, cy);
            this.cells[cy][cx] = CELL_TYPE.EMPTY;
            // 鏟子把要塞牆暫時變成鋼（shovelOn），L4 打得掉；那一格同樣算拆牆。
            if (wb) (wallCells || (wallCells = [])).push({ base: wb, cx, cy });
          }
        } else if (v === CELL_TYPE.BASE) {
          this.cells[cy][cx] = CELL_TYPE.EMPTY;
          hit = true;
          baseHit = true;
          const b = this.baseAtCell(cx, cy);
          if (b) {
            b.dead = true;
            // 同一發子彈會一次掃到 2×2 的幾格老鷹：只記「第一個兇手」，
            // 之後再被打到（理論上不該發生）也不覆寫，否則歸因會飄。
            if (b.killedBy === undefined || b.killedBy === null)
              b.killedBy = killerTeam === undefined ? null : killerTeam;
            base = b;
          }
        }
      }
    }
    return { hit, baseHit, base, wallCells };
  }

  /** 點 (px,py) 所在 cell 是否為冰 */
  isIceAt(px_, py_) {
    return this.cellAt(Math.floor(px_ / CELL), Math.floor(py_ / CELL)) === CELL_TYPE.ICE;
  }

  /** 鏟子：某基地的磚環 → 鋼（記錄原值以便還原）。預設基地 0。 */
  shovelOn(baseIndex = 0) {
    const base = this.bases[baseIndex];
    if (!base || base.shovelBackup) return;
    base.shovelBackup = [];
    for (const [cx, cy] of base.ring) {
      if (!this.inGrid(cx, cy)) continue;
      base.shovelBackup.push({ cx, cy, old: this.cells[cy][cx] });
      this.cells[cy][cx] = CELL_TYPE.STEEL;
    }
  }

  /** 鏟子時間到：鋼 → 還原。不帶參數＝全部基地還原。 */
  shovelOff(baseIndex = null) {
    const targets = baseIndex === null
      ? this.bases
      : [this.bases[baseIndex]].filter(Boolean);
    for (const base of targets) {
      if (!base.shovelBackup) continue;
      for (const { cx, cy, old } of base.shovelBackup) this.cells[cy][cx] = old;
      base.shovelBackup = null;
    }
  }

  get shovelActive() { return this.bases.some(b => !!b.shovelBackup); }
}
