/* ═══════════════════════════════════════════
   ai.js — 坦克 AI：巡邏 / 追擊 / 衝敵基地 / 回防攔截

   單人模式與觀戰模式共用這套 AI，差異由 game 提供的
   foesOf / foeBaseOf / ownBaseOf / frozenFor 決定：
     - 單人：敵人只有一個玩家目標、且沒有「自家基地」→ 不會回防
     - 觀戰：兩隊互为敵人，各自有基地 → 會回防
   ═══════════════════════════════════════════ */

const EnemyAI = {

  /** 每幀驅動一台 AI 坦克 */
  update(tank, game) {
    if (!tank.alive || tank.spawnTimer > 0 || game.frozenFor(tank)) return;

    tank.aiDirTimer--;
    tank.aiShootTimer--;

    // 定期換方向
    if (tank.aiDirTimer <= 0) {
      tank.aiDirTimer = 40 + Math.floor(Math.random() * 60);
      tank.dir = this._pickDirection(tank, game, false);
    }

    const moved = tank.tryMove(tank.dir, game.map, game.allTanks());

    // 卡住 → 立刻換向（不選回頭路以外的死路）
    if (!moved) {
      tank.dir = this._pickDirection(tank, game, true);
      tank.aiDirTimer = 25 + Math.floor(Math.random() * 35);
    }

    // 射擊：與目標同軸時積極開火，否則偶發
    if (tank.aiShootTimer <= 0) {
      tank.aiShootTimer = 25 + Math.floor(Math.random() * 50);
      const lined = this._linedUp(tank, game);
      if (Math.random() < (lined ? 0.55 : 0.04)) {
        const b = tank.shoot(game.bullets);
        if (b) game.bullets.push(b);
      }
    }
  },

  /**
   * 選目標點：
   *   1) 敵車逼近自家基地 → 回防攔截（僅觀戰模式有自家基地）
   *   2) 40% 追最近敵車、30% 衝敵基地、其餘巡邏（回傳 undefined）
   */
  _goal(tank, game) {
    const foes = game.foesOf(tank);
    const ownBase = game.ownBaseOf(tank);
    const foeBase = game.foeBaseOf(tank);

    if (ownBase) {
      let threat = null, best = DEMO_THREAT_RADIUS;
      for (const f of foes) {
        const d = f.distTo(ownBase.x, ownBase.y);
        if (d < best) { best = d; threat = f; }
      }
      if (threat) return { x: threat.x, y: threat.y, defend: true };
    }

    const roll = Math.random();
    if (roll < 0.4 && foes.length) {
      let near = foes[0];
      for (const f of foes) if (f.distTo(tank.x, tank.y) < near.distTo(tank.x, tank.y)) near = f;
      return { x: near.x, y: near.y };
    }
    if (roll < 0.7 && foeBase) return { x: foeBase.x, y: foeBase.y };
    return undefined;
  },

  /** 依目標點選方向；主方向被擋就換垂直方向 */
  _pickDirection(tank, game, stuck) {
    const goal = stuck ? undefined : this._goal(tank, game);

    if (goal) {
      const want = this._toward(tank.x, tank.y, goal.x, goal.y);
      if (this._dirOpen(tank, want, game.map)) return want;
      const alt = this._perpendicular(tank, want, goal);
      if (this._dirOpen(tank, alt, game.map)) return alt;
    }

    // 隨機：排除反方向，優先可走的
    const opposite = (tank.dir + 2) % 4;
    const options = [DIR.UP, DIR.RIGHT, DIR.DOWN, DIR.LEFT]
      .filter(d => d !== opposite && this._dirOpen(tank, d, game.map));
    if (options.length === 0) return opposite;
    return options[Math.floor(Math.random() * options.length)];
  },

  _toward(x, y, tx, ty) {
    const dx = tx - x, dy = ty - y;
    if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? DIR.RIGHT : DIR.LEFT;
    return dy > 0 ? DIR.DOWN : DIR.UP;
  },

  _perpendicular(tank, dir, goal) {
    // 朝目標的另一軸
    const dx = goal.x - tank.x, dy = goal.y - tank.y;
    if (dir === DIR.UP || dir === DIR.DOWN) return dx > 0 ? DIR.RIGHT : DIR.LEFT;
    return dy > 0 ? DIR.DOWN : DIR.UP;
  },

  _dirOpen(tank, dir, map) {
    const v = DIR_VEC[dir];
    const nx = tank.x + v.dx * CELL;
    const ny = tank.y + v.dy * CELL;
    return !map.tankBlocked(nx, ny);
  },

  /** 是否與敵車或敵基地同軸（有射擊線） */
  _linedUp(tank, game) {
    const c = tank.center();
    const targets = game.foesOf(tank).map(f => f.center());
    const foeBase = game.foeBaseOf(tank);
    if (foeBase) targets.push(foeBase);

    for (const t of targets) {
      const sameCol = Math.abs(t.x - c.x) < CELL &&
        ((tank.dir === DIR.UP && t.y < c.y) || (tank.dir === DIR.DOWN && t.y > c.y));
      const sameRow = Math.abs(t.y - c.y) < CELL &&
        ((tank.dir === DIR.LEFT && t.x < c.x) || (tank.dir === DIR.RIGHT && t.x > c.x));
      if (sameCol || sameRow) return true;
    }
    return false;
  },

  /** 找該隊一個空的出生點。回傳 {x,y} 或 null。 */
  pickSpawn(game, team = TEAM.RED) {
    const points = game.demoMode
      ? DEMO_SPAWNS[team]
      : ENEMY_SPAWNS.map(x => ({ x, y: 0 }));
    const order = [...points].sort(() => Math.random() - 0.5);

    for (const sp of order) {
      const box = { x: sp.x, y: sp.y, w: TANK_PX, h: TANK_PX };
      let clear = !game.map.tankBlocked(sp.x, sp.y);
      if (clear) {
        for (const t of game.allTanks()) {
          if (t.alive && boxesOverlap(box, t.box)) { clear = false; break; }
        }
      }
      if (clear) return { x: sp.x, y: sp.y };
    }
    return null;
  },

  /** 依關卡決定下一台敵人類型 */
  pickType(stageNumber) {
    const d = Math.min(1, (stageNumber - 1) / 20); // 0 → 1
    const r = Math.random();
    if (r < 0.40 - d * 0.15) return ENEMY_TYPE.BASIC;
    if (r < 0.65 - d * 0.10) return ENEMY_TYPE.FAST;
    if (r < 0.85)            return ENEMY_TYPE.POWER;
    return ENEMY_TYPE.ARMOR;
  },
};
