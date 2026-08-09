/**
 * engines/sm.mjs — 神马搜索(移动端直连)
 *
 * 反爬研究结论(实测):
 *  - 移动 UA 直连 https://m.sm.cn/s?q= → 200,标准 HTML 结果页(~545KB)
 *  - 结果均为直链(https://...),不走加密跳转——adclick 链接只在广告块(cpc_img)里
 *  - 广告块特征:class="cpc-a"(adclick 链接)+ "广告"角标 div.cpc-img-ad
 *
 * 解析(移动版 HTML):
 *  - 按 <div class="qk-card 分割结果卡片
 *  - 标题: div.qk-title-text(含 <em> 高亮)
 *  - URL: 标题内 a.qk-link-wrapper 的 href(直链;神马内部链接如 m.sm.cn/s?q= 过滤)
 *  - 摘要: div.qk-paragraph-text
 */

import { clean, decodeEntities, extractSerpDate } from "../html.mjs";
import { UA_MOBILE } from "../config.mjs";
import { createDirectEngine } from "./factory.mjs";
import { parseDomOr, elementText, queryOne, queryAll } from "../dom.mjs";
import { parseSerp } from "../parse-serp.mjs";

const SM_URL = "https://m.sm.cn/s";
const BLOCKED_MIN_LEN = 8_000;

/** 神马内部链接(相关搜索/频道等非结果目标,过滤) */
export function isSmInternal(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "m.sm.cn" || host.endsWith(".sm.cn") || host === "sm.cn";
  } catch {
    return true;
  }
}

/**
 * 解析神马搜索页 HTML(直连/fixture 测试共用)。
 * 解析命中 0 条 → blocked:true + reason 提示结构可能变更。
 * @returns {{blocked:boolean, reason?:string, results:Array<{title,url,desc}>}}
 */
export function parseSmHtml(html, limit) {
  if (html.length < BLOCKED_MIN_LEN || /安全验证|请输入验证码|验证码|captcha/i.test(html.slice(0, 2000))) {
    return { blocked: true, reason: "神马触发安全验证(反爬风控),尝试 baidu", results: [] };
  }
  // 风控检测(验证码页远小于正常结果页)
  if (html.length < BLOCKED_MIN_LEN || /安全验证|请输入验证码|验证码|captcha/i.test(html.slice(0, 2000))) {
    return { blocked: true, reason: "神马触发安全验证(反爬风控),尝试 baidu", results: [] };
  }
  const doc = parseDomOr(html);
  const results = [];
  for (const el of queryAll(doc, "div.qk-card")) {
    if (results.length >= limit) break;
    // 广告块:adclick 链接或"广告"角标
    if (/adclick|>广告</i.test(el.innerHTML.slice(0, 1000))) continue;
    const a = queryOne(el, "a.qk-link-wrapper[href]");
    if (!a) continue;
    const link = decodeEntities(a.getAttribute("href") || "");
    if (!link.startsWith("http") || isSmInternal(link)) continue;
    // 标题:qk-title-text div(在 a 内或紧随其后)
    const tm = queryOne(a, ".qk-title-text");
    const title = tm ? clean(elementText(tm)) : clean(elementText(a));
    if (!title) continue;
    // 摘要:qk-paragraph-text div
    const pm = queryOne(el, ".qk-paragraph-text");
    const desc = pm ? clean(elementText(pm)).slice(0, 400) : "";
    // 日期:标题/摘要全文兜底(完整年月日格式严格,散文年份不会误报)
    const date = extractSerpDate(title + " " + desc);
    results.push({ title, url: link, desc, ...(date ? { date } : {}) });
  }
  if (results.length === 0) {
    return {
      blocked: true,
      reason: "神马页面解析命中 0 条:页面结构可能已变更,请运行 npm run fixtures 更新快照",
      results,
    };
  }
  return { blocked: false, results };
}

/**
 * 神马搜索(移动端)。工厂直连。
 * @returns {Promise<{engine:"sm", mode:"mobile", blocked:boolean, reason?:string, results:Array}>}
 */
export const searchSm = createDirectEngine({
  name: "sm",
  mode: "mobile",
  buildUrl: (query) => `${SM_URL}?q=${encodeURIComponent(query)}`,
  parse: (html, limit) => parseSerp(html, { engineKey: "sm", specific: parseSmHtml, limit, excludeHosts: ["m.sm.cn", "www.sm.cn"] }),
  headers: { "User-Agent": UA_MOBILE },
});
