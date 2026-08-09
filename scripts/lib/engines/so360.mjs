/**
 * engines/so360.mjs — 360 搜索(桌面 UA 直连)
 *
 * 反爬研究结论(实测):
 *  - 桌面 UA 直连 https://www.so.com/s?q= → 200,标准 HTML 结果页(~450KB)
 *  - 移动 UA 302 → m.so.com(移动版),故用桌面 UA
 *  - 结果链接为 https://www.so.com/link?m= 加密跳转(无法本地解码);
 *    但标题 <a> 上直接携带 data-mdurl 属性 = 真实 URL,优先取用,无需浏览器
 *  - 广告块特征:lianmeng-ad(联盟广告)
 *
 * 解析(桌面版 HTML):
 *  - 按 <li class="res-list 分割(含普通与新闻流 referer-news-flow,均为结果)
 *  - 标题: h3.res-title 内 <a>(含 <em> 高亮)
 *  - 真实 URL: data-mdurl(360 内部域名除外);缺失则保留 so.com/link?m= 加密链接(可打开)
 *  - 摘要: span.res-list-summary,回退 div.res-rich 整块
 *  - 时间: span.g-c-gray 内 "2026年1月5日" 格式
 *
 * 已知坑(2025-08 实测): SERP 内含 "AI 精选/智能推荐" 模块,<a href> 直接指向
 *  ai.so.com/search?search=... 搜索 URL(非真实结果目标),且 data-mdurl 缺失或为
 *  360 内部域名时不覆盖 link → 会原样混入结果。修复: href 为 360 内部域名时,
 *  仅放行 so.com/link?m= 加密跳转,其余内部 URL 一律剔除。
 */

import { clean, decodeEntities, extractSerpDate } from "../html.mjs";
import { createDirectEngine } from "./factory.mjs";
import { parseSerp } from "../parse-serp.mjs";

import { parseDomOr, elementText, queryOne, queryAll } from "../dom.mjs";

const SO360_URL = "https://www.so.com/s";
const BLOCKED_MIN_LEN = 8_000; // 风控/验证页远小于正常结果页(~450KB)

/** 360 系内部域名(导航/推荐/新闻流等非真实结果目标,过滤) */
export function isSo360Internal(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === "www.so.com" ||
      host.endsWith(".so.com") ||
      host.endsWith(".360.cn") ||
      host.endsWith(".360kan.com")
    );
  } catch {
    return true;
  }
}

/**
 * 解析 360 搜索页 HTML(直连/fixture 测试共用)。
 * 解析命中 0 条 → blocked:true + reason 提示结构可能变更。
 * @returns {{blocked:boolean, reason?:string, results:Array<{title,url,desc,date?}>}}
 */
export function parseSo360Html(html, limit) {
  // 风控检测(验证码页远小于正常结果页)
  if (html.length < BLOCKED_MIN_LEN || /安全验证|请输入验证码|验证码|captcha/i.test(html.slice(0, 2000))) {
    return { blocked: true, reason: "360 触发安全验证(反爬风控),尝试 baidu", results: [] };
  }
  const doc = parseDomOr(html);
  const results = [];
  for (const el of queryAll(doc, "li.res-list")) {
    if (results.length >= limit) break;
    // 广告块:联盟广告容器
    if (/lianmeng-ad/i.test(el.innerHTML.slice(0, 300))) continue;
    const h = queryOne(el, "h3.res-title a[href]");
    if (!h) continue;
    const title = clean(elementText(h));
    if (!title) continue;
    let link = decodeEntities(h.getAttribute("href") || "");
    // 真实 URL:data-mdurl(非 360 内部域名);缺失保留 so.com/link?m= 加密链接
    const muEl = queryOne(el, "a[data-mdurl]");
    const mu = muEl ? muEl.getAttribute("data-mdurl") || "" : "";
    if (mu && mu.startsWith("http") && !isSo360Internal(mu)) {
      link = decodeEntities(mu);
    }
    // 内部搜索/推荐 URL(ai.so.com/search?search=... 等“AI精选”模块)非真实结果,剔除;
    // 唯一合法内部链接是 so.com/link?m= 加密跳转(正常结果)。data-mdurl 为外部真实
    // URL 时 link 已被覆盖为外部域名,不会走到这里。
    if (isSo360Internal(link) && !/^https?:\/\/(?:www\.)?so\.com\/link\?/i.test(link)) continue;
    // 摘要:res-list-summary span,回退 res-rich div 整块文本
    let desc = "";
    const sm = queryOne(el, "span.res-list-summary");
    if (sm) desc = clean(elementText(sm));
    if (!desc) {
      const ri = queryOne(el, "div.res-rich");
      if (ri) desc = clean(elementText(ri));
    }
    // 时间:g-c-gray 内 "2026年1月5日" 格式;缺失时标题/摘要全文兜底(完整年月日格式严格)
    let date = "";
    const gc = queryOne(el, ".g-c-gray");
    if (gc) {
      const dm = elementText(gc).match(/(\d{4}年\d{1,2}月\d{1,2}日)/);
      if (dm) date = dm[1];
    }
    if (!date) date = extractSerpDate(title + " " + desc);
    results.push({ title, url: link, desc: desc.slice(0, 400), ...(date ? { date } : {}) });
  }
  if (results.length === 0) {
    return {
      blocked: true,
      reason: "360 页面解析命中 0 条:页面结构可能已变更,请运行 npm run fixtures 更新快照",
      results,
    };
  }
  return { blocked: false, results };
}

/**
 * 360 搜索(桌面 UA)。
 * @returns {Promise<{engine:"so360", mode:"web", blocked:boolean, reason?:string, results:Array}>}
 */
export const searchSo360 = createDirectEngine({
  name: "so360",
  mode: "web",
  buildUrl: (query) => `${SO360_URL}?q=${encodeURIComponent(query)}`,
  parse: (html, limit) => parseSerp(html, { engineKey: "so360", specific: parseSo360Html, limit, excludeHosts: ["www.so.com", "so.com"] }),
});
