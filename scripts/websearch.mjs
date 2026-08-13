#!/usr/bin/env node
/**
 * websearch.mjs — CLI 入口(薄壳)
 * 实际逻辑见 lib/cli.mjs。此文件仅做入口转发,便于错误处理集中。
 */
import { main } from "./lib/cli.mjs";
import { closeBrowser } from "./lib/engines/browser.mjs";

main(process.argv.slice(2))
  .then(async () => {
    await closeBrowser().catch(() => {}); // 释放 puppeteer/playwright 共享浏览器实例,防 chromium 残留
    process.exit(0); // 浏览器兜底(puppeteer)会持有连接,成功也须显式退出
  })
  .catch(async (e) => {
    await closeBrowser().catch(() => {}); // 异常路径同样释放浏览器实例,防 chromium 残留
    console.error(`❌ 未捕获错误: ${e.message}`);
    process.exit(1);
  });
