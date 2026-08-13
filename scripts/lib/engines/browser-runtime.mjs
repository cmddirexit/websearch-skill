/**
 * Chromium runtime: binary/driver discovery, shared browser lifecycle, and
 * the Puppeteer/Playwright rendering channel.
 */

import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { solveCloudflareChallenge } from "./cf-solver.mjs";
import { isAntibotContent, detectAntibot, isCfAnti } from "../antiblock.mjs";
import {
  UA,
  buildChromeUa,
  NAV_TIMEOUT_MS,
  BROWSER_PROFILE_PREFIX,
  STEALTH_VIEWPORT_W,
  STEALTH_VIEWPORT_H,
  STEALTH_LOCALE,
  BROWSER_PATH,
} from "../config.mjs";
import { STEALTH_INIT_SCRIPT } from "./browser-stealth.mjs";
import { humanize } from "./browser-humanize.mjs";

let availabilityChecked = false;
let available = false;
let cachedChromiumPath = null;
let sharedBrowser = null;
let launching = null;
let driverKind = null;
let cachedChromeVersion = null;

/** Chromium version is cached so the browser UA matches the installed binary. */
export async function probeChromiumVersion(bin) {
  if (cachedChromeVersion !== null) return cachedChromeVersion;
  cachedChromeVersion = null;
  try {
    const { execFile } = await import("node:child_process");
    const ver = await new Promise((resolve) => {
      execFile(bin, ["--version"], { timeout: 5000 }, (err, stdout) => {
        const match = String(stdout || "").match(/(?:Chromium|Chrome)\s+([\d.]+)/);
        resolve(match ? match[1] : null);
      });
    });
    if (ver) cachedChromeVersion = ver;
  } catch {
    // Fall back to the configured default UA.
  }
  return cachedChromeVersion;
}

export async function effectiveChromeUa(bin) {
  const ver = await probeChromiumVersion(bin);
  return ver ? buildChromeUa(ver) : UA;
}

/** Resolve Chromium without eagerly loading an optional browser driver. */
export function resolveChromiumPath() {
  if (cachedChromiumPath !== null) return cachedChromiumPath;
  cachedChromiumPath = null;
  if (process.env.WEBSEARCH_BROWSER_PATH && existsSync(process.env.WEBSEARCH_BROWSER_PATH)) {
    cachedChromiumPath = process.env.WEBSEARCH_BROWSER_PATH;
    return cachedChromiumPath;
  }
  if (BROWSER_PATH && existsSync(BROWSER_PATH)) {
    cachedChromiumPath = BROWSER_PATH;
    return cachedChromiumPath;
  }
  const termuxPrefix = process.env.PREFIX || "/data/data/com.termux/files/usr";
  const candidates = [
    `${termuxPrefix}/lib/chromium/chrome`,
    `${termuxPrefix}/bin/chromium-browser`,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  // Playwright / Puppeteer 本地缓存的 Chromium(桌面 Linux 常见安装形态,
  // 不在 PATH 也不在系统路径,不探测就永远"未检测到 Chromium")
  const home = process.env.HOME || "";
  const pwCaches = [
    `${home}/.cache/ms-playwright`,
    `${home}/.cache/puppeteer`,
    process.env.PLAYWRIGHT_BROWSERS_PATH || "",
    process.env.PUPPETEER_CACHE_DIR || "",
  ].filter(Boolean);
  for (const cache of pwCaches) {
    if (!existsSync(cache)) continue;
    let entries = [];
    try {
      entries = readdirSync(cache, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || !/chrom/i.test(e.name)) continue;
      for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-win64/chrome.exe", "chrome/chrome"]) {
        const p = join(cache, e.name, rel);
        if (existsSync(p)) {
          cachedChromiumPath = p;
          return cachedChromiumPath;
        }
      }
    }
  }
  for (const dir of (process.env.PATH || "").split(":")) {
    for (const name of ["chromium-browser", "chromium", "google-chrome", "chrome", "chromium_browser"]) {
      const path = `${dir}/${name}`;
      if (existsSync(path)) {
        cachedChromiumPath = path;
        return cachedChromiumPath;
      }
    }
  }
  return null;
}

/** Load an optional library driver, preferring Puppeteer on Termux. */
export async function getBrowserDriver() {
  if (driverKind) return driverKind;
  try {
    const puppeteer = await import("puppeteer-core");
    if (puppeteer?.default?.launch) {
      driverKind = { kind: "puppeteer", launch: puppeteer.default.launch };
      return driverKind;
    }
  } catch {}
  try {
    const playwright = await import("playwright");
    if (playwright?.chromium?.launch) {
      driverKind = { kind: "playwright", launch: playwright.chromium.launch };
      return driverKind;
    }
  } catch {}
  return null;
}

export async function isBrowserAvailable() {
  if (availabilityChecked) return available;
  availabilityChecked = true;
  available = Boolean(resolveChromiumPath());
  return available;
}

/** Close the shared library-mode browser. CLI browser processes are one-shot. */
export async function closeBrowser() {
  if (!sharedBrowser) return;
  try {
    await sharedBrowser.close();
  } catch {
    // Already disconnected.
  }
  sharedBrowser = null;
}

function profileDirOf(args) {
  const value = (args || []).find((arg) => arg.startsWith("--user-data-dir="));
  return value ? value.slice("--user-data-dir=".length) : null;
}

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
      const matchesProfile = profileDir
        ? cmdline.includes(profileDir)
        : cmdline.includes(BROWSER_PROFILE_PREFIX);
      if (!matchesProfile) continue;
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const ppid = Number(stat.match(/^\d+ \([^)]*\) \S+ (\d+)/)?.[1]);
      if (ppid === 1) pids.push(Number(name));
    } catch {
      // Process exited or became unreadable.
    }
  }
  return pids;
}

function cleanupOrphanChromium(profileDir) {
  if (!profileDir) return;
  try {
    const pids = findOrphanChromiumPids(profileDir);
    for (const pid of findOrphanChromiumPids(null)) {
      if (!pids.includes(pid)) pids.push(pid);
    }
    for (const pid of pids) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Process already exited.
        }
      }
    }
    if (pids.length) {
      console.error(`[browser] 清理孤儿 chromium(pids ${pids.join(",")}, profile ${profileDir})`);
    }
    for (const file of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      try {
        rmSync(join(profileDir, file), { force: true });
      } catch {
        // Idempotent cleanup.
      }
    }
  } catch {
    // Cleanup failure must not break rendering.
  }
}

function uniqueProfileArgs(launchArgs) {
  const base = process.env.TMPDIR || process.env.HOME || "/tmp";
  return {
    ...launchArgs,
    args: launchArgs.args.map((arg) =>
      arg.startsWith("--user-data-dir=")
        ? `--user-data-dir=${base}/${BROWSER_PROFILE_PREFIX}-${process.pid}-lib`
        : arg
    ),
  };
}

async function launchWithFallback(driver, launchArgs) {
  try {
    return await driver.launch(launchArgs);
  } catch {
    cleanupOrphanChromium(profileDirOf(launchArgs.args));
    try {
      return await driver.launch(launchArgs);
    } catch (error) {
      console.error(`[browser] 共享 profile 启动失败(${String(error.message).slice(0, 60)}),换唯一 profile 重试...`);
      return driver.launch(uniqueProfileArgs(launchArgs));
    }
  }
}

async function getSharedBrowser(driver, launchArgs) {
  if (sharedBrowser) return sharedBrowser;
  if (!launching) {
    launching = launchWithFallback(driver, launchArgs)
      .then((browser) => {
        sharedBrowser = browser;
        return browser;
      })
      .finally(() => {
        launching = null;
      });
  }
  return launching;
}

async function createStealthPage(browser, driver) {
  if (driver.kind === "playwright") {
    const context = await browser.newContext({
      userAgent: UA,
      viewport: { width: STEALTH_VIEWPORT_W, height: STEALTH_VIEWPORT_H },
      locale: STEALTH_LOCALE,
    });
    await context.addInitScript(STEALTH_INIT_SCRIPT);
    return { page: await context.newPage(), context };
  }
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(STEALTH_INIT_SCRIPT);
  await page.setViewport({ width: STEALTH_VIEWPORT_W, height: STEALTH_VIEWPORT_H });
  return { page, context: null };
}

/** Render HTML through Puppeteer or Playwright using one shared browser instance. */
export async function getDomViaDriver(driver, url, waitMs, ua) {
  const base = process.env.TMPDIR || process.env.HOME || "/tmp";
  const launchArgs = {
    executablePath: resolveChromiumPath(),
    headless: true,
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-blink-features=AutomationControlled",
      `--lang=${STEALTH_LOCALE}`,
      `--user-agent=${ua}`,
      "--start-maximized",
      "--test-type",
      "--mute-audio",
      "--disable-logging",
      "--force-color-profile=srgb",
      "--font-render-hinting=none",
      "--disable-cookie-encryption",
      "--fingerprinting-canvas-image-data-noise",
      `--user-data-dir=${base}/${BROWSER_PROFILE_PREFIX}-shared`,
    ],
  };
  cleanupOrphanChromium(profileDirOf(launchArgs.args));
  try {
    sharedBrowser = await getSharedBrowser(driver, launchArgs);
  } catch (error) {
    console.error(`[browser] 共享实例启动失败(${error.message.slice(0, 60)}),清理残留后换唯一 profile...`);
    sharedBrowser = await launchWithFallback(driver, uniqueProfileArgs(launchArgs));
  }

  let page;
  let pageContext = null;
  try {
    ({ page, context: pageContext } = await createStealthPage(sharedBrowser, driver));
  } catch (error) {
    console.error(`[browser] 共享实例不可用(${error.message.slice(0, 40)}),重启...`);
    await sharedBrowser.close().catch(() => {});
    sharedBrowser = null;
    launching = null;
    sharedBrowser = await getSharedBrowser(driver, launchArgs);
    ({ page, context: pageContext } = await createStealthPage(sharedBrowser, driver));
  }

  try {
    const referer = /(douyin|weibo|baidu|sogou|taobao|bilibili|zhihu|\.163\.|\.qq\.com|toutiao|xiaohongshu)/i.test(url)
      ? undefined
      : "https://www.google.com/";
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS, referer });
    await solveCloudflareChallenge(page);
    await humanize(page, waitMs);
    const html = await page.content();
    const anti = detectAntibot(html.slice(0, 3000));
    if (isCfAnti(anti)) throw new Error(`反爬验证页(${anti.label}),降级 CLI 通道`);
    if (isAntibotContent(html.slice(0, 3000))) {
      throw new Error("反爬风控页(命中 40362/限制访问),降级 CLI 通道");
    }
    return html;
  } finally {
    await page.close().catch(() => {});
    if (pageContext) await pageContext.close().catch(() => {});
  }
}
