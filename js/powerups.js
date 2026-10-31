/* ═══════════════════════════════════════════
   powerups.js — 道具實體（效果套用由 game.js 負責）
   ═══════════════════════════════════════════ */

class PowerUp {
  /** @param tileX,tileY 16px tile 座標 */
  constructor(tileX, tileY, type) {
    this.x = tileX * 16;
    this.y = tileY * 16;
    this.type = type;
    this.alive = true;
    this.timer = T.POWERUP_BLINK;
  }

  get box() { return { x: this.x, y: this.y, w: 16, h: 16 }; }

  update() {
    if (--this.timer <= 0) this.alive = false;
  }

  /** 快消失時閃爍 */
  get visible() {
    if (this.timer > 120) return true;
    return (this.timer >> 3) % 2 === 0;
  }

  /** 加權隨機：星星常見，+1命稀有 */
  static randomType() {
    const bag = [
      POWERUP_TYPE.STAR, POWERUP_TYPE.STAR,
      POWERUP_TYPE.BOMB, POWERUP_TYPE.CLOCK,
      POWERUP_TYPE.SHOVEL, POWERUP_TYPE.SHIELD,
      POWERUP_TYPE.TANK,
    ];
    return bag[Math.floor(Math.random() * bag.length)];
  }

  /** 在隨機空 tile 生成。找不到回傳 null。 */
  static spawnRandom(map) {
    const spots = [];
    for (let r = 0; r < 13; r++) {
      for (let c = 0; c < 13; c++) {
        let empty = true;
        for (let dy = 0; dy < 2 && empty; dy++)
          for (let dx = 0; dx < 2 && empty; dx++)
            if (map.cells[r * 2 + dy][c * 2 + dx] !== CELL_TYPE.EMPTY) empty = false;
        if (empty) spots.push([c, r]);
      }
    }
    if (spots.length === 0) return null;
    const [c, r] = spots[Math.floor(Math.random() * spots.length)];
    return new PowerUp(c, r, PowerUp.randomType());
  }
}
