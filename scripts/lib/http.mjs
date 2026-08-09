/**
 * http.mjs — HTTP 请求封装
 * 统一管理 UA、超时、重定向、同域限速、Cookie 会话持久化,所有引擎共用。
 * 常量集中在 config.mjs,此处 re-export UA 保持 index.mjs 兼容。
 */

import { readFileSync } from "node:fs";
import { connect } from "node:net";
import {
  UA,
  REQ_HEADERS,
  HTTP_TIMEOUT_MS,
  HTTP_FULL_TIMEOUT_MS,
  DOMAIN_RATE_LIMIT_MS,
  COOKIE_FILE,
  COOKIE_TTL_MS,
  PROBE_TIMEOUT_MS,
  TLS_FALLBACK_ENABLED,
} from "./config.mjs";
import { httpGetViaImpersonate, isTlsFallbackCandidate } from "./tls.mjs";
import { atomicWriteJsonSync } from "./state-file.mjs";

// re-export 保持 index.mjs 兼容(外部仍可从 "./http.mjs" 拿 REQ_HEADERS)
export { REQ_HEADERS };
export { UA };

// ==================== 同域限速(礼貌爬取) ====================
const lastRequestAt = new Map(); // host -> 上次请求时间戳
const pendingHosts = new Map(); // host -> Promise 链尾(同域请求串行化)

/** 计算还需等待的毫秒数(纯函数,便于测试) */
export function computeRateLimitDelay(last, now, minInterval = DOMAIN_RATE_LIMIT_MS) {
  return Math.max(0, minInterval - (now - last));
}

/**
 * 同域限速:同 host 的请求严格串行化,后一个在前一个完成后按间隔等待。
 * 用 per-host promise 链实现原子性,并发同域请求不会同时通过检查(否则限速失效)。
 */
async function waitForRateLimit(url) {
  const host = new URL(url).host;
  const prev = pendingHosts.get(host) || Promise.resolve();
  const next = prev.then(async () => {
    const wait = computeRateLimitDelay(lastRequestAt.get(host) || 0, Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt.set(host, Date.now());
  });
  // 链尾吞错,防止某个请求失败导致后续请求永远等不到(链内逻辑不会 reject,防御性处理)
  pendingHosts.set(host, next.catch(() => {}));
  await next;
}

// ==================== Cookie jar(会话持久化) ====================
// 结构: Map<host, Map<name, {value, expiresAt}>>
const cookieJar = new Map();

/** 解析一条 set-cookie 头: "name=value; Path=...; Expires=..." → {name, value, expiresAt} */
export function parseSetCookieLine(line) {
  const parts = line.split(";");
  const first = (parts[0] || "").split("=");
  const name = (first[0] || "").trim();
  if (!name) return null;
  const value = first.slice(1).join("=").trim();
  let expiresAt = 0; // 0 = 会话 cookie(本进程有效)
  for (const p of parts.slice(1)) {
    const [k, ...v] = p.trim().split("=");
    const val = v.join("=");
    if (/^expires$/i.test(k)) {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) expiresAt = t;
    } else if (/^max-age$/i.test(k)) {
      const s = Number(val);
      if (!Number.isNaN(s)) expiresAt = Date.now() + s * 1000;
    }
  }
  return { name, value, expiresAt };
}

/** 把响应的 set-cookie 合并进 jar */
export function updateCookieJarForResponse(url, setCookieHeaders) {
  if (!setCookieHeaders?.length) return;
  const host = new URL(url).host;
  let hostCookies = cookieJar.get(host);
  if (!hostCookies) {
    hostCookies = new Map();
    cookieJar.set(host, hostCookies);
  }
  for (const line of setCookieHeaders) {
    const c = parseSetCookieLine(line);
    if (!c) continue;
    hostCookies.set(c.name, { value: c.value, expiresAt: c.expiresAt });
  }
}

/** 拼出请求用的 Cookie 头("a=1; b=2"),自动过滤过期项 */
export function getCookieHeaderFor(url) {
  const host = new URL(url).host;
  const hostCookies = cookieJar.get(host);
  if (!hostCookies) return "";
  const now = Date.now();
  const pairs = [];
  for (const [name, c] of hostCookies) {
    if (c.expiresAt && c.expiresAt < now) continue; // 过期
    pairs.push(`${name}=${c.value}`);
  }
  return pairs.join("; ");
}

// ---- 磁盘持久化(跨 CLI 运行共享,模拟"老访客") ----
// 节流:高频请求(聚合 7 引擎)不每次同步写盘,30s 间隔批量写;进程退出时兜底 flush
const COOKIE_PERSIST_INTERVAL_MS = 30_000;
let lastPersistAt = 0;

function persistCookieJar() {
  const now = Date.now();
  if (now - lastPersistAt < COOKIE_PERSIST_INTERVAL_MS) return;
  lastPersistAt = now;
  try {
    const out = {};
    for (const [host, hostCookies] of cookieJar) {
      const valid = [...hostCookies]
        .filter(([, c]) => !c.expiresAt || c.expiresAt > now)
        // savedAt = 本次写入时间:加载时据此做整体 TTL(旧文件无 savedAt → 视为过期,一次性清理)
        .map(([name, c]) => ({ name, value: c.value, expiresAt: c.expiresAt, savedAt: now }));
      if (valid.length) out[host] = valid;
    }
    atomicWriteJsonSync(COOKIE_FILE, out, { mode: 0o600 });
  } catch {
    /* 持久化失败不阻塞请求 */
  }
}

// 进程退出时强制 flush 节流窗口内的 cookie(同步写,CLI 短跑场景不丢会话)
process.on("exit", () => {
  lastPersistAt = 0; // 绕过节流窗口
  persistCookieJar();
});

function loadCookieJar() {
  try {
    const raw = JSON.parse(readFileSync(COOKIE_FILE, "utf8"));
    const now = Date.now();
    for (const [host, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue;
      const hostCookies = new Map();
      for (const c of list) {
        // savedAt 缺失(旧文件) → 按 0 处理,首次加载即被 TTL 清理(会话 cookie 不再永久存活)
        if (now - (typeof c.savedAt === "number" ? c.savedAt : 0) > COOKIE_TTL_MS) continue; // 整体 TTL
        if (c.expiresAt && c.expiresAt < now) continue;
        hostCookies.set(c.name, { value: c.value, expiresAt: c.expiresAt });
      }
      if (hostCookies.size) cookieJar.set(host, hostCookies);
    }
  } catch {
    /* 无缓存文件 → 空 jar */
  }
}
loadCookieJar();

// ==================== 请求 ====================

/** 生成带超时的 AbortSignal */
export function timeoutSignal(ms = HTTP_TIMEOUT_MS) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  t.unref?.(); // 库模式长跑:计时器不拖住进程退出(fetch 本身持有事件循环)
  return c.signal;
}

/**
 * 合并 Cookie 头到请求头(不改动调用方传入的对象)。
 * 注意:headers 可能带自定义 UA(如 baidu 移动端),Cookie 独立追加。
 */
function withCookieHeader(url, headers) {
  const cookie = getCookieHeaderFor(url);
  if (!cookie) return headers;
  return { ...headers, Cookie: cookie };
}

/**
 * TLS 指纹兜底:直连 fetch 命中候选失败模式(403/TLS 拦截)且 curl-impersonate/
 * curl_cffi 可用时,用浏览器指纹重试同一请求。成功 → 返回 body(并把重定向途中
 * 的 set-cookie 喂回 jar);失败/不可用 → null,调用方原样重抛。
 */
async function tryTlsFallback(err, url, headers, timeoutMs) {
  if (!TLS_FALLBACK_ENABLED) return null;
  if (!isTlsFallbackCandidate(err)) return null;
  const out = await httpGetViaImpersonate(url, { timeoutMs, headers: withCookieHeader(url, headers) });
  // 只有拿到 200 正文才算兜底成功(impersonate 返回 403/429 等同样视为失败,
  // 否则 403 页面会被误当成功返回 —— mojeek 实测踩过这个坑)
  if (!out || !out.body || out.status !== 200) return null;
  updateCookieJarForResponse(url, out.setCookies);
  persistCookieJar();
  return out.body;
}

/**
 * GET 请求返回文本。
 * @param {string} url
 * @param {object} [opts] { timeoutMs, headers }
 * @returns {Promise<string>} HTML 文本
 * @throws {Error} 非 2xx 或超时
 */
export async function httpGet(url, { timeoutMs = HTTP_TIMEOUT_MS, headers = REQ_HEADERS } = {}) {
  await waitForRateLimit(url);
  try {
    const res = await fetch(url, {
      headers: withCookieHeader(url, headers),
      signal: timeoutSignal(timeoutMs),
      redirect: "follow",
    });
    if (!res.ok) {
      const e = new Error(`HTTP ${res.status} (${url})`);
      e.status = res.status;
      // 附加响应体(限 8KB):403/验证码页的 body 含反爬类型特征(Cloudflare Turnstile 等),
      // cli.mjs 用它做 detectAntibot 识别,让降级日志带上具体类型而非笼统“fetch failed”
      try {
        const rb = await res.text();
        if (rb) e.body = rb.slice(0, 8000);
      } catch { /* body 不可读(连接中断等)则忽略 */ }
      throw e;
    }
    updateCookieJarForResponse(res.url || url, res.headers.getSetCookie?.() || []);
    persistCookieJar();
    return await res.text();
  } catch (e) {
    const body = await tryTlsFallback(e, url, headers, timeoutMs);
    if (body !== null) return body;
    throw e;
  }
}

/**
 * GET 请求返回完整响应(需读取 body 与 content-type)。
 * @returns {Promise<{status:number, contentType:string, finalUrl:string, body:string}>}
 */
export async function httpGetFull(url, { timeoutMs = HTTP_FULL_TIMEOUT_MS, headers = REQ_HEADERS } = {}) {
  await waitForRateLimit(url);
  try {
    const res = await fetch(url, {
      headers: withCookieHeader(url, headers),
      signal: timeoutSignal(timeoutMs),
      redirect: "follow",
    });
    if (!res.ok) {
      const e = new Error(`HTTP ${res.status} (${url})`);
      e.status = res.status;
      // 附加响应体(限 8KB):供 cli.mjs detectAntibot 识别反爬类型(同 httpGet)
      try {
        const rb = await res.text();
        if (rb) e.body = rb.slice(0, 8000);
      } catch { /* body 不可读则忽略 */ }
      throw e;
    }
    updateCookieJarForResponse(res.url || url, res.headers.getSetCookie?.() || []);
    persistCookieJar();
    const body = await res.text();
    return {
      status: res.status,
      contentType: (res.headers.get("content-type") || "").toLowerCase(),
      finalUrl: res.url || url,
      body,
    };
  } catch (e) {
    const body = await tryTlsFallback(e, url, headers, timeoutMs);
    if (body !== null) {
      return { status: 200, contentType: "text/html", finalUrl: url, body };
    }
    throw e;
  }
}

/**
 * TCP 连通性探测:host:port 能建立连接即视为可达(超时即失败),聚合前预检用。
 * @param {string} host
 * @param {number} [port=443]
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export function tcpProbe(host, port = 443, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let sock;
    try {
      sock = connect({ host, port });
    } catch {
      return resolve(false);
    }
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
  });
}

/**
 * GET JSON API(github/hn/wikipedia 等 JSON API 引擎统一入口)。
 * 复用 httpGet 的同域限速/Cookie/超时/重定向层,避免各引擎手写原生 fetch + AbortSignal。
 * 默认 Accept: application/json(调用方可覆盖,如 github 的 application/vnd.github+json)。
 * @param {string} url
 * @param {object} [opts] { timeoutMs, headers }
 * @returns {Promise<any>} 解析后的 JSON
 * @throws {Error} 非 2xx 或 JSON 解析失败
 */
export async function httpGetJson(url, { timeoutMs = HTTP_TIMEOUT_MS, headers = {} } = {}) {
  const body = await httpGet(url, {
    timeoutMs,
    headers: { Accept: "application/json", ...headers },
  });
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`JSON 解析失败 (${url.slice(0, 80)})`);
  }
}
