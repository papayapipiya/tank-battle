/* ═══════════════════════════════════════════
   input.js — 鍵盤輸入（held / one-shot pressed）
   ═══════════════════════════════════════════ */

const Input = (() => {
  const held = {};
  const pressed = {};   // one-shot, cleared each frame
  const queue = [];

  const GAME_KEYS = new Set([
    'w', 'a', 's', 'd', 'j', ' ', 'p', 'r', 'm', 'enter',
    'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
  ]);

  function onKeyDown(e) {
    const k = e.key.toLowerCase();
    if (!held[k]) queue.push(k);
    held[k] = true;
    if (GAME_KEYS.has(k)) e.preventDefault();
  }

  function onKeyUp(e) {
    held[e.key.toLowerCase()] = false;
  }

  function onBlur() {           // 視窗失焦 → 放掉所有鍵，避免卡住
    for (const k of Object.keys(held)) held[k] = false;
    queue.length = 0;
  }

  function init() {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
  }

  /** 每個邏輯幀開頭呼叫：把佇列按鍵轉成 one-shot */
  function update() {
    for (const k of Object.keys(pressed)) pressed[k] = false;
    while (queue.length) pressed[queue.shift()] = true;
  }

  const isDown    = (k) => !!held[k.toLowerCase()];
  const wasPressed = (k) => !!pressed[k.toLowerCase()];

  return { init, update, isDown, wasPressed };
})();
