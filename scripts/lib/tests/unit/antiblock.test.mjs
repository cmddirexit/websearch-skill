// antiblock.mjs —— isCfAnti 单一事实来源(CF 类型判定收敛点)
import { test } from "node:test";
import assert from "node:assert/strict";
import { isCfAnti, detectAntibot, classifyFetchResult, detectNotFound } from "../../antiblock.mjs";

test("isCfAnti: CF 系类型一律命中(turnstile/interstitial/未来新名)", () => {
  assert.equal(isCfAnti({ type: "cloudflare-turnstile", label: "Turnstile" }), true);
  assert.equal(isCfAnti({ type: "cloudflare-interstitial", label: "Just a moment" }), true);
  assert.equal(isCfAnti({ type: "cloudflare-managed" }), true, "未来 CF 新类型名自动覆盖");
});

test("isCfAnti: 非 CF / 边界输入不误判", () => {
  assert.equal(isCfAnti({ type: "zhihu-40362" }), false);
  assert.equal(isCfAnti({ type: "captcha" }), false);
  assert.equal(isCfAnti(null), false);
  assert.equal(isCfAnti(undefined), false);
  assert.equal(isCfAnti({}), false);
  assert.equal(isCfAnti({ type: 42 }), false, "type 非字符串不误判");
});

test("detectAntibot: 知乎 40362 风控 JSON → login-wall(供 fetch 跳过存档直接浏览器)", () => {
  const r = detectAntibot(JSON.stringify({ code: 40362, message: "您当前请求存在异常" }));
  assert.equal(r?.type, "login-wall");
  const r2 = detectAntibot("暂时限制本次访问");
  assert.equal(r2?.type, "login-wall");
  assert.equal(detectAntibot("正常页面内容"), null);
});

test("isCfAnti: 与 detectAntibot 集成(CF 验证页 HTML → 命中)", () => {
  const cfPage = `<html><head><title>Just a moment...</title></head><body>
    <div class="cf-challenge">Performing security verification</div>
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></body></html>`;
  const anti = detectAntibot(cfPage);
  assert.ok(anti, "CF 验证页应被 detectAntibot 识别");
  assert.equal(isCfAnti(anti), true);
});

test("classifyFetchResult: SPA 残缺检测 —— HTML 远大于正文且裸字符截断 → truncated", () => {
  // 官网 case:39KB HTML(Next.js SSR)只提取出 500 字符,结尾是单词中途的 "W"
  const r = {
    markdown:
      "Advances in single-cell RNA-seq technologies now enable large-scale measurements of cellular responses to genetic and chemical perturbations, fueling this exciting era of predictive cellular modeling. The Virtual Cell Challenge is a recurring, open, community-driven challenge aimed at evaluating and improving computational models that predict cellular responses to genetic or chemical perturbations.\n\nIn 2026, the Challenge raises the bar to multi-context generalization and zero-shot prediction. W",
    htmlBytes: 39964,
  };
  assert.ok(r.markdown.length >= 200, "测试前提:正文达线");
  const { kind } = classifyFetchResult(r);
  assert.equal(kind, "truncated", "SPA 壳(HTML 巨大+正文截断)应判 truncated,触发浏览器兜底");
});

test("classifyFetchResult: SPA 残缺检测 —— 完整句末标点结尾不误判", () => {
  // 正文以句号结尾(完整),即使 HTML 很大也不判 truncated
  const r = {
    markdown: "The Virtual Cell Challenge is a recurring, open, community-driven challenge aimed at evaluating computational models. " .repeat(6) + "Good.",
    htmlBytes: 39964,
  };
  assert.ok(r.markdown.length >= 200, "测试前提:正文达线");
  const { kind } = classifyFetchResult(r);
  assert.equal(kind, "full");
});

test("classifyFetchResult: HTML 与正文比例正常(非 SPA)不误判", () => {
  // 正文 >= 200 字符(达线)但 HTML 比例正常 → full
  const r = {
    markdown: "这是一篇普通文章正文,内容完整且以句号结尾。".repeat(12) + "这是一篇普通文章正文,内容完整。",
    htmlBytes: 800,
  };
  assert.ok(r.markdown.length >= 200, "测试前提:正文达线");
  const { kind } = classifyFetchResult(r);
  assert.equal(kind, "full");
});

test("classifyFetchResult: 无 htmlBytes(浏览器兜底/存档结果)不受截断检测影响", () => {
  const r = {
    markdown: "浏览器渲染后的完整正文,以句号结尾。".repeat(12) + "浏览器渲染后的完整正文。",
    // 不传 htmlBytes → 默认 0,不触发 truncated
  };
  assert.ok(r.markdown.length >= 200, "测试前提:正文达线");
  const { kind } = classifyFetchResult(r);
  assert.equal(kind, "full");
});

test("detectNotFound: Next.js 404 页(标题含 404 + could not be found)→ 命中", () => {
  const html = `<html><head><title>404: This page could not be found.</title></head><body>
    <main>404 This page could not be found.</main></body></html>`;
  const nf = detectNotFound(html);
  assert.ok(nf, "Next.js 404 页应被识别");
  assert.equal(nf.type, "not-found");
});

test("detectNotFound: 中文 404 页(页面不存在)→ 命中", () => {
  const html = `<html><head><title>错误 404</title></head><body>
    <div>404 页面不存在,请检查链接</div></body></html>`;
  const nf = detectNotFound(html);
  assert.ok(nf, "中文 404 页应被识别");
});

test("detectNotFound: 正常页(含 404 字样但非 404 页)→ 不误判", () => {
  const html = `<html><head><title>HTTP Status Codes 404 Explained</title></head><body>
    <article>HTTP 404 Not Found is a standard response code. This page explains it in detail with examples.</article></body></html>`;
  const nf = detectNotFound(html);
  assert.equal(nf, null, "科普页含 404 字样不应误判为页面不存在");
});

test("detectNotFound: 反爬页/验证码页 → 不误判为 404", () => {
  const html = `<html><head><title>Just a moment...</title></head><body>
    <div class="cf-challenge">Performing security verification</div>
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></body></html>`;
  const nf = detectNotFound(html);
  assert.equal(nf, null, "CF 验证页不是 404");
});

test("detectNotFound: 空输入/非 HTML → null 不抛错", () => {
  assert.equal(detectNotFound(null), null);
  assert.equal(detectNotFound(""), null);
  assert.equal(detectNotFound("plain text without html"), null);
});

// ==================== SPA 懒加载占位壳(央视网"正在加载"类) ====================
test("classifyFetchResult: 正文达线但含'正在加载'占位标记 → truncated(触发浏览器兜底)", () => {
  // 央视网等客户端渲染站:正文短但达线,含占位标记 → 残缺,浏览器渲染后才有真内容
  const r = {
    markdown: "正在加载… 请稍候。页面内容由客户端渲染,此段为占位文本。".repeat(8),
    htmlBytes: 50000,
  };
  assert.ok(r.markdown.length >= 200, "测试前提:正文达线");
  const { kind } = classifyFetchResult(r);
  assert.equal(kind, "truncated", "含占位标记的短内容应判 truncated,让浏览器渲染后重试");
});

test("classifyFetchResult: 正常文章含'加载'字样(如讨论网页加载)不误判", () => {
  const r = {
    markdown: "网页加载速度直接影响用户体验,本文讨论前端性能优化方案,内容完整。".repeat(10),
    htmlBytes: 3000,
  };
  assert.ok(r.markdown.length >= 200, "测试前提:正文达线");
  const { kind } = classifyFetchResult(r);
  assert.equal(kind, "full", "正文完整且长,不应误判 truncated");
});

// ==================== 列表页结果分类 ====================
test("classifyFetchResult: 列表页结果(条目数达标)→ full,不再当空壳触发浏览器兜底", () => {
  const r = {
    markdown: "- 2026-08-07 [新闻一](https://x.cn/a.shtml)\n- 2026-08-07 [新闻二](https://x.cn/b.shtml)\n- 2026-08-06 [新闻三](https://x.cn/c.shtml)",
    isList: true,
    listCount: 3,
  };
  const { kind } = classifyFetchResult(r);
  assert.equal(kind, "full", "列表结果≥3条即视为可用内容,不浪费浏览器兜底");
});
