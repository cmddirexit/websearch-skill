/**
 * update-fixtures.mjs — 抓取真实搜索页 HTML 存为 gzip 快照
 *
 * 用途:真实站点改版时,解析器测试(手写样例)可能全部通过但实际解析失败。
 * 此脚本抓取真实页面存为 fixtures/*.html.gz,测试对真实结构做回归断言。
 *
 * 运行: npm run fixtures   (站点改版 / 解析测试挂掉时重跑)
 * 产物: scripts/lib/fixtures/{bing-search,baidu-search,marginalia-search}.html.gz
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { httpGet } from "./lib/http.mjs";
import { UA_MOBILE } from "./lib/config.mjs";
import { parseBingHtml } from "./lib/engines/bing.mjs";
import { parseBaiduHtml } from "./lib/engines/baidu.mjs";
import { parseSogouHtml } from "./lib/engines/sogou.mjs";
import { parseSo360Html } from "./lib/engines/so360.mjs";
import { parseSmHtml } from "./lib/engines/sm.mjs";
import { parseToutiaoHtml } from "./lib/engines/toutiao.mjs";
import { parseGithubTrending } from "./lib/engines/trending.mjs";
import { parseMarginaliaHtml } from "./lib/engines/marginalia.mjs";
import { parseChinasoHtml } from "./lib/engines/chinaso.mjs";
import { getDom } from "./lib/engines/browser.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(DIR, "lib", "fixtures");

const targets = [
  {
    name: "bing-search",
    url: "https://cn.bing.com/search?q=%E5%8C%97%E4%BA%AC%E5%A4%A9%E6%B0%94&count=8",
    // 校验:解析命中 ≥1 条才允许存快照(防止风控页/错误页污染回归基线)
    verify: (html) => !parseBingHtml(html, 8).blocked && parseBingHtml(html, 8).results.length >= 1,
  },
  {
    name: "baidu-search",
    url: "https://www.baidu.com/s?wd=%E5%8C%97%E4%BA%AC%E5%A4%A9%E6%B0%94&rn=8",
    mobile: true,
    verify: (html) => {
      const r = parseBaiduHtml(html, 8);
      return !r.blocked && r.results.length >= 1;
    },
  },
  {
    name: "sogou-search",
    url: "https://www.sogou.com/web?query=%E5%8C%97%E4%BA%AC%E5%A4%A9%E6%B0%94&num=8",
    verify: (html) => !parseSogouHtml(html, 8).blocked && parseSogouHtml(html, 8).results.length >= 1,
  },
  {
    name: "so360-search",
    url: "https://www.so.com/s?q=%E5%8C%97%E4%BA%AC%E5%A4%A9%E6%B0%94",
    verify: (html) => !parseSo360Html(html, 8).blocked && parseSo360Html(html, 8).results.length >= 1,
  },
  {
    name: "sm-search",
    url: "https://m.sm.cn/s?q=%E5%8C%97%E4%BA%AC%E5%A4%A9%E6%B0%94",
    mobile: true,
    verify: (html) => !parseSmHtml(html, 8).blocked && parseSmHtml(html, 8).results.length >= 1,
  },
  {
    name: "toutiao-search",
    url: "https://so.toutiao.com/search?keyword=%E5%8C%97%E4%BA%AC%E5%A4%A9%E6%B0%94",
    verify: (html) => !parseToutiaoHtml(html, 8).blocked && parseToutiaoHtml(html, 8).results.length >= 1,
  },
  {
    name: "trending-daily",
    url: "https://github.com/trending",
    verify: (html) => parseGithubTrending(html, 8).length >= 1,
  },
  {
    name: "marginalia-search",
    url: "https://search.marginalia.nu/search?query=web+scraping&profile=default",
    verify: (html) => parseMarginaliaHtml(html, 8).length >= 1,
  },
  {
    name: "sogou-wechat-search",
    url: "https://weixin.sogou.com/weixin?query=%E5%A4%A7%E6%A8%A1%E5%9E%8B&type=2",
    verify: (html) => !parseSogouWechatHtml(html, 8).blocked && parseSogouWechatHtml(html, 8).results.length >= 1,
  },
  {
    name: "chinaso-search",
    url: "https://www.chinaso.com/search/pagesearch.htm?q=%E5%8C%97%E4%BA%AC%E5%A4%A9%E6%B0%94",
    browser: true, // SPA 无 SSR,需浏览器渲染(直连 httpGet 只有空壳)
    verify: (html) => !parseChinasoHtml(html, 8).blocked && parseChinasoHtml(html, 8).results.length >= 1,
  },
  // 聚类回归快照(多义查询含中英混合标题,回归 cluster.mjs 的相关性打分/差异标注)
  {
    name: "bing-apple",
    url: "https://cn.bing.com/search?q=%E8%8B%B9%E6%9E%9C&setlang=zh-CN&ensearch=0&count=15",
    verify: (html) => !parseBingHtml(html, 15).blocked && parseBingHtml(html, 15).results.length >= 1,
  },
  {
    name: "bing-iphone",
    url: "https://cn.bing.com/search?q=iPhone+17+%E5%8F%91%E5%B8%83+%E4%BB%B7%E6%A0%BC&setlang=zh-CN&ensearch=0&count=15",
    verify: (html) => !parseBingHtml(html, 15).blocked && parseBingHtml(html, 15).results.length >= 1,
  },
  {
    name: "bing-tesla",
    url: "https://cn.bing.com/search?q=%E7%89%B9%E6%96%AF%E6%8B%89&setlang=zh-CN&ensearch=0&count=15",
    verify: (html) => !parseBingHtml(html, 15).blocked && parseBingHtml(html, 15).results.length >= 1,
  },
];

mkdirSync(FIXTURES, { recursive: true });

for (const t of targets) {
  const opts = t.mobile ? { headers: { "User-Agent": UA_MOBILE } } : {};
  try {
    const html = t.browser ? await getDom(t.url, 6000) : await httpGet(t.url, { ...opts, timeoutMs: 20_000 });
    if (!html || !t.verify(html)) {
      console.error(`❌ ${t.name}: 快照校验失败(页面无结构化结果,可能是风控/错误页),已跳过不覆盖`);
      continue;
    }
    const gz = gzipSync(Buffer.from(html, "utf8"));
    const file = join(FIXTURES, `${t.name}.html.gz`);
    writeFileSync(file, gz);
    console.log(`✅ ${t.name}.html.gz  ${html.length} 字符 → ${(gz.length / 1024).toFixed(0)}KB`);
  } catch (e) {
    console.error(`❌ ${t.name}: ${e.message.slice(0, 80)}`);
  }
}
