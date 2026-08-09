/**
 * domain-rep.mjs — 域名信誉评分 + 在线跨域模式学习(软限制,非硬剔除)
 *
 * 动机:中文搜索结果的软文污染是动态演化的(SEO 站群换域名/换路径/换模板),
 * 静态黑名单或 site: 限定治标不治本。逐域名独立评分在新域名面前是盲区
 * (每个新域名都要从零积累样本才被识别)—— 故在域名级学习之上叠加在线模式模型。
 * 历史 API/文档称其为“元学习”,算法本质是带持久化的在线逻辑回归,不是 MAML 类
 * learning-to-learn。跨域模型只接受独立质量证据,规则自身生成的标签不得反训规则特征。
 *
 * ┌─────────────────────── 双循环结构 ───────────────────────┐
 * │ 内循环(模式学习):已知域名积累的样本(特征 + 实际质量贡献)  │
 * │   → 在线更新模式权重(特征→垃圾概率),类似感知机/逻辑回归    │
 * │ 外循环(冷启动匹配):新域名首次出现(无自身样本)             │
 * │   → 提取特征 → 用模式权重预测初始信誉分,立即软降权/加权    │
 * │ 反馈闭环:每次结果更新域名自身;有独立质量标签时才更新       │
 * │   跨域模式权重,避免规则标签反训规则特征                    │
 * └───────────────────────────────────────────────────────────┘
 *
 * 三级信号(弱→强):
 *   - 规则质量分 quality + 低质标记(filter.mjs,推断)
 *   - fetch 实测正文质量(空壳/404 → 0.1;有实质正文 → 0.95)
 *
 * 域名级学习:searchScore(递减学习率)+ fetchScore(实测优先融合,0.7/0.3)。
 * 在线模式学习:token 特征(标题 bigram/英文词 + URL 段 + 内容标记,无人工词表)
 *   → updateMetaTokens 在线更新 token 权重 —— 哪些 token 预示低质由数据决定,非硬匹配。
 * 衰减:30 天未见的域名向中性 0.5 回归,90 天完全中性(不永久定罪)。
 * 应用:信誉分映射为 quality 的乘性因子(软降权)—— 低信誉压沉不剔除,高信誉微升。
 * 透明:展示层打 badge(⚠[rep:0.31] / ✓[rep:0.82] / [meta:0.33] 冷启动预测)。
 *
 * 持久化:~/.cache/websearch-domain-rep.json(跨 CLI 进程增量积累)
 */
import { existsSync, readFileSync } from "node:fs";
import {
  REP_FILE, REP_MIN_SAMPLES, REP_STRENGTH, REP_DECAY_START_DAYS, REP_DECAY_FULL_DAYS,
  REP_MAX_DOMAINS, REP_FETCH_OK_CONTRIB, REP_FETCH_EMPTY_CONTRIB,
  META_LR, META_MIN_SAMPLES, META_COLD_CLAMP, META_MAX_WEIGHTS, META_STRONG_LR, META_TRUST_FULL_SAMPLES,
} from "./config.mjs";
import { judgeResults, judgeText, judgeCacheGet } from "./llm-judge.mjs";
import { atomicWriteJsonSync } from "./state-file.mjs";

// 实例内部使用的纯函数(显式 import,re-export 不创建当前作用域绑定)
import { clamp, CONTENT_LOW_FLAGS, contributionFromQuality, updateScore, updateFetchScore, effectiveScore, decayedScore, repFactor, repBadge, predictTokens, updateMetaTokens } from "./rep-score.mjs";
import { FUNCTIONAL_PATH_RE, registrableHost, repKeys, extractLearnFeatures, titleFlagTokens, urlTokens, GENERIC_DOMAIN_LABELS } from "./rep-features.mjs";

// v3 切断了查询相关性负反馈和规则标签→规则特征的目标泄漏。旧模型无法逐样本
// 反演出污染来源,因此按缓存 schema 失效并从中性重新学习。
const REP_SCHEMA_VERSION = 3;

// ---- re-export(公共 API 不变:index.mjs / domain-rep.test.mjs / backtest-meta.mjs 零改动) ----
export { clamp, CONTENT_LOW_FLAGS, contributionFromQuality, updateScore, updateFetchScore, effectiveScore, decayedScore, repFactor, repBadge, predictTokens, updateMetaTokens } from "./rep-score.mjs";
export { ENGINE_DOMAINS, FUNCTIONAL_PATH_SEGS, FUNCTIONAL_PATH_RE, registrableHost, repKeys, cnBigrams, enWords, GENERIC_DOMAIN_LABELS, urlTokens, flagTokens, extractLearnFeatures, titleFlagTokens } from "./rep-features.mjs";

// ==================== 信誉库实例 ====================

/**
 * 信誉库实例:域名级学习 + 元学习(双循环) + 应用。
 * 模块单例由调用方创建(cli.mjs),库复用可自建。
 * @param {Object} [opts] @param {string} [opts.file=REP_FILE] 持久化文件
 */
export function createDomainReputation({ file = REP_FILE } = {}) {
  let domains = {}; // key → {searchScore, fetchScore, searchSamples, fetchSamples, lowHits, okHits, fetchOk, fetchEmpty, firstSeen, lastSeen}
  let meta = { bias: 0, weights: {}, touched: {}, lastStep: {}, freq: {}, weightSamples: 0 }; // 元学习模式参数(内循环产物,token→权重)

  function load() {
    try {
      if (!file || !existsSync(file)) return;
      const j = JSON.parse(readFileSync(file, "utf8"));
      if (j.version !== REP_SCHEMA_VERSION) return;
      domains = j.domains || {};
      meta = { bias: 0, weights: {}, touched: {}, lastStep: {}, freq: {}, weightSamples: 0, ...(j.meta || {}) };
      // token 权重时间衰减:模式记着过时的软文词会永久压制新内容(站点/站群会换模板),
      // 距上次持久化越久,权重整体向 0 收缩(半衰期 90 天):过时模式淡出,活跃模式保留。
      if (j.updatedAt) {
        const days = (Date.now() - j.updatedAt) / 86400000;
        if (days > 1 && Object.keys(meta.weights).length) {
          const k = Math.pow(0.5, days / 90);
          for (const t in meta.weights) meta.weights[t] *= k;
        }
      }
      // 一次性清理:历史上学到的泛域名标签权重(d:com/www/org 被正常站推成 +0.3~0.4,
      // 新代码已不再生成这类 token,这里清掉存量,避免冷启动预测被系统性推正)
      for (const t of Object.keys(meta.weights)) {
        if (t.startsWith("d:")) {
          const lab = t.slice(2);
          if (lab === "www" || lab.length === 2 || GENERIC_DOMAIN_LABELS.has(lab)) {
            delete meta.weights[t];
            delete meta.touched[t];
            delete meta.lastStep[t];
            delete meta.freq[t];
          }
        }
      }
    } catch {
      domains = {};
      meta = { bias: 0, weights: {}, touched: {}, lastStep: {}, weightSamples: 0 };
    }
  }
  load();

  function save() {
    if (!file) return;
    try {
      const entries = Object.entries(domains);
      if (entries.length > REP_MAX_DOMAINS) {
        // 超上限:清最久未见的一半(优先保留近期活跃域名,旧站群自然淘汰)
        entries.sort((a, b) => (a[1].lastSeen || 0) - (b[1].lastSeen || 0));
        for (const [k] of entries.slice(0, Math.floor(REP_MAX_DOMAINS / 2))) delete domains[k];
      }
      atomicWriteJsonSync(file, { version: REP_SCHEMA_VERSION, updatedAt: Date.now(), meta, domains });
    } catch {
      /* 写失败不影响主流程 */
    }
  }

  function getEntry(key) {
    if (!domains[key]) {
      domains[key] = { searchScore: 0.5, fetchScore: 0.5, searchSamples: 0, fetchSamples: 0, trustedSamples: 0, lowHits: 0, okHits: 0, fetchOk: 0, fetchEmpty: 0, fetchBlocked: 0, firstSeen: Date.now(), lastSeen: Date.now() };
    }
    return domains[key];
  }

  /**
   * 记录一个样本。域名级始终更新;learnMeta=true 时才更新跨域模式。
   * 模式 label = metaLabel(提供时)或 contribution —— LLM 内容可信度判断
   *   是可靠信号(quality 分只是形态分,学出来是主题偏置),见 learnFromResultsLLM;
   *   strong=true 用固定大学习率;trusted=true 标记独立 LLM/fetch 证据,只有它可在
   *   样本不足时让极端分提前生效,规则启发式分不得冒充高置信证据;
   * 域名级:searchScore 用绝对 contribution 递减学习;重复低质模式惩罚(样本≥5 且低质率>0.6 → ×0.6)。
   * @param {Set<string>} tokens 激活 token 集
   * @param {number} metaLabel 跨域模式专用 label(可选;缺省=contribution)
   */
  function record(url, contribution, { low = false, tokens = null, strong = false, trusted = false, metaLabel = null, learnMeta = true } = {}) {
    if (learnMeta) updateMetaTokens(meta, tokens || urlTokens(url), metaLabel ?? contribution, { strong });
    for (const key of repKeys(url)) {
      const e = getEntry(key);
      let c = contribution;
      if (e.searchSamples >= 5 && e.lowHits / e.searchSamples > 0.6) c *= 0.6;
      updateScore(e, c);
      if (trusted) e.trustedSamples = (e.trustedSamples || 0) + 1;
      if (low) e.lowHits++; else e.okHits++;
      e.lastSeen = Date.now();
    }
  }

  /**
   * LLM 增强版学习(推荐主路径):只对**未知域名**(自身样本 <3)调 LLM 判断内容可信度
   * —— 已知信誉的站(知乎/CSDN/百科)每次重复判断是浪费,直接 quality 学习(便宜);
   * 新域名(站群换的新域)才是冷启动要判的,通常只有几条,LLM 调用秒级完成。
   * LLM 不可用/失败 → 全部降级 quality 学习(不阻塞主流程)。
   * @returns {Promise<boolean>} 是否用了 LLM label
   */
  async function learnFromResultsLLM(results) {
    // 待 LLM 判断的 = 未知域名(新域名冷启动需要可信度判断)
    const needLLM = [];
    for (const r of results || []) {
      const host = registrableHost(r?.url);
      if (!host) continue;
      const e = domains[host];
      if (!e || (e.searchSamples || 0) < 3) needLLM.push(r);
    }
    const scores = needLLM.length ? await judgeResults(needLLM) : null;
    const scoreMap = new Map();
    if (scores) needLLM.forEach((r, i) => {
      if (i < scores.length && (!scores.judged || scores.judged[i])) scoreMap.set(r.url, scores[i]);
    });
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const url = r?.url;
      if (!url || FUNCTIONAL_PATH_RE.test(url)) continue;
      const flags = r.flags || [];
      if (flags.some((f) => f.startsWith("ad:"))) continue;
      const contentLow = flags.some((f) => CONTENT_LOW_FLAGS.has(f));
      const tokens = registrableHost(url)
        ? extractLearnFeatures(url, { title: r.title, desc: r.desc, flags })
        : titleFlagTokens(r.title, flags);
      // 新域名有 LLM 判断用可信度;已知域名/LLM 失败 → quality(便宜,不重复调 LLM)
      const llmScore = scoreMap.get(url);
      const contribution = llmScore !== undefined
        ? 0.05 + 0.9 * (1 - llmScore) // 软文 1.0 → 0.05(负),可信 0.0 → 0.95(正)
        : contributionFromQuality(r.quality ?? 0.5, flags);
      // quality/flags 同时也是 tokens 的输入特征,用其派生标签训练跨域模型会发生
      // 目标泄漏。没有独立 LLM 判断时只更新域名自身,不更新 token 权重。
      record(url, contribution, {
        low: contentLow,
        tokens,
        metaLabel: llmScore !== undefined ? contribution : null,
        learnMeta: llmScore !== undefined,
        trusted: llmScore !== undefined,
      });
    }
    return scoreMap.size > 0; // 是否用了 LLM label
  }

  /**
   * 从搜索结果学习(搜索完成后调用):每条非广告结果的 quality/flags → 域名分 + 模式。
   * 广告(ad:*)已硬剔除,不参与信誉(避免把广告联盟流量算进站点质量)。
   */
  function learnFromResults(results) {
    for (const r of results || []) {
      const url = r?.url;
      if (!url) continue;
      // 引擎功能页(如 baidu.com/landing 搜索落地页)不是内容,不参与信誉
      if (FUNCTIONAL_PATH_RE.test(url)) continue;
      const flags = r.flags || [];
      if (flags.some((f) => f.startsWith("ad:"))) continue;
      const contentLow = flags.some((f) => CONTENT_LOW_FLAGS.has(f));
      // 引擎跳转 URL(公众号加密链接等,域名无法归因)→ 只学标题特征,不学 URL token
      const tokens = registrableHost(url)
        ? extractLearnFeatures(url, { title: r.title, desc: r.desc, flags })
        : titleFlagTokens(r.title, flags);
      record(url, contributionFromQuality(r.quality ?? 0.5, flags), {
        low: contentLow,
        tokens,
        learnMeta: false,
      });
    }
    return domains;
  }

  /**
   * @deprecated 查询相关性不能作为全局域名质量标签。保留空操作以兼容旧调用方;
   * 折叠只应影响当前查询的展示,不应改变跨查询持久化信誉。
   */
  function learnCollapsed(_collapsed) {
    return domains;
  }

  /** fetch 实测反馈(空壳/404/网络失败 → 0.1 负):“页面打不开/没内容”才是可靠负信号,
   * 更新 fetchScore(实测优先融合) + 元学习(strong 固定大学习率)。
   * 注意:正文完整 ≠ 可信 —— 软文正文完整也能打开,正反馈必须走 learnFetchLLM(LLM 判内容)。 */
  function learnFetch(url, ok, extra = {}) {
    if (!url) return;
    const contrib = ok ? REP_FETCH_OK_CONTRIB : REP_FETCH_EMPTY_CONTRIB;
    const tokens = extractLearnFeatures(url, extra);
    record(url, contrib, { low: !ok, strong: true, trusted: true, tokens });
    for (const key of repKeys(url)) {
      const e = getEntry(key);
      updateFetchScore(e, contrib);
      if (ok) e.fetchOk = (e.fetchOk || 0) + 1;
      else e.fetchEmpty = (e.fetchEmpty || 0) + 1;
      e.lastSeen = Date.now();
    }
  }

  /** fetch 反爬/风控拦截(403/验证码/风控 JSON 页):内容可能很好只是被拦,中性不降分。
   * 区别于 learnFetch(空壳/HTTP 错误 = 真负):只记录 fetchBlocked 计数、更新 lastSeen,
   * 不动 fetchScore、不污染元学习 —— 风控页的 token 特征(40362 等)不代表内容质量。
   * 知乎等强反爬站直连 403、浏览器也被风控时走此通道,避免一次拦截把高分站钉到中性。 */
  function learnFetchBlocked(url, extra = {}) {
    if (!url) return;
    for (const key of repKeys(url)) {
      const e = getEntry(key);
      e.fetchBlocked = (e.fetchBlocked || 0) + 1;
      e.lastSeen = Date.now();
    }
  }

  /** fetch 正文完整后的可信度反馈(最强信号):正文前段给 LLM 判断是否拼凑软文。
   * 软文页能正常打开 —— “能抓到正文”不能当正反馈(盲点修复)。
   * **标题信号参与综合**(取标题与正文中更可疑的):SEO 站标题是软文模板、正文是伪装,
   * 只判正文会把软文站“洗白”(3bgg 案例:标题被判 1.0,正文被判 0.0 → 一次 fetch 从 0.11 拉回 0.64)。
   * 低信誉域名且无标题缓存:正反馈折价(0.95→0.6),需多次一致证据才翻身,防单次洗白。
   * LLM 判断:软文 → 0.1(负);可信 → 0.95(正);LLM 失败 → 0.6 温和正(保底)。
   * 更新 fetchScore + 元学习(strong + 标题/正文特征)。 */
  async function learnFetchLLM(url, extra = {}) {
    if (!url) return;
    const softScore = await judgeText(extra.body || extra.markdown, { title: extra.title, url });
    let contrib = 0.6; // LLM 不可用时的保底:正文完整是温和正(可访问性 ≠ 可信度)
    if (softScore !== null) {
      // 综合 = 标题与正文中更可疑的(标题判断来自搜索结果阶段的缓存;无缓存则只凭正文)
      const titleHit = judgeCacheGet(url, extra.title);
      const titleScore = titleHit ? titleHit.s : undefined;
      const combined = titleScore !== undefined ? Math.max(titleScore, softScore) : softScore;
      contrib = combined > 0.6 ? REP_FETCH_EMPTY_CONTRIB : (combined < 0.3 ? REP_FETCH_OK_CONTRIB : 0.5);
      // 低信誉域名(有效分 <0.35)且无标题信号可查:正反馈折价 —— 单次“正常正文”不足以洗白历史负分
      if (contrib > 0.6 && titleScore === undefined) {
        const host = registrableHost(url);
        const e = host ? domains[host] : null;
        if (e && effectiveScore(e) < 0.35) contrib = 0.6; // 温和正,需多次一致证据才恢复
      }
    }
    const tokens = extractLearnFeatures(url, extra);
    record(url, contrib, {
      low: contrib < 0.35,
      strong: true,
      tokens,
      // 正文可访问但 LLM 不可用时 contrib=0.6,这不是独立的内容可信度标签。
      learnMeta: softScore !== null,
      trusted: softScore !== null,
    });
    for (const key of repKeys(url)) {
      const e = getEntry(key);
      updateFetchScore(e, contrib);
      if (contrib > 0.6) e.fetchOk = (e.fetchOk || 0) + 1;
      else if (contrib < 0.4) e.fetchEmpty = (e.fetchEmpty || 0) + 1;
      e.lastSeen = Date.now();
    }
  }

  /**
   * 查询某条 URL 的信誉:null = 无样本且模式未成熟(冷启动)。
   * 已有样本 → 域名级分(衰减后);无样本 → 外循环冷启动:模式预测分
   * (压缩到 [META_COLD_CLAMP] 防极端,因子生效、badge 标 [meta:x.xx] 提示是预测)。
   */
  function lookup(url, extra = {}) {
    const keys = repKeys(url);
    const host = keys[0];
    if (!host) return null;
    const hostEntry = domains[host];
    const pathKey = keys[1];
    const pathEntry = pathKey ? domains[pathKey] : null;
    const pathSamples = pathEntry
      ? (pathEntry.searchSamples || 0) + (pathEntry.fetchSamples || 0)
      : 0;
    const pathScore = pathEntry ? decayedScore(pathEntry) : 0.5;
    // A path entry is more specific than its host. Use it once it has the normal evidence
    // threshold, or immediately when an independent LLM/fetch signal made it extreme.
    const usePath = Boolean(pathEntry) && (
      pathSamples >= REP_MIN_SAMPLES
      || ((pathEntry.trustedSamples || 0) > 0 && (pathScore <= 0.3 || pathScore >= 0.7))
    );
    const e = usePath ? pathEntry : hostEntry;
    const scope = usePath ? pathKey : host;
    const hasOwn = e && ((e.searchSamples || 0) + (e.fetchSamples || 0)) > 0;
    if (!hasOwn) {
      if (meta.weightSamples >= META_MIN_SAMPLES) {
        const tokens = extractLearnFeatures(url, extra);
        // 训练 label 分布偏正(搜索结果的正常命中大多 0.85+),预测分用压缩系数收到
        // 中性附近 —— 冷启动阶段保守不误伤:偏正预测只给有限微升,负权重驱动真降权;
        // 置信度渐进(Bayesian smoothing):模式越成熟(weightSamples 越多)越敢偏离中性,
        // 刚过门槛 0.55,满 META_TRUST_FULL_SAMPLES 后全量 1.0(见 config 注释)。
        const raw = predictTokens(tokens, meta);
        const trust = Math.min(1, meta.weightSamples / META_TRUST_FULL_SAMPLES);
        const score = clamp(0.5 + (raw - 0.5) * (0.5 + 0.5 * trust), META_COLD_CLAMP[0], META_COLD_CLAMP[1]);
        return { score, samples: 0, coldStart: true, factor: repFactor(score, REP_MIN_SAMPLES), badge: `[meta:${score.toFixed(2)}]`, fetchOk: 0, fetchEmpty: 0 };
      }
      return null;
    }
    const score = decayedScore(e);
    const samples = (e.searchSamples || 0) + (e.fetchSamples || 0);
    // 高置信提前生效:LLM/fetch 判断可靠,分数极端(≤0.3 或 ≥0.7)时样本 1 就干预 ——
    // 否则要等 3 样本,而站群域名每次搜索只出现 1-2 次,可能永远到不了 3,学习白做。
    // 中性分(0.3~0.7)仍零干预(样本不足不冤枉,等积累)。
    const trusted = (e.trustedSamples || 0) > 0;
    const effSamples = samples >= REP_MIN_SAMPLES || (trusted && (score <= 0.3 || score >= 0.7))
      ? Math.max(samples, 1)
      : samples;
    return {
      score,
      samples,
      factor: repFactor(score, effSamples),
      badge: repBadge(score, effSamples),
      fetchOk: e.fetchOk || 0,
      fetchEmpty: e.fetchEmpty || 0,
      fetchBlocked: e.fetchBlocked || 0,
      trustedSamples: e.trustedSamples || 0,
      scope,
    };
  }

  /** 聚类前软降权:每条 quality *= 域名信誉因子(低信誉压沉,高信誉微升;不剔除)。
   * 冷启动域名(无样本)也参与 —— 元学习预测的初始分直接生效。
   * 上限 1.15 与 repFactor 对齐(微升保留;cluster 质量因子 0.5+0.5×meanQ 对 >1 安全)。 */
  function applyToResults(results) {
    for (const r of results || []) {
      const rep = lookup(r?.url, { title: r.title, desc: r.desc, flags: r.flags });
      if (rep) r.quality = clamp((r.quality ?? 0.5) * rep.factor, 0.05, 1.15);
      r.rep = rep; // 供展示层打 badge(flat 分支也可用)
    }
    return results;
  }

  /** 调试:按当前有效分排序返回最低/最高域名 + 模式权重概览 */
  function stats() {
    const arr = Object.entries(domains)
      .map(([key, e]) => ({ key, samples: (e.searchSamples || 0) + (e.fetchSamples || 0), score: effectiveScore(e), lowHits: e.lowHits, okHits: e.okHits, fetchEmpty: e.fetchEmpty }))
      .sort((a, b) => a.score - b.score);
    const topWeights = Object.entries(meta.weights)
      .map(([f, w]) => ({ f, w }))
      .sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
      .slice(0, 10);
    return { total: arr.length, weightSamples: meta.weightSamples, topWeights, lowest: arr.slice(0, 8), highest: arr.slice(-8).reverse() };
  }

  function reset() {
    domains = {};
    meta = { bias: 0, weights: {}, touched: {}, lastStep: {}, freq: {}, weightSamples: 0 };
    save();
  }

  return {
    record, learnFromResults, learnFromResultsLLM, learnCollapsed, learnFetch, learnFetchLLM, learnFetchBlocked, lookup, applyToResults, stats, save, reset,
    _raw: () => domains, _meta: () => meta,
  };
}
