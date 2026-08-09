/**
 * learn.mjs — 域名信誉单例 + LLM 学习队列(展示先行、退出前落盘)
 *
 * 从 cli.mjs 拆出(2026-08 重构,cli.mjs 变为调度门面):
 * cli(runSearch)/format(printResults)/fetch-flow(runFetch) 三处复用 rep 与学习编排,
 * 避免学习队列逻辑散落在调度与展示层。
 *
 * 学习模型:每次搜索结果自动学习(LLM 判内容可信度 → 元学习可靠 label),
 * 每次 fetch 回写实测质量。LLM 请求失败自动降级 quality 学习,照常保存。
 */

import { createDomainReputation } from "./domain-rep.mjs";

/** 域名信誉学习单例(跨 CLI 进程持久化;每次搜索自动学习,每次 fetch 回写实测质量) */
export const rep = createDomainReputation();

// LLM 学习排队:展示先行(结果已输出),后台 LLM 判断内容可信度 → 可靠 label 学习模式;
// 串行执行避免并发;进程退出前**阻塞等待** LLM 完成 —— 学习不丢失:
//   · 通常 2-5 秒(冷判断),热缓存/已知域名 0 秒
//   · 最坏 = LLM 请求自身 30s 超时 → 返回 null → 降级 quality 学习 → 照常保存
//   · 等完这次,判断入缓存,所有未来搜索零成本(放弃=下次重判,网络差时永远学不进去)
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
export async function waitLLM(timeoutMs = 0) {
  if (!timeoutMs) {
    await llmQueue; // 阻塞等待(LLM 请求 30s 超时兜底,失败降级 quality 也照常保存)
    return;
  }
  // 带硬超时等待:LLM 学习是后台增强,结果早已打印完,不值得为它阻塞进程退出太久
  // (大结果集 58 条分 3 片并行 LLM 判断,网络差时接近 30s 上限 —— 交互式搜索会被
  // 外部超时截断)。超时即放弃本次学习(下次搜索缓存未命中会重判),不抛错、不阻塞。
  await Promise.race([llmQueue, new Promise((res) => setTimeout(res, timeoutMs))]);
}
