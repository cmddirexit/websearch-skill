/**
 * filter.mjs — 规则级广告/噪声过滤(零依赖,纯函数)
 *
 * 两阶段流水线的第一阶段(先过滤,再聚类):
 *   1. 硬证据(ad:*):从聚类剔除 —— 引擎 SERP 广告标记 / 标题强广告标记 /
 *      广告联盟域名 / 广告跳转 URL(重定向+目标参数组合)
 *   2. 软信号(low:*):降权不剔除 —— 短摘要/垃圾文案组合/短链/超长 URL 等
 * 每条结果附加 quality[0,1] 与 flags[],供 cluster.mjs 质量加权打分。
 *
 * 设计原则:高精度优先,宁可漏放也不误杀。
 * - 漏放的广告页进入聚类后,靠 quality 分把所在簇整体压沉(lowRelevance)
 * - 误杀则直接损失有效结果,代价更高
 * - 不依赖外部词典/API,可在 SERP 结果上同步执行(不抓正文)
 */

// ---- L1 硬证据:URL ----

/** 广告联盟/广告网络域名(搜索结果解析漏网时兜底;宁缺勿滥) */
export const AD_DOMAINS = [
  "doubleclick.net", "googlesyndication.com", "googleadservices.com",
  "adservice.google.com", "adservice.google.cn", "adservice.google.co.uk",
  "amazon-adsystem.com", "taboola.com", "outbrain.com", "criteo.com", "criteo.net",
  "adroll.com", "rubiconproject.com", "pubmatic.com", "openx.net",
  "revcontent.com", "mgid.com", "propellerads.com", "popads.net",
  "bidvertiser.com", "exoclick.com",
];

/** 短链域名(软信号:广告/垃圾站常用,但也可能是正常分享链接,只降权不剔除) */
export const SHORTENER_DOMAINS = [
  "t.cn", "dwz.cn", "url.cn", "bit.ly", "goo.gl", "is.gd", "tinyurl.com",
  "suo.im", "sohu.com/short", "v.douyin.com",
];

/** 广告跳转路径段(须与"目标参数"同时出现才算硬证据,避免误杀 /click/out 等正常页) */
export const AD_REDIRECT_SEGMENTS = /(?:^|\/)(?:redirect|goto|jump|out|outlink|fwd|click)(?:\.php|\.jsp|\.aspx|\.html)?(?:\/|$|\?)/i;

/** 目标参数名(重定向/跳转链接的落地目标) */
export const REDIRECT_TARGET_PARAMS = ["url", "u", "target", "to", "dest", "destination", "redirect", "jump", "goto", "link", "next", "rurl", "go"];

// ---- L1 硬证据:文本标记 ----

/** 强广告标记(标题/摘要中括号式或标准广告标签,命中即硬证据) */
export const AD_MARKER_STRONG =
  /【广告】|\[广告\]|\[Sponsor(ed)?\]|\[Ad\]|^Sponsor(ed)?[:： ]|^Ad[:： ]|Advertisement|^广告[：:]|广告(?:推广|推荐)?[：:]/i;

/** 弱广告标记(仅降权;带否定排除:“无广告/没有广告/免广告”等正常语义不算)。
 * 刻意只保留“广告”一词、不包含“推广/赞助”——“推广普通话”“赞助商”等正常语境太多,误报代价高 */
export const AD_MARKER_WEAK = /(?<!无|没有|免|去除|去|拦截)广告/i;

// ---- L2 软信号:文案垃圾组合 ----

const SPAM_ACTION = /立即|马上|点击|赶紧|速来|抓紧|错过|抢/;
const SPAM_GOAL = /下载|注册|领取|优惠|折扣|促销|免费|红包|返现|秒杀|限时|低价|特价|直销/;
const SHOUTY_RE = /[!！]{2,}/;
const ALLCAPS_RE = /^[A-Z0-9][A-Z0-9\s.'"&,-]{7,}$/;

// ---- 工具函数 ----

function hostname(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function pathAndParams(url) {
  try {
    const u = new URL(url);
    return { path: u.pathname.toLowerCase(), params: [...u.searchParams.keys()].map((k) => k.toLowerCase()) };
  } catch {
    return { path: "", params: [] };
  }
}

/**
 * 列表页/首页/栏目页判定(门户聚合列表页如“今日动态-生物通”等,非单篇文章):
 * URL 路径空/首页/单段短栏目目录(无扩展名无文章 id)+ 摘要缺失或很短(<80)+ 标题短(<24)。
 * 真文章通常路径含文章 id 或较长语义路径、且摘要完整。零词表、纯结构信号。
 */
export function isIndexPageLike(url, title, desc) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const path = u.pathname.replace(/\/+$/, "").toLowerCase();
  const t = String(title || "").trim();
  const d = String(desc || "").trim();
  if (d.length >= 80 || t.length >= 24) return false; // 摘要完整/标题长 → 疑似真文章
  if (d.length > 10) return false; // 有实质摘要(>10字)的栏目入口如“人民日报电子版”不误杀
  const rootish = path === "" || /^\/?(?:index|default|home)(?:\.html?)?$/.test(path);
  if (rootish) return true;
  const segs = path.split("/").filter(Boolean);
  // 单段短栏目目录(URL 以 / 结尾 = 目录形态,如 /newsf/、/news/;博客短链 /py、/1 无尾斜杠不误判)
  if (
    segs.length === 1 &&
    u.pathname.endsWith("/") &&
    !/\.[a-z0-9]{2,5}$/.test(segs[0]) &&
    !/\d{4,}/.test(segs[0])
  )
    return true;
  return false;
}

/** 是否命中广告联盟/短链域名 */
export function isAdDomain(url) {
  const host = hostname(url);
  return AD_DOMAINS.some((d) => host === d || host.endsWith("." + d));
}

export function isShortener(url) {
  const host = hostname(url);
  return SHORTENER_DOMAINS.includes(host);
}

/** 是否命中"跳转路径 + 目标参数"组合(硬证据) */
export function isRedirectAdUrl(url) {
  const { path, params } = pathAndParams(url);
  if (!AD_REDIRECT_SEGMENTS.test(path)) return false;
  return params.some((p) => REDIRECT_TARGET_PARAMS.includes(p));
}

/** 强/弱广告文本标记检测 */
export function hasAdMarker(text, { strong = false } = {}) {
  const t = String(text || "");
  return strong ? AD_MARKER_STRONG.test(t) : AD_MARKER_WEAK.test(t);
}

/**
 * 结果标记检测。
 * @param {{title?:string, desc?:string, url?:string, isAd?:boolean}} r
 * @returns {string[]} flags,前缀 ad: = 硬证据(剔除),low: = 软信号(降权)
 */
export function detectFlags(r) {
  const title = String(r.title || "");
  const desc = String(r.desc || "");
  const url = String(r.url || "");
  const flags = [];

  // L1 硬证据
  if (r.isAd === true) flags.push("ad:serp-marker");
  if (hasAdMarker(title, { strong: true })) flags.push("ad:title-marker");
  if (hasAdMarker(desc, { strong: true })) flags.push("ad:desc-marker");
  if (url && isAdDomain(url)) flags.push("ad:domain");
  if (url && isRedirectAdUrl(url)) flags.push("ad:redirect-url");

  // L2 软信号(硬证据已剔除时,剩余标记仅降权)
  // sogou 公众号跳转链接(weixin.sogou.com/link?url=...)天生超长 + 参数多,是跳转机制而非
  // 内容低质信号 —— 豁免 long-url/many-params,避免公众号周报类优质结果被双重降权
  const isSogouJumpLink = /^https?:\/\/weixin\.sogou\.com\/link\?/i.test(url);
  if (url && isShortener(url)) flags.push("low:shortener");
  if (hasAdMarker(desc) && !flags.some((f) => f.startsWith("ad:"))) flags.push("low:desc-marker");
  if (title.length < 4) flags.push("low:title");
  if (desc.length === 0) flags.push("low:desc-empty");
  else if (desc.length < 15) flags.push("low:desc-short");
  if (SHOUTY_RE.test(title)) flags.push("low:shouty");
  if (ALLCAPS_RE.test(title)) flags.push("low:allcaps");
  if (SPAM_ACTION.test(title) && SPAM_GOAL.test(title)) flags.push("low:spam-title");
  if ((SPAM_ACTION.test(desc) && SPAM_GOAL.test(desc))) flags.push("low:spam-desc");
  if (url.length > 240 && !isSogouJumpLink) flags.push("low:long-url");
  if (pathAndParams(url).params.length >= 6 && !isSogouJumpLink) flags.push("low:many-params");
  if (isIndexPageLike(url, title, desc)) flags.push("low:index-page");

  return flags;
}

/** 每条软信号的降权因子(乘性,最终 clamp 到 [0.15, 1]) */
const LOW_QUALITY_FACTOR = {
  "low:shortener": 0.85,
  "low:desc-marker": 0.85,
  "low:title": 0.7,
  "low:desc-empty": 0.9,
  "low:desc-short": 0.92,
  "low:shouty": 0.88,
  "low:allcaps": 0.85,
  "low:spam-title": 0.6,
  "low:spam-desc": 0.7,
  "low:long-url": 0.92,
  "low:many-params": 0.9,
  "low:index-page": 0.45,
};

/** 质量分 [0,1]:1 = 干净;含 ad:* = 0(不参与聚类,此处仅作记录) */
export function scoreQuality(r, flags = detectFlags(r)) {
  if (flags.some((f) => f.startsWith("ad:"))) return 0;
  let q = 1;
  for (const f of flags) q *= LOW_QUALITY_FACTOR[f] ?? 1;
  return Math.max(0.15, q);
}

/** 是否为广告(硬证据) */
export function isAdResult(r) {
  return detectFlags(r).some((f) => f.startsWith("ad:"));
}

/**
 * 过滤入口:硬剔除广告,软降权噪声。
 * 副作用:原地为每条结果附加 quality/flags(不修改其他字段)。
 * @param {Array<{title:string, desc?:string, url?:string, isAd?:boolean}>} results
 * @returns {{kept:Array, ads:Array, flagged:Array}}
 *   kept    干净 + 软降权(进聚类,quality<1 的簇整体降权)
 *   ads     硬证据广告(不参与聚类)
 *   flagged 软信号结果(已并入 kept,单独列出供 CLI 提示)
 */
export function filterResults(results) {
  const ads = [];
  const flagged = [];
  const kept = [];
  for (const r of results) {
    const flags = detectFlags(r);
    r.flags = flags;
    r.quality = scoreQuality(r, flags);
    if (flags.some((f) => f.startsWith("ad:"))) ads.push(r);
    else {
      if (flags.length > 0) flagged.push(r);
      kept.push(r);
    }
  }
  return { kept, ads, flagged };
}

// ==================== 查询时间意图 + 旧文沉底(展示层软信号) ====================
// 痛点:搜“AI 大事 本周”时 2024/2025 的旧文混在中前位置。
// 方案:查询带时间意图(本周/最近/最新…)时,对带日期且明显过旧的结果
//   ①加 low:stale 标注(展示时可见) ②稳定重排沉到队尾(cluster 的 rankScore 基于
//   输入顺序 → 簇分降低 → 自然沉底)。
// 关键:【不碰 quality】—— 旧文 ≠ 低质内容,进域名信誉学习会污染“内容可信度”信号
// (rep-score 的 contributionFromQuality / CONTENT_LOW_FLAGS 均不处理 low:stale)。

/** 查询是否带时间意图(想找新内容)→ 启用旧文沉底。
 * 覆盖:本周/最近/最新/突发/快讯/进展/要闻/大事件/大事/近日/近期 等 ——
 * “国内外大事件”“XX 最新进展”这类新闻意图查询,旧闻(2018-2023)应沉底。
 * 历史意图保护:查询含明确历史信号(19xx 年份/历史/纪念/周年/那年…)时不启用 ——
 * 搜“1927 年大事件”“建党百年大事记”时旧文是正确答案,不能沉底。 */
const HISTORICAL_GUARD_RE = /(19\d{2}|公元前|历史|当年|那年|纪念|周年|大事记|回忆|往事|古代|近代|民国|清朝|明朝|宋朝|唐朝|汉朝|三国|史记)/i;
const TIME_INTENT_RE =
  /(本周|上周|本月|上月|最近|最新|今日|今天|昨日|昨天|近\s*\d+\s*(天|日|周)|突发|快讯|进展|要闻|大事件|大事|近日|近期|近况|今晨|刚刚|今日要闻|this\s*week|this\s*month|latest|breaking|fresh|new\s+release|recent|today)/i;
export function hasTimeIntent(query) {
  const q = String(query || "");
  if (HISTORICAL_GUARD_RE.test(q)) return false;
  return TIME_INTENT_RE.test(q);
}

/** 解析结果日期文本 → 距今天数(>0);无法解析返回 null。支持 ISO/中文/相对时间。 */
export function parseResultDateAgo(s) {
  const str = String(s || "").trim();
  if (!str) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let m = str.match(/(\d+)\s*(?:天|日)\s*前/);
  if (m) return Number(m[1]);
  m = str.match(/(\d+)\s*周\s*前/);
  if (m) return Number(m[1]) * 7;
  m = str.match(/(\d+)\s*个?月\s*前/);
  if (m) return Number(m[1]) * 30;
  m = str.match(/(\d+)\s*年\s*前/);
  if (m) return Number(m[1]) * 365;
  if (/昨天|昨日/.test(str)) return 1;
  if (/前天/.test(str)) return 2;
  if (/上周/.test(str)) return 7;
  m = str.match(/(\d{4})[年\/\-.]?(\d{1,2})[月\/\-.]?(\d{1,2})[日]?/);
  if (!m) m = str.match(/(\d{1,2})月(\d{1,2})日/); // 缺年份:按当年
  if (!m) return null;
  const d = m.length >= 4
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    : new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2])); // 月日分支:m[1]=月 m[2]=日
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.round((today - d) / 86400000));
}

/** 旧文阈值(天):时间意图查询下,日期早于此时长的结果视为旧文沉底(覆盖“本周/最近”粒度,
 * 只把明显过旧的压下去,近一两个月的文章仍正常参与排序) */
export const STALE_DAYS = 60;

/** 时间意图查询下:旧文沉底(稳定重排,非旧文保持原序)。
 * 附加 low:stale 标注 + r.staleDays(展示层显示“⏳x天前”)。
 * @param {Array<{date?:string, flags?:string[]}>} results
 * @returns {Array} 重排后的新数组(原数组不被修改;无时间意图/无旧文时原样返回) */
export function applyRecencyOrder(results, query) {
  if (!hasTimeIntent(query)) return results;
  const aged = [];
  const fresh = [];
  for (const r of results) {
    const ago = parseResultDateAgo(r.date);
    if (ago !== null && ago > STALE_DAYS) {
      r.flags = r.flags || [];
      if (!r.flags.includes("low:stale")) r.flags.push("low:stale");
      r.staleDays = ago;
      aged.push(r);
    } else fresh.push(r);
  }
  if (!aged.length) return results;
  aged.sort((a, b) => (b.staleDays || 0) - (a.staleDays || 0)); // 最旧的排最后
  return [...fresh, ...aged];
}

// ==================== --since 结果级时效过滤(硬过滤) ====================
// 与 applyRecencyOrder(软沉底)不同:--since 是用户显式要求的时间窗,超窗结果直接剔除
// (带日期的剔除;无日期无法判断,保守保留并提示)。chinaso 引擎在 API 层就支持 stime/etime,
// 其余引擎(聚合时)靠这里统一过滤 —— 解决“搜大事件混入 2018 旧闻、高考资料、PPT 模板”。

/** 解析 --since 参数(24h|1w|1m|1y 或 YYYY-MM-DD)→ 阈值时间戳;非法 → null */
export function parseSince(since) {
  const s = String(since || "").trim();
  if (!s) return null;
  const now = Date.now();
  const DAY = 86400000;
  const m = s.match(/^(\d+)([hdwmy])$/i);
  if (m) {
    const n = Number(m[1]);
    const mult = { h: 3600000, d: DAY, w: 7 * DAY, m: 30 * DAY, y: 365 * DAY }[m[2].toLowerCase()];
    if (!Number.isNaN(n) && n > 0) return now - n * mult;
    return null;
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.getTime();
  return null;
}

/**
 * 按时间窗硬过滤:解析得日期且早于阈值 → 剔除(返回 dropped 供提示);
 * 无日期/解析失败 → 保留(不能因缺信息误杀)。
 * @returns {{kept:Array, dropped:Array}}
 */
export function applySinceFilter(results, since) {
  const threshold = parseSince(since);
  if (!threshold) return { kept: results, dropped: [] };
  const kept = [];
  const dropped = [];
  for (const r of results) {
    const ago = parseResultDateAgo(r.date);
    if (ago !== null) {
      // parseResultDateAgo 返回距今天数;阈值换算成天数比较
      const maxDays = Math.max(1, Math.round((Date.now() - threshold) / 86400000));
      if (ago > maxDays) {
        dropped.push(r);
        continue;
      }
    }
    kept.push(r);
  }
  return { kept, dropped };
}
