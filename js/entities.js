/* ═══════════════════════════════════════════
   entities.js — Tank / Bullet（grid-locked 移動）

   移動規則（原版手感）：
   - 坦克位置 = px（16×16 box 左上角）
   - 轉向時垂直軸自動吸附最近的 cell 邊界（8px）
   - 前進只改方向軸座標 → 永不漂移、不卡牆
   ═══════════════════════════════════════════ */

function boxesOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x &&
         a.y < b.y + b.h && a.y + a.h > b.y;
}

class Tank {
  /**
   * @param x,y  px（16×16 box 左上角）
   * @param stats { speed, hp, score, bulletSpeed, enemyType }
   */
  constructor(x, y, dir, isPlayer, stats = {}) {
    this.x = x; this.y = y;
    this.dir = dir;
    this.isPlayer = isPlayer;
    // 所屬隊伍：單人模式 = 玩家(藍) vs 敵人(紅)；觀戰模式由 stats 指定
    this.team = stats.team ?? (isPlayer ? TEAM.BLUE : TEAM.RED);

    this.speed = stats.speed ?? PLAYER_SPEED;
    this.hp = stats.hp ?? 1;
    this.maxHp = this.hp;
    this.score = stats.score ?? 0;
    this.enemyType = stats.enemyType ?? null;

    this.firepower = FIREPOWER.L1;
    this.maxBullets = 1;
    this.bulletSpeed = stats.bulletSpeed ?? 4;

    this.cooldown = 0;
    this.spawnTimer = T.SPAWN_ANIM;  // 出生星芒 + 無敵
    this.shieldTimer = 0;            // 護盾（道具/重生）
    this.flashing = false;           // 閃紅敵人：擊殺掉道具
    this.flashFrame = 0;
    this.alive = true;
    this.moving = false;

    // 冰面
    this.slideDir = null;

    // AI 計時器（敵人使用）
    this.aiDirTimer = 0;
    this.aiShootTimer = 20;
  }

  get box() { return { x: this.x, y: this.y, w: TANK_PX, h: TANK_PX }; }
  center() { return { x: this.x + TANK_PX / 2, y: this.y + TANK_PX / 2 }; }

  /** 是否為敵對隊伍（觀戰模式用；單人模式 likewise） */
  isFoeOf(other) { return !!other && this.team !== other.team; }

  distTo(px_, py_) {
    const c = this.center();
    return Math.hypot(px_ - c.x, py_ - c.y);
  }

  /** 每幀計時器遞減 */
  tick() {
    if (this.cooldown > 0) this.cooldown--;
    if (this.spawnTimer > 0) this.spawnTimer--;
    if (this.shieldTimer > 0) this.shieldTimer--;
    if (this.flashing) this.flashFrame++;
  }

  /**
   * 嘗試朝 dir 移動一格速度量。轉向會自動吸附 cell 網格。
   * @returns true = 實際有移動
   */
  tryMove(dir, map, tanks) {
    // 轉向：吸附垂直軸到最近的 cell 邊界
    if (dir !== this.dir) {
      const snapped = { x: this.x, y: this.y };
      if (dir === DIR.UP || dir === DIR.DOWN) {
        snapped.x = Math.round(this.x / CELL) * CELL;
      } else {
        snapped.y = Math.round(this.y / CELL) * CELL;
      }
      // 吸附後不能撞牆/撞車才生效
      if (!map.tankBlocked(snapped.x, snapped.y) &&
          !this._hitsAnyTank(snapped.x, snapped.y, tanks)) {
        this.x = snapped.x;
        this.y = snapped.y;
      }
      this.dir = dir;
    }

    const v = DIR_VEC[this.dir];
    const nx = this.x + v.dx * this.speed;
    const ny = this.y + v.dy * this.speed;

    if (map.tankBlocked(nx, ny)) return false;
    if (this._hitsAnyTank(nx, ny, tanks)) return false;

    this.x = nx;
    this.y = ny;
    return true;
  }

  _hitsAnyTank(x, y, tanks) {
    const box = { x, y, w: TANK_PX, h: TANK_PX };
    for (const t of tanks) {
      if (t !== this && t.alive && boxesOverlap(box, t.box)) return true;
    }
    return false;
  }

  onIce(map) {
    const c = this.center();
    return map.isIceAt(c.x, c.y);
  }

  /** 開火。回傳 Bullet 或 null。 */
  shoot(existingBullets) {
    if (this.cooldown > 0 || this.spawnTimer > 0 || !this.alive) return null;
    let mine = 0;
    for (const b of existingBullets) if (b.owner === this) mine++;
    if (mine >= this.maxBullets) return null;

    this.cooldown = 8;
    const c = this.center();
    const v = DIR_VEC[this.dir];
    // 火力 L2 起提速；未升級的敵人維持原 bulletSpeed（與舊行為等價）
    const speed = this.firepower >= FIREPOWER.L2 ? 8 : this.bulletSpeed;
    return new Bullet(c.x + v.dx * 10, c.y + v.dy * 10, this.dir, speed, this);
  }

  /** 玩家火力升級 */
  upgradeFirepower() {
    if (this.firepower < FIREPOWER.L4) {
      this.firepower++;
      this._syncFirepower();
    }
  }

  resetFirepower() {
    this.firepower = FIREPOWER.L1;
    this._syncFirepower();
  }

  _syncFirepower() {
    this.maxBullets = this.firepower >= FIREPOWER.L3 ? 2 : 1;
  }

  /** 受彈。回傳 true = 被摧毀 */
  takeDamage() {
    this.hp--;
    if (this.hp <= 0) { this.alive = false; return true; }
    return false;
  }
}

class Bullet {
  constructor(x, y, dir, speed, owner) {
    this.x = x; this.y = y;   // 中心點 px
    this.dir = dir;
    this.speed = speed;
    this.owner = owner;
    // 敵人 firepower 恆為 1，故與舊的 isPlayer 分支等價
    this.power = owner.firepower;
    this.alive = true;
  }

  get box() { return { x: this.x - 2, y: this.y - 2, w: BULLET_PX, h: BULLET_PX }; }

  /** 前進並處理地形碰撞。回傳 map.bulletHit 結果。 */
  update(map) {
    const v = DIR_VEC[this.dir];
    this.x += v.dx * this.speed;
    this.y += v.dy * this.speed;

    // 界外即消
    if (this.x < 0 || this.x >= FIELD_PX || this.y < 0 || this.y >= FIELD_PX) {
      this.alive = false;
      return { hit: true, baseHit: false };
    }
    const r = map.bulletHit(this.x, this.y, this.power);
    if (r.hit) this.alive = false;
    return r;
  }
}
