/**
 * browser-stealth.mjs — 浏览器 stealth 指纹伪装(纯静态资源)
 *
 * 从 engines/browser.mjs 拆出(2026-08 重构,browser.mjs re-export 保持公共 API):
 * STEALTH_INIT_SCRIPT 是注入页面上下文的脚本字符串,与浏览器启动/渲染通道无耦合,
 * 独立成模块后可单独单测/复用(inspect.mjs / 库复用方直接引用)。
 */

/**
 * stealth 注入脚本(页面脚本运行前执行,库模式 evaluateOnNewDocument / addInitScript;
 * CLI 模式无注入点,靠 --disable-blink-features=AutomationControlled 去掉 webdriver)。
 * 对应 2025 反爬攻防下沉:浏览器指纹 + navigator.webdriver 检测。三件事:
 *   1. 抹掉自动化特征(webdriver 是 puppeteer/playwright 最大破绽)
 *   2. 补齐真人浏览器必有、爬虫实例常缺的插件/语言/chrome 运行时
 *   3. Canvas 指纹加轻微噪声:每次绘制结果略不同 → 跨站指纹追踪失效
 * 全部 try/catch 包裹:任一注入失败不影响页面加载(防御性,宁可少伪装不可崩页)。
 */
export const STEALTH_INIT_SCRIPT = `
(() => {
  // 1. 自动化特征:navigator.webdriver
  try { Object.defineProperty(Navigator.prototype, "webdriver", { get: () => undefined }); } catch {}

  // 2. 真人浏览器常态(语言/插件/chrome 运行时)
  try { Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh", "en-US", "en"] }); } catch {}
  try {
    const plugins = [
      { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer", description: "Portable Document Format" },
      { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai", description: "" },
      { name: "Native Client", filename: "internal-nacl-plugin", description: "" },
    ];
    for (const p of plugins) {
      try { Object.defineProperty(p, "length", { get: () => 1 }); p[0] = p; } catch {}
    }
    Object.defineProperty(navigator, "plugins", { get: () => plugins });
  } catch {}
  try {
    window.chrome = window.chrome || { runtime: {}, loadTimes: () => ({}), csi: () => ({}), app: { isInstalled: false } };
  } catch {}
  try { navigator.permissions.query = (p) => Promise.resolve({ state: "granted", onchange: null }); } catch {}

  // 3. Canvas 指纹噪声:toDataURL/toBlob 前对画布像素做极轻微扰动,
  //    使每次绘制的指纹结果都不同(破坏跨站指纹唯一性)
  try {
    const noise = (ctx, w, h) => {
      if (!ctx || w <= 0 || h <= 0) return;
      const img = ctx.getImageData(0, 0, w, h);
      const d = img.data;
      for (let i = 0; i < d.length; i += 64) {
        d[i] += Math.random() > 0.5 ? 1 : -1;
      }
      ctx.putImageData(img, 0, 0);
    };
    const origDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      try { noise(this.getContext("2d"), this.width, this.height); } catch {}
      return origDataURL.apply(this, args);
    };
    const origToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (cb, ...args) {
      try { noise(this.getContext("2d"), this.width, this.height); } catch {}
      return origToBlob.call(this, cb, ...args);
    };
  } catch {}
})();
`;
