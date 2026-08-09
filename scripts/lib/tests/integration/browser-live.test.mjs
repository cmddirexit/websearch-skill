// integration/browser-live.test.mjs — 真实 Chromium 反检测验证
// 慢:启动无头浏览器,默认不随 npm test 跑
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveChromiumPath, isBrowserAvailable, getDom, closeBrowser } from "../../engines/browser.mjs";

test("browser: CLI 模式 --disable-blink-features=AutomationControlled 同样去掉 webdriver", { skip: !resolveChromiumPath() }, async () => {
  // 直接起 chromium CLI(--dump-dom),验证 blink 层标志对 data: URL 生效(与 getDomViaCli 同参数)
  const { execFile } = await import("node:child_process");
  const bin = resolveChromiumPath();
  const url = 'data:text/html,<script>document.title="wd=" + navigator.webdriver</script>';
  const html = await new Promise((resolve, reject) => {
    execFile(
      bin,
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--virtual-time-budget=3000",
        "--dump-dom",
        url,
      ],
      { timeout: 20_000, maxBuffer: 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
  // 库模式 init 脚本 → undefined;CLI 模式 blink 标志在 Chromium 149 上 → false(同样不可自动化)
  assert.match(html, /<title>wd=(undefined|false)<\/title>/, `CLI 层 webdriver 应被抹掉,实际: ${html.slice(0, 120)}`);
});

// ---------- tls.mjs 冷却(硬拦站不白等) ----------

test(
  "browser: stealth 注入后 navigator.webdriver 为 undefined(浏览器可用时;CLI 标志同效)",
  { skip: !resolveChromiumPath() },
  async () => {
    if (!(await isBrowserAvailable())) return; // 双保险:二进制存在但不可启动则跳过
    try {
      const html = await getDom(
        'data:text/html,<script>document.title="wd=" + navigator.webdriver + "|langs=" + (navigator.languages||[]).length</script>',
        0,
      );
      assert.match(html, /<title>wd=undefined\|langs=[1-9]\d*<\/title>/, `webdriver 应被抹掉,实际: ${html.slice(0, 120)}`);
    } finally {
      await closeBrowser(); // 共享浏览器实例持有 CDP 连接,不关会拖住测试进程退出
    }
  },
);


