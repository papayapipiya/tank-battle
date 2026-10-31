/* ═══════════════════════════════════════════
   sprites.js — 開機時程序化生成所有貼圖（無圖檔）
   每張 sprite 是獨立小 canvas，以 SPRITE_SS=2 的细节解析度繪製：
     地形 cell 8→16、坦克/道具/特效 16→32、大爆炸 32→64。
   渲染時 Renderer 縮回 邏輯尺寸 繪製，1 美術像素 = 1 裝置像素。
   本檔內座標一律為「美術像素」（= 邏輯像素 × 2）。
   ═══════════════════════════════════════════ */

const Sprites = (() => {
  const bank = new Map();

  function make(w, h, drawFn) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    drawFn(g);
    return c;
  }

  function px(g, x, y, w, h, color) {
    g.fillStyle = color;
    g.fillRect(x, y, w, h);
  }

  // 實心圓（整數格心判定，保持硬邊像素感）
  function disc(g, cx, cy, r, color) {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r * r) px(g, x, y, 1, 1, color);
      }
    }
  }

  // 圓環：rInner < 距離 <= rOuter
  function ring(g, cx, cy, rOuter, rInner, color) {
    for (let y = Math.floor(cy - rOuter); y <= Math.ceil(cy + rOuter); y++) {
      for (let x = Math.floor(cx - rOuter); x <= Math.ceil(cx + rOuter); x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 <= rOuter * rOuter && d2 > rInner * rInner) px(g, x, y, 1, 1, color);
      }
    }
  }

  // 簡易顏色增減亮度
  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.max(0, Math.min(255, (n >> 16) + amt));
    const gg = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt));
    const b = Math.max(0, Math.min(255, (n & 255) + amt));
    return `rgb(${r},${gg},${b})`;
  }

  // 左右對稱繪製：fn 只畫左半，右半鏡像補上
  function mirrored(g, w, fn) {
    g.save(); fn(g); g.restore();
    g.save(); g.translate(w, 0); g.scale(-1, 1); fn(g); g.restore();
  }

  // ── 32×32 坦克（朝上繪製，再旋轉出 4 向 × 2 履帶幀）──
  function drawTankUp(g, body, accent, frame) {
    const tread = '#242424', treadMid = '#3a3a3a', treadLite = '#5c5c5c', treadDark = '#101010';

    // 履帶（左右兩條，x 0-5 / 26-31）
    for (const tx of [0, 26]) {
      px(g, tx, 2, 6, 28, tread);
      px(g, tx, 2, 1, 28, treadLite);          // 外緣高光
      px(g, tx + 5, 2, 1, 28, treadDark);      // 內緣陰影
      for (let i = 0; i < 7; i++) {            // 履帶節，兩幀交錯滾動
        const y = 2 + i * 4 + frame * 2;
        if (y + 2 <= 30) {
          px(g, tx + 1, y, 4, 2, treadMid);
          px(g, tx + 1, y, 4, 1, treadLite);
        }
      }
    }

    // 車身（x 6-25）：底色 + 四邊斜角
    px(g, 6, 6, 20, 20, body);
    px(g, 6, 6, 20, 2, shade(body, 30));       // 上緣高光
    px(g, 6, 24, 20, 2, shade(body, -30));     // 下緣陰影
    px(g, 6, 8, 2, 16, shade(body, 14));       // 左側
    px(g, 24, 8, 2, 16, shade(body, -14));     // 右側
    px(g, 8, 12, 16, 1, shade(body, -44));     // 裝甲接縫
    px(g, 8, 20, 16, 1, shade(body, -44));
    px(g, 9, 22, 3, 2, shade(body, 24));       // 尾排氣口
    px(g, 20, 22, 3, 2, shade(body, 24));

    // 砲塔
    disc(g, 16, 16, 6, shade(body, -22));
    disc(g, 16, 15, 5, shade(body, 6));
    px(g, 13, 12, 3, 2, shade(body, 46));      // 砲塔高光
    ring(g, 16, 15, 5, 4, shade(body, -34));   // 砲塔縫

    // 砲管（朝上）+ 砲口套筒
    px(g, 14, 0, 4, 15, accent);
    px(g, 14, 0, 1, 15, shade(accent, -46));
    px(g, 17, 0, 1, 15, shade(accent, 34));
    px(g, 13, 3, 6, 3, shade(accent, -16));
    px(g, 13, 3, 6, 1, shade(accent, 40));
  }

  function rotated(src, dir) {
    if (dir === DIR.UP) return src;
    return make(32, 32, (g) => {
      g.translate(16, 16);
      g.rotate([0, Math.PI / 2, Math.PI, -Math.PI / 2][dir]);
      g.drawImage(src, -16, -16);
    });
  }

  function buildTanks() {
    const roles = {
      // 玩家火力 1-4（黃→金→綠金→亮綠）
      p1: ['#d8b84c', '#f0e0a0'], p2: ['#e0c040', '#f8f0b0'],
      p3: ['#c8d040', '#f0f8a0'], p4: ['#80d848', '#d0f8a0'],
      // 敵人
      basic: [ENEMY_STATS[ENEMY_TYPE.BASIC].body, '#f0e0c0'],
      fast:  [ENEMY_STATS[ENEMY_TYPE.FAST].body, '#d0e8f8'],
      power: [ENEMY_STATS[ENEMY_TYPE.POWER].body, '#f8d0f0'],
      armor4: [ARMOR_HP_COLORS[3], '#e0f0e0'],
      armor3: [ARMOR_HP_COLORS[2], '#f8f0c0'],
      armor2: [ARMOR_HP_COLORS[1], '#f8d0a0'],
      armor1: [ARMOR_HP_COLORS[0], '#e0e0e0'],
    };
    for (const [role, [body, accent]] of Object.entries(roles)) {
      for (let frame = 0; frame < 2; frame++) {
        const up = make(32, 32, (g) => drawTankUp(g, body, accent, frame));
        for (let dir = 0; dir < 4; dir++) {
          bank.set(`tank_${role}_${dir}_${frame}`, rotated(up, dir));
        }
      }
    }
  }

  // ── 16×16 地形 cell ──
  function buildTiles() {
    // 磚牆：兩排錯縫，每塊 8×7 美術像素 + 灰漿與單塊明暗
    bank.set('brick', make(16, 16, (g) => {
      px(g, 0, 0, 16, 16, '#581808');                       // 灰漿底
      const rows = [[1, 0], [9, 4]];                        // [起 y, x 向錯位]
      for (const [y, off] of rows) {
        for (let bx = -1; bx < 3; bx++) {
          const x = bx * 8 + off;
          const x0 = Math.max(0, x), x1 = Math.min(16, x + 7);
          if (x1 <= x0) continue;
          const w = x1 - x0;
          px(g, x0, y, w, 7, '#a8482f');
          px(g, x0, y, w, 1, '#c86050');                    // 頂光
          px(g, x0, y + 6, w, 1, '#7c2c1c');                // 底陰影
          px(g, x1 - 1, y, 1, 7, '#8c3424');                // 右緣
        }
      }
    }));

    // 鋼牆：倒角金屬板 + 四角鉚釘
    bank.set('steel', make(16, 16, (g) => {
      px(g, 0, 0, 16, 16, '#686868');
      px(g, 1, 1, 14, 14, '#b0b0b0');
      px(g, 1, 1, 14, 2, '#e8e8e8');                        // 上高光
      px(g, 1, 1, 2, 14, '#d8d8d8');                        // 左高光
      px(g, 2, 13, 13, 2, '#787878');                       // 下陰影
      px(g, 13, 2, 2, 12, '#8c8c8c');                       // 右陰影
      for (const [rx, ry] of [[3, 3], [11, 3], [3, 11], [11, 11]]) {
        px(g, rx, ry, 2, 2, '#e0e0e0');
        px(g, rx, ry + 1, 2, 1, '#808080');
      }
      px(g, 6, 6, 4, 4, '#9a9a9a');                         // 中央壓印
      px(g, 6, 6, 4, 1, '#d0d0d0');
    }));

    // 水面：兩幀波浪位移
    for (let f = 0; f < 2; f++) {
      bank.set(`water${f}`, make(16, 16, (g) => {
        px(g, 0, 0, 16, 16, '#1c38b8');
        px(g, 0, 0, 16, 3, '#2444cc');                      // 上層亮帶
        px(g, 0, 13, 16, 3, '#1428a0');                     // 下層暗帶
        const o = f * 4;
        for (let i = 0; i < 2; i++) {
          const y = 4 + i * 6;
          const x = (i * 8 + o) % 16;
          px(g, x, y, 5, 1, '#5080f0');
          px(g, x, y, 3, 1, '#9ec4ff');                     // 泡沫高光
          px(g, (x + 8) % 16, y + 1, 3, 1, '#3860d8');
        }
      }));
    }

    // 樹叢：多層團簇，坦克藏在下面仍可辨
    bank.set('forest', make(16, 16, (g) => {
      px(g, 0, 0, 16, 16, '#0a280a');
      for (const [cx, cy, r, c] of [
        [4, 4, 4, '#1c5a1c'], [11, 3, 4, '#1c5a1c'],
        [8, 8, 5, '#227022'], [3, 12, 4, '#1c5a1c'], [12, 12, 4, '#1c5a1c'],
      ]) disc(g, cx, cy, r, c);
      for (const [x, y] of [[3, 2], [10, 2], [7, 6], [2, 10], [11, 10]]) {
        px(g, x, y, 2, 1, '#3a9a3a');                       // 受光葉片
        px(g, x + 1, y + 1, 2, 1, '#2a7a2a');
      }
    }));

    // 冰面：漸層 + 鏡面條紋 + 細裂紋
    bank.set('ice', make(16, 16, (g) => {
      px(g, 0, 0, 16, 16, '#c8dcf0');
      px(g, 0, 0, 16, 4, '#e2eefb');
      px(g, 0, 12, 16, 4, '#a8c4e0');
      px(g, 2, 3, 10, 1, '#ffffff');
      px(g, 5, 7, 8, 1, '#ffffff');
      px(g, 1, 10, 6, 1, '#f0f8ff');
      for (const [x, y] of [[12, 4], [3, 6], [9, 12], [13, 9]]) px(g, x, y, 1, 1, '#8fb0d0');
      px(g, 11, 5, 1, 4, '#9cbad8');
      px(g, 12, 8, 3, 1, '#9cbad8');
    }));
  }

  // ── 老鷹基地 32×32 ──
  function buildBase() {
    const gold = '#e8c840', lite = '#f8e888', dark = '#a08020', dk = '#6c5414';
    bank.set('base', make(32, 32, (g) => {
      px(g, 0, 0, 32, 32, '#000000');
      // 展翅（左半繪製後鏡像）
      mirrored(g, 32, (c) => {
        px(c, 2, 10, 11, 2, gold);
        px(c, 1, 12, 12, 3, gold);
        px(c, 0, 15, 13, 2, gold);
        px(c, 1, 17, 12, 2, dark);
        px(c, 3, 19, 10, 2, dark);
        for (let x = 2; x < 13; x += 3) px(c, x, 12, 1, 5, lite);   // 羽軸
        for (let x = 1; x < 12; x += 3) px(c, x, 15, 1, 3, dk);     // 羽縫
      });
      // 頭與喙
      disc(g, 16, 7, 3, gold);
      px(g, 14, 5, 2, 2, lite);
      px(g, 15, 9, 2, 2, '#f8a040');
      px(g, 14, 6, 1, 1, '#000');
      px(g, 17, 6, 1, 1, '#000');
      // 身軀
      px(g, 13, 10, 6, 10, dark);
      px(g, 14, 10, 4, 9, gold);
      px(g, 15, 12, 2, 5, lite);
      // 尾羽
      mirrored(g, 32, (c) => {
        px(c, 13, 20, 3, 4, gold);
        px(c, 11, 24, 5, 2, dark);
      });
      // 底座
      px(g, 6, 27, 20, 3, '#808080');
      px(g, 6, 27, 20, 1, '#c8c8c8');
      px(g, 8, 30, 16, 2, '#585858');
    }));

    bank.set('base_dead', make(32, 32, (g) => {
      const gray = '#585858', dk2 = '#383838', lite2 = '#787878';
      px(g, 0, 0, 32, 32, '#000000');
      mirrored(g, 32, (c) => {
        px(c, 2, 13, 11, 2, gray);
        px(c, 1, 15, 12, 3, dk2);
        px(c, 3, 18, 10, 2, gray);
        for (let x = 2; x < 13; x += 3) px(c, x, 15, 1, 4, lite2);
      });
      disc(g, 16, 11, 3, gray);
      px(g, 13, 15, 6, 9, dk2);
      px(g, 14, 16, 4, 7, gray);
      // 斷裂痕
      for (const [x, y] of [[9, 8], [22, 10], [16, 5], [6, 20], [25, 22]]) {
        px(g, x, y, 2, 2, lite2);
        px(g, x + 1, y + 2, 1, 1, gray);
      }
      px(g, 6, 27, 20, 3, '#4a4a4a');
      px(g, 8, 30, 16, 2, '#2e2e2e');
    }));
  }

  // ── 子彈 / 護盾 / 出生動畫 / 爆炸 ──
  function buildFx() {
    bank.set('bullet', make(8, 8, (g) => {
      disc(g, 4, 4, 3.4, '#f8f8f8');
      disc(g, 4, 4, 2.2, '#f8e080');
      px(g, 3, 3, 2, 2, '#ffffff');
      px(g, 2, 2, 1, 1, '#fff8d0');
    }));

    for (let f = 0; f < 2; f++) {
      bank.set(`shield${f}`, make(32, 32, (g) => {
        const c1 = '#58c8f8', c2 = '#f8f858';
        const c = f === 0 ? c1 : c2;
        const dim = shade(f === 0 ? '#58c8f8' : '#f8f858', -60);
        // 環狀交錯虛線（2 幀互錯半格）
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * Math.PI * 2 + (f ? Math.PI / 16 : 0);
          const x = Math.round(15.5 + Math.cos(a) * 14.5) - 1;
          const y = Math.round(15.5 + Math.sin(a) * 14.5) - 1;
          px(g, x, y, 4, 4, c);
          px(g, x, y, 4, 1, shade(f === 0 ? '#58c8f8' : '#f8f858', 40));
          px(g, x, y + 3, 4, 1, dim);
        }
      }));
    }

    for (let f = 0; f < 4; f++) {
      bank.set(`spawn${f}`, make(32, 32, (g) => {
        const c = ['#f8f8f8', '#f8e058', '#58c8f8', '#f85858'][f];
        const s = (4 + f * 2) * 2;
        const cx = 16, cy = 16;
        // 四角星（細長輻射臂）
        px(g, cx - 2, cy - s, 4, s * 2, c);
        px(g, cx - s, cy - 2, s * 2, 4, c);
        // 斜向短輻射
        for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          for (let k = 2; k < s - 2; k += 3) px(g, cx + dx * k, cy + dy * k, 3, 3, c);
        }
        disc(g, cx, cy, 4, c);
        disc(g, cx, cy, 2, '#ffffff');
      }));
    }

    // 小爆炸（坦克/磚）
    for (let f = 0; f < 3; f++) {
      bank.set(`boom${f}`, make(32, 32, (g) => {
        const hot = ['#f8f8a0', '#f8a040', '#f86030'][f];
        const core = ['#ffffff', '#f8f8a0', '#f8a040'][f];
        const r = (3 + f * 3) * 2;
        disc(g, 16, 16, r, hot);
        disc(g, 16, 16, r * 0.55, core);
        // 向外飛散的碎塊
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2 + f * 0.4;
          const d = r + 2 + (i % 2) * 3;
          px(g, Math.round(16 + Math.cos(a) * d) - 1, Math.round(16 + Math.sin(a) * d) - 1,
             3, 3, hot);
        }
      }));
    }

    // 大爆炸（基地/玩家）
    for (let f = 0; f < 2; f++) {
      bank.set(`boomBig${f}`, make(64, 64, (g) => {
        const outer = f === 0 ? '#f8a040' : '#f87020';
        const mid = f === 0 ? '#f8f8a0' : '#f8a040';
        const r = (8 + f * 5) * 2;
        disc(g, 32, 32, r + 6, outer);
        disc(g, 32, 32, r, mid);
        disc(g, 32, 32, r * 0.5, '#fff8d0');
        // 環狀火舌
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2 + f * 0.3;
          const d = r + 8 + (i % 3) * 4;
          disc(g, 32 + Math.cos(a) * d, 32 + Math.sin(a) * d, 4 - (i % 2), outer);
        }
        // 飛散碎片
        for (const [dx, dy] of [[-22, -18], [20, -22], [24, 16], [-18, 22], [4, -26], [-26, 2]]) {
          px(g, 32 + dx, 32 + dy, 3, 3, mid);
        }
      }));
    }
  }

  // ── 道具 32×32 ──
  function buildPowerups() {
    const defs = {
      [POWERUP_TYPE.STAR]: (g) => {   // 黃星
        px(g, 14, 4, 4, 24, '#f8d840');
        px(g, 4, 14, 24, 4, '#f8d840');
        px(g, 10, 10, 12, 12, '#f8d840');
        for (const [x, y] of [[8, 8], [20, 8], [8, 20], [20, 20]]) px(g, x, y, 4, 4, '#f8d840');
        px(g, 15, 5, 2, 22, '#f8e888');                   // 豎向高光
        px(g, 5, 15, 22, 2, '#f8e888');
        px(g, 14, 13, 4, 4, '#fff8c0');
        px(g, 12, 20, 8, 2, '#c8a820');                   // 底部陰影
      },
      [POWERUP_TYPE.BOMB]: (g) => {   // 炸彈
        disc(g, 15, 19, 9, '#282828');
        disc(g, 13, 16, 6, '#484848');                    // 球面受光
        px(g, 11, 13, 3, 2, '#808080');
        px(g, 18, 8, 4, 8, '#885830');                    // 引信
        px(g, 18, 8, 1, 8, '#a8703f');
        disc(g, 21, 6, 3, '#f8c040');                     // 火花
        px(g, 20, 5, 2, 2, '#fff8d0');
        px(g, 24, 3, 2, 2, '#f87020');
      },
      [POWERUP_TYPE.CLOCK]: (g) => {  // 時鐘
        disc(g, 16, 16, 10, '#f0f0f0');
        disc(g, 16, 16, 8, '#203040');
        px(g, 15, 8, 2, 3, '#f0f0f0');                    // 上錶冠
        px(g, 15, 10, 2, 6, '#f0f0f0');                   // 分針
        px(g, 16, 15, 5, 2, '#f0f0f0');                   // 時針
        disc(g, 16, 16, 1, '#f8d840');
        for (let i = 0; i < 12; i++) {                    // 刻度
          const a = (i / 12) * Math.PI * 2;
          px(g, Math.round(16 + Math.cos(a) * 7) , Math.round(16 + Math.sin(a) * 7), 1, 1,
             i % 3 === 0 ? '#f8f8f8' : '#8098b0');
        }
      },
      [POWERUP_TYPE.SHOVEL]: (g) => { // 鏟子
        px(g, 18, 4, 4, 16, '#a07840');                   // 柄
        px(g, 18, 4, 1, 16, '#c09860');
        px(g, 17, 3, 6, 3, '#806030');                    // 握把
        px(g, 10, 18, 12, 10, '#c0c0c0');                 // 鏟面
        px(g, 11, 19, 10, 2, '#e8e8e8');
        px(g, 12, 26, 8, 2, '#909090');
        px(g, 10, 28, 12, 1, '#686868');
        for (let x = 11; x < 21; x += 3) px(g, x, 24, 1, 4, '#a0a0a0');   // 鏽痕
      },
      [POWERUP_TYPE.SHIELD]: (g) => { // 頭盔/盾
        px(g, 6, 8, 20, 12, '#58c8f8');
        px(g, 8, 6, 16, 3, '#a8e0f8');
        px(g, 8, 20, 16, 4, '#58c8f8');
        px(g, 6, 24, 20, 2, '#2888b8');
        px(g, 8, 9, 16, 2, '#a8e0f8');                    // 帶子
        px(g, 10, 12, 4, 6, '#8fdcf8');                   // 鏡面高光
        px(g, 12, 24, 8, 1, '#1c6c90');
      },
      [POWERUP_TYPE.TANK]: (g) => {   // 小坦克（+1 命）
        px(g, 6, 12, 20, 10, '#80d848');                  // 車身
        px(g, 6, 12, 20, 2, '#a8f070');
        px(g, 6, 20, 20, 2, '#58a830');
        px(g, 12, 8, 8, 6, '#80d848');                    // 砲塔
        px(g, 13, 9, 4, 2, '#b8f888');
        px(g, 15, 3, 2, 7, '#d0f8a0');                    // 砲管
        for (const tx of [5, 25]) px(g, tx, 14, 2, 8, '#2a2a2a');         // 履帶邊
        for (let i = 0; i < 4; i++) {
          px(g, 6, 14 + i * 2, 20, 1, '#2a2a2a');
        }
        px(g, 8, 22, 5, 3, '#2a2a2a');
        px(g, 19, 22, 5, 3, '#2a2a2a');
      },
    };
    for (const [type, drawIcon] of Object.entries(defs)) {
      bank.set(`powerup_${type}`, make(32, 32, (g) => {
        px(g, 0, 0, 32, 32, '#e8e8e8');                   // 白框
        px(g, 1, 1, 30, 2, '#ffffff');                    // 框內高光
        px(g, 1, 29, 30, 2, '#a0a0a0');                   // 框下陰影
        px(g, 2, 2, 28, 28, '#282828');
        px(g, 3, 3, 26, 1, '#3c3c3c');
        drawIcon(g);
      }));
    }
  }

  function build() {
    buildTiles();
    buildTanks();
    buildBase();
    buildFx();
    buildPowerups();
  }

  const get = (name) => bank.get(name);

  return { build, get };
})();
