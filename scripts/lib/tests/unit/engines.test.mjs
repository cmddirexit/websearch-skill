// 引擎解析器纯函数测试(bing/baidu/marginalia/chinaso/sogou/so360/sm/toutiao/trending/cnnews/hotlist/sogou-wechat)
// 含 fixtures/ 真实快照回归(loadFixture)与搜狗冷却状态
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFixture, assertResultShape } from "./helpers.mjs";
import { decodeBingUrl, isLangPolluted, parseBingHtml, dedupeZhResults, domainStem } from "../../engines/bing.mjs";
import { extractMu, extractBlockTitle, extractDesc, isBaiduInternal, filterDesc, parseBaiduHtml } from "../../engines/baidu.mjs";
import { parseMarginaliaResult, extractMarginaliaDesc, parseMarginaliaHtml } from "../../engines/marginalia.mjs";
import { parseChinasoHtml } from "../../engines/chinaso.mjs";
import { parseSogouHtml, isInCooldown, setCooldown } from "../../engines/sogou.mjs";
import { parseSo360Html, isSo360Internal } from "../../engines/so360.mjs";
import { parseSmHtml } from "../../engines/sm.mjs";
import { parseToutiaoHtml } from "../../engines/toutiao.mjs";
import { parseGithubTrending } from "../../engines/trending.mjs";
import { parseSogouWechatHtml } from "../../engines/sogou-wechat.mjs";
import { extractNewsLinks, isArticleUrl } from "../../engines/cnnews.mjs";
import { parseDateFromUrl, normalizeCnDate, longestCommonSubstring } from "../../html.mjs";
import { parseWeiboHotlist, parseWeiboOfficialHtml, parseBaiduHotlist, parseToutiaoHotlist, parseDouyinHotlist } from "../../engines/hotlist.mjs";


test("decodeBingUrl: /ck/a 跳转 base64url 解码", () => {
  // u=a1 + base64url("https://example.com/x?y=1")
  const target = "https://example.com/x?y=1";
  const b64 = "a1" + Buffer.from(target, "utf8").toString("base64url");
  const url = `https://cn.bing.com/ck/a?u=${b64}&p=1`;
  assert.equal(decodeBingUrl(url), target);
});


test("decodeBingUrl: 普通链接清理 UTM", () => {
  const url = "https://a.com/p?utm_source=x&utm_medium=y&id=3";
  assert.equal(decodeBingUrl(url), "https://a.com/p?id=3");
});


test("decodeBingUrl: bing 内部页丢弃", () => {
  assert.equal(decodeBingUrl("https://cn.bing.com/search?q=1"), "");
  assert.equal(decodeBingUrl("https://cn.bing.com/newtabredir?url=https%3A%2F%2Fa.com"), "");
  assert.equal(decodeBingUrl(""), "");
});


test("isLangPolluted: 英文查询+中文结果判定污染", () => {
  assert.equal(isLangPolluted("web scraping", [{ title: "什么是Web - 知乎" }, { title: "Scrapy 教程" }, { title: "Web Scraping Guide" }]), true);
  assert.equal(isLangPolluted("web scraping", [{ title: "Web Scraping Guide" }, { title: "Scrapy Docs" }]), false);
  assert.equal(isLangPolluted("北京天气", [{ title: "中国天气网" }]), false); // 中文查询不检测
  assert.equal(isLangPolluted("web scraping", []), false);
});

// ---------- fetch-page.mjs ----------

test("baidu: c-result 与 content_left 都失效时,h3>a 备选可解析", () => {
  // 填充到超过风控长度阈值(5000),否则短页面会被判风控
  const pad = "<p>" + "填充内容".repeat(1300) + "</p>"; // 5200+ 字符,超过风控长度阈值
  const html = `<html><head><title>t</title></head><body>${pad}<div id="results">
    <h3 class="t"><a href="https://news.example/a">新闻标题A</a></h3>
    <h3><a href="https://news.example/b">新闻标题B</a></h3>
  </div></body></html>`;
  const { blocked, results } = parseBaiduHtml(html, 5);
  assert.equal(blocked, false);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, "新闻标题A");
});

// ---------- 真实站点快照回归(fixtures/) ----------
// 快照由 npm run fixtures 抓取(真实搜索页 HTML,gzip)。
// 若此类测试失败 = 站点改版,解析器对真实结构失效,运行 npm run fixtures 更新快照后复查。



test("真实快照: bing 搜索结果页可解析", () => {
  const { blocked, results } = parseBingHtml(loadFixture("bing-search"), 8);
  assert.equal(blocked, false, "真实 bing 页不应被判反爬");
  assertResultShape(results);
});


test("真实快照: baidu 搜索页可解析", () => {
  const { blocked, results } = parseBaiduHtml(loadFixture("baidu-search"), 8);
  assert.equal(blocked, false, "真实 baidu 页不应被判风控");
  assertResultShape(results);
});


test("搜狗冷却: 触发验证码后进入冷却期,期内快速失败", () => {
  setCooldown(60_000); // 伪造冷却
  assert.ok(isInCooldown(), "冷却期内 isInCooldown 应为 true");
  setCooldown(-1); // 清除冷却
  assert.equal(isInCooldown(), false, "冷却过期后应为 false");
});


test("真实快照: sogou 搜索页可解析", () => {
  const { blocked, results } = parseSogouHtml(loadFixture("sogou-search"), 8);
  assert.equal(blocked, false, "真实 sogou 页不应被判风控");
  assertResultShape(results);
});


test("真实快照: so360 搜索页可解析", () => {
  const { blocked, results } = parseSo360Html(loadFixture("so360-search"), 8);
  assert.equal(blocked, false, "真实 360 页不应被判风控");
  assertResultShape(results);
});


test("so360: AI精选内部搜索 URL(ai.so.com/search)剔除", () => {
  // 手写 SERP:① AI 精选块 href 直接是 ai.so.com 搜索 URL(非真实结果)② 正常结果(加密跳转+data-mdurl)
  const html = (
    `<li class=\"res-list\"><h3 class=\"res-title \"><a href=\"https://ai.so.com/search?search=Arc%E8%99%9A%E6%8B%9F%E7%BB%86%E8%83%9E&src=so_result_natural\">AI精选虚拟细胞</a></h3><p class=\"res-desc\">AI回答摘要</p></li>` +
    `<li class=\"res-list\"><h3 class=\"res-title \"><a href=\"https://www.so.com/link?m=abc123\" data-mdurl=\"https://real-site.com/article/1\">正常结果标题</a></h3><p class=\"res-desc\"><span class=\"res-list-summary\">这是一篇正常文章的完整摘要内容,长度足够。</span></p></li>`
  ).padEnd(8500, " "); // 超 BLOCKED_MIN_LEN 避免误判风控
  const { blocked, results } = parseSo360Html(html, 8);
  assert.equal(blocked, false);
  assert.equal(results.length, 1, "AI精选搜索 URL 应被剔除,仅留正常结果");
  assert.equal(results[0].url, "https://real-site.com/article/1");
  assert.equal(results[0].title, "正常结果标题");
  assert.ok(isSo360Internal("https://ai.so.com/search?search=x"), "ai.so.com 应识别为 360 内部域名");
});


test("真实快照: sm 神马搜索页可解析", () => {
  const { blocked, results } = parseSmHtml(loadFixture("sm-search"), 8);
  assert.equal(blocked, false, "真实神马页不应被判风控");
  assertResultShape(results);
});


test("真实快照: toutiao 头条搜索页可解析", () => {
  const { blocked, results } = parseToutiaoHtml(loadFixture("toutiao-search"), 8);
  assert.equal(blocked, false, "真实头条页不应被判风控");
  assertResultShape(results);
});


test("toutiao: 软风控空结果页 → 提示非结构变更(不误导跑 fixtures)", () => {
  // 正常大小 SSR 页(>50KB 过风控长度检查)、含结果容器 ala-data、但无结果字段 → 软风控
  const padded = "x".repeat(55_000);
  const softBlocked = parseToutiaoHtml(`<!DOCTYPE html><html><script data-for="ala-data">{"data":{}}</script>${padded}`, 8);
  assert.equal(softBlocked.blocked, true);
  assert.ok(softBlocked.reason.includes("非结构变更"), "应提示软风控而非结构变更: " + softBlocked.reason);
  assert.ok(!softBlocked.reason.includes("fixtures"), "不应让 agent 去跑 fixtures");
});


test("toutiao: 真结构变更页(无容器) → 才提示更新快照", () => {
  const padded = "x".repeat(55_000);
  const realChange = parseToutiaoHtml(`<!DOCTYPE html><html><body>${padded}</body></html>`, 8);
  assert.equal(realChange.blocked, true);
  assert.ok(realChange.reason.includes("结构可能已变更"), "无容器页才是真改版: " + realChange.reason);
  assert.ok(realChange.reason.includes("fixtures"));
});


test("真实快照: github trending 页面可解析", () => {
  const items = parseGithubTrending(loadFixture("trending-daily"), 8);
  assert.ok(items.length >= 1, "Trending 页应解析出仓库");
  const first = items[0];
  assert.match(first.name, /^[^/]+\/[^/]+$/, "仓库名应为 owner/repo 形态");
  assert.ok(first.url.startsWith("https://github.com/"), "URL 应为 github.com 链接");
  assert.ok(first.starsDelta || first.lang, "应含 star 增量或语言信息");
});


test("trending: 手写样例解析(名称/描述/star 增量/语言)", () => {
  const html = `<article class="Box-row"><h2 class="h3 lh-condensed"><a href="/foo/bar">bar</a></h2><p class="col-9 color-fg-muted my-1 pr-4">A demo repo</p><span class="d-inline-block float-sm-right"><svg></svg>1,234 stars today</span><span itemprop="programmingLanguage">Python</span></article>`;
  const items = parseGithubTrending(html, 5);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, "foo/bar");
  assert.equal(items[0].desc, "A demo repo");
  assert.equal(items[0].starsDelta, "1,234");
  assert.equal(items[0].lang, "Python");
  assert.equal(items[0].url, "https://github.com/foo/bar");
});


test("trending: weekly 页 this week 增量也能解析", () => {
  const html = `<article class="Box-row"><h2 class="h3 lh-condensed"><a href="/a/b">b</a></h2><span class="d-inline-block float-sm-right"><svg></svg>42 stars this week</span></article>`;
  const items = parseGithubTrending(html, 5);
  assert.equal(items[0].starsDelta, "42");
});


test("trending: 过滤非仓库链接(语言筛选/导航)", () => {
  const html = `<article class="Box-row"><h2 class="h3 lh-condensed"><a href="/trending/python">python</a></h2></article><article class="Box-row"><h2 class="h3 lh-condensed"><a href="/owner/repo">repo</a></h2></article>`;
  const items = parseGithubTrending(html, 5);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, "owner/repo");
});


test("真实快照: marginalia 搜索页可解析", () => {
  const results = parseMarginaliaHtml(loadFixture("marginalia-search"), 8);
  assertResultShape(results);
});

// ---------- engines/marginalia.mjs ----------

test("marginalia: 主/老界面结构都失效时,通用 h2>a 备选可解析", () => {
  const html = `<html><body><main>
    <h2><a href="https://site1.example">Site One</a></h2>
    <h2><a href="https://site2.example">Site Two</a></h2>
  </main></body></html>`;
  const results = parseMarginaliaHtml(html, 5);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, "Site One");
});


test("marginalia: 解析 h2 块提取标题与 URL(&shy; 已清除)", () => {
  const block = `<h2 class="text-md sm:text-xl"><a href="https://blog.kulman.sk/web-scraping-with-swift/" rel="noopener noreferrer">Web scraping with Swift -&shy; Igor Kulman</a></h2>`;
  const r = parseMarginaliaResult(block);
  assert.equal(r.title, "Web scraping with Swift - Igor Kulman");
  assert.equal(r.url, "https://blog.kulman.sk/web-scraping-with-swift/");
  assert.equal(parseMarginaliaResult("<div>no h2</div>"), null);
});


test("marginalia: 提取摘要(p.mt-2)", () => {
  const following = `<div class="overflow-auto flex-1"><p class="mt-2 text-sm text-black leading-relaxed">I now spend most of my time in macOS</p></div>`;
  assert.equal(extractMarginaliaDesc(following), "I now spend most of my time in macOS");
  assert.equal(extractMarginaliaDesc("<div></div>"), "");
});

// ---------- engines/chinaso.mjs ----------

test("真实快照: chinaso 搜索页可解析(SPA 渲染后 HTML)", () => {
  const { blocked, results } = parseChinasoHtml(loadFixture("chinaso-search"), 8);
  assert.ok(!blocked, "渲染快照不应被风控判定");
  assertResultShape(results);
  assert.ok(results.length >= 1, "应解析出至少 1 条结果");
  assert.ok(results[0].url.startsWith("https://"), "链接应为可打开的跳转 URL");
});


test("chinaso: 手写样例解析标题/摘要/来源/时间(<em> 高亮清理)", () => {
  const html = (`<div class="search-list">
    <div class="list">
      <a class="common-title" href="https://www.chinaso.com/link?url=abc&amp;pos=0"><em>北京</em>今天仍有雷雨<em>天气</em></a>
      <p class="common-summary">今晨,<em>北京</em>天空云较多。</p>
      <div class="source"><span class="source-name">中国天气网</span><span class="source-time">2天前</span></div>
    </div>
    <div class="list">
      <a class="common-title" href="https://www.chinaso.com/link?url=def">第二条新闻</a>
    </div>
  </div>`).padEnd(8500, " "); // 超 BLOCKED_MIN_LEN 避免误判风控
  const { blocked, results } = parseChinasoHtml(html, 5);
  assert.ok(!blocked);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, "北京今天仍有雷雨天气");
  assert.equal(results[0].source, "中国天气网");
  assert.equal(results[0].date, "2天前");
  assert.ok(results[0].desc.includes("天空云较多"));
  assert.equal(results[1].source, undefined, "无来源时不填 source 字段");
});


test("chinaso: SPA 空壳(无搜索结果)返回 blocked", () => {
  const { blocked } = parseChinasoHtml("<div id=\"app\"></div>" + " ".repeat(100), 5);
  assert.equal(blocked, true);
});


test("真实快照: sogou-wechat 微信搜索页可解析", () => {
  const { blocked, results } = parseSogouWechatHtml(loadFixture("sogou-wechat-search"), 8);
  assert.ok(!blocked, "快照不应被风控判定");
  assertResultShape(results);
  assert.ok(results.length >= 1, "应解析出至少 1 条结果");
  assert.ok(results[0].url.startsWith("https://weixin.sogou.com/link?url="), "链接应为可打开的跳转 URL");
});


test("sogou-wechat: 手写样例解析标题/摘要/公众号/时间", () => {
  const html = (`<ul class="news-list">
    <li id="sogou_vr_11002601_box_0">
      <div class="txt-box">
        <h3><a target="_blank" href="/link?url=abc&amp;type=2"><em><!--red_beg-->大模型<!--red_end--></em>该去二级市场要钱了</a></h3>
        <p class="txt-info" id="sogou_vr_11002601_summary_0"><em><!--red_beg-->大模型<!--red_end--></em>公司正在走向验证商业价值</p>
        <div class="s-p"><span class="all-time-y2">虎嗅APP</span><span class="s2"><script>document.write(timeConvert('1774784784'))</script></span></div>
      </div>
    </li>
  </ul>`).padEnd(8500, " "); // 超 BLOCKED_MIN_LEN 避免误判风控
  const { blocked, results } = parseSogouWechatHtml(html, 5);
  assert.ok(!blocked);
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "大模型该去二级市场要钱了");
  assert.equal(results[0].account, "虎嗅APP");
  assert.equal(results[0].date, "2026-03-29");
  assert.ok(results[0].desc.includes("验证商业价值"));
  assert.equal(results[0].url, "https://weixin.sogou.com/link?url=abc&type=2");
});

// ---------- engines/baidu.mjs ----------

test("baidu: extractMu 从 data-log 提取真实 URL", () => {
  const dl = '{"fm":"alhm","mu":"https://m.weather.com.cn/x.shtml#!/xh","order":2}';
  assert.equal(extractMu(dl), "https://m.weather.com.cn/x.shtml#!/xh");
  assert.equal(extractMu('{"fm":"alhm"}'), "");
});


test("baidu: extractBlockTitle 从 cosc-title-slot 提取标题并清理高亮", () => {
  const block = `<span class="cosc-title-slot"><span class="tts-b-hl"><!--s-text-->【<em>北京天气</em>预报15天】<!--/s-text--></span></span>`;
  assert.equal(extractBlockTitle(block), "【北京天气预报15天】");
  assert.equal(extractBlockTitle("<div>no title</div>"), "");
});


test("baidu: extractDesc 从 pure-summary JSON 提取摘要", () => {
  const block = `<div data-module="pure-summary"><!--s-data:{"summaryData":{"generalLines":[{"data":[{"text":"北京天气预报<em>北京</em>"}]}]}}--></div>`;
  assert.equal(extractDesc(block), "北京天气预报北京");
});


test("baidu: isBaiduInternal 过滤百度内部域名", () => {
  assert.equal(isBaiduInternal("https://www.baidu.com/weather/1"), true);
  assert.equal(isBaiduInternal("http://34689.recommend_list.baidu.com"), true);
  assert.equal(isBaiduInternal("https://baike.baidu.com/item/x"), true);
  assert.equal(isBaiduInternal("https://m.weather.com.cn/x"), false);
  assert.equal(isBaiduInternal("https://example.com/x"), false);
});


test("baidu: filterDesc 过滤仅域名/站点标识的伪摘要", () => {
  assert.equal(filterDesc("www.anandtech.com", "https://www.anandtech.com/show/x"), "");
  assert.equal(filterDesc("B站精选", "https://www.bilibili.com/video/x"), "");
  assert.equal(filterDesc("北京天气预报,及时准确发布中央气象台天气信息", "https://m.weather.com.cn/x"), "北京天气预报,及时准确发布中央气象台天气信息");
  assert.equal(filterDesc("", "https://a.com/x"), "");
});

// ---------- 缺陷修复回归(D1/D2/D3) ----------

test("cnnews: parseDateFromUrl 支持人民网/12371/政府网 URL 模式", () => {
  
  assert.equal(parseDateFromUrl("http://politics.people.com.cn/n1/2026/0801/c1024-40771951.html"), "2026-08-01");
  assert.equal(parseDateFromUrl("https://www.12371.cn/2026/07/31/ARTI1785471041489696.shtml"), "2026-07-31");
  assert.equal(parseDateFromUrl("https://www.gov.cn/2026-07/30/content_5999999.htm"), "2026-07-30");
  assert.equal(parseDateFromUrl("https://example.com/no-date"), "");
  assert.equal(normalizeCnDate("2026年8月1日"), "2026-08-01");
  assert.equal(normalizeCnDate("2026-8-1"), "2026-08-01");
  assert.equal(normalizeCnDate("没有日期"), "");
});


test("cnnews: extractNewsLinks 解析人民网列表页(相对链接按源补全)", () => {
  
  const html = `<html><body>
    <a href="/n1/2026/0801/c1024-40771951.html">习近平向全体人民解放军指战员致以节日的祝贺</a>
    <a href="https://www.12371.cn/2026/07/31/ARTI1785471041489696.shtml">中央政治局集体学习</a>
    <a href="/GB/67481/444924/index.html">跟着总书记学党史数据库</a>
    <a href="/">首页</a>
    <a href="javascript:void(0)">登录</a>
  </body></html>`;
  const items = extractNewsLinks(html, "人民网·党建", "http://cpc.people.com.cn/");
  assert.ok(items.length >= 2, `应解析出文章链接,实际 ${items.length}`);
  assert.ok(items.some((x) => x.url === "http://cpc.people.com.cn/n1/2026/0801/c1024-40771951.html"), "相对链接按源 URL 补全");
  assert.equal(items.find((x) => x.title.includes("中央政治局"))?.date, "2026-07-31");
  assert.ok(isArticleUrl("http://politics.people.com.cn/n1/2026/0801/c1024-40771951.html"));
  assert.ok(!isArticleUrl("http://cpc.people.com.cn/GB/67481/444924/index.html"));
});

// ==================== hotlist(平台热搜榜) ====================


test("hotlist: parseWeiboHotlist 解析 tophub 镜像(排名/标题/热度)", () => {
  
  const html = `<table><tbody>
    <tr><td align="center">1.</td><td><a href="https://s.weibo.com/weibo?q=a" target="_blank">强军制胜不负荣光</a></td><td class="ws">115万</td></tr>
    <tr><td align="center">2.</td><td><a href="https://s.weibo.com/weibo?q=b" target="_blank">女子住酒店退房</a></td><td class="ws">112万</td></tr>
  </tbody></table>`;
  const items = parseWeiboHotlist(html, 5);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { rank: 1, title: "强军制胜不负荣光", heat: "115万", url: "https://s.weibo.com/weibo?q=a" });
  assert.equal(items[1].heat, "112万");
});


test("hotlist: parseWeiboOfficialHtml 解析官方页(含无标记行/广告行/热度数字)", () => {
  
  const html = `<html><body><table><tbody>
    <tr class=""><td class="td-01"><i class="icon-top"></i></td>
      <td class="td-02"><a href="/weibo?q=%E7%83%AD%E6%90%9C1" target="_blank">统帅与士兵心连心</a></td>
      <td class="td-03"><i class="icon-txt icon-txt-hot">热</i></td></tr>
    <tr class=""><td class="td-01 ranktop ranktop1">1</td>
      <td class="td-02"><a href="/weibo?q=%E7%83%AD%E6%90%9C2" target="_blank">女子住酒店退房搬空用品</a><span>1091514</span></td>
      <td class="td-03"><i class="icon-txt icon-txt-new">新</i></td></tr>
    <tr class=""><td class="td-01 ranktop ranktop2">2</td>
      <td class="td-02"><a href="javascript:void(0);" target="_blank">广告位</a></td>
      <td class="td-03"></td></tr>
  </tbody></table></body></html>`;
  const items = parseWeiboOfficialHtml(html, 5);
  assert.equal(items.length, 2, "广告行(href=javascript)应被过滤");
  assert.equal(items[0].rank, 0, "置顶行 rank=0");
  assert.ok(items[0].heat.includes("热"), "置顶行带标记");
  assert.ok(items[1].heat.includes("109.2万"), "数字热度转万: " + items[1].heat);
  assert.ok(items[1].url.startsWith("https://s.weibo.com/"), "相对链接补全");
});


test("hotlist: parseBaiduHotlist 解析百度 JSON(置顶/排名)", () => {
  
  const body = JSON.stringify({ data: { cards: [{ component: "tabTextList", content: [{ content: [
    { isTop: true, word: "矢志强军向复兴", url: "https://m.baidu.com/s?word=a" },
    { isTop: false, index: 1, word: "个贷新规", url: "https://m.baidu.com/s?word=b" },
  ] }] }] } });
  const items = parseBaiduHotlist(body, 5);
  assert.equal(items.length, 2);
  assert.equal(items[0].rank, 0);
  assert.equal(items[0].heat, "置顶");
  assert.equal(items[1].rank, 1);
  assert.equal(items[1].title, "个贷新规");
});


test("hotlist: parseToutiaoHotlist 解析头条 JSON(热度转万/URL 清理)", () => {
  
  const body = JSON.stringify({ data: [
    { Title: "俄军兵临双子城下", HotValue: 16731403, Url: "https://www.toutiao.com/trending/1/?log_pb=%7B%22a%22%3A1%7D", ClusterIdStr: "1" },
    { Title: "个贷新规", HotValue: 1234, Url: "", ClusterIdStr: "2" },
  ] });
  const items = parseToutiaoHotlist(body, 5);
  assert.equal(items.length, 2);
  assert.equal(items[0].heat, "1673.1万");
  assert.equal(items[0].url, "https://www.toutiao.com/trending/1/", "追踪参数应清理");
  assert.equal(items[1].url, "https://www.toutiao.com/trending/2/", "无 Url 时用 ClusterIdStr 兜底");
});


test("hotlist: parseDouyinHotlist 解析混淆 class DOM(词条/链接)", () => {
  
  const html = `<html><body><ul>
    <li class="xqnrQ8ZV"><div class="_Q3ByIgH listStyle"><img src="up.svg" alt=""></div>
      <div class="qe4SKjIp"><div class="OQtNjDJ9">
        <a href="/hot/2593465/%E7%BB%9F%E5%B8%85%E4%B8%8E%E5%A3%AB%E5%85%B5%E5%BF%83" class="RZuwF26I ogheTtO9" target="_blank"><h3>统帅与士兵心连心</h3></a>
      </div></div></li>
    <li><a href="/video/7664771414982455406"><div class="videoImage"></div></a></li>
  </ul></body></html>`;
  const items = parseDouyinHotlist(html, 5);
  assert.equal(items.length, 1, "视频卡片(非 /hot/ 链接)应被排除");
  assert.equal(items[0].title, "统帅与士兵心连心");
  assert.ok(items[0].url.startsWith("https://www.douyin.com/hot/"), "相对链接补全: " + items[0].url);
  assert.equal(items[0].heat, "", "抖音无热度数字");
});

// ==================== bing 中文工具站站群过滤 ====================


test("bing: dedupeZhResults 识别黄历站群(域名变体+标题雷同,不依赖词表)", () => {
  // 站群本质:不同域名共享同一词根 huangli + 标题模板雷同
  assert.equal(domainStem("https://www.huangli123.net/huangli/"), "huangli123");
  assert.ok(longestCommonSubstring("huangli123", "tthuangli") >= 4, "共享词根 huangli");
  const results = [
    { title: "今日黄历查询_老黄历查询_万年历老黄历查询_老黄历网", url: "https://www.huangli123.net/huangli/" },
    { title: "今日黄历 · 吉凶宜忌查询", url: "https://huangli.me/" },
    { title: "黄历_老黄历_今日黄历查询-黄历网", url: "https://www.huangli.com/huangli/" },
    { title: "今日黄历宜忌查询,今日老黄历,今天是什么日子老黄历_天天黄历", url: "https://m.tthuangli.com/jinrihuangli/" },
    { title: "黄历_老黄历_今日黄历查询-黄历网", url: "https://www.huangli.com/" },
    { title: "今日农历,今日择吉日,今日黄历查询-老黄历网", url: "https://www.laohuangli.co/" },
    { title: "天天黄历官网正版,今日老黄历查询,万年历黄道吉日_天天黄历", url: "https://www.tthuangli.com/" },
  ];
  const { good, junkCount } = dedupeZhResults(results);
  assert.ok(junkCount >= 5, `应过滤大部分站群,实际过滤 ${junkCount}`);
  assert.ok(good.length <= 2, `站群应聚成 1 簇,实际 ${good.length}`);
});


test("bing: dedupeZhResults 不误杀(正常新闻/同站多篇文章/转载去重)", () => {
  const results = [
    { title: "中国新闻_央视网", url: "https://news.cctv.com/china/" },
    { title: "人民网_网上的人民日报", url: "https://www.people.com.cn/" },
    { title: "腾讯网-要闻", url: "https://news.qq.com/" },
    { title: "Python 爬虫入门详细教程(含实例)", url: "https://zhuanlan.zhihu.com/p/1" },
    { title: "Python 爬虫 - BeautifulSoup 菜鸟教程", url: "https://www.runoob.com/python3/1" },
  ];
  let { good, junkCount } = dedupeZhResults(results);
  assert.equal(junkCount, 0, "多样化结果不应误判");
  assert.equal(good.length, results.length);
  // 门户站名/栏目词重叠不误判(网易新闻 ⊂ 网易新闻客户端、中国新闻央视网 vs 中国新闻网头条主页)
  const portal = [
    { title: "中国新闻_央视网 (cctv.com)", url: "https://news.cctv.com/china/" },
    { title: "今日头条", url: "https://www.toutiao.com/" },
    { title: "网易新闻客户端", url: "https://headline.m.163.com/" },
    { title: "人民网_网上的人民日报", url: "https://www.people.com.cn/" },
    { title: "腾讯网-要闻", url: "https://news.qq.com/" },
    { title: "网易新闻", url: "https://news.163.com/" },
    { title: "中国新闻网的头条主页 - 今日头条", url: "https://www.toutiao.com/c/user/token/x" },
    { title: "最新滚动新闻_网易新闻中心", url: "https://news.163.com/latest/" },
  ];
  ({ good, junkCount } = dedupeZhResults(portal));
  assert.equal(junkCount, 0, "门户站名/栏目词重叠不应误判");
  assert.equal(good.length, portal.length);
  // 同站两篇不同文章(csdn)不聚类
  const sameSite = [
    { title: "Python爬虫史上超详细讲解(零基础入门)", url: "https://blog.csdn.net/ChenBinBini/article/details/1" },
    { title: "一篇最全 Python 爬虫超详细讲解(零基础入门)", url: "https://blog.csdn.net/likuoelie/article/details/2" },
    { title: "Python 爬虫入门详细教程", url: "https://zhuanlan.zhihu.com/p/3" },
  ];
  ({ good, junkCount } = dedupeZhResults(sameSite));
  assert.equal(junkCount, 0, "同站多篇不同文章不应聚类");
  // 转载(不同站相同标题)去重
  const dup = [
    { title: "新华社:高质量推进国防和军队现代化", url: "https://a.news.cn/1.html" },
    { title: "新华社:高质量推进国防和军队现代化", url: "https://www.gov.cn/2.html" },
    { title: "人民网:高质量推进国防和军队现代化", url: "https://www.people.com.cn/3.html" },
  ];
  ({ good, junkCount } = dedupeZhResults(dup));
  assert.equal(junkCount, 2, "跨站同源转载应去重,保留 1 条");
  assert.equal(good.length, 1);
});

// ==================== 搜索结果聚类(cluster.mjs) ====================

const CLUSTER_MIXED = [
  { title: "中国新闻_央视网", url: "https://news.cctv.com/china/" },
  { title: "人民网_网上的人民日报", url: "https://www.people.com.cn/" },
  { title: "腾讯网-要闻", url: "https://news.qq.com/" },
  { title: "Python爬虫史上超详细讲解(零基础入门)", url: "https://blog.csdn.net/1" },
  { title: "一篇最全 Python 爬虫超详细讲解", url: "https://blog.csdn.net/2" },
  { title: "Python 爬虫入门详细教程(含实例)", url: "https://zhuanlan.zhihu.com/p/1" },
  { title: "今日黄历查询_老黄历查询_万年历老黄历查询", url: "https://www.huangli123.net/" },
  { title: "今日黄历宜忌查询,今日老黄历", url: "https://m.tthuangli.com/" },
];



// ---------- SERP 标题日期提取(2026-08 修复:标题含日期是强时效信号) ----------
test("bing: 标题含日期(2025年5月11日热点新闻速览) → date 字段", () => {
  const html = '<html><body><li class="b_algo"><h2><a href="https://x.com/1">2025年5月11日热点新闻速览 中美经贸会谈</a></h2><div class="b_caption"><p>国内要闻汇总</p></div></li></body></html>';
  const { results } = parseBingHtml(html, 5);
  assert.equal(results[0].date, "2025-05-11", "标题日期应提取为 date");
});

test("baidu: 标题含日期(2022年6月25日热点新闻简报) → date 字段", () => {
  const pad = "x".repeat(8000); // 超过 BAIDU_BLOCKED_MIN_LEN,避免误判风控
  const html = `<html><body>${pad}<div class="c-result result" data-log="{&quot;mu&quot;:&quot;https://x.com/2&quot;}"><div class="cosc-title-slot"><!--s-text-->2022年6月25日热点新闻简报 每天一分钟知晓天下事<!--/s-text--></div><div class="c-abstract"><span>旧文摘要</span></div></div></body></html>`;
  const { blocked, results } = parseBaiduHtml(html, 5);
  assert.equal(blocked, false);
  assert.equal(results[0]?.date, "2022-06-25", "标题日期应提取为 date");
});
