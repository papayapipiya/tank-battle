/* ai/train-cli.js — train.bat 的內容本體（ASCII 批次檔 ＋ 這裡出中文）
   ═══════════════════════════════════════════════════════════
   為什麼中文不寫在 .bat 裡：cmd.exe 用系統碼頁逐位元組解析批次檔，
   夾中文的 UTF-8 .bat 會被拆成亂碼指令（實測：'M' 不是內部或外部命令）。
   所以 train.bat 只留 ASCII 外殼，所有訊息由 node 印出 —— node 的輸出
   在 Windows 終端機（配合 chcp 65001）是正常的 UTF-8。

   算分 v6 起是「雙族群」：藍＝進攻、紅＝防守各練各的，一份網路同時被
   兩種角色輪流考，分數只會是兩邊的平均。所以這裡預設練進攻族，
   要換族就把角色寫進參數（位置不拘順序）：

     node ai/train-cli.js                    # 進攻族 runs/attack-v6.json，20 代
     node ai/train-cli.js defense            # 防守族 runs/defense-v6.json，20 代
     node ai/train-cli.js defense 10         # 防守族只跑 10 代
     node ai/train-cli.js 40 runs/neat.json  # 指定存檔（舊用法照舊有效）

   ⚠ 這裡是「手動、跑固定幾代」的路。要「兩族交替、無限輪、每代刷新快照、
     網頁自己跟隨」請雙擊 auto.bat（ai/auto-train.js）。單獨練一族時對手取
     另一族最新的冠軍快照（拿不到才退回規則 AI），所以分數仍可比，
     只是不會自動輪替 —— 一邊變強另一邊的尺跟著變嚴這件事不會發生。

   它跟 evolve.js 是同一支訓練碼（直接 require 進來跑 main()），
   所以「一鍵」跟「手打指令」不會是兩套行為；差別只在預設值與結尾提示。
   ═══════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const evolve = require('./evolve');

/** 兩個角色 → 各自的 checkpoint 與瀏覽器快照（一個角色一整套，絕不共用）。
 *  ⚠ 檔名裡的「v6」是這一對存檔開族時的標籤，不是算分版本：真正的版本在
 *     檔案內的 scoringVersion，升版（v6 → v7 加了自破與貼身）不換檔名，
 *     由 ai/evolve.js 偵測版本不符後把舊冠軍在現行的尺下重評。 */
const ROLES = {
  attack: { label: '進攻', seat: '藍', ckpt: path.join('runs', 'attack-v6.json'), snap: 'trained-attack' },
  defense: { label: '防守', seat: '紅', ckpt: path.join('runs', 'defense-v6.json'), snap: 'trained-defense' },
};
const ORDER = ['attack', 'defense'];

const roleOf = tok => {
  if (tok === undefined) return null;
  const t = String(tok).toLowerCase();
  if (t === 'attack' || t === 'a' || tok === '進攻' || tok === '攻' || tok === '藍') return 'attack';
  if (t === 'defense' || t === 'defence' || t === 'd' || tok === '防守' || tok === '守' || tok === '紅') return 'defense';
  return null;
};

// 位置參數不拘順序：角色 / 代數 / 存檔路徑各認各的。
let role = null, gens = null, ckpt = null;
for (const a of process.argv.slice(2)) {
  const r = roleOf(a);
  if (r && !role) { role = r; continue; }
  if (gens === null && /^\d+$/.test(a)) { gens = Number(a); continue; }
  if (!ckpt && !/^\d+$/.test(a)) { ckpt = a; continue; }
  console.log(`多餘的參數：${a}`);
  console.log('用法：train.bat [attack|defense] [代數] [存檔路徑]');
  process.exitCode = 1;
  return;
}

// 什麼都沒給 → 進攻族（兩族都還沒開族時也是它，下面會提示怎麼起頭）。
// 只給存檔路徑 → 從檔名認一次角色，避免把防守族練成進攻族的尺。
if (!role && !ckpt) role = 'attack';
if (!role && ckpt) {
  const base = path.basename(ckpt).toLowerCase();
  if (/defen[cs]e/.test(base)) role = 'defense';
  else if (/attack/.test(base)) role = 'attack';
}
if (!ckpt && role) ckpt = ROLES[role].ckpt;
gens = gens === null ? 20 : gens;
const R = role ? ROLES[role] : null;

if (!fs.existsSync(ckpt)) {
  console.log(`找不到存檔 ${ckpt}。`);
  console.log('第一次訓練請先產生一個起點（三選一，由省事到麻煩）：');
  console.log('  1) 雙擊 auto.bat —— 兩族交替、無限輪、每代刷新快照、網頁自己跟隨');
  console.log('  2) node ai/split.js —— 從舊的單模型冠軍拆出進攻族＋防守族兩份存檔，再雙擊 train.bat');
  console.log('  3) 從模仿種子練起：');
  console.log('     node ai/imitate.js --stages 0,1,2 --games 3 --out runs/seed.json');
  console.log(`     node ai/evolve.js --seed-from runs/seed.json --gens 20 --out ${ckpt}`);
  process.exitCode = 1;
  return;
}

if (!Number.isFinite(gens) || gens <= 0) {
  console.log('代數要是正整數，例如：node ai/train-cli.js 20');
  console.log('換一族：node ai/train-cli.js defense 20');
  process.exitCode = 1;
  return;
}

const perGenSec = 17;   // 實測：族群 24 × 2 圖 × 2 種子 × 雙座位 ≈ 15～20 秒/代
const mins = Math.round(gens * perGenSec / 60);

console.log('========================================');
console.log(`  訓練 ${gens} 代${R ? `（${R.seat}＝${R.label}族）` : ''}，接續 ${ckpt}`);
console.log(`  估計 ${mins < 1 ? '不到 1' : mins} 分鐘（每代約 ${perGenSec} 秒，實際看機器）`);
console.log('  這支視窗要開著；想中途停就在這個視窗按 Ctrl+C（每代會落盤，停了不會白跑）');
console.log('');
console.log('  邊看邊練：另開一個終端機視窗，在專案資料夾下打');
console.log(`    node ai/evolve.js --status ${ckpt}`);
console.log('  會回報第幾代、累計幾場、最後落盤是幾秒前 —— 那個「幾秒前」會週期性歸零，就是活著');
console.log('  同時開著 index.html 就會自己進觀戰（標題畫面按 T 是手動開場）；');
console.log('  左欄 ①「訓練狀態」每代跟著換，任一族的冠軍換人時場上該隊的車直接換網路');
console.log('========================================');
console.log('');

try {
  // --export-to 決定刷新哪一份快照：兩族的檔名不同源，混用會讓藍席跑防守模型
  // （實測過：那樣兩隊分數會一起塌，看起來像退步，其實是考錯人）。
  // --export-every 1 讓網頁每代跟隨，不必等整段跑完。
  const snap = R ? path.join('ai', `${R.snap}.json`) : path.join('ai', 'trained.json');
  const args = ['--resume', ckpt, '--gens', String(gens), '--export-to', snap, '--export-every', '1'];
  if (R) {
    const other = ROLES[ORDER.find(k => k !== role)];
    const opp = path.join('ai', `${other.snap}.json`);
    if (fs.existsSync(opp)) args.push('--vs', opp);
  }
  evolve.main(args);
} catch (e) {
  console.log('');
  console.log(`✗ 訓練中斷：${e.message}`);
  console.log('  （部分代數已經落盤，重跑同一條指令會從上次的存檔接續）');
  process.exitCode = 1;
  return;
}

console.log('');
console.log('========================================');
console.log('  完成。怎麼確認與驗收：');
console.log('  1) 開 index.html（開著的重新整理一次）→ 左欄 ① 的代數／分數應該已經往上走');
console.log(`  2) 訓練履歷：node ai/ledger.js --ckpt ${ckpt}`);
console.log(`     （工作階段幾段、每段幾代幾場幾分鐘、冠軍第幾代刷新、評判標準）`);
console.log('  3) 過程監測：node ai/monitor.js --ckpt ' + ckpt + ' --stage 0 --games 4');
console.log('     再開 ai/monitor.html 看卡牆／動作單一／子彈去哪了');
console.log('  4) 只練一族不會自動輪替：要兩族互為考題、每代刷新、網頁自己跟隨，');
console.log('     就雙擊 auto.bat（ai/auto-train.js）。');
console.log('========================================');
