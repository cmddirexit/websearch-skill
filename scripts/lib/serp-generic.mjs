/**
 * serp-generic.mjs — 站点无关的 SERP 通用解析器(启发式,零站点特定知识)
 *
 * 背景:特异性解析器(引擎文件里的正则/DOM 解析)精确但脆弱,站点改版即 0 命中。
 * 本模块提供两层"免维护"兜底,让改版降级为"质量下降 + 日志提示",而非功能中断:
 *
 *   层② parseSerpGeneric —— 结构签名聚类:所有搜索引擎结果页本质是"链接列表",
 *      用不依赖站点知识的结构信号识别结果条目(兄弟节点结构相似 + 外部域多样 + 标题质量)
 *   层③ urlstreamExtract —— URL 流提取:专治 JSON 内嵌页(如头条 SSR),
 *      URL 形态(如 /group/<id>/)比字段名稳定,字段名改版但 URL 形态不变
 *
 * 解析器选型:linkedom(轻量 DOM,纯 JS,1.8MB 页面 ~100ms;jsdom 需 ~1s)。
 * 只需遍历 <a> + 向上取父链,无需完整 DOM 能力。
 *
 * 设计原则:
 *  - 纯函数,无 IO,单测覆盖(结构聚类 / 黑名单 / URL 流三级)
 *  - 只认标签名忽略 class/id → 天然免疫类名变更(防过拟合)
 *  - 黑名单为"搜索引擎生态公共知识"(引擎自身域、平台导航域/路径),非站点知识
 *  - 全部失败返回空数组,不抛错 —— 由 parse-serp.mjs 决定降级/blocked
 */

import JSON5 from "json5";
import { elementText, parseDom } from "./dom.mjs";

/**
 * 公共黑名单:搜索引擎生态通用导航/追踪链接(非站点特定知识)。
 *  - 引擎自身域(调用方通过 opts.excludeHosts 补充)
 *  - 平台域:微软导航、Google 全家桶导航
 *  - 公共路径:/support/ /policies/ /feedback/ /about/ /login 等
 */
const BLACKLIST_HOSTS = new Set([
  "go.microsoft.com",
  "support.microsoft.com",
  "policies.google.com",
  "support.google.com",
  "accounts.google.com",
  "consent.google.com",
  "www.google.com",
  "www.bing.com",
  "cn.bing.com",
  "www.baidu.com",
  "www.sogou.com",
  "www.so.com",
  "m.baidu.com",
  "about.google.com",
  "github.com",
]);

const BLACKLIST_PATH = /\/(support|policies|feedback|about|login|register|signup|signin|help|terms|privacy|legal)(\/|$)/i;

/** 候选链接过滤:文本太短(纯图标/单字) */
const MIN_TITLE_LEN = 5;
const MAX_TITLE_LEN = 120;

/** 纯文本清洗(复用 html.mjs 的 clean 语义,但避免循环依赖) */
function cleanText(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// elementText 已抽到 dom.mjs(dom.mjs 顶部 import)

/**
 * 层② 通用 SERP 解析器:结构签名聚类。
 * @param {string} html
 * @param {number} limit 目标条数
 * @param {{excludeHosts?:string[]}} [opts] 排除的引擎自身域(如 ["so.toutiao.com"])
 * @returns {{results:Array<{title,url,desc}>}}
 */
export function parseSerpGeneric(html, limit, opts = {}) {
  if (!html || html.length < 500) return { results: [] };
  const excludeHosts = new Set(BLACKLIST_HOSTS);
  for (const h of opts.excludeHosts || []) excludeHosts.add(String(h).toLowerCase());

  let doc;
  try {
    doc = parseDom(html);
  } catch {
    return { results: [] }; // 畸形 HTML:linkedom 可能抛错,降级到层③
  }
  // 1. 收集候选链接 + 结构签名(向上 3 层标签路径,只认标签名)
  const candidates = [];
  for (const a of doc.querySelectorAll("a")) {
    const href = a.getAttribute("href");
    if (!href || !/^https?:\/\//i.test(href)) continue;
    let host = "";
    try {
      host = new URL(href).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      continue;
    }
    if (excludeHosts.has(host)) continue;
    const title = cleanText(elementText(a)).slice(0, MAX_TITLE_LEN);
    if (title.length < MIN_TITLE_LEN) continue;
    let path = "";
    try {
      path = new URL(href).pathname;
    } catch {
      continue;
    }
    if (BLACKLIST_PATH.test(path)) continue;
    // 结构签名:向上 3 层标签名序列(忽略 class/id)
    const sig = [];
    let el = a;
    for (let i = 0; i < 3 && el; i++) {
      sig.push(el.tagName);
      el = el.parentElement;
    }
    // 摘要长度预计算:父节点非链接文本(供组排序用,顺带产出 desc)
    let desc = "";
    let descLen = 0;
    try {
      const parent = a.parentElement;
      if (parent) desc = cleanText(elementText(parent).replace(title, "")).slice(0, 300);
      descLen = desc.length;
    } catch {
      /* 忽略 */
    }
    candidates.push({ a, href, title, host, sig: sig.join(">"), desc, descLen });
  }
  if (candidates.length === 0) return { results: [] };

  // 2. 按结构签名聚类(同一列表的条目结构高度相似)
  const groups = new Map(); // sig → candidates[]
  for (const c of candidates) {
    if (!groups.has(c.sig)) groups.set(c.sig, []);
    groups.get(c.sig).push(c);
  }

  // 3. 取最佳组作为"结果列表":数量优先,但必须通过标题质量过滤
  //    - 标题质量:组内"不含 URL 显示文本的标题"占比(徽标/来源链接如 bing 的
  //      tilk 会显示 "站点名+https://...",这类组直接滤掉,留下 A>H2 真结果组)
  //    - 摘要丰富度:组内"父节点含非链接文本"的比例(页脚/导航链接无描述)
  const ranked = [...groups.entries()]
    .map(([sig, list]) => {
      const uniqueHosts = new Set(list.map((c) => c.host)).size;
      const diversity = uniqueHosts / list.length;
      const goodTitles = list.filter((c) => !/https?:/i.test(c.title)).length;
      const titleQuality = goodTitles / list.length;
      const withDesc = list.filter((c) => (c.descLen || 0) >= 20).length;
      const descRatio = withDesc / list.length;
      return { sig, list, diversity, titleQuality, descRatio, n: list.length };
    })
    .filter((g) => g.n >= 3 && g.titleQuality >= 0.6)
    .sort((a, b) => b.n - a.n || b.descRatio - a.descRatio || b.diversity - a.diversity);
  if (ranked.length === 0) return { results: [] };
  const best = ranked[0];

  // 4. 提取条目:标题=a 文本,URL=href,摘要=父节点内非链接文本;
  //    同 URL 去重(徽标链接与标题链接同 URL 时保留先出现的标题组条目)
  const results = [];
  const seenUrl = new Set();
  for (const c of best.list) {
    if (results.length >= limit) break;
    if (seenUrl.has(c.href)) continue;
    seenUrl.add(c.href);
    results.push({ title: c.title, url: c.href, desc: c.desc });
  }
  return { results };
}

/** 标题质量检查:过滤 URL 显示文本/JSON 结构碎片/query 片段/base64 等噪音 */
function isJunkTitle(t) {
  if (typeof t !== "string") return true;
  const s = t.trim();
  if (s.length < MIN_TITLE_LEN || s.length > MAX_TITLE_LEN) return true;
  if (/https?:/i.test(s)) return true;
  if (/^[\[{]/.test(s)) return true;
  if (/^["'`,]|["'`,]$/.test(s)) return true; // 引号/逗号包裹(JSON 残留)
  if (/[=;]/.test(s)) return true; // query 参数片段(c_source=...)
  if (/\\["{}]/.test(s)) return true; // JSON 转义残留
  if (/^\d{10,}$/.test(s)) return true; // 纯数字串(如 gid)
  if (/[0-9a-f]{8}-[0-9a-f]{4}-/.test(s)) return true; // UUID
  if (/^[0-9a-f]{4}-[0-9a-f]{4}-/i.test(s)) return true; // 部分 UUID 段
  if (/,\s*["']|["']\s*[,:]/.test(s)) return true; // JSON 拼接残片(", search_id:)
  if (/\\u[0-9a-f]{4}/i.test(s)) return true; // 未解码 \u 转义
  if (/^[A-Za-z0-9+/]{20,}={0,2}$/.test(s)) return true; // base64 串
  return false;
}

/**
 * 层③ URL 流兜底:JSON 内嵌页(SSR <script> 数据)专用。
 * 原理:URL 形态(如 /group/<id>/)比 JSON 字段名稳定 —— 头条改版大概率换
 * 字段名(ttsearch_msite_url → 别的),但内容 URL 形态不变。
 * @param {string} html
 * @param {RegExp} urlShape 引擎内容 URL 形态(如 /\/group\/\d+\//)
 * @param {number} limit
 * @returns {{results:Array<{title,url,desc}>}}
 */
/**
 * 大括号配对:从 start 起(期望 '{')找完整 JSON 对象,跳过字符串内的 { }。
 * @returns {string|null} 完整 JSON 文本(含首尾 { })
 */
function matchBraces(html, start) {
  let i = start;
  while (i < html.length && /\s/.test(html[i])) i++;
  if (html[i] !== "{") return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 常见页面内嵌 JSON 包装模式(函数调用/全局赋值)。
 * 头条 SSR:T.flow({data:...}) —— 与字段名无关,只要包装模式还在就能提取。
 */
const JSON_PATTERNS = [
  /T\.flow\(/g,
  /window\.__INITIAL_STATE__\s*=\s*/g,
  /__NEXT_DATA__\s*=\s*/g,
  /window\.__NUXT__\s*=\s*/g,
];

/**
 * 从 HTML 提取所有可 parse 的 JSON 块(结构化,非正则窗口):
 *  ① <script type="application/json|ld+json"> 内容(直接 parse)
 *  ② 常见包装模式(大括号配对 + JSON.parse,坏块跳过)
 * @returns {Array<Object>}
 */
export function extractJsonBlocks(html) {
  const blocks = [];
  const add = (raw) => {
    // 严格 JSON 优先;失败用 json5(JS 对象字面量:未引号 key/尾随逗号,
    // 如头条 T.flow({ data: {...}, display: [...] }))
    for (const parser of [JSON.parse, JSON5.parse]) {
      try {
        const j = parser(raw);
        if (j && typeof j === "object") {
          blocks.push(j);
          return;
        }
      } catch {
        /* 尝试下一种解析器 */
      }
    }
  };
  // ① script[type="application/json"|"application/ld+json"]
  const scriptRe = /<script[^>]*type=["']application\/(?:json|ld\+json)["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(html)) !== null) add(m[1]);
  // ② 包装模式(T.flow( 等)
  for (const pat of JSON_PATTERNS) {
    pat.lastIndex = 0;
    while ((m = pat.exec(html)) !== null) {
      const raw = matchBraces(html, m.index + m[0].length);
      if (raw) {
        add(raw);
        pat.lastIndex = m.index + m[0].length + raw.length; // 跳过已消费块
      }
    }
  }
  return blocks;
}

/**
 * 从结果条目对象节点提取标题/摘要(字段名无关:遍历所有字符串字段,
 * 按"字段名像 title + 文本长度适中"打分选标题,避免依赖具体 key)。
 * @returns {{title:string, url:string, desc:string}|null}
 */
function extractEntry(node, url) {
  let title = "";
  let best = -1;
  for (const [k, v] of Object.entries(node)) {
    if (typeof v !== "string" || v === url) continue;
    const s = v.trim();
    if (isJunkTitle(s)) continue;
    let score = s.length;
    if (/title|name|abstract|headline/i.test(k)) score += 100; // 标题类字段名加分
    if (s.length > 80) score -= 60; // 过长是摘要/正文
    if (/^[a-z_]+\s*[:：]/.test(s) && s.split(",").length >= 3) score -= 80; // 枚举/配置文本(normal:无图,middle:单图,...)
    if (score > best) {
      best = score;
      title = s;
    }
  }
  if (!title) return null;
  // 摘要:摘要类字段(优先级),否则取次长文本
  let desc = "";
  for (const [k, v] of Object.entries(node)) {
    if (typeof v !== "string") continue;
    if (/summary|abstract|desc|content|snippet/i.test(k) && !isJunkTitle(v) && v.length > 20) {
      desc = cleanText(v).slice(0, 300);
      break;
    }
  }
  if (!desc) {
    let second = "";
    let secondLen = 0;
    for (const v of Object.values(node)) {
      if (typeof v !== "string" || v === url || v === title) continue;
      const s = v.trim();
      if (s.length > 20 && s.length < 400 && !isJunkTitle(s) && s.length > secondLen) {
        second = s;
        secondLen = s.length;
      }
    }
    desc = second;
  }
  return { title: cleanText(title).slice(0, MAX_TITLE_LEN), url, desc: desc.slice(0, 300) };
}

/**
 * 递归遍历 JSON 对象树(字段名无关):收集匹配 urlShape 的字符串值(URL),
 * 并从所在对象节点提取标题/摘要。改版时字段名/嵌套怎么变都不影响。
 */
function walkJson(node, urlShape, results, seen, limit) {
  if (results.length >= limit) return;
  if (Array.isArray(node)) {
    for (const item of node) {
      walkJson(item, urlShape, results, seen, limit);
      if (results.length >= limit) return;
    }
    return;
  }
  if (!node || typeof node !== "object") return;
  // 本节点内找 URL(完整 URL 才收,防相对路径;第一个匹配即消费)
  for (const v of Object.values(node)) {
    if (typeof v === "string" && /^https?:\/\//i.test(v) && urlShape.test(v)) {
      const key = v.replace(/^https?:\/\/(m|mobile)\./i, "https://").split("?")[0];
      if (!seen.has(key)) {
        seen.add(key);
        const entry = extractEntry(node, v);
        if (entry) results.push(entry);
      }
      break;
    }
  }
  // 递归子节点(即使本节点是条目也继续,因为数组里可能还有嵌套列表)
  for (const v of Object.values(node)) {
    if (v && typeof v === "object") walkJson(v, urlShape, results, seen, limit);
  }
}

/**
 * 层③ URL 流兜底 —— JSON 结构化提取(主,字段名无关) + 正则(兜底):
 *  ① extractJsonBlocks:找到页面内嵌 JSON 块(script/json、T.flow( 等包装模式)
 *  ② walkJson 递归:收集匹配 urlShape 的 URL + 相邻文本字段,不依赖字段名/嵌套深度
 *  ③ JSON 块全缺失/parse 失败时返回空(HTML 链接页由层② DOM 解析覆盖;
 *     非链接非 JSON 的极端页面诚实返回空,不硬凑)
 * @param {string} html
 * @param {RegExp} urlShape 引擎内容 URL 形态(如 /\/group\/\d+\//)
 * @param {number} limit
 * @returns {{results:Array<{title,url,desc}>}}
 */
export function urlstreamExtract(html, urlShape, limit) {
  if (!html || !urlShape) return { results: [] };
  // JSON.parse + 递归遍历(字段名无关,无正则窗口)
  const blocks = extractJsonBlocks(html);
  const results = [];
  const seen = new Set();
  for (const block of blocks) {
    walkJson(block, urlShape, results, seen, limit);
    if (results.length >= limit) break;
  }
  return { results };
}
