/* ═══════════════════════════════════════════
   game.js — 狀態機 + 主迴圈 + 規則

   单人：TITLE → STAGE_INTRO → PLAYING ⇄ PAUSED
                            ↘ STAGE_CLEAR → (下一關 INTRO)
                            ↘ GAME_OVER → TITLE
   觀戰：TITLE →(T) DEMO_INTRO → DEMO ⇄ PAUSED → DEMO_RESULT →(下一輪) DEMO_INTRO
   全域按鍵（P/M/Enter/R/T）在任何狀態都處理。
   ═══════════════════════════════════════════ */

class Game {
  constructor() {
    Sprites.build();
    Renderer.init(document.getElementById('gameCanvas'));
    UI.init();
    Input.init();

    this.hiScore = parseInt(localStorage.getItem('tankBattleHiScore') || '0', 10);
    this.score = 0;
    this.lives = 3;
    this.stage = 1;
    this.nextExtraLife = SCORE_EXTRA_LIFE;

    this.state = STATE.TITLE;
    this.stateTimer = 0;
    this.frame = 0;
    this.moveDir = null;
    this.pauseReturn = null;

    // ── A.I. 對戰（觀戰）模式 ──
    this.demoMode = false;
    this.demoRound = 0;
    this.demoStageIndex = 0;
    this.teams = null;
    this.tanks = [];
    this.demoWinner = null;
    this.demoCap = 0;

    this.setupStage(this.stage);
    this.startLoop();
  }

  // ── 關卡建立（不改狀態）──
  setupStage(n) {
    this.map = new GameMap(n - 1);
    this.player = new Tank(PLAYER_SPAWN.x, PLAYER_SPAWN.y, DIR.UP, true, {});
    this.enemies = [];
    this.bullets = [];
    this.powerUps = [];
    this.iconsLeft = ENEMIES_PER_STAGE; // 右側敵軍圖示 = 尚未擊殺數
    this.spawnedTotal = 0;
    this.spawnCd = 30;
    this.freezeTimer = 0;
    this.shovelTimer = 0;
    this.moveDir = null;
    Renderer.clearFx();
  }

  startStage(n) {
    this.setupStage(n);
    this.state = STATE.STAGE_INTRO;
    this.stateTimer = T.STAGE_INTRO;
  }

  newGame() {
    this.score = 0;
    this.lives = 3;
    this.stage = 1;
    this.nextExtraLife = SCORE_EXTRA_LIFE;
    this.startStage(1);
  }

  allTanks() {
    return this.demoMode ? this.tanks : [this.player, ...this.enemies];
  }

  // ══════════ AI 視角查詢（單人／觀戰共用）══════════

  /** 該坦克的敵對存活車輛 */
  foesOf(tank) {
    if (this.demoMode) {
      const foe = this.teams[1 - tank.team];
      return foe.tanks.filter(t => t.alive && t.spawnTimer <= 0);
    }
    if (tank.isPlayer) return this.enemies.filter(e => e.alive && e.spawnTimer <= 0);
    return this.player.alive ? [this.player] : [];
  }

  /** 該坦克要攻擊的老鷹中心（邏輯 px） */
  foeBaseOf(tank) {
    if (this.demoMode) {
      const b = this.map.bases[1 - tank.team];
      return b && !b.dead ? GameMap.baseCenter(b) : null;
    }
    const b = this.map.bases[0];
    return b && !b.dead ? GameMap.baseCenter(b) : null;
  }

  /** 該坦克要守護的老鷹；單人模式敵人沒有自家基地 → null（不回防） */
  ownBaseOf(tank) {
    if (!this.demoMode) return null;
    const b = this.map.bases[tank.team];
    return b && !b.dead ? GameMap.baseCenter(b) : null;
  }

  /** 該坦克是否被時鐘凍結 */
  frozenFor(tank) {
    return this.demoMode ? this.teams[tank.team].frozen > 0 : this.freezeTimer > 0;
  }

  // ══════════ 輸入 ══════════

  /** 全域按鍵 — 任何狀態都要能收 */
  handleGlobalKeys() {
    if (Input.wasPressed('m')) Audio.toggleMute();

    // T：從標題進入 A.I. 對戰（觀戰）
    if (Input.wasPressed('t') && this.state === STATE.TITLE) {
      this.startDemo();
      return;
    }

    if (Input.wasPressed('p')) {
      const pausable = this.state === STATE.PLAYING || this.state === STATE.DEMO;
      if (pausable) {
        this.pauseReturn = this.state;
        this.state = STATE.PAUSED;
        Audio.play('pause');
      } else if (this.state === STATE.PAUSED) {
        this.state = this.pauseReturn || STATE.PLAYING;
      }
    }

    const confirm = Input.wasPressed('enter') || Input.wasPressed('r');
    if (confirm) {
      if (this.state === STATE.TITLE) {
        this.newGame();
      } else if (this.demoMode) {
        // 觀戰中：Enter 回標題，R 重打本輪
        if (Input.wasPressed('enter')) this.exitDemo();
        else this.startDemo(false);
      } else if (this.state === STATE.GAME_OVER) {
        this.state = STATE.TITLE;
      } else if (Input.wasPressed('r') && this.state === STATE.PLAYING) {
        this.startStage(this.stage); // R = 重開本關
      }
    }
  }

  /** 方向輸入：記住最近按下的方向，放開後回落到任何還按著的方向 */
  readMoveDir() {
    const KEYS = [
      ['w', DIR.UP], ['arrowup', DIR.UP],
      ['s', DIR.DOWN], ['arrowdown', DIR.DOWN],
      ['a', DIR.LEFT], ['arrowleft', DIR.LEFT],
      ['d', DIR.RIGHT], ['arrowright', DIR.RIGHT],
    ];
    for (const [k, d] of KEYS) if (Input.wasPressed(k)) this.moveDir = d;

    const stillHeld = this.moveDir !== null &&
      KEYS.some(([k, d]) => d === this.moveDir && Input.isDown(k));
    if (!stillHeld) {
      this.moveDir = null;
      for (const [k, d] of KEYS) {
        if (Input.isDown(k)) { this.moveDir = d; break; }
      }
    }
  }

  // ══════════ 主更新 ══════════

  update() {
    this.handleGlobalKeys();

    switch (this.state) {
      case STATE.TITLE:
      case STATE.PAUSED:
      case STATE.GAME_OVER:
        return; // 等待按鍵

      case STATE.STAGE_INTRO:
        if (--this.stateTimer <= 0) this.state = STATE.PLAYING;
        return;

      case STATE.STAGE_CLEAR:
        if (--this.stateTimer <= 0) {
          this.stage++;
          this.startStage(this.stage);
        }
        return;

      case STATE.DEMO_INTRO:
        if (--this.stateTimer <= 0) {
          this.state = STATE.DEMO;
          this.demoCap = DEMO_ROUND_CAP;
        }
        return;

      case STATE.DEMO:
        this.updateDemo();
        return;

      case STATE.DEMO_RESULT:
        if (--this.stateTimer <= 0) this.startDemo(); // 自動開下一輪
        return;

      case STATE.PLAYING:
        this.updatePlaying();
        return;
    }
  }

  updatePlaying() {
    this.frame++;

    // ── 道具計時器 ──
    if (this.freezeTimer > 0) this.freezeTimer--;
    if (this.shovelTimer > 0 && --this.shovelTimer <= 0) this.map.shovelOff();

    // ── 玩家 ──
    this.readMoveDir();
    const p = this.player;
    p.moving = false;
    if (p.alive && p.spawnTimer <= 0) {
      if (this.moveDir !== null) {
        p.moving = p.tryMove(this.moveDir, this.map, this.allTanks());
        p.slideDir = this.moveDir;
      } else if (p.slideDir !== null && p.onIce(this.map)) {
        // 冰面滑行：放開按鍵後繼續滑到離開冰面或撞牆
        p.moving = p.tryMove(p.slideDir, this.map, this.allTanks()) || true;
        if (!p.onIce(this.map)) p.slideDir = null;
      } else {
        p.slideDir = null;
      }

      if (Input.isDown('j') || Input.isDown(' ')) {
        const b = p.shoot(this.bullets);
        if (b) { this.bullets.push(b); Audio.play('shoot'); }
      }
    }
    p.tick();

    // ── 敵人 ──
    for (const e of this.enemies) {
      if (!e.alive) continue;
      EnemyAI.update(e, this);
      e.tick();
    }

    // ── 子彈：地形 ──
    for (const b of this.bullets) {
      if (!b.alive) continue;
      const r = b.update(this.map);
      if (r.baseHit) this.onBaseDestroyed();
    }

    // ── 子彈：互撞抵消 ──
    for (let i = 0; i < this.bullets.length; i++) {
      const a = this.bullets[i];
      if (!a.alive || !a.owner.isPlayer) continue;
      for (const b of this.bullets) {
        if (!b.alive || b.owner.isPlayer) continue;
        if (boxesOverlap(a.box, b.box)) { a.alive = false; b.alive = false; break; }
      }
    }

    // ── 子彈：打坦克 ──
    for (const b of this.bullets) {
      if (!b.alive) continue;
      const targets = b.owner.isPlayer ? this.enemies : [this.player];
      for (const t of targets) {
        if (!t.alive || t.spawnTimer > 0) continue;
        if (!boxesOverlap(b.box, t.box)) continue;
        b.alive = false;
        if (t.isPlayer) {
          if (t.shieldTimer > 0) break; // 護盾擋下
          this.onPlayerHit();
        } else {
          if (t.takeDamage()) this.onEnemyKilled(t, true);
          else Audio.play('hitSteel');
        }
        break;
      }
    }

    // ── 道具 ──
    for (const pu of this.powerUps) {
      pu.update();
      if (pu.alive && p.alive && boxesOverlap(pu.box, p.box)) {
        pu.alive = false;
        this.applyPowerUp(pu);
      }
    }

    // ── 敵人出生 ──
    if (--this.spawnCd <= 0) {
      this.spawnCd = Math.max(SPAWN_INTERVAL_FLOOR,
        SPAWN_INTERVAL_MIN - (this.stage - 1) * SPAWN_INTERVAL_STEP);
      if (this.iconsLeft > this.enemies.length &&
          this.enemies.length < MAX_ENEMIES_ON_FIELD) {
        this.spawnEnemy();
      }
    }

    // ── 過關判定 ──
    if (this.iconsLeft === 0 && this.enemies.length === 0) {
      this.state = STATE.STAGE_CLEAR;
      this.stateTimer = T.STAGE_CLEAR;
      Audio.play('stageClear');
    }

    // ── 清理 ──
    this.bullets = this.bullets.filter(b => b.alive);
    this.enemies = this.enemies.filter(e => e.alive);
    this.powerUps = this.powerUps.filter(pu => pu.alive);
  }

  // ══════════ A.I. 對戰（觀戰模式）══════════

  /** 開一輪 AI 對戰。nextRound=false 表示重打本輪（同一張地圖） */
  startDemo(nextRound = true) {
    if (nextRound) this.demoRound++;
    this.demoMode = true;
    this.demoStageIndex = (this.demoRound - 1) % STAGES.length;
    this.map = new GameMap(this.demoStageIndex, { demo: true });

    this.player = null;
    this.enemies = [];
    this.tanks = [];
    this.bullets = [];
    this.powerUps = [];
    this.freezeTimer = 0;
    this.shovelTimer = 0;
    this.spawnCd = 0;
    this.moveDir = null;
    this.demoWinner = null;
    this.powerUpCd = DEMO_POWERUP_INTERVAL;
    Renderer.clearFx();

    this.teams = [TEAM.BLUE, TEAM.RED].map(id => ({
      id,
      label: id === TEAM.BLUE ? '藍' : '紅',
      baseIndex: id,
      pool: DEMO_TANKS_PER_TEAM,
      tanks: [],
      spawnCd: 20 + id * 25,
      frozen: 0,
      shovelTimer: 0,
      score: 0,
      kills: 0,
    }));

    this.stage = this.demoRound;
    this.state = STATE.DEMO_INTRO;
    this.stateTimer = T.STAGE_INTRO;
  }

  /** 退出觀戰，回到標題並重建單人關卡 */
  exitDemo() {
    this.demoMode = false;
    this.teams = null;
    this.tanks = [];
    this.stage = 1;
    this.score = 0;
    this.lives = 3;
    this.nextExtraLife = SCORE_EXTRA_LIFE;
    this.setupStage(1);
    this.state = STATE.TITLE;
  }

  updateDemo() {
    this.frame++;

    if (--this.demoCap <= 0) {
      this.finishDemo(this.demoScoreLeader());
      return;
    }

    // ── 隊伍計時器 ──
    for (const team of this.teams) {
      if (team.frozen > 0) team.frozen--;
      if (team.shovelTimer > 0 && --team.shovelTimer <= 0) {
        this.map.shovelOff(team.baseIndex);
      }
    }

    // ── 全部坦克由 AI 驅動 ──
    for (const t of this.tanks) {
      if (!t.alive) continue;
      EnemyAI.update(t, this);
      t.tick();
    }

    // ── 子彈：地形／基地 ──
    for (const b of this.bullets) {
      if (!b.alive) continue;
      const r = b.update(this.map);
      if (r.baseHit && r.base) {
        this.onDemoBaseHit(r.base);
        if (this.state !== STATE.DEMO) return;
      }
    }

    // ── 子彈：敵對互撞抵消 ──
    for (let i = 0; i < this.bullets.length; i++) {
      const a = this.bullets[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < this.bullets.length; j++) {
        const c = this.bullets[j];
        if (!c.alive || c.owner.team === a.owner.team) continue;
        if (boxesOverlap(a.box, c.box)) { a.alive = false; c.alive = false; break; }
      }
    }

    // ── 子彈：打敵隊坦克 ──
    for (const b of this.bullets) {
      if (!b.alive) continue;
      for (const t of this.tanks) {
        if (!t.alive || t.spawnTimer > 0 || t.team === b.owner.team) continue;
        if (!boxesOverlap(b.box, t.box)) continue;
        b.alive = false;
        if (t.shieldTimer > 0) break;            // 護盾擋下
        if (t.takeDamage()) this.creditKill(b.owner, t);
        else Audio.play('hitSteel');
        break;
      }
    }

    // ── 道具：誰先撞到誰用 ──
    for (const pu of this.powerUps) {
      pu.update();
      for (const t of this.tanks) {
        if (!pu.alive) break;
        if (t.alive && t.spawnTimer <= 0 && boxesOverlap(pu.box, t.box)) {
          pu.alive = false;
          this.applyPowerUpToTank(t, pu);
        }
      }
    }

    // ── 兩隊各自出生 ──
    for (const team of this.teams) {
      if (--team.spawnCd > 0) continue;
      team.spawnCd = DEMO_SPAWN_INTERVAL;
      if (team.pool > 0 && team.tanks.length < DEMO_MAX_ON_FIELD) {
        this.spawnDemoTank(team);
      }
    }

    // ── 定期在場中央補道具 ──
    if (--this.powerUpCd <= 0) {
      this.powerUpCd = DEMO_POWERUP_INTERVAL;
      const pu = PowerUp.spawnRandom(this.map);
      if (pu) { this.powerUps.push(pu); Audio.play('powerupAppear'); }
    }

    // ── 雙方坦克池耗盡且場上無車 → 比積分 ──
    if (this.tanks.length === 0 && this.teams.every(t => t.pool === 0)) {
      this.finishDemo(this.demoScoreLeader());
      return;
    }

    // ── HUD 鏡像：生命=藍隊剩餘、敵軍=紅隊剩餘、分數=藍隊 ──
    this.score = this.teams[TEAM.BLUE].score;
    this.lives = this.teams[TEAM.BLUE].pool + this.teams[TEAM.BLUE].tanks.length;
    this.iconsLeft = this.teams[TEAM.RED].pool + this.teams[TEAM.RED].tanks.length;

    // ── 清理 ──
    this.bullets = this.bullets.filter(x => x.alive);
    for (const team of this.teams) team.tanks = team.tanks.filter(t => t.alive);
    this.tanks = this.tanks.filter(t => t.alive);
    this.powerUps = this.powerUps.filter(p => p.alive);
  }

  spawnDemoTank(team) {
    const sp = EnemyAI.pickSpawn(this, team.id);
    if (!sp) { team.spawnCd = 30; return; }   // 出生點被佔，稍後再試

    const type = EnemyAI.pickType(this.demoRound + 1);
    const stats = ENEMY_STATS[type];
    const isBlue = team.id === TEAM.BLUE;
    const t = new Tank(sp.x, sp.y, isBlue ? DIR.UP : DIR.DOWN, isBlue, {
      speed: stats.speed, hp: stats.hp, score: stats.score,
      bulletSpeed: stats.bulletSpeed, enemyType: type, team: team.id,
    });
    team.pool--;
    team.tanks.push(t);
    this.tanks.push(t);
  }

  /** 擊殺記點（炸彈路徑也復用此處，統一標記死亡） */
  creditKill(shooter, victim) {
    victim.alive = false;
    const c = victim.center();
    Renderer.spawnExplosion(c.x, c.y, false);
    Renderer.spawnPopup(c.x, c.y, String(victim.score));
    Audio.play('explode');
    const team = this.teams[shooter.team];
    team.kills++;
    team.score += victim.score;
  }

  onDemoBaseHit(base) {
    const idx = this.map.bases.indexOf(base);
    const c = GameMap.baseCenter(base);
    Renderer.spawnExplosion(c.x, c.y, true);
    Audio.play('bigExplode');
    this.map.shovelOff(idx);
    this.finishDemo(this.teams[1 - idx]);
  }

  demoScoreLeader() {
    const [a, b] = this.teams;
    if (a.score !== b.score) return a.score > b.score ? a : b;
    if (a.kills !== b.kills) return a.kills > b.kills ? a : b;
    return null;
  }

  finishDemo(winner) {
    if (this.state !== STATE.DEMO) return;
    this.demoWinner = winner;
    this.state = STATE.DEMO_RESULT;
    this.stateTimer = DEMO_RESULT_FRAMES;
    Audio.play(winner ? 'stageClear' : 'gameOver');
  }

  applyPowerUpToTank(tank, pu) {
    const team = this.teams[tank.team];
    const foeTeam = this.teams[1 - tank.team];
    team.score += SCORE_POWERUP;
    const c = tank.center();
    Renderer.spawnPopup(c.x, c.y - 8, String(SCORE_POWERUP));
    Audio.play('powerup');

    switch (pu.type) {
      case POWERUP_TYPE.STAR:
        tank.upgradeFirepower();
        break;

      case POWERUP_TYPE.SHIELD:
        tank.shieldTimer = T.SHIELD;
        break;

      case POWERUP_TYPE.TANK:
        team.pool++;
        Audio.play('extraLife');
        break;

      case POWERUP_TYPE.CLOCK:
        foeTeam.frozen = T.CLOCK_FREEZE;
        Audio.play('freeze');
        break;

      case POWERUP_TYPE.BOMB:
        for (const foe of [...foeTeam.tanks]) {
          if (foe.alive) this.creditKill(tank, foe);
        }
        Audio.play('bigExplode');
        break;

      case POWERUP_TYPE.SHOVEL: {
        const base = this.map.bases[team.baseIndex];
        if (base && !base.dead) {
          this.map.shovelOn(team.baseIndex);
          team.shovelTimer = T.SHOVEL;
          Audio.play('shovel');
        }
        break;
      }
    }
  }

  // ══════════ 事件 ══════════

  spawnEnemy() {
    const sp = EnemyAI.pickSpawn(this);
    if (!sp) return;

    const type = EnemyAI.pickType(this.stage);
    const stats = ENEMY_STATS[type];
    const e = new Tank(sp.x, sp.y, DIR.DOWN, false, {
      speed: stats.speed, hp: stats.hp,
      score: stats.score, bulletSpeed: stats.bulletSpeed,
      enemyType: type,
    });
    this.spawnedTotal++;
    if (FLASH_KILL_INDICES.includes(this.spawnedTotal)) e.flashing = true;
    this.enemies.push(e);
  }

  onEnemyKilled(e, byPlayer) {
    e.alive = false; // 炸彈路徑不經過 takeDamage，統一在這裡標記死亡
    this.iconsLeft--;
    const c = e.center();
    Renderer.spawnExplosion(c.x, c.y, false);
    Audio.play('explode');

    if (byPlayer) {
      this.score += e.score;
      Renderer.spawnPopup(c.x, c.y, String(e.score));
      // 閃紅敵人掉道具（場上同時只有一個）
      if (e.flashing) {
        for (const pu of this.powerUps) pu.alive = false;
        const pu = PowerUp.spawnRandom(this.map);
        if (pu) { this.powerUps.push(pu); Audio.play('powerupAppear'); }
      }
      // 2 萬分獎命
      if (this.score >= this.nextExtraLife) {
        this.nextExtraLife += SCORE_EXTRA_LIFE;
        this.lives++;
        Audio.play('extraLife');
      }
    }
  }

  onPlayerHit() {
    const c = this.player.center();
    Renderer.spawnExplosion(c.x, c.y, true);
    Audio.play('bigExplode');

    this.lives--;
    if (this.lives <= 0) {
      this.onGameOver();
      return;
    }
    // 重生：位置歸位、火力歸零、短暫無敵
    this.player.resetFirepower();
    this.player.x = PLAYER_SPAWN.x;
    this.player.y = PLAYER_SPAWN.y;
    this.player.dir = DIR.UP;
    this.player.spawnTimer = T.SPAWN_ANIM;
    this.player.shieldTimer = T.PLAYER_RESPAWN_SHIELD;
    this.player.slideDir = null;
  }

  onBaseDestroyed() {
    if (this.state !== STATE.PLAYING) return;
    Renderer.spawnExplosion((BASE_CELL_X + 1) * CELL, (BASE_CELL_Y + 1) * CELL, true);
    this.onGameOver();
  }

  onGameOver() {
    this.state = STATE.GAME_OVER;
    Audio.play('gameOver');
    if (this.score > this.hiScore) {
      this.hiScore = this.score;
      localStorage.setItem('tankBattleHiScore', String(this.hiScore));
    }
  }

  applyPowerUp(pu) {
    this.score += SCORE_POWERUP;
    const c = this.player.center();
    Renderer.spawnPopup(c.x, c.y - 8, String(SCORE_POWERUP));
    Audio.play('powerup');

    switch (pu.type) {
      case POWERUP_TYPE.STAR:
        this.player.upgradeFirepower();
        break;

      case POWERUP_TYPE.BOMB:
        // 全滅場上敵人（計入擊殺數，不給個別分數、不掉道具）
        for (const e of this.enemies) {
          if (e.alive) this.onEnemyKilled(e, false);
        }
        Audio.play('bigExplode');
        break;

      case POWERUP_TYPE.CLOCK:
        this.freezeTimer = T.CLOCK_FREEZE;
        Audio.play('freeze');
        break;

      case POWERUP_TYPE.SHOVEL:
        this.map.shovelOn();
        this.shovelTimer = T.SHOVEL;
        Audio.play('shovel');
        break;

      case POWERUP_TYPE.SHIELD:
        this.player.shieldTimer = T.SHIELD;
        break;

      case POWERUP_TYPE.TANK:
        this.lives++;
        Audio.play('extraLife');
        break;
    }
  }

  // ══════════ 渲染 ══════════

  draw() {
    Renderer.clear();
    Renderer.drawMap(this.map, this.frame);

    for (const pu of this.powerUps) Renderer.drawPowerUp(pu);
    if (this.demoMode) {
      for (const t of this.tanks) Renderer.drawTank(t, this.teams[t.team].frozen > 0);
    } else {
      Renderer.drawTank(this.player, false);
      for (const e of this.enemies) Renderer.drawTank(e, this.freezeTimer > 0);
    }
    for (const b of this.bullets) Renderer.drawBullet(b);

    Renderer.drawFx();
    Renderer.drawForestOverlay(this.map);

    switch (this.state) {
      case STATE.TITLE:
        Renderer.overlay([
          { text: '坦克大戰', size: 24, bold: true, color: '#f8d840', gap: 24 },
          { text: 'BATTLE CITY', size: 10, color: '#888', gap: 24 },
          { text: 'PRESS ENTER', size: 12, color: '#fff', gap: 18 },
          { text: 'T — A.I. 對戰觀戰', size: 9, color: '#58c8f8', gap: 16 },
          { text: `HI-SCORE ${this.hiScore}`, size: 9, color: '#f85858' },
        ]);
        break;
      case STATE.DEMO_INTRO:
        Renderer.overlay([
          { text: 'A.I. 對戰', size: 20, bold: true, color: '#f8d840', gap: 22 },
          { text: `ROUND ${this.demoRound}`, size: 12, color: '#fff', gap: 18 },
          { text: '藍守下方  紅守上方', size: 9, color: '#888', gap: 16 },
          { text: 'ENTER 返回', size: 8, color: '#666' },
        ], { dim: 0.85 });
        break;
      case STATE.DEMO_RESULT: {
        const [b0, b1] = this.teams;
        const w = this.demoWinner;
        Renderer.overlay([
          { text: w ? `${w.label}隊勝` : '平手', size: 22, bold: true,
            color: w && w.id === TEAM.BLUE ? '#f8d840' : '#f85858', gap: 24 },
          { text: `藍 ${b0.score}  (${b0.kills} 擊殺)`, size: 10, color: '#f8d840', gap: 16 },
          { text: `紅 ${b1.score}  (${b1.kills} 擊殺)`, size: 10, color: '#c8a84b', gap: 20 },
          { text: w ? '下一輪即將開始' : 'ENTER 返回', size: 8, color: '#888' },
        ], { dim: 0.7 });
        break;
      }
      case STATE.STAGE_INTRO:
        Renderer.overlay([
          { text: `STAGE ${this.stage}`, size: 18, bold: true, color: '#fff' },
        ], { dim: 0.85 });
        break;
      case STATE.PAUSED:
        Renderer.overlay([
          { text: 'PAUSE', size: 18, bold: true, color: '#fff' },
        ], { dim: 0.5 });
        break;
      case STATE.STAGE_CLEAR:
        Renderer.overlay([
          { text: `STAGE ${this.stage}`, size: 16, bold: true, color: '#f8d840', gap: 18 },
          { text: 'CLEAR!', size: 16, bold: true, color: '#f8d840' },
        ], { dim: 0.55 });
        break;
      case STATE.GAME_OVER:
        Renderer.overlay([
          { text: 'GAME', size: 20, bold: true, color: '#f83838', gap: 22 },
          { text: 'OVER', size: 20, bold: true, color: '#f83838', gap: 26 },
          { text: `SCORE ${this.score}`, size: 10, color: '#fff', gap: 14 },
          { text: 'PRESS ENTER', size: 9, color: '#888' },
        ]);
        break;
    }

    UI.update(this);
  }

  // ══════════ 主迴圈（固定 60fps timestep）══════════

  startLoop() {
    let last = performance.now();
    let acc = 0;
    const loop = (now) => {
      let elapsed = now - last;
      last = now;
      if (elapsed > 200) elapsed = 200;
      acc += elapsed;
      while (acc >= FRAME_MS) {
        Input.update();
        this.update();
        Renderer.tickFx();
        acc -= FRAME_MS;
      }
      this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}

// ── Boot ──
window.addEventListener('DOMContentLoaded', () => {
  window.__game = new Game();
});
