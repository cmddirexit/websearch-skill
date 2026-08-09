/**
 * engines/sogou-wechat.mjs — 搜狗微信搜索(微信公众号文章)
 *
 * 接入方案(2026-08,GitHub 调研 SearXNG sogou_wechat.py 获得):
 *  - 直连 https://weixin.sogou.com/weixin?query=&type=2 实测成功(33KB,40 条)
 *  - 结果块:li[id^="sogou_vr_"];标题 h3 a;链接 /link?url= 加密跳转(需拼域名);
 *    摘要 p.txt-info;公众号名 span.all-time-y2;时间 script timeConvert('unix秒')
 *  - 标题/摘要含 <em><!--red_beg-->高亮<!--red_end--></em>,clean 会清理
 *  - 反爬:与 sogou 主站同系,短时多次请求可能触发 antispider 验证码
 *
 * 解析(HTML,DOM 选择器):
 *  - 结构定位用 CSS 选择器,文本提取用 elementText(与全部引擎一致的 B 路线架构)
 */

import { clean, decodeEntities, tsToDate } from "../html.mjs";
import { UA } from "../config.mjs";
import { createDirectEngine } from "./factory.mjs";
import { parseSerp } from "../parse-serp.mjs";
import { parseDomOr, elementText, queryOne, queryAll } from "../dom.mjs";

const SOGOU_WX_URL = "https://weixin.sogou.com/weixin";
const SOGOU_WX_ORIGIN = "https://weixin.sogou.com";
const BLOCKED_MIN_LEN = 4_000; // 验证码/风控页远小于正常结果页(~33KB)

/**
 * 解析搜狗微信搜索页 HTML(直连/fixture 测试共用)。
 * 解析命中 0 条 → blocked:true + reason 提示结构可能变更。
 * @returns {{blocked:boolean, reason?:string, results:Array<{title,url,desc,account?,date?}>}}
 */
export function parseSogouWechatHtml(html, limit) {
  // 风控检测(验证码页远小于正常结果页)
  if (html.length < BLOCKED_MIN_LEN || /antispider|请输入验证码|验证码|captcha|verify\.css/i.test(html.slice(0, 2000))) {
    return { blocked: true, reason: "搜狗微信触发验证码(反爬风控,短时多次搜索易触发),尝试 baidu", results: [] };
  }
  const doc = parseDomOr(html);
  const results = [];
  for (const li of queryAll(doc, "li[id^='sogou_vr_']")) {
    if (results.length >= limit) break;
    const a = queryOne(li, "h3 a[href]");
    if (!a) continue;
    const title = clean(elementText(a));
    if (!title) continue;
    let link = decodeEntities(a.getAttribute("href") || "");
    // /link?url= 加密跳转 → 拼完整域名(可打开)
    if (link.startsWith("/link?url=")) link = SOGOU_WX_ORIGIN + link;
    if (!link.startsWith("http")) continue;
    // 摘要:txt-info p
    const sm = queryOne(li, "p.txt-info");
    const desc = sm ? clean(elementText(sm)).slice(0, 400) : "";
    // 公众号名:all-time-y2 span
    const acc = queryOne(li, "span.all-time-y2");
    const account = acc ? clean(elementText(acc)) : "";
    // 时间:script timeConvert('1774784784')(unix 秒;linkedom elementText 不含 script 内容,需取 script 节点文本)
    let date = "";
    const scr = queryOne(li, "script");
    if (scr) {
      const tm = (scr.textContent || scr.innerHTML || "").match(/timeConvert\('(\d+)'\)/);
      if (tm) date = tsToDate(tm[1]);
    }
    results.push({
      title,
      url: link,
      desc,
      ...(account ? { account } : {}),
      ...(date ? { date } : {}),
    });
  }
  if (results.length === 0) {
    return {
      blocked: true,
      reason: "搜狗微信页面解析命中 0 条:页面结构可能已变更,请运行 npm run fixtures 更新快照",
      results,
    };
  }
  return { blocked: false, results };
}

/**
 * 搜狗微信搜索(桌面 UA 直连)。
 * @returns {Promise<{engine:"sogou-wechat", mode:"web", blocked:boolean, reason?:string, results:Array}>}
 */
export const searchSogouWechat = createDirectEngine({
  name: "sogou-wechat",
  mode: "web",
  buildUrl: (query, limit) => `${SOGOU_WX_URL}?query=${encodeURIComponent(query)}&type=2`,
  parse: (html, limit) => parseSerp(html, { engineKey: "sogou-wechat", specific: parseSogouWechatHtml, limit }),
  headers: { "User-Agent": UA },
});
