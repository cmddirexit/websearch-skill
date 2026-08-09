/** Chromium CLI rendering channel. */

import { spawn } from "node:child_process";
import {
  BROWSER_DEBUG_LOG,
  CLI_TIMEOUT_MS,
  STEALTH_LOCALE,
} from "../config.mjs";
import { appendDebugLog } from "../persist.mjs";

function extractErrorLine(stderr) {
  const lines = String(stderr || "").split(/\n/);
  const hit = lines.find(
    (line) => /ERROR|FATAL|FAILED|Segmentation|Traceback|ERR_/i.test(line) && !/inotify|dbus/i.test(line),
  );
  return hit ? hit.trim().slice(0, 160) : "";
}

/** Render one URL with a one-shot `chromium --dump-dom` process. */
export function getDomViaCli(bin, url, waitMs, ua, opts = {}) {
  const { virtualTime = true, timeoutMs } = opts;
  const waitBudget = virtualTime ? 0 : Math.max(timeoutMs || 30000, waitMs * 3);
  const killAfterMs = CLI_TIMEOUT_MS + (virtualTime ? 0 : waitBudget) + 5000;
  return new Promise((resolve, reject) => {
    const args = [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
      "--start-maximized",
      "--test-type",
      "--force-color-profile=srgb",
      "--font-render-hinting=none",
      "--fingerprinting-canvas-image-data-noise",
      `--lang=${STEALTH_LOCALE}`,
      `--user-agent=${ua}`,
      ...(virtualTime
        ? [`--virtual-time-budget=${Math.max(15000, waitMs * 3)}`]
        : [`--timeout=${waitBudget}`]),
      "--dump-dom",
      url,
    ];
    const child = spawn(bin, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const killTree = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Process group already exited.
      }
    };
    const timer = setTimeout(killTree, killAfterMs);
    process.on("exit", killTree);
    child.stdout.on("data", (chunk) => {
      if (stdout.length >= 40 * 1024 * 1024) {
        truncated = true;
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8192) stderr += chunk;
    });
    const cleanup = () => {
      clearTimeout(timer);
      process.removeListener("exit", killTree);
      killTree();
    };
    const failWith = (message) => {
      appendDebugLog(`URL: ${url}\ncmd: chromium ${args.join(" ")}\nexit: (见下)\nstderr(前 8192 字符):\n${stderr}\n--- 末尾 ---`);
      const diagnostic = extractErrorLine(stderr) || stderr.slice(0, 200) || "(无 stderr)";
      reject(new Error(`${message}: ${diagnostic} [调试日志: ${BROWSER_DEBUG_LOG}]`));
    };
    child.on("error", (error) => {
      cleanup();
      appendDebugLog(`URL: ${url}\ncmd: chromium ${args.join(" ")}\nspawn 错误: ${String(error.message)}\n--- 末尾 ---`);
      reject(new Error(`chromium CLI 启动失败: ${String(error.message).slice(0, 120)} [调试日志: ${BROWSER_DEBUG_LOG}]`));
    });
    child.on("close", (code) => {
      cleanup();
      if (stdout || truncated) return resolve(stdout);
      failWith(`chromium CLI 无输出(exit ${code})`);
    });
  });
}
