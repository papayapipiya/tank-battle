/* ═══════════════════════════════════════════
   game.js — 狀態機 + 主迴圈 + 規則

   單人：TITLE → STAGE_INTRO → PLAYING ⇄ PAUSED
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
    // 觀戰播放速度（右欄滑鼠按鈕 1×/2×/4×）。只在 startLoop 裡放大餵進
    // 固定 timestep 的時間，不改 FRAME_MS、也不改任何邏輯規則；
    // 無頭訓練端根本不跑這個迴圈，所以訓練跟訓練場看到的行為不受影響。
    this.speed = 1;

    // ── A.I. 對戰（觀戰）模式 ──
    this.demoMode = false;
    // 觀戰開局的第一台車固定從自家老鷹兩側（x=32/96）對稱出生，
    // 不再從地圖最左／最右的角落冒出來；第二台以後仍四點隨機。
    // 訓練競技場（ai/arena.js）會把它關掉，維持原本的四點分佈與分數基準。
    this.demoOpeningCenter = true;
    this.demoRound = 0;
    this.demoStageIndex = 0;
    // 右欄「📌 固定這張圖」：null＝每一輪隨機抽一張（使用者要的「地圖隨機」）。
    // 想連續觀察同一張地形上的攻守進化成什麼樣，才按下去鎖住。
    this.demoMapPinned = null;
    this.teams = null;
    this.tanks = [];
    this.demoWinner = null;
    this.demoCap = 0;
    // 外部決策器（訓練／觀戰用）；AI = Node 側 ai/ 模組，null 時全部跑 EnemyAI 規則
    this.AI = (typeof AI !== 'undefined' && AI) ? AI : null;
    this.teamControllerSpecs = null;

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

  /** 亂數（無頭引擎會把它換成可種子化的實作，這裡只做轉傳） */
  rand() {
    return (typeof window.__rand === 'function') ? window.__rand() : Math.random();
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
      // 開場那 90 幀與結算那 300 幀也準暫停：觀戰時「把判決畫面停住看清楚」
      // 正是滑鼠族最需要的，之前只有 PLAYING／DEMO 能停，按 P 沒反應。
      const pausable = this.state === STATE.PLAYING || this.state === STATE.DEMO ||
        this.state === STATE.DEMO_INTRO || this.state === STATE.DEMO_RESULT;
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
      if (r.baseHit) this.onBaseDestroyed(b.owner ? b.owner.team : null);
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

  /** 開一輪 AI 對戰。nextRound=false 表示重打本輪（同一張地圖）
   *  @param stageOverride 指定地圖編號（訓練／面板選圖用）；給定時不隨 demoRound
   *         遞增、也不隨機，同一 (stage, seed) 必然重現同一局——競技場的
   *         可重現性依賴此參數。
   *
   *  地形選擇（2026-11-01「地圖隨機」）：
   *    · 有 override ⇒ 就用那一張（訓練考題、◀▶ 瀏覽、面板選圖）
   *    · demoMapPinned 非 null ⇒ 每一輪都固定在這一張（右欄「📌 固定」）
   *    · 其餘情况：nextRound=true 抽一張新的 mapId；nextRound=false（R 鍵
   *      「重開本輪」）沿用這一輪原本那張 —— 不然「重看剛剛那一場」
   *      會變成「換一張圖」，對照組就沒了。
   *  mapId → 地形是固定函數（js/mapgen.js），所以抽到的圖在任何機器上都一樣。 */
  startDemo(nextRound = true, stageOverride = null) {
    if (nextRound && stageOverride === null) this.demoRound++;
    this.demoMode = true;
    const wrap = i => ((i % MAP_VARIANTS) + MAP_VARIANTS) % MAP_VARIANTS;
    if (stageOverride !== null) {
      this.demoStageIndex = wrap(stageOverride);
      // 鎖圖時 ◀▶ 改的是「固定到哪一張」，不是只重開這一次
      if (this.demoMapPinned !== null) this.demoMapPinned = this.demoStageIndex;
    } else if (this.demoMapPinned !== null) {
      this.demoStageIndex = wrap(this.demoMapPinned);
    } else if (nextRound) {
      this.demoStageIndex = Math.floor(Math.random() * MAP_VARIANTS);
    }
    this.map = new GameMap(this.demoStageIndex, { demo: true });

    this.player = null;
    this.enemies = [];
    this.tanks = [];
    this.bullets = [];
    this.powerUps = [];
    // v11 的拆牆計量：每一格老鷹牆被誰的哪一槍拆掉，逐筆記在這裡。
    // 訓練端（ai/arena.js）每幀取走就清空；觀戰頁不讀它，所以每輪開始要歸零，
    // 否則一個長Session 會把幾百筆小物件掛在 game 上。
    this.wallEvents = [];
    this.freezeTimer = 0;
    this.shovelTimer = 0;
    this.spawnCd = 0;
    this.moveDir = null;
    this.demoWinner = null;
    this.demoResult = null;          // { reason, text }：這一輪為什麼這樣收場
    this.powerUpCd = DEMO_POWERUP_INTERVAL;
    Renderer.clearFx();

    this.teams = [TEAM.BLUE, TEAM.RED].map(id => ({
      id,
      label: id === TEAM.BLUE ? '藍' : '紅',
      // 攻守分工：HUD、結算、訓練端的角色說明都讀這三個欄位，
      // 不要在別處再寫死「藍=進攻」——換席位時只改 constants.js 一處。
      role: demoRoleOf(id),
      roleLabel: demoRoleOf(id) === DEMO_ROLES.ATTACK ? '進攻' : '防守',
      baseIndex: id,
      pool: DEMO_TANKS_PER_TEAM,
      tanks: [],
      spawned: 0,          // 本輪已出幾台（開場一次出滿 4 台，之後打完才補）
      // 首發由下面的 spawnOpeningRanks 一次填滿；這個 20 只是「沒擠滿時」的保底，
      // 兩隊同值 —— 原本 +id*25 讓藍隊早 25 幀出兵 = 實測的第二個偏置。
      spawnCd: 20,
      // 進攻方補人較快：30 秒的鐘對守方有利，出兵節奏是把優勢補回去的那一面。
      spawnEvery: DEMO_TEAM_SPAWN_INTERVALS[id],
      frozen: 0,
      shovelTimer: 0,
      score: 0,
      kills: 0,
      // 炸彈道具直接判死、不經過 takeDamage()，所以這幾條命不會出現在
      // hp 差分（damageDone）裡。分開記，才說得清「傷害 ≥ 擊殺」為什麼
      // 偶爾不成立；訓練端 ai/arena.js 會把這個數字一起帶進統計。
      bombKills: 0,
    }));

    // ── 開場即全出：每隊一開局就把 4 個出生點填滿 ──
    // 使用者的原話：「紅藍的坦克一開始就全部出來，四台」。
    // 之前是第 20 幀擠出第一台、之後每 100／150 幀補一台，所以開局常有
    // 「一邊兩台、另一邊一台」的瞬間 —— 數量差會被直接當成戰況，其實那是出兵節奏。
    // 現在場上從第一幀就是 4 vs 4，之後只守「打完才補、補到 4 台」這一條上限。
    // 順序仍讓第一台走 demoOpeningCenter 的中央對稱點（其餘四點隨機），
    // 兩隊同幀、同一樣的 4 點，所以不會因此偏袒任何一席。
    this.spawnOpeningRanks();

    this.stage = this.demoRound;
    this.state = STATE.DEMO_INTRO;
    this.stateTimer = T.STAGE_INTRO;
  }

  /** 開場批次：把兩隊各填到 DEMO_MAX_ON_FIELD 台（出生點被佔就交給後續節奏補） */
  spawnOpeningRanks() {
    if (!this.teams) return;
    for (const team of this.teams) {
      for (let i = 0; i < DEMO_MAX_ON_FIELD && team.pool > 0; i++) this.spawnDemoTank(team);
      // 擠滿 4 台 → 補人計時器從「正常節奏」起算，不要留 setup 那個 20 幀首發預設。
      // 沒擠滿（某點被佔，spawnDemoTank 自己設了 30 幀重試）→ 保留短間隔，別把缺口拖到 100 幀後。
      if (team.tanks.length >= DEMO_MAX_ON_FIELD) team.spawnCd = team.spawnEvery;
    }
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

    // 擲硬幣翻轉坦克陣列的處理順序。
    // 原本的固定順序（藍先紅後）讓所有「同幀互毀」都由藍隊獲勝：
    // 藍隊先開火 ⇒ 子彈先進陣列 ⇒ 藍的子彈先結算，紅的車先死，
    // 紅的子彈回頭找不到目標（!t.alive 就跳過）。實測 200 局藍隊 58.5% 勝率，
    // 就是這個排序偏置。改成每幀隨機取向，兩隊在統計上才真的等價。
    if (this.rand() < 0.5) this.tanks.reverse();

    if (--this.demoCap <= 0) {
      // 使用者規則：「超過 30 秒沒有分出勝負，紅色贏」。
      // 進攻方只有把紅隊老鷹打掉這一條路，拖時間對它沒有價值；
      // 防守方「守住了」本身就是勝利條件，所以這里不再比積分（原本的
      // demoScoreLeader 會讓消極避戰也贏，正是使用者要的積極性反面）。
      this.finishDemo(this.teams[DEMO_DEFENSE_TEAM], 'time');
      return;
    }

    // ── 隊伍計時器 ──
    for (const team of this.teams) {
      if (team.frozen > 0) team.frozen--;
      if (team.shovelTimer > 0 && --team.shovelTimer <= 0) {
        this.map.shovelOff(team.baseIndex);
      }
    }

    // ── 全部坦克由 AI 驅動（有 controller 就交給他）──
    for (const t of this.tanks) {
      if (!t.alive) continue;
      if (t.controller) t.controller.step(t, this);
      else EnemyAI.update(t, this);
      if (!t.controller) t.tick();
    }

    // ── 子彈：地形／基地 ──
    for (const b of this.bullets) {
      if (!b.alive) continue;
      const r = b.update(this.map);
      if (r.wallCells && r.wallCells.length) this.recordWallHit(b, r.wallCells);
      if (r.baseHit && r.base) {
        // 把開火者的隊伍一起傳進去：老鷹被毀時要分得出「被敵人打爆」還是
        // 「被自己人打爆」（使用者要求：自破要記錄、要列入訓練標準）。
        this.onDemoBaseHit(r.base, b.owner ? b.owner.team : null);
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

    // ── 兩隊各自出生（進攻方補人較快，見 DEMO_TEAM_SPAWN_INTERVALS）──
    for (const team of this.teams) {
      if (--team.spawnCd > 0) continue;
      team.spawnCd = team.spawnEvery;
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

    // ── 雙方坦克池耗盡且場上無車：進攻方再也打不進去 → 防守方（紅）勝 ──
    // 原本這裡比積分；新規則下藍隊「只有一個贏法」，兵力用盡就是沒攻破，
    // 讓結果跟 30 秒到時一樣判給紅隊，才不會出現「誰都沒動但比較誰分高」。
    if (this.tanks.length === 0 && this.teams.every(t => t.pool === 0)) {
      this.finishDemo(this.teams[DEMO_DEFENSE_TEAM], 'pool');
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

  /**
   * 觀戰開局的第一台車：從自家老鷹左右旁的中央出生點出車。
   * 兩隊取 180° 對稱的一對（藍 32／紅 96 或藍 96／紅 32，逐輪換邊），
   * 避免原本四點隨機常出現「一台在最左、一台在最右」的邊角畫面。
   * 只影響瀏覽器觀戰；訓練競技場會關掉 demoOpeningCenter，考題不變。
   * 回傳 {x,y} 或 null（該點被佔用時交給 pickSpawn 重試）。
   */
  openingSpawn(team) {
    if (!this.demoOpeningCenter) return null;
    const side = (this.demoRound % 2 === 0) ? 0 : 1;   // 0：藍左紅右；1：藍右紅左
    const idx = team.id === TEAM.BLUE ? (side ? 2 : 1) : (side ? 1 : 2);
    const sp = DEMO_SPAWNS[team.id][idx];
    if (this.map.tankBlocked(sp.x, sp.y)) return null;
    const box = { x: sp.x, y: sp.y, w: TANK_PX, h: TANK_PX };
    for (const t of this.tanks) {
      if (t.alive && boxesOverlap(box, t.box)) return null;
    }
    return { x: sp.x, y: sp.y };
  }

  spawnDemoTank(team) {
    // 本輪第一台車走中央對稱點；被佔用或訓練模式則沿用原本的四點隨機。
    const sp = (team.spawned === 0 && this.openingSpawn(team)) || EnemyAI.pickSpawn(this, team.id);
    if (!sp) { team.spawnCd = 30; return; }   // 出生點被佔，稍後再試

    // 敵人組成依「本輪地圖」而非遞增的 demoRound：
    // 訓練時每局獨立（demoRound 不再變動），用 demoRound 會讓同關卡的重現結果漂移。
    // % ENEMY_DIFF_CURVE：地形現在是 0..254 隨機抽，而 pickType 的難度曲線在
    // 第 21 關就封頂 —— 不取模的話「地圖編號大於 20」會把所有輪都變成最硬的一組
    // （ARMOR 常駐），難度差異悄悄從「關卡」跑到「地圖編號」上了。
    const type = EnemyAI.pickType((this.demoStageIndex % ENEMY_DIFF_CURVE) + 1);
    const stats = ENEMY_STATS[type];
    const isBlue = team.id === TEAM.BLUE;
    const t = new Tank(sp.x, sp.y, isBlue ? DIR.UP : DIR.DOWN, isBlue, {
      speed: stats.speed, hp: stats.hp, score: stats.score,
      bulletSpeed: stats.bulletSpeed, enemyType: type, team: team.id,
    });
    team.pool--;
    // 訓練／對戰注入點：teamControllerSpecs[teamIndex] 決定這台車聽誰的
    if (this.teamControllerSpecs && this.AI) {
      const spec = this.teamControllerSpecs[team.id];
      if (spec) t.controller = this.AI.makeController(spec, team.id);
    }
    team.tanks.push(t);
    team.spawned++;
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

  /**
   * 拆牆事件（v11 計量用）：把「老鷹外圍那一圈少了哪幾格」記到開這一槍的人身上。
   * 這裡只記事實（哪一隊、拆哪座要塞幾格、從哪裡開的槍、子彈往哪個方向飛），
   * 不下好壞判斷 —— 「算不算近距離」由讀的一端（ai/arena.js）用
   * `EnemyAI.baseWithin` ＋ `AI_ASSAULT_RADIUS` 判，規則與計量共用同一把尺。
   * 沒有開火者的拆牆（炸彈道具那種路徑）一律不歸因：寧可漏記，不栽贓。
   */
  recordWallHit(b, cells) {
    const team = b.owner ? b.owner.team : null;
    if (team === null || team === undefined) return;
    const list = this.wallEvents || (this.wallEvents = []);
    // 一發子彈同時掃到兩座要塞（實務上不會，兩座老鷹在場的兩端）→ 分兩筆記，
    // 歸因才不會因為「只記第一格所在的要塞」而飄到另一隊頭上。
    // 記的是座標而不是個數：鏟子（shovelOn 把整圈_backup 成磚）會讓被打掉的
    // 牆「活回來」，同一格可以被打第二次 —— 訓練端要用座標去重，
    // 否則「拆了→被還原→再拆」會變成可反覆領的分（見 ai/arena.js 的 wallSeen）。
    for (const base of this.map.bases) {
      const keys = [];
      for (const c of cells) if (c.base === base) keys.push(c.cx + ',' + c.cy);
      if (keys.length) list.push({ team, baseIndex: this.map.bases.indexOf(base), keys,
        fireX: b.fireX, fireY: b.fireY, dir: b.dir });
    }
  }

  onDemoBaseHit(base, killerTeam = null) {
    const idx = this.map.bases.indexOf(base);
    const c = GameMap.baseCenter(base);
    Renderer.spawnExplosion(c.x, c.y, true);
    Audio.play('bigExplode');
    this.map.shovelOff(idx);
    // 兇手跟老鷹同一隊 = 「自己人打爆自家老鷹」。使用者要求：要記錄、要進入訓練標準。
    // killerTeam 為 null 時（炸彈道具、舊存檔、手動事件）一律視為非自破 ——
    // 寧可漏記，不可把敵人的戰功栽贓給自己人。
    const ownGoal = killerTeam !== null && killerTeam !== undefined && killerTeam === idx;
    // 老鷹被毀 = 該隊輸。這仍然是本遊戲唯一的「提前分出勝負」條件：
    // 紅隊老鷹被打掉 → 藍隊（進攻方）達成唯一目標；
    // 藍隊老鷹被打掉 → 紅隊贏，連同「防守方反向攻破」這種情況也算。
    // ⚠ reason 不因為自破而換新值（breach／counter 仍是那套終局條件），
    //   ownGoal 是「這個結果是怎麼來的」的附加資訊，計分端據此不發進攻大獎。
    this.finishDemo(this.teams[1 - idx], idx === TEAM.RED ? 'breach' : 'counter',
      { ownGoal, killerTeam: ownGoal ? killerTeam : null });
  }

  /**
   * 收場。
   * reason 只有一個來源：哪一種終局條件先成立。結算畫面與訓練端的 report
   * 都讀這份，才不會出現「網頁說時間到、履歷說打到上限」兩套說法。
   * extra.ownGoal：老鷹是被自己人打爆的（見 onDemoBaseHit）。
   */
  finishDemo(winner, reason = 'time', extra = null) {
    if (this.state !== STATE.DEMO) return;
    this.demoWinner = winner;
    this.demoResult = {
      reason,
      winner: winner ? winner.id : null,
      text: DEMO_END_TEXT[reason] || DEMO_END_TEXT.time,
      ownGoal: false,
      killerTeam: null,
    };
    if (extra && extra.ownGoal) {
      this.demoResult.ownGoal = true;
      this.demoResult.killerTeam = extra.killerTeam;
      this.demoResult.text = DEMO_OWN_GOAL_TEXT[reason] || this.demoResult.text;
    }
    this.state = STATE.DEMO_RESULT;
    this.stateTimer = DEMO_RESULT_FRAMES;
    Audio.play(winner && winner.id === DEMO_ATTACK_TEAM ? 'stageClear' : 'gameOver');
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
          if (foe.alive) { this.creditKill(tank, foe); team.bombKills++; }
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
    Renderer.setDemo(this.demoMode);
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
          { text: '藍隊進攻  紅隊防守', size: 9, color: '#888', gap: 12 },
          { text: `${DEMO_ATTACK_SECONDS} 秒未破局 紅隊勝`, size: 9, color: '#888', gap: 16 },
          { text: 'ENTER 返回', size: 8, color: '#666' },
        ], { dim: 0.85 });
        break;
      case STATE.DEMO_RESULT: {
        const [b0, b1] = this.teams;
        const w = this.demoWinner;
        const res = this.demoResult || {};
        // 直立場只有 144 邏輯 px 寬（旧版 208），一句「30 秒內摧毀紅隊老鷹 —— 
        // 藍隊進攻成功」在 9px 下會溢出，而覆蓋層不會自動換行。
        // 結算句都帶「——」這個天然斷點，所以拆兩行；其餘呼叫端的句子照原樣。
        const why = String(res.text || '');
        const whyLines = why.includes('——')
          ? why.split('——').map(s => s.trim()).filter(Boolean).map((s, i) =>
              ({ text: s, size: 9, color: '#fff', gap: i === 0 ? 6 : 18 }))
          : [{ text: why, size: 9, color: '#fff', gap: 18 }];
        Renderer.overlay([
          { text: w ? `${w.label}隊勝（${w.roleLabel}）` : '平手', size: 18, bold: true,
            color: w && w.id === TEAM.BLUE ? '#f8d840' : '#f85858', gap: 20 },
          ...whyLines,
          { text: `藍（進攻） ${b0.score}  (${b0.kills} 擊殺)`, size: 9, color: '#f8d840', gap: 14 },
          { text: `紅（防守） ${b1.score}  (${b1.kills} 擊殺)`, size: 9, color: '#c8a84b', gap: 20 },
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

  /** 一logical 幀的輸入推進（抽出來讓無頭引擎能精確重現同一順序） */
  inputUpdate() { Input.update(); }

  /** 一 logical 幀的特效推進 */
  stepFx() { Renderer.tickFx(); }

  startLoop() {
    let last = performance.now();
    let acc = 0;
    const loop = (now) => {
      let elapsed = now - last;
      last = now;
      if (elapsed > 200) elapsed = 200;
      // speed（滑鼠面板的 1×/2×/4×）：把「現實時間」放大後餵進同一個 60fps
      // 固定 timestep，所以邏輯上一幀都沒跳、也沒變快 —— 變的只是每幅畫面跑幾幀。
      // 這比改 FRAME_MS 安全：改 FRAME_MS 會讓輸入、滑行、無敵計時全跟著變形。
      const sp = this.speed || 1;
      acc += elapsed * sp;
      // 上限：速度 × 每幅畫面的預算幀。真的來不及（背景頁、機器慢）就丟幀，
      // 不讓 while 越跑越長把整個頁面鎖死 —— 觀戰是給人看著等的，不能反客為主。
      let budget = 12 * sp;
      while (acc >= FRAME_MS && budget-- > 0) {
        this.inputUpdate();
        this.update();
        this.stepFx();
        acc -= FRAME_MS;
      }
      if (acc > FRAME_MS) acc = 0;
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
