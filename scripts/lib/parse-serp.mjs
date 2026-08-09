/**
 * parse-serp.mjs — 解析器包装器:三层防御 + 双判据动态降级
 *
 * 目标:站点改版 → 降级为"质量下降 + 日志提示",而非功能中断。
 *
 * 降级判据(双判据,任一满足即保级特异性解析器):
 *   A. 绝对比例:specificCount / min(limit, domEntryCount) ≥ 0.5
 *      domEntryCount = 特异性解析器顺手返回的"页面实际结果容器数"(成本≈0),
 *      缺失时退化为 limit —— 冷门查询(真实结果不足 limit)靠它避免误报
 *   B. 相对质量:specificCount ≥ 5 且 specificCount ≥ genericCount
 *      特异性虽比例不高但仍优于通用时不降级
 *   只有特异性结果 < 5 且通用解析器明显更多时才切换
 *
 * 零回归保证:判据 A 通过(特异性正常)时通用解析器完全不执行,输出逐字节不变。
 * 逐次独立判定,进程内无状态:站点修复后自动恢复特异性,无需跨进程缓存(YAGNI)。
 *
 * 调用链:引擎 search() 的 parse 换成 `(html, limit) => parseSerp(html, {...})`;
 * 特异性解析器(引擎文件里的正则/DOM 解析)原样保留,只包装。
 */

import { parseSerpGeneric, urlstreamExtract } from "./serp-generic.mjs";

/** 判据 A 阈值:特异性比例达标即保级 */
const MIN_HIT_RATE = 0.5;
/** 判据 B 下限:特异性至少这么多条才考虑"相对质量保级" */
const MIN_SPECIFIC_COUNT = 5;

/**
 * 包装特异性解析器,按双判据决定采用哪层。
 * @param {string} html 原始页面
 * @param {Object} cfg
 * @param {string} cfg.engineKey 引擎 key(诊断/日志用)
 * @param {(html:string, limit:number)=>{blocked?:boolean, reason?:string, results:Array, domEntryCount?:number}} cfg.specific 现有特异性解析器
 * @param {RegExp} [cfg.urlShape] 层③ URL 形态(JSON 内嵌页,如 /\/group\/\d+\//)
 * @param {number} cfg.limit 目标条数
 * @param {string[]} [cfg.excludeHosts] 排除的引擎自身域(层②用)
 * @returns {{blocked:boolean, reason?:string, results:Array, parsedBy:"specific"|"generic"|"urlstream"|"none", hitRate:number, specificCount:number, genericCount:number}}
 */
export function parseSerp(html, { engineKey, specific, urlShape, limit, excludeHosts }) {
  // ① 特异性解析器(现有,零改动)
  let specificOut = { blocked: false, results: [], reason: "" };
  try {
    specificOut = specific(html, limit) || { blocked: false, results: [] };
  } catch (e) {
    specificOut = { blocked: true, reason: (e.message || e).slice(0, 120), results: [] };
  }
  const specificCount = (specificOut.results || []).length;
  // 判据 A 的分母:页面实际结果容器数(缺失退化为 limit)
  const domEntryCount = typeof specificOut.domEntryCount === "number" ? specificOut.domEntryCount : limit;
  const denom = Math.max(1, Math.min(limit, domEntryCount));
  const hitRate = specificCount / denom;

  // 判据 A:比例达标 → 保级,通用解析器完全不执行(零回归)
  if (specificCount > 0 && hitRate >= MIN_HIT_RATE) {
    return { ...specificOut, parsedBy: "specific", hitRate, specificCount, genericCount: 0 };
  }

  // 需要通用结果做判据 B / 降级
  let genericResults = [];
  let genericCount = 0;
  try {
    const g = parseSerpGeneric(html, limit, { excludeHosts });
    genericResults = g.results || [];
    genericCount = genericResults.length;
  } catch {
    /* 通用解析失败不阻断 */
  }

  // 判据 B:特异性 ≥5 条且 ≥ 通用 → 相对质量保级
  if (specificCount >= MIN_SPECIFIC_COUNT && specificCount >= genericCount && specificCount > 0) {
    return { ...specificOut, parsedBy: "specific", hitRate, specificCount, genericCount };
  }
  // 通用解析器明显更多 → 降级采用通用(站点可能改版的典型信号)
  if (genericCount > specificCount) {
    return {
      blocked: false,
      results: genericResults,
      parsedBy: "generic",
      hitRate,
      specificCount,
      genericCount,
      reason: `特异性命中 ${specificCount}/${denom},已降级通用解析器(站点可能改版,engine=${engineKey})`,
    };
  }
  // 通用也不如特异性 → 保底用特异性(避免降级到更差)
  if (specificCount > 0) {
    return { ...specificOut, parsedBy: "specific", hitRate, specificCount, genericCount };
  }

  // 层③ URL 流兜底(JSON 内嵌页专用)
  if (urlShape) {
    try {
      const us = urlstreamExtract(html, urlShape, limit);
      if (us.results.length > 0) {
        return {
          blocked: false,
          results: us.results,
          parsedBy: "urlstream",
          hitRate: 0,
          specificCount,
          genericCount,
          reason: `特异性/通用解析均 0 命中,已用 URL 流兜底(engine=${engineKey})`,
        };
      }
    } catch {
      /* 兜底失败继续 */
    }
  }

  // 全失败
  return {
    blocked: true,
    reason: specificOut.reason || `解析器全部失败:特异性 ${specificCount} 条,通用 ${genericCount} 条(engine=${engineKey})`,
    results: [],
    parsedBy: "none",
    hitRate,
    specificCount,
    genericCount,
  };
}
