/**
 * config.mjs — 全局配置集中(所有超时/UA/阈值)
 *
 * 修改策略:Ai/人维护时先看这里,再动各引擎文件。
 * 命名前缀标注用途: HTTP_ / CLI_ / MARGINALIA_ / BAIDU_ / BODY_
 */
import { USER_CONFIG } from "./user-config.mjs";

/** 读取数值环境变量。显式的 0 必须保留,非法值才回退默认值。 */
export function envNumber(name, fallback, env = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

// ---- HTTP ----
/** 桌面 Chrome UA(httpGet 与浏览器兜底共用,反爬伪装) */
/**
 * 生成 Chrome 桌面版 UA。版本参数化:浏览器层(engines/browser.mjs)会探测本地
 * chromium 实际版本并覆盖 —— UA 必须与真实浏览器版本匹配,否则知乎等站按
 * “UA 版本与实现不符”的风控逻辑拒绝(实测 Chrome120 UA + Chromium149 → 40362)。
 * 默认 149 与当前 Termux x11-repo 的 chromium 一致;升级后只改默认值或依赖探测。
 */
export function buildChromeUa(version = "149.0.0.0") {
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

export const UA = buildChromeUa();
/** 通用请求头(http.mjs 与 tls.mjs 共用,避免各自复制导致改一处不同步) */
export const REQ_HEADERS = {
  "User-Agent": UA,
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "Cache-Control": "no-cache",
};
/** 百度移动端 UA(绕过桌面 UA 风控,实测稳定);版本同样参数化 */
export function buildMobileUa(version = "149.0.0.0") {
  return `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Mobile Safari/537.36`;
}
export const UA_MOBILE = buildMobileUa();
/** httpGet 默认超时(搜索页) */
export const HTTP_TIMEOUT_MS = envNumber("WEBSEARCH_HTTP_TIMEOUT_MS", USER_CONFIG.network?.httpTimeoutMs ?? 10_000);
/** httpGetFull 默认超时(大页面正文) */
export const HTTP_FULL_TIMEOUT_MS = envNumber("WEBSEARCH_FETCH_TIMEOUT_MS", USER_CONFIG.network?.fetchTimeoutMs ?? 20_000);
/** 同域连续请求最小间隔(礼貌爬取,降低被风控概率) */
export const DOMAIN_RATE_LIMIT_MS = 1500;

// ---- Cookie jar(会话持久化) ----
/** 技能缓存目录(折叠详情/会话 Cookie 等;统一改这里即可换缓存位置) */
const TEST_CACHE_DIR = `${process.env.TMPDIR || "/tmp"}/websearch-test-${process.pid}`;
export const CACHE_DIR = process.env.WEBSEARCH_CACHE_DIR ||
  (process.env.NODE_TEST_CONTEXT
    ? TEST_CACHE_DIR
    : USER_CONFIG.cache?.directory || `${process.env.HOME || process.env.TMPDIR || "/tmp"}/.cache`);
/** Cookie 持久化文件(跨 CLI 运行共享,模拟"老访客"降低风控判定) */
export const COOKIE_FILE = `${CACHE_DIR}/websearch-cookies.json`;
/** 引擎失败记忆持久化文件(跨 CLI 运行:失败的引擎进入冷却期,后续搜索直接跳过,
 * 避免每次聚合都等满超时。如 CN 网络下 api.github.com 连接失败 → 30 分钟冷却) */
export const ENGINE_FAIL_FILE = `${CACHE_DIR}/websearch-engine-fail.json`;
/** API 嵌入失败记忆持久化文件(同模式:限流/故障后冷却期内不再请求) */
export const EMBED_FAIL_FILE = `${CACHE_DIR}/websearch-embed-fail.json`;
/** 聚合前 TCP 连通性预检超时(探测各引擎域名 443 端口,不通的直接跳过,不再发起搜索请求) */
export const PROBE_TIMEOUT_MS = 2_000;
/** Cookie 超过此年龄整体丢弃(避免长期陈旧状态) */
export const COOKIE_TTL_MS = 24 * 60 * 60 * 1000;

// ---- 调度 ----
/** 默认搜索目标上限。保持固定,不暴露为用户配置,临时覆盖只允许 CLI --limit。 */
export const DEFAULT_SEARCH_LIMIT = 99;
/** 整条降级链硬预算:一次搜索最多等这么久 */
export const TOTAL_BUDGET_MS = envNumber("WEBSEARCH_TOTAL_BUDGET_MS", USER_CONFIG.network?.totalBudgetMs ?? 40_000);
/** 聚合时单个引擎的独立超时上限:慢引擎(如 github 原生 fetch 无超时、网络不稳)
 * 挂起时快速放弃,避免等满 TOTAL_BUDGET_MS 拖慢聚合(实测 github 曾拖 39997ms)。
 * 直连引擎自身超时(HTTP_TIMEOUT_MS=10s) + 余量;浏览器兜底引擎不受此限(searx 已排除聚合) */
export const PER_ENGINE_TIMEOUT_MS = envNumber("WEBSEARCH_PER_ENGINE_TIMEOUT_MS", USER_CONFIG.network?.perEngineTimeoutMs ?? 12_000);

// ---- 浏览器兜底 ----
/** 浏览器渲染总超时(聚合预算一部分):无梯子/实例慢时快速失败,不阻塞聚合 */
export const CLI_TIMEOUT_MS = 40_000;
/** CF 真实等待单轮上限:Turnstile/managed challenge 放行有时要 40-60s,第二轮从 30s 提到 90s */
export const CLI_CF_TIMEOUT_MS = 90_000;
/** CF 真实等待轮询第一轮(45s):放行快时不必等满 90s */
export const CLI_CF_ROUND1_MS = 45_000;
/** zendriver 探测超时(python3 -c import zendriver) */
export const ZD_PROBE_TIMEOUT_MS = 8_000;
/** zendriver solver 单次上限(python 启动 + chromium 冷启动 + 60s CF 等待) */
export const ZD_SOLVER_TIMEOUT_MS = 75_000;
/** 存档镜像:web.archive.org 单发超时 / archive.today 系并行每镜像超时 */
export const ARCHIVE_WAYBACK_TIMEOUT_MS = 12_000;
export const ARCHIVE_TODAY_TIMEOUT_MS = 8_000;
/** 页面级缓存 TTL:同一 URL 重复抓取秒回,CF 站点冷启动 9s → 热请求 0s */
export const PAGE_CACHE_TTL_MS = envNumber("WEBSEARCH_PAGE_CACHE_TTL_MS", USER_CONFIG.cache?.pageTtlMs ?? 6 * 3600 * 1000);
/** 库模式(page.goto)导航超时 */
export const NAV_TIMEOUT_MS = envNumber("WEBSEARCH_NAV_TIMEOUT_MS", USER_CONFIG.browser?.navigationTimeoutMs ?? 20_000);
/** 用户配置浏览器路径;环境变量仍在 browser-runtime 中优先。 */
export const BROWSER_PATH = USER_CONFIG.browser?.path || "";
/** 浏览器 profile 目录前缀(CLI 随机后缀防并发锁,库模式固定 shared) */
export const BROWSER_PROFILE_PREFIX = "wschromium";
/** 浏览器兜底调试日志:CLI 失败时完整 stderr/退出码/命令行落盘(替代只留 80 字符的截断报错) */
export const BROWSER_DEBUG_LOG = `${CACHE_DIR}/websearch-browser-debug.log`;
/** stealth 视口:与 UA(Windows Chrome/120)一致的"常驻访客"画像,库模式 newPage 时设置 */
export const STEALTH_VIEWPORT_W = 1366;
export const STEALTH_VIEWPORT_H = 768;
/** stealth 注入脚本的浏览器语言(与 Accept-Language 对齐) */
export const STEALTH_LOCALE = "zh-CN";

// ---- TLS/HTTP2 指纹兜底(curl-impersonate / python curl_cffi) ----
/** 直连 fetch 失败(403/TLS 指纹拦截)时用浏览器指纹 curl 变体重试;env=0 关闭 */
export const TLS_FALLBACK_ENABLED = process.env.WEBSEARCH_TLS_FALLBACK !== "0";
/** impersonate 请求超时(快速失败,不拖慢降级链) */
export const TLS_FALLBACK_TIMEOUT_MS = 10_000;
/** impersonate 目标指纹(与 UA 版本对齐:Chrome/120) */
export const TLS_IMPERSONATE_TARGET = "chrome120";

// ---- TLS 兜底可用性探测 ----
/** python3 curl_cffi 可用性探测超时(只做一次,结果缓存) */
export const TLS_PYTHON_PROBE_TIMEOUT_MS = 8_000;
/** TLS 兜底失败记忆持久化文件(跨 CLI 进程:impersonate 也救不回硬拦站(如 mojeek)时冷却,
 * 期内直连失败不再尝试 impersonate,避免每次搜索都白等 curl 8-10s) */
export const TLS_FAIL_FILE = `${CACHE_DIR}/websearch-tls-fail.json`;
/** 连续多少次兜底失败进入冷却 */
export const TLS_FAIL_THRESHOLD = 2;
/** 冷却时长(与引擎失败记忆同策略:直连不通的场景按 30 分钟记,成功清零不误伤) */
export const TLS_COOLDOWN_MS = 30 * 60_000;

// ---- Marginalia ----
/** 直连超时(该站间歇限流,快速失败让降级链尽快切浏览器) */
export const MARGINALIA_TIMEOUT_MS = 10_000;
/** 响应小于此字节数视为验证页/限流页 */
export const MARGINALIA_VERIFY_MIN_BYTES = 40 * 1024;

// ---- Baidu ----
/** 响应小于此长度视为风控页 */
export const BAIDU_BLOCKED_MIN_LEN = 5000;

// ---- CnNews(官方新闻源) ----
/** 只保留最近 N 天内的新闻(时效性过滤) */
export const CNNEWS_MAX_AGE_DAYS = 30;
/** 每源最多解析的链接数(防超大首页拖慢) */
export const CNNEWS_MAX_ITEMS_PER_SOURCE = 400;

// ---- Hotlist(平台热搜榜) ----
/** 微博官方页浏览器渲染等待(ms):等热搜列表 JS 渲染完成 */
export const HOTLIST_WEIBO_WAIT_MS = 6000;
/** 抖音热榜浏览器渲染等待(ms):数据由签名 API 异步加载,需更久 */
export const HOTLIST_DOUYIN_WAIT_MS = 12000;

// ---- SearXNG ----
/** 每个实例浏览器渲染的硬上限:公共实例不可达(如无梯子)/antibot 时快速失败,
 * 避免吃光整条聚合预算(实测手机端无梯子时直连超时→浏览器 20s 导航超时→CLI 再烧 20s+) */
export const SEARX_BROWSER_TIMEOUT_MS = 15_000;

// ---- 搜狗风控策略 ----
/** 触发验证码后的冷却期:期内聚合/单引擎直接跳过不再请求(避免反复触发) */
export const SOGOU_COOLDOWN_MS = 5 * 60_000;

// ---- 语义嵌入与聚类(embed.mjs / cluster.mjs) ----
/** 默认嵌入模型(中文优先,bge-small-zh 中文区分度实测最佳;中英均衡可换 multilingual-e5-small) */
export const EMBED_BACKEND = process.env.WEBSEARCH_EMBED_BACKEND || USER_CONFIG.semantic?.backend || "auto";
export const EMBED_MODEL = process.env.WEBSEARCH_EMBED_MODEL || USER_CONFIG.semantic?.localModel || "Xenova/bge-small-zh-v1.5";
/** 与簇心余弦 ≥ 此值才归簇;低于 → 自成簇/噪声(e5-small 同主题中文文档余弦约 0.5~0.7) */
export const CLUSTER_SIM_THRESHOLD = 0.42;
/** 与簇心余弦 ≥ 此值视为近似重复(转载/镜像页),簇内折叠计数 */
export const CLUSTER_DUP_THRESHOLD = 0.94;
/** 转载级折叠候选门槛(实测):转载同文 ~0.95、转载换措辞 ~0.78~0.85、
 * 同主题不同文 <0.72~0.80。0.75 以下必不折叠;0.75~dupThreshold 区间需文本
 * 证据(标题/摘要 LCS 近重复)才折叠,防同主题不同文误杀(见 cluster.mjs 预处理)。 */
export const REPRINT_THRESHOLD = envNumber("WEBSEARCH_REPRINT_THRESHOLD", 0.75);
/** 超大簇拆分:语义模式下簇内成员数超过此值 → 动态拆分检查
 * (拆分信号数据驱动:pairwise 归属度 IQR 离群检测 + 当前结果集词频子主题分组,
 * 无固定阈值;见 cluster.mjs splitBySignals) */
export const MAX_CLUSTER_SIZE = envNumber("WEBSEARCH_MAX_CLUSTER_SIZE", 12);

/** 单例语义桶合并:拆分后剩余的单例按平均链接(UPGMA)合并成桶,
 * 截止=max(当前后端 simThreshold,pairwise Q3)+最大 gap。env=0 关闭。 */
export const BUCKET_SINGLETONS = process.env.WEBSEARCH_BUCKET_SINGLETONS !== "0";
/** 桶规模上限:超限禁止该对合并(防一桶吞下所有单例) */
export const MAX_BUCKET_SIZE = envNumber("WEBSEARCH_MAX_BUCKET_SIZE", 6);

// ---- 语义嵌入 API 后端(OpenAI 兼容,如硅基流动) ----
/** API 基址(硅基流动;可换其它 OpenAI 兼容提供商) */
export const EMBED_API_BASE = process.env.SILICONFLOW_API_BASE || USER_CONFIG.semantic?.apiBase || "https://api.siliconflow.cn/v1";
/** API 嵌入模型(默认 MTEB 多语言榜首 Qwen3-Embedding-8B,4096 维;也可换 BAAI/bge-m3) */
export const EMBED_API_MODEL = process.env.SILICONFLOW_EMBED_MODEL || USER_CONFIG.semantic?.apiModel || "Qwen/Qwen3-Embedding-8B";
/** API 嵌入输出维度压缩(MRL,`dimensions` 参数):实测 4096→1024 相似度误差 <0.005
 * (报道↔指南 0.903↔0.906),分布不变 → 聚类阈值无需调整;存储/计算省 4 倍
 * (UPGMA pairwise 等 O(n²)×dim 热点)。0 = 不压缩(4096 全维);
 * 不支持的提供商(400/422)自动去掉该参数重试。 */
export const EMBED_API_DIMENSIONS = envNumber("EMBED_API_DIMENSIONS", USER_CONFIG.semantic?.apiDimensions ?? 1024);
/** API 后端聚类相似度阈值(实测 Qwen3-8B:同主题 0.58~0.72 vs 异主题 0.32~0.45,0.5 安全分离) */
export const EMBED_API_SIM_THRESHOLD = 0.5;
/** 簇相关度低于此 → 标记 lowRelevance(广告/垃圾簇沉底提示) */
export const CLUSTER_NOISE_SCORE = 0.3;

// ---- 语义相关性重排(query↔文档余弦,ML 温和过滤;不可用自动回退 text+rank) ----
/** 语义相关性在簇分数中的权重(有 queryVec 时,text/rank 权重按比例收缩,保持三者之和为 1) */
export const SEM_WEIGHT = envNumber("WEBSEARCH_SEM_WEIGHT", 0.45);
/** 语义模式下,簇内 query↔文档平均余弦低于此 → 额外标记 lowRelevance(仍展示,不剔除) */
export const SEM_NOISE_THRESHOLD = envNumber("WEBSEARCH_SEM_NOISE", 0.32);

// ---- 语义相关性分级(展示策略层,relevance.mjs 消费;不删 URL,分级给摘要) ----
// 三档:相关(完整展示) / 边缘(标题+URL,不给摘要) / 无关(沉底折叠区,只留 URL+原因)
// 阈值自适应:基于当前结果集最高语义分(top)的比例 + 绝对下限双保险,
// 避免模型/语言漂移导致固定阈值失真(实测 Qwen3:相关 0.59 vs 词典 0.36)。
/** 分级模式:balanced=默认三档;aggressive=边缘/无关折叠为单行汇总;conservative=只排序不折叠 */
export const REL_MODE = process.env.WEBSEARCH_REL_MODE || USER_CONFIG.semantic?.relevanceMode || "balanced";
/** 相关区:rel ≥ max(REL_RELEVANT_MIN, top×REL_RELEVANT_RATIO) */
export const REL_RELEVANT_MIN = 0.5;
export const REL_RELEVANT_RATIO = 0.6;
/** 无关区:rel < max(REL_IRRELEVANT_MIN, top×REL_IRRELEVANT_RATIO) */
export const REL_IRRELEVANT_MIN = 0.25;
export const REL_IRRELEVANT_RATIO = 0.4;
/** 文本命中但语义无关的判定:簇 textScore(文本命中率)>此值 且 语义分低 → 原因注明"含查询词但语义无关" */
export const REL_TEXT_HIT = 0.5;
/** 折叠详情缓存文件(每次搜索覆盖;agent 可用 reveal 命令或直接读取展开查看折叠内容) */
export const REVEAL_FILE = `${CACHE_DIR}/websearch-collapsed.md`;

// ---- 域名信誉评分 + 增量学习(domain-rep.mjs) ----
/** 信誉库持久化文件(跨 CLI 进程增量积累;软文站动态演化,不永久定罪、按衰减回归中性) */
export const REP_FILE = `${CACHE_DIR}/websearch-domain-rep.json`;
/** 冷启动:样本数低于此不干预(避免少量样本误伤,学习期先观察) */
export const REP_MIN_SAMPLES = 3;
/** 信誉分 → quality 乘性因子映射斜率:score 0.5→1.0,0→0.35,1→1.15(clamp 后) */
export const REP_STRENGTH = envNumber("WEBSEARCH_REP_STRENGTH", USER_CONFIG.reputation?.strength ?? 1.6);
/** 超过此天数未见的域名开始向中性 0.5 回归(站点改版/换人运营的宽容期) */
export const REP_DECAY_START_DAYS = 30;
/** 超过此天数未见 → 完全中性(0.5,零影响) */
export const REP_DECAY_FULL_DAYS = 90;
/** 信誉库域名条数上限(超出清最久未见的一半,防无限膨胀) */
export const REP_MAX_DOMAINS = 5000;
/** fetch 成功(正文≥此字符)的贡献分(最强正信号:真实内容质量) */
export const REP_FETCH_OK_CONTRIB = 0.95;
/** fetch 空/失败 的贡献分(最强负信号) */
export const REP_FETCH_EMPTY_CONTRIB = 0.1;
/** fetch 正文达到此字符数才算成功(防“页面能开但正文为空”的软文壳) */
export const REP_FETCH_MIN_OK_CHARS = 200;

// ---- 在线跨域模式学习(历史 META_* 变量名保留兼容) ----
/** 模式权重在线学习率(每条样本的梯度步长;随样本数递减) */
export const META_LR = envNumber("WEBSEARCH_META_LR", 0.05);
/** 模式库最少样本数:少于此时冷启动预测不可靠,不启用(避免学歪的模式误判新域名) */
export const META_MIN_SAMPLES = envNumber("WEBSEARCH_META_MIN_SAMPLES", 30);
/** 冷启动预测分压缩区间(防极端;0.15/0.85 时 factor≈0.4/1.1,软降权可控) */
export const META_COLD_CLAMP = [0.15, 0.85];
/** 学习式 token 特征权重上限(超上限清最久未见的一半,防膨胀) */
export const META_MAX_WEIGHTS = envNumber("WEBSEARCH_META_MAX_WEIGHTS", 6000);
/** 强信号(fetch 实测)的固定学习率:不随样本数衰减 —— 实测反馈必须压过大量中性搜索样本 */
export const META_STRONG_LR = envNumber("WEBSEARCH_META_STRONG_LR", 0.2);
/** L2 收缩(正则):每次更新对激活 token 权重乘 (1-λ) 向 0 回归 —— 罕见 token 被少数样本推走后自然淡出,稳定 token 保持(无正则的在线学习在稀疏特征下必过拟合,FTRL 同理) */
export const META_L2_DECAY = envNumber("WEBSEARCH_META_L2_DECAY", 0.001);
/** 显式启用 LLM 学习后,CLI 最多等待这么久;0 = 不等待后台学习。 */
export const LLM_WAIT_MS = Math.max(0, envNumber("WEBSEARCH_LLM_WAIT_MS", 3000));
/** 冷启动预测置信度达满所需样本数:>= 此值时压缩系数全量生效(1.0)。
 * Bayesian smoothing 精神:模式越成熟预测越敢偏离中性,刚过门槛时保守压缩。 */
export const META_TRUST_FULL_SAMPLES = 3000;

// ---- 正文提取 ----
/** 容器文本低于此长度视为无效,继续降级 */
export const MIN_CONTAINER_CHARS = 100;
/** 正文最大字符数 */
export const MAX_BODY_CHARS = 200_000;
