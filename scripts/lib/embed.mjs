/**
 * embed.mjs — 语义嵌入层(API 优先,本地 WASM 兜底)
 *
 * 设计:默认走 OpenAI 兼容嵌入 API(硅基流动 Qwen3-Embedding-8B,MTEB 多语言榜首);
 * 无 key/API 失败时降级本地 WASM(已安装时);都不行返回 {available:false},
 * 聚类自动降级短语模式 —— 与浏览器兜底同一"可用即增强,不可用即降级"模式。
 *
 * 环境变量:
 *   SILICONFLOW_API_KEY=     API key(或技能目录 .env.json,chmod 600)
 *   SILICONFLOW_API_BASE=    OpenAI 兼容基址(默认 https://api.siliconflow.cn/v1)
 *   SILICONFLOW_EMBED_MODEL= 模型(默认 Qwen/Qwen3-Embedding-8B,4096 维;可换 BAAI/bge-m3)
 *   EMBED_API_DIMENSIONS=    MRL 输出维度压缩(默认 1024,几乎无损省 4 倍;0=不压缩)
 *   WEBSEARCH_EMBED_BACKEND= api|local|wasm 强制后端
 *   WEBSEARCH_EMBED_MODEL=   本地模型名(仅 local/wasm 兜底用)
 *
 * API 韧性(与 aggregate.mjs 引擎失败记忆同模式):
 *   429/5xx/网络错误 → 退避重试(3 次,间隔递增);连续失败 2 次 → 冷却 5 分钟,
 *   冷却期内不再请求(限流/故障时避免每次搜索都白等 + 雪上加霜),成功自动恢复。
 *   查询向量会话内缓存:同一查询重复搜索(agent 调参/重跑)复用,少一次 API 调用
 *   (结果向量不缓存 —— 实测 34 条截断文本唯一率 100%,跨查询几乎不命中)。
 *
 * 本地 WASM(Termux/Android 历史方案,默认不用;如启用见 setup-semantic.mjs):
 *   - onnxruntime-node 在 npm 层拒绝 android:EBADPLATFORM(无 android 预编译)
 *   - 绕法:process.platform==="android" 时用 module.registerHooks() 把
 *     "onnxruntime-node" 重定向到 onnxruntime-web 的 **Node 专用入口**
 *     (ort.node.min.mjs,纯 WASM + fs 加载),"sharp" 重定向到空 shim
 *   - 本地模型已从缓存删除(搜索本身需联网,离线用不到嵌入)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, renameSync, statSync, utimesSync } from "node:fs";
import { createHash } from "node:crypto";
import { join as pathJoin } from "node:path";
import { createCooldown } from "./cooldown.mjs";
import { CACHE_DIR, EMBED_BACKEND, EMBED_MODEL, EMBED_API_BASE, EMBED_API_MODEL, EMBED_API_DIMENSIONS, EMBED_FAIL_FILE } from "./config.mjs";

let embedder = null; // {extract, model}
let attempted = false;
let hooksReady = null; // Promise<{webDist:URL}|null> 一次性

function currentEmbedBackend(env = process.env) {
  return env.WEBSEARCH_EMBED_BACKEND || EMBED_BACKEND;
}

// ---- API 失败记忆(通用冷却工具,跨进程持久化) ----
// 连续失败 2 次 → 冷却 5 分钟,期内不再请求;成功清零。
// 受益场景:限流(429)/网络故障时,避免每次搜索都白等 + 加重负载。
// 持久化到磁盘:CLI 每次独立进程,冷却跨搜索生效(与 aggregate 引擎失败记忆同模式)。
const apiCooldown = createCooldown({ threshold: 2, cooldownMs: 5 * 60_000, file: EMBED_FAIL_FILE });
const API_KEY = "api"; // 单 key 冷却(与引擎名隔离,不碰撞)

/** 测试钩子:清空 API 失败状态(含磁盘) */
export function resetApiFailState() {
  apiCooldown.reset();
}

// ---- 结果向量缓存(磁盘,跨进程持久) ----
// 场景:agent 对同一搜索调参/重跑(改 limit/阈值/引擎),结果集相同 → 完整复用
// {qVec, vectors},零 API 调用。CLI 每次运行是独立进程,内存 Map 无意义 → 磁盘持久化
// (~/.cache/websearch-vectors/,与 reveal 缓存同目录)。key 覆盖端点、模型、维度和完整
// 输入文本,配置或摘要变化自动失效。容量超限时按最近使用时间淘汰最旧条目。

const VEC_CACHE_DIR = pathJoin(CACHE_DIR, "websearch-vectors");
const VEC_CACHE_MAX_FILES = 300;
const VEC_CACHE_VERSION = 2;
const vecCacheMem = new Map(); // 本次进程内存快取(避免重复读盘)

function vecCachePath(key) {
  return pathJoin(VEC_CACHE_DIR, `${key}.json`);
}

function vecCacheLoad(key) {
  const hit = vecCacheMem.get(key);
  if (hit) return hit;
  try {
    const f = vecCachePath(key);
    if (!existsSync(f)) return null;
    const v = JSON.parse(readFileSync(f, "utf8"));
    const now = new Date();
    try { utimesSync(f, now, now); } catch { /* 只读缓存仍可命中 */ }
    vecCacheMem.set(key, v); // 后续读内存
    return v;
  } catch {
    return null;
  }
}

function vecCacheSave(key, out) {
  try {
    mkdirSync(VEC_CACHE_DIR, { recursive: true });
    const files = readdirSync(VEC_CACHE_DIR).filter((f) => f.endsWith(".json"));
    const overflow = files.length - VEC_CACHE_MAX_FILES + 1;
    if (overflow > 0) {
      files
        .map((name) => ({ name, mtime: statSync(pathJoin(VEC_CACHE_DIR, name)).mtimeMs }))
        .sort((a, b) => a.mtime - b.mtime)
        .slice(0, overflow)
        .forEach(({ name }) => rmSync(pathJoin(VEC_CACHE_DIR, name), { force: true }));
    }
    const target = vecCachePath(key);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(out));
    renameSync(tmp, target);
    vecCacheMem.set(key, out);
  } catch {
    // 缓存失败不影响主流程
  }
}

/** 测试钩子:测试环境清内存与隔离磁盘;生产环境默认只清内存。 */
export function resetQVecCache({ disk = Boolean(process.env.NODE_TEST_CONTEXT) } = {}) {
  vecCacheMem.clear();
  try {
    if (disk && existsSync(VEC_CACHE_DIR)) {
      for (const f of readdirSync(VEC_CACHE_DIR).filter((name) => name.endsWith(".json"))) {
        rmSync(pathJoin(VEC_CACHE_DIR, f), { force: true });
      }
    }
  } catch {
    // 忽略清理失败
  }
}

/** API key 读取顺序:环境变量 → 技能目录 .env.json(chmod 600) */
function getApiKey() {
  if (process.env.SILICONFLOW_API_KEY) return process.env.SILICONFLOW_API_KEY;
  try {
    const envFile = new URL("../../.env.json", import.meta.url);
    return JSON.parse(readFileSync(envFile, "utf8")).SILICONFLOW_API_KEY || null;
  } catch {
    return null;
  }
}


/** 是否需要在 import transformers 前注册 WASM 重定向 hooks */
function needWasmRedirect() {
  if (currentEmbedBackend() === "wasm") return true; // 显式强制
  return process.platform === "android"; // Termux:onnxruntime-node 无 android 预编译
}

/**
 * Termux/Android 专用:注册模块解析钩子,把 onnxruntime-node / sharp 重定向到
 * onnxruntime-web(WASM Node 入口)与空 shim。必须在 import transformers 之前完成。
 * @returns {Promise<{webDist:URL}|null>} null = 缺少 onnxruntime-web(未装依赖)
 */
async function ensureWasmBackend() {
  if (!needWasmRedirect()) return null;
  if (hooksReady) return hooksReady;
  hooksReady = (async () => {
    try {
      const { registerHooks } = await import("node:module");
      if (typeof registerHooks !== "function") return null; // Node <22.15
      // 定位 onnxruntime-web 的 Node 条件入口(node_modules 里,package.json exports.node.import)
      const webEntry = import.meta.resolve("onnxruntime-web");
      const webDist = new URL("./", new URL(webEntry));
      registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier === "onnxruntime-node") return { url: webEntry, shortCircuit: true };
          if (specifier === "sharp") return { url: "data:text/javascript,export default {};", shortCircuit: true };
          return nextResolve(specifier, context);
        },
      });
      return { webDist };
    } catch {
      return null; // onnxruntime-web 未安装 → 保持降级
    }
  })();
  return hooksReady;
}

/** 获取嵌入器(懒加载 + 缓存;失败置 null,不再重试) */
export async function getEmbedder({ quiet = false } = {}) {
  if (attempted) return embedder;
  attempted = true;
  try {
    // 先确保 WASM 后端就位(Termux 必须,桌面跳过),再加载 transformers
    const wasm = await ensureWasmBackend();
    const tf = await import("@huggingface/transformers");
    if (wasm) {
      // WASM 模式:wasm 文件指向本地 onnxruntime-web/dist(避免 fetch/blob),单线程最稳
      tf.env.backends.onnx.wasm.wasmPaths = wasm.webDist.href;
      tf.env.backends.onnx.wasm.numThreads = 1;
    }
    const model = EMBED_MODEL;
    const extract = await tf.pipeline("feature-extraction", model, { quantized: true });
    embedder = { extract, model };
  } catch (e) {
    embedder = null;
    // 未安装/后端不可用 → 降级;quiet=true(自动尝试模式)静默,仅显式 --semantic 时提示
    if (!quiet) console.error(`[degrade] 语义嵌入不可用(${(e.message || e).split("\n")[0].slice(0, 120)}),回退短语聚类`);
  }
  return embedder;
}

/** 测试/手动重置用(改环境变量后重新探测) */
export function resetEmbedder() {
  attempted = false;
  embedder = null;
  hooksReady = null;
}

/**
 * 文本列表 → 向量列表(mean pooling + L2 归一化)。
 * @returns {Promise<number[][]|null>} 不可用时返回 null
 */
export async function embedTexts(texts, { quiet = false } = {}) {
  const em = await getEmbedder({ quiet });
  if (!em) return null;
  const out = [];
  for (const t of texts) {
    const res = await em.extract(t, { pooling: "mean", normalize: true });
    out.push(Array.from(res.data));
  }
  return out;
}

/** 显式 L2 归一化:不信任提供商一定返回归一化向量(本地 WASM 用 normalize:true,
 *  API 无此保证)。幂等(已归一化向量不变);零向量保持原样防 NaN。 */
function normalizeL2(v) {
  let sq = 0;
  for (const x of v) sq += x * x;
  const len = Math.sqrt(sq);
  if (!len) return v;
  return v.map((x) => x / len);
}

/**
 * API 嵌入(OpenAI 兼容 /v1/embeddings,批量一次请求)。
 * 韧性:429/5xx/网络错误退避重试(最多 3 次);连续失败进入冷却(见 apiCooling);
 * MRL 维度压缩(EMBED_API_DIMENSIONS)不被支持的提供商(400/422)自动去掉重试。
 * @returns {Promise<number[][]|null>}
 */
export async function apiEmbedTexts(texts, {
  quiet = false,
  timeoutMs = 10_000,
  maxAttempts = 3,
} = {}) {
  const key = getApiKey();
  if (!key) {
    if (!quiet) console.error("[degrade] 未配置 SILICONFLOW_API_KEY(环境变量或 .env.json),跳过 API 嵌入");
    return null;
  }
  if (apiCooldown.isCooled(API_KEY)) {
    if (!quiet) console.error("[degrade] API 嵌入连续失败进入冷却期,跳过(成功调用自动恢复)");
    return null;
  }
  const model = EMBED_API_MODEL;
  const dim = EMBED_API_DIMENSIONS;
  let body = { model, input: texts, encoding_format: "float" };
  let usesDimensions = dim > 0;
  if (usesDimensions) body.dimensions = dim;
  const attemptLimit = Math.max(1, Math.min(5, Math.trunc(maxAttempts) || 1));
  const requestTimeoutMs = Math.max(250, Math.min(120_000, Number(timeoutMs) || 10_000));
  let attempts = 0;
  while (attempts < attemptLimit) {
    attempts++;
    try {
      const res = await fetch(`${EMBED_API_BASE}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (res.ok) {
        const j = await res.json();
        if (!j.data?.length) throw new Error("API 返回空数据");
        const out = j.data.map((d) => normalizeL2(d.embedding || []));
        apiCooldown.mark(API_KEY, true); // 成功清零
        if (!quiet && currentEmbedBackend() !== "api") {
          console.error(`[info] 语义嵌入使用 API 后端(${model}, ${out[0]?.length || 0} 维)`);
        }
        return out;
      }
      // MRL 维度压缩不被支持(换 OpenAI 兼容提供商)→ 去掉 dimensions 重试
      if (usesDimensions && (res.status === 400 || res.status === 422)) {
        usesDimensions = false;
        body = { model, input: texts, encoding_format: "float" };
        attempts--; // 协议兼容纠正不消耗网络重试额度,且只会发生一次
        continue;
      }
      const err = await res.text().catch(() => "");
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempts < attemptLimit) {
        await new Promise((r) => setTimeout(r, 300 * attempts)); // 退避 300/600ms
        continue;
      }
      throw new Error(`HTTP ${res.status}: ${err.slice(0, 100)}`);
    } catch (e) {
      const msg = e.message || String(e);
      // 网络错误(连接失败/超时)也可重试
      const retryable =
        msg.startsWith("HTTP 429") || msg.startsWith("HTTP 5") ||
        msg.includes("fetch failed") || msg.includes("ECONN") || msg.includes("ETIMEDOUT") ||
        msg.includes("network") || e?.name === "AbortError" || e?.name === "TimeoutError";
      if (retryable && attempts < attemptLimit) {
        await new Promise((r) => setTimeout(r, 300 * attempts));
        continue;
      }
      apiCooldown.mark(API_KEY, false);
      if (!quiet) console.error(`[degrade] API 嵌入失败(${msg.slice(0, 120)}),回退短语聚类`);
      return null;
    }
  }
  apiCooldown.mark(API_KEY, false);
  return null;
}

/**
 * 任意文本按显式语义后端配置生成向量。与 embedResults 共用 off/api/local/wasm/auto
 * 契约，避免调用方绕过隐私配置；auto 才允许 API 失败后回退本地模型。
 */
export async function embedConfiguredTexts(texts, {
  quiet = false,
  apiTimeoutMs = 10_000,
  apiMaxAttempts = 3,
} = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return null;
  const configuredBackend = currentEmbedBackend();
  const forced = configuredBackend === "auto" ? undefined : configuredBackend;
  if (forced === "off") return null;
  if (forced === "api") {
    return apiEmbedTexts(texts, { quiet, timeoutMs: apiTimeoutMs, maxAttempts: apiMaxAttempts });
  }
  if (forced === "local" || forced === "wasm") {
    return embedTexts(texts, { quiet });
  }
  const apiVectors = await apiEmbedTexts(texts, {
    quiet: true,
    timeoutMs: apiTimeoutMs,
    maxAttempts: apiMaxAttempts,
  });
  return apiVectors || embedTexts(texts, { quiet });
}

/**
 * 把 [qText, ...results] 的向量列表拆成 {qVec?, vectors}:
 * hasQuery 时首个向量是查询向量(qVec),其余是结果向量;否则全部是结果向量。
 * api/local/默认 三个后端分支共用(消除重复三元)。
 */
function shapeVectors(vectors, hasQuery) {
  return hasQuery ? { qVec: vectors[0], vectors: vectors.slice(1) } : { vectors };
}

/**
 * 结果列表 → 向量(标题+摘要,截断 512 字符);query 非空时连同查询词一起嵌入,
 * 返回 qVec(查询向量)供 query↔文档语义相关性重排(ML 温和过滤,见 cluster.mjs)。
 * 降级链:API(有 key) → 本地 WASM(已安装) → {available:false}(短语聚类兜底)。
 * @param {Array} results
 * @param {{quiet?:boolean, query?:string}} [opts] quiet=true 时不可用不打印提示(自动尝试模式)
 * @returns {Promise<{available:boolean, qVec?:number[], vectors?:number[][], model?:string, backend?:string}>}
 */
export async function embedResults(results, { quiet = false, query = "" } = {}) {
  if (!results || results.length === 0) return { available: false };
  const hasQuery = Boolean(query && String(query).trim());
  // 查询词放首位:API 批量一次请求;本地 WASM 逐条也一样。
  // 前缀“查询:”与结果文本区分,避免查询词本身被当成文档语义噪声。
  const qText = hasQuery ? `查询:${String(query).trim().slice(0, 256)}` : null;
  const texts = [
    ...(hasQuery ? [qText] : []),
    // 先分别截断再拼接:避免超长 title/desc(如 github 曾返回 6.5 万字符 desc)
    // 先拼成 12 万字符大字符串再 slice 浪费内存;嵌入只取前 512 字符
    ...results.map((r) => `${String(r.title || "").slice(0, 200)} ${String(r.desc || "").slice(0, 400)}`.trim().slice(0, 512)),
  ];

  // 显式后端:api=强制 API;local/wasm=强制本地(无 key 时兜底)
  const configuredBackend = currentEmbedBackend();
  const forced = configuredBackend === "auto" ? undefined : configuredBackend;
  if (forced === "off") return { available: false };
  if (forced === "api") {
    const vectors = await apiEmbedTexts(texts, { quiet });
    if (!vectors) return { available: false };
    const out = shapeVectors(vectors, hasQuery);
    return { available: true, ...out, model: EMBED_API_MODEL, backend: "api" };
  }
  if (forced === "local" || forced === "wasm") {
    const localVectors = await embedTexts(texts, { quiet });
    if (!localVectors) return { available: false };
    const out = shapeVectors(localVectors, hasQuery);
    return { available: true, ...out, model: embedder?.model, backend: "local" };
  }

  // 默认:API 优先(跑分最高、零本地开销;搜索本身需联网,离线无需本地模型)
  // 输入内容、provider 配置或算法版本任一变化都必须重新嵌入,防止错误复用旧向量。
  const cacheKey = qText ? createHash("sha1").update(JSON.stringify({
    version: VEC_CACHE_VERSION,
    baseURL: EMBED_API_BASE,
    model: EMBED_API_MODEL,
    dimensions: EMBED_API_DIMENSIONS,
    texts,
  })).digest("hex") : null;
  if (cacheKey) {
    const hit = vecCacheLoad(cacheKey);
    if (hit) return { available: true, ...hit, model: EMBED_API_MODEL, backend: "api", cached: true };
  }
  const apiVectors = await apiEmbedTexts(texts, { quiet: true });
  if (apiVectors) {
    const out = shapeVectors(apiVectors, hasQuery);
    if (cacheKey && out.vectors) vecCacheSave(cacheKey, out);
    return { available: true, ...out, model: EMBED_API_MODEL, backend: "api" };
  }

  // API 不可用(无 key/失败) → 本地 WASM 兜底(已安装时)
  const localVectors = await embedTexts(texts, { quiet });
  if (localVectors) {
    const out = shapeVectors(localVectors, hasQuery);
    return { available: true, ...out, model: embedder?.model, backend: "local" };
  }
  return { available: false };
}
