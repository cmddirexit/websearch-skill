/**
 * cluster.mjs — 搜索结果聚类(双模式:短语 STC / 语义嵌入,质量加权)【门面】
 *
 * 调研结论:网上无开箱即用的轻量"搜索结果聚类"JS 库(Carrot2 是 Java,
 * npm 上只有通用聚类/后缀树数据结构),故按经典算法思想自研。
 *
 * 2026-08 重构:870 行算法杂货铺按职责拆为三个子模块,本文件保留
 * DEFAULT_OPTIONS + clusterResults 主函数 + 全部公共导出(re-export),API 零变化:
 *   - cluster-phrase.mjs   分词工具(cnGrams/enWords/queryTokens/titleTokens...) + 短语建簇
 *   - cluster-semantic.mjs 余弦/转载检测 + 语义建簇(贪心首领/超大簇拆分/单例桶合并)
 *   - cluster-labels.mjs   可读簇标签/簇内差异标注(纯字符串工具)
 *
 * 两条路径(输出契约一致,可无缝切换):
 *   1. 短语模式(零依赖,默认):STC 风格 —— 共享显著短语关联 + Jaccard 簇合并
 *   2. 语义模式(可选,传入 vectors):嵌入余弦 + 贪心首领聚类 —— 无共享词也能聚,
 *      跨语言/近义表达也识别;接近重复(cosine ≥ dupThreshold)自动折叠计数
 * 语义模式无 vectors 时自动回退短语模式(零回归)。
 *
 * 质量加权:结果可携带 quality[0,1](由 filter.mjs 生成),簇分数乘以
 * (0.5 + 0.5×簇内平均质量) —— 广告/垃圾页所在的簇整体沉底(lowRelevance),
 * 纯主题簇不受影响。
 */

// ---- 语义聚类阈值(统一来自 config.mjs,调参先看那里) ----
import { CLUSTER_SIM_THRESHOLD, CLUSTER_DUP_THRESHOLD, REPRINT_THRESHOLD, CLUSTER_NOISE_SCORE, SEM_WEIGHT, SEM_NOISE_THRESHOLD, MAX_CLUSTER_SIZE, BUCKET_SINGLETONS, MAX_BUCKET_SIZE } from "./config.mjs";
import { buildPhrase, cnGrams, enWords, queryTokens, titleTokens } from "./cluster-phrase.mjs";
import { buildSemantic, cosine, hasReprintTextEvidence } from "./cluster-semantic.mjs";
import { cleanTitleForLabel, distinctiveSpan, readableClusterLabel } from "./cluster-labels.mjs";

// ---- re-export(公共 API 不变,index.mjs 与其他复用方零改动) ----
export { cnGrams, enWords, ZH_STOP, titleTokens, BRAND_ALIAS, queryTokens, tokenJaccard } from "./cluster-phrase.mjs";
export { cosine, cosineMatrix, isNearDuplicateDesc, hasReprintTextEvidence } from "./cluster-semantic.mjs";
export {
  LABEL_SITE_HINTS, EDGE_SEP_RE, SENTENCE_SEP_RE,
  cleanTitleForLabel, longestCommonSpan, readableClusterLabel, pickSegment, distinctiveSpan,
} from "./cluster-labels.mjs";

/**
 * 相关性打分权重:文本命中率(查询 token 对齐)与引擎排名信号(搜索引擎自己的相关性判断)。
 * 排名信号是跨语言/跨语义的通用兜底:搜"苹果"返回 Apple 官网 rank1,bing 已替你对齐了"苹果≈Apple",
 * 即使文本完全不匹配(中文查询 vs 英文标题),簇也不会归零。
 */
const TEXT_WEIGHT = 0.7;
const RANK_WEIGHT = 0.3;

/**
 * 聚类默认配置;复用方可注入自己的停用词/品牌词典/权重/合并阈值/语义阈值。
 * 默认零词表(实测真实搜索无需词表,簇结构与排序不受影响;
 * 词表仅对门户聚合页等泛查询场景有帮助,按需注入)。
 */
export const DEFAULT_OPTIONS = {
  stopWords: new Set(),
  brandAlias: {},
  textWeight: TEXT_WEIGHT,
  rankWeight: RANK_WEIGHT,
  // ---- 语义相关性重排(有 queryVec 时生效;ML 温和过滤,不剔除任何结果) ----
  semWeight: SEM_WEIGHT,
  semNoise: SEM_NOISE_THRESHOLD,
  mergeThreshold: 0.55,
  // ---- 语义模式(传入 vectors 时生效)阈值来自 config.mjs,可用环境变量覆盖 ----
  // 模型适配:bge-small-zh(默认)用 0.42;multilingual-e5-small 无前缀相似度整体上移,应调 ~0.80
  simThreshold: Number(process.env.WEBSEARCH_SIM_THRESHOLD) || CLUSTER_SIM_THRESHOLD,
  dupThreshold: CLUSTER_DUP_THRESHOLD,
  // 转载级折叠候选门槛(0.75~dupThreshold 区间需文本证据,见 clusterResults 预处理)
  reprintThreshold: REPRINT_THRESHOLD,
  // ---- 超大簇拆分(仅语义模式;信号数据驱动,见 cluster-semantic.mjs splitBySignals) ----
  // 簇内成员数 > maxClusterSize 时检查拆分:pairwise 归属度 IQR 离群检测
  // + 当前结果集词频子主题分组,均无固定阈值
  maxClusterSize: MAX_CLUSTER_SIZE,
  maxSplitDepth: 3,
  // ---- 单例语义桶合并(仅语义模式;UPGMA 平均链接,见 cluster-semantic.mjs upgmaBuckets) ----
  bucketSingletons: BUCKET_SINGLETONS,
  maxBucketSize: MAX_BUCKET_SIZE,
  // ---- 质量加权 ----
  noiseScore: CLUSTER_NOISE_SCORE,
};

/**
 * 聚类主函数。
 * @param {Array<{title:string, desc?:string, [url]?:string, [quality]?:number, [flags]?:string[]}>} results
 *   搜索结果。⚠️ 隐式契约:数组顺序 = 引擎相关性排序(排名信号依赖它,rank=index+1);
 *   url 字段可选;quality/flags 由 filter.mjs 附加(缺失按 1/[] 处理)
 * @param {string} query 搜索词(用于簇相关性排序)
 * @param {Partial<typeof DEFAULT_OPTIONS>} [options]
 *   - vectors: 可选语义模式。与 results 等长的嵌入向量数组(embed.mjs 生成);
 *     缺失/长度不符 → 自动回退短语模式
 * @returns {{clusters:Array<{label:string, score:number, size:number, quality:number,
 *            lowRelevance:boolean, duplicates:number, items:Array, variants:string[]}>,
 *            uncovered:Array, phrases:Array<{phrase:string, df:number}>}}
 */
export function clusterResults(results, query, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const semanticOk =
    opts.vectors && opts.vectors.length === results.length && results.length > 0;
  // query↔文档语义重排可用性:向量维度与结果一致(embed.mjs 保证同模型同维度)
  const semanticRel =
    semanticOk && opts.queryVec && opts.queryVec.length === opts.vectors[0].length;

  // 1. 每条的标题 token(短语信号)、全文本(相关性打分)、向量(语义信号)、质量
  const docs = results.map((r, i) => ({
    idx: i,
    result: r,
    vec: semanticOk ? opts.vectors[i] : null,
    // ML 相关性:查询向量 ↔ 文档向量余弦(0~1;归一化向量余弦为负时截断为 0)
    rel: semanticRel ? Math.max(0, cosine(opts.queryVec, opts.vectors[i])) : null,
    text: `${r.title || ""} ${r.desc || ""}`,
    tokens: new Set(titleTokens(r.title || "", opts.stopWords)),
    quality: typeof r.quality === "number" ? r.quality : 1,
  }));

  // 2. 文档频率(短语模式建簇 + 标签/变体标注共用;语义模式标签仍用短语,保证可读)
  const df = new Map();
  for (const d of docs) for (const t of d.tokens) df.set(t, (df.get(t) || 0) + 1);

  // 2.5 语义转载折叠预处理(仅语义模式;软折叠,不丢 URL,只计数+保留代表条):
  //    pairwise 余弦落在 [reprintThreshold, dupThreshold) 区间(转载级,实测 0.75~0.94)
  //    且标题/摘要有文本近重复证据 → "后出现者"标记 dup=true —— 折叠计数,不参与建簇
  //    与展示。换措辞转载(标题不同但正文同源,实测 ~0.84)可折叠;同主题不同文
  //    (向量可能 0.75~0.85 但标题摘要都不同)不误杀。
  //    ≥ dupThreshold 的镜像级折叠仍由 greedyClusterByCentroid 的 centroid 机制负责
  //    (两机制互补不重叠,避免 pairwise 比 centroid 激进造成行为回归)。
  //    比聚合层字符 LCS 硬过滤更准、更软(URL 保留在折叠详情)。
  if (semanticOk) {
    for (let i = 0; i < docs.length; i++) {
      if (docs[i].dup) continue;
      for (let j = i + 1; j < docs.length; j++) {
        if (docs[j].dup) continue;
        const sim = cosine(docs[i].vec, docs[j].vec);
        if (sim < opts.reprintThreshold || sim >= opts.dupThreshold) continue;
        if (hasReprintTextEvidence(docs[i].result, docs[j].result)) {
          docs[j].dup = true; // 后出现者折叠(主引擎/靠前结果优先保留)
        }
      }
    }
  }

  // 3. 建簇(双模式)
  const rawClusters = semanticOk
    ? buildSemantic(docs, opts)
    : buildPhrase(docs, df, opts);

  // 4. 标签 + 相关性打分(质量加权)+ 排序
  const qToks = queryTokens(query, opts.brandAlias);
  const baseW = qToks.filter((x) => x.w === 1).length; // 别名只加分不稀释的分母
  const out = rawClusters
    .map((c) => {
      // 标签:可读簇标签 —— 簇内标题两两最长公共子串(LCS),避免旧实现取 2~4 字 n-gram
      // 产生"计算机基/习路线自"这类破碎标签;单例簇/无共享片段时回退 df 最高 token
      const items = c.members;
      const label = readableClusterLabel(
        items.map((d) => d.result.title || ""),
        df,
        (c.tokens && c.tokens.length > 0) ? c.tokens : docs.flatMap((d) => [...d.tokens])
      );
      // 相关性:查询 token 按簇内命中文档**占比**贡献(修复:旧实现对拼接文本"任一命中即满分",
      // 10 条大簇仅 1 条相关也 textScore=1 → 排序虚高;且拼接文本有跨文档边界伪 gram)。
      // 英文跨语言簇由排名信号(RANK_WEIGHT)兜底,不依赖文本命中。
      const texts = items.map((d) => d.text);
      let total = 0;
      for (const { t, w } of qToks) {
        const gram = t.slice(2);
        let n = 0;
        for (const txt of texts) {
          const ok = t.startsWith("c:")
            ? cnGrams(txt, t.length - 2).has(gram)
            : enWords(txt).includes(gram);
          if (ok) n++;
        }
        if (n > 0) total += w * (n / texts.length);
      }
      // 封顶 1:别名 token 命中可致 total>baseW(修复:旧实现输出"相关度 1.20")
      const textScore = baseW > 0 ? Math.min(1, total / baseW) : 0;
      // 排名信号:簇内结果平均原始排名(数组顺序即引擎排序,rank=idx+1),归一化到 [0,1]
      const avgRank = items.reduce((s, d) => s + d.idx + 1, 0) / items.length;
      const rankScore = results.length > 1 ? 1 - (avgRank - 1) / (results.length - 1) : 1;
      // 质量加权:簇分数 × (0.5 + 0.5×簇内平均质量)。纯主题簇质量≈1 无影响;
      // 广告/垃圾聚集的簇质量低 → 分数被压沉(不剔除但排后 + lowRelevance)
      const meanQ = items.reduce((s, d) => s + d.quality, 0) / items.length;
      // 语义相关性重排(ML):簇内 query↔文档平均余弦。词典页/导航站/纯列表页
      // 与查询语义距离远 → semScore 低 → 簇自然沉底 + 标低相关,但**不剔除**
      // (用户真查"best 什么意思"时词典结果 semScore 高,不会被误杀 ——
      // 这是比域名黑名单/规则降权更温和、更准的过滤)。
      // 无 queryVec(嵌入不可用)时走原 text+rank 打分,零回归。
      const semScore = semanticRel
        ? items.reduce((s, d) => s + d.rel, 0) / items.length
        : null;
      let score;
      let lowRelevance;
      if (semanticRel) {
        // 语义为主,text/rank 按 (1-semWeight) 比例收缩,三者之和恒为 1
        const w = opts.semWeight;
        const tw = opts.textWeight * (1 - w);
        const rw = opts.rankWeight * (1 - w);
        score = (w * semScore + tw * textScore + rw * rankScore) * (0.5 + 0.5 * meanQ);
        // 双低相关信号:总分数低,或语义分单独低于阈值(文本命中但语义无关,
        // 如"best 是什么意思"命中查询词 best —— 语义分才能抓住这类)
        lowRelevance = score < opts.noiseScore || semScore < opts.semNoise;
      } else {
        score = (opts.textWeight * textScore + opts.rankWeight * rankScore) * (0.5 + 0.5 * meanQ);
        lowRelevance = score < opts.noiseScore;
      }
      // 簇内差异标注:每条标题中最长的、不出现于簇内其他标题的连续片段(清洗样板后),
      // 替代旧实现的"唯一 n-gram"(输出"习路线自"这类跨词边界破碎 4-gram)
      const variants = items.map((d) => {
        const t = cleanTitleForLabel(d.result.title || "");
        const others = items.filter((x) => x !== d).map((x) => cleanTitleForLabel(x.result.title || ""));
        return distinctiveSpan(t, others, label);
      }).filter(Boolean);
      return {
        label,
        score,
        size: items.length,
        quality: meanQ,
        lowRelevance,
        duplicates: c.dups || 0,
        items,
        variants,
        semScore,
        // 文本命中率(供 relevance.mjs 判断"含查询词但语义无关")——仅评分用,不参与展示
        textScore,
      };
    })
    .sort((a, b) => b.score - a.score || b.size - a.size);

  // 5. 结果不跨簇重复:簇按(相关度, 规模)排序后,每条结果只归入第一个包含它的簇
  //    去重键 = 数组位置(idx),不依赖 url(复用方结果可无 url 字段)
  const assigned = new Set();
  const finalClusters = [];
  for (const c of out) {
    const items = c.items.filter((d) => !assigned.has(d.idx));
    for (const d of items) assigned.add(d.idx);
    if (items.length > 0) {
      finalClusters.push({
        label: c.label,
        score: c.score,
        size: items.length,
        quality: c.quality,
        lowRelevance: c.lowRelevance,
        duplicates: c.duplicates,
        items: items.map((d) => ({
          ...d.result,
          // 每条结果的 ML 语义相关度(0~1);无语义重排时为 undefined(不输出)
          ...(semanticRel ? { rel: d.rel } : {}),
        })),
        variants: c.variants,
        // 簇级语义相关性(ML;无语义重排时为 null)——CLI 展示与库复用方判断用
        semScore: semanticRel ? c.semScore : null,
        textScore: semanticRel ? c.textScore : null,
      });
    }
  }
  const uncovered = results.filter((_, i) => !assigned.has(i) && !docs[i].dup);

  return {
    clusters: finalClusters,
    uncovered,
    phrases: [...df.entries()]
      .filter(([, n]) => n >= 2)
      .map(([t, n]) => ({ phrase: t.replace(/^[ce]:/, ""), df: n }))
      .sort((a, b) => b.df - a.df)
      .slice(0, 20),
  };
}
