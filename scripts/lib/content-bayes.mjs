/**
 * content-bayes.mjs — 内容级朴素贝叶斯分类器(零人工词表,自举训练)
 *
 * 出处:知乎反垃圾实践(2017,zhuanlan.zhihu.com/p/25835417)结论
 *   "AC + 贝叶斯 > max { AC, 贝叶斯 }" —— 单独贝叶斯在开放领域效果差
 *   (内容发散、长尾词频低),必须与其他证据组合。本模块定位为内容证据链的
 *   **最终兜底**:结构证据(assessContentEvidence)与语义证据
 *   (assessSemanticEvidence)都模棱两可时,用历史标注自举的 token 概率预测。
 *
 * 训练信号(重要,防自反馈):
 *   只用独立证据源——结构证据(local-content-v1)与语义证据(semantic-v1)的
 *   高精度标签;贝叶斯自身预测产出的标签**不训练贝叶斯**(否则自己教自己,
 *   偏差累积)。这沿袭重构原则"规则自身生成的标签不得反训规则特征"。
 *
 * 推理:Paul Graham "A Plan for Spam" 风格 —— 取概率最偏离 0.5 的 K 个
 *   token(有区分度的才参与),独立概率合成,避免大量中性 token 稀释信号;
 *   Laplace 平滑(+1/+2)处理长尾稀疏 token。
 *
 * 成熟门槛:有效样本数 + 正/负样本都达标才启用(防默认环境只有单类样本
 *   时单类投毒;同 META_MIN_CLASS_SAMPLES 哲学)。未成熟时 predict 返回 null,
 *   静默降级 —— "可用即增强,不可用即降级"。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { atomicWriteJsonSync } from "./state-file.mjs";
import {
  CACHE_DIR, BAYES_MIN_SAMPLES, BAYES_MIN_CLASS_SAMPLES, BAYES_TOP_K, BAYES_PREDICT_THR,
} from "./config.mjs";
import { cnBigrams, enWords } from "./rep-features.mjs";

const BAYES_FILE = `${CACHE_DIR}/websearch-content-bayes.json`;
const SCHEMA_VERSION = 1;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 正文 → token 集(中文 bigram + 英文词/数字)。截前 maxChars 字符,
 * bigram 覆盖正文主题词,英文词覆盖技术/品牌词;去空白压缩长度。 */
export function bodyTokens(text, maxChars = 1600) {
  const t = String(text || "").replace(/\s+/g, "").slice(0, maxChars);
  return new Set([...cnBigrams(t), ...enWords(t)]);
}

/**
 * 内容贝叶斯实例。跨进程持久化(token 计数 + 样本量)。
 * @param {Object} [opts] @param {string} [opts.file=BAYES_FILE]
 */
export function createContentBayes({ file = BAYES_FILE } = {}) {
  let counts = {}; // token -> {g: 正常计数, b: 低质计数}
  let samples = 0;      // 有效样本数(置信度加权)
  let goodSamples = 0;
  let badSamples = 0;
  let eventIds = new Set(); // 去重(同 URL+正文+标签只训练一次)

  function load() {
    try {
      if (!file || !existsSync(file)) return;
      const j = JSON.parse(readFileSync(file, "utf8"));
      if (j.version !== SCHEMA_VERSION) return;
      counts = j.counts || {};
      samples = j.samples || 0;
      goodSamples = j.goodSamples || 0;
      badSamples = j.badSamples || 0;
      eventIds = new Set(j.eventIds || []);
    } catch {
      // 损坏则从零开始(同 domain-rep 哲学:宁可冷启动,不用污染数据)
      counts = {}; samples = 0; goodSamples = 0; badSamples = 0; eventIds = new Set();
    }
  }

  function save() {
    try {
      if (!file) return;
      atomicWriteJsonSync(file, {
        version: SCHEMA_VERSION, updatedAt: Date.now(),
        counts, samples, goodSamples, badSamples, eventIds: [...eventIds].slice(-5000),
      });
    } catch { /* 保存失败不影响主流程 */ }
  }

  /** 成熟门槛:有效样本 + 正负类各自达标。 */
  function ready() {
    return samples >= BAYES_MIN_SAMPLES
      && goodSamples >= BAYES_MIN_CLASS_SAMPLES
      && badSamples >= BAYES_MIN_CLASS_SAMPLES;
  }

  /** P(token 低质),Laplace 平滑(+1/+2):未见 token 中性 0.5。 */
  function tokenProb(token) {
    const c = counts[token];
    if (!c) return 0.5;
    return (c.b + 1) / (c.g + c.b + 2);
  }

  /**
   * 训练一条样本。label: 0~1 低质概率(**越低越垃圾**:0.2/0.25/0.35 = 低质,
   * 0.72/0.82 = 优质;中性 0.4~0.6 不训练)。eventKey 用于去重(同内容不重复计数)。
   * @returns {boolean} 是否产生有效训练
   */
  function learn(tokens, label, { confidence = 1, eventKey = "" } = {}) {
    if (!tokens?.size || !Number.isFinite(label)) return false;
    const w = clamp(Number(confidence) || 0, 0, 1);
    if (w <= 0) return false;
    const bad = label < 0.4;  // 低质(低分)
    const good = label > 0.6; // 优质(高分)
    if (!bad && !good) return false; // 中性不训练
    const id = createHash("sha1")
      .update(`${eventKey}\u0000${[...tokens].sort().join("\u0001")}\u0000${label.toFixed(2)}`)
      .digest("hex").slice(0, 16);
    if (eventIds.has(id)) return false;
    eventIds.add(id);
    samples += w;
    if (bad) badSamples += w; else goodSamples += w;
    for (const t of tokens) {
      counts[t] = counts[t] || { g: 0, b: 0 };
      if (bad) counts[t].b += w; else counts[t].g += w;
    }
    return true;
  }

  /**
   * 预测正文低质概率。未成熟/无区分度 token → null。
   * @returns {{prob:number, top:string[], coverage:number}|null}
   *   prob 越接近 1 越可能是低质/模板内容;top 为最极端 token 抽样(诊断用)。
   */
  function predict(tokens) {
    if (!ready() || !tokens?.size) return null;
    const scored = [];
    for (const t of tokens) {
      const p = tokenProb(t);
      const d = Math.abs(p - 0.5);
      if (d > 0.05) scored.push({ t, p, d }); // 只取有区分度的 token
    }
    if (scored.length < 4) return null;
    scored.sort((a, b) => b.d - a.d);
    const top = scored.slice(0, BAYES_TOP_K);
    let prod = 1, inv = 1;
    for (const { p } of top) { prod *= p; inv *= 1 - p; }
    const prob = prod / (prod + inv);
    return {
      prob,
      top: top.slice(0, 8).map(({ t, p }) => `${t}:${p.toFixed(2)}`),
      coverage: scored.length,
    };
  }

  /** 预测结果 → 内容证据(仅低质方向;优质方向交给结构证据,不扩张)。 */
  function predictEvidence(tokens) {
    const p = predict(tokens);
    if (!p) return null;
    if (p.prob < BAYES_PREDICT_THR) return null;
    const confidence = Math.min(0.5, 0.3 + (p.prob - BAYES_PREDICT_THR) * 1.0);
    return { label: 0.35, confidence, source: "bayes-v1", reasons: ["bayesian-low-quality"], prob: p.prob };
  }

  function stats() {
    return { samples, goodSamples, badSamples, tokens: Object.keys(counts).length, ready: ready() };
  }

  load();
  return { learn, predict, predictEvidence, tokenProb, ready, stats, save, _raw: () => ({ counts, samples, goodSamples, badSamples }) };
}

/** 全局单例(跨 CLI 进程持久化;fetch 学习链路用)。 */
export const contentBayes = createContentBayes();
