// modules/layout.js — 布局与弹窗堆叠的纯函数（可离线单测）
const SIDEBAR_W = 280;

// 多直播间网格：返回按打开顺序排列的矩形 [{x,y,w,h}]
// n=1 填满；n=2 左右各半；n=3 左大右二；n>=4 网格 cols=ceil(sqrt(n))
// 页面横向裁切问题由 viewer.js 的“按格子宽度自动缩放页面”解决
function computeRects(n, W, H, sidebarW = SIDEBAR_W) {
  const w = Math.max(W - sidebarW, 0);
  const h = H;
  const x0 = sidebarW;
  const rects = [];
  if (n <= 0) return rects;
  if (n === 1) {
    rects.push({ x: x0, y: 0, w, h });
  } else if (n === 2) {
    const half = w / 2;
    rects.push({ x: x0, y: 0, w: half, h });
    rects.push({ x: x0 + half, y: 0, w: half, h });
  } else if (n === 3) {
    const halfW = w / 2, halfH = h / 2;
    rects.push({ x: x0, y: 0, w: halfW, h });
    rects.push({ x: x0 + halfW, y: 0, w: halfW, h: halfH });
    rects.push({ x: x0 + halfW, y: halfH, w: halfW, h: halfH });
  } else {
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const cw = w / cols, ch = h / rows;
    for (let i = 0; i < n; i++) {
      const col = i % cols, row = Math.floor(i / cols);
      rects.push({ x: x0 + col * cw, y: row * ch, w: cw, h: ch });
    }
  }
  return rects;
}

// 右下角弹窗堆叠：返回按加入顺序（最早在最上）的位置 [{x,y}]
function computePopupPositions(count, wa, opts = {}) {
  const W = opts.width || 340;
  const H = opts.height || 104;
  const MARGIN = opts.margin != null ? opts.margin : 12;
  const GAP = opts.gap != null ? opts.gap : 10;
  const positions = [];
  for (let i = 0; i < count; i++) {
    const offset = (count - 1 - i) * (H + GAP);
    positions.push({
      x: Math.round(wa.x + wa.width - W - MARGIN),
      y: Math.round(wa.y + wa.height - H - MARGIN - offset),
    });
  }
  return positions;
}

module.exports = { computeRects, computePopupPositions, SIDEBAR_W };
