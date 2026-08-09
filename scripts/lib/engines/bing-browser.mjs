/**
 * engines/bing-browser.mjs — bing 浏览器版搜索
 *
 * 从 browser.mjs 拆出(职责分离:browser.mjs 只留浏览器基础设施):
 * 直连被反爬(地域污染/风控)时用浏览器渲染搜索结果页,复用直连解析器。
 * 与直连输出 shape 一致 {engine, mode, blocked, reason?, results},含站群过滤/污染检测。
 */

import { isBrowserAvailable, getDom } from "./browser.mjs";
import { parseBingHtml, dedupeZhResults, isLangPolluted } from "./bing.mjs";

/** 用浏览器执行 bing 搜索(复用直连解析器)。不可用返回 null */
export async function searchBingViaBrowser(query, limit) {
  if (!(await isBrowserAvailable())) return null;
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN&ensearch=0&count=${limit}`;
  const html = await getDom(url, 4000);
  if (!html) return null;
  const { blocked, results } = parseBingHtml(html, limit);
  const out = {
    engine: "bing",
    mode: "browser",
    blocked,
    reason: blocked ? "浏览器版 bing 无结构化结果" : undefined,
    results,
  };
  // 与直连同样的中文站群过滤/英文污染检测,保证浏览器通道输出一致
  if (!blocked && results.length > 0) {
    if (/[\u4e00-\u9fff]/.test(query)) {
      const { good, junkCount } = dedupeZhResults(results);
      if (good.length === 0) {
        return { ...out, polluted: true, reason: "疑似站群劫持", results: [] };
      }
      if (junkCount > 0) return { ...out, results: good, note: `已过滤 ${junkCount} 条近似重复(疑似站群/转载)` };
    } else if (isLangPolluted(query, results)) {
      return { ...out, polluted: true, reason: "地域语言污染", results: [] };
    }
  }
  return out;
}
