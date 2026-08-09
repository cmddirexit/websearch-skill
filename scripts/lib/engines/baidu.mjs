/**
 * engines/baidu.mjs — 百度搜索(移动端 UA 绕过风控)
 *
 * 反爬研究结论:
 *  - 桌面 UA 直连 www.baidu.com/s → 302 跳转"安全验证"(wappass)风控页
 *  - 移动端 UA(Linux Android)直连同一 URL → 200,返回完整移动版搜索结果页
 *  - 移动版结果链接是 m.baidu.com 重定向,真实 URL 藏在 data-log 属性的 mu 字段
 *
 * 解析(移动版 HTML):
 *  - 按 <div class="c-result result"> 分块(带捕获组保留开标签)
 *  - URL: data-log='{"mu":"真实URL"}'(单引号,区别于 rl-link-data-log 双引号)
 *  - 标题: cosc-title-slot 内的 <!--s-text--> 包裹文本(可能含 <em> 高亮)
 *  - 摘要: pure-summary 的 <!--s-data:JSON--> 中 summaryData.generalLines[].data[].text
 */

import { clean, extractSerpDate } from "../html.mjs";
import { UA_MOBILE, BAIDU_BLOCKED_MIN_LEN } from "../config.mjs";
import { createDirectEngine } from "./factory.mjs";
import { parseSerp } from "../parse-serp.mjs";
import { parseDomOr, elementText, queryOne, queryAll, asElement } from "../dom.mjs";

const BAIDU_URL = "https://www.baidu.com/s";

/** 百度内部域名/推荐位过滤 */
export function isBaiduInternal(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === "www.baidu.com" ||
      host.endsWith(".baidu.com") ||
      host === "baidu.com" ||
      host.endsWith(".bdstatic.com")
    );
  } catch {
    return true;
  }
}

/** 从 data-log JSON 提取 mu(真实 URL) */
export function extractMu(dataLog) {
  const m = dataLog.match(/"mu":"([^"]+)"/);
  return m ? m[1].replace(/&amp;/g, "&") : "";
}

/** 从块元素提取标题(cosc-title-slot 下的 s-text 注释块)。结构用选择器定位,
 * 注释包裹的数据用正则提取(数据块提取,同 extractMu)。命名 extractBlockTitle
 * 以区分 html.mjs 的通用 extractTitle(取 <title>)。 */
export function extractBlockTitle(block) {
  const el = asElement(block);
  if (!el) return "";
  const slot = queryOne(el, "[class*='cosc-title-slot']");
  if (!slot) return "";
  const m = slot.innerHTML.match(/<!--s-text-->([\s\S]*?)<!--\/s-text-->/);
  return m ? clean(m[1]) : "";
}

/** 从块元素提取摘要(pure-summary JSON 数据块,回退 cos-line-clamp 元素) */
export function extractDesc(block) {
  const el = asElement(block);
  if (!el) return "";
  const sm = queryOne(el, "[data-module='pure-summary']");
  if (sm) {
    const m = sm.innerHTML.match(/<!--s-data:(\{[\s\S]*?\})-->/);
    if (m) {
      try {
        const j = JSON.parse(m[1]);
        const lines = j.summaryData?.generalLines || [];
        const text = lines.map((l) => (l.data || []).map((d) => d.text || "").join("")).join(" ");
        if (text) return clean(text);
      } catch {
        /* 解析失败走回退 */
      }
    }
  }
  const c = queryOne(el, "[class*='cos-line-clamp']");
  return c ? clean(elementText(c)) : "";
}

/** 过滤伪摘要:太短或仅域名/站点标识(如 "www.anandtech.com"、"B站精选") */
export function filterDesc(desc, url) {
  if (!desc || desc.length < 12) return "";
  try {
    const host = new URL(url).hostname.replace(/^www\.|^m\./i, "").toLowerCase();
    if (desc.replace(/^www\.|^m\./i, "").toLowerCase().startsWith(host)) return "";
  } catch {
    /* 忽略解析失败 */
  }
  return desc;
}

/**
 * 解析百度搜索页 HTML(直连/浏览器兜底/fixture 测试共用)。
 * 解析命中 0 条 → 返回 blocked:true + reason 提示结构可能变更。
 * @returns {{blocked:boolean, reason?:string, results:Array}}
 */
export function parseBaiduHtml(html, limit) {
  // 风控检测(移动端一般不会触发,但保留兜底)
  if (html.length < BAIDU_BLOCKED_MIN_LEN || /安全验证|请输入验证码|captcha/i.test(html.slice(0, 500))) {
    return {
      blocked: true,
      reason: "百度触发安全验证(反爬风控),尝试 bing",
      results: [],
    };
  }
  const doc = parseDomOr(html);

  // 主模式:div.c-result.result 块(DOM 选择器定位),data-log 属性读 URL
  const results = [];
  for (const el of queryAll(doc, "div.c-result.result")) {
    if (results.length >= limit) break;
    const url = extractMu(el.getAttribute("data-log") || "");
    if (!url.startsWith("http") || isBaiduInternal(url)) continue;
    // 标题:标准结构优先;JS 渲染卡片(视频/资讯)无静态标题时回退域名
    let title = extractBlockTitle(el);
    if (!title) {
      try {
        const u = new URL(url);
        title = `${u.hostname.replace(/^m\./i, "")}${u.pathname !== "/" ? " · " + u.pathname : ""}`;
      } catch {
        continue;
      }
    }
    const desc = extractDesc(el).slice(0, 400);
    // 过滤站点标识类伪摘要(如 "B站精选"、纯域名)
    const finalDesc = filterDesc(desc, url);
    // 标题日期优先(如 "2025年5月11日热点新闻速览",强时效信号;标题不受 40 字符限制),
    // 摘要全文兜底(完整年月日格式严格,散文年份不会误报)
    const titleDate = extractSerpDate(title);
    const date = titleDate || extractBaiduDate(el) || extractSerpDate(desc);
    const r = { title, url, desc: finalDesc };
    if (date) r.date = date;
    results.push(r);
  }

  // 主解析无结果时:回退桌面版解析(兼容页面结构变化)
  if (results.length === 0) {
    const cl = queryOne(doc, "#content_left");
    if (cl) {
      for (const a of queryAll(cl, "a[href]")) {
        if (results.length >= limit) break;
        const url = a.getAttribute("href") || "";
        const title = clean(elementText(a));
        if (!title || !url.startsWith("http")) continue;
        results.push({ title, url, desc: clean(elementText(cl)).slice(0, 400) });
      }
    }
  }
  // 第三级备选:通用 h3>a 提取(百度经典桌面结构,即使容器匹配失败也能抓到链接)
  if (results.length === 0) {
    for (const a of queryAll(doc, "h3 a[href]")) {
      if (results.length >= limit) break;
      const url = a.getAttribute("href") || "";
      const title = clean(elementText(a));
      if (!title || !url.startsWith("http") || isBaiduInternal(url)) continue;
      results.push({ title, url, desc: "" });
    }
  }

  if (results.length === 0) {
    return {
      blocked: true,
      reason: "百度页面解析命中 0 条:页面结构可能已变更,请运行 npm run fixtures 更新快照",
      results,
    };
  }
  return { blocked: false, results };
}

/** 从结果块提取日期(百度结果日期在短文本节点,如 "2026年8月5日"/"3小时前")。
 * 逐文本节点扫描(每段 <40 字符),与 bing 的 extractCaptionDate 同策略 —— 长摘要散文里的年份不误报。 */
function extractBaiduDate(el) {
  const walk = (node, out = []) => {
    for (const n of node?.childNodes || []) {
      if (n.nodeType === 3) {
        const t = String(n.textContent || "").trim();
        if (t && t.length < 40) {
          const d = extractSerpDate(t);
          if (d) out.push(d);
        }
      } else if (n.nodeType === 1 && !/^(script|style)$/i.test(n.tagName || "")) walk(n, out);
    }
    return out;
  };
  return walk(el)[0] || "";
}

/**
 * 百度搜索(移动端 UA)。工厂直连:请求 → parseBaiduHtml → blocked 包装。
 * @returns {Promise<{engine:"baidu", mode:"mobile", blocked:boolean, reason?:string, results:Array}>}
 */
export const searchBaidu = createDirectEngine({
  name: "baidu",
  mode: "mobile",
  buildUrl: (query, limit) => `${BAIDU_URL}?wd=${encodeURIComponent(query)}&rn=${limit}`,
  parse: (html, limit) => parseSerp(html, { engineKey: "baidu", specific: parseBaiduHtml, limit, excludeHosts: ["www.baidu.com", "m.baidu.com"] }),
  headers: { "User-Agent": UA_MOBILE },
});
