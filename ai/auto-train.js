/* ai/auto-train.js — 全自動：進攻模型＋防守模型交替演化、自己匯出、網頁自己開場自己跟隨
   ═══════════════════════════════════════════════════════════
   使用者的原話：「我要自動遊戲自動訓練 不要有手動處理」，
   以及這一輪的方向修正：「藍色＝進攻、紅色＝防守，各自有各自的訓練模型」。

   這支程式做的事（一次設定，之後不用管）：
     1. 交替跑兩段訓練，一輪接一輪，永遠不會停：
          第 k 輪： 進攻族 N 代（對手＝防守族最新冠軍）→ 匯出
                    防守族 N 代（對手＝剛匯出的進攻族新冠軍）→ 匯出
        這就是「交替自我對弈」：兩族互為考題，一邊變強另一邊的尺跟著變嚴。
     2. 每代都落盤（--save-every 1）並刷新該族的觀戰快照
        （--export-to ＋ --export-every 1）→ 網頁上的代數與網路自己更新。
     3. 寫出 ai/auto-watch.js 旗標 → 重新整理 index.html 就會自己開場，
        不必在標題畫面按 Y／U。旗標裡帶兩份快照檔名，藍席放進攻模型、
        紅席放防守模型（不再是「兩隊同一份網路」）。
     4. 開一次瀏覽器（--no-open 可關）；之後頁面自己跟隨，不用再碰。
     5. 訓練程序掛掉會自動重開；Ctrl+C 才是真的停。
     6. 兩份 v6 存檔（runs/attack-v6.json／runs/defense-v6.json）若不存在，
        先自己跑 node ai/split.js 從舊的單模型冠軍拆出兩族 —— 第一次開機
        也是零手動。

   ⚠ 兩隻訓練程序不能同時寫同一份存檔 —— 這支用 runs/auto-train.lock
     擋掉重複啟動，開場前也會看 ai/live-data.js 是否還有別的訓練在跑
     （running=true 且兩分鐘內有更新、而且寫的不是我們這兩份存檔就拒絕啟動）。

   ⚠ 即時看板 ai/live-data.js 一次只反映「正在練的那一族」：
     進攻段跑完換防守段，看板的角色會跟著換。要看兩族的歷史履歷請開
     ai/ledger.html（node ai/ledger.js --all 產生），它同時列兩族。

   用法：
     node ai/auto-train.js                 # 無限輪，每輪兩族各 20 代
     node ai/auto-train.js --mode rule     # 觀戰改成「藍隊進攻網路 vs 紅隊規則 AI」
     node ai/auto-train.js --stage 2       # 觀看地圖索引 2（STAGE 顯示 3）
     node ai/auto-train.js --gens 10       # 每段 10 代
     node ai/auto-train.js --once          # 只跑一輪就停（測試／有事要關機）
     node ai/auto-train.js --off           # 關掉自動開場（刪除旗標檔）
     node ai/auto-train.js --no-open       # 不自動開瀏覽器

   進度：
     runs/trainer.log        訓練原始輸出（每段一個標頭，掛掉的原因也在這）
     ai/live.html            即時看板（正在練的那一族；代數與角色每代更新）
     ai/ledger.html          兩族的訓練履歷與評判標準（靜態快照，要重跑 node ai/ledger.js --all）
     index.html              開著就會自己開場；任一族的冠軍換人時場上該隊的車直接換網路
   ═══════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

/** 兩個角色 → 兩份 checkpoint ＋ 兩份觀戰快照（一個角色一整套，絕不共用）
 *  ⚠ 檔名裡的「v6」是這一對存檔開族時的標籤（雙族群從算分 v6 開始），
 *     不是算分版本。真正的版本在檔案內的 scoringVersion：
 *     升版（例如 v6 → v7 加了「自破老鷹」與「貼身殲滅」）時**不換檔名**，
 *     由 ai/evolve.js 偵測 scoringVersion 不符 → 把舊冠軍在現行尺下重評。
 *     換檔名等於把已經練好的幾百代丟在原處沒人接，那是資料損失不是整理。 */
const MODELS = {
  attack: {
    role: 'attack', label: '進攻', seat: 0,
    ckpt: path.join(ROOT, 'runs', 'attack-v6.json'),
    to: path.join(ROOT, 'ai', 'trained-attack.json'),
  },
  defense: {
    role: 'defense', label: '防守', seat: 1,
    ckpt: path.join(ROOT, 'runs', 'defense-v6.json'),
    to: path.join(ROOT, 'ai', 'trained-defense.json'),
  },
};
/** 交替的順序：先練進攻，防守那段才看得到「今天變強的對手」 */
const ORDER = ['attack', 'defense'];

const DEFAULTS = {
  seed: path.join(ROOT, 'runs', 'seed.json'),
  from: path.join(ROOT, 'runs', 'warm-v2.json'),     // 分裂用的舊單模型冠軍
  flag: path.join(ROOT, 'ai', 'auto-watch.js'),
  lock: path.join(ROOT, 'runs', 'auto-train.lock'),
  log: path.join(ROOT, 'runs', 'trainer.log'),
  live: path.join(ROOT, 'ai', 'live-data.js'),
  index: path.join(ROOT, 'index.html'),
};

const HELP = `ai/auto-train.js — 自動訓練（進攻／防守交替演化）＋自動觀戰

用法：
  node ai/auto-train.js                 # 無限輪；一輪 = 進攻 N 代 → 防守 N 代
  node ai/auto-train.js --gens 10       # 每段 10 代（一輪 20 代）
  node ai/auto-train.js --once          # 只跑一輪
  node ai/auto-train.js --max-rounds 5  # 跑 5 輪後停
  node ai/auto-train.js --mode rule     # 觀戰：藍隊進攻網路 vs 紅隊規則 AI（預設 dual）
  node ai/auto-train.js --stage 2       # 觀戰地圖索引（0 起算）
  node ai/auto-train.js --no-open       # 不自動開瀏覽器
  node ai/auto-train.js --off           # 停用自動開場（刪旗標，下次開頁面回標題）
  node ai/auto-train.js --force         # 忽略「別的訓練還在跑」的檢查（危險，通常不要）
  node ai/auto-train.js --no-split      # 兩份 v6 存檔不在就報錯，不要自動跑 ai/split.js
  node ai/auto-train.js --sandbox DIR   # 存檔／快照／旗標／鎖／日誌全進 DIR（測試用，不碰正式檔）

輸出：
  ai/trained-attack.js / ai/trained-defense.js  兩個角色的觀戰快照（瀏覽器每 12 秒重讀）
  ai/auto-watch.js     自動開場旗標（內容是觀戰模式、地圖與兩份快照檔名）
  runs/trainer.log     訓練原始輸出
  runs/auto-train.lock 單一訓練程序鎖（正常結束會刪除）`;

function rel(p) { return path.relative(ROOT, p).replace(/\\/g, '/'); }

function stamp() {
  return new Date().toLocaleString('zh-Hant', { hour12: false });
}

function parse(argv) {
  const o = {
    gens: 20, once: false, maxRounds: 0,
    mode: 'dual', stage: 0, open: true, flagOn: true, live: true, split: true,
    force: false, off: false, help: false, sandbox: null,
    seed: DEFAULTS.seed, from: DEFAULTS.from,
    flag: DEFAULTS.flag, lock: DEFAULTS.lock, log: DEFAULTS.log,
    liveFile: DEFAULTS.live, index: DEFAULTS.index,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 需要一個值`);
      return v;
    };
    switch (a) {
      case '--gens': o.gens = Number(take()); break;
      case '--once': o.once = true; break;
      case '--max-rounds': o.maxRounds = Number(take()); break;
      case '--mode': o.mode = take(); break;
      case '--stage': o.stage = Number(take()); break;
      case '--no-open': o.open = false; break;
      case '--no-flag': o.flagOn = false; break;
      case '--no-live': o.live = false; break;
      case '--no-split': o.split = false; break;
      case '--force': o.force = true; break;
      case '--off': o.off = true; break;
      case '--sandbox': o.sandbox = path.resolve(take()); break;
      case '--help': case '-h': o.help = true; break;
      case '--seed': o.seed = path.resolve(take()); break;
      case '--from': o.from = path.resolve(take()); break;
      case '--flag': o.flag = path.resolve(take()); break;
      case '--lock': o.lock = path.resolve(take()); break;
      case '--log': o.log = path.resolve(take()); break;
      case '--index': o.index = path.resolve(take()); break;
      default: throw new Error(`unknown arg: ${a}`);
    }
  }
  // 沙箱（給自動測試用）：兩族的存檔、快照、旗標、鎖、日誌、看板檔
  // 全部改指到暫時目錄。沒有這一步，測試就會去寫使用者正在練的那兩份
  // v6 存檔 —— 兩支程序寫同一份會互相蓋掉，這是訓練管線最貴的一種意外。
  if (o.sandbox) {
    const inSandbox = p => path.join(o.sandbox, path.basename(p));
    for (const k of ORDER) MODELS[k] = Object.assign({}, MODELS[k], {
      ckpt: inSandbox(MODELS[k].ckpt), to: inSandbox(MODELS[k].to),
    });
    o.flag = inSandbox(o.flag);
    o.lock = inSandbox(o.lock);
    o.log = inSandbox(o.log);
    o.liveFile = inSandbox(o.liveFile);
    o.index = inSandbox(o.index);
    fs.mkdirSync(o.sandbox, { recursive: true });
  }
  if (!Number.isInteger(o.gens) || o.gens <= 0)
    throw new Error(`--gens 要是正整數（收到 ${o.gens}）`);
  if (!['dual', 'both', 'rule', 'attack', 'defense'].includes(o.mode))
    throw new Error(`--mode 只能是 dual（預設，兩隊各自的角色模型）／rule（藍＝進攻網路，紅＝規則 AI）` +
      `／attack／defense（只放一個模型，另一隊規則 AI）（收到 ${o.mode}）`);
  if (o.mode === 'both') o.mode = 'dual';        // 舊旗標寫法相容
  if (!Number.isInteger(o.stage) || o.stage < 0)
    throw new Error(`--stage 要是非負整數（收到 ${o.stage}）`);
  return o;
}

/* ── 鎖：同一份專案只準一支自動訓練 ── */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function readLock(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function acquireLock(o) {
  const prev = readLock(o.lock);
  if (prev && prev.pid && prev.pid !== process.pid && pidAlive(prev.pid)) {
    console.error(`✗ 已經有一支自動訓練在跑（PID ${prev.pid}，${prev.startedAt || '?'}）。`);
    console.error('  同一份存檔不能同時寫 —— 先關掉那一支，或確認它真的死了再刪 ' + rel(o.lock));
    return false;
  }
  fs.mkdirSync(path.dirname(o.lock), { recursive: true });
  fs.writeFileSync(o.lock, JSON.stringify({
    pid: process.pid, startedAt: new Date().toISOString(),
    models: ORDER.map(k => rel(MODELS[k].ckpt)),
  }, null, 2));
  return true;
}

function releaseLock(o) {
  const j = readLock(o.lock);
  if (j && j.pid === process.pid) {
    try { fs.unlinkSync(o.lock); } catch { /* 已經沒了就算了 */ }
  }
}

/* ── 看 live-data.js：是不是還有另一支訓練在跑（不是我們的子程序） ── */
function readLive(file) {
  try {
    const ctx = {};
    ctx.window = ctx;
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), ctx, { timeout: 1000 });
    return ctx.__LIVE__ || null;
  } catch { return null; }
}

function otherTrainerRunning(o) {
  const j = readLive(o.liveFile);
  if (!j || j.running !== true) return null;
  const at = Date.parse(j.at || '');
  if (!Number.isFinite(at) || Date.now() - at > 120000) return null;   // 兩分鐘沒動＝死掉的殘影
  const mine = ORDER.map(k => path.resolve(MODELS[k].ckpt));
  const other = j.file ? path.resolve(ROOT, j.file) : null;
  if (other && mine.includes(other)) return null;            // 是我們自己這兩份存檔之一，不衝突
  return j;
}

/* ── 自動開場旗標：瀏覽器的 watch.js 讀到就自己開場 ── */
function writeFlag(o) {
  const body =
    '/* 由 ai/auto-train.js 自動產生，請勿手改。\n' +
    '   存在的意思＝index.html 一打開就自動觀戰（不必按 Y／U）。 */\n' +
    'window.TANK_AUTO_WATCH = ' + JSON.stringify({
      mode: o.mode,                 // dual = 藍隊進攻模型 vs 紅隊防守模型；rule = 進攻模型 vs 規則 AI
      stage: o.stage,               // 地圖索引（STAGE 面板顯示 +1）
      // 兩份快照的路徑也寫進來：觀戰頁因此不需要把檔名寫死，
      // 之後要換檔名（例如再多一個角色）只改訓練端這一處。
      attack: rel(MODELS.attack.to).replace(/\.json$/, '.js'),
      defense: rel(MODELS.defense.to).replace(/\.json$/, '.js'),
      since: new Date().toISOString(),
    }, null, 2) + ';\n';
  fs.mkdirSync(path.dirname(o.flag), { recursive: true });
  fs.writeFileSync(o.flag, body);
}

function removeFlag(o) {
  try { fs.unlinkSync(o.flag); } catch { /* 不存在就算了 */ }
}

/* ── 開瀏覽器（Windows 用 start；其他平台用 open／xdg-open） ── */
function openGame(o) {
  try {
    const url = 'file:///' + o.index.replace(/\\/g, '/');
    let cmd, args;
    if (process.platform === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '', url]; }
    else if (process.platform === 'darwin') { cmd = 'open'; args = [url]; }
    else { cmd = 'xdg-open'; args = [url]; }
    const c = spawn(cmd, args, { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
    c.on('error', () => console.warn(`⚠ 開不了瀏覽器，請自己開 ${rel(o.index)}`));
    c.unref();
  } catch (e) {
    console.warn(`⚠ 開不了瀏覽器（${e.message}），請自己開 ${rel(o.index)}`);
  }
}

/* ── 一段訓練：一個 evolve 子程序（吃一個角色） ── */
function sessionArgs(o, roleKey) {
  const m = MODELS[roleKey];
  const other = MODELS[ORDER.find(k => k !== roleKey)];
  const args = [path.join(__dirname, 'evolve.js')];
  if (fs.existsSync(m.ckpt)) args.push('--resume', m.ckpt);
  else args.push('--out', m.ckpt, '--role', m.role);        // 理論上不會走到：ensureModels 先補齊
  // 對手＝另一個角色「最新的冠軍」。檔還在寫／還沒匯出時退回規則 AI，
  // 不能讓整段訓練因為一個附檔不存在就中斷。
  if (fs.existsSync(other.to)) args.push('--vs', other.to);
  args.push('--gens', String(o.gens));
  args.push('--save-every', '1');
  args.push('--export-to', m.to);
  args.push('--export-every', '1');
  if (!o.live) args.push('--no-live');
  return args;
}

let activeChild = null;
let stopping = false;

function runSession(o, n, roleKey) {
  const m = MODELS[roleKey];
  return new Promise(resolve => {
    const args = sessionArgs(o, roleKey);
    fs.mkdirSync(path.dirname(o.log), { recursive: true });
    const fd = fs.openSync(o.log, 'a');
    fs.writeSync(fd, `\n===== [${stamp()}] 第 ${n} 輪・${m.label}族：${o.gens} 代｜` +
      `${fs.existsSync(m.ckpt) ? '接續' : '新開'} ${rel(m.ckpt)}｜對手 ` +
      `${args.includes('--vs') ? rel(MODELS[ORDER.find(k => k !== roleKey)].to) : '規則 AI'} =====\n`);
    fs.writeSync(fd, `node ${args.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}\n\n`);

    let child;
    try {
      child = spawn(process.execPath, args, {
        cwd: ROOT, windowsHide: true,
        stdio: ['ignore', fd, fd],
      });
    } catch (e) {
      fs.closeSync(fd);
      console.error(`✗ 無法啟動訓練子程序：${e.message}`);
      return resolve({ code: -1, error: e.message });
    }

    activeChild = child;
    child.on('error', e => {
      fs.closeSync(fd);
      activeChild = null;
      console.error(`✗ 訓練子程序錯誤：${e.message}`);
      resolve({ code: -1, error: e.message });
    });
    child.on('exit', (code, signal) => {
      try { fs.closeSync(fd); } catch { /* 已關 */ }
      activeChild = null;
      resolve({ code, signal });
    });
  });
}

/** 同步跑一支子程序並等它結束（用在開機前的準備步驟） */
function runSync(o, args, label) {
  return new Promise(resolve => {
    const c = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true, stdio: 'inherit' });
    c.on('error', e => { console.error(`✗ ${label} 啟動失敗：${e.message}`); return resolve(-1); });
    c.on('exit', code => resolve(code));
  });
}

/**
 * 開機前的準備：兩份 v6 存檔 + 兩份觀戰快照一定要存在。
 * 少了這一段，「第一次執行」就需要使用者手動跑 ai/split.js 與 --export，
 * 而使用者的要求是「不要有手動處理」。
 */
async function ensureModels(o) {
  const missing = ORDER.filter(k => !fs.existsSync(MODELS[k].ckpt));
  if (missing.length) {
    if (!o.split) {
      console.error(`✗ 缺少 ${missing.map(k => rel(MODELS[k].ckpt)).join('／')}；` +
        `--no-split 擋掉了自動分裂，請自己跑 node ai/split.js`);
      return false;
    }
    if (!fs.existsSync(o.from)) {
      console.error(`✗ 要自動分裂但找不到來源存檔 ${rel(o.from)}；` +
        `請用 --from 指到一份有冠軍的 checkpoint`);
      return false;
    }
    console.log(`[${stamp()}] 第一次開機：從 ${rel(o.from)} 的冠軍拆出進攻／防守兩個族群…`);
    const code = await runSync(o, [path.join(__dirname, 'split.js')], 'ai/split.js');
    if (code !== 0) { console.error(`✗ ai/split.js 回傳 ${code}，無法開始訓練`); return false; }
  }
  // 快照先補齊：這樣第一輪的防守段就能拿到「對手」，觀戰頁也不會開空檔。
  for (const k of ORDER) {
    const m = MODELS[k];
    if (fs.existsSync(m.to)) continue;
    console.log(`[${stamp()}] 補上缺失的觀戰快照 ${rel(m.to)}…`);
    const code = await runSync(o, [path.join(__dirname, 'evolve.js'),
      '--export', m.ckpt, '--to', m.to], '匯出快照');
    if (code !== 0) console.warn(`⚠ ${rel(m.to)} 匯出失敗（code=${code}）；` +
      `對手那一族這輪會退回規則 AI，訓練照跑`);
  }
  return true;
}

async function main(argv) {
  const o = parse(argv);
  if (o.help) { console.log(HELP); return; }
  if (o.off) {
    removeFlag(o);
    console.log(`已停用自動開場（刪除 ${rel(o.flag)}）。`);
    console.log('訓練若還在跑不受影響；下次開 index.html 會回到標題畫面。');
    return;
  }

  if (!acquireLock(o)) { process.exitCode = 1; return; }

  const other = o.force ? null : otherTrainerRunning(o);
  if (other) {
    releaseLock(o);
    console.error(`✗ 偵測到另一支訓練正在跑（${other.file || '?'}，最後更新 ${other.at}）。`);
    console.error('  兩支程序同時寫存檔會互相蓋掉；等它結束，或確定是殘影再 --force。');
    process.exitCode = 1;
    return;
  }

  const cleanup = () => {
    stopping = true;
    if (activeChild) {
      try { activeChild.kill(); } catch { /* 已結束 */ }
    }
    removeFlag(o);          // 使用者主動停：不要讓下次開頁面還自動進觀戰
    releaseLock(o);
  };
  process.on('SIGINT', () => { console.log('\n收到 Ctrl+C，收尾中…'); cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });
  process.on('exit', () => {
    if (stopping) return;
    releaseLock(o);         // 正常結束只清鎖；旗標留著（頁面仍可自動觀戰最新快照）
  });

  if (!(await ensureModels(o))) { releaseLock(o); process.exitCode = 1; return; }

  if (o.flagOn) writeFlag(o);

  console.log('========================================');
  console.log('  自動訓練：進攻／防守兩個模型交替演化（之後不用再手動匯出或按鍵）');
  for (const k of ORDER)
    console.log(`  ${MODELS[k].label}族 ${rel(MODELS[k].ckpt)}｜每段 ${o.gens} 代｜` +
      `每代匯出 ${rel(MODELS[k].to)}`);
  console.log(`  對弈方式：每一族都坐自己的席位，對手＝另一族最新的冠軍`);
  console.log(`  觀戰 ${o.mode === 'dual' ? '藍＝進攻模型、紅＝防守模型'
    : o.mode === 'rule' ? '藍＝進攻網路、紅＝規則 AI'
    : `${MODELS[o.mode].label}網路 vs 規則 AI`}｜地圖 ${o.stage}（STAGE ${o.stage + 1}）`);
  console.log(`  日誌 ${rel(o.log)}｜鎖 ${rel(o.lock)}`);
  console.log('  停止：在這個視窗按 Ctrl+C（會先收掉子程序，不會留兩支在跑）');
  console.log('========================================');

  if (o.flagOn && o.open) {
    openGame(o);
    console.log(`已開瀏覽器；舊的分頁請關掉或重新整理一次，之後就交給自動跟隨。`);
  }

  let rounds = 0;
  let failures = 0;
  while (!stopping) {
    rounds++;
    for (const roleKey of ORDER) {
      if (stopping) break;
      const m = MODELS[roleKey];
      console.log(`[${stamp()}] 第 ${rounds} 輪・${m.label}族：${o.gens} 代 → ${rel(m.ckpt)}`);
      const r = await runSession(o, rounds, roleKey);
      if (stopping) break;
      if (r.code === 0) {
        failures = 0;
      } else {
        failures++;
        const wait = Math.min(60, 5 * failures);
        console.error(`[${stamp()}] 第 ${rounds} 輪・${m.label}族中斷（code=${r.code}` +
          `${r.signal ? `, ${r.signal}` : ''}）。${wait} 秒後跳到下一段；原因看 ${rel(o.log)} 尾巴。`);
        await new Promise(res => setTimeout(res, wait * 1000));
      }
    }
    if (stopping) break;
    if (!failures) console.log(`[${stamp()}] 第 ${rounds} 輪完成（兩族各 ${o.gens} 代），接下一輪。`);
    if (o.once) break;
    if (o.maxRounds && rounds >= o.maxRounds) break;
    await new Promise(res => setTimeout(res, 1000));
  }

  console.log(`\n[${stamp()}] 自動訓練結束（共 ${rounds} 輪）。`);
  if (!stopping) releaseLock(o);   // 正常結束（--once／--max-rounds）：旗標留著，頁面仍可自動觀戰
  else cleanup();
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(e => {
    console.error(e.stack || e.message);
    process.exitCode = 1;
  });
}

module.exports = {
  MODELS, ORDER, parse, readLock, readLive, otherTrainerRunning,
  sessionArgs, writeFlag, removeFlag, ensureModels,
};
