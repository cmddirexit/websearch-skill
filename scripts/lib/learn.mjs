/**
 * learn.mjs — 域名信誉单例 + LLM 学习队列(展示先行、退出前落盘)
 *
 * 从 cli.mjs 拆出(2026-08 重构,cli.mjs 变为调度门面):
 * cli(runSearch)/format(printResults)/fetch-flow(runFetch) 三处复用 rep 与学习编排,
 * 避免学习队列逻辑散落在调度与展示层。
 *
 * 学习模型:每次搜索结果自动学习;显式启用 LLM 时用其内容可信度 label 增强,
 * 否则使用本地 quality。每次 fetch 回写实测质量,LLM 失败不影响保存。
 */

import { createDomainReputation } from "./domain-rep.mjs";
import { LLM_WAIT_MS } from "./config.mjs";

/** 域名信誉学习单例(跨 CLI 进程持久化;每次搜索自动学习,每次 fetch 回写实测质量) */
export const rep = createDomainReputation();

// LLM 学习排队:展示先行,后台判断;默认关闭。显式启用时等待仍受 LLM_WAIT_MS
// 硬上限约束,网络或服务商异常不能拖住 CLI 主流程。
let llmQueue = Promise.resolve();
export function queueLLMLearn(results) {
  llmQueue = llmQueue
    .then(() => rep.learnFromResultsLLM(results))
    .catch(() => rep.learnFromResults(results))
    .then(() => rep.save());
}
export function queueFetchLearn(url, extra) {
  llmQueue = llmQueue
    .then(() => rep.learnFetchLLM(url, extra)) // 内部已保底(LLM 失败 → 温和正 0.6)
    .catch(() => {})
    .then(() => rep.save());
}
export async function waitLLM(timeoutMs = LLM_WAIT_MS) {
  if (timeoutMs <= 0) return;
  // 带硬超时等待:LLM 学习是后台增强,结果早已打印完,不值得为它阻塞进程退出太久
  // 超时即放弃本次学习(下次搜索缓存未命中会重判),不抛错、不阻塞。
  let timer;
  try {
    await Promise.race([
      llmQueue,
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
