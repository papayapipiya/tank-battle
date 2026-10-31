/* ═══════════════════════════════════════════
   audio.js — WebAudio 合成音效（無音檔）
   ═══════════════════════════════════════════ */

const Audio = (() => {
  let ctx = null;
  let muted = false;

  function ac() {
    if (!ctx) {
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { return null; }
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, dur, type = 'square', vol = 0.05, delay = 0) {
    if (muted) return;
    const a = ac(); if (!a) return;
    try {
      const t0 = a.currentTime + delay;
      const osc = a.createOscillator();
      const g = a.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      osc.connect(g); g.connect(a.destination);
      osc.start(t0); osc.stop(t0 + dur);
    } catch (e) { /* audio 錯誤不影響遊戲 */ }
  }

  function noise(dur, vol = 0.08, lowpassFrom = 0, lowpassTo = 0) {
    if (muted) return;
    const a = ac(); if (!a) return;
    try {
      const n = Math.floor(a.sampleRate * dur);
      const buf = a.createBuffer(1, n, a.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
      const src = a.createBufferSource(); src.buffer = buf;
      const g = a.createGain();
      g.gain.setValueAtTime(vol, a.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + dur);
      if (lowpassFrom > 0) {
        const f = a.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.setValueAtTime(lowpassFrom, a.currentTime);
        f.frequency.exponentialRampToValueAtTime(lowpassTo, a.currentTime + dur);
        src.connect(f); f.connect(g);
      } else {
        src.connect(g);
      }
      g.connect(a.destination);
      src.start();
    } catch (e) { /* ignore */ }
  }

  const sfx = {
    shoot:      () => tone(880, 0.05, 'square', 0.035),
    hitWall:    () => tone(180, 0.05, 'sawtooth', 0.03),
    hitSteel:   () => tone(1200, 0.04, 'triangle', 0.04),
    explode:    () => noise(0.25, 0.08),
    bigExplode: () => noise(0.5, 0.1, 500, 60),
    powerupAppear: () => tone(1320, 0.12, 'sine', 0.05),
    powerup:    () => { tone(660, 0.06, 'square', 0.04); tone(990, 0.06, 'square', 0.04, 0.06); tone(1320, 0.09, 'square', 0.04, 0.12); },
    extraLife:  () => [800, 1000, 1200, 1600].forEach((f, i) => tone(f, 0.08, 'square', 0.04, i * 0.07)),
    stageClear: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.14, 'square', 0.05, i * 0.12)),
    gameOver:   () => { tone(392, 0.25, 'square', 0.05); tone(311, 0.25, 'square', 0.05, 0.25); tone(262, 0.5, 'square', 0.05, 0.5); },
    pause:      () => tone(440, 0.08, 'sine', 0.05),
    freeze:     () => tone(1760, 0.2, 'sine', 0.04),
    shovel:     () => noise(0.15, 0.05, 800, 200),
  };

  function play(name) { if (sfx[name]) sfx[name](); }
  function toggleMute() { muted = !muted; return muted; }
  function isMuted() { return muted; }

  return { play, toggleMute, isMuted };
})();
