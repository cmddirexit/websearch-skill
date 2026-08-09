/**
 * format.mjs — 展示层:搜索/抓取/榜单结果输出 + 页面缓存写入
 *
 * 从 cli.mjs 拆出(2026-08 重构):把 console 输出与缓存副作用从调度逻辑分离。
 *   - printResults:搜索结果的 过滤→聚类→展示 两阶段流水线(消费 filter/cluster/embed/relevance)
 *   - emitFetchResult:抓取结果统一出口(先缓存达线正文,再按请求 maxChars 截断展示)
 *   - printHotlist / printTrending:榜单展示
 *
 * 本模块只做"如何展示/是否写缓存",调度决策(走哪条抓取链)在 cli.mjs / fetch-flow.mjs。
 */

import { REVEAL_FILE, EMBED_API_SIM_THRESHOLD, REP_FETCH_MIN_OK_CHARS } from "./config.mjs";
import { clusterResults, cosine } from "./cluster.mjs";
import { filterResults, applyRecencyOrder } from "./filter.mjs";
import { stripControl } from "./html.mjs";
import { embedResults } from "./embed.mjs";
import { buildPresentation, collapsedBrief, collapsedMarkdown } from "./relevance.mjs";
import { classifyFetchResult } from "./antiblock.mjs";
import { pageCachePut } from "./persist.mjs";
import { dbg } from "./debug.mjs";
import { rep, queueLLMLearn } from "./learn.mjs";

/** 输出搜索结果:默认 过滤→聚类(两阶段流水线);--flat 平铺 */
export async function printResults(r, query, flat = false, semantic = null) {
  const label = r.mode === "browser" ? `${r.engine}(浏览器)` : r.engine;
  // 分层解析降级提示:特异性解析器失效时(站点可能改版)自动降级通用/JSON 结构化提取
  if (r.parsedBy && r.parsedBy !== "specific" && r.results.length > 0) {
    console.error(`[degrade] ${r.engine} 特异性解析降级(${r.parsedBy}${r.specificCount !== undefined ? ` 命中 ${r.specificCount}` : ""}),站点可能改版 —— 已自动切换解析方式,结果可继续使用`);
  }
  // 聚类模式:
  if (!flat && r.results.length >= 2) {
    // 阶段一:规则过滤(硬剔除广告,软降权垃圾);阶段二:聚类组织
    const { kept, ads, flagged } = filterResults(r.results);
    // 时间意图查询(本周/最近/最新…):旧文沉底 + low:stale 标注。不改 quality,
    // 不污染域名信誉学习(见 filter.mjs applyRecencyOrder 注释);无时间意图零开销。
    const ordered = applyRecencyOrder(kept, query);
    // 域名信誉:从当次结果学习 + 软降权(低信誉域名整体压沉但不剔除,冷启动零干预)
    // LLM 版学习(异步排队,不阻塞展示):LLM 判断内容可信度 → 元学习可靠 label;
    // LLM 失败/未配 key → 自动降级纯 quality 分学习
    rep.applyToResults(ordered);
    queueLLMLearn(ordered);
    let vectors = null;
    let qVec = null;
    let backend = null;
    let em = null;
    if (semantic !== false) {
      try {
        // query 一起嵌入 → qVec(query↔文档语义相关性重排的 ML 基础)
        em = await embedResults(kept, { quiet: semantic !== true, query });
        if (em.available) {
          vectors = em.vectors;
          qVec = em.qVec || null;
          backend = em.backend;
          // API 后端的相似度分布与本地不同(Qwen3-8B 同 0.58~0.72 vs 异 0.32~0.45):
          // 用 API 专用阈值,除非用户显式设了 WEBSEARCH_SIM_THRESHOLD
          if (backend === "api" && !process.env.WEBSEARCH_SIM_THRESHOLD) {
            process.env.WEBSEARCH_SIM_THRESHOLD = String(EMBED_API_SIM_THRESHOLD);
          }
        }
      } catch {
        vectors = null; // 嵌入失败不阻断主流程
      }
    }
    const { clusters, uncovered } = clusterResults(ordered, query, {
      vectors,
      ...(qVec ? { queryVec: qVec } : {}),
    });
    console.log(`🔍 ${label} 搜索 "${query}" → ${r.results.length} 条(过滤后 ${kept.length} · 聚类 ${clusters.length} 组)`);
    if (backend === "api") console.log(`🧠 语义后端: API(${em?.model || ""})`);
    if (ads.length > 0) {
      console.log(`🚫 剔除广告 ${ads.length} 条: ${ads.map((a) => stripControl(a.title.slice(0, 20))).join(" | ")}`);
    }
    if (flagged.length > 0) {
      console.log(`⚠️ 低质 ${flagged.length} 条已标记(降权不剔除)`);
    }
    // ---- 语义相关性分级(决策层在 relevance.mjs 的 buildPresentation,纯函数可单测) ----
    // 非 conservative 模式下,edge+irrelevant 全部折叠成一行(簇名×条数+语义分),
    // AI 从簇名即知折叠了什么(如"best 是什么意思"→词典页);详情写缓存文件,
    // 搜索完成后可 websearch.mjs reveal(或直接读文件)展开查看。URL 永不丢。
    // conservative 模式:只排序不折叠,全量展开;无嵌入时全部走原逻辑(零回归)。
    const { shown, collapsed } = buildPresentation(clusters);
    rep.learnCollapsed(collapsed); // 低相关折叠簇 → 轻负反馈(该域结果与查询无关)
    for (const c of shown) {
      const parts = [`📦 [${c.label}] 相关度 ${c.score.toFixed(2)} · ${c.size} 条`];
      if (c.semScore !== null && c.semScore !== undefined) parts.push(`语义 ${c.semScore.toFixed(2)}`);
      if (c.quality !== undefined && c.quality < 0.99) parts.push(`质量 ${c.quality.toFixed(2)}`);
      // 低质成员数(比质量均值更有区分度:大簇质量均值 0.97 看不出簇内鱼目混珠)
      const lowCount = c.items.filter((x) => x.flags && x.flags.some((f) => f.startsWith("low:"))).length;
      if (lowCount > 0) parts.push(`⚠低质 ${lowCount} 条`);
      if (c.lowRelevance) parts.push("⚠️低相关");
      if (c.duplicates > 0) parts.push(`含 ${c.duplicates} 条近似重复`);
      console.log(parts.join(" · "));
      if (c.variants && c.variants.length > 0 && c.size > 1) console.log(`   ↳ 簇内主题: ${[...new Set(c.variants)].join(" / ")}`);
      c.items.forEach((x) => {
        const badge = x.flags && x.flags.length > 0 ? ` ⚠[${x.flags.join(",")}]` : "";
        const repBadge_ = x.rep?.badge ? ` ${x.rep.badge}` : "";
        const flags = x.flags || [];
        const spamOnly = flags.some((f) => f.startsWith("low:spam-"));
        // 簇级低相关或垃圾文案 → 只显示标题,不给深挖入口
        if (c.lowRelevance || spamOnly) {
          console.log(`   ${stripControl(x.title)}${badge}${repBadge_} ·(仅标题)`);
          return;
        }
        const staleTag = x.staleDays ? ` ⏳${x.staleDays}天前旧文` : "";
        console.log(`   ${stripControl(x.title)}${badge}${repBadge_}${staleTag}`);
        // low:stale(旧文)不是内容低质,仍显示摘要/日期供判断;其余 low:* 弱化展示
        if (flags.some((f) => f.startsWith("low:") && f !== "low:stale")) {
          console.log(`   🔗 ${x.url}`);
          return;
        }
        if (x.date) console.log(`   ⏱ ${x.date}`);
        if (x.desc) console.log(`   ${stripControl(x.desc)}`);
        console.log(`   🔗 ${x.url}`);
      });
      console.log();
    }
    // 折叠区:一行摘要(簇名×条数+语义分),详情写缓存文件供 reveal/直接读取
    if (collapsed.length > 0) {
      const total = collapsed.reduce((s, c) => s + c.size, 0);
      console.log(`📦 低相关折叠 ${collapsed.length} 簇 / ${total} 条: ${collapsedBrief(collapsed)}`);
      console.log(`   (折叠详情: ${REVEAL_FILE} —— 运行 websearch.mjs reveal 或直接读取该文件展开查看)`);
      try {
        const fs = await import("node:fs");
        fs.mkdirSync(REVEAL_FILE.replace(/\/[^/]+$/, ""), { recursive: true });
        fs.writeFileSync(REVEAL_FILE, collapsedMarkdown(collapsed, query));
      } catch (e) {
        console.error(`[degrade] 折叠缓存写入失败: ${e.message}`);
      }
      console.log();
    }
    // 未归簇单条:语义模式下单例低相关簇已被 buildPresentation 折叠(uncovered 仅短语模式出现,原样展示)
    if (uncovered.length > 0) {
      console.log(`📋 未归簇 ${uncovered.length} 条(与查询无共享词/语义距离过远;可能只是聚类漏判,保留 URL 可深挖)`);
      uncovered.forEach((x) => {
        const badge = x.flags && x.flags.length > 0 ? ` ⚠[${x.flags.join(",")}]` : "";
        console.log(`   ${x.title}${badge}`);
        console.log(`   🔗 ${x.url}`);
      });
      console.log();
    }
    return;
  }
  // 平铺模式:尝试语义重排(query↔文档余弦降序,ML 温和排序,不剔除任何结果)。
  // 解决英文查询被词典/翻译结果占前排的问题 —— 词典页与查询语义距离远,自然沉底。
  // (聚类分支在上方已 return,执行到这里必为 flat 或结果 <2)
  // 平铺也学习(quality/flags 由 filterResults 原地附加,不改展示顺序;badge 供展示)
  const flatKept = filterResults(r.results).kept;
  rep.applyToResults(r.results);
  queueLLMLearn(flatKept);
  let list = r.results;
  if (semantic !== false && r.results.length >= 2) {
    try {
      const em = await embedResults(r.results, { quiet: true, query });
      if (em.available && em.qVec && em.vectors && em.vectors.length === r.results.length) {
        const scored = r.results.map((x, i) => ({ x, rel: Math.max(0, cosine(em.qVec, em.vectors[i])) }));
        scored.sort((a, b) => b.rel - a.rel);
        list = scored.map((v) => ({ ...v.x, rel: v.rel }));
        console.log(`🧠 语义重排: ${em.backend === "api" ? `API(${em.model})` : "local"} 按查询相关性降序`);
      }
    } catch {
      /* 嵌入失败保持原顺序 */
    }
  }
  // 时间意图查询(本周/最近/最新…):旧文沉底(在语义重排之后做,不破坏语义排序;
  // 无意图时原样返回零开销;同样不改 quality,不污染信誉学习)
  list = applyRecencyOrder(list, query);
  console.log(`🔍 ${label} 搜索 "${query}" → ${r.results.length} 条结果\n`);
  list.forEach((x, i) => {
    const staleTag = x.staleDays ? ` ⏳${x.staleDays}天前旧文` : "";
    console.log(`${i + 1}. ${x.title}${x.rel !== undefined ? ` (语义相关 ${x.rel.toFixed(2)})` : ""}${x.rep?.badge ? ` ${x.rep.badge}` : ""}${staleTag}`);
    if (x.date) console.log(`   ⏱ ${x.date}`);
    if (x.desc) console.log(`   ${x.desc}`);
    console.log(`   🔗 ${x.url}`);
    console.log();
  });
  if (r.results.length === 0) console.log("(无结果,可尝试换关键词或引擎)");
}

/** 输出抓取结果:缓存存完整正文(见 emitFetchResult),这里按请求的 maxChars 截断展示 ——
 * 避免 --max 截断污染缓存(以前提取时就截断,缓存存的是截断版,后续大 max 请求也命中残缺)。 */
function printFetchResult(r, maxChars) {
  console.log(`📄 标题: ${stripControl(r.title)}`);
  if (r.publishedAt) console.log(`   ⏱ 发布时间: ${stripControl(r.publishedAt)}`);
  if (r.metaDesc) console.log(`   简介: ${stripControl(r.metaDesc)}`);
  console.log(`   来源: ${r.url}\n`);
  const body = r.markdown || r.body || "(正文为空)";
  console.log(stripControl(body.slice(0, maxChars)));
}

/** 写页面缓存(6h TTL,同一 URL 重复抓取秒回)—— 调度层显式决策,不在输出函数里做副作用。
 * 只缓存正文达线(full)的结果:空壳(SPA Loading 占位/短页)不缓存,①避免 6h 内重复命中空壳;
 * ②空壳会在下次 fetch 被浏览器兜底修复,旧空壳缓存会让修复永远不生效。
 * 缓存命中回放(_cached)不重复写。(导出供决策链单测) */
export function cacheFetchResult(r) {
  if (!r || r._cached || !r.url || !r.markdown) return;
  const { kind } = classifyFetchResult(r, REP_FETCH_MIN_OK_CHARS);
  if (kind !== "full") {
    dbg(`不写缓存: 分类=${kind}(${(r.markdown || "").length}字符 < ${REP_FETCH_MIN_OK_CHARS})`);
    return;
  }
  pageCachePut(r.url, { title: r.title, publishedAt: r.publishedAt, metaDesc: r.metaDesc, url: r.url, markdown: r.markdown });
  dbg(`写入缓存: ${r.url} (${(r.markdown || "").length}字符, 6h TTL)`);
}

/** 抓取结果统一出口:先缓存(达线才写,存完整正文),再按请求 maxChars 截断输出 ——
 * 所有成功路径(直连/存档/浏览器兜底)都走这里,避免各分支各自调 printFetchResult 时漏写或误写缓存 */
export function emitFetchResult(r, maxChars = 3000) {
  cacheFetchResult(r);
  printFetchResult(r, maxChars);
}

/** 输出热搜榜结果(单榜失败置 error,不影响其他榜) */
export function printHotlist(result) {
  for (const [key, b] of Object.entries(result)) {
    console.log(`🔥 ${b.name}${b.note ? ` [${b.note}]` : ""}${b.error ? ` (抓取失败: ${b.error})` : ` → ${b.items.length} 条`}\n`);
    b.items.forEach((x, i) => {
      console.log(`${i + 1}. ${x.title}${x.heat ? `  (${x.heat})` : ""}`);
      console.log(`   🔗 ${x.url}`);
      console.log();
    });
    if (b.items.length === 0 && !b.error) console.log("(榜单为空)");
  }
}

/** 输出 GitHub Trending 榜单 */
export function printTrending(b) {
  console.log(`📈 GitHub 热门 [${b.note || "今日"}]${b.error ? ` (抓取失败: ${b.error})` : ` → ${b.items.length} 个仓库`}\n`);
  b.items.forEach((x, i) => {
    const star = x.starsDelta ? ` · ${x.deltaUnit ? "+" + x.starsDelta + "⭐/" + x.deltaUnit : "+" + x.starsDelta + "⭐"}` : "";
    const lang = x.lang ? ` · ${x.lang}` : "";
    console.log(`${i + 1}. ${x.name}${star}${lang}`);
    if (x.desc) console.log(`   ${x.desc.slice(0, 100)}`);
    console.log(`   🔗 ${x.url}`);
    console.log();
  });
  if (b.items.length === 0 && !b.error) console.log("(榜单为空)");
}
