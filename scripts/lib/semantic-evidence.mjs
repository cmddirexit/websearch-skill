/**
 * semantic-evidence.mjs — 标题-正文语义一致性证据(零词表,异步)
 *
 * 动机:字符级 titleCoverage 只查“标题词是否出现在正文”——标题党/拼凑文
 * 只要塞几个标题词就能绕过。语义嵌入把标题和正文投影到向量空间,算余弦相似度:
 * 标题党(夸大标题 + 不相关拼凑正文)语义错位 → 低相似度,无需任何人工词表。
 *
 * 设计(与内容证据同哲学:“可用即增强,不可用即降级”):
 *   - 严格服从 embed.mjs 的 off/api/local/wasm/auto 后端配置;auto 模式下 API
 *     失败才回退本地模型,全部不可用时返回 null(静默降级)。
 *   - 只产负证据(标题党),不产正证据:高相似度交给现有结构证据
 *     (substantive-aligned-body)判断,避免语义判断过度扩张。
 *   - 依赖注入 embedFn,便于单元测试(真实网络调用不可靠,测试注入假嵌入)。
 *
 * 阈值:Qwen3-Embedding-8B 上,标题与同主题正文余弦 ≈ 0.6~0.85,
 * 标题党/泛泛标题 ≈ 0.2~0.45。取 <0.4 为错位(保守,宁漏勿误)。
 */

import { embedConfiguredTexts } from "./embed.mjs";
import { SEMANTIC_EVIDENCE_TIMEOUT_MS } from "./config.mjs";

/** 默认嵌入函数:服从全局后端配置,并限制为一次短请求。 */
async function defaultEmbed(texts) {
  return embedConfiguredTexts(texts, {
    quiet: true,
    apiTimeoutMs: SEMANTIC_EVIDENCE_TIMEOUT_MS,
    apiMaxAttempts: 1,
  });
}

/** 余弦相似度(向量已 L2 归一化时即点积;未归一化也兼容)。 */
export function cosine(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (!denom) return null;
  return dot / denom;
}

/**
 * 标题-正文语义一致性证据。正文取前 SIM_BODY_CHARS 字符(嵌入只需整体语义,
 * 截断不影响主题一致性判断,省 token)。embed 不可用/相似度中性 → null。
 * @param {{title?:string, body?:string, markdown?:string}} extra
 * @param {{embedFn?:Function, simBodyChars?:number, mismatchThr?:number}} [opts] 测试注入
 * @returns {Promise<{label:number, confidence:number, source:string, reasons:string[], sim:number}|null>}
 */
export async function assessSemanticEvidence(
  { title = "", body = "", markdown = "" } = {},
  { embedFn = defaultEmbed, simBodyChars = 600, mismatchThr = 0.4 } = {},
) {
  const titleText = String(title || "").trim();
  const text = String(markdown || body || "").replace(/\s+/g, " ").trim();
  if (!titleText || text.length < 300) return null; // 正文太短,语义证据不可靠

  let vectors;
  try {
    vectors = await embedFn([`标题:${titleText.slice(0, 120)}`, text.slice(0, simBodyChars)]);
  } catch {
    return null;
  }
  if (!vectors || vectors.length < 2) return null;

  const sim = cosine(vectors[0], vectors[1]);
  if (sim === null) return null;
  if (sim >= mismatchThr) return null; // 语义对齐 → 交给结构证据,不产证据

  // 低相似度 → 标题党弱负证据。置信度随错位程度加深:0.40→0.30 附近起步,
  // 0.20 以下才给满置信度,防极端嵌入噪声误判。
  const confidence = Math.min(0.6, 0.35 + (mismatchThr - sim) * 1.2);
  return {
    label: 0.25,
    confidence: Math.max(0.3, confidence),
    source: "semantic-v1",
    reasons: ["title-body-semantic-mismatch"],
    sim: Number(sim.toFixed(3)),
  };
}
