// integration/aggregate-live.test.mjs — B1 缺陷回归(真实 main() 搜索)
// 慢:真跑网络聚合,默认不随 npm test 跑
import { test } from "node:test";
import assert from "node:assert/strict";

test("B1: search 参数解析 — flag 值不误当查询词(--engine 在前)", async () => {
  const { main } = await import("../../cli.mjs");
  const logs = [];
  const orig = console.log; console.log = (...a) => logs.push(a.join(" "));
  const origErr = console.error; console.error = (...a) => logs.push("ERR:" + a.join(" "));
  try {
    // 旧实现 rest.find(!startsWith("--")) 会把 "bing" 当查询词
    await main(["search", "--engine", "bing", "北京天气", "--limit", "1"]);
  } finally {
    console.log = orig; console.error = origErr;
  }
  const hit = logs.find((l) => l.includes("搜索")) || "";
  assert.ok(hit.includes("北京天气"), `查询词应为北京天气,实际: ${hit.slice(0, 60)}`);
});


