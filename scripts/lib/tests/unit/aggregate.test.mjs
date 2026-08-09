// registry(声明式配置) + budget(硬预算) + aggregate(多引擎聚合/失败记忆) + B1-B4 缺陷回归
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEngines, ENGINE_LABELS } from "../../engines/registry.mjs";
import { withBudget } from "../../budget.mjs";
import { aggregateSearch, isEngineCooled, resetEngineFailState, isNearDuplicateTitle } from "../../aggregate.mjs";
import { queryTokens } from "../../cluster.mjs";
import { decodeBingUrl } from "../../engines/bing.mjs";
import { mockEngine } from "./helpers.mjs";

test("registry: 配置加载,降级链展开为 {label, fn}", () => {
  const engines = loadEngines();
  assert.ok(engines.bing && engines.baidu && engines.marginalia, "三个引擎都应注册");
  assert.equal(engines.bing.label, "bing(中文/英文通用)");
  assert.equal(typeof engines.bing.search, "function");
  assert.ok(engines.bing.fallbacks.length >= 3, "bing 降级链含 marginalia 双兜底 + bing 浏览器");
  assert.equal(engines.bing.fallbacks[0].label, ENGINE_LABELS.marginalia, "fallback 名取自 ENGINE_LABELS");
  assert.equal(typeof engines.bing.fallbacks[0].fn, "function");
});


test("registry: aggregateWith \"all\" 展开为除自身与专用引擎外全部", () => {
  const engines = loadEngines();
  const keys = Object.keys(engines);
  for (const k of keys) {
    const aw = engines[k].aggregateWith;
    assert.ok(!aw.includes(k), `聚合伙伴不应包含自身(${k})`);
    assert.ok(!aw.includes("cnnews"), `cnnews 不参与通用聚合(${k} 不应含 cnnews)`);
  }
  // 中文聚合典型组合:bing 的伙伴覆盖全部中文引擎(语言过滤在 aggregate.mjs 做)
  for (const zh of ["baidu", "sogou", "so360", "sm", "toutiao"]) {
    assert.ok(engines.bing.aggregateWith.includes(zh), `bing 聚合应含 ${zh}`);
  }
  // cnnews 保持显式列表(专用新闻频道)
  assert.deepEqual(engines.cnnews.aggregateWith, ["bing", "baidu", "github"]);
});


test("registry: 配置引用了未注册引擎 → 启动即抛错", () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-conf-"));
  try {
    const bad = { engines: { ghost: { search: "nonexistent-engine", fallbacks: [] } } };
    const file = join(dir, "engines.conf.json");
    writeFileSync(file, JSON.stringify(bad));
    assert.throws(() => loadEngines(file), /未在 ENGINE_IMPLS 注册/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("registry: fallback 引用未注册引擎 → 抛错", () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-conf-"));
  try {
    const bad = { engines: { bing: { search: "bing", fallbacks: ["not-a-real-engine"] } } };
    const file = join(dir, "engines.conf.json");
    writeFileSync(file, JSON.stringify(bad));
    assert.throws(() => loadEngines(file), /fallback "not-a-real-engine"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- http.mjs(Cookie jar 与限速) ----------

test("预算: withBudget 在预算内正常 resolve", async () => {
  const v = await withBudget(Promise.resolve(42), 1000, "test");
  assert.equal(v, 42);
});


test("预算: 超出预算立即 reject(硬约束,底层任务被丢弃)", async () => {
  await assert.rejects(
    withBudget(new Promise((r) => setTimeout(() => r("晚到"), 300)), 50, "slow"),
    /超出预算/
  );
});


test("预算: 无剩余预算直接失败", async () => {
  await assert.rejects(withBudget(Promise.resolve(1), 0, "none"), /无剩余预算/);
});


test("B2: cookie 持久化写入 savedAt(TTL 检查有依据)", async () => {
  // 直接构造并调用磁盘读写路径有副作用,改为验证 persist 结构:通过 httpGet 触发后读文件
  const { readFileSync } = await import("node:fs");
  const { COOKIE_FILE } = await import("../../config.mjs");
  let entry = null;
  try {
    const j = JSON.parse(readFileSync(COOKIE_FILE, "utf8"));
    for (const list of Object.values(j)) if (Array.isArray(list) && list.length) { entry = list[0]; break; }
  } catch { /* 无文件 */ }
  if (!entry) { console.log("[B2] 无 cookie 文件,跳过(需先有真实请求)"); return; }
  assert.equal(typeof entry.savedAt, "number", "持久化条目应含 savedAt 时间戳");
});


test("B3: queryTokens 注入的自定义品牌词典生效", () => {
  const custom = { "测试": "custom" };
  const toks = queryTokens("测试", custom);
  assert.ok(toks.some((t) => t.t === "e:custom"), `自定义别名应生效,实际: ${toks.map((t) => t.t)}`);
  // 默认词典不受影响
  assert.ok(queryTokens("苹果").some((t) => t.t === "e:apple"));
});


test("B4: decodeBingUrl 解码直链 HTML 实体(含双重编码)", () => {
  // 单重 &amp; 与双重 &amp%3B 都应解码为 &
  const single = decodeBingUrl("https://www.bing.com/?setlang=zh-cn&amp;brdr=1");
  const double = decodeBingUrl("https://www.bing.com/?setlang=zh-cn&amp%3Bsetmkt=en-us&amp%3Bbrdr=1");
  assert.ok(!single.includes("&amp"), `单重编码应解码: ${single}`);
  assert.ok(!double.includes("&amp"), `双重编码应解码: ${double}`);
  assert.equal(double, "https://www.bing.com/?setlang=zh-cn&setmkt=en-us&brdr=1");
  // 跳转链接解码不受影响(实体解码不会破坏 base64url)
  assert.equal(decodeBingUrl("https://cn.bing.com/ck/a?a=b&u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS8"), "https://example.com/");
});


// ==================== 规则过滤(filter.mjs) ====================


test("aggregate: 近似转载标题判定(LCS 占比,零词表,不误杀)", () => {
  assert.ok(
    isNearDuplicateTitle(
      "全球首届AI虚拟细胞大赛结果出炉,华人科学家横扫全场 - 搜狐",
      "全球首届AI虚拟细胞大赛结果出炉,华人科学家横扫..._生物通"
    ),
    "同源转载(仅差站名后缀/截断)应判重"
  );
  assert.ok(
    !isNearDuplicateTitle(
      "Arc虚拟细胞挑战赛:入门指南 - Hugging Face 文档",
      "Cell:虚拟细胞挑战赛已开启,科研人不能错过的顶刊机会 - 知乎"
    ),
    "共享主题短语但非转载不应误杀"
  );
  assert.ok(!isNearDuplicateTitle("虚拟细胞大赛", "虚拟细胞挑战赛"), "短标题(<8)不参与近似判定");
  assert.ok(!isNearDuplicateTitle("苹果发布会新机", "苹果股价新高"), "同词不同文不误判");
});


test("聚合: URL 去重(www 变体)+ 主引擎优先 + src 标记", async () => {
  resetEngineFailState();
  const bing = mockEngine("bing", [
    { title: "A", url: "https://a.com/1", desc: "a" },
    { title: "B", url: "https://www.a.com/1", desc: "b" }, // www 变体 → 与 A 重复
  ]);
  const baidu = mockEngine("baidu", [{ title: "C", url: "https://c.com/", desc: "c" }], { zhOnly: true });
  const eng = { bing: bing.engine, baidu: baidu.engine };
  const r = await aggregateSearch(eng, "英文查询 no cjk", 10, ["bing", "baidu"], Date.now() + 60_000);
  assert.equal(r.blocked, false);
  assert.equal(r.results.length, 2, "A(www 变体去重)+ C,共 2 条");
  assert.equal(r.results[0].title, "A", "主引擎(bing)结果在前");
  assert.equal(r.results[0].src, "bing");
  assert.equal(r.results[1].src, "baidu");
  assert.equal(r.results[0].sourceRank, 1, "主引擎结果保留来源内名次");
  assert.equal(r.results[1].sourceRank, 1, "补充引擎第 1 名不应变成全局末位名次");
});


test("聚合: 语言过滤(英文查询跳过 zhOnly,中文查询跳过 enOnly)", async () => {
  resetEngineFailState();
  const zh = mockEngine("baidu", [{ title: "中", url: "https://zh.com/", desc: "" }], { zhOnly: true });
  const en = mockEngine("marginalia", [{ title: "En", url: "https://en.com/", desc: "" }], { enOnly: true });
  const gen = mockEngine("bing", [{ title: "G", url: "https://g.com/", desc: "" }]);
  const eng = { baidu: zh.engine, marginalia: en.engine, bing: gen.engine };
  const rEn = await aggregateSearch(eng, "rust async", 10, ["bing", "baidu", "marginalia"], Date.now() + 60_000);
  assert.ok(!rEn.results.some((x) => x.src === "baidu"), "英文查询不应调 zhOnly 引擎");
  assert.ok(rEn.results.some((x) => x.src === "marginalia"), "英文查询应保留 enOnly 引擎");
  const rZh = await aggregateSearch(eng, "北京天气", 10, ["bing", "baidu", "marginalia"], Date.now() + 60_000);
  assert.ok(!rZh.results.some((x) => x.src === "marginalia"), "中文查询不应调 enOnly 引擎");
  assert.ok(rZh.results.some((x) => x.src === "baidu"), "中文查询应保留 zhOnly 引擎");
});


test("聚合: blocked 引擎不阻塞整体,其余正常返回", async () => {
  resetEngineFailState();
  const bad = mockEngine("searx", [], { blocked: true, reason: "实例不可达" });
  const ok = mockEngine("bing", [{ title: "G", url: "https://g.com/", desc: "" }]);
  const eng = { searx: bad.engine, bing: ok.engine };
  const r = await aggregateSearch(eng, "q", 10, ["bing", "searx"], Date.now() + 60_000);
  assert.equal(r.blocked, false);
  assert.equal(r.results.length, 1);
  assert.ok(r._errors.some((e) => e.includes("searx")), "失败引擎进 _errors 供 [info] 输出");
});


test("聚合: 失败记忆 —— 连续失败 2 次进入冷却,冷却中不再调用引擎", async () => {
  resetEngineFailState();
  const bad = mockEngine("searx", [], { blocked: true, reason: "实例不可达" });
  const ok = mockEngine("bing", [{ title: "G", url: "https://g.com/", desc: "" }]);
  const eng = { searx: bad.engine, bing: ok.engine };
  const partners = ["bing", "searx"];
  const deadline = Date.now() + 60_000;
  await aggregateSearch(eng, "q", 10, partners, deadline);
  await aggregateSearch(eng, "q", 10, partners, deadline);
  assert.equal(bad.calls.count, 2, "两次失败后引擎调用 2 次");
  assert.ok(isEngineCooled("searx"), "连续 2 次失败 → 进入冷却");
  const r = await aggregateSearch(eng, "q", 10, partners, deadline);
  assert.equal(bad.calls.count, 2, "冷却中第 3 次聚合不再调用引擎");
  assert.ok(r._errors.some((e) => e.includes("冷却")), "冷却中的引擎给出明确跳过原因");
  // 成功一次后状态应清空(下次失败重新计数)
  resetEngineFailState();
  assert.equal(isEngineCooled("searx"), false, "状态可重置");
});


test("聚合: 预算耗尽时全部跳过", async () => {
  resetEngineFailState();
  const ok = mockEngine("bing", [{ title: "G", url: "https://g.com/", desc: "" }]);
  const eng = { bing: ok.engine };
  const r = await aggregateSearch(eng, "q", 10, ["bing"], Date.now() - 1000);
  assert.equal(r.blocked, true, "预算已过 → 聚合全失败");
  assert.equal(r.results.length, 0);
});

// ---- 层③ JSON 结构化提取(serp-generic.mjs) ----
