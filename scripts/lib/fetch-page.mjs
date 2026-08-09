/**
 * fetch-page.mjs — 网页正文提取
 *
 * 主提取器:Mozilla 官方 Readability(Firefox 阅读模式同款)
 *   - jsdom 解析 DOM → Readability 逐节点文本密度/链接密度评分
 *   - 返回 title/byline/excerpt/textContent,对复杂页面(门户/SPA 布局)鲁棒
 *   - 解析失败或结果无效 → 自动回退自研正则方案(见 extractBodyRegex)
 *
 * 两条入口共用同一提取器:
 *   - 直连: httpGetFull → extractBodyFromHtml
 *   - 浏览器: chromium getDom(JS 渲染后 HTML)→ extractBodyFromHtml
 */

import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { httpGetFull } from "./http.mjs";
import { clean, extractMetaDescription, extractTitle, stripTags, parseDateFromUrl, normalizeCnDate, extractSerpDate } from "./html.mjs";
import { parseDom, elementText, queryAll, queryOne } from "./dom.mjs";
import { pickDate, recordFetchOutcome } from "./date-ml.mjs";
import { MIN_CONTAINER_CHARS, MAX_BODY_CHARS } from "./config.mjs";

// ==================== 列表页提取(频道/滚动/聚合页) ====================
// 背景:新闻频道页/滚动列表页(中新网首页、国际在线滚动频道等)不是文章结构,
// Readability/正则正文提取只能拿到版权壳或时间戳序列 —— 但页面 HTML(直连或
// 浏览器渲染后)里明明有完整新闻列表(<a> 标题 + 链接)。这类页面按"链接列表"
// 输出,比空壳/时间戳有用得多,也避免为拿列表白跑浏览器兜底。
// 实现原则:只用 DOM 遍历(linkedom)定位结构,不用正则抠 HTML 标签 ——
// 属性顺序/嵌套/实体变化都影响不了 DOM API。文本级日期识别不可避免用正则。

/** 列表页判定:正文低于此字符数视为"空壳/版权壳"(中新网首页实测 127 字符版权声明) */
export const LIST_SHELL_MAX_CHARS = 220;
/** 列表页判定:正文低于此字符且链接文本总量远超正文时,视为"列表主导页"(滚动频道页时间戳流) */
export const LIST_DOMINANT_MAX_CHARS = 1200;
/** 列表条目最少数量:少于它不切换(避免把短文章页的推荐链接误当列表) */
export const LIST_MIN_ITEMS = 3;
/** 标题长度范围(短于 5 = 图标/单字导航;长于 80 = 异常) */
export const LIST_TITLE_MIN = 5;
export const LIST_TITLE_MAX = 80;

/** 导航容器标签(排除用) */
const NAV_TAGS = new Set(["NAV", "HEADER", "FOOTER", "ASIDE"]);
/** 常见导航类名片段(排除用,宁缺勿滥 —— 误排除最多丢几条,误包含则列表变脏) */
const NAV_CLASS_RE = /(^|[-_]?)(nav|navbar|menu|breadcrumb|pagination|toolbar|topbar|footer|header|sidebar|category|channel|crumbs)([-_]?$)/i;
/** 功能/导航链接文本(首页/登录/更多…) */
const NAV_TEXT_RE = /^(首页|网站首页|登录|注册|搜索|更多|全部|返回|下一页|上一页|关于我们|联系我们|设为首页|收藏本站|English|手机版|客户端|APP|微信|微博|邮箱|版权|免责声明|隐私政策|网站地图|RSS|招聘|加入我们|帮助|客服|评论|点赞|分享|转发|打印|字号|大|中|小|繁体|简体|进入|详情|阅读全文|read\s*more|more)$/i;

/** 文章相似度打分(URL 形态):日期路径/长数字 id/文章后缀 = 内容页信号。
 * 分数 ≥ 1 才收;分数高排序靠前。纯 URL 字符串分析,无站点知识。 */
export function linkArticleScore(url) {
  const path = url.pathname;
  let s = 0;
  if (/\/(20\d{2})[\/\-](\d{1,2})[\/\-](\d{1,2})/.test(path)) s += 3; // 日期路径(新闻站惯例)
  if (/\/\d{4,}\//.test(path)) s += 2; // 长数字 id(文章/条目 id)
  if (/\.(s?html?|shtm)$/i.test(path)) s += 1; // 静态文章后缀
  const segs = path.split("/").filter(Boolean);
  if (segs.length >= 3) s += 1; // 深层路径(频道/栏目/条目)
  if (segs.length === 2 && !/\.\w+$/.test(segs[1])) s -= 1; // 二级栏目根(/gn/ /gj/ 频道入口)
  return s;
}

/** 是否处于导航/页脚容器(上溯最多 5 层):标签名 + class 双信号 */
function inNavContext(a) {
  let el = a.parentElement;
  for (let depth = 0; el && depth < 5; el = el.parentElement, depth++) {
    if (NAV_TAGS.has(el.tagName)) return true;
    const cls = el.classList;
    if (cls) {
      for (const c of cls) {
        if (NAV_CLASS_RE.test(c)) return true;
      }
    }
  }
  return false;
}

/** 条目附近的时间文本:优先 <time datetime> 属性,其次容器内 class 含 time/date 的元素文本,
 * 最后容器文本前 60 字符(新闻列表常在标题旁显示 "08-07 10:30" 或 "2026-08-07")。
 * 返回 "YYYY-MM-DD" 或相对时间原文("昨天"/"3小时前"),无 → ""。 */
export function nearbyDate(a) {
  const container = a.parentElement?.parentElement || a.parentElement;
  if (container) {
    const time = queryOne(container, "time[datetime]");
    const dt = time?.getAttribute?.("datetime") || "";
    const fromAttr = dt ? extractSerpDate(dt) : "";
    if (fromAttr) return fromAttr;
    const dateEl = queryOne(container, "[class*='time'],[class*='date'],[class*='Time'],[class*='Date']");
    if (dateEl) {
      const d = extractSerpDate(elementText(dateEl));
      if (d) return d;
    }
  }
  // 容器内非链接文本(标题旁的时间文本)
  const t = container ? elementText(container).slice(0, 60) : "";
  return extractSerpDate(t);
}

/**
 * 列表页链接提取(DOM 遍历,非正则):收集页面上文章形态的 <a> 链接 + 标题 + 日期。
 * 过滤:导航容器、功能性链接、短标题、重复 URL、非内容页 URL。
 * 排序:有日期的按日期倒序(新闻列表惯例最新在前),无日期保持文档顺序。
 * @param {string} html
 * @param {string} [baseUrl] 解析相对链接的基准(传页面 URL)
 * @returns {{items:Array<{title:string,url:string,date:string,score:number}>}}
 */
export function extractLinkList(html, baseUrl = "") {
  const doc = parseDom(html);
  if (!doc) return { items: [] };
  const anchors = queryAll(doc, "a[href]");
  if (anchors.length === 0) return { items: [] };
  const seenUrl = new Set();
  const seenTitle = new Set();
  const items = [];
  for (const a of anchors) {
    let url;
    try {
      url = baseUrl ? new URL(a.getAttribute("href"), baseUrl) : new URL(a.getAttribute("href"));
      if (!/^https?:$/.test(url.protocol)) continue; // javascript:/mailto:/# 排除
    } catch {
      continue; // 非法 URL
    }
    if (inNavContext(a)) continue;
    const title = clean(elementText(a));
    if (title.length < LIST_TITLE_MIN || title.length > LIST_TITLE_MAX) continue;
    if (NAV_TEXT_RE.test(title)) continue;
    url.hash = "";
    const ukey = url.toString().replace(/\/$/, "");
    if (seenUrl.has(ukey)) continue;
    seenUrl.add(ukey);
    const score = linkArticleScore(url);
    if (score < 1) continue;
    // 标题近重复(同文镜像/转载链接)折叠
    const tkey = title.replace(/[\s\u3000]+/g, "");
    if (seenTitle.has(tkey)) continue;
    seenTitle.add(tkey);
    const date = nearbyDate(a) || parseDateFromUrl(url.toString());
    items.push({ title, url: url.toString(), date, score });
  }
  // 有日期的按日期倒序(新闻列表最新在前),无日期保持文档顺序(门户首页通常即时间倒序)
  const dated = items.filter((i) => i.date).sort((x, y) => y.date.localeCompare(x.date));
  const undated = items.filter((i) => !i.date);
  return { items: [...dated, ...undated] };
}

/** 列表结果 → 统一抓取结果契约({title, metaDesc, body, markdown, publishedAt, isList, listCount}) */
function buildListResult(items, html, maxChars, url) {
  const newest = items.find((i) => i.date)?.date || "";
  const withDate = items.filter((i) => i.date).length;
  const datePrefix = withDate >= Math.ceil(items.length * 0.4); // 多数条目有日期才加前缀(保持整洁)
  const md = items
    .map((i) => (datePrefix && i.date ? `- ${i.date} [${i.title}](${i.url})` : `- [${i.title}](${i.url})`))
    .join("\n");
  const body = items.map((i) => `${i.date && datePrefix ? i.date + " " : ""}${i.title}`).join("\n");
  const r = {
    title: extractTitle(html),
    metaDesc: extractMetaDescription(html),
    body,
    markdown: md,
    publishedAt: newest,
    isList: true,
    listCount: items.length,
  };
  const { body: b2, markdown: m2 } = clampLength(body, md, maxChars);
  return { ...r, body: b2, markdown: m2 };
}

// HTML → Markdown(LLM/agent 友好输出:保留标题层级/链接/表格/代码块)
const turndown = new TurndownService({
  headingStyle: "atx", // # 标题
  codeBlockStyle: "fenced", // ``` 代码块
  bulletListMarker: "-",
});

/** 按 maxChars 截断,返回 {body, markdown} */
function clampLength(body, markdown, maxChars) {
  const cap = Math.min(maxChars, MAX_BODY_CHARS);
  return { body: body.slice(0, cap), markdown: markdown.slice(0, cap) };
}

/** 剥离干扰标签(正则方案用,嵌套安全:成对匹配) */
function stripChromeTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(nav|header|footer|iframe|noscript|form|aside)[^>]*>[\s\S]*?<\/\1>/gi, " ");
}

/**
 * Readability 提取(主方案)。失败/无效返回 null,由调用方回退。
 * title 修正:Readability 优先 og:title(如 GitHub og:title 是 slogan),
 * 当其等于 og:title 且 <title> 不同时,<title> 更可信。
 * @returns {{title, metaDesc, body, markdown}|null}
 */
export function extractBodyWithReadability(html, maxChars, url = "") {
  try {
    const dom = new JSDOM(html, { url: url || "about:blank" });
    const article = new Readability(dom.window.document).parse();
    if (!article?.textContent) return null;
    const body = article.textContent.replace(/\s+/g, " ").trim();
    if (body.length < MIN_CONTAINER_CHARS) return null;
    // markdown:由 Readability 的 article.content(已剔除导航/广告)直接转换
    let markdown = body;
    try {
      markdown = turndown.turndown(article.content).trim();
    } catch {
      /* turndown 异常 → 用纯文本兜底 */
    }
    const rawTitle = extractTitle(html);
    const ogTitle = (html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i) || [])[1];
    let title = article.title || rawTitle;
    if (ogTitle && title === ogTitle && rawTitle && rawTitle !== ogTitle) {
      title = rawTitle; // og:title 是站点标语等,<title> 更可信
    }
    return {
      title,
      metaDesc: article.excerpt || extractMetaDescription(html),
      ...clampLength(body, markdown, maxChars),
    };
  } catch {
    return null; // 畸形 HTML / jsdom 异常 → 回退正则
  }
}

/**
 * 自研正则方案(回退):分层容器策略。
 * 1. 剥离干扰标签 2. article/main 语义容器 3. class 容器 4. body 全文
 * @returns {{title, metaDesc, body, markdown}|null}
 */
export function extractBodyRegex(html, maxChars) {
  try {
    const cleaned = stripChromeTags(html);
    let body = "";
    const semantic = cleaned.match(/<(article|main)[^>]*>[\s\S]*?<\/\1>/i);
    if (semantic) body = stripTags(semantic[0]);
    if (!body || body.length < MIN_CONTAINER_CHARS) {
      const klass = cleaned.match(
        /<div[^>]*class="[^"]*(?:content|article|post|entry|markdown-body|article-content|post-content)[^"]*"[^>]*>[\s\S]*?<\/div>/i
      );
      if (klass) body = stripTags(klass[0]);
    }
    if (!body || body.length < MIN_CONTAINER_CHARS) {
      body = stripTags(cleaned);
    }
    if (!body.trim()) return null;
    return {
      title: extractTitle(html),
      metaDesc: extractMetaDescription(html),
      // 正则回退无 DOM 结构:markdown 即纯文本(无层级/链接标记)
      ...clampLength(body, body, maxChars),
    };
  } catch {
    return null;
  }
}

/**
 * 从页面提取发布时间(YYYY-MM-DD)。规则版(保持向后兼容/单测用):
 * meta article:published_time 优先 → URL → 正文中文日期。
 * 注意:fetch 主路径已改用 date-ml 的 pickDate(多候选 + 列表页识别),
 * 避免频道页 meta 误导(国际在线滚动频道 meta 2018-03-28,实际列表 2026-08-07)。
 */
export function extractPublishedAt(html, url = "") {
  const m = html.match(/<meta[^>]*property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i);
  if (m) {
    const t = new Date(m[1]);
    if (!Number.isNaN(t.getTime())) return t.toISOString().slice(0, 10);
  }
  const u = parseDateFromUrl(url);
  if (u) return u;
  const r = html.match(/(20\d{2})[年\/\-.]?(\d{1,2})[月\/\-.]?(\d{1,2})[日]?/);
  if (r) {
    const d = normalizeCnDate(r[0]);
    if (d) return d;
  }
  return "";
}

/**
 * 从任意 HTML 提取正文(Readability 优先,正则回退),附带发布时间。
 * @returns {{title:string, metaDesc:string, body:string, markdown:string, publishedAt:string}}
 */
/**
 * 通用 SSR 内嵌数据槽提取:现代 SSR 页面把结构化数据内嵌 <script> 标签,
 * 比抠 DOM 稳且常含 DOM 没有的字段。支持(按优先级):
 *   1. js-initialData(知乎等自定义 SSR)
 *   2. __NEXT_DATA__(Next.js)
 *   3. window.__INITIAL_STATE__ / window.__NUXT__(Vue/Nuxt 系)
 * 返回解析后的 JSON 或 null(解析失败/无数据槽)。
 */
export function extractSsrEmbeddedJson(html) {
  if (!html) return null;
  // 1. js-initialData(知乎等)
  let m = html.match(/<script id="js-initialData" type="text\/json">([\s\S]*?)<\/script>/);
  if (m) {
    try {
      return JSON.parse(m[1]);
    } catch { /* 换下一种 */ }
  }
  // 2. __NEXT_DATA__(Next.js 通用约定)
  m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (m) {
    try {
      return JSON.parse(m[1]);
    } catch { /* 换下一种 */ }
  }
  // 3. window.__INITIAL_STATE__ / window.__NUXT__(Vue/Nuxt 系,对象字面量)
  m = html.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?})\s*;?\s*<\/script>/);
  if (m) {
    try {
      return JSON.parse(m[1]);
    } catch { /* 换下一种 */ }
  }
  return null;
}

/**
 * 知乎文章页 SSR 数据提取:基于通用 extractSsrEmbeddedJson,
 * 取 initialState.entities.articles 的正文 HTML(干净,含标题/点赞/评论),比 DOM 抠取稳 ——
 * 实测 2026-08 知乎文章页可抓(未登录+干净 chromium CLI + 版本匹配 UA + 低频单次),
 * js-initialData 必含结构化正文。返回 null 表示非知乎/无数据,走通用提取。
 */
export function extractZhihuInitialData(html) {
  const j = extractSsrEmbeddedJson(html);
  if (!j) return null;
  try {
    const arts = j?.initialState?.entities?.articles;
    if (!arts) return null;
    const a = Object.values(arts)[0];
    const content = a?.content;
    if (!content) return null;
    const title = a.title || "";
    // content 是正文 HTML:转 markdown + 纯文本(与通用提取器输出契约一致)
    let markdown = content;
    try {
      markdown = turndown.turndown(content).trim();
    } catch { /* turndown 异常 → 纯文本兑底 */ }
    const body = stripTags(content).replace(/\s+/g, " ").trim();
    // created 是秒级时间戳(知乎 API 惯例):<1e12(≈2001年)视为秒,否则毫秒
    const created = Number(a.created);
    const publishedAt = created
      ? new Date(created < 1e12 ? created * 1000 : created).toISOString().slice(0, 10)
      : null;
    return {
      title,
      metaDesc: `知乎 · ${a.voteupCount ?? "?"} 赞 · ${a.commentCount ?? "?"} 评论`,
      body,
      markdown,
      publishedAt,
    };
  } catch {
    return null; // 解析失败 → 回退通用提取
  }
}

export function extractBodyFromHtml(html, maxChars, url) {
  // 知乎文章页:js-initialData 优先(SSR 结构化正文,比 DOM 抠取更干净)
  if (url && /zhihu\.com/i.test(url)) {
    const z = extractZhihuInitialData(html);
    if (z) {
      const { body, markdown } = clampLength(z.body, z.markdown, maxChars);
      return { ...z, body, markdown };
    }
  }
  const base = extractBodyWithReadability(html, maxChars, url) || extractBodyRegex(html, maxChars);
  const primaryLen = (base?.markdown || base?.body || "").trim().length;
  // 列表页检测:正文不足(空壳/版权壳/SPA 壳)或链接文本总量远超正文(滚动频道时间戳流),
  // 且页面确实含 ≥3 条文章形态链接 → 按链接列表输出(比空壳/时间戳有用,也省浏览器兜底)。
  // 正常文章(正文 >1200 字符)零开销跳过;短文章页误触发概率低(list 需 ≥3 条且文本占比大)。
  if (primaryLen < LIST_DOMINANT_MAX_CHARS) {
    const list = extractLinkList(html, url);
    if (list.items.length >= LIST_MIN_ITEMS) {
      const listText = list.items.reduce((s, i) => s + i.title.length, 0);
      const isShell = primaryLen < LIST_SHELL_MAX_CHARS;
      const listDominant = primaryLen < LIST_DOMINANT_MAX_CHARS && listText > primaryLen * 1.5;
      if (isShell || listDominant) {
        const r = buildListResult(list.items, html, maxChars, url);
        // 列表页强监督信号:页面确为列表页 → 更新列表页判别模型。
        // bodyLen 传提取前正文长度(短壳),不传列表 markdown 长度 —— 否则列表页的
        // bodyShort/bodyMed 特征与长文文章页重合,列表判别学习信号被污染。
        recordFetchOutcome(url, html, { isList: true, listCount: r.listCount, bodyLen: primaryLen, body: r.body, markdown: r.markdown });
        return r;
      }
    }
  }
  if (!base) return null;
  // 发布时间:ML 多候选裁决(meta/URL/正文/JSON-LD 冲突时选最可信;列表页概率高时降权 meta),
  // 解决频道页 meta 误导(如国际在线滚动频道 meta 2018-03-28 但实际是 2026-08-07 滚动列表)
  const pub = pickDate(html, url, { bodyLen: primaryLen, title: base.title || "" });
  const out = { ...base, publishedAt: pub.date, _dateSource: pub.source, _isListPage: pub.isList };
  // 渲染后/直连正文验证学习(弱监督,纯增强):页面形态 → 列表页标签
  recordFetchOutcome(url, html, { isList: out.isList, listCount: out.listCount, body: out.body, markdown: out.markdown });
  return out;
}

/**
 * 直连抓取并提取正文。
 * htmlBytes 透传原始 HTML 大小:classifyFetchResult 据此判断是否 SPA 残缺
 * (HTML 远大于提取正文 → 正文在 JS 数据流里,直连只拿到壳,需浏览器兜底)。
 * @returns {Promise<{title, metaDesc, body, url, htmlBytes}>}
 */
export async function fetchPageDirect(url, maxChars) {
  const { contentType, finalUrl, body: html } = await httpGetFull(url);
  if (!contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("text/markdown")) {
    throw new Error(`不支持的内容类型: ${contentType}`);
  }
  const r = extractBodyFromHtml(html, maxChars, finalUrl);
  return { ...r, url: finalUrl, htmlBytes: html.length };
}

/** 统一入口:直连失败抛错由 cli 捕获并尝试浏览器兜底 */
export { fetchPageDirect as fetchPage };
