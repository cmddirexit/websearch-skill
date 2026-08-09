/**
 * engines/sogou.mjs — 搜狗搜索(桌面 UA 直连)
 *
 * 反爬研究结论(实测):
 *  - 桌面 UA 直连 https://www.sogou.com/web?query= → 200,标准 HTML 结果页
 *  - 移动 UA 302 → m.sogou.com(移动版结构不同),故用桌面 UA
 *  - 结果链接是 /link?url= 加密跳转;跳转页为静态 HTML 内嵌 JS:
 *      <script>window.location.replace("http://real/")</script>
 *      <noscript><META http-equiv="refresh" content="0;URL='http://real/'">
 *    正则直接提取真实 URL,无需浏览器、无需跟随重定向、无需 cookie(实测裸 curl 可得)
 *  - 推广块:vrwrap 附加类 middle-better-hintBox(及内容区"推广"标记),需过滤
 *
 * 解析(桌面版 HTML):
 *  - 按 <div class="vrwrap 分割结果块(捕获组保留开标签以检查推广类名)
 *  - 标题: h3.vr-title | h3.pt 内 <a>(含 <em> 高亮,clean 去标签)
 *  - 摘要: div#cacheresult_summary_N,回退 .star-wiki(均含 <em>)
 *  - 真实 URL: 对每条 /link?url= 小并发(4)请求跳转页提取 window.location.replace;
 *    失败回退原始跳转链接(可打开,但下游 fetch 无正文)
 */

import { httpGet } from "../http.mjs";
import { parseSerp } from "../parse-serp.mjs";
import { clean, decodeEntities, extractSerpDate } from "../html.mjs";
import { UA, SOGOU_COOLDOWN_MS } from "../config.mjs";
import { createCooldown } from "../cooldown.mjs";
import { parseDomOr, elementText, queryOne, queryAll } from "../dom.mjs";

const SOGOU_URL = "https://www.sogou.com/web";
const SOGOU_HOME = "https://www.sogou.com/"; // 会话建立:先访问主页拿 cookie
const SOGOU_ORIGIN = "https://www.sogou.com";
const RESOLVE_CONCURRENCY = 4; // 跳转解析并发(浏览器点击链接级别,礼貌但够快)
const RESOLVE_TIMEOUT_MS = 4_000;
const BLOCKED_MIN_LEN = 8_000; // 风控页远小于正常结果页(~470KB)

// ---- 风控降触发策略 ----
// ① 触发验证码后冷却 SOGOU_COOLDOWN_MS:期内直接快速失败,不再请求(避免反复触发)
// ② 首次调用先访问主页建立 cookie 会话(无 cookie 直接搜索更易触发风控)
// 会话级冷却(进程内,不持久化):单 key;与 aggregate 引擎失败记忆/embed API 冷却
// 同一通用工具(cooldown.mjs),此处用直接 setCooldown 语义(触发即冷却,非累计)
const sogouCooldown = createCooldown({ threshold: 2, cooldownMs: SOGOU_COOLDOWN_MS });
const SOGOU_KEY = "sogou";
let sessionReady = false; // 会话是否已建立

/** 冷却检查(测试可直调) */
export function isInCooldown() {
  return sogouCooldown.isCooled(SOGOU_KEY);
}

/** 设置冷却(测试/内部用) */
export function setCooldown(ms) {
  sogouCooldown.setCooldown(SOGOU_KEY, ms);
}

/** 触发验证码 → 记录冷却起点 */
function markBlocked() {
  sogouCooldown.setCooldown(SOGOU_KEY, SOGOU_COOLDOWN_MS);
}

/** 建立会话:首次搜索前先 GET 主页拿 cookie(失败不致命,继续搜索) */
async function ensureSession() {
  if (sessionReady) return;
  sessionReady = true; // 防并发重复
  try {
    await httpGet(SOGOU_HOME, { timeoutMs: 5_000 });
  } catch {
    /* 主页不可达不阻塞搜索 */
  }
}

/** 从搜狗跳转页提取真实 URL(window.location.replace / noscript META refresh 双兜底) */
export function extractRealUrlFromRedirect(body) {
  const js = body.match(/window\.location\.replace\("([^"]+)"\)/);
  if (js && js[1].startsWith("http")) return decodeEntities(js[1]);
  const meta = body.match(/content="0;URL='([^']+)'"/i);
  if (meta && meta[1].startsWith("http")) return decodeEntities(meta[1]);
  return "";
}

/** 解析一条跳转链接 → 真实 URL;失败回退原跳转链接 */
async function resolveRealUrl(linkUrl) {
  try {
    const res = await fetch(linkUrl, {
      headers: { "User-Agent": UA, Referer: SOGOU_URL, Accept: "text/html" },
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
      redirect: "follow",
    });
    if (!res.ok) return linkUrl;
    const real = extractRealUrlFromRedirect(await res.text());
    return real || linkUrl;
  } catch {
    return linkUrl; // 超时/网络失败:保留跳转链接(仍可打开,下游拿不到正文)
  }
}

/** 小并发 worker 池批量解析跳转链接(同域轻量请求,不套 httpGet 限速——浏览器点击级别) */
async function resolveAll(urls) {
  const out = new Array(urls.length);
  let i = 0;
  const n = Math.min(RESOLVE_CONCURRENCY, urls.length);
  const worker = async () => {
    while (i < urls.length) {
      const idx = i++;
      out[idx] = await resolveRealUrl(urls[idx]);
    }
  };
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

/**
 * 解析搜狗搜索页 HTML(直连/fixture 测试共用)。
 * 解析命中 0 条 → blocked:true + reason 提示结构可能变更。
 * @returns {{blocked:boolean, reason?:string, results:Array<{title,url,desc}>}}
 */
export function parseSogouHtml(html, limit) {
  // 风控检测:验证码页远小于正常结果页(~470KB),或出现反爬资源/特征
  if (
    html.length < BLOCKED_MIN_LEN ||
    /antispider|请输入验证码|验证码|captcha|verify\.css|anti\.min\.css/i.test(html.slice(0, 2000))
  ) {
    return {
      blocked: true,
      reason: "搜狗触发验证码(反爬风控,短时多次搜索易触发,稍后可恢复),尝试 baidu",
      results: [],
    };
  }
  // 按 vrwrap 块分割(DOM 选择器定位);推广块:附加类 middle-better-hintBox 或块内"推广"标记
  const doc = parseDomOr(html);
  const results = [];
  for (const el of queryAll(doc, "div.vrwrap")) {
    if (results.length >= limit) break;
    const cls = el.getAttribute("class") || "";
    if (/middle-better-hintBox|sogou_ad|(?:^|[\s"])ad[-\s]/i.test(cls) || /推广/i.test(el.innerHTML.slice(0, 300))) continue;
    const h = queryOne(el, "h3.vr-title a[href], h3.pt a[href]");
    if (!h) continue;
    const title = clean(elementText(h));
    const link = decodeEntities(h.getAttribute("href") || "");
    if (!title || !link.startsWith("/link?url=")) continue;
    // 摘要:三级回退 ①cacheresult_summary id(纯文本结果)②fz-mid space-txt(图文结果)③star-wiki(相关卡)
    let desc = "";
    const sm = queryOne(el, "div[id^='cacheresult_summary_']");
    if (sm) desc = clean(elementText(sm));
    if (!desc) {
      const fz = queryOne(el, "div.fz-mid.space-txt");
      if (fz) desc = clean(elementText(fz));
    }
    if (!desc) {
      const sw = queryOne(el, "div.star-wiki");
      if (sw) desc = clean(elementText(sw));
    }
    // 日期:标题/摘要全文兜底(完整年月日格式严格,散文年份不会误报)
    const date = extractSerpDate(title + " " + desc);
    results.push({ title, url: SOGOU_ORIGIN + link, desc: desc.slice(0, 400), ...(date ? { date } : {}) });
  }
  if (results.length === 0) {
    return {
      blocked: true,
      reason: "搜狗页面解析命中 0 条:页面结构可能已变更,请运行 npm run fixtures 更新快照",
      results,
    };
  }
  return { blocked: false, results };
}

/**
 * 搜狗搜索(桌面 UA)。
 * 冷却期内快速失败(不请求);首次调用先建立 cookie 会话。
 * @returns {Promise<{engine:"sogou", mode:"web", blocked:boolean, reason?:string, results:Array}>}
 */
export async function searchSogou(query, limit) {
  if (isInCooldown()) {
    return {
      engine: "sogou",
      mode: "web",
      blocked: true,
      reason: "搜狗处于验证码触发后的冷却期(约 5 分钟),自动跳过,尝试 baidu",
      results: [],
    };
  }
  await ensureSession();
  const url = `${SOGOU_URL}?query=${encodeURIComponent(query)}&num=${limit}`;
  const html = await httpGet(url); // 默认桌面 UA
  const parsed = parseSerp(html, { engineKey: "sogou", specific: parseSogouHtml, limit, excludeHosts: ["www.sogou.com"] });
  const { blocked, reason, results, parsedBy, hitRate, specificCount, genericCount } = parsed;
  if (blocked) {
    markBlocked(); // 触发验证码 → 进入冷却
    return { engine: "sogou", mode: "web", blocked: true, reason, results: [], ...(parsedBy ? { parsedBy } : {}) };
  }
  // 逐条解析跳转链接 → 真实 URL(小并发)
  const realUrls = await resolveAll(results.map((r) => r.url));
  results.forEach((r, i) => {
    if (realUrls[i]) r.url = realUrls[i];
  });
  return { engine: "sogou", mode: "web", blocked: false, results, ...(parsedBy ? { parsedBy, hitRate, specificCount, genericCount } : {}) };
}
