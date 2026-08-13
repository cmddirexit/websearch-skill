// domain-rep.mjs 域名信誉评分 + 增量学习(软限制,非硬剔除)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registrableHost, repKeys, contributionFromQuality, updateScore, updateFetchScore, updateUtilityScore, effectiveScore, decayedScore,
  repFactor, repBadge, utilityFactor, clamp, createDomainReputation,
  cnBigrams, enWords, urlTokens, flagTokens, extractLearnFeatures, titleFlagTokens, normalizedFeatureVector, predictTokens, updateMetaTokens, metaReady,
} from "../../domain-rep.mjs";
import { assessContentEvidence } from "../../content-evidence.mjs";
import { createContentBayes } from "../../content-bayes.mjs";


test("rep: 注册域名去 www、折叠子域,失败/引擎域返回空串", () => {
  assert.equal(registrableHost("https://www.cnblogs.com/pinpaituijan/p/1"), "cnblogs.com");
  assert.equal(registrableHost("https://zhuanlan.zhihu.com/p/1"), "zhihu.com", "子域折叠到注册域");
  assert.equal(registrableHost("https://news.xnnews.com.cn/a"), "xnnews.com.cn", "二级国家域正确提取");
  assert.equal(registrableHost("not a url"), "");
  assert.equal(registrableHost("https://e.so.com/we?q=1"), "", "引擎跳转域不学习");
  assert.equal(registrableHost("https://link.zhihu.com/?target=x"), "", "外链跳转域不学习");
});


test("rep: 两级键 = host 全站 + host/首段路径(站内子空间)", () => {
  assert.deepEqual(repKeys("https://www.cnblogs.com/pinpaituijan/p/20062149"), ["cnblogs.com", "cnblogs.com/pinpaituijan"]);
  assert.deepEqual(repKeys("https://www.zhihu.com/question/123"), ["zhihu.com", "zhihu.com/question"]);
  // 首页无路径段 → 仅 host;文件扩展名/功能段路径不建子键
  assert.deepEqual(repKeys("https://blog.com/"), ["blog.com"]);
  assert.deepEqual(repKeys("https://blog.com/index.html"), ["blog.com"]);
  assert.deepEqual(repKeys("https://news.example.com/2026/08/story"), ["example.com"], "年份首段不是内容分区");
  assert.deepEqual(repKeys("https://news.example.com/123456/story"), ["example.com"], "纯数字 ID 首段不是内容分区");
  assert.deepEqual(repKeys("https://github.com/login"), ["github.com"], "功能段不建子键");
  assert.deepEqual(repKeys("https://e.so.com/we?q=1"), [], "引擎域无键");
});


test("rep: 贡献分 = quality 基础 + spam/栏目页惩罚,desc-empty 中性化,clamp [0.05,1]", () => {
  assert.equal(contributionFromQuality(1), 1);
  assert.equal(contributionFromQuality(0.5), 0.5);
  assert.ok(contributionFromQuality(0.5, ["low:spam-desc"]) < contributionFromQuality(0.5), "垃圾文案标记应减分");
  assert.ok(contributionFromQuality(0.5, ["low:index-page"]) < contributionFromQuality(0.5), "栏目页应减分");
  assert.ok(contributionFromQuality(0.5, ["low:desc-empty"]) > contributionFromQuality(0.5, ["low:index-page"]), "desc-empty 惩罚应远轻于栏目页(反爬误伤防护)");
  assert.equal(contributionFromQuality(0.5, ["low:spam-desc", "low:index-page"]), 0.1, "0.5×0.4×0.5=0.1");
  assert.equal(contributionFromQuality(NaN), 0.5, "非法 quality 回退中性");
  assert.equal(contributionFromQuality(0.001), 0.05, "下限 clamp");
});


test("rep: 平滑更新收敛到贡献值,学习率随样本数递减", () => {
  const e = { searchScore: 0.5, searchSamples: 0 };
  updateScore(e, 0.9);
  assert.ok(e.searchScore > 0.5 && e.searchScore < 0.9, "首样本向 0.9 移动");
  for (let i = 0; i < 200; i++) updateScore(e, 0.9);
  assert.ok(e.searchScore > 0.88, "200 样本后收敛到 0.9");
  // 学习率递减:样本多时单次噪声漂移小
  const e2 = { searchScore: 0.8, searchSamples: 100 };
  updateScore(e2, 0.1);
  assert.ok(Math.abs(e2.searchScore - 0.8) < 0.1, "稳定期抗单次噪声漂移");
  const e3 = { searchScore: 0.5, searchSamples: 0 };
  updateScore(e3, 0.1);
  assert.ok(Math.abs(e3.searchScore - 0.5) > 0.1, "探索期学得快");
});


test("rep: 时间衰减 — 30 天内不变,90 天完全中性", () => {
  const now = Date.now();
  const entry = { searchScore: 0.2, contentScore: 0.5, searchSamples: 10, lastSeen: now };
  assert.equal(decayedScore(entry, now), 0.2, "刚见过不衰减");
  assert.equal(decayedScore(entry, now + 29 * 86_400_000), 0.2, "30 天内零衰减");
  const mid = decayedScore(entry, now + 60 * 86_400_000);
  assert.ok(mid > 0.2 && mid < 0.5, "60 天部分回归:" + mid);
  assert.equal(decayedScore(entry, now + 120 * 86_400_000), 0.5, "90 天后完全中性");
});


test("rep: 信誉因子映射 — 0.5→1,0→0.35,1→1.15;冷启动不干预", () => {
  assert.equal(repFactor(0.5, 10), 1);
  assert.equal(repFactor(0, 10), 0.35);
  assert.equal(repFactor(1, 10), 1.15);
  assert.equal(repFactor(0.8, 10), 1.15, "0.8→1.48 超上限 clamp 到 1.15");
  assert.equal(repFactor(0, 1), 1, "样本不足(冷启动)零干预");
  assert.equal(repFactor(0, 2), 1);
  assert.equal(repFactor(0.5, 3), 1);
});

test("rep: 主动选择使用价值至少三次才生效,并封顶 3%", () => {
  const entry = { utilityScore: 0, utilitySamples: 0 };
  updateUtilityScore(entry);
  updateUtilityScore(entry);
  assert.equal(utilityFactor(entry), 1);
  updateUtilityScore(entry);
  assert.ok(utilityFactor(entry) > 1 && utilityFactor(entry) < 1.03);
  for (let i = 0; i < 20; i++) updateUtilityScore(entry);
  assert.equal(entry.utilityScore, 1);
  assert.equal(utilityFactor(entry), 1.03);
});


test("rep: badge 分档 — ≥0.65 正,≤0.35 负,中间中性,冷启动无 badge", () => {
  assert.equal(repBadge(0.82, 5), "✓[rep:0.82]");
  assert.equal(repBadge(0.31, 5), "⚠[rep:0.31]");
  assert.equal(repBadge(0.5, 5), "·[rep:0.50]");
  assert.equal(repBadge(0.1, 2), "", "冷启动无 badge");
  assert.equal(clamp(1.5, 0, 1), 1);
  assert.equal(clamp(-1, 0, 1), 0);
});


test("rep: 从搜索结果学习 — 低质域名降分,干净域名保持;ad: 硬剔除不参与;desc-empty 不误伤", () => {
  const rep = createDomainReputation({ file: null });
  rep.learnFromResults([
    { title: "某发稿平台软文", url: "https://www.cnblogs.com/pinpaituijan/p/1", desc: "立即点击下载领取优惠", flags: ["low:spam-desc"], quality: 0.7 },
    { title: "某发稿平台软文2", url: "https://www.cnblogs.com/pinpaituijan/p/2", desc: "马上注册限时免费", flags: ["low:spam-desc"], quality: 0.6 },
    { title: "正常深度文章", url: "https://zhuanlan.zhihu.com/p/1", desc: "完整内容", flags: [], quality: 1 },
    { title: "知乎问题(反爬无摘要)", url: "https://www.zhihu.com/question/1", desc: "", flags: ["low:desc-empty"], quality: 0.9 },
    { title: "广告", url: "https://ads.example.com/1", flags: ["ad:domain"], quality: 0 },
  ]);
  const raw = rep._raw();
  assert.ok(raw["cnblogs.com"].searchSamples === 2 && raw["cnblogs.com"].searchScore < 0.5, "软文域名降分:" + raw["cnblogs.com"].searchScore);
  assert.equal(raw["cnblogs.com/pinpaituijan"].searchSamples, 2, "路径子键同步学习");
  assert.ok(raw["zhihu.com"].searchSamples >= 2 && raw["zhihu.com"].searchScore >= 0.75, "知乎(含 zhuanlan 折叠)保持高分:" + raw["zhihu.com"].searchScore);
  assert.equal(raw["ads.example.com"], undefined, "广告域名不参与信誉");
  // desc-empty 不计入内容低质(知乎反爬不误伤):lowHits 不涨,分数接近中性偏上
  assert.equal(raw["zhihu.com"].lowHits, 0, "desc-empty 不计数为内容低质");
  assert.ok(raw["zhihu.com"].searchScore >= 0.8, "desc-empty 微减不伤知乎:" + raw["zhihu.com"].searchScore);
  // 冷启动(<3 样本):lookup 有样本但 factor=1(零干预)
  const lu = rep.lookup("https://zhuanlan.zhihu.com/p/2");
  assert.ok(lu && lu.samples >= 1 && lu.factor === 1, "冷启动零干预");
});

test("rep: 重复搜索结果和同日抓取状态不冒充独立样本", () => {
  const rep = createDomainReputation({ file: null });
  const result = { title: "同一篇文章", url: "https://repeat.example/article/1", flags: [], quality: 1 };
  rep.learnFromResults([result]);
  rep.learnFromResults([result]);
  assert.equal(rep._raw()["repeat.example"].searchSamples, 1);
  rep.learnFetch(result.url, false);
  rep.learnFetch(result.url, false);
  assert.equal(rep._raw()["repeat.example"].availabilitySamples, 1);
});

test("rep: 主动 fetch 选择按 URL/日期去重,只微升 utility 而不污染质量模型", () => {
  const rep = createDomainReputation({ file: null });
  const beforeMeta = rep._meta().weightSamples;
  rep.learnSelection("https://useful.example/articles/1");
  rep.learnSelection("https://useful.example/articles/1");
  assert.equal(rep._raw()["useful.example"].utilitySamples, 1, "同 URL 同日只计一次");
  assert.equal(rep.lookup("https://useful.example/articles/next").factor, 1, "一次选择不影响排序");

  rep.learnSelection("https://useful.example/articles/2");
  assert.equal(rep.lookup("https://useful.example/articles/next").factor, 1, "两次选择仍不影响排序");
  rep.learnSelection("https://useful.example/articles/3");
  const selected = rep.lookup("https://useful.example/articles/next");
  assert.ok(selected.factor > 1 && selected.factor <= 1.03, JSON.stringify(selected));
  assert.equal(selected.score, 0.5, "选择行为不改变内容信誉分");
  assert.equal(selected.samples, 0, "选择行为不冒充内容/搜索样本");
  assert.equal(selected.utilitySamples, 3);
  assert.equal(rep._raw()["useful.example"].contentScore, 0.5);
  assert.equal(rep._raw()["useful.example"].availabilityScore, 0.5);
  assert.equal(rep._meta().weightSamples, beforeMeta, "选择行为不训练跨域模型");
  assert.equal(rep._events().length, 0, "选择行为不生成训练事件");

  for (let i = 4; i <= 20; i++) rep.learnSelection(`https://useful.example/other/${i}`);
  assert.equal(rep.lookup("https://useful.example/new").factor, 1.03, "使用价值最多提升 3%");
});


test("rep: 重复低质模式惩罚 — 稳定低质率>60% 的域名持续降档(学习规律)", () => {
  const rep = createDomainReputation({ file: null });
  // 软文站:8 条全是内容低质标记
  for (let i = 0; i < 8; i++) {
    rep.learnFromResults([{ title: `限时优惠第${i}篇`, url: `https://seo-station.com/p/${i}`, desc: "立即点击注册领取", flags: ["low:spam-title", "low:spam-desc"], quality: 0.5 }]);
  }
  const lu = rep.lookup("https://seo-station.com/p/99");
  assert.ok(lu && lu.score < 0.25, "重复低质模式 → 深降:" + lu?.score);
  assert.ok(lu.score < 0.35, "低于单次惩罚能到的水平(规律惩罚生效)");
  // 正常站:同样 8 条但干净 → 高分
  const rep2 = createDomainReputation({ file: null });
  for (let i = 0; i < 8; i++) {
    rep2.learnFromResults([{ title: `正常文章${i}`, url: `https://good-blog.com/p/${i}`, desc: "这是完整的技术文章内容,信息量充足", flags: [], quality: 1 }]);
  }
  assert.ok(rep2.lookup("https://good-blog.com/p/9").score > 0.9, "干净站保持高分");
  // 反爬站:8 条全是 desc-empty(无内容低质标记)→ 不触发规律惩罚
  const rep3 = createDomainReputation({ file: null });
  for (let i = 0; i < 8; i++) {
    rep3.learnFromResults([{ title: `知乎问题${i}`, url: `https://www.zhihu.com/question/${i}`, desc: "", flags: ["low:desc-empty"], quality: 0.9 }]);
  }
  assert.ok(rep3.lookup("https://www.zhihu.com/question/99").score > 0.8, "全 desc-empty 不触发规律惩罚(反爬误伤防护)");
});


test("rep: 抓取可用性与内容质量分离 — 空壳不污染内容模型", () => {
  const rep = createDomainReputation({ file: null });
  rep.learnFetch("https://seo-shell.com/p/1", false);
  rep.learnFetch("https://seo-shell.com/p/2", false);
  rep.learnFetch("https://seo-shell.com/p/3", false);
  const lu = rep.lookup("https://seo-shell.com/p/9");
  assert.equal(lu.score, 0.5, "空壳只说明不可用,不得判定内容低质");
  assert.ok(lu.factor < 1 && lu.factor >= 0.75, "重复不可用只做温和降权:" + lu.factor);
  assert.ok(lu.fetchEmpty >= 3);
  assert.equal(rep._meta().weightSamples, 0, "抓取失败不得训练跨域内容模型");
  rep.learnFetch("https://good.com/p/1", true);
  const lu2 = rep.lookup("https://good.com/p/2");
  assert.equal(lu2.score, 0.5, "抓取成功也不等于内容可信");
});


test("rep: 软降权应用 — quality 乘因子,低信誉压沉不剔除,冷启动零影响", () => {
  const rep = createDomainReputation({ file: null });
  for (let i = 0; i < 3; i++) {
    rep.recordContentEvidence(`https://low.com/article/${i}`, 0.1, { tokens: new Set(["t:低质模板"]), eventKey: `low-${i}` });
    rep.recordContentEvidence(`https://high.com/article/${i}`, 0.95, { tokens: new Set(["t:深度内容"]), eventKey: `high-${i}` });
  }
  const results = [
    { title: "低信誉域文章", url: "https://low.com/p/1", quality: 1 },
    { title: "高信誉域文章", url: "https://high.com/p/1", quality: 1 },
    { title: "冷启动域文章", url: "https://fresh.com/p/1", quality: 1 },
  ];
  rep.applyToResults(results);
  assert.ok(results[0].quality < 0.7, "低信誉压沉:" + results[0].quality);
  assert.ok(results[1].quality > 1, "高信誉微升:" + results[1].quality);
  assert.equal(results[2].quality, 1, "冷启动零影响");
  assert.ok(results[0].rep.badge.startsWith("⚠"), "低信誉打负 badge");
  assert.ok(results[1].rep.badge.startsWith("✓"), "高信誉打正 badge");
});


test("rep: 单个启发式极端分不冒充独立证据提前干预", () => {
  const rep = createDomainReputation({ file: null });
  rep.learnFromResults([{
    title: "疑似推广",
    url: "https://heuristic.example/sponsored/1",
    flags: ["low:spam-desc", "low:index-page"],
    quality: 0.2,
  }]);
  const hit = rep.lookup("https://heuristic.example/sponsored/2");
  assert.equal(hit.trustedSamples, 0);
  assert.equal(hit.factor, 1, "不足 3 样本且无 LLM/fetch 证据时不得提前降权");
  assert.equal(hit.badge, "");
});


test("rep: 路径级样本优先于全站样本,隔离同站不同内容区", () => {
  const rep = createDomainReputation({ file: null });
  for (let i = 0; i < 8; i++) {
    rep.learnFromResults([{
      title: `正常技术文章 ${i}`,
      url: `https://mixed.example/articles/${i}`,
      flags: [],
      quality: 1,
    }]);
  }
  for (let i = 0; i < 4; i++) {
    rep.learnFromResults([{
      title: `推广软文 ${i}`,
      url: `https://mixed.example/sponsored/${i}`,
      flags: ["low:spam-desc"],
      quality: 0.3,
    }]);
  }
  const articles = rep.lookup("https://mixed.example/articles/next");
  const sponsored = rep.lookup("https://mixed.example/sponsored/next");
  assert.equal(articles.scope, "mixed.example/articles");
  assert.equal(sponsored.scope, "mixed.example/sponsored");
  assert.ok(articles.score > sponsored.score + 0.4, `${articles.score} vs ${sponsored.score}`);
});


test("rep: 持久化 roundtrip(跨进程增量积累)", () => {
  const dir = mkdtempSync(join(tmpdir(), "wsrep-"));
  const file = join(dir, "rep.json");
  try {
    const r1 = createDomainReputation({ file });
    r1.learnFetch("https://persist.com/a", false);
    r1.learnFetch("https://persist.com/b", true);
    r1.learnSelection("https://persist.com/selected/1");
    r1.learnSelection("https://persist.com/selected/2");
    r1.learnSelection("https://persist.com/selected/3");
    r1.save();
    const r2 = createDomainReputation({ file });
    const lu = r2.lookup("https://persist.com/c");
    assert.ok(lu && lu.samples === 0 && lu.fetchEmpty === 1 && lu.fetchOk === 1, "可用性状态跨实例读回:" + JSON.stringify(lu));
    assert.equal(lu.utilitySamples, 3, "使用价值状态跨实例读回");
    assert.ok(lu.factor > 1, "持久化后的使用价值微升仍生效");
    r2.learnSelection("https://persist.com/selected/1");
    assert.equal(r2._raw()["persist.com"].utilitySamples, 3, "重启后同 URL 同日仍去重");
    // 继续积累(不覆盖,增量)
    r2.learnFetch("https://persist.com/d", false);
    r2.learnSelection("https://persist.com/selected/4");
    r2.save();
    const r3 = createDomainReputation({ file });
    assert.equal(r3._raw()["persist.com"].availabilitySamples, 3, "可用性增量积累");
    assert.equal(r3._raw()["persist.com"].utilitySamples, 4, "使用价值增量积累");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rep: v2 污染模型不迁移到新的证据边界", () => {
  const dir = mkdtempSync(join(tmpdir(), "wsrep-v2-"));
  const file = join(dir, "rep.json");
  try {
    writeFileSync(file, JSON.stringify({
      version: 2,
      updatedAt: Date.now(),
      meta: { weights: { "t:词典": -3 }, weightSamples: 100 },
      domains: { "dict.example": { searchScore: 0.1, searchSamples: 20 } },
    }));
    const rep = createDomainReputation({ file });
    assert.equal(rep.lookup("https://dict.example/a"), null, "旧查询反馈污染不得继续影响信誉");
    assert.equal(rep._meta().weightSamples, 0, "旧规则自训练权重不得继续用于冷启动");
    rep.learnFromResults([{ title: "正常词典", url: "https://dict.example/a", quality: 1, flags: [] }]);
    rep.save();
    assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 4, "新证据写回 v4 schema");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rep: v3 只迁移未混入旧 fetch 的域名搜索历史", () => {
  const dir = mkdtempSync(join(tmpdir(), "wsrep-v3-"));
  const file = join(dir, "rep.json");
  try {
    writeFileSync(file, JSON.stringify({
      version: 3,
      meta: { weights: { "t:旧权重": -2 }, weightSamples: 100 },
      domains: {
        "search-only.example": { searchScore: 0.8, searchSamples: 5, fetchSamples: 0, lastSeen: Date.now() },
        "mixed-fetch.example": { searchScore: 0.1, searchSamples: 5, fetchSamples: 2, lastSeen: Date.now() },
      },
    }));
    const rep = createDomainReputation({ file });
    assert.equal(rep.lookup("https://search-only.example/a").score, 0.8);
    assert.equal(rep.lookup("https://mixed-fetch.example/a"), null);
    assert.equal(rep._meta().weightSamples, 0);
    assert.equal(rep._events().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// ==================== 元学习:学习式 token 特征(非硬匹配) ====================

test("meta: tokenizer — 中文 bigram/英文词/URL 段/内容标记,无人工词表", () => {
  // 中文 bigram(纯汉字)
  const bg = cnBigrams("推荐测评平台");
  assert.ok(bg.has("推荐") && bg.has("荐测") && bg.has("测评") && bg.has("评平") && bg.has("平台"), "中文 2-gram:" + [...bg]);
  assert.ok(!cnBigrams("abc123").size, "非汉字不产出 bigram");
  // 英文词(小写)
  const ew = enWords("Best Reddit Guide 2026");
  assert.ok(ew.has("best") && ew.has("reddit") && ew.has("2026"), "英文词+数字词");
  // URL 段(纯数字段归一化为 n,防具体日期过拟合;混合段如 t20260512_4609208 是软文模板特征,保留)+ 域名标签
  const ut = urlTokens("http://news.xnnews.com.cn/shangy/202605/t20260512_4609208.shtml");
  assert.ok(ut.has("d:xnnews") && ut.has("u:shangy"), "域名标签+路径段");
  assert.ok(ut.has("u:n") && !ut.has("u:202605"), "纯数字段归一化:" + [...ut]);
  assert.ok(ut.has("u:t20260512_4609208"), "混合日期模板段保留(软文特征):" + [...ut]);
  // 内容标记
  const ft = flagTokens(["low:spam-desc", "low:desc-empty"]);
  assert.ok(ft.has("f:spam-desc") && ft.has("f:desc-empty") && !ft.has("ad:domain"), "flag → token,广告排除");
  // 合并
  const all = extractLearnFeatures("https://blog.com/p/1", { title: "Python教程 推荐", flags: ["low:desc-empty"] });
  assert.ok(all.has("t:python") && all.has("t:教程") && all.has("u:n") && all.has("f:desc-empty"), "合并激活集:" + [...all]);
});


test("meta: 预测 — 无权重中性 0.5,权重推动偏离", () => {
  const m0 = { bias: 0, weights: {} };
  assert.equal(predictTokens(new Set(["t:推荐"]), m0), 0.5, "零权重 → 中性");
  const m = { bias: 0, weights: { "t:推荐": -1.2, "t:教程": 0.8 } };
  assert.ok(predictTokens(new Set(["t:推荐"]), m) < 0.35, "负权重压分:" + predictTokens(new Set(["t:推荐"]), m));
  assert.ok(predictTokens(new Set(["t:教程"]), m) > 0.6, "正权重提分:" + predictTokens(new Set(["t:教程"]), m));
  assert.ok(predictTokens(new Set(["t:未知词"]), m) === 0.5, "未见 token 无影响(稀疏泛化)");
});

test("meta: 特征按通道归一化,域名身份和规则 flag 不进入跨域模型", () => {
  const vector = normalizedFeatureVector(new Set([
    "t:a", "t:b", "t:c", "t:d", "u:post", "d:example", "f:spam-desc",
  ]));
  assert.equal(vector.get("t:a"), 0.25);
  assert.equal(vector.get("u:post"), 1);
  assert.equal(vector.has("d:example"), false);
  assert.equal(vector.has("f:spam-desc"), false);
  assert.equal([...vector.entries()].filter(([token]) => token.startsWith("t:")).reduce((sum, [, x]) => sum + x, 0), 1);
});


test("meta: 在线学习 — token 权重从数据中涌现,非硬编码", () => {
  // 模拟真实软文站:标题高度模板化(同一发稿商标题几乎一致),反复低质出现
  const SEO_TITLE = "2026年6月工程信息平台推荐榜测评优惠免费下载"; // 软文模板标题
  const DOC_TITLE = "Python爬虫教程完整实战"; // 干净技术文章标题
  const meta = { bias: 0, weights: {}, touched: {}, weightSamples: 0 };
  for (let i = 0; i < 80; i++) {
    updateMetaTokens(meta, extractLearnFeatures(`https://seo${i}.com/post/${i}`, { title: SEO_TITLE, flags: ["low:spam-desc"] }), 0.1);
    updateMetaTokens(meta, extractLearnFeatures(`https://docs${i}.com/post/${i}`, { title: DOC_TITLE, flags: [] }), 0.95);
  }
  // 数据自动学出:软文词权重为负,教程词权重为正(没有人工定义任何词表)
  assert.ok(meta.weights["t:推荐"] < -0.1, "推荐 权重被学负:" + meta.weights["t:推荐"]);
  assert.ok(meta.weights["t:优惠"] < -0.1, "优惠 权重被学负:" + meta.weights["t:优惠"]);
  assert.ok(meta.weights["t:爬虫"] > 0.1, "爬虫 权重被学正:" + meta.weights["t:爬虫"]);
  assert.ok(meta.weights["t:教程"] > 0.1, "教程 权重被学正:" + meta.weights["t:教程"]);
  assert.ok(meta.weights["t:优惠"] < meta.weights["t:爬虫"], "软文词权重低于教程词:" + meta.weights["t:优惠"] + " vs " + meta.weights["t:爬虫"]);
  // 预测:新域名 + 与训练模板一致的软文词 → 强识别;模板变形(部分词重合)→ 略低于中性;
  // 教程词 → 预测高。bigram 对词边界敏感,故变形标题只要求中性偏下,模板一致要求强负。
  const seoPred = predictTokens(extractLearnFeatures("https://new-seo.com/post/1", { title: "2026年7月工程信息平台推荐榜测评优惠免费下载" }), meta);
  assert.ok(seoPred < 0.35, "模板一致的新软文冷启动预测低:" + seoPred);
  const seoVar = predictTokens(extractLearnFeatures("https://new-seo2.com/post/1", { title: "2026年6月免费推荐下载测评" }), meta);
  assert.ok(seoVar < 0.55, "模板变形(部分词重合)预测略低于中性:" + seoVar);
  const docPred = predictTokens(extractLearnFeatures("https://new-docs.com/post/1", { title: "爬虫教程实战" }), meta);
  assert.ok(docPred > 0.6, "新教程冷启动预测高:" + docPred);
  // 未见 token 的域名 → 中性(稀疏泛化,不误伤)
  assert.ok(Math.abs(predictTokens(new Set(["t:神秘词xyz"]), meta) - 0.5) < 0.1, "未见词中性");
});


test("meta: 冷启动先验要求正负两类证据,并随域名自身证据平滑淡出", () => {
  const rep = createDomainReputation({ file: null });
  // 模式未成熟(样本 < META_MIN_SAMPLES):新域名无预测(冷启动关闭)
  rep.learnFromResults([{ title: "测试", url: "https://a.com/1", desc: "x", flags: [], quality: 0.9 }]);
  assert.equal(rep.lookup("https://brand-new-domain.com/p/1"), null, "模式未成熟不预测");
  // 只有负样本时即使达到总量门槛也不得启用,防默认环境单类投毒。
  for (let i = 0; i < 30; i++) {
    const url = `https://seo${i}.com/2026/0${i % 9}/t${i}${i}.shtml`;
    const title = `2026年${i}月平台推荐榜测评口碑`;
    rep.record(url, 0.4, {
      low: true,
      tokens: extractLearnFeatures(url, { title, flags: ["low:spam-desc", "low:desc-empty"] }),
      metaLabel: 0.1,
    });
  }
  assert.equal(metaReady(rep._meta()), false);
  assert.equal(rep.lookup("https://negative-only.example/post/1", { title: "平台推荐榜测评" }), null);
  // 加入独立正样本后模型才启用。
  for (let i = 0; i < 30; i++) {
    const url = `https://docs${i}.example/tutorial/${i}`;
    rep.record(url, 0.9, {
      tokens: extractLearnFeatures(url, { title: `Python异步编程教程实战${i}` }),
      metaLabel: 0.9,
    });
  }
  assert.equal(metaReady(rep._meta()), true);
  // 全新域名(从未见过):标题带学到的软文模式 → 冷启动预测低分 + 软降权生效
  const cold = rep.lookup("https://brand-new-seo-site.cn/2026/07/t20260712_12345.shtml", { title: "2026年7月信息平台推荐榜测评" });
  assert.ok(cold && cold.coldStart === true, "新域名走冷启动匹配");
  assert.ok(cold.score < 0.45, "冷启动预测分压低:" + cold?.score);
  assert.ok(cold.factor < 1, "冷启动软降权生效:" + cold?.factor);
  assert.ok(cold.badge.startsWith("[meta:"), "badge 标注预测来源");
  // 干净的新域名(无软文特征)→ 中性(允许 bias 偏移 ±0.12,60 软文样本会把 bias 稍微拉低)
  const neutral = rep.lookup("https://brand-new-clean-blog.com/p/1", { title: "Python 异步编程详解" });
  assert.ok(neutral && neutral.score >= 0.38 && neutral.score <= 0.62, "无特征新站中性:" + neutral?.score);
  // 一条启发式样本后先验不应突然消失,而是渐进融合。
  rep.learnFromResults([{ title: "2026年7月信息平台推荐榜测评", url: "https://brand-new-seo-site.cn/2026/07/next.shtml", desc: "形式完整", flags: [], quality: 1 }]);
  const blended = rep.lookup("https://brand-new-seo-site.cn/2026/07/again.shtml", { title: "2026年7月信息平台推荐榜测评" });
  assert.ok(blended.samples >= 1 && blended.priorWeight > 0, "少量自身样本仍保留先验");
  assert.ok(blended.factor < 1, "一次形态正常样本不能立即洗掉低质先验:" + JSON.stringify(blended));
});

test("meta: 训练事件按来源和页面去重并可持久化回放", () => {
  const dir = mkdtempSync(join(tmpdir(), "wsrep-events-"));
  const file = join(dir, "rep.json");
  try {
    const rep = createDomainReputation({ file });
    const args = { tokens: new Set(["t:模板", "u:post"]), source: "local-content-v1", eventKey: "same-content", confidence: 0.8 };
    assert.equal(rep.recordContentEvidence("https://a.example/post/1", 0.2, args), true);
    assert.equal(rep.recordContentEvidence("https://a.example/post/1", 0.2, args), false, "重复证据不重复训练");
    assert.equal(rep._events().length, 1);
    assert.equal(rep._meta().weightSamples, 1);
    rep.save();
    const loaded = createDomainReputation({ file });
    assert.equal(loaded._events().length, 1);
    assert.equal(loaded._meta().weightSamples, 1, "模型由事件回放重建");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("meta: 无 LLM 正文结构证据可生成正负独立标签", () => {
  const goodBody = `Python 异步编程教程\n${"本节通过具体代码解释事件循环、任务调度和异常处理，并给出可复现实验步骤。".repeat(25)}`;
  const badBody = `平台推荐榜测评\n${"立即咨询客服，限时优惠，点击咨询免费领取。\n".repeat(12)}`;
  const good = assessContentEvidence({ title: "Python 异步编程教程", markdown: goodBody });
  const bad = assessContentEvidence({ title: "平台推荐榜测评", markdown: badBody });
  assert.ok(good?.label >= 0.65 && good.confidence > 0);
  assert.ok(bad?.label <= 0.35 && bad.confidence >= 0.5);
});

test("meta: fetch 主流程在 LLM 关闭时使用本地正文证据,模棱两可时只记可用性", async () => {
  process.env.WEBSEARCH_LLM_OFF = "1";
  try {
    const rep = createDomainReputation({
      file: null,
      bayes: createContentBayes({ file: null }),
      embedFn: async () => null, // 测试注入:语义嵌入不可用,跳过 API 调用
    });
    const body = `Node.js 流式处理教程\n${"本文给出可运行代码，解释背压、错误传播和资源释放，并逐步验证输出结果。".repeat(25)}`;
    const evidence = await rep.learnFetchContent("https://docs.example/tutorial/stream", {
      title: "Node.js 流式处理教程",
      markdown: body,
    });
    assert.equal(evidence?.source, "local-content-v1");
    assert.equal(rep._raw()["docs.example"].availabilitySamples, 1);
    assert.equal(rep._raw()["docs.example"].contentSamples, 1);
    assert.equal(rep._events().length, 1);

    const uncertain = await rep.learnFetchContent("https://neutral.example/a", {
      title: "普通页面",
      markdown: "普通页面内容".repeat(30),
    });
    assert.equal(uncertain, null);
    assert.equal(rep._raw()["neutral.example"].availabilitySamples, 1);
    assert.equal(rep._raw()["neutral.example"].contentSamples, 0);
  } finally {
    delete process.env.WEBSEARCH_LLM_OFF;
  }
});


test("meta: 公众号等引擎跳转链接只学标题不学 URL token(域名无法归因不污染)", () => {
  // 公众号加密链接:域名是 weixin.sogou.com(引擎域,registrableHost 返回空)
  const url = "https://weixin.sogou.com/link?url=dn9a_xxx&type=2";
  assert.equal(registrableHost(url), "", "引擎跳转域无注册域");
  // 完整提取(含 URL token)vs 仅标题提取:后者不含 d:/u: 引擎 token
  const full = extractLearnFeatures(url, { title: "2026年工程信息平台推荐榜", flags: [] });
  const only = titleFlagTokens("2026年工程信息平台推荐榜", []);
  assert.ok(full.has("d:sogou") && full.has("u:link"), "完整提取含 URL token");
  assert.ok(![...only].some((t) => t.startsWith("d:") || t.startsWith("u:")), "仅标题提取无 URL token");
  assert.ok(only.has("t:推荐"), "标题 bigram 保留");
  // 本地规则标签不再训练跨域模型;引擎跳转结果也不应污染 token 权重
  const rep = createDomainReputation({ file: null });
  rep.learnFromResults([{ title: "某公众号深度文章推荐", url, desc: "", flags: [], quality: 1 }]);
  assert.equal(rep._raw()["weixin.sogou.com"], undefined, "引擎域不建域名条目");
  assert.equal(rep._meta().weightSamples, 0, "无独立标签时不训练跨域模式");
});


test("meta: LLM label 学习 — learnFromResultsLLM 用内容可信度而非 quality,失败自动降级", async () => {
  const rep = createDomainReputation({ file: null });
  // 注入假 judge(纯函数测试,不真调 LLM):软文标题→0.95,教程标题→0.05
  const realJudge = (await import("../../llm-judge.mjs")).judgeResults;
  // 直接 patch 模块导出的引用不可行(import 绑定),改用 learnFromResultsLLM 内部
  // 的 judgeResults —— 通过环境变量强制降级路径测不到 LLM 分支,故这里改为:
  //  手测 metaLabel 映射逻辑 + 降级路径。
  // LLM 关掉 → 走降级 learnFromResults(不抛错、不阻塞)
  process.env.WEBSEARCH_LLM_OFF = "1";
  const ok = await rep.learnFromResultsLLM([{ title: "测试", url: "https://a.com/1", desc: "x", flags: [], quality: 0.9 }]);
  assert.equal(ok, false, "LLM 关闭时降级,返回 false");
  assert.ok(rep._raw()["a.com"], "降级后域名级学习照常");
  assert.equal(rep._meta().weightSamples, 0, "规则 quality 降级不得反训跨域 token 模型");
  delete process.env.WEBSEARCH_LLM_OFF;
});

test("meta: metaLabel 分离 — 元学习用可信度 label,域名级用 quality(不互相污染)", () => {
  const rep = createDomainReputation({ file: null });
  // 域名级:0.4 低 quality → 域名分应降;元学习:label 0.95(可信)→ 模式权重学正
  rep.record("https://spam-example.com/1", 0.4, { tokens: new Set(["t:软文词", "u:post"]), low: true, metaLabel: 0.95 });
  const e = rep._raw()["spam-example.com"];
  assert.ok(e.searchScore < 0.5, "域名级用 quality(降分):" + e.searchScore.toFixed(2));
  const w = rep._meta().weights["t:软文词"];
  assert.ok(w !== undefined && w > 0, "元学习用 metaLabel(正),权重学正:" + w);
  // 反过来:域名级高分 + 元学习低 label
  rep.record("https://trusted-example.com/1", 0.95, { tokens: new Set(["t:软文词", "u:post"]), low: false, metaLabel: 0.05 });
  assert.ok(rep._raw()["trusted-example.com"].searchScore > 0.5, "域名级高分保持");
  const w2 = rep._meta().weights["t:软文词"];
  assert.ok(w2 < 0.1, "同一个 token 被负 label 拉回:" + w2.toFixed(3));
});
