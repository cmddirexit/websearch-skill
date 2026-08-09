// date-ml 发布时间提取:规则候选生成 + 在线学习裁决(传统 ML,非 LLM)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractDateCandidates,
  extractPageFeatures,
  pickDate,
  predictLinear,
  recordFetchOutcome,
  updateLinear,
  resetDateModel,
  inspectDateModel,
} from "../../date-ml.mjs";
import { parseResultDateAgo } from "../../filter.mjs";

// ---------- 候选生成 ----------
test("候选生成: meta article:published_time / URL / 正文上下文 / JSON-LD 多来源", () => {
  const html = `<html><head>
    <meta property="article:published_time" content="2026-08-07T10:30:00+08:00">
    <script type="application/ld+json">{"datePublished":"2026-08-06"}</script>
  </head><body><p>发布时间:2026年8月5日 报道</p></body></html>`;
  const cands = extractDateCandidates(html, "https://news.cn/2026/0804/art.shtml");
  const srcs = cands.map((c) => `${c.date}:${c.source}`).sort();
  assert.ok(srcs.includes("2026-08-07:meta-article"), "meta 候选");
  assert.ok(srcs.includes("2026-08-06:jsonld"), "JSON-LD 候选");
  assert.ok(srcs.includes("2026-08-05:body-ctx"), "正文上下文候选(ctxStrong)");
  assert.ok(srcs.includes("2026-08-04:url"), "URL 候选");
  const ctx = cands.find((c) => c.source === "body-ctx");
  assert.equal(ctx.ctxStrong, true, "正文发布时间语境词标记");
});

test("候选生成: 列表页时间元素(list-time)与 JS 变量", () => {
  const html = `<html><head><meta property="article:published_time" content="2018-03-28"></head>
    <body><ul>
      <li><span class="time">2026-08-07 10:30</span><a href="/20260807/a.shtml">新闻一</a></li>
      <li><span class="time">2026-08-06 22:00</span><a href="/20260806/b.shtml">新闻二</a></li>
    </ul><script>var publishTime="2026-08-05";</script></body></html>`;
  const cands = extractDateCandidates(html, "https://x.cn/roll");
  const srcs = cands.map((c) => c.source);
  assert.ok(srcs.includes("list-time"), "列表时间元素应生成候选");
  assert.ok(srcs.includes("js-var"), "JS 变量应生成候选");
  assert.ok(srcs.includes("meta-article"), "meta 也在(供裁决比较)");
});

// ---------- 页面特征 ----------
test("页面特征: 列表页(链接密集/无 article/短壳/频道标题)与文章页区分信号", () => {
  const listHtml = `<html><head><title>滚动新闻_国际在线</title></head><body>
    <ul><li><a href="/20260807/1.shtml">新闻一</a></li><li><a href="/20260807/2.shtml">新闻二</a></li>
    <li><a href="/20260807/3.shtml">新闻三</a></li><li><a href="/20260807/4.shtml">新闻四</a></li></ul></body></html>`;
  const artHtml = `<html><head><title>一篇真实报道</title></head><body>
    <article><h1>标题</h1><p>${"正文内容".repeat(300)}</p></article></body></html>`;
  const f1 = extractPageFeatures(listHtml, "https://x.cn/roll", 0, "滚动新闻_国际在线");
  const f2 = extractPageFeatures(artHtml, "https://x.cn/2026/0807/a.shtml", 1500, "一篇真实报道");
  assert.ok(f1.linkDensity > f2.linkDensity, "列表页链接密度更高");
  assert.equal(f1.hasArticle, 0);
  assert.equal(f2.hasArticle, 1, "文章页有 article 容器");
  assert.equal(f1.bodyShort, 1, "列表页正文短壳");
  assert.equal(f1.titleChannel, 1, "标题含频道词");
  assert.equal(f2.bodyMed, 0, "长文不进中档桶");
});

// ---------- pickDate 裁决 ----------
test("pickDate: 列表页 meta 误导(2018-03-28)被 list-time 2026-08-07 压过", () => {
  resetDateModel();
  const html = `<html><head><meta property="article:published_time" content="2018-03-28">
    <title>滚动新闻_国际在线</title></head><body><ul>
      <li><span class="time">2026-08-07 10:30</span><a href="/20260807/a.shtml">谈判举行</a></li>
      <li><span class="time">2026-08-06 22:00</span><a href="/20260806/b.shtml">油价波动</a></li>
      <li><a href="/20260805/c.shtml">外交动态</a></li></ul></body></html>`;
  const r = pickDate(html, "https://news.cri.cn/channel/roll", { bodyLen: 0, title: "滚动新闻_国际在线" });
  assert.equal(r.date, "2026-08-07", "应选列表最新条目时间而非 meta");
  assert.equal(r.source, "list-time");
  assert.equal(r.isList, true);
});

test("pickDate: 真文章页唯一 meta-article → 规则快速路径直接采用", () => {
  resetDateModel();
  const html = `<html><head><meta property="article:published_time" content="2026-08-07">
    <title>一篇真实报道</title></head><body><article><h1>标题</h1><p>${"正文内容".repeat(200)}</p></article></body></html>`;
  const r = pickDate(html, "https://news.cn/2026/0807/art.shtml", { bodyLen: 1000, title: "一篇真实报道" });
  assert.equal(r.date, "2026-08-07");
  assert.equal(r.source, "meta-article");
  assert.equal(r.isList, false);
});

test("pickDate: 列表页仅剩 meta 候选时拒绝(宁缺毋错,不输出误导日期)", () => {
  resetDateModel();
  const html = `<html><head><meta property="article:published_time" content="2018-03-28">
    <title>频道_列表</title></head><body>
    <a href="/20260807/a.shtml">新闻一</a><a href="/20260806/b.shtml">新闻二</a></body></html>`;
  const r = pickDate(html, "https://x.cn/channel", { bodyLen: 0, title: "频道_列表" });
  assert.equal(r.date, "", "不应输出频道页元数据日期");
  assert.equal(r.isList, true);
});

// ---------- 在线学习(感知机) ----------
test("在线学习: updateLinear 朝 label 方向收敛,预测值改善", () => {
  const model = { w: {}, bias: 0, samples: 0 };
  const feats = { "src:meta-article": 1, ctxStrong: 1 };
  const p0 = predictLinear(feats, model);
  for (let i = 0; i < 50; i++) updateLinear(model, feats, 1, 0.1); // 反复正样本
  const p1 = predictLinear(feats, model);
  assert.ok(p1 > p0, `正样本训练后预测应上升: ${p0.toFixed(3)} → ${p1.toFixed(3)}`);
  assert.ok(p1 > 0.5, "应超过 0.5 阈值");
});

test("在线学习: 正常文章正文按字符长度提供列表页负样本", () => {
  resetDateModel();
  const html = `<html><body><article><p>${"正文内容".repeat(100)}</p></article></body></html>`;
  recordFetchOutcome("https://example.com/article", html, {
    isList: false,
    listCount: 0,
    body: "正文内容".repeat(100),
  });
  assert.equal(inspectDateModel().list.samples, 1, "未显式传 bodyLen 时应使用正文字符数");
});

test("在线学习: 正文明确日期同时强化正确候选并压低错误候选", () => {
  resetDateModel();
  const html = `<html><head><meta property="article:published_time" content="2025-05-01"></head>
    <body><article><p>本文发表于2026年8月6日。</p><p>${"正文".repeat(150)}</p></article></body></html>`;
  recordFetchOutcome("https://example.com/2026/08-07/a.html", html, {
    body: "正文".repeat(150),
    listCount: 0,
  });
  const model = inspectDateModel().cand;
  assert.ok(model.samples >= 3, `meta/URL/正文候选都应收到监督,实际 ${model.samples}`);
  assert.ok(model.w["src:body-ctx"] > 0.25, "正文强日期来源权重应得到正向更新");
  assert.ok(model.w["src:meta-article"] < 0.7, "冲突 meta 来源权重应得到负向更新");
});

test("模型持久化: inspectDateModel 含冷启动先验(meta-article 权重最高)", () => {
  resetDateModel();
  const m = inspectDateModel();
  assert.ok(m.cand.w["src:meta-article"] > m.cand.w["src:meta-generic"], "meta-article 先验强于泛 meta");
  assert.ok(m.list.w.hasArticle < 0, "article 容器 → 文章页(负列表权重)");
});

// ---------- URL 冲突裁决(2026-08 修复) ----------
test("pickDate: meta 过期与 URL 日期冲突(相差>30天)时选 URL(meta 可能是 CMS 缓存/频道元数据)", () => {
  resetDateModel();
  const html = `<html><head><title>中美贸易新动作</title>
    <meta property="article:published_time" content="2025-05-01">
    <meta name="date" content="2025-05-01"></head>
    <body><article><h1>中美贸易新动作</h1><p>${"内容".repeat(600)}</p></article></body></html>`;
  const r = pickDate(html, "https://www.chinanews.com.cn/cj/2026/08-07/10673364.shtml", { bodyLen: 1200, title: "中美贸易新动作" });
  assert.equal(r.date, "2026-08-07", "冲突时 URL 日期(页面真实时间)应胜出");
  assert.equal(r.source, "url");
  assert.equal(r.isList, false, "真文章页不应误判列表页");
});

test("pickDate: 正文明确声明发布时间时,body-ctx 压过 URL 冲突惩罚", () => {
  resetDateModel();
  const html = `<html><head><title>解读</title>
    <meta property="article:published_time" content="2025-05-01"></head>
    <body><article><h1>解读</h1><p>本文发表于2026年8月6日,分析如下。</p><p>${"文".repeat(400)}</p></article></body></html>`;
  const r = pickDate(html, "https://x.cn/2026/08-07/123.shtml", { bodyLen: 800, title: "解读" });
  assert.equal(r.date, "2026-08-06", "正文语境日期可信度最高");
  assert.equal(r.source, "body-ctx");
});

test("parseResultDateAgo: 缺年份月日(8月6日)按当年解析,不再返回 null", () => {
  const ago = parseResultDateAgo("8月6日");
  assert.ok(ago !== null && ago >= 0 && ago < 366, `缺年份日期应按当年解析: ${ago}`);
  const y = parseResultDateAgo("2026-08-06");
  assert.ok(typeof y === "number" && y >= 0);
});
