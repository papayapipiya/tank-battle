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

// 轉向後至少連續走幾步才準再轉（AI 專用）。
// 只擋「原地翻面」不夠：實測網路會在牆邊兩格之間上下/左右抽動，
// 每幀都換方向、每幀也都有 1px 位移 —— 畫面上仍然是原地抖動。
// 給轉向一個短暫的承諾期，車子才會真的「往一個方向開」，而不是原地鋸齒。
const AI_DIR_COMMIT = 12;

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
    this.aiWanted = null;            // 下一幀想轉去的方向（真的走得到才成立，見 moveAsAI）
    this.lastMoveDir = null;         // 上一次「真的走出去」的方向（反悔偵測用）
    this.stuckFrames = 0;            // 連續走不動的幀數（AI 換向／解卡用）
    this.commitLeft = 0;             // 轉向後還要連續走幾步才準再轉（防原地鋸齒）

    // 外部決策器（訓練／觀戰注入點）；null = 由 EnemyAI 規則驅動
    this.controller = null;
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

  /**
   * AI 專用：朝 dir 轉向並走一步；**這一步如果真的走不了，就把轉向撤回**。
   * ═══════════════════════════════════════════════════════════
   * 使用者看到的「原地旋轉」有兩種：左右翻面，和上下每幀翻面
   * （觀戰實測同一台車原地 160 次 0→2→0→2）。成因是控制器每幀
   * 只改 dir、tryMove 失敗也沒關係，車子的朝向就跟著控制器抖。
   * 從行為上說，這種原地轉向不產生任何位移，也沒有戰術價值。
   *
   * 所以 AI 的「轉向」改成有條件成立：先照常轉＋走，若一步都走不了，
   * 連吸附造成的座標變化一起還原。轉向必須換到位移才算數；
   * 走不動時就維持原向，等路讓開再轉。
   *
   * 另外兩條防「原地磨蹭」的規則：
   *   1. 往前走得通時，不準下一步直接原路退回（見 reverseBanned）。
   *      想掉頭要先走一步垂直方向 —— 撤退仍做得到，只是不許抖。
   *   2. 剛轉過向的 AI_DIR_COMMIT 步內不準再轉；這期間的轉向請求
   *      直接當成「繼續往前」。只擋原地翻面不夠，實測網路會在牆邊
   *      兩格之間每幀換一次垂直方向，位移雖有 1px，畫面上仍是原地鋸齒。
   *
   * 玩家不走這條路：單人模式貼牆轉向是正常操作，不能一起鎖掉。
   */
  moveAsAI(dir, map, tanks) {
    // 也不準「走一步立刻原路退回去」：往前還走得通時，回頭路先封住。
    // 這種一來一回在畫面上就是原地上下（或左右）磨蹭，位移為零；
    // 真正的撤退（前面撞牆／撞車）不受限，想掉頭也可以先走一步垂直方向。
    const back = this.reverseBanned(map, tanks);
    if (back >= 0 && dir === back) {
      this.stuckFrames = Math.min(99, this.stuckFrames + 1);
      return false;
    }

    // 剛轉過向 → 先沿這個方向走完承諾期；這期間的轉向請求被吞掉，
    // 直接繼續往前（不是站著不動），直到前面真的被擋住才準再轉。
    let want = dir;
    if (want !== this.dir && this.commitLeft > 0 && this.forwardOpen(map, tanks)) {
      want = this.dir;
    }

    const px = this.x, py = this.y, pd = this.dir;
    const moved = this.tryMove(want, map, tanks);
    if (moved) {
      this.lastMoveDir = this.dir;
      this.stuckFrames = 0;
      if (this.dir !== pd) this.commitLeft = AI_DIR_COMMIT;
      else if (this.commitLeft > 0) this.commitLeft--;
    } else {
      if (want !== pd) {
        this.x = px;
        this.y = py;
        this.dir = pd;
      }
      this.stuckFrames = Math.min(99, this.stuckFrames + 1);
    }
    return moved;
  }

  /** 目前朝向前方一步走得通嗎？（承諾期／回頭路判斷共用） */
  forwardOpen(map, tanks) {
    const v = DIR_VEC[this.dir];
    const nx = this.x + v.dx * this.speed;
    const ny = this.y + v.dy * this.speed;
    return !map.tankBlocked(nx, ny) && !this._hitsAnyTank(nx, ny, tanks);
  }

  /**
   * 現在哪個方向是「不準直接回頭」的？往前走得通時回傳反向，否則 -1。
   * 給 moveAsAI 與 policy 的反射層共用，兩邊才不會各判一套。
   */
  reverseBanned(map, tanks) {
    if (this.lastMoveDir === null) return -1;
    const fwd = DIR_VEC[this.lastMoveDir];
    const nx = this.x + fwd.dx * this.speed;
    const ny = this.y + fwd.dy * this.speed;
    if (map.tankBlocked(nx, ny) || this._hitsAnyTank(nx, ny, tanks)) return -1;
    return (this.lastMoveDir + 2) % 4;
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
    const b = new Bullet(c.x + v.dx * 10, c.y + v.dy * 10, this.dir, speed, this);
    // 批次五（J）：把「開火那一瞬間的車心」留在子彈上。
    // 為什麼不讓計量端在子彈消失的那一幀回推位置：子彈 8px/幀、車 2px/幀，
    // 一顆飛到對面老鷹的槍要飛 20 幀以上，那 40px 的漂移剛好跟 56px 的
    // 「門口」同一個等級 —— 用impact 點判「近距離拆牆」會把遠射算成貼臉。
    // 只有老鷹牆的拆計（v11）讀這兩個欄位；遊戲規則不受影響。
    b.fireX = c.x; b.fireY = c.y;
    return b;
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
    if (this.x < 0 || this.x >= FIELD_W || this.y < 0 || this.y >= FIELD_H) {
      this.alive = false;
      return { hit: true, baseHit: false };
    }
    const r = map.bulletHit(this.x, this.y, this.power, this.owner ? this.owner.team : null);
    if (r.hit) this.alive = false;
    return r;
  }
}
