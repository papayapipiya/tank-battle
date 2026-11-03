/* ═══════════════════════════════════════════
   ai.js — 坦克 AI：巡邏 / 追擊 / 衝敵基地 / 回防攔截

   單人模式與觀戰模式共用這套 AI，差異由 game 提供的
   foesOf / foeBaseOf / ownBaseOf / frozenFor 決定：
     - 單人：敵人只有一個玩家目標、且沒有「自家基地」→ 不會回防
     - 觀戰：兩隊互為敵人，各自有基地 → 會回防
   ═══════════════════════════════════════════ */

// 連續卡住幾幀之後把「回頭路」也納入候選：兩台車在死角互相頂住時，
// 只排除反方向會讓它們永遠鎖死在同一格（觀戰模式實測 maxStay 3000+ 幀）
const AI_BACK_AFTER = 8;

// ── v7：近身格鬥（使用者規則：兩台坦克太接近時，先解決對方坦克）──
// 「太接近」用中心距 40px（5 格）判定：這個距離上兩車之間只剩不到一個車長，
// 子彈 4～8px/幀，一兩幀就撞上 —— 誰先開火誰吃掉對方。
// 為什麼不設成 16px（剛好貼住）：貼住時兩台車已經互相擋路，
// 那時才改目標就晚了，正是要避免的「頂著敵人原地轉圈」。
// 為什麼不設更大：全場才 208px，半徑一大「格鬥」就變成常態，
// 進攻方的拆鷹、防守方的回防會被無限期推遲 —— 那又走向另一個極端。
const AI_DUEL_RADIUS = 40;
const AI_DUEL_SHOOT = 0.9;      // 同軸且貼身：這一槍幾乎必中，不需要原本的擲骰節奏
const AI_DUEL_REPICK = 8;       // 貼身時「想去哪」每 8 幀跟一次最新敵位（平常是 40～100 幀）

/* ── 批次二（G）：規則 AI 要認角色 ─────────────────────────────
   原本 `_goal` 對兩隊是同一支碼（貼身 → 回防 → 40% 追敵 → 30% 打老鷹 → 巡邏），
   於是「誰是進攻方」這件事只寫在規則與計分裡，行為層完全沒反應：
     · 紅隊（防守）一路追到藍隊門口（探針實測 foeHalfShare 兩隊差不到 3 個百分點），
       自家老鷹後面是空的 —— 防守分靠的是「打掉來犯者」，但來犯者是被它自己趕走的；
     · 更要緊的是規則 AI 同時是兩族共同的新手政策（網路 abstain 時由它代步、
       ai/teacher.js 的模仿種子也錄它），所以這個「中性駕駛」會被一路灌進起步期。
   單人模式的敵人 role=null，走原本那套擲骰，行為不受角色規則影響。 */

/* ── 批次五（J）：攻擊目標 ＝ 先打敵車，貼到對方門口才改瞄主堡 ──────
   使用者的規則原文：「坦克攻擊目標修正 1. 對方坦克 2. 當接近對方主堡」。
   ⚠ 這一條講的是**瞄誰**，不是**跑去哪**。初版我把「先打敵車」同時實成了位移的
   預設目標（追全場最近那台），量出來的結果是壞的，所以位移那一半已經退回：
     · 開槍選靶（`_shotTarget`）：同軸前方有活敵車 → 打車；同軸只有主堡、而且
       自己已貼到對方老鷹門口（≤56px）→ 才打堡。這是使用者那兩句的出處。
     · 位移目標（`_goal`）：進攻席永遠壓向對方主堡。追人的只有兩種例外 ——
       貼身 ≤40px（`AI_DUEL_RADIUS`，使用者另一條「太接近先解決對方」）與
       敵車已進自家牆腳 ≤56px（回防，兩席共用的第一優先）。
   證據（`node audit-hunt.js 240`，同一批地圖與種子，破局率標準誤 ±3.2%）：
       追車範圍          破局率   hunt 幀占比   進攻均分   防守均分
       無限追（初版）      18.3%     71.9%       40.32     78.79
       只排背後那台        18.3%     68.9%       42.19     81.37
       過中線 或 ≤168px    20.4%     37.1%       44.05     76.00
       完全不追＝壓鷹      31.7%      0.0%       61.50     67.90
   「縮小追車範圍」只救回 2 個百分點（在誤差內）；把位移交還給主堡才救回 13 個百分點，
   同一支 120 局的尺讀到 29.2%（批次四是 33.3%，差在 v11 的選靶仍會為打車停在門口外）——`node measure-breach.js 120`。附帶的好處是兩席分數差從
   1.95 倍縮到 1.10 倍 —— 這正是 BALANCE-RESEARCH 那條主軸要的。
   為什麼追人會賠上破局率：hunt 的目標點每 8～100 幀換一台車，車又在動，於是藍車
   的路徑是一條追尾巴的曲線，很少真的在門口停下來開槍；拆牆格數 1.80 vs 2.61、
   擊殺 6.5 vs 5.9 —— 多殺 0.6 台賠上 13 個百分點的本業，這就是「用射擊的邏輯去開車」。
   門檻沿用 DEMO_THREAT_RADIUS（56px）而不是另設一個數：防守端「敵車進到自家牆腳
   56px 一律回防」、arena 的家門口計量（BASE_DEFENSE_RADIUS）、v11 的近／遠拆牆
   都是這一個圈，三處同一把尺，兩席的「門口」才對稱，探針印出來的數也才可直接互比。
   ⚠ 批次二那兩個常數（AI_BLOCK_REACH／AI_ATTACK_CLEAR_SHARE）與 `_blocker`
   一起刪除了，不是留著當「另一條偶爾生效的規則」：碼裡同時存在「壓老鷹」跟
   「先打車」兩條預設，誰也壓不住誰，調參時根本分不清動的是哪一條。 */
const AI_ASSAULT_RADIUS = DEMO_THREAT_RADIUS;   // 56px：離對方主堡這麼近才算「已經到家門口」

/* ── 批次四（I）：開火節拍要跟著「家裡有沒有事」─────────────────
   ladder 實測（`node ai/balance.js --mode ladder --terms`）把防守席翻出來：
   純規則 AI 一局只開 16.2 槍、擊殺 6.63、讓藍隊在自家半場待 815.5 幀；
   同一席換成隨機按鍵是開火 198.7 槍、擊殺 11.8、藍隊只剩 366.1 幀，連 winRate
   都從 75% 升到 88%。所以「愈隨機愈高分」不是尺歪了，是**老師真的打得比隨機差**，
   ladder 只是把這件事印出來而已。
   根因是舊代碼每幀只問兩件事：「現在這個朝向有沒有同軸目標」（有才 0.55）、
   「25～75 幀冷卻到了沒」。防守席站在防線上，朝向是位移的結果（原地轉是違法的，
   見上面那條註解），同軸的時機本來就少，再被平均 50 幀的冷卻一稀釋，
   一局就剩十幾槍 —— 那門炮基本是裝飾。
   修法只動節拍與「不同軸時值不值得開槍」，不動轉向規則：
   敵車進到自家屏蔽半徑（=正在打我家）時，用格鬥級的節奏試槍，
   沒同軸時也留一點壓制機率（封走廊、逼對方讓路）。
   ⚠ 沒有把同軸的 0.55 拉到 1：打不打得中是幾何與反應的問題，那正是 `accuracy`
   項在量的東西；改成必中等於把計分項的訊號自己抹掉。 */
const AI_SCREEN_SHOOT_GAP = 10;     // 敵車已到自家門口屏蔽圈：10～20 幀試一槍
const AI_SCREEN_SHOOT_JITTER = 10;
const AI_SCREEN_BLIND = 0.15;       // 這種情況下即使不同軸也值得一開槍（壓制、封走廊）
const AI_HOME_SHOOT_GAP = 16;       // 敵車已進到自家半場：16～30 幀試一槍
const AI_HOME_SHOOT_JITTER = 14;
const AI_HOME_BLIND = 0.08;
const AI_LINE_SHOOT = 0.8;          // 同軸、非格鬥：機會難得的走廊槍從 0.55 拉到 0.8


const EnemyAI = {

  /** 每幀驅動一台 AI 坦克 */
  update(tank, game) {
    if (!tank.alive || tank.spawnTimer > 0 || game.frozenFor(tank)) return;

    tank.aiDirTimer--;
    tank.aiShootTimer--;

    // v7 第一優先：有敵車貼身 → 本幀的目標就是「先解決它」。
    // duel 只算一次（下面換向和射擊都要用），也回傳那台敵車給 _goal 直接用。
    const duel = this._nearestFoe(tank, game);
    // 警戒等級（批次四 I）：決定開火節拍與「要不要先把車擺進走廊」。
    const alert = this._alertLevel(tank, game, duel);

    // 定期換方向：只登記「想去哪」，不直接改 tank.dir。
    // 朝向是位移的結果，不是下一個念頭 —— moveAsAI 走不到就會把轉向撤回，
    // 所以這裡直接改 dir 會重現原地翻面（規則 AI 也不例外）。
    if (tank.aiWanted === null || tank.aiDirTimer <= 0) {
      // 貼身格鬥時敵車一直在動，40～100 幀才更新一次「想去哪」等於在半場之外追尾巴。
      tank.aiDirTimer = duel ? AI_DUEL_REPICK : 40 + Math.floor(Math.random() * 60);
      tank.aiWanted = this._pickDirection(tank, game, false, false, duel);
    }

    const moved = tank.moveAsAI(tank.aiWanted, game.map, game.allTanks());

    // 卡住 → 立刻重挑（不選回頭路以外的死路）
    if (!moved) {
      // 「卡住」要計連續幀數，不能只換一次方向：
      // 兩台車在死角互相頂住時，四個方向全被擋（地形或隊友），
      // 原本的規則「不選回頭路」會把它們永遠鎖死在這裡 ——
      // 實測觀戰模式有 26/54 台車整局沒離開過所在格（maxStay 3000+ 幀），
      // 使用者看到的「坦克都卡在某個地方」就是這個死鎖，不是 AI 笨。
      tank.aiStuck = (tank.aiStuck || 0) + 1;
      tank.aiWanted = this._pickDirection(tank, game, true, tank.aiStuck >= AI_BACK_AFTER, duel);
      tank.aiDirTimer = 25 + Math.floor(Math.random() * 35);
    } else tank.aiStuck = 0;

    // 射擊：與目標同軸時積極開火，否則偶發；節拍跟著警戒等級走（批次四 I）。
    if (tank.aiShootTimer <= 0) {
      // 等級只決定「多久試一槍／不同軸時開不開槍」；瞄誰由 `_shotTarget` 判（批次五 J）。
      tank.aiShootTimer = alert === 'duel' ? 8 + Math.floor(Math.random() * 8)
        : alert === 'screen' ? AI_SCREEN_SHOOT_GAP + Math.floor(Math.random() * AI_SCREEN_SHOOT_JITTER)
          : alert === 'home' ? AI_HOME_SHOOT_GAP + Math.floor(Math.random() * AI_HOME_SHOOT_JITTER)
            : 25 + Math.floor(Math.random() * 50);
      // 會打到自己家老鷹的那一槍收手：坦克常常停在 eagle 正上方，
      // 原本的偶發射擊把自家圍牆連老鷹一起啃掉（監測的 own_base_damage 紅旗）。
      const safe = !this._ownBaseInFront(tank, game);
      // 選靶（批次五，使用者規則「先打對方坦克、接近對方主堡才打主堡」）：
      // 同軸有敵車 → 打車；只有對方主堡、而且自己已貼到門口 56px → 拆鷹；
      // 兩樣都沒有 → 落回「不同軸」那條壓制槍的擲骰。
      const shotAt = this._shotTarget(tank, game);
      const odds = shotAt
        ? (alert === 'duel' ? AI_DUEL_SHOOT : AI_LINE_SHOOT)
        : alert === 'screen' ? AI_SCREEN_BLIND
          : alert === 'home' ? AI_HOME_BLIND : 0.04;
      if (safe && Math.random() < odds) {
        const b = tank.shoot(game.bullets);
        if (b) game.bullets.push(b);
      }
    }
  },

  /**
   * 開火節拍用的警戒等級：'duel' ＞ 'screen' ＞ 'home' ＞ 'idle'。
   *   duel   ＝ 有敵車貼身（v7 那條規則，用呼叫端算好的 duel）
   *   screen ＝ 有敵車進到自家老鷹的屏蔽半徑（DEMO_SCREEN_RADIUS）內
   *   home   ＝ 有敵車踏進自家這半場（走廊還在它手上，先壓制再說）
   * 單人模式沒有自己要塞（`map.bases[tank.team]` 不存在）→ 恆回 'idle'，
   * 敵人維持原本那套擲骰，行為不受這一版影響。
   */
  _alertLevel(tank, game, duel) {
    if (duel) return 'duel';
    const ownBase = game.ownBaseOf(tank);
    if (!ownBase) return 'idle';
    if (this._nearestIn(game.foesOf(tank), ownBase, DEMO_SCREEN_RADIUS)) return 'screen';
    return this._foeInOwnHalf(tank, game, ownBase) ? 'home' : 'idle';
  },

  /** 敵隊有沒有車在「自己這一側」的半場？半邊由自家老鷹在哪一端決定，不是寫死上下。 */
  _foeInOwnHalf(tank, game, ownBase) {
    const ownIsTop = ownBase.y < FIELD_H / 2;
    for (const f of game.foesOf(tank)) {
      if (!f.alive || f.spawnTimer > 0) continue;
      const c = f.center();
      if (ownIsTop ? c.y < FIELD_H / 2 : c.y > FIELD_H / 2) return true;
    }
    return false;
  },

  /* 「用移動把自己擺進敵車那條走廊」（_laneDir＋_shotLaneOpen）嘗試過、量過之後刪了。
     想法很直覺：防守席同軸的時機太少，那就主動去對齊。實測反而更差 ——
     同一組考題（地圖 0..7 × 3 種子 × 8 個 p）防守席 p=0 的均分
     從 66.98 掉到 63.02，反轉幅度從 −8.18 變成 −10.92（負的越多＝愈像隨機愈高分，越糟）。
     原因是它把車從防線上拉走：為了對齊一條走廊，防守車會離開擋位去頂牆，
     blockedFrames 換來的不是射擊線而是堵住隊友 —— 同一套「在場占比」的教訓（#71）：
     任何「讓車去對齊幾何」的規則，都要先看它會不會把車從它本來該站的位置帶走。 */

  /**
   * 離本車最近、且在「貼身」半徑內的敵車（中心距，見 AI_DUEL_RADIUS）。
   * 沒有 → null（這時才輪到推進／回防那些長遠目標）。
   * 出生無敵的車不算：對它開槍是白費，把它當目標還會讓兩台車互相頂著轉圈。
   */
  _nearestFoe(tank, game) {
    const c = tank.center();
    let best = null, bd = AI_DUEL_RADIUS;
    for (const f of game.foesOf(tank)) {
      if (!f.alive || f.spawnTimer > 0) continue;
      const d = f.distTo(c.x, c.y);
      if (d < bd) { bd = d; best = f; }
    }
    return best;
  },

  /**
   * 子彈沿目前朝向飛出去，會不會傷到自己家的要塞（老鷹 + 要塞牆）？
   * 規則 AI 與網路端（ai/controller.js 的 ownBaseInFront）用同一套幾何判斷：
   * 只有磚／鋼（和出界）會擋子彈，水跟樹林不擋；
   * 擋下來的若是自家要塞牆 → 這一槍不準開，是一般牆 → 放行。
   * 單人模式敵人沒有 own base（map.bases[RED] 不存在）→ 恆回 false，行為不變。
   */
  _ownBaseInFront(tank, game) {
    const map = game.map;
    const own = map.bases[tank.team];
    if (!own) return false;
    const v = DIR_VEC[tank.dir];
    const c = tank.center();
    let x = c.x + v.dx * 10, y = c.y + v.dy * 10;
    for (let k = 0; k <= MAX_SCAN_CELLS; k++) {
      const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
      if (cx < 0 || cx >= GRID_W || cy < 0 || cy >= GRID_H) return false;
      const b = map.baseAtCell(cx, cy);
      if (b) return b === own;                       // 先撞到敵家老鷹 → 這槍有意義
      const t = map.cellAt(cx, cy);
      if (t === CELL_TYPE.BRICK || t === CELL_TYPE.STEEL)
        return map.isFortressWall(own, cx, cy);      // 是要塞牆就收手，一般牆放行
      x += v.dx * CELL; y += v.dy * CELL;
    }
    return false;
  },

  /**
   * 選目標點（v7 的優先順序 ＋ 批次二 G 的角色分工 ＋ 批次五 J 的選靶）：
   *   0) 有敵車貼身 → 先解決那台（使用者規則，壓過下面全部）
   *   1) 敵車已進到自家老鷹的牆腳（DEMO_THREAT_RADIUS 內）→ 一律回防（兩席都要）
   *   2) 防守席（紅）：敵車進入屏蔽半徑（DEMO_SCREEN_RADIUS ≈ 場高 1/3）→ 出去攔
   *   3) 防守席：沒威脅 → 站在自家門前的防線上，絕不一路追到對方門口
   *   4) 進攻席（藍）：位移**只認對方主堡**（assault）。
   *      「先打敵車」這句話落在射擊層（`_shotTarget`：同軸有活敵車就打車，
   *      貼到門口才打堡），不在位移層 —— 上面那段批次五的註解有 240 局的數。
   *   5) 單人模式（role=null，沒有自己要塞）→ 維持原本的 40% 追／30% 打／巡邏
   */
  _goal(tank, game, duelFoe) {
    const foes = game.foesOf(tank);
    const ownBase = game.ownBaseOf(tank);
    const foeBase = game.foeBaseOf(tank);
    const role = demoRoleOf(tank.team);

    // 0) 近身格鬥：目標改成那台敵車本身。呼叫端已經算過 duel（每幀只算一次），
    //    沒帶進來時自己補算 —— 卡住重挑那一條路是帶著 stuck=true 進來的。
    const foe = duelFoe !== undefined ? duelFoe : this._nearestFoe(tank, game);
    if (foe) return { x: foe.x, y: foe.y, duel: true };

    // 1) 老鷹被拆掉就立刻輸，所以「已經在牆腳的敵車」不分席位都先處理。
    //    這一環比防線近得多（56 vs 112），留著它是為了讓進攻席不會為了拆鷹
    //    把自己家放空 —— 使用者要的「打擊敵車也算防守」在這裡也要成立。
    const gate = ownBase && this._nearestIn(foes, ownBase, DEMO_THREAT_RADIUS);
    if (gate) return { x: gate.x, y: gate.y, defend: true };

    // 2)／3) 防守席：攔截到屏蔽半徑，其餘時間站在防線上（不是在自己門口轉圈）
    if (role === DEMO_ROLES.DEFENSE) {
      if (ownBase) {
        const threat = this._nearestIn(foes, ownBase, DEMO_SCREEN_RADIUS);
        if (threat) return { x: threat.x, y: threat.y, defend: true };
        const line = this._holdLine(ownBase);
        const dy = line - tank.y;
        // 保持各自的橫座標：四台車都朝老鷹那格擠的話，會互相頂死在牆邊
        //（這是 _dirOpen 會擋車的直接後果），一條橫向散開的防線才攔得到人。
        if (Math.abs(dy) >= CELL) return { x: tank.x, y: line, hold: true };
        return undefined;        // 已在防線上 → 順勢巡邏，不要原地不動
      }
    }

    // 4) 進攻席（批次五，收斂後）：位移只認對方主堡。
    //    「先打敵車」是**射擊**的優先序（`_shotTarget`：同軸有活敵車就打車），
    //    不是**位移**的任務 —— 把追車塞進目標點之後，240 局實測破局率
    //    33.3% → 18.3%（縮小追車範圍也只回到 20.4%），多殺 0.6 台車賠掉本業。
    //    追人只留兩個例外，而且都在這行之前就已經攔掉了：
    //      · 貼身 ≤40px（上面第 0 條，使用者的「太接近先解決對方」）
    //      · 敵車已進自家牆腳 ≤56px（上面第 1 條回防）
    if (role === DEMO_ROLES.ATTACK && foeBase) {
      return { x: foeBase.x, y: foeBase.y, assault: true };
    }

    // 5) 中性（單人模式的敵人、或還沒有要塞的臨時局面）：維持舊的擲骰行為
    const roll = Math.random();
    if (roll < 0.4 && foes.length) {
      let near = foes[0];
      for (const f of foes) if (f.distTo(tank.x, tank.y) < near.distTo(tank.x, tank.y)) near = f;
      return { x: near.x, y: near.y };
    }
    if (roll < 0.7 && foeBase) return { x: foeBase.x, y: foeBase.y };
    return undefined;
  },

  /** 敵隊裡離某個點最近、且在半徑內的活車（出生無敵中的不算）→ 沒有就 null */
  _nearestIn(foes, point, radius) {
    let best = null, bd = radius;
    for (const f of foes) {
      if (!f.alive || f.spawnTimer > 0) continue;
      const d = f.distTo(point.x, point.y);
      if (d < bd) { bd = d; best = f; }
    }
    return best;
  },

  /**
   * 防線 y 座標：從自家老鷹往「中場那一側」推 DEMO_HOLD_LINE，並夾在場內。
   * 老鷹在上面（紅）→ 防線在它下方；在下面（藍）→ 在它上方。
   * 用老鷹位置判斷方向，不是用 team：單人模式哪天換邊也不會錯。
   */
  _holdLine(ownBase) {
    const down = ownBase.y < FIELD_H / 2;
    return Math.max(TANK_PX, Math.min(FIELD_H - TANK_PX,
      ownBase.y + (down ? DEMO_HOLD_LINE : -DEMO_HOLD_LINE)));
  },

  /** 離對方主堡 ≤AI_ASSAULT_RADIUS（56px）？——「已經到家門口」的唯一判準 */
  _foeBaseClose(tank, foeBase) {
    return this.baseWithin(tank.center(), foeBase, AI_ASSAULT_RADIUS);
  },

  /**
   * 某個點到主堡的距離是否在門檻內（純幾何，不带 tank 物件）。
   * ⚠ 這一版刻意對外開放：訓練端的逐槍拆牆計量（ai/arena.js 的 foeWallNear／
   *   foeWallFar）要用「開火點」問同一件事。如果 arena 自己抄一份 sqrt，
   *   改這裡的半徑就不會反映到計分 —— 那正是批次五要避免的「兩把尺」。
   */
  baseWithin(c, point, radius) {
    if (!c || !point) return false;
    const dx = c.x - point.x, dy = c.y - point.y;
    return dx * dx + dy * dy <= radius * radius;
  },

  /**
   * 這一槍瞄的是誰（批次五）：
   *   'tank' ＝ 目前朝向上有敵車（同軸、在前方）→ 打車，壓過打牆
   *   'base' ＝ 朝向上沒有敵車、只有對方主堡，而且自己已貼到門口 ≤56px
   *   null   ＝ 兩樣都沒有 → 交給「不同軸」那條壓制射擊的擲骰
   * 只問對齊、不問遮擋：中間有磚擋住時這一槍頂多是浪費，
   * 不是違規（違規那條是 `_ownBaseInFront`，管的是打到自家要塞）。
   */
  _shotTarget(tank, game) {
    const c = tank.center();
    for (const f of game.foesOf(tank)) {
      if (!f.alive || f.spawnTimer > 0) continue;
      if (this._inFront(c, tank.dir, f.center())) return 'tank';
    }
    const foeBase = game.foeBaseOf(tank);
    if (foeBase && this._inFront(c, tank.dir, foeBase) && this._foeBaseClose(tank, foeBase)) return 'base';
    return null;
  },

  /** 點 t 在本車目前朝向上、且同軸（同一條橫／直走廊的前方）？ */
  _inFront(c, dir, t) {
    const sameCol = Math.abs(t.x - c.x) < CELL &&
      ((dir === DIR.UP && t.y < c.y) || (dir === DIR.DOWN && t.y > c.y));
    const sameRow = Math.abs(t.y - c.y) < CELL &&
      ((dir === DIR.LEFT && t.x < c.x) || (dir === DIR.RIGHT && t.x > c.x));
    return sameCol || sameRow;
  },

  /**
   * 依目標點選方向；主方向被擋就換垂直方向。
   * @param allowBack 卡到快死鎖了：把「回頭路」也放進候選，
   *                  否則兩台車在死角互相頂住就永遠分不開。
   * @param duelFoe   本幀已算出的貼身敵車（update 每幀算一次，這裡不重算）。
   */
  _pickDirection(tank, game, stuck, allowBack, duelFoe) {
    const goal = stuck ? undefined : this._goal(tank, game, duelFoe);
    const tanks = game.allTanks();

    if (goal) {
      const want = this._toward(tank.x, tank.y, goal.x, goal.y);
      if (this._dirOpen(tank, want, game.map, tanks)) return want;
      const alt = this._perpendicular(tank, want, goal);
      if (this._dirOpen(tank, alt, game.map, tanks)) return alt;
    }

    // 隨機：排除反方向，優先可走的
    const opposite = (tank.dir + 2) % 4;
    const options = [DIR.UP, DIR.RIGHT, DIR.DOWN, DIR.LEFT]
      .filter(d => (allowBack || d !== opposite) && this._dirOpen(tank, d, game.map, tanks));
    // 四面都走不通 → 維持目前朝向，不要回傳 opposite。
    // 回傳 opposite 只是把車轉 180°，tryMove 仍會失敗；下一幀又轉回去，
    // 就變成「原地每幀翻面」的鬼畜旋轉（實測死角可連轉 9～11 幀）。
    // 車真的被圍死時，正確的行為是穩穩停著，等旁邊讓開再走。
    if (options.length === 0) return tank.dir;
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

  /**
   * 這個方向「下一步走不走得通」。
   * ⚠ 除了地形，還要看別台車：tryMove 會因為撞車而原地不動，
   *   但只看地形的話 AI 會一直挑同一條被隊友堵死的路，
   *   雨刷式地互相頂死（ai/observation.js 的 front 段也是同一個判準）。
   */
  _dirOpen(tank, dir, map, tanks) {
    const v = DIR_VEC[dir];
    const nx = tank.x + v.dx * CELL;
    const ny = tank.y + v.dy * CELL;
    if (map.tankBlocked(nx, ny)) return false;
    if (tanks) {
      const box = { x: nx, y: ny, w: TANK_PX, h: TANK_PX };
      for (const t of tanks) {
        if (t !== tank && t.alive && boxesOverlap(box, t.box)) return false;
      }
    }
    return true;
  },

  /**
   * ⚠ 批次五（J）刪掉了舊的 `_linedUp`：它的活兒（「這一槍有沒有值得瞄的東西」）
   * 已經完全由 `_shotTarget` 回答，而且答案不再相同 —— 以前「離對方老鷹 300px
   * 但正對準它」也算對齊，現在那條不算（使用者要的順序是先打車，貼到門口才拆鷹）。
   * 留一個同名、不同意的殼子只會讓測試綠著、規則早就換了；測試直接問 `_shotTarget`。
   */

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
