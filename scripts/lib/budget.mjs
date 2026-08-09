/**
 * budget.mjs — 硬超时工具(降级链/聚合共用的预算控制)
 *
 * 给 Promise 加硬超时:超时后返回的 promise 立即 reject,
 * 底层任务继续执行但结果被丢弃(HTTP 自带 signal 兜底,chromium 有自身超时与进程树清理)。
 * 单引擎搜索与多引擎聚合都必须经此限时,否则慢引擎(如 searx 浏览器兜底)会拖垮整条链路。
 */

/**
 * @param {Promise} promise
 * @param {number} ms 剩余预算(<=0 直接失败)
 * @param {string} label 日志用
 */
export function withBudget(promise, ms, label) {
  if (ms <= 0) return Promise.reject(new Error(`${label} 无剩余预算`));
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超出预算 ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
