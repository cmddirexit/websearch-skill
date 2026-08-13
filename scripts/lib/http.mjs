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
  WECHAT_UA,
  WECHAT_REFERER,
} from "./config.mjs";
import { httpGetViaImpersonate, isTlsFallbackCandidate } from "./tls.mjs";
import { atomicWriteJsonSync } from "./state-file.mjs";
import { validateFetchUrl } from "./url-safety.mjs";

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
/** lastRequestAt 上限:库模式长跑下同域限速记忆 Map 只增不减,超限清理最旧条目 */
const MAX_HOST_STATE = 2000;

async function waitForRateLimit(url) {
  const host = new URL(url).host;
  const prev = pendingHosts.get(host) || Promise.resolve();
  const next = prev.then(async () => {
    const wait = computeRateLimitDelay(lastRequestAt.get(host) || 0, Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt.set(host, Date.now());
  });
  // 链尾吞错,防止某个请求失败导致后续请求永远等不到(链内逻辑不会 reject,防御性处理)
  const chained = next.catch(() => {});
  pendingHosts.set(host, chained);
  // 链完成后清理:该 host 无新请求排队时移除链尾,防 Map 无限膨胀(库模式长跑)
  chained.finally(() => {
    if (pendingHosts.get(host) === chained) pendingHosts.delete(host);
  });
  // lastRequestAt 只增不减 → 超限清理最旧(限速记忆,偶尔漏一次无害)
  if (lastRequestAt.size > MAX_HOST_STATE) {
    lastRequestAt.delete(lastRequestAt.keys().next().value);
  }
  await next;
}

// ==================== Cookie jar(会话持久化) ====================
// 结构: Map<host, Map<name, {value, expiresAt}>>
const cookieJar = new Map();

/** 解析一条 set-cookie 头: "name=value; Path=...; Expires=...; Domain=..." →
 * {name, value, expiresAt, domain}。domain 为裸域名(去掉前导点);无 Domain 字段时为空串
 * (表示仅当前 host 有效)。 */
export function parseSetCookieLine(line) {
  const parts = line.split(";");
  const first = (parts[0] || "").split("=");
  const name = (first[0] || "").trim();
  if (!name) return null;
  const value = first.slice(1).join("=").trim();
  let expiresAt = 0; // 0 = 会话 cookie(本进程有效)
  let domain = "";
  for (const p of parts.slice(1)) {
    const [k, ...v] = p.trim().split("=");
    const val = v.join("=");
    if (/^expires$/i.test(k)) {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) expiresAt = t;
    } else if (/^max-age$/i.test(k)) {
      const s = Number(val);
      if (!Number.isNaN(s)) expiresAt = Date.now() + s * 1000;
    } else if (/^domain$/i.test(k)) {
      domain = val.replace(/^\./, "").trim();
    }
  }
  return { name, value, expiresAt, domain };
}

/** 把响应的 set-cookie 合并进 jar。带 Domain 字段的 cookie 存到 ".domain" key
 * (匹配自身及所有子域,见 getCookieHeaderFor 的域名级匹配);无 Domain 的存精确 host。 */
export function updateCookieJarForResponse(url, setCookieHeaders) {
  if (!setCookieHeaders?.length) return;
  const host = new URL(url).host;
  for (const line of setCookieHeaders) {
    const c = parseSetCookieLine(line);
    if (!c) continue;
    const key = c.domain ? `.${c.domain}` : host;
    let target = cookieJar.get(key);
    if (!target) {
      target = new Map();
      cookieJar.set(key, target);
    }
    target.set(c.name, { value: c.value, expiresAt: c.expiresAt });
  }
}

/** 拼出请求用的 Cookie 头("a=1; b=2"),自动过滤过期项。
 * 支持域名级 cookie:jar 里以 "." 开头的 key(如 ".zhihu.com")匹配自身及所有子域
 * (标准 cookie Domain 语义),供 WEBSEARCH_COOKIES 注入登录态用;精确 host 后合并,
 * 同名时精确 host 覆盖域名级(与浏览器行为一致)。 */
export function getCookieHeaderFor(url) {
  const host = new URL(url).host;
  const now = Date.now();
  const merged = new Map();
  const addFrom = (hostCookies) => {
    for (const [name, c] of hostCookies) {
      if (c.expiresAt && c.expiresAt < now) continue; // 过期
      merged.set(name, c.value);
    }
  };
  // 域名级 cookie 先加,精确 host 后加(同名覆盖)
  for (const [domain, hostCookies] of cookieJar) {
    if (!domain.startsWith(".")) continue;
    if (host === domain.slice(1) || host.endsWith(domain)) addFrom(hostCookies);
  }
  const exact = cookieJar.get(host);
  if (exact) addFrom(exact);
  return [...merged].map(([name, value]) => `${name}=${value}`).join("; ");
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

// 进程退出时强制 flush 节流窗口内的 cookie(同步写,CLI 短跑场景不丢会话)。
// 用 exit 而非 beforeExit:exit 阶段只能同步写,且 cookie 文件仅几 KB,同步开销可忽略;
// beforeExit 会在事件循环反复清空时多次触发,需额外防重入,得不偿失。
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
// 自定义 Cookie 注入(登录墙站绕过):WEBSEARCH_COOKIES 环境变量,JSON 格式
// {"www.zhihu.com":"d_c0=xx; z_c0=yy", ".zhihu.com":"..."} —— 手动登录站点后从浏览器
// 导出 Cookie 填入,直连即带登录态,绕过知乎 40362 等登录/会话风控。
// host 支持精确域名与 ".domain" 域名级(后者对子域都生效)。expiresAt=0 表示会话级
// (不设过期,仅当次运行有效),同时随 jar 持久化可跨进程复用(受 COOKIE_TTL 24h 限制)。
function loadCustomCookies() {
  const raw = process.env.WEBSEARCH_COOKIES;
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    for (const [host, cookieStr] of Object.entries(parsed)) {
      if (typeof cookieStr !== "string" || !cookieStr.trim()) continue;
      const hostCookies = new Map();
      for (const part of cookieStr.split(";")) {
        const idx = part.indexOf("=");
        if (idx <= 0) continue;
        const name = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        if (name) hostCookies.set(name, { value, expiresAt: 0 });
      }
      if (hostCookies.size) cookieJar.set(host, hostCookies);
    }
  } catch {
    /* 自定义 cookie 格式错误不影响主流程(静默,避免每次启动报错) */
  }
}
loadCustomCookies();

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
 * 站点专属请求头覆盖:按 host 切换 UA/Referer 等,绕过站点对特定 UA 的风控。
 * mp.weixin.qq.com 对普通浏览器 UA 会弹"环境异常"验证码,对微信内置浏览器 UA
 * 则正常返回正文(微信内分享即靠此 UA)—— 这是微信公众号文章抓取的稳定通道。
 * 返回新对象,不改动调用方 headers。
 */
function siteHeaders(url, headers) {
  const host = new URL(url).host;
  if (host === "mp.weixin.qq.com" || host.endsWith(".mp.weixin.qq.com")) {
    return { ...headers, "User-Agent": WECHAT_UA, Referer: WECHAT_REFERER };
  }
  return headers;
}

// ==================== 知乎 d_c0 预热 ====================
// 知乎网页版风控要求 d_c0(匿名身份 cookie);未带时部分页面/接口返回 40362。
// d_c0 可通过 POST /udid 匿名获取(无需登录,有效期 3 年),响应 Set-Cookie 直接下发。
// 预热策略:对 zhihu.com 的请求,若 jar 里尚无 d_c0 则先 POST /udid 一次(并发去重),
// d_c0 经 updateCookieJarForResponse 存到 ".zhihu.com"(Domain 级),对所有子域生效,
// 并随 jar 持久化复用 —— 后续请求直接命中,不再重复预热。
let zhihuUdidWarmup = null;
async function warmupZhihuUdidd() {
  if (!zhihuUdidWarmup) {
    zhihuUdidWarmup = (async () => {
      try {
        const res = await fetch("https://www.zhihu.com/udid", {
          method: "POST",
          headers: { "User-Agent": UA, Referer: "https://www.zhihu.com/" },
          signal: timeoutSignal(PROBE_TIMEOUT_MS),
        });
        if (res.ok) {
          updateCookieJarForResponse("https://www.zhihu.com/udid", res.headers.getSetCookie?.() || []);
          persistCookieJar();
        }
      } catch {
        /* 预热失败不影响主请求(直连照旧,失败再走降级链) */
      }
    })().finally(() => {
      zhihuUdidWarmup = null;
    });
  }
  return zhihuUdidWarmup;
}

/** 对知乎域请求,若尚无 d_c0 则预热一次(匿名身份,提升未登录抓取成功率)。 */
async function warmupZhihuForHost(url) {
  const host = new URL(url).host;
  if (host !== "zhihu.com" && !host.endsWith(".zhihu.com")) return;
  if (/d_c0=/.test(getCookieHeaderFor(url))) return; // 已有 d_c0,跳过
  await warmupZhihuUdidd();
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

/** 重定向后地址二次校验:fetch 的 redirect:follow 会静默跟随重定向,攻击者可让公网 URL
 * 302 到内网/本地地址,绕过调用方对初始 URL 的校验(盲 SSRF)。此处用同一校验器
 * (url-safety.mjs)拦下非公网/带凭据/非 http(s) 的最终落地地址。属于事后校验:
 * 请求已发出但响应被拒,攻击者拿不到内网内容,残余探测风险大幅降低。 */
function assertSafeFinalUrl(originalUrl, finalUrl) {
  if (!finalUrl || finalUrl === originalUrl) return; // 未发生重定向
  validateFetchUrl(finalUrl);
}

/**
 * GET 请求返回文本。
 * @param {string} url
 * @param {object} [opts] { timeoutMs, headers }
 * @returns {Promise<string>} HTML 文本
 * @throws {Error} 非 2xx 或超时
 */
export async function httpGet(url, { timeoutMs = HTTP_TIMEOUT_MS, headers = REQ_HEADERS } = {}) {
  headers = siteHeaders(url, headers);
  await warmupZhihuForHost(url);
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
    assertSafeFinalUrl(url, res.url || url);
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
  headers = siteHeaders(url, headers);
  await warmupZhihuForHost(url);
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
    assertSafeFinalUrl(url, res.url || url);
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
