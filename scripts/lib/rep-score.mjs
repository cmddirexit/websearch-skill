/**
 * rep-score.mjs — 域名信誉评分 + 元学习权重更新(纯函数)
 *
 * 从 domain-rep.mjs 拆出(2026-08 重构,domain-rep.mjs 变为实例 + 门面 re-export):
 *   - 样本贡献分(contributionFromQuality)/ 域名级增量更新(updateScore/updateFetchScore)
 *   - 有效分融合 / 时间衰减 / 乘性因子 / 展示 badge
 *   - 元学习:模式预测(predictTokens)+ 在线权重更新(updateMetaTokens,词袋逻辑回归)
 *
 * 本文件只依赖 config.mjs(阈值),不依赖文件 IO/实例状态 —— 可单独单测。
 */

import {
  REP_MIN_SAMPLES, REP_STRENGTH, REP_DECAY_START_DAYS, REP_DECAY_FULL_DAYS,
  META_LR, META_MAX_WEIGHTS, META_STRONG_LR, META_L2_DECAY,
} from "./config.mjs";
import { GENERIC_DOMAIN_LABELS } from "./rep-features.mjs";

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
  entry.fetchSamples = (entry.fetchSamples || 0) + 1;
  entry.fetchScore = 0.5 * contribution + 0.5 * (entry.fetchScore ?? 0.5);
  entry.fetchScore = clamp(entry.fetchScore, 0, 1);
  return entry.fetchScore;
}

/** 有效分:有 fetch 实测时实测优先(0.7/0.3 融合),无实测回退搜索推断分。
 * 软文站搜索样本多但 fetch 一次空壳 → 实测把分钉低,搜索样本拉不回来。 */
export function effectiveScore(e) {
  const s = e.searchScore ?? 0.5;
  if ((e.fetchSamples || 0) > 0) return 0.7 * (e.fetchScore ?? 0.5) + 0.3 * s;
  return s;
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
export function predictTokens(tokens, meta) {
  let z = 0;
  for (const t of tokens || []) z += meta?.weights?.[t] ?? 0;
  return 1 / (1 + Math.exp(-z));
}

/**
 * 内循环:token 权重在线更新(词袋逻辑回归/感知机风格)。
 * 每条样本用实际贡献分作 label,残差 err = label − 预测,梯度下降:
 *   w_token += lr × err(仅对激活 token)
 * 学习率随样本数递减(早期快速捕捉规律,后期稳定不漂移);
 * **strong=true 时用固定大学习率 META_STRONG_LR**(fetch 实测等强信号必须
 * 压过大量中性搜索样本,不被递减 lr 稀释)。
 * 高频泛词被大量不同质量样本平均 → 权重趋近 0,自动无害;
 * 真正与低质强相关的 token 权重被反复推离 0。
 * @returns {boolean} 是否有 token 被更新
 */
export function updateMetaTokens(meta, tokens, label, { strong = false } = {}) {
  if (!tokens || !tokens.size) return false;
  const pred = predictTokens(tokens, meta);
  const err = clamp(label - pred, -1, 1);
  meta.weightSamples = (meta.weightSamples || 0) + 1;
  // bias 不参与预测(无特征=0.5 先验中性),权重即 token 相对中性的偏差
  meta.bias = 0;
  meta.touched = meta.touched || {};
  meta.lastStep = meta.lastStep || {}; // token 上次被激活时的 weightSamples(惰性 L2 用)
  meta.freq = meta.freq || {}; // token 被激活次数(per-token 学习率用)
  for (const t of tokens) {
    if (t.startsWith("d:")) {
      const lab = t.slice(2);
      if (lab === "www" || lab.length === 2 || GENERIC_DOMAIN_LABELS.has(lab)) continue; // 泛域名标签不学
    }
    // per-token 学习率:由该 token 自身激活次数决定,与全局样本数无关 ——
    // 全局递减学习率后期(lr≈0.002)新出现的软文套路 token 学不动(权重永远起不来),
    // 这是在线学习“新特征冷启动”问题的简化解(AdaGrad/FTRL per-coordinate 同源):
    // 新 token(freq=0)回到初始学习率 0.05,快速建立模式;稳定 token(freq 大)平滑回落。
    // strong(fetch 实测)固定大学习率,不在此列。
    const freq = meta.freq[t] || 0;
    const tokLr = strong ? META_STRONG_LR : META_LR / (1 + freq * 0.01);
    meta.freq[t] = freq + 1;
    // 惰性 L2 收缩(间隔补算,等价 weight decay,见 FTRL 惰性正则精神):
    // 权重先按距上次激活的步数差向 0 回归再更新 —— 罕见 token 被 1-2 个偶然样本推走后,
    // 隔大量样本再激活时证据已被冲淡(权重大幅回归);连续激活的稳定 token gap≈1,
    // 收缩(0.1%)与推动(lr×err)平衡,保持显著。防稀疏特征过拟合。
    const gap = meta.weightSamples - (meta.lastStep[t] ?? meta.weightSamples);
    meta.weights[t] = (meta.weights[t] ?? 0) * Math.pow(1 - META_L2_DECAY, gap) + tokLr * err;
    meta.touched[t] = Date.now();
    meta.lastStep[t] = meta.weightSamples;
  }
  // 权重上限保护:超上限清最久未见的一半(旧 token 模式已稳定,淘汰不伤新学习)
  if (meta.weightSamples % 100 === 0) {
    const keys = Object.keys(meta.weights);
    if (keys.length > META_MAX_WEIGHTS) {
      keys.sort((a, b) => (meta.touched[a] || 0) - (meta.touched[b] || 0));
      for (const k of keys.slice(0, Math.floor(META_MAX_WEIGHTS / 2))) {
        delete meta.weights[k];
        delete meta.touched[k];
        delete meta.lastStep[k];
        delete meta.freq[k];
      }
    }
  }
  return true;
}
