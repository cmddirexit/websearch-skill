// browser.mjs(stealth/CLI 反检测/贝塞尔) + cf-solver.mjs(Turnstile 识别) + antiblock.mjs(反爬类型)
import { test } from "node:test";
import assert from "node:assert/strict";
import { STEALTH_INIT_SCRIPT, resolveChromiumPath, isBrowserAvailable, getDom, closeBrowser, bezierPath } from "../../engines/browser.mjs";
import { detectCloudflareChallenge } from "../../engines/cf-solver.mjs";
import { detectAntibot } from "../../antiblock.mjs";

test("closeBrowser: 幂等,未启动浏览器时调用不抛错", async () => {
  await closeBrowser(); // sharedBrowser 为 null,应直接返回
  await closeBrowser(); // 二次调用仍安全
});


test("browser: STEALTH_INIT_SCRIPT 含关键注入点(webdriver/languages/plugins/canvas 噪声)", () => {
  assert.match(STEALTH_INIT_SCRIPT, /navigator\.webdriver/, "必须抹掉 webdriver");
  assert.match(STEALTH_INIT_SCRIPT, /defineProperty\(navigator, "languages"/, "必须补齐语言");
  assert.match(STEALTH_INIT_SCRIPT, /defineProperty\(navigator, "plugins"/, "必须补齐插件");
  assert.match(STEALTH_INIT_SCRIPT, /toDataURL/, "必须带 Canvas 指纹噪声");
  assert.match(STEALTH_INIT_SCRIPT, /disable-blink-features|AutomationControlled|window\.chrome/, "运行时补齐");
});
test("cf: detectCloudflareChallenge 识别四种挑战类型", () => {
  assert.equal(detectCloudflareChallenge(`<script>cType: 'non-interactive'</script>`), "non-interactive");
  assert.equal(detectCloudflareChallenge(`<script>cType: 'managed'</script>`), "managed");
  assert.equal(detectCloudflareChallenge(`<script>cType: 'interactive'</script>`), "interactive");
  assert.equal(
    detectCloudflareChallenge(`<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>`),
    "embedded",
  );
  assert.equal(detectCloudflareChallenge(`<html><body>normal page</body></html>`), null);
  assert.equal(detectCloudflareChallenge(""), null);
  assert.equal(detectCloudflareChallenge(null), null);
});

// ---------- antiblock.mjs(反爬类型识别) ----------


test("antiblock: 识别 Cloudflare Turnstile / interstitial / 验证码", () => {
  assert.equal(detectAntibot(`<script>window._cf_chl_opt = {cType: 'interactive'}</script>`).type, "cloudflare-turnstile");
  assert.equal(detectAntibot(`<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/g/scripts/jsd/main.js"></script>`).type, "cloudflare-interstitial");
  assert.equal(detectAntibot(`<script src="https://www.google.com/recaptcha/api.js"></script>`).type, "captcha");
  assert.equal(detectAntibot(`<div class="g-recaptcha"></div>`).type, "captcha");
  assert.equal(detectAntibot(`<script src="https://hcaptcha.com/1/api.js"></script>`).type, "captcha");
});


test("antiblock: 识别 JS 倒计时 / 限流 / 封禁,普通页返回 null", () => {
  assert.equal(detectAntibot(`<p>You must enable JavaScript and manually proceed</p>`).type, "js-countdown");
  assert.equal(detectAntibot(`<h1>Too many requests. Please slow down.</h1>`).type, "rate-limit");
  assert.equal(detectAntibot(`<h1>访问过于频繁,请稍后再试</h1>`).type, "rate-limit");
  assert.equal(detectAntibot(`<h1>Access Denied</h1>`).type, "blocked");
  assert.equal(detectAntibot(`<html><body>normal page with results</body></html>`), null);
  assert.equal(detectAntibot(""), null);
  assert.equal(detectAntibot(null), null);
});


test("antiblock: 优先级 —— Turnstile cType 先于通用验证码,interstitial 先于封禁", () => {
  // 同时含 turnstile script 与 cType → 判交互挑战(更具体)
  const mixed = `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script><script>cType: 'managed'</script>`;
  assert.equal(detectAntibot(mixed).type, "cloudflare-turnstile");
  // interstitial 页含 access denied 字样 → 应判 CF 检查页而非通用封禁
  const both = `<title>Just a moment...</title><p>Access denied</p>`;
  assert.equal(detectAntibot(both).type, "cloudflare-interstitial");
});


test("browser: bezierPath 单调推进且不越界(n=1 边界)", () => {
  const p = bezierPath(0, 900, 10);
  assert.equal(p.length, 10);
  assert.ok(p.every((v) => v >= 0 && v <= 900), "插值点应在行程范围内");
  assert.ok(p[p.length - 1] === 900, "终点精确到达");
  assert.ok(p.every((v, i) => i === 0 || v >= p[i - 1]), "单调递增(无回退)");
  assert.deepEqual(bezierPath(100, 500, 1), [500], "n=1 直接返回终点");
});

