// cli.mjs runFetch 决策链单元测试
//
// 背景:本次排障(SPA 空壳/缓存误写/CF 误标)4 个 bug 全在 runFetch 调度层,
// 但该层无测试且内部函数不可测 —— 此文件用 node:test 的 mock.module 替换
// fetch-page/browser/persist/http/domain-rep,纯内存验证决策链,不触网不写盘。
//
// 覆盖场景(决策树):
//   ① 缓存命中 → 秒回,不直连不兜底
//   ② 直连 full → 直接返回 + 写缓存,不兜底
//   ③ 直连 empty → 浏览器兜底成功(full) → 返回兜底结果 + 写缓存
//   ④ 直连 empty → 浏览器兜底失败(null) → 回退直连空壳,不写缓存
//   ⑤ 直连异常(403) → 存档失败 → 浏览器成功 → 返回浏览器结果
//   ⑥ 已知 CF 站记忆命中 → 跳过直连,直接 preferCli 兜底
//   ⑦ 空壳兜底带 skipZendriver(直连 200 非 CF 拦截)

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ⚠ flag 防护:cli 决策链测试依赖 mock.module(实验性 API,需 --experimental-test-module-mocks)。
// npm test 已带该 flag;但手动 `node --test xxx` 跑时会 mock.module undefined → 直接 TypeError
// 误导排查。无 flag 时注册一个 skip 测试,提示正确跑法,而不是崩。
if (typeof mock?.module !== "function") {
  test("cli 决策链测试需要 --experimental-test-module-mocks", { skip: "请用 npm test 运行(已带该 flag)" }, () => {});
} else {
  await runCliTests();
}

async function runCliTests() {

// 测试隔离:archive 冷却状态写到临时文件,避免污染真实 cache
process.env.WEBSEARCH_ARCHIVE_FAIL_FILE = join(tmpdir(), `ws-archive-fail-${process.pid}.json`);

// ---------- mock 依赖(cli.mjs 的 import 链),必须在 import cli.mjs 之前 ----------
const calls = { fetchPage: [], fetchViaBrowser: [], cachePut: [], cacheGet: 0, cfHost: 0, selection: [], httpGetFull: 0 };
// 测试间共享的"当前结果",每个 test 开始前设置
const state = { fetchPageResult: null, browserResult: null, cfHost: false, fetchPageThrows: null, cacheHit: null };

mock.module("../../fetch-page.mjs", {
  namedExports: {
    fetchPage: async (url, maxChars) => {
      calls.fetchPage.push({ url, maxChars });
      if (state.fetchPageThrows) throw state.fetchPageThrows;
      return state.fetchPageResult;
    },
  },
});

mock.module("../../engines/browser.mjs", {
  namedExports: {
    // 完整 mock(部分 mock 会丢 getDom 等导出,registry→bing-browser 链会崩)
    fetchViaBrowser: async (url, maxChars, opts) => {
      calls.fetchViaBrowser.push({ url, opts });
      return state.browserResult;
    },
    resolveChromiumPath: () => "/usr/bin/chromium",
    getLastBrowserFailure: () => "",
    isBrowserAvailable: async () => true,
    getDom: async () => null,
    closeBrowser: async () => {},
    probeChromiumVersion: async () => "149.0.0.0",
    bezierPath: () => [],
    STEALTH_INIT_SCRIPT: "",
  },
});

mock.module("../../persist.mjs", {
  namedExports: {
    pageCacheGet: (url) => { calls.cacheGet++; return state.cacheHit; },
    pageCachePut: (url, data) => calls.cachePut.push({ url, data }),
    hostOf: (url) => { try { return new URL(url).host; } catch { return "x"; } },
    isKnownCfHost: (host) => { calls.cfHost++; return state.cfHost; },
  },
});

mock.module("../../http.mjs", {
  namedExports: {
    // 完整 mock 全部导出(部分 mock 会丢其他导出,导致依赖链 import httpGet 崩)
    REQ_HEADERS: {}, UA: "test-ua",
    computeRateLimitDelay: () => 0, parseSetCookieLine: () => null,
    updateCookieJarForResponse: () => {}, getCookieHeaderFor: () => "",
    timeoutSignal: () => undefined, tcpProbe: async () => false,
    httpGet: async () => { throw new Error("httpGet mocked off"); },
    httpGetJson: async () => { throw new Error("httpGetJson mocked off"); },
    // fetchViaArchive 用:默认 archive 不可达(慢链直接失败);调用次数供冷却测试断言
    httpGetFull: async () => { calls.httpGetFull++; throw new Error("archive unreachable"); },
  },
});

mock.module("../../domain-rep.mjs", {
  namedExports: {
    createDomainReputation: () => ({
      learnSelection: (url) => calls.selection.push(url),
      learnFetch: () => {}, learnFetchBlocked: () => {},
      learnFetchContent: async () => {}, learnFetchLLM: async () => {}, learnFromResultsLLM: async () => {},
      learnFromResults: async () => {}, save: async () => {},
    }),
  },
});

const { runFetch, cacheFetchResult } = await import("../../cli.mjs");

// ---------- 工具 ----------
const URL_ = "https://example.com/article";
const shell = (len) => "x".repeat(len); // 短壳
const fullBody = (n = 500) => "真实正文内容 ".repeat(Math.ceil(n / 6)); // 达线正文
// 真实 fetchPage 产物含 markdown 字段(cacheFetchResult 依赖);shell 版同样带
const pageOk = (extra = {}) => ({ markdown: fullBody(), body: fullBody(), title: "T", url: URL_, ...extra });
const pageShell = (extra = {}) => ({ markdown: shell(33), body: shell(33), title: "Loading", url: URL_, ...extra });

function reset() {
  calls.fetchPage.length = 0;
  calls.fetchViaBrowser.length = 0;
  calls.cachePut.length = 0;
  calls.cacheGet = 0;
  calls.cfHost = 0;
  calls.selection.length = 0;
  state.fetchPageResult = pageOk();
  state.browserResult = null;
  state.cfHost = false;
  state.fetchPageThrows = null;
  state.cacheHit = null;
}

// 捕获 console.log(printFetchResult 走 stdout),防污染测试输出
const origLog = console.log;
function silenceLog() { console.log = () => {}; }
function restoreLog() { console.log = origLog; }

// ---------- ① 缓存命中 → 秒回 ----------
test("① 缓存命中:不直连不兜底不重写缓存", async () => {
  reset(); silenceLog();
  state.cacheHit = { markdown: fullBody(), title: "Cached", url: URL_ };
  try {
    await runFetch(URL_, 500);
  } finally { restoreLog(); }
  assert.equal(calls.fetchPage.length, 0, "缓存命中不应直连");
  assert.equal(calls.fetchViaBrowser.length, 0, "缓存命中不应兜底");
  assert.equal(calls.cachePut.length, 0, "回放(_cached)不应重写缓存");
  assert.deepEqual(calls.selection, [URL_], "缓存命中也应记录主动选择");
});

// ---------- ② 直连 full → 直接返回 + 写缓存 ----------
test("② 直连达线:直接返回,写缓存,不触发兜底", async () => {
  reset(); silenceLog();
  state.fetchPageResult = pageOk({ title: "Full" });
  try {
    await runFetch(URL_, 500);
  } finally { restoreLog(); }
  assert.equal(calls.fetchViaBrowser.length, 0, "达线不应兜底");
  assert.equal(calls.cachePut.length, 1, "达线结果应写缓存");
  assert.match(calls.cachePut[0].data.markdown, /真实正文/, "缓存内容应为直连正文");
});

// ---------- ③ 直连 empty → 浏览器兜底成功 ----------
test("③ 直连空壳:浏览器兜底成功则返回兜底结果并写缓存", async () => {
  reset(); silenceLog();
  state.fetchPageResult = pageShell();
  state.browserResult = pageOk({ title: "Rendered" });
  try {
    await runFetch(URL_, 500);
  } finally { restoreLog(); }
  assert.equal(calls.fetchViaBrowser.length, 1, "空壳应触发浏览器兜底");
  assert.equal(calls.cachePut.length, 1, "兜底达线结果应写缓存");
  assert.match(calls.cachePut[0].data.markdown, /真实正文/, "缓存应为兜底正文");
});

// ---------- ④ 直连 empty → 浏览器兜底失败 → 回退直连,不写缓存 ----------
test("④ 直连空壳 + 兜底失败:回退直连结果,不写缓存(空壳不缓存)", async () => {
  reset(); silenceLog();
  state.fetchPageResult = pageShell();
  state.browserResult = null; // 浏览器不可用
  try {
    await runFetch(URL_, 500);
  } finally { restoreLog(); }
  assert.equal(calls.fetchViaBrowser.length, 1, "空壳应尝试兜底");
  assert.equal(calls.cachePut.length, 0, "空壳(无论兜底成败)不写缓存");
});

// ---------- ⑤ 直连异常(403) → 存档失败 → 浏览器成功 ----------
test("⑤ 直连 403:存档失败后浏览器兜底成功并写缓存", async () => {
  reset(); silenceLog();
  state.fetchPageThrows = Object.assign(new Error("HTTP 403 Forbidden"), { status: 403, body: "<html>denied</html>" });
  state.browserResult = pageOk({ title: "ViaBrowser" });
  try {
    await runFetch(URL_, 500);
  } finally { restoreLog(); }
  assert.equal(calls.fetchViaBrowser.length, 1, "403 应触发浏览器兜底");
  assert.equal(calls.cachePut.length, 1, "兜底达线应写缓存");
});

// ---------- ⑤b 直连异常(404) → 跳过存档,浏览器确认 404 → 报页面不存在 ----------
test("⑤b 直连 404:跳过存档,浏览器确认 404 → 报页面不存在而非误导性 CF 错误", async () => {
  reset(); silenceLog();
  state.fetchPageThrows = Object.assign(new Error("HTTP 404 (https://x/y)"), { status: 404 });
  state.browserResult = { url: URL_, notFound: true }; // 浏览器渲染后仍是 404 页
  let err = null;
  try {
    await runFetch(URL_, 500);
  } catch (e) {
    err = e;
  } finally { restoreLog(); }
  assert.ok(err, "应抛错(页面不存在)");
  assert.match(err.message, /页面不存在/, "错误信息应明确 404 而非可能被 CF 拦截");
  assert.equal(calls.fetchViaBrowser.length, 1, "404 仍需浏览器确认一次");
  assert.equal(calls.fetchViaBrowser[0].opts.skipZendriver, true, "404 场景应跳过 zendriver(避免空等 60s)");
  assert.equal(calls.cachePut.length, 0, "404 不写缓存");
});

// ---------- ⑤c 直连 404 + 浏览器兜底环境失败(null) → 仍报页面不存在 ----------
test("⑤c 直连 404 + 浏览器不可用:仍报页面不存在(404 是确定性信号)", async () => {
  reset(); silenceLog();
  state.fetchPageThrows = Object.assign(new Error("HTTP 404 (https://x/y)"), { status: 404 });
  state.browserResult = null; // 浏览器不可用/未安装
  let err = null;
  try {
    await runFetch(URL_, 500);
  } catch (e) {
    err = e;
  } finally { restoreLog(); }
  assert.ok(err, "应抛错");
  assert.match(err.message, /页面不存在/, "直连 404 是确定性信号,浏览器失败不影响结论");
});

// ---------- ⑤d archive 冷却期:跳过存档直接浏览器(不可达网络省 ~20s) ----------
test("⑤d archive 冷却期:403 跳过存档直接浏览器,不再白等镜像超时", async () => {
  const { archiveCooldown } = await import("../../fetch-flow.mjs");
  reset(); silenceLog();
  // 连续失败达阈值 → 进入冷却(与真实不可达网络一致)
  archiveCooldown.mark("archive", false);
  archiveCooldown.mark("archive", false);
  assert.ok(archiveCooldown.isCooled("archive"), "连续失败应进入冷却");
  calls.httpGetFull = 0;
  state.fetchPageThrows = Object.assign(new Error("HTTP 403 Forbidden"), { status: 403, body: "<html>denied</html>" });
  state.browserResult = pageOk({ title: "ViaBrowser" });
  try {
    await runFetch(URL_, 500);
  } finally {
    archiveCooldown.reset(); // 清理测试状态
    restoreLog();
  }
  assert.equal(calls.httpGetFull, 0, "冷却期内不应调用存档镜像");
  assert.equal(calls.fetchViaBrowser.length, 1, "直接浏览器兜底");
});

// ---------- ⑤e login-wall(知乎 40362):跳过存档直接浏览器 ----------
test("⑤e login-wall 风控(知乎 40362):跳过存档直接浏览器", async () => {
  reset(); silenceLog();
  calls.httpGetFull = 0;
  state.fetchPageThrows = Object.assign(new Error("HTTP 403"), {
    status: 403,
    body: JSON.stringify({ code: 40362, message: "您当前请求存在异常" }),
  });
  state.browserResult = pageOk({ title: "ViaBrowser" });
  try {
    await runFetch(URL_, 500);
  } finally { restoreLog(); }
  assert.equal(calls.httpGetFull, 0, "login-wall 不应走存档(archive 也抓不到需登录内容)");
  assert.equal(calls.fetchViaBrowser.length, 1, "直接浏览器兜底");
  assert.equal(calls.fetchViaBrowser[0].opts.preferCli, true, "login-wall 走 CLI 真实等待轮(库模式 CDP 泄漏必被拦)");
});

// ---------- ⑥ 已知 CF 站 → 跳过直连,直接 preferCli 兜底 ----------
test("⑥ CF 记忆命中:跳过直连,直接浏览器兜底(preferCli)", async () => {
  reset(); silenceLog();
  state.cfHost = true;
  state.browserResult = pageOk({ title: "CF" });
  try {
    await runFetch(URL_, 500);
  } finally { restoreLog(); }
  assert.equal(calls.fetchPage.length, 0, "CF 记忆命中不应直连");
  assert.equal(calls.fetchViaBrowser.length, 1, "应直接浏览器兜底");
  assert.equal(calls.fetchViaBrowser[0].opts.preferCli, true, "CF 站应走真实等待轮");
  assert.equal(calls.cachePut.length, 1, "CF 兜底达线应写缓存");
});

// ---------- ⑦ 空壳兜底带 skipZendriver(直连 200 非 CF) ----------
test("⑦ 直连 200 空壳:兜底带 skipZendriver(非 CF 场景跳过 zendriver)", async () => {
  reset(); silenceLog();
  state.fetchPageResult = pageShell();
  state.browserResult = pageOk({ title: "Rendered" });
  try {
    await runFetch(URL_, 500);
  } finally { restoreLog(); }
  assert.equal(calls.fetchViaBrowser.length, 1);
  assert.equal(calls.fetchViaBrowser[0].opts.skipZendriver, true, "直连 200 空壳兜底应跳过 zendriver");
  assert.equal(calls.fetchViaBrowser[0].opts.preferCli, undefined, "空壳兜底不应 preferCli(用虚拟时间轮)");
});

// ---------- cacheFetchResult 直接单测(复用上面的 pageCachePut mock) ----------
test("cacheFetchResult:空壳不写缓存/达线写缓存/回放跳过", () => {
  reset();
  cacheFetchResult({ markdown: shell(10), url: "https://a.com" }); // empty → 不写
  cacheFetchResult({ markdown: fullBody(), url: "https://b.com" }); // full → 写
  cacheFetchResult({ markdown: fullBody(), url: "https://c.com", _cached: true }); // 回放 → 跳过
  assert.equal(calls.cachePut.length, 1, "仅达线写缓存");
  assert.equal(calls.cachePut[0].url, "https://b.com", "写缓存的是达线那一条");
});
} // end runCliTests
