// cluster.mjs —— 短语模式聚类 + 语义聚类(向量) + 转载折叠 + 回归
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clusterResults, queryTokens, titleTokens, tokenJaccard, cnGrams, enWords,
  cosine, readableClusterLabel, cleanTitleForLabel, longestCommonSpan, distinctiveSpan,
} from "../../cluster.mjs";
import { loadFixture, clusterFromFixture } from "./helpers.mjs";

// ---- 顶层 fixture 常量(原 tests.mjs 定义,cluster 测试共享) ----

const CLUSTER_MIXED = [
  { title: "中国新闻_央视网", url: "https://news.cctv.com/china/" },
  { title: "人民网_网上的人民日报", url: "https://www.people.com.cn/" },
  { title: "腾讯网-要闻", url: "https://news.qq.com/" },
  { title: "Python爬虫史上超详细讲解(零基础入门)", url: "https://blog.csdn.net/1" },
  { title: "一篇最全 Python 爬虫超详细讲解", url: "https://blog.csdn.net/2" },
  { title: "Python 爬虫入门详细教程(含实例)", url: "https://zhuanlan.zhihu.com/p/1" },
  { title: "今日黄历查询_老黄历查询_万年历老黄历查询", url: "https://www.huangli123.net/" },
  { title: "今日黄历宜忌查询,今日老黄历", url: "https://m.tthuangli.com/" },
];

const V = (x) => [x];

test("cluster: 三主题混合结果正确聚类,查询相关簇排前", () => {
  const { clusters, uncovered, phrases } = clusterResults(CLUSTER_MIXED, "python 爬虫 教程");
  assert.ok(clusters.length >= 2, `应有 ≥2 簇,实际 ${clusters.length}`);
  const first = clusters[0];
  assert.ok(/python|爬虫/.test(first.label), `相关簇标签应为爬虫类,实际 \"${first.label}\"`);
  assert.ok(first.score >= 0.5, `相关簇分数应高,实际 ${first.score}`);
  assert.equal(first.size, 3, "爬虫教程 3 条应聚一簇");
  const hl = clusters.find((c) => c.label.includes("黄历"));
  assert.ok(hl, "黄历簇应存在");
  assert.equal(hl.size, 2);
  assert.ok(hl.score < 0.25, `与查询无关的簇分数应很低(仅排名信号兜底),实际 ${hl.score}`);
  assert.equal(uncovered.length, 3, "新闻门户 3 条无共享短语 → uncovered");
  assert.ok(phrases.some((p) => p.phrase === "爬虫" && p.df === 3), "显著短语含 爬虫(df=3)");
});


test("cluster: 换查询词时相关性排序随之变化(黄历查询 → 黄历簇第一)", () => {
  const { clusters } = clusterResults(CLUSTER_MIXED, "今日黄历 查询 宜忌");
  assert.ok(/黄历/.test(clusters[0].label), `黄历查询时黄历簇应排第一,实际 \"${clusters[0].label}\"`);
  assert.ok(clusters[0].score >= 0.5);
});


test("cluster: 无关结果不强行归簇(全 uncovered 或仅少数簇)", () => {
  const unrelated = [
    { title: "量子计算原理", url: "https://a.com/1" },
    { title: "咖啡豆烘焙技巧", url: "https://b.com/2" },
    { title: "自行车保养手册", url: "https://c.com/3" },
    { title: "猫咪行为解读", url: "https://d.com/4" },
    { title: "深海鱼类图鉴", url: "https://e.com/5" },
  ];
  const { clusters, uncovered } = clusterResults(unrelated, "xyz");
  assert.ok(clusters.length === 0 || uncovered.length >= 4, `无共享短语不应强行聚类: ${clusters.length} 簇/${uncovered.length} uncovered`);
});


test("cluster: 纯函数 tokenJaccard/cnGrams/enWords", () => {
  assert.ok(cnGrams("习近平建军节祝贺", 2).has("建军"), "中文 2-gram 提取");
  assert.ok(!cnGrams("Python爬虫", 2).has("py"), "中英混合只取中文 gram");
  assert.ok(enWords("Python web scraping tutorial").includes("scraping"), "英文词提取(小写)");
  assert.ok(!enWords("the and for").length, "英文停用词剔除");
  const a = new Set(["x", "y"]);
  const b = new Set(["y", "z"]);
  assert.equal(tokenJaccard(a, b), 1 / 3, "Jaccard: 交集1/并集3");
});


test("cluster: 可读标签 —— 最长公共子串代替破碎 n-gram", () => {
  assert.equal(
    longestCommonSpan("计算机专业学习路线:从新手到专家", "计算机专业学习路线图:大一大二打基础"),
    "计算机专业学习路线", "LCS 应返回共享连续短语");
  const titles = [
    "计算机专业学习路线:从新手到专家_计算机学习路线",
    "计算机专业学习路线图:大一大二打基础,大三大四定方向",
    "计算机专业超详细学习路线(零基础)",
  ];
  const label = readableClusterLabel(titles, new Map(), []);
  assert.equal(label, "计算机专业学习路线", `应取共享连续短语而非 n-gram 碎片,实际 \"${label}\"`);
  // 可读性性质:标签必为某原始标题的连续子串(修复前"计算机基/习路线自"不满足)
  assert.ok(titles.some((t) => t.includes(label)), "标签应为某标题的连续子串");
});


test("cluster: 英文标签不跨句子级标点(Welcome, Cot: the → Welcome)", () => {
  const label = readableClusterLabel(
    ["Welcome, Cot: the complete guide to web frameworks", "Welcome, Cot: the 2026 edition for beginners"],
    new Map(), []
  );
  assert.equal(label, "Welcome", `英文标签应切段取最长段,实际 \"${label}\"`);
  // 带括号的合理短语不应被切(括号不是句子级标点)
  const paren = readableClusterLabel(["Apple (中国大陆) - 官方网站", "iPhone - Apple (中国大陆)"], new Map(), []);
  assert.ok(/apple/i.test(paren), `括号内短语应保留,实际 \"${paren}\"`);
});


test("cluster: 可读标签 —— 站点样板不劫持 LCS(苹果簇标签仍是 苹果)", () => {
  assert.equal(cleanTitleForLabel("苹果公司_百度百科"), "苹果公司", "剥站点样板");
  assert.equal(cleanTitleForLabel("Apple (中国大陆) - 官方网站"), "Apple (中国大陆)", "剥官方站样板");
  const label = readableClusterLabel(
    ["苹果公司_百度百科", "苹果（蔷薇科苹果属植物）_百度百科", "爱思助手官网-安全好用的苹果设备管理软件", "市值破5万亿美元、创史上最强Q3:库克给苹果“光明的未来”"],
    new Map(), []
  );
  assert.equal(label, "苹果", `样板后缀不应成为标签,实际 \"${label}\"`);
});


test("cluster: 簇内差异标注为连续片段而非破碎 n-gram", () => {
  assert.equal(
    distinctiveSpan("计算机专业学习路线:从新手到专家", ["计算机专业学习路线图:大一大二打基础"], "计算机专业学习路线"),
    "从新手到专家", "独有片段应为完整短语");
  const { clusters } = clusterResults([
    { title: "计算机专业学习路线:从新手到专家", url: "a" },
    { title: "计算机专业学习路线图:大一大二打基础", url: "b" },
    { title: "计算机专业超详细学习路线(零基础)", url: "c" },
  ], "计算机 学习路线");
  const c = clusters[0];
  assert.ok(c.variants.length >= 1, "簇内应有差异标注");
  const all = c.items.map((x) => x.title);
  for (const v of c.variants) {
    assert.ok(all.some((t) => t.includes(v)), `variant \"${v}\" 应为某标题的连续子串(修复前是跨词 n-gram)`);
  }
});

// ==================== 真实搜索结果聚类回归(缺陷修复验证) ====================



test("cluster回归: 搜「苹果」时英文 Apple 官网簇不再归零(A 修复)", () => {
  const { clusters } = clusterFromFixture("bing-apple", "苹果", 10);
  const apple = clusters.find((c) => /apple/i.test(c.label));
  const zh = clusters.find((c) => c.label === "苹果");
  assert.ok(zh, "中文苹果簇存在");
  assert.ok(apple, "英文 apple 簇存在");
  assert.ok(apple.score > 0, `apple 簇分数应 >0(修复前为 0),实际 ${apple.score}`);
  assert.ok(zh.score >= apple.score, `中文簇仍应排前: ${zh.score} vs ${apple.score}`);
});


test("cluster回归: 多义「苹果」簇带簇内差异标注", () => {
  const { clusters } = clusterFromFixture("bing-apple", "苹果", 10);
  const zh = clusters.find((c) => c.label === "苹果");
  assert.ok(zh && zh.variants && zh.variants.length >= 2, `簇内差异标注应有 ≥2 项,实际 ${zh?.variants?.length}`);
});


test("cluster回归: 单主题「iPhone」结果收敛为单簇", () => {
  const { clusters, uncovered } = clusterFromFixture("bing-iphone", "iPhone 17 发布 价格", 15);
  assert.ok(clusters.length >= 1);
  const total = clusters.reduce((s, c) => s + c.size, 0) + uncovered.length;
  const biggest = clusters.reduce((m, c) => Math.max(m, c.size), 0);
  // 相对断言:主簇应覆盖 ≥70% 结果(单主题查询收敛;fixture 重抓后结果数会漂移,绝对阈值易碎)
  assert.ok(biggest / total >= 0.7, `主簇应覆盖 ≥70% 结果,实际 ${biggest}/${total}`);
  assert.ok(uncovered.length <= 3, `uncovered 应 ≤3,实际 ${uncovered.length}`);
});


test("cluster回归: 无词典词「特斯拉」英文官网簇靠排名信号兜底不归零", () => {
  const { clusters } = clusterFromFixture("bing-tesla", "特斯拉", 15);
  const tesla = clusters.find((c) => /tesla/i.test(c.label));
  assert.ok(tesla, "英文 tesla 簇存在");
  // 覆盖率加权后英文簇分数下降(0.5→~0.29),但>0不归零即设计目标(排名信号兜底)
  assert.ok(tesla.score >= 0.2, `英文簇分数应靠排名信号兜底(≥0.2),实际 ${tesla.score}`);
  const zh = clusters.find((c) => c.label === "特斯拉");
  assert.ok(zh && zh.score > tesla.score, `中文簇仍应排前: ${zh?.score} vs ${tesla.score}`);
});


test("cluster: titleTokens 注入停用词表生效 + 泛词组合 gram 被滤(B 修复)", () => {
  // 注入词表生效(修复前: 硬编码 ZH_STOP,注入无效)
  const t1 = titleTokens("深度解读量子纠缠理论", new Set(["深度", "解读"]));
  assert.ok(!t1.includes("c:深度") && !t1.includes("c:解读"), "注入的 2 字停用词应滤除");
  // 泛词组合 3/4-gram 也被滤(修复前: 只滤 2 字精确词,深度解读/解读量子逃过 → 噪音簇)
  assert.ok(!t1.includes("c:深度解读") && !t1.includes("c:解读量子"), "泛词组合 gram 应滤除");
  assert.ok(!t1.includes("c:深度解") && !t1.includes("c:解读量"), "以停用词开头的 3-gram 应滤除");
  assert.ok(t1.includes("c:量子") && t1.includes("c:纠缠"), "实词 gram 不受影响");
});


test("cluster: 大簇仅少量相关时相关度不再虚高(覆盖率加权, C 修复)", () => {
  // 8 条都含“苹果”,但只有 1 条含查询词“手机”:修复前 textScore=1 → score≈0.83 虚高
  const r = [
    { title: "苹果 iPhone 发布", url: "a1" },
    { title: "苹果公司股价", url: "a2" },
    { title: "水果价格行情", url: "b1" },
    { title: "果园种植技术", url: "b2" },
    { title: "苹果醋食谱", url: "b3" },
    { title: "苹果汁营养", url: "b4" },
    { title: "苹果派做法", url: "b5" },
    { title: "苹果酱制作", url: "b6" },
    { title: "苹果手机评测", url: "b7" },
    { title: "苹果手表", url: "b8" },
  ];
  const { clusters } = clusterResults(r, "苹果 手机");
  const c = clusters.find((x) => /苹果/.test(x.label));
  assert.ok(c, "苹果簇存在");
  assert.ok(c.score < 0.7, `8 条仅 1 条含查询词 → 分数应受覆盖率抑制(<0.7),实际 ${c.score}`);
  // 对照:全部命中查询词时分数仍高
  const full = clusterResults(
    [{ title: "苹果手机发布会", url: "x1" }, { title: "苹果手机评测", url: "x2" }, { title: "苹果手机价格", url: "x3" }],
    "苹果 手机"
  );
  assert.ok(full.clusters[0].score > 0.7, `全命中簇分数应高,实际 ${full.clusters[0].score}`);
});


test("cluster: 相关度分数封顶 1.0(别名命中不再溢出, C 修复)", () => {
  const r = [
    { title: "苹果 Apple 官网 - iPhone", url: "a" },
    { title: "苹果 水果", url: "b" },
  ];
  const { clusters } = clusterResults(r, "苹果");
  for (const c of clusters) assert.ok(c.score <= 1.001, `分数应 ≤1,实际 ${c.label}=${c.score}`);
});


test("cluster复用: 无 url 字段的结果也能聚类(url 非依赖键)", () => {
  const noUrl = [
    { title: "Python爬虫入门教程", desc: "零基础" },
    { title: "Python 爬虫超详细讲解", desc: "实战" },
    { title: "今日黄历查询宜忌", desc: "老黄历" },
    { title: "老黄历今日查询", desc: "万年历" },
  ];
  const { clusters, uncovered } = clusterResults(noUrl, "python 爬虫");
  assert.equal(uncovered.length, 0, "4 条都有共享短语,应全部归簇(无 url 时按位置去重,不因缺 url 字段清空)");
  assert.equal(clusters.length, 2, "爬虫簇 + 黄历簇");
  assert.equal(clusters.filter((c) => /python|爬虫/i.test(c.label)).length, 1, "爬虫簇存在");
});


test("cluster复用: options 可注入停用词表/合并阈值", () => {
  const r = [
    { title: "深度解读量子纠缠理论", url: "a" },
    { title: "量子纠缠实验新进展", url: "b" },
    { title: "股市深度解读今日行情", url: "c" },
    { title: "行情深度解读与投资策略", url: "d" },
  ];
  // 默认:无共享显著短语?「深度解读」在 c/d 有,a/b 无 → 2 簇
  const def = clusterResults(r, "量子");
  const withStop = clusterResults(r, "量子", { stopWords: new Set(["深度", "解读", "今日", "行情"]) });
  // 注入停用词后「深度解读」不再建簇 → 量子 2 条无共享 → 全 uncovered
  assert.ok(withStop.clusters.length <= def.clusters.length, "注入停用词不增加簇数");
});

// ==================== 缺陷修复回归(B1/B2/B3/B4) ====================
// 对应审查发现并修复的 bug,防止后续重构回退


test("cluster语义: 同主题收敛,离群点进 uncovered(噪声语义)", () => {
  const results = [
    { title: "Python 爬虫入门", url: "a" },
    { title: "Python 爬虫进阶", url: "b" },
    { title: "Python 爬虫实战", url: "c" },
    { title: "咖啡豆烘焙技巧", url: "d" },
  ];
  // 一维归一化向量:1D 下 cosine=1 或 -1,用 2 维构造区分度;相似度 0.8/0.84,低于折叠阈值 0.94
  const { clusters, uncovered } = clusterResults(results, "python 爬虫", {
    vectors: [[1, 0], [0.8, 0.6], [0.7, 0.714], [-1, 0]],
  });
  assert.ok(clusters.length >= 2, "应有爬虫簇 + 离群单例簇");
  const py = clusters.find((c) => /python|爬虫/i.test(c.label));
  assert.ok(py, "爬虫簇应存在");
  assert.equal(py.size, 3, "3 条爬虫结果应聚一簇");
  // 语义模式:离群点成为单例簇(噪声语义),不强行并入主簇
  const coffee = clusters.find((c) => c.size === 1 && /咖啡|烘焙/i.test(c.label));
  assert.ok(coffee, "离群点(咖啡)应独立为单例簇");
  assert.ok(coffee.score < py.score, "离群簇分数应低于主题簇");
});


test("cluster语义: 近似重复折叠计数(duplicates),不重复展示", () => {
  const results = [
    { title: "新华社通稿:某地新闻", url: "a" },
    { title: "新华社通稿:某地新闻(转载)", url: "b" },
    { title: "某地新闻详细报道", url: "c" },
    { title: "完全不相关内容", url: "d" },
  ];
  const { clusters } = clusterResults(results, "某地新闻", {
    vectors: [[1, 0], [0.999, 0.0447], [0.7, 0.714], [-1, 0]],
    dupThreshold: 0.99,
  });
  const main = clusters.find((c) => c.label.includes("某地"));
  assert.ok(main, "主簇存在");
  assert.equal(main.size, 2, "a/b 近似重复折叠后仅 2 条(标题与转载)");
  assert.equal(main.duplicates, 1, "重复计数应为 1");
});


test("cluster语义转载折叠: 换措辞转载(向量+文本证据)折叠,同主题不同文不误杀", () => {
  const aDesc = "新华社北京电 某地发生重大事件,相关部门已介入调查处理,后续进展将持续跟进报道";
  const results = [
    { title: "全球首届AI虚拟细胞大赛结果出炉,华人科学家横扫全场 - 搜狐", url: "a", desc: aDesc },
    // 换措辞转载:标题不同用词(横扫全场→包揽大奖),但正文首段同源(desc 高度重叠),向量 0.84
    { title: "虚拟细胞挑战赛落幕,中国科学家团队包揽大奖 - 新浪", url: "c", desc: "新华社北京电 某地发生重大事件,相关部门已介入调查处理,官方表示将及时公布进展" },
    // 同主题不同文:向量 0.8/0.3,标题摘要都不同 → 不折叠
    { title: "Arc虚拟细胞挑战赛:入门指南 - Hugging Face", url: "d", desc: "Arc Institute 推出 Virtual Cell Challenge,参赛者需训练模型预测基因沉默影响" },
    { title: "Cell:虚拟细胞挑战赛已开启,科研人不能错过的顶刊机会", url: "e", desc: "人工智能与组学技术革命带来新机遇,构建直接模拟细胞动态行为的模型" },
  ];
  const { clusters, uncovered } = clusterResults(results, "虚拟细胞大赛", {
    vectors: [[1, 0], [0.84, 0.543], [-0.2, 0.98], [0.3, 0.954]],
  });
  // 换措辞转载 c 折叠计数,不代表条展示;同主题不同文 d/e 完整保留
  assert.equal(clusters.reduce((s, c) => s + c.duplicates, 0), 1, "换措辞转载应折叠计数 1");
  const allShown = clusters.flatMap((c) => c.items.map((d) => d.url));
  assert.deepEqual([...allShown].sort(), ["a", "d", "e"], "a/d/e 保留,c 不重复展示");
  assert.equal(uncovered.length, 0);
});


test("cluster语义: 质量加权 —— 垃圾簇整体沉底(lowRelevance)", () => {
  const results = [
    { title: "免费VPN下载", url: "a", quality: 0.15, flags: ["low:spam-desc"] },
    { title: "VPN 优惠活动", url: "b", quality: 0.15, flags: ["low:spam-title"] },
    { title: "Python 爬虫教程", url: "c" },
    { title: "Python 爬虫实例", url: "d" },
  ];
  const { clusters } = clusterResults(results, "python 爬虫", {
    vectors: [[1, 0], [0.9, 0.436], [-1, 0], [-0.9, 0.436]],
  });
  const py = clusters.find((c) => /python|爬虫/i.test(c.label));
  const junk = clusters.find((c) => /vpn/i.test(c.label));
  assert.ok(py && junk, "两类簇都存在(软信号不剔除)");
  assert.ok(junk.quality < 0.5, `垃圾簇平均质量应低,实际 ${junk.quality}`);
  assert.ok(junk.score < py.score, "垃圾簇分数应低于主题簇(质量加权沉底)");
  assert.ok(py.quality === 1, "干净簇质量 = 1(质量因子无影响)");
});


test("cluster语义: 无 vectors 自动回退短语模式(与旧行为一致)", () => {
  const r = [
    { title: "Python爬虫入门教程", desc: "零基础" },
    { title: "Python 爬虫超详细讲解", desc: "实战" },
    { title: "今日黄历查询宜忌", desc: "老黄历" },
  ];
  const { clusters, uncovered } = clusterResults(r, "python 爬虫");
  assert.equal(uncovered.length, 1, "黄历 1 条无共享短语 → uncovered(爬虫 2 条聚簇)");
  assert.equal(clusters.length, 1, "短语模式:仅爬虫簇(黄历单条不建簇)");
});


test("cluster语义: 超大簇拆分为子主题簇(>maxClusterSize 触发)", () => {
  // 3 个子主题各 7 条(21 条):A=[1,0,0] B=[0.45,0.893,0] C=[0.45,0,0.893]
  // A↔B=A↔C=0.45(在拆分窗口 [simThreshold 0.42, intraThr 0.50) 内 → 主聚类合并、拆分拆开),
  // B↔C=0.20(< 主阈值,主聚类即独立)
  const results = [];
  const vecs = [];
  for (let i = 0; i < 7; i++) { results.push({ title: `虚拟细胞大赛结果报道${i}号`, url: `a${i}` }); vecs.push([1, 0, 0]); }
  for (let i = 0; i < 7; i++) { results.push({ title: `虚拟细胞大赛入门指南${i}号`, url: `b${i}` }); vecs.push([0.45, 0.893, 0]); }
  for (let i = 0; i < 7; i++) { results.push({ title: `虚拟细胞大赛融资新闻${i}号`, url: `c${i}` }); vecs.push([0.45, 0, 0.893]); }
  const { clusters } = clusterResults(results, "虚拟细胞大赛", { vectors: vecs, simThreshold: 0.42, dupThreshold: 1.01 });
  assert.ok(clusters.length >= 3, `21 条 3 子主题应拆成 ≥3 簇,实际 ${clusters.length}`);
  const biggest = clusters.reduce((m, c) => Math.max(m, c.size), 0);
  assert.ok(biggest <= 12, `最大簇应 ≤ maxClusterSize(12),实际 ${biggest}`);
  // A/B 主聚类合并成 14 条后被拆回子主题簇(验证拆分真正发生,而非巧合)
  const aCluster = clusters.find((c) => c.items.every((x) => /结果报道/.test(x.title)));
  const bCluster = clusters.find((c) => c.items.every((x) => /入门指南/.test(x.title)));
  assert.ok(aCluster && bCluster, "结果报道/入门指南子主题应各自成簇(拆分有效)");
  assert.equal(aCluster.size, 7);
  assert.equal(bCluster.size, 7);
});


test("cluster语义: 簇 ≤ maxClusterSize 不拆分(零回归)", () => {
  // 10 条同主题:方向角 [0°,60°] 扇形,两两/与质心 cosine ≥ 0.5(≥ 主阈值 0.42,同簇);
  // dupThreshold 传 1 隔离近似重复折叠(dup 是独立特性,已有专门测试)
  const results = [];
  const vecs = [];
  for (let i = 0; i < 10; i++) {
    const th = (i * Math.PI) / 30; // 0°..60°
    results.push({ title: `虚拟细胞大赛报道${i}号`, url: `a${i}` });
    vecs.push([Math.cos(th), Math.sin(th)]);
  }
  const { clusters } = clusterResults(results, "虚拟细胞大赛", { vectors: vecs, simThreshold: 0.42, dupThreshold: 1.01 });
  assert.equal(clusters.length, 1, `10 条同主题应保持 1 簇(≤12 不拆),实际 ${clusters.length}`);
  assert.equal(clusters[0].size, 10);
});


test("cluster语义: 拆分后真离群单例保持独立(平安细胞不藏回子簇)", () => {
  // 13 条主主题(方向角 [-15°,+15°] 扇形,成员间 cosine ≥ cos30°≈0.87 ≥ intraThr 0.50 → 拆不开,
  // 证明它们本就是同一子主题) + 1 条"平安细胞"(与主簇质心 cos=0.45,
  // 在拆分窗口 [主阈值 0.42, intraThr 0.50) 内:主聚类并入 → 14 条触发拆分 → 二次聚类拆出 →
  // 单例回收阈值同为 0.50 → 保持单例)
  const results = [];
  const vecs = [];
  for (let i = 0; i < 13; i++) {
    const th = (-15 + i * 2.5) * (Math.PI / 180);
    results.push({ title: `虚拟细胞大赛报道${i}号`, url: `a${i}` });
    vecs.push([Math.cos(th), Math.sin(th)]);
  }
  results.push({ title: "一场比武激活平安细胞的内生动力", url: "pingan" });
  vecs.push([Math.cos(63.3 * (Math.PI / 180)), Math.sin(63.3 * (Math.PI / 180))]);
  const { clusters } = clusterResults(results, "虚拟细胞大赛", { vectors: vecs, simThreshold: 0.42, dupThreshold: 1.01 });
  const main = clusters.find((c) => c.items.every((x) => /报道/.test(x.title)));
  assert.ok(main, "主主题簇存在");
  assert.equal(main.size, 13, "同子主题成员应完整保留(不误拆)");
  const singletons = clusters.filter((c) => c.size === 1);
  assert.ok(singletons.some((c) => /平安/.test(c.items[0].title)), "平安细胞应为独立单例簇(不藏回子簇)");
});


test("cluster: cosine 余弦计算正确", () => {
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9, "同向 = 1");
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9, "正交 = 0");
  assert.ok(Math.abs(cosine([1, 0], [-1, 0]) + 1) < 1e-9, "反向 = -1");
  assert.equal(cosine(null, [1]), 0, "非法输入返回 0");
});


test("cluster语义桶: 单例语义桶合并(融资类归桶,真独立保持单例)", () => {
  // 8 个单例:3 条融资新闻(文本不共享短语但语义同向)、2 条方案解读(同向另一轴)、
  // 3 条真独立(各占一轴,与所有成员低相似)。贪心聚类下(主阈值 0.42)它们各自成簇 →
  // UPGMA 应合并出 融资桶(3)+ 方案桶(2),独立者保持单例。
  const results = [];
  const vecs = [];
  const add = (title, url, vec) => { results.push({ title, url }); vecs.push(vec); };
  add("注册资本仅增3万,百度为何加注这家虚拟细胞公司", "f1", [0.97, 0.24, 0, 0, 0]);
  add("2000亿美元的数据赌局:虚拟细胞公司的钱烧对了吗", "f2", [0.98, 0.2, 0, 0, 0]);
  add("晶泰科技孵化虚拟细胞引擎完成数千万元天使轮融资", "f3", [0.95, 0.32, 0, 0, 0]);
  add("虚拟细胞大赛World Top30方案详解", "s1", [0.1, 0.9, 0, 0, 0]);
  add("对话百图生科张晓明:夺冠是厚积薄发", "s2", [0.05, 0.93, 0, 0, 0]);
  add("最小人造细胞JCVI的数字克隆实现", "i1", [0, 0, 1, 0, 0]);
  add("广州发布行业首个AI细胞智造大模型", "i2", [0, 0, 0, 1, 0]);
  add("GOAI世界人工智能开源大赛四大赛道发布", "i3", [0, 0, 0, 0, 1]);
  const { clusters } = clusterResults(results, "虚拟细胞大赛", {
    vectors: vecs, simThreshold: 0.42, dupThreshold: 1.01,
  });
  assert.equal(clusters.length, 5, "融资桶 + 方案桶 + 3 独立单例");
  const fin = clusters.find((c) => c.items.some((x) => x.url === "f1"));
  assert.ok(fin && fin.size === 3, "3 条融资新闻应合成一桶(语义同向 pairwise 0.95+)");
  const plan = clusters.find((c) => c.items.some((x) => x.url === "s1"));
  assert.ok(plan && plan.size === 2, "2 条方案解读应合成一桶(pairwise 0.9)");
  const singles = clusters.filter((c) => c.size === 1);
  assert.equal(singles.length, 3, "3 条真独立单例保持独立(不误合)");
});


test("cluster语义重排: 词典结果(标题含查询词但语义无关)沉底+低相关,不剔除", () => {
  const results = [
    { title: "Top 10 AI learning agents tools", url: "a" },
    { title: "best 是什么意思 best 的翻译 音标 读音 用法 例句", url: "dict" },
    { title: "How AI agents learn new knowledge", url: "b" },
  ];
  const qVec = [1, 0, 0, 0];
  // 词典页与查询语义正交(cos≈0),两条 AI 文章与查询同向(cos≈1)
  const vectors = [[1, 0.1, 0, 0], [0.05, 1, 0, 0], [1, -0.1, 0, 0]];
  const { clusters } = clusterResults(results, "best AI agents for learning", {
    vectors,
    queryVec: qVec,
  });
  // 不剔除:词典结果仍在(ML 温和过滤 = 重排 + 标注,不是删除)
  const dict = clusters.find((c) => /字典|词典|翻译|音标/.test(c.label) || c.items.some((i) => i.url === "dict"));
  assert.ok(dict, "词典结果应仍展示(不剔除)");
  assert.equal(clusters.length, 2, "正常簇 + 词典簇都在");
  assert.ok(dict.lowRelevance, "词典簇应标 ⚠️低相关");
  assert.ok(dict.semScore !== null && dict.semScore < 0.1, `词典簇语义分应≈0(实际 ${dict.semScore})`);
  assert.ok(dict.items[0].rel !== undefined && dict.items[0].rel < 0.1, "条目应携带 rel 字段");
  // 正常簇语义分高、不低相关、排前面
  const good = clusters.find((c) => !c.lowRelevance);
  assert.ok(good, "相关内容簇不应低相关");
  assert.ok(good.semScore > 0.9, `正常簇语义分应高(实际 ${good.semScore})`);
  assert.ok(clusters[0] === good || clusters[0].score > dict.score, "正常簇应排词典簇前面");
});


test("cluster语义重排: 文本命中但语义无关的总分应低于语义相关结果", () => {
  // 两条结果标题都含查询词 "best",但一条语义相关一条是词典页
  const results = [
    { title: "Best AI learning agent comparison 2025", url: "good" },
    { title: "best 是什么意思 词典 例句 音标", url: "dict" },
  ];
  const qVec = [1, 0, 0];
  const vectors = [[1, 0.05, 0], [0.1, 1, 0]];
  const { clusters } = clusterResults(results, "best AI learning agent", {
    vectors,
    queryVec: qVec,
  });
  const dict = clusters.find((c) => c.items.some((i) => i.url === "dict"));
  const good = clusters.find((c) => c.items.some((i) => i.url === "good"));
  assert.ok(dict && good, "两簇都在(不剔除)");
  // 语义重排的核心价值:词典页虽然标题含 best(文本命中),总分仍显著低于语义相关页
  assert.ok(good.score > dict.score, "语义相关结果应排词典页前面");
  assert.ok(dict.lowRelevance, "词典页应标低相关");
});


test("cluster语义重排: 无 queryVec 时零回归(semScore=null,原打分不变)", () => {
  const r = [
    { title: "Python爬虫入门教程", desc: "零基础" },
    { title: "Python 爬虫超详细讲解", desc: "实战" },
  ];
  const withVec = clusterResults(r, "python 爬虫", { vectors: [[1, 0], [0.9, 0.1]] });
  const noVec = clusterResults(r, "python 爬虫");
  withVec.clusters.forEach((c) => assert.equal(c.semScore, null, "无 queryVec → semScore 应为 null"));
  assert.equal(noVec.clusters[0].semScore, null, "短语模式 → semScore 应为 null");
  assert.ok(noVec.clusters.length >= 1 && noVec.clusters[0].size >= 1, "短语模式仍正常聚类");
});
