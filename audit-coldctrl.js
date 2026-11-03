'use strict';
/* audit-coldctrl.js — 「冷開機第一代的分到底是誰掙來的」探針（唯讀，不寫任何檔案）
   ═══════════════════════════════════════════════════════════════════════
   為什麼要寫這支：訓練管線裡有一句流傳了很久的解釋——「冷開機第一代很多幀在
   abstain，是規則 AI 在代步，所以它的 mean 天生虛高」。聽起來合理，但從來沒人量過。
   批次五（進攻席位移退回「只壓主堡」）之後暖啟動第一代的分數掉下來，這條假設被
   拿去當藉口，結果一量就錯：

     · abstain 的條件是「最大輸出 < -0.85」（ai/neat.js 的 toPolicy），
       隨機權重的 argmax 幾乎永遠在上面 ⇒ 第一代就在自己開車；
     · 真的代步的是**規則 AI 那席**：控制權欄位只統計網路，所以老師顯示 0%。

   冷開機 mean 有時比暖啟動高，原因在尺不在代步：**亂走偶爾撿到過程分**
   （實測防守席隨機#1 87.35 ＞ 老師 55.87 ＞ 種子 22.61）。這是計分的弱點，
   記在 BALANCE-RESEARCH.md；它同時也說明「暖啟動第一代 mean 有沒有比冷開機高」
   不能拿來判斷暖啟動划不划算，要判斷就得看 3 代冠軍坐回席位的勝負。

   跑法：node audit-coldctrl.js            （兩席都跑）
         node audit-coldctrl.js attack     （只跑進攻席）                                */

const path = require('path');
const fs = require('fs');
const { Arena } = require('./ai/arena');
const Fitness = require('./ai/fitness');
const Observation = require('./ai/observation');
const { ACTION_COUNT } = require('./ai/actions');
const { Genome, InnovationHistory } = require('./ai/neat');

const arena = new Arena({ maxFrames: 2400 });
// 考題固定 6 局（3 張圖 × 2 個種子）：控制權與均分是穩定統計量，不用 24 局。
const EXAMS = [];
for (let m = 0; m < 3; m++) for (let s = 0; s < 2; s++) EXAMS.push({ stage: m, seed: 41000 + m * 7 + s * 131 });

const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '—');

/** 把 pol 放進 role 那一席（對面恆為規則 AI），回傳控制權／卡牆／均分／勝負／破局 */
function measure(pol, role) {
  const acc = { decided: 0, field: 0, stuck: 0, score: 0, win: 0, breach: 0, tot: 0 };
  const id = role === 'attack' ? 0 : 1;
  for (const e of EXAMS) {
    const r = role === 'attack'
      ? arena.run({ stage: e.stage, seed: e.seed, blue: pol, red: 'rule' })
      : arena.run({ stage: e.stage, seed: e.seed, blue: 'rule', red: pol });
    const t = r.teams[id];
    acc.decided += t.framesDecided || 0;
    acc.field += t.fieldFrames || 0;
    acc.stuck += t.blockedFrames || 0;
    acc.score += Fitness.scoreOf(t, r, id, {
      role: role === 'attack' ? Fitness.ROLES.ATTACK : Fitness.ROLES.DEFENSE, maxFrames: 2400,
    }).final;
    acc.breach += (r.end === 'breach' ? 1 : 0);
    acc.win += (r.winner === id ? 1 : 0);
    acc.tot++;
  }
  return {
    ctrl: acc.decided / Math.max(1, acc.field),
    stuck: acc.stuck / Math.max(1, acc.field),
    mean: acc.score / acc.tot,
    win: `${acc.win}/${acc.tot}`,
    breach: `${acc.breach}/${acc.tot}`,
  };
}

/** 跟 NEAT.initialize 同一支碼的隨機基因組（Genome.seed、10 條邊、同一個 LCG） */
function randomGenomes(n) {
  let x = 4242;
  const rand = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const out = [];
  for (let i = 0; i < n; i++) {
    const g = Genome.seed(Observation.OBS_DIM, ACTION_COUNT, new InnovationHistory(), rand);
    out.push({ kind: 'policy', policy: g.toPolicy(), label: `隨機#${i}` });
  }
  return out;
}

function report(role) {
  const seat = role === 'attack' ? '藍（進攻）' : '紅（防守）';
  console.log(`\n── ${seat}席：冷開機第一代的分是誰掙的（${EXAMS.length} 局固定考題）──`);
  const rows = [];
  for (const p of randomGenomes(3)) rows.push({ ...measure(p, role), name: p.label });
  const seedFile = path.join('runs', `seed-${role}.json`);
  if (fs.existsSync(seedFile)) {
    const sj = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
    rows.push({ ...measure({ kind: 'policy', policy: Genome.fromJSON(sj.genome).toPolicy() }, role), name: '模仿種子' });
  } else {
    console.log(`   （缺少 ${seedFile}，種子那列跳過：node ai/imitate.js --role ${role} --out ${seedFile}）`);
  }
  rows.push({ ...measure('rule', role), name: '老師(規則AI)' });
  for (const r of rows) {
    console.log(`   ${r.name.padEnd(14)} 控制權 ${pct(r.ctrl * 100, 100)}｜卡牆 ${pct(r.stuck * 100, 100)}｜` +
      `均分 ${r.mean.toFixed(2)}｜勝 ${r.win}｜破局 ${r.breach}`);
  }
  console.log('   讀法：控制權只統計「網路自己決策」的在場幀，規則 AI 那席恆為 0%；' +
    '所以「隨機權重也在自己開車」這件事看的是前三列，不是最後一列。');
}

const only = process.argv[2];
for (const role of (only ? [only] : ['attack', 'defense'])) {
  if (role !== 'attack' && role !== 'defense') {
    console.error(`用法：node audit-coldctrl.js [attack|defense]（收到 ${role}）`);
    process.exitCode = 1;
    continue;
  }
  report(role);
}
