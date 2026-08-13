/**
 * domain-rep.mjs — 域名信誉评分 + 在线跨域模式学习(软限制,非硬剔除)
 *
 * 动机:中文搜索结果的软文污染是动态演化的(SEO 站群换域名/换路径/换模板),
 * 静态黑名单或 site: 限定治标不治本。逐域名独立评分在新域名面前是盲区
 * (每个新域名都要从零积累样本才被识别)—— 故在域名级学习之上叠加在线模式模型。
 * 历史 API/文档称其为“元学习”,算法本质是带持久化的在线逻辑回归,不是 MAML 类
 * learning-to-learn。跨域模型只接受独立质量证据,规则自身生成的标签不得反训规则特征。
 *
 * 四类状态严格分离:
 *   - searchScore:搜索结果形态启发式,只更新当前域名/路径;
 *   - contentScore:LLM 或本地正文结构产生的独立内容证据;
 *   - availabilityScore:成功/404/空壳等抓取可用性,不得训练内容模式。
 *   - utilityScore:模型主动选择 fetch 的使用价值弱信号,只微升当前域名/路径。
 *
 * 跨域先验使用按通道归一化的 FTRL-Proximal,只消费可回放的独立证据事件。
 * 正负样本均达到门槛后才启用;新域名使用先验,随后随自身证据平滑淡出。
 * 衰减:30 天未见的域名向中性 0.5 回归,90 天完全中性(不永久定罪)。
 * 应用:信誉分映射为 quality 的乘性因子(软降权)—— 低信誉压沉不剔除,高信誉微升。
 * 透明:展示层打 badge(⚠[rep:0.31] / ✓[rep:0.82] / [meta:0.33] 冷启动预测)。
 *
 * 持久化:~/.cache/websearch-domain-rep.json(跨 CLI 进程增量积累)
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  REP_FILE, REP_MIN_SAMPLES,
  REP_MAX_DOMAINS, REP_FETCH_OK_CONTRIB, REP_FETCH_EMPTY_CONTRIB,
  META_COLD_CLAMP, META_TRUST_FULL_SAMPLES, META_MAX_EVENTS,
} from "./config.mjs";
import { judgeResults, judgeText, judgeCacheGet } from "./llm-judge.mjs";
import { atomicWriteJsonSync } from "./state-file.mjs";
import { assessContentEvidence } from "./content-evidence.mjs";
import { resolveContentEvidence, trainBayes } from "./evidence-chain.mjs";
import { contentBayes } from "./content-bayes.mjs";

// 实例内部使用的纯函数(显式 import,re-export 不创建当前作用域绑定)
import { clamp, CONTENT_LOW_FLAGS, contributionFromQuality, updateScore, updateFetchScore, updateAvailabilityScore, updateUtilityScore, effectiveScore, availabilityFactor, utilityFactor, decayedScore, repFactor, repBadge, predictTokens, updateMetaTokens, normalizedFeatureVector, metaReady } from "./rep-score.mjs";
import { FUNCTIONAL_PATH_RE, registrableHost, repKeys, extractLearnFeatures, titleFlagTokens, urlTokens } from "./rep-features.mjs";

// v4 分离内容/可用性并引入可回放事件。v3 无原始事件,无法无损迁移。
const REP_SCHEMA_VERSION = 4;

// ---- re-export(公共 API 不变:index.mjs / domain-rep.test.mjs / backtest-meta.mjs 零改动) ----
export { clamp, CONTENT_LOW_FLAGS, contributionFromQuality, updateScore, updateFetchScore, updateAvailabilityScore, updateUtilityScore, effectiveScore, availabilityFactor, utilityFactor, decayedScore, repFactor, repBadge, predictTokens, updateMetaTokens, normalizedFeatureVector, metaReady } from "./rep-score.mjs";
export { ENGINE_DOMAINS, FUNCTIONAL_PATH_SEGS, FUNCTIONAL_PATH_RE, registrableHost, repKeys, cnBigrams, enWords, GENERIC_DOMAIN_LABELS, urlTokens, flagTokens, extractLearnFeatures, titleFlagTokens } from "./rep-features.mjs";

// ==================== 信誉库实例 ====================

/**
 * 信誉库实例:域名级学习 + 元学习(双循环) + 应用。
 * 模块单例由调用方创建(cli.mjs),库复用可自建。
 * @param {Object} [opts] @param {string} [opts.file=REP_FILE] 持久化文件
 */
export function createDomainReputation({ file = REP_FILE, bayes = contentBayes, embedFn } = {}) {
  const emptyMeta = () => ({ bias: 0, weights: {}, touched: {}, z: {}, n: {}, weightSamples: 0, effectiveSamples: 0, positiveSamples: 0, negativeSamples: 0 });
  let domains = {};
  let meta = emptyMeta();
  let events = [];
  let eventIds = new Set();

  function replayEvents() {
    meta = emptyMeta();
    const now = Date.now();
    for (const event of events) {
      const ageDays = Math.max(0, now - (event.at || now)) / 86_400_000;
      const confidence = (event.confidence ?? 1) * Math.pow(0.5, ageDays / 90);
      updateMetaTokens(meta, new Set(event.tokens || []), event.label, { confidence });
    }
  }

  function load() {
    try {
      if (!file || !existsSync(file)) return;
      const j = JSON.parse(readFileSync(file, "utf8"));
      if (j.version === 3) {
        // v3 的纯搜索观察仍可复用;出现过旧 fetch 的条目已混合可用性与内容语义,
        // 无法可靠拆分,宁可丢弃。旧跨域权重因没有事件账本一律不迁移。
        domains = Object.fromEntries(Object.entries(j.domains || {})
          .filter(([, entry]) => (entry.fetchSamples || 0) === 0)
          .map(([key, entry]) => [key, {
            ...entry,
            contentScore: 0.5,
            contentSamples: 0,
            availabilityScore: 0.5,
            availabilitySamples: 0,
            utilityScore: 0,
            utilitySamples: 0,
            trustedSamples: 0,
            observationIds: [],
            availabilityEventIds: [],
            selectionEventIds: [],
          }]));
        return;
      }
      if (j.version !== REP_SCHEMA_VERSION) return;
      domains = j.domains || {};
      events = Array.isArray(j.events) ? j.events.slice(-META_MAX_EVENTS) : [];
      eventIds = new Set(events.map((event) => event.id).filter(Boolean));
      replayEvents();
    } catch {
      domains = {};
      meta = emptyMeta();
      events = [];
      eventIds = new Set();
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
      atomicWriteJsonSync(file, { version: REP_SCHEMA_VERSION, updatedAt: Date.now(), meta, events, domains });
    } catch {
      /* 写失败不影响主流程 */
    }
  }

  function getEntry(key) {
    if (!domains[key]) {
      domains[key] = { searchScore: 0.5, contentScore: 0.5, availabilityScore: 0.5, utilityScore: 0, searchSamples: 0, contentSamples: 0, availabilitySamples: 0, utilitySamples: 0, trustedSamples: 0, lowHits: 0, okHits: 0, fetchOk: 0, fetchEmpty: 0, fetchBlocked: 0, observationIds: [], availabilityEventIds: [], selectionEventIds: [], firstSeen: Date.now(), lastSeen: Date.now() };
    }
    return domains[key];
  }

  function evidenceId(source, eventKey, tokens, label) {
    const stable = eventKey || `${[...tokens].sort().join("\u0001")}\u0000${label}`;
    return createHash("sha256").update(`${source}\u0000${stable}`).digest("hex").slice(0, 24);
  }

  /** Store one deduplicated, replayable cross-domain training event. */
  function recordMetaEvidence(url, tokens, label, {
    source = "explicit",
    confidence = 1,
    eventKey = url,
  } = {}) {
    const cleanTokens = [...normalizedFeatureVector(tokens).keys()];
    if (!Number.isFinite(label) || confidence <= 0) return false;
    const id = evidenceId(source, eventKey, cleanTokens, label);
    if (eventIds.has(id)) return false;
    const event = {
      id,
      at: Date.now(),
      domain: registrableHost(url),
      source,
      label: clamp(label, 0, 1),
      confidence: clamp(confidence, 0, 1),
      tokens: cleanTokens,
    };
    events.push(event);
    eventIds.add(id);
    if (cleanTokens.length) updateMetaTokens(meta, new Set(cleanTokens), event.label, { confidence: event.confidence });
    if (events.length > META_MAX_EVENTS) {
      const removed = events.splice(0, events.length - META_MAX_EVENTS);
      for (const old of removed) eventIds.delete(old.id);
      replayEvents();
    }
    return true;
  }

  /** Independent content evidence updates content reputation and the cross-domain prior. */
  function recordContentEvidence(url, label, {
    tokens = null,
    source = "explicit",
    confidence = 1,
    eventKey = url,
    low = label <= 0.35,
  } = {}) {
    if (!url || !Number.isFinite(label)) return false;
    const contribution = clamp(label, 0.05, 0.95);
    const features = tokens || urlTokens(url);
    const learned = recordMetaEvidence(url, features, contribution, { source, confidence, eventKey });
    if (!learned) return false;
    for (const key of repKeys(url)) {
      const entry = getEntry(key);
      updateFetchScore(entry, contribution);
      entry.trustedSamples = (entry.trustedSamples || 0) + confidence;
      if (low) entry.lowHits++; else entry.okHits++;
      entry.lastSeen = Date.now();
    }
    return learned;
  }

  /**
   * 记录一个样本。域名级始终更新;learnMeta=true 时才更新跨域模式。
   * 模式 label = metaLabel(提供时)或 contribution —— LLM 内容可信度判断
   *   是可靠信号(quality 分只是形态分,学出来是主题偏置),见 learnFromResultsLLM;
   * 域名级:searchScore 用绝对 contribution 递减学习;重复低质模式惩罚(样本≥5 且低质率>0.6 → ×0.6)。
   * @param {Set<string>} tokens 激活 token 集
   * @param {number} metaLabel 跨域模式专用 label(可选;缺省=contribution)
   */
  function record(url, contribution, { low = false, tokens = null, metaLabel = null, learnMeta = null, metaSource = "explicit", metaConfidence = 1, metaEventKey = url, observationKey = url } = {}) {
    const shouldLearnMeta = learnMeta ?? metaLabel !== null;
    if (shouldLearnMeta) {
      recordMetaEvidence(url, tokens || urlTokens(url), metaLabel ?? contribution, {
        source: metaSource,
        confidence: metaConfidence,
        eventKey: metaEventKey,
      });
    }
    const observationId = createHash("sha256").update(String(observationKey)).digest("hex").slice(0, 16);
    for (const key of repKeys(url)) {
      const e = getEntry(key);
      e.observationIds = e.observationIds || [];
      if (e.observationIds.includes(observationId)) {
        e.lastSeen = Date.now();
        continue;
      }
      e.observationIds.push(observationId);
      if (e.observationIds.length > 64) e.observationIds.splice(0, e.observationIds.length - 64);
      let c = contribution;
      if (e.searchSamples >= 5 && e.lowHits / e.searchSamples > 0.6) c *= 0.6;
      updateScore(e, c);
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
    // 未知域名优先;已知域名按 URL 哈希约 5% 确定性复检,发现站点质量漂移。
    const needLLM = [];
    for (const r of results || []) {
      const host = registrableHost(r?.url);
      if (!host) continue;
      const e = domains[host];
      const refresh = createHash("sha256").update(String(r.url || "")).digest()[0] < 13;
      if (!e || (e.searchSamples || 0) < 3 || refresh) needLLM.push(r);
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
      const heuristicContribution = contributionFromQuality(r.quality ?? 0.5, flags);
      // 规则形态分只更新域名观察值。独立判断另写 contentScore 与跨域事件,
      // 避免把两种证据压进同一个递减平均数。
      record(url, heuristicContribution, {
        low: contentLow,
        tokens,
        learnMeta: false,
        observationKey: `${url}\u0000${r.title || ""}`,
      });
      if (llmScore !== undefined) {
        const contentLabel = 0.05 + 0.9 * (1 - llmScore);
        recordContentEvidence(url, contentLabel, {
          tokens,
          source: "llm-serp-v1",
          confidence: 0.75,
          eventKey: `${url}\u0000${r.title || ""}`,
          low: contentLabel <= 0.35,
        });
      }
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
        observationKey: `${url}\u0000${r.title || ""}`,
      });
    }
    return domains;
  }

  /** 抓取可用性反馈。空壳/404 不能证明内容低质,只更新 availabilityScore。 */
  function learnFetch(url, ok, _extra = {}) {
    if (!url) return;
    const day = new Date().toISOString().slice(0, 10);
    const eventId = createHash("sha256").update(`${url}\u0000${ok}\u0000${day}`).digest("hex").slice(0, 16);
    for (const key of repKeys(url)) {
      const e = getEntry(key);
      e.availabilityEventIds = e.availabilityEventIds || [];
      if (e.availabilityEventIds.includes(eventId)) {
        e.lastSeen = Date.now();
        continue;
      }
      e.availabilityEventIds.push(eventId);
      if (e.availabilityEventIds.length > 64) e.availabilityEventIds.splice(0, e.availabilityEventIds.length - 64);
      updateAvailabilityScore(e, ok);
      if (ok) e.fetchOk = (e.fetchOk || 0) + 1;
      else e.fetchEmpty = (e.fetchEmpty || 0) + 1;
      e.lastSeen = Date.now();
    }
  }

  /**
   * 模型主动选择 fetch 的弱正反馈。按 URL+UTC 日期去重,只更新当前域名/路径的
   * utility 通道;不改内容/可用性分,不生成跨域训练事件。未选择绝不是负反馈。
   */
  function learnSelection(url) {
    if (!url) return false;
    const day = new Date().toISOString().slice(0, 10);
    const eventId = createHash("sha256").update(`${url}\u0000${day}`).digest("hex").slice(0, 16);
    let learned = false;
    for (const key of repKeys(url)) {
      const e = getEntry(key);
      e.selectionEventIds = e.selectionEventIds || [];
      if (e.selectionEventIds.includes(eventId)) {
        e.lastSeen = Date.now();
        continue;
      }
      e.selectionEventIds.push(eventId);
      if (e.selectionEventIds.length > 64) e.selectionEventIds.splice(0, e.selectionEventIds.length - 64);
      updateUtilityScore(e);
      e.lastSeen = Date.now();
      learned = true;
    }
    return learned;
  }

  /** fetch 反爬/风控拦截(403/验证码/风控 JSON 页):内容可能很好只是被拦,中性不降分。
   * 只记录 fetchBlocked 计数、更新 lastSeen,不动可用性或内容模型。
   * 知乎等强反爬站直连 403、浏览器也被风控时走此通道,避免一次拦截把高分站钉到中性。 */
  function learnFetchBlocked(url, extra = {}) {
    if (!url) return;
    for (const key of repKeys(url)) {
      const e = getEntry(key);
      e.fetchBlocked = (e.fetchBlocked || 0) + 1;
      e.lastSeen = Date.now();
    }
  }

  /** fetch 正文完整后的内容反馈:优先使用显式 LLM,否则使用高精度本地正文结构证据。
   * 软文页能正常打开 —— “能抓到正文”不能当正反馈(盲点修复)。
   * **标题信号参与综合**(取标题与正文中更可疑的):SEO 站标题是软文模板、正文是伪装,
   * 只判正文会把软文站“洗白”(3bgg 案例:标题被判 1.0,正文被判 0.0 → 一次 fetch 从 0.11 拉回 0.64)。
   * 低信誉域名且无标题缓存:正反馈折价(0.95→0.6),需多次一致证据才翻身,防单次洗白。
   * LLM 不可用时只有达到高精度条件的正文结构证据才训练;模棱两可则保持中性。 */
  async function learnFetchContent(url, extra = {}) {
    if (!url) return;
    learnFetch(url, true, extra);
    const softScore = await judgeText(extra.body || extra.markdown, { title: extra.title, url });
    let evidence = null;
    if (softScore !== null) {
      // 综合 = 标题与正文中更可疑的(标题判断来自搜索结果阶段的缓存;无缓存则只凭正文)
      const titleHit = judgeCacheGet(url, extra.title);
      const titleScore = titleHit ? titleHit.s : undefined;
      const combined = titleScore !== undefined ? Math.max(titleScore, softScore) : softScore;
      let contribution = combined > 0.6 ? REP_FETCH_EMPTY_CONTRIB : (combined < 0.3 ? REP_FETCH_OK_CONTRIB : 0.5);
      // 低信誉域名(有效分 <0.35)且无标题信号可查:正反馈折价 —— 单次“正常正文”不足以洗白历史负分
      if (contribution > 0.6 && titleScore === undefined) {
        const host = registrableHost(url);
        const e = host ? domains[host] : null;
        if (e && effectiveScore(e) < 0.35) contribution = 0.6;
      }
      evidence = { label: contribution, confidence: 0.9, source: "llm-body-v1" };
    } else {
      // 非 LLM 证据链:结构 → 语义 → 贝叶斯(见 evidence-chain.mjs)。
      // 全部模棱两可或不可用 → null(中性,不训练);embedFn 仅供测试注入。
      evidence = await resolveContentEvidence(extra, { bayes, embedFn });
    }
    if (evidence) {
      const tokens = extractLearnFeatures(url, extra);
      const bodyHash = createHash("sha256")
        .update(String(extra.body || extra.markdown || "").slice(0, 4000))
        .digest("hex")
        .slice(0, 16);
      const recorded = recordContentEvidence(url, evidence.label, {
        tokens,
        source: evidence.source,
        confidence: evidence.confidence,
        eventKey: `${url}\u0000${bodyHash}`,
        low: evidence.label <= 0.35,
      });
      // 贝叶斯训练:只用独立证据源(结构/语义/LLM),贝叶斯自身预测不训练自己
      // (防自反馈循环);正文 token 与 FTRL 的标题 token 不重叠,互不污染。
      if (recorded) trainBayes(bayes, url, extra, evidence, bodyHash);
    }
    return evidence;
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
      ? (pathEntry.searchSamples || 0) + (pathEntry.contentSamples || 0)
      : 0;
    const pathScore = pathEntry ? decayedScore(pathEntry) : 0.5;
    // A path entry is more specific than its host. Use it once it has the normal evidence
    // threshold, or immediately when an independent LLM/fetch signal made it extreme.
    const usePath = Boolean(pathEntry) && (
      pathSamples >= REP_MIN_SAMPLES
      || (pathEntry.availabilitySamples || 0) >= REP_MIN_SAMPLES
      || (pathEntry.utilitySamples || 0) >= REP_MIN_SAMPLES
      || ((pathEntry.trustedSamples || 0) > 0 && (pathScore <= 0.3 || pathScore >= 0.7))
    );
    const e = usePath ? pathEntry : hostEntry;
    const scope = usePath ? pathKey : host;
    const samples = e ? (e.searchSamples || 0) + (e.contentSamples || 0) : 0;
    let priorScore = null;
    if (metaReady(meta)) {
      const raw = predictTokens(extractLearnFeatures(url, extra), meta);
      const trust = Math.min(1, meta.effectiveSamples / META_TRUST_FULL_SAMPLES);
      priorScore = clamp(0.5 + (raw - 0.5) * (0.5 + 0.5 * trust), META_COLD_CLAMP[0], META_COLD_CLAMP[1]);
    }
    if (!samples && priorScore === null && !(e?.availabilitySamples > 0) && !(e?.utilitySamples > 0)) return null;

    const rawOwnScore = samples ? decayedScore(e) : 0.5;
    const searchTrust = clamp(((e?.searchSamples || 0) - 1) / Math.max(1, REP_MIN_SAMPLES - 1), 0, 1);
    const contentTrust = (e?.contentSamples || 0) > 0
      ? clamp(0.6 + (e.contentSamples - 1) * 0.2, 0, 1)
      : 0;
    const ownTrust = Math.max(searchTrust, contentTrust);
    const ownScore = priorScore === null
      ? rawOwnScore
      : 0.5 + (rawOwnScore - 0.5) * ownTrust;
    // 跨域先验随自身证据平滑淡出。启发式样本需要约 10 次才完全覆盖先验;
    // 独立正文证据更强,每条额外把先验权重降低 0.2。
    const trustedCount = e?.contentSamples || 0;
    const priorWeight = priorScore === null
      ? 0
      : samples === 0
        ? 1
        : clamp(0.6 * (1 - samples / 10) - trustedCount * 0.2, 0, 0.6);
    const score = priorScore === null
      ? ownScore
      : ownScore * (1 - priorWeight) + priorScore * priorWeight;
    // 高置信提前生效:LLM/fetch 判断可靠,分数极端(≤0.3 或 ≥0.7)时样本 1 就干预 ——
    // 否则要等 3 样本,而站群域名每次搜索只出现 1-2 次,可能永远到不了 3,学习白做。
    // 中性分(0.3~0.7)仍零干预(样本不足不冤枉,等积累)。
    const trusted = (e?.trustedSamples || 0) > 0;
    const evidenceReady = samples >= REP_MIN_SAMPLES
      || (trusted && (score <= 0.3 || score >= 0.7))
      || priorScore !== null;
    const effSamples = evidenceReady ? Math.max(samples, REP_MIN_SAMPLES) : samples;
    const contentFactor = repFactor(score, effSamples);
    const accessFactor = availabilityFactor(e);
    // 路径 utility 尚未达到门槛时沿用域名级信号,避免独立选择被稀疏路径切碎。
    const utilityEntry = usePath && (pathEntry.utilitySamples || 0) >= REP_MIN_SAMPLES
      ? pathEntry
      : hostEntry;
    const useFactor = utilityFactor(utilityEntry);
    const badge = samples === 0 && priorScore !== null
      ? `[meta:${score.toFixed(2)}]`
      : priorWeight > 0
        ? `[blend:${score.toFixed(2)}]`
        : repBadge(score, effSamples);
    return {
      score,
      samples,
      coldStart: samples === 0 && priorScore !== null,
      priorScore,
      priorWeight,
      factor: clamp(contentFactor * accessFactor * useFactor, 0.35, 1.15),
      badge,
      fetchOk: e?.fetchOk || 0,
      fetchEmpty: e?.fetchEmpty || 0,
      fetchBlocked: e?.fetchBlocked || 0,
      availabilityScore: e?.availabilityScore ?? 0.5,
      utilityScore: utilityEntry?.utilityScore ?? 0,
      utilitySamples: utilityEntry?.utilitySamples || 0,
      trustedSamples: e?.trustedSamples || 0,
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
      .map(([key, e]) => ({ key, samples: (e.searchSamples || 0) + (e.contentSamples || 0), score: effectiveScore(e), availability: e.availabilityScore, utility: e.utilityScore, utilitySamples: e.utilitySamples || 0, lowHits: e.lowHits, okHits: e.okHits, fetchEmpty: e.fetchEmpty }))
      .sort((a, b) => a.score - b.score);
    const topWeights = Object.entries(meta.weights)
      .map(([f, w]) => ({ f, w }))
      .sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
      .slice(0, 10);
    return { total: arr.length, weightSamples: meta.weightSamples, effectiveSamples: meta.effectiveSamples, positiveSamples: meta.positiveSamples, negativeSamples: meta.negativeSamples, events: events.length, ready: metaReady(meta), topWeights, lowest: arr.slice(0, 8), highest: arr.slice(-8).reverse() };
  }

  function reset() {
    domains = {};
    meta = emptyMeta();
    events = [];
    eventIds = new Set();
    save();
  }

  return {
    record, recordContentEvidence, recordMetaEvidence, learnFromResults, learnFromResultsLLM, learnSelection, learnFetch, learnFetchContent, learnFetchBlocked, lookup, applyToResults, stats, save, reset,
    _raw: () => domains, _meta: () => meta, _events: () => events,
  };
}
