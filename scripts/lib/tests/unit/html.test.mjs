// html 工具 + fetch-page(readability/正则正文提取)解析测试
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeEntities, clean, stripTags, extractAttr, stripControl } from "../../html.mjs";
import { extractBodyWithReadability, extractBodyRegex } from "../../fetch-page.mjs";


test("decodeEntities: 命名实体", () => {
  assert.equal(decodeEntities("a&amp;b &lt;c&gt; &quot;d&quot;"), "a&b <c> \"d\"");
});


test("decodeEntities: 数字实体与空格类", () => {
  assert.equal(decodeEntities("&#0183; &#169;"), "· ©");
  assert.equal(decodeEntities("a&ensp;b&nbsp;c"), "a b c");
  assert.equal(decodeEntities("Web scraping with Swift -&shy; Igor"), "Web scraping with Swift - Igor");
});


test("clean: 移除软连字符 U+00AD(浏览器渲染后真实字符)", () => {
  assert.equal(clean("Web scraping with Swift -\u00ad Igor Kulman"), "Web scraping with Swift - Igor Kulman");
});


test("decodeEntities: bing 双重编码 &amp%3B", () => {
  assert.equal(decodeEntities("x=1&amp%3By=2"), "x=1&y=2");
  assert.equal(decodeEntities("hl=zh-CN&amp%3Bgl=CN"), "hl=zh-CN&gl=CN");
});


test("stripTags: 移除标签与 script", () => {
  assert.equal(stripTags("<div>a<script>var x=1</script>b</div>"), "a b");
});


test("clean: 标签+实体+空白", () => {
  assert.equal(clean("<strong> 小米 <em>15</em> &amp; 价格 </strong>"), "小米 15 & 价格");
});


test("extractAttr: data-url", () => {
  assert.equal(extractAttr('<div data-url="https://a.com/b">x</div>', "data-url"), "https://a.com/b");
});

// ---------- engines/bing.mjs ----------

test("readability: 文章页提取正文,剔除导航", () => {
  const para = "这是正文段落,包含足够长度的内容用于验证提取正确性,确保超过字符阈值,让 Readability 能稳定识别文章主体区域。这里继续补充更多文字,模拟真实文章段落。";
  const html = `
  <html><head><title>My Great Article - Blog</title>
  <meta property="og:title" content="My Great Article"></head>
  <body><nav>Nav junk links</nav>
  <article><h1>My Great Article</h1><p>${para}</p><p>${para}</p><p>${para}</p></article>
  <footer>Footer junk</footer></body></html>`;
  const r = extractBodyWithReadability(html, 300);
  assert.ok(r, "readability 应成功提取");
  assert.ok(r.body.includes("这是正文段落"), "正文应包含段落");
  assert.ok(!r.body.includes("Nav junk"), "不应包含导航");
  assert.ok(!r.body.includes("Footer junk"), "不应包含页脚");
  assert.ok(r.title.startsWith("My Great Article"), "标题应基于文章标题");
});


test("readability: og:title 是标语时回退 <title>", () => {
  const html = `<html><head><title>Trending repositories on GitHub today</title>
  <meta property="og:title" content="Build software better, together"></head>
  <body><article><p>${"repo内容".repeat(40)}</p></article></body></html>`;
  const r = extractBodyWithReadability(html, 300);
  assert.ok(r, "应成功提取");
  assert.equal(r.title, "Trending repositories on GitHub today");
});


test("readability: 无效页回退正则方案", () => {
  const html = `<html><head><title>t</title></head><body><div>只有一点点文本</div></body></html>`;
  const r = extractBodyRegex(html, 200);
  assert.ok(r);
  assert.ok(r.body.length > 0);
  // 极短内容 Readability 返回 null,extractBodyFromHtml 回退正则
});


test("markdown: 链接/标题层级/列表保留", () => {
  const para = "这是正文段落,包含足够长度的内容用于验证提取正确性,确保超过字符阈值,让 Readability 能稳定识别文章主体区域。这里继续补充更多文字,模拟真实文章段落。";
  const html = `
  <html><head><title>T</title></head>
  <body><article>
    <h1>大标题</h1>
    <h2>小节</h2>
    <p>${para}</p>
    <p>参考 <a href="https://example.com/doc">官方文档</a> 了解更多。</p>
    <ul><li>要点一</li><li>要点二</li></ul>
  </article></body></html>`;
  const r = extractBodyWithReadability(html, 600);
  assert.ok(r, "应成功提取");
  // Readability 会把页面主标题 h1 降级为 h2,不锁定具体级别,只验证层级标记存在
  assert.match(r.markdown, /##\s+大标题/, "标题应保留为 atx 层级标记");
  assert.match(r.markdown, /##\s+小节/, "h2 应保留为 atx 二级标题");
  assert.match(r.markdown, /\[官方文档\]\(https:\/\/example\.com\/doc\)/, "链接应保留为 inline markdown");
  assert.match(r.markdown, /^[-*]\s+要点一/m, "列表应保留");
});


test("markdown: 正则回退路径 markdown 字段仍存在", () => {
  const html = `<html><head><title>t</title></head><body><div>只有一点点文本</div></body></html>`;
  const r = extractBodyRegex(html, 200);
  assert.ok(r);
  assert.ok(typeof r.markdown === "string" && r.markdown.length > 0, "正则回退时 markdown 字段存在");
  assert.equal(r.markdown, r.body, "无 DOM 结构时 markdown 等于纯文本");
});

// stripControl:终端控制序列净化(恶意页面标题注入防护)
test("stripControl: ANSI 转义/控制字符剥离,可读文本保留", () => {
  // CSI 序列(清屏/颜色)
  assert.equal(stripControl("标题\u001b[2J\u001b[H真内容"), "标题真内容");
  assert.equal(stripControl("\u001b[31m红色\u001b[0m"), "红色");
  // OSC 序列(改终端标题)
  assert.equal(stripControl("x\u001b]0;evil\u0007y"), "xy");
  // 裸控制字符
  assert.equal(stripControl("a\u0000b\u0007c"), "abc");
  // 可读空白保留
  assert.equal(stripControl("a\tb\nc"), "a\tb\nc");
  // 普通文本原样
  assert.equal(stripControl("正常的搜索结果标题"), "正常的搜索结果标题");
  assert.equal(stripControl(null), "");
  assert.equal(stripControl(undefined), "");
});

// ==================== extractSerpDate(SERP 结果日期提取) ====================
import { extractSerpDate } from "../../html.mjs";
import { extractBodyFromHtml, extractLinkList } from "../../fetch-page.mjs";

test("extractSerpDate: 相对时间原文(parseResultDateAgo 可理解)", () => {
  assert.equal(extractSerpDate("3小时前"), "3小时前");
  assert.equal(extractSerpDate("昨天 12:30"), "昨天");
  assert.equal(extractSerpDate("5天前"), "5天前");
  assert.equal(extractSerpDate("2个月前"), "2个月前");
  assert.equal(extractSerpDate("1年前"), "1年前");
});

test("extractSerpDate: 绝对日期归一化", () => {
  assert.equal(extractSerpDate("2026年8月5日"), "2026-08-05");
  assert.equal(extractSerpDate("2026-08-05 10:30"), "2026-08-05");
  assert.equal(extractSerpDate("2026/08/05"), "2026-08-05");
});

test("extractSerpDate: 无日期返回空(不误报)", () => {
  assert.equal(extractSerpDate(""), "");
  assert.equal(extractSerpDate("这是一段普通摘要"), "");
  assert.equal(extractSerpDate("阅读量 1000"), "");
});

// ==================== 列表页提取(DOM 遍历,非正则) ====================
test("extractLinkList: 中新网首页形态 —— 空壳正文但链接列表丰富", () => {
  // 模拟门户首页:正文只有版权壳,但 <a> 列表含新闻(日期路径 URL)
  const html = `<html><head><title>中国新闻网_梳理天下新闻</title></head><body>
    <div class="nav"><a href="/gn/">国内</a><a href="/gj/">国际</a></div>
    <ul class="newslist">
      <li><a href="https://www.chinanews.com.cn/gn/2026/08-07/10673618.shtml">习近平总书记关切事|厚植营商沃土</a></li>
      <li><a href="https://www.chinanews.com.cn/cj/2026/08-07/10673364.shtml">多地向县放权激活发展</a></li>
      <li><a href="https://www.chinanews.com.cn/sh/2026/08-07/10673583.shtml">遇到洪涝如何自救</a></li>
      <li><a href="https://www.chinanews.com.cn/tp/2026/08-06/1200337.shtml">云南石林火把节</a></li>
    </ul>
    <footer>本网站所刊载信息，不代表中新社和中新网观点。未经授权禁止转载。Copyright ©1999-2026 chinanews.com</footer>
  </body></html>`;
  const list = extractLinkList(html, "https://www.chinanews.com.cn/");
  assert.ok(list.items.length >= 3, `应提取 ≥3 条新闻链接,实际 ${list.items.length}`);
  // 导航链接(国内/国际栏目)不应进入列表
  assert.ok(!list.items.some((i) => i.title === "国内" || i.title === "国际"), "频道导航链接应被过滤");
  // 第一条应为最新日期(08-07)
  assert.equal(list.items[0].date, "2026-08-07", "按日期倒序,最新在前");
  // 文章形态打分:日期路径链接才收
  assert.ok(list.items.every((i) => /20\d{2}/.test(i.url)), "条目 URL 应含日期路径");
});

test("extractBodyFromHtml: 空壳版权页 → 列表结果(isList + 最新条目日期)", () => {
  const html = `<html><head><title>频道页</title><meta property="article:published_time" content="2018-03-28"></head>
  <body><ul>
    <li><a href="https://x.cn/2026/08-07/a.shtml">新闻甲正式发布</a></li>
    <li><a href="https://x.cn/2026/08-07/b.shtml">新闻乙最新进展</a></li>
    <li><a href="https://x.cn/2026/08-06/c.shtml">新闻丙专题报道</a></li>
  </ul><footer>版权声明 Copyright © 2026</footer></body></html>`;
  const r = extractBodyFromHtml(html, 3000, "https://x.cn/roll");
  assert.equal(r.isList, true, "空壳+链接列表 → 列表结果");
  assert.ok(r.markdown.includes("- 2026-08-07 ["), "markdown 为带日期的链接列表");
  // 问题3核心:发布时间不能用频道页 meta(2018-03-28),应为列表最新条目日期
  assert.equal(r.publishedAt, "2026-08-07", "发布时间 = 列表最新条目,而非误导性 meta");
  assert.ok(r.listCount >= 3);
});
