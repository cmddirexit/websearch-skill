/**
 * relevance.mjs — 语义相关性分级(展示策略层,纯函数零 IO)
 *
 * 职责:把语义分(0~1,query↔文档余弦,见 cluster.mjs 的 semScore/rel)映射为
 * 三档展示级别,并生成可读的原因描述 —— 供 CLI 决定"给 LLM 多少信息":
 *   relevant    完整展示(标题+摘要+URL)
 *   edge        精简展示(标题+短摘要+URL)—— 摘要截断,兼顾信息与防误导
 *   irrelevant  沉底折叠区,只留 URL+原因 —— 信息不删,但明确提示可忽略
 *
 * 设计原则(可维护性):
 *  - 纯函数,无 IO 无状态,单测覆盖阈值/分级/原因三段逻辑
 *  - 阈值自适应:基于当前结果集最高语义分(top)的比例 + 绝对下限双保险,
 *    避免固定阈值随模型/语言漂移失真(实测 Qwen3-8B:相关簇 0.59,词典 0.36)
 *  - 不硬编码域名/词表判断原因:只用"文本命中率 vs 语义分"两个已有信号
 *  - 无语义分(semScore 为 null,嵌入不可用)时返回 unscored,调用方走原逻辑(零回归)
 *
 * 调用链:cluster.mjs 产出 semScore/textScore → 本模块分级 → cli.mjs 展示
 *
 * 阈值/模式默认值统一来自 config.mjs(REL_* 常量),调用方无需传参;
 * 传入 opts 可覆盖(测试/库复用方按需微调)。
 */

import {
  REL_MODE,
  REL_RELEVANT_MIN,
  REL_RELEVANT_RATIO,
  REL_IRRELEVANT_MIN,
  REL_IRRELEVANT_RATIO,
  REL_TEXT_HIT,
} from "./config.mjs";

// ---- 分级级别 ----
export const REL_LEVELS = ["relevant", "edge", "irrelevant", "unscored"];

/**
 * 阈值/模式默认值(内部读 config;调用方可传 opts 覆盖单个值)
 */
function relDefaults(opts = {}) {
  return {
    relevantMin: opts.relevantMin ?? REL_RELEVANT_MIN,
    relevantRatio: opts.relevantRatio ?? REL_RELEVANT_RATIO,
    irrelevantMin: opts.irrelevantMin ?? REL_IRRELEVANT_MIN,
    irrelevantRatio: opts.irrelevantRatio ?? REL_IRRELEVANT_RATIO,
    textHit: opts.textHit ?? REL_TEXT_HIT,
    relMode: opts.relMode ?? REL_MODE,
  };
}

/**
 * 自适应阈值:基于当前结果集语义分分布计算两档分界。
 * 公式:edge = max(relevantMin, top×relevantRatio);irrelevant = max(irrelevantMin, top×irrelevantRatio)。
 * top 很低(全结果都低相关,如查询过泛)时绝对下限兜底,避免把垃圾也当相关。
 * @param {Array<number|null|undefined>} semScores 全部簇/条目的语义分
 * @param {{relevantMin?:number, relevantRatio?:number, irrelevantMin?:number, irrelevantRatio?:number}} [opts]
 * @returns {{edge:number, irrelevant:number, top:number}} edge=相关/边缘分界(>=edge 相关), irrelevant=边缘/无关分界(<irrelevant 无关)
 */
export function computeRelThresholds(semScores, opts = {}) {
  const top = Math.max(0, ...(semScores || []).filter((s) => typeof s === "number"));
  const d = relDefaults(opts);
  const edge = Math.max(d.relevantMin, top * d.relevantRatio);
  const irrelevant = Math.max(d.irrelevantMin, top * d.irrelevantRatio);
  return { edge, irrelevant, top };
}

/**
 * 单簇分级。
 * @param {number|null} semScore 簇语义分(null=无嵌入)
 * @param {{edge:number, irrelevant:number}} thresholds computeRelThresholds 的结果
 * @returns {"relevant"|"edge"|"irrelevant"|"unscored"}
 */
export function gradeCluster(semScore, thresholds) {
  if (semScore === null || semScore === undefined) return "unscored";
  if (semScore >= thresholds.edge) return "relevant";
  if (semScore >= thresholds.irrelevant) return "edge";
  return "irrelevant";
}

/**
 * 无关/边缘结果的原因描述(数据驱动,非域名黑名单):
 *  - 文本命中率高(textScore≥textHit)但语义分低 → 标题/摘要含查询词,属表面匹配
 *  - 否则 → 与查询主题无关联
 * @param {{semScore?:number, textScore?:number}} cluster
 * @param {{textHit?:number}} [opts]
 * @returns {string}
 */
export function irrelevantReason(cluster, opts = {}) {
  const d = relDefaults(opts);
  const hit = typeof cluster?.textScore === "number" && cluster.textScore >= d.textHit;
  const score = typeof cluster?.semScore === "number" ? cluster.semScore.toFixed(2) : "?";
  return hit
    ? `标题/摘要含查询词但语义无关(语义 ${score})`
    : `与查询主题无明显语义关联(语义 ${score})`;
}

/**
 * 折叠/展示决策(纯函数)——从 cli.mjs 提取的核心决策逻辑,库复用方可直接调用。
 *
 * 三档分级(仅语义分可用时;无语义分则全进 shown 零回归):
 *  - relevant   完整展示(标题+摘要+URL)
 *  - edge       精简展示(标题+短摘要+URL —— 摘要截断,降低误导同时不丢信息)
 *  - irrelevant 折叠成一行(簇名×条数+语义分),详情写 reveal 文件,URL 不丢
 * 模式差异:
 *  - balanced(默认):三档全用
 *  - aggressive:edge+irrelevant 都折叠成一行(只保留 relevant 完整展示)
 *  - conservative:只排序不折叠(全进 shown)
 *
 * @param {Array} clusters clusterResults 输出的簇数组(带 semScore)
 * @param {{relMode?:string}} [opts] relMode: balanced / aggressive / conservative
 * @returns {{thresholds:Object|null, shown:Array, edge:Array, collapsed:Array}}
 *          thresholds={edge,irrelevant,top}|null
 */
export function buildPresentation(clusters, opts = {}) {
  const d = relDefaults(opts);
  const thresholds = clusters.some((c) => typeof c.semScore === "number")
    ? computeRelThresholds(clusters.map((c) => c.semScore), d)
    : null;
  const foldEdge = d.relMode === "aggressive";
  const shown = [];
  const edge = [];
  const collapsed = [];
  for (const c of clusters) {
    const grade = thresholds && d.relMode !== "conservative"
      ? gradeCluster(c.semScore, thresholds)
      : "relevant";
    if (grade === "relevant") shown.push(c);
    else if (grade === "edge" && !foldEdge) edge.push(c);
    else collapsed.push(c);
  }
  return { thresholds, shown, edge, collapsed };
}

/**
 * 折叠区一行摘要(LLM 快速感知折叠了什么、几条):
 *   [簇名]×条数(语义 X.XX) · [簇名]×条数(语义 Y.YY)
 * 簇名是最强信号(如"best 是什么意思"→词典页),语义分辅助判断,详情在 reveal 文件。
 * @param {Array} collapsed 折叠簇数组(clusterResults 输出的簇对象)
 * @returns {string}
 */
export function collapsedBrief(collapsed) {
  return collapsed
    .map((c) => {
      const s = typeof c.semScore === "number" ? `(${c.semScore.toFixed(2)})` : "";
      return `[${c.label}]×${c.size}${s}`;
    })
    .join(" · ");
}

/**
 * 折叠详情缓存内容(Markdown,供 reveal 命令 / agent 直接读文件展开查看)。
 * 每条:簇名+条数+语义分+原因,条目带标题与 URL —— 信息完整,可 fetch 深挖。
 * @param {Array} collapsed 折叠簇数组
 * @param {string} query 搜索词(文件头标注来源查询)
 * @param {{textHit?:number}} [opts]
 * @returns {string} Markdown 文本
 */
export function collapsedMarkdown(collapsed, query, opts = {}) {
  const lines = [`# 低相关折叠(查询: ${query || ""})`, ""];
  for (const c of collapsed) {
    const s = typeof c.semScore === "number" ? c.semScore.toFixed(2) : "?";
    lines.push(`## [${c.label}] ×${c.size} · 语义 ${s}`);
    lines.push(`原因: ${irrelevantReason(c, opts)}`);
    for (const x of c.items || []) {
      lines.push(`- ${x.title || ""}`);
      if (x.url) lines.push(`  ${x.url}`);
    }
    for (const x of c.duplicateItems || []) {
      lines.push(`- [近似重复] ${x.title || ""}`);
      if (x.url) lines.push(`  ${x.url}`);
      if (x.duplicateOf) lines.push(`  代表: ${x.duplicateOf}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
