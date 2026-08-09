/**
 * cluster-phrase.mjs — 短语模式:分词工具 + STC 风格建簇(零依赖)
 *
 * 从原 cluster.mjs 拆出(2026-08 重构,cluster.mjs 变为门面 re-export,公共 API 不变):
 *   - 分词:中文 n-gram / 英文单词 / 停用词 / 品牌别名 → 聚类 token
 *   - 建簇:共享显著短语(df≥2)关联 + 子集并入 + Jaccard 簇合并
 *
 * 本文件只依赖自身(纯函数),是聚类流水线的最底层。
 * ⚠ 语义模式的转载检测与建簇在 cluster-semantic.mjs,标签/变体工具在 cluster-labels.mjs。
 */

// ---- 分词:中文按字符 n-gram(2~4),英文按单词 ----

/** 中文 n-gram 集合(纯中文连续 n 字,避免英文/数字噪音)
 * ⚠ 与 domain-rep.mjs 的 cnBigrams 同族(固定 2-gram + 截断),改动行为时注意同步意图 */
export function cnGrams(text, n) {
  const t = String(text || "").replace(/\s+/g, "");
  const pat = new RegExp(`[\\u4e00-\\u9fff]{${n}}`);
  const g = new Set();
  for (let i = 0; i + n <= t.length; i++) {
    const seg = t.slice(i, i + n);
    if (pat.test(seg)) g.add(seg);
  }
  return g;
}

/** 英文单词(≥3 字母,去停用词)
 * ⚠ 与 domain-rep.mjs 的 enWords 同名不同义:本处用于聚类 token(数组 + 停用词),
 * 那边用于特征提取(Set + 数字词)。改动前先确认调用方语义。 */
const EN_STOP = new Set([
  "the", "and", "for", "with", "from", "that", "this", "your", "you", "are", "was",
  "have", "has", "not", "but", "all", "can", "how", "what", "when", "where", "why",
]);
export function enWords(text) {
  const words = (String(text || "").toLowerCase().match(/[a-z]{3,}/g) || []);
  return [...new Set(words.filter((w) => !EN_STOP.has(w)))];
}

/** 中文泛化词/来源词(2 字):可选词表——复用方注入 stopWords 时用于滤除泛词/噪音标签。
 * 默认不启用(实测真实搜索结果主题聚焦,词表命中率极低,删后簇结构无变化);
 * 仅当复用方遇到门户聚合页等泛查询场景时按需注入。 */
export const ZH_STOP = new Set([
  "今日", "昨日", "前天", "明天", "最新", "发布", "发展", "表示", "相关", "内容", "平台",
  "视频", "直播", "新闻", "人民网", "党建", "官网", "首页", "小时", "之前", "更多",
  "查看", "阅读", "全文", "原文", "标题", "来源", "点击", "进入", "搜索", "结果",
  "中国", "国际", "国内", "社会", "经济", "文化", "报道", "记者", "网友", "用户",
  "什么", "怎么", "如何", "为什么", "可以", "需要", "这样", "我们", "他们", "已经",
]);

/** 将结果标题转为特征 token 集(建簇只用标题:desc 里的泛词/时间戳会制造噪音簇)。
 * stopWords 默认空表(无词表模式);复用方按需注入。 */
export function titleTokens(title, stopWords = new Set()) {
  const toks = new Set();
  for (const n of [2, 3, 4]) for (const g of cnGrams(title, n)) toks.add(`c:${g}`);
  for (const w of enWords(title)) toks.add(`e:${w}`);
  return [...toks].filter((t) => {
    if (!t.startsWith("c:")) return true;
    const g = t.slice(2);
    if (stopWords.has(g)) return false; // 精确等于停用词(任意长度)
    // 修复: 旧实现硬编码 ZH_STOP 且只滤 2 字精确词,注入词表失效;且“深度解读”“今日黄历查询”
    // 这类以泛词开头/结尾的组合 gram 逃过过滤 → 制造噪音簇。这里按停用词前缀/后缀一并滤除。
    for (const w of stopWords) {
      if (w.length >= 2 && g.length > w.length && (g.startsWith(w) || g.endsWith(w))) return false;
    }
    return true;
  });
}

/** 中文品牌/术语 → 英文别名(查询 token 扩展用):可选词表——复用方注入 brandAlias 时用于
 * 跨语言加分(如搜“苹果”给英文 Apple 官网簇加分)。默认不启用(实测缺失时排名信号兜底,
 * 英文簇不归零,仅展示分数偏低,簇结构与排序不变)。 */
export const BRAND_ALIAS = {
  "苹果": "apple", "微博": "weibo", "抖音": "douyin", "微信": "wechat", "淘宝": "taobao",
  "京东": "jd", "腾讯": "tencent", "华为": "huawei", "小米": "xiaomi", "百度": "baidu",
  "知乎": "zhihu", "网易": "netease", "拼多多": "pinduoduo", "哔哩哔哩": "bilibili",
  "优酷": "youku", "谷歌": "google", "亚马逊": "amazon", "微软": "microsoft",
  "特斯拉": "tesla", "英伟达": "nvidia", "英特尔": "intel", "苹果公司": "apple",
};

/** 查询 token(用于相关性打分):返回 [{t, w}]。
 * - 不做停用词过滤:查询词短,即便"泛"也是用户意图
 * - 可选:中文品牌词扩展英文别名 token(权重 0.5,加分不稀释)。词典只是锦上添花,
 *   缺失时排名信号兜底,不依赖它
 * @param {string} query 查询词
 * @param {Record<string,string>} [brandAlias] 品牌别名表(默认 BRAND_ALIAS),复用方可注入
 */
export function queryTokens(query, brandAlias = BRAND_ALIAS) {
  const toks = [];
  const base = new Set();
  for (const g of cnGrams(query, 2)) base.add(`c:${g}`);
  for (const w of enWords(query)) base.add(`e:${w}`);
  for (const t of base) toks.push({ t, w: 1 });
  for (const g of cnGrams(query, 2)) {
    const alias = brandAlias[g]; // 用注入的词典(修复:旧代码硬编码 BRAND_ALIAS,自定义词典失效)
    if (alias) toks.push({ t: `e:${alias}`, w: 0.5 });
  }
  return toks;
}

/** 两个 token 集的 Jaccard 相似度 */
export function tokenJaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * 短语建簇:STC 风格(零依赖路径)。
 * 1. 显著短语(df≥2) → 候选簇;2. 子集并入 + Jaccard≥阈值合并。
 * @param {Array<{idx:number, tokens:Set<string>}>} docs 已算好 token 集的文档
 * @param {Map<string,number>} df 文档频率
 * @param {{mergeThreshold:number}} opts
 */
export function buildPhrase(docs, df, opts) {
  const sigTokens = [...df.entries()].filter(([, n]) => n >= 2).map(([t]) => t);
  let clusters = sigTokens.map((t) => ({
    token: t,
    members: new Set(docs.filter((d) => d.tokens.has(t)).map((d) => d.idx)),
  }));
  clusters.sort((a, b) => b.members.size - a.members.size);
  const merged = [];
  for (const c of clusters) {
    let target = null;
    for (const m of merged) {
      const inter = [...c.members].filter((x) => m.members.has(x)).length;
      const union = new Set([...c.members, ...m.members]).size;
      const isSubset = c.members.size > 0 && [...c.members].every((x) => m.members.has(x));
      if (isSubset || (union > 0 && inter / union >= opts.mergeThreshold)) {
        target = m;
        break;
      }
    }
    if (target) {
      for (const x of c.members) target.members.add(x);
      target.tokens.push(c.token);
    } else {
      merged.push({ token: c.token, tokens: [c.token], members: new Set(c.members) });
    }
  }
  return merged.map((c) => ({
    members: [...c.members].sort((a, b) => a - b).map((i) => docs[i]),
    tokens: c.tokens,
    dups: 0,
  }));
}
