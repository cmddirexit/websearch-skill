/**
 * antiblock.mjs — 反爬类型识别器(scrapfly Antibot-Detector 思路精简版)
 *
 * 价值:降级链现在只知道"被挡了",不知道"被什么挡了"。识别出反爬类型后,
 * 降级策略可以更有针对性:
 *   cloudflare-turnstile     → 浏览器兜底 + Turnstile 自动求解(已移植)
 *   cloudflare-interstitial  → 浏览器兜底,等自动跳转
 *   js-countdown             → 浏览器兜底(虚拟时间快进 / 等倒计时)
 *   rate-limit               → 走冷却,不反复请求
 *   captcha                  → 浏览器兜底(求解成功率有限,如实提示)
 *   blocked                  → 通用封禁
 *
 * 纯函数、零依赖、只扫 HTML 头部(大页面省内存)。识别结果进引擎 blocked 的
 * reason,降级日志 [degrade] 自动带上类型标签,agent 一眼知道发生了什么。
 */

/** 反爬类型 → 展示标签 */
export const ANTIBOT_LABELS = {
  "cloudflare-turnstile": "Cloudflare Turnstile 挑战",
  "cloudflare-interstitial": "Cloudflare 检查页(Just a moment)",
  "js-countdown": "JS 倒计时/启用 JS 验证",
  "rate-limit": "限流/频率限制",
  captcha: "验证码(reCAPTCHA/hCaptcha/极验)",
  blocked: "访问被拒",
  "login-wall": "登录/会话风控(知乎 40362 等)",
};

/** SPA 残缺检测参数(见 classifyFetchResult 注释):HTML ≥ 此倍数 × 正文才可疑 */
export const TRUNCATE_HTML_RATIO = 10;
/** 只对正文小于此字符数的结果做截断检测(长文截断风险低,且大页面正文本身就长) */
export const TRUNCATE_MAX_CHARS = 3000;
/** SPA 懒加载占位文本:正文短且含这些标记 = 页面 JS 还没渲染出内容(央视网等 "正在加载" 壳) */
export const LOADING_PLACEHOLDER_RE = /正在加载|页面加载中|内容加载中|加载中…|加载中\.\.\.|loading\.\.\.|数据加载|努力加载|加载失败/i;
/** 列表页结果的最少条目数:≥ 此值视为可用内容(不再当空壳) */
export const LIST_OK_ITEMS = 3;

/**
 * 统一反爬/风控内容检测(单一事实来源):输入错误消息/风控 JSON/页面片段,
 * 命中任何反爬特征 → true。供 cli.mjs(抓取反馈三分类)、browser.mjs(风控页降级判断)等
 * 共用 —— 避免各处维护不同正则导致行为漂移。
 * 覆盖:HTTP 403 / 知乎 40362 风控 JSON / 验证码 / access denied / 限流 / 禁止访问。
 * 注意 /403/ 可能误命中正文里的数字“403”,使用场景限定为“短内容/错误信息/风控页头部”,
 * 且调用方通常配合内容长度判定(见 classifyFetchResult)。
 */
export function isAntibotContent(text) {
  if (!text) return false;
  const s = String(text).slice(0, 2000);
  return /403|40362|风控|验证码|antispider|access denied|access restricted|forbidden|captcha|restricted|暂时限制本次访问|请求存在异常|摇一摇|rate limit|请求过于频繁|访问过于频繁|拒绝访问|禁止访问|已被拦截|blocked/i.test(
    s,
  );
}

/**
 * 抓取结果分类(纯函数,可单测):正文达线 → full(LLM 判可信度);
 * 短内容命中反爬特征 → blocked(中性,不降分);否则 → empty(真空壳,负反馈)。
 * 分类决策集中于此,cli.mjs 只消费结果 —— 反爬≠垃圾的信号分类原则的唯一出口。
 *
 * 新增 truncated 类:SPA(Next.js/React 等)站直连时正文在 JS 数据流里,
 * Readability 只能提取出开头一小段(常以句子中途的裸字符/单词截断),
 * 字符数可能 >= minOkChars 而误判 full —— 残缺内容既直接返回又写缓存,
 * 6h 内全部命中残缺缓存,浏览器兜底(能拿完整页)永远没机会执行。
 * 判定特征(两个条件同时满足才判 truncated,避免误伤正常短页):
 *   1. 原始 HTML 大小远大于提取正文(SPA 特征:正文被 JS 吃掉)
 *   2. 提取正文以裸字母/数字/汉字结尾(句子中途截断,非正常句末标点)
 * 命中 truncated 后 cli 走浏览器兜底、不写缓存 —— 与 full/empty 同样处理,
 * 只是不把残缺内容当成功。
 */
export function classifyFetchResult(r, minOkChars = 200) {
  const raw = (r?.markdown || r?.body || "").trim();
  const len = raw.length;
  // 列表页结果(频道/滚动/聚合页的链接列表):条目数达标即视为可用内容 ——
  // 空壳兜底链没必要为列表页再跑浏览器(中新网等站点浏览器也被反爬)。
  if (r?.isList && (r.listCount || 0) >= LIST_OK_ITEMS && len >= 60) {
    return { kind: "full", len };
  }
  if (len >= minOkChars) {
    // SPA 懒加载占位壳:正文达线但含“正在加载”等标记且内容短 → truncated(残缺),
    // 触发浏览器兜底拿 JS 渲染后的完整正文(央视网等客户端渲染站)。
    if (len < TRUNCATE_MAX_CHARS && LOADING_PLACEHOLDER_RE.test(raw)) {
      return { kind: "truncated", len };
    }
    // SPA 残缺检测:HTML 远大于正文 + 正文裸字符截断 → truncated(非 full)
    const htmlBytes = r?.htmlBytes ?? 0;
    const lastChar = raw[len - 1];
    const bareEnd = /[A-Za-z0-9\u4e00-\u9fff]$/.test(lastChar); // 以裸字母/数字/汉字结尾 = 句子中途截断
    if (htmlBytes >= TRUNCATE_HTML_RATIO * len && bareEnd && len < TRUNCATE_MAX_CHARS) {
      return { kind: "truncated", len };
    }
    return { kind: "full", len };
  }
  const probe = `${raw} ${r?.metaDesc || ""} ${r?.title || ""}`.slice(0, 500);
  if (isAntibotContent(probe)) return { kind: "blocked", len };
  return { kind: "empty", len };
}

/**
 * 识别页面 HTML 中的反爬类型。
 * @param {string|null} html
 * @returns {{type:keyof ANTIBOT_LABELS, label:string}|null} 未识别 → null
 */
/** Cloudflare 挑战判定(单一事实来源):detectAntibot 结果是否为 CF 系验证
 * (turnstile/interstitial/managed 等)。browser/cli 一律走这里,禁止各处散落
 * type === "cloudflare-..." 判断 —— CF 换类型名只改这一处。 */
export function isCfAnti(anti) {
  return !!(anti && typeof anti.type === "string" && anti.type.startsWith("cloudflare"));
}

export function detectAntibot(html) {
  if (!html) return null;
  const s = html.slice(0, 20_000); // 只扫头部,大页面省内存;特征串都在头部 JS/标题里
  // 1. Cloudflare Turnstile 交互挑战(CF 挑战 JS 里的 cType 特征串)
  if (/cType:\s*'(non-interactive|managed|interactive)'/.test(s)) {
    return { type: "cloudflare-turnstile", label: ANTIBOT_LABELS["cloudflare-turnstile"] };
  }
  // 2. Cloudflare interstitial("Just a moment..." 检查页 / challenge-platform 脚本)
  if (/<title>Just a moment\.\.\.<\/title>/i.test(s) || /challenges\.cloudflare\.com\/cdn-cgi\/challenge-platform/i.test(s)) {
    return { type: "cloudflare-interstitial", label: ANTIBOT_LABELS["cloudflare-interstitial"] };
  }
  // 3. JS 倒计时/需启用 JS 验证(如 marginalia 的 1 秒倒计时页)
  if (/manually proceed|countdown|enable javascript|waiting for javascript/i.test(s)) {
    return { type: "js-countdown", label: ANTIBOT_LABELS["js-countdown"] };
  }
  // 4. 限流
  if (/too many requests|rate limit(ed|ing)?|请求过于频繁|访问过于频繁|稍后再试/i.test(s)) {
    return { type: "rate-limit", label: ANTIBOT_LABELS["rate-limit"] };
  }
  // 5. 通用验证码(turnstile 脚本嵌入也算;reCAPTCHA/hCaptcha/极验)
  if (/g-recaptcha|recaptcha|hcaptcha|geetest|challenges\.cloudflare\.com\/turnstile/i.test(s)) {
    return { type: "captcha", label: ANTIBOT_LABELS.captcha };
  }
  // 6. 通用封禁
  if (/access denied|forbidden|blocked|拒绝访问|禁止访问|已被拦截/i.test(s)) {
    return { type: "blocked", label: ANTIBOT_LABELS.blocked };
  }
  // 7. 登录/会话风控(知乎 40362 风控 JSON、请求存在异常等)—— 内容级反爬,
  //    区别于 HTTP 状态码;命中即应走“中性不降分 + 换干净通道/登录 cookie”策略
  if (/40362|您当前请求存在异常|暂时限制本次访问|摇一摇/.test(s)) {
    return { type: "login-wall", label: ANTIBOT_LABELS["login-wall"] };
  }
  return null;
}

/** 404 页面检测(单一事实来源):页面不存在时直连/浏览器渲染后 HTML 都带 404 特征。
 * 用于把“页面不存在”从“被反爬拦截/浏览器失败”中区分出来 —— 否则兜底链白跑
 * 90s+ 后报误导性错误(可能被 CF 拦截),实际只是 URL 写错/页面删除。
 * 返回 {{type:'not-found', label}|null}。特征优先级:
 *   1. <title> 直接含 404 + not found(Next.js/多数框架的默认 404 页)
 *   2. title 含“404 不存在”语义(中文站/自定义 404 页:错误 404 / 404 页面不存在)
 *   3. body 的 404 特征串(页面级标记:could not be found / 请求的页面不存在 / 找不到该页)
 * 注意:规则 3 的“not found”必须是页面级完整短语(而非科普文“HTTP 404 Not Found is..."),
 * 且需在 title/正文头部区域 —— 科普/文档页含 404 字样但页面存在,不能误判。 */
export function detectNotFound(html) {
  if (!html) return null;
  const s = html.slice(0, 20_000);
  const title = (s.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
  // 1. Next.js 404 页:title = "404: This page could not be found."
  if (/404/.test(title) && /not\s*found|could\s*not\s*be\s*found/i.test(title)) {
    return { type: "not-found", label: "404 页面(页面不存在)" };
  }
  // 2. title 含“404 + 不存在”语义(中文站/自定义 404 页,标题短且明确)
  if (title && title.length < 60 && /404/.test(title) && /不存在|无法找到|未能找到|not\s*found|couldn't\s*be\s*found/i.test(title)) {
    return { type: "not-found", label: "404 页面(页面不存在)" };
  }
  // 3. body 页面级 404 特征串(完整短语,需出现在前 3000 字符 —— 页面头部是
  //    404 标识的固定位置;科普文里的 "HTTP 404 Not Found is a standard..." 是
  //    讲解句式,不匹配这里的独立短语,且科普页 title 不含 404 不会走到这)
  const head = s.slice(0, 3000);
  if (/404/.test(head) && /this\s*page\s*(could\s*not\s*be\s*found|does\s*not\s*exist|was\s*not\s*found)|请求的页面(不存在|无法找到)|找不到该页|页面不存在|您访问的页面(不存在|已被删除)/i.test(head)) {
    return { type: "not-found", label: "404 页面(页面不存在)" };
  }
  return null;
}
