/* ai/actions.js — 動作空間定義
   ═══════════════════════════════════════════
   5 類離散動作。選「離散」而不是「5 維 sigmoid」的理由：
   坦克是 grid-locked 移動，轉向時垂直軸會吸附到格線，
   連續輸出很容易學出「同幀同時按兩個方向 → 反覆吸附 → 抖動」的車。

   ⚠ 本體包在 IIFE 裡：瀏覽器用 <script src> 載入時，幾個檔案共用同一個
     全域詞彙作用域，兩檔各宣告一次 `const ACTIONS` 就是 SyntaxError，
     而且會順手把遊戲主迴圈打斷（real bug，被觀戰頁驗證出來）。
     Node 端走 module.exports，瀏覽器端掛到 window，同一份實作兩個出口。
   ═══════════════════════════════════════════ */
(function (root) {
'use strict';

const ACTIONS = Object.freeze({
  UP: 0, RIGHT: 1, DOWN: 2, LEFT: 3, FIRE: 4,
});

const ACTION_NAMES = Object.freeze(['上', '右', '下', '左', '射擊']);
const ACTION_COUNT = 5;

const AIActions = { ACTIONS, ACTION_NAMES, ACTION_COUNT };

if (typeof module !== 'undefined' && module.exports) module.exports = AIActions;
else root.AIActions = AIActions;
})(typeof window !== 'undefined' ? window : globalThis);
