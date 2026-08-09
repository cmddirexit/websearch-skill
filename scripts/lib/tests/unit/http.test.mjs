// http.mjs —— Cookie jar 解析/拼装/过期 与 同域限速
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeRateLimitDelay,
  parseSetCookieLine,
  updateCookieJarForResponse,
  getCookieHeaderFor,
  httpGet,
} from "../../http.mjs";
import { DOMAIN_RATE_LIMIT_MS } from "../../config.mjs";

test("cookie: 解析 set-cookie 行(name/value/Expires)", () => {
  const c = parseSetCookieLine("BAIDUID=abc123; Path=/; Expires=Wed, 01 Jan 2099 00:00:00 GMT");
  assert.equal(c.name, "BAIDUID");
  assert.equal(c.value, "abc123");
  assert.ok(c.expiresAt > Date.now(), "应解析出未来过期时间");
  const noExpire = parseSetCookieLine("session=x; Path=/");
  assert.equal(noExpire.expiresAt, 0, "无过期时间是会话 cookie");
  const maxAge = parseSetCookieLine("tok=xyz; Max-Age=3600");
  assert.ok(maxAge.expiresAt > Date.now(), "Max-Age 应换算成时间戳");
});


test("cookie: 响应 set-cookie 后拼出请求 Cookie 头", () => {
  updateCookieJarForResponse("https://example.com/search", [
    "A=1; Path=/",
    "B=hello%20world; Path=/; Expires=Wed, 01 Jan 2099 00:00:00 GMT",
  ]);
  const h = getCookieHeaderFor("https://example.com/other");
  assert.match(h, /A=1/);
  assert.match(h, /B=hello%20world/);
});


test("cookie: 过期 cookie 不再带上", () => {
  const future = new Date(Date.now() + 3_600_000).toUTCString(); // 1 小时后
  const past = new Date(Date.now() - 5000).toUTCString();
  updateCookieJarForResponse("https://expired.example/", [`OK=1; Expires=${future}`, `DEAD=2; Expires=${past}`]);
  const h = getCookieHeaderFor("https://expired.example/");
  assert.match(h, /OK=1/);
  assert.doesNotMatch(h, /DEAD=2/, "过期 cookie 应被过滤");
});

test("限速: 同域连续请求需等待间隔", () => {
  assert.equal(computeRateLimitDelay(0, Date.now()), 0, "无历史请求不等待");
  assert.equal(computeRateLimitDelay(Date.now(), Date.now() + DOMAIN_RATE_LIMIT_MS), 0, "已过间隔不等待");
  assert.ok(computeRateLimitDelay(Date.now(), Date.now() + 100) > 0, "间隔内需等待");
});
