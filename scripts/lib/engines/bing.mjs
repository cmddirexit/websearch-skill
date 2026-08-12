/**
 * engines/bing.mjs — Bing 搜索(直连)
 * 参考 open-websearch 的 bing 引擎:
 *  - 直连 cn.bing.com/search,解析 #b_results 下的 .b_algo 块
 *  - 处理 /ck/a 跳转链接(base64url 解码 u 参数还原真实 URL)
 *  - 清理 UTM 等跟踪参数
 *
 * 地域污染调研(2025-08,实测):CN IP 下 cn.bing.com/www.bing.com 均被重定向/定位到
 * 必应中国版,英文查询返回 70% 中文结果(知乎/博客园),且 mkt=en-US 等参数被忽略或
 * 返回无关垃圾(WhatsApp/WEB.DE,实测 6/6 不相关)。唯一正解是 global.bing.com
 * (国际版,不重定向,mkt=en-US 生效)——实测英文查询 0% 中文且全部相关;个别长查询
 * (如 "openai api pricing")global 返回 0 条,此时回退 cn.bing.com 走原有污染检测。
 * 中文查询无污染问题,始终走 cn.bing.com(中文结果更全)。
 */

import { httpGet } from "../http.mjs";
import { clean, extractAttr, decodeEntities, longestCommonSubstring, extractSerpDate } from "../html.mjs";
// re-export 保持外部(tests/cluster 旧引用)兼容
export { longestCommonSubstring };
import { parseDomOr, elementText, queryOne, queryAll } from "../dom.mjs";

const BING_URL = "https://cn.bing.com/search";
const GLOBAL_BING_URL = "https://global.bing.com/search";

/**
 * 解码 bing 跳转链接(/ck/a),返回真实目标 URL。
 * u 参数为 base64url(去掉 a1 前缀),Node Buffer 原生支持解码。
 * 非跳转链接则清理跟踪参数后返回。
 */
export function decodeBingUrl(rawUrl) {
  if (!rawUrl) return "";
  // 先解码 HTML 实体(含 bing 偶发双重编码 &amp%3B → &amp; → &):href 里的 &amp; 不会被 URL 构造器解码,
  // 直接 toString 会把实体残留进输出(实测直链输出 &amp%3B 乱码)
  const u = decodeEntities(rawUrl.trim());
  if (!u.startsWith("http")) return "";
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    if (host.endsWith("bing.com") && path.startsWith("/ck/a")) {
      const b64 = (url.searchParams.get("u") || "").replace(/^a1/, "");
      const dec = Buffer.from(b64, "base64url").toString("utf8").trim();
      return dec.startsWith("http") ? dec : "";
    }
    // bing 内部页面(搜索结果页/新标签页)丢弃
    if (host.endsWith("bing.com") && (path.startsWith("/search") || path.startsWith("/newtabredir"))) {
      return "";
    }
    ["utm_source", "utm_medium", "utm_campaign", "ref", "source"].forEach((p) => url.searchParams.delete(p));
    return url.toString();
  } catch {
    return "";
  }
}

/** 从摘要容器提取日期(bing 结果日期在 caption 内的短文本节点里,如 "2026年8月5日"/"5 天前")。
 * 逐文本节点扫描(每段 <40 字符)而非整段摘要 —— 长摘要散文里的年份(如 "2023年报告指出")
 * 会被短节点隔离,不误报。返回 "YYYY-MM-DD" 或相对时间原文;无 → ""。 */
function extractCaptionDate(cap) {
  const walk = (el, out = []) => {
    for (const node of el?.childNodes || []) {
      if (node.nodeType === 3) {
        const t = String(node.textContent || "").trim();
        if (t && t.length < 40) {
          const d = extractSerpDate(t);
          if (d) out.push(d);
        }
      } else if (node.nodeType === 1 && !/^(script|style)$/i.test(node.tagName || "")) {
        walk(node, out);
      }
    }
    return out;
  };
  return walk(cap)[0] || "";
}

/** 从单个 .b_algo 元素提取 {title, url, desc}(DOM 选择器定位,不再正则匹配 HTML) */
function parseAlgoBlock(blockEl) {
  const a = queryOne(blockEl, "h2 a[href]");
  if (!a) return null;
  const url = decodeBingUrl(a.getAttribute("href") || "");
  if (!url) return null;
  const title = clean(elementText(a));
  if (!title) return null;
  // 标题日期优先(bing 标题常含 "2025年5月11日热点新闻速览" 这类完整日期,是强时效信号;
  // 40 字符短节点限制只作用于摘要扫描,标题不受限 —— 标题里的完整年月日基本就是内容日期)
  const titleDate = extractSerpDate(title);
  // 摘要:优先 b_caption 下的 <p>,回退 b_caption 全文
  const cap = queryOne(blockEl, ".b_caption");
  const p = cap ? queryOne(cap, "p") : null;
  const desc = clean(p ? elementText(p) : cap ? elementText(cap) : "");
  const date = titleDate || (cap ? extractCaptionDate(cap) : "") || extractSerpDate(desc);
  const r = { title, url, desc };
  if (date) r.date = date; // 时效排序/旧文沉底的数据基础(有则加,无则不污染)
  return r;
}

/** 检测是否命中反爬页(无结构化结果 + 验证关键词) */
function isBlocked(html, algoBlocks) {
  if (algoBlocks.length > 0) return false;
  return /captcha|验证码|人机验证|access denied|blocked|too many requests/i.test(html.slice(0, 2000));
}

/**
 * 检测地域语言污染:英文查询返回大量中文结果(本机 CN IP 上 bing 常见)。
 * 中文查询不检测;英文查询时结果中中文标题占比 ≥50% 视为污染。
 */
export function isLangPolluted(query, results) {
  if (/[\u4e00-\u9fff]/.test(query)) return false; // 查询含中文 → 不判定污染
  const titles = results.map((r) => r.title).filter(Boolean);
  if (titles.length === 0) return false;
  const cn = titles.filter((t) => /[\u4e00-\u9fff]/.test(t)).length;
  return cn / titles.length >= 0.5;
}

/**
 * 提取域名主干(去 www/m 前缀与 TLD):huangli123.net → huangli123。
 * 站群变体域名(huanli123/huangli/tthuangli/laohuangli)共享同一词根。
 */
export function domainStem(url) {
  try {
    return new URL(url).hostname.replace(/^(www|m|mobile|wap)\./i, "").split(".")[0].toLowerCase();
  } catch {
    return "";
  }
}

/** 字符 n-gram 集合(标题近似指纹)。默认 2-gram,站群检测用;转载检测用 3-gram(更精确)。
 * 只保留纯中文 n 字,避免英文/数字制造虚假重叠(如多篇 Python 教程都共享 "py"/"th" gram) */
export function charNGrams(text, n = 2) {
  const t = String(text || "").replace(/\s+/g, "");
  const g = new Set();
  const pat = new RegExp(`[\\u4e00-\\u9fff]{${n}}`);
  for (let i = 0; i + n <= t.length; i++) {
    const seg = t.slice(i, i + n);
    if (pat.test(seg)) g.add(seg);
  }
  return g;
}

/** 两个 gram 集合的包含度(重叠数 / 较小集大小,0~1) */
function gramOverlap(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.min(a.size, b.size);
}

/** 两个字符串的最长公共子串长度(域名变体共享词根检测,O(n*m),域名很短) */
/**
 * 中文结果聚类去重(无词表,通用)。两条结果满足以下任一条件视为同类,
 * 只保留排名靠前的一条:
 *  1. 站群:域名主干不同但共享 ≥4 字符词根(huangli123/tthuangli/laohuangli)
 *     且标题 2-gram 包含度 ≥0.3(模板雷同)——抓黄历/万年历/天气等任意工具站群
 *  2. 转载:域名不同且标题 3-gram 包含度 ≥0.55(同源通稿/转载,如新华社通稿多站转)
 * 分层信号:站群用短 2-gram(黄历等 2 字主题),转载用整句 3-gram(门户站名/栏目词
 * 如“网易新闻”⊂“网易新闻客户端”不会误判)。同域名多结果不聚类,不误杀同站多篇。
 * @returns {{good:Array, junkCount:number, clusters:Array<{rep:string, count:number}>}}
 */
export function dedupeZhResults(results) {
  const clusters = []; // {rep: result, stem: string, grams2: Set, grams3: Set}
  let junkCount = 0;
  for (const r of results) {
    const stem = domainStem(r.url);
    const grams2 = charNGrams(r.title, 2);
    const grams3 = charNGrams(r.title, 3);
    let dup = false;
    for (const c of clusters) {
      const stemShare = stem && c.stem && stem !== c.stem && longestCommonSubstring(stem, c.stem) >= 4;
      const overlap2 = gramOverlap(grams2, c.grams2);
      // 转载判定要求双方 3-gram 样本充足(标题 ≥6 字):短站名/栏目词
      // (“网易新闻”⊂“网易新闻客户端”)只有 1 个 3-gram,直接跳过不判
      const enoughSample = grams3.size >= 4 && c.grams3.size >= 4;
      const overlap3 = enoughSample ? gramOverlap(grams3, c.grams3) : 0;
      // 站群(短词雷同 + 域名变体);转载(整句雷同)
      if ((stemShare && overlap2 >= 0.3) || (enoughSample && stem && c.stem && stem !== c.stem && overlap3 >= 0.55)) {
        c.count++;
        dup = true;
        break;
      }
    }
    if (dup) junkCount++;
    else clusters.push({ rep: r, stem, grams2, grams3, count: 1 });
  }
  return {
    good: clusters.map((c) => c.rep),
    junkCount,
    clusters: clusters.filter((c) => c.count > 1).map((c) => ({ rep: c.rep.title, count: c.count })),
  };
}

/**
 * 解析 bing 搜索页 HTML(直连与浏览器兜底共用)。
 * @returns {{blocked:boolean, results:Array}}
 */
export function parseBingHtml(html, limit) {
  const doc = parseDomOr(html);
  // 主模式:li.b_algo 块(覆盖 b_algoBig 等多 class 变体)
  const blocks = queryAll(doc, "li.b_algo");
  const results = [];
  for (const block of blocks) {
    if (results.length >= limit) break;
    const r = parseAlgoBlock(block);
    if (r) results.push(r);
  }
  // 备选模式(主模式 0 条时):通用 h2>a 提取,兼容 bing 国际版/改版结构
  if (results.length === 0) {
    for (const a of queryAll(doc, "h2 a[href]")) {
      if (results.length >= limit) break;
      const url = decodeBingUrl(a.getAttribute("href") || "");
      const title = clean(elementText(a));
      if (!url || !title || !url.startsWith("http")) continue;
      results.push({ title, url, desc: "" });
    }
  }
  return { blocked: isBlocked(html, blocks) && results.length === 0, results };
}

/**
 * bing 直连搜索。
 * 按查询语言分流:
 *  - 中文查询 → cn.bing.com(setlang=zh-CN):工具站站群过滤,过滤后仍有结果 → 保留
 *    并附 note;全部被滤 → polluted:true 触发降级链。
 *  - 英文查询 → global.bing.com(mkt=en-US,国际版,CN IP 不被地域污染):直接返回;
 *    0 条/反爬 → 回退 cn.bing.com 走地域语言污染检测(isLangPolluted),污染 → polluted:true。
 * @returns {Promise<{engine:"bing", mode:"direct", blocked:boolean, reason?:string, results:Array}>}
 */
export async function searchBing(query, limit) {
  const isZh = /[\u4e00-\u9fff]/.test(query);
  let html, usedGlobal = false;
  if (!isZh) {
    // 英文查询:国际版优先(实测 mkt=en-US 生效,0% 中文且相关)
    let gHtml = null;
    try {
      const gUrl = `${GLOBAL_BING_URL}?q=${encodeURIComponent(query)}&mkt=en-US&setlang=en&ensearch=1&count=${limit}`;
      gHtml = await httpGet(gUrl);
    } catch {
      // global.bing.com 网络不可达(被墙/地区封锁):标记后走 cn.bing.com 回退
      usedGlobal = true;
    }
    if (gHtml !== null) {
      const g = parseBingHtml(gHtml, limit);
      if (!g.blocked && g.results.length > 0) {
        return {
          engine: "bing",
          mode: "direct",
          blocked: false,
          results: g.results,
          note: "global.bing.com(国际版,规避 CN 地域污染)",
        };
      }
      usedGlobal = true;
    }
  }
  // 中文查询直接走中国版;英文查询在 global 失败/0条后回退 cn.bing.com(mkt=en-US 尽力保留英文结果,
  // 污染检测 isLangPolluted 兜底:若仍返回大量中文结果则触发降级链)
  const url = isZh
    ? `${BING_URL}?q=${encodeURIComponent(query)}&setlang=zh-CN&ensearch=0&count=${limit}`
    : `${BING_URL}?q=${encodeURIComponent(query)}&mkt=en-US&setlang=en&ensearch=1&count=${limit}`;
  html = await httpGet(url);
  const { blocked, results } = parseBingHtml(html, limit);
  if (usedGlobal && blocked) {
    return {
      engine: "bing",
      mode: "direct",
      blocked: true,
      reason: "bing global 失败且 cn 回退触发反爬",
      results: [],
    };
  }
  if (usedGlobal && results.length === 0) {
    return {
      engine: "bing",
      mode: "direct",
      blocked: true,
      reason: "bing global 返回 0 条且 cn 回退也解析 0 条",
      results: [],
    };
  }
  if (blocked) {
    return { engine: "bing", mode: "direct", blocked: true, reason: "bing 直连触发反爬", results: [] };
  }
  if (results.length === 0) {
    return {
      engine: "bing",
      mode: "direct",
      blocked: true,
      reason: "bing 页面解析命中 0 条:页面结构可能已变更,请运行 npm run fixtures 更新快照",
      results: [],
    };
  }
  const base = { engine: "bing", mode: "direct", blocked: false, results };
  if (/[\u4e00-\u9fff]/.test(query)) {
    // 中文查询:站群/转载聚类去重(黄历/万年历等模板站群,通用信号:域名变体+标题雷同)
    const { good, junkCount, clusters } = dedupeZhResults(results);
    if (good.length === 0) {
      return {
        ...base,
        polluted: true,
        reason: `bing 中文结果疑似站群劫持(已滤 ${junkCount} 条重复)`,
        results: [],
      };
    }
    if (junkCount > 0) {
      const clusterNote = clusters.map((c) => `“${c.rep.slice(0, 10)}…”×${c.count}`).join("、");
      return { ...base, results: good, note: `已过滤 ${junkCount} 条近似重复(疑似站群/转载:${clusterNote})` };
    }
    return base;
  }
  return { ...base, polluted: isLangPolluted(query, results) };
}
