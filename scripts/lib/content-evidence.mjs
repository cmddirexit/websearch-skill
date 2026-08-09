/** High-precision, non-LLM content evidence derived from fetched body text. */
import { cnBigrams, enWords } from "./rep-features.mjs";

const PROMO_RE = /(立即(?:咨询|联系|购买|注册|下载|领取)|免费(?:咨询|试用|领取)|限时(?:优惠|折扣)|点击(?:咨询|购买|注册|下载)|添加(?:微信|客服)|扫码(?:咨询|购买)|优惠名额|咨询热线)/gi;

function normalizedLines(text) {
  return String(text || "")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").replace(/^\s*[-#>*\d.、]+\s*/, "").trim())
    .filter((line) => line.length >= 20);
}

function repetitionRatio(text) {
  const lines = normalizedLines(text);
  if (lines.length < 4) return 0;
  const counts = new Map();
  for (const line of lines) counts.set(line, (counts.get(line) || 0) + 1);
  const repeated = [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  return repeated / lines.length;
}

function titleCoverage(title, body) {
  const terms = new Set([...cnBigrams(title), ...enWords(title)]);
  if (!terms.size) return null;
  const lower = body.toLowerCase();
  let hits = 0;
  for (const term of terms) if (lower.includes(term)) hits++;
  return hits / terms.size;
}

/**
 * 句长统计(模板化写作的零词表信号)。中文/英文混合按句末标点分句,
 * 过滤噪音短句(标点碎片/编号行);模板或机器生成的内容句长高度均匀,
 * 人类文章长短句交错。返回 {n, mean, cv} 或 null(样本不足)。
 * cv = stddev/mean(变异系数,消除篇幅量纲,可直接跨文章比较)。
 */
export function sentenceStats(text) {
  const sentences = String(text || "")
    .replace(/\s+/g, " ")
    .split(/[。！？!?；;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8); // 去碎片:编号/短语/换行残片
  if (sentences.length < 8) return null; // 样本不足不判定
  const lens = sentences.map((s) => s.length);
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
  if (mean <= 0) return null;
  const variance = lens.reduce((acc, l) => acc + (l - mean) * (l - mean), 0) / lens.length;
  const stddev = Math.sqrt(variance);
  return { n: lens.length, mean, cv: stddev / mean };
}

/**
 * Return independent content-quality evidence or null when structure alone is ambiguous.
 * Labels are quality probabilities: 1 = substantive, 0 = low-quality/template content.
 */
export function assessContentEvidence({ title = "", body = "", markdown = "" } = {}) {
  const text = String(markdown || body || "").replace(/\s+/g, " ").trim();
  if (text.length < 200) return null;

  const promoHits = [...text.matchAll(PROMO_RE)].length;
  const repeated = repetitionRatio(markdown || body);
  const coverage = titleCoverage(title, text);

  if (repeated >= 0.45) {
    return { label: 0.2, confidence: 0.8, source: "local-content-v1", reasons: ["repeated-body"] };
  }
  if (promoHits >= 3 && (text.length < 1600 || repeated >= 0.15)) {
    return { label: 0.15, confidence: 0.8, source: "local-content-v1", reasons: ["promotional-body"] };
  }
  if (coverage !== null && coverage < 0.08 && text.length >= 700) {
    return { label: 0.25, confidence: 0.55, source: "local-content-v1", reasons: ["title-body-mismatch"] };
  }
  if (text.length >= 1200 && (coverage === null || coverage >= 0.25) && repeated < 0.2 && promoHits <= 1) {
    return { label: 0.82, confidence: 0.65, source: "local-content-v1", reasons: ["substantive-aligned-body"] };
  }
  if (text.length >= 600 && coverage !== null && coverage >= 0.35 && repeated < 0.15 && promoHits === 0) {
    return { label: 0.72, confidence: 0.4, source: "local-content-v1", reasons: ["aligned-body"] };
  }
  // 句长均匀性(模板化写作弱负信号):真实条列式文章句长也较均匀(cv≈0.2~0.3),
  // 单靠 cv 无法区分 AI 模板与清单体好文 —— 故两级触发:
  //   ① cv 极低(<0.1,机械等长句,只能机器/模板产生) → 独立弱负证据;
  //   ② cv <0.25 但叠加其他负特征(命中营销词或标题覆盖低) → 组合弱负证据。
  // 只兜底“模棱两可”的长文(未命中正/负分支),不推翻已判定的实质文章。
  if (text.length >= 600) {
    const stats = sentenceStats(text);
    if (stats && stats.n >= 10) {
      if (stats.cv < 0.1) {
        return { label: 0.35, confidence: 0.4, source: "local-content-v1", reasons: ["uniform-sentence-length"] };
      }
      if (stats.cv < 0.25 && (promoHits >= 1 || (coverage !== null && coverage < 0.12))) {
        return { label: 0.35, confidence: 0.35, source: "local-content-v1", reasons: ["uniform-sentence-length+weak-negative"] };
      }
    }
  }
  return null;
}
