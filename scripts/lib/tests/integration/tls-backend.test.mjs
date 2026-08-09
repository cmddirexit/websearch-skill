// integration/tls-backend.test.mjs — TLS 指纹兜底真后端(curl-impersonate/curl_cffi)
// 慢:启动 python/curl,默认不随 npm test 跑
import { test } from "node:test";
import assert from "node:assert/strict";
import { isImpersonateAvailable } from "../../tls.mjs";

test("tls: impersonate 非 200 不当成功(httpGet 仍抛原始错误)", async () => {
  if (!(await isImpersonateAvailable())) return; // 无后端时直连抛错同样通过,但没覆盖非 200 分支
  const { createServer } = await import("node:http");
  const srv = createServer((req, res) => {
    res.statusCode = 403;
    res.end("<html>mock firewall block</html>");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const { httpGet } = await import("../../http.mjs");
  try {
    await assert.rejects(httpGet(`http://127.0.0.1:${port}/x`), /HTTP 403/, "impersonate 403 不应冒充成功");
  } finally {
    srv.close();
  }
});

// ---------- Cloudflare Turnstile 检测(移植自 Scrapling) ----------

