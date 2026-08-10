// content-bayes.mjs 内容级朴素贝叶斯(零词表兜底分类器)单元测试
// 全内存实例(file:null),不碰真实缓存;纯函数 + 合成样本,无网络
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContentBayes, bodyTokens } from "../../content-bayes.mjs";
import { clamp } from "../../rep-score.mjs";

// ---- 工具 ----

function makeBayes() {
  return createContentBayes({ file: null });
}

/** 低质/模板风正文(无营销词,靠句式与重复结构)——模拟内容农场批量文 */
function badBody(i) {
  const filler = [
    "平台推荐榜测评分析报告", "信息中心最新资讯汇总", "行业动态观察解读",
    "网络热点话题深度盘点", "产品对比评测报告", "用户口碑反馈收集整理",
  ][i % 6];
  return `${filler}内容专题第${i + 1}期:本节汇总整理最新行业信息与平台动态观察,提供参考资讯汇总报告解读分析。`.repeat(3);
}

/** 优质正文(实质内容)——模拟真实教程/科普 */
function goodBody(i) {
  const topics = [
    "Python 异步编程事件循环与任务调度", "高血压患者低盐饮食的钠摄入控制",
    "Git 分支管理合并冲突解决", "MySQL 索引原理与查询优化",
    "家庭绿植浇水频率与光照需求", "数据可视化图表的坐标轴设计",
  ];
  const topic = topics[i % 6];
  return `${topic}教程:本文通过具体可运行的示例代码与逐步验证的实验步骤,详细解释核心概念、常见问题与性能对比,并给出可复现的操作流程和注意事项。`;
}

// ---- bodyTokens ----

test("bayes: bodyTokens 提取中文 bigram + 英文词", () => {
  const t = bodyTokens("Python 异步编程教程:事件循环与任务调度");
  assert.ok(t.has("python"), "英文词应按原始词界提取并转小写");
  assert.ok(t.has("异步"), "中文 bigram 应被提取");
  assert.ok(t.size > 10);
});

test("bayes: 英文空白词界不被压缩,中文正文不受标题 60 字符上限", () => {
  const english = bodyTokens("Python async programming event loop");
  assert.deepEqual(
    [...english].filter((token) => /[a-z]/.test(token)),
    ["python", "async", "programming", "event", "loop"],
  );
  assert.ok(!english.has("pythonasyncprogrammi"), "不得把多个英文词拼接后截断");

  const chinese = bodyTokens(`${"甲".repeat(80)}深度学习模型`);
  assert.ok(chinese.has("深度"), "正文 60 字符之后的中文主题词仍应进入模型");
});

test("bayes: 空正文返回空集", () => {
  assert.equal(bodyTokens("").size, 0);
  assert.equal(bodyTokens(null).size, 0);
});

// ---- learn 与去重 ----

test("bayes: 中性标签不训练,负/正标签按置信度加权", () => {
  const b = makeBayes();
  assert.equal(b.learn(new Set(["t:中性"]), 0.5), false, "中性不训练");
  assert.equal(b.learn(new Set(["t:低质"]), 0.2, { confidence: 0.8 }), true);
  assert.equal(b.learn(new Set(["t:优质"]), 0.82, { confidence: 1 }), true);
  const s = b.stats();
  assert.equal(s.badSamples, 0.8);
  assert.equal(s.goodSamples, 1);
  assert.equal(s.samples, 1.8);
  assert.equal(b.ready(), false, "样本不足未成熟");
});

test("bayes: 相同内容(eventKey)不重复训练", () => {
  const b = makeBayes();
  const t = new Set(["t:a", "t:b"]);
  assert.equal(b.learn(t, 0.2, { eventKey: "same-url" }), true);
  assert.equal(b.learn(t, 0.2, { eventKey: "same-url" }), false, "重复被去重");
  assert.equal(b.stats().samples, 1);
});

test("bayes: 训练后 token 概率偏向正确方向", () => {
  const b = makeBayes();
  b.learn(new Set(["t:垃圾", "t:推广"]), 0.2, { eventKey: "neg1" });
  b.learn(new Set(["t:垃圾", "t:模板"]), 0.2, { eventKey: "neg2" });
  b.learn(new Set(["t:教程", "t:代码"]), 0.82, { eventKey: "pos1" });
  assert.ok(b.tokenProb("t:垃圾") > 0.7, "低质 token 概率应偏高");
  assert.ok(b.tokenProb("t:教程") < 0.4, "优质 token 概率应偏低");
  assert.equal(b.tokenProb("t:未见词"), 0.5, "未见 token 中性");
});

// ---- predict / predictEvidence ----

test("bayes: 训练正负样本后可区分模板文与实质文", () => {
  const b = makeBayes();
  for (let i = 0; i < 12; i++) b.learn(bodyTokens(badBody(i)), 0.2, { eventKey: `bad-${i}` });
  for (let i = 0; i < 30; i++) b.learn(bodyTokens(goodBody(i)), 0.82, { eventKey: `good-${i}` });
  assert.ok(b.ready(), "正负样本达标后应成熟");
  const badPred = b.predict(bodyTokens(badBody(100)));
  const goodPred = b.predict(bodyTokens(goodBody(100)));
  assert.ok(badPred, "模板文应有预测");
  assert.ok(badPred.prob > 0.7, `模板文低质概率应高,实际 ${badPred?.prob}`);
  assert.ok(goodPred, "实质文应有预测");
  assert.ok(goodPred.prob < 0.4, `实质文低质概率应低,实际 ${goodPred?.prob}`);
});

test("bayes: predictEvidence 只产低质证据,阈值下返回 null", () => {
  const b = makeBayes();
  for (let i = 0; i < 12; i++) b.learn(bodyTokens(badBody(i)), 0.2, { eventKey: `bad-${i}` });
  for (let i = 0; i < 30; i++) b.learn(bodyTokens(goodBody(i)), 0.82, { eventKey: `good-${i}` });
  const badEv = b.predictEvidence(bodyTokens(badBody(200)));
  assert.ok(badEv, "模板文应产出证据");
  assert.equal(badEv.source, "bayes-v1");
  assert.equal(badEv.label, 0.35);
  assert.ok(badEv.confidence >= 0.3 && badEv.confidence <= 0.5);
  const goodEv = b.predictEvidence(bodyTokens(goodBody(200)));
  assert.equal(goodEv, null, "优质文不产出负证据");
});

test("bayes: 未成熟时 predict 返回 null(静默降级)", () => {
  const b = makeBayes();
  b.learn(bodyTokens(badBody(0)), 0.2, { eventKey: "only-bad" });
  assert.equal(b.predict(bodyTokens(badBody(1))), null, "单类/样本不足不预测");
  assert.equal(b.predictEvidence(bodyTokens(badBody(1))), null);
});

// ---- 持久化 ----

test("bayes: save/load 后预测一致(file:null 不落盘)", () => {
  const b = makeBayes();
  for (let i = 0; i < 12; i++) b.learn(bodyTokens(badBody(i)), 0.2, { eventKey: `bad-${i}` });
  for (let i = 0; i < 30; i++) b.learn(bodyTokens(goodBody(i)), 0.82, { eventKey: `good-${i}` });
  const before = b.predict(bodyTokens(badBody(5)));
  assert.ok(before && before.prob > 0.7);
});

test("bayes: 真实文件持久化 round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "wsbayes-"));
  const file = join(dir, "bayes.json");
  try {
    const b1 = createContentBayes({ file });
    for (let i = 0; i < 12; i++) b1.learn(bodyTokens(badBody(i)), 0.2, { eventKey: `bad-${i}` });
    for (let i = 0; i < 30; i++) b1.learn(bodyTokens(goodBody(i)), 0.82, { eventKey: `good-${i}` });
    b1.save();
    assert.ok(existsSync(file), "应落盘");
    const b2 = createContentBayes({ file });
    assert.ok(b2.ready());
    const p = b2.predict(bodyTokens(badBody(9)));
    assert.ok(p && p.prob > 0.7, "加载后预测一致");
    // 去重跨进程:同内容不重复计数
    const before = b2.stats().samples;
    b2.learn(bodyTokens(badBody(3)), 0.2, { eventKey: "bad-3" });
    assert.equal(b2.stats().samples, before, "跨进程同事件去重");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bayes: v1 旧 token 语义不迁移,保守冷启动", () => {
  const dir = mkdtempSync(join(tmpdir(), "wsbayes-v1-"));
  const file = join(dir, "bayes.json");
  try {
    writeFileSync(file, JSON.stringify({
      version: 1,
      counts: { pythonasyncprogrammi: { g: 0, b: 20 } },
      samples: 40,
      goodSamples: 20,
      badSamples: 20,
      eventIds: ["old"],
    }));
    const bayes = createContentBayes({ file });
    assert.deepEqual(bayes.stats(), {
      samples: 0, goodSamples: 0, badSamples: 0, tokens: 0, ready: false,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bayes: 超过 5000 条后仍保留旧事件去重语义", () => {
  const dir = mkdtempSync(join(tmpdir(), "wsbayes-dedupe-"));
  const file = join(dir, "bayes.json");
  try {
    const b1 = createContentBayes({ file });
    const tokens = new Set(["shared-token"]);
    for (let i = 0; i < 5001; i++) {
      assert.equal(b1.learn(tokens, 0.2, { eventKey: `event-${i}` }), true);
    }
    b1.save();
    const b2 = createContentBayes({ file });
    const before = b2.stats().samples;
    assert.equal(b2.learn(tokens, 0.2, { eventKey: "event-0" }), false, "最早事件仍须去重");
    assert.equal(b2.stats().samples, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bayes: clamp 工具", () => {
  assert.equal(clamp(2, 0, 1), 1);
  assert.equal(clamp(-1, 0, 1), 0);
  assert.equal(clamp(0.5, 0, 1), 0.5);
});
