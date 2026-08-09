/**
 * timeline.mjs — 时间线命令:多篇报道自动串成时间线
 *
 * 痛点:复杂事件(美伊冲突、地区局势等)的报道分散在多篇文章里(时间跨度数月),
 * 单次搜索 + 单篇 fetch 只能看到孤点,看不清"4 月发生了什么 → 5 月升级 → 8 月停火"的脉络。
 *
 * 流程:聚合搜索(默认多引擎)→ 过滤广告 → 取前 N×3 条候选 → 并行抓取正文(直连优先,
 * 空壳浏览器兜底,并发 3)→ 提取发布时间(date-ml 多候选裁决)+ 首段要点 → 按日期排序
 * 分组输出。无日期文章单独列出(URL 不丢)。
 *
 * 成本控制:抓取阶段全局预算 75s(手机上避免拖到几分钟);单篇直连 20s / 浏览器 45s 上限。
 */

import { loadEngines } from "./engines/registry.mjs";
import { TOTAL_BUDGET_MS } from "./config.mjs";
import { aggregateSearch } from "./aggregate.mjs";
import { filterResults, parseResultDateAgo } from "./filter.mjs";
import { stripControl, normalizeCnDate, extractSerpDate } from "./html.mjs";

/** 抓取阶段全局预算(超出放弃剩余抓取,已抓的照常输出) */
const FETCH_BUDGET_MS = 75_000;
/** 单篇直连超时 / 浏览器兜底超时 */
const FETCH_DIRECT_TIMEOUT_MS = 20_000;
const FETCH_BROWSER_TIMEOUT_MS = 45_000;
/** 并行抓取并发数(手机上 3 个 chromium/node 进程并行已较激进) */
const CONCURRENCY = 3;

/** 带超时的 Promise(超时 resolve null,不抛错 —— 抓取失败只是少一条时间线节点) */
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      () => { clearTimeout(t); resolve(null); },
    );
  });
}

/** 时间线日期归一化 → YYYY-MM-DD(排序/分组用)。
 * SERP 日期格式混杂("2026年3月14日"/"1天前"/"前天"),不归一化会排错序、分组乱。
 * 归一化失败返回原串(沉底到无日期区显示,不丢)。 */
function absDate(d) {
  if (!d) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  // 中文绝对日期(2026年3月14日)先归一化
  const cn = normalizeCnDate(d);
  if (cn) return cn;
  // 相对时间("3天前"/"昨天")→ 绝对(必须先于 extractSerpDate:后者对相对时间原样返回)
  const ago = parseResultDateAgo(d);
  if (ago !== null) {
    const t = new Date(Date.now() - ago * 86400000);
    const y = t.getFullYear();
    const m = String(t.getMonth() + 1).padStart(2, "0");
    const day = String(t.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  // 标准绝对格式(2026-08-05/2026/08/05)
  const sd = extractSerpDate(d);
  if (/^\d{4}-\d{2}-\d{2}$/.test(sd)) return sd;
  // 无法解析 → 空(进“无日期”区,URL 不丢;返回原串会让垃圾月份分组混入时间线)
  return "";
}

/** 并发受限的 map(简单池实现,保持结果顺序) */
async function pMap(items, fn, concurrency) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 抓单篇:直连优先;正文 <200 字符(空壳/SPA)→ 浏览器渲染兜底。失败/超时 → null。 */
async function fetchTimelinePage(url) {
  const { fetchPageDirect } = await import("./fetch-page.mjs");
  const { fetchViaBrowser } = await import("./engines/browser.mjs");
  const direct = await withTimeout(fetchPageDirect(url, 6000), FETCH_DIRECT_TIMEOUT_MS);
  if (direct) {
    const raw = (direct.markdown || direct.body || "").trim();
    if (raw.length >= 200) return direct;
  }
  // 空壳 → 浏览器兜底(直连 200 非 CF:skipZendriver,虚拟时间轮等 JS 渲染)
  const br = await withTimeout(fetchViaBrowser(url, 6000, { skipZendriver: true }), FETCH_BROWSER_TIMEOUT_MS);
  if (br && !br.notFound) return br;
  return null;
}

/** 从 markdown 提取首段要点(去掉标题行/链接语法,取第一个有实质内容的句子,≤150 字) */
function firstParagraph(markdown) {
  const lines = String(markdown || "")
    .split("\n")
    .map((l) =>
      l
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // 图片
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // 链接 → 文本
        .replace(/^#{1,6}\s*/, "") // 标题
        .replace(/^>\s*/, "")
        .trim(),
    )
    .filter((l) => l.length >= 12); // 跳过短导航行
  return (lines[0] || "").slice(0, 150);
}

/**
 * 时间线主入口。
 * @param {string} query 事件/主题
 * @param {number} limit 最多抓取多少篇(默认 8,上限 12)
 */
export async function runTimeline(query, limit = 8) {
  const engines = loadEngines();
  const engine = engines["bing"];
  const partners = engine.aggregateWith || [];
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  // 1. 聚合搜索(与默认 search 同通道)
  let results = [];
  const agg = await aggregateSearch(engines, query, 99, ["bing", ...partners], deadline, {});
  if (!agg.blocked && agg.results.length) results = agg.results;
  if (!results.length) {
    try {
      const r = await engines.bing.search(query, 30, {});
      results = r?.results || [];
    } catch { /* 主引擎失败 → 空结果 */ }
  }
  if (!results.length) {
    console.log(`📅 时间线 "${query}":搜索无结果(可换主题词或稍后重试)`);
    return;
  }
  const { kept } = filterResults(results);
  if (!kept.length) {
    console.log(`📅 时间线 "${query}":结果全部被广告过滤,无可用条目`);
    return;
  }
  console.error(`[timeline] 搜索 ${results.length} 条,过滤后 ${kept.length} 条,抓取前 ${Math.min(limit * 3, kept.length)} 条候选...`);
  // 2. 取候选(优先带日期的 —— 时间线需要锚点;其余按引擎顺序)
  const dated = kept.filter((r) => r.date);
  const undated = kept.filter((r) => !r.date);
  const candidates = [...dated, ...undated].slice(0, Math.min(limit * 3, kept.length));
  // 3. 并行抓取(全局预算内;超预算的候选跳过)
  const t0 = Date.now();
  const items = await pMap(
    candidates,
    async (c) => {
      if (Date.now() - t0 > FETCH_BUDGET_MS) return null; // 预算耗尽,放弃剩余
      // 单篇抓取上限动态收紧:不超全局预算(3 并发最坏情况也要受控)
      const remain = FETCH_BUDGET_MS - (Date.now() - t0);
      const page = await withTimeout(fetchTimelinePage(c.url), Math.max(5_000, remain));
      if (!page) return null;
      return {
        title: page.title || c.title,
        url: c.url,
        date: absDate(page.publishedAt || c.date || ""),
        desc: firstParagraph(page.markdown || ""),
        source: (() => { try { return new URL(c.url).host.replace(/^www\./, ""); } catch { return c.url; } })(),
      };
    },
    CONCURRENCY,
  );
  const got = items.filter(Boolean);
  if (!got.length) {
    console.log(`📅 时间线 "${query}":搜索有结果但抓取全部失败(反爬/超时),URL 如下 ——`);
    kept.slice(0, 10).forEach((r) => console.log(`  - ${stripControl(r.title)}\n    ${r.url}`));
    return;
  }
  // 4. 排序输出:有日期按时间升序分组;无日期单列
  const withDate = got.filter((i) => i.date).sort((a, b) => a.date.localeCompare(b.date));
  const noDate = got.filter((i) => !i.date);
  const span = withDate.length >= 2 ? `${withDate[0].date} → ${withDate[withDate.length - 1].date}` : withDate[0]?.date || "";
  console.log(`\n📅 时间线 "${query}" — ${got.length} 篇报道${span ? ` · 时间跨度 ${span}` : ""}\n`);
  let curMonth = "";
  for (const i of withDate) {
    const month = i.date.slice(0, 7);
    if (month !== curMonth) {
      curMonth = month;
      console.log(`## ${month}`);
    }
    const day = i.date.slice(5);
    console.log(`- **${day}** [${stripControl(i.title)}](${i.url})${i.source ? ` · ${i.source}` : ""}`);
    if (i.desc) console.log(`  ${stripControl(i.desc)}`);
  }
  if (noDate.length) {
    console.log(`\n## 无日期(未入线,URL 保留)`);
    noDate.forEach((i) => {
      console.log(`- [${stripControl(i.title)}](${i.url})${i.source ? ` · ${i.source}` : ""}`);
      if (i.desc) console.log(`  ${stripControl(i.desc)}`);
    });
  }
  console.log(`\n(抓取 ${got.length}/${candidates.length} 篇,耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s;时间线建议配合 fetch 深挖单篇细节)`);
}
