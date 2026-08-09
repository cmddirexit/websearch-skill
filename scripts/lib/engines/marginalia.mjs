/**
 * engines/marginalia.mjs — Marginalia 英文独立索引搜索
 *
 * 为什么需要:本设备(中国 IP)上 bing/ecosia 等按出口 IP 地域返回中文结果,
 * 英文技术查询被中文内容污染(实测 "web scraping techniques" 仅 0/8 英文)。
 * Marginalia 是独立索引(非 Google/Bing 聚合),服务器在欧洲,专注英文、
 * 非商业化内容,不受 CN IP 地域影响 —— 实测同查询返回全英文高质量结果。
 *
 * 解析(HTML 版):
 *  - 标题+URL: <h2 class="text-md..."><a href="URL">标题</a></h2>
 *  - 摘要: h2 后最近 <p class="mt-2 text-sm...">文本</p>
 *  - 注意 &shy;(软连字符)在标题与显示 URL 中大量出现,decodeEntities 需移除
 */

import { httpGet } from "../http.mjs";
import { parseSerp } from "../parse-serp.mjs";
import { clean } from "../html.mjs";
import { detectAntibot } from "../antiblock.mjs";
import { MARGINALIA_TIMEOUT_MS, MARGINALIA_VERIFY_MIN_BYTES } from "../config.mjs";
import { parseDomOr, elementText, queryOne, queryAll, asElement } from "../dom.mjs";

const MARGINALIA_URL = "https://search.marginalia.nu/search";

/** 从单个 h2 块提取 {title, url};结构不匹配返回 null */
export function parseMarginaliaResult(h2Block) {
  const el = asElement(h2Block);
  if (!el) return null;
  const a = queryOne(el, "a[href]");
  if (!a) return null;
  const url = a.getAttribute("href") || "";
  const title = clean(elementText(a));
  if (!title || !url.startsWith("http")) return null;
  return { title, url };
}

/** 从 h2 块之后的片段提取摘要(p.mt-2),无则返回 "" */
export function extractMarginaliaDesc(following) {
  const el = asElement(following);
  if (!el) return "";
  const p = queryOne(el, "p.mt-2.text-sm");
  return p ? clean(elementText(p)) : "";
}

/**
 * 解析 marginalia 搜索页 HTML(新老界面兼容,直连与浏览器兜底共用):
 *  - 新界面:<h2 class="text-md..."><a href>标题</a></h2> + p.mt-2 摘要
 *  - 老界面/浏览器渲染后:<a class="title" href>标题</a>(无摘要)
 */
export function parseMarginaliaHtml(html, limit) {
  const doc = parseDomOr(html, []);
  const results = [];
  // 新界面:h2.text-md 结果块,摘要取紧随其后的兄弟容器(原实现为 h2 之后的片段)
  const h2s = queryAll(doc, "h2.text-md");
  for (let i = 0; i < h2s.length && results.length < limit; i++) {
    const r = parseMarginaliaResult(h2s[i]);
    if (!r) continue;
    const next = h2s[i].nextElementSibling;
    r.desc = next && next.tagName !== "H2" ? extractMarginaliaDesc(next).slice(0, 400) : "";
    results.push(r);
  }
  if (results.length >= limit) return results;
  // 老界面:a.title 锚点
  for (const a of queryAll(doc, "a.title")) {
    if (results.length >= limit) break;
    const url = a.getAttribute("href") || "";
    const title = clean(elementText(a));
    if (!url.startsWith("http") || !title) continue;
    results.push({ title, url, desc: "" });
  }
  if (results.length >= limit) return results;
  // 第三级备选:通用 h2>a 提取(结构大改时兜底)
  for (const a of queryAll(doc, "h2 a[href]")) {
    if (results.length >= limit) break;
    const url = a.getAttribute("href") || "";
    const title = clean(elementText(a));
    if (!url.startsWith("http") || !title) continue;
    results.push({ title, url, desc: "" });
  }
  return results;
}

/**
 * Marginalia 搜索。
 * 注意:marginalia 有温和限流与 JS 验证(倒计时页),直连可能间歇性失败:
 *  - 命中验证/限流页 → blocked:true + reason(调用方会继续降级或明确提示)
 *  - 浏览器兜底(Chromium)可执行 JS 过验证,完全可用
 * @returns {Promise<{engine:"marginalia", mode:"direct", blocked:boolean, reason?:string, results:Array}>}
 */
export async function searchMarginalia(query, limit) {
  const url = `${MARGINALIA_URL}?query=${encodeURIComponent(query)}&profile=default`;
  // marginalia 限流/验证时常间歇失败:快速失败让降级链尽快切浏览器兜底,不拖慢整体
  const html = await httpGet(url, { timeoutMs: MARGINALIA_TIMEOUT_MS });

  // 验证/限流/错误页检测:倒计时验证页、极小页、"manually proceed";
  // 用 antiblock 识别器给出反爬类型标签(降级日志 [degrade] 自动带上,策略更有针对性)
  const antibot = detectAntibot(html);
  if (html.length < MARGINALIA_VERIFY_MIN_BYTES || antibot) {
    return {
      engine: "marginalia",
      mode: "direct",
      blocked: true,
      reason: `marginalia 触发反爬:${antibot ? antibot.label : "短页(疑似验证/限流)"}(将尝试浏览器兜底)`,
      results: [],
    };
  }

  const parsed = parseSerp(html, { engineKey: "marginalia", specific: parseMarginaliaHtml, limit, excludeHosts: ["search.marginalia.nu"] });
  const { results, parsedBy, hitRate, specificCount, genericCount } = parsed;
  if (parsed.blocked) return { engine: "marginalia", mode: "direct", blocked: true, reason: parsed.reason, results: [], parsedBy: parsed.parsedBy || "none" };
  return {
    engine: "marginalia",
    mode: "direct",
    blocked: results.length === 0,
    reason: results.length === 0 ? "marginalia 无结果(关键词 AND 匹配,可精简查询词)" : undefined,
    results,
  };
}
