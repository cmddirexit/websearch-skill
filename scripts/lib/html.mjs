/**
 * html.mjs — HTML 文本处理工具
 * 实体解码、标签剥离、文本清洗、属性/片段提取。所有解析器共用。
 */

/**
 * 解码 HTML 实体(含命名实体与数字实体)。
 * 顺序:先 URL 编码层(%26/%3B),再 HTML 实体层(含无分号容忍)。
 * 解决 bing 偶发的双重编码(&amp%3B → &amp; → &)。
 */
export function decodeEntities(s) {
  let out = s;
  // 1. URL 编码层
  out = out.replace(/%26/g, "&").replace(/%3B/g, ";");
  // 2. 命名实体
  out = out
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&ensp;/g, " ")
    .replace(/&emsp;/g, " ")
    .replace(/&middot;/g, "·")
    .replace(/&shy;/g, ""); // 软连字符(不可见),marginalia 等站点用于断行
  // 3. &amp 带分号优先,再容忍无分号变体(后面非字母数字/井号)
  out = out.replace(/&amp;/g, "&").replace(/&amp(?![a-z0-9#])/gi, "&");
  // 4. 数字实体 &#NNN; 与 &#xHH;
  out = out
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return out;
}

/** 剥离全部标签(script/style 一并移除),压缩空白 */
export function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 清洗文本:去标签 → 解码实体 → 压缩空白 → 收紧中文标点间空格 */
export function clean(s) {
  return decodeEntities(stripTags(s))
    .replace(/\s+/g, " ")
    // 软连字符 U+00AD(浏览器渲染后为真实字符,常见于 marginalia 断行标题)
    .replace(/\u00ad/g, "")
    // 汉字/全角标点间空格(<em> 高亮残留):【 北京天气 预报15天】 → 【北京天气预报15天】
    .replace(/([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])\s+(?=[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])/g, "$1")
    // 标点后/前空格
    .replace(/([，。；：！？、）】」』》])\s+/g, "$1")
    .replace(/\s+([（【「『《])/g, "$1")
    .trim();
}

/** 剥离终端控制序列(ANSI 转义/其他 C0-C1 控制字符),仅用于面向终端的输出。
 * 搜索结果/抓取正文来自不可信第三方页面,标题里可藏 \x1b[2J(清屏)或颜色序列
 * 伪造输出 —— 打印前必须净化,否则恶意站点能控制终端表现。保留换行/制表等
 * 可读空白,其余控制字符删掉。 */
export function stripControl(s) {
  // ① ANSI CSI 序列 ESC [ ... 字母(含 8-bit 0x9B)与 OSC ESC ] ... BEL/ST
  // ② 其余 C0(0x00-0x1F)/C1(0x80-0x9F)控制字符(除 \t \n \r)
  return String(s ?? "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

/** 提取第一个匹配的属性值(支持单双引号),已解码实体 */
export function extractAttr(html, attr) {
  const m = html.match(new RegExp(`${attr}=["']([^"']+)["']`, "i"));
  return m ? decodeEntities(m[1]) : "";
}

/** 提取 <title> 文本 */
export function extractTitle(html) {
  return clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
}

/**
 * 从 URL 提取新闻发布日期("2026-08-01")。支持常见新闻站 URL 模式:
 *  - /n1/2026/0801/c1024-xxx.html(人民网)
 *  - /2026/07/31/ARTIxxx.shtml(共产党员网)
 *  - /2026-07/31/content_xxx.htm(政府网)
 * @returns {string} YYYY-MM-DD;无 → ""
 */
function validMonthDay(mm, dd) {
  const m = Number(mm);
  const d = Number(dd);
  // 必须数字比较且排除 0:字符串比较会放行 "00"(如腾讯新闻占位时间戳 2002-00-00)
  if (!Number.isInteger(m) || !Number.isInteger(d) || m < 1 || m > 12 || d < 1) return false;
  const dim = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // 2月按 29 宽松(不引入闰年判断)
  return d <= dim[m - 1];
}

/** 从 URL 提取新闻发布日期("2026-08-01")。支持常见新闻站 URL 模式:
 *  - /n1/2026/0801/c1024-xxx.html(人民网)
 *  - /2026/07/31/ARTIxxx.shtml(共产党员网)
 *  - /2026-07/31/content_xxx.htm(政府网)
 * @returns {string} YYYY-MM-DD;无 → ""
 */
export function parseDateFromUrl(url) {
  try {
    const s = url || "";
    // /2026/0801/ 与 /2026/07/31/ 均命中(MMDD 无分隔符优先)
    const m = s.match(/\/(20\d{2})\/(\d{2})(\d{2})\//);
    if (m && validMonthDay(m[2], m[3])) return `${m[1]}-${m[2]}-${m[3]}`;
    const m2 = s.match(/\/(20\d{2})[\/-](\d{1,2})[\/-](\d{1,2})[^0-9]/);
    if (m2 && validMonthDay(m2[2], m2[3])) {
      const mm = m2[2].padStart(2, "0");
      const dd = m2[3].padStart(2, "0");
      return `${m2[1]}-${mm}-${dd}`;
    }
  } catch {
    /* 非法 URL */
  }
  return "";
}

/** 归一化中文日期文本("2026年8月1日" "2026-8-1" "2026/08/01") → "2026-08-01" */
export function normalizeCnDate(s) {
  const m = String(s || "").match(/(20\d{2})[年\/\-.]?(\d{1,2})[月\/\-.]?(\d{1,2})[日]?/);
  if (!m) return "";
  if (!validMonthDay(m[2], m[3])) return ""; // 排除 00 月/00 日等占位符(数字校验,字符串比较会放行)
  const mm = String(Number(m[2])).padStart(2, "0");
  const dd = String(Number(m[3])).padStart(2, "0");
  return `${m[1]}-${mm}-${dd}`;
}

/** 提取 meta description(og:description 兜底) */
export function extractMetaDescription(html) {
  return clean(
    html.match(/<meta[^>]*name="description"[^>]*content="([^"]+)"/i)?.[1] ||
      html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]+)"/i)?.[1] ||
      ""
  );
}

/**
 * 从搜索引擎结果摘要文本提取日期(SERP 日期信号,供时效排序/旧文沉底用)。
 * 返回两种形式:① 绝对日期 "YYYY-MM-DD" ② 相对时间原文("3小时前"/"昨天"/"5天前"…,
 * filter.mjs 的 parseResultDateAgo 能理解)。无日期 → ""。
 * 软信号设计:宁可漏(返回空)不误报 —— 误报会把新文当旧文沉底。
 */
export function extractSerpDate(text) {
  const s = String(text || "").trim();
  if (!s) return "";
  // 相对时间:分钟/小时(当日事件,留给 parseResultDateAgo 按 <1 天处理)
  let m = s.match(/(\d+)\s*(分钟|小时)\s*前/);
  if (m) return `${m[1]}${m[2]}前`;
  if (/昨天|昨日/.test(s)) return "昨天";
  if (/前天/.test(s)) return "前天";
  m = s.match(/(\d+)\s*(?:天|日)\s*前/);
  if (m) return `${m[1]}天前`;
  m = s.match(/(\d+)\s*周\s*前/);
  if (m) return `${m[1]}周前`;
  m = s.match(/(\d+)\s*个?月\s*前/);
  if (m) return `${m[1]}个月前`;
  m = s.match(/(\d+)\s*年\s*前/);
  if (m) return `${m[1]}年前`;
  // 绝对日期:2026年8月5日 / 2026-08-05 / 2026/08/05
  m = s.match(/(20\d{2})[年\/\-.]?(\d{1,2})[月\/\-.]?(\d{1,2})[日]?/);
  if (m && validMonthDay(m[2], m[3])) {
    return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
  }
  // 无年份 "8月5日":按当年推断(与 parseResultDateAgo 一致;相对新鲜的结果才这么显示)
  m = s.match(/(\d{1,2})月(\d{1,2})日/);
  if (m && validMonthDay(m[1], m[2])) {
    const y = new Date().getFullYear();
    return `${y}-${String(m[1]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
  }
  return "";
}

/** unix 秒 → YYYY-MM-DD(本地时区,避免 toISOString 的 UTC 偏移导致北京时间凌晨发布的文章日期差一天) */
export function tsToDate(ts) {
  const d = new Date(Number(ts) * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 最长公共连续子串长度(滚动数组 O(m) 空间)。
 * 原完整 DP 矩阵 O(n*m) 在长输入下爆内存(实测 8k 字符摘要单次分配 ~480MB,
 * 转载判定 pairwise 叠加 → 2GB OOM);滚动数组行为等价,长摘要可全量计算。
 * 从 engines/bing.mjs 下沉:通用文本算法,纯聚类/调度都不应依赖引擎模块。
 */
export function longestCommonSubstring(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 0;
  let prev = new Uint32Array(m + 1);
  let cur = new Uint32Array(m + 1);
  let best = 0;
  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1];
    for (let j = 1; j <= m; j++) {
      if (ai === b[j - 1]) {
        const v = prev[j - 1] + 1;
        cur[j] = v;
        if (v > best) best = v;
      } else {
        cur[j] = 0; // 连续子串:不等则断,显式清零(复用上一行数组)
      }
    }
    const t = prev;
    prev = cur;
    cur = t;
    cur.fill(0);
  }
  return best;
}

/** 标题归一化(去空白/标点差异) → 用于镜像页去重 */
export function normalizeTitle(t) {
  return String(t || "")
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[|｜·•\-—–_]/g, "")
    .slice(0, 80);
}

/**
 * 标题近重复判定(零词表,数据驱动):标题归一化后最长公共子串(LCS)占比判断。
 * 同源转载/镜像页标题常仅差站名后缀或少量增删;不同文章共享查询主题短语
 * 占比 ~0.5 以下不触发。双保险:LCS ≥ 12 字符 且 LCS/较短标题 ≥ 0.55;短标题(<8)不参与。
 * 从 aggregate.mjs 下沉:cluster 语义转载折叠的文本证据,不应依赖调度模块。
 */
export function isNearDuplicateTitle(a, b) {
  const ta = normalizeTitle(a);
  const tb = normalizeTitle(b);
  if (ta.length < 8 || tb.length < 8) return false;
  const lcs = longestCommonSubstring(ta, tb);
  return lcs >= 12 && lcs / Math.min(ta.length, tb.length) >= 0.55;
}
