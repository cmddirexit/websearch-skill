/**
 * lib/index.mjs — 公共 API 入口(作为库复用的统一出口)
 *
 * 其他脚本/工具可这样使用:
 *   import { searchBing, searchBaidu, fetchPage, httpGet, clean } from "websearch-skill";
 *
 * 引擎契约(所有 search 函数统一):
 *   search(query, limit) → Promise<{engine, mode, blocked, reason?, results:[{title,url,desc}]}>
 *   直连失败/被反爬 → blocked:true;浏览器兜底不可用 → null
 *
 * mode 枚举(引擎返回,标识结果来源形态):
 *   mobile  移动端页面(移动 UA 直连,如 baidu/sm)
 *   web     桌面端页面(桌面 UA 直连,如 so360/sogou/bing/marginalia)
 *   ssr     服务端渲染数据页(如 toutiao 的 T.flow SSR)
 *   json    API JSON(如 github/hn/wikipedia)
 *   browser 浏览器渲染兜底(cli 输出用它判断是否标注"(浏览器)")
 *   direct  无特殊形态的默认值(cnnews 等)
 *
 * 浏览器兜底(searchBingViaBrowser / fetchViaBrowser)需要本机有 playwright + chromium,
 * 不可用时返回 null,不抛错,可放心调用。
 */

export { searchBing, decodeBingUrl, isLangPolluted, parseBingHtml } from "./engines/bing.mjs";
export { searchBaidu, parseBaiduHtml, extractMu, extractBlockTitle, extractDesc, filterDesc, isBaiduInternal } from "./engines/baidu.mjs";
export { searchMarginalia, parseMarginaliaResult, extractMarginaliaDesc, parseMarginaliaHtml } from "./engines/marginalia.mjs";
export { searchCnnews, extractNewsLinks, isArticleUrl, CN_NEWS_SOURCES } from "./engines/cnnews.mjs";
export { fetchHotlist, parseWeiboHotlist, parseToutiaoHotlist, parseBaiduHotlist, parseDouyinHotlist, fetchWeiboHotlist, fetchDouyinHotlist, HOT_BOARDS } from "./engines/hotlist.mjs";
export { fetchGithubTrending, parseGithubTrending, TRENDING_SINCE } from "./engines/trending.mjs";
export { isBrowserAvailable, resolveChromiumPath, getDom, fetchViaBrowser, closeBrowser } from "./engines/browser.mjs";
export { searchBingViaBrowser } from "./engines/bing-browser.mjs";
export { searchMarginaliaViaBrowser } from "./engines/marginalia-browser.mjs";
import { loadEngines, defaultEngineKey, ENGINE_IMPLS, ENGINE_LABELS } from "./engines/registry.mjs";
export { loadEngines, defaultEngineKey, ENGINE_IMPLS, ENGINE_LABELS };
export { loadUserConfig, validateUserConfig, resolveUserConfigPath, USER_CONFIG, USER_CONFIG_FILE } from "./user-config.mjs";
export { fetchPage, fetchPageDirect, extractBodyFromHtml, extractPublishedAt, extractLinkList, linkArticleScore, nearbyDate, LIST_MIN_ITEMS, LIST_SHELL_MAX_CHARS } from "./fetch-page.mjs";
export { decodeEntities, clean, stripTags, extractAttr, extractTitle, extractMetaDescription, parseDateFromUrl, normalizeCnDate, extractSerpDate } from "./html.mjs";
// 发布时间提取 ML(规则候选 + 在线学习裁决,非 LLM)
export { extractDateCandidates, extractPageFeatures, pickDate, recordFetchOutcome, predictLinear, updateLinear, inspectDateModel, resetDateModel, saveDateModel } from "./date-ml.mjs";
export { httpGet, httpGetFull, httpGetJson, UA, REQ_HEADERS } from "./http.mjs";
export { validateFetchUrl, isNonPublicIp, UNSAFE_URL_CODE } from "./url-safety.mjs";
// TLS 指纹兜底(直连 403/TLS 拦截时的 curl-impersonate/curl_cffi 重试)
export {
  httpGetViaImpersonate,
  isTlsFallbackCandidate,
  isImpersonateAvailable,
  isTlsHostCooled,
  recordTlsFailure,
  recordTlsSuccess,
  resetTlsFailState,
  parseCurlOutput,
} from "./tls.mjs";
// 反爬类型识别 + 统一反爬检测 + 抓取结果三分类 + 404 页面识别
// (判断对方用了 Turnstile/倒计时/限流/验证码/风控,降级策略参考;404 区分“页面不存在”)
export { detectAntibot, ANTIBOT_LABELS, isAntibotContent, classifyFetchResult, detectNotFound } from "./antiblock.mjs";
// 浏览器 stealth/CF 求解/贝塞尔轨迹(库复用)
export { detectCloudflareChallenge, solveCloudflareChallenge } from "./engines/cf-solver.mjs";
export { bezierPath, STEALTH_INIT_SCRIPT } from "./engines/browser.mjs";
export { main, runFetch, cacheFetchResult } from "./cli.mjs";
export { clusterResults, queryTokens, titleTokens, tokenJaccard, cnGrams, enWords, cosine, cosineMatrix, DEFAULT_OPTIONS, ZH_STOP, BRAND_ALIAS, readableClusterLabel, cleanTitleForLabel, longestCommonSpan, distinctiveSpan, pickSegment, LABEL_SITE_HINTS, EDGE_SEP_RE, SENTENCE_SEP_RE } from "./cluster.mjs";
export { filterResults, detectFlags, scoreQuality, isAdResult, hasAdMarker, isAdDomain, isShortener, isRedirectAdUrl, AD_DOMAINS, SHORTENER_DOMAINS, AD_REDIRECT_SEGMENTS, AD_MARKER_STRONG } from "./filter.mjs";
// 域名信誉评分 + 增量学习(软限制:按搜索结果与 fetch 实测给域名评分,学习规律后降权不剔除)
export { createDomainReputation, registrableHost, repKeys, contributionFromQuality, updateScore, updateFetchScore, updateAvailabilityScore, updateUtilityScore, effectiveScore, availabilityFactor, utilityFactor, decayedScore, repFactor, repBadge, clamp, CONTENT_LOW_FLAGS, ENGINE_DOMAINS, FUNCTIONAL_PATH_SEGS, cnBigrams, enWords as repEnWords, urlTokens, flagTokens, extractLearnFeatures, titleFlagTokens, normalizedFeatureVector, predictTokens, updateMetaTokens, metaReady } from "./domain-rep.mjs";
export { assessContentEvidence, sentenceStats } from "./content-evidence.mjs";
export { assessSemanticEvidence, cosine as semanticCosine } from "./semantic-evidence.mjs";
export { createContentBayes, contentBayes, bodyTokens } from "./content-bayes.mjs";
export { resolveContentEvidence, trainBayes } from "./evidence-chain.mjs";
export { judgeResults, llmConfig } from "./llm-judge.mjs";
export { embedResults, embedTexts, embedConfiguredTexts, getEmbedder, resetEmbedder } from "./embed.mjs";
export {
  computeRelThresholds,
  gradeCluster,
  irrelevantReason,
  buildPresentation,
  collapsedBrief,
  collapsedMarkdown,
  REL_LEVELS,
} from "./relevance.mjs";
