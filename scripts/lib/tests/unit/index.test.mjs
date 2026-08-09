// index.mjs 公共 API 冒烟测试
//
// 背景:index.mjs 曾导出不存在的 enWordsFeatures,导致外部 `import from "websearch-skill"`
// 一导入即 SyntaxError —— 而 171 个单元测试全过,因为测试都绕过 index.mjs 直连具体模块。
// 此文件兜底:验证公共 API 入口可加载 + 关键导出存在 + 同名冲突已别名化。

import { test } from "node:test";
import assert from "node:assert/strict";

// 动态 import:加载失败会 reject,测试自然失败
const idx = await import("../../index.mjs");

test("index.mjs 可加载且导出非空", () => {
  assert.ok(Object.keys(idx).length > 50, `导出应充实(实际 ${Object.keys(idx).length})`);
});

test("引擎搜索统一契约(engine/mode/blocked/results)", () => {
  for (const fn of [idx.searchBing, idx.searchBaidu, idx.searchCnnews, idx.searchMarginalia]) {
    assert.equal(typeof fn, "function", "引擎 search 应为函数");
  }
  // 注:sogou/searx 等特例引擎未进公共 API(直连特判/实例聚合),经 registry 消费
});

test("浏览器基础设施导出", () => {
  assert.equal(typeof idx.getDom, "function");
  assert.equal(typeof idx.fetchViaBrowser, "function");
  assert.equal(typeof idx.isBrowserAvailable, "function");
  assert.equal(typeof idx.resolveChromiumPath, "function");
});

test("浏览器版引擎已拆分到独立文件(bing-browser/marginalia-browser)", () => {
  assert.equal(typeof idx.searchBingViaBrowser, "function");
  assert.equal(typeof idx.searchMarginaliaViaBrowser, "function");
});

test("同名函数别名:cluster.enWords 与 domain-rep.repEnWords 并存", () => {
  assert.equal(typeof idx.enWords, "function", "聚类 token 版 enWords");
  assert.equal(typeof idx.repEnWords, "function", "特征提取版经别名 repEnWords 导出");
  // 行为确实不同:聚类版滤停用词(数组),特征版保留数字(Set)
  const clusterOut = idx.enWords("the 2026 ai news");
  assert.ok(Array.isArray(clusterOut) && !clusterOut.includes("the"), "聚类版滤停用词");
  assert.ok(idx.repEnWords("the 2026 ai news").has("2026"), "特征版保留数字词");
});

test("抓取/解析/聚类工具导出", () => {
  assert.equal(typeof idx.fetchPage, "function");
  assert.equal(typeof idx.extractBodyFromHtml, "function");
  assert.equal(typeof idx.httpGet, "function");
  assert.equal(typeof idx.clusterResults, "function");
  assert.equal(typeof idx.classifyFetchResult, "function");
  assert.equal(typeof idx.detectAntibot, "function");
  assert.equal(typeof idx.runFetch, "function", "调度链应导出供测试/复用");
  assert.equal(typeof idx.cacheFetchResult, "function");
});
