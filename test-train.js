/* test-train.js — 訓練管線的自動測試（競技場 / 適應度 / 斷點續存）
   ═══════════════════════════════════════════════════════════
   跑法：node test-train.js
   重點是「跨 process 接續」：第二代之後重開一支 node，把 checkpoint
   讀回來繼續演化，這才是「今天 100 場、明天接著跑」的真正驗證。
   ═══════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync, spawnSync } = require('child_process');

const { Arena } = require('./ai/arena');
const Observation = require('./ai/observation');
const { teamFitness } = require('./ai/fitness');
const Fitness = require('./ai/fitness');
const { Genome, InnovationHistory } = require('./ai/neat');
const Checkpoint = require('./ai/checkpoint');
const { hashSeed } = require('./ai/rng');
const Live = require('./ai/live');
// 天花板的算法只有一份：ai/balance.js 的 ceilingFor（探針的 --mode ceiling 走的也是它）。
const Balance = require('./ai/balance');

let pass = 0, fail = 0;
function T(name, ok, extra) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}
let T0 = Date.now();
function section(t) {
  const now = Date.now();
  console.log(`\n── ${t} ──` + (t === 'startup' ? '' : ` [上節 ${((now - T0) / 1000).toFixed(1)}s]`));
  T0 = now;
}

const TMP = path.join('runs', '_test');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

function evolve(args) {
  // stderr 也要接進 pipe：否則子 process 預期的「拒絕載入」錯誤訊息會直接
  // 潑到測試輸出裡，看起來像真的當了。
  // --no-live：測試用的假 checkpoint 不該覆寫使用者正在看的即時看板資料。
  return execFileSync(process.execPath, ['ai/evolve.js', '--no-live'].concat(args),
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const arena = new Arena();

// ══════ 1. 競技場：可重現、可注入 ══════
section('arena');
{
  const a = arena.run({ stage: 2, seed: 4242, blue: 'random' });
  const b = arena.run({ stage: 2, seed: 4242, blue: 'random' });
  T('A: 同 (stage, seed, 控制組合) → 完全相同的一局', JSON.stringify(a) === JSON.stringify(b));
  const c = arena.run({ stage: 2, seed: 900, blue: 'random' });
  T('A: 換種子就會換一局', JSON.stringify(a) !== JSON.stringify(c));
  T('A: 訓練競技場維持四點開局（中央開局只給觀戰頁）',
    arena.game.demoOpeningCenter === false);

  const rule = arena.run({ stage: 2, seed: 4242 });
  T('A: 不注入時兩隊都跑規則 AI', rule.teams[0].dominance === null && rule.teams[1].dominance === null);
  T('A: 一局會在幀上限內結束', !rule.capped && rule.frames > 100, rule.frames);
  // v6：終局原因是遊戲自己記的，訓練端只讀它、不推測。
  // 「拖到時間到」對防守方是勝利、對進攻方是失敗，少了這個欄位就無法計分。
  T('A: 報告帶回終局原因、時鐘長度與 timedOut',
    ['breach', 'counter', 'time', 'pool'].includes(rule.end) &&
    rule.attackSeconds === 30 &&
    rule.timedOut === (rule.end === 'time' || rule.end === 'pool'),
    `${rule.end}／${rule.timedOut}／${rule.attackSeconds}s`);
  T('A: 正常一局不會撞無頭引擎保險絲（capped 只代表出錯）',
    rule.capped === false && rule.frames <= 1890, rule.frames);
  T('A: 有擊殺發生', rule.teams[0].kills + rule.teams[1].kills > 0,
    `${rule.teams[0].kills}/${rule.teams[1].kills}`);
  T('A: 出兵數守恆（死亡 + 存活 + 未出兵 = 隊伍總量）',
    rule.teams.every(s => s.deaths + s.survivors + s.poolLeft === arena.R.DEMO_TANKS_PER_TEAM),
    rule.teams.map(s => `${s.deaths}+${s.survivors}+${s.poolLeft}`).join(' vs '));

  const pol = obs => (obs && obs.length === Observation.OBS_DIM ? 4 : null);
  const withPol = arena.run({ stage: 2, seed: 4242, blue: pol });
  T('A: policy 有被叫到（藍隊決策幀 > 0）', withPol.teams[0].framesDecided > 0, withPol.teams[0].framesDecided);
  T('A: policy 只影響藍隊', withPol.teams[1].dominance === null);
  T('A: 觀測維度 = 規格宣告的維度', Observation.OBS_DIM === Observation.OBS_SPEC.dim, Observation.OBS_DIM);

  // ── v8「紅藍的坦克一開始就全部出來，四台」在訓練端的兩條保證 ──
  // ① 開場就出滿 4 台：一局剛跑 150 幀（開場 90 幀 + 60 幀出兵動畫，還沒有人死、
  //    也還沒到補人節奏）時，每隊應該正好是「場上 4 台、池裡剩 16 台」。
  // ② 那 4 台必須聽「這注入的這一隊 spec」：arena 裡 specs／controller 清單
  //    要在 startDemo() 之前準備好，否則開場那 4 台（在全場最久的車）會拿不到 policy，
  //    實測控制權從 100% 掉到 11% —— 分數就變成「規則 AI 的車替網路刷」。
  const opening = arena.run({ stage: 2, seed: 4242, blue: 'random', maxFrames: 150 });
  T('A v8: 開場一次出滿每隊 4 台（場上 4／池剩 16，兩隊都一樣）',
    opening.teams.every(s => s.survivors === arena.R.DEMO_MAX_ON_FIELD &&
      s.poolLeft === arena.R.DEMO_TANKS_PER_TEAM - arena.R.DEMO_MAX_ON_FIELD),
    opening.teams.map(s => `場上 ${s.survivors}／池 ${s.poolLeft}`).join('・'));
  const openingPol = arena.run({ stage: 2, seed: 4242, blue: pol, maxFrames: 150 });
  T('A v8: 開場那 4 台就歸注入的 policy 管（specs 先於 startDemo 設好）',
    openingPol.teams[0].tanksControlled === arena.R.DEMO_MAX_ON_FIELD,
    `控車 ${openingPol.teams[0].tanksControlled} 台／決策 ${openingPol.teams[0].framesDecided} 幀`);
  T('A v8: 對面那隊沒人替它開車（控制只給被注入的一隊）',
    openingPol.teams[1].tanksControlled === 0);

  // v5 半場攔截：以自家老鷹在球場哪一側決定「自家半場」，
  // 不能寫死藍隊就是下半場 —— 地圖對稱換邊時才不會判反。
  T('A: 每隊的計量含 halfDefenseDamage', 'halfDefenseDamage' in rule.teams[0]);
  // v6 新增的計量：進攻要看得見「推進到哪」，防守要看得見「攔了多少」，
  // 自拆要塞要看得見「開了幾槍」。少一個欄位，對應的計分項就默默變 NaN。
  // v11 把 foeWallLost 按「開火瞬間離敵鷹多遠」拆成 near／far 兩堆（同一把 56px 的尺，
  // 跟規則 AI「貼到門口才改瞄主堡」的門檻共用），所以拆牆類一定要三個欄位都在。
  T('A: v6／v11 的進攻／防守／自拆計量都在報告裡',
    ['foeHalfFrames', 'foeBaseMinDist', 'foeWallLost', 'foeWallNear', 'foeWallFar',
      'selfBaseShots', 'supportFrames'].every(k => k in rule.teams[0]),
    Object.keys(rule.teams[0]).join(','));
  // v10 的兩個本業占比同樣要在報告裡（少了欄位，計分項不會報錯，只會靜默變 0）
  T('A: v10 的包圍／門前在場計量都在報告裡，且兩隊都跑規則 AI 時真的有計到（不全是 0）',
    ['besiegeFrames', 'screenFrames'].every(k => k in rule.teams[0]) &&
    rule.teams.some(s => s.besiegeFrames > 0 || s.screenFrames > 0),
    `藍 besiege=${rule.teams[0].besiegeFrames} screen=${rule.teams[0].screenFrames}｜` +
    `紅 besiege=${rule.teams[1].besiegeFrames} screen=${rule.teams[1].screenFrames}`);
  // v11 的拆牆計量要能自己對帳：同一格敵牆一局最多記一次。
  // 鏟子（shovelOn）會把被打掉的牆補回來，不去重的話「拆—長—再拆」就能反覆領分。
  // 近／遠是互斥分類，合起來不得超過敵方要塞的牆格總數；foeWallLost 可以比它小
  // （結算時牆已被鏟子補回），這個差別是有意的：前者問「真的拆過幾格」，
  // 後者問「結算時還少幾格」—— 跑 audit-walls.js 5 4242 看得見整條因果。
  const wallRuns = [4242, 7, 99, 1234].map(seed => arena.run({ stage: 2, seed }));
  const ringTotal = arena.game.map.bases[1].ring.length;
  T('A v11: 拆牆去重後不超過敵方牆格總數（同一格一局只記一次）',
    wallRuns.every(r => r.teams.every(s =>
      s.foeWallNear + s.foeWallFar <= ringTotal &&
      Number.isFinite(s.foeWallNear) && Number.isFinite(s.foeWallFar))),
    `牆格 ${ringTotal}｜` + wallRuns.map(r =>
      r.teams.map(s => `近${s.foeWallNear}/遠${s.foeWallFar}`).join(' ')).join('・'));
  T('A v11: 規則 AI 確實拆到牆（近＋遠有非零的局），不然這一項會在訓練裡靜默失聰',
    wallRuns.some(r => r.teams.some(s => s.foeWallNear + s.foeWallFar > 0)),
    wallRuns.map(r => r.teams.map(s => s.foeWallNear + s.foeWallFar).join('/')).join(' '));
  // 9:21 之後寬高是兩個數：中線只能由高算（FIELD_H/2 = 168），
  // 拿 FIELD_W/2（72）會把「自家半場」判到對手那側去。
  const mid = arena.R.FIELD_H / 2;
  const boxAtY = y => ({ x: 96, y, w: 16, h: 16 });
  T('A: 藍隊（老鷹在底邊）自家半場 = 中線以下',
    arena.inOwnHalf({ box: boxAtY(mid) }, { y: mid + 80 }) === true &&
    arena.inOwnHalf({ box: boxAtY(mid - 40) }, { y: mid + 80 }) === false);
  T('A: 紅隊（老鷹在頂邊）自家半場 = 中線以上',
    arena.inOwnHalf({ box: boxAtY(mid - 40) }, { y: mid - 80 }) === true &&
    arena.inOwnHalf({ box: boxAtY(mid) }, { y: mid - 80 }) === false);

  // v10 的 screenFrames（門前在場）判準：一定要在「老鷹面向來敵那一側」的 56px 圈內。
  // 這一條是純幾何，寫錯不會報錯、只會讓防守分白送 —— 紅隊出生點離自家老鷹
  // 不到 56px，車不動就吃飽，所以四個方位各驗一次。
  {
    const { screensEagle } = require('./ai/arena');
    const own = { x: 72, y: 24 };        // 紅鷹在頂邊
    const foe = { x: 72, y: 312 };       // 藍鷹在底邊：來敵在下方
    const at = (cx, cy) => ({ x: cx - 8, y: cy - 8, w: 16, h: 16 });
    T('A: v10 screenFrames 判準 —— 老鷹與來敵之間算擋，鷹背後與圈外都不算',
      screensEagle(at(72, 64), own, foe) === true &&      // 下方 40px：面向來敵，圈內
      screensEagle(at(72, 79), own, foe) === true &&      // 剛好 55px：仍在圈內
      screensEagle(at(72, 85), own, foe) === false &&     // 59px：出圈
      screensEagle(at(72, -16), own, foe) === false &&    // 上方：窩在鷹背後
      screensEagle(at(120, 24), own, foe) === false &&    // 正側方：不偏來敵那側（點積 0）
      screensEagle(at(72, 64), own, null) === false);     // 沒有敵鷹座標（非對局資料流）
  }
}

// ══════ 1b. 移動行為：不原地轉、不原地上下 ══════
section('movement');
{
  const R = arena.R;
  const clearMap = () => {
    const m = new R.GameMap(0);
    // 18×42：寬高分開迴圈（舊的 GRID 一個數同時當寬跟高，換形狀就會留半邊沒清）
    for (let r = 0; r < R.GRID_H; r++) for (let c = 0; c < R.GRID_W; c++) m.cells[r][c] = 0;
    m.bases = [];
    return m;
  };
  const mkTank = (x, y, dir) => {
    const t = new R.Tank(x, y, dir, false, { speed: 1 });
    t.spawnTimer = 0;
    return t;
  };

  // 轉向必須換到位移：右邊是牆時，連吸附造成的座標變化都要撤回
  {
    const m = clearMap();
    for (let r = 0; r < R.GRID_H; r++) m.cells[r][10] = R.CELL_TYPE.STEEL;
    const t = mkTank(64, 65, R.DIR.UP);
    const moved = t.moveAsAI(R.DIR.RIGHT, m, []);
    T('P: 側面是牆 → 不會原地轉向（座標、朝向都維持）',
      moved === false && t.x === 64 && t.y === 65 && t.dir === R.DIR.UP,
      `${t.x},${t.y},${t.dir}`);
  }

  // 走一步就原路退回 = 使用者看到的「原地上下」；往前走得通時不準反悔
  {
    const m = clearMap();
    const t = mkTank(64, 64, R.DIR.UP);
    const up1 = t.moveAsAI(R.DIR.UP, m, []);
    const y1 = t.y;
    const back = t.moveAsAI(R.DIR.DOWN, m, []);
    T('P: 往前走得通時，不準下一步原路退回（禁止原地上下）',
      up1 && !back && t.y === y1 && t.dir === R.DIR.UP && t.lastMoveDir === R.DIR.UP,
      `y=${t.y} dir=${t.dir}`);
  }

  // 轉向後要有承諾期：只擋原路退回不夠，垂直方向每幀翻面仍是原地鋸齒
  {
    const m = clearMap();
    const t = mkTank(64, 64, R.DIR.UP);
    const right = t.moveAsAI(R.DIR.RIGHT, m, []);
    let stayed = true, stayedMoving = true;
    for (let i = 0; i < 10; i++) {
      const x0 = t.x;
      const ok = t.moveAsAI(R.DIR.DOWN, m, []);
      if (t.dir !== R.DIR.RIGHT) stayed = false;
      if (!ok || t.x === x0) stayedMoving = false;
    }
    T('P: 轉向後有承諾期，不會每幀換方向原地鋸齒',
      right && stayed && stayedMoving, `dir=${t.dir} x=${t.x}`);
  }

  // 但前面真的撞牆時，回頭是有意義的撤退，不能一起鎖死
  {
    const m = clearMap();
    for (let c = 0; c < R.GRID_W; c++) m.cells[6][c] = R.CELL_TYPE.STEEL;  // y=48..55
    const t = mkTank(64, 56, R.DIR.UP);
    t.lastMoveDir = R.DIR.UP;                    // 剛從下面走上來，現在正前方是牆
    const back = t.moveAsAI(R.DIR.DOWN, m, []);
    T('P: 前方撞牆 → 回頭路放行（撤退不是抖動）',
      back && t.dir === R.DIR.DOWN && t.y === 57,
      `y=${t.y} dir=${t.dir}`);
  }

  // 規則 AI 也要遵守同一條規則：逐幀驗「方向變了必有位移」
  {
    const m = clearMap();
    const t = mkTank(64, 64, R.DIR.UP);
    t.aiShootTimer = 1e9;
    const game = {
      map: m, bullets: [],
      foesOf: () => [], ownBaseOf: () => null, foeBaseOf: () => null,
      allTanks: () => [t], frozenFor: () => false,
    };
    let moves = 0, turns = 0, turnsWithoutMove = 0;
    let prev = { x: t.x, y: t.y, dir: t.dir };
    for (let i = 0; i < 600; i++) {
      R.EnemyAI.update(t, game);
      if (t.x !== prev.x || t.y !== prev.y) moves++;
      if (t.dir !== prev.dir) {
        turns++;
        if (t.x === prev.x && t.y === prev.y) turnsWithoutMove++;
      }
      prev = { x: t.x, y: t.y, dir: t.dir };
    }
    T('P: 規則 AI 確實在移動（不是站著等）', moves > 300, `${moves}/600 幀有位移`);
    T('P: 規則 AI 每次轉向都伴隨位移', turnsWithoutMove === 0,
      `${turnsWithoutMove} 次原地轉 / ${turns} 次轉向`);
  }
}

// ══════ 2. v6 規則一致性：角色席位與終局原因 ══════
// 這節原本測的是「藍紅勝率各半」（v5 之前兩隊做同一份工作，不對稱就是 biases）。
// v6 之後「各半」不再是正確的檢查：藍隊只有打掉紅隊老鷹一條贏路，
// 紅隊靠時鐘就贏，所以勝率本來就該偏向紅隊。
// 要釘的是「誰在什麼條件下贏」這條規則，而不是數字好看。
section('v6 rule consistency');
{
  const N = 40;
  const ends = {};
  let blue = 0, red = 0, capped = 0, bad = null;
  for (let i = 0; i < N; i++) {
    const r = arena.run({ stage: i % 6, seed: hashSeed(0xba1, i) });
    ends[r.end] = (ends[r.end] || 0) + 1;
    if (r.capped) capped++;
    if (r.winner === 0) blue++; else if (r.winner === 1) red++; else bad = bad || `第 ${i} 局沒有勝隊`;
    // 進攻方（藍）唯一的贏法
    if (r.winner === 0 && r.end !== 'breach') bad = bad || `第 ${i} 局藍隊靠「${r.end}」贏（規則不允許）`;
    // 時鐘與兵力耗盡都判防守方；藍鷹被毀（counter）也是紅贏
    if (['time', 'pool', 'counter'].includes(r.end) && r.winner !== 1)
      bad = bad || `第 ${i} 局「${r.end}」沒判給紅隊`;
    if (r.end === 'breach' && r.winner !== 0) bad = bad || `第 ${i} 局紅鷹被毀卻不是藍隊贏`;
  }
  T(`B: ${N} 局規則對局：藍只可能因 breach 取勝，時間到／兵力耗盡都判紅隊贏`,
    bad === null, bad || JSON.stringify(ends));
  T('B: 規則局全部在 30 秒上限內收場（沒碰到無頭引擎保險絲）',
    capped === 0 && Object.keys(ends).every(k => ['breach', 'counter', 'time', 'pool'].includes(k)),
    `${capped} 局撞上限｜${JSON.stringify(ends)}`);
  // 這一條是「為什麼進攻模型不能只靠勝負計分」的實證：
  // 規則 AI 互打時藍隊不是每一局都破得了網，只給 breach 那 70 分的話，
  // 早期族群會整代整代拿 0 分、演化停滯（v5 之前真的發生過）。
  // 所以這裡要的是「破網率落在中間」，不是一條上限：
  //   太低（<20%）→ 勝負項幾乎不給分，考題本身退化了；
  //   太高（>90%）→ 尺又變了，變成「誰坐藍席誰拿 70 分」，那時候才真的不需要推進項。
  // 這一格確實隨批次往上走過，都是量出來的（`node ai/balance.js --mode matrix` 的
  // rule·rule，48 局：v9 16.7%＝8/48 → 批次一二＋v10 31.25%＝15/48 → 批次四 37.5%＝18/48；
  // 對照組 rand·rand 同段都是 50%，那是儀器校準，不是行為）。本節自己的 40 局考題
  // （地圖 0..5 × hashSeed(0xba1,i)）實測 50%＝20/40 —— 還在「偶爾才破網」這一側，
  // 這一條要擋的是「進攻標準備註成只靠勝負」，那個理由沒有因為節拍變強而消失。
  T(`B: 規則 AI 互打時藍隊（進攻）只偶爾破網（${blue}/${N}＝${(blue / N * 100).toFixed(1)}%；探針 48 局是 37.5%）→ 進攻標準必須保留推進項`,
    blue / N >= 0.2 && blue / N <= 0.9, `${blue}/${N}｜紅 ${red}`);
  const atkTerms = Fitness.termsFor ? Fitness.termsFor('attack') : null;
  T('B: 進攻標準確實含推進／拆牆／破局三項（不只是「贏了才給分」）',
    ['foeHalf', 'penetration', 'foeWall', 'breach'].every(k => atkTerms.some(t => t.key === k)),
    atkTerms && atkTerms.map(t => t.key).join(','));
}

// ══════ 3. 適應度：兩套評判標準（進攻／防守）＋ v7 自破與貼身 ══════
section('fitness v7');
{
  // fixture 要含計量端全部欄位：少一個，對應的計分項就會靜默變 NaN
  // （這正是 v5 測試在 v6 全紅的原因 —— 所以這裡把欄位一次列齊）。
  const base = () => ({
    kills: 4, deaths: 2, survivors: 2, poolLeft: 6, score: 400, shots: 20, damageDone: 6,
    fieldFrames: 1000, powerups: 1, firepowerUp: 1, ownBaseAlive: true, foeBaseKilled: false,
    ownBaseCellsLost: 0, dominance: 0.4, framesDecided: 900,
    blockedFrames: 0, actN: 900,
    baseDefenseDamage: 0, baseDefenseKills: 0, halfDefenseDamage: 0,
    foeHalfFrames: 0, foeBaseMinDist: null, foeWallLost: 0,
    // v11：拆敵牆依「開火瞬間離敵鷹多遠」分堆（≤56px 算近，其餘算遠）
    foeWallNear: 0, foeWallFar: 0,
    selfBaseShots: 0, supportFrames: 0,
    // v10：包圍敵鷹（進攻本業）／門前擋在場（防守本業，只算靠敵那一側）
    besiegeFrames: 0, screenFrames: 0,
    // v7：貼身殲滅（使用者規則「兩台坦克太接近時先解決對方坦克」）
    duelKills: 2, duelFrames: 150,
    // v7：自家老鷹是被自己人打爆的／敵家老鷹是自己人打爆的
    ownBaseKilledBySelf: false, foeBaseOwnGoal: false,
  });
  const END = { winner: 0, end: 'breach' };
  const rep = (s, o = {}) => {
    const winner = o.winner !== undefined ? o.winner : END.winner;
    const end = o.end !== undefined ? o.end : END.end;
    return {
      winner, frames: o.frames !== undefined ? o.frames : 2000, capped: !!o.capped,
      teams: [s, base()], end,
      timedOut: end === 'time' || end === 'pool',   // v6：時鐘到／兵力耗盡都算「拖時間」
      attackSeconds: 30,
    };
  };
  const A = (s, o) => teamFitness(s, rep(s, o), 0, {});     // 藍席＝進攻
  const D = (s, o) => teamFitness(s, rep(s, o), 1, {});     // 紅席＝防守
  // 逐項拆解：v10 有幾項是「混在同一批數字裡」的本業項（holdGate 吃攔截量也吃
  // 門前占比、denial 吃對手的推進），直接比總分會看不出門檻本身有沒有生效。
  const rowOf = (s, o, seat, key) =>
    Fitness.scoreOf(s, rep(s, o), seat, {}).rows.find(r => r.key === key);
  const f = A(base());
  const d = D(base(), { winner: 1, end: 'counter' });

  // 版本號是 checkpoint 判斷「冠軍要不要先重評」的唯一依據（ai/evolve.js 讀
  // meta.champion.scoringVersion !== SCORING_VERSION），所以這一行真正的用途是：
  // 有人改了尺卻忘了升版本時，讓測試攔下來——不然舊冠軍會帶著新尺的分數繼續當冠軍。
  T('F: 算分版本升到 14（v14 是把三項「選不動的項」改成有梯度的口徑：accuracy 每殺發數、spray 門檻隨量、annihilation 封頂 6×8），且兩套標準各自成表（進攻 24 項／防守 23 項）',
    Fitness.SCORING_VERSION === 14 &&
    Fitness.termsFor('attack').length === 24 && Fitness.termsFor('defense').length === 23,
    `v${Fitness.SCORING_VERSION}：${Fitness.termsFor('attack').length}/${Fitness.termsFor('defense').length}`);
  // v10 的全部道理都在「兩席的本業上限要一樣高」這句話上：上限不對等，
  // 「換上自己模型的加分」就天生一邊多一邊少（探針量到 4.8×），起步就談不上平衡。
  // 天花板的算法只有一份（ai/balance.js 的 ceilingFor：合成成績每項打滿），
  // 測試直接叫它，不在這裡另寫一套——另寫一套的話，改權重時就會一邊過、一邊不過。
  const ceilOf = seat => Balance.ceilingFor(seat);
  const cA = ceilOf('attack'), cD = ceilOf('defense');
  T('F: 兩席的本業（勝負＋推進／攔截）上限同高 —— 攻守的「可爬空間」必須對等',
    Math.abs(cA.job - cD.job) <= 10,
    `進攻 ${cA.job.toFixed(0)}／防守 ${cD.job.toFixed(0)}`);
  T('F: 每一席的本業上限都由「席位才做得到的事」構成（探針分组缺項就會亮）',
    ['breach', 'besiege', 'foeWall'].every(k => cA.rows.some(r => r.key === k && r.contribution > 0)) &&
    ['holdWin', 'holdGate', 'denial', 'defense', 'halfDefense']
      .every(k => cD.rows.some(r => r.key === k && r.contribution > 0)),
    `進攻 ${cA.rows.filter(r => r.contribution > 0).length} 項／` +
    `防守 ${cD.rows.filter(r => r.contribution > 0).length} 項`);
  T('F: 本業佔自己天花板 ≥40%（B 的驗收：不問角色的戰鬥項不能還是主軸）',
    cA.job / cA.total >= 0.4 && cD.job / cD.total >= 0.4,
    `進攻 ${(cA.job / cA.total * 100).toFixed(0)}%（戰鬥 ${cA.byGroup.combat.toFixed(0)}）｜` +
    `防守 ${(cD.job / cD.total * 100).toFixed(0)}%（戰鬥 ${cD.byGroup.combat.toFixed(0)}）`);
  // penetration 那 10 分用的是「半場距離」這個尺。尺一定要跟著戰場高度走：
  // 寫死 104（26×26 時代）會讓 9:21 的長場永遠拿不到滿分，而這是「尺歪了」
  // 那種不會報錯、只會讓網路學歪的錯，所以直接跟 arena 的幾何對一次。
  T('F: 半場尺 === FIELD_H/2（換形狀時必須一起動，否則 penetration 永遠補滿）',
    Fitness.HALF_FIELD_PX === arena.R.FIELD_H / 2 && Fitness.HALF_FIELD_PX === 168,
    `${Fitness.HALF_FIELD_PX} vs FIELD_H/2=${arena.R.FIELD_H / 2}`);
  T('F: 兩套標準互斥 —— 進攻表沒有防守項、防守表沒有破網項',
    ['defense', 'halfDefense', 'holdWin', 'holdGate'].every(k =>
      !Fitness.termsFor('attack').some(t => t.key === k)) &&
    ['breach', 'timeoutFail', 'foeHalf', 'penetration', 'foeWall'].every(k =>
      !Fitness.termsFor('defense').some(t => t.key === k)),
    Fitness.termsFor('attack').map(t => t.key).join(','));
  T('F: 同一個 key 在兩套標準裡可以不同權重（ownBaseAlive 6 vs 14）',
    Fitness.weightOf(Fitness.TERMS.find(t => t.key === 'ownBaseAlive'), 'attack') === 6 &&
    Fitness.weightOf(Fitness.TERMS.find(t => t.key === 'ownBaseAlive'), 'defense') === 14);

  // 探針的 --terms（落地後才加的）：階梯一旦反向，「均分」只說「不對」，
  // 逐項差值才說得出「哪一項在發錢」。選項要能被解析、也要能在用錯模式時擋下來，
  // 否則跑了一整輪（幾百局）才發現沒開這個欄位。
  T('F: 探針 --terms 只準配 ladder；選項解析與防呆都在（跑完才發現沒開欄位太貴）',
    Balance.parseArgs(['--mode', 'ladder', '--terms']).terms === true &&
    Balance.parseArgs(['--mode', 'ladder']).terms === false &&
    (() => { try { Balance.parseArgs(['--mode', 'matrix', '--terms']); return false; }
      catch (e) { return /--terms/.test(e.message); } })() &&
    (() => { try { Balance.parseArgs(['--mode', 'ceiling', '--terms']); return false; }
      catch (e) { return /--terms/.test(e.message); } })(),
    'ladder 可開、matrix／ceiling 要報錯');

  T('F: 正常一局有正分（兩個角色都是）', f > 0 && d > 0, `${f.toFixed(2)} / ${d.toFixed(2)}`);

  // ── v7 兩條使用者規則在「訓練標準」這一端的落點 ──
  // ① 「自己人把自己的老鷹打死，要記錄，然後列入訓練標準，避免自己殺自己」
  //    → ownEagleBySelf（-80）＋ 本局歸零的地板。
  // ② 「紅藍的坦克如果太過接近，目標要修改成先解決對方的坦克」
  //    → duelKill（貼身每台 +6，封 4 台；v10 把不問角色的戰鬥項天花板壓下來，
  //      單位價從 8 降到 6，規則本身沒動）。規則端在 js/ai.js，計量端在 ai/arena.js。
  // 這裡只驗「記了之後真的會改變分數」；分數不改，網路永遠學不到。
  {
    const row = (ex, k) => { const r = ex.allItems.find(x => x.key === k); return r ? r.contribution : null; };
    const exA = (s, o) => Fitness.explainFitness(s, rep(s, o || {}), 0, {});   // 藍席＝進攻
    const exD = (s, o) => Fitness.explainFitness(s, rep(s, o || {}), 1, {});   // 紅席＝防守
    const T7 = Fitness.TERMS.find(t => t.key === 'ownEagleBySelf');
    const D7 = Fitness.TERMS.find(t => t.key === 'duelKill');

    T('F v7: 自破老鷹（-80）比破網（+70）還重，且兩套標準都收這兩項',
      !!T7 && !!D7 &&
      Fitness.weightOf(T7, 'attack') === -80 && Fitness.weightOf(T7, 'defense') === -80 &&
      Fitness.weightOf(D7, 'attack') === 6 && Fitness.weightOf(D7, 'defense') === 6 &&
      ['attack', 'defense'].every(r =>
        Fitness.termsFor(r).some(t => t.key === 'ownEagleBySelf') &&
        Fitness.termsFor(r).some(t => t.key === 'duelKill')),
      T7 && D7 ? `${Fitness.weightOf(T7, 'attack')}/${Fitness.weightOf(D7, 'attack')}` : 'term 不存在');

    // 地板存在的意義：只有 -80 那一項的話，「打爆自己家但順帶破網成功」
    // （+70）加上早結束的 speed 分，淨值可能又變正 —— 那種個體如果有分，
    // 等於告訴網路這件事可以接受。
    const sin = base(); sin.ownBaseKilledBySelf = true; sin.foeBaseKilled = true; sin.duelKills = 4;
    // ⚠ v13 之後 breach 要看殲滅實績：這裡把 kills 湊到門檻（6 台），讓「+70」這句話
    //   在這裡仍然是字面意義 —— 這一節驗的是 v7 那條地板，不是 v13 那道門檻（門檻另有測試）。
    sin.kills = Fitness.BREACH_KILL_PROOF;
    const eSin = exA(sin, { winner: 0, end: 'breach' });
    T('F v7: 自己打爆自家老鷹 → 本局分數歸 0（連破網與貼身殲滅一起抹平）',
      eSin.sum > 0 && eSin.total === 0 && eSin.ownGoal === true &&
      row(eSin, 'ownEagleBySelf') === -80 &&
      eSin.floors.some(fl => fl.label.startsWith('自己打爆自家老鷹')),
      `加總 ${eSin.sum.toFixed(2)} → 結算 ${eSin.total}`);

    // 反刷分：對手自己把家打爆時，規則上我們贏了，但這個勝利不是我們打出來的。
    const merit = base(); merit.kills = Fitness.BREACH_KILL_PROOF;   // 同上：breach 要拿滿才比得出「戰功 vs 得利」
    const eMerit = exA(merit, { winner: 0, end: 'breach' });
    const lucky = Object.assign({}, merit); lucky.foeBaseOwnGoal = true; lucky.foeBaseKilled = true;
    const eGift = exA(lucky, { winner: 0, end: 'breach' });
    T('F v7: 對手自破 → 這局的贏不計戰功（breach／speed 都歸 0，但 won 仍是事實）',
      eMerit.won === true && eMerit.winByMerit === true && row(eMerit, 'breach') === 70 &&
      eGift.won === true && eGift.winByMerit === false &&
      row(eGift, 'breach') === 0 && row(eGift, 'speed') === 0 && eGift.total < eMerit.total,
      `實贏 ${eMerit.total.toFixed(2)}／得利 ${eGift.total.toFixed(2)}`);

    const dStat = () => { const s = base(); s.baseDefenseDamage = 6; return s; };
    const eDMerit = exD(dStat(), { winner: 1, end: 'time' });
    const dLucky = dStat(); dLucky.foeBaseOwnGoal = true;
    const eDGift = exD(dLucky, { winner: 1, end: 'counter' });
    T('F v7: 防守席一樣 —— 靠對手自破拿下的「贏」不給 holdWin／holdGate',
      row(eDMerit, 'holdWin') > 0 && row(eDMerit, 'holdGate') > 0 &&
      eDGift.won === true && eDGift.winByMerit === false &&
      row(eDGift, 'holdWin') === 0 && row(eDGift, 'holdGate') === 0,
      `holdWin ${row(eDMerit, 'holdWin')}→${row(eDGift, 'holdWin')}｜` +
      `holdGate ${row(eDMerit, 'holdGate')}→${row(eDGift, 'holdGate')}`);

    const dk = n => { const s = base(); s.duelKills = n; return exA(s); };
    T('F v7: 貼身殲滅每台 +6、每局封在 4 台（不封頂會單項吃滿整張表）',
      row(dk(0), 'duelKill') === 0 && row(dk(2), 'duelKill') === 12 && row(dk(10), 'duelKill') === 24,
      `0→${row(dk(0), 'duelKill')} 2→${row(dk(2), 'duelKill')} 10→${row(dk(10), 'duelKill')}`);

    T('F v7: 沒貼身殲滅不代表懲罰（duelKill 是純加分項，不設門檻）',
      exA(base()).total > 0 && dk(4).total > dk(0).total,
      `${dk(0).total.toFixed(2)} → ${dk(4).total.toFixed(2)}`);
  }

  // ── v12 激烈度（批次六）：把「打死人」變成一筆存得下來的錢 ──────────
  // 起因是量的，不是觀感（`node audit-intensity.js 120`，runs/audit-intensity.log）：
  //   現任雙冠軍對打 平均 9.7 秒收場／中位 8.8 秒／每場 5.9 殺／112 發／19.1 發才換一台
  //   同一份考題的規則 AI   25.6 秒／12.8 殺／54 發／4.2 發一殺
  // 互射占比反而是模型的 60.9% 對規則的 9.0% ⇒ 缺的不是交火，是殲滅與收尾。
  // 病根在尺：killPer1k／damagePer1k 是流量計量（一局縮到 9 秒，分子分母一起縮小、
  // 比例照樣坐滿），而 breach(70)＋speed(20) 讓「繞過所有人直取老鷹」變成最優解。
  // 下面逐條釘住的正是這四件事，外加「新項要換掉預算、不是疊上去」那條紀律。
  {
    const ex12 = (s, o) => Fitness.explainFitness(s, rep(s, o || {}), 0, {});   // 藍席＝進攻
    const r12 = (ex, k) => ex.allItems.find(x => x.key === k);
    const killStat = n => { const s = base(); s.kills = n; return s; };

    const AN = Fitness.TERMS.find(t => t.key === 'annihilation');
    T('F v12／v14: 殲滅是尺上第一筆不看時長的「總量」戰功；v14 把分配改成封頂 6 台 × 每台 8 分（48 不變）',
      !!AN && Fitness.weightOf(AN, 'attack') === 8 && Fitness.weightOf(AN, 'defense') === 8 &&
      Fitness.ANNIHILATION_CAP === 6 &&
      Fitness.termsFor('defense').some(t => t.key === 'annihilation') &&
      r12(ex12(killStat(0)), 'annihilation').contribution === 0 &&
      r12(ex12(killStat(5)), 'annihilation').contribution === 40 &&
      r12(ex12(killStat(6)), 'annihilation').contribution === 48 &&
      r12(ex12(killStat(20)), 'annihilation').contribution === 48,
      AN ? `封頂 ${Fitness.ANNIHILATION_CAP} 台 × ${Fitness.weightOf(AN, 'attack')}＝${Fitness.ANNIHILATION_CAP * Fitness.weightOf(AN, 'attack')}` : 'term 不存在');

    // 這一段是 v12 的全部道理：把「速決但空手」與「殲滅但慢」放在一起比總分。
    // 舊尺下速決吃 speed 滿檔（20）而空手無罰；新尺下 speed 要實績、殲滅另計。
    const sprint = killStat(0);
    const eSprint = ex12(sprint, { frames: 480, winner: 0, end: 'breach' });     // 8 秒斬首、零殲滅
    const grind = base();                                                        // kills 4（實績滿檔）
    const eGrind = ex12(grind, { frames: 1500, winner: 0, end: 'breach' });      // 25 秒清場再破網
    T('F v12: 速決但一台沒打死 → speed 歸 0（v11 之前那是接近滿分的一項）',
      r12(eSprint, 'speed').contribution === 0 && eSprint.winByMerit === true,
      `8 秒（480 幀）破網、零殲滅 ⇒ speed ${r12(eSprint, 'speed').contribution}`);
    T('F v12: 「殲滅但慢」打得過「速決但空手」—— 打死人比早收場值錢',
      eGrind.total > eSprint.total + 20,
      `清場 ${eGrind.total.toFixed(1)}（殲滅 ${r12(eGrind, 'annihilation').contribution}＋` +
      `speed ${r12(eGrind, 'speed').contribution.toFixed(1)}）vs 速決 ${eSprint.total.toFixed(1)}`);

    // ⚠ v14 動了 accuracy 的口徑（原來的「每發平均傷害」在族群裡大家都貼 0，選不動）：
    //   現在它讀「每 1 殺發數」的斜坡，所以這裡的 fixture 要用 (kills, shots) 這一對來寫。
    const accStat2 = (kills, shots) => { const s = base(); s.kills = kills; s.shots = shots; s.damageDone = 4 * kills; return ex12(s); };
    T(`F v14: 準頭讀「每 1 殺發數」—— ${Fitness.ACCURACY_SPK_ZERO} 發＝0、${Fitness.ACCURACY_SPK_FULL} 發＝滿 ${Fitness.ACCURACY_MONEY} 分，中間是直的（舊口徑的梯度死在封頂下面）`,
      r12(accStat2(5, 100), 'accuracy').contribution === 0 &&
      r12(accStat2(5, 30), 'accuracy').value === 1 &&
      r12(accStat2(5, 30), 'accuracy').contribution === Fitness.ACCURACY_MONEY &&
      // 斜坡中點＝每 1 殺 13 發（20 與 6 的正中間），所以 2 殺要 26 發
      r12(accStat2(2, 26), 'accuracy').value === 0.5 &&
      r12(accStat2(2, 26), 'accuracy').contribution === Fitness.ACCURACY_MONEY * 0.5 &&
      Fitness.weightOf(Fitness.TERMS.find(t => t.key === 'accuracy'), 'attack') === 8,
      `${Fitness.ACCURACY_SPK_ZERO}→${Fitness.ACCURACY_SPK_FULL} 發一殺的斜坡，滿分 ${Fitness.ACCURACY_MONEY}`);
    T('F v14: 一槍沒開不給準頭分（否則「不打」會被讀成「打得真準」）',
      r12(accStat2(0, 0), 'accuracy').contribution === 0 &&
      r12(accStat2(4, 0), 'accuracy').contribution === 0,
      'shots＝0 ⇒ accuracy 0');

    const sprayStat2 = (kills, shots) => { const s = base(); s.kills = kills; s.shots = shots; return ex12(s); };
    // 直接指定「每 1 殺發數」的 fixture（5 殺 × spk 發），用來掃兩段口徑的接縫
    const sprayStat2Raw = spk => { const s = base(); s.kills = 5; s.shots = Math.round(5 * spk); return s; };
    T(`F v14: 彈雨的罰改跟著「每殺耗彈」走——大於 ${Fitness.SPRAY_SHOTS_MIN} 發才判、${Fitness.ACCURACY_SPK_ZERO} 發一殺起罰、${Fitness.SPRAY_SPK_MAX} 發罰滿 -30`,
      r12(sprayStat2(3, Fitness.SPRAY_SHOTS_MIN), 'spray').contribution === 0 &&
      r12(sprayStat2(5, 100), 'spray').contribution === 0 &&
      r12(sprayStat2(2, 60), 'spray').contribution === -15 &&
      r12(sprayStat2(1, 60), 'spray').contribution === -30 &&
      Fitness.weightOf(Fitness.TERMS.find(t => t.key === 'spray'), 'attack') === -30,
      `起罰 ${Fitness.ACCURACY_SPK_ZERO}／罰滿 ${Fitness.SPRAY_SPK_MAX}，30 發那道「樣本要夠大」保留`);
    T('F v14: accuracy 與 spray 的兩段不重疊——每殺 20 發是分界，獎的那段不會同時被罰',
      [8, 12, 16, 19].every(spk => {
        const r = ex12(sprayStat2Raw(spk));
        return r.allItems.find(x => x.key === 'spray').contribution === 0;
      }) && (() => {
        const r = ex12(sprayStat2Raw(24));
        return r.allItems.find(x => x.key === 'accuracy').contribution === 0 &&
          r.allItems.find(x => x.key === 'spray').contribution < 0;
      })(),
      '6～20 發那段只發獎、20 發以上那段只處罰');

    // 新項是「換掉」流量項的預算，不是疊在尺上：通用交戰軸的天花板維持 v11 的 242，
    // 否則「本業佔自己天花板 ≥40%」那條 v10 驗收會被新增項悄悄稀釋（實測 44%→38%）。
    T('F v12: 加項不長總量 —— 通用交戰軸天花板釘在 242（v11 是 241.5，那 +0.5 全來自 accuracy 7.5→8.0），本業比例仍 ≥40%',
      Math.abs(cA.byGroup.combat - 242) < 0.01 && Math.abs(cD.byGroup.combat - 242) < 0.01 &&
      cA.job / cA.total >= 0.4 && cD.job / cD.total >= 0.4,
      `戰鬥 攻 ${cA.byGroup.combat.toFixed(0)}／守 ${cD.byGroup.combat.toFixed(0)}｜` +
      `本業占比 ${(100 * cA.job / cA.total).toFixed(1)}%／${(100 * cD.job / cD.total).toFixed(1)}%`);
    T('F v12: 探針的軸分組收得到每一項（新項漏進 GROUP 會讓「本業佔天花板」靜默失真）',
      [cA, cD].every(c => Math.abs(c.byGroup.objective + c.byGroup.process + c.byGroup.combat +
        c.byGroup.discipline - c.total) < 0.01),
      `攻 ${cA.byGroup.objective.toFixed(1)}+${cA.byGroup.process.toFixed(1)}+${cA.byGroup.combat.toFixed(1)} vs 總 ${cA.total.toFixed(1)}`);
    T('F v12: 版本注記寫清楚「這一版動了哪幾項」（收斂曲線接縫要看得懂是尺變了、不是車變弱）',
      /v12/.test(Fitness.SCORING_VERSION_NOTE) &&
      /annihilation|殲滅/.test(Fitness.SCORING_VERSION_NOTE) &&
      /speed/.test(Fitness.SCORING_VERSION_NOTE) && /spray/.test(Fitness.SCORING_VERSION_NOTE) &&
      /killPer1k/.test(Fitness.SCORING_VERSION_NOTE),
      Fitness.SCORING_VERSION_NOTE.slice(0, 60) + '…');
  }

  // ── v13 破局的殲滅實績門檻（批次七）──────────────────────────────
  // v12 落實以後的第四次讀數（`node audit-intensity.js 120`，兩席成熟冠軍、藍 4064／紅 4026）：
  //   中位終局 10.8 秒／每場擊殺 8.4 台／每 1 殺 14.5 發 —— 三條線都往對的方向走、也都還沒到，
  //   而且 120 局裡 38.3% 還在 10 秒內收場。`--mode matrix` 那格講得最明白：
  //   進攻席最大的單一項還是 breach ＋40.83／局（發放率 58.3%、不問清了幾台），局均 573 幀＝9.6 秒。
  // ⇒ 「先清人再破網」與「繞過所有人直取老鷹」同分，尺沒在選前者。v13 就是把這條捷徑關掉。
  // 下面釘的是門檻的形狀、門檻不吃掉稀有事件本身、以及「換尺不動老師」那條紀律。
  {
    const ex13 = (s, o) => Fitness.explainFitness(s, rep(s, o || {}), 0, {});
    const r13 = (ex, k) => ex.allItems.find(x => x.key === k);
    const k13 = n => { const s = base(); s.kills = n; return s; };
    const WON = { winner: 0, end: 'breach' };                 // 破網取勝（同格局、只換擊殺數）
    const P = Fitness.BREACH_KILL_PROOF;

    T(`F v13: breach 由「打破就值 70」改成「打破 × min(1, 擊殺/${P})」（0 台→0、3 台→半額、${P} 台→拿滿、超過不加）`,
      P === 6 && r13(ex13(k13(0), WON), 'breach').contribution === 0 &&
      r13(ex13(k13(3), WON), 'breach').contribution === 35 &&
      r13(ex13(k13(P), WON), 'breach').contribution === 70 &&
      r13(ex13(k13(20), WON), 'breach').contribution === 70,
      `門檻 ${P} 台｜滿額 70`);

    // 這一條是 v13 的全部道理：同一種「打破老鷹」的結局，只差在場上有沒有真的清出人。
    T('F v13: 空手斬首（8 秒破網、一台沒打死）拿不到勝負分，而「清人再破網」照樣拿滿 —— 捷徑關掉了',
      r13(ex13(k13(0), { frames: 480, ...WON }), 'breach').contribution === 0 &&
      r13(ex13(k13(P), { frames: 480, ...WON }), 'breach').contribution === 70 &&
      ex13(k13(P), { frames: 480, ...WON }).total >
      ex13(k13(0), { frames: 480, ...WON }).total + 50,
      `速決空手 ${ex13(k13(0), { frames: 480, ...WON }).total.toFixed(1)} vs 速決清場 ${ex13(k13(P), { frames: 480, ...WON }).total.toFixed(1)}`);

    // 但不能把「贏了卻沒清夠」打成 0 分地板：那正是批次一研究裡「0 分地板讓選壓消失」那個坑。
    T('F v13: 空手斬首不歸零（其它項照給）—— 贏局仍留梯度，否則進攻席會整片同分',
      ex13(k13(0), WON).total > 0 &&
      ex13(k13(0), WON).sum === ex13(k13(0), WON).total,
      `零殲滅破網 ${ex13(k13(0), WON).total.toFixed(2)}`);

    T('F v13: 擊殺愈多分數不減（breach 門檻與 annihilation 同向，沒有「多殺人反而扣」的反轉）',
      [0, 1, 2, 3, 4, 5, 6, 8, 12].every((n, i, arr) =>
        i === 0 || ex13(k13(n), WON).total >= ex13(k13(arr[i - 1]), WON).total),
      `0→12 殺：${[0, 3, 6, 12].map(n => ex13(k13(n), WON).total.toFixed(1)).join(' / ')}`);

    // 分層的證據：門檻那兩個字（BREACH_KILL_PROOF／min(1, 擊殺)）只出現在計分端。
    // 規則端要是知道了「要清幾台才算贏」，那就不是換尺、是改遊戲規則（那是另一個決定）。
    T('F v13: 門檻只活在計分端 —— js/ 那幾支規則檔不認識它（破局在規則上照樣算藍隊贏，由 B 節釘住）',
      (() => {
        const fs = require('fs'), path = require('path');
        const files = ['ai.js', 'game.js', 'entities.js', 'map.js', 'constants.js', 'mapgen.js'];
        return files.every(n => {
          const src = fs.readFileSync(path.join(__dirname, 'js', n), 'utf8');
          return !/BREACH_KILL_PROOF|min\(1, 擊殺/.test(src);
        }) && Fitness.BREACH_KILL_PROOF === 6;
      })(),
      'js/ai.js…mapgen.js 六支規則檔都不含門檻常數');

    T('F v13: breach 仍是進攻表最大的一項（門檻只打折發放、沒有把它降成普通項）',
      (() => {
        const atk = Fitness.termsFor('attack');
        const b = Fitness.weightOf(atk.find(t => t.key === 'breach'), 'attack');
        return b === 70 && atk.every(t => t.key === 'breach' || Fitness.weightOf(t, 'attack') <= b);
      })() && r13(ex13(k13(P), WON), 'breach').contribution === 70,
      `權重仍 70，滿額實績下照樣是全表最大單項`);

    T('F v13: 防守席不受影響（防守表沒有 breach 項，holdWin／holdGate 的算式一個字都沒動）',
      !Fitness.termsFor('defense').some(t => t.key === 'breach') &&
      Fitness.formulaOf(Fitness.TERMS.find(t => t.key === 'holdWin'), 'defense') ===
      Fitness.termsFor('defense').find(t => t.key === 'holdWin').formula &&
      /撐過時鐘|0\.4/.test(Fitness.termsFor('defense').find(t => t.key === 'holdWin').formula),
      '防守 23 項、勝負兩檔不變');

    T('F v13: 天花板三條不變量仍在（門檻不稀釋本業占比；合成成績每項打滿時 kills 40 ≥ 門檻）',
      Math.abs(cA.total - 419.80) < 0.01 && Math.abs(cD.total - 428.93) < 0.01 &&
      Math.abs(cA.job - cD.job) <= 10 &&
      cA.job / cA.total >= 0.4 && cD.job / cD.total >= 0.4 &&
      Math.abs(cA.byGroup.combat - 242) < 0.01,
      `攻 ${cA.total.toFixed(2)}／守 ${cD.total.toFixed(2)}｜本業 ${(100 * cA.job / cA.total).toFixed(1)}%／${(100 * cD.job / cD.total).toFixed(1)}%｜差 ${Math.abs(cA.job - cD.job).toFixed(2)}`);

    T('F v13: 版本注記寫清楚這一把動的是 breach 門檻、代價是進攻席掉分與信噪比',
      /v13/.test(Fitness.SCORING_VERSION_NOTE) && /breach/.test(Fitness.SCORING_VERSION_NOTE) &&
      new RegExp('min\\(1, 擊殺數/' + P + '\\)').test(Fitness.SCORING_VERSION_NOTE) &&
      /信噪比|排序/.test(Fitness.SCORING_VERSION_NOTE) &&
      /js\/ai\.js/.test(Fitness.SCORING_VERSION_NOTE),
      Fitness.SCORING_VERSION_NOTE.slice(0, 46) + '…');
  }

  const long = base();
  long.fieldFrames *= 3; long.kills *= 3; long.damageDone *= 3; long.shots *= 3;
  long.powerups *= 3; long.firepowerUp *= 3;
  // ⚠ 這條在比的是「逐幀歸一化」，所以要讓兩端的**開關項處在同一檔**：
  //   v13 之後 breach 看殲滅實績（kills 4→0.67、12→1.0），直接拿 f 當分母會把
  //   「門檻爬完」誤讀成「拉長局數讓分數暴衝」（實測比值 1.44，超出 1.35）。
  //   分母改成「殲滅實績已拿滿」的同款成績（kills 6＝門檻），兩端只剩流量項的歸一化差異。
  const fFull = base(); fFull.kills = Fitness.BREACH_KILL_PROOF;
  const ratio = A(long) / A(fFull);
  T('F: 整局拉長 3 倍但節奏不變 → 分數只小幅變動（逐幀歸一化生效；分母同站門檻內側，不然量到的是 v13 那道門）',
    ratio > 0.75 && ratio < 1.35, ratio.toFixed(2));

  const turtle = base();
  Object.assign(turtle, { kills: 0, shots: 0, damageDone: 0, powerups: 0, firepowerUp: 0,
    fieldFrames: 30, actN: 0 });
  T('F: 整局躺平 → 0 分', A(turtle, { winner: null, end: 'time' }) === 0);

  const spray = base(); spray.shots = 400;
  T('F: 亂槍掃射比打得準的分數低', A(spray) < f, `${A(spray).toFixed(1)} vs ${f.toFixed(1)}`);

  const suicide = base(); suicide.deaths = 18; suicide.kills = 18;
  T('F: 同傷交換（互換命）不會比穩健打法高分',
    A(suicide, { winner: null, end: 'time' }) < f);

  // 自家老鷹被毀：v6 兩個角色的終局條件都含這一條，所以一律封頂。
  const owo = base(); owo.ownBaseAlive = false; owo.ownBaseCellsLost = 8;
  const fOwo = A(owo, { winner: null, end: 'counter' });
  const dOwo = D(owo, { winner: 0, end: 'breach' });
  T('F: 進攻方被反拆家 → 封頂在「守住老鷹」的固定分之下（不是歸零，要留梯度）',
    fOwo < f && fOwo <= 2, fOwo.toFixed(2));
  T('F: 防守方被破網 → 封頂 10（守住老鷹是 14 分，被拆就是比較爛）',
    dOwo < d && dOwo <= 10, dOwo.toFixed(2));
  const owoIdle = Object.assign(owo, { kills: 0, shots: 0, damageDone: 0, powerups: 0, firepowerUp: 0 });
  T('F: 被拆家時仍保留梯度（有擊殺 > 毫無作為；早期全代 0 分才會真的停滯）',
    fOwo > A(owoIdle, { winner: null, end: 'counter' }),
    `${fOwo.toFixed(1)} vs ${A(owoIdle, { winner: null, end: 'counter' }).toFixed(1)}`);

  const winFast = Object.assign(base(), { fieldFrames: 800 });
  const winSlow = Object.assign(base(), { fieldFrames: 4000 });
  T('F: 進攻方贏得快比贏得失分高（speed 讀 rep.frames）',
    teamFitness(winFast, { winner: 0, frames: 900, capped: false, teams: [winFast, base()], end: 'breach', timedOut: false }, 0, {})
    > teamFitness(winSlow, { winner: 0, frames: 1700, capped: false, teams: [winSlow, base()], end: 'breach', timedOut: false }, 0, {}));

  // stalemate 量的是「無頭引擎的保險絲斷了」，與時鐘到是兩件不同的事，
  // 所以用同一個 end 比 capped 前後，差額必須剛好等於那一項的權重。
  // 分數是小數加總，比較差額要用容差，不能用 === （34.1 - 18 ≠ 16.1）。
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  T('F: 跑到保險絲還沒結果 → 兩個角色都扣 stalemate 那 18 分',
    near(A(base(), { winner: null, frames: 2400, capped: true, end: 'time' }),
         A(base(), { winner: null, frames: 1800, end: 'time' }) - 18) &&
    near(D(base(), { winner: null, frames: 2400, capped: true, end: 'time' }),
         D(base(), { winner: null, frames: 1800, end: 'time' }) - 18),
    `${A(base(), { winner: null, frames: 2400, capped: true, end: 'time' }).toFixed(1)}｜${D(base(), { winner: null, frames: 2400, capped: true, end: 'time' }).toFixed(1)}`);

  // ── 進攻角色專屬 ──
  T('F: 摧毀紅隊老鷹（breach）是進攻表最大的一項 —— 它是進攻方的全部目標',
    (() => {
      const atk = Fitness.termsFor('attack');
      const b = Fitness.weightOf(atk.find(t => t.key === 'breach'), 'attack');
      // 權重要用 weightOf 取：ownBaseAlive／speed 是 {attack, defense} 兩套。
      return atk.every(t => t.key === 'breach' ||
        Fitness.weightOf(t, 'attack') <= b);
    })(),
    `breach ${Fitness.TERMS.find(t => t.key === 'breach').weight}`);
  const late = base(); late.foeHalfFrames = 500; late.foeBaseMinDist = 20; late.foeWallNear = 4;
  T('F: 沒破網但真的推進（壓進敵半場／貼到敵鷹／拆掉要塞牆）有分',
    A(late, { winner: 1, end: 'time' }) > A(base(), { winner: 1, end: 'time' }),
    `${A(late, { winner: 1, end: 'time' }).toFixed(1)} vs ${A(base(), { winner: 1, end: 'time' }).toFixed(1)}`);
  T('F: 拖到 30 秒時間到 = 進攻方失敗，扣掉 timeoutFail 那 25 分',
    near(A(base(), { winner: 1, end: 'time' }),
         A(base(), { winner: 1, end: 'counter' }) - 25),
    `time ${A(base(), { winner: 1, end: 'time' }).toFixed(1)}｜counter ${A(base(), { winner: 1, end: 'counter' }).toFixed(1)}`);
  // v11：foeWall 只讀 near／far（舊的 foeWallLost 留給履歷顯示，不再計分）。
  // 同樣 8 格，貼到門口開的槍給滿額 8×5＝40 分，在半場外啃牆只按 0.25 折算＝2×5＝10 分
  // ——使用者的攻擊順序是「先打敵車、接近主堡才打主堡」，分數不能反過來獎半場外啃牆。
  const wall1 = Object.assign(base(), { foeWallNear: 1 });
  const wall8 = Object.assign(base(), { foeWallNear: 8 });
  const wall50 = Object.assign(base(), { foeWallNear: 50 });
  const far8 = Object.assign(base(), { foeWallFar: 8 });
  const wallRow = s => rowOf(s, { winner: 1, end: 'time' }, 0, 'foeWall').contribution;
  T('F: 拆牆有梯度且封頂在 8 格（牆共 20 格，不封會變成刷拆牆）',
    A(wall8, { winner: 1, end: 'time' }) > A(wall1, { winner: 1, end: 'time' }) &&
    A(wall50, { winner: 1, end: 'time' }) === A(wall8, { winner: 1, end: 'time' }));
  T('F v11: 拆牆分數按開火距離分堆——貼門口的 8 格給滿 40，半場外啃牆的 8 格只給 10',
    wallRow(base()) === 0 && wallRow(wall1) === 5 &&
    wallRow(wall8) === 40 && wallRow(far8) === 10 &&
    wallRow(Object.assign(base(), { foeWallNear: 50 })) === 40,
    `0 格→${wallRow(base())}｜近 1→${wallRow(wall1)}｜近 8→${wallRow(wall8)}｜` +
    `遠 8→${wallRow(far8)}（=min(8, 0.25×8)×5）`);
  T('F v11: 舊的 foeWallLost 不再參與計分（只有 near／far 會動這一項）',
    wallRow(Object.assign(base(), { foeWallLost: 20 })) === 0 &&
    wallRow(Object.assign(base(), { foeWallNear: 2, foeWallFar: 4 })) ===
      wallRow(Object.assign(base(), { foeWallNear: 2, foeWallFar: 4, foeWallLost: 20 })),
    `只給 foeWallLost 20 → ${wallRow(Object.assign(base(), { foeWallLost: 20 }))}`);
  const deep = Object.assign(base(), { foeBaseMinDist: 0 });
  T('F: 離敵鷹愈近愈有分；整局沒有一台車在場（null）不給這一項',
    A(deep, { winner: 1, end: 'time' }) > A(base(), { winner: 1, end: 'time' }));

  // v10 新增的進攻本業項：包圍敵鷹。penetration 只看「最近到過哪裡」，擦過一眼
  // 就永久滿分；besiege 看「在門口待多久」，才分得出「路過」與「壓上去打」。
  // 滿分線 15% 是校準出來的：rule·rule 實測中位落在這一帶，基準線才會在 0.4~0.6。
  const bsRow = n => rowOf(Object.assign(base(), { besiegeFrames: n }),
    { winner: 1, end: 'time' }, 0, 'besiege').contribution;
  T('F: 包圍敵鷹（besiege 30 分）按 56px 圈內在場占比給，15% 打滿且不再漲',
    bsRow(0) === 0 && bsRow(75) === 15 && bsRow(150) === 30 && bsRow(600) === 30,
    `0%→${bsRow(0)}｜7.5%→${bsRow(75)}｜15%→${bsRow(150)}｜60%→${bsRow(600)}`);

  // v10 把「拖到時間到」的罰從全額改成按推進程度打折：完全沒過半場才扣滿 25。
  // 都貼到城門口了還扣滿，等於叫進攻方別靠近 —— 跟 breach 那 70 分互相打臉。
  const tfRow = s => rowOf(s, { winner: 1, end: 'time' }, 0, 'timeoutFail').contribution;
  T('F: timeoutFail 按推進程度打折（沒過半場扣滿 25，半程扣 12.5，貼到城門口不扣）',
    tfRow(base()) === -25 &&
    tfRow(Object.assign(base(), { foeBaseMinDist: Fitness.HALF_FIELD_PX / 2 })) === -12.5 &&
    tfRow(Object.assign(base(), { foeBaseMinDist: 0 })) === 0,
    `0%→${tfRow(base())}｜50%→${tfRow(Object.assign(base(), { foeBaseMinDist: 84 }))}｜` +
    `100%→${tfRow(Object.assign(base(), { foeBaseMinDist: 0 }))}`);

  // ── 防守角色專屬 ──
  T('F: v3 的評判標準含「家門口攔截」與「協同壓制」（現在歸在防守表）',
    Fitness.termsFor('defense').some(t => t.key === 'defense') &&
    Fitness.termsFor('defense').some(t => t.key === 'teamwork'));
  const withDef = Object.assign(base(), { baseDefenseDamage: 4, baseDefenseKills: 2 });
  T('F: 家門口攔截有加分（同樣的傷害，打在家門口更值錢）',
    D(withDef, { winner: 1, end: 'time' }) > D(base(), { winner: 1, end: 'time' }));
  const def6 = Object.assign(base(), { baseDefenseDamage: 6 });
  const def50 = Object.assign(base(), { baseDefenseDamage: 50 });
  T('F: 家門口攔截有上限（5 hp 以上不再加分；v10 把 6 收緊成 5，單位價 5→7 換平衡）',
    D(def50, { winner: 1, end: 'time' }) === D(def6, { winner: 1, end: 'time' }) &&
    Fitness.GATE_HP_FULL === 5);
  T('F: v5 的「半場攔截」仍在防守表裡（打敵車也算防守）',
    Fitness.termsFor('defense').some(t => t.key === 'halfDefense'));
  const half4 = Object.assign(base(), { halfDefenseDamage: 4 });
  T('F: 敵車在自家半場挨的打有加分（不是只有擋在門口才叫防守）',
    D(half4, { winner: 1, end: 'time' }) > D(base(), { winner: 1, end: 'time' }));
  const def4 = Object.assign(base(), { baseDefenseDamage: 4 });
  T('F: 同樣 4 hp，家門口比半場值錢（愈靠近老鷹愈關鍵）',
    D(def4, { winner: 1, end: 'time' }) > D(half4, { winner: 1, end: 'time' }));
  const half8 = Object.assign(base(), { halfDefenseDamage: 8 });
  const half50 = Object.assign(base(), { halfDefenseDamage: 50 });
  T('F: 半場攔截有上限（6 hp 以上不再加分，避免變成傷害重複計價）',
    D(half50, { winner: 1, end: 'time' }) === D(half8, { winner: 1, end: 'time' }) &&
    Fitness.HALF_HP_FULL === 6);

  // 消極門檻：使用者的規則說「撐到時間到紅隊贏」，但不能因此「躲起來」就滿分。
  // v10 把「贏」分成兩種：打掉藍鷹才是自己贏下來的（45），只是被時鐘判勝（18）——
  // 18 剛好等於舊的 30 分基準線附近，所以規則 AI 的總分不會因為拆級而漂移。
  const gateRow = (s, o) => rowOf(s, o || { winner: 1, end: 'time' }, 1, 'holdGate').contribution;
  T('F: 防守贏一局分兩級 —— 打掉藍鷹 45／只是撐過 30 秒 18（不做事只能拿 18）',
    rowOf(base(), { winner: 1, end: 'time' }, 1, 'holdWin').contribution === 18 &&
    rowOf(Object.assign(base(), { foeBaseKilled: true }), { winner: 1, end: 'counter' }, 1, 'holdWin').contribution === 45 &&
    gateRow(base()) === 0,
    `時鐘 ${rowOf(base(), { winner: 1, end: 'time' }, 1, 'holdWin').contribution}｜` +
    `反打 ${rowOf(Object.assign(base(), { foeBaseKilled: true }), { winner: 1, end: 'counter' }, 1, 'holdWin').contribution}`);
  // holdGate 的 34 分裡，「門前在場」只是加成、不是另一半，是因為實測它是反技能的：
  // rand·rand 中位 28.0% ＞ rule·rule 14.8% ＞ v9 防守冠軍 7.4%（愈會玩愈低 ——
  // 隨機的車被牆困在家門口就吃飽）。所以它不能獨立換分（screenHold 那項因此刪除），
  // 只能把「真的攔到傷害」的那一半放大到兩倍；兩段都要贏了才發。
  T('F: 消極門檻 34 分＝攔到 2hp 才有份（17），門前擋滿 30% 加倍（34）；零攔截不發',
    gateRow(Object.assign(base(), { baseDefenseDamage: 2 })) === 17 &&
    gateRow(Object.assign(base(), { halfDefenseDamage: 4 })) === 17 &&
    gateRow(Object.assign(base(), { screenFrames: 300 })) === 0 &&          // 只站位、沒攔到 → 不發
    gateRow(Object.assign(base(), { screenFrames: 300, baseDefenseDamage: 1 })) === 17 &&
    gateRow(Object.assign(base(), { screenFrames: 300, baseDefenseDamage: 2 })) === 34 &&
    gateRow(Object.assign(base(), { screenFrames: 900, baseDefenseDamage: 6 })) === 34,  // 擋再久也不超
    `攔 2hp→${gateRow(Object.assign(base(), { baseDefenseDamage: 2 }))}｜` +
    `攔 2hp＋門前 30%→${gateRow(Object.assign(base(), { screenFrames: 300, baseDefenseDamage: 2 }))}`);

  // 拒止（denial）：看的是「對手壓不壓得進我家半場」，但一定要自家有攔到傷害才發。
  // 沒這一道就把對手不來當成分數 —— 48 場實測 rand·rand 這一項平均 25.00（滿分 25），
  // 因為隨機藍隊常常整局沒過半場；那等於獎勵什麼都不做。
  const denyRow = s => rowOf(s, { winner: 1, end: 'time' }, 1, 'denial').contribution;
  T('F: 拒止 32 分要「對手進不來」且「自家攔到 4hp」兩件都成立（免單已堵）',
    denyRow(base()) === 0 &&                                                 // 對手沒壓進來但自家沒攔到 → 0
    denyRow(Object.assign(base(), { baseDefenseDamage: 4 })) === 32 &&       // 兩件都做到 → 滿分
    denyRow(Object.assign(base(), { baseDefenseDamage: 2 })) === 16 &&       // 攔一半 → 扣一半
    denyRow(Object.assign(base(), { foeHalfFrames: 550, baseDefenseDamage: 4 })) === 0,  // 壓進 55% → 沒拒住
    `不放行→${denyRow(base())}｜滿→${denyRow(Object.assign(base(), { baseDefenseDamage: 4 }))}｜` +
    `壓入 55%→${denyRow(Object.assign(base(), { foeHalfFrames: 550, baseDefenseDamage: 4 }))}`);

  T('F: screenHold（把「門前在場」直接當一項分）已經從尺裡刪掉 —— 它是反技能項',
    !Fitness.TERMS.some(t => t.key === 'screenHold') &&
    !Fitness.termsFor('defense').some(t => t.key === 'screenHold') &&
    Fitness.termsFor('defense').some(t => t.key === 'denial') &&
    Fitness.termsFor('attack').some(t => t.key === 'besiege'),
    Fitness.termsFor('defense').map(t => t.key).join(','));

  T('F: 通用交戰項（不問角色的戰鬥分）在兩席的天花板一模高 —— 誰也不能靠它多爬',
    cA.byGroup.combat === cD.byGroup.combat,
    `兩席都是 ${cA.byGroup.combat.toFixed(1)}（本業 ${cA.job.toFixed(0)}／${cD.job.toFixed(0)}）`);
  T('F: 沒獲勝的防守局拿不到 holdWin／holdGate（輸了就是輸了）',
    rowOf(base(), { winner: 0, end: 'breach' }, 1, 'holdWin').contribution === 0 &&
    rowOf(Object.assign(base(), { baseDefenseDamage: 6 }), { winner: 0, end: 'breach' }, 1, 'holdGate').contribution === 0);
  const holdFast = Object.assign(base(), { baseDefenseDamage: 6 });
  T('F: 防守方靠打掉藍隊老鷹取勝才有 speed 分；撐到時間到不給（那是時鐘判勝）',
    D(holdFast, { winner: 1, end: 'counter', frames: 600 }) >
      D(holdFast, { winner: 1, end: 'counter', frames: 1600 }) &&
    rowOf(holdFast, { winner: 1, end: 'time' }, 1, 'speed').contribution === 0);

  // ── 過程懲罰：卡牆／動作單一／亂打不動的目標 ──
  const pinned = Object.assign(base(), { fieldFrames: 1000, blockedFrames: 550, dominance: 0.92 });
  const fPinned = A(pinned);
  const clean = Object.assign(base(), { fieldFrames: 1000, blockedFrames: 60, dominance: 0.45 });
  const fClean = A(clean);
  T('F: 卡牆 55% + 只按射擊 → 分數明顯低於同樣成績但會機動的個體',
    fPinned < fClean * 0.6, `${fPinned.toFixed(1)} vs ${fClean.toFixed(1)}`);
  T('F: 完全卡死又不殺人 → 歸零（不給「守著牆掃射」的局部最優）',
    A(Object.assign(base(), { kills: 0, blockedFrames: 700, dominance: 0.95 }),
      { winner: null, end: 'time' }) === 0);

  const g1 = Object.assign(base(), { blockedFrames: 210 });    // 21% → 剛過免罰線
  const g2 = Object.assign(base(), { blockedFrames: 400 });    // 40%
  const g3 = Object.assign(base(), { blockedFrames: 700 });    // 70% → 扣滿
  T('F: 卡牆懲罰是連續梯度（21% > 40% > 70% 扣得愈來愈多）',
    A(g1) > A(g2) && A(g2) > A(g3) && A(g3) < f,
    [A(g1), A(g2), A(g3)].map(v => v.toFixed(1)).join(' / '));
  const m1 = Object.assign(base(), { dominance: 0.62 });
  const m2 = Object.assign(base(), { dominance: 0.99 });
  T('F: 動作單一懲罰也是連續梯度', A(m1) > A(m2), `${A(m1).toFixed(1)} vs ${A(m2).toFixed(1)}`);
  T('F: 沒有 policy 的隊伍（純規則 AI）不受過程懲罰誤傷',
    A(Object.assign(base(), { blockedFrames: 900, actN: 0, dominance: 0.99 })) === f);

  // ── v6 新增：自拆要塞的開火要能被計分（兩個角色都算）──
  const selfShot = Object.assign(base(), { selfBaseShots: 3 });
  T('F: 開槍打到自己要塞（老鷹或要塞牆）逐發扣分，兩個角色都扣',
    A(selfShot) < f && D(selfShot, { winner: 1, end: 'time' }) <
      D(base(), { winner: 1, end: 'time' }) &&
    f - A(selfShot) === 21, `${f.toFixed(1)} → ${A(selfShot).toFixed(1)}`);
  T('F: 自家要塞牆被削也要扣分（僥倖守住不等於完好守住）',
    A(Object.assign(base(), { ownBaseCellsLost: 4 })) < f);

  // ── 協同：兩套標準都保留，但要有自己的梯度且不能無限刷 ──
  const sup0 = Object.assign(base(), { supportFrames: 100 });      // 10%：剛好門檻
  const supMid = Object.assign(base(), { supportFrames: 175 });    // 17.5%
  const supFull = Object.assign(base(), { supportFrames: 250 });   // 25%
  T('F: 協同壓制 10% 以下不給分（避免把剛好同框算成合作）',
    A(sup0, { winner: 1, end: 'time' }) === A(base(), { winner: 1, end: 'time' }));
  T('F: 協同壓制有連續梯度且封頂',
    A(supMid, { winner: 1, end: 'time' }) > A(base(), { winner: 1, end: 'time' }) &&
    A(supFull, { winner: 1, end: 'time' }) > A(supMid, { winner: 1, end: 'time' }) &&
    A(Object.assign(base(), { supportFrames: 400 }), { winner: 1, end: 'time' }) ===
      A(supFull, { winner: 1, end: 'time' }));
}

// ══════ 4. 監測層：過程數據 + 紅旗 ══════
section('telemetry');
{
  const { RULES } = require('./ai/telemetry');

  // 訓練迴圈的便宜計量必須和 Recorder 對得上，否則「用紅旗重訓」
  // 驗的是另一套數字，監測到的和懲罰到的就不是同一件事。
  const t = arena.run({ stage: 1, seed: hashSeed(0x7e1e, 1, 0), blue: 'random', maxFrames: 2500, record: true });
  const a0 = t.teams[0], m0 = t.telemetry.teams[0];
  T('M: 訓練用的便宜計量與 Recorder 逐隊一致（在場幀）', a0.fieldFrames === m0.fieldFrames,
    `${a0.fieldFrames} vs ${m0.fieldFrames}`);
  T('M: 訓練用的便宜計量與 Recorder 逐隊一致（卡牆比例）',
    Math.abs(a0.blockedFrames / a0.fieldFrames - m0.blockedShare) < 1e-9,
    `${(100 * a0.blockedFrames / a0.fieldFrames).toFixed(2)}% vs ${(100 * m0.blockedShare).toFixed(2)}%`);
  // 允許的落差 = 該隊陣亡數：Recorder 是在 step() 之後取樣，
  // 而「子彈在同一幀把車打死」時那台車已經不在 G.tanks 的活車清單裡，
  // 它那最後一幀的動作就讀不到。競技場讀 controller.actions，所以會多計這幾幀。
  const gap = a0.actN - m0.actionN;
  T('M: 動作直方圖總數一致（落差 ≤ 陣亡數，且競技場不會少計）',
    gap >= 0 && gap <= a0.deaths, `arena ${a0.actN} vs rec ${m0.actionN}（陣亡 ${a0.deaths}）`);
  T('M: 沒有 policy 的隊伍不會被標成「被網路控制」', t.telemetry.teams[1].ctrlTanks === 0);
  T('M: 不記錄時報告裡不留遙測（訓練迴圈不多花錢）',
    arena.run({ stage: 1, seed: 5, blue: 'random' }).telemetry === undefined);

  // 「控制權 100%」原本是假的：framesDecided 以前連 abstain 幀也一起算。
  const neverPol = arena.run({ stage: 1, seed: 7, blue: () => null, maxFrames: 1200 });
  T('M: 全程不會決定（回傳 null）→ 決策幀 0，不冒充網路的功勞',
    neverPol.teams[0].framesDecided === 0 && neverPol.teams[0].actN === 0,
    `${neverPol.teams[0].framesDecided} / 在場 ${neverPol.teams[0].fieldFrames}`);
  let half = 0;
  const alternating = () => (half++ % 2 === 0 ? 4 : null);      // 一半幀交給規則 AI
  const halfPol = arena.run({ stage: 1, seed: 7, blue: alternating, maxFrames: 1200 });
  const share = halfPol.teams[0].framesDecided / halfPol.teams[0].fieldFrames;
  T('M: 一半幀 abstain → 控制權如實報在 40%~60% 之間', share > 0.4 && share < 0.6,
    (100 * share).toFixed(0) + '%');

  // 紅旗要「該亮就亮、不該亮別亂亮」，用合成數據把兩邊都釘住
  const degenerate = {
    ctrlTanks: 3, fieldFrames: 900, actionShare: [0.03, 0.01, 0.0, 0.04, 0.92], actionN: 900,
    blockedShare: 0.55, fireWhileBlockedShare: 0.49, shots: 320, unbreakableHitShare: 0.3,
    brickDestroyed: 0, advancePx: 8, abstainShare: 0, deaths: 9, kills: 1,
    ownBaseCellsLost: 4,
  };
  const healthy = {
    ctrlTanks: 3, fieldFrames: 900, actionShare: [0.24, 0.26, 0.22, 0.16, 0.12], actionN: 900,
    blockedShare: 0.08, fireWhileBlockedShare: 0.02, shots: 120, unbreakableHitShare: 0.04,
    brickDestroyed: 22, advancePx: 180, abstainShare: 0.1, deaths: 3, kills: 7,
    ownBaseCellsLost: 0,
  };
  const fired = s => RULES.filter(r => { try { return r.test(s); } catch (e) { return false; } }).map(r => r.id);
  const D = fired(degenerate), H = fired(healthy);
  T('M: 退化打法（92% 射擊、55% 卡牆、0 推進）→ 紅旗全亮', D.length >= 5, D.join(','));
  T('M: 健康打法 → 零紅旗', H.length === 0, H.join(','));
  T('M: 每條紅旗都自帶門檻與修法（報告要能直接指導下一輪）',
    RULES.every(r => r.id && r.label && r.limit && r.why && r.fix && typeof r.test === 'function'));

  const wall = arena.run({ stage: 0, seed: 31337, maxFrames: 1500, record: true });
  const terr = wall.telemetry.terrain;
  T('M: 地形計量分得清「削掉磚」與「打不動的地形」',
    terr.brick_destroyed > 0 && Object.prototype.hasOwnProperty.call(terr, 'steel'),
    JSON.stringify(terr));
  T('M: 逐局軌跡有留下來（HTML 介面靠它畫熱點與卡點）',
    wall.telemetry.tankTracks.length > 0 && wall.telemetry.heat.length === 2,
    wall.telemetry.tankTracks.length + ' 台車');
}

// ══════ 5. 斷點續存：真的重開 process 接回去 ══════
section('checkpoint / resume');
{
  const file = path.join(TMP, 'resume.json');
  evolve(['--gens', '2', '--pop', '4', '--stages', '0', '--seeds', '1', '--quiet', '--out', file]);
  const j1 = JSON.parse(fs.readFileSync(file, 'utf8'));
  T('C: 第 2 代落盤', j1.neat.generation === 2, j1.neat.generation);
  // 場數 = 代數 × 族群 × 地圖 × 種子 × 座位。v6 每個模型只坐自己那一席
  // （seats=1），所以 2 代 × 4 隻 × 1 圖 × 1 種 × 1 座 = 8 場。
  T('C: 記錄了場數（v6 單座位）', j1.episodes === 2 * 4 * 1 * 1, j1.episodes);
  T('C: 考題記了席位與角色（場數預算與重評都按這一席算）',
    j1.config.seats === 1 && j1.config.role === 'attack',
    JSON.stringify({ seats: j1.config.seats, role: j1.config.role }));
  T('C: 冠軍那筆分數記了「打誰打出來的」',
    typeof j1.champion.measuredAgainst === 'string' && j1.champion.measuredAgainst.length > 0,
    j1.champion.measuredAgainst);
  T('C: 記錄了觀測規格', j1.obsSpec.version === Observation.OBS_SPEC.version);
  T('C: 記錄了 innovation history',
    typeof j1.neat.hist.nextConn === 'number' && j1.neat.hist.connByKey.length > 0,
    j1.neat.hist && j1.neat.hist.nextConn);
  T('C: 記錄了 champion 基因組', !!j1.champion && Array.isArray(j1.champion.genome.links));
  T('C: 記錄了 history 曲線', j1.neat.history.length === 2);

  // 第二支 process：接續
  const out2 = evolve(['--resume', file, '--gens', '1', '--quiet']);
  const j2 = JSON.parse(fs.readFileSync(file, 'utf8'));
  T('C: 跨 process 接續後 generation 連續', j2.neat.generation === 3, j2.neat.generation);
  T('C: 場數累加而非歸零（一代 4 隻 × 1 圖 × 1 種 × 1 座）',
    j2.episodes === j1.episodes + 4, `${j1.episodes} → ${j2.episodes}`);
  T('C: innovation 計數器接得回去（只增不減）',
    j2.neat.hist.nextConn >= j1.neat.hist.nextConn, `${j1.neat.hist.nextConn} → ${j2.neat.hist.nextConn}`);
  T('C: 同一個創新號在接續後仍只對應一條邊', (() => {
    const seen = new Map();
    for (const g of j2.neat.population) for (const l of g.links) {
      const k = l.in + '>' + l.out;
      if (seen.has(l.innovation) && seen.get(l.innovation) !== k) return false;
      seen.set(l.innovation, k);
    }
    return true;
  })());
  T('C: 族群大小不變', j2.neat.population.length === j1.neat.population.length);
  T('C: 沿用 checkpoint 裡的考題設定', JSON.stringify(j2.config.stages) === JSON.stringify(j1.config.stages));

  // 續練時加入沒練過的地圖：--stages 是「明確覆寫」。
  // 換圖＝換尺，所以舊冠軍要在新考題上重評；校準局不能混進訓練場數。
  {
    const examFile = path.join(TMP, 'exam.json');
    fs.copyFileSync(file, examFile);
    const before = JSON.parse(fs.readFileSync(examFile, 'utf8'));
    evolve(['--resume', examFile, '--gens', '1', '--stages', '0,1', '--quiet']);
    const after = JSON.parse(fs.readFileSync(examFile, 'utf8'));
    const st = after.sessions[after.sessions.length - 1];
    T('C: 續練可以明確用 --stages 加入新地圖', JSON.stringify(after.config.stages) === JSON.stringify([0, 1]));
    T('C: 換圖記在該段工作階段（前後不可比）',
      st.examChanged === true && JSON.stringify(st.examBefore) === JSON.stringify([0]));
    T('C: 舊冠軍在新考題重評，校準局不計入訓練場數',
      !!st.championRescore && st.championRescore.games === 2 * 1 &&
      st.championRescore.reasons.includes('exam') &&
      after.episodes === before.episodes + 4 * 2 * 1,
      `場 ${before.episodes}→${after.episodes}，校準 ${st.championRescore && st.championRescore.games}`);
    const raw = fs.readFileSync(examFile, 'utf8');
    let badStage = '';
    // 地圖改成隨機產生之後，「有效關卡」就是 0..MAP_VARIANTS-1 整個區間，
    // 所以越界的 id 要用 MAP_VARIANTS 本身算出來（以前抄 34／99 那種數字，
    // 換一次圖就變成「合法但沒意義」，這條測試會靜默失效）。
    const tooBig = arena.R.MAP_VARIANTS;
    try { evolve(['--resume', examFile, '--gens', '1', '--stages', '0,' + tooBig, '--quiet']); }
    catch (e) { badStage = String(e.message || ''); }
    T('C: 不存在的關卡要拒絕（id ≥ MAP_VARIANTS），且不改存檔',
      /不是有效關卡/.test(badStage) && raw === fs.readFileSync(examFile, 'utf8'), badStage);
  }
  // 工作階段要記「實際跑到的設定」，不是 CLI 的預設值。
  // 續練時 o.seeds 預設 1，但 checkpoint 可能是 2 —— 記錯會讓履歷騙人。
  {
    const s2 = path.join(TMP, 'seeds2.json');
    evolve(['--gens', '1', '--pop', '4', '--stages', '0', '--seeds', '2', '--quiet', '--out', s2]);
    evolve(['--resume', s2, '--gens', '1', '--quiet']);
    const j = JSON.parse(fs.readFileSync(s2, 'utf8'));
    const st = j.sessions[j.sessions.length - 1];
    T('C: 工作階段記的是實際 seeds（2），不是 CLI 預設 1', st.args.seeds === 2, st.args.seeds);
  }

  // 算分換版（v2 → v3）跟換圖一樣是「換尺」：舊冠軍留著上一版的分數
  // 會壓著新世代（或反之），續練時必須先重評。
  {
    const sv = path.join(TMP, 'scorev.json');
    evolve(['--gens', '1', '--pop', '4', '--stages', '0', '--seeds', '1', '--quiet', '--out', sv]);
    const raw = JSON.parse(fs.readFileSync(sv, 'utf8'));
    raw.champion.scoringVersion = 1;   // 假裝是 v1 算分存下來的冠軍
    raw.champion.fitness = 999;        // 舊單位，不可比
    fs.writeFileSync(sv, JSON.stringify(raw));
    const beforeEp = raw.episodes;
    evolve(['--resume', sv, '--gens', '1', '--quiet']);
    const after = JSON.parse(fs.readFileSync(sv, 'utf8'));
    const st = after.sessions[after.sessions.length - 1];
    T('C: 算分換版 → 續練時自動重評舊冠軍（不是把 999 當真壓著新世代）',
      !!st.championRescore && st.championRescore.reasons.includes('scoring') &&
      st.championRescore.fromVersion === 1 && st.championRescore.toVersion === Fitness.SCORING_VERSION &&
      after.champion.scoringVersion === Fitness.SCORING_VERSION &&
      after.episodes === beforeEp + 4,
      `fixture 999 → ${after.champion.fitness.toFixed(2)}；${st.championRescore && st.championRescore.reasons}`);
  }

  // 主打 workflow：「今天跑 100 場，明天接著跑」。場數上限必須是本次的，
  // 不能跟歷史累計比 —— 比過就會一代都不跑、原地落盤（曾真的踩到）。
  {
    const j3 = JSON.parse(fs.readFileSync(file, 'utf8'));
    evolve(['--resume', file, '--episodes', '1', '--quiet']);
    const j4 = JSON.parse(fs.readFileSync(file, 'utf8'));
    T('C: --episodes 上限算「本次」，歷史場數再高也照樣跑滿一代',
      j4.neat.generation === j3.neat.generation + 1 && j4.episodes === j3.episodes + 4,
      `gen ${j3.neat.generation}→${j4.neat.generation}，場 ${j3.episodes}→${j4.episodes}`);
  }

  // 規格不符必須拒絕，不能將就
  const bad = JSON.parse(JSON.stringify(j2));
  bad.obsSpec = { version: 99, dim: 12, gridRadius: 1 };
  const badFile = path.join(TMP, 'badspec.json');
  fs.writeFileSync(badFile, JSON.stringify(bad));
  let refused = false, msg = '';
  try { evolve(['--resume', badFile, '--gens', '1', '--quiet']); }
  catch (e) { refused = true; msg = String(e.stdout || '') + String(e.stderr || ''); }
  T('C: 觀測規格不符 → 拒絕載入而不是靜默重訓', refused);
  T('C: 拒絕時講清楚原因', /觀測規格不相容/.test(msg), msg.trim().slice(0, 80));

  // 不是本專案的存檔也要擋
  const junk = path.join(TMP, 'junk.json');
  fs.writeFileSync(junk, '{"hello":1}');
  let junkRefused = false;
  try { Checkpoint.load(junk, Observation.OBS_SPEC); } catch (e) { junkRefused = /不是本專案/.test(e.message); }
  T('C: 亂七八糟的檔案會被擋下', junkRefused);

  // 兩個上限都沒給 → 會無限演化（--quiet 時曾跑成真的死迴圈），必須啟動前就擋掉
  let guardRefused = false, guardMsg = '';
  try { evolve(['--pop', '4', '--stages', '0', '--quiet']); }
  catch (e) { guardRefused = true; guardMsg = String(e.stdout || '') + String(e.stderr || ''); }
  T('C: 沒給任何上限 → 拒絕啟動而不是無限跑',
    guardRefused && /至少給一個上限/.test(guardMsg), guardMsg.trim().slice(-60));

  // --quiet 只該關掉列印，不該影響「跑幾代」的控制流
  const q = path.join(TMP, 'quiet3.json');
  evolve(['--gens', '3', '--pop', '4', '--stages', '0', '--seeds', '1', '--quiet', '--out', q]);
  T('C: --quiet 仍遵守 --gens 上限（3 代就停）',
    JSON.parse(fs.readFileSync(q, 'utf8')).neat.generation === 3);

  // 存檔要原子：不能留下 .tmp
  T('C: 沒有殘留的 .tmp 檔', !fs.existsSync(file + '.tmp'));
}

// ══════ 5. 訓練真的有效：適應度會上升 ══════
section('learning signal');
{
  const file = path.join(TMP, 'curve.json');
  evolve(['--gens', '6', '--pop', '8', '--stages', '0', '--seeds', '1', '--quiet', '--out', file]);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const best = j.neat.history.map(h => h.best);
  const mean = j.neat.history.map(h => h.mean);
  T(`L: 6 代之後 best 上升（${best[0].toFixed(1)} → ${best[best.length - 1].toFixed(1)}）`,
    best[best.length - 1] > best[0]);
  T(`L: mean 也上升（${mean[0].toFixed(1)} → ${mean[mean.length - 1].toFixed(1)}）`,
    mean[mean.length - 1] > mean[0]);

  // 這條是「不該從頭訓練到尾」的實證基礎（使用者的判斷，第 22 輪的對話）：
  // 冷開機的前幾代，族群裡多數個體根本還沒找到會動的網路。
  // 註一：冷開機第一代 best 不會是 0，因為 abstain 的幀由規則 AI 代步 ——
  //       所以看 mean（整體水位）而不是 best（偶爾撿到一個能動的）。
  // 註二：閾值改用「與收斂後的水位相比」而不是寫死一個分數。v6 的進攻表
  //       多了推進／破網這種幾十分的過程項，同一個「還沒學會」的個體
  //       自然比 v5 高，寫死 25 只是在追著算分版本跑。
  // 註三：v10 把這道比例從 0.5 放寬到 0.85 —— 不是退讓，是尺本來就改了目標：
  //       v10 故意讓「不問角色的戰鬥分」變便宜、把分錢換成「天天都發生的占比」
  //       （包圍門口／拒止／門前在場），所以一開始亂動也會撿到基本盤。
  //       實測 43.54／60.90＝0.71（v9 是 0.4x）。這一項要守的仍是那句話：
  //       第一代的水位明顯低於收斂後，所以不該從頭練到尾；0.5 那個數屬 v9 的尺。
  T(`L: 冷開機第一代整體水位明顯低於自己收斂後的水平（mean ${mean[0].toFixed(1)} 只有末代 ${mean[mean.length - 1].toFixed(1)} 的 ${Math.round(mean[0] / mean[mean.length - 1] * 100)}%；暖啟動的第一代見下一節）`,
    mean[0] < mean[mean.length - 1] * 0.85 && best[0] > mean[0],
    `mean ${mean[0].toFixed(2)}｜末代 ${mean[mean.length - 1].toFixed(2)}｜比例 ${(mean[0] / mean[mean.length - 1]).toFixed(2)}`);
}

// ══════ 6. 暖啟動：模仿種子 → NEAT（逐席位）══════
section('warm start');
{
  /* 這一節從「一顆種子坐兩個席位」改寫成「每顆種子只坐自己那一席」。
     為什麼要改：批次二 G3 之後種子分角色收（runs/seed-attack／runs/seed-defense），
     兩席的贏法本來就相反（藍要在 30 秒內拆掉對面老鷹；紅只要撐過時鐘），
     把兩席的勝負加在一起算一個勝率，等於用測試懲罰分工 ——
     實測過：防守種子自己坐紅席是 12/24（50%），混著算被 ai/monitor.js 讀成 13%。
     批次四又把規則 AI（也就是這裡的對手）調強，所以舊門檻那句「≥ 40%」
     對進攻種子根本不可能成立：行為複製的老師自己一槍都不破局（0/24）。
     進攻那一席改問過程（控制權／卡牆／開火／擊殺），並把「種子不會贏、
     5 代之後會贏」當成一組斷言 —— 那才是暖啟動的價值所在。
     考題固定：地圖 0..7 × 3 種子（hashSeed(0x517, i)），與 runs/seed-eval.js、
     runs/warm-probe.js 同一把尺，數字可以直接拿去對門檻。
     ⚠ 種子檔有兩條讀法：先拿本機現記的那份（runs/seed-<席位>.json，ai/imitate.js 的
       輸出路徑），沒有才退回版控裡的定格副本（ai/seeds/seed-<席位>.json）。會需要第二條
       是因為 runs/ 整個被 .gitignore 排除（checkpoint 隨代數一直長大，不屬原始碼），
       於是「從 GitHub 全新 clone 出來跑 CI」那台機器根本沒有 runs/ 目錄，
       這一節十幾條測試會全部以「檔案不存在」變紅 —— 那不是程式壞了，是環境缺件。
       兩份目前位址不同、內容相同（都是批次五重記的 v2 種子），CI 驗的是那份定格副本。 */
  const SEED_EXAMS = [];
  for (let m = 0; m < 8; m++) for (let s = 0; s < 3; s++) SEED_EXAMS.push({ stage: m, seed: hashSeed(0x517, m * 3 + s) });

  /** 把 policy 放進它自己那一席，對面恆為規則 AI（n 局考題，預設全部 24 局） */
  const inSeat = (pol, role, n = SEED_EXAMS.length) => {
    const acc = { win: 0, tot: 0, decided: 0, field: 0, stuck: 0, shots: 0, kills: 0, breach: 0 };
    for (const e of SEED_EXAMS.slice(0, n)) {
      const r = role === 'attack'
        ? arena.run({ stage: e.stage, seed: e.seed, blue: pol, red: 'rule' })
        : arena.run({ stage: e.stage, seed: e.seed, blue: 'rule', red: pol });
      const t = r.teams[role === 'attack' ? 0 : 1];
      acc.win += (r.winner === (role === 'attack' ? 0 : 1) ? 1 : 0);
      acc.breach += (r.end === 'breach' ? 1 : 0);
      acc.tot++;
      acc.decided += t.framesDecided || 0; acc.field += t.fieldFrames || 0;
      acc.stuck += t.blockedFrames || 0; acc.shots += t.shots || 0; acc.kills += t.kills || 0;
    }
    return acc;
  };
  const pc = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '—');

  /** 種子檔位置：本機現記的那份優先，沒有才退回版控裡的定格副本（CI 那台機器沒有 runs/） */
  const seedPath = role => [path.join('runs', `seed-${role}.json`), path.join('ai', 'seeds', `seed-${role}.json`)]
    .find(p => fs.existsSync(p));

  for (const role of ['attack', 'defense']) {
    const seat = role === 'attack' ? '藍（進攻）' : '紅（防守）';
    const seedFile = seedPath(role);
    if (!seedFile) {
      T(`W: 需要 ${role} 席的模仿種子（runs/seed-${role}.json 與 ai/seeds/seed-${role}.json 都找不到；` +
        `本機可跑 node ai/imitate.js --role ${role} --out runs/seed-${role}.json）`,
        false, '檔案不存在');
      continue;
    }
    const seedJson = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
    T(`W: ${role} 種子記得了觀測規格與席位（讀的是 ${seedFile}）`,
      seedJson.obsSpec.version === Observation.OBS_SPEC.version && seedJson.role === role,
      `v${seedJson.obsSpec.version}／role=${seedJson.role}`);

    const a = inSeat({ kind: 'policy', policy: Genome.fromJSON(seedJson.genome).toPolicy() }, role);
    T(`W: ${seat}種子真的自己在開車，不是躲在公司 AI 後面（控制權 ${pc(a.decided, a.field)}）`,
      a.decided / a.field > 0.9, pc(a.decided, a.field));
    T(`W: ${seat}種子不卡牆（卡牆 ${pc(a.stuck, a.field)}）`, a.stuck / a.field < 0.1, pc(a.stuck, a.field));
    // 老師本人坐同一席（對面也是規則 AI，所以這其實是 rule·rule 那一格）：
    //   下面那兩條要把「種子做不到」跟「老師做得到」放在一起講，
    //   數字就地量（8 局），不抄註解、也不在測試名字裡寫死百分比。
    const tch = inSeat('rule', role, 8);
    if (role === 'defense') {
      // 防守席的贏法＝撐過 30 秒（或打掉藍鷹），行為複製的老師做得到，
      // 所以這一席可以照舊用勝負率當尺（勝率印在名字上，會隨老師變，不寫死在註解裡）。
      T(`W: 防守種子坐紅席打得過同席規則 AI（${a.win}/${a.tot}＝${pc(a.win, a.tot)} ≥ 40%；老師本人同席 ${pc(tch.win, tch.tot)}）`,
        a.win / a.tot >= 0.4, `${a.win}/${a.tot}｜老師 ${tch.win}/${tch.tot}`);
    } else {
      // 進攻席只有一種贏法：30 秒內打掉紅隊老鷹。
      // ⚠ 這條的「為什麼」在批次五換過了。舊說法是「老師自己坐藍席也不破局，
      //   所以複製它的種子必然 0 勝」；現在老師會破局了（同席實測印在名字上，
      //   數來自這一段自己跑的 8 局，不是抄註解），種子卻仍然 0 勝 0 破局。
      //   真正的原因是**逐幀忠實度 88% 複製的是「動作」，不是「目的」**：
      //   它每一百幀偏十幾次，累積起來就走不完那條 312px 的長走廊 ——
      //   行為複製只能給過程，不能給勝負。所以這條用過程項驗（有開火、有擊殺），
      //   並把「不會贏」寫在名字上；老師那一列同時證明「不是尺算不出破局分」。
      T(`W: 進攻種子只有過程、不會贏（勝率 ${a.win}/${a.tot}、破局 ${pc(a.breach, a.tot)}；老師同席破得了 ${pc(tch.breach, tch.tot)}）`,
        a.win / a.tot < 0.4 && a.shots / a.tot > 0 && a.kills / a.tot >= 5 && tch.breach > 0,
        `開火 ${(a.shots / a.tot).toFixed(1)}/局｜擊殺 ${(a.kills / a.tot).toFixed(2)}/局｜破局 ${a.breach}/${a.tot}` +
        `｜老師 8 局破 ${tch.breach}/${tch.tot}`);
    }

    // --seed-from：族群從種子長出來，而不是從隨機權重（席位要對得上，G3 已驗過錯席會被擋）
    // v12 起跑 5 代（原本 3 代）：尺開始付錢給「打死人」之後，進攻席先變成鬥士、
    //   再變成破網手 —— 同一支種子、同一份考題實測（`node runs/warm-gens.js 3 5 6`）：
    //     3 代 勝 7/24（29.2%）、破局 7/24、擊殺 10.75/局、每殺 9.5 發、平均 27.4 秒
    //     5 代 勝 24/24、破局 24/24、擊殺 6.25/局、每殺 17.2 發、平均 13.6 秒
    //   所以要改的是「量到第幾代」，不是門檻：暖啟動省下幾十代的結論沒變，
    //   只是 v12 把「先清場再攻城」排在了前面（那正是使用者要的激烈）。
    const WARM_GENS = 5;
    const file = path.join(TMP, `warm-${role}.json`);
    evolve(['--seed-from', seedFile, '--role', role, '--gens', String(WARM_GENS), '--pop', '8',
      '--stages', '0', '--seeds', '1', '--quiet', '--out', file]);
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    T(`W: --seed-from 有寫進考題設定（之後知道這一輪是暖啟動來的・${role}）`,
      j.config.seedFrom === seedFile && j.config.role === role, j.config.role);
    // 「暖啟動第一代 mean 就有水位」這顆釘子，舊版寫死 > 20 分。
    // ⚠ 20 追的其實是**老師**：批次五把進攻老師的位移退回「只壓主堡」之後
    //   （實測破局率 22.5% → 29.2%），紅席被壓得更兇，同一顆釘子就從 2x.x 掉到 19.3。
    //   這一版把它拆成兩件真的能量、而且跟老師強弱無關的事：
    //   ① 第一代不踩在 0 分地板上（有水位）；
    //   ② 冷開機那一代也是**網路自己在開車**（控制權 ≥90%），不是規則 AI 代步。
    // ⚠ 舊稿在這裡寫過第三件：「冷開機第一代很多幀是 abstain、由規則 AI 代步，
    //   所以冷開機的 mean 天生虛高，兩個 mean 不能直接比」。實測是**錯的**，
    //   已經撤掉（`node audit-coldctrl.js`，6 局固定考題）：
    //      隨機權重 3 隻 → 控制權 99.8~99.9%（abstain 要「最大輸出 < -0.85」，
    //                       隨機 argmax 幾乎永遠在上面，所以第一代就在自己開車）
    //      老師坐同席   → 控制權恆 0%，因為那個欄位只統計網路
    //   冷開機的 mean 有時比暖啟動高（本節實測：進攻 43.36 vs 40.05、防守 30.61 vs 10.70），
    //   原因在**尺**不在代步：亂走也會撿到過程分（防守席隨機#1 87.35 ＞ 老師 55.87
    //   ＞ 種子 22.61）。那是計分弱點，記在 BALANCE-RESEARCH.md；它同時意味著
    //   「第一代 mean 的高低」不能拿來論暖啟動划不划算。真正把關的是下面兩條：
    //   5 代冠軍坐回席位打得過規則 AI（≥40%）、進攻 5 代冠軍真的破得了局（≥50%）。
    //   另一邊，種子分數天生低於老師（同一支 6 局考題：進攻 17.31 vs 77.09、防守 22.61 vs 55.87，
   //   破局 0/6 vs 2/6
    //   也不是尺壞，是「行為複製只能給過程」：忠實度 88% 學得動作，學不到那條 312px 的走廊。
    const cold = path.join(TMP, `cold-${role}.json`);
    evolve(['--role', role, '--gens', '1', '--pop', '8', '--stages', '0', '--seeds', '1',
      '--quiet', '--seed', 4242, '--out', cold]);
    const cj = JSON.parse(fs.readFileSync(cold, 'utf8'));
    const warmMean = j.neat.history[0].mean, coldMean = cj.neat.history[0].mean;
    T(`W: ${seat}暖啟動第一代不踩 0 分地板（mean ${warmMean.toFixed(1)} > 5）`,
      warmMean > 5, `暖 ${warmMean.toFixed(2)}｜冷開機同世代 ${coldMean.toFixed(2)}（兩邊的 mean 都來自網路自己開車，但冷開機撿的是亂走的過程分）`);
    // ② 的證據就地量：跟 NEAT.initialize 同一支碼生一隻隨機基因組，坐 6 局。
    const { ACTION_COUNT } = require('./ai/actions');
    const rnd = (() => { let x = 4242; return () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); })();
    const rg = Genome.seed(Observation.OBS_DIM, ACTION_COUNT, new InnovationHistory(), rnd);
    const rc = inSeat({ kind: 'policy', policy: rg.toPolicy() }, role, 6);
    const rCtrl = rc.decided / Math.max(1, rc.field), sCtrl = a.decided / Math.max(1, a.field);
    T(`W: ${seat}冷開機第一代也是自己在開車，不是規則 AI 代步（隨機權重控制權 ${pc(rc.decided, rc.field)} ≥ 90%，與種子 ${pc(a.decided, a.field)} 同級）`,
      rCtrl >= 0.9 && sCtrl >= 0.9,
      `隨機 ${rCtrl.toFixed(3)}｜種子 ${sCtrl.toFixed(3)}｜所以 mean 高低不是代步造成的（見 audit-coldctrl.js）`);
    const links = j.neat.population[0].links.length;
    T(`W: ${seat}族群第 0 號保留未變異的種子（邊數 ${links}，與種子同級）`,
      Math.abs(links - seedJson.seed.links.length) <= 3, `${links} vs ${seedJson.seed.links.length}`);

    // ${WARM_GENS} 代之後的冠軍要坐在自己席位打得過規則 AI（原本這條測的是冷開機 6 代，
    // 實測 4/24 —— 那不是適應度壞，是「從零學起」本來就要幾十代；暖啟動把這段預算省下來）
    const c = inSeat({ kind: 'policy', policy: Genome.fromJSON(j.champion.genome).toPolicy() }, role);
    T(`W: ${seat}暖啟動 ${WARM_GENS} 代冠軍對規則 AI 勝率 ≥ 40%（實測 ${c.win}/${c.tot}＝${pc(c.win, c.tot)}）`,
      c.win / c.tot >= 0.4, `${c.win}/${c.tot}（種子 ${a.win}/${a.tot}）`);
    T(`W: ${seat}贏的是網路自己贏的（控制權 ${pc(c.decided, c.field)}）`,
      c.decided / c.field > 0.9, pc(c.decided, c.field));
    if (role === 'attack') {
      // 進攻席唯一的勝負項：會不會破局。種子 0%、${WARM_GENS} 代之後才學會贏 ——
      // 這一條就是「暖啟動省下幾十代」最直接的證據。
      T(`W: ${seat}${WARM_GENS} 代冠軍真的破得了局（${pc(c.breach, c.tot)}，種子只有 ${pc(a.breach, a.tot)}）`,
        c.breach / c.tot >= 0.5, `${c.breach}/${c.tot}`);
    }
  }

  {
    const seedFile = seedPath('defense');
    // 拿「另一本創新帳」的檔來暖啟動必須被擋：硬塞會讓 crossover 認錯邊
    const champGenome = JSON.parse(fs.readFileSync(path.join(TMP, 'warm-defense.json'), 'utf8')).champion.genome;
    const badFile = path.join(TMP, 'badseed.json');
    fs.writeFileSync(badFile, JSON.stringify({ kind: 'tank-battle-genome', genome: champGenome }));
    let refused = false, msg = '';
    try { evolve(['--seed-from', badFile, '--role', 'defense', '--gens', '1', '--pop', '4',
      '--stages', '0', '--quiet', '--out', path.join(TMP, 'never.json')]); }
    catch (e) { refused = true; msg = String(e.stdout || '') + String(e.stderr || ''); }
    T('W: 匯出的基因組不能冒充種子（會被擋，並講清楚為什麼）',
      refused && /不是模仿種子/.test(msg), msg.trim().slice(-70));

    // 舊觀測規格的種子更要擋：欄位一變，權重就接到別的感測器上
    const seedJson = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
    const oldSeed = JSON.parse(JSON.stringify(seedJson));
    oldSeed.obsSpec = { version: 1, dim: 80 };
    const oldFile = path.join(TMP, 'oldseed.json');
    fs.writeFileSync(oldFile, JSON.stringify(oldSeed));
    let oldRefused = false, oldMsg = '';
    try { evolve(['--seed-from', oldFile, '--role', 'defense', '--gens', '1', '--pop', '4',
      '--stages', '0', '--quiet', '--out', path.join(TMP, 'never2.json')]); }
    catch (e) { oldRefused = true; oldMsg = String(e.stdout || '') + String(e.stderr || ''); }
    T('W: v1（80 欄）種子拒絕載入', oldRefused && /觀測規格/.test(oldMsg), oldMsg.trim().slice(-70));

    // --resume 已經帶著族群，再給 --seed-from 是互相矛盾的指令
    let bothRefused = false, bothMsg = '';
    try { evolve(['--resume', path.join(TMP, 'warm-defense.json'), '--seed-from', seedFile,
      '--gens', '1', '--quiet']); }
    catch (e) { bothRefused = true; bothMsg = String(e.stdout || '') + String(e.stderr || ''); }
    T('W: --resume 與 --seed-from 不能同時給', bothRefused && /不能再給/.test(bothMsg),
      bothMsg.trim().slice(-60));
  }
}

// ══════ 7. 反射層與自我傷害（觀測 v2 的後半段）══════
section('reflex & self-damage');
{
  const Controller = require('./ai/controller');
  const { ACTIONS } = require('./ai/actions');
  const front = Observation.OBS_DIM - Observation.LEN.front;
  T('O: 觀測 v2 的 front 段在最後 LEN.front 欄（起點 80）',
    Observation.OBS_SPEC.version === 2 && Observation.LEN.front === 5 && front === 80,
    `v${Observation.OBS_SPEC.version} len=${Observation.LEN.front} base=${front}`);

  // 反射層：前方堵死 → 換到可走的方向；四面堵死 → 維持原結論（別亂動）
  const obs = dir => {
    const o = new Float64Array(Observation.OBS_DIM);
    for (let d = 0; d < 4; d++) o[front + d] = d === dir ? 1 : 0;
    o[Observation.OBS_DIM - 1] = 1;                    // 目前朝向也堵
    return o;
  };
  const esc = Controller.escapeBlocked;
  T('R: 正前方是牆 → 改挑走得通的方向', esc(obs(0), 0, 0) === 1, esc(obs(0), 0, 0));
  T('R: 選的是射擊、但面朝牆 → 先讓車能動（射擊時用目前朝向判斷）',
    esc(obs(2), ACTIONS.FIRE, 2) !== ACTIONS.FIRE, esc(obs(2), ACTIONS.FIRE, 2));
  T('R: 沒堵的方向照過（反射不該搶走正常的決策）', esc(obs(0), 3, 0) === 3);
  T('R: 四面全堵 → 維持原結論，不亂轉', (() => {
    const o = new Float64Array(Observation.OBS_DIM);
    for (let d = 0; d < 5; d++) o[front + d] = 1;
    return esc(o, 1, 1) === 1;
  })());
  // 反悔偵測：網路想原路退回時，反射層要先幫它挑一個前進/垂直方向，
  // 不能只是否決 → 否決到底就變成站著不動，仍然不是「積極進攻」。
  T('R: 反射層會封住「不準原路退回」的方向並改選別路',
    esc(obs(-1), 2, 0, 2) !== 2, esc(obs(-1), 2, 0, 2));
  T('R: 前方撞牆時回頭路照樣放行（banned=-1）', esc(obs(0), 2, 0) === 2);
  T('R: 規則 AI 不再直接改 tank.dir（統一經過 moveAsAI）',
    /moveAsAI/.test(fs.readFileSync(path.join(__dirname, 'js', 'ai.js'), 'utf8')) &&
    !/tank\.dir\s*=(?!=)/.test(fs.readFileSync(path.join(__dirname, 'js', 'ai.js'), 'utf8')));

  // 「拆自己家」只有一個定義：老師、競技場、監測、反射層都呼叫同一個 predicate
  T('S: 「拆自己家」只有一個定義（老師/競技場/監測都呼叫 controller 那一份）',
    typeof Controller.ownBaseInFront === 'function'
    && ['ai/teacher.js', 'ai/arena.js', 'ai/telemetry.js'].every(f =>
      /ownBaseInFront/.test(fs.readFileSync(f, 'utf8'))));
  {
    // 用合成小地圖把「老鷹在槍線上」這件事鎖死。
    // 座標一律從**真實常數**推（18×42 的 9:21 長場：藍隊老鷹在底邊 cy 40..41、
    // 紅隊在頂邊 cy 0..1，兩邊都在 cx 8..9），不要再抄「12,23」這種舊坐標 ——
    // 抄死的數字換一次地形就會變成「測到錯的東西但不報錯」。
    // 坦克 16×16（中心落在 cx+1, cy+1 格），射線從 center 往前 10px 起算，
    // 所以朝下開的第一格是 cy+2。
    // 不跑真引擎是因為 ownBaseInFront 只看 map.baseAtCell / map.cellAt，
    // 用真地圖反而會被那一局的隨機佈防干擾，測的就不是這個 predicate 了。
    const RG = arena.R;
    const BRICK = RG.CELL_TYPE.BRICK;
    const GW = RG.GRID_W, GH = RG.GRID_H;
    const BLUE_EAGLE = RG.DEMO_BASE_CELLS[0];   // {cx:8, cy:40}
    const RED_EAGLE = RG.DEMO_BASE_CELLS[1];    // {cx:8, cy:0}
    const mkMap = bricks => ({
      // 給 gridOf() 讀真實邊界（沒有 cells 時它退回後備值，測試就等於沒驗到邊界）
      cells: Array.from({ length: GH }, () => new Array(GW).fill(0)),
      bases: [{ team: 0, cx: BLUE_EAGLE.cx, cy: BLUE_EAGLE.cy },
              { team: 1, cx: RED_EAGLE.cx, cy: RED_EAGLE.cy }],
      baseAtCell(cx, cy) {
        for (const b of this.bases)
          if (cx >= b.cx && cx < b.cx + 2 && cy >= b.cy && cy < b.cy + 2) return b;
        return null;
      },
      cellAt: (cx, cy) => (bricks.includes(cx + ',' + cy) ? BRICK : 0),
    });
    const mk = (team, dir, cx, cy) => ({
      team, dir, x: cx * 8, y: cy * 8,
      center() { return { x: this.x + 8, y: this.y + 8 }; },
    });
    // 槍線走的那一欄 = 中心欄 = cx+1（放在老鷹 2×2 的左欄上，正好斜著蓋到右欄）
    const COL = BLUE_EAGLE.cx;          // 車停 cx=8 → 查核欄位 cx+1=9（老鷹的右欄）
    const ABOVE = BLUE_EAGLE.cy - 5;    // 35 → 第一格 37，離要塞牆還有一格
    const open = { map: mkMap([]) };
    const atHomeDown = Controller.ownBaseInFront(mk(0, 2, COL, ABOVE), open);  // 藍車朝下＝自家老鷹
    const facingAway = Controller.ownBaseInFront(mk(0, 3, COL, ABOVE), open);  // 朝左 → 一路出界
    const foeEagle = Controller.ownBaseInFront(mk(0, 0, COL, ABOVE), open);    // 朝上打的是紅家老鷹
    const walled = { map: mkMap([(COL + 1) + ',' + (ABOVE + 2)]) };
    const brickBetween = Controller.ownBaseInFront(mk(0, 2, COL, ABOVE), walled);
    T('S: 老鷹在槍線上 → 判定不安全（這一槍會拆自己家）', atHomeDown === true);
    T('S: 轉個頭就安全（predicate 不是「有基地就擋」）', facingAway === false, String(facingAway));
    T('S: 敵家老鷹在槍線上 → 安全（這槍有意義，不能一起攔）', foeEagle === false, String(foeEagle));
    T('S: 中間隔著磚 → 安全（子彈根本飛不到老鷹）', brickBetween === false, String(brickBetween));
    T('S: 單人模式（沒有自家基地）不會被誤判', (() => {
      const fake = { map: { bases: [null, null], baseAtCell: () => null, cellAt: () => 0 } };
      return Controller.ownBaseInFront(mk(0, 2, COL, ABOVE), fake) === false;
    })());
  }

  // v6 把「拆自己家」擴大成「傷到要塞本體或要塞的牆都算」，而且只有磚／鋼會擋子彈。
  // 這一段的磚環**直接叫 GameMap.ringCells() 算**（js/map.js 建環用的同一支函式），
  // base 座標直接讀 DEMO_BASE_CELLS —— 這樣「測試自己編一套地圖、遊戲又是另一套」
  // 這件事在結構上就不可能發生，換地形時也不會悄悄失效。
  {
    const RG = arena.R;
    const CT = RG.CELL_TYPE;
    const GW = RG.GRID_W, GH = RG.GRID_H;          // 18×42：ringKeys 的索引寬度
    const BLUE = RG.DEMO_BASE_CELLS[0];            // 藍（下）{cx:8, cy:40}
    const RED = RG.DEMO_BASE_CELLS[1];             // 紅（上）{cx:8, cy:0}
    const RING = [
      RG.GameMap.ringCells(BLUE.cx, BLUE.cy, false),
      RG.GameMap.ringCells(RED.cx, RED.cy, true),
    ];
    const key = (cx, cy) => cx + ',' + cy;
    // 開局時整圈環就是磚（js/map.js 的 _addBase 無條件蓋磚），所以預設值也是磚；
    // override 用來模擬「牆被打掉／鏟子變鋼／場上蓋了水或樹林」。
    const mkGame = (override = {}, opts = {}) => {
      const cells = {};
      for (let t = 0; t < 2; t++) for (const [x, y] of RING[t]) cells[key(x, y)] = CT.BRICK;
      Object.assign(cells, override);
      const cellAt = (cx, cy) => cells[key(cx, cy)] || CT.EMPTY;
      const bases = [BLUE, RED].map((b, t) => ({
        team: t, cx: b.cx, cy: b.cy,
        ring: RING[t],
        ringKeys: new Set(RING[t].map(([x, y]) => y * GW + x)),
      }));
      const map = {
        // 真實邊界：controller 的 gridOf() 現讀 cells，out-of-bounds 才算「子彈消失」
        cells: Array.from({ length: GH }, () => new Array(GW).fill(CT.EMPTY)),
        bases, cellAt,
        baseAtCell(cx, cy) {
          for (const b of bases)
            if (cx >= b.cx && cx < b.cx + 2 && cy >= b.cy && cy < b.cy + 2) return b;
          return null;
        },
      };
      // 真實 map 有 isFortressWall；留一條「只有 ringKeys 的舊 stub」給相容性測試。
      if (!opts.noIsFortressWall) {
        map.isFortressWall = (base, cx, cy) => {
          if (!base.ringKeys.has(cy * GW + cx)) return false;
          const v = cellAt(cx, cy);
          return v === CT.BRICK || v === CT.STEEL;
        };
      }
      return { map };
    };
    const gun = (team, dir, cx, cy) => ({
      team, dir, x: cx * 8, y: cy * 8,
      center() { return { x: this.x + 8, y: this.y + 8 }; },
    });
    const UP = 0, RIGHT = 1, DOWN = 2, LEFT = 3;
    const safe = (tank, g) => Controller.ownBaseInFront(tank, g) === false;

    // 藍車放在 (cx 8, cy 35)：中心落在 (9, 36)，子彈往下第一格是 (9, 37)。
    // (9,37)「不在環上」（藍隊環的頂牆是第 38、39 列），所以它能當「環外的一般牆」；
    // 再往下 (9,38)/(9,39) 才是要塞牆，最後 (9,40) 是老鷹。
    // ⚠ 這些列號全部由 ringCells 算出來的真實幾何決定，不是抄的數字。
    const TANK_CY = BLUE.cy - 5;              // 35
    const LANE = BLUE.cx + 1;                 // 9 —— 射線實際走的那一欄
    const OUTSIDE_RING = TANK_CY + 2;         // 37：槍線上第一格，環外
    const WALL_ROW = RING[0].filter(([x]) => x === LANE).map(([, y]) => y).sort((a, b) => a - b);
    const A_TANK = () => gun(0, DOWN, BLUE.cx, TANK_CY);
    const wallKeys = WALL_ROW.map(y => key(LANE, y));
    const outsideKey = key(LANE, OUTSIDE_RING);
    const foeWallRow = RING[1].filter(([x]) => x === LANE).map(([, y]) => y).sort((a, b) => b - a);
    const foeKeys = foeWallRow.map(y => key(LANE, y));

    // ① 自家要塞牆在彈道上 → 這一槍不準（v6 新增的半條規則）
    const ringBrick = mkGame();
    T('S6: 打在自家要塞牆（環上的磚）→ 判定為傷到要塞，不準開火',
      safe(A_TANK(), ringBrick) === false);
    // ② 牆已經被打掉，槍線直撞老鷹 → 照樣不準
    const hole = mkGame(Object.fromEntries(wallKeys.map(k => [k, CT.EMPTY])));
    T('S6: 要塞牆已缺 → 同一條線上是自家老鷹，一樣不準',
      safe(A_TANK(), hole) === false);
    // ③ 擋在前面的是環外的一般磚 → 子彈飛不到要塞 → 放行
    const plainWall = mkGame(Object.fromEntries(
      wallKeys.map(k => [k, CT.EMPTY]).concat([[outsideKey, CT.BRICK]])));
    T('S6: 中途被環外的一般磚擋住 → 這槍碰不到要塞與要塞牆 → 放行',
      safe(A_TANK(), plainWall) === true);
    // ④ 水／樹林不擋子彈（js/map.js bulletHit 的事實）：不能拿它們當擋箭牌
    const overWater = mkGame(Object.fromEntries(wallKeys.map(k => [k, CT.WATER])));
    const overForest = mkGame(Object.fromEntries(wallKeys.map(k => [k, CT.FOREST])));
    T('S6: 要塞牆的位置是水 → 水不擋子彈，這一槍會打到自家老鷹 → 不準',
      safe(A_TANK(), overWater) === false);
    T('S6: 要塞牆的位置是樹林 → 同理不準（只有磚／鋼會擋子彈）',
      safe(A_TANK(), overForest) === false);
    // ⑤ 鏟子把牆變成鋼：仍是要塞牆（座標屬性），還是不準打
    const steelRing = mkGame({ [wallKeys[0]]: CT.STEEL });
    T('S6: 鏟子把要塞牆變成鋼 → 還是自家要塞牆 → 不準開火',
      safe(A_TANK(), steelRing) === false);
    // ⑥ 環外的一格變鋼（跟要塞無關）→ 擋住了 → 放行
    const steelOutside = mkGame(Object.fromEntries(
      wallKeys.map(k => [k, CT.EMPTY]).concat([[outsideKey, CT.STEEL]])));
    T('S6: 環外的鋼擋住彈道 → 安全', safe(A_TANK(), steelOutside) === true);
    // ⑦ 槍線上第一個撞到的是敵家老鷹（那兩排環先清掉）→ 這槍有意義
    const atRedEagle = mkGame(Object.fromEntries(foeKeys.map(k => [k, CT.EMPTY])));
    T('S6: 彈道先撞到敵隊老鷹 → 放行（不是「所有朝上的槍都禁」）',
      safe(gun(0, UP, BLUE.cx, RED.cy + 4), atRedEagle) === true,
      '環欄=' + JSON.stringify(WALL_ROW) + ' 敵環欄=' + JSON.stringify(foeWallRow));
    // ⑧ 先撞到敵隊要塞牆 → 那是對面的牆，不是自家的 → 放行
    T('S6: 先撞到敵隊要塞牆 → 放行（只禁傷到「自己」的要塞）',
      safe(gun(0, UP, BLUE.cx, RED.cy + 4), ringBrick) === true);
    // ⑨ 四個方向都要查得對：同一台車轉離自家老鷹就照樣能打
    T('S6: 同一台車朝上（離開自家鷹）→ 準開火',
      safe(gun(0, UP, BLUE.cx, TANK_CY), ringBrick) === true);
    // 車在環上方時，左右兩邊都撞不到環（橫向那一排不是環列）；
    // 車蓋在環正中央（第 38／39 列）時左右照樣會打到自家牆，那種格子不在這裡測。
    T('S6: 左／右朝向撞不到要塞牆 → 準開火（不是「在家門口就一律禁射」）',
      safe(gun(0, LEFT, BLUE.cx, TANK_CY), ringBrick) === true &&
      safe(gun(0, RIGHT, BLUE.cx, TANK_CY), ringBrick) === true);
    // ⑩ 紅隊鏡像：老鷹在頂邊，朝上打就是拆自己家
    T('S6: 紅隊（老鷹在頂邊）朝上打自家要塞牆 → 一樣不準',
      safe(gun(1, UP, RED.cx, RED.cy + 4), ringBrick) === false);
    T('S6: 紅隊朝下打（往下是敵場，先撞到的是藍家的牆）→ 放行',
      safe(gun(1, DOWN, RED.cx, RED.cy + 4), ringBrick) === true);
    // ⑪ 出界＝子彈消失 → 安全
    T('S6: 朝左打出界（路上沒有要塞）→ 安全',
      safe(gun(0, LEFT, 3, 20), ringBrick) === true);
    // ⑫ 舊 stub 沒有 isFortressWall 時要退回 ringKeys（兩條路都得擋住要塞牆）
    const legacyStub = mkGame({}, { noIsFortressWall: true });
    T('S6: map 沒有 isFortressWall 時退回 base.ringKeys（不是靜默放行）',
      safe(A_TANK(), legacyStub) === false && safe(A_TANK(), ringBrick) === false,
      'ringKeys 寬度=' + GW);
    // ⑬ 單人模式：敵車是紅隊（js/entities.js：不是玩家就是 TEAM.RED），而單人地圖
    //     只有 index 0 一座老鷹 → bases[1] 是 undefined → 判定恆安全，
    //     57 項單人測試的行為不會被這條新規則動到。
    //     （team 沒有定義時也一樣放行，免得以後哪個新模式漏設 team 就整場不開火。）
    {
      const single = mkGame();
      single.map.bases = [single.map.bases[0]];
      delete single.map.bases[1];
      T('S6: 單人模式的敵車（無 own base）→ 判定恆安全，不會被新規則綁手綁腳',
        Controller.ownBaseInFront(gun(1, UP, BLUE.cx, TANK_CY), single) === false &&
        Controller.ownBaseInFront(gun(1, DOWN, BLUE.cx, TANK_CY), single) === false &&
        Controller.ownBaseInFront(gun(undefined, DOWN, BLUE.cx, TANK_CY), single) === false,
        'UP=' + Controller.ownBaseInFront(gun(1, UP, BLUE.cx, TANK_CY), single) +
        ' DOWN=' + Controller.ownBaseInFront(gun(1, DOWN, BLUE.cx, TANK_CY), single));
    }
  }

  // 老師的取樣要真的分得開事件，否則「加權取樣」是空的。
  // 注意 aim 不在 eventsSeen：它不是「某一幀的分類」，而是另外補的射擊標籤，
  // 所以看 eventsKept。
  {
    const Teacher = require('./ai/teacher');
    const seen = Teacher.collect({ stages: [0], gamesPerStage: 1, maxFrames: 1800, seedBase: 4321,
      shares: { keep: 0.2 } });
    const ev = seen.meta.eventsSeen, kept = seen.meta.eventsKept;
    T('T: 老師四類逐幀事件都收得到（卡牆/自由轉向/開火/繼續走）',
      ['stuck', 'freeTurn', 'fire', 'keep'].every(k => (ev[k] || 0) > 0), JSON.stringify(ev));
    T('T: 「有射擊線」的補標籤也有收到（射擊覆蓋率靠它）', (kept.aim || 0) > 0, JSON.stringify(kept));
    T('T: 「有射擊線」樣本的標籤是射擊（不然射擊覆蓋率是假的）',
      seen.samples.filter(s => s.event === 'aim').every(s => s.label === ACTIONS.FIRE));
    T('T: 「卡牆」樣本確實沒移動（分類用位置差，不是 8px 預探）',
      seen.samples.filter(s => s.event === 'stuck').every(s => s.moved === 0));
    T('T: keep 降權後樣本數確實變少（資料是可控的，不是越大越好）',
      seen.meta.kept < seen.meta.rawFrames, `${seen.meta.kept} / ${seen.meta.rawFrames}`);
  }
}

// ══════ U. 訓練履歷：次數與標準都出自同一支碼 ══════
section('ledger / provenance');
{
  const Ledger = require('./ai/ledger');
  const Fitness = require('./ai/fitness');

  // U1. 標準表不能漏項 —— 展示給使用者的標準少一項，比沒有標準更糟
  const rb = Ledger.rubric();
  T('U: 每個權重都有評判標準說明（rubric.undocumented 為空）',
    rb.undocumented.length === 0, rb.undocumented.join(','));
  T('U: TERMS 的權重與 WEIGHTS 一致（標準表不是另外寫的說明）',
    Fitness.TERMS.every(t => t.weight === Fitness.WEIGHTS[t.key]));
  T('U: 評判標準帶算分版本與觀測版本',
    rb.scoringVersion === Fitness.SCORING_VERSION &&
    rb.obsSpec.version === Observation.OBS_SPEC.version);

  // U2. 逐項拆解加總 = 實際適應度（同一份碼，不是兩套算法）
  //     v6：拆解只列「這個角色」適用的項次，所以比的是 termsFor(role)，
  //     不是整張 TERMS（兩個角色各看一套標準，這正是 v6 的重點）。
  const rep = arena.run({ stage: 0, seed: hashSeed(0xabc, 0, 1), blue: 'rule', red: 'rule' });
  const ex = Fitness.explainFitness(rep.teams[0], rep, 0, {});
  const sumRows = ex.allItems.reduce((a, r) => a + r.contribution, 0);
  T('U: 拆解的各項加總等於它自己的總和（蓋地板前）',
    Math.abs(sumRows - ex.sum) < 1e-9, `${sumRows} vs ${ex.sum}`);
  T('U: explainFitness 的總分等於 teamFitness（兩個入口同一份算法）',
    ex.total === Fitness.teamFitness(rep.teams[0], rep, 0, {}));
  T('U: 拆解列出這個角色的所有計分項（不是只列有分的，也不混進別的角色）',
    ex.allItems.length === Fitness.termsFor('attack').length && ex.role === 'attack' &&
    Fitness.explainFitness(rep.teams[1], rep, 1, {}).allItems.length === Fitness.termsFor('defense').length,
    `${ex.allItems.length}（進攻）vs TERMS 共 ${Fitness.TERMS.length}`);

  // U2b. v7 新增的兩筆計量：貼身殲滅（duelKills／duelFrames）與自破（ownBaseKilledBySelf）。
  //      計量必須真的從遊戲狀態讀出來 —— fitness 那兩項如果拿到 undefined，
  //      使用者的兩條規則就只是寫在文件上，訓練根本不會看。
  {
    let duelSeen = 0, ownGoalRounds = 0, bad = null;
    for (let i = 0; i < 6 && !bad; i++) {
      const r = arena.run({ stage: i % 4, seed: hashSeed(0xd7e1, i, 3), blue: 'rule', red: 'rule' });
      if (typeof r.ownGoal !== 'boolean' ||
          !(r.ownGoalTeam === null || typeof r.ownGoalTeam === 'number'))
        bad = { round: i, why: 'report 少了 ownGoal／ownGoalTeam' };
      if (r.ownGoal !== (r.ownGoalTeam !== null && r.ownGoalTeam >= 0))
        bad = { round: i, why: 'ownGoal 與 ownGoalTeam 不一致' };
      for (const t of r.teams) {
        if (typeof t.duelKills !== 'number' || typeof t.duelFrames !== 'number' ||
            typeof t.ownBaseKilledBySelf !== 'boolean' || typeof t.foeBaseOwnGoal !== 'boolean')
          bad = { team: t.team, why: 'v7 計量欄位不存在或型別不對' };
        else if (t.duelKills > t.kills)
          bad = { team: t.team, duelKills: t.duelKills, kills: t.kills, why: '貼身殲滅比總擊殺還多' };
        duelSeen += t.duelKills;
        if (t.ownBaseKilledBySelf) ownGoalRounds++;
      }
    }
    T('A v7: 每隊都帶得出「貼身殲滅」與「自家老鷹被自己人打爆」兩筆計量',
      bad === null, bad ? JSON.stringify(bad) : '');
    T('A v7: 規則 AI 互打會真的產生貼身殲滅（計量是活的，不是恆 0）',
      duelSeen > 0, `6 局共 ${duelSeen} 台`);
    // 這一條用固定種子，所以不會偶發紅；它守的是「彈道閘 + 貼身優先」這兩條
    // 一起工作時，不要出現自己把自己家打爆的結局（真出現就是要重新看規則）。
    T('A v7: 這 6 局固定種子的規則對局裡沒有任何一隊打爆自家老鷹',
      ownGoalRounds === 0, `${ownGoalRounds} 局自破`);
  }

  // U3. 每擊殺至少造成 1 hp：致命一擊若被漏算，damageDone 會 < kills
  //     （這是修過的 bug：舊差分加了 t.alive 條件，打死那一下整條 hp 都不計）
  //     炸彈道具是例外：它直接判死、不經過 takeDamage()，所以另外記 bombKills。
  {
    let bad = null;
    for (let s = 0; s < 4 && !bad; s++) {
      const r = arena.run({ stage: s % 3, seed: hashSeed(0xabc, s % 3, 7), blue: 'rule', red: 'rule' });
      for (const t of r.teams)
        if (t.kills > 0 && t.damageDone + (t.bombKills || 0) < t.kills)
          bad = { kills: t.kills, dmg: t.damageDone, bomb: t.bombKills || 0 };
    }
    T('U: 傷害計量含致命一擊（damageDone + 炸彈擊殺 ≥ 擊殺數）',
      bad === null, bad ? JSON.stringify(bad) : '');
  }

  // U4. 工作階段要跨 process 累加，而且增量是「差值」不是累計
  const file = path.join(TMP, 'ledger.json');
  evolve(['--gens', '2', '--pop', '4', '--stages', '0', '--seeds', '1', '--quiet', '--out', file]);
  const j1 = Checkpoint.load(file, Observation.OBS_SPEC);
  const wasGen = j1.neat.generation, wasEp = j1.episodes;
  T('U: 新訓練會記下第 1 段工作階段',
    (j1.sessions || []).length === 1, JSON.stringify((j1.sessions || []).length));
  const t1 = j1.sessions[0];
  T('U: 工作階段記了來源與起訖時間',
    t1.source === 'cold' && !!t1.startedAt && !!t1.finishedAt &&
    t1.generations === wasGen && t1.episodes === wasEp,
    JSON.stringify({ src: t1.source, g: t1.generations, e: t1.episodes }));

  const out2 = path.join(TMP, 'ledger-out.json');
  evolve(['--resume', file, '--gens', '1', '--pop', '4', '--stages', '0', '--seeds', '1',
    '--quiet', '--export-to', out2]);
  const j2 = Checkpoint.load(file, Observation.OBS_SPEC);
  T('U: 第二次開機會追加第 2 段（不是覆蓋）', (j2.sessions || []).length === 2);
  const t2 = j2.sessions[1];
  T('U: 第 2 段的增量正確（代數／場數都是差值，不是累計）',
    t2.source === 'resume' && t2.generations === 1 &&
    t2.episodes === j2.episodes - j2.sessions[0].episodes,
    `${t2.generations} 代 ${t2.episodes} 場`);
  T('U: 每段都記了算分版本',
    j2.sessions.every(s => s.scoringVersion === Fitness.SCORING_VERSION));

  // U5. 匯出檔要帶履歷，履歷也要讀得回來
  const exJson = JSON.parse(fs.readFileSync(out2, 'utf8'));
  T('U: 匯出檔帶 provenance、算分版本與匯出時間',
    !!exJson.provenance && exJson.scoringVersion === Fitness.SCORING_VERSION && !!exJson.exportedAt);
  const res = Ledger.resumeOf(out2);
  T('U: 匯出檔的履歷讀得到 2 段訓練',
    res.counts.sessions === 2 && res.counts.sessionsInferred === false);
  T('U: 履歷的「可比較」判定跟著算分版本',
    res.scoring.version === Fitness.SCORING_VERSION && res.scoring.comparable === true);

  // U6. 舊存檔（沒有 sessions）要標成推導，不能編一條時間軸
  const legacy = JSON.parse(JSON.stringify(j2));
  delete legacy.sessions;
  fs.writeFileSync(file, JSON.stringify(legacy));
  const old = Ledger.resumeOf(file);
  T('U: 沒有 sessions 的舊存檔標成「推導」而不是假時間軸',
    old.counts.sessionsInferred === true && old.counts.sessionList[0].inferred === true &&
    old.counts.sessionList[0].startedAt === null);

  // U7. 別人家的 JSON 要被拒絕，不能當成自己的成績單
  const alien = path.join(TMP, 'alien.json');
  fs.writeFileSync(alien, JSON.stringify({ kind: 'something-else', obsSpec: Observation.OBS_SPEC }));
  let refused = false;
  try { Ledger.resumeOf(alien); } catch (e) { refused = /不是本專案的訓練產物/.test(e.message); }
  T('U: 外來 kind 被拒絕（不冒充本專案產物）', refused);

  // U8. 考績寫回檔案，但不動訓練進度
  //     v6：席位固定（藍＝進攻、紅＝防守），所以一局考績只打一個位子，
  //     games = 地圖數 × 每圖種子數（v5 是 ×2 座位）。
  const before = Checkpoint.load(file, Observation.OBS_SPEC).neat.generation;
  // maxFrames 要 ≥1890（規則上一局最多 1890 幀：30 秒倒數＋開場那幾幀）——
  // 之前寫 1500，v11 剛好都卡在「進攻 25 秒內破網」所以結局有 reason；
  // v12 開始付錢給殲滅之後，2 代 pop4 的冠軍會先在場上清人，1500 幀不夠它收尾，
  // arena 只能回 end=null（考績就記成 '?'）。那不是尺壞，是考卷被截掉了。
  const v = Ledger.verify(file, { stages: [0], seedsPerStage: 1, maxFrames: 1900 });
  const after = Checkpoint.load(file, Observation.OBS_SPEC);
  const a0 = after.assessments[0];
  T('U: --verify 追加考績且不改動代數',
    v.assessments === 1 && after.neat.generation === before &&
    after.assessments.length === 1 && a0.games === 1,
    JSON.stringify({ n: after.assessments && after.assessments.length, g: after.neat.generation }));
  T('U: 考績記的是「哪個角色坐哪個位子」，不再藍紅各打一輪',
    a0.role === 'attack' && a0.seat === 0 && a0.gamesPerSeat === 1 &&
    ['breach', 'counter', 'time', 'pool'].includes(Object.keys(a0.ends || {})[0]),
    JSON.stringify({ role: a0.role, seat: a0.seat, ends: a0.ends }));
}

// ══════ 11. 即時看板資料層（ai/live.js） ══════
section('live');
{
  const Ledger = require('./ai/ledger');
  // L1. 訓練程序端：吃記憶體、running 是確定的布林值
  const lf = path.join(TMP, 'live-checkpoint.json');
  evolve(['--gens', '2', '--pop', '4', '--stages', '0', '--seeds', '1', '--quiet', '--out', lf]);
  const ck = Checkpoint.load(lf, Observation.OBS_SPEC);

  const meta = {
    config: ck.config,
    episodes: ck.episodes,
    champion: ck.champion,
    sessions: ck.sessions,
    assessments: ck.assessments,
  };
  const neat = { generation: ck.neat.generation, history: ck.neat.history };
  const L1 = Live.fromTrainer(lf, meta, neat, true);
  T('L: 訓練端 payload 帶確定 running=true 與目前代數',
    L1.kind === Live.KIND && L1.running === true && L1.gen === ck.neat.generation &&
    L1.episodes === ck.episodes, JSON.stringify({ g: L1.gen, e: L1.episodes }));
  // v6：一個族群只練一個角色、只坐一個位子，所以每代場數不再 ×2。
  T('L: 每代場數由 族群×地圖×種子×座位數 算出來（v6 單座位）',
    ck.config.seats === 1 &&
    L1.perGen === ck.config.pop * ck.config.stages.length * ck.config.seeds * ck.config.seats,
    `${L1.perGen} vs ${ck.config.pop}×${ck.config.stages.length}×${ck.config.seeds}×${ck.config.seats}`);
  T('L: 本段進度（doneGens／targetGens）讀得到',
    L1.session && L1.session.doneGens === ck.neat.generation - ck.sessions[0].fromGeneration &&
    L1.session.targetGens === 2,
    JSON.stringify(L1.session && { d: L1.session.doneGens, t: L1.session.targetGens }));
  T('L: 冠軍摘要與指紋跟履歷同一套',
    L1.champion && L1.champion.fingerprint === Ledger.fingerprint(ck.champion.genome) &&
    L1.champion.fitness === ck.champion.fitness,
    L1.champion && L1.champion.fingerprint);

  // L2. 檔案監看端：running 必須是 null（不知道程序活著沒），不能冒充「訓練中」或「已停止」
  const L2 = Live.fromCheckpoint(ck, lf, { mode: 'watch', running: null });
  T('L: 檔案監看的 running=null（不謊稱訓練中／已停止）',
    L2.running === null && L2.mode === 'watch');
  T('L: 監看模式仍帶得出本段起點（換圖接縫要靠它）',
    L2.session && L2.session.fromGeneration === ck.sessions[0].fromGeneration &&
    Array.isArray(L2.sessions) && L2.sessions.length === ck.sessions.length);
  T('L: 歷史只保留需要的欄位（gen/best/mean/species/raw/zero）',
    L2.history.length === ck.neat.history.length &&
    Object.keys(L2.history[0]).sort().join(',') === 'best,gen,mean,raw,species,zero');
  // raw／zero 是批次一（0 分保留原分排序）帶出來的兩行：
  // best 曲線平在 0 的時候，只有這兩行能分辨「停滯」跟「地板下面還在長」。
  T('L: 原始分與 0 分占比會進看板（平在 0 的曲線要靠它判讀）',
    Number.isFinite(L2.history[0].raw) && L2.history[0].zero >= 0 && L2.history[0].zero <= 1,
    JSON.stringify(L2.history[0]));
  // 參考尺（固定對手的分數）：沒量過就不能憑空出現 0 —— 那會被讀成「參考分是 0 分」。
  T('L: 沒有參考尺時看板给 null（不是拿 0 冒充量過）',
    L2.reference === null || L2.reference.history.length === 0 ||
      (L2.reference.latest && typeof L2.reference.latest.scores === 'object'));

  // L3. 考績要跟著 payload 出去，看板才知道實戰成績
  Ledger.verify(lf, { stages: [0], seedsPerStage: 1, maxFrames: 1500 });
  const ck2 = Checkpoint.load(lf, Observation.OBS_SPEC);
  const L3 = Live.fromCheckpoint(ck2, lf, { mode: 'snapshot', running: null });
  T('L: 考績（assessments）會進即時看板，且帶得出角色與局數',
    L3.assessments.length === 1 && L3.assessments[0].games === 1 &&
    L3.assessments[0].role === 'attack',
    JSON.stringify(L3.assessments[0] && { n: L3.assessments.length, g: L3.assessments[0].games, r: L3.assessments[0].role }));
  T('L: 看板知道這一族練的是哪個角色（席位不再靠猜）',
    L3.role === 'attack' && L3.seat === 0 && L3.roleLabel === '進攻',
    JSON.stringify({ role: L3.role, seat: L3.seat, label: L3.roleLabel }));

  // L4. 產出必須是可直接用 <script src> 載入的 JS，而不是 JSON
  const outJs = path.join(TMP, 'live-data.js');
  const wrote = Live.tryWrite(outJs, L1);
  const txt = fs.readFileSync(outJs, 'utf8');
  const sandbox = { window: {} };
  vm.runInNewContext(txt, sandbox);
  T('L: 產出是 window.__LIVE__ 的 <script>（file:// 才能載入）',
    wrote && txt.includes('window.__LIVE__ = ') &&
    sandbox.window.__LIVE__.kind === Live.KIND && sandbox.window.__LIVE__.running === true);
  T('L: 序列化後數字與記憶體一致（看板不重算）',
    sandbox.window.__LIVE__.best === L1.best &&
    sandbox.window.__LIVE__.history.length === L1.history.length);

  // L5. CLI --once 也走同一份 fromCheckpoint，不能出現第二套格式
  const cliOut = path.join(TMP, 'live-cli.js');
  execFileSync(process.execPath, ['ai/live.js', '--once', lf, '--out', cliOut],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const cliSandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(cliOut, 'utf8'), cliSandbox);
  T('L: CLI --once 產生的格式與訓練端相同（同一個 KIND／欄位）',
    cliSandbox.window.__LIVE__.kind === Live.KIND &&
    cliSandbox.window.__LIVE__.sessions.length === L3.sessions.length &&
    cliSandbox.window.__LIVE__.checkpointMtime !== null);
}

// ══════ 12. 雙族群訓練端：--role／--vs／換對手重評 ══════
section('dual population');
{
  const dir = path.join(TMP, 'dual');
  fs.mkdirSync(dir, { recursive: true });
  const ckA = path.join(dir, 'p-attack.json');
  const ckD = path.join(dir, 'p-defense.json');
  const snap = path.join(dir, 'opp-snapshot.json');
  const light = ['--pop', '4', '--stages', '0', '--seeds', '1', '--quiet'];

  // P1. 角色只能是兩個之一：「雙方都要」在 v6 不成立（兩個角色的標準互斥）
  let badRole = '';
  try { evolve(['--role', 'both', '--gens', '1', '--out', path.join(dir, 'nope.json')].concat(light)); }
  catch (e) { badRole = String(e.stdout || '') + String(e.stderr || ''); }
  T('P: --role 只接受 attack／defense（「兩個都要」不是角色）',
    /--role/.test(badRole) && !fs.existsSync(path.join(dir, 'nope.json')), badRole.trim().slice(-50));

  // P2. 角色要落進存檔：接續時不需要（也不應該）再講一次
  evolve(['--role', 'defense', '--gens', '1', '--out', ckD].concat(light));
  const jD = Checkpoint.load(ckD, Observation.OBS_SPEC);
  T('P: 防守族群把角色與席位寫進存檔（defense／只坐一席）',
    jD.config.role === 'defense' && jD.config.seats === 1 && jD.role === 'defense',
    JSON.stringify({ role: jD.config.role, seats: jD.config.seats }));
  T('P: 每代場數只算自己那一席（pop×圖×種子×1）', jD.episodes === 4, jD.episodes);
  T('P: 防守族群的考題是紅席（冠軍那筆記的是「打誰」）',
    jD.champion.measuredAgainst === 'rule' && jD.champion.role === 'defense',
    JSON.stringify({ vs: jD.champion.measuredAgainst, role: jD.champion.role }));

  // P3. 接續時給錯角色 → 拒絕，且存檔保持原樣
  const genD = jD.neat.generation;
  let mixed = '';
  try { evolve(['--resume', ckD, '--role', 'attack', '--gens', '1', '--quiet']); }
  catch (e) { mixed = String(e.stdout || '') + String(e.stderr || ''); }
  T('P: 用錯角色接續會被拒絕（不會把防守模型拿去練進攻）',
    /與存檔/.test(mixed) && Checkpoint.load(ckD, Observation.OBS_SPEC).neat.generation === genD,
    mixed.trim().slice(-70));

  // P4. --vs 找不到檔 → 當場拒絕，不能假裝在打對手
  let noVs = '';
  try { evolve(['--resume', ckD, '--vs', path.join(dir, 'ghost.json'), '--gens', '1', '--quiet']); }
  catch (e) { noVs = String(e.stdout || '') + String(e.stderr || ''); }
  T('P: --vs 指向不存在的檔會被拒絕（不會悄悄退回打規則 AI）', /--vs/.test(noVs), noVs.trim().slice(-50));

  // P5. 注入對手的冠軍：尺換了要重評，而且校準局不計入訓練場數
  evolve(['--role', 'attack', '--gens', '1', '--out', ckA].concat(light));
  evolve(['--export', ckA, '--to', snap]);
  const snapJ = JSON.parse(fs.readFileSync(snap, 'utf8'));
  T('P: 匯出的快照自報角色與席位（觀戰頁不必猜）',
    snapJ.kind === 'tank-battle-genome' && snapJ.role === 'attack' && snapJ.seat === 0,
    JSON.stringify({ kind: snapJ.kind, role: snapJ.role, seat: snapJ.seat }));

  evolve(['--resume', ckD, '--vs', snap, '--gens', '1', '--quiet']);
  const jD2 = Checkpoint.load(ckD, Observation.OBS_SPEC);
  const rs1 = jD2.sessions[jD2.sessions.length - 1].championRescore;
  T('P: 換對手（規則 AI → 對面冠軍）→ 舊冠軍重評，reasons 含 opponent',
    !!rs1 && rs1.reasons.includes('opponent') && rs1.games === 1,
    JSON.stringify(rs1 && { reasons: rs1.reasons, games: rs1.games }));
  T('P: 校準局不計入訓練場數（場數只是訓練預算的單位）',
    jD2.episodes === jD.episodes + 4 && jD2.neat.generation === genD + 1,
    `${jD.episodes} → ${jD2.episodes}`);
  T('P: 重評後的尺寫成 vs:<檔>#<指紋>（含對手實際基因組）',
    /^vs:runs\/_test\/dual\/opp-snapshot\.json#[0-9a-f]{12}$/.test(jD2.champion.measuredAgainst),
    jD2.champion.measuredAgainst);
  T('P: 工作階段記了這一段的尺（兩段訓練不會看起來像同一把尺）',
    jD2.sessions[jD2.sessions.length - 1].opponentRuler === jD2.champion.measuredAgainst &&
    jD2.sessions[0].opponentRuler === 'rule',
    JSON.stringify(jD2.sessions.map(s => s.opponentRuler)));

  // P6. 同一份對手再接續 → 尺沒變就不重評（白花 1 場校準局）
  const genD2 = jD2.neat.generation;
  evolve(['--resume', ckD, '--vs', snap, '--gens', '1', '--quiet']);
  const jD3 = Checkpoint.load(ckD, Observation.OBS_SPEC);
  const s3 = jD3.sessions[jD3.sessions.length - 1];
  T('P: 同一份對手接續 → 不重評（只記這一段的尺）',
    !s3.championRescore && s3.opponentChanged === false &&
    jD3.neat.generation === genD2 + 1,
    JSON.stringify({ rs: !!s3.championRescore, ch: s3.opponentChanged }));

  // P7. 交替自我對弈的真實情境：檔名完全沒變，但對面又練強一代
  //     （auto-train 每輪都重寫同一個快照檔）→ 指紋不同 → 必須重評
  const snap2 = JSON.parse(JSON.stringify(snapJ));
  snap2.genome.links[0].weight += 0.5;
  snap2.generation = snapJ.generation + 1;
  fs.writeFileSync(snap, JSON.stringify(snap2));
  evolve(['--resume', ckD, '--vs', snap, '--gens', '1', '--quiet']);
  const jD4 = Checkpoint.load(ckD, Observation.OBS_SPEC);
  const rs4 = jD4.sessions[jD4.sessions.length - 1].championRescore;
  T('P: 對手檔名沒變、內容換了（指紋不同）→ 仍然判定換尺並重評',
    !!rs4 && rs4.reasons.includes('opponent'), JSON.stringify(rs4 && rs4.reasons));
  T('P: 兩段的尺不同（不是只比檔名）',
    jD3.champion.measuredAgainst !== jD4.champion.measuredAgainst,
    `${jD3.champion.measuredAgainst} → ${jD4.champion.measuredAgainst}`);

  // P8. 外來觀測規格的對手要拒絕：v1 的網路輸出欄位數不同，放上去是亂開槍
  const alien = path.join(dir, 'alien-opp.json');
  const bad = JSON.parse(JSON.stringify(snapJ));
  bad.obsSpec = { version: 1, dim: 60 };
  fs.writeFileSync(alien, JSON.stringify(bad));
  let vsRefused = '';
  try { evolve(['--resume', ckD, '--vs', alien, '--gens', '1', '--quiet']); }
  catch (e) { vsRefused = String(e.stdout || '') + String(e.stderr || ''); }
  T('P: 觀測規格不符的對手檔被拒絕（不拿舊網路 contemporary 充數）',
    /觀測規格/.test(vsRefused), vsRefused.trim().slice(-60));
}

// ══════ 12b. 批次一：取樣面（共種子配對 ＋ 0 分次的鍵 ＋ 固定參考尺） ══════
// 這三件都不動「分數這把尺」本身（不升 SCORING_VERSION、不需重評），
// 動的是「同一群基因怎麼被比較、以及曲線能不能被解釋」。
section('sampling (batch 1)');
{
  const dir = path.join(TMP, 'sampling');
  fs.mkdirSync(dir, { recursive: true });
  const light = ['--pop', '4', '--stages', '0,1', '--seeds', '1', '--quiet'];
  // 要讀終端輸出的那幾條不能加 --quiet：「參考尺不進適應度」那行就是給人不把
  // 觀測分當成分數的保證，靜默模式把它藏了，測試就變成在比對不存在的東西。
  const small = ['--pop', '4', '--stages', '0,1', '--seeds', '1'];
  const ckBase = path.join(dir, 's-base.json');
  evolve(['--role', 'defense', '--gens', '1', '--out', ckBase, '--no-ref'].concat(light));
  // 凍結快照：拿一份「練完就停在該處」的基因組當參考尺（跟 --vs 同格式，但永不覆寫）
  const frozen = path.join(dir, 'frozen.json');
  evolve(['--export', ckBase, '--to', frozen]);

  // S1. 預設就有參考尺：規則 AI ＋ 明確給的凍結快照，兩把都進存檔
  const ckRef = path.join(dir, 's-ref.json');
  const out1 = evolve(['--role', 'attack', '--gens', '2', '--out', ckRef,
    '--ref', frozen, '--seed', 777].concat(small));
  const jRef = Checkpoint.load(ckRef, Observation.OBS_SPEC);
  T('S: 每代量兩把固定尺（規則 AI ＋凍結快照）並寫進存檔',
    jRef.reference && jRef.reference.rulers.length === 2 &&
    jRef.reference.history.length === 2 &&
    jRef.reference.history.every(r => Object.values(r.scores).every(Number.isFinite)),
    JSON.stringify(jRef.reference && jRef.reference.rulers.map(r => r.key)));
  T('S: 參考尺的考題＝族群考題（同圖同種子，否則逐場無法對照）',
    jRef.reference.exam.length === 2 &&
    jRef.reference.exam.every(e => e.seed === hashSeed(0x5eed, e.stage, e.s)),
    JSON.stringify(jRef.reference && jRef.reference.exam));
  const liveRef = Live.fromCheckpoint(jRef, ckRef, { mode: 'snapshot' }).reference;
  T('S: 看板講得出參考尺打了幾場、哪幾張圖（不然那條線沒有單位）',
    liveRef.games === 2 && liveRef.maps.join(',') === '0,1' &&
    liveRef.latest.scores && Object.keys(liveRef.latest.scores).length === 2,
    JSON.stringify(liveRef && { games: liveRef.games, maps: liveRef.maps }));
  T('S: 參考尺只是觀測 —— 不佔訓練場數（episodes 仍是 pop×圖×種子×代）',
    jRef.episodes === 4 * 2 * 2, jRef.episodes);
  T('S: 參考尺不參與選擇（adaptedness 仍是打活對手的分）',
    /參考尺（不進適應度/.test(out1) && jRef.champion.fitness >= 0);

  // S2. --no-ref：整塊參考資料不存在（看板的這一區不畫，而不是畫一條 0 分的線）
  const ckNoRef = Checkpoint.load(ckBase, Observation.OBS_SPEC);
  T('S: --no-ref 的那一族沒有 reference 欄位（不是拿 0 冒充量過）',
    ckNoRef.reference === undefined, JSON.stringify(ckNoRef.reference));
  T('S: 沒參考尺時 live 的 reference 是 null',
    Live.fromCheckpoint(ckNoRef, ckBase, { mode: 'snapshot' }).reference === null);

  // S3. 接續要接在同一條參考曲線上（尺沒換 → 舊紀錄不能丟）
  //     明確給 --ref：不給的話會 auto-detect 到 repo 裡的 ai/refs/*.json，
  //     那把尺跟上面用的 frozen 不同，測試就會在「換尺重新起算」那條路上失敗。
  evolve(['--resume', ckRef, '--gens', '1', '--ref', frozen, '--seed', 777].concat(small));
  const jRef2 = Checkpoint.load(ckRef, Observation.OBS_SPEC);
  T('S: --resume 把參考史接回去（3 代 = 3 筆，代號連續）',
    jRef2.reference.history.length === 3 &&
    jRef2.reference.history.map(h => h.gen).join(',') === '1,2,3',
    JSON.stringify(jRef2.reference.history.map(h => h.gen)));
  T('S: 接續後族群的代數也接得上（參考尺沒把訓練搞斷）',
    jRef2.neat.generation === 3 && jRef2.episodes === 4 * 3 * 2,
    JSON.stringify({ gen: jRef2.neat.generation, ep: jRef2.episodes }));

  // S4. 換了參考快照＝換尺：舊曲線不併進同一條（否則會讀成「參考分暴跌」）
  const other = path.join(dir, 'frozen2.json');
  const j2 = JSON.parse(fs.readFileSync(frozen, 'utf8'));
  j2.genome.links = j2.genome.links.slice(0, Math.max(1, j2.genome.links.length - 3));
  fs.writeFileSync(other, JSON.stringify(j2));
  const ckSwap = path.join(dir, 's-swap.json');
  evolve(['--resume', ckRef, '--gens', '1', '--out', ckSwap, '--ref', other, '--seed', 777]
    .concat(light));
  const jSwap = Checkpoint.load(ckSwap, Observation.OBS_SPEC);
  T('S: 換 --ref 後參考史重新起算（不跟舊尺併成一條線）',
    jSwap.reference.history.length === 1 &&
    jSwap.reference.rulers[1].key !== jRef.reference.rulers[1].key,
    JSON.stringify(jSwap.reference.history.map(h => h.gen)));

  // S5. --ref 給不存在的檔要當場拒絕（不能假裝有兩把尺）
  let refErr = '';
  try { evolve(['--resume', ckRef, '--gens', '1', '--ref', path.join(dir, 'ghost.json')]); }
  catch (e) { refErr = String(e.stdout || '') + String(e.stderr || ''); }
  T('S: --ref 指向不存在的檔會被拒絕', /--ref/.test(refErr), refErr.trim().slice(-60));

  // S6. 共種子配對：同參數同種子重跑一次 → 每代的 best/raw 逐筆相同
  const ckRe = path.join(dir, 's-repeat.json');
  evolve(['--role', 'attack', '--gens', '2', '--out', ckRe, '--ref', frozen, '--seed', 777]
    .concat(light));
  const jRe = Checkpoint.load(ckRe, Observation.OBS_SPEC);
  T('S: 全員同卷＋固定種子 → 兩輪跑出一模一樣的曲線（逐場差值才解得開）',
    jRe.neat.history.map(h => h.best.toFixed(4)).join('|') ===
    jRef.neat.history.map(h => h.best.toFixed(4)).join('|') &&
    jRe.neat.history.map(h => h.raw.toFixed(4)).join('|') ===
    jRef.neat.history.map(h => h.raw.toFixed(4)).join('|'),
    JSON.stringify({ a: jRe.neat.history.map(h => h.best), b: jRef.neat.history.map(h => h.best) }));

  // S7. 0 分世代的次鍵要一路帶著走（存檔、物種、本代最佳）
  T('S: 每個個體都帶著未封頂的原始分（tie），且存檔帶得回來',
    jRe.neat.population.length === 4 &&
    jRe.neat.population.every(g => typeof g.tie === 'number' && Number.isFinite(g.tie)),
    JSON.stringify(jRe.neat.population.map(g => g.tie && g.tie.toFixed(1))));
  T('S: 每代記下 0 分占比與原始分（平線是停滯還是憋著力，靠這行分辨）',
    jRe.neat.history.every(h => Number.isFinite(h.raw) && h.zero >= 0 && h.zero <= 1),
    JSON.stringify(jRe.neat.history.map(h => [h.raw && h.raw.toFixed(1), h.zero])));
}

// ══════ 12.5 批次二（G3）：老師與種子分席 ══════
// 規則 AI 從這一批起「兩席教的是不同的事」（藍壓老鷹、紅守門前 1/3 場）。
// 混收的老師資料會讓暖啟動第一步就把分工糊回去，所以取樣、種子、
// --seed-from 三段都要帶著 role 走，對不上就拒絕。
section('role split (batch 2)');
{
  const Teacher = require('./ai/teacher');
  const { roleOfTeam, ROLES } = require('./ai/fitness');
  const dir = path.join(TMP, 'role');
  fs.mkdirSync(dir, { recursive: true });

  // G1. teacher --role 只收那一席的幀（兩隊都跑，但樣本只留自己那席）
  const mixed = Teacher.collect({ stages: [0], gamesPerStage: 1, maxFrames: 600 });
  const defOnly = Teacher.collect({ stages: [0], gamesPerStage: 1, maxFrames: 600, role: 'defense' });
  T('G: 老師默認兩隊混收（role=null，舊行為不變）',
    mixed.meta.role === null && mixed.samples.length > 0 &&
    mixed.samples.some(s => roleOfTeam(s.team) === 'attack') &&
    mixed.samples.some(s => roleOfTeam(s.team) === 'defense'),
    `混收 ${mixed.samples.length} 筆`);
  T('G: --role defense 的樣本全部來自防守席（進攻席的動作一筆都不留）',
    defOnly.meta.role === 'defense' && defOnly.samples.length > 0 &&
    defOnly.samples.every(s => roleOfTeam(s.team) === 'defense'),
    `${defOnly.samples.length} 筆／` +
    JSON.stringify(defOnly.samples.slice(0, 3).map(s => s.team)));
  T('G: 分席後「看了多少幀」只數那一席（不然事件占比會拿兩隊除一隊）',
    defOnly.meta.rawFrames > 0 && defOnly.meta.rawFrames < mixed.meta.rawFrames,
    `防守 ${defOnly.meta.rawFrames} vs 混收 ${mixed.meta.rawFrames}`);
  let badRole = '';
  try { Teacher.collect({ stages: [0], gamesPerStage: 1, maxFrames: 120, role: 'midfielder' }); }
  catch (e) { badRole = String(e.message); }
  T('G: 老師只認 attack／defense（打錯席位名稱要當場報，不是默默混收）',
    /attack/.test(badRole), badRole.slice(0, 60));

  // G2. imitate --role：種子檔與基因組檔都帶著席位
  const seedDef = path.join(dir, 'seed-defense.json');
  const run = a => execFileSync(process.execPath, ['ai/imitate.js'].concat(a),
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const outDef = run(['--role', 'defense', '--out', seedDef, '--games', '1',
    '--stages', '0', '--epochs', '6', '--quiet']);
  const jDef = JSON.parse(fs.readFileSync(seedDef, 'utf8'));
  const jGen = JSON.parse(fs.readFileSync(seedDef.replace(/\.json$/, '') + '.genome.json', 'utf8'));
  T('G: 模仿種子在檔案裡寫明是哪一席練的（role + 中文席位標籤）',
    jDef.role === 'defense' && jDef.roleLabel === Fitness.ROLE_LABEL.defense &&
    jDef.teacher.role === 'defense',
    JSON.stringify({ role: jDef.role, label: jDef.roleLabel }));
  T('G: 伴生的基因組檔也帶 role（瀏覽器／monitor 看得懂同一件事）',
    jGen.role === 'defense' && jGen.note.includes(Fitness.ROLE_LABEL.defense),
    jGen.note);
  T('G: 收樣本時只收一席 → 印出來的席位是防守，不是「兩隊混收」',
    /防守|兩隊混收/.test(outDef) && !/兩隊混收/.test(outDef),
    outDef.split('\n').filter(l => /席位/.test(l)).join(' / ').slice(0, 80));
  const seedMix = path.join(dir, 'seed-mixed.json');
  run(['--out', seedMix, '--games', '1', '--stages', '0', '--epochs', '6', '--quiet']);
  const jMix = JSON.parse(fs.readFileSync(seedMix, 'utf8'));
  T('G: 不給 --role 的種子 role=null（舊種子不會被誤標成某一席）',
    jMix.role === null && jMix.roleLabel === '兩隊混收', String(jMix.role));

  // G3. --seed-from 的席位守門：錯席拒絕、對席放行、舊種子警告
  const light = ['--pop', '4', '--stages', '0', '--seeds', '1', '--quiet'];
  let mismatch = false, mmMsg = '';
  try {
    evolve(['--seed-from', seedDef, '--gens', '1', '--role', 'attack',
      '--out', path.join(dir, 'x.json')].concat(light));
  } catch (e) { mismatch = true; mmMsg = String(e.stdout || '') + String(e.stderr || ''); }
  T('G: 拿防守席的種子暖啟動進攻族群 → 被拒絕',
    mismatch && /defense/.test(mmMsg) && /attack/.test(mmMsg),
    mmMsg.trim().slice(-80));
  let okOut = path.join(dir, 'ok-defense.json');
  evolve(['--seed-from', seedDef, '--gens', '1', '--role', 'defense',
    '--out', okOut].concat(light));
  const jOk = JSON.parse(fs.readFileSync(okOut, 'utf8'));
  T('G: 同席種子照常暖啟動（族群從老師的邊長出來）',
    jOk.config.role === 'defense' && jOk.config.seedFrom === seedDef,
    JSON.stringify(jOk.config.role));
  let warnOut = '';
  {
    // 警告是 console.warn（走 stderr），而 --quiet 又會壓掉 stdout，
    // 所以這條非用 spawnSync 把兩邊一起收進來看不可。
    const r = spawnSync(process.execPath,
      ['ai/evolve.js', '--no-live', '--seed-from', seedMix, '--gens', '1', '--role', 'attack',
        '--out', path.join(dir, 'x2.json')].concat(light), { encoding: 'utf8' });
    warnOut = String(r.stdout || '') + String(r.stderr || '');
    T('G: 沒有 role 的舊種子照收，但會印警告（不假裝它屬於這一席）',
      r.status === 0 && /沒有 role 欄位|兩隊混收/.test(warnOut), warnOut.trim().slice(-70));
  }
}

// ══════ 12.6 批次二（G）：角色化之後，兩席在場上做的事不一樣 ══════
// 這一節是「規則層」的行為釘子：探針（ai/balance.js）量的是全貌，
// 這裡用最少的局數釘住三個實測方向，避免以後有人把 _goal 改回一支碼還全綠。
section('role behaviour (batch 2)');
{
  T('G: 訓練層讀到的屏蔽半徑／防線是場高推出來的（不是另一份 56）',
    arena.R.DEMO_SCREEN_RADIUS === Math.round(arena.R.FIELD_H / 3) &&
    arena.R.DEMO_HOLD_LINE === Math.round(arena.R.FIELD_H / 6) &&
    // 批次五（J）：換掉「擋路 64px／清障 32%」那兩個常數，改成選靶門檻。
    // 這一項要盯的是「只有一份尺」：進攻端改瞄主堡的距離必須跟防守端的
    // 牆腳回防、arena 的家門口計量同一個數，否則兩席的「門口」不對稱。
    arena.R.AI_ASSAULT_RADIUS === arena.R.DEMO_THREAT_RADIUS,
    JSON.stringify(arena.R.DEMO_SCREEN_RADIUS) + '/' + arena.R.DEMO_HOLD_LINE +
    '/' + arena.R.AI_ASSAULT_RADIUS);

  const n = 6;
  let blueHalf = 0, redHalf = 0, blueF = 0, redF = 0, redHomeDmg = 0;
  for (let i = 0; i < n; i++) {
    const stage = i % 2, seed = hashSeed(0xb2, stage, i);
    const r = arena.run({ stage, seed, blue: 'rule', red: 'rule', maxFrames: 1200 });
    const bf = r.teams[0].fieldFrames || 1, rf = r.teams[1].fieldFrames || 1;
    blueHalf += (r.teams[0].foeHalfFrames || 0) / bf;
    redHalf += (r.teams[1].foeHalfFrames || 0) / rf;
    blueF += bf; redF += rf;
    redHomeDmg += r.teams[1].halfDefenseDamage || 0;
  }
  const bs = blueHalf / n, rs = redHalf / n;
  // 比值門檻 1.8× → 1.4×（批次五 J）。原因不是分工變模糊，是這一節只跑 6 局
  // 取樣：實測探針（node audit-goals.js 6）確認紅隊在敵半場的那 29.7%
  // 全部來自 defend／hold／duel 三種目標點，hunt／assault 一幀都沒有 ——
  // 也就是「先打敵車」只改了進攻席的預設，沒有把守家的車推過去。
  // 1.4× 仍然咬得住這一節真正的用途：有人把 _goal 改回一支碼時兩席會幾乎相同（≈1.0×）。
  T(`G: 藍（進攻）壓進敵半場 ${Math.round(bs * 100)}% ＞ 紅（防守）${Math.round(rs * 100)}%（分工看得見）`,
    bs > rs * 1.4 && bs > 0.25, `藍 ${(bs * 100).toFixed(1)}%／紅 ${(rs * 100).toFixed(1)}%` +
    `＝${(bs / rs).toFixed(2)}×（門檻 1.4×）`);
  T(`G: 紅不再整隊前壓（敵半場占比 ${(rs * 100).toFixed(1)}% < 40%）—— 44.8% 是舊行為`,
    rs < 0.4, `${(rs * 100).toFixed(1)}%`);
  T(`G: 紅隊在自家半場攔下 ${(redHomeDmg / n).toFixed(1)} hp／局（屏蔽半徑才有東西可打）`,
    redHomeDmg / n >= 2, `${(redHomeDmg / n).toFixed(2)} hp`);
  T('G: 兩席都還在真的開車（控制權不是靠卡牆撐出來的幀數）',
    blueF > 0 && redF > 0, `藍 ${blueF}／紅 ${redF} 在場幀`);
}

// ══════ 12.7 批次四（I）：火力節拍在「整局」裡的樣子 ══════
// test-harness.js 的 batch4 那節驗的是一幀一幀的節拍表對不對；這一節驗的是
// 整局加起來那門炮有沒有真的在做事。ladder 實測（#73）翻出來的原始事實是
// 純規則 AI 坐紅席一局只開 16.2 槍，同一席換成隨機亂按開 198.7 槍 ——
// 老師比學生還不會打，模仿它的種子（暖啟動的起點）就跟著一起不會打。
// 門檻 22 落在批次四實測（28.8 槍）與舊值（16.2 槍）之間，退回舊行為一定紅；
// 上限 60 則是防止有人把擲骰改成必開 —— 那樣 accuracy／spray 兩項的訊號會被自己抹掉。
section('fire cadence (batch 4)');
{
  const R = arena.R;
  const n = 12;
  let redShots = 0, blueShots = 0;
  for (let i = 0; i < n; i++) {
    const stage = i % 8, seed = hashSeed(0xb2, stage, i);
    const r = arena.run({ stage, seed, blue: 'rule', red: 'rule' });
    redShots += r.teams[1].shots || 0; blueShots += r.teams[0].shots || 0;
  }
  const per = v => (v / n).toFixed(1);
  T(`I: 規則 AI 坐紅席每局開火 ${per(redShots)} 槍（批次四前 16.2，門檻 22）`,
    redShots / n >= 22, `${per(redShots)} 槍/局`);
  T(`I: 也沒有變成機槍（紅 ${per(redShots)} ≤ 60；ladder 探針的 p=1「每幀亂按」是 190.7 槍/局）`,
    redShots / n <= 60, `${per(redShots)}｜96 局探針 p=1 ＝ 190.7`);
  T(`I: 藍席（進攻）同一支碼照樣有火力（${per(blueShots)} 槍/局）—— 節拍不是只為防守改的`,
    blueShots / n >= 22, `${per(blueShots)} 槍/局`);
  T('I: 節拍表只有一份常數（訓練端從 arena 讀得到同一個數）',
    R.AI_SCREEN_SHOOT_GAP === 10 && R.AI_HOME_SHOOT_GAP === 16 &&
    R.AI_SCREEN_BLIND === 0.15 && R.AI_HOME_BLIND === 0.08 && R.AI_LINE_SHOOT === 0.8,
    `screen ${R.AI_SCREEN_SHOOT_GAP}+${R.AI_SCREEN_SHOOT_JITTER}／home ${R.AI_HOME_SHOOT_GAP}+${R.AI_HOME_SHOOT_JITTER}` +
    `／blind ${R.AI_SCREEN_BLIND}·${R.AI_HOME_BLIND}／line ${R.AI_LINE_SHOOT}`);

  // 反轉地板：防守席換上「更隨機的對手」不應比較高分。
  // 端點用 ai/balance.js 的 blendSpec，跟 ladder 探針同一支儀器：
  // p=0 ＝每幀都交回規則 AI（＝老師），p=1 ＝每幀都亂按（＝最笨的那一格）。
  // ⚠ 不要拿這裡的數字當結論：8 圖 × 2 種子＝16 局／臂，探針量到的單局 σ ≈ 50
  //   ⇒ 兩臂均分差的 SE ≈ 50×√(2/16) ≈ 17.6，本節這一次讀到 +11.2，
  //   同一件事的 96 局探針讀 −9.94（z −1.38）—— 兩個讀值相差不到一個 SE，
  //   是同一件事的兩次抽樣，不是「測試比較好了」。
  //   這一條只擋「明顯退回舊行為」（批次四前是 −25.07、z −2.23 ⇒ 地板 −20），
  //   要判定細微差異請跑 node ai/balance.js --mode ladder --terms（96 局／格、附 z-score）。
  // ⚠ v14 把這道的地板放寬到 −40，理由要寫在這裡：v13 那條 96 局讀 −4.27，其中有 −25.61 是
  //   spray「每局都罰滿 −30」借來的——一個在族群裡零梯度的常數項，靠把亂按那端整塊壓下去，
  //   才讓老師看起來比亂按高。v14 把 spray 改成有梯度的斜坡（亂按端只扣 −4.39），
  //   同一支探針讀到 −22.44（`node runs/_ladder-diff.js` 逐項拆解），也就是「反轉變大」不是新病，
  //   是把那塊遮住的常數項拿掉之後，防守席「不動腦也拿得到本業分」這件事第一次被看見。
  //   地板留 −40：夠擋「整條階梯翻掉」，但不假裝 −22 這格是健康的。真正的修法在尺的本業項
  //   （防守席要像 v13 的 breach 那樣加實績門檻），不在把 spray 再壓回定值。
  const armScore = redSpec => {
    let s = 0, games = 0, selfGoal = 0;
    for (let m = 0; m < 8; m++) for (let q = 0; q < 2; q++) {
      const seed = 91_000 + m * 263 + q * 29;     // 與 ai/balance.js 的 ladder 同一顆種子
      const r = arena.run({ stage: m, seed, blue: 'rule', red: redSpec(seed) });
      s += Fitness.scoreOf(r.teams[1], r, 1, { role: 'defense', maxFrames: 2400 }).final;
      if (r.teams[1].ownBaseKilledBySelf) selfGoal++;
      games++;
    }
    return { mean: s / games, selfGoal, games };
  };
  const d0 = armScore(seed => Balance.blendSpec(0, seed));
  const d1 = armScore(seed => Balance.blendSpec(1, seed));
  T(`I: 防守席的階梯沒有翻掉（老師 ${d0.mean.toFixed(1)} − 每幀亂按 ${d1.mean.toFixed(1)} = ${(d0.mean - d1.mean).toFixed(1)}；權威 96 局：v13 −4.27／v14 −22.44，其中 −25.61 是 v13 的 spray 罰滿借來的）`,
    d0.mean - d1.mean >= -40, `Δ ${(d0.mean - d1.mean).toFixed(2)}（16 局／臂，差的 SE ≈ 17.6；地板 −40 只擋「整條翻掉」，v14 的真實 separation 在 ladder 探針）`);

  // 儀器辨認（批次四踩過的坑）：arena 的 'random' 不是「零技能駕駛」，是「會自爆的駕駛」。
  // randomPolicy() 每幀自己選方向、15% 機率開火，且**不經過 v6 彈道閘**（那道閘寫在
  // PolicyController 與規則 AI 裡），所以紅席一下場就把自家老鷹打爆，整臂分數趴在
  // 0 地板 —— 拿它跟老師比會得出「79.6 − 0.0」這種假結論（我就這樣錯過一次）。
  // ladder 的 p=1 走 PolicyController，紀律還在，才是可以比的「最笨那格」。
  const dsu = armScore(() => 'random');
  T(`I: arena 的 'random' 會自爆（16 局中 ${dsu.selfGoal} 局 ownBaseKilledBySelf），不能當零技能對照組`,
    dsu.selfGoal / dsu.games > 0.5 && dsu.mean < d1.mean,
    `自爆 ${dsu.selfGoal}/${dsu.games}｜防守均分 ${dsu.mean.toFixed(1)} vs blendSpec(1) ${d1.mean.toFixed(1)}`);
  // p=0 那一端必須真的等於老師，否則整條階梯的起點是翹的：
  // blendSpec(0) 每幀擲骰擲不過 → 回 null → PolicyController 走 abstain，
  // 由規則 AI 代步。這跟直接交 'rule'（不注入 controller）應該是同一盤棋。
  const dRule = armScore(() => 'rule');
  T(`I: ladder 的 p=0 端點就是老師本身（blendSpec(0) ${d0.mean.toFixed(2)} ≡ 'rule' ${dRule.mean.toFixed(2)}）`,
    Math.abs(d0.mean - dRule.mean) < 0.01, `Δ ${(d0.mean - dRule.mean).toFixed(4)}`);
}


// ══════ 13. 全自動：auto-train（雙模型交替演化＋自動匯出＋自動開場） ══════
section('auto-train');
{
  // 這節會真的 spawn 訓練子程序。正式那兩份存檔（runs/attack-v6.json／
  // runs/defense-v6.json）此刻正被背景那支自動訓練寫入，測試要是直接碰它們，
  // 就等於「兩支程序寫同一份存檔」—— 所以整節走 --sandbox：
  // 存檔／快照／旗標／鎖／日誌全部進 TMP，正式檔一個字都不動。
  const SBX = path.join(TMP, 'sbx');
  fs.mkdirSync(SBX, { recursive: true });
  // 檔名要與 ai/auto-train.js 的 MODELS 一致：--sandbox 只換目錄、不換 basename。
  const ckA = path.join(SBX, 'attack-v6.json');
  const ckD = path.join(SBX, 'defense-v6.json');
  const light = ['--pop', '4', '--stages', '0', '--seeds', '1', '--quiet'];
  evolve(['--role', 'attack', '--gens', '1', '--out', ckA].concat(light));
  evolve(['--role', 'defense', '--gens', '1', '--out', ckD].concat(light));
  const before = {
    a: JSON.parse(fs.readFileSync(ckA, 'utf8')).neat.generation,
    d: JSON.parse(fs.readFileSync(ckD, 'utf8')).neat.generation,
  };
  // 正式開場旗標的mtime：跑完要跟之前一樣（sandbox 不準寫到 ai/auto-watch.js）
  const prodFlag = path.join('ai', 'auto-watch.js');
  const prodMtime = fs.existsSync(prodFlag) ? fs.statSync(prodFlag).mtimeMs : 0;

  const log = path.join(SBX, 'trainer.log');      // DEFAULTS.log 的 basename，被 sandbox 搬進來
  const stdout = execFileSync(process.execPath, ['ai/auto-train.js', '--once', '--gens', '1',
    '--sandbox', SBX, '--no-open', '--no-live'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const fwd = s => String(s).replace(/\\/g, '/');

  const after = {
    a: JSON.parse(fs.readFileSync(ckA, 'utf8')).neat.generation,
    d: JSON.parse(fs.readFileSync(ckD, 'utf8')).neat.generation,
  };
  T('A: --once 一輪把兩個模型都推進一代（進攻→防守，交替演化）',
    after.a === before.a + 1 && after.d === before.d + 1,
    `進攻 ${before.a}→${after.a}｜防守 ${before.d}→${after.d}`);
  T('A: --sandbox 真的把兩族換進沙盒（不是照舊寫 runs/attack-v6.json）',
    fwd(stdout).includes(fwd(SBX)) && stdout.includes('進攻族') && stdout.includes('防守族'),
    fwd(stdout).split('\n').filter(l => l.includes('族')).join(' ⏎ ').slice(0, 120));
  T('A: 沙盒沒碰正式開場旗標（正在跑的那支自動訓練不受影響）',
    !fs.existsSync(prodFlag) || fs.statSync(prodFlag).mtimeMs === prodMtime);

  // A2. 兩個角色各有一份快照，而且自報角色 —— 觀戰頁才能把對的網路放進對的席位
  const snapA = path.join(SBX, 'trained-attack.json');
  const snapD = path.join(SBX, 'trained-defense.json');
  const exA = JSON.parse(fs.readFileSync(snapA, 'utf8'));
  const exD = JSON.parse(fs.readFileSync(snapD, 'utf8'));
  T('A: 每代自動匯出兩份快照（不必手動 --export）',
    exA.generation === after.a && exA.role === 'attack' && exA.seat === 0 && !!exA.genome &&
    exD.generation === after.d && exD.role === 'defense' && exD.seat === 1 && !!exD.genome,
    `進攻 gen ${exA.generation}（${exA.role}／席 ${exA.seat}）｜防守 gen ${exD.generation}（${exD.role}／席 ${exD.seat}）`);
  // 開機時快照不存在（ensureModels 補），跑完這一代代數變成 2 ——
  // 代數是 2 就證明「每代刷新」有發生，而不是只補了一次開機快照。
  T('A: 快照帶的是這一段的代數，不是補檔那一次的（自動跟隨真的在跟）',
    exA.generation === before.a + 1 && exA.championGeneration != null && exA.fitness != null,
    `gen ${exA.generation}｜冠軍 ${exA.championGeneration}｜fitness ${exA.fitness}`);
  T('A: 兩份 .js 也一起刷新（file:// 的瀏覽器讀的是這份）',
    fs.existsSync(snapA.replace(/\.json$/i, '.js')) && fs.existsSync(snapD.replace(/\.json$/i, '.js')));

  // A3. 自動開場旗標：一份頁面、兩套模型（不再是「兩隊同一份網路」）
  const flag = path.join(SBX, 'auto-watch.js');
  const fbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(flag, 'utf8'), fbox);
  const FL = fbox.window.TANK_AUTO_WATCH;
  T('A: 寫出自動開場旗標（瀏覽器不必按 Y／U）', FL && FL.mode === 'dual',
    JSON.stringify(FL && { mode: FL.mode, stage: FL.stage }));
  T('A: 旗標裡帶兩份快照檔名 —— 藍席放進攻模型、紅席放防守模型',
    /trained-attack\.js$/.test(FL.attack) && /trained-defense\.js$/.test(FL.defense) &&
    fwd(FL.attack).startsWith(fwd(SBX)),
    JSON.stringify({ a: fwd(FL.attack), d: fwd(FL.defense) }));

  // A4. 鎖與日誌：正常結束釋放鎖；兩段訓練都有原始輸出留檔
  T('A: 正常結束會釋放鎖（下次還能啟動）', !fs.existsSync(path.join(SBX, 'auto-train.lock')));
  {
    const txt = fwd(fs.readFileSync(log, 'utf8'));
    T('A: 日誌按「第 N 輪・進攻族／防守族」分段（掛掉時知道是哪一族）',
      /第 1 輪・進攻族/.test(txt) && /第 1 輪・防守族/.test(txt) &&
      txt.indexOf('進攻族') < txt.indexOf('防守族'), txt.split('\n').find(l => l.includes('===== ')));
    T('A: 日誌記下每一段用的是誰當對手（交替對弈不是口頭說的）',
      /對手 .*trained-defense\.json/.test(txt) && /對手 .*trained-attack\.json/.test(txt),
      txt.split('\n').filter(l => l.includes('對手')).map(l => l.slice(0, 90)).join(' ⏎ '));
  }

  // A5. 兩支程序不能同時寫同一份存檔：鎖還在、或看板上別人在跑 → 拒絕啟動
  {
    fs.writeFileSync(path.join(SBX, 'auto-train.lock'),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    let busy = '';
    try {
      execFileSync(process.execPath, ['ai/auto-train.js', '--once', '--gens', '1',
        '--sandbox', SBX, '--no-open', '--no-live'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { busy = String(e.stdout || '') + String(e.stderr || ''); }
    T('A: 鎖還被人持有（PID 活著）→ 第二支拒絕啟動，不共用存檔',
      /已經有一支自動訓練在跑/.test(busy), fwd(busy).trim().slice(0, 70));
    fs.unlinkSync(path.join(SBX, 'auto-train.lock'));

    const genNow = JSON.parse(fs.readFileSync(ckA, 'utf8')).neat.generation;
    fs.writeFileSync(path.join(SBX, 'live-data.js'), 'window.__LIVE__ = ' + JSON.stringify({
      kind: Live.KIND, running: true, at: new Date().toISOString(),
      file: path.join(TMP, 'other-family.json'),
    }) + ';\n');
    let clash = '';
    try {
      execFileSync(process.execPath, ['ai/auto-train.js', '--once', '--gens', '1',
        '--sandbox', SBX, '--no-open', '--no-live'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { clash = String(e.stdout || '') + String(e.stderr || ''); }
    T('A: 看板上有「別人的」訓練在跑 → 拒絕啟動（兩支同時寫會互相蓋掉）',
      /另一支訓練正在跑/.test(clash) &&
      JSON.parse(fs.readFileSync(ckA, 'utf8')).neat.generation === genNow,
      fwd(clash).trim().slice(0, 70));

    // 但看板上寫的是我們自己這兩份存檔時不能自己擋自己 ——
    // 否則正式那支每次重開都會被自己上一段的殘影拒於門外。
    fs.writeFileSync(path.join(SBX, 'live-data.js'), 'window.__LIVE__ = ' + JSON.stringify({
      kind: Live.KIND, running: true, at: new Date().toISOString(),
      file: path.join(TMP, 'sbx', 'defense-v6.json'),
    }) + ';\n');
    execFileSync(process.execPath, ['ai/auto-train.js', '--once', '--gens', '1',
      '--sandbox', SBX, '--no-open', '--no-live'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    T('A: 看板上的檔案是我們自己這兩族 → 不自己擋自己，照常開跑',
      JSON.parse(fs.readFileSync(ckA, 'utf8')).neat.generation === genNow + 1,
      `${genNow} → ${JSON.parse(fs.readFileSync(ckA, 'utf8')).neat.generation}`);
    fs.rmSync(path.join(SBX, 'live-data.js'), { force: true });
  }

  // A6. --off 關掉自動開場（只刪旗標，不動訓練）
  {
    const genNow = JSON.parse(fs.readFileSync(ckA, 'utf8')).neat.generation;
    execFileSync(process.execPath, ['ai/auto-train.js', '--off', '--sandbox', SBX],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    T('A: --off 刪除旗標（下次開頁面回到標題），且不動存檔',
      !fs.existsSync(flag) &&
      JSON.parse(fs.readFileSync(ckA, 'utf8')).neat.generation === genNow);
  }

  // 「忘了給必要參數」要當場拒絕，不能默默跑成「其實沒在跟隨」
  let noTarget = '';
  try {
    evolve(['--gens', '1', '--pop', '4', '--stages', '0', '--quiet',
      '--export-every', '1', '--out', path.join(TMP, 'never-export.json')]);
  } catch (e) { noTarget = String(e.stdout || '') + String(e.stderr || ''); }
  T('A: --export-every 沒給 --export-to 會被拒絕（不會假裝在跟隨）',
    /--export-to/.test(noTarget), noTarget.trim().slice(-60));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n---');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
