// integration/http-live.test.mjs — 真网络请求(同域限速)
// 慢:依赖外网可达,默认不随 npm test 跑(用 npm run test:integration)
import { test } from "node:test";
import assert from "node:assert/strict";
import { httpGet } from "../../http.mjs";
import { DOMAIN_RATE_LIMIT_MS } from "../../config.mjs";

// ---------- html.mjs ----------

test("限速: 并发同域请求串行化,总耗时 ≥ 2 倍间隔", async () => {
  // 两个并发请求同一 host:串行化后第二个必须等第一个完成后再过间隔
  const t0 = Date.now();
  await Promise.all([httpGet("https://example.com/"), httpGet("https://example.com/")]);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= DOMAIN_RATE_LIMIT_MS, `并发同域应串行限速,实际 ${elapsed}ms`);
});

// ==================== cnnews(官方新闻源) ====================

