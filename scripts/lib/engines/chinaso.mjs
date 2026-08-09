/**
 * engines/chinaso.mjs — 中国搜索(央媒背景,官方色彩)
 *
 * 接入方案(2026-08,GitHub 调研 SearXNG chinaso.py 获得):
 *  - 官方 JSON API:`/v5/general/v1/web/search?q=&pn=&ps=`,带 uid cookie
 *    (base64(random 16B),SearXNG 同款)。实测直连成功:status:0, data.data[] 数组
 *  - 无 cookie 时返回 {"status":2,"msg":"ip control"}(IP 限);带 uid 后正常
 *  - 链接为 chinaso.com/link?url= 加密跳转(隐私追踪型,无法本地解码),保留原样(可打开)
 *  - 空结果:{"status":0,"msg":"empty result","data":{}}(合法空,非错误)
 *
 * 降级链:直连 JSON API → 浏览器渲染(SPA 无 SSR,Chrome dump-dom 实测有效) →
 * blocked。API 被 IP 限/网络异常时自动走浏览器,两者皆失败返回 blocked。
 *
 * 解析(API JSON):
 *  - data.data[] → title(含 <em> 高亮,需清理)/snippet/url/timestamp/source
 *  - timestamp 为 unix 秒;source 为新闻来源(中国天气网/BRTV 等)
 */

import { randomBytes } from "node:crypto";
import { clean, tsToDate } from "../html.mjs";
import { httpGetJson } from "../http.mjs";
import { parseSerp } from "../parse-serp.mjs";
import { parseDomOr, elementText, queryOne, queryAll } from "../dom.mjs";
import { getDom, isBrowserAvailable } from "./browser.mjs";

const CHINASO_API = "https://www.chinaso.com/v5/general/v1/web/search";
const CHINASO_URL = "https://www.chinaso.com/search/pagesearch.htm";
const BLOCKED_MIN_LEN = 8_000; // SPA 空壳(~70KB 含框架)远大于验证页,但风控页仍远小于正常渲染页

/** 时效过滤映射(SearXNG chinaso.py time_range_dict 同款):24h/1w/1m/1y → stime 取值 */
const SINCE_MAP = { "24h": "24h", "1w": "1w", "1m": "1m", "1y": "1y" };

/** 单条 API 结果 → 统一结果结构 */
function parseApiItem(entry) {
  const title = clean(entry.title || "");
  if (!title) return null;
  const url = entry.url || "";
  if (!url.startsWith("http")) return null;
  return {
    title,
    url,
    desc: clean(entry.snippet || "").slice(0, 400),
    ...(entry.source ? { source: entry.source } : {}),
    ...(entry.timestamp ? { date: tsToDate(entry.timestamp) } : {}),
  };
}

/**
 * 解析中国搜索渲染后 HTML(浏览器/fixture 测试共用)。
 * 解析命中 0 条 → blocked:true + reason 提示结构可能变更。
 * @returns {{blocked:boolean, reason?:string, results:Array<{title,url,desc,source?,date?}>}}
 */
export function parseChinasoHtml(html, limit) {
  if (html.length < BLOCKED_MIN_LEN) {
    return { blocked: true, reason: "中国搜索页面异常(风控/空壳),尝试 baidu", results: [] };
  }
  const doc = parseDomOr(html);
  const results = [];
  for (const el of queryAll(doc, ".search-list .list")) {
    if (results.length >= limit) break;
    const t = queryOne(el, "a.common-title[href]");
    if (!t) continue;
    const title = clean(elementText(t));
    if (!title) continue;
    const link = t.getAttribute("href") || "";
    if (!/^https?:\/\//.test(link)) continue;
    // 摘要:common-summary p(可能为空)
    const sm = queryOne(el, "p.common-summary");
    const desc = sm ? clean(elementText(sm)).slice(0, 400) : "";
    // 来源与时间:source 行(可能缺其一)
    const src = queryOne(el, "span.source-name");
    const tm = queryOne(el, "span.source-time");
    results.push({
      title,
      url: link,
      desc,
      ...(src && clean(elementText(src)) ? { source: clean(elementText(src)) } : {}),
      ...(tm && clean(elementText(tm)) ? { date: clean(elementText(tm)) } : {}),
    });
  }
  if (results.length === 0) {
    return {
      blocked: true,
      reason: "中国搜索页面解析命中 0 条:页面结构可能已变更,请运行 npm run fixtures 更新快照",
      results,
    };
  }
  return { blocked: false, results };
}

/** 直连官方 JSON API(SearXNG 同款:uid cookie 绕过 IP 限制) */
async function searchChinasoApi(query, limit, opts) {
  const uid = Buffer.from(randomBytes(16)).toString("base64");
  let url = `${CHINASO_API}?q=${encodeURIComponent(query)}&pn=1&ps=${Math.min(limit, 10)}`;
  // 时效过滤:stime=24h/1w/1m/1y + etime=now(实测有效,返回新闻类时效结果)
  const since = SINCE_MAP[opts?.since] || "";
  if (since) url += `&stime=${since}&etime=now`;
  const data = await httpGetJson(url, {
    headers: { Cookie: `uid=${uid}`, Referer: "https://www.chinaso.com/" },
  });
  // status:0 = 成功(空结果 data:{} 为合法空);status:2 = ip control(走浏览器兜底)
  if (data?.status !== 0) return null;
  const items = Array.isArray(data?.data?.data) ? data.data.data : [];
  const results = items.map(parseApiItem).filter(Boolean).slice(0, limit);
  return results.length ? { engine: "chinaso", mode: "json", blocked: false, results } : null;
}

/** 浏览器渲染兜底(API 被 IP 限 / 网络异常时) */
async function searchChinasoBrowser(query, limit) {
  if (!(await isBrowserAvailable())) return null;
  const url = `${CHINASO_URL}?q=${encodeURIComponent(query)}`;
  const html = await getDom(url, 6000); // 等 SPA 渲染 + 结果加载
  if (!html) return null;
  const parsed = parseSerp(html, { engineKey: "chinaso", specific: parseChinasoHtml, limit });
  return {
    engine: "chinaso",
    mode: "browser",
    blocked: parsed.blocked,
    reason: parsed.reason,
    results: parsed.results,
  };
}

/**
 * 中国搜索:直连 JSON API 优先,浏览器渲染兜底。
 * @param {{since?: "24h"|"1w"|"1m"|"1y"}} [opts] 时效过滤(24小时/1周/1月/1年)
 * @returns {Promise<{engine:"chinaso", mode:"json"|"browser", blocked:boolean, reason?:string, results:Array}>}
 */
export async function searchChinaso(query, limit, opts) {
  try {
    const r = await searchChinasoApi(query, limit, opts);
    if (r) return r;
  } catch {
    // API 网络/JSON 异常 → 浏览器兜底
  }
  const br = await searchChinasoBrowser(query, limit);
  if (br) return br;
  return { engine: "chinaso", mode: "json", blocked: true, reason: "中国搜索 API 被 IP 限制且浏览器不可用,尝试 baidu", results: [] };
}
