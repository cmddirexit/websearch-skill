/**
 * browser-humanize.mjs — 浏览器拟人行为(贝塞尔轨迹 + 分步滚动)
 *
 * 从 engines/browser.mjs 拆出(2026-08 重构,browser.mjs re-export 保持公共 API):
 *   - bezierPath:三次贝塞尔路径(纯函数,可单测)—— 鼠标/滚动共用
 *   - humanize:拟人化等待/鼠标移动/分步非线性滚动,对抗 2026 AI 行为风控
 *
 * 本模块只依赖自身(纯函数),不依赖浏览器启动/渲染通道。
 */

/** 三次贝塞尔路径:从 y0 到 y1 的 n 步插值,控制点随机落在行程中段。
 * 真人鼠标非线性/带停顿,匀速直线是机器特征(对应 2026 AI 行为风控)。 */
export function bezierPath(y0, y1, n) {
  if (n <= 1) return [y1];
  const span = y1 - y0;
  // 控制点随机落在行程的 15%~50% 与 55%~85% 区间 → 曲线形状每次不同
  const c1 = y0 + span * (0.15 + Math.random() * 0.35);
  const c2 = y0 + span * (0.55 + Math.random() * 0.3);
  const pts = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const mt = 1 - t;
    pts.push(Math.round(mt * mt * mt * y0 + 3 * mt * mt * t * c1 + 3 * mt * t * t * c2 + t * t * t * y1));
  }
  return pts;
}

/**
 * 拟人化:随机抖动等待 + 鼠标贝塞尔轨迹移动 + 分步非线性滚动(带随机停顿)。
 * 对应 2026 攻防"AI 行为风控":真人鼠标非线性/带停顿,匀速直线是机器特征。
 */
export async function humanize(page, waitMs) {
  if (waitMs <= 0) return;
  const jitter = Math.floor(Math.random() * 800);
  await new Promise((r) => setTimeout(r, waitMs + jitter));
  try {
    // 1. 鼠标轨迹:从视口随机起点沿贝塞尔路径移到终点(每步 15-55ms,非匀速)
    try {
      const vp = page.viewport ? page.viewport() : page.viewportSize();
      const w = (vp && vp.width) || 1280;
      const h = (vp && vp.height) || 720;
      const sx = Math.floor(Math.random() * w * 0.6) + Math.floor(w * 0.2);
      const sy = Math.floor(Math.random() * h * 0.4) + Math.floor(h * 0.3);
      const ex = sx + Math.floor(Math.random() * 200) - 100;
      const ey = sy + Math.floor(Math.random() * 100) - 50;
      const mx = bezierPath(sx, ex, 8);
      const my = bezierPath(sy, ey, 8);
      for (let i = 0; i < mx.length; i++) {
        await page.mouse.move(mx[i], my[i], { steps: 1 });
        await new Promise((r) => setTimeout(r, 15 + Math.random() * 40));
      }
    } catch {
      /* 非页面上下文则忽略 */
    }
    // 2. 滚动:贝塞尔分步 + 随机中途停顿(真人阅读停顿)
    const total = await page.evaluate(
      () => Math.min((document.body && document.body.scrollHeight) || 600, 900),
    );
    const path = bezierPath(0, total, 6 + Math.floor(Math.random() * 4));
    await page.evaluate((pts) => {
      return new Promise((resolve) => {
        let i = 0;
        const step = () => {
          if (i >= pts.length) return resolve();
          window.scrollTo(0, pts[i++]);
          const delay = 30 + Math.random() * 70;
          // 25% 概率中途停顿 300-800ms(模拟阅读)
          if (Math.random() < 0.25) setTimeout(step, delay + 300 + Math.random() * 500);
          else setTimeout(step, delay);
        };
        step();
      });
    }, path);
  } catch {
    /* 非页面上下文则忽略 */
  }
}
