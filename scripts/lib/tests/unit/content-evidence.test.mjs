// content-evidence.mjs 句长均匀性 + semantic-evidence.mjs 标题-正文语义一致性
// 两个零词表证据的单元测试(纯函数 + 注入假嵌入,不依赖网络)
import { test } from "node:test";
import assert from "node:assert/strict";
import { assessContentEvidence, sentenceStats } from "../../content-evidence.mjs";
import { assessSemanticEvidence, cosine } from "../../semantic-evidence.mjs";

// ---- 句长统计 ----

test("sentenceStats: 模板化均匀句 → 低 CV", () => {
  const uniform = Array.from({ length: 20 }, (_, i) => `这是第${i + 1}条模板化内容的固定长度句子片段`).join("。");
  const stats = sentenceStats(uniform);
  assert.ok(stats, "样本充足应返回统计");
  assert.ok(stats.n >= 10);
  assert.ok(stats.cv < 0.3, `模板句 CV 应低,实际 ${stats.cv}`);
});

test("sentenceStats: 人类长短句交错 → 高 CV", () => {
  const human = [
    "高血压患者饮食需注意低盐低脂高钾及控制总热量,这是控制血压的基础措施。",
    "限盐!", // 短句碎片(<8 过滤)
    "日常烹饪应使用定量盐勺,每日食盐摄入量控制在推荐范围内,同时需警惕酱油咸菜腐乳等隐形高盐调味品和加工食品。",
    "对于口味较重的患者,可尝试利用醋柠檬汁葱姜蒜等天然香料替代部分食盐来提味,逐步适应清淡饮食,有助于减轻血管壁压力,辅助维持血压稳定。",
    "多吃香蕉橙子土豆菠菜蘑菇。",
    "但在合并肾功能不全的情况下,高钾饮食需谨慎,应在专业评估后确定具体摄入方案,避免因排钾障碍引发高钾血症等严重后果。",
    "运动配合也很重要。",
    "建议每周进行至少150分钟中等强度有氧运动,可分次完成,运动前后注意热身和放松,避免在血压过高或天气极端时进行剧烈运动。",
    "坚持运动配合饮食管理可显著改善血管内皮功能。",
    "降低交感神经兴奋性,使收缩压和舒张压均有不同程度下降,长期规律监测有助于及时发现血压波动趋势。",
    "为医生调整用药剂量提供依据,也能帮助患者建立自我管理信心,提高治疗依从性。",
  ].join("");
  const stats = sentenceStats(human);
  assert.ok(stats, "样本充足应返回统计");
  assert.ok(stats.cv >= 0.3, `人类文章 CV 应较高,实际 ${stats.cv}`);
});

// ---- assessContentEvidence 句长均匀分支 ----

test("assessContentEvidence: 长文 + 句长均匀 → uniform-sentence-length 弱负证据", () => {
  const uniformBody = Array.from(
    { length: 25 },
    (_, i) => `这里是第${i + 1}条模板化生成的固定句式内容段落填充字数`,
  ).join("。");
  // 标题 bigram 不覆盖(避免命中 aligned),无营销词、无重复整行
  const ev = assessContentEvidence({ title: "完全无关的标题词汇", markdown: uniformBody });
  assert.equal(ev?.reasons?.[0], "uniform-sentence-length");
  assert.equal(ev.label, 0.35);
  assert.ok(ev.confidence >= 0.3 && ev.confidence <= 0.5);
});

test("assessContentEvidence: 实质长文(长短句交错)不被句长信号误伤", () => {
  const goodBody = `Python 异步编程教程\n${`本节通过具体代码解释事件循环、任务调度和异常处理,并给出可复现实验步骤与性能对比。`.repeat(25)}`;
  const ev = assessContentEvidence({ title: "Python 异步编程教程", markdown: goodBody });
  assert.ok(ev?.label >= 0.65, "实质/对齐好文不被句长信号拉低");
  assert.notEqual(ev?.reasons?.[0], "uniform-sentence-length", "好文不被句长均匀性误判");
});

test("assessContentEvidence: 短文不触发句长信号", () => {
  const short = "普通页面内容".repeat(30); // ~150 字符
  const ev = assessContentEvidence({ title: "普通页面", markdown: short });
  assert.equal(ev, null, "短文保持中性");
});

// ---- 语义一致性(注入假嵌入) ----

test("cosine: 归一化向量点积 / 维度不匹配返回 null", () => {
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
  assert.equal(cosine([1, 0], [1, 0, 0]), null);
  assert.equal(cosine([], []), null);
});

test("assessSemanticEvidence: 低相似度(标题党) → semantic-v1 弱负证据", async () => {
  // 假嵌入:标题向量与正文向量接近正交 → 相似度 ≈ 0
  const fakeEmbed = async () => [[1, 0, 0], [0, 1, 0]];
  const ev = await assessSemanticEvidence(
    { title: "2026年五大平台推荐榜,不看后悔!", markdown: "本文介绍家庭绿植养护基础,包括浇水施肥光照和土壤选择等内容。".repeat(30) },
    { embedFn: fakeEmbed },
  );
  assert.ok(ev, "低相似度应产出证据");
  assert.equal(ev.source, "semantic-v1");
  assert.equal(ev.label, 0.25);
  assert.ok(ev.confidence >= 0.3 && ev.confidence <= 0.6);
  assert.ok(ev.sim < 0.1);
});

test("assessSemanticEvidence: 高相似度(语义对齐) → null,交给结构证据", async () => {
  const fakeEmbed = async () => [[1, 0, 0], [1, 0, 0]];
  const ev = await assessSemanticEvidence(
    { title: "Python 异步编程教程", markdown: "本节通过具体代码解释事件循环和任务调度。".repeat(30) },
    { embedFn: fakeEmbed },
  );
  assert.equal(ev, null);
});

test("assessSemanticEvidence: 嵌入不可用 → null 静默降级", async () => {
  const fakeEmbed = async () => null;
  const ev = await assessSemanticEvidence(
    { title: "任意标题", markdown: "正文内容足够长用于测试嵌入不可用时的降级路径。".repeat(20) },
    { embedFn: fakeEmbed },
  );
  assert.equal(ev, null);
});

test("assessSemanticEvidence: 嵌入函数抛错 → null 静默降级", async () => {
  const ev = await assessSemanticEvidence(
    { title: "任意标题", markdown: "正文内容足够长用于测试嵌入异常时的降级路径。".repeat(20) },
    { embedFn: async () => { throw new Error("backend failed"); } },
  );
  assert.equal(ev, null);
});

test("assessSemanticEvidence: 正文太短 → null", async () => {
  let called = false;
  const fakeEmbed = async () => {
    called = true;
    return [[1, 0], [0, 1]];
  };
  const ev = await assessSemanticEvidence(
    { title: "短文章标题", markdown: "很短的内容" },
    { embedFn: fakeEmbed },
  );
  assert.equal(ev, null);
  assert.equal(called, false, "正文不足 300 字符不应发起嵌入请求");
});
