/**
 * engines/cnnews.mjs — 官方新闻源白名单引擎(带发布时间)
 *
 * 思路:绕开搜索引擎排序,直接抓官方信源列表页,从 URL 提取结构化日期,
 * 按"日期降序 + 关键词过滤"输出。针对通用搜索的三个短板:
 *  - 时效性:结果自带发布日期,可过滤陈旧新闻(默认只保留 30 天内)
 *  - 相关性:信源白名单(人民网系/共产党员网),无垃圾站/黄历/天气
 *  - 准确性:标题来自官方源原文,URL 可直接 fetch 溯源
 *
 * 信源选择标准:静态 HTML 可解析、本设备直连可用(已实测)。
 * 单源失败不影响其他源(allSettled)。
 */

import { httpGet } from "../http.mjs";
import { clean, decodeEntities, parseDateFromUrl, normalizeCnDate } from "../html.mjs";
import { CNNEWS_MAX_AGE_DAYS, CNNEWS_MAX_ITEMS_PER_SOURCE } from "../config.mjs";

/** 官方新闻源白名单(顺序即优先级,url 必须静态可解析) */
export const CN_NEWS_SOURCES = [
  { name: "人民网·时政", url: "http://politics.people.com.cn/" },
  { name: "人民网·党建", url: "http://cpc.people.com.cn/" },
  { name: "人民网首页", url: "http://www.people.com.cn/" },
  { name: "共产党员网", url: "https://www.12371.cn/" },
];

/** 导航/频道/页脚等非文章标题词,用于过滤列表页噪音 */
const NAV_WORDS =
  /登录|注册|首页|更多|关于我们|网站地图|English|微博|微信|客户端|邮箱|RSS|招聘|设为首页|加入收藏|版权所有|广告|举报|搜索|无障碍|简体|繁体|欢迎您|滚动|时政要闻|高层|人事|理论|党建|独家|视频|访谈|数字报|专题|图解|数据库|书刊|论坛/i;

/** 是否新闻文章 URL(过滤站内导航/数据库/专题页)。分站判断,避免 .htm 后缀兜底误伤库页 */
export function isArticleUrl(url) {
  const u = String(url || "").toLowerCase();
  if (u.includes("people.com.cn")) {
    // 人民网系:仅 /n{n}/ 路径的文章(GB 库/专题页排除)
    return /people\.com\.cn\/n\d+\//.test(u);
  }
  if (u.includes("12371.cn")) {
    return /12371\.cn\/20\d{2}\//.test(u);
  }
  return /\.(?:htm|shtml)$/.test(u);
}

/**
 * 从列表页 HTML 提取文章链接(标题+URL+日期)。
 * 相对链接按**源自身 URL** 补全(首页同频道链接多为相对路径,host 必须来自源);
 * 日期优先 URL 模式,回退标题内嵌日期。
 * @param {string} html
 * @param {string} sourceName 仅用于来源标注
 * @param {string} sourceUrl 该源列表页 URL,相对链接解析基准
 * @returns {Array<{title:string, url:string, date:string, source:string}>}
 */
export function extractNewsLinks(html, sourceName, sourceUrl) {
  const out = [];
  const seen = new Set();
  const re = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < CNNEWS_MAX_ITEMS_PER_SOURCE) {
    const title = clean(m[2]);
    if (!title || title.length < 8) continue;
    if (NAV_WORDS.test(title)) continue;
    let url = decodeEntities(m[1]);
    try {
      if (url.startsWith("//")) url = "http:" + url;
      else if (url.startsWith("/")) url = new URL(url, sourceUrl).href;
      if (!/^https?:/.test(url)) continue;
    } catch {
      continue;
    }
    if (!isArticleUrl(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    let date = parseDateFromUrl(url);
    if (!date) date = normalizeCnDate(title);
    out.push({ title, url, date, source: sourceName });
  }
  return out;
}

/**
 * 官方新闻源搜索。
 * 查询词为空 → 最新要闻(热点模式);非空 → 标题包含任一 token 的文章。
 * @returns {Promise<{engine:"cnnews", mode:"official", blocked:boolean, reason?:string, results:Array}>}
 */
export async function searchCnnews(query, limit) {
  const tokens = (query || "").split(/\s+/).filter(Boolean);
  const cutoff = Date.now() - CNNEWS_MAX_AGE_DAYS * 24 * 3600 * 1000;

  const fetched = await Promise.allSettled(
    CN_NEWS_SOURCES.map((s) => httpGet(s.url).then((html) => ({ s, html })))
  );

  let failed = 0;
  const all = [];
  for (const r of fetched) {
    if (r.status !== "fulfilled") {
      failed++;
      continue;
    }
    const { s, html } = r.value;
    for (const item of extractNewsLinks(html, s.name, s.url)) {
      if (item.date) {
        const t = new Date(`${item.date}T00:00:00`).getTime();
        if (Number.isNaN(t) || t < cutoff) continue; // 过期新闻剔除
      }
      if (tokens.length && !tokens.some((tk) => item.title.includes(tk))) continue;
      all.push(item);
    }
  }

  // 按日期降序(无日期排最后),同日期保持源顺序
  all.sort((a, b) => {
    if (a.date && b.date) return b.date.localeCompare(a.date);
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  });

  // 去重:URL 精确去重 + 转载标题去重(去标点后前 24 字符相同视为同文)
  const seenUrl = new Set();
  const seenTitle = new Set();
  const titleKey = (t) => t.replace(/[，。、·|｜\[\]【】()（）""''“”]/g, "").slice(0, 24);
  const results = [];
  for (const it of all) {
    if (seenUrl.has(it.url)) continue;
    const tk = titleKey(it.title);
    if (tk.length >= 12 && seenTitle.has(tk)) continue; // 仅对有效标题去重,防误伤短标题
    seenUrl.add(it.url);
    seenTitle.add(tk);
    results.push({ title: it.title, url: it.url, desc: it.source, date: it.date });
    if (results.length >= limit) break;
  }

  if (results.length === 0 && failed === CN_NEWS_SOURCES.length) {
    return {
      engine: "cnnews",
      mode: "official",
      blocked: true,
      reason: "全部官方源抓取失败(网络或反爬),尝试降级...",
      results: [],
    };
  }
  return { engine: "cnnews", mode: "official", blocked: false, results };
}
