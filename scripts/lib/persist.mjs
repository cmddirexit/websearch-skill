/**
 * persist.mjs — 跨进程基础设施(CF 站点记忆 / 页面缓存 / 浏览器调试日志 / URL 工具)
 *
 * 职责边界:一切“落盘状态”与轻量工具收敛于此,业务模块(browser/cli)只 import 调用,
 * 不各自实现文件读写。所有函数接受可选 baseDir 参数 —— 默认 CACHE_DIR,测试可注入
 * 临时目录隔离(不污染真实缓存)。
 *
 * 文件布局(~/.cache/ 下):
 *   websearch-cf-sites.json      已知 CF 类站点域名集合(真实等待轮/zendriver 成功过)
 *   websearch-page-cache/<sha1>.json 页面提取结果缓存(6h TTL)
 *   websearch-browser-debug.log  CLI 失败完整 stderr 诊断
 */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { CACHE_DIR, BROWSER_DEBUG_LOG, PAGE_CACHE_TTL_MS } from "./config.mjs";

/* ---------- URL 小工具(与业务解耦,后续可独立成 url-utils) ---------- */

/** 提取 URL hostname;非法 URL 返回空串(调用方自行处理) */
export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/* ---------- CF 站点记忆 ---------- */

const cfSitesFile = (base) => `${base}/websearch-cf-sites.json`;

/** 该域名是否记忆为“CF 类站点”(真实等待轮/zendriver 成功过) */
export function isKnownCfHost(host, baseDir = CACHE_DIR) {
  try {
    return JSON.parse(readFileSync(cfSitesFile(baseDir), "utf8")).includes(host);
  } catch {
    return false;
  }
}

/** 标记域名(幂等);落盘失败不影响主流程 */
export function markCfHost(host, baseDir = CACHE_DIR) {
  try {
    mkdirSync(baseDir, { recursive: true });
    let arr = [];
    try {
      arr = JSON.parse(readFileSync(cfSitesFile(baseDir), "utf8"));
    } catch {
      arr = [];
    }
    if (!arr.includes(host)) {
      arr.push(host);
      writeFileSync(cfSitesFile(baseDir), JSON.stringify(arr));
    }
  } catch { /* 落盘失败不影响主流程 */ }
}

/* ---------- 页面级缓存(6h TTL,同一 URL 重复抓取秒回) ---------- */

function pageCacheKey(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return createHash("sha1").update(u.href).digest("hex");
  } catch {
    return createHash("sha1").update(String(url)).digest("hex");
  }
}
function pageCacheFile(baseDir, url) {
  return `${baseDir}/websearch-page-cache/${pageCacheKey(url)}.json`;
}

/** 命中且未过期返回缓存结果,否则 null */
export function pageCacheGet(url, baseDir = CACHE_DIR) {
  try {
    const d = JSON.parse(readFileSync(pageCacheFile(baseDir, url), "utf8"));
    if (Date.now() - d.savedAt < PAGE_CACHE_TTL_MS) return d.r;
  } catch { /* 无缓存/损坏 */ }
  return null;
}

/** 写缓存(幂等);失败不影响主流程 */
export function pageCachePut(url, r, baseDir = CACHE_DIR) {
  try {
    const dir = `${baseDir}/websearch-page-cache`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/${pageCacheKey(url)}.json`, JSON.stringify({ savedAt: Date.now(), r }));
  } catch { /* 缓存写失败不影响主流程 */ }
}

/* ---------- 浏览器调试日志(CLI 失败完整 stderr 落盘,可回溯定位) ---------- */

/** 追加一条调试日志(同步写,进程退出前已落盘);失败静默 */
export function appendDebugLog(entry, file = BROWSER_DEBUG_LOG) {
  try {
    mkdirSync(file.replace(/\/[^/]+$/, ""), { recursive: true });
    appendFileSync(file, `\n=== ${new Date().toISOString()} ===\n${entry}\n`);
  } catch { /* 落盘失败不影响主流程 */ }
}
