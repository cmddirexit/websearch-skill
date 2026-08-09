/**
 * tests/helpers.mjs — 测试共享助手
 * 真实快照加载(fixtures/*.html.gz)、结果形状断言、fixture 聚类、mock 引擎。
 * 按模块拆分的测试文件都从这里取公共工具,避免各文件重复内联。
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { parseBingHtml } from "../../engines/bing.mjs";
import { clusterResults } from "../../cluster.mjs";

/** 加载 fixtures/ 下的真实站点快照(gz 压缩 HTML) */
export function loadFixture(name) {
  const base = fileURLToPath(new URL(`../../fixtures/${name}.html.gz`, import.meta.url));
  return gunzipSync(readFileSync(base)).toString("utf8");
}

/** 快照解析结果形状断言(站点改版保护) */
export function assertResultShape(results) {
  assert.ok(results.length >= 1, "真实快照应解析出至少 1 条结果(站点改版?运行 npm run fixtures)");
  for (const r of results) {
    assert.ok(r.title && r.title.length > 0, "标题非空");
    assert.ok(r.url.startsWith("http"), `URL 合法: ${r.url.slice(0, 40)}`);
  }
}

/** 从 fixture 快照一路走到聚类(cluster 测试用) */
export function clusterFromFixture(name, query, limit) {
  // 聚类 fixture 与其他引擎快照统一由 npm run fixtures 管理(scripts/lib/fixtures/*.html.gz)
  const html = loadFixture(name);
  const { results } = parseBingHtml(html, limit);
  return clusterResults(results, query);
}

/** 可计数的 mock 引擎(aggregate 测试用) */
export function mockEngine(name, results, opts = {}) {
  const calls = { count: 0 };
  const impl = async (q, n) => {
    calls.count++;
    if (opts.blocked) return { engine: name, mode: "direct", blocked: true, reason: opts.reason || "风控", results: [] };
    return { engine: name, mode: "direct", blocked: false, results };
  };
  return {
    engine: { label: opts.label || name, search: impl, fallbacks: [], aggregateWith: [], zhOnly: !!opts.zhOnly, enOnly: !!opts.enOnly, pageLimit: opts.pageLimit || 10 },
    calls,
  };
}
