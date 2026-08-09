/**
 * engines/marginalia-browser.mjs — marginalia 浏览器版搜索
 *
 * 从 browser.mjs 拆出(职责分离:browser.mjs 只留浏览器基础设施):
 * marginalia 有 1 秒 JS 倒计时验证,直连(时间戳求解)失败时用浏览器渲染兜底。
 */

import { isBrowserAvailable, getDom } from "./browser.mjs";
import { parseMarginaliaHtml } from "./marginalia.mjs";

/** 用浏览器执行 marginalia 搜索(可过 1 秒 JS 倒计时验证)。不可用返回 null */
export async function searchMarginaliaViaBrowser(query, limit) {
  if (!(await isBrowserAvailable())) return null;
  const url = `https://search.marginalia.nu/search?query=${encodeURIComponent(query)}&profile=default`;
  const html = await getDom(url, 6000); // 等 JS 验证 + 结果渲染
  if (!html) return null;
  const results = parseMarginaliaHtml(html, limit);
  return {
    engine: "marginalia",
    mode: "browser",
    blocked: results.length === 0,
    reason: results.length === 0 ? "浏览器版 marginalia 无结果" : undefined,
    results,
  };
}
