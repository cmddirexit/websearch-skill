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
  return null;
}
