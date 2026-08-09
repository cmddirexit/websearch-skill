/**
 * Browser fallback facade. It owns channel ordering and result classification;
 * channel-specific process and lifecycle details live in sibling modules.
 *
 * Order for rendered DOM: library driver -> Chromium CLI virtual-time pass ->
 * Chromium CLI real-time passes. Full-page fetches may try zendriver first.
 */

import { detectAntibot, detectNotFound, isCfAnti } from "../antiblock.mjs";
import {
  CLI_CF_ROUND1_MS,
  CLI_CF_TIMEOUT_MS,
  REP_FETCH_MIN_OK_CHARS,
} from "../config.mjs";
import { brief, dbg, dbgStep } from "../debug.mjs";
import { hostOf, markCfHost } from "../persist.mjs";
import { getDomViaCli } from "./browser-cli.mjs";
import {
  effectiveChromeUa,
  getBrowserDriver,
  getDomViaDriver,
  isBrowserAvailable,
  resolveChromiumPath,
} from "./browser-runtime.mjs";
import { getDomViaZendriver } from "./browser-zendriver.mjs";

export {
  closeBrowser,
  isBrowserAvailable,
  probeChromiumVersion,
  resolveChromiumPath,
} from "./browser-runtime.mjs";
export { STEALTH_INIT_SCRIPT } from "./browser-stealth.mjs";
export { bezierPath } from "./browser-humanize.mjs";

let lastBrowserFailure = "";

function setBrowserFailure(reason) {
  lastBrowserFailure = reason ? String(reason).slice(0, 200) : "";
}

export function getLastBrowserFailure() {
  return lastBrowserFailure;
}

/** Render a URL while preserving the established browser/CLI fallback order. */
export async function getDom(url, waitMs = 4000, opts = {}) {
  const { preferCli = false } = opts;
  const bin = resolveChromiumPath();
  if (!bin) return null;
  dbg(`getDom 入口: ${url} preferCli=${preferCli} waitMs=${waitMs}`);

  const ua = await effectiveChromeUa(bin);
  if (!preferCli) {
    const driver = await getBrowserDriver();
    if (driver) {
      try {
        const html = await dbgStep(
          "  库模式(getDomViaDriver)",
          () => getDomViaDriver(driver, url, waitMs, ua),
        );
        if (html) dbg(`  库模式: HTML ${brief(html)}`);
        if (html) setBrowserFailure("");
        return html;
      } catch (error) {
        setBrowserFailure(`库模式失败: ${String(error.message).slice(0, 100)}`);
        console.error(`[browser] 库模式失败(${error.message.slice(0, 60)}),降级 CLI...`);
      }
    }
  }

  // Virtual time handles JS countdown pages cheaply. Known CF pages skip it.
  if (!preferCli) {
    try {
      const html = await dbgStep(
        "  CLI 虚拟时间轮(virtual-time-budget)",
        () => getDomViaCli(bin, url, waitMs, ua, { virtualTime: true }),
      );
      if (html) {
        const anti = detectAntibot(html.slice(0, 20000));
        if (isCfAnti(anti)) {
          setBrowserFailure(`CLI 虚拟时间轮拿到 ${anti.label}(交互验证需真实等待)`);
          console.error(`[browser] CLI 首轮返回 ${anti.label},换真实等待重试...`);
          dbg(`  CLI 虚拟时间轮拿到 ${anti.label} → 换真实等待`);
        } else {
          dbg(`  CLI 虚拟时间轮成功: HTML ${brief(html)}`);
          setBrowserFailure("");
          return html;
        }
      }
    } catch (error) {
      setBrowserFailure(`CLI 虚拟时间轮失败: ${String(error.message).slice(0, 100)}`);
      console.error(`[browser] CLI 首轮失败: ${error.message}`);
    }
  }

  const realTimeRounds = [
    { timeoutMs: Math.max(CLI_CF_ROUND1_MS, waitMs * 3), label: "第二轮(45s)" },
    { timeoutMs: CLI_CF_TIMEOUT_MS, label: "第三轮(90s)" },
  ];
  for (const round of realTimeRounds) {
    try {
      const html = await dbgStep(
        `  CLI 真实等待轮(${round.label})`,
        () => getDomViaCli(bin, url, waitMs, ua, { virtualTime: false, timeoutMs: round.timeoutMs }),
      );
      if (!html) continue;
      const anti = detectAntibot(html.slice(0, 20000));
      if (isCfAnti(anti)) {
        setBrowserFailure(`CLI ${round.label}仍返回 ${anti.label}(站点验证未放行)`);
        console.error(`[browser] CLI ${round.label}仍返回 ${anti.label},继续下一轮...`);
        continue;
      }
      markCfHost(hostOf(url));
      setBrowserFailure("");
      return html;
    } catch (error) {
      setBrowserFailure(`CLI ${round.label}失败: ${String(error.message).slice(0, 100)}`);
      console.error(`[browser] CLI ${round.label}失败: ${error.message}`);
    }
  }
  setBrowserFailure("CLI 真实等待轮未取得非验证页(站点持续拦截或无正文)");
  return null;
}

async function extractRenderedPage(html, url, maxChars, channel) {
  const { extractBodyFromHtml } = await import("../fetch-page.mjs");
  const page = extractBodyFromHtml(html, maxChars, url);
  const body = (page?.markdown || page?.body || "").trim();
  if (page && body.length >= REP_FETCH_MIN_OK_CHARS) {
    dbg(`  ${channel}成功: HTML ${brief(html)} → 提取 ${brief(page)} ✅`);
    setBrowserFailure("");
    return { result: { ...page, url }, bodyLength: body.length };
  }
  const notFound = detectNotFound(html);
  return {
    result: notFound ? { url, notFound: true } : null,
    bodyLength: body.length,
    notFound,
  };
}

/** Fetch and extract a page through the browser fallback stack. */
export async function fetchViaBrowser(url, maxChars, opts = {}) {
  if (!(await isBrowserAvailable())) {
    setBrowserFailure("未检测到 Chromium 二进制(WEBSEARCH_BROWSER_PATH/PREFIX/系统路径均未命中)");
    return null;
  }
  dbg(`fetchViaBrowser 入口: ${url} preferCli=${opts.preferCli || false} skipZendriver=${opts.skipZendriver || false}`);

  if (!opts.skipZendriver) {
    const html = await dbgStep("  zendriver 快速通道", () => getDomViaZendriver(url));
    if (html) {
      const anti = detectAntibot(html.slice(0, 20000));
      if (!isCfAnti(anti)) {
        const extracted = await extractRenderedPage(html, url, maxChars, "zendriver ");
        if (extracted.result) {
          if (extracted.notFound) {
            dbg(`  zendriver 拿到 404 页(提取 ${extracted.bodyLength}字符)→ 确认 ${extracted.notFound.label},返回 notFound`);
            console.error(`[browser] zendriver 确认 ${extracted.notFound.label}`);
          }
          return extracted.result;
        }
        dbg(`  zendriver 拿到壳(提取 ${extracted.bodyLength}字符 < ${REP_FETCH_MIN_OK_CHARS})→ 继续降级`);
        setBrowserFailure(`zendriver 渲染后仍无正文(${extracted.bodyLength}字符,SPA 壳或反爬页)`);
      } else {
        markCfHost(hostOf(url));
      }
    }
  }

  const html = await dbgStep(
    "  getDom(库模式→虚拟时间→真实等待)",
    () => getDom(url, 4000, opts),
  );
  if (!html) {
    if (!lastBrowserFailure) {
      setBrowserFailure("getDom 三通道(库模式/虚拟时间/真实等待)均未取得渲染 HTML");
    }
    return null;
  }
  dbg(`  getDom 拿到 HTML ${brief(html)}`);
  const anti = detectAntibot(html.slice(0, 20000));
  if (isCfAnti(anti)) {
    markCfHost(hostOf(url));
    console.error(`[browser] 浏览器兜底拿到 ${anti.label}(未通过验证),视为失败`);
    setBrowserFailure(`站点 ${anti.label} 未能通过验证(浏览器已尽力,需换出口 IP/人工验证)`);
    return null;
  }

  const extracted = await extractRenderedPage(html, url, maxChars, "");
  if (extracted.result) {
    if (extracted.notFound) {
      dbg(`  提取失败/不足(${extracted.bodyLength}字符)→ 视为失败返回 null (${extracted.notFound.label})`);
      console.error(`[browser] 浏览器兜底确认 ${extracted.notFound.label}`);
    }
    return extracted.result;
  }
  dbg(`  提取失败/不足(${extracted.bodyLength}字符)→ 视为失败返回 null`);
  if (!lastBrowserFailure) {
    setBrowserFailure(`渲染后提取无正文(${extracted.bodyLength}字符,风控页/SPA 壳)`);
  }
  return null;
}
