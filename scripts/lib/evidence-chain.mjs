/**
 * evidence-chain.mjs — 内容证据链裁决(零词表,可注入测试)
 *
 * 把 learnFetchContent 里的证据链裁决抽离出来:结构证据(纯规则) →
 * 语义证据(标题-正文嵌入一致性) → 贝叶斯(历史标注自举)。三者返回统一契约
 * {label, confidence, source, reasons},任一命中即止;全部模棱两可 → null(中性)。
 *
 * 设计:
 *   - 纯编排,不持有任何状态;bayes/embedFn 依赖注入,便于单元测试隔离
 *     (测试传假 bayes / 假 embedFn,零网络零落盘)。
 *   - 贝叶斯训练编排(trainBayes)与裁决分离:只用独立证据源训练,
 *     "bayes-v1" 自身的预测结果不训练自己(防自反馈循环)。
 *   - 新增证据源只需在 resolveContentEvidence 里加一级,契约不变。
 */

import { assessContentEvidence } from "./content-evidence.mjs";
import { assessSemanticEvidence } from "./semantic-evidence.mjs";
import { bodyTokens } from "./content-bayes.mjs";

/**
 * 裁决一条正文的证据:结构 → 语义 → 贝叶斯,命中即返回。
 * @param {{title?:string, body?:string, markdown?:string}} extra
 * @param {{bayes?:Object, embedFn?:Function}} [opts]
 *   bayes: 内容贝叶斯实例(可选,未成熟时 predictEvidence 返回 null);
 *   embedFn: 语义嵌入函数注入(测试用;缺省走默认 API 后端)。
 * @returns {Promise<{label:number, confidence:number, source:string, reasons:string[]}|null>}
 */
export async function resolveContentEvidence(extra = {}, { bayes = null, embedFn } = {}) {
  // 1. 结构证据(同步,纯规则:重复行/营销词/标题覆盖/句长均匀性)
  const structural = assessContentEvidence(extra);
  if (structural) return structural;

  // 2. 语义证据(异步:标题-正文嵌入余弦;嵌入不可用返回 null,静默降级)
  const semantic = await assessSemanticEvidence(extra, embedFn ? { embedFn } : {});
  if (semantic) return semantic;

  // 3. 贝叶斯兜底(自举分类器;未成熟返回 null)
  if (bayes) {
    const predicted = bayes.predictEvidence(bodyTokens(extra.body || extra.markdown));
    if (predicted) return predicted;
  }
  return null;
}

/**
 * 贝叶斯训练编排:只用独立证据源(local-content-v1 / semantic-v1 / llm-body-v1)训练,
 * 贝叶斯自身预测(bayes-v1)不训练自己。eventKey 用 URL+正文哈希去重。
 * @returns {boolean} 是否产生有效训练
 */
export function trainBayes(bayes, url, extra, evidence, bodyHash) {
  if (!bayes || !evidence || evidence.source === "bayes-v1") return false;
  const learned = bayes.learn(bodyTokens(extra.body || extra.markdown), evidence.label, {
    confidence: evidence.confidence,
    eventKey: `${url}\u0000${bodyHash}`,
  });
  if (learned) bayes.save();
  return learned;
}
