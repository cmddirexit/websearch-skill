/** Optional zendriver rendering channel for Cloudflare-protected sites. */

import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { ZD_PROBE_TIMEOUT_MS, ZD_SOLVER_TIMEOUT_MS } from "../config.mjs";
import { dbg } from "../debug.mjs";
import { resolveChromiumPath } from "./browser-runtime.mjs";

const execFile = promisify(execFileCallback);
const ZD_SOLVER = new URL("./zd_solver.py", import.meta.url).pathname;
let checked = false;
let available = false;

function zendriverAvailable() {
  if (checked) return available;
  checked = true;
  try {
    execFileSync("python3", ["-c", "import zendriver"], {
      timeout: ZD_PROBE_TIMEOUT_MS,
      stdio: "ignore",
    });
    available = true;
  } catch {
    available = false;
  }
  return available;
}

export async function getDomViaZendriver(url) {
  if (!zendriverAvailable()) {
    dbg("zendriver 不可用(未安装 python 包) → 跳过");
    return null;
  }
  const bin = resolveChromiumPath();
  if (!bin) {
    dbg("zendriver 不可用(未找到 chromium) → 跳过");
    return null;
  }
  const startedAt = Date.now();
  try {
    const { stdout } = await execFile("python3", [ZD_SOLVER, url, "60", bin], {
      timeout: ZD_SOLVER_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const result = JSON.parse(stdout);
    dbg(`zendriver 返回: ok=${result.ok} elapsed=${result.elapsed ?? "?"}s html=${(result.html || "").length}字符 err=${result.error || "-"} (共${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
    if (result.ok && result.html) return result.html;
    console.error(`[zd] solver 失败: ${result.error || "无输出"}`);
  } catch (error) {
    dbg(`zendriver 通道异常(${String(error.message).slice(0, 80)}) 共${((Date.now() - startedAt) / 1000).toFixed(1)}s → 返回 null`);
    console.error(`[zd] zendriver 通道不可用: ${String(error.message).slice(0, 120)}`);
    try {
      execFileSync("pkill", ["-9", "-f", "websearch-zd-profile"], { stdio: "ignore" });
    } catch {
      // No matching orphan process.
    }
  }
  return null;
}
