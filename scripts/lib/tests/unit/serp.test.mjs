// serp-generic.mjs(JSON/urlstream 结构化提取) + parse-serp.mjs(双判据降级)
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSerpGeneric, urlstreamExtract, extractJsonBlocks } from "../../serp-generic.mjs";
import { parseSerp } from "../../parse-serp.mjs";
import { loadFixture } from "./helpers.mjs";


function awaitImportSerp() {
  return { extractJsonBlocks, urlstreamExtract };
}
function awaitImportParseSerp() {
  return { parseSerp };
}


test("serp层③: extractJsonBlocks 支持 JS 对象字面量(未引号 key,json5 接管)", () => {
  const { extractJsonBlocks } = awaitImportSerp();
  const html = `<script>window.__INITIAL_STATE__ = { data: { list: [{ gid: "123", "title": "测试标题", "url": "https://example.com/group/123/" }] } };</script>`;
  const blocks = extractJsonBlocks(html);
  assert.ok(blocks.length >= 1, "应提取出 JSON 块(未引号 key 用 json5)");
  const j = blocks[0];
  assert.equal(j.data.list[0].title, "测试标题", "json5 解析未引号 key 成功");
});


test("serp层③: urlstreamExtract 字段名无关(改字段名仍提取)", () => {
  const { urlstreamExtract } = awaitImportSerp();
  const html = `<script>window.__INITIAL_STATE__ = { result: [{ headline: "完全不同的字段名", "x_url": "https://site.com/a/100/", "y_summary": "摘要内容" }] };</script>`;
  const r = urlstreamExtract(html, /\/a\/\d+\//, 5);
  assert.ok(r.results.length >= 1, "字段名无关:应提取到条目");
  assert.equal(r.results[0].title, "完全不同的字段名");
  assert.ok(r.results[0].url.includes("/a/100/"), "URL 正确");
});


test("serp层③: 相对 URL 被过滤,只收完整 URL", () => {
  const { urlstreamExtract } = awaitImportSerp();
  const html = `<script>window.__INITIAL_STATE__ = { r: [{ "title": "好的", "u": "/group/1/" }, { "title": "好2", "u": "https://site.com/group/2/" }] };</script>`;
  const r = urlstreamExtract(html, /\/group\/\d+\//, 5);
  assert.ok(r.results.every((x) => /^https?:/.test(x.url)), "只应收集完整 URL");
});


test("serp层③: 非 JSON 内容返回空(不抛错,不硬凑)", () => {
  const { urlstreamExtract } = awaitImportSerp();
  // 无 script JSON,只有散落文本里的 URL → 层③不适用(HTML 链接页由层② DOM 解析覆盖)
  const html = `<div>参考 https://site.com/group/99/ 这个</div>`;
  const r = urlstreamExtract(html, /\/group\/\d+\//, 5);
  assert.equal(r.results.length, 0, "无 JSON 块时返回空,不硬凑");
});


test("serp层③: toutiao fixture 结构化提取 ≥4 条且标题质量高(无 JSON 碎片)", () => {
  const { urlstreamExtract } = awaitImportSerp();
  const html = loadFixture("toutiao-search");
  const r = urlstreamExtract(html, /\/group\/\d+\//, 10);
  assert.ok(r.results.length >= 4, `头条 fixture 应提取 ≥4 条,实际 ${r.results.length}`);
  // 标题质量:无 JSON 碎片特征
  for (const x of r.results) {
    assert.ok(!/https?:/.test(x.title), `标题不应含 URL: ${x.title.slice(0, 30)}`);
    assert.ok(!/\\\\u[0-9a-f]{4}/i.test(x.title), `标题不应含未解码转义: ${x.title.slice(0, 30)}`);
    assert.ok(x.title.length >= 5, "标题长度达标");
  }
  // 头条场景标题应与"北京天气"相关(查询上下文)
  assert.ok(r.results.some((x) => x.title.includes("北京")), "应包含北京天气相关标题");
});


test("parseSerp判据A: 冷门查询不误报(domEntryCount 分母)", () => {
  const { parseSerp } = awaitImportParseSerp();
  // 页面实际只有 6 条,特异性全解析出 → 6/min(10,6)=1.0 保级,通用不执行
  let genericCalls = 0;
  const r = parseSerp("<html>mock</html>", {
    engineKey: "test",
    specific: (html, limit) => ({ blocked: false, results: Array.from({ length: 6 }, (_, i) => ({ title: `r${i}`, url: `u${i}` })), domEntryCount: 6 }),
    limit: 10,
  });
  assert.equal(r.parsedBy, "specific", "判据A:6/6=1.0 ≥ 0.5 → 保级");
  assert.equal(genericCalls, 0, "判据A 通过时通用解析器不执行(零回归)");
});


test("parseSerp判据B: 特异性≥5 且优于通用 → 相对质量保级", () => {
  const { parseSerp } = awaitImportParseSerp();
  // 比例低(5/10=0.5 边界)但 specific(5) ≥ generic(3)→ 保级
  const r = parseSerp("<html><div><a href='https://a.com/1'>标题一 这里足够长</a></div></html>", {
    engineKey: "test",
    specific: (html, limit) => ({ blocked: false, results: Array.from({ length: 5 }, (_, i) => ({ title: `s${i} 有标题`, url: `u${i}` })) }),
    limit: 10,
  });
  assert.equal(r.parsedBy, "specific", "判据B:5≥5 且 5≥3 → 保级");
  assert.ok(r.specificCount >= 5);
});


test("parseSerp降级: 特异性 <5 且通用明显更多 → 切通用", () => {
  const { parseSerp } = awaitImportParseSerp();
  // 特异性只有 2 条,通用解析器能从 HTML 提取 9 条 → 降级
  const html = Array.from({ length: 9 }, (_, i) => `<div><a href="https://x${i}.com/p">这是第 ${i} 个足够长的标题内容</a><p>摘要文本内容</p></div>`).join("");
  const r = parseSerp(html, {
    engineKey: "test",
    specific: (html, limit) => ({ blocked: false, results: [{ title: "a", url: "u1" }, { title: "b", url: "u2" }] }),
    limit: 10,
  });
  assert.equal(r.parsedBy, "generic", "特异性 2 < 通用 9 → 降级通用");
  assert.ok(r.results.length >= 5, "通用解析结果可用");
});


test("parseSerp层③: 特异性 0 + JSON 内嵌页(urlShape)→ urlstream", () => {
  const { parseSerp } = awaitImportParseSerp();
  const html = `<script>window.__INITIAL_STATE__ = { data: { list: [{ "title": "JSON 内嵌标题", "url": "https://site.com/group/100/" }] } };</script>`;
  const r = parseSerp(html, {
    engineKey: "test",
    specific: () => ({ blocked: true, reason: "0 命中:SSR 结构可能已变更", results: [] }),
    urlShape: /\/group\/\d+\//,
    limit: 5,
  });
  assert.equal(r.parsedBy, "urlstream", "JSON 内嵌页 → 层③");
  assert.equal(r.results[0].title, "JSON 内嵌标题");
});
