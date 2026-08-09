/**
 * engines/trending.mjs — GitHub Trending 热门项目榜(直连,无 API key)
 *
 * 实测:
 *  - https://github.com/trending?since=daily|weekly|monthly 服务器渲染 HTML(~630KB),
 *    默认桌面 UA 直连 200,无风控
 *  - 条目边界:<article class="Box-row">
 *  - 仓库名:h2 内 <a href="/owner/repo">
 *  - 描述:<p class="col-9 ...">
 *  - 今日新增 star:"N stars today/this week/this month"(橙色 ▲,页面只给增量不给总 star)
 *  - 语言:<span itemprop="programmingLanguage">
 *
 * 与 github(仓库搜索)互补:github 按关键词搜仓库,trending 给"最近热门"榜单。
 */

import { httpGet } from "../http.mjs";
import { clean } from "../html.mjs";
import { parseDomOr, elementText, queryOne, queryAll } from "../dom.mjs";

const TRENDING_URL = "https://github.com/trending";
/** 合法 since 值 → URL 参数;default=daily */
export const TRENDING_SINCE = ["daily", "weekly", "monthly"];

/**
 * 解析 GitHub Trending 页 HTML(fixture 测试共用,纯函数)。
 * @param {string} html
 * @param {number} limit
 * @returns {Array<{rank, name, url, desc, starsDelta, lang}>} starsDelta=纯数字增量(单位由调用方按 since 定)
 */
export function parseGithubTrending(html, limit) {
  const doc = parseDomOr(html, []);
  const out = [];
  for (const b of queryAll(doc, "article.Box-row")) {
    if (out.length >= limit) break;
    const h = queryOne(b, "h2 a[href]");
    if (!h) continue;
    const href = h.getAttribute("href") || "";
    const name = href.replace(/^\//, "").replace(/\/$/, "");
    // 过滤非 owner/repo 形态(如 /trending/xxx 语言筛选链接)
    if (!/^[^/]+\/[^/]+$/.test(name) || /^trending\//.test(name)) continue;
    const d = queryOne(b, "p.col-9");
    const desc = d ? clean(elementText(d)).slice(0, 300) : "";
    const deltaM = elementText(b).match(/([\d,]+)\s*stars?\s+(?:today|this week|this month)/);
    const langEl = queryOne(b, "span[itemprop='programmingLanguage']");
    out.push({
      rank: out.length + 1,
      name,
      url: `https://github.com/${name}`,
      desc,
      starsDelta: deltaM ? deltaM[1] : "",
      lang: langEl ? clean(elementText(langEl)).trim() : "",
    });
  }
  return out;
}

export async function fetchGithubTrending(since = "daily", limit = 15) {
  const s = TRENDING_SINCE.includes(since) ? since : "daily";
  const url = s === "daily" ? TRENDING_URL : `${TRENDING_URL}?since=${s}`;
  try {
    const html = await httpGet(url);
    const items = parseGithubTrending(html, Math.min(limit, 25));
    if (items.length === 0) {
      return { name: "github-trending", error: "解析命中 0 条(Trending 页面结构可能变更)", items: [] };
    }
    const unit = s === "daily" ? "今日" : s === "weekly" ? "本周" : "本月";
    items.forEach((x) => (x.deltaUnit = unit));
    return { name: "github-trending", note: unit, items };
  } catch (e) {
    return { name: "github-trending", error: (e.message || e).slice(0, 80), items: [] };
  }
}
