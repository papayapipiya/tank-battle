/* ═══════════════════════════════════════════
   map.js — 26×26 cell 地形管理

   - 載入 13×13 tile 關卡，展開成 26×26 cells（1 tile = 2×2 cells）
   - 老鷹 (12..13, 24..25)，自動補磚環、淨空出生點
   - 磚牆以 cell（8×8）為最小破壞單位
   - demo 模式：把下半部垂直鏡像到上半部，形成對稱戰場 + 第二座老鷹
   - 基地以 this.bases 陣列管理（單人模式只有一座）
   ═══════════════════════════════════════════ */

class GameMap {
  constructor(stageIndex = 0, opts = {}) {
    this.bases = [];
    this.load(stageIndex, !!opts.demo);
  }

  static CHAR_TO_CELL(ch) {
    switch (ch) {
      case '#': return CELL_TYPE.BRICK;
      case 'S': return CELL_TYPE.STEEL;
      case '~': return CELL_TYPE.WATER;
      case 'F': return CELL_TYPE.FOREST;
      case 'I': return CELL_TYPE.ICE;
      case 'B': return CELL_TYPE.BASE;
      default:  return CELL_TYPE.EMPTY;
    }
  }

  /** tile 座標的磚環 → cell 座標；flip 時以 12-r 鏡像到頂部 */
  static RING_CELLS(flip = false) {
    return GameMap.BASE_RING_TILES.flatMap(([c, r]) => {
      const rt = flip ? 12 - r : r;
      const out = [];
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) out.push([c * 2 + dx, rt * 2 + dy]);
      return out;
    });
  }

  load(index, demo = false) {
    const tiles = STAGES[index % STAGES.length];
    this.cells = Array.from({ length: GRID }, () => Array(GRID).fill(CELL_TYPE.EMPTY));

    for (let r = 0; r < 13; r++) {
      for (let c = 0; c < 13; c++) {
        const v = GameMap.CHAR_TO_CELL(tiles[r][c]);
        if (v === CELL_TYPE.EMPTY) continue;
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++)
            this.cells[r * 2 + dy][c * 2 + dx] = v;
      }
    }

    this.bases = [];

    // 藍隊／單人基地（下方）
    this._addBase(BASE_CELL_X, BASE_CELL_Y, false);

    if (demo) {
      // 下半部鏡像蓋到上半部 → 對稱戰場，並自動帶出頂部磚環
      for (let cy = 0; cy < GRID / 2; cy++) {
        this.cells[cy] = this.cells[GRID - 1 - cy].slice();
      }
      this._addBase(DEMO_BASE_CELLS[TEAM.RED].cx, DEMO_BASE_CELLS[TEAM.RED].cy, true);

      // 兩隊出生點淨空
      for (const team of DEMO_SPAWNS)
        for (const sp of team) this._clearBox(sp.x, sp.y, TANK_PX, TANK_PX);
      return;
    }

    // 出生點淨空（敵×3、玩家×1 + 2P 位）
    for (const px of ENEMY_SPAWNS) this._clearBox(px, 0, TANK_PX, TANK_PX);
    this._clearBox(PLAYER_SPAWN.x, PLAYER_SPAWN.y, TANK_PX, TANK_PX);
    this._clearBox(8 * 16, PLAYER_SPAWN.y, TANK_PX, TANK_PX); // 2P 位
  }

  /** 蓋上老鷹本體（蓋過任何關卡資料）並登記基地 */
  _addBase(cx, cy, flip) {
    // 磚環：原版每關必蓋，無條件覆蓋關卡資料
    for (const [rx, ry] of GameMap.RING_CELLS(flip)) {
      if (this.inGrid(rx, ry)) this.cells[ry][rx] = CELL_TYPE.BRICK;
    }
    for (let dy = 0; dy < 2; dy++)
      for (let dx = 0; dx < 2; dx++)
        this.cells[cy + dy][cx + dx] = CELL_TYPE.BASE;

    this.bases.push({
      cx, cy,
      rot: flip ? Math.PI : 0,
      dead: false,
      ring: GameMap.RING_CELLS(flip),
      shovelBackup: null,
    });
  }

  /** 任一基地被毀（單人模式語意：老鷹掉了） */
  get baseDestroyed() { return this.bases.some(b => b.dead); }

  _clearBox(x, y, w, h) {
    for (let cy = Math.floor(y / CELL); cy < (y + h) / CELL; cy++)
      for (let cx = Math.floor(x / CELL); cx < (x + w) / CELL; cx++)
        if (this.inGrid(cx, cy)) this.cells[cy][cx] = CELL_TYPE.EMPTY;
  }

  inGrid(cx, cy) { return cx >= 0 && cx < GRID && cy >= 0 && cy < GRID; }

  cellAt(cx, cy) {
    if (!this.inGrid(cx, cy)) return CELL_TYPE.STEEL; // 界外視同硬牆
    return this.cells[cy][cx];
  }

  /** AABB (x,y,w,h) 是否撞到坦克不可通行的 cell */
  tankBlocked(x, y, w = TANK_PX, h = TANK_PX) {
    if (x < 0 || y < 0 || x + w > FIELD_PX || y + h > FIELD_PX) return true;
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
   * 回傳 { hit, baseHit, base } — hit=true 表示子彈應消失。
   * 磚 cell 直接削掉；鋼 cell 需 L4 火力；老鷹 cell → baseHit。
   */
  bulletHit(bx, by, power) {
    const x0 = Math.floor((bx - 2) / CELL), x1 = Math.floor((bx + 1) / CELL);
    const y0 = Math.floor((by - 2) / CELL), y1 = Math.floor((by + 1) / CELL);

    let hit = false, baseHit = false, base = null;
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        if (!this.inGrid(cx, cy)) { hit = true; continue; }
        const v = this.cells[cy][cx];
        if (v === CELL_TYPE.BRICK) {
          this.cells[cy][cx] = CELL_TYPE.EMPTY;
          hit = true;
        } else if (v === CELL_TYPE.STEEL) {
          hit = true;
          if (power >= FIREPOWER.L4) this.cells[cy][cx] = CELL_TYPE.EMPTY;
        } else if (v === CELL_TYPE.BASE) {
          this.cells[cy][cx] = CELL_TYPE.EMPTY;
          hit = true;
          baseHit = true;
          const b = this.baseAtCell(cx, cy);
          if (b) { b.dead = true; base = b; }
        }
      }
    }
    return { hit, baseHit, base };
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

// 老鷹周圍 6 塊磚環（tile 座標）
GameMap.BASE_RING_TILES = Object.freeze([
  [5, 11], [6, 11], [7, 11],
  [5, 12],           [7, 12],
]);
