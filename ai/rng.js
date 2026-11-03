/* ai/rng.js — 可種子化 RNG（mulberry32）
   訓練時每個對局用固定種子，讓「同一基因組 + 同一種子」可重現，
   不同對局之間換種子，避免把種子當棋力。                        */
'use strict';

/** 依種子回傳 [0,1) 的隨機函數 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 把 (a, b) 混成一個 32 位整數種子 */
function hashSeed(...nums) {
  let h = 2166136261 >>> 0;
  for (const n of nums) {
    h = Math.imul(h ^ (Math.trunc(n) & 0xffff), 16777619) >>> 0;
    h = Math.imul(h ^ (Math.trunc(n) / 65536 | 0), 16777619) >>> 0;
  }
  return h >>> 0;
}

module.exports = { mulberry32, hashSeed };
