// evidence-chain.mjs 证据链裁决与贝叶斯训练编排单元测试
// 全部注入假 bayes / 假 embedFn,零网络零落盘
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveContentEvidence, trainBayes } from "../../evidence-chain.mjs";
import { createContentBayes, bodyTokens } from "../../content-bayes.mjs";

/** 模板风低质正文(重复行 → 结构证据命中) */
const repeatedBody = "立即咨询客服,限时优惠,点击咨询免费领取。\n".repeat(12);
/** 标题党:理财标题 + 养花正文(结构证据 null,语义命中) */
const titleParty = {
  title: "2026年十大最佳理财平台推荐,不看后悔!",
  markdown: "家庭绿植养护基础:本文介绍室内绿植的浇水频率、光照需求、土壤选择和常见病虫害防治。".repeat(10),
};
/** 中性正文(结构/语义/贝叶斯都 null → 返回 null) */
const neutralBody = {
  title: "普通页面",
  markdown: "普通页面内容介绍,中等长度文本,没有明显特征。".repeat(15),
};

// ---- 裁决顺序 ----

test("chain: 结构证据优先命中(重复行模板文)", async () => {
  const ev = await resolveContentEvidence({ title: "某平台推荐", markdown: repeatedBody }, { bayes: null, embedFn: async () => null });
  assert.equal(ev?.source, "local-content-v1");
  assert.equal(ev.reasons[0], "repeated-body");
});

test("chain: 结构 null 时语义证据命中(标题党,注入假嵌入低相似)", async () => {
  const fakeEmbed = async () => [[1, 0, 0], [0, 1, 0]]; // 正交 → 低相似度
  const ev = await resolveContentEvidence(titleParty, { bayes: null, embedFn: fakeEmbed });
  assert.equal(ev?.source, "semantic-v1");
  assert.equal(ev.reasons[0], "title-body-semantic-mismatch");
});

test("chain: 结构正证据不能短路语义反证", async () => {
  const keywordStuffed = {
    title: "Python 异步编程教程",
    markdown: ("Python 异步 编程 教程 " + "本文实际介绍旅游景点、天气、交通和住宿安排,与编程主题无关。").repeat(80),
  };
  const ev = await resolveContentEvidence(keywordStuffed, {
    bayes: null,
    embedFn: async () => [[1, 0], [0, 1]],
  });
  assert.equal(ev?.source, "semantic-v1", "标题关键词填充不得直接获得结构正标签");
});

test("chain: 高精度结构负证据立即返回,不调用嵌入", async () => {
  let calls = 0;
  const ev = await resolveContentEvidence(
    { title: "某平台推荐", markdown: repeatedBody },
    { bayes: null, embedFn: async () => { calls++; return [[1, 0], [0, 1]]; } },
  );
  assert.equal(ev?.reasons?.[0], "repeated-body");
  assert.equal(calls, 0);
});

test("chain: 结构/语义都 null 时贝叶斯兜底(成熟模型)", async () => {
  const bayes = createContentBayes({ file: null });
  // 训练到成熟:低质(理财/推荐模板风)+ 优质(养花/绿植教程)
  for (let i = 0; i < 12; i++) {
    bayes.learn(bodyTokens(`理财平台推荐榜测评分析报告第${i}期:汇总行业资讯与平台动态,提供参考报告解读。`.repeat(3)), 0.2, { eventKey: `bad-${i}` });
  }
  for (let i = 0; i < 30; i++) {
    bayes.learn(bodyTokens(`绿植养护教程第${i}期:本文通过具体步骤解释浇水频率、光照需求与土壤选择,并给出可复现操作。`), 0.82, { eventKey: `good-${i}` });
  }
  assert.ok(bayes.ready(), "应成熟");
  const ev = await resolveContentEvidence(
    { title: "匿名文章标题", markdown: "理财平台推荐榜测评分析报告专题:汇总行业资讯与平台动态观察,提供参考解读。".repeat(3) },
    { bayes, embedFn: async () => null },
  );
  assert.equal(ev?.source, "bayes-v1", "贝叶斯应兜底命中");
  assert.equal(ev.label, 0.35);
});

test("chain: 全部模棱两可 → null(中性,不训练)", async () => {
  const ev = await resolveContentEvidence(neutralBody, { bayes: null, embedFn: async () => null });
  assert.equal(ev, null);
});

test("chain: 语义嵌入不可用(embedFn 返回 null)静默跳过", async () => {
  const ev = await resolveContentEvidence(titleParty, { bayes: null, embedFn: async () => null });
  assert.equal(ev, null, "嵌入不可用不应报错,降级为中性");
});

// ---- 贝叶斯训练编排 ----

test("chain: trainBayes 只训练独立证据源,不训练 bayes-v1(防自反馈)", () => {
  const bayes = createContentBayes({ file: null });
  const extra = { markdown: "任意正文内容用于训练编排测试,长度足够长。".repeat(10) };
  const bodyHash = "abc123";
  // 独立证据 → 训练
  const trained = trainBayes(bayes, "https://a.example/x", extra, { source: "semantic-v1", label: 0.25, confidence: 0.5 }, bodyHash);
  assert.equal(trained, true);
  assert.ok(bayes.stats().samples > 0, "独立证据应训练贝叶斯");
  // bayes-v1 自身预测 → 不训练
  const self = trainBayes(bayes, "https://b.example/y", extra, { source: "bayes-v1", label: 0.35, confidence: 0.4 }, "def456");
  assert.equal(self, false, "bayes-v1 不训练自己");
  const before = bayes.stats().samples;
  assert.equal(bayes.stats().samples, before);
});

test("chain: trainBayes 无 bayes / 无 evidence → false", () => {
  assert.equal(trainBayes(null, "https://a.example", { markdown: "x" }, { source: "x", label: 0.2 }, "h"), false);
  assert.equal(trainBayes(createContentBayes({ file: null }), "https://a.example", { markdown: "x" }, null, "h"), false);
});

// ---- 集成:learnFetchContent 在贝叶斯成熟后产出 bayes-v1 证据 ----

test("chain: learnFetchContent 集成——贝叶斯成熟后兜底产出证据且不训练自己", async () => {
  process.env.WEBSEARCH_LLM_OFF = "1";
  try {
    const { createDomainReputation } = await import("../../domain-rep.mjs");
    const bayes = createContentBayes({ file: null });
    for (let i = 0; i < 12; i++) {
      bayes.learn(bodyTokens(`理财平台推荐榜测评分析报告第${i}期:汇总行业资讯与平台动态观察,提供参考解读。`.repeat(3)), 0.2, { eventKey: `bad-${i}` });
    }
    for (let i = 0; i < 30; i++) {
      bayes.learn(bodyTokens(`绿植养护教程第${i}期:本文通过具体步骤解释浇水频率、光照需求与土壤选择,并给出可复现操作。`), 0.82, { eventKey: `good-${i}` });
    }
    const rep = createDomainReputation({ file: null, bayes, embedFn: async () => null });
    const before = bayes.stats().samples;
    const evidence = await rep.learnFetchContent("https://integ.example/top10", {
      title: "匿名文章",
      markdown: "理财平台推荐榜测评分析报告专题:汇总行业资讯与平台动态观察,提供参考解读。".repeat(3),
    });
    assert.equal(evidence?.source, "bayes-v1", "集成链路贝叶斯应兜底");
    assert.equal(bayes.stats().samples, before, "bayes-v1 证据不训练自己");
    assert.equal(rep._raw()["integ.example"].contentSamples, 1, "域名内容分仍记录(贝叶斯证据也写域名信誉)");
  } finally {
    delete process.env.WEBSEARCH_LLM_OFF;
  }
});
