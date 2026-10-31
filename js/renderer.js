/* ═══════════════════════════════════════════
   renderer.js — Canvas 渲染 + DOM HUD
   邏輯座標（208×208）→ ctx.scale(SCALE) 放大顯示。
   貼圖原生尺寸為 邏輯 × SPRITE_SS，故縮到 s.width/SPRITE_SS 繪製；
   位置先對齊裝置像素格，避免 2× 細節被重採樣變糊。
   ═══════════════════════════════════════════ */

const Renderer = (() => {
  let canvas, ctx;
  let explosions = [];   // { x, y, timer, big }
  let popups = [];       // { x, y, text, timer }

  function init(canvasEl) {
    canvas = canvasEl;
    canvas.width = FIELD_PX * SCALE;
    canvas.height = FIELD_PX * SCALE;
    ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
  }

  function clearFx() { explosions = []; popups = []; }

  function spawnExplosion(x, y, big = false) {
    explosions.push({ x, y, timer: big ? 30 : 18, big });
  }
  function spawnPopup(x, y, text) {
    popups.push({ x, y, text, timer: 45 });
  }

  function clear() {
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, FIELD_PX, FIELD_PX);
  }

  function drawSprite(name, x, y) {
    const s = Sprites.get(name);
    if (!s) return;
    // 原生尺寸是 邏輯 × SPRITE_SS，縮回邏輯尺寸繪製
    const w = s.width / SPRITE_SS, h = s.height / SPRITE_SS;
    // 位置對齊裝置像素格（1/SCALE 邏輯步進），避免重採樣糊掉 2× 細節
    const dx = Math.round(x * SCALE) / SCALE;
    const dy = Math.round(y * SCALE) / SCALE;
    ctx.drawImage(s, dx, dy, w, h);
  }

  /** 可旋轉版本（觀戰模式頂部基地倒置 180°） */
  function drawSpriteRot(name, x, y, rot) {
    const s = Sprites.get(name);
    if (!s) return;
    if (!rot) { drawSprite(name, x, y); return; }
    const w = s.width / SPRITE_SS, h = s.height / SPRITE_SS;
    ctx.save();
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate(rot);
    ctx.drawImage(s, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  // ── 地形（森林除外，最後蓋上）──
  function drawMap(map, frame) {
    const waterFrame = (frame >> 4) % 2;
    for (let cy = 0; cy < GRID; cy++) {
      for (let cx = 0; cx < GRID; cx++) {
        const v = map.cells[cy][cx];
        const x = cx * CELL, y = cy * CELL;
        switch (v) {
          case CELL_TYPE.BRICK: drawSprite('brick', x, y); break;
          case CELL_TYPE.STEEL: drawSprite('steel', x, y); break;
          case CELL_TYPE.WATER: drawSprite(`water${waterFrame}`, x, y); break;
          case CELL_TYPE.ICE:   drawSprite('ice', x, y); break;
          // FOREST / BASE / EMPTY 不在此畫
        }
      }
    }
    // 老鷹（每座 2×2 cells；觀戰模式有上下兩座）
    for (const base of map.bases) {
      drawSpriteRot(base.dead ? 'base_dead' : 'base',
        base.cx * CELL, base.cy * CELL, base.rot);
    }
  }

  function drawForestOverlay(map) {
    for (let cy = 0; cy < GRID; cy++)
      for (let cx = 0; cx < GRID; cx++)
        if (map.cells[cy][cx] === CELL_TYPE.FOREST)
          drawSprite('forest', cx * CELL, cy * CELL);
  }

  // ── 坦克 ──
  function tankRole(tank) {
    if (tank.isPlayer) return `p${tank.firepower}`;
    switch (tank.enemyType) {
      case ENEMY_TYPE.FAST:  return 'fast';
      case ENEMY_TYPE.POWER: return 'power';
      case ENEMY_TYPE.ARMOR: return `armor${Math.max(1, tank.hp)}`;
      default:               return 'basic';
    }
  }

  function drawTank(tank, frozen) {
    if (!tank.alive) return;

    // 出生星芒動畫（無敵期）
    if (tank.spawnTimer > 0) {
      const f = 3 - (Math.floor(tank.spawnTimer / 8) % 4);
      drawSprite(`spawn${f}`, tank.x, tank.y);
      return;
    }

    const tread = tank.moving ? (Math.floor(tank.x + tank.y) >> 2) % 2 : 0;
    drawSprite(`tank_${tankRole(tank)}_${tank.dir}_${tread}`, tank.x, tank.y);

    // 閃紅敵人（掉道具）：紅色覆蓋閃爍
    if (tank.flashing && (tank.flashFrame >> 2) % 2 === 0) {
      ctx.fillStyle = 'rgba(255,40,40,0.55)';
      ctx.fillRect(tank.x, tank.y, TANK_PX, TANK_PX);
    }
    // 凍結：藍色覆蓋
    if (frozen) {
      ctx.fillStyle = 'rgba(120,180,255,0.4)';
      ctx.fillRect(tank.x, tank.y, TANK_PX, TANK_PX);
    }
    // 護盾
    if (tank.shieldTimer > 0) {
      drawSprite(`shield${(tank.shieldTimer >> 2) % 2}`, tank.x, tank.y);
    }
  }

  function drawBullet(b) {
    drawSprite('bullet', b.x - 2, b.y - 2);
  }

  function drawPowerUp(p) {
    if (!p.visible) return;
    drawSprite(`powerup_${p.type}`, p.x, p.y);
  }

  // ── 特效 ──
  function drawFx() {
    for (const e of explosions) {
      const name = e.big
        ? `boomBig${e.timer > 15 ? 0 : 1}`
        : `boom${Math.min(2, Math.floor((18 - e.timer) / 6))}`;
      const size = e.big ? 32 : 16;
      drawSprite(name, e.x - size / 2, e.y - size / 2);
    }
    ctx.textAlign = 'center';
    ctx.font = 'bold 8px "Courier New", monospace';
    for (const p of popups) {
      ctx.fillStyle = '#f8e058';
      ctx.fillText(p.text, p.x, p.y - (45 - p.timer) * 0.3);
    }
  }

  function tickFx() {
    for (const e of explosions) e.timer--;
    explosions = explosions.filter(e => e.timer > 0);
    for (const p of popups) p.timer--;
    popups = popups.filter(p => p.timer > 0);
  }

  // ── 全螢幕覆蓋層 ──
  function overlay(lines, opts = {}) {
    ctx.fillStyle = `rgba(0,0,0,${opts.dim ?? 0.65})`;
    ctx.fillRect(0, 0, FIELD_PX, FIELD_PX);
    ctx.textAlign = 'center';
    let y = FIELD_PX / 2 - (lines.length - 1) * 12 + (opts.dy || 0);
    for (const line of lines) {
      ctx.fillStyle = line.color || '#fff';
      ctx.font = `${line.bold ? 'bold ' : ''}${line.size || 10}px "Courier New", monospace`;
      ctx.fillText(line.text, FIELD_PX / 2, y);
      y += line.gap ?? 16;
    }
  }

  return {
    init, clear, clearFx,
    drawMap, drawForestOverlay, drawTank, drawBullet, drawPowerUp,
    drawFx, tickFx, overlay,
    spawnExplosion, spawnPopup,
  };
})();

/* ═══════════════════════════════════════════
   UI — DOM 面板（分數/生命/關卡/敵軍圖示/火力）
   ═══════════════════════════════════════════ */
const UI = (() => {
  let el = {};
  let last = { lives: -1, icons: -1, power: -1 };

  function init() {
    el = {
      stage:  document.getElementById('stageDisplay'),
      icons:  document.getElementById('enemyIcons'),
      lives:  document.getElementById('livesDisplay'),
      score:  document.getElementById('scoreDisplay'),
      hi:     document.getElementById('hiScoreDisplay'),
      power:  document.getElementById('powerDisplay'),
    };
    last = { lives: -1, icons: -1, power: -1 };
  }

  function update(game) {
    if (el.stage) el.stage.textContent = game.stage;
    if (el.score) el.score.textContent = game.score;
    if (el.hi)    el.hi.textContent = game.hiScore;

    if (el.icons && game.iconsLeft !== last.icons) {
      last.icons = game.iconsLeft;
      let html = '';
      for (let i = 0; i < game.iconsLeft; i++) html += '<span class="enemy-icon"></span>';
      el.icons.innerHTML = html;
    }

    if (el.lives && game.lives !== last.lives) {
      last.lives = game.lives;
      let html = '';
      for (let i = 0; i < Math.max(0, Math.min(game.lives, 9)); i++)
        html += '<span class="life-icon"></span>';
      el.lives.innerHTML = html;
    }

    const fp = game.player ? game.player.firepower : 1;
    if (el.power && fp !== last.power) {
      last.power = fp;
      el.power.textContent = '★'.repeat(fp);
      el.power.style.color = fp >= 4 ? '#80d848' : '#f8d840';
    }
  }

  return { init, update };
})();
