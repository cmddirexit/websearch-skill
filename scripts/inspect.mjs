#!/usr/bin/env node
/**
 * inspect.mjs — 浏览器检查模式(DevTools 能力子集)
 *
 * 像 Chrome DevTools 一样打开网页做交互式检查:执行 JS、查元素、监听网络、
 * 看 console、取 cookie、截图。底层 = puppeteer-core + 本地 Chromium(CDP),
 * 复用 websearch 的反爬基建(stealth 注入 + 版本匹配 UA + 随机干净 profile),
 * 所以被知乎等强风控站拦时,检查结果与真实浏览器一致。
 *
 * 用法:
 *   node scripts/inspect.mjs <url> [选项]
 *     --js "code"        执行 JS(表达式或语句)并打印结果(JSON 序列化)
 *     --select "selector" 打印匹配元素 outerHTML(截断 3000)
 *     --network          监听并打印页面所有网络请求(方法/URL/状态/类型)
 *     --console          收集并打印 console 日志
 *     --cookies          打印 document.cookie 与 localStorage 键
 *     --screenshot out.png 整页截图保存
 *     --timeout ms       页面加载超时(默认 20s)
 *     --wait ms          加载后额外等待(默认 3000,给 JS 渲染时间)
 *
 * 示例:
 *   node scripts/inspect.mjs "https://zhuanlan.zhihu.com/p/679458317" \
 *     --js "document.title" --network
 *   node scripts/inspect.mjs <url> --select "#js-initialData" --screenshot shot.png
 */
import { existsSync, rmSync } from "node:fs";
import { resolveChromiumPath, probeChromiumVersion, STEALTH_INIT_SCRIPT } from "./lib/engines/browser.mjs";
import { buildChromeUa, STEALTH_LOCALE, STEALTH_VIEWPORT_W, STEALTH_VIEWPORT_H, NAV_TIMEOUT_MS } from "./lib/config.mjs";

const arg = (name, def = null) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1] ?? "";
};
const has = (name) => process.argv.includes(name);

const url = process.argv[2];
if (!url || url.startsWith("--")) {
  console.error(`用法: node scripts/inspect.mjs <url> [--js code] [--select sel] [--network] [--console] [--cookies] [--screenshot file] [--timeout ms] [--wait ms]`);
  process.exit(2);
}

const bin = resolveChromiumPath();
if (!bin) {
  console.error("✗ 未找到 chromium(装 x11-repo 的 chromium 或设 WEBSEARCH_BROWSER_PATH)");
  process.exit(1);
}

// 版本匹配 UA(与 getDom 同源逻辑)
const ver = await probeChromiumVersion(bin);
const ua = ver ? buildChromeUa(ver) : null;
console.log(`● chromium: ${bin}${ver ? ` (v${ver})` : ""}`);

const { default: puppeteer } = await import("puppeteer-core");

let browser = null;
try {
  browser = await puppeteer.launch({
    headless: true,
    executablePath: bin,
    ignoreDefaultArgs: ["--enable-automation"], // 去 webdriver 标志(与 getDom 一致)
    defaultViewport: { width: STEALTH_VIEWPORT_W, height: STEALTH_VIEWPORT_H },
    args: [
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-blink-features=AutomationControlled",
      `--lang=${STEALTH_LOCALE}`,
      ...(ua ? [`--user-agent=${ua}`] : []),
      "--start-maximized",
      "--test-type",
      "--mute-audio",
      "--disable-logging",
      "--force-color-profile=srgb",
      "--font-render-hinting=none",
      "--fingerprinting-canvas-image-data-noise",
      // 不指定 user-data-dir:puppeteer 用默认临时 profile,退出自动清理(调试工具要干净)
    ],
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(STEALTH_INIT_SCRIPT);

  // 网络监听(先注册再 goto)
  const requests = [];
  if (has("--network")) {
    page.on("request", (r) => {
      if (!["image", "font"].includes(r.resourceType())) {
        requests.push({ method: r.method(), url: r.url(), type: r.resourceType(), status: null });
      }
    });
    page.on("response", (r) => {
      const item = requests.find((x) => x.url === r.url() && x.status === null);
      if (item) item.status = r.status();
    });
  }

  // console 监听
  const consoleLogs = [];
  if (has("--console")) {
    page.on("console", (m) => consoleLogs.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
    page.on("pageerror", (e) => consoleLogs.push(`[pageerror] ${String(e).slice(0, 300)}`));
  }

  // 加载
  const timeoutMs = Number(arg("--timeout", String(NAV_TIMEOUT_MS)));
  const waitMs = Number(arg("--wait", "3000"));
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    console.log(`● ${resp ? `HTTP ${resp.status()}` : "no response"} | ${url}`);
    if (resp && resp.status() >= 400) {
      console.log(`⚠ 页面返回错误状态;继续尝试检查内容(可能被反爬拦)…`);
    }
  } catch (e) {
    console.log(`⚠ 加载异常: ${e.message.split("\n")[0]}`);
    console.log(`  继续尝试检查已渲染内容(SPA 首屏/错误页也可能有信息)…`);
  }
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

  // 基本信息:标题 + 文本长度
  const basic = await page.evaluate(() => ({
    title: document.title,
    textLen: (document.body?.innerText || "").length,
    htmlLen: document.documentElement?.outerHTML.length || 0,
  }));
  console.log(`● 标题: ${basic.title}`);
  console.log(`● 文本 ${basic.textLen} 字符 / HTML ${basic.htmlLen} 字节`);

  // --js:执行任意 JS
  if (has("--js")) {
    const code = arg("--js");
    try {
      const result = await page.evaluate(
        (src) => {
          // 表达式直接求值;语句用 Function 包装(可访问页面全局变量)
          const isExpr = /^[\s(]*(?:[\w$.\[\]'"`]|\(|\[|\{|\+|-|!|~|new |typeof |void |await )/.test(src) && !/\n/.test(src);
          if (isExpr) return { ok: true, value: eval(src) };
          const fn = new Function(`return (async () => { ${src} })()`);
          return { ok: true, value: fn() };
        },
        code,
      );
      const value = result?.value;
      const out = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value);
      console.log(`\n── JS 结果 ──\n${String(out).slice(0, 4000)}`);
    } catch (e) {
      console.error(`✗ JS 执行失败: ${e.message}`);
    }
  }

  // --select:查元素 outerHTML
  if (has("--select")) {
    const sel = arg("--select");
    const info = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return { found: false };
      return { found: true, tag: el.tagName, html: el.outerHTML.slice(0, 3000), count: document.querySelectorAll(s).length };
    }, sel);
    if (info.found) {
      console.log(`\n── ${sel} (${info.tag}, 全页 ${info.count} 个) ──\n${info.html}`);
    } else {
      console.log(`\n── ${sel} → 未找到(页面未渲染该元素?)`);
    }
  }

  // --cookies
  if (has("--cookies")) {
    const ck = await page.evaluate(() => ({
      cookie: document.cookie,
      ls: Object.keys(localStorage).slice(0, 50),
      ss: Object.keys(sessionStorage).slice(0, 20),
    }));
    console.log(`\n── Cookie ──\n${ck.cookie || "(空,httpOnly cookie 不在 document.cookie)"}`);
    console.log(`── localStorage(${ck.ls.length}) ──\n${ck.ls.join(", ") || "(空)"}`);
  }

  // --console
  if (has("--console")) {
    console.log(`\n── Console(${consoleLogs.length}) ──`);
    console.log(consoleLogs.slice(0, 30).join("\n") || "(无日志)");
  }

  // --network
  if (has("--network")) {
    console.log(`\n── Network(${requests.length}) ──`);
    for (const r of requests.slice(0, 40)) {
      console.log(`${r.status ?? "…"} ${r.method} ${r.type.padEnd(10)} ${r.url.slice(0, 140)}`);
    }
    if (requests.length > 40) console.log(`… 其余 ${requests.length - 40} 条省略`);
  }

  // --screenshot
  if (has("--screenshot")) {
    const file = arg("--screenshot");
    await page.screenshot({ path: file, fullPage: true });
    console.log(`\n● 截图已保存: ${file} (${existsSync(file) ? "OK" : "失败"})`);
  }
} finally {
  if (browser) await browser.close().catch(() => {});
}
