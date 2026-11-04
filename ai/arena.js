/* ai/arena.js — 無頭競技場：跑一局、量一局
   ═══════════════════════════════════════════════════════════
   訓練迴圈唯一依賴的對局介面：

     new Arena().run({ stage, seed, blue, red })  →  report

   · 一局 = 一個完整 DEMO 回合（含 DEMO_INTRO 開場）。地圖由
     startDemo(true, stage) 綁定，所以 (stage, seed, 控制器組合)
     完全決定結果 —— 這是「今天跑 100 場、明天接得回去」的前提。
   · 渲染整個關掉，迴圈逐幀呼叫遊戲自己的 update()，
     所以 report.frames 就是真實邏輯幀，不會因繪圖耗時飄移。
   · 計量方式：觀察 game 狀態的逐幀差分（子彈新增、道具消失、
     hp 下降、firepower 上升）。刻意不改遊戲規則去配合訓練，
     這樣「訓練場裡的行為」和「瀏覽器裡看到的行為」才是同一套。
   ═══════════════════════════════════════════════════════════ */
'use strict';

const { createEngine } = require('./engine');
const Controller = require('./controller');
const { Recorder } = require('./telemetry');

/** AABB 重疊（跟 bundle 裡的 boxesOverlap 同式；跨 vm 邊界自己算一份） */
function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

const TEAMS = [0, 1];

/* ── 過程計量（v3 計分、v5 半場攔截、v6 攻守分工）──────────────
   防守（家門口）：敵車進到「自家老鷹 ~7 格」（56px）內才挨的打，才叫攔截。
     在 midfield 對射也很有價值，但那是 damageDone 的事；
     這一項刻意只認家門口的傷害，才不會把「到處打架」誤記成「會防守」。
   防守（半場，v5）：使用者要的「打擊對方坦克也是防守」。
     敵車一踏進自家半場就開始消耗，就算在老鷹 56px 外也算攔截；
     家門口那段已算進上一項，這裡不重複計算（兩者是互斥分類）。
   進攻（v6，藍隊＝進攻方）：30 秒內必須拆掉紅隊老鷹，所以推進要有可測量的痕跡。
     foeHalfFrames  = 自家車待在「敵半場」的在場幀（真的壓上去，不是在家門前繞圈）
     foeBaseMinDist = 本隊離敵鷹最近到過哪裡（px，越小越好；沒有車在場時記 Infinity）
     foeWallLost    = 敵人要塞牆被拆掉幾格（結算時互補：己方掉牆＝對方拆的）
     foeWallNear／foeWallFar
                    = v11 把上面那個總數按「開火點離敵鷹多遠」拆成兩堆：
                      ≤AI_ASSAULT_RADIUS（56px，跟規則 AI 改瞄主堡同一個門檻）算近，
                      其餘算遠。使用者的攻擊順序是「先打敵車、接近主堡才打主堡」，
                      所以遠距離啃牆不能跟貼臉拆鷹拿一樣的分數（見 ai/fitness.js foeWall）。
                      同一格牆一局只記一次：鏟子（shovelOn）會讓被打掉的牆活回來，
                      不去重就成了可反覆領的分。這堆跟 foeWallLost 可以不相等 ——
                      前者是「真的拆過幾格」，後者是「結算時還少幾格」。
   本業占比（v10，兩族各一項「天天都發生」的過程量，見 BALANCE-RESEARCH.md 的 C）：
     besiegeFrames  = 自家車貼在敵鷹 56px 圈內的在場幀（進攻：壓上去待著，不是擦過一眼）
     screenFrames   = 自家車擋在「老鷹靠敵那一側」56px 圈內的在場幀（防守：回防要有自己的梯度；
                      停在出生點那種「在後面陪老鷹」不算，見迴圈裡的點積說明）
     拒止不另設計量 —— 它就是對手的 foeHalfFrames 換算過來，敵人不進來就是最好的防守。
   協同：兩台以上友車同時貼著同一台敵車（64px ≈ 8 格）。
     用「同一台敵車」當條件，而不是「隊友彼此靠近」——
     兩台車一起在家裡繞圈不算合作，一起壓同一個目標才算。
   ⚠ 三者都以 px 半徑、逐幀計算，跟觀測的 gridRadius 無關；
     調半徑只會改變計分，不會改變遊戲規則。 */
const BASE_DEFENSE_RADIUS = 56;
const SUPPORT_RADIUS = 64;

/** box 中心到 (x,y) 的距離是否在 r 內 */
function centerWithin(box, x, y, r) {
  const dx = box.x + box.w / 2 - x;
  const dy = box.y + box.h / 2 - y;
  return dx * dx + dy * dy <= r * r;
}

/** 兩個 box 中心距離是否在 r 內 */
function centersNear(a, b, r) {
  return centerWithin(a, b.x + b.w / 2, b.y + b.h / 2, r);
}

/** 兩個 box 中心的距離（px） */
function centersDist(a, b) {
  const dx = a.x + a.w / 2 - (b.x + b.w / 2);
  const dy = a.y + a.h / 2 - (b.y + b.h / 2);
  return Math.hypot(dx, dy);
}

/** 這台車有沒有「擋在自家老鷹靠敵那一側」的 56px 圈內？（screenFrames 的判準）
 *  拆成純函數只為了一個理由：這一條是幾何，幾何寫錯不會報錯，只會讓
 *  防守分白送（見下面迴圈裡的 ⚠）。寫在迴圈裡就沒辦法用四個座標驗它。 */
function screensEagle(box, ownC, foeC, r = BASE_DEFENSE_RADIUS) {
  if (!box || !ownC || !foeC) return false;
  const ox = box.x + box.w / 2 - ownC.x, oy = box.y + box.h / 2 - ownC.y;
  if (ox * ox + oy * oy > r * r) return false;
  // off·(敵鷹 − 自家鷹) > 0 ⇒ 車在老鷹面向來敵的那一側，才算「擋」而不是「窩」。
  return ox * (foeC.x - ownC.x) + oy * (foeC.y - ownC.y) > 0;
}

/** 共用一個引擎：重建要讀 11 個檔並重編整個 bundle，訓練時是純浪費 */
let cached = null;
function acquireEngine() {
  if (cached) return cached;
  let EnemyAI = null;
  const hooks = { controllers: [] };
  const aiModules = {
    // 規則 AI 的 fallback 入口（controller 決定「這幀我不會」時用）
    update: (t, g) => EnemyAI.update(t, g),
    makeController: (spec, teamId) => {
      const c = Controller.makeController(spec);
      if (c) { c.team = teamId; hooks.controllers.push(c); }
      return c;
    },
  };
  const engine = createEngine({ seed: 1, aiModules });
  EnemyAI = engine.R.EnemyAI;
  engine.__hooks = hooks;
  cached = engine;
  return engine;
}

/** 給監測標註用的「這一隊是誰」；不要把整個 spec 物件塞進報告 */
function describe(spec) {
  if (spec === undefined) return 'rule(default)';
  if (spec === null || spec === 'rule') return 'rule';
  if (spec === 'random') return 'random';
  return spec.kind || 'policy';
}

function freshStat() {
  return {
    kills: 0, deaths: 0, survivors: 0, poolLeft: 0, score: 0,
    shots: 0, damageDone: 0,             // damageDone = 對敵隊造成的 hp 損失總和
    bombKills: 0,                        // 炸彈道具直接判死的敵車（不經 hp 差分）
    baseDefenseDamage: 0,                // 在自家老鷹附近攔下的傷害（damageDone 的子集）
    baseDefenseKills: 0,                 // 在自家老鷹附近打掉的敵車
    halfDefenseDamage: 0,                // v5：敵車在自家半場（家門口以外）挨的傷害
    foeHalfFrames: 0,                    // v6 進攻：自家車在「敵半場」的在場幀
    besiegeFrames: 0,                    // v10 進攻：自家車貼在敵鷹 56px 內的在場幀
    screenFrames: 0,                     // v10 防守：自家車「擋在老鷹靠敵那一側」56px 內的在場幀
    foeBaseMinDist: Infinity,            // v6 進攻：本隊離敵鷹最近到過哪裡（px）
    foeWallLost: 0,                      // v6 進攻：敵人要塞牆少了幾格（結算時填入）
    foeWallNear: 0,                      // v11：其中「開火時人已貼到敵鷹門口（≤56px）」的格數
    foeWallFar: 0,                       // v11：開火時還在門口外的格數（啃遠牆，計分打折）
    supportFrames: 0,                    // 「兩台以上友車壓同一台敵車」的在場幀
    selfBaseShots: 0,                    // 開火當下就注定打在自家老鷹上的子彈數
    ownBaseKilledBySelf: false,          // v7：自家老鷹是被自己人打爆的
    foeBaseOwnGoal: false,               // v7：敵鷹是自破的（這局的「贏」是對方送的）
    duelKills: 0,                        // v7：在「貼身」距離內打掉的敵車（先解決對方坦克）
    duelFrames: 0,                       // v7：自家車正與敵車貼身的在場幀（只觀察、不計分）
    fieldFrames: 0,                      // 可行動的在場幀（出生無敵、被凍結不算）
    blockedFrames: 0,                    // 在場但「動不了」的幀（頂到牆/被車擋住）
    powerups: 0, firepowerUp: 0,
    ownBaseAlive: true, foeBaseKilled: false, ownBaseCellsLost: 0,
    dominance: null, framesDecided: 0,   // policy 的動作單一性 / 決策幀數
    tanksControlled: 0,                  // v8：這一局有幾台車真的聽注入的 policy
    actHist: null, actN: 0,              // 五類動作各自被選了幾次
  };
}

class Arena {
  constructor(o = {}) {
    this.engine = o.engine || acquireEngine();
    this.R = this.engine.R;
    this.game = this.engine.game;
    // 一局在規則上最長 90（開場）+ 30×60（時鐘）= 1890 幀。
    // 2400 只是無頭引擎的保險絲：真的碰到代表規則被改壞了（舊值 8000 是
    // 90 秒時代的殘留，會讓「卡住的局」白燒 3 倍訓練預算）。
    this.defaultMaxFrames = o.maxFrames || 2400;
  }

  /**
   * @param {object} o
   *   o.stage 地圖編號（0..MAP_VARIANTS-1，決定地形）
   *   o.seed  亂數種子
   *   o.blue / o.red  null|'rule' = 規則 AI、'random'、policy 函數、{policy, jitter}
   *   o.maxFrames 硬上限
   */
  run(o = {}) {
    const R = this.R, G = this.game, hooks = this.engine.__hooks;
    const maxFrames = o.maxFrames || this.defaultMaxFrames;

    this.engine.setSeed(o.seed ?? 1);
    G.state = R.STATE.TITLE;
    G.demoMode = false;
    // 開局中央出生點只是觀戰頁的展示調整；訓練維持原本四點隨機的考題，
    // 否則同一份 checkpoint 的分數會因為出生分佈被改掉而不可比。
    G.demoOpeningCenter = false;
    // ⚠ v8「開場一次出滿 4 台」之後，這三段順序不能反：
    //   startDemo() 會在內部就把 4 台車生出來，而每台車是在 spawnDemoTank()
    //   裡向 AI.makeController(spec) 拿控制的。所以「這一隊聽誰的」必須先寫好、
    //   統計用的 controller 清單必須先清掉，才進 startDemo ——
    //   否則開場那 4 台會拿到「上一局」的控制器（第一局則是 null＝規則 AI），
    //   而這一局真正在場最久的車又不記進 framesDecided，
    //   實測控制權從 100% 掉到 11%，網路的成績變成拿規則 AI 的車替它刷。
    hooks.controllers.length = 0;
    G.teamControllerSpecs = (o.blue === undefined && o.red === undefined)
      ? null
      : { 0: o.blue === undefined ? null : o.blue, 1: o.red === undefined ? null : o.red };
    G.startDemo(true, o.stage ?? 0);

    const stats = [freshStat(), freshStat()];
    // v7「貼身」的判定半徑：直接讀規則 AI 自己用的那個數字（ai/engine.js 有 expose）。
    // 訓練端另寫一份 40 的話，改 js/ai.js 的半徑就不會反映到計分，
    // 「AI 認為的近距離」和「計分認為的近距離」會悄悄分岔。
    const duelRadius = R.AI_DUEL_RADIUS || 40;
    // 逐幀監測（可選）：跟訓練共用同一個對局驅動，絕不會「訓練一套、監測一套」
    const rec = o.record ? new Recorder({ trackTeams: TEAMS }) : null;
    if (rec) rec.begin(G, R, { label: o.label || null, blue: describe(o.blue), red: describe(o.red) });
    const seenBullets = new Set();
    // v11 拆牆去重：記「哪一格要塞牆已經算過一次」（key = 要塞索引:cx,cy）。
    const wallSeen = new Set();
    const baseCells0 = TEAMS.map(id => aliveRing(G, id));
    // 基地中心只在開局算一次：地圖不會在局中移動
    const baseCenters = TEAMS.map(id => {
      const b = G.map.bases[id];
      return { x: (b.cx + 1) * R.CELL, y: (b.cy + 1) * R.CELL };
    });
    let lastHp = new Map();
    const prevPos = new Map();     // tank → {x,y} 上一幀位置（差分「這幀有沒有真的移動」）
    for (const t of G.tanks) lastHp.set(t, t.hp);

    let frames = 0;
    let capped = true;
    while (frames < maxFrames) {
      const puBefore = G.powerUps.filter(p => p.alive).map(p => ({ p, box: p.box, t: p.timer }));
      const tanksBefore = G.tanks.filter(t => t.alive).map(t => ({ t, hp: t.hp, fp: t.firepower, box: t.box }));

      this.engine.step(1);
      frames++;
      if (rec) rec.afterFrame(G, R);

      for (const b of G.bullets) {
        if (!seenBullets.has(b) && b.owner && b.owner.team !== undefined) {
          seenBullets.add(b);
          stats[b.owner.team].shots++;
          // 「拆自己家」要在開火的當下判定（這顆子彈注定打在自家老鷹上），
          // 不能等結算看「自家圍牆少了幾格」—— 那個數字有一半是敵人打的。
          if (Controller.ownBaseInFront(b.owner, G)) stats[b.owner.team].selfBaseShots++;
        }
      }
      // v11 拆牆歸因：js/game.js 在子彈撞地形的當下記下「哪一隊從哪裡開槍、
      // 拆掉哪座要塞幾格」（G.wallEvents），這裡每幀取走並清空。
      // 分成近／遠兩堆用的還是規則 AI 自己那把尺（EnemyAI.baseWithin ＋
      // AI_ASSAULT_RADIUS），不是在訓練端另設一個門檻 —— 否則「AI 以為已到家門口」
      // 和「計量認為是家門口拆的牆」會分岔，那條折扣就等於在打隨機誤差。
      // ⚠ 判的是「開火點」，不是撞牆那幀的車位：子彈 8px/幀、車 2px/幀，
      //   飛到對面要 20 幀以上，那 40px 漂移跟 56px 的門檻同一個等級。
      const wallEv = G.wallEvents;
      if (wallEv && wallEv.length) {
        for (const ev of wallEv) {
          const s = stats[ev.team];
          // 只認「拆敵人要塞牆」：打到自己家那一圈的格數是 ownBaseCellsLost
          // 那條紅線的證據，不能同時算進進攻成績。
          if (!s || ev.baseIndex !== 1 - ev.team) continue;
          const c = baseCenters[ev.baseIndex];
          // 沒有開火點（非坦克子彈、舊資料流）→ 一律算遠：保守，不虚發近距離的分。
          const near = !!c && Number.isFinite(ev.fireX) && Number.isFinite(ev.fireY) &&
            R.EnemyAI.baseWithin({ x: ev.fireX, y: ev.fireY }, c, R.AI_ASSAULT_RADIUS);
          // 同一格本局只記一次：鏟子把整圈牆 backup 成磚，shovelOff 時連之前
          // 被打掉的那幾格也一併「活回來」（實測 stage 5／seed 4242：藍在 995 幀
          // 拆掉紅家 2 格，紅 1363 幀撿到鏟子，1364 幀那 2 格變回磚）。
          // 不去重的話，「拆了→等它還原→再拆」會變成可反覆領的 5 分／格。
          let n = 0;
          for (const k of ev.keys) {
            const cellId = ev.baseIndex + ':' + k;
            if (wallSeen.has(cellId)) continue;
            wallSeen.add(cellId); n++;
          }
          if (!n) continue;
          if (near) s.foeWallNear += n; else s.foeWallFar += n;
        }
        wallEv.length = 0;
      }
      // 道具：本幀從在場變不見，且不是自然過期 → 有人撿到
      const stillThere = new Set(G.powerUps.filter(p => p.alive));
      for (const { p, box, t } of puBefore) {
        if (stillThere.has(p) || t <= 12) continue;         // t<=12：閃爍期結束，算過期
        let grabber = -1;
        for (const tank of G.tanks) if (overlaps(box, tank.box)) { grabber = tank.team; break; }
        if (grabber >= 0) stats[grabber].powerups++;
      }
      // 逐幀差分：傷害、火力升級、在場幀
      for (const { t, hp, fp } of tanksBefore) {
        const foe = 1 - t.team;
        // ⚠ 這裡不能加 t.alive 條件：takeDamage() 是「先扣 hp、扣到 0 才標死」，
        //   致命那一下就發生在 alive 變 false 的同一幀。
        //   舊寫法 `t.alive && t.hp < hp` 等於把「擊殺」造成的 hp 全丢掉：
        //   1 hp 的車被打掉時 damageDone 不增加 → accuracy 項幾乎拿不到分，
        //   而 spray 懲罰（每發平均傷害 < 0.25）反倒會誤傷打得準的個體。
        if (t.hp < hp) stats[foe].damageDone += (hp - Math.max(0, t.hp));
        if (t.firepower > fp) stats[t.team].firepowerUp++;
      }
      // 防守：敵車在「自家老鷹附近」挨的打，記給守方。
      // 只算家門口的傷害 → 「會回防」和「到處對射」在分數上終於分得開。
      for (const { t, hp } of tanksBefore) {
        if (t.hp >= hp) continue;
        const owner = 1 - t.team;
        if (G.map.bases[owner].dead) continue;
        const c = baseCenters[owner];
        const dmg = hp - Math.max(0, t.hp);
        if (centerWithin(t.box, c.x, c.y, BASE_DEFENSE_RADIUS)) {
          stats[owner].baseDefenseDamage += dmg;
          if (hp > 0 && t.hp <= 0) stats[owner].baseDefenseKills++;
        } else if (this.inOwnHalf(t, c)) {
          // 家門口以外、但敵車已經踏進自家半場 → 主動迎擊也算防守。
          // 兩類互斥，所以一筆傷害只會被計價一次。
          stats[owner].halfDefenseDamage += dmg;
        }
      }
      // 協同：同一隊「兩台以上」在場車同時貼著同一台敵車，這一幀記一次。
      // 用「同一台敵車」而不是「隊友彼此靠近」：
      // 兩台車一起繞圈、一起守家都不算合作，一起壓同一個目標才算。
      for (const id of TEAMS) {
        const allies = G.tanks.filter(t => t.alive && t.team === id &&
          t.spawnTimer <= 0 && !G.frozenFor(t));
        if (allies.length < 2) continue;
        for (const target of G.tanks) {
          if (!target.alive || target.team === id || target.spawnTimer > 0) continue;
          let n = 0;
          for (const a of allies) if (centersNear(a.box, target.box, SUPPORT_RADIUS) && ++n >= 2) break;
          if (n >= 2) { stats[id].supportFrames++; break; }
        }
      }
      // v7 近身殲滅：敵車死的時候「身邊就有一台敵車」→ 記給那台車所屬的隊。
      // 為什麼用距離歸因、不用子彈歸因：這一項要的就是「近距離打死人」這個事實；
      // 用子彈 owner 會把炸彈道具、流彈等路徑也算進去，那些不是格鬥。
      // 最近的敵車為準（一局只會記一次），避免三台車圍殺時重複計功。
      for (const { t, hp } of tanksBefore) {
        if (!(hp > 0 && t.hp <= 0)) continue;
        let best = null, bd = duelRadius;
        for (const a of G.tanks) {
          if (!a.alive || a.team === t.team || a.spawnTimer > 0) continue;
          const d = centersDist(a.box, t.box);
          if (d < bd) { bd = d; best = a; }
        }
        if (best) stats[best.team].duelKills++;
      }
      for (const t of G.tanks) {
        const s = stats[t.team];
        // 出生無敵／被凍結的幀不算：那幾幀車本來就動不了，計進去會把
        // 「被牆頂住」稀釋掉，紅旗就永遠亮不起來。
        if (!t.alive || t.spawnTimer > 0 || G.frozenFor(t)) { prevPos.delete(t); continue; }
        s.fieldFrames++;
        // v7：這台車正在「貼身」對上敵車嗎？（只記錄，不直接計分 ——
        // 分數給的是 duelKills 那個結果，這一項留給監測看「有沒有真的交戰」。）
        for (const f of G.tanks) {
          if (!f.alive || f.team === t.team || f.spawnTimer > 0) continue;
          if (centersDist(t.box, f.box) < duelRadius) { s.duelFrames++; break; }
        }
        // v6 進攻計量（逐幀，不看結論）：這台車壓到敵半場了嗎？最接近敵鷹到哪裡？
        const foeC = baseCenters[1 - t.team];
        if (this.inOwnHalf(t, foeC)) s.foeHalfFrames++;
        const dcx = t.box.x + t.box.w / 2 - foeC.x, dcy = t.box.y + t.box.h / 2 - foeC.y;
        const dFoe = Math.sqrt(dcx * dcx + dcy * dcy);
        if (dFoe < s.foeBaseMinDist) s.foeBaseMinDist = dFoe;
        // v10 的兩個「本業占比」（探針實測：稀有事件不夠當方向盤，天天發生的才夠）：
        //   besiegeFrames ＝貼在敵鷹門口（同 baseDefenseDamage 那個 56px 圈）的幀，
        //     penetration 只看「最近到過哪裡」，到了就不會再漲；在門口繞多久才分得清
        //     「擦過一眼」與「壓上去打」。
        //   screenFrames ＝待在自家老鷹門口同一圈的幀，給「回防」一條自己的梯度，
        //     不再只用擊殺數間接猜它有沒有在家。
        // 老鷹一被拆掉這局就結算（DEMO 的終局條件），所以這裡不用處理「家已經沒了」
        // 的幀；ownC 的判空只是防「單人模式只有一座老鷹」那類非對局資料流。
        if (dFoe <= BASE_DEFENSE_RADIUS) s.besiegeFrames++;
        // 只認「老鷹靠敵那一側」：紅隊出生點在 y=0、老鷹在 y≈24，車停在
        // 家門口不動就已經在 56px 圈內 —— 不加那一道的話這一項是白送的，
        // 等於用「存在」當防守。判準本身抽成 screensEagle，由測試直接驗幾何。
        //（進攻端的 besiege 不需要這一道：藍隊出生點離紅鷹 300px，貼上去一定是走過去的。）
        // ⚠ 加了這一道之後，「門前在場占比」仍然不適合直接當一項分數：
        //   48 場實測 rand·rand 中位 28.0% ＞ rule·rule 14.8% ＞ v9 防守冠軍 7.4%
        //   —— 愈會玩愈低，因為隨機的車被牆跟老鷹圈困住就吃飽。
        //   所以這個計量現在只做 holdGate 的加成（贏了才發，而且要「已經攔到傷害」
        //   才乘得出來 —— 零攔截光站位一分都不給），
        //   原本打算加的 screenHold 項因此刪除，記錄見 ai/fitness.js。
        if (screensEagle(t.box, baseCenters[t.team], foeC)) s.screenFrames++;
        // 卡牆用「位置有沒有改變」判定，不用 t.moving：
        // 規則 AI（js/ai.js）根本沒寫 t.moving，拿它當訊號會把整隊誤判成全幀卡住。
        const p = prevPos.get(t);
        if (p) {
          if (p.x === t.x && p.y === t.y) s.blockedFrames++;
          else { p.x = t.x; p.y = t.y; }
        } else prevPos.set(t, { x: t.x, y: t.y });
      }
      if (G.state !== R.STATE.DEMO && G.state !== R.STATE.DEMO_INTRO) { capped = false; break; }
    }

    for (const id of TEAMS) {
      const tm = G.teams[id], s = stats[id];
      s.kills = tm.kills;
      // 炸彈擊殺不經過 takeDamage()，所以 damageDone 看不到它們；
      // 分開帶出去，讓「傷害 ≥ 擊殺」這條不變式能寫成
      // damageDone + bombKills ≥ kills，而不是把炸彈悄悄算成傷害。
      s.bombKills = tm.bombKills || 0;
      s.score = tm.score;
      s.poolLeft = tm.pool;
      s.survivors = tm.tanks.length;
      s.deaths = (R.DEMO_TANKS_PER_TEAM - tm.pool) - tm.tanks.length;
      s.ownBaseAlive = !G.map.bases[id].dead;
      s.foeBaseKilled = G.map.bases[1 - id].dead;
      s.ownBaseCellsLost = baseCells0[id] - aliveRing(G, id);
      // v7：老鷹被毀時「兇手是誰」由 js/map.js 的 bulletHit 記在 base.killedBy。
      // 只認明確記下來的兇手（炸彈道具、舊存檔等路徑是 null）——
      // 把沒有證據的死亡算成自破，等於憑空懲罰一支无辜的隊伍。
      const ownKiller = G.map.bases[id].killedBy;
      const foeKiller = G.map.bases[1 - id].killedBy;
      s.ownBaseKilledBySelf = G.map.bases[id].dead && ownKiller === id;
      s.foeBaseOwnGoal = G.map.bases[1 - id].dead && foeKiller === (1 - id);
      // 進攻方的「拆牆」證據：敵人要塞牆少了幾格。
      // 掉牆的責任在打他的人身上 —— 自己掉的格數就是對方拆的（同一格不會兩隊同時拆）。
      s.foeWallLost = baseCells0[1 - id] - aliveRing(G, 1 - id);
      s.foeBaseMinDist = Number.isFinite(s.foeBaseMinDist)
        ? Math.round(s.foeBaseMinDist * 10) / 10 : null;
      s.role = tm.role || null;                 // v6：'attack'（藍）／'defense'（紅）
      s.roleLabel = tm.roleLabel || null;
      const cs = hooks.controllers.filter(c => c.team === id);
      s.tanksControlled = cs.length;
      if (cs.length) {
        const hist = new Array(5).fill(0);
        let n = 0;
        for (const c of cs) for (const a of c.actions) { hist[a]++; n++; }
        s.dominance = n ? Math.max(...hist) / n : null;
        s.framesDecided = cs.reduce((a, c) => a + c.frames, 0);
        s.actHist = hist;      // 訓練時的「癱瘓偵測」用整條分佈，不是只看最大值
        s.actN = n;
      }
    }

    const winner = G.demoWinner ? G.demoWinner.id : null;
    const end = G.demoResult ? G.demoResult.reason : null;
    // v7：哪一隊把自己的老鷹打爆（沒有則 null）。判據是 js/map.js 記下的
    // base.killedBy ——「兇手跟老鷹同隊」才算自破，推測的不算。
    const ownGoalTeam = stats.findIndex(s => s.ownBaseKilledBySelf);
    const report = {
      stage: G.demoStageIndex,
      seed: o.seed ?? 1,
      frames,
      capped,
      winner,
      // 終局原因是遊戲自己記的（js/game.js finishDemo），不是這裡推測的：
      //   breach＝紅鷹被毀（藍達成唯一勝利條件）、counter＝藍鷹被毀、
      //   time＝30 秒時鐘到、pool＝雙方兵力耗盡而紅鷹還在。
      // 「拖到時間到」對防守方是勝利、對進攻方是失敗，所以計分一定要看這個，
      // 不能只看 capped（ capped 現在只代表「無頭引擎的保險絲斷了」）。
      end,
      endText: G.demoResult ? G.demoResult.text : null,
      timedOut: end === 'time' || end === 'pool',
      // v7：這一局的終局是不是「自己人打爆自家老鷹」造成的。
      // reason 仍是 breach／counter（使用者要的是「記錄＋罰分」，不是新贏法），
      // ownGoalTeam = 打爆自己家的那一隊；沒有自破時是 null。
      // 判據取 stats[].ownBaseKilledBySelf（來源是 js/map.js 記的 base.killedBy），
      // 而不是只看 demoResult.ownGoal —— 一局裡兩家老鷹不可能同時被毀，
      // 但計分要的是「哪一隊犯的錯」，那個資訊只有在 killedBy 上才準確。
      ownGoal: ownGoalTeam >= 0,
      ownGoalTeam: ownGoalTeam >= 0 ? ownGoalTeam : null,
      attackSeconds: R.DEMO_ATTACK_SECONDS,
      teams: stats,
    };
    G.teamControllerSpecs = null;               // 規格不洩漏到下一局
    if (rec) report.telemetry = rec.finish(G, R, report);
    hooks.controllers.length = 0;
    return report;
  }

  /**
   * 敵車是不是已經踏進「這一隊」的半場？
   * 以自家老鷹在球場哪一側決定：老鷹在底邊 → y >= 中線算自家半場
   * （紅隊反過來）。不用寫死隊伍，地圖對稱換邊也不會判錯。
   */
  inOwnHalf(tank, baseCenter) {
    // 9:21 之後「半場」是高度的一半（FIELD_H/2 = 168px），不是寬。
    // 以前 FIELD_PX 一個數同時是寬也是高，所以這種地方不會寫錯；
    // 現在寫錯不會報錯，只會「幾乎所有車都算在自己半場」——防守計分默默失真。
    const mid = this.R.FIELD_H / 2;
    const cy = tank.box.y + tank.box.h / 2;
    return baseCenter.y >= mid ? cy >= mid : cy <= mid;
  }
}

function aliveRing(G, teamId) {
  const b = G.map.bases[teamId];
  let n = 0;
  for (const [cx, cy] of b.ring) if (G.map.cells[cy][cx] !== 0) n++;
  return n;
}

module.exports = { Arena, acquireEngine, overlaps, centersDist, screensEagle };
