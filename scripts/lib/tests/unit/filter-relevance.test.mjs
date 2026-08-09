// filter.mjs(广告/垃圾剔除) + relevance.mjs(分级/折叠) + 端到端
import { test } from "node:test";
import assert from "node:assert/strict";
import { filterResults, detectFlags, scoreQuality, isAdResult, hasAdMarker, isIndexPageLike } from "../../filter.mjs";
import { computeRelThresholds, gradeCluster, irrelevantReason, collapsedBrief, collapsedMarkdown, buildPresentation } from "../../relevance.mjs";
import { clusterResults } from "../../cluster.mjs";
import { loadFixture } from "./helpers.mjs";


test("filter: 引擎 SERP 广告标记(isAd)硬剔除", () => {
  const { kept, ads, flagged } = filterResults([
    { title: "某某产品官网", url: "https://shop.example.com/a", desc: "详情", isAd: true },
    { title: "正常新闻页", url: "https://news.cn/1", desc: "这是一条正常新闻内容,有完整信息" },
  ]);
  assert.equal(ads.length, 1, "isAd 标记应硬剔除");
  assert.equal(kept.length, 1);
  assert.equal(flagged.length, 0);
});


test("filter: 标题【广告】强标记 + 广告域名 + 跳转 URL 硬剔除", () => {
  const { kept, ads } = filterResults([
    { title: "【广告】限时特惠活动", url: "https://x.com/1" },
    { title: "品牌推广方案", url: "https://www.doubleclick.net/ads/1" },
    { title: "阅读更多", url: "https://x.com/redirect?url=https://evil.com" },
    { title: "正常文章", url: "https://blog.com/p/1", desc: "这是一篇正常的技术文章,内容完整" },
  ]);
  assert.equal(ads.length, 3, "广告标记/域名/跳转 URL 三类硬证据");
  assert.equal(kept.length, 1);
  assert.equal(kept[0].title, "正常文章");
});


test("filter: 广告标记否定排除(无广告/没有广告不误报)", () => {
  assert.ok(!detectFlags({ title: "Proton VPN", url: "https://protonvpn.com/", desc: "免费版无限流量,无广告,严格无日志" }).includes("low:desc-marker"), "无广告不应触发");
  assert.ok(detectFlags({ title: "Proton VPN", url: "https://protonvpn.com/", desc: "广告位招商,价格优惠" }).includes("low:desc-marker"), "广告位招商应触发");
});


test("filter: 列表页/栏目页降权(low:index-page),真文章不误判", () => {
  // 栏目页:短路径无文章 id + 短标题 + 无实质摘要 → 降权
  const idx = detectFlags({ title: "今日动态 - 生物通", url: "https://www.ebiotrade.com/newsf/", desc: "" });
  assert.ok(idx.includes("low:index-page"), "栏目页应标记 low:index-page");
  assert.ok(scoreQuality({ title: "今日动态 - 生物通", url: "https://www.ebiotrade.com/newsf/", desc: "" }) < 0.6, "栏目页应强降权");
  // 首页
  assert.ok(isIndexPageLike("https://portal.com/", "某门户首页", ""));
  // 真文章(含文章 id + 完整摘要)→ 不误判
  const art = detectFlags({ title: "虚拟细胞大赛夺冠方案深度分析", url: "https://blog.com/p/12345", desc: "本文从数据、模型、训练三个维度完整复盘夺冠方案,并给出可复现的代码细节与调参经验,篇幅较长内容完整。" });
  assert.ok(!art.includes("low:index-page"), "含文章 id 的真文章不应误判");
  const rmrb = detectFlags({ title: "人民日报电子版", url: "http://paper.people.com.cn/rmrb/", desc: "人民日报数字报,包含今日所有版面" });
  assert.ok(!rmrb.includes("low:index-page"), "有实质摘要的栏目入口不误判");
  assert.equal(scoreQuality({ title: "虚拟细胞大赛夺冠方案深度分析", url: "https://blog.com/p/12345", desc: "本文从数据、模型、训练三个维度完整复盘夺冠方案,并给出可复现的代码细节与调参经验,篇幅较长内容完整。" }), 1);
});


test("filter: 垃圾文案组合降权不剔除(quality<1),正常结果 quality=1", () => {
  const { kept, flagged } = filterResults([
    { title: "免费VPN下载中心", url: "https://vpn.example.com/download", desc: "立即下载客户端,马上注册领取优惠" },
    { title: "Python 爬虫教程", url: "https://blog.com/py", desc: "本文介绍 Python 爬虫的完整入门流程与代码示例" },
  ]);
  assert.equal(flagged.length, 1, "垃圾组合应标记");
  assert.equal(kept.length, 2, "软信号不剔除");
  const junk = kept.find((r) => /vpn/.test(r.url));
  assert.ok(junk.quality < 1, `垃圾页 quality 应 <1,实际 ${junk.quality}`);
  assert.ok(junk.flags.includes("low:spam-desc"));
  const clean = kept.find((r) => /blog/.test(r.url));
  assert.equal(clean.quality, 1);
  assert.equal(clean.flags.length, 0);
  assert.ok(scoreQuality({ title: "正常新闻标题", url: "https://a.com", desc: "这是一篇完整的技术文章内容介绍" }) === 1);
});


test("filter: 广告不影响正常新闻/文档(高精度,不误杀)", () => {
  const normal = [
    { title: "国务院新闻办公室发布会", url: "https://www.gov.cn/xinwen/1.htm", desc: "介绍了最新的政策措施与实施情况" },
    { title: "Wikipedia - Web scraping", url: "https://en.wikipedia.org/wiki/Web_scraping", desc: "Web scraping is the process of automatically extracting data from websites." },
    { title: "人民日报电子版", url: "http://paper.people.com.cn/rmrb/", desc: "人民日报数字报,包含今日所有版面" },
  ];
  const { ads, flagged } = filterResults(normal);
  assert.equal(ads.length, 0, "正常结果不应被剔除");
  assert.equal(flagged.length, 0, "正常结果不应被降权");
});

// ==================== 语义聚类(cluster.mjs 双模式) ====================

/** 构造一维语义向量(便于手写断言):同一主题向量接近,不同主题远离 */
const V = (x) => [x];


test("relevance分级: 阈值自适应(高 top 按比例,低 top 绝对下限兜底)", () => {
  // 高 top:相关分界 = max(0.5, 0.59×0.6)=0.5;无关分界 = max(0.25, 0.59×0.4)=0.25
  const t1 = computeRelThresholds([0.59, 0.36, 0.32]);
  assert.ok(Math.abs(t1.edge - 0.5) < 1e-9, `高 top 时 edge=max(0.5, 比例)(实际 ${t1.edge})`);
  assert.ok(Math.abs(t1.irrelevant - 0.25) < 1e-9, `高 top 时 irrelevant=max(0.25, 比例)(实际 ${t1.irrelevant})`);
  // 低 top(全部低相关,如查询过泛):比例失效,绝对下限兜底,避免把垃圾当相关
  const t2 = computeRelThresholds([0.2, 0.15, 0.1]);
  assert.equal(t2.edge, 0.5, "低 top 时 edge 回落到绝对下限 0.5");
  assert.equal(t2.irrelevant, 0.25, "低 top 时 irrelevant 回落到绝对下限 0.25");
  // 空数组:不抛错,全 0
  const t3 = computeRelThresholds([]);
  assert.equal(t3.top, 0);
  // 自定义阈值(模式配置可注入)
  const t4 = computeRelThresholds([0.8], { relevantMin: 0.4, relevantRatio: 0.5, irrelevantMin: 0.2, irrelevantRatio: 0.3 });
  assert.ok(Math.abs(t4.edge - 0.4) < 1e-9, "自定义参数生效");
  assert.ok(Math.abs(t4.irrelevant - 0.24) < 1e-9, "自定义比例生效(0.8×0.3=0.24)");
});


test("relevance分级: gradeCluster 三档映射 + unscored 回退", () => {
  const t = computeRelThresholds([0.59, 0.36, 0.32]); // edge=0.5, irrelevant=0.25
  assert.equal(gradeCluster(0.59, t), "relevant");
  assert.equal(gradeCluster(0.5, t), "relevant", "等于 edge 线也算相关");
  assert.equal(gradeCluster(0.36, t), "edge", "边缘区:标题+URL,不给摘要");
  assert.equal(gradeCluster(0.25, t), "edge", "等于 irrelevant 线仍算边缘(不在无关区)");
  assert.equal(gradeCluster(0.24, t), "irrelevant", "低于无关线 → 折叠区");
  assert.equal(gradeCluster(null, t), "unscored", "无嵌入 → unscored,调用方走原逻辑");
  assert.equal(gradeCluster(undefined, t), "unscored");
});


test("relevance分级: irrelevantReason 数据驱动原因(非域名黑名单)", () => {
  // 文本命中(textScore 高)但语义分低 → 表面匹配
  const r1 = irrelevantReason({ semScore: 0.2, textScore: 0.7 }, { textHit: 0.5 });
  assert.match(r1, /含查询词但语义无关/, "应提示表面匹配");
  // 文本也未命中 → 无关联
  const r2 = irrelevantReason({ semScore: 0.2, textScore: 0.1 }, { textHit: 0.5 });
  assert.match(r2, /无明显语义关联/, "应提示无关联");
  // 语义分缺失时不崩
  const r3 = irrelevantReason({ textScore: 0.1 });
  assert.ok(typeof r3 === "string" && r3.length > 0);
});


test("cluster+relevance 端到端: 词典簇分到边缘/无关区,正常簇完整", () => {
  const results = [
    { title: "Top AI learning agents tools", url: "good1" },
    { title: "How AI agents learn knowledge", url: "good2" },
    { title: "best 是什么意思 best 的翻译 音标 读音", url: "dict" },
  ];
  const qVec = [1, 0, 0, 0];
  const vectors = [[1, 0.1, 0, 0], [1, -0.1, 0, 0], [0.05, 1, 0, 0]];
  const { clusters } = clusterResults(results, "best AI agents for learning", { vectors, queryVec: qVec });
  const t = computeRelThresholds(clusters.map((c) => c.semScore));
  const grades = clusters.map((c) => ({ label: c.label, grade: gradeCluster(c.semScore, t), semScore: c.semScore }));
  const good = grades.find((g) => g.grade === "relevant");
  const low = grades.find((g) => g.grade !== "relevant" && g.grade !== "unscored");
  assert.ok(good, "正常簇应 relevant");
  assert.ok(low, "词典簇应被分到边缘/无关区");
  assert.ok(low.semScore < good.semScore, "词典簇语义分应低于正常簇");
});


test("relevance折叠: collapsedBrief 一行摘要含簇名×条数+语义分", () => {
  const brief = collapsedBrief([
    { label: "best 是什么意思", size: 9, semScore: 0.36 },
    { label: "BEST 装置", size: 1, semScore: 0.32 },
  ]);
  assert.match(brief, /best 是什么意思.*×9.*0\.36/s, "含簇名×条数+语义分");
  assert.match(brief, /BEST 装置.*×1.*0\.32/s, "多簇以分隔符连接");
  // 无语义分(无嵌入场景)不崩
  const b2 = collapsedBrief([{ label: "x", size: 2 }]);
  assert.match(b2, /\[x\]×2/, "无语义分仍输出簇名×条数");
});


test("relevance折叠: collapsedMarkdown 详情含原因/标题/URL,供 reveal 或直接读取", () => {
  const md = collapsedMarkdown(
    [{ label: "best 是什么意思", size: 2, semScore: 0.36, textScore: 0.7, items: [{ title: "爱词霸", url: "https://www.iciba.com/word?w=best" }, { title: "剑桥词典", url: "https://dictionary.cambridge.org/" }] }],
    "best AI agents for learning",
    { textHit: 0.5 }
  );
  assert.match(md, /查询: best AI agents for learning/, "文件头标注来源查询");
  assert.match(md, /\[best 是什么意思\] ×2 · 语义 0\.36/, "簇头含名×数+语义分");
  assert.match(md, /含查询词但语义无关/, "文本命中但语义无关 → 数据驱动原因");
  assert.match(md, /爱词霸/, "条目标题");
  assert.match(md, /https:\/\/www\.iciba\.com/, "条目 URL(信息不丢)");
  // 空折叠不崩
  assert.equal(collapsedMarkdown([], "q"), "# 低相关折叠(查询: q)\n");
});


test("relevance决策: buildPresentation 折叠/展示分流(默认读 config,零传参)", () => {
  const clusters = [
    { label: "Launch HN", size: 5, semScore: 0.59, score: 0.44 },
    { label: "best 是什么意思", size: 9, semScore: 0.36, score: 0.37 },
    { label: "BEST 装置", size: 1, semScore: 0.32, score: 0.33 },
  ];
  // 默认 balanced:相关簇 shown,其余折叠(无需 cli 传阈值参数)
  const p = buildPresentation(clusters);
  assert.deepEqual(p.shown.map((c) => c.label), ["Launch HN"], "相关簇进 shown");
  assert.deepEqual(p.collapsed.map((c) => c.label).sort(), ["BEST 装置", "best 是什么意思"].sort(), "边缘+无关全折叠");
  assert.ok(p.thresholds && p.thresholds.edge >= 0.5, "阈值已计算(自适应,读 config 默认)");
  // conservative:只排序不折叠,全进 shown
  const pc = buildPresentation(clusters, { relMode: "conservative" });
  assert.equal(pc.collapsed.length, 0, "conservative 不折叠");
  assert.equal(pc.shown.length, 3, "conservative 全展开");
  // 无语义分(嵌入不可用):thresholds=null,全进 shown(零回归)
  const pn = buildPresentation([{ label: "x", size: 1, semScore: null }]);
  assert.equal(pn.thresholds, null);
  assert.equal(pn.collapsed.length, 0, "无嵌入不折叠");
  assert.equal(pn.shown.length, 1);
});


test("relevance决策: 语义模式低相关单例簇(=聚类漏判的低相关单条)同样被折叠", () => {
  // 三条:两条同主题成簇,一条语义无关离群点(语义模式下自成单例簇)
  const results = [
    { title: "Python 爬虫入门教程", url: "a" },
    { title: "Python 爬虫超详细讲解", url: "b" },
    { title: "黄历 万年历 老黄历", url: "c" },
  ];
  const qVec = [1, 0, 0, 0];
  const vectors = [[1, 0, 0, 0], [0.9, 0.1, 0, 0], [0, 1, 0, 0]];
  const { clusters } = clusterResults(results, "python 爬虫", { vectors, queryVec: qVec });
  const p = buildPresentation(clusters);
  const folded = p.collapsed.map((c) => c.size).reduce((s, n) => s + n, 0);
  assert.equal(folded, 1, "离群低相关单例簇被折叠(与正常簇体系一致)");
  assert.ok(p.shown.some((c) => c.size >= 2), "同主题簇完整展示");
  // 无 queryVec:不折叠(零回归)
  const { clusters: c2 } = clusterResults(results, "python 爬虫");
  const p2 = buildPresentation(c2);
  assert.equal(p2.collapsed.length, 0, "无嵌入不折叠");
});


test("filter+cluster 端到端: 广告剔除后聚类只处理有效结果", () => {
  const raw = [
    { title: "【广告】Python 培训班限时优惠", url: "https://edu.example.com/ad/1", isAd: true },
    { title: "Python爬虫入门教程", url: "https://blog.com/py1", desc: "零基础入门" },
    { title: "Python 爬虫超详细讲解", url: "https://blog.com/py2", desc: "实战详解" },
    { title: "今日黄历查询", url: "https://huangli.com/", desc: "老黄历宜忌" },
  ];
  const { kept, ads } = filterResults(raw);
  assert.equal(ads.length, 1);
  const { clusters, uncovered } = clusterResults(kept, "python 爬虫");
  const py = clusters.find((c) => /python|爬虫/i.test(c.label));
  assert.equal(py.size, 2, "广告剔除后爬虫 2 条聚一簇");
  assert.ok(!py.items.some((x) => x.isAd || /广告/.test(x.title)), "簇内无广告残留");
});

// ==================== aggregateSearch 集成测试(核心聚合逻辑, mock 引擎不请求网络) ====================

/** mock 引擎工厂:统计调用次数,可配 blocked/zhOnly/enOnly/pageLimit */

// ==================== 时间意图 + 旧文沉底 + --since 硬过滤 ====================
import { hasTimeIntent, applyRecencyOrder, applySinceFilter, parseSince } from "../../filter.mjs";

test("hasTimeIntent: 新闻意图词(大事件/突发/进展/要闻)启用旧文沉底", () => {
  for (const q of ["国内外大事件", "突发新闻", "中美关系最新进展", "本周要闻", "今日大事", "近期动态"]) {
    assert.ok(hasTimeIntent(q), `应识别时间意图: ${q}`);
  }
});

test("hasTimeIntent: 历史意图查询不误启用(旧文是正确答案)", () => {
  for (const q of ["1927年大事件", "建党百年大事记", "历史大事件", "纪念改革开放40周年", "那年大事"]) {
    assert.equal(hasTimeIntent(q), false, `历史查询不应启用沉底: ${q}`);
  }
});

test("applyRecencyOrder: 时间意图查询下旧文沉底并标记 low:stale", () => {
  const results = [
    { title: "新文", url: "https://a.com/1", date: "2026-08-01" },
    { title: "旧文", url: "https://b.com/2", date: "2019-05-01" },
    { title: "无日期", url: "https://c.com/3" },
  ];
  const ordered = applyRecencyOrder(results, "国内外大事件");
  assert.equal(ordered[0].title, "新文", "新文保持在前");
  assert.equal(ordered[2].title, "旧文", "旧文沉底");
  const old = ordered.find((r) => r.title === "旧文");
  assert.ok(old.flags.includes("low:stale"), "旧文标记 low:stale");
  assert.ok(old.staleDays > 60, "记录距今天数");
});

test("applyRecencyOrder: 无时间意图查询原样返回(零开销)", () => {
  const results = [{ title: "A", url: "https://a.com/1", date: "2019-05-01" }];
  assert.equal(applyRecencyOrder(results, "python 教程"), results, "无意图不重排");
});

test("parseSince + applySinceFilter: --since 1w 剔除超窗旧文,无日期保留", () => {
  const threshold = parseSince("1w");
  assert.ok(threshold, "1w 应解析出阈值");
  const results = [
    { title: "本周", url: "https://a.com/1", date: "2026-08-07" },
    { title: "上周", url: "https://a.com/2", date: "2026-07-01" },
    { title: "无日期", url: "https://c.com/3" },
    { title: "相对时间", url: "https://d.com/4", date: "3小时前" },
  ];
  const { kept, dropped } = applySinceFilter(results, "1w");
  assert.equal(dropped.length, 1, "仅超窗且带日期的剔除");
  assert.equal(dropped[0].title, "上周");
  assert.ok(kept.some((r) => r.title === "无日期"), "无日期保守保留");
  assert.ok(kept.some((r) => r.title === "相对时间"), "相对时间(近日)保留");
});

test("applySinceFilter: 非法 since 参数原样返回(不误杀)", () => {
  const results = [{ title: "A", url: "https://a.com/1", date: "2019-05-01" }];
  const { kept, dropped } = applySinceFilter(results, "bogus");
  assert.equal(kept.length, 1);
  assert.equal(dropped.length, 0);
});
