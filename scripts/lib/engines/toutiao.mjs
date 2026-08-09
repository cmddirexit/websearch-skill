/**
 * engines/toutiao.mjs — 头条搜索(SSR 数据解析)
 *
 * 反爬研究结论(实测):
 *  - 桌面 UA 直连 https://so.toutiao.com/search?keyword= → 200,~1.8MB SSR 大页面
 *  - 结果数据嵌在多个 <script data-for="ala-data"> 的 T.flow({data:{...}}) 里,
 *    字段为 JSON(HTML 实体 + \u 转义),无独立 API
 *  - 每条结果有唯一 gid(/group/<gid>/),ttsearch_msite_url 为真实站内 URL
 *  - 摘要:summary_text 纯文本;abstract 是富文本偏移索引(不可用)
 *  - 标题字段可能带 <em> 高亮(\u003cem\u003e 转义)
 *
 * 解析策略:
 *  - 以 "ttsearch_msite_url" 为结果锚点(每结果唯一)
 *  - 标题:锚点前后 ±5000 窗口内最近的 title/title_txt/abstract_title/show_title
 *  - 摘要:同窗口内 summary_text(纯文本)
 *  - 时间:publish_time/display_time(unix 秒 → YYYY-MM-DD)
 *  - 去重:同 gid 只取一次
 */

import { clean, tsToDate, extractSerpDate } from "../html.mjs";
import { UA } from "../config.mjs";
import { createDirectEngine } from "./factory.mjs";
import { parseSerp } from "../parse-serp.mjs";

const TOUTIAO_URL = "https://so.toutiao.com/search";
const BLOCKED_MIN_LEN = 50_000; // 正常 SSR 页 ~1.8MB,风控/错误页远小于此
const WINDOW = 5_000; // 标题/摘要搜索窗口(±锚点)

/** JSON 字符串字段解码("\u003cem\u003e" 等) */
function jsonField(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}

/**
 * 解析头条搜索 SSR 页 HTML(直连/fixture 测试共用)。
 * @returns {{blocked:boolean, reason?:string, results:Array<{title,url,desc,date?}>}}
 */
export function parseToutiaoHtml(html, limit) {
  if (html.length < BLOCKED_MIN_LEN || /安全验证|请输入验证码|验证码|captcha/i.test(html.slice(0, 3000))) {
    return { blocked: true, reason: "头条触发安全验证(反爬风控),尝试 baidu", results: [] };
  }
  const results = [];
  const seen = new Set();
  let domEntryCount = 0; // 页面实际结果容器数(供 parseSerp 判据 A 用,防冷门查询误报)
  const urlRe = /"ttsearch_msite_url":"(https:\/\/[^"]+)"/g;
  let m;
  while ((m = urlRe.exec(html)) !== null && results.length < limit) {
    domEntryCount++;
    const rawUrl = m[1];
    const gidM = rawUrl.match(/\/group\/(\d+)\//);
    const gid = gidM ? gidM[1] : rawUrl;
    if (seen.has(gid)) continue;
    seen.add(gid);
    // 窗口:锚点前后 ±WINDOW
    const start = Math.max(0, m.index - WINDOW);
    const win = html.slice(start, Math.min(html.length, m.index + WINDOW));
    // 标题:最近的候选字段
    let title = "";
    let best = Infinity;
    const titleRe = /"(?:title|title_txt|abstract_title|show_title)":"((?:[^"\\]|\\.)*)"/g;
    let tm;
    while ((tm = titleRe.exec(win)) !== null) {
      const t = clean(jsonField(tm[1]));
      if (t && t.length > 2) {
        const dist = Math.abs(start + tm.index - m.index);
        if (dist < best) {
          best = dist;
          title = t;
        }
      }
    }
    if (!title) continue;
    // 摘要:summary_text(纯文本)
    const sm = win.match(/"summary_text":"((?:[^"\\]|\\.)*)"/);
    const desc = sm ? clean(jsonField(sm[1])).slice(0, 400) : "";
    // 时间:publish_time/display_time(Unix 秒)→ 日期;缺失时标题/摘要全文兜底
    // (完整年月日格式严格,散文年份不会误报)
    const pt = win.match(/"(?:publish_time|display_time)":"(\d{10})"/);
    const date = pt ? tsToDate(pt[1]) : extractSerpDate(title + " " + desc);
    // URL:清理跟踪参数,保留 /group/<gid>/
    const url = rawUrl.replace(/[?&](channel|in_ogs|in_tfs|original_source|source|traffic_source|upstream_biz|utm_[a-z_]+)=[^&]*/g, "").replace(/&{2,}/g, "&").replace(/\?&/, "?").replace(/[?&]$/, "");
    results.push({ title, url, desc, ...(date ? { date } : {}) });
  }
  if (results.length === 0) {
    // 区分“软风控/空结果”与“真改版”:页面仍含结果容器(ala-data)但字段 0 命中
    // → 头条对异常请求返回正常大小但结果区为空的 SSR 页(实测:软风控,1.76MB 页
    //   过 BLOCKED_MIN_LEN 检查但无结果数据),不是改版 —— 提示语避免误导 agent 去跑 fixtures;
    // 连结果容器都没有 → 才是结构变更(改版/验证页/错误页)。
    const hasContainer = html.includes("ala-data") || html.includes("__NEXT_DATA__") || html.includes("data-for");
    if (hasContainer) {
      return {
        blocked: true,
        reason: "头条返回空结果页(软风控或该查询无结果),非结构变更 —— 稍后重试或换引擎",
        results,
        domEntryCount,
      };
    }
    return {
      blocked: true,
      reason: "头条页面解析命中 0 条:SSR 结构可能已变更,请运行 npm run fixtures 更新快照",
      results,
      domEntryCount,
    };
  }
  return { blocked: false, results, domEntryCount };
}

/**
 * 头条搜索(桌面 UA)。
 * 解析器经 parseSerp 包装:特异性(SSR 字段)→ 层③ JSON 结构化提取(urlShape=group URL)
 * → 全失败 blocked。站点改版时字段名变 → 特异性 0 命中 → 自动降级层③,结果不中断。
 * @returns {Promise<{engine:"toutiao", mode:"ssr", blocked:boolean, reason?:string, results:Array, parsedBy?:string}>}
 */
export const searchToutiao = createDirectEngine({
  name: "toutiao",
  mode: "ssr",
  buildUrl: (query) => `${TOUTIAO_URL}?keyword=${encodeURIComponent(query)}`,
  parse: (html, limit) =>
    parseSerp(html, {
      engineKey: "toutiao",
      specific: parseToutiaoHtml,
      urlShape: /\/group\/\d+\//, // 内容 URL 形态(比字段名稳定;层③ JSON 结构化提取用)
      limit,
      excludeHosts: ["so.toutiao.com"],
    }),
  headers: { "User-Agent": UA },
});
