import { test } from "node:test";
import assert from "node:assert/strict";
import { isNonPublicIp, validateFetchUrl, UNSAFE_URL_CODE } from "../../url-safety.mjs";

test("fetch URL: 只接受公网 http/https 且返回规范化 URL", () => {
  assert.equal(validateFetchUrl("https://Example.com/a?q=1"), "https://example.com/a?q=1");
  assert.equal(validateFetchUrl("http://8.8.8.8/"), "http://8.8.8.8/");
  assert.equal(validateFetchUrl("https://[2606:4700:4700::1111]/"), "https://[2606:4700:4700::1111]/");
});

test("fetch URL: 拒绝非 Web 协议、凭据和本地主机", () => {
  for (const url of [
    "file:///etc/passwd",
    "data:text/plain,secret",
    "https://user:pass@example.com/",
    "http://localhost/admin",
    "http://sub.localhost/admin",
  ]) {
    assert.throws(() => validateFetchUrl(url), (error) => error.code === UNSAFE_URL_CODE, url);
  }
});

test("fetch URL: 拒绝私有、环回、链路本地和保留 IP 字面量", () => {
  for (const ip of ["0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "224.0.0.1", "::", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"]) {
    assert.equal(isNonPublicIp(ip), true, ip);
    const literal = ip.includes(":") ? `[${ip}]` : ip;
    assert.throws(() => validateFetchUrl(`http://${literal}/`), (error) => error.code === UNSAFE_URL_CODE, ip);
  }
});

test("fetch URL: 整数形式 IPv4 会先被 URL 解析器规范化再拦截", () => {
  assert.throws(() => validateFetchUrl("http://2130706433/"), /127\.0\.0\.1/);
});
