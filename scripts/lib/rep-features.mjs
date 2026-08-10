/**
 * rep-features.mjs — 域名信誉特征提取(纯函数)
 *
 * 从 domain-rep.mjs 拆出(2026-08 重构,domain-rep.mjs 变为实例 + 门面 re-export):
 *   - 域名解析:注册域折叠 / 引擎域排除 / 路径子键
 *   - 学习式 token 特征:标题中文 bigram + 英文词 + URL 路径段/域名标签 + 内容标记
 *
 * 特征空间 = 数据自动涌现的 token,无人工词表、无硬编码规则:
 *   - 标题:中文 2-gram(纯汉字)+ 英文词(小写)
 *   - URL:路径段(u: 前缀)+ 域名标签(d: 前缀)
 *   - 内容:filter.mjs 低质标记映射(f: 前缀)
 * 哪个 token 预示低质量/低相关,**由权重在线学习决定**,不是人写死的。
 */

/** 引擎/跳转域(搜索结果里的引擎自身 URL,非内容站,不参与信誉):
 * 如 e.so.com(360 跳转)、link.zhihu.com(知乎外链跳转)、weixin.sogou.com(搜狗微信)。 */
export const ENGINE_DOMAINS = new Set([
  "e.so.com", "www.so.com", "www.baidu.com", "www.bing.com", "cn.bing.com", "global.bing.com",
  "www.sogou.com", "weixin.sogou.com", "m.sm.cn", "quark.sm.cn", "so.toutiao.com", "m.toutiao.com",
  "search.marginalia.nu", "hn.algolia.com", "api.github.com", "en.wikipedia.org", "www.chinaso.com",
  "link.zhihu.com", "www.google.com", "www.google.com.hk", "r.jina.ai", "webcache.googleusercontent.com",
]);

/** 通用功能路径段(登录/注册/搜索/账户等,非内容子空间,不建路径子键) */
export const FUNCTIONAL_PATH_SEGS = new Set([
  "login", "signin", "signup", "register", "account", "search", "logout", "settings", "auth", "oauth",
]);

/** 引擎功能页/落地页路径(如 baidu.com/landing 搜索落地页、跳转链接) —— 不是内容,
 * 不参与信誉(learnFromResults/learnFromResultsLLM 共用)。 */
export const FUNCTIONAL_PATH_RE = /\/(?:landing|wz|wap|search|click)(?:[\/?#]|$)/i;

/** 注册域名(去 www、折叠子域到注册域;引擎域返回 "" 跳过;失败返回空串)。
 * 子域折叠:news.xnnews.com.cn → xnnews.com.cn,zhuanlan.zhihu.com → zhihu.com ——
 * 否则同一站的不同子域各自积累样本,学习信号被切碎。 */
export function registrableHost(url) {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    if (ENGINE_DOMAINS.has(h)) return "";
    const labels = h.split(".");
    if (labels.length > 2) {
      const last3 = labels.slice(-3).join(".");
      if (/\.(com|net|org|gov|edu|ac|biz|info|name|co|me|tv)\.(cn|hk|tw|mo)$/.test(last3)) return last3; // xxx.com.cn → 注册域
      return labels.slice(-2).join("."); // news.163.com → 163.com
    }
    return h;
  } catch {
    return "";
  }
}

/** 信誉键:host(全站)+ host/首段路径(站内内容子空间,如 cnblogs.com/pinpaituijan 品牌专栏)。
 * 功能段(login/search 等)不建子键;引擎域返回 []。 */
export function repKeys(url) {
  const host = registrableHost(url);
  if (!host) return [];
  const keys = [host];
  try {
    const seg = (new URL(url).pathname.split("/").filter(Boolean)[0] || "").toLowerCase();
    const identifierLike = /^\d+$/.test(seg) || /^(?:19|20)\d{2}[-_]\d{1,2}(?:[-_]\d{1,2})?$/.test(seg);
    if (seg && !identifierLike && !FUNCTIONAL_PATH_SEGS.has(seg) && !/\.(html?|php|jsp|aspx|json)$/i.test(seg)) {
      keys.push(`${host}/${seg}`);
    }
  } catch {
    /* 忽略 */
  }
  return keys;
}

/** 中文 2-gram(仅纯汉字,默认长度 ≤60 截断防长标题膨胀)
 * ⚠ 与 cluster.mjs 的 cnGrams 同族,改动行为时注意同步意图 */
export function cnBigrams(str, maxChars = 60) {
  const limit = Math.max(0, Math.trunc(maxChars) || 0);
  const s = String(str || "").replace(/\s+/g, "").slice(0, limit);
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    if (/^[\u4e00-\u9fff]{2}$/.test(g)) out.add(g);
  }
  return out;
}

/** 英文词 + 数字词(小写;标题年份如 2026 也是有效 token;长度 2-20)
 * ⚠ 与 cluster.mjs 的 enWords 同名不同义:本处用于特征提取(Set + 数字词),
 * 那边用于聚类 token(数组 + 停用词)。index.mjs 中经 repEnWords 别名导出以区分。 */
export function enWords(str) {
  const out = new Set();
  for (const m of String(str || "").toLowerCase().matchAll(/(?:[a-z][a-z0-9]{1,19}|[0-9]{2,10})/g)) out.add(m[0]);
  return out;
}

/** 泛域名标签(TLD + www):全互联网域名共有,不携带内容质量信息 ——
 * 若参与特征,会被海量正常样本推成稳定正权重(实测 d:com +0.40/d:www +0.31),
 * 冷启动预测被系统性推正。排除后 d: 标签只保留有区分度的二级域(arxiv/zhihu/3bgg 等)。
 * 2 字母标签(ccTLD:cn/hk/jp/us...)与下列常见长 TLD 全部视为泛标签。 */
export const GENERIC_DOMAIN_LABELS = new Set([
  "www", "com", "net", "org", "edu", "gov", "mil", "int", "info", "biz", "io", "co", "me", "ai", "tv", "app", "xyz", "top", "site", "online", "tech", "fun", "club", "wiki", "news", "blog", "dev", "id", "cc", "ws", "mobi", "name", "pro", "asia", "tel", "live", "shop", "store", "cloud", "link", "icu", "vip", "wang", "ren", "xin"
]);

/** URL 结构 token:路径段(u:) + 域名标签(d:)。日期块/数字 id 自然成为 token(如 u:202605)。 */
export function urlTokens(url) {
  const out = new Set();
  try {
    const u = new URL(url);
    for (const seg of u.pathname.toLowerCase().split(/[/.\-]/)) {
      const s = seg.replace(/^\d+$/, "n"); // 纯数字段归一化为 n(防具体日期/id 过拟合)
      if (s === "n" || (s.length >= 2 && s.length <= 24)) out.add("u:" + s);
    }
    for (const lab of u.hostname.toLowerCase().split(".")) {
      if (lab.length >= 2 && lab.length <= 24 && !/^\d+$/.test(lab) && !GENERIC_DOMAIN_LABELS.has(lab) && lab.length !== 2) out.add("d:" + lab);
    }
  } catch {
    /* 忽略 */
  }
  return out;
}

/** 内容标记 → 特征 token(f: 前缀),来自 filter.mjs 的低质标记(非人工词表) */
export function flagTokens(flags = []) {
  const out = new Set();
  for (const f of flags) {
    if (f.startsWith("ad:")) continue; // 广告不参与信誉
    out.add("f:" + f.replace(/^low:/, ""));
  }
  return out;
}

/** 合并为样本的完整 token 激活集(union) */
export function extractLearnFeatures(url, extra = {}) {
  const t = new Set();
  for (const x of cnBigrams(extra.title)) t.add("t:" + x);
  for (const x of enWords(extra.title)) t.add("t:" + x);
  for (const x of urlTokens(url)) t.add(x);
  for (const x of flagTokens(extra.flags)) t.add(x);
  return t;
}

/** 仅标题+标记 token(引擎跳转 URL 如公众号加密链接无法归因域名时用:只学标题,不污染 URL 权重) */
export function titleFlagTokens(title, flags = []) {
  const t = new Set();
  for (const x of cnBigrams(title)) t.add("t:" + x);
  for (const x of enWords(title)) t.add("t:" + x);
  for (const x of flagTokens(flags)) t.add(x);
  return t;
}
