/* ═══════════════════════════════════════════
   hud.js — 左右兩欄的面板（使用者要求重新梳理的三件事）

     ① 訓練狀態   —— 現在場上是「哪一份網路」，以及訓練端是不是正在跑
     ② 紅藍隊伍＋倒數 —— 兩隊各自的出兵／擊殺／老鷹，加上 30 秒計時
     ③ 滑鼠操作   —— 人類不駕駛坦克，所以操作全部做成可點的按鈕

   ⚠ 這一欄只做「讀狀態 ＋ 發指令」，不寫任何遊戲規則：
     戰況全部從 window.__game 現讀，訓練進度從 ai/live-data.js ＋
     兩份 trained-*.js 快照現讀。面板坏了最多是數字不更新，
     不會讓場上的坦克行為變樣 —— 這跟「訓練一套、網頁一套」是同一類錯誤，
     所以寧可多包一層，也不要讓面板自己算分數。
   ═══════════════════════════════════════════ */
(function () {
  'use strict';

  const LIVE_SRC = 'ai/live-data.js';
  const LIVE_POLL_MS = 5000;      // 訓練端每代（約 7 秒）覆寫一次，5 秒夠新
  const TICK_MS = 250;            // 面板刷新：倒數要看得出在走，又不要每幀摸 DOM

  const $ = id => document.getElementById(id);
  const setText = (id, txt) => { const el = $(id); if (el && el.textContent !== txt) el.textContent = txt; };
  const setCls = (id, cls) => { const el = $(id); if (el && el.className !== cls) el.className = cls; };
  /** 讀 watch.js 的取值一律經過這裡：場上那兩份網路是非同步載入的，
      「還沒就緒」是每頁開場都會出現的常態，不該讓整欄停擺（見 boot()）。 */
  const safeCall = (fn, fallback) => { try { return fn(); } catch (e) { return fallback; } };

  let live = null;                // ai/live-data.js 的內容（即時訓練端寫）
  let liveAt = 0;                 // 收到那份資料的時刻（本機時間）
  let lastSwitch = 0;

  /* ── 訓練狀態：即時資料（live-data.js）＋ 場上快照（trained-*.js）──
     兩者不同源，也該不同顯示：
       live-data = 「訓練程序現在練到第幾代」（可能還在練另一族）
       snapshot  = 「這一隊現在開的是哪一份網路」（每代匯出，所以最多落後一代） */
  function loadLive() {
    const s = document.createElement('script');
    s.src = LIVE_SRC + '?t=' + Date.now();
    // 訓練端正在覆寫這個檔的瞬間可能讀到半截 → 語法錯誤。
    // 這不算異常：留著上一份資料繼續顯示，下一輪再試。
    s.onerror = () => { s.remove(); scheduleLive(); };
    s.onload = () => {
      s.remove();
      if (window.__LIVE__ && window.__LIVE__.kind === 'tank-battle-live') {
        live = window.__LIVE__;
        liveAt = Date.now();
      }
      scheduleLive();
    };
    document.head.appendChild(s);
  }
  function scheduleLive() { setTimeout(loadLive, LIVE_POLL_MS); }

  const ago = ms => (ms < 0 ? '剛剛' : ms < 60000 ? `${Math.round(ms / 1000)} 秒前`
    : ms < 3600000 ? `${Math.round(ms / 60000)} 分鐘前`
    : `${(ms / 3600000).toFixed(1)} 小時前`);

  /** live-data 是不是「此刻還在跑」：訓練端每代覆寫，兩分鐘沒動就當它停了 */
  function liveRunning() {
    if (!live || !live.running) return false;
    const t = Date.parse(live.at || '');
    if (isNaN(t)) return false;
    return Date.now() - t < 120000;
  }

  // 面板寬 320px、內含 padding 後約 296px，標籤欄＋值欄對半：值欄 ≈ 143px 那一版已經過時。
  // 最小字級全站守 16px（值欄 17px）→ 一行最多約 17 個全形字，
  // 超過就折行，「代數／分數」被切開後反而讀不出來。
  // 所以這裡只留「場上那顆大腦是第幾代、拿幾分」，
  // 訓練練到哪一代、快照幾時匯出、對照的冠軍是哪一代 —— 全部放 title。
  function modelLine(m, role, loading) {
    if (loading) return { txt: '模型載入中…', title: 'ai/trained-*.js 還在載入，下一輪就有。' };
    if (!m.onField) return { txt: '規則 AI', title: '這一席目前是 js/ai.js 的規則 AI，沒有上網路。' };
    const s = m.snap;
    if (!s) return { txt: '等訓練端匯出…', title: '訓練端每代會匯出 ai/trained-' + role + '.js。' };
    const gen = s.generation ?? '?';
    const champ = s.championGeneration ?? gen;
    const fit = Number(s.fitness || 0).toFixed(1);
    return {
      txt: `第 ${champ} 代・${fit} 分`,
      title: `場上網路＝第 ${champ} 代的冠軍（${fit} 分，算分 v${s.scoringVersion ?? '?'}）\n` +
        `這一族的 checkpoint 練到第 ${gen} 代\n` +
        `累計對局 ${Number(s.episodes || 0).toLocaleString('en-US')} 場\n` +
        `匯出時間 ${s.exportedAt || '?'}\n` +
        (s.opponentRuler ? `評這個分數時的對面：${s.opponentRuler}\n` : '') +
        `來源 ai/trained-${role}.js`,
    };
  }

  function setCell(id, cell) {
    const el = $(id);
    if (!el || !cell) return;
    if (el.textContent !== cell.txt) el.textContent = cell.txt;
    if (el.title !== cell.title) el.title = cell.title;
  }

  function renderTrainState() {
    const W = window.TANK_WATCH;
    const g = window.__game;
    let el = $('hudTrainState');
    if (!el) return;

    if (liveRunning()) {
      const roleLabel = live.roleLabel || live.role || '';
      setCls('hudTrainState', 'hud-line hud-state');
      el.textContent = `即時：訓練中（${roleLabel} 第 ${live.gen} 代）`;
      el.title = `ai/live-data.js 在 ${ago(Date.now() - liveAt)}更新` +
        `（${live.file || ''}）\n每代 ${live.perGen ?? '?'} 場・累計 ${live.episodes ?? '?'} 場` +
        `・算分 v${live.scoringVersion ?? '?'}\n` +
        '「即時」＝訓練程序自己每代覆寫的看板資料，不是這一頁的進度。';
    } else if (live && live.at) {
      setCls('hudTrainState', 'hud-line hud-state stale');
      el.textContent = `快照：訓練端未在跑（最後 ${ago(Date.now() - Date.parse(live.at))}）`;
      el.title = 'ai/live-data.js 兩分鐘以上沒有更新 → 訓練程序可能結束或被關掉。\n' +
        '重新開始：node ai/auto-train.js（或雙擊 train.bat）。\n' +
        '場上的網路照舊在打，只是不會再變強。';
    } else {
      setCls('hudTrainState', 'hud-line hud-state off');
      el.textContent = '查無訓練資料（ai/live-data.js 還沒產生）';
      el.title = '跑過 node ai/auto-train.js 之後這裡才會出現即時進度。';
    }

    // 場上模型的快照是 watch.js 用 <script src> 非同步拉回來的：
    // DOMContentLoaded 那一次渲染時 trained-*.js 往往還沒到，
    // W.models() 會丟例外。這不該讓面板死掉（見 boot() 的註解），
    // 而且「還沒載入」本身就是使用者要看見的一種狀態。
    const NO_MODEL = { attack: { snap: null, onField: false }, defense: { snap: null, onField: false } };
    const models = safeCall(() => W && W.models ? W.models() : NO_MODEL,
      Object.assign({ loading: true }, NO_MODEL));
    setCell('hudModelAttack', modelLine(models.attack, 'attack', models.loading));
    setCell('hudModelDefense', modelLine(models.defense, 'defense', models.loading));

    const spec = window.AIObservation && window.AIObservation.OBS_SPEC;
    const sv = (live && live.scoringVersion) || (models.attack.snap && models.attack.snap.scoringVersion) ||
      (models.defense.snap && models.defense.snap.scoringVersion);
    setCell('hudRubric', {
      txt: `v${sv ?? '?'}／${spec ? spec.dim : '?'} 欄`,
      title: 'v＝計分標準版本（ai/fitness.js TERMS；v7 起「自己打爆自家老鷹」記 0 分、' +
        '貼身先解決敵車有額外分）\n欄＝觀測向量長度，長度變了舊的網路就不能直接接續。\n' +
        '每一項怎麼算、權重多少：ai/ledger.html「評判標準」。',
    });

    const eps = [];
    if (models.attack.snap) eps.push(`進 ${Number(models.attack.snap.episodes || 0).toLocaleString('en-US')}`);
    if (models.defense.snap) eps.push(`守 ${Number(models.defense.snap.episodes || 0).toLocaleString('en-US')}`);
    setCell('hudEpisodes', {
      txt: eps.length ? eps.join('／') : '—',
      title: '兩族各自跑過的對局數（一場＝一個基因體打一局）。\n' +
        '這是訓練端的累計，跟觀戰這一頁看到幾輪無關。',
    });

    const exp = [models.attack.snap, models.defense.snap].filter(s => s && s.exportedAt)
      .map(s => Date.parse(s.exportedAt)).filter(t => !isNaN(t));
    setCell('hudSnapAge', {
      txt: exp.length ? ago(Date.now() - Math.max(...exp)) : '—',
      title: '場上那兩份網路最近一次匯出的時間（取兩族較新的那個）。\n' +
        '訓練端每代匯出一次，所以這個數字會一直往回跳。',
    });

    const sw = safeCall(() => W && W.swapCount ? W.swapCount() : { attack: 0, defense: 0 },
      { attack: 0, defense: 0 });
    const note = $('hudTrainNote');
    if (note) {
      const modeTxt = W && W.mode ? { dual: '藍進攻／紅防守兩個模型', both: '兩席同一份網路',
        rule: '藍＝網路、紅＝規則 AI', defense: '藍＝規則 AI、紅＝網路' }[W.mode] || W.mode : '尚未開場';
      // roundsShown 存在 localStorage（#30 的修正：不能把訓練快照當成這一頁的進度），
      // 所以它是「這台電腦累計」而不是「本頁」—— 寫錯會讓人以為 528 輪是剛開的這一頁看到的。
      note.textContent = `場上：${modeTxt}・本機累計已看 ${W && W.roundsShown ? W.roundsShown : 0} 輪。` +
        `換新冠軍時自動跟隨（藍 ${sw.attack || 0} 次／紅 ${sw.defense || 0} 次）。` +
        '觀戰不會訓練，也不會改寫任何檔案。';
    }
    // 舊版面残留的 #aiDisplay（其它測試或書籤可能還在讀）：同步寫一行簡短狀態
    const legacy = $('aiDisplay');
    if (legacy) legacy.textContent = el.textContent;
  }

  /* ── ② 兩隊戰況＋30 秒倒數：全部現讀 game，面板自己不算任何規則 ── */
  function ringLeft(base) {
    const map = window.__game && window.__game.map;
    if (!base || !map || !base.ring) return null;
    let n = 0;
    for (const [cx, cy] of base.ring) {
      const row = map.cells[cy];
      if (row && row[cx] !== 0 && row[cx] !== undefined) n++;
    }
    return n;
  }

  function renderBattle() {
    const g = window.__game;
    if (!g) return;
    const demo = !!g.demoMode && g.teams;
    const legacy = $('hudLegacy');
    if (legacy) legacy.className = 'hud-block legacy' + (demo ? '' : ' show');

    if (!demo) { setText('hudClock', '--'); setText('hudRound', '單人模式'); return; }

    const total = DEMO_ROUND_CAP;
    // DEMO_INTRO（開場那 90 幀）還沒開始計時，時鐘是滿的；
    // 直接讀 demoCap 的話會顯示 0.0 秒 + 紅燈，像已經時間內一樣。
    const left = g.state === STATE.DEMO_INTRO ? total : Math.max(0, g.demoCap || 0);
    const secs = left / TARGET_FPS;
    setText('hudRound', `第 ${g.demoRound} 輪`);
    // 地形現在是隨機抽的，所以這一欄要連「從幾張裡抽」一起講：
    // 「地圖 137」單獨看會讓人以為真的有 137 關。
    setText('hudMap', `地圖 ${(g.demoStageIndex ?? 0) + 1}/${MAP_VARIANTS}`);
    setText('hudClock', secs.toFixed(1));
    // 張力可視化：最後 10 秒就進入紅色脈動（原本 5 秒才變紅）。
    // 中位數一場才 9.5 秒 —— 5 秒的門檻常常整場都看不到，等於沒做。
    const urgent = secs <= 10;
    setCls('hudClock', 'hud-clock-num' + (urgent ? ' urgent' : ''));
    const bar = $('hudClockBar');
    if (bar) {
      bar.style.width = `${(100 * left / total).toFixed(1)}%`;
      bar.className = urgent ? 'urgent' : '';
    }

    const W = window.TANK_WATCH;
    setText('hudRule', `藍 30 秒內破紅鷹＝藍勝；時間到或兵力耗盡＝紅勝。` +
      (W && W.stage !== undefined ? `（訓練考題由訓練端決定，這裡只換看的圖）` : ''));

    for (const [id, pre] of [[0, 'Blue'], [1, 'Red']]) {
      const t = g.teams[id];
      if (!t) continue;
      setText(`hud${pre}On`, String(t.tanks.length));
      setText(`hud${pre}Pool`, String(t.pool));
      setText(`hud${pre}Kills`, String(t.kills));
      setText(`hud${pre}Score`, `${t.score} 分`);
      const base = g.map.bases[id];
      const ring = ringLeft(base);
      const full = base && base.ring ? base.ring.length : null;
      const el = $(`hud${pre}Base`);
      if (el) {
        // 「完好 / 圍牆剩幾格 / 被毀」：老鷹還在但牆被啃過，結算上是同一件事，
        // 但對觀察者要分得開 —— 圍牆掉格是「差一點就輸」的證據。
        el.textContent = base && base.dead ? '被毀（這隊輸）'
          : ring === null || full === null ? '—'
          : ring >= full ? '完好' : `圍牆剩 ${ring}/${full}`;
        el.style.color = base && base.dead ? '#f85858' : (ring !== null && full !== null && ring < full ? '#e0a040' : '#7bd88f');
      }
    }

    const res = g.demoResult;
    const endEl = $('hudEnd');
    if (endEl) {
      const w = res && res.winner !== null && res.winner !== undefined ? g.teams[res.winner] : null;
      const txt = res ? `${res.text || ''}｜reason ${res.reason}` : '（本輪還沒結束）';
      endEl.textContent = res && res.ownGoal
        ? `⚠ 自破：${['藍', '紅'][res.killerTeam] || '?'}隊把自己的老鷹打爆 → ${txt}`
        : txt;
      endEl.className = 'hud-end' + (res && res.ownGoal ? ' own' : '');
      endEl.title = res && res.ownGoal
        ? '自己人打爆自家老鷹：訓練端會把這一隊這一局記 0 分（計分 v7 的地板），' +
          '對面那隊拿不到勝負分，因為那不是它打出來的。'
        : '終局原因與訓練報告讀同一份（js/game.js finishDemo）。';
    }
  }

  /* ── ④ 競賽感：張力／系列賽／Kill feed／結算卡 ──────────────────
     全部是「現讀場上狀態 → 寫面板」，跟上面兩塊同一套紀律：
     不存規則、不影響訓練，資料來源是 game 的唯讀欄位（shots／killEvents/
     t.serial）＋ TANK_WATCH.series()。 */

  /** 場上那兩隊的「世代隊名」：從快照現讀，沒快照就退回角色名 */
  function teamNames() {
    const NO_MODEL = { attack: { snap: null, onField: false }, defense: { snap: null, onField: false } };
    const m = safeCall(() => { const W = window.TANK_WATCH; return W && W.models ? W.models() : NO_MODEL; }, NO_MODEL);
    const name = (seat, mod, label) => {
      const champ = mod && mod.snap ? mod.snap.championGeneration : null;
      return champ != null ? `${label}・第 ${champ} 代冠軍` : `${label}・規則 AI`;
    };
    return [name(0, m.attack, '藍'), name(1, m.defense, '紅')];
  }

  function renderSeries() {
    const el = $('hudSeries');
    if (!el) return;
    const W = window.TANK_WATCH;
    const s = W && W.series ? safeCall(() => W.series(), null) : null;
    if (!s || !s.started) {
      el.textContent = '系列賽：還沒開場';
      el.title = '進觀戰後開始記：BO7，先拿 4 勝的隊伍是系列冠軍。\n' +
        '記帳只活在這一頁（重整＝新系列）；「已觀戰 N 場」才是跨重整的累計。';
      el.className = 'hud-series';
      return;
    }
    const names = teamNames();
    const need = Math.ceil(s.bestOf / 2);
    el.className = 'hud-series';
    if (s.champion !== null) {
      el.textContent = '';
      el.append('系列冠軍：');
      const b = document.createElement('span');
      b.className = 'champ';
      b.textContent = `${names[s.champion]}！`;
      el.append(b, `（${s.wins[0]} — ${s.wins[1]}）`);
      el.title = `BO${s.bestOf} 打完了：先拿 ${need} 勝的隊伍是系列冠軍。\n` +
        '下一輪開打會自動重新開帳，從 0 — 0 再來一個系列。';
      return;
    }
    // 一行塞不下世代隊名（面板 320px）→ 隊名進 title，本行只留比分與狀態
    el.textContent = '';
    el.append(`BO${s.bestOf} 第 ${s.gameNo} 場｜藍 ${s.wins[0]} — ${s.wins[1]} 紅`);
    if (s.matchPoint) {
      const mp = document.createElement('span');
      mp.className = 'mp';
      mp.textContent = '　賽末點';
      el.append(mp);
    }
    el.title = `隊名：藍＝${names[0]}、紅＝${names[1]}\n` +
      `BO${s.bestOf}：先拿 ${need} 勝的隊伍是系列冠軍。\n` +
      '每一輪結束記一勝（不論贏法）；記帳只活在這一頁，重整＝新系列。';
  }

  /* ── 張力：破局進度（藍車離紅鷹最近多遠）＋包圍壓力（紅鷹 56px 內藍車數）──
     用跟規則 AI 同一把尺（AI_ASSAULT_RADIUS / EnemyAI.baseWithin 的定義），
     觀察者才不會跟規則各講各話。 */
  function renderTension(g) {
    const breach = $('hudBreach'), bar = $('hudBreachBar'), siegeEl = $('hudSiege');
    if (!breach || !bar || !siegeEl) return;
    const bases = g.map && g.map.bases;
    const redBase = bases && bases[1], blueBase = bases && bases[0];
    if (!redBase) return;
    if (redBase.dead) {           // 已經破了：滿格，別再算距離
      breach.textContent = '100%';
      bar.style.width = '100%';
      bar.className = 'breach';
      siegeEl.textContent = '已破防';
      return;
    }
    const rb = GameMap.baseCenter(redBase);
    const bb = blueBase ? GameMap.baseCenter(blueBase) : null;
    const full = bb ? Math.hypot(rb.x - bb.x, rb.y - bb.y) : 1;
    let minD = full, siege = 0;
    for (const t of g.tanks) {
      if (!t.alive || t.team !== TEAM.BLUE) continue;
      const c = t.center();
      const d = Math.hypot(rb.x - c.x, rb.y - c.y);
      if (d < minD) minD = d;
      if (d <= AI_ASSAULT_RADIUS) siege++;
    }
    const prog = Math.max(0, Math.min(1, 1 - minD / full));
    breach.textContent = `${Math.round(prog * 100)}%`;
    bar.style.width = `${(prog * 100).toFixed(1)}%`;
    bar.className = 'breach';
    siegeEl.textContent = `${siege} 台`;
  }

  /* ── Kill feed：吃 game.killEvents（creditKill 記的唯讀事件流）──
     每 250ms 取走就清空（跟訓練端吃 wallEvents 同一套節奏），
     每條停 8 秒、最後 0.6 秒淡出，最多同時掛 4 條。 */
  const kfQueue = [];             // { node, expires }
  const KF_TTL = 8000, KF_FADE = 600, KF_MAX = 4;

  function kfLabel(team, serial) {
    const span = document.createElement('span');
    if (team === 0 || team === 1) {
      span.className = team === 0 ? 'blue' : 'red';
      span.textContent = `${team === 0 ? '藍' : '紅'}${serial ?? '?'}`;
    } else {
      span.textContent = '？';    // 沒有歸因的擊殺（寧可漏記，不栽贓）
    }
    return span;
  }

  function drainKillFeed(g) {
    const feed = $('killFeed');
    if (!feed) return;
    if (g.demoMode && g.killEvents && g.killEvents.length) {
      const evs = g.killEvents.splice(0);
      for (const ev of evs) {
        const line = document.createElement('div');
        line.className = 'kf-line';
        const t = document.createElement('span');
        t.className = 't';
        t.textContent = `#${ev.frame}`;
        line.append(t, kfLabel(ev.killerTeam, ev.killerSerial), ' 擊毀 ',
          kfLabel(ev.victimTeam, ev.victimSerial));
        kfQueue.push({ node: line, expires: Date.now() + KF_TTL });
      }
      while (kfQueue.length > KF_MAX) {
        const old = kfQueue.shift();
        if (old.node.parentNode) old.node.remove();
      }
      for (const k of kfQueue) if (!k.node.parentNode) feed.appendChild(k.node);
    }
    const now = Date.now();
    for (let i = kfQueue.length - 1; i >= 0; i--) {
      const k = kfQueue[i];
      if (now >= k.expires - KF_FADE) k.node.classList.add('fading');
      if (now >= k.expires) {
        k.node.remove();
        kfQueue.splice(i, 1);
      }
    }
    feed.hidden = kfQueue.length === 0;
  }

  /* ── 結算卡：DEMO_RESULT 那 300 幀疊在畫布中央 ── */
  function renderResultCard(g) {
    const card = $('resultCard');
    if (!card) return;
    const res = g.demoResult;
    const show = g.state === STATE.DEMO_RESULT && res;
    card.hidden = !show;
    if (!show) return;

    const secs = ((DEMO_ROUND_CAP - Math.max(0, g.demoCap || 0)) / TARGET_FPS).toFixed(1);
    const [bn, rn] = teamNames();
    const winLabel = res.winner === 0 || res.winner === 1 ? ['藍隊', '紅隊'][res.winner] : '？';
    const blue = g.teams[0], red = g.teams[1];
    const spk = team => team.kills > 0
      ? (team.shots / team.kills).toFixed(1) : '—';

    card.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'rc-title ' + (res.winner === 0 ? 'blue' : res.winner === 1 ? 'red' : '');
    title.textContent = `${winLabel} 獲勝`;
    card.appendChild(title);

    const row = (k, v) => {
      const r = document.createElement('div');
      r.className = 'rc-row';
      const a = document.createElement('span');
      a.textContent = k;
      const b = document.createElement('b');
      b.textContent = v;
      r.append(a, b);
      card.appendChild(r);
    };
    row('結果', res.text || '');
    row('用時', `${secs} 秒`);
    row('擊殺', `${blue.kills} — ${red.kills}`);
    row('耗彈', `${blue.shots} — ${red.shots}`);
    row('每殺發數', `${spk(blue)} — ${spk(red)}`);
    if (res.ownGoal) {
      const w = document.createElement('div');
      w.className = 'rc-own';
      w.textContent = `⚠ 自破：${['藍', '紅'][res.killerTeam] || '?'}隊打爆自家老鷹`;
      card.appendChild(w);
    }
    const W = window.TANK_WATCH;
    const s = W && W.series ? safeCall(() => W.series(), null) : null;
    if (s) {
      const line = document.createElement('div');
      line.className = 'rc-series';
      line.textContent = s.champion !== null
        ? `系列賽：${s.wins[0]} — ${s.wins[1]}，系列冠軍出爐！`
        : `系列賽：藍 ${s.wins[0]} — ${s.wins[1]} 紅（BO${s.bestOf}）`;
      card.appendChild(line);
    }
    card.title = `藍＝${bn}、紅＝${rn}\n耗彈與每殺發數來自本輪子彈誕生計數（唯讀展示）。`;
  }

  /* ── ③ 滑鼠操作 ── */
  // 暫停可用的狀態，和 js/game.js handleGlobalKeys 的 P 鍵同一份清單。
  // 面板自己列一份（不 import）是因為兩邊都在同一個全域 STATE 下，
  // 但 game.js 沒有把這個判斷包成函式；改動時兩邊要一起改。
  const PAUSABLE = [STATE.PLAYING, STATE.DEMO, STATE.DEMO_INTRO, STATE.DEMO_RESULT];

  function markActive(container, attr, value) {
    const wrap = $(container);
    if (!wrap) return;
    for (const b of wrap.querySelectorAll('button')) {
      b.classList.toggle('on', b.dataset[attr] === String(value));
    }
  }

  /** 右欄那顆換圖開關的文字／高亮：跟著 game.demoMapPinned 走（唯一真相） */
  function syncMapLock() {
    const lock = $('btnMapLock');
    const g = window.__game;
    if (!lock || !g) return;
    const pinned = g.demoMapPinned !== null && g.demoMapPinned !== undefined;
    lock.textContent = pinned ? `📌 固定 地圖 ${((g.demoStageIndex ?? 0) + 1)}` : '🔀 每輪隨機';
    lock.classList.toggle('on', pinned);
    lock.title = pinned
      ? `接下來每一輪都用地圖 ${(g.demoMapPinned ?? 0) + 1}（共 ${MAP_VARIANTS} 張）。\n` +
        '再按一次恢復「每輪隨機抽一張」。\n只影響瀏覽器觀戰，訓練考題不進這裡。'
      : `接下來每一輪隨機抽一張地形（共 ${MAP_VARIANTS} 張，同一張編號在任何機器上地形相同）。\n` +
        '想連續觀察同一張圖就按下去鎖住。';
  }

  function wireButtons() {
    const g = window.__game;
    const W = window.TANK_WATCH;

    const pause = $('btnPause');
    if (pause) pause.addEventListener('click', () => {
      if (!g) return;
      // 走 game 自己的暫停路徑（跟按 P 完全同一條），面板不另寫一套狀態機
      if (g.state === STATE.PAUSED) { g.state = g.pauseReturn || STATE.PLAYING; }
      else if (PAUSABLE.includes(g.state)) {
        g.pauseReturn = g.state; g.state = STATE.PAUSED; Audio.play('pause');
      }
      pause.textContent = g.state === STATE.PAUSED ? '▶ 繼續' : '⏸ 暫停';
    });

    const restart = $('btnRestart');
    if (restart) restart.addEventListener('click', () => {
      if (g && g.demoMode) g.startDemo(false, g.demoStageIndex);   // 重打本輪、同一張圖
      else if (g) g.startStage(g.stage);
    });

    // 標題頁上「下一輪」＝進入觀戰（T 鍵做的事）：
    // 這一欄是給不碰鍵盤的人用的，按了沒反應會被當成面板壞掉。
    const next = $('btnNext');
    if (next) next.addEventListener('click', () => {
      if (!g) return;
      if (g.demoMode) g.startDemo(true);
      else if (g.state === STATE.TITLE) g.startDemo();
    });

    const title = $('btnTitle');
    if (title) title.addEventListener('click', () => { if (g && g.demoMode) g.exitDemo(); });

    const spd = $('btnSpeed');
    if (spd) spd.addEventListener('click', e => {
      const b = e.target.closest('button[data-speed]');
      if (!b || !g) return;
      g.speed = Number(b.dataset.speed);
      markActive('btnSpeed', 'speed', g.speed);
    });

    const mapBtn = dir => () => {
      if (!W || !W.setStage) return;
      const cur = g && g.demoMode ? g.demoStageIndex : (W.stage || 0);
      W.setStage(cur + dir);
      setText('hudMapLabel', String((W.stage || 0) + 1));
    };
    if ($('btnMapPrev')) $('btnMapPrev').addEventListener('click', mapBtn(-1));
    if ($('btnMapNext')) $('btnMapNext').addEventListener('click', mapBtn(1));

    // 「🔀 每輪隨機」／「📌 固定這張圖」：使用者要的是隨機地形，但連續觀察
    // 同一張圖上兩隊怎麼打仍是合理需求（例如想比較同一張圖的第 3 輪與第 30 輪）。
    // 鎖定只影響瀏覽器觀戰的換圖；訓練考題走 ai/evolve.js 的 --stages，兩者無關。
    const lock = $('btnMapLock');
    if (lock) lock.addEventListener('click', () => {
      if (!g) return;
      g.demoMapPinned = g.demoMapPinned === null ? (g.demoStageIndex ?? 0) : null;
      syncMapLock();
    });

    const mode = $('btnMode');
    if (mode) mode.addEventListener('click', e => {
      const b = e.target.closest('button[data-mode]');
      if (!b || !W || !W.setMode) return;
      W.setMode(b.dataset.mode);
      markActive('btnMode', 'mode', b.dataset.mode);
    });

    const mute = $('btnMute');
    if (mute) {
      const paint = () => {
        const on = Audio.isMuted();
        mute.textContent = on ? '🔇 靜音中' : '🔊 音效';
        mute.classList.toggle('on', !on);
      };
      mute.addEventListener('click', () => { Audio.toggleMute(); paint(); });
      paint();
    }
  }

  function render() {
    renderTrainState();
    renderBattle();
    const W = window.TANK_WATCH;
    const g = window.__game;
    if (g) {
      // 競賽感三塊：只在觀戰模式有意義，單人模式整個疊層收起來
      const demo = !!g.demoMode;
      const feed = $('killFeed');
      if (feed && !demo) feed.hidden = true;
      if (demo) drainKillFeed(g);
      renderResultCard(g);
      if (demo && (g.state === STATE.DEMO || g.state === STATE.DEMO_INTRO || g.state === STATE.DEMO_RESULT)) {
        renderTension(g);
      } else {
        // 退回標題／單人模式：張力那兩行不要留著上一場的數字
        setText('hudBreach', '—');
        setText('hudSiege', '—');
        const bb = $('hudBreachBar');
        if (bb) { bb.style.width = '0%'; bb.className = 'breach'; }
      }
    }
    renderSeries();
    if (W && W.mode && Date.now() - lastSwitch > 1500) {
      markActive('btnMode', 'mode', W.mode);
      lastSwitch = Date.now();
    }
    if (g) {
      setText('hudMapLabel', String(((g.demoStageIndex ?? (W && W.stage) ?? 0)) + 1));
      syncMapLock();
      const p = $('btnPause');
      if (p) {
        const on = g.state === STATE.PAUSED;
        p.textContent = on ? '▶ 繼續' : '⏸ 暫停';
        // 標題／結算畫面之外都沒什麼不能停的；單人 STAGE_INTRO 才真的停不了。
        p.disabled = !on && !PAUSABLE.includes(g.state);
      }
      // 「回標題」只有在真的處於觀戰時才有意義
      const back = $('btnTitle');
      if (back) back.disabled = !g.demoMode;
      markActive('btnSpeed', 'speed', g.speed || 1);
    }
  }

  // 每一輪渲染都不準把時鐘帶走。
  // 這欄是旁路顯示，讀的是別檔非同步準備好的東西（網路快照、live-data、
  // watch.js 的狀態），「某一瞬間還沒就緒」是常態而不是異常。
  // 之前一次例外就讓整欄永久停擺，使用者看到的是「訓練好像沒在跑」，
  // 實際上場上的坦克照打 —— 這種誤導比數字舊一點嚴重得多。
  // 所以這裡接住例外、把原因寫在面板上（不靜默），下一輪照樣試。
  let broken = null;
  function tick() {
    try {
      render();
      if (broken) { broken = null; renderTrainState(); }
    } catch (e) {
      if (broken !== e.message) {
        broken = e.message;
        const el = $('hudTrainState');
        if (el) {
          el.textContent = '面板這輪讀取失敗：' + e.message;
          el.className = 'hud-line hud-state stale';
        }
      }
    }
  }

  function boot() {
    wireButtons();
    loadLive();
    // ⚠ 先排時鐘、再渲染第一次。
    // 之前是 tick() 跑完才 setInterval，結果開場那一次正好卡在
    // trained-*.js 還沒載入完（見上面 safeCall 的註解），例外一路丟出 boot()，
    // 時鐘根本沒註冊 —— 面板就此永遠停在開場那 0.1 秒：
    // 實測場上已經打到第 4 輪，左右兩欄還是「—／--.-／等訓練端匯出…」。
    // 一欄「讀不到就再也不動」的狀態列，比讀到舊資料更糟：
    // 使用者無法分辨是訓練沒跑，還是網頁壞了。
    setInterval(tick, TICK_MS);
    tick();
  }

  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
