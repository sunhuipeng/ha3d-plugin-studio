/* 右上角 2D 平面预览 —— 只做一件事：把插件 plan2d 画的线显示出来
 *
 * 约定和 ha-3d-home/public/js/editor.js 完全一致：
 *   编辑器准备一个 CanvasRenderingContext2D，translate 到中心（必要时 rotate 到朝向/墙向），
 *   然后调 plan2d(c, p)，插件以原点为中心画中性线稿；开/关只体现在 p.fill。
 *
 * 这里就是那个「外层」：c 就是右上角这块 canvas 自己的 2D context，直接传进去画，
 * 画完就能看到。额外只做一次包围盒测量 —— 插件按像素量级作画（p.L / p.ppm），
 * 不同插件的符号大小差很多，量一下才知道该缩放多少、摆到哪儿，
 * 保证任何插件的符号都居中铺满这块小卡片。测量和正式绘制在同一块 canvas 上：
 *   clear(透明) → 试画一遍 → 读像素求包围盒 → clear → 铺白底 → 缩放居中正式画
 */

import { clamp } from './math';

const PAPER = '#ffffff';
const EMPTY_INK = '#c3cbd8';
const DOOR_INK = '#2a3346';
const WINDOW_INK = '#7fb3e8';

const OFF_L = 118;      // 交给门窗 plan2d 的洞口像素宽（卡片里足够细）
const OFF_PPM = 100;    // 设备没有洞口宽度，用固定 ppm（像素/米）
const MAX_SCALE = 1.7;  // 放大上限，避免小符号被吹成巨粗线条

function setup(cv) {
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 240;
  const H = cv.clientHeight || 150;
  if (!W || !H) return null;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
  }
  /* 只设 width/height 属性会把元素按像素尺寸撑开，必须同步 CSS 尺寸 */
  cv.style.width = W + 'px';
  cv.style.height = H + 'px';
  return { ctx: cv.getContext('2d'), W, H, dpr };
}

/** 读 alpha 通道求内容包围盒，换算成「以画布中心为原点」的 CSS 像素坐标 */
function alphaBounds(ctx, W, H, dpr) {
  const w = Math.round(W * dpr);
  const h = Math.round(H * dpr);
  let data;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch (e) {
    return null;   // 理论上不会：这块 canvas 里没有跨域内容
  }
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (data[row + x * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return {
    x: x0 / dpr - W / 2,
    y: y0 / dpr - H / 2,
    w: (x1 - x0 + 1) / dpr,
    h: (y1 - y0 + 1) / dpr,
  };
}

function clearAll(ctx, cv) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
}

function paper(ctx, W, H, dpr) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);
}

function hint(ctx, W, H, text, color) {
  ctx.fillStyle = color;
  ctx.font = '11px system-ui, -apple-system, "PingFang SC", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, W / 2, H / 2);
}

/**
 * 把插件 plan2d 的线稿画到右上角这块 canvas 上。
 * @param {HTMLCanvasElement} cv
 * @param {import('./plugin-preview').PluginPreview|null} pv
 * @returns {boolean} 是否画出了内容（false = 还没跑出插件）
 */
export function drawPlan(cv, pv) {
  if (!cv) return false;
  const box = setup(cv);
  if (!box) return false;
  const { ctx, W, H, dpr } = box;

  const info = pv && typeof pv.planInfo === 'function' ? pv.planInfo() : null;
  if (!info || !info.ready) return false;

  const plan = typeof pv.planSymbol === 'function' ? pv.planSymbol() : null;
  if (!plan) {
    paper(ctx, W, H, dpr);
    hint(ctx, W, H, '插件未实现 plan2d', '#c2a05a');
    return true;
  }

  /* 门/窗是 type:'door'/'window' 的贴墙设备（kind 与设备同为 'device'）：
     它们有洞口宽度（符号沿墙展开），设备是「点状物」（按 ppm 画自己的图形） */
  const isOpening = info.type === 'door' || info.type === 'window';
  const w = Math.max(0.2, Number(info.w) || 0.9);
  const L = isOpening ? OFF_L : 0;
  const ppm = isOpening ? L / w : OFF_PPM;

  /* 调色板沿用引擎：设备 ink/accent/accent2/lw 由 devicePalette 给，
     门窗 ink 按 door / window 取（和 ha-3d-home 户型图一致） */
  const pal = info.palette || {};
  const ink = isOpening
    ? (info.type === 'window' ? WINDOW_INK : DOOR_INK)
    : (pal.ink || '#6b7280');

  const p = {
    L,
    lw: pal.lw || 1.6,
    ppm,
    sel: false,
    on: !!info.on,
    hasState: info.hasState !== false,
    type: info.type || '',
    style: String(info.styleId || '').split(':').pop(),
    fill: info.on ? '#fdeecb' : '#fff',   // 开 = 暖琥珀，关 = 白（和户型图一致）
    ink,
    accent: pal.accent || '#c3cad6',
    accent2: pal.accent2 || '#9aa3b2',
    options: info.options || {},
    entityId: info.entityId,
    state: info.state,
    obj: info.obj,
    getState: info.getState,
  };

  /* 门窗 rot 是弧度（墙方向），设备 rot 是度（朝向） */
  const rot0 = info.obj ? Number(info.obj.rot) || 0 : 0;
  const rot = rot0 ? (isOpening ? rot0 : (rot0 * Math.PI) / 180) : 0;

  /* ---- 1) 透明底上试画，量包围盒 ----
     试画先缩到 k 倍：符号可能比卡片大（比如 2m 宽的门按 ppm 算出来就超宽），
     直接按 1:1 画会被画布裁掉，量出来的包围盒就不准了。
     一旦发现内容贴到画布边缘，就把 k 再减半重试（最多 3 次）。 */
  let failed = false;
  let bb = null;
  let k = 0.5;
  for (let round = 0; round < 3; round++) {
    clearAll(ctx, cv);
    ctx.setTransform(dpr * k, 0, 0, dpr * k, (dpr * W) / 2, (dpr * H) / 2);
    if (rot) ctx.rotate(rot);
    try {
      plan(ctx, p);
    } catch (e) {
      failed = true;
      break;
    }
    bb = alphaBounds(ctx, W, H, dpr);
    if (!bb) break;
    const clipped = bb.x <= -W / 2 + 1.5 || bb.y <= -H / 2 + 1.5
      || bb.x + bb.w >= W / 2 - 1.5 || bb.y + bb.h >= H / 2 - 1.5;
    if (!clipped) break;
    bb = null;
    k *= 0.5;
  }
  /* alphaBounds 给的是画布上的 CSS 坐标，除以 k 还原到「1:1 时的符号尺寸」 */
  if (bb) bb = { x: bb.x / k, y: bb.y / k, w: bb.w / k, h: bb.h / k };

  /* ---- 2) 清掉试画内容，铺白底 ---- */
  clearAll(ctx, cv);
  paper(ctx, W, H, dpr);

  if (!bb) {
    hint(ctx, W, H, failed ? 'plan2d 绘制出错' : 'plan2d 没有画东西',
      failed ? '#d94f4f' : EMPTY_INK);
    return true;
  }

  /* ---- 3) 等比缩放居中，正式画一遍（矢量，缩放后依然清晰） ---- */
  const pad = 8;
  const s = clamp(Math.min((W - pad * 2) / bb.w, (H - pad * 2) / bb.h), 0.05, MAX_SCALE);

  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(s, s);
  ctx.translate(-(bb.x + bb.w / 2), -(bb.y + bb.h / 2));
  if (rot) ctx.rotate(rot);
  try {
    plan(ctx, p);
  } catch (e) {
    /* 插件画崩了：不至于把整块预览搞挂 */
  }
  ctx.restore();
  return true;
}

/** 空态：还没跑出插件（渲染后这里就变成 plan2d 线稿） */
export function drawPlanEmpty(cv) {
  if (!cv) return;
  const box = setup(cv);
  if (!box) return;
  const { ctx, W, H, dpr } = box;
  clearAll(ctx, cv);
  paper(ctx, W, H, dpr);
  ctx.strokeStyle = '#e2e8f1';
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(10.5, 10.5, W - 21, H - 21);
  ctx.setLineDash([]);
  hint(ctx, W, H, '渲染后显示插件 plan2d 线稿', EMPTY_INK);
}
