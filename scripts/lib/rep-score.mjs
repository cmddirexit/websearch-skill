/**
 * rep-score.mjs — 域名信誉评分 + 在线跨域模式权重更新(纯函数)
 *
 * 从 domain-rep.mjs 拆出(2026-08 重构,domain-rep.mjs 变为实例 + 门面 re-export):
 *   - 样本贡献分(contributionFromQuality)/ 域名级增量更新(updateScore/updateFetchScore)
 *   - 有效分融合 / 时间衰减 / 乘性因子 / 展示 badge
 *   - 在线模式:模式预测(predictTokens)+ 权重更新(updateMetaTokens,词袋逻辑回归)
 *
 * 本文件只依赖 config.mjs(阈值),不依赖文件 IO/实例状态 —— 可单独单测。
 */

import {
  REP_MIN_SAMPLES, REP_STRENGTH, REP_DECAY_START_DAYS, REP_DECAY_FULL_DAYS,
  META_LR, META_MAX_WEIGHTS, META_FTRL_BETA, META_FTRL_L1, META_FTRL_L2,
  META_MIN_SAMPLES, META_MIN_CLASS_SAMPLES,
} from "./config.mjs";

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * 内容质量类低质标记(spam/标题模板/栏目页/短链等):计入低质率(lowHits)。
 * 注意:**desc-empty/desc-short/long-url/many-params 是"展示受限"而非"内容垃圾",
 * 不计入低质率** —— 知乎等反爬站的搜索结果普遍 desc-empty,误伤代价高;
 * 软文站的实质低质特征(垃圾文案/模板标题/栏目页)才是学习信号。
 */
export const CONTENT_LOW_FLAGS = new Set([
  "low:spam-title", "low:spam-desc", "low:title", "low:index-page",
  "low:shouty", "low:allcaps", "low:shortener", "low:desc-marker",
]);

/**
 * 单样本贡献分(0~1):quality 为主,spam/栏目页标记叠加惩罚。
 * desc-empty 等展示受限标记仅微减(0.95)—— 知乎反爬也 desc-empty,重罚误伤。
 * 纯函数,可单测。@param {number} quality 规则质量分 [0,1] @param {string[]} flags
 */
export function contributionFromQuality(quality, flags = []) {
  let c = Number.isFinite(quality) ? quality : 0.5;
  if (flags.includes("low:spam-title") || flags.includes("low:spam-desc")) c *= 0.4;
  if (flags.includes("low:index-page")) c *= 0.5;
  if (flags.includes("low:desc-empty")) c *= 0.95; // 中性化:信息缺失 ≠ 内容垃圾
  return clamp(c, 0.05, 1);
}

/**
 * 增量平滑更新(域名级搜索推断信号):score += lr×(contribution−score),lr 随样本数递减。
 * 样本 1→lr≈0.5(cap 防首样本误判全覆盖),10→0.45,50→0.14,200→0.04:早期快速学习,后期抗噪声。
 */
export function updateScore(entry, contribution) {
  entry.searchSamples = (entry.searchSamples || 0) + 1;
  const lr = Math.min(0.5, 1 / (1 + entry.searchSamples * 0.12)); // cap:一次误判最多搬动一半,而非 89%
  entry.searchScore += lr * (contribution - entry.searchScore);
  entry.searchScore = clamp(entry.searchScore, 0, 1);
  return entry.searchScore;
}

/**
 * fetch 实测信号更新(比 SERP 推断可靠得多):固定 0.5 混合率(旧 0.5 + 新 0.5),
 * 每次实测都会实质性校正分数 —— 不会被大量中性搜索样本稀释。
 */
export function updateFetchScore(entry, contribution) {
  entry.contentSamples = (entry.contentSamples || 0) + 1;
  entry.contentScore = 0.5 * contribution + 0.5 * (entry.contentScore ?? 0.5);
  entry.contentScore = clamp(entry.contentScore, 0, 1);
  return entry.contentScore;
}

/** 抓取可用性与内容质量分离。404/空壳只能更新这个分数,不得训练内容模式。 */
export function updateAvailabilityScore(entry, available) {
  entry.availabilitySamples = (entry.availabilitySamples || 0) + 1;
  const contribution = available ? 0.95 : 0.1;
  entry.availabilityScore = 0.5 * contribution + 0.5 * (entry.availabilityScore ?? 0.5);
  return clamp(entry.availabilityScore, 0, 1);
}

/**
 * 主动选择使用价值。它只累计正向选择次数,不表示正文可信或抓取可用,也不参与跨域模型。
 * score 由独立样本数确定,避免重复增量公式在状态迁移或回放时产生漂移。
 */
export function updateUtilityScore(entry) {
  entry.utilitySamples = (entry.utilitySamples || 0) + 1;
  entry.utilityScore = clamp(entry.utilitySamples / 5, 0, 1);
  return entry.utilityScore;
}

/** 至少 3 次独立选择后才微升,5 次达到上限 3%;没有负向 utility 反馈。 */
export function utilityFactor(entry) {
  const samples = entry?.utilitySamples || 0;
  if (samples < REP_MIN_SAMPLES) return 1;
  const score = Number.isFinite(entry?.utilityScore)
    ? entry.utilityScore
    : clamp(samples / 5, 0, 1);
  return 1 + 0.03 * clamp(score, 0, 1);
}

/** 有效分:有 fetch 实测时实测优先(0.7/0.3 融合),无实测回退搜索推断分。
 * 软文站搜索样本多但 fetch 一次空壳 → 实测把分钉低,搜索样本拉不回来。 */
export function effectiveScore(e) {
  const s = e.searchScore ?? 0.5;
  if ((e.contentSamples || 0) > 0) return 0.7 * (e.contentScore ?? 0.5) + 0.3 * s;
  return s;
}

/** 可用性只温和影响排序,且至少需要 3 次观测。它不改变内容信誉分或 badge。 */
export function availabilityFactor(entry) {
  if ((entry?.availabilitySamples || 0) < REP_MIN_SAMPLES) return 1;
  return clamp(1 + ((entry.availabilityScore ?? 0.5) - 0.5) * 0.5, 0.75, 1.05);
}

/** 时间衰减:超过 REP_DECAY_START_DAYS 未见,分数向 0.5 回归;FULL_DAYS 完全中性。纯函数。 */
export function decayedScore(entry, now = Date.now()) {
  const ageDays = (now - (entry.lastSeen || now)) / 86_400_000;
  if (ageDays <= REP_DECAY_START_DAYS) return effectiveScore(entry);
  const t = clamp((ageDays - REP_DECAY_START_DAYS) / (REP_DECAY_FULL_DAYS - REP_DECAY_START_DAYS), 0, 1);
  return 0.5 + (effectiveScore(entry) - 0.5) * (1 - t);
}

/** 信誉分 → quality 乘性因子(软降权):0.5→1.0,0→0.35,1→1.15;冷启动(样本不足)不干预。纯函数。 */
export function repFactor(score, samples = REP_MIN_SAMPLES) {
  if (samples < REP_MIN_SAMPLES) return 1;
  return clamp(1 + (score - 0.5) * REP_STRENGTH, 0.35, 1.15);
}

/** 信誉分 → 展示 badge:≥0.65 正,≤0.35 负,中间中性;样本不足无 badge */
export function repBadge(score, samples) {
  if (samples < REP_MIN_SAMPLES) return "";
  const s = score.toFixed(2);
  if (score >= 0.65) return `✓[rep:${s}]`;
  if (score <= 0.35) return `⚠[rep:${s}]`;
  return `·[rep:${s}]`;
}

/**
 * 模式预测(sigmoid):激活 token 权重之和 → [0,1],0.5 中性。
 * 关键设计:**不包含 bias** —— 无特征(全新 token 集)预测恒为 0.5,
 * 即"未知先验中性":不冤枉也不放过新域名。bias 不参与预测,权重学的就是
 * token 相对中性的偏差(该 token 出现 → 质量高于/低于 0.5 多少)。
 * 纯函数,可单测。@param {Set<string>} tokens 激活 token 集
 */
export function normalizedFeatureVector(tokens) {
  const byChannel = new Map();
  for (const token of tokens || []) {
    const channel = token.slice(0, 2);
    // 域名身份属于域名模型;filter flag 属于规则标签。两者都不得进入跨域模式。
    if (channel !== "t:" && channel !== "u:") continue;
    if (!byChannel.has(channel)) byChannel.set(channel, []);
    byChannel.get(channel).push(token);
  }
  const vector = new Map();
  for (const values of byChannel.values()) {
    // Channel contribution is an average, so adding correlated title bigrams cannot by itself
    // make the prediction more extreme.
    const scale = 1 / values.length;
    for (const token of values) vector.set(token, scale);
  }
  return vector;
}

export function predictTokens(tokens, meta) {
  let z = 0;
  for (const [t, x] of normalizedFeatureVector(tokens)) z += (meta?.weights?.[t] ?? 0) * x;
  return 1 / (1 + Math.exp(-z));
}

export function metaReady(meta) {
  return (meta?.effectiveSamples || 0) >= META_MIN_SAMPLES
    && (meta?.positiveSamples || 0) >= META_MIN_CLASS_SAMPLES
    && (meta?.negativeSamples || 0) >= META_MIN_CLASS_SAMPLES;
}

function ftrlWeight(z, n) {
  if (Math.abs(z) <= META_FTRL_L1) return 0;
  return -(z - Math.sign(z) * META_FTRL_L1)
    / ((META_FTRL_BETA + Math.sqrt(n)) / META_LR + META_FTRL_L2);
}

/**
 * FTRL-Proximal 在线更新。标题和 URL 通道分别做 L1 归一化,避免长标题的相关
 * bigram 被当成多份独立证据;confidence 控制弱标签的梯度贡献。
 * @returns {boolean} 是否有 token 被更新
 */
export function updateMetaTokens(meta, tokens, label, { confidence = 1 } = {}) {
  const vector = normalizedFeatureVector(tokens);
  if (!vector.size || !Number.isFinite(label) || confidence <= 0) return false;
  const pred = predictTokens(tokens, meta);
  const err = clamp(label - pred, -1, 1);
  meta.weightSamples = (meta.weightSamples || 0) + 1;
  meta.effectiveSamples = (meta.effectiveSamples || 0) + clamp(confidence, 0, 1);
  if (label >= 0.65) meta.positiveSamples = (meta.positiveSamples || 0) + confidence;
  else if (label <= 0.35) meta.negativeSamples = (meta.negativeSamples || 0) + confidence;
  // bias 不参与预测(无特征=0.5 先验中性),权重即 token 相对中性的偏差
  meta.bias = 0;
  meta.touched = meta.touched || {};
  meta.z = meta.z || {};
  meta.n = meta.n || {};
  for (const [t, x] of vector) {
    const oldN = meta.n[t] || 0;
    const oldW = meta.weights[t] || 0;
    const gradient = -err * x * clamp(confidence, 0, 1);
    const nextN = oldN + gradient * gradient;
    const sigma = (Math.sqrt(nextN) - Math.sqrt(oldN)) / META_LR;
    meta.z[t] = (meta.z[t] || 0) + gradient - sigma * oldW;
    meta.n[t] = nextN;
    meta.weights[t] = ftrlWeight(meta.z[t], nextN);
    meta.touched[t] = Date.now();
  }
  // 权重上限保护:超上限清最久未见的一半(旧 token 模式已稳定,淘汰不伤新学习)
  if (meta.weightSamples % 100 === 0) {
    const keys = Object.keys(meta.weights);
    if (keys.length > META_MAX_WEIGHTS) {
      keys.sort((a, b) => (meta.touched[a] || 0) - (meta.touched[b] || 0));
      for (const k of keys.slice(0, Math.floor(META_MAX_WEIGHTS / 2))) {
        delete meta.weights[k];
        delete meta.touched[k];
        delete meta.z[k];
        delete meta.n[k];
      }
    }
  }
  return true;
}
