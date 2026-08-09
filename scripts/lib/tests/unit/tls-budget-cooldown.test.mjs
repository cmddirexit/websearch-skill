// tls / budget / cooldown 无测试模块的纯函数轻量单测
// (tls 的 parseCurlOutput / isTlsFallbackCandidate,budget 的 withBudget,cooldown 的状态机)

import { test } from "node:test";
import assert from "node:assert/strict";

// ---------- tls.mjs ----------
import { parseCurlOutput, isTlsFallbackCandidate, isTlsHostCooled, recordTlsFailure, recordTlsSuccess, resetTlsFailState } from "../../tls.mjs";

test("parseCurlOutput: 状态码/重定向 set-cookie 收集/body 提取", () => {
  const out = [
    "HTTP/1.1 301 Moved Permanently",
    "location: /final",
    "set-cookie: sid=abc; Path=/",
    "",
    "HTTP/1.1 200 OK",
    "content-type: text/html",
    "set-cookie: theme=dark",
    "",
    "<html>real body</html>",
  ].join("\r\n");
  const r = parseCurlOutput(out);
  assert.equal(r.status, 200, "状态码应取最后一块");
  assert.deepEqual(r.setCookies, ["sid=abc; Path=/", "theme=dark"], "重定向途中 cookie 也要进 jar");
  assert.equal(r.body, "<html>real body</html>");
});

test("parseCurlOutput: 无 header 块(纯 body)不崩", () => {
  const r = parseCurlOutput("just a body");
  assert.equal(r.status, 0);
  assert.equal(r.body, "");
});

test("isTlsFallbackCandidate: 403 状态 / TLS 指纹错误信号 → true,普通错误 → false", () => {
  assert.equal(isTlsFallbackCandidate({ status: 403 }), true);
  assert.equal(isTlsFallbackCandidate({ status: 404 }), false, "404 不是指纹拦截");
  assert.equal(isTlsFallbackCandidate(new Error("fetch failed: ECONNRESET")), true, "ECONNRESET = 握手被 RST");
  assert.equal(isTlsFallbackCandidate(new Error("SSL handshake failed")), true);
  assert.equal(isTlsFallbackCandidate(new Error("certificate has expired")), true, "人类可读证书错误也要识别");
  assert.equal(isTlsFallbackCandidate(new Error("self-signed certificate")), true);
  assert.equal(isTlsFallbackCandidate(new Error("page not found")), false);
  assert.equal(isTlsFallbackCandidate(null), false);
});

test("TLS 失败记忆:连续失败达阈值进冷却,成功清零", () => {
  resetTlsFailState();
  assert.equal(isTlsHostCooled("a.com"), false);
  recordTlsFailure("a.com");
  recordTlsFailure("a.com"); // 达到阈值(2)
  assert.equal(isTlsHostCooled("a.com"), true, "连续失败应进冷却");
  recordTlsSuccess("a.com");
  assert.equal(isTlsHostCooled("a.com"), false, "成功应清零");
  resetTlsFailState();
});

// ---------- budget.mjs ----------
import { withBudget } from "../../budget.mjs";

test("withBudget: 正常完成返回结果,超时 reject", async () => {
  const ok = await withBudget(Promise.resolve("done"), 500, "t");
  assert.equal(ok, "done");
  await assert.rejects(withBudget(new Promise((r) => setTimeout(r, 1000, "late")), 50, "t"), /超出预算/);
  // 立即失败:预算耗尽
  await assert.rejects(withBudget(Promise.resolve("x"), 0, "t"), /无剩余预算/);
});

// ---------- cooldown.mjs ----------
import { createCooldown } from "../../cooldown.mjs";

test("createCooldown: 触发阈值后进入冷却,到期恢复", async () => {
  const cd = createCooldown({ threshold: 3, cooldownMs: 30_000 }); // 阈值 3 次
  assert.equal(cd.isCooled("x.com"), false);
  cd.mark("x.com", false); cd.mark("x.com", false);
  assert.equal(cd.isCooled("x.com"), false, "未达阈值不冷却");
  cd.mark("x.com", false);
  assert.equal(cd.isCooled("x.com"), true, "达阈值进冷却");
  // 成功清零:冷却期内成功则立刻解除(或重置计数)
  cd.mark("x.com", true);
  assert.equal(cd.isCooled("x.com"), false, "成功应解除冷却");
  // 不同域名互不影响
  assert.equal(cd.isCooled("y.com"), false);
  cd.reset();
});
