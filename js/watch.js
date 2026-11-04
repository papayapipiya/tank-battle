/* ═══════════════════════════════════════════
   watch.js — 瀏覽器觀戰：藍＝進攻模型、紅＝防守模型
   ═══════════════════════════════════════════
   兩個角色、兩份基因組、各自訓練、各自被熱跟隨：

     藍隊（進攻）＝ ai/trained-attack.js   （只有打穿紅隊老鷹才算贏）
     紅隊（防守）＝ ai/trained-defense.js  （撐過 30 秒或打掉藍隊老鷹即勝）

   啟動方式（file:// 開啟時查詢參數常被剝掉，所以每條路都留）：

     自動：  ai/auto-train.js 會寫出 ai/auto-watch.js 旗標 →
             這裡讀到就直接開場，不必按鍵（這是「不要手動處理」的那條路）
     按鍵：  在 TITLE 畫面按 Y ＝ 雙模型對打（藍進攻模型 vs 紅防守模型）
                    按 U ＝ 同一份基因組自我對弈（拿進攻模型佔兩席，純粹好看）
     網址：  index.html?watch=1&stage=7   或   index.html#watch=rule&stage=7
             watch=rule 時紅隊改由規則 AI 開車（只想看進攻模型的推進路線用這個）

   自動跟隨：開戰後每個角色各自每 12 秒重讀自己的快照檔。
   訓練端（--export-every 1）每代刷新對應那份，所以頁面不重新整理也會
   從「第 N 代」走到「第 N+1 代」；某個角色的冠軍真的換人時，
   只有那一隊的 policy 換成新網路，另一隊完全不受影響。

   ai/*.js 原本是 Node 訓練端的碼，但每個檔都留了 window 出口，
   所以網頁上算的觀測向量、動作空間、網路前推，跟跑
   `node ai/evolve.js` 時是同一份實作 —— 看到的等於學到的，
   不會因為「訓練用一套、執行用另一套」而悄悄變樣。
   ═══════════════════════════════════════════ */
(function () {
  const parse = str => {
    const o = {};
    (str || '').replace(/^[?#&]/, '').split('&').forEach(kv => {
      const i = kv.indexOf('=');
      if (i > 0) o[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
    });
    return o;
  };
  const q = Object.assign({}, parse(location.search), parse(location.hash));
  let stage = Number(q.stage || 0);
  const POLL_MS = 12000;

  /* ── 兩個角色的身分：席位、檔案名、全域變數名 ──────────────
     席位（seat）就是 game.tanks[].team：0=藍、1=紅。
     角色不是「選項」而是規則：js/constants.js 裡藍隊永遠進攻、紅隊永遠防守，
     所以觀戰端不能把防守模型塞進藍席 —— 那會用錯尺，看起來像練壞了。 */
  const ROLES = {
    attack: {
      seat: 0, label: '進攻', color: '藍',
      file: q.genome || 'ai/trained-attack.js',
      global: 'TRAINED_GENOME_ATTACK',
      win: '只有打穿紅隊老鷹才算贏',
    },
    defense: {
      seat: 1, label: '防守', color: '紅',
      file: 'ai/trained-defense.js',
      global: 'TRAINED_GENOME_DEFENSE',
      win: '撐過 30 秒或打掉藍隊老鷹就贏',
    },
  };

  // 執行期才會產生的檔案，可能還不存在：缺少時要能繼續跑
  // （自動訓練第一次匯出前就是這個狀態），不能當場失敗。
  const FILES = [
    { src: 'ai/actions.js' },
    { src: 'ai/observation.js' },
    { src: 'ai/controller.js' },
    { src: 'ai/neat.js' },
  ];

  let assetsStarted = false;
  const assetReady = [];

  let started = false;          // 已經進觀戰（start 執行過）
  let mode = 'dual';            // dual | both | rule | attack | defense
  const snap = { attack: null, defense: null };   // 各角色目前套用到場上的快照
  const swapCount = { attack: 0, defense: 0 };
  let pendingAuto = null;       // 有自動旗標、但還在等第一次匯出
  let autoBooted = false;
  const timers = {};
  const pollSeq = { attack: 0, defense: 0 };
  let badSnapWarned = false;
  let badgeTimer = null;        // 面板刷新計時器（重新 start 時要先清掉舊的）
  let roundsShown = 0;          // 這一頁累計看過幾輪（renderBadge 每幀刷新時更新）

  function badge(msg, cls, title) {
    const el = document.getElementById('aiDisplay');
    if (!el) return;
    el.className = 'panel-ai' + (cls ? ' ' + cls : '');
    el.textContent = msg;
    el.title = title || '';
  }

  function fail(msg) {
    console.warn('[watch] ' + msg);
    document.title = '⚠ ' + msg;
    badge(msg, 'bad');
  }

  /* ── 載入 AI 腳本：同一份只載一次，按鍵／自動／網址三條路共用 ── */
  function loadAssets(done) {
    if (window.AIObservation && window.AINeat) return done();
    if (done) assetReady.push(done);
    if (assetsStarted) return;
    assetsStarted = true;
    loadAll(0, () => {
      while (assetReady.length) assetReady.shift()();
    });
  }

  function loadAll(i, done) {
    if (i >= FILES.length) return done();
    const f = FILES[i];
    const s = document.createElement('script');
    s.src = f.src;
    s.onload = () => loadAll(i + 1, done);
    s.onerror = () => fail(`載入 ${f.src} 失敗 — AI 那幾支碼還在不在？`);
    document.head.appendChild(s);
  }

  /* ── 快照：先讀角色自己的別名，才退回舊的單一全域 ─────────── */
  function readSnapshot(key) {
    const role = ROLES[key];
    const aliased = window[role.global];
    if (aliased && aliased.genome) return aliased;
    // 舊的匯出檔只設 window.TRAINED_GENOME（沒有角色別名），而它會被任何一份
    // 新檔覆寫，所以只能當「單一模型時代」的後備：給藍席（進攻），不給紅席。
    // 把沒有角色的舊冠軍塞進紅席更糟 —— 那是用錯尺，看起來像練壞了。
    const legacy = window.TRAINED_GENOME;
    if (key === 'attack' && legacy && legacy.genome && !legacy.role) return legacy;
    return null;
  }

  /** 這一局需要哪幾個角色的快照才動得起來（'both' 只要進攻那份，兩席共用） */
  function requiredRoles() {
    if (mode === 'defense') return ['defense'];
    if (mode === 'rule' || mode === 'attack' || mode === 'both') return ['attack'];
    return ['attack', 'defense'];        // dual：兩個模型各自上場
  }

  function readySnapshots() {
    return requiredRoles().every(k => snapshotCompatible(readSnapshot(k)));
  }

  /** 快照的觀測規格跟現行不符就不能上場（欄位改過必須重訓） */
  function snapshotCompatible(t) {
    const spec = window.AIObservation && window.AIObservation.OBS_SPEC;
    if (!spec || !t || !t.genome) return false;
    if (t.obsSpec && t.obsSpec.version !== spec.version) {
      if (!badSnapWarned) {
        badSnapWarned = true;
        console.warn(`[watch] 忽略不相容的快照（v${t.obsSpec.version}／現行 v${spec.version}）`);
      }
      return false;
    }
    if (t.obsSpec && t.obsSpec.dim && t.obsSpec.dim !== spec.dim) {
      console.warn(`[watch] 忽略欄位數不符的快照（${t.obsSpec.dim}／現行 ${spec.dim}）`);
      return false;
    }
    return true;
  }

  function makePolicy(t) {
    return window.AINeat.Genome.fromJSON(t.genome).toPolicy();
  }

  /** 這個角色在這一局該不該真的由網路開車 */
  function seatIsNetworked(key) {
    if (mode === 'both') return key === 'attack';      // 兩席同一份基因組，只認進攻那份
    if (mode === 'rule') return key === 'attack';      // 紅隊交回規則 AI
    if (mode === 'attack') return key === 'attack';
    if (mode === 'defense') return key === 'defense';
    return true;                                        // dual
  }

  /**
   * 把某個角色的新快照套到正在跑的這一場，只換那一隊的車。
   * PolicyController 保留觀測緩衝與計數，直接換 policy 函式，
   * 不會讓整台車的狀態歸零，也不需要重新開一局。
   */
  function applyToField(key, t) {
    const g = window.__game;
    const role = ROLES[key];
    if (!g || !g.demoMode || !g.teamControllerSpecs) return 0;
    const spec = { kind: 'policy', policy: makePolicy(t) };
    if (mode === 'both') g.teamControllerSpecs = { 0: spec, 1: spec };
    else g.teamControllerSpecs = Object.assign({}, g.teamControllerSpecs, { [role.seat]: spec });

    // 'both' 是同一份基因組佔兩席，所以兩隊都要換；其餘模式只換這個角色的那一隊。
    const teams = mode === 'both' ? [0, 1] : [role.seat];
    let n = 0;
    for (const tank of g.tanks) {
      if (!teams.includes(tank.team)) continue;
      const teamSpec = g.teamControllerSpecs[tank.team];
      if (!teamSpec) {
        if (tank.controller && tank.controller.kind === 'policy') tank.controller = null;
        continue;
      }
      if (tank.controller && tank.controller.kind === 'policy') {
        tank.controller.policy = teamSpec.policy;
        tank.controller.team = tank.team;
      } else {
        tank.controller = g.AI.makeController(teamSpec, tank.team);
      }
      n++;
    }
    swapCount[key]++;
    console.info(`[watch] ${role.color}隊${role.label}模型跟隨新冠軍：` +
      `第 ${t.championGeneration} 代，適應度 ${Number(t.fitness).toFixed(2)}（換了 ${n} 台車）`);
    return n;
  }

  /* ── 自動跟隨：每個角色各排各的 timer，各讀各的檔 ── */
  function schedulePoll(key, ms = POLL_MS) {
    if (timers[key]) clearTimeout(timers[key]);
    timers[key] = setTimeout(() => pollOnce(key), ms);
  }

  function pollOnce(key) {
    const file = ROLES[key].file;
    const s = document.createElement('script');
    s.src = file + '?t=' + Date.now() + '-' + (++pollSeq[key]);
    s.onload = () => {
      try {
        const t = readSnapshot(key);
        if (t && snapshotCompatible(t)) onSnapshot(key, t);
      } finally {
        s.remove();
        if (started && seatIsNetworked(key)) schedulePoll(key);
      }
    };
    s.onerror = () => {
      s.remove();
      if (started) renderBadge();       // 訓練端沒在寫檔：badge 照舊，下一輪再試
      if (started && seatIsNetworked(key)) schedulePoll(key);
    };
    document.head.appendChild(s);
  }

  function onSnapshot(key, t) {
    // 開場前（自動模式等第一次匯出）：兩份湊齊了才開場，
    // 否則一開場就有一隊是規則 AI，跟「各自有各自的訓練模型」不是同一件事。
    if (!started && pendingAuto) {
      snap[key] = t;
      maybeAutoStart();
      return;
    }
    if (!started) { snap[key] = t; return; }

    const prev = snap[key];
    const championChanged = !prev ||
      t.championGeneration !== prev.championGeneration ||
      Number(t.fitness) !== Number(prev.fitness);
    snap[key] = t;
    if (championChanged && seatIsNetworked(key)) applyToField(key, t);
    renderBadge();
  }

  /** 快照上的代數／場數／匯出時間 —— 全部照檔案說，不推算 */
  function snapshotTitle(key) {
    const t = snap[key];
    const role = ROLES[key];
    if (!t) return `${role.color}隊 ${role.label}模型：還沒有快照（等訓練端匯出）`;
    const prov = t.provenance || {};
    const sess = Array.isArray(prov.sessions) ? prov.sessions : null;
    const sessLabel = sess && sess.length
      ? sess.map((s, i) => `${i + 1}. ${s.source === 'resume' ? '接續' : s.source === 'split' ? '由舊冠軍拆出' : s.source === 'seed-from' ? '暖啟動' : '冷開機'}` +
        `｜${s.generations} 代 ${s.episodes} 場` +
        `${s.startedAt ? `｜${s.startedAt.slice(0, 10)}` : ''}`).join('\n')
      : '（這份存檔沒記逐段）';
    return `${role.color}隊＝${role.label}模型（${role.win}）\n` +
      `冠軍第 ${t.championGeneration ?? '?'} 代｜基因組第 ${t.generation} 代\n` +
      `累計 ${Number(t.episodes || 0).toLocaleString('en-US')} 場｜算分 v${t.scoringVersion ?? '?'}\n` +
      `快照時間 ${t.exportedAt ? t.exportedAt.slice(0, 19).replace('T', ' ') : '未記錄'}\n` +
      `來源 ${(prov.sourceFile || role.file).replace(/\\/g, '/')}\n${sessLabel}\n` +
      `自動跟隨：每 ${POLL_MS / 1000} 秒重讀 ${role.file}` +
      (swapCount[key] ? `\n這一頁已跟隨換網路 ${swapCount[key]} 次` : '');
  }

  function modeText() {
    if (mode === 'rule') return '藍＝網路｜紅＝規則';
    if (mode === 'defense') return '藍＝規則｜紅＝網路';
    if (mode === 'both') return '兩席同一份基因組';
    return '藍進攻／紅防守';
  }

  /* ── 自動開場：旗標檔存在就自己進觀戰，不必按 Y/U ── */
  function autoConfig() {
    const c = window.TANK_AUTO_WATCH;
    return c && typeof c === 'object' ? c : null;
  }

  /** 把還缺的快照檔補進 DOM（每份都掛自己的角色別名，重複載入只是覆寫同一個） */
  function ensureSnapshotsLoaded(cb) {
    const missing = requiredRoles().filter(k => !readSnapshot(k));
    if (!missing.length) return cb();
    let i = 0;
    (function next() {
      if (i >= missing.length) return cb();
      const key = missing[i++];
      const s = document.createElement('script');
      s.src = ROLES[key].file;
      s.onload = next;
      // 還沒有這份匯出（自動訓練第一次匯出前就是這樣）：繼續往下走，
      // 由 maybeAutoStart 顯示「等待中」，不要當場失敗。
      s.onerror = next;
      document.head.appendChild(s);
    })();
  }

  function maybeAutoStart() {
    const cfg = pendingAuto;
    if (!cfg || autoBooted) return;
    const g = window.__game;
    if (!g) return setTimeout(maybeAutoStart, 200);
    if (g.state !== 'title') return;        // 使用者已經自己開局：不要搶畫面

    if (!readySnapshots()) {
      const waiting = requiredRoles().filter(k => !snapshotCompatible(readSnapshot(k)))
        .map(k => ROLES[k].file);
      badge('自動觀戰待命\n等待訓練端匯出…', 'idle',
        `還在等：${waiting.join('、')}\n` +
        '找到就自己開場（不需要按鍵）。\n' +
        '若一直停在這裡：確認 ai/auto-train.js 正在跑、runs/trainer.log 有在長。');
      requiredRoles().forEach(k => {
        if (!snapshotCompatible(readSnapshot(k)) && !timers[k]) schedulePoll(k, 3000);
      });
      return;
    }
    autoBooted = true;
    start(mode);
  }

  /** 把訓練好的基因組放進 game，並立刻開始觀戰 */
  function start(m) {
    const g = window.__game;
    if (started) return;
    if (!g) return setTimeout(() => start(m), 40);

    mode = m || 'dual';
    const spec = window.AIObservation.OBS_SPEC;

    // 缺快照的處理要按角色講清楚，不要靜默退化成規則 AI：
    // 「紅隊沒跑」跟單機版根本沒訓練過是兩件不同的事。
    const missing = requiredRoles().filter(k => !snapshotCompatible(readSnapshot(k)));
    if (missing.length) {
      return fail(`缺少${missing.map(k => ROLES[k].label).join('、')}模型的快照：` +
        `跑 node ai/auto-train.js（或 node ai/evolve.js --export runs/${missing[0]}-v6.json ` +
        `--to ai/trained-${missing[0]}.json）`);
    }

    started = true;
    pendingAuto = null;

    // 每一席的來源：'both' 把進攻模型同時放進兩席（同網對打純為好看），
    // 'rule'／'attack' 時紅席交回規則 AI，'defense' 時藍席交回規則 AI。
    // null 在這裡就是「這一隊由規則 AI 開車」，HUD 也會照實寫。
    const specs = {};
    for (const key of ['attack', 'defense']) {
      const role = ROLES[key];
      const t = readSnapshot(key);
      if (t) snap[key] = t;
      if (!seatIsNetworked(key)) { specs[role.seat] = null; continue; }
      const src = (mode === 'both') ? readSnapshot('attack') : t;
      specs[role.seat] = src ? { kind: 'policy', policy: makePolicy(src) } : null;
    }

    // game.AI 同時是「controller 工廠」和「網路不會時的規則 AI 後備」
    g.AI = {
      makeController: (s, teamId) => {
        const c = window.AIController.makeController(s);
        if (c) c.team = teamId;
        return c;
      },
      update: (tank, game) => EnemyAI.update(tank, game),
    };

    // ⚠ 順序：specs 要在 startDemo 之前寫好。
    //   v8 起「開場一次就出滿 4 台」，而那 4 台是在 startDemo 內部 spawnDemoTank()
    //   時向 g.AI.makeController(spec) 拿控制的 —— 之後才設 specs 的話，
    //   開場那 8 台會沿用「上一局」的控制器（第一次開場乾脆就是規則 AI），
    //   面板上寫著「場上是第 N 代冠軍」，actually 打得最久的車卻不是它。
    g.teamControllerSpecs = specs;
    g.startDemo(true, stage);
    g.demoRound = 1;                 // 從第 1 輪起算；之後自動續戰由遊戲自己遞增
    // 左側 STAGE 面板是 1-based（觀戰模式下 stage 只供 HUD，
    // 出兵種類走 demoStageIndex），所以索引 7 要顯示成 8。
    g.stage = stage + 1;

    const KEY = 'tankBattleWatchRounds';
    let stored = 0;
    try { stored = parseInt(localStorage.getItem(KEY) || '0', 10) || 0; } catch (e) { /* file:// 有時被擋，忽略就好 */ }
    const firstRound = g.demoRound;
    let lastPlayed = -1;

    // 面板上的數字是「訓練快照」，不是這一頁的即時進度 —— 但自動跟隨開著時，
    // 訓練端每代刷新快照，所以代數與時間會自己往上走。
    renderBadge = function () {
      let played = stored;
      if (g.demoRound) {
        played = stored + Math.max(0, g.demoRound - firstRound);
        if (played !== lastPlayed) {
          lastPlayed = played;
          try { localStorage.setItem(KEY, String(played)); } catch (e) { /* 同上 */ }
        }
      }
      roundsShown = played;         // 給右欄 HUD 讀：這一頁看到第幾輪
      // 面板 320px（padding 後內容約 296px）、這一區 17px → 一行最多約 17 個全形字。
      // 超長就會折行、把最後一行擠出面板 —— 數字看不見比難看更糟。
      // 角色名字放標頭，每行只留「席位顏色＋代數＋分數」，
      // 完整資訊（冠軍第幾代、匯出時間、來源、幾段訓練）全在 title 裡。
      const line = key => {
        const t = snap[key], role = ROLES[key];
        if (!seatIsNetworked(key)) return `${role.color}：規則 AI`;
        if (!t) return `${role.color}：等快照`;
        return `${role.color} ${t.generation}代 ${Number(t.fitness).toFixed(0)}分`;
      };
      const longMode = mode === 'dual' ? '藍隊＝進攻模型、紅隊＝防守模型（各自訓練、各自跟隨）'
        : mode === 'both' ? '兩席都是進攻模型（同一份網路自我對弈）'
        : mode === 'rule' ? '藍隊＝進攻模型，紅隊＝規則 AI'
        : '藍隊＝規則 AI，紅隊＝防守模型';
      badge(`${modeText()}\n${line('attack')}\n${line('defense')}\n已觀戰 ${played} 場`, null,
        `${longMode}\n\n${ROLES.attack.label}模型：\n${snapshotTitle('attack')}\n\n` +
        `${ROLES.defense.label}模型：\n${snapshotTitle('defense')}\n\n` +
        `觀戰不會訓練、也不會改寫任何檔案；數字來自訓練端每代匯出的快照。\n` +
        `某一隊的冠軍換人時，只有那一隊的車換網路，不必重新整理。\n` +
        `觀測 ${spec.dim} 欄`);
    };
    renderBadge();
    // 只留一個計時器：setMode／setStage（滑鼠面板）會重新 start()，
    // 每重開一次就再加一個 setInterval 的話，面板會越跑越慢。
    if (badgeTimer) clearInterval(badgeTimer);
    badgeTimer = setInterval(renderBadge, 1000);   // 每輪結束 demoRound 才 +1，1 秒足夠，且不打斷畫面迴圈

    for (const key of ['attack', 'defense']) {
      if (seatIsNetworked(key)) {
        schedulePoll(key);
        console.info(`[watch] ${ROLES[key].color}隊＝${ROLES[key].label}模型（${ROLES[key].file}，` +
          `第 ${snap[key] ? snap[key].generation : '?'} 代，fitness ${snap[key] ? Number(snap[key].fitness).toFixed(1) : '?'}）` +
          `｜自動跟隨每 ${POLL_MS / 1000}s`);
      } else {
        console.info(`[watch] ${ROLES[key].color}隊＝規則 AI（模式 ${mode}）`);
      }
    }
    console.info(`[watch] 地圖索引 ${stage}｜觀測 ${spec.dim} 欄｜` +
      `規則：藍隊進攻（30 秒內必須打穿紅隊老鷹）、紅隊防守（時間到就算贏）`);
  }

  // 給 onSnapshot／applyToField 呼叫；start 內會換成閉包版本（要記已觀戰場數）
  let renderBadge = () => {};

  function boot(m) {
    mode = m || 'dual';
    loadAssets(() => ensureSnapshotsLoaded(() => start(mode)));
  }

  /* ── 開場前先讀自動旗標；沒有旗標就維持原本「按 Y/U 才載入」的行為 ── */
  (function loadAutoFlag() {
    const s = document.createElement('script');
    s.src = 'ai/auto-watch.js?t=' + Date.now();
    s.onload = () => {
      const cfg = autoConfig();
      if (!cfg) return;
      pendingAuto = cfg;
      mode = cfg.mode || 'dual';
      if (cfg.stage !== undefined && cfg.stage !== null) stage = Number(cfg.stage) || 0;
      // 旗標可以指定別份檔名（訓練端換輸出路徑時會寫）
      if (cfg.attack) ROLES.attack.file = cfg.attack;
      if (cfg.defense) ROLES.defense.file = cfg.defense;
      // 核心碼 → 缺的快照檔 → 檢查能不能開場。
      // 快照還沒匯出時 maybeAutoStart 會排輪詢，等訓練端寫出第一份就自己開。
      loadAssets(() => ensureSnapshotsLoaded(maybeAutoStart));
    };
    s.onerror = () => { /* 沒開自動模式：正常 */ };
    document.head.appendChild(s);
  })();

  // ── 網址啟動 ──
  if (q.watch) boot(q.watch === true || q.watch === '1' ? 'dual' : q.watch);

  // ── 按鍵啟動（只在 TITLE 受理，跟原本按 T 進觀戰同一格）──
  window.addEventListener('keydown', e => {
    const g = window.__game;
    if (!g || g.state !== 'title') return;
    const k = (e.key || '').toLowerCase();
    if (k === 'y') { e.preventDefault(); boot('dual'); }     // 藍進攻模型 vs 紅防守模型
    if (k === 'u') { e.preventDefault(); boot('both'); }     // 同一份基因組自我對弈
  });

  /* ── 給右欄 HUD（js/hud.js）的介面：滑鼠是「主要」操作途徑 ──────
     人類不駕駛坦克了，所以面板需要的是「換模型、換地圖、看訓練進度」，
     不是方向鍵。這層把 watch.js 的內部狀態用函數暴露出去，
     hud.js 不碰 ROLES/snap 這些內部物件 —— 面板壞了不會把觀戰一起帶走。 */
  function restartAs(m) {
    mode = m || mode;
    started = false;
    autoBooted = true;                 // 手動切模式後不要再被自動開場搶一次
    loadAssets(() => ensureSnapshotsLoaded(() => start(mode)));
  }

  window.TANK_WATCH = {
    /** 目前上場的模式（dual／both／rule／defense） */
    get mode() { return mode; },
    get started() { return started; },
    get stage() { return stage; },
    get roundsShown() { return roundsShown; },
    get swapCount() { return Object.assign({}, swapCount); },
    /** 面板上那行「藍 進攻／紅 防守」的角色說明 */
    roles: () => ({
      attack: { label: ROLES.attack.label, file: ROLES.attack.file, win: ROLES.attack.win },
      defense: { label: ROLES.defense.label, file: ROLES.defense.file, win: ROLES.defense.win },
    }),
    /** 兩份快照＋是否由網路開車；缺快照時回 null，讓面板寫「等匯出」而不是猜 */
    models: () => ({
      attack: { snap: readSnapshot('attack'), onField: seatIsNetworked('attack') },
      defense: { snap: readSnapshot('defense'), onField: seatIsNetworked('defense') },
    }),
    /** 換上場的模型：重新開一輪（同一張地圖） */
    setMode(m) { restartAs(m); },
    /** 換看哪張地圖：只重開本輪，不遞增輪數、也不碰訓練端的考題。
     *  地圖編號空間現在是 MAP_VARIANTS 張隨機生成的地形（不再是 35 張手刻關卡），
     *  所以環繞取模要用 MAP_VARIANTS；並把「固定／隨機」的 label 刷新的責任交給 hud。 */
    setStage(i) {
      stage = ((i % MAP_VARIANTS) + MAP_VARIANTS) % MAP_VARIANTS;
      const g = window.__game;
      if (g && started && g.demoMode) g.startDemo(false, stage);
      else if (g && g.state === 'title') restartAs(mode);
      return stage;
    },
    /** 面板上的「已觀戰 N 場」要不要順手落盤（localStorage）由 renderBadge 決定 */
    pollSnapshotNow(key) { if (ROLES[key]) pollOnce(key); },
  };
})();
