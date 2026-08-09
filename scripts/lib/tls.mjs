/**
 * tls.mjs — TLS/HTTP2 指纹兜底(curl-impersonate 风格)
 *
 * 背景:Node 原生 fetch(undici)的 TLS 指纹(JA3/JA4)与真实 Chrome 完全不同,
 * Cloudflare 系站点 / 部分防火墙(Ecosia 403、Mojeek 网络层拦截、TLS 握手被
 * RST)按指纹直接拒绝 —— 纯 HTTP 头伪装救不回来。本模块在直连 fetch 失败
 * (403 / TLS 握手错误)时,用带浏览器 TLS 指纹的 curl 变体对同一 URL 重试:
 *
 *   后端 1:curl-impersonate 二进制(curl_chrome120 / curl-impersonate 等,
 *          按版本名内嵌指纹;generic 二进制用 --impersonate chrome120)
 *   后端 2:python3 + curl_cffi(pip 装,impersonate="chrome120",
 *          Termux aarch64 实测可用:curl_cffi-0.16.0-cp313-android wheel)
 *
 * 两个后端都不可用时静默返回 null,调用方(httpGet 的 catch 分支)行为零变化
 * —— 与浏览器兜底同样的\"可选增强\"哲学。可用性探测只做一次并缓存。
 *
 * 统一出口:
 *   - isImpersonateAvailable():任一后端可用(缓存)
 *   - httpGetViaImpersonate(url, {timeoutMs, headers}) → {status, setCookies, body} | null
 *   - isTlsFallbackCandidate(err):命中 403 / TLS 错误才值得兜底(纯函数,可单测)
 *   - parseCurlOutput(output):curl -i 多段输出 → {status, setCookies, body}(纯函数,可单测)
 *
 * 注意:本模块不 import http.mjs(避免循环依赖),headers 由调用方传入
 * (http.mjs 已在其中合并 Cookie 头);返回的 setCookies 由调用方喂回 cookie jar。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import {
  TLS_FALLBACK_TIMEOUT_MS,
  TLS_IMPERSONATE_TARGET,
  TLS_PYTHON_PROBE_TIMEOUT_MS,
  TLS_FAIL_FILE,
  TLS_FAIL_THRESHOLD,
  TLS_COOLDOWN_MS,
  REQ_HEADERS,
} from "./config.mjs";
import { createCooldown } from "./cooldown.mjs";

/** 默认头统一来自 config.mjs(与 http.mjs 的 REQ_HEADERS 同源,不再各自复制) */

// ==================== 后端可用性探测(缓存) ====================

/** curl-impersonate 二进制候选(按常见发布形态;generic 需 --impersonate 标志) */
const CURL_IMPERSONATE_NAMES = [
  "curl-impersonate", // 新版单一二进制(--impersonate chrome120)
  "curl_chrome", // 老版本化二进制(内嵌指纹,无需标志)
  "curl_chrome124",
  "curl_chrome120",
  "curl_chrome116",
  "curl_chrome110",
  "curl_chrome100",
  "curl_chrome99",
  "curl_chrome96",
  "curl_chrome80",
  "curl-impersonate-chrome", // Ubuntu PPA 风格(默认即 chrome)
];

let curlBinaryChecked = false;
let curlBinaryPath = null;

/** 探测 curl-impersonate 二进制(只做一次,结果缓存) */
function resolveCurlBinary() {
  if (curlBinaryChecked) return curlBinaryPath;
  curlBinaryChecked = true;
  const dirs = (process.env.PATH || "").split(":");
  for (const dir of dirs) {
    for (const name of CURL_IMPERSONATE_NAMES) {
      const p = join(dir, name);
      if (existsSync(p)) {
        curlBinaryPath = p;
        return curlBinaryPath;
      }
    }
  }
  return null;
}

let pythonChecked = false;
let pythonHasCurlCffi = false;

/** python3 -c "import curl_cffi" 可用性探测(只做一次,结果缓存;失败静默) */
async function probePythonCurlCffi() {
  if (pythonChecked) return pythonHasCurlCffi;
  pythonChecked = true;
  try {
    const { code } = await runPython(["-c", "import curl_cffi"], TLS_PYTHON_PROBE_TIMEOUT_MS);
    pythonHasCurlCffi = code === 0;
  } catch {
    pythonHasCurlCffi = false;
  }
  return pythonHasCurlCffi;
}

/** 任一后端可用? */
export async function isImpersonateAvailable() {
  if (resolveCurlBinary()) return true;
  return await probePythonCurlCffi();
}

// ==================== 失败记忆/冷却(硬拦站不白等) ====================
// 某些站是网络/IP 层硬拦(curl-impersonate 也救不回,如 mojeek 连 BoringSSL 握手都被 RST),
// 每次都等满 curl 超时(8-10s)纯属白费。复用通用冷却工具:域名连续失败达阈值 →
// 冷却 30 分钟(与引擎失败记忆同策略),期内 httpGetViaImpersonate 直接短路;成功清零。
const tlsCooldown = createCooldown({ threshold: TLS_FAIL_THRESHOLD, cooldownMs: TLS_COOLDOWN_MS, file: TLS_FAIL_FILE });

/** 该域名是否在冷却期(期内不再尝试 impersonate) */
export function isTlsHostCooled(host) {
  return tlsCooldown.isCooled(host);
}

/** 记录一次兜底失败(连续达阈值 → 冷却) */
export function recordTlsFailure(host) {
  tlsCooldown.mark(host, false);
}

/** 记录一次兜底成功(清零,恢复即重新参与) */
export function recordTlsSuccess(host) {
  tlsCooldown.mark(host, true);
}

/** 测试/手动:清空 TLS 冷却状态(含磁盘) */
export function resetTlsFailState() {
  tlsCooldown.reset();
}

/** 兜底结果记账:200 且非空 → 成功清零;非 200/空 → 失败累计(达阈值冷却) */
function noteResult(host, r) {
  if (!r) {
    recordTlsFailure(host);
    return null;
  }
  if (r.status === 200 && r.body) {
    recordTlsSuccess(host);
  } else {
    recordTlsFailure(host);
  }
  return r;
}

// ==================== 请求执行 ====================

/** 运行 python3,返回 {code, stdout, stderr}(超时 SIGKILL) */
function runPython(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn("python3", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return reject(e);
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* 已退出则忽略 */
      }
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < 8192) stderr += d;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * python curl_cffi 请求。stdout 输出与 curl -i 同构的"header 块 + 空行 + body",
 * 直接复用 parseCurlOutput:
 *   HTTP/1.1 <status> <reason>\n
 *   set-cookie: ...\n
 *   \n
 *   <body>
 */
async function impersonateViaPython(url, headers, timeoutMs) {
  const script = `
import json, sys
from curl_cffi import requests as cr
url, h, t = sys.argv[1], json.loads(sys.argv[2]), int(sys.argv[3])
try:
    r = cr.get(url, impersonate=${JSON.stringify(TLS_IMPERSONATE_TARGET)}, headers=h, timeout=t, allow_redirects=True)
except Exception as e:
    print("HTTP/1.1 0 ERROR")
    print("set-cookie: ")
    print()
    print(str(e)[:200])
    sys.exit(1)
print(f"HTTP/1.1 {r.status_code} OK")
seen = set()
for k, v in r.headers.items():
    if k.lower() == "set-cookie" and v not in seen:
        seen.add(v)
        print("set-cookie: " + v)
print()
print(r.text)
`;
  const { code, stdout } = await runPython(
    ["-c", script, url, JSON.stringify(headers), String(Math.max(5, Math.ceil(timeoutMs / 1000)))],
    timeoutMs + 2000,
  );
  if (code !== 0 || !stdout) return null;
  const parsed = parseCurlOutput(stdout);
  if (parsed.status === 0) return null; // 脚本自身报错(HTTP/1.1 0 ERROR)
  return parsed;
}

/** 判断该二进制是否 generic(需 --impersonate 标志):名字含版本号 → 已内嵌指纹 */
function needsImpersonateFlag(bin) {
  const name = basename(bin);
  if (/\d/.test(name)) return false; // curl_chrome120 等,内嵌指纹
  if (/impersonate-chrome$/.test(name)) return false; // PPA 风格默认 chrome
  return true; // curl-impersonate 单一二进制需 --impersonate
}

/** curl-impersonate 二进制请求(输出 -i 多段格式,parseCurlOutput 解析) */
function impersonateViaCurl(bin, url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = [
      "-sS",
      "-L", // 跟随重定向(header 块多段输出,-i)
      "-i",
      "--compressed",
      "-m",
      String(Math.max(5, Math.ceil(timeoutMs / 1000))),
    ];
    if (needsImpersonateFlag(bin)) args.push("--impersonate", TLS_IMPERSONATE_TARGET);
    for (const [k, v] of Object.entries(headers || {})) args.push("-H", `${k}: ${v}`);
    args.push(url);
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return reject(e);
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* 已退出则忽略 */
      }
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < 4096) stderr += d;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || !stdout) {
        reject(new Error(`curl-impersonate exit ${code}: ${stderr.slice(0, 120)}`));
        return;
      }
      resolve(parseCurlOutput(stdout));
    });
  });
}

// ==================== 解析(纯函数) ====================

/**
 * 解析 curl -i / curl_cffi 的统一输出。
 * 格式:若干段 \"HTTP/1.1 ...\\r\\n...header...\\r\\n\\r\\n\" + body(HTML 本身可能含空行,
 * 所以按空行分段后,最后一个匹配 HTTP 状态行的段 = 最终响应的 header 块,
 * 其后的所有段都是 body,拼接还原)。
 * - 状态:取最后一个 header 块的 HTTP 行(重定向后是最终状态)
 * - set-cookie:所有 header 块全收集(重定向途中种下的 cookie 也要进 jar)
 */
export function parseCurlOutput(output) {
  const segments = output.split(/\r?\n\r?\n/);
  let lastHeaderIdx = -1;
  for (let i = 0; i < segments.length; i++) {
    if (/^HTTP\/\S+\s+\d{3}/m.test(segments[i])) lastHeaderIdx = i;
  }
  let status = 0;
  const setCookies = [];
  for (let i = 0; i < segments.length; i++) {
    const isHeaderBlock = i === lastHeaderIdx || /^HTTP\/\S+\s+\d{3}/m.test(segments[i]);
    for (const line of segments[i].split(/\r?\n/)) {
      const m = /^HTTP\/\S+\s+(\d{3})/.exec(line.trim());
      if (m) status = Number(m[1]);
      else if (/^set-cookie:/i.test(line)) setCookies.push(line.replace(/^set-cookie:\s*/i, "").trim());
    }
  }
  const body = lastHeaderIdx >= 0 ? segments.slice(lastHeaderIdx + 1).join("\n\n") : "";
  return { status, setCookies, body };
}

/** 命中候选失败模式(403 / TLS 指纹拦截)才值得走 impersonate 兜底(纯函数) */
export function isTlsFallbackCandidate(err) {
  if (!err) return false;
  if (typeof err.status === "number") return err.status === 403;
  const msg = String(err?.message || err?.code || "");
  // ECONNRESET/EPROTO:握手被对端 RST(Cloudflare 指纹拦截的典型信号);
  // CERT_*/SSL/TLS/HANDSHAKE:证书或协议层拦截。除字面枚举外也匹配人类可读形式
  // (OpenSSL 报 "certificate has expired" 而非 "CERT_HAS_EXPIRED",漏了会把 TLS 拦截误判为普通 404)
  return /ECONNRESET|EPROTO|CERT_HAS_EXPIRED|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_SSL|TLS|HANDSHAKE|expired|self-signed|unable to verify/i.test(
    msg,
  );
}

// ==================== 统一出口 ====================

/**
 * 用浏览器 TLS 指纹重试请求。
 * 冷却期内的域名直接返回 null(不启动后端);尝试过但未拿到 200 正文 → 记失败。
 * @param {string} url
 * @param {object} [opts] { timeoutMs, headers(已含 Cookie 头) }
 * @returns {Promise<{status:number, setCookies:string[], body:string}|null>} 后端不可用/冷却/失败 → null
 */
export async function httpGetViaImpersonate(url, { timeoutMs = TLS_FALLBACK_TIMEOUT_MS, headers = {} } = {}) {
  const host = new URL(url).host;
  if (isTlsHostCooled(host)) return null; // 硬拦站冷却期:快速失败,不白等 curl
  const h = { ...REQ_HEADERS, ...headers };
  let attempted = false;
  const bin = resolveCurlBinary();
  if (bin) {
    attempted = true;
    try {
      return noteResult(host, await impersonateViaCurl(bin, url, h, timeoutMs));
    } catch {
      /* 二进制失败不阻塞 python 后端,继续 */
    }
  }
  if (await probePythonCurlCffi()) {
    attempted = true;
    try {
      return noteResult(host, await impersonateViaPython(url, h, timeoutMs));
    } catch {
      /* 兜底失败,走下方记失败 */
    }
  }
  if (attempted) recordTlsFailure(host); // 尝试过但全部失败
  return null;
}
