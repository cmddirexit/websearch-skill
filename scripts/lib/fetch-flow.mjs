/**
 * fetch-flow.mjs — 抓取调度:直连 → 存档 → 浏览器兜底链
 *
 * 从 cli.mjs 拆出(2026-08 重构):runFetch 的决策链(缓存命中/直连达线/空壳兜底/
 * CF 快速通道/404 归因/错误分诊)+ 存档兜底独立成模块,cli.mjs 变为调度门面
 * (re-export runFetch/cacheFetchResult 保持公共 API 不变)。
 *
 * 决策链测试见 tests/unit/cli.test.mjs(8 场景,mock.module 全局生效,拆分后零改动)。
 */

import { fetchViaBrowser, resolveChromiumPath, getLastBrowserFailure } from "./engines/browser.mjs";
import {
  REP_FETCH_MIN_OK_CHARS,
  MAX_BODY_CHARS,
  ARCHIVE_WAYBACK_TIMEOUT_MS,
  ARCHIVE_TODAY_TIMEOUT_MS,
  ARCHIVE_COOLDOWN_MS,
  ARCHIVE_FAIL_FILE,
} from "./config.mjs";
import { createCooldown } from "./cooldown.mjs";
import { pageCacheGet, hostOf, isKnownCfHost } from "./persist.mjs";
import { dbg, dbgStep, brief } from "./debug.mjs";
import { isAntibotContent, classifyFetchResult, detectAntibot, isCfAnti } from "./antiblock.mjs";
import { rep, queueFetchLearn } from "./learn.mjs";
import { emitFetchResult } from "./format.mjs";
import { validateFetchUrl } from "./url-safety.mjs";

/** 存档兜底失败冷却:不可达网络下连续失败后跳过(跨进程持久化,成功自动恢复)。
 * file 支持 env 覆盖(测试隔离,避免写真实 cache)。 */
export const archiveCooldown = createCooldown({
  threshold: 2,
  cooldownMs: ARCHIVE_COOLDOWN_MS,
  file: process.env.WEBSEARCH_ARCHIVE_FAIL_FILE || ARCHIVE_FAIL_FILE,
});

/** 只有网络、限流或服务端故障才说明 archive 基础设施不可用。 */
export function isArchiveInfrastructureError(error) {
  const status = Number(error?.status);
  if (Number.isFinite(status) && status > 0) {
    return status === 401 || status === 403 || status === 407 || status === 408
      || status === 425 || status === 429 || status === 451 || status >= 500;
  }
  const message = String(error?.message || error || "").toLowerCase();
  return /abort|timeout|timed out|fetch failed|network|econn|enet|ehost|enotfound|unreachable|socket|dns/.test(message);
}

/** URL 无快照/无正文不应触发全局冷却;必须所有镜像都属于基础设施故障。 */
export function shouldCoolArchive(failures) {
  return Array.isArray(failures) && failures.length > 0
    && failures.every(isArchiveInfrastructureError);
}

/** 抓取调度:直连失败时尝试浏览器兜底。(导出供决策链单测;见 tests/unit/cli.test.mjs) */
export async function runFetch(url, maxChars) {
  url = validateFetchUrl(url);
  const t0 = Date.now();
  dbg(`fetch start: ${url} (maxChars=${maxChars})`);
  // 主动选择本身是使用价值信号,所以缓存命中也计数;内容质量与可用性仍由后续独立通道判断。
  rep.learnSelection(url);
  rep.save();
  // 页面级缓存命中(6h 内):秒回,不再走 45-90s 的 CF 兜底链
  const cached = pageCacheGet(url);
  if (cached) {
    console.error(`[cache] 命中 6h 内页面缓存,跳过抓取`);
    dbg(`缓存命中: markdown ${(cached.markdown || "").length} 字符 → 秒回`);
    emitFetchResult({ ...cached, _cached: true }, maxChars);
    dbg(`fetch done(缓存): ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return;
  }
  let host = hostOf(url);
  const { fetchPage } = await import("./fetch-page.mjs"); // 懒加载:jsdom 链只在真抓正文时加载
  // 反爬/风控类失败(403/验证码/Access Restricted):内容可能很好只是被拦,中性不降分。
  // 只有"页面能开但正文空壳/拼凑"才是软文负信号;正文完整 ≠ 可信(软文页也能打开),
    // 正文内容反馈走 learnFetchContent(本地结构证据,可选 LLM 增强)。
  // 反爬特征检测统一走 antiblock.mjs(单一事实来源),避免正则散落漂移。
  const isAntiBot = isAntibotContent;
  const isHttpError = (msg) => /HTTP \d{3}|status \d{3}|\b404\b|\b500\b|\b502\b|\b503\b/.test(msg || "");
  // 抓取结果三分类(纯函数,可单测):full → LLM 判可信度;blocked → 中性不降分;empty → 真空壳负反馈
  const classify = (r) => classifyFetchResult(r, REP_FETCH_MIN_OK_CHARS);
  // 反馈(空壳/HTTP 错误/网络失败):网络环境问题中性,页面内容问题才负 —— 避免把
  // "浏览器不可用/断网"误判为"页面是垃圾"。
  const feedbackEmpty = () => {
    rep.learnFetch(url, false, {});
    rep.save();
  };
  // 反爬/风控拦截(403/验证码/风控 JSON):内容可能很好只是被拦,中性不降分(见 learnFetchBlocked)
  const feedbackBlocked = () => {
    rep.learnFetchBlocked(url, {});
    rep.save();
  };
  // SPA 残缺(truncated):页面能开、正文达线但被 JS 吃掉(Next.js/React 壳),
  // 是技术性不完整不是内容垃圾 —— 与 blocked 同理中性不降分(learnFetchBlocked 只更新计数)
  const feedbackTruncated = () => {
    rep.learnFetchBlocked(url, {});
    rep.save();
  };
  const feedbackFull = (r) => {
    // 正文完整 → 本地结构证据判断;显式启用时可由 LLM 增强。
    // 挂 llmQueue:fetch 是交互命令,进程退出前要等学习完成(否则丢失)但不超过预算
    queueFetchLearn(url, { title: r.title, desc: r.metaDesc, body: r.markdown || r.body });
  };
  // 统一反馈入口:四分类 → 对应学习通道(truncated 中性,不当空壳负反馈)
  const feedback = (r) => {
    const { kind } = classify(r);
    if (kind === "full") feedbackFull(r);
    else if (kind === "blocked" || kind === "truncated") feedbackBlocked();
    else feedbackEmpty();
  };
  // 已知 CF 站点(记忆命中):直连 10s 大概率白等(CF 对程序化直连必拦,除非配置变化),
  // 直接浏览器兜底(zendriver ~11s 冷启动)省 10s;失败再 fallthrough 到正常直连流程
  if (isKnownCfHost(host)) {
    dbg(`CF 记忆命中 ${host} → 跳过直连,直接浏览器兜底(preferCli 真实等待轮)`);
    const br0 = await dbgStep("已知CF站→fetchViaBrowser(preferCli)", () => fetchViaBrowser(url, MAX_BODY_CHARS, { preferCli: true }));
    if (br0) {
      dbg(`✓ 兜底成功: ${brief(br0)}`);
      feedback(br0);
      emitFetchResult(br0, maxChars);
      dbg(`fetch done(CF 快速通道): ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return;
    }
    console.error(`[degrade] 已知 CF 站点浏览器兜底失败,回退直连流程`);
    dbg(`CF 快速通道失败 → 回退直连流程`);
  }
  try {
    const r = await dbgStep("直连 fetchPage", () => fetchPage(url, MAX_BODY_CHARS));
    // SPA/JS 壳检测:直连 HTTP 200"成功",但正文不足达线字符(如 "Loading..." 占位壳,
    // 常见于 React/Vue 客户端渲染站)—— 这类页面浏览器渲染后才会有真内容,
    // 直接输出空壳是误导(fetch 的意义就是拿正文),先试浏览器兜底;不可用/失败再回退直连结果。
    // (原实现只对 catch 分支兜底,空壳不抛错,导致浏览器兜底链完全没有机会执行)
    const { kind } = classify(r);
    dbg(`直连结果: ${brief(r)}, 分类=${kind}${kind === "full" ? " → 直接返回" : " → 触发兜底"}`);
    if (kind !== "full") {
      console.error(
        `[degrade] 直连返回${kind === "empty" ? "空壳" : kind === "truncated" ? "SPA残缺" : "疑似风控短内容"}(正文 ${(r.body || "").length} 字符 < ${REP_FETCH_MIN_OK_CHARS}),尝试浏览器兜底...`,
      );
      try {
        // 不走 preferCli:真实等待轮(--timeout)只等 load 事件,--dump-dom 不等待 SPA 的 JS
        // 异步渲染(React/Vue 挂载 + 数据 fetch),会拿到 Loading 壳;默认链路里的虚拟时间轮
        // (--virtual-time-budget)才会等 JS 时钟快进后 dump 出真实内容。
        // 另:直连 200(非 CF 拦截)时跳过 zendriver —— 它对普通站是负收益(实测 Next.js 站
        // get 等导航事件 16s+ 还拿壳),库模式/虚拟时间轮 8-11s 就能拿到完整页
        const br = await dbgStep("空壳→浏览器兜底", () => fetchViaBrowser(url, MAX_BODY_CHARS, { skipZendriver: true }));
        if (br) {
          // 浏览器确认 404(直连 200 但实为软 404 页):报页面不存在,不输出空壳误导
          if (br.notFound) {
            dbg(`空壳→浏览器确认 404 → 报页面不存在`);
            throw new Error(`页面不存在(404): ${url}。直连返回 200 空壳,浏览器渲染后确认页面不存在 —— 该 URL 无效或已被删除,请检查链接拼写/时效。`);
          }
          dbg(`✓ 兜底成功: ${brief(br)}`);
          feedback(br);
          emitFetchResult(br, maxChars);
          dbg(`fetch done(空壳兜底): ${((Date.now() - t0) / 1000).toFixed(1)}s`);
          return;
        }
        console.error(`[degrade] ${browserFailHint()},回退直连结果`);
        dbg(`浏览器兜底失败 → 回退直连空壳结果(将作为空壳负反馈)`);
      } catch (be) {
        console.error(`[degrade] 浏览器兜底失败(${be.message}),回退直连结果`);
        dbg(`浏览器兜底异常 → 回退直连结果: ${String(be.message).slice(0, 120)}`);
      }
    }
    feedback(r);
    emitFetchResult(r, maxChars);
    dbg(`fetch done(直连): ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    // 内容类型不支持(如 PDF):浏览器 dump-dom 也拿不到正文,直接抛原错误,不误导性尝试兜底
    if (/不支持的内容类型/.test(e.message)) throw e;
    // 反爬类型识别:403 响应体(http.mjs 已把 body 附到 e.body)或错误消息 → [degrade] 日志带上类型标签,
    // agent 一眼知道"被 Cloudflare Turnstile 拦"而非"页面不存在"(P1-4)
    const anti = e.body ? detectAntibot(e.body) : null;
    // CF 类站点判定:①直连 403 响应体带 CF 特征 ②已知 CF 站点记忆(真实等待轮成功过)
    // —— 二者都直接走浏览器快速通道,跳过存档
    const host = hostOf(url);
    const isCf = isCfAnti(anti) || isKnownCfHost(host);
    // 登录/会话风控(知乎 40362 等):archive 同样抓不到需登录的内容,且此类站
    // 库模式 CDP 泄漏必被拦 —— 与 CF 同待遇:跳过存档,直接 CLI 真实等待轮。
    const isLoginWall = anti?.type === "login-wall";
    const isKnownAnti = isCf || isLoginWall;
    console.error(`[degrade] 直连抓取失败(${e.message})${anti ? ` —— ${anti.label}` : isCf ? " —— 已知 CF 站点" : ""},尝试兜底...`);
    dbg(`直连失败: ${e.message}${anti ? `(反爬: ${anti.label})` : ""} isCf=${isCf} isLoginWall=${isLoginWall} → 走兜底链`);
    // HTTP 404 = 页面不存在:与反爬/网络错误不同,404 是确定性结论 —— 存档兜底
    // 必然同样 404(archive 不会保存不存在的页面),白跑 20s+;浏览器渲染也只会拿到
    // 404 页(Next.js 等 SSR 站尤其如此)。直接标记 notFound,浏览器确认一次后报准确错误。
    const isNotFound = /HTTP 404|status 404|\b404\b/.test(e.message);
    if (isNotFound) {
      dbg(`直连 HTTP 404 → 页面不存在(非反爬/网络错误),跳过存档,浏览器确认...`);
    }
    // 存档兜底条件:非反爬硬墙站 且 非冷却期 且 有 HTTP 状态(网络层失败 fetch failed/aborted 时
    // archive 站同样不可达,实测纯浪费;只有 HTTP 403/5xx 才有存档价值,如知乎直连 403)。
    // 冷却期:archive 连续失败达阈值后跳过(不可达网络下省 ~20s),成功自动恢复。
    let ar = null;
    if (!isKnownAnti && !archiveCooldown.isCooled("archive") && e.status && !isNotFound) {
      try {
        ar = await dbgStep("存档兜底(wayback+today)", () => fetchViaArchive(url, MAX_BODY_CHARS));
        if (ar) archiveCooldown.mark("archive", true);
      } catch (ae) {
        if (ae.archiveInfrastructureFailure) archiveCooldown.mark("archive", false);
        console.error(`[degrade] 存档兜底不可用(${ae.message})`);
        dbg(`存档兜底失败: ${String(ae.message).slice(0, 120)}`);
      }
      if (ar) {
        dbg(`✓ 存档命中: ${brief(ar)}`);
        feedback(ar);
        emitFetchResult(ar, maxChars);
        return;
      }
    }
    // 2) 浏览器兜底
    console.error(`[degrade] 存档无快照,尝试浏览器兜底...`);
    let br = null;
    let browserErr = null; // 保存浏览器失败原因,最终错误归因用(P0-1)
    try {
      // CF 验证站/网络层失败(无 HTTP 状态):库模式 CDP 泄漏必被拦且网络层失败时
      // 库模式同样连不上 —— 跳过库模式与虚拟时间轮,直接 CLI 真实等待轮(省 ~10-30s)
      // 直连已 404:跳过 zendriver(它会对 404 页空等 60s 拿同一张壳),库模式
      // 8-9s 即可确认浏览器渲染后仍是 404 页,无需 CLI 真实等待轮
      br = await dbgStep("浏览器兜底", () =>
        fetchViaBrowser(url, MAX_BODY_CHARS, {
          preferCli: isKnownAnti || !e.status,
          skipZendriver: isKnownAnti || !e.status || isNotFound,
        }),
      );
    } catch (be) {
      // 浏览器兜底失败是环境问题(未安装/启动失败/反爬页),不是页面问题:中性不降分
      browserErr = be;
      console.error(`[degrade] 浏览器兜底失败(${be.message}) —— 中性,不降分`);
      dbg(`浏览器兜底异常: ${String(be.message).slice(0, 120)}`);
    }
    if (br) {
      // 浏览器兜底确认 404:zendriver/getDom 渲染后仍是 404 页 → 页面不存在,
      // 报准确错误而非误导性的"可能被 CF 拦截"(fetchViaBrowser 返回 {notFound:true} 标记)
      if (br.notFound) {
        dbg(`浏览器兜底确认 404 → 报页面不存在`);
        throw new Error(`页面不存在(HTTP 404): ${url}。直连返回 404,浏览器渲染后确认页面不存在 —— 该 URL 无效或已被删除,请检查链接拼写/时效。`);
      }
      dbg(`✓ 浏览器兜底成功: ${brief(br)}`);
      // ⚠ 浏览器兜底可能"成功打开"了反爬风控页(知乎 40362 JSON、验证码页)——
      // classify 会归为 blocked → 中性 feedbackBlocked,而非空壳 feedbackEmpty(会降分)
      feedback(br);
      emitFetchResult(br, maxChars);
      return;
    }
    // 直连 404 + 浏览器兜底也无正文:浏览器渲染后仍是 404 页(Next.js 等 SSR 站
    // 对不存在路由返回 404 页,正文 < 阈值),fetchViaBrowser 返回 null —— 此时
    // 报"页面不存在(HTTP 404)"而非误导性的"可能被 CF 拦截"。
    // 注意:浏览器兜底可能是环境失败(未装 chromium/反爬页),此时 isNotFound 判断
    // 只在【直连已 404】时才成立 —— 直连 404 是确定性信号,环境失败不影响结论。
    if (isNotFound) {
      dbg(`直连 404 + 浏览器兜底无正文 → 确证页面不存在`);
      throw new Error(`页面不存在(HTTP 404): ${url}。直连返回 404,浏览器渲染后仍无正文 —— 该 URL 不存在或已被删除。请检查链接拼写/时效,或改用站点搜索获取正确 URL。`);
    }
    // 直连失败 + 兜底不可用:区分原因 —— HTTP 错误且非反爬 = 页面真负;反爬(403/验证码)/网络错误 = 中性
    if (isHttpError(e.message) && !isAntiBot(e.message)) feedbackEmpty();
    // P0-1 错误归因:浏览器已装却报"未安装"是误导 —— 按 resolveChromiumPath 分诊,
    // 并带上反爬类型 + 浏览器最后错误 + 可执行的下一步建议
    const browserHint = browserErr ? `(最后错误: ${browserErr.message.slice(0, 120)})` : `(原因: ${getLastBrowserFailure() || "浏览器返回空"})`;
    if (resolveChromiumPath()) {
      throw new Error(
        `直连/存档/浏览器兜底均失败。已安装 Chromium 但未取得页面 ${browserHint};` +
          `常见原因:目标站 Cloudflare Turnstile/人机验证无法通过(${anti?.label || "未知"})、当前 IP 被站点封锁、或页面需要登录。` +
          `建议:更换网络出口 IP,或手动浏览器访问 ${url} 查看`,
      );
    }
    throw new Error(
      `直连/存档/浏览器兜底均失败。未检测到 Chromium,无法启用浏览器兜底(直连错误: ${e.message})。` +
        `建议: pkg install x11-repo && pkg install chromium 启用浏览器兜底`,
    );
  }
}

/** 浏览器兜底失败提示:区分“未装 Chromium”(环境问题,可安装)与“已装但被站点拦”(页面问题)。
 * 此前统一报“浏览器兜底不可用”误导排查 —— 实测多数情况是站点对浏览器同样反爬,而非浏览器缺失。 */
function browserFailHint() {
  if (resolveChromiumPath()) {
    return `浏览器兜底失败(Chromium 已装,但未取得正文: ${getLastBrowserFailure() || "站点反爬或渲染无正文"})`;
  }
  return `浏览器兜底不可用(未检测到 Chromium —— pkg install x11-repo && pkg install chromium 可启用)`;
}

/** 存档兜底:web.archive.org(独立服务)单发 → archive.today 系多镜像并行(同一服务,选最快)。
 * 原顺序轮询 30s 预算实测在 archive 不可达的网络下纯浪费(计时实测整链慢的主因之一),
 * 并行 + 短超时把最坏等待压到 ~20s;全部失败抛错(带各镜像原因)由调用方吞掉。
 * web.archive.org 用 2id_ 前缀(原始 HTML,不注入工具栏 chrome);archive.today 系用 /newest/。 */
async function fetchViaArchive(url, maxChars) {
  const { httpGetFull } = await import("./http.mjs");
  const { extractBodyFromHtml } = await import("./fetch-page.mjs");
  const errors = [];
  const failures = [];
  const tryMirror = async (name, target, timeoutMs) => {
    const { contentType, finalUrl, body: html } = await httpGetFull(target, { timeoutMs });
    if (!contentType.includes("text/html")) throw new Error(`${name}: 内容类型 ${contentType}`);
    const base = extractBodyFromHtml(html, maxChars, finalUrl);
    if (!base) throw new Error(`${name}: 快照无正文`);
    return { ...base, url: finalUrl };
  };
  // 第一阶段:web.archive.org(唯一权威存档,独立服务)
  try {
    const r = await tryMirror("web.archive.org", `https://web.archive.org/web/2id_/${url}`, ARCHIVE_WAYBACK_TIMEOUT_MS);
    console.error(`[degrade] 存档 web.archive.org 命中`);
    return r;
  } catch (wa) {
    failures.push(wa);
    errors.push(wa.message);
    console.error(`[degrade] 存档 web.archive.org 失败(${wa.message.slice(0, 50)})`);
  }
  // 第二阶段:archive.today 系并行(ph/is/vn/li 都是同一服务的不同域名,选最快可用)
  const todayMirrors = [
    { name: "archive.ph", build: (u) => `https://archive.ph/newest/${u}` },
    { name: "archive.is", build: (u) => `https://archive.is/newest/${u}` },
    { name: "archive.vn", build: (u) => `https://archive.vn/newest/${u}` },
    { name: "archive.li", build: (u) => `https://archive.li/newest/${u}` },
  ];
  const settled = await Promise.allSettled(
    todayMirrors.map((m) => tryMirror(m.name, m.build(url), ARCHIVE_TODAY_TIMEOUT_MS)),
  );
  for (const s of settled) {
    if (s.status === "fulfilled") {
      console.error(`[degrade] 存档 ${s.value.url ? "archive.today 系" : ""} 命中`);
      return s.value;
    }
    failures.push(s.reason);
    errors.push(s.reason?.message || "未知");
  }
  const error = new Error(`存档镜像全部失败: ${errors.join(" | ")}`);
  error.archiveInfrastructureFailure = shouldCoolArchive(failures);
  throw error;
}
