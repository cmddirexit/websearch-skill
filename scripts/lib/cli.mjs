/**
 * cli.mjs — CLI 调度门面:参数解析、引擎调度(runSearch)、主入口
 *
 * 2026-08 重构:709 行按职责拆为四模块,本文件保留 main + runSearch + HELP,
 * 并 re-export runFetch/cacheFetchResult(公共 API 不变,index.mjs 与测试零改动):
 *   - learn.mjs      域名信誉单例 + LLM 学习队列(queueLLMLearn/queueFetchLearn/waitLLM)
 *   - format.mjs     展示层(printResults/printFetchResult/emitFetchResult/cacheFetchResult/榜单)
 *   - fetch-flow.mjs 抓取调度(runFetch 决策链 + 存档兜底)
 *
 * 职责:
 *  - 解析 search/fetch 参数
 *  - 引擎调度:注册表驱动 + 声明式降级链(新增引擎只需注册,不改调度逻辑)
 *  - 结果输出委托 format.mjs
 *
 * 引擎契约(所有 search 函数统一):
 *   search(query, limit) → Promise<SearchResult | null>
 *   SearchResult = { engine, mode, blocked, reason?, results: [{title,url,desc}] }
 *   直连失败/被反爬 → blocked:true + reason;浏览器兜底不可用 → null
 *
 * 降级链(声明式,见 ENGINES 注册表):
 *   bing : bing 直连 → 浏览器兜底(bing)
 *   baidu: baidu 直连 → bing 直连 → 浏览器兜底(bing)
 *   fetch: 直连 → 浏览器兜底(独立流程,见 fetch-flow.mjs runFetch)
 *
 * 本模块可被其他脚本 import 复用;所有错误以 throw 抛出,
 * 由调用方决定处理方式(薄壳 websearch.mjs 负责 catch 后 process.exit)。
 */

import { loadEngines, defaultEngineKey } from "./engines/registry.mjs";
import { DEFAULT_SEARCH_LIMIT, TOTAL_BUDGET_MS, REVEAL_FILE } from "./config.mjs";
import { withBudget } from "./budget.mjs";
import { aggregateSearch } from "./aggregate.mjs";
import { applySinceFilter } from "./filter.mjs";
import { printResults, printHotlist, printTrending } from "./format.mjs";
import { waitLLM } from "./learn.mjs";
import { runFetch } from "./fetch-flow.mjs";

// ---- re-export(公共 API 不变:index.mjs 导出 main/runFetch/cacheFetchResult;cli 决策链单测引用) ----
export { runFetch } from "./fetch-flow.mjs";
export { cacheFetchResult } from "./format.mjs";

/**
 * 引擎注册表:由 engines.conf.json 声明 + registry.mjs 映射校验(加载即校验引用完整性)。
 * 新增引擎: 1) engines/ 实现 search 2) registry.mjs 注册 3) engines.conf.json 登记 + 声明降级链。
 *
 * 降级链说明:
 *  - bing 的 fallbacks 含 marginalia:CN IP 上英文查询会被地域污染,
 *    检测到 polluted 时自动切英文独立索引(直连→浏览器双兜底)
 *  - 浏览器兜底需要 Chromium(Termux: pkg install chromium),库可用时走
 *    puppeteer-core/playwright,否则自动降级 chromium CLI(零 npm 依赖)
 */
const ENGINES = loadEngines();
const DEFAULT_ENGINE = defaultEngineKey(ENGINES);

const HELP = `用法:
  websearch.mjs search "查询词" [--engine ${Object.keys(ENGINES).join("|")}] [--limit N] [--flat] [--semantic|--no-semantic] [--since 24h|1w|1m|1y]
  websearch.mjs fetch "https://..." [--max N]
  websearch.mjs timeline "事件/主题" [--limit N]   # 多篇报道自动串成时间线(复杂事件专用,如美伊冲突)
  websearch.mjs reveal                  # 展开查看上次搜索的折叠区详情(低相关结果,缓存于 ~/.cache/websearch-collapsed.md)
  websearch.mjs hotlist [weibo|douyin|baidu|toutiao] [--limit N]   # 平台热搜榜(默认全部)

默认对搜索结果聚类:两阶段流水线 —— ① 规则过滤广告/垃圾(硬剔除)② 聚类组织
(共享短语分组,簇按与查询词的相关度+质量加权排序,agent 可直接看前几个簇);
--flat 关闭聚类,平铺显示原始结果;--semantic 强制语义嵌入聚类(npm run setup:semantic 一键启用,
不可用自动回退短语),--no-semantic 强制关闭。引擎:
  bing (默认)  中文/英文通用,直连 cn.bing.com;中文结果自动过滤工具站站群(黄历/万年历等模板站);
               英文查询若被地域污染自动切 Marginalia
  baidu        中文内容,直连百度(移动端 UA 绕过风控),失败自动降级 bing
  cnnews       官方新闻源白名单(人民网/共产党员网),结果自带发布日期、可按关键词过滤;空查询=最新要闻
  marginalia   英文独立索引(不依赖 Google/Bing,不受 CN IP 地域影响)

低相关折叠(语义重排可用时):非相关簇折叠为一行(簇名×条数+语义分),详情写
~/.cache/websearch-collapsed.md,搜索完成后可 reveal 展开或直接读取。
环境变量: WEBSEARCH_REL_MODE=conservative 全展开 / balanced(默认)折叠; WEBSEARCH_SEM_WEIGHT 等调参。

热搜榜:
  hotlist weibo    微博热搜(镜像直连+官方页浏览器双通道)
  hotlist douyin   抖音热榜(官方页,浏览器渲染后 DOM 提取)
  hotlist baidu    百度热搜(官方公开 API)
  hotlist toutiao  头条热榜(官方公开 JSON API)
  (微博/抖音官方接口均需登录或签名,浏览器通道是唯一直连方案)

浏览器兜底:
  Termux: pkg install chromium 后自动启用(三层:puppeteer-core → playwright → chromium CLI)
  桌面:  npm i playwright && npx playwright install chromium
  环境变量 WEBSEARCH_BROWSER_PATH 可指定浏览器可执行文件。`;

/** 结果级时效硬过滤(--since 参数):超窗且带日期的结果剔除;无日期无法判断,保守保留。
 * 与 chinaso 引擎的 API 层 stime/etime 互补 —— 其余引擎(聚合时)靠这里统一过滤。 */
function applySince(r, since) {
  if (!since) return r;
  const { kept, dropped } = applySinceFilter(r.results, since);
  if (dropped.length) console.error(`[degrade] --since ${since}: 剔除 ${dropped.length} 条超窗结果(带日期可判断的旧文)`);
  return { ...r, results: kept };
}

/** 调度搜索:主引擎 → 按注册表降级链依次尝试 → 全部失败打印空结果 */
async function runSearch(query, engineName, limit, flat, semantic, since) {
  const engine = ENGINES[engineName];
  const start = Date.now();
  const deadline = start + TOTAL_BUDGET_MS; // 整条降级链的硬预算,防止边际 60s+ 卡死
  let first;
  // 多引擎聚合(limit>10 且引擎声明了聚合伙伴):并行抓取 + URL 去重合并,
  // 突破单引擎单页 ~10 条硬限(实测 count/first/滚动/点击翻页全部被忽略)
  const partners = engine.aggregateWith || [];
  if (limit > 10 && partners.length > 0) {
    const agg = await aggregateSearch(ENGINES, query, limit, [engineName, ...partners], deadline, { since });
    if (!agg.blocked && agg.results.length > 0) {
      await printResults(applySince(agg, since), query, flat, semantic);
      if (agg.note) console.log(`[info] ${agg.note}`);
      if (agg._errors?.length) console.log(`[info] 聚合跳过: ${agg._errors.join("; ")}`);
      return;
    }
    // 聚合全失败 → 回退主引擎降级链
    console.error(`[degrade] 聚合失败(${agg.reason || "无结果"}),回退主引擎降级链...`);
    first = { engine: engineName, mode: "direct", blocked: true, reason: agg.reason };
  } else {
    try {
      // 主引擎也受总预算约束(与降级链合计 40s)
      first = await withBudget(engine.search(query, limit, { since }), deadline - start, engineName);
    } catch (e) {
      first = { engine: engineName, mode: "direct", blocked: true, reason: e.message };
    }
  }
  if (first && !first.blocked && !first.polluted && first.results.length > 0) {
    await printResults(applySince(first, since), query, flat, semantic);
    if (first.note) console.log(`[info] ${first.note}`);
    return;
  }
  if (first?.polluted) {
    console.error(`[degrade] ${first.engine || engineName} 结果被地域语言污染(英文查询返回大量中文),尝试英文独立索引...`);
  } else {
    console.error(`[degrade] ${first?.reason || `${engineName} 无结果`}`);
  }
  for (const { label, fn } of engine.fallbacks) {
    const remain = deadline - Date.now();
    if (remain <= 0) {
      console.error(`[degrade] 降级链超时(${TOTAL_BUDGET_MS / 1000}s),停止尝试`);
      break;
    }
    let r;
    try {
      r = await withBudget(fn(query, limit, { since }), remain, label); // 单次 fallback 也不可超剩余预算
    } catch (e) {
      console.error(`[degrade] ${label}兜底出错: ${e.message}`);
      continue;
    }
    if (r && !r.blocked && !r.polluted && r.results.length > 0) {
      await printResults(applySince(r, since), query, flat, semantic);
      if (r.note) console.log(`[info] ${r.note}`);
      return;
    }
    console.error(`[degrade] ${label}兜底${r?.reason ? `: ${r.reason}` : "无结果/不可用"}`);
  }
  console.error(`[degrade] ${engineName} 与所有兜底均失败`);
  await printResults({ engine: engineName, mode: "direct", results: [] }, query);
}

/**
 * 主入口。错误以 throw 抛出(参数错误、抓取失败等),由调用方处理。
 * @param {string[]} args CLI 参数(不含 node/脚本路径)
 */
export async function main(args) {
  const [cmd, ...rest] = args;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }
  if (cmd === "search") {
    // 逐项消费 flag 值(--engine/--limit 的取值不作为查询词),剩余非 flag 参数拼接为查询词
    // 修复: 旧实现 rest.find(!startsWith("--")) 会把 flag 值(如 --engine bing 的 "bing")误当查询词
    let engine = DEFAULT_ENGINE;
    let limit = DEFAULT_SEARCH_LIMIT; // 默认拉满:99 是聚合上限而非保证值
    let flat = false;
    let semantic = null; // null=自动尝试(装了嵌入可用,不可用静默降级); true/false 强制
    let since = ""; // 时效过滤(24h|1w|1m|1y),目前仅 chinaso 生效(官方 API stime/etime)
    const queryParts = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "--engine") { engine = rest[++i]; continue; }
      if (a === "--limit") { const n = parseInt(rest[++i], 10); if (!Number.isNaN(n)) limit = n; continue; }
      if (a === "--flat") { flat = true; continue; }
      if (a === "--semantic") { semantic = true; continue; }
      if (a === "--no-semantic") { semantic = false; continue; }
      if (a === "--since") { since = rest[++i] || ""; continue; }
      if (!a.startsWith("--")) queryParts.push(a);
    }
    const query = queryParts.join(" "); // 多词查询不带引号也支持
    limit = Math.min(Math.max(limit || DEFAULT_SEARCH_LIMIT, 1), 150);
    if (!query && engine !== "cnnews") throw new Error('缺少查询词,用法: websearch.mjs search "查询词"');
    if (engine === "cnnews" && !query) console.error("[cnnews] 空查询 → 最新要闻(热点模式)");
    if (!ENGINES[engine]) throw new Error(`未知引擎: ${engine}(可选 ${Object.keys(ENGINES).join("|")})`);
    await runSearch(query, engine, limit, flat, semantic, since);
    await waitLLM();
  } else if (cmd === "reveal") {
    // 展开查看上次搜索的折叠区详情(缓存文件由 search 生成;agent 也可直接读 REVEAL_FILE)
    const fs = await import("node:fs");
    if (!fs.existsSync(REVEAL_FILE)) {
      throw new Error(`无折叠缓存(${REVEAL_FILE}): 先执行一次 search 生成折叠区,再 reveal 展开查看`);
    }
    console.log(fs.readFileSync(REVEAL_FILE, "utf8"));
  } else if (cmd === "fetch") {
    const url = rest[0];
    const maxIdx = rest.indexOf("--max");
    const max = maxIdx >= 0 ? Math.min(Math.max(parseInt(rest[maxIdx + 1]) || 3000, 500), 20000) : 3000;
    if (!url) throw new Error('缺少 URL,用法: websearch.mjs fetch "https://..."');
    await runFetch(url, max);
    await waitLLM();
  } else if (cmd === "timeline") {
    // 时间线:复杂事件(美伊冲突等)分散在多篇报道里(4-8 月),单篇 fetch 看不清脉络。
    // timeline 聚合搜索 → 并行抓取关键文章 → 提取发布时间+要点 → 按时间排序输出。
    const { runTimeline } = await import("./timeline.mjs");
    const flags = new Set(["--limit", "--engine", "--max"]);
    const query = rest.filter((a, i) => !a.startsWith("--") && !flags.has(rest[i - 1])).join(" ");
    if (!query) throw new Error('缺少主题,用法: websearch.mjs timeline "事件/主题"');
    const limitIdx = rest.indexOf("--limit");
    const limit = limitIdx >= 0 ? Math.min(Math.max(parseInt(rest[limitIdx + 1]) || 8, 3), 12) : 8;
    await runTimeline(query, limit);
    await waitLLM();
  } else if (cmd === "hotlist") {
    // 懒加载 hotlist(其内部 import jsdom):纯 search/fetch 路径不加载 jsdom,与 fetch-page 懒加载设计一致
    const { fetchHotlist } = await import("./engines/hotlist.mjs");
    // 位置参数 = 非 flag 且非 flag 值(如 --limit 8 里的 8)
    const flags = new Set(["--limit", "--engine", "--max"]);
    const board = rest.find((a, i) => !a.startsWith("--") && !flags.has(rest[i - 1])) || "";
    const limitIdx = rest.indexOf("--limit");
    const limit = limitIdx >= 0 ? Math.min(Math.max(parseInt(rest[limitIdx + 1]) || 10, 5), 50) : 10;
    printHotlist(await fetchHotlist(board, limit));
  } else if (cmd === "trending") {
    // 懒加载 trending(轻量依赖,纯正则解析):search/fetch 路径不加载
    const { fetchGithubTrending, TRENDING_SINCE } = await import("./engines/trending.mjs");
    const flags = new Set(["--limit", "--engine", "--max"]);
    const since = rest.find((a, i) => !a.startsWith("--") && !flags.has(rest[i - 1])) || "daily";
    if (!TRENDING_SINCE.includes(since)) throw new Error(`未知时间窗: ${since}(可选 ${TRENDING_SINCE.join("|")})`);
    const limitIdx = rest.indexOf("--limit");
    const limit = limitIdx >= 0 ? Math.min(Math.max(parseInt(rest[limitIdx + 1]) || 15, 5), 25) : 15;
    printTrending(await fetchGithubTrending(since, limit));
  } else {
    throw new Error(`未知命令: ${cmd}\n${HELP}`);
  }
}
