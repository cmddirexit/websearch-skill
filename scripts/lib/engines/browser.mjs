/**
 * engines/browser.mjs — 真实浏览器兜底(Chromium,三层能力)
 *
 * 直连被反爬/需 JS 渲染时的最后手段。三层能力按可用性自动选择:
 *   1. puppeteer-core 库 + 系统 chromium   (Termux/Android 实测可用,首选)
 *   2. playwright 库 + 自带/系统浏览器      (桌面 Linux/macOS/Windows)
 *   3. chromium CLI --headless --dump-dom  (零 npm 依赖,Termux 实测可用)
 *
 * 浏览器二进制探测顺序:
 *   WEBSEARCH_BROWSER_PATH 环境变量 > $PREFIX/lib/chromium/chrome(Termux) >
 *   常见系统路径(chromium/chrome/google-chrome)> PATH
 *
 * 统一出口:
 *   - getDom(url):渲染后 HTML 字符串(库模式 page.content / CLI 模式 dump-dom)
 *   - fetchViaBrowser:复用正文提取器
 * 任何环节不可用都返回 null / blocked:true,绝不抛错 —— 调用方自动回退直连。
 *
 * 引擎版搜索(searchBingViaBrowser / searchMarginaliaViaBrowser)已拆到
 * engines/bing-browser.mjs / engines/marginalia-browser.mjs,新增引擎浏览器版
 * 遵循同样模式(引擎文件 import 本模块的 getDom,不往这里加)。
 */

import { spawn, execFileSync, execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
const execFile = promisify(execFileCb);
import { existsSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { solveCloudflareChallenge } from "./cf-solver.mjs";
import { isAntibotContent, detectAntibot, isCfAnti, detectNotFound } from "../antiblock.mjs";
import { dbg, dbgStep, brief } from "../debug.mjs";
import {
  UA,
  buildChromeUa,
  CLI_TIMEOUT_MS,
  CLI_CF_TIMEOUT_MS,
  CLI_CF_ROUND1_MS,
  ZD_PROBE_TIMEOUT_MS,
  ZD_SOLVER_TIMEOUT_MS,
  NAV_TIMEOUT_MS,
  REP_FETCH_MIN_OK_CHARS,
  BROWSER_PROFILE_PREFIX,
  STEALTH_VIEWPORT_W,
  STEALTH_VIEWPORT_H,
  STEALTH_LOCALE,
} from "../config.mjs";
import { appendDebugLog, isKnownCfHost, markCfHost, hostOf } from "../persist.mjs";
import { STEALTH_INIT_SCRIPT } from "./browser-stealth.mjs";
import { bezierPath, humanize } from "./browser-humanize.mjs";

// ---- re-export(公共 API 不变:index.mjs / inspect.mjs / 测试均从本模块导入) ----
export { STEALTH_INIT_SCRIPT } from "./browser-stealth.mjs";
export { bezierPath } from "./browser-humanize.mjs";

let availabilityChecked = false;
let available = false;
let cachedChromiumPath = null;
let sharedBrowser = null; // puppeteer/playwright 浏览器实例复用
let launching = null;     // launch 互斥锁:并发 getDom(聚合时 searx+bing-browser 并行)只启动一次
let driverKind = null;
let cachedChromeVersion = null; // chromium --version 探测结果(UA 版本匹配用)

// ---- 浏览器兜底失败原因追踪(诊断用) ----
// fetchViaBrowser 失败时记录人类可读原因,供 fetch-flow.mjs 输出准确降级日志 ——
// 区分"未安装 Chromium"与"已安装但站点反爬/渲染无正文",避免误导性的"浏览器不可用"。
let lastBrowserFailure = "";

/** 记录最近一次浏览器兜底失败原因(内部) */
function setBrowserFailure(reason) {
  if (reason) lastBrowserFailure = String(reason).slice(0, 200);
}

/** 读取最近一次浏览器兜底失败原因(供调用方输出诊断;无失败记录 → "") */
export function getLastBrowserFailure() {
  return lastBrowserFailure;
}

/** 探测 chromium 版本号(只做一次,缓存):UA 必须与实际浏览器版本匹配,
 * 否则知乎等站会按“UA 版本与实现不符”的风控逻辑拒绝(实测 Chrome120 UA + Chromium149 触发 40362)。
 * 探测失败返回 null(调用方回退默认 UA)。导出供 inspect 等调试工具复用。 */
export async function probeChromiumVersion(bin) {
  if (cachedChromeVersion !== null) return cachedChromeVersion;
  cachedChromeVersion = null;
  try {
    const { execFile } = await import("node:child_process");
    const ver = await new Promise((res) => {
      execFile(bin, ["--version"], { timeout: 5000 }, (err, stdout) => {
        const m = String(stdout || "").match(/(?:Chromium|Chrome)\s+([\d.]+)/);
        res(m ? m[1] : null);
      });
    });
    if (ver) cachedChromeVersion = ver;
  } catch {
    /* 探测失败 → 回退默认 UA */
  }
  return cachedChromeVersion;
}

/** 与本地 chromium 版本匹配的 UA(探测成功用版本号拼,失败回退默认);两模式共用,只算一次 */
async function effectiveChromeUa(bin) {
  const ver = await probeChromiumVersion(bin);
  return ver ? buildChromeUa(ver) : UA;
}

/** 探测 chromium 二进制路径(只做一次,结果缓存)
 * 候选顺序:环境变量 WEBSEARCH_BROWSER_PATH > Termux 默认前缀(硬编码,
 * 不依赖 $PREFIX env —— 某些受限环境下 node 进程拿不到 PREFIX,此前会导致
 * 已装的 Chromium 被误判为"不可用")> 常见系统路径 > PATH。 */
export function resolveChromiumPath() {
  if (cachedChromiumPath !== null) return cachedChromiumPath;
  cachedChromiumPath = null;
  if (process.env.WEBSEARCH_BROWSER_PATH && existsSync(process.env.WEBSEARCH_BROWSER_PATH)) {
    cachedChromiumPath = process.env.WEBSEARCH_BROWSER_PATH;
    return cachedChromiumPath;
  }
  // Termux 默认前缀硬编码兜底:$PREFIX 缺失/被清空也能找到(实测受限 shell 环境)
  const termuxPrefix = process.env.PREFIX || "/data/data/com.termux/files/usr";
  const candidates = [
    `${termuxPrefix}/lib/chromium/chrome`, // Termux
    `${termuxPrefix}/bin/chromium-browser`,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) {
      cachedChromiumPath = p;
      return cachedChromiumPath;
    }
  }
  // PATH 兜底
  const pathDirs = (process.env.PATH || "").split(":");
  for (const dir of pathDirs) {
    for (const name of ["chromium-browser", "chromium", "google-chrome", "chrome", "chromium_browser"]) {
      const p = `${dir}/${name}`;
      if (existsSync(p)) {
        cachedChromiumPath = p;
        return cachedChromiumPath;
      }
    }
  }
  return null;
}

/** 动态加载驱动库:puppeteer-core 优先,playwright 兜底(桌面)。无则返回 null */
async function getDriver() {
  if (driverKind) return driverKind;
  try {
    const p = await import("puppeteer-core");
    if (p?.default?.launch) {
      driverKind = { kind: "puppeteer", launch: p.default.launch };
      return driverKind;
    }
  } catch {}
  try {
    const pw = await import("playwright");
    if (pw?.chromium?.launch) {
      driverKind = { kind: "playwright", launch: pw.chromium.launch };
      return driverKind;
    }
  } catch {}
  return null;
}

/** 探测整体可用性(二进制存在即视为可用:无库时 CLI 模式兜底),结果缓存 */
export async function isBrowserAvailable() {
  if (availabilityChecked) return available;
  availabilityChecked = true;
  // 旧实现 Boolean(binary) && (Boolean(await getDriver()) || true):(X || true) 恒真,退化为只查二进制
  // getDriver 的驱动探测/缓存由 getDom 首次调用时完成,此处无需预加载
  available = Boolean(resolveChromiumPath());
  return available;
}

/**
 * 关闭共享浏览器实例(幂等)。
 * 库模式(agent 进程内长期使用)结束后应显式调用释放 chromium 进程;
 * CLI 薄壳在 process.exit 前调用。CLI 模式的一次性进程自动退出,无需处理。
 */
export async function closeBrowser() {
  if (sharedBrowser) {
    try {
      await sharedBrowser.close();
    } catch {
      /* 已断开则忽略 */
    }
    sharedBrowser = null;
  }
}

/** 从 launch args 提取 --user-data-dir= 对应的 profile 目录(无则 null) */
function profileDirOf(args) {
  const a = (args || []).find((x) => x.startsWith("--user-data-dir="));
  return a ? a.slice("--user-data-dir=".length) : null;
}

/** 找出占用某 profile 且【父进程已死】的 chromium 进程(扫 /proc)。
 * profileDir=null 时匹配所有 websearch 自己的 profile(前缀 BROWSER_PROFILE_PREFIX),
 * 用于顺带清理 unique per-PID profile 的孤儿。
 * 父进程(node)被 SIGKILL 后,chromium 被 init(PPID=1)收养 → 孤儿根。
 * 只清 PPID=1 的根进程:并行实例正在用的浏览器 PPID 是活 node,不会被误杀。
 * 子进程(zygote/gpu/crashpad)PPID 是根 chromium,杀根时按进程组一起清理。
 * 不依赖 SingletonLock 文件内容(Chromium 149 锁文件格式不可靠,可能非纯 PID)。 */
function findOrphanChromiumPids(profileDir) {
  const pids = [];
  let names;
  try {
    names = readdirSync("/proc");
  } catch {
    return pids;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cmdline = readFileSync(`/proc/${name}/cmdline`, "utf8").replace(/\0/g, " ");
      if (!cmdline.includes("chrom")) continue;
      const dirMatch = profileDir ? cmdline.includes(profileDir) : cmdline.includes(BROWSER_PROFILE_PREFIX);
      if (!dirMatch) continue;
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const ppid = Number(stat.match(/^\d+ \([^)]*\) \S+ (\d+)/)?.[1]);
      if (ppid === 1) pids.push(Number(name)); // 父进程已死 → 孤儿根
    } catch {
      /* 进程已退出或不可读,跳过 */
    }
  }
  return pids;
}

/** 清理占用某 profile 的孤儿 chromium 进程(库模式浏览器被 SIGKILL 的 node 留下的常见事故)。
 * 双管齐下:①扫 /proc 杀 PPID=1 的孤儿根进程(杀整个进程组,zygote/gpu 同组),
 * 顺带清理其他 websearch profile(unique per-PID)的孤儿;②删残留锁文件
 * (SingletonLock/Socket/Cookie —— puppeteer 见锁即报 "already running",进程已死的锁
 * 不删,共享 profile 永远不可复用)。幂等、绝不抛错。 */
function cleanupOrphanChromium(profileDir) {
  if (!profileDir) return;
  try {
    const pids = findOrphanChromiumPids(profileDir);
    if (profileDir) {
      for (const p of findOrphanChromiumPids(null)) if (!pids.includes(p)) pids.push(p);
    }
    for (const pid of pids) {
      try {
        process.kill(-pid, "SIGKILL"); // 杀整个进程组
      } catch {
        try {
          process.kill(pid, "SIGKILL"); // 失败退化为单 PID
        } catch {
          /* 进程已退出 */
        }
      }
    }
    if (pids.length) console.error(`[browser] 清理孤儿 chromium(pids ${pids.join(",")}, profile ${profileDir})`);
    for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      try {
        rmSync(join(profileDir, f), { force: true });
      } catch {
        /* 幂等 */
      }
    }
  } catch {
    /* 幂等:清理失败不影响主流程 */
  }
}

/**
 * 启动浏览器实例;共享 profile 被残留孤儿 chromium 锁住时先清理孤儿再重试,
 * 仍失败才换唯一 per-PID profile(Termux 上孤儿 chromium 常见:node 被 kill 后
 * 子进程存活,SingletonLock 仍指向活 PID,puppeteer 会直接抛 "The browser is already running")。
 * 清理后大概率能直接复用共享 profile(更快且不丢缓存),换 unique 只是最后兜底。
 */
async function launchWithFallback(driver, launchArgs) {
  try {
    return await driver.launch(launchArgs);
  } catch (e) {
    // 先清理孤儿再重试共享 profile(比直接换 unique 快,且不丢共享缓存)
    cleanupOrphanChromium(profileDirOf(launchArgs.args));
    try {
      return await driver.launch(launchArgs);
    } catch (e2) {
      console.error(`[browser] 共享 profile 启动失败(${String(e2.message).slice(0, 60)}),换唯一 profile 重试...`);
      const uniqueArgs = {
        ...launchArgs,
        args: launchArgs.args.map((a) =>
          a.startsWith("--user-data-dir=")
            ? `--user-data-dir=${process.env.TMPDIR || process.env.HOME}/${BROWSER_PROFILE_PREFIX}-${process.pid}-lib`
            : a
        ),
      };
      return await driver.launch(uniqueArgs);
    }
  }
}

/**
 * 获取共享浏览器实例(带互斥锁)。
 * 聚合场景下多个引擎(searx/marginalia/bing-browser)并行触发 getDom,
 * 若无锁会同时 launch → 共享 profile 被 SingletonLock 占用 → 双双失败/换 unique 双开。
 * 锁保证并发调用共享同一次 launch(幂等),失败后 launching 清空允许下次重试。
 */
async function getSharedBrowser(driver, launchArgs) {
  if (sharedBrowser) return sharedBrowser;
  if (!launching) {
    launching = launchWithFallback(driver, launchArgs)
      .then((b) => {
        sharedBrowser = b;
        return b;
      })
      .finally(() => {
        launching = null;
      });
  }
  return launching;
}

/**
 * 三次贝塞尔曲线插值:生成 y0→y1 的 n 个中间点(控制点随机 → 每次轨迹不同)。
 * 真人滚动/鼠标移动是非线性的(加速-减速),直线跳变是典型的机器特征。
 * 纯函数,可单测。
 */
/**
 * 创建带 stealth 注入的页面。
 * - playwright:init 脚本必须挂在 context 上,故 newContext + addInitScript
 * - puppeteer:默认 context + evaluateOnNewDocument(每页注入)
 * 返回 { page, ctx }(ctx 非空时 finally 里一起关,防 playwright context 泄漏)。
 */
async function createStealthPage(browser, driver) {
  if (driver.kind === "playwright") {
    const ctx = await browser.newContext({
      userAgent: UA,
      viewport: { width: STEALTH_VIEWPORT_W, height: STEALTH_VIEWPORT_H },
      locale: STEALTH_LOCALE,
    });
    await ctx.addInitScript(STEALTH_INIT_SCRIPT);
    const page = await ctx.newPage();
    return { page, ctx };
  }
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(STEALTH_INIT_SCRIPT);
  await page.setViewport({ width: STEALTH_VIEWPORT_W, height: STEALTH_VIEWPORT_H });
  return { page, ctx: null };
}

/** 库模式:启动(复用实例)并抓渲染后 HTML。兼容 puppeteer(有 isConnected)与 playwright(无该方法)。 */
async function getDomViaDriver(driver, url, waitMs, ua) {
  const launchArgs = {
    executablePath: resolveChromiumPath(),
    headless: true,
    // Scrapling 深挖结论:playwright/puppeteer 默认加 --enable-automation 正是
    // navigator.webdriver=true 的源头,直接移除比 JS 注入更彻底(patchright 同款做法)
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      // stealth:blink 层直接去掉 webdriver(库/CLI 模式共同生效),语言对齐 UA 画像
      "--disable-blink-features=AutomationControlled",
      `--lang=${STEALTH_LOCALE}`,
      `--user-agent=${ua}`,
      // Scrapling STEALTH_ARGS 精选:headless 检测绕过 + Canvas/字体指纹对抗 + 提速
      "--start-maximized", // headless check bypass
      "--test-type",
      "--mute-audio",
      "--disable-logging",
      "--force-color-profile=srgb",
      "--font-render-hinting=none", // 影响 Canvas 字体渲染哈希,指纹对抗
      "--disable-cookie-encryption",
      "--fingerprinting-canvas-image-data-noise", // Chromium 149 原生 Canvas 噪声(优于 JS 注入)
      // 单实例共享 profile:缓存复用且不污染 ~/.config
      `--user-data-dir=${process.env.TMPDIR || process.env.HOME}/${BROWSER_PROFILE_PREFIX}-shared`,
    ],
  };
  // launch 前主动清理占用共享 profile 的孤儿进程(上次 node 被 SIGKILL 留下的库模式浏览器):
  // 不清理的话每次 fetch 反爬站都要先经历一次 "already running" 失败再换 profile,白耗时间
  // 且孤儿进程堆积吃内存(手机上尤其明显)。幂等,无孤儿时零开销。
  cleanupOrphanChromium(profileDirOf(launchArgs.args));
  try {
    sharedBrowser = await getSharedBrowser(driver, launchArgs);
  } catch (e) {
    // 共享 profile 启动失败(可能被残留孤儿 chromium 锁住),清理孤儿后换 unique 重试
    console.error(`[browser] 共享实例启动失败(${e.message.slice(0, 60)}),清理残留后换唯一 profile...`);
    const uniqueArgs = {
      ...launchArgs,
      args: launchArgs.args.map((a) =>
        a.startsWith("--user-data-dir=")
          ? `--user-data-dir=${process.env.TMPDIR || process.env.HOME}/${BROWSER_PROFILE_PREFIX}-${process.pid}-lib`
          : a
      ),
    };
    sharedBrowser = await launchWithFallback(driver, uniqueArgs);
  }
  let page;
  let pageCtx = null;
  try {
    ({ page, ctx: pageCtx } = await createStealthPage(sharedBrowser, driver));
  } catch (e) {
    // 浏览器可能已死(puppeteer 断开/playwright 崩溃):重建实例后再试一次
    console.error(`[browser] 共享实例不可用(${e.message.slice(0, 40)}),重启...`);
    await sharedBrowser.close().catch(() => {});
    sharedBrowser = null;
    launching = null;
    sharedBrowser = await getSharedBrowser(driver, launchArgs);
    ({ page, ctx: pageCtx } = await createStealthPage(sharedBrowser, driver));
  }
  try {
    // Scrapling google_search 同款:默认带 Google referer,让目标站以为是搜索引擎来的流量,
    // 降低风控判定;国内站(百度系/微博/抖音等)带 Google referer 反而可疑,排除
    const referer = /(douyin|weibo|baidu|sogou|taobao|bilibili|zhihu|\.163\.|\.qq\.com|toutiao|xiaohongshu)/i.test(
      url,
    )
      ? undefined
      : "https://www.google.com/";
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS, referer });
    // Cloudflare Turnstile 自动求解(先检测,页面无挑战时零开销)
    await solveCloudflareChallenge(page);
    await humanize(page, waitMs);
    const html = await page.content();
    // 强风控站(知乎文章页等):库模式(CDP 附加 + 共享 profile 残留状态)实测拿到的是
    // 风控 JSON 页(40362/您当前请求存在异常)而非正文 —— 检测到即抛错,降级 CLI 通道
    // (CLI 模式每次随机干净 profile + 无 CDP 附加,实测能过知乎文章页,见 js-initialData 提取)
    // 检测统一走 antiblock.mjs(单一事实来源,含 40362 类风控特征);Cloudflare 验证页
    // (Turnstile/Just a moment)用 detectAntibot 识别 —— 两者都降级 CLI 重试
    const anti = detectAntibot(html.slice(0, 3000));
    if (isCfAnti(anti)) {
      throw new Error(`反爬验证页(${anti.label}),降级 CLI 通道`);
    }
    if (isAntibotContent(html.slice(0, 3000))) {
      throw new Error(`反爬风控页(命中 40362/限制访问),降级 CLI 通道`);
    }
    return html;
  } finally {
    await page.close().catch(() => {});
    if (pageCtx) await pageCtx.close().catch(() => {});
  }
}

/* ===== zendriver 快速通道 =====
 * 裸 WebSocket CDP(无 Runtime.enable 泄漏)→ CF 检测不到自动化;实测 cell.com/
 * nature.com 3s 内直取真实页面(CLI 轮询要 45-90s)。失败自动降级 CLI,不影响现有链。
 * 异步 execFile(非阻塞):搜索聚合场景不拖死其他并行引擎。 */
const ZD_SOLVER = new URL("./zd_solver.py", import.meta.url).pathname;
let zdChecked = false;
let zdOk = false;
function zendriverAvailable() {
  if (zdChecked) return zdOk;
  zdChecked = true;
  try {
    execFileSync("python3", ["-c", "import zendriver"], { timeout: ZD_PROBE_TIMEOUT_MS, stdio: "ignore" });
    zdOk = true;
  } catch {
    zdOk = false;
  }
  return zdOk;
}
/** zendriver 抓渲染后 HTML;不可用/失败返回 null(异步非阻塞,chromium 路径动态探测) */
async function getDomViaZendriver(url) {
  if (!zendriverAvailable()) {
    dbg(`zendriver 不可用(未安装 python 包) → 跳过`);
    return null;
  }
  const bin = resolveChromiumPath(); // 动态探测,与 CLI/库模式同源,不硬编码
  if (!bin) {
    dbg(`zendriver 不可用(未找到 chromium) → 跳过`);
    return null;
  }
  const t0 = Date.now();
  try {
    const { stdout } = await execFile("python3", [ZD_SOLVER, url, "60", bin], {
      timeout: ZD_SOLVER_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024, // 大页面(150KB+)JSON 转义后体积不小
      stdio: ["ignore", "pipe", "ignore"],
    });
    const j = JSON.parse(stdout);
    dbg(`zendriver 返回: ok=${j.ok} elapsed=${j.elapsed ?? "?"}s html=${(j.html || "").length}字符 err=${j.error || "-"} (共${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    if (j.ok && j.html) return j.html;
    console.error(`[zd] solver 失败: ${j.error || "无输出"}`);
  } catch (e) {
    dbg(`zendriver 通道异常(${String(e.message).slice(0, 80)}) 共${((Date.now() - t0) / 1000).toFixed(1)}s → 返回 null`);
    console.error(`[zd] zendriver 通道不可用: ${String(e.message).slice(0, 120)}`);
    // execFile 超时 kill 的是 python 主进程,python 被 SIGKILL 时 zd_solver 的 finally 没机会
    // 执行,chromium 进程树变孤儿(锁住共享 profile + 吃内存)—— 按唯一 profile 路径兜底清理
    try {
      execFileSync("pkill", ["-9", "-f", "websearch-zd-profile"], { stdio: "ignore" });
    } catch { /* pkill 无匹配也返回非零,忽略 */ }
  }
  return null;
}

/** 从 stderr 提取最有信息量的诊断行(ERROR/FATAL 行优先,替代“前 80 字符”截断) */
function extractErrorLine(stderr) {
  const lines = String(stderr || "").split(/\n/);
  const hit = lines.find((l) => /ERROR|FATAL|FAILED|Segmentation|Traceback|ERR_/i.test(l) && !/inotify|dbus/i.test(l));
  return hit ? hit.trim().slice(0, 160) : "";
}

/** CLI 模式:一次性进程 --dump-dom 抓渲染后 HTML。
 * ⚠ Termux 实测:--dump-dom 与 --user-data-dir 组合会挂起无输出(profile 初始化死锁),
 * 去掉 user-data-dir,让 chromium 用默认临时 profile(进程退出即释放,不污染 ~/.config)。
 * 并发锁风险:CLI 仅在库模式失败时兜底,并发场景罕见,可接受。
 *
 * @param {{virtualTime?:boolean, timeoutMs?:number}} opts virtualTime=true 用 --virtual-time-budget 快进
 *   (过 JS 倒计时验证);false 改用 --timeout 真实墙钟等待(Cloudflare Turnstile 是交互
 *   验证,虚拟时间快进反而让脚本永远等不到响应 → 挂起无输出,真实等待才有机会过验证)。
 *   timeoutMs 覆盖 --timeout 值(CF 轮询用,最长 CLI_CF_TIMEOUT_MS)。
 *   ⚠ killTree 定时器按 单轮 timeout + CLI_TIMEOUT_MS 余量 动态放大 —— 真实等待轮
 *   (90s)不能被 40s 的固定超时提前杀掉。
 */
function getDomViaCli(bin, url, waitMs, ua, opts = {}) {
  const { virtualTime = true, timeoutMs } = opts;
  const waitBudget = virtualTime ? 0 : Math.max(timeoutMs || 30000, waitMs * 3);
  const killAfterMs = CLI_TIMEOUT_MS + (virtualTime ? 0 : waitBudget) + 5000;
  return new Promise((resolve, reject) => {
    const args = [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--no-first-run",
      "--no-default-browser-check",
      // stealth:CLI 模式无注入点,靠 blink 标志去掉 webdriver + 语言对齐 + 指纹 flag
      "--disable-blink-features=AutomationControlled",
      "--start-maximized",
      "--test-type",
      "--force-color-profile=srgb",
      "--font-render-hinting=none",
      "--fingerprinting-canvas-image-data-noise",
      `--lang=${STEALTH_LOCALE}`,
      `--user-agent=${ua}`,
      // 虚拟时间快进:至少 15s(过 JS 倒计时验证),按 waitMs 放大覆盖更长等待场景;
      // 非 virtualTime 轮次:真实墙钟等待(见函数注释),给 Turnstile 完成验证的机会
      ...(virtualTime
        ? [`--virtual-time-budget=${Math.max(15000, waitMs * 3)}`]
        : [`--timeout=${waitBudget}`]),
      "--dump-dom",
      url,
    ];
    // detached + 进程组 SIGKILL:chromium 会派生 zygote/gpu 等子进程树,
    // 若只杀主进程(Termux 上 execFile timeout 的默认行为)会留下孤儿锁住 profile;
    // 负 PID 杀整个进程组,完成后/超时/出错一律清理,node 被外部 kill 时也能自愈。
    const child = spawn(bin, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const killTree = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* 进程组已退出则忽略 */
      }
    };
    // 双重清理:①超时定时器(进程存活时触发)② process exit 钩子(node 提前退出时
    // 定时器随进程销毁,不挂钩子会留下永不退出的孤儿 chromium——实测真实事故)。
    // 二者都只是同步 SIGKILL,幂等安全。
    const timer = setTimeout(killTree, killAfterMs);
    process.on("exit", killTree);
    child.stdout.on("data", (d) => {
      if (stdout.length >= 40 * 1024 * 1024) {
        truncated = true;
        return;
      }
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < 8192) stderr += d;
    });
    const failWith = (msg) => {
      // 完整诊断落盘(不截断),错误消息里带日志路径 + 最有信息量的 stderr 行
      appendDebugLog(`URL: ${url}\ncmd: chromium ${args.join(" ")}\nexit: (见下)\nstderr(前 8192 字符):\n${stderr}\n--- 末尾 ---`);
      const diag = extractErrorLine(stderr) || stderr.slice(0, 200) || "(无 stderr)";
      reject(new Error(`${msg}: ${diag} [调试日志: ${BROWSER_DEBUG_LOG}]`));
    };
    child.on("error", (err) => {
      clearTimeout(timer);
      process.removeListener("exit", killTree);
      killTree();
      appendDebugLog(`URL: ${url}\ncmd: chromium ${args.join(" ")}\nspawn 错误: ${String(err.message)}\n--- 末尾 ---`);
      reject(new Error(`chromium CLI 启动失败: ${String(err.message).slice(0, 120)} [调试日志: ${BROWSER_DEBUG_LOG}]`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      process.removeListener("exit", killTree);
      killTree(); // 兜底:确保整棵树退出,不留孤儿
      if (stdout || truncated) return resolve(stdout);
      failWith(`chromium CLI 无输出(exit ${code})`);
    });
  });
}

/**
 * 核心:拿渲染后 HTML。库模式优先,失败降级 CLI。
 * @returns {Promise<string|null>}
 */
/** 渲染后 HTML(库模式 CDP 优先,失败降级 CLI)。
 * @param {{preferCli?:boolean}} opts preferCli=true 直接 CLI(跳过库模式与虚拟时间轮) */
export async function getDom(url, waitMs = 4000, opts = {}) {
  const { preferCli = false } = opts;
  const bin = resolveChromiumPath();
  if (!bin) return null;
  dbg(`getDom 入口: ${url} preferCli=${preferCli} waitMs=${waitMs}`);
  // UA 与本地浏览器版本匹配(探测一次,缓存):知乎等站按 UA 版本不符判风控
  const ua = await effectiveChromeUa(bin);
  if (!preferCli) {
    const driver = await getDriver();
    if (driver) {
      try {
        const html = await dbgStep("  库模式(getDomViaDriver)", () => getDomViaDriver(driver, url, waitMs, ua));
        if (html) dbg(`  库模式: HTML ${brief(html)}`);
        return html;
      } catch (e) {
        setBrowserFailure(`库模式失败: ${String(e.message).slice(0, 100)}`);
        console.error(`[browser] 库模式失败(${e.message.slice(0, 60)}),降级 CLI...`);
      }
    }
  }
  // CLI 第一轮:虚拟时间快进(过 JS 倒计时验证,快)。CF 验证站(preferCli)已知必然失败,直接跳过
  if (!preferCli) {
    try {
      const html = await dbgStep("  CLI 虚拟时间轮(virtual-time-budget)", () => getDomViaCli(bin, url, waitMs, ua, { virtualTime: true }));
      if (html) {
        // CF Turnstile/检查页:虚拟时间快进对交互验证无效(脚本等不到真实响应),换第二轮真实等待重试
        const anti = detectAntibot(html.slice(0, 20000));
        if (isCfAnti(anti)) {
          setBrowserFailure(`CLI 虚拟时间轮拿到 ${anti.label}(交互验证需真实等待)`);
          console.error(`[browser] CLI 首轮返回 ${anti.label},换真实等待重试...`);
          dbg(`  CLI 虚拟时间轮拿到 ${anti.label} → 换真实等待`);
        } else {
          dbg(`  CLI 虚拟时间轮成功: HTML ${brief(html)}`);
          return html;
        }
      }
    } catch (e) {
      setBrowserFailure(`CLI 虚拟时间轮失败: ${String(e.message).slice(0, 100)}`);
      console.error(`[browser] CLI 首轮失败: ${e.message}`);
    }
  }
  // CLI 真实等待轮询:CF 放行需要真实墙钟时间(虚拟时间下会挂起),且有时需多轮才放行。
  // 每轮 timeout 递增(45s → 90s),dump 结果非 CF 验证页即返回;仍为 CF 页则继续下一轮
  // (CF 对连续尝试有时第 2-3 轮才放行,IP/会话状态在 CDN 端累积)。全部失败返回 null。
  const cfRounds = [
    { timeoutMs: Math.max(CLI_CF_ROUND1_MS, waitMs * 3), label: "第二轮(45s)" },
    { timeoutMs: CLI_CF_TIMEOUT_MS, label: "第三轮(90s)" },
  ];
  for (const r of cfRounds) {
    try {
      const html = await dbgStep(`  CLI 真实等待轮(${r.label})`, () => getDomViaCli(bin, url, waitMs, ua, { virtualTime: false, timeoutMs: r.timeoutMs }));
      if (html) {
        const anti = detectAntibot(html.slice(0, 20000));
        if (isCfAnti(anti)) {
          setBrowserFailure(`CLI ${r.label}仍返回 ${anti.label}(站点验证未放行)`);
          console.error(`[browser] CLI ${r.label}仍返回 ${anti.label},继续下一轮...`);
          continue;
        }
        // ⚠ markCfHost 唯一合法入口:真实等待轮成功 = 确证该站需要浏览器真实等待(CF 类站点)。
        // 统一语义:只有「确证 CF」才标记(zendriver/虚拟时间轮达线 ≠ CF 站,见 fetchViaBrowser),
        // 否则普通 SPA 站会被 isKnownCfHost 短路进 preferCli 真实等待轮而拿到 Loading 壳
        markCfHost(hostOf(url));
        return html;
      }
    } catch (e) {
      setBrowserFailure(`CLI ${r.label}失败: ${String(e.message).slice(0, 100)}`);
      console.error(`[browser] CLI ${r.label}失败: ${e.message}`);
    }
  }
  setBrowserFailure("CLI 真实等待轮未取得非验证页(站点持续拦截或无正文)");
  return null;
}

/** 用浏览器抓取页面正文(直连被反爬/需 JS 渲染时的兜底)。不可用返回 null。
 * 通道顺序:zendriver(裸 CDP,CF 站 3s 直取)→ getDom(库模式 → CLI 轮询)。
 * @param {{preferCli?:boolean, skipZendriver?:boolean}} opts
 *   - preferCli=true 跳过库模式与虚拟时间轮,直接 CLI 真实等待轮
 *     (CF 验证站:库模式 CDP 泄漏必被拦、虚拟时间轮必然失败 —— 已知路径直接跳过省时间)
 *   - skipZendriver=true 跳过 zendriver 快速通道。zendriver 为 CF 站设计(3s 直取),
 *     对普通站是负收益:实测 Next.js 站 get 等导航事件 16s+ 且返回时 JS 未渲染完(拿壳),
 *     而库模式(domcontentloaded+humanize)8s / CLI 虚拟时间轮 11s 就能拿到完整页 ——
 *     直连 200(非 CF 拦截)时应当跳过 */
export async function fetchViaBrowser(url, maxChars, opts = {}) {
  if (!(await isBrowserAvailable())) {
    setBrowserFailure("未检测到 Chromium 二进制(WEBSEARCH_BROWSER_PATH/PREFIX/系统路径均未命中)");
    return null;
  }
  dbg(`fetchViaBrowser 入口: ${url} preferCli=${opts.preferCli || false} skipZendriver=${opts.skipZendriver || false}`);
  // zendriver 快速通道:CF 站(Just a moment/Turnstile)实测 3s 内直接拿真实页面,
  // 无需 CLI 45-90s 等待轮;普通站同样适用(渲染后 HTML)
  if (!opts.skipZendriver) {
    const zdHtml = await dbgStep("  zendriver 快速通道", () => getDomViaZendriver(url));
    if (zdHtml) {
      const anti = detectAntibot(zdHtml.slice(0, 20000));
      if (!(isCfAnti(anti))) {
        // 懒加载正文提取:jsdom/readability/turndown 只在真的抓正文时才加载,避免拖慢纯搜索路径
        const { extractBodyFromHtml } = await import("../fetch-page.mjs");
        const base = extractBodyFromHtml(zdHtml, maxChars, url);
        // 只有正文达线才算成功:zendriver 在真实墙钟下可能拿到 SPA(Next.js/React)的
        // Loading 壳(本站实测 20s 仍未渲染完)—— 壳不是真实内容,不能当成功返回。
        // 注意此处【不】 markCfHost:zendriver 能达线 ≠ CF 站(普通 SPA 同样适用),
        // 误标会把普通站短路进 isKnownCfHost 的 preferCli 真实等待轮而拿到壳
        const raw = (base?.markdown || base?.body || "").trim();
        if (base && raw.length >= REP_FETCH_MIN_OK_CHARS) {
          dbg(`  zendriver 成功: HTML ${brief(zdHtml)} → 提取 ${brief(base)} ✅`);
          setBrowserFailure("");
          return { ...base, url };
        }
        // 404 页:zendriver 已花 60s+ 拿到 404 壳,直接确认返回,不让 getDom 再白跑一轮
        const nf = detectNotFound(zdHtml);
        if (nf) {
          dbg(`  zendriver 拿到 404 页(提取 ${raw.length}字符)→ 确认 ${nf.label},返回 notFound`);
          console.error(`[browser] zendriver 确认 ${nf.label}`);
          return { url, notFound: true };
        }
        dbg(`  zendriver 拿到壳(提取 ${raw.length}字符 < ${REP_FETCH_MIN_OK_CHARS})→ 继续降级`);
        setBrowserFailure(`zendriver 渲染后仍无正文(${raw.length}字符,SPA 壳或反爬页)`);
      }
      // zendriver 拿到 CF 验证页(罕见):确证 CF,标记后降级 CLI 轮询
      if (isCfAnti(anti)) markCfHost(hostOf(url));
    }
  }
  const html = await dbgStep("  getDom(库模式→虚拟时间→真实等待)", () => getDom(url, 4000, opts));
  if (!html) {
    setBrowserFailure(lastBrowserFailure || "getDom 三通道(库模式/虚拟时间/真实等待)均未取得渲染 HTML");
    return null;
  }
  dbg(`  getDom 拿到 HTML ${brief(html)}`);
  // CF 验证页(Turnstile/Just a moment)未通过验证:不算成功抓取 —— 返回 null 让调用方
  // 走最终错误分诊(提示“被 CF 验证拦截 + 更换网络出口”等可执行建议),而非打印无用的验证页正文
  const anti = detectAntibot(html.slice(0, 20000));
  if (isCfAnti(anti)) {
    markCfHost(hostOf(url));
    console.error(`[browser] 浏览器兜底拿到 ${anti.label}(未通过验证),视为失败`);
    setBrowserFailure(`站点 ${anti.label} 未能通过验证(浏览器已尽力,需换出口 IP/人工验证)`);
    return null;
  }
  // 懒加载正文提取:jsdom/readability/turndown 只在真的抓正文时才加载,避免拖慢纯搜索路径
  const { extractBodyFromHtml } = await import("../fetch-page.mjs");
  const base = extractBodyFromHtml(html, maxChars, url);
  // ⚠ 提取失败/正文不足(风控 JSON/验证码页/SPA 壳):返回 null 而非 {url} 空对象 ——
  // 否则调用方会把“无内容”误判为“空壳垃圾页”给负反馈,反爬站(知乎 40362)会被误伤降分。
  // 正文达线检查与 zendriver 分支同标准(getDom 内部真实等待轮成功已 markCfHost,此处不重复)
  const raw = (base?.markdown || base?.body || "").trim();
  if (!base || raw.length < REP_FETCH_MIN_OK_CHARS) {
    // 404 页面识别:页面不存在时浏览器渲染后也是 404 页(Next.js 等 SSR 站),
    // 让调用方(cli)能报“页面不存在”而非误导性的“被 CF 拦截/浏览器失败”
    const nf = detectNotFound(html);
    dbg(`  提取失败/不足(${raw.length}字符)→ 视为失败返回 null${nf ? ` (${nf.label})` : ""}`);
    if (nf) {
      console.error(`[browser] 浏览器兜底确认 ${nf.label}`);
      return { url, notFound: true };
    }
    setBrowserFailure(lastBrowserFailure || `渲染后提取无正文(${raw.length}字符,风控页/SPA 壳)`);
    return null;
  }
  dbg(`  ✓ 提取成功: ${brief(base)}`);
  setBrowserFailure("");
  return { ...base, url };
}
