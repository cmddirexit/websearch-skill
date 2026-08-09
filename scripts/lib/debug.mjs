/**
 * debug.mjs — WEBSEARCH_DEBUG=1 结构化决策追踪
 *
 * 动机:排查抓取/降级链问题时,常规 [degrade]/[browser] 日志只给结论不给过程 ——
 * 看不到“直连拿到什么 → 为什么放弃 → 每个通道花多久/结果如何 → 最终来自哪”。
 * debug 模式输出带缩进的完整决策链(每步耗时 + 结果概要),一眼定位卡点。
 *
 * 用法: WEBSEARCH_DEBUG=1 node scripts/websearch.mjs fetch "https://..."
 * 默认关闭:所有函数零开销直接透传,不影响正常输出与性能。
 */

export const DEBUG = !!process.env.WEBSEARCH_DEBUG;

let depth = 0;

/** 输出一行 [debug] 日志(带缩进,层级由 dbgStep 管理);非 debug 模式静默 */
export function dbg(...args) {
  if (!DEBUG) return;
  console.error(`[debug]${"  ".repeat(depth)}${args.join(" ")}`);
}

/**
 * 执行 fn 并记录耗时与结果概要。
 * - 成功:dbgStep(label, fn) 返回 fn() 原值,并输出 `${label} → Xs`
 * - 异常:输出 `${label} ✗ Xs: 错误摘要`,再原样抛出
 * 非 debug 模式:直接返回 fn(),无缩进管理、零开销。
 */
export async function dbgStep(label, fn) {
  if (!DEBUG) return fn();
  const t0 = Date.now();
  depth++;
  try {
    const r = await fn();
    dbg(`${label} → ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    depth--;
    return r;
  } catch (e) {
    dbg(`${label} ✗ ${((Date.now() - t0) / 1000).toFixed(1)}s: ${String(e?.message || e).slice(0, 160)}`);
    depth--;
    throw e;
  }
}

/** 概要:正文对象/字符串 → 长度概览,debug 输出用 */
export function brief(r, extra = "") {
  const raw = typeof r === "string" ? r : r?.markdown || r?.body || "";
  return `${raw.length}字符${extra ? ` ${extra}` : ""}`;
}
