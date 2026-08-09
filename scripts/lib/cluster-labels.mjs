/**
 * cluster-labels.mjs — 可读簇标签与簇内差异标注(纯字符串工具)
 *
 * 从原 cluster.mjs 拆出(2026-08 重构,cluster.mjs 变为门面 re-export,公共 API 不变):
 *   - 站点样板清洗(cleanTitleForLabel):剥掉"_CSDN博客" "| 知乎" 等尾巴
 *   - 最长公共子串(LCS)候选 + 句子级标点切段
 *   - 可读簇标签(readableClusterLabel):簇内标题两两 LCS 中得分最高者
 *   - 差异标注(distinctiveSpan):每条标题独有的连续片段,替代破碎 n-gram
 *
 * 本文件只依赖自身(纯函数),供 cluster.mjs 与其他复用方调用。
 */

/** 站点样板关键词:cleanTitleForLabel 只剥"分隔符+这些关键词"结尾的尾巴。
 * 仅用于标签/变体可读性,不参与建簇/排序(簇结构保持零词表)。 */
export const LABEL_SITE_HINTS = [
  "csdn", "知乎", "博客园", "百度百科", "维基百科", "什么值得买", "简书", "掘金", "infoq",
  "豆瓣", "央视网", "人民日报", "人民网", "腾讯网", "网易", "新浪", "搜狐", "头条", "澎湃",
  "界面新闻", "36氪", "虎嗅", "少数派", "汽车之家", "中关村在线", "哔哩哔哩", "微博",
  "微信公众号", "github", "stackoverflow", "mdn", "w3school", "官方", "官网", "首页", "百科",
  "门户", "技术社区",
];

const LABEL_SEP_RE = /(?:[_\-|｜·•]\s*)+([^_\-|｜·•]{0,16})$/;

/** 首尾分隔符/标点清理(标签候选与独有片段共用):LCS 可能把"_ 特斯拉汽车"的前导
 * 分隔符一并吞入,清理后才不影响可读性与打分。注意不能用 \w 清(下划线是 \w)。 */
export const EDGE_SEP_RE = /^[_\-|｜·•,，、;；:：()（）\[\]【】<>《》"'“”…\s.]+|[_\-|｜·•,，、;；:：()（）\[\]【】<>《》"'“”…\s.]+$/g;

/** 句子级标点:LCS 候选含这些标点时按标点切段取最长段。
 * 英文标题的 LCS 常跨 "Welcome, Cot: the " 这类共享残片当标签;
 * 注意不含连字符/括号/引号/空格(它们是词内/短语内成分,切了会破坏 "web-framework"
 * "Apple (中国大陆)" 这类合理结果)。 */
export const SENTENCE_SEP_RE = /[,，;；:：。.!！?？…]+/;

/** 标签/变体专用标题清洗:剥掉尾部站点样板("_CSDN博客" "| 知乎" "- 百度百科" " - 官方网站" 等),
 * 避免最长公共子串命中样板而不是主题。逐轮剥直到无样板(最多 4 轮)。只影响可读性。 */
export function cleanTitleForLabel(title, siteHints = LABEL_SITE_HINTS) {
  let t = String(title || "").trim();
  for (let i = 0; i < 4; i++) {
    const m = t.match(LABEL_SEP_RE);
    if (!m) break;
    const tail = m[1].toLowerCase();
    if (!siteHints.some((h) => tail.includes(h.toLowerCase()))) break;
    t = t.slice(0, m.index).trimEnd();
  }
  return t.trim();
}

/** 两串的最长公共连续子串,返回子串本身(bing.mjs 的同名函数只返回长度) */
export function longestCommonSpan(a, b) {
  if (!a || !b) return "";
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  let best = 0, end = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
        if (dp[i][j] > best) { best = dp[i][j]; end = i; }
      }
    }
  }
  return a.slice(end - best, end);
}

/**
 * 可读簇标签:簇内标题两两最长公共子串中得分最高者。
 * 得分 = 长度 + 覆盖标题数 + 含 df 最高 token 加成 —— 兼顾"长而完整"与"代表全簇";
 * 站点样板已由 cleanTitleForLabel 剥除,避免 LCS 命中"百度百科"这类样板。
 * 单例簇 / 两两无 ≥minLen 公共子串时回退旧逻辑(df 最高 token)。
 */
export function readableClusterLabel(titles, df, clusterToks, { maxLen = 18, minLen = 2 } = {}) {
  let clean = titles.map((t) => cleanTitleForLabel(t));
  // 超长标题截断:longestCommonSpan 的 O(n*m) DP 矩阵对超长输入(如 github 返回的
  // 长仓库描述/脏数据)会吃大量内存(实测与摘要 LCS 同源问题),标签可读性也不需要全文
  clean = clean.map((t) => (t.length > 200 ? t.slice(0, 200) : t));
  // 单例簇:没有簇内共享片段,标签直接用标题本身(回退"df 最高 token"会输出
  // "细胞/虚拟"这类主题词,单例簇可读性差 —— 标题本身才是最有信息量的标签)
  if (clean.length === 1) {
    const t = (clean[0] || "").trim();
    return t.length > maxLen ? t.slice(0, maxLen) : t;
  }
  const cands = new Map();
  for (let i = 0; i < clean.length; i++) {
    for (let j = i + 1; j < clean.length; j++) {
      const raw = longestCommonSpan(clean[i], clean[j]).replace(EDGE_SEP_RE, "");
      // LCS 若跨句子级标点(英文标题常见 "Welcome, Cot: the " 这类共享残片),
      // 按标点切段取最长段做候选;无句子级标点(中文短语/带括号短语)保持整串
      const pieces = SENTENCE_SEP_RE.test(raw)
        ? raw.split(SENTENCE_SEP_RE).filter(Boolean).map((p) => p.replace(EDGE_SEP_RE, ""))
        : [raw];
      for (const s of pieces) {
        if (s.length < minLen || !/[A-Za-z\u4e00-\u9fff]/.test(s)) continue;
        const cov = clean.reduce((n, t) => n + (t.includes(s) ? 1 : 0), 0);
        const old = cands.get(s);
        if (!old || cov > old.cov) cands.set(s, { s, cov });
      }
    }
  }
  // 回退标签:簇内 df 最高、长度最长的 token(去掉 c:/e: 前缀)
  const topTok = (clusterToks && clusterToks.length > 0 ? clusterToks : [])
    .map((t) => ({ t, df: df.get(t) || 0, len: t.length }))
    .sort((a, b) => b.df - a.df || b.len - a.len)[0]?.t || "";
  const topStr = topTok.replace(/^[ce]:/, "");
  const scored = [...cands.values()]
    .map((c) => ({
      s: c.s,
      score: c.s.length + c.cov + (topStr && c.s.toLowerCase().includes(topStr.toLowerCase()) ? 1.5 : 0),
    }))
    .sort((a, b) => b.score - a.score || b.s.length - a.s.length);
  const best = scored[0]?.s || topStr;
  return best.length > maxLen ? best.slice(0, maxLen) : best;
}

/** 把过长的独有片段切成"最短可读段":按常见分隔符切,优先取不在簇内共享(pool)的段,
 * 且不包含簇标签(避免与标签重复);清理首尾非词字符。 */
export function pickSegment(span, pool, label = "", maxLen = 14) {
  const segs = String(span)
    .split(/[_\-|｜·•,，、;；:：()（）\[\]【】<>《》"'“”…\s]+/)
    .filter(Boolean)
    .map((s) => s.replace(EDGE_SEP_RE, ""));
  const uniq = segs
    .filter((s) => s.length >= 2 && !(pool && pool.has(s)) && !(label && s.includes(label)))
    .sort((a, b) => b.length - a.length);
  const best = uniq[0] || segs.sort((a, b) => b.length - a.length)[0] || span;
  return best.length > maxLen ? best.slice(0, maxLen) : best;
}

/**
 * 条目代表性独有片段:标题中最长的、不出现于簇内其他标题(清洗后)的连续子串。
 * 旧实现取"df=1 的唯一 n-gram"(如"习路线自"——跨词边界的破碎 4-gram);
 * 本实现取真实连续片段,再按分隔符切成不与簇标签重复的最短可读段。
 */
export function distinctiveSpan(title, others, label = "") {
  const t = String(title || "");
  if (!t || others.length === 0) return "";
  const pool = new Set();
  for (const o of others) {
    const s = String(o || "");
    for (let i = 0; i < s.length; i++)
      for (let j = i + 2; j <= s.length; j++) pool.add(s.slice(i, j));
  }
  let best = "";
  for (let i = 0; i < t.length; i++) {
    for (let j = i + 2; j <= t.length; j++) {
      const sub = t.slice(i, j);
      if (pool.has(sub) || !/[A-Za-z0-9\u4e00-\u9fff]/.test(sub)) continue;
      if (sub.length > best.length) best = sub;
    }
  }
  return best ? pickSegment(best, pool, label) : "";
}
