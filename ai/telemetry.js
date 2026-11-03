/* ai/telemetry.js — 逐幀監測：把「整個遊戲過程」變成可檢查的數據
   ═══════════════════════════════════════════════════════════
   為什麼需要這層：只看勝率與適應度會把退化策略誇成聰明。
   實測例：第 50 代冠軍對規則 AI 勝率 75%、控制權 100%，
   但逐幀看出來是 91% 的決策都在按「射擊」、從不選「下」，
   於是把車開進牆壁後就一直對著打不動的東西開槍 —— 結論完全看不見這個。

   這層記錄的是「過程」：
     · 每台車：走過的格子與停留熱點、最長原地不動、被牆擋住的幀、
               動作直方圖、abstain（交給規則 AI 代步）比例
     · 每發子彈：死因分類（破牆／打不動的鋼水樹／命中坦克／互抵消／出界）
     · 地形：每次 bulletHit 實際削掉了哪一格、原本是什麼
     · 局層：推進度（離敵鷹最近距離）、控制格數、無效開火率

   然後用一組帶閾值的紅旗規則把「行為退化」標出來。紅旗是硬要求：
   任何一條在訓練報告裡出現，就不該宣稱這一代變強了。
   ═══════════════════════════════════════════════════════════ */
'use strict';

const ACTIONS = require('./actions').ACTIONS;
const ACTION_NAMES = require('./actions').ACTION_NAMES;

/* ── 紅旗規則：name / 判定 / 門槛 / 怎麼修 ────────────────── */
const RULES = [
  {
    id: 'action_monotony',
    label: '動作單一',
    test: m => m.actionShare && Math.max(...m.actionShare) > 0.80,
    value: m => m.actionShare ? (100 * Math.max(...m.actionShare)).toFixed(0) + '%' : 'n/a',
    limit: '≤ 80%',
    why: '網路幾乎只輸出同一個動作。勝率再高也是「一個鍵打天下」，沒有學到機動。',
    fix: '適應度要懲罰單一動作／要求動作熵下限，或把動作空間拆成「方向×是否開火」。',
  },
  {
    id: 'no_retreat',
    label: '從不後撤',
    test: m => m.actionShare && Math.min(m.actionShare[0], m.actionShare[2]) < 0.005,
    value: m => m.actionShare
      ? `上${(100 * m.actionShare[0]).toFixed(1)}% 下${(100 * m.actionShare[2]).toFixed(1)}%` : 'n/a',
    limit: '上下都要 > 0.5%',
    why: '某個方向完全沒出現過＝觀測與獎勵沒有把「退回射擊線／回防」連起來。',
    fix: '檢查觀測是否含「背後的敵情與自家老鷹距離」，並給回防成功的子項分。',
  },
  {
    id: 'wall_pinning',
    label: '卡牆開火',
    test: m => m.blockedShare > 0.25 && m.fireWhileBlockedShare > 0.10,
    value: m => `擋住 ${(100 * m.blockedShare).toFixed(0)}%、其中開火 ${(100 * m.fireWhileBlockedShare).toFixed(0)}%`,
    limit: '擋住 >25% 且開火 >10% 即紅旗',
    why: '車頂在牆上不動、還持續開槍 —— 使用者看到的「卡在某個地方」就是這個。',
    fix: '把「意圖方向被擋」計入懲罰；並讓開火不佔用轉向動作（8 個動作）。',
  },
  {
    id: 'waste_on_unbreakable',
    label: '對打不動的目標開火',
    test: m => m.shots > 20 && m.unbreakableHitShare > 0.15,
    value: m => `${(100 * m.unbreakableHitShare).toFixed(0)}% 的子彈打在鋼牆/水/樹/冰`,
    limit: '≤ 15%',
    why: '子彈消失在不會破的地形上，看起來就是「打到牆壁沒有損傷」。',
    fix: '觀測要能分辨「前方那格能不能破」；適應度對無效彈計負分。',
  },
  {
    id: 'no_terrain_damage',
    label: '幾乎不破牆',
    test: m => m.shots > 30 && m.brickDestroyed === 0,
    value: m => `${m.shots} 發、削掉 ${m.brickDestroyed} 格`,
    limit: '開火 >30 發時至少要削到牆',
    why: '完全沒有地形損傷代表彈道或地形判定接錯，或是從不朝可破目標開火。',
    fix: '用 --trace 看子彈死因分類，確認 bulletHit 有沒有被走到。',
  },
  {
    id: 'no_progress',
    label: '不推進',
    test: m => m.advancePx < 16,
    value: m => `離敵老鷹最近距離整局只縮短 ${m.advancePx}px`,
    limit: '> 16px（2 格）',
    why: '不下壓的打法只能等對方上門，實務上會退化成守著一格開槍。',
    fix: '給「推進到敵半場」的子項獎勵，或把 dominance 的負分加重。',
  },
  {
    id: 'proxy_control',
    label: '其實是規則 AI 在開',
    test: m => m.ctrlTanks > 0 && m.fieldFrames > 200 && m.abstainShare > 0.5,
    value: m => `${(100 * m.abstainShare).toFixed(0)}% 的幀交回規則 AI`,
    limit: '≤ 50%',
    why: '網路 abstain 太多，成績主要不是學出來的。',
    fix: '提高 abstain 門檻的懲罰，或讓 bias 可學（現在固定 -0.85 才 abstain）。',
  },
  {
    id: 'kamikaze',
    label: '送頭',
    test: m => m.deaths >= 6 && m.kills / Math.max(1, m.deaths) < 0.7,
    value: m => `死 ${m.deaths} / 殺 ${m.kills}`,
    limit: '死 6 次以上時 K/D ≥ 0.7',
    why: '用命換命也能刷到流量分，這種個體不該被選成冠軍。',
    fix: 'death 權重要壓過 killPer1k；同傷交換的局不給速度加分。',
  },
  {
    id: 'own_base_damage',
    label: '拆自己家',
    test: m => m.selfBaseShots > 0,
    value: m => `${m.selfBaseShots} 發子彈一出生就打在自家老鷹上`,
    limit: '0 發',
    why: '坦克常常停在自家 eagle 正上方，這一槍打不到敵人，只把自家的防禦工事連同老鷹一起拆掉。',
    fix: '開火前查「子彈路徑上第一個碰到的是不是自家老鷹」（ai/controller.js 的 ownBaseInFront），是就收手。',
  },
  {
    id: 'own_eagle_destroyed',
    label: '自己打爆自家老鷹',
    test: m => !!m.ownBaseKilledBySelf,
    value: m => m.ownBaseKilledBySelf ? '自家老鷹是被自己人的子彈打爆的' : '',
    limit: '0 次（一次就輸，而且分數歸 0）',
    why: '使用者規則（v7）：「自己人把自己的老鷹打死要記錄、要列入訓練標準」。' +
      '這比拆掉圍牆嚴重一個等級 —— 老鷹被毀就是該隊直接輸，連拖時間的機會都沒了。' +
      '判定用的是 js/map.js 記下的兇手（base.killedBy），不是「結算時牆少了幾格」那種推測。',
    fix: '反射層（fireIsSafe）攔掉彈道指向自家要塞的那一槍；計分端再加一道地板：' +
      '自破那局無論其它項多漂亮都記 0 分，讓這種個體永遠選不上。',
  },
];

/* ── 記錄器 ─────────────────────────────────────────────── */
class Recorder {
  /**
   * @param {object} o { trackTeams: [0,1], sampleCells: true }
   */
  constructor(o = {}) {
    this.o = o;
    this.trackTeams = o.trackTeams || [0, 1];
    this.events = [];          // 地形破損事件（供熱點圖）
    this.bulletDeaths = {};    // 死因 → 計數（依隊伍）
    this.heat = [new Map(), new Map()];   // team → "cx,cy" → 幀數
    this.tracks = [];          // 每台車的軌跡取樣（降取樣，避免資料爆炸）
    this._tankId = 0;
  }

  /** 在 G.startDemo 之後呼叫：包 bulletHit、抓初始地形 */
  begin(G, R, meta) {
    this.G = G; this.R = R;
    this.meta = meta || {};
    this.frame = 0;
    this.tanks = new Map();      // tank obj → rec
    this.bullets = new Map();    // bullet obj → rec
    this.prevBullets = new Set();
    this.brick0 = this._count(G, R.CELL_TYPE.BRICK);
    // 地圖快照與老鷹位置：網頁要畫「車卡在哪一格相對於牆壁」，
    // 只有熱點座標而沒有地形是看不出來的。
    this.grid = G.map.cells.map(r => r.slice());
    this.bases = G.map.bases.map((b, i) => ({ team: i, cx: b.cx, cy: b.cy }));
    // 依「子彈撞到什麼」計數。brick_destroyed = 真的被削掉的磚格數。
    this.terrain = { brick_destroyed: 0, brick: 0, steel: 0, water: 0, forest: 0, ice: 0, base: 0, border: 0, other: 0 };
    // 逐隊「削掉幾格磚」。地形計量本身是全域的（一局總損傷），但紅旗要判的是
    // 「這一隊打不打得動東西」，所以得在子彈歸因時按射擊方拆開。
    this.cellsDestroyed = [0, 0];
    this._near = [];             // 本幀的 bulletHit 記錄（用來給子彈歸因）

    const self = this;
    const CT = R.CELL_TYPE;
    const orig = G.map.bulletHit.bind(G.map);
    G.map.bulletHit = function (bx, by, power, killerTeam = null) {
      const CELL = R.CELL;
      const x0 = Math.floor((bx - 2) / CELL), x1 = Math.floor((bx + 1) / CELL);
      const y0 = Math.floor((by - 2) / CELL), y1 = Math.floor((by + 1) / CELL);
      const before = [];
      for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++)
        before.push({ cx, cy, v: self._cell(cx, cy) });
      const r = orig(bx, by, power, killerTeam);
      if (r.hit) {
        let destroyed = 0, kind = 'other';
        let inGrid = false;
        for (const b of before) {
          if (b.v >= 0) inGrid = true;
          const now = self._cell(b.cx, b.cy);
          if (b.v === CT.BRICK && now === CT.EMPTY) { destroyed++; kind = 'brick'; }
          else if (b.v === CT.STEEL && now === CT.BRICK) { destroyed++; kind = 'brick'; }
          else if (b.v === CT.STEEL) { kind = 'steel'; }
          else if (b.v === CT.WATER) kind = 'water';
          else if (b.v === CT.FOREST) kind = 'forest';
          else if (b.v === CT.ICE) kind = 'ice';
          else if (b.v === CT.BASE) kind = 'base';
        }
        // 撞戰場邊界（bulletHit 對界外也回 hit=true）：這是正常終止，
        // 不能算進「對打不動的地形開火」，否則無效率統計會被高估。
        if (!inGrid) kind = 'border';
        // 撞磚有兩種下場：真的削掉（brick_destroyed 累加「格數」），
        // 或這發子彈其實是從磚塊旁邊擦過（destroyed=0）。
        if (kind === 'brick') self.terrain.brick_destroyed += destroyed;
        else self.terrain[kind in self.terrain ? kind : 'other'] += 1;
        self._near.push({ kind, destroyed, x: bx, y: by });
        self.events.push({ f: self.frame, x: Math.round(bx), y: Math.round(by), kind, destroyed });
      }
      return r;
    };
    return this;
  }

  _cell(cx, cy) {
    const m = this.G.map;
    return m.inGrid(cx, cy) ? m.cells[cy][cx] : -1;
  }

  _count(G, v) {
    let n = 0;
    for (const row of G.map.cells) for (const c of row) if (c === v) n++;
    return n;
  }

  /** 每幀結算後呼叫 */
  afterFrame(G, R) {
    const CELL = R.CELL;
    this.frame++;
    const aliveB = new Set();

    // ── 坦克 ──
    for (const t of G.tanks) {
      if (!t.alive) continue;
      let r = this.tanks.get(t);
      if (!r) {
        r = {
          id: ++this._tankId, team: t.team, born: this.frame, died: null,
          cx: -1, cy: -1, stay: 0, maxStay: 0,
          fieldFrames: 0, blocked: 0, fireWhileBlocked: 0,
          px: null, py: null,
          fire: 0, dirFrames: new Array(4).fill(0),
          act: new Array(5).fill(0), actN: 0, ruleFrames: 0,
          shots: 0, spawn: [Math.round(t.x / CELL), Math.round(t.y / CELL)],
          path: [],
        };
        this.tanks.set(t, r);
      }
      const cx = Math.round(t.x / CELL), cy = Math.round(t.y / CELL);
      if (cx === r.cx && cy === r.cy) { r.stay++; r.maxStay = Math.max(r.maxStay, r.stay); }
      else { r.stay = 0; r.cx = cx; r.cy = cy; if (r.path.length < 4000) r.path.push([cx, cy]); }

      const actionable = t.spawnTimer <= 0 && !G.frozenFor(t);
      // 「卡住」= 這一幀位置完全沒變（頂到牆或被車擋死）。
      // 不能讀 t.moving：規則 AI（js/ai.js）沒維護那個欄位，會把整隊都誤判成卡住。
      // 出生／被凍結的幀把上一幀位置清空：無敵期本來就站在出生點不動，
      // 留著會讓「剛出生的第一幀」被算成卡牆（和 arena 的便宜計量對不上）。
      const moved = r.px === null || t.x !== r.px || t.y !== r.py;
      if (actionable) { r.px = t.x; r.py = t.y; }
      else { r.px = null; r.py = null; }
      if (actionable) {
        r.fieldFrames++;
        const hm = this.heat[r.team];
        const k = cx + ',' + cy;
        hm.set(k, (hm.get(k) || 0) + 1);
        if (!moved) r.blocked++;
        const c = t.controller;
        if (c) r.hasCtrl = true;
        if (c && typeof c.lastAction === 'number') {
          r.act[c.lastAction]++; r.actN++;
          if (c.lastAction === ACTIONS.FIRE) { r.fire++; if (!moved) r.fireWhileBlocked++; }
        }
      }
      const d = t.dir;
      if (d >= 0 && d < 4) r.dirFrames[d]++;
    }

    // ── 子彈：新增 / 消失 ──
    for (const b of G.bullets) {
      if (!b.alive) continue;
      aliveB.add(b);
      if (!this.bullets.has(b)) {
        const rec = { team: b.owner && b.owner.team, born: this.frame, x: b.x, y: b.y, dir: b.dir };
        this.bullets.set(b, rec);
        const tr = b.owner && this.tanks.get(b.owner);
        if (tr) tr.shots++;
      } else {
        const rec = this.bullets.get(b);
        rec.x = b.x; rec.y = b.y;
      }
    }
    for (const [b, rec] of this.bullets) {
      if (aliveB.has(b)) continue;
      const cause = this._classify(G, R, b, rec);
      const byTeam = this.bulletDeaths[rec.team] || (this.bulletDeaths[rec.team] = {});
      byTeam[cause] = (byTeam[cause] || 0) + 1;
      this.bullets.delete(b);
    }

    // ── 推進度：每隊離敵老鷹的最近距離 ──
    // ⚠ map.bases[i].cx/cy 是「格子座標」（老鷹佔 2×2 格），
    //   坦克的 x/y 是 px。混用會把距離算成 1/8 大小，推進度就永遠是 0。
    const CELL0 = R.CELL;
    for (const id of this.trackTeams) {
      const foe = this._basePx(G.map.bases[1 - id], CELL0);
      let best = Infinity;
      for (const t of G.tanks) {
        if (!t.alive || t.team !== id) continue;
        best = Math.min(best, Math.hypot(t.x - foe.x, t.y - foe.y));
      }
      const prev = this['min' + id];
      if (isFinite(best)) this['min' + id] = Math.min(prev === undefined ? Infinity : prev, best);
    }

    // ⚠ _near 要在「子彈歸因做完之後」才清。原本在幀開頭清掉，等於把
    //   這一幀 step() 裡記錄的撞牆事件先抹掉 → 所有打中磚塊的子彈都被
    //   歸成 unknown，觀測到的「削磚 0 格」是記錄器的 bug 而不是遊戲的 bug。
    this._near.length = 0;
  }

  _basePx(b, CELL) { return { x: (b.cx + 1) * CELL, y: (b.cy + 1) * CELL }; }

  _classify(G, R, b, rec) {
    // 9:21：出界要分寬高兩邊查。用同一個 F 查 y 的話，
    // 「飛過底邊被子彈界外消掉」會被當成牆，削磚統計跟著錯。
    if (b.x < 0 || b.y < 0 || b.x >= R.FIELD_W || b.y >= R.FIELD_H) return 'boundary';
    for (const e of this._near) {
      if (Math.abs(e.x - b.x) <= 8 && Math.abs(e.y - b.y) <= 8) {
        if (e.kind === 'brick') {
          if (e.destroyed && (rec.team === 0 || rec.team === 1))
            this.cellsDestroyed[rec.team] += e.destroyed;
          return e.destroyed ? 'brick_destroyed' : 'brick';
        }
        return e.kind === 'steel' ? 'steel'
          : e.kind === 'base' ? 'base'
          : e.kind;                                // water / forest / ice / other
      }
    }
    for (const t of G.tanks) {
      if (t.team === rec.team) continue;
      if (Math.abs(t.x - b.x) < 12 && Math.abs(t.y - b.y) < 12) return 'tank';
    }
    for (const o of G.bullets) if (o !== b && Math.hypot(o.x - b.x, o.y - b.y) < 8) return 'bullet';
    return 'unknown';
  }

  /** 一局結束：把原始記錄換成「可判讀的指標 + 紅旗」 */
  finish(G, R, rep) {
    const teamIdx = {};
    for (const id of this.trackTeams) {
      const rs = [...this.tanks.values()].filter(r => r.team === id);
      const act = new Array(5).fill(0);
      let actN = 0, field = 0, blocked = 0, fireBlocked = 0, fire = 0, shots = 0, ruleFrames = 0;
      let maxStay = 0, stuckTanks = 0;
      for (const r of rs) {
        for (let i = 0; i < 5; i++) act[i] += r.act[i];
        actN += r.actN; field += r.fieldFrames; blocked += r.blocked;
        fireBlocked += r.fireWhileBlocked; fire += r.fire; shots += r.shots;
        maxStay = Math.max(maxStay, r.maxStay);
        if (r.maxStay > 120) stuckTanks++;
      }
      const deaths = (rep && rep.teams[id] ? rep.teams[id].deaths : 0);
      const s = {
        team: id,
        tanks: rs.length,
        ctrlTanks: rs.filter(r => r.hasCtrl).length,   // 0 = 這一隊根本沒有 policy
        fieldFrames: field,
        actionShare: actN ? act.map(a => a / actN) : null,
        actionN: actN,
        actionNames: ACTION_NAMES,
        blockedShare: field ? blocked / field : 0,
        fireWhileBlockedShare: field ? fireBlocked / field : 0,
        fireShare: field ? fire / field : 0,
        shots,
        brickDestroyed: this.cellsDestroyed[id] || 0,   // 這一隊自己削掉的磚格數
        unbreakableHitShare: (() => {
          const d = this.bulletDeaths[id] || {};
          const bad = (d.steel || 0) + (d.water || 0) + (d.forest || 0) + (d.ice || 0) + (d.other || 0);
          const n = Object.values(d).reduce((a, b) => a + b, 0);
          return n ? bad / n : 0;
        })(),
        bulletDeaths: this.bulletDeaths[id] || {},
        abstainShare: (() => {
          const st = rep && rep.teams[id];
          if (!st || !field) return 0;
          return Math.max(0, 1 - (st.framesDecided || 0) / field);
        })(),
        advancePx: (() => {
          const m = this['min' + id];
          const CELL = R.CELL;
          const a = this._basePx(G.map.bases[id], CELL), b = this._basePx(G.map.bases[1 - id], CELL);
          const home = Math.hypot(a.x - b.x, a.y - b.y);
          return isFinite(m) ? Math.max(0, home - m) : 0;
        })(),
        distinctCells: [...this.heat[id].keys()].length,
        maxStay, stuckTanks,
        kills: rep ? rep.teams[id].kills : 0,
        deaths,
        ownBaseCellsLost: rep ? rep.teams[id].ownBaseCellsLost : 0,
        // ⚠ 「自家圍牆少了幾格」有一半是敵人打的，不能拿來判定自己拆家。
        //   自拆的判定在開火的當下做（見 controller.ownBaseInFront），
        //   這一欄跟適應度、紅旗用的是同一個數字。
        selfBaseShots: rep ? (rep.teams[id].selfBaseShots || 0) : 0,
        // v7：兩件「使用者點名要記錄」的事，都直接從 arena 的逐幀計量拿，
        // 不在這裡另算一套 —— 計量只有一個來源（ai/arena.js + js/map.js 的 base.killedBy）。
        ownBaseKilledBySelf: rep ? !!rep.teams[id].ownBaseKilledBySelf : false,
        foeBaseOwnGoal: rep ? !!rep.teams[id].foeBaseOwnGoal : false,
        duelKills: rep ? (rep.teams[id].duelKills || 0) : 0,
        duelFrames: rep ? (rep.teams[id].duelFrames || 0) : 0,
        ownBaseAlive: rep ? rep.teams[id].ownBaseAlive : true,
        won: rep ? rep.winner === id : false,
      };
      s.flags = RULES.filter(rl => { try { return rl.test(s); } catch (e) { return false; } })
        .map(rl => ({ id: rl.id, label: rl.label, value: String(rl.value(s)), limit: rl.limit, why: rl.why, fix: rl.fix }));
      teamIdx[id] = s;
    }

    const heat = this.trackTeams.map(id => ({
      team: id,
      cells: [...this.heat[id].entries()].sort((a, b) => b[1] - a[1]).slice(0, 60)
        .map(([k, v]) => { const [x, y] = k.split(',').map(Number); return { x, y, f: v }; }),
    }));

    return {
      meta: Object.assign({ frames: this.frame, stage: rep && rep.stage, seed: rep && rep.seed,
        winner: rep && rep.winner, capped: rep && rep.capped }, this.meta),
      grid: this.grid, bases: this.bases,
      terrain: Object.assign({}, this.terrain, { brick0: this.brick0, brickNow: this._count(G, R.CELL_TYPE.BRICK) }),
      teams: teamIdx,
      heat,
      events: this.events.slice(0, 4000),
      tankTracks: [...this.tanks.values()].map(r => ({
        id: r.id, team: r.team, born: r.born, died: r.died, spawn: r.spawn,
        maxStay: r.maxStay, blocked: r.blocked, fieldFrames: r.fieldFrames,
        shots: r.shots, act: r.act, actN: r.actN, path: r.path.slice(0, 500),
      })),
    };
  }
}

/* ── CLI：node ai/telemetry.js --mode trained --stage 0 --games 4 ── */
function main(argv) {
  const o = { mode: 'trained', stage: 0, games: 4, maxFrames: 4000, json: null, quiet: false, team: 'policy' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], nx = () => argv[++i];
    if (a === '--mode') o.mode = nx();
    else if (a === '--stage') o.stage = Number(nx());
    else if (a === '--games') o.games = Number(nx());
    else if (a === '--team') o.team = nx();          // policy（預設）| both
    else if (a === '--max-frames') o.maxFrames = Number(nx());
    else if (a === '--json') o.json = nx();
    else if (a === '--quiet') o.quiet = true;
    else throw new Error('unknown arg ' + a);
  }

  const { Arena } = require('./arena');
  const fs = require('fs');
  const { hashSeed } = require('./rng');
  const NEAT = require('./neat');

  let spec = o.mode === 'rule' ? 'rule' : o.mode === 'random' ? 'random' : null;
  if (o.mode === 'trained') {
    const j = JSON.parse(fs.readFileSync('ai/trained.json', 'utf8'));
    spec = { kind: 'policy', policy: NEAT.Genome.fromJSON(j.genome).toPolicy() };
  }

  const arena = new Arena();
  const all = [];
  for (let i = 0; i < o.games; i++) {
    const seed = hashSeed(0x7e1e, o.stage, i);
    const r = arena.run({ stage: o.stage, seed, blue: spec, red: 'rule', maxFrames: o.maxFrames, record: true });
    all.push(r);
  }

  // 跨局彙總：紅旗以「幾個被監測的隊伍實例出現過」計
  // 預設只盯「有 policy 的那一隊」—— 規則 AI 本來就沒 controller，
  // 把它一起列進來只會產生「其實是規則 AI 在開」這種廢紅旗。
  const tally = new Map();
  let episodes = 0;
  for (const r of all) for (const id of [0, 1]) {
    const t = r.telemetry && r.telemetry.teams[id];
    if (!t) continue;
    if (o.team === 'policy' && t.ctrlTanks === 0) continue;
    episodes++;
    for (const f of t.flags) {
      const e = tally.get(f.id) || { ...f, n: 0, samples: [] };
      e.n++; if (e.samples.length < 3) e.samples.push(`第${id === 0 ? '藍' : '紅'}隊 ${f.value}`);
      tally.set(f.id, e);
    }
  }

  if (!o.quiet) {
    for (const r of all.slice(0, 1)) {
      const t = r.telemetry.teams[0], tt = r.telemetry.terrain;
      console.log(`\n═ 逐幀監測：${o.mode} vs 規則 AI｜地圖 ${o.stage}｜${all.length} 局 ═`);
      console.log(`藍隊（被監測）：車 ${t.tanks} 台、在場 ${t.fieldFrames} 幀、開火 ${t.shots} 發`);
      console.log(`  動作分佈 ${t.actionNames.map((n, i) => `${n} ${(100 * t.actionShare[i]).toFixed(0)}%`).join('  ')}`);
      console.log(`  被牆擋住 ${(100 * t.blockedShare).toFixed(0)}%｜擋住時開火 ${(100 * t.fireWhileBlockedShare).toFixed(0)}%｜` +
        `最長原地 ${t.maxStay} 幀｜卡牆車 ${t.stuckTanks} 台`);
      console.log(`  子彈死因 ${JSON.stringify(t.bulletDeaths)}`);
      console.log(`  推進 ${t.advancePx.toFixed(0)}px｜走過 ${t.distinctCells} 格｜abstain ${(100 * t.abstainShare).toFixed(0)}%`);
      console.log(`  地形：削磚 ${tt.brick_destroyed} 格、打鋼 ${tt.steel} 次（打不動）、` +
        `打水 ${tt.water} 次、打樹 ${tt.forest} 次、打冰 ${tt.ice} 次`);
    }
    console.log(`\n─ 紅旗（${episodes} 個被監測隊伍實例中出現次數）─`);
    if (!tally.size) console.log('  ✓ 無');
    for (const e of [...tally.values()].sort((a, b) => b.n - a.n))
      console.log(`  ✗ ${e.label}  ${e.n}/${episodes}｜${e.samples.join('；')}｜門槛 ${e.limit}\n` +
        `     原因：${e.why}\n     修法：${e.fix}`);
    const win = all.filter(r => r.winner === 0).length;
    console.log(`\n結果面：藍隊勝 ${win}/${all.length}（對照用，不能代替過程檢查）`);
  }

  if (o.json) {
    fs.mkdirSync(require('path').dirname(o.json), { recursive: true });
    fs.writeFileSync(o.json, JSON.stringify({ mode: o.mode, stage: o.stage, games: all.map(r => r.telemetry) }, null, 1));
    console.log(`\n詳細數據 → ${o.json}`);
  }
  return { all, tally };
}

/* ⚠ 匯出要在 CLI 啟動「之前」：arena.js 會 require 本模組，而 main() 又
   require arena —— 先跑 main 的話循環依賴會拿到還沒賦值的 exports。 */
module.exports = { Recorder, RULES, main };

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (e) { console.error(e.stack); process.exitCode = 1; }
}
