/* ai/checkpoint.js — 訓練進度落盤
   ═══════════════════════════════════════════════════════════
   「今天跑 100 場、明天接著跑」要靠這個檔案。裡面必須有 4 樣東西，
   少一樣隔天就會跑偏：

     · population + species   —— 個體本身
     · innovation history     —— 少了它，隔天長出的新邊會跟歷史上的邊重複編號，
                                 crossover 把兩條不同的邊當成同一條
     · generation / history   —— 停滯偵測與收敛曲線要接得回去
     · obsSpec                —— 觀測規格版本；欄位一變，舊基因組全部作廢，
                                 這裡寧可拒絕載入也不要悄悄跑出無意義的數字
   ═══════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');

const KIND = 'tank-battle-neat-checkpoint';
const FORMAT_VERSION = 1;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 原子換檔。
 * Windows 上 rename 覆蓋「已存在且剛被寫過」的檔案會偶發 EPERM
 * （防毒/索引服務還抓著舊檔），所以重試並先解鏈；
 * 真的卡死就退回 copy —— 對訓練進度來說「內容完整」比「嚴格原子」更重要。
 */
function atomicWrite(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  for (let i = 0; i < 6; i++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      sleep(25 * (i + 1));
      try { fs.unlinkSync(file); } catch { /* 不存在或仍被鎖，繼續重試 */ }
    }
  }
  fs.copyFileSync(tmp, file);
  try { fs.unlinkSync(tmp); } catch { /* 留個 .tmp 不影響正確性 */ }
}

function save(file, state) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  atomicWrite(file, JSON.stringify(state, null, 1));
  return file;
}

/**
 * @param {object} obsSpec 目前觀測規格（Observation.OBS_SPEC）
 * @throws 規格不合時拋錯，绝不「將就用」
 */
function load(file, obsSpec) {
  const raw = fs.readFileSync(file, 'utf8');
  const j = JSON.parse(raw);
  if (j.kind !== KIND) throw new Error(`checkpoint: 不是本專案的存檔（kind=${j.kind}）`);
  if (j.formatVersion !== FORMAT_VERSION)
    throw new Error(`checkpoint: 格式版本 ${j.formatVersion}，本版只認 ${FORMAT_VERSION}`);
  if (obsSpec && j.obsSpec && j.obsSpec.version !== obsSpec.version)
    throw new Error(
      `checkpoint: 觀測規格不相容（存檔 v${j.obsSpec.version}/${j.obsSpec.dim} 欄，` +
      `現行 v${obsSpec.version}/${obsSpec.dim} 欄）。觀測欄位改變會讓既有基因組全部失效，` +
      `請重新訓練，或把 observation.js 的 OBS_SPEC 還原。`);
  return j;
}

function exists(file) { return fs.existsSync(file); }

module.exports = { save, load, exists, KIND, FORMAT_VERSION };
