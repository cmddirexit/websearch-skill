// integration/http-live.test.mjs — 真实 HTTP 请求链(同域限速,使用进程内服务)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { httpGet } from "../../http.mjs";
import { DOMAIN_RATE_LIMIT_MS } from "../../config.mjs";

// ---------- html.mjs ----------

test("限速: 并发同域请求串行化,总耗时 ≥ 1 个间隔", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/`;
  // 两个并发请求同一 host:串行化后第二个必须等第一个完成后再过间隔
  const t0 = Date.now();
  try {
    await Promise.all([httpGet(url), httpGet(url)]);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= DOMAIN_RATE_LIMIT_MS, `并发同域应串行限速,实际 ${elapsed}ms`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ==================== cnnews(官方新闻源) ====================
