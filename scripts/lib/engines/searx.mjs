/**
 * searx.mjs — SearXNG 公共实例搜索(聚合 Google/Bing/DDG/Wikipedia 等 70+ 引擎)
 *
 * 价值:直连拿不到的 Google 结果,通过 SearXNG 实例聚合获得(实测 priv.au 质量高)。
 * 实现要点:
 *  - 实例列表 SEARX_INSTANCES(按质量排序),可环境变量 SEARX_INSTANCE 指定
 *  - 直连 JSON API 优先(部分实例未禁 JSON,快);403/antibot → 无头浏览器渲染
 *  - 浏览器渲染用 browser.mjs 的 getDom(共享 chromium 实例,复用 marginalia 的过验证经验)
 *  - 解析:article.result 块,h3>a 为原始 URL+标题(display 链接 web.archive 只是 cache_link)
 *  - 实例级降级:当前实例无结果/验证失败 → 自动换下一个
 *
 * 注意:公共实例随时可能挂/限流(429/antibot),引擎内静默降级,聚合层不感知。
 */

import { getDom, isBrowserAvailable } from "./browser.mjs";
import { parseSerp } from "../parse-serp.mjs";
import { SEARX_BROWSER_TIMEOUT_MS } from "../config.mjs";
import { withBudget } from "../budget.mjs";
import { parseDomOr, elementText, queryOne, queryAll } from "../dom.mjs";

/** 公共实例列表(按质量/稳定性排序;可换环境变量 SEARX_INSTANCE) */
const SEARX_INSTANCES = (process.env.SEARX_INSTANCE || "https://priv.au,https://searxng.site")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** 每个实例的浏览器渲染等待(ms):SearXNG 结果渲染较慢 */
const SEARX_WAIT_MS = 10000;
/** JSON 直连超时(antibot 实例快速失败,不等默认 fetch 超时) */
const JSON_TIMEOUT_MS = 3000;

/**
 * 解析 SearXNG HTML:article.result 块 → {title, url, desc, engines}
 * h3>a 是原始 URL(display 的 web.archive 链接只是 cache_link)。
 */
export function parseSearxHtml(html, limit) {
  const doc = parseDomOr(html, []);
  const results = [];
  for (const block of queryAll(doc, "article.result")) {
    if (results.length >= limit) break;
    const h3 = queryOne(block, "h3 a[href]");
    if (!h3) continue;
    const url = h3.getAttribute("href") || "";
    const title = clean(elementText(h3));
    if (!title || !/^https?:\/\//.test(url)) continue;
    const descEl = queryOne(block, ".content");
    const desc = descEl ? clean(elementText(descEl)).replace(/\s+/g, " ").trim() : "";
    const engEl = queryOne(block, ".engines");
    const engines = engEl ? clean(elementText(engEl)).trim() : "";
    results.push({ title, url, desc: engines ? `${desc} [via ${engines}]`.trim() : desc });
  }
  return results;
}

/** 单实例浏览器搜索(失败返回 null 由调用方换实例) */
async function searchInstance(query, limit, base) {
  const url = `${base}/search?q=${encodeURIComponent(query)}`;
  const html = await getDom(url, SEARX_WAIT_MS);
  if (!html) return null;
  const parsed = parseSerp(html, { engineKey: "searx", specific: parseSearxHtml, limit });
  return parsed.blocked || parsed.results.length === 0 ? null : parsed.results;
}

/**
 * SearXNG 搜索(实例列表顺序尝试)。
 * @returns {Promise<{engine:"searx", mode:"direct"|"browser", blocked:boolean, reason?:string, results:Array}>}
 */
export async function searchSearx(query, limit) {
  const perPage = Math.min(limit || 10, 30);
  const errors = [];

  // 1) 直连 JSON API(部分实例未禁用;antibot 实例 3s 内快速失败)——并行试全部实例,
  //    串行 2×3s 会浪费聚合预算,并行最坏也是 3s
  const jsonResults = await Promise.allSettled(
    SEARX_INSTANCES.map(async (base) => {
      try {
        const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`;
        const res = await fetch(url, {
          signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) WebSearchSkill/1.0", Accept: "application/json" },
        });
        if (res.ok) {
          const j = await res.json();
          const hits = j?.results || [];
          if (hits.length > 0) {
            return hits.slice(0, perPage).map((r) => ({
              title: r.title,
              url: r.url,
              desc: r.content ? `${r.content.slice(0, 200)}${r.engine ? ` [via ${r.engine}]` : ""}` : (r.engine ? `[via ${r.engine}]` : ""),
            }));
          }
        }
      } catch { /* 继续下一实例 */ }
      return null;
    })
  );
  const direct = jsonResults.find((r) => r.status === "fulfilled" && r.value?.length > 0);
  if (direct) {
    return { engine: "searx", mode: "direct", blocked: false, results: direct.value };
  }

  // 2) 无头浏览器渲染(过 antibot/JS 验证)——只试质量最高的第一个实例,且硬上限
  //    SEARX_BROWSER_TIMEOUT_MS(公共实例不可达/慢时快速失败,不阻塞聚合;
  //    串行多实例实测手机端可拖 30s+ 且无梯子时必败,试一个足够判断)。
  if (!(await isBrowserAvailable())) {
    return { engine: "searx", mode: "browser", blocked: true, reason: `无浏览器兜底(${errors[0] || "JSON 不可用"})`, results: [] };
  }
  try {
    const base = SEARX_INSTANCES[0];
    const results = await withBudget(searchInstance(query, perPage, base), SEARX_BROWSER_TIMEOUT_MS, "searx-browser");
    if (results) {
      return { engine: "searx", mode: "browser", blocked: false, results };
    }
  } catch {
    /* 超时/失败 → 快速放弃 */
  }
  return { engine: "searx", mode: "browser", blocked: true, reason: "SearXNG 实例不可达或渲染超时(无梯子/实例维护),已快速放弃", results: [] };
}
