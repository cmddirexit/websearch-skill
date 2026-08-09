/**
 * aggregate.mjs — 多引擎聚合(并行抓取 + URL 去重合并)
 *
 * 背景:直连搜索引擎对自动化访问每页固定 ~10 条(count/first/翻页参数全部被忽略,
 * 实测 first=11 与第一页 10/10 标题重叠)。要更多结果只能聚合多个引擎:
 * 不同引擎的排名算法/索引互补,同查询重叠率约 40~60%,三引擎去重后 ~20-30 条。
 *
 * 设计(可扩展):
 *  - 聚合伙伴在 engines.conf.json 的 aggregateWith 声明(声明式,新引擎注册时顺带声明即可)
 *  - 查询语言过滤:zhOnly/enOnly 声明(如英文查询跳过百度避免中文污染,中文查询跳过 marginalia);
 *    含 CJK 字符视为中文查询
 *  - 并行 Promise.allSettled:单引擎失败/超时不阻塞其它引擎,聚合永不因单点失败而全挂
 *  - 主引擎结果原序在前(质量最高),补充引擎按声明顺序、去重后接在后面
 *  - 去重:只按规范化 URL 精确匹配。相同标题可能是不同页面/版本,保留到语义转载
 *    折叠阶段处理,以便 duplicateItems 仍可恢复每个 URL
 *  - 每引擎分配 ceil(limit/引擎数) 条(上限 10=引擎单页硬限),整条链路受 deadline 预算约束
 */

import { URL } from "node:url";
import { withBudget } from "./budget.mjs";
import { createCooldown } from "./cooldown.mjs";
import { tcpProbe } from "./http.mjs";
import { PER_ENGINE_TIMEOUT_MS, ENGINE_FAIL_FILE, PROBE_TIMEOUT_MS } from "./config.mjs";
import { normalizeTitle, isNearDuplicateTitle } from "./html.mjs";
// re-export 保持外部(tests 旧引用)兼容:文本工具已下沉 html.mjs
// (cluster.mjs 不再依赖本调度模块,依赖方向恢复为 调度→纯函数)
export { normalizeTitle, isNearDuplicateTitle };

/** 每引擎默认单页上限(搜索引擎硬限;API 类引擎在 engines.conf.json 用 pageLimit 声明更大值) */
export const ENGINE_PAGE_LIMIT = 10;

// ---- 引擎失败记忆(通用冷却) ----
// 引擎失败记忆(通用冷却工具,跨进程持久化):连续失败 FAIL_THRESHOLD 次 →
// 冷却 FAIL_COOLDOWN_MS,期内聚合直接跳过不再请求。直连不通的引擎(如 CN 网络
// 下 api.github.com)首次失败后,后续搜索直接跳过,不再每次等满超时;
// 成功自动清零,恢复后自动重新参与。
const engineCooldown = createCooldown({
  threshold: 2,
  cooldownMs: 30 * 60_000, // 直连不通的场景按 30 分钟记(成功清零,不误伤)
  file: ENGINE_FAIL_FILE,
});

/** 聚合内是否处于冷却(测试可直调) */
export function isEngineCooled(key) {
  return engineCooldown.isCooled(key);
}

/** 记录引擎成败(内部):成功清零,失败累计,达阈值进入冷却;状态写回磁盘跨进程生效 */
function markEngineOutcome(key, ok) {
  engineCooldown.mark(key, ok);
}

/** 测试钩子:清空失败状态(含磁盘) */
export function resetEngineFailState() {
  engineCooldown.reset();
}

/** URL 规范化:去 www./m. 前缀、去尾斜杠、去 utm/tracking 参数 → 用于去重 */
export function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    u.hostname = u.hostname.replace(/^(www|m|mobile)\./i, "");
    u.hash = "";
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|spm|ref|source|mtm_|_ga)/i.test(p)) u.searchParams.delete(p);
    }
    let s = u.toString().replace(/\/$/, "");
    return s.replace(/^https?:\/\//, "");
  } catch {
    return raw;
  }
}

/**
 * 多引擎聚合搜索。
 * @param {Object} engines loadEngines() 结果(engineKey → {search, fallbacks})
 * @param {string} query 查询词
 * @param {number} limit 目标总条数
 * @param {string[]} partners 聚合伙伴引擎 key(含主引擎,主引擎在前;如 ["bing","baidu","marginalia"])
 * @param {number} deadline 硬预算时间戳(Date.now()+预算)
 * @returns {Promise<{engine:string, mode:"aggregate", results:Array, sources:Array<string>, counts:Object, blocked:boolean}>}
 */
export async function aggregateSearch(engines, query, limit, partners, deadline, opts) {
  // 查询语言过滤:含 CJK → 中文查询(跳过 enOnly);纯 ASCII → 英文查询(跳过 zhOnly)
  const isZh = /[\u4e00-\u9fff]/.test(query);
  let filtered = partners.filter((key) => {
    const eng = engines[key];
    if (!eng) return true; // 未注册引擎保留(由下方任务报错)
    if (isZh && eng.enOnly) return false;
    if (!isZh && eng.zhOnly) return false;
    return true;
  });
  if (filtered.length === 0) filtered = partners; // 全部被语言过滤(理论上不可能,bing 通用) → 保底
  // TCP 连通性预检:不通的引擎直接跳过,不再发起搜索请求(如 CN 网络下 api.github.com
  // 连接超时,每次聚合都等满单引擎超时;预检 2s 并发探测,总耗时 ≈ 探测超时)。
  // 探测失败计入失败记忆(连续 2 次进冷却),避免每次搜索重复探测。
  const skippedHosts = [];
  const probeTargets = filtered.filter((k) => engines[k]?.host);
  if (probeTargets.length > 0) {
    const probeResults = await Promise.all(
      probeTargets.map(async (k) => [k, await tcpProbe(engines[k].host)])
    );
    const unreachable = probeResults.filter(([, ok]) => !ok).map(([k]) => k);
    if (unreachable.length > 0) {
      filtered = filtered.filter((k) => !unreachable.includes(k));
      for (const k of unreachable) {
        markEngineOutcome(k, false);
        skippedHosts.push(`${k}:${engines[k].host} 连接失败`);
      }
    }
  }
  // 每引擎分配目标条数:至少抓满单页(普通引擎 10 条,API 类按 pageLimit)。
  // 旧实现均分(7 引擎 → 每引擎 ceil(30/7)=5 条),去重+失败引擎后常不足目标
  // (旧实现均分导致去重后不足目标;抓满单页后原始量足,去重仍可达 limit)
  const targets = filtered.map((key) => {
    const pageLimit = engines[key]?.pageLimit || ENGINE_PAGE_LIMIT;
    return Math.min(pageLimit, Math.max(Math.ceil(limit / filtered.length), Math.min(ENGINE_PAGE_LIMIT, limit)));
  });
  const tasks = filtered.map(async (key, i) => {
    const perEngine = targets[i];
    const eng = engines[key];
    if (!eng) return { key, results: [], error: `未注册引擎 ${key}` };
    if (isEngineCooled(key)) return { key, results: [], error: "连续失败已进入冷却期,跳过" };
    const remain = deadline - Date.now();
    if (remain <= 0) return { key, results: [], error: "预算耗尽" };
    try {
      // 单引擎受“全局剩余预算”与“单引擎独立上限”双约束:慢引擎(原生 fetch 无
      // 超时/网络不稳)挂起时快速放弃,不让它拖满 TOTAL_BUDGET_MS 拖慢聚合
      // (底层浏览器进程由自身超时/进程树清理兜底)
      const budget = Math.min(remain, PER_ENGINE_TIMEOUT_MS);
      const r = await withBudget(eng.search(query, perEngine, opts), budget, key);
      if (!r || r.blocked) {
        markEngineOutcome(key, false); // 失败记忆:连续失败进入冷却
        return { key, results: [], error: r?.reason || "blocked" };
      }
      markEngineOutcome(key, true);
      return { key, results: r.results || [] };
    } catch (e) {
      markEngineOutcome(key, false);
      return { key, results: [], error: (e.message || e).slice(0, 80) };
    }
  });
  const settled = await Promise.allSettled(tasks);
  const buckets = new Map(); // key → results
  const counts = {}; // 聚合信息:key → {fetched, kept}
  const errors = [];
  // 预检跳过的引擎也计入聚合信息(如 github:api.github.com 连接失败)
  if (skippedHosts.length > 0) errors.push(...skippedHosts);
  settled.forEach((s) => {
    if (s.status !== "fulfilled" || !s.value) return;
    const { key, results, error } = s.value;
    if (error) {
      errors.push(`${key}:${error}`);
      return;
    }
    buckets.set(key, results);
    counts[key] = { fetched: results.length, kept: 0 };
  });
  if (buckets.size === 0) {
    return {
      engine: partners[0], mode: "aggregate", blocked: true,
      reason: `聚合引擎全部失败(${errors.join("; ")})`, results: [],
      sources: [], counts,
    };
  }
  // 主引擎优先保序,补充引擎按声明顺序;只做 URL 精确去重。
  // 近似转载(换措辞/同源改写)不再在此硬丢弃 —— 由 cluster.mjs 语义转载折叠
  // (向量余弦 + 文本证据,软折叠保留 URL)处理,字符 LCS 硬过滤已移除(误杀风险)。
  // 目标条数可能因 pageLimit 未满(如 bing 10 < 均分 25):此时补充引擎继续抓满差值
  const seen = new Set();
  const merged = [];
  for (const key of filtered) {
    const list = buckets.get(key) || [];
    for (let sourceIndex = 0; sourceIndex < list.length; sourceIndex++) {
      const r = list[sourceIndex];
      const ukey = normalizeUrl(r.url);
      if (seen.has(ukey)) continue;
      seen.add(ukey);
      // 保留来源内名次。聚合数组仍按主引擎优先拼接,但相关性评分不能把补充
      // 引擎的第 1 名误当成全局第 11/21 名。
      merged.push({ ...r, src: key, sourceRank: sourceIndex + 1, sourceCount: list.length });
      if (counts[key]) counts[key].kept++;
    }
  }
  // 补充去重信息(供输出展示)
  const note = Object.entries(counts)
    .filter(([, c]) => c.fetched > 0)
    .map(([k, c]) => `${k}×${c.kept}(${c.fetched})`)
    .join(" + ");
  return {
    engine: filtered.join("+"),
    mode: "aggregate",
    blocked: false,
    // 合并顺序即引擎声明顺序(主引擎在前);去重后若超出目标条数,截断到 limit,
    // 保证默认 99 就尽量抓满 99 条(旧行为: 每引擎均分 5 条,去重后经常只有 ~20)
    results: merged.slice(0, limit),
    sources: partners.filter((k) => counts[k]?.fetched > 0),
    counts,
    note: note ? `多引擎聚合: ${note}` : "",
    // 聚合后的结果已含各引擎自己的 blocked 处理;若主引擎直连失败但补充引擎成功,
    // 记录用于降级提示(不阻塞)
    _errors: errors,
  };
}
