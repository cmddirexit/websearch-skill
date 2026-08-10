// embed.mjs(语义嵌入缓存/冷却韧性) + tls.mjs(TLS 指纹兜底与失败冷却)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCurlOutput, isTlsFallbackCandidate, recordTlsFailure, recordTlsSuccess,
  isTlsHostCooled, resetTlsFailState, httpGetViaImpersonate, isImpersonateAvailable,
} from "../../tls.mjs";

test("embed韧性: 同查询+同结果集缓存命中 → 零 API 调用", async () => {
  const { embedResults, resetQVecCache } = await import("../../embed.mjs");
  resetQVecCache();
  const realFetch = globalThis.fetch;
  const realKey = process.env.SILICONFLOW_API_KEY;
  process.env.SILICONFLOW_API_KEY = "test-only";
  let calls = 0;
  globalThis.fetch = async (_url, opts) => {
    calls++;
    const body = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: body.input.map((_, i) => ({
          embedding: Array.from({ length: 8 }, (_, k) => (i + 1) * (k + 1) * 0.01),
        })),
      }),
    };
  };
  try {
    const results = [
      { title: "虚拟细胞大赛结果", url: "u1", desc: "d1" },
      { title: "虚拟细胞入门指南", url: "u2", desc: "d2" },
    ];
    const r1 = await embedResults(results, { query: "虚拟细胞大赛" });
    assert.equal(r1.available, true);
    assert.equal(calls, 1, "首次调用 API 一次(含查询向量共 3 个文本)");
    assert.equal(r1.vectors.length, 2);
    // 相同查询 + 相同结果集 → 缓存命中,零 API 调用
    const r2 = await embedResults(results, { query: "虚拟细胞大赛" });
    assert.equal(calls, 1, "缓存命中不调 API");
    assert.deepEqual(r2.qVec, r1.qVec, "缓存向量一致");
    // URL 不变但摘要变化 → 缓存键也必须变化,不能复用陈旧向量
    await embedResults([{ ...results[0], desc: "changed" }, results[1]], { query: "虚拟细胞大赛" });
    assert.equal(calls, 2, "输入内容变化则重新嵌入");
    // 结果集不同(同一查询)→ 重新调 API
    const r3 = await embedResults([{ title: "x", url: "u3", desc: "d3" }], { query: "虚拟细胞大赛" });
    assert.equal(calls, 3, "结果集变化则重新嵌入");
    assert.ok(r3.qVec, "新结果集仍返回查询向量");
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.SILICONFLOW_API_KEY;
    else process.env.SILICONFLOW_API_KEY = realKey;
  }
});


test("embed韧性: 连续失败进入冷却期(不再请求),成功恢复", async () => {
  const { embedResults, resetApiFailState, resetQVecCache } = await import("../../embed.mjs");
  resetApiFailState();
  resetQVecCache();
  const realFetch = globalThis.fetch;
  const realKey = process.env.SILICONFLOW_API_KEY;
  process.env.SILICONFLOW_API_KEY = "test-only";
  let failMode = true; // 先全部 500,后恢复 200
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (failMode) return { ok: false, status: 500, text: async () => "server error" };
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
    };
  };
  try {
    const results = [{ title: "t", url: "u", desc: "d" }];
    // 第一次:500 + 退避重试,3 次尝试后失败 → available:false,fails=1(未达冷却阈值)
    const r1 = await embedResults(results, { query: "q" });
    assert.equal(r1.available, false, "API 连续失败回退短语模式");
    assert.ok(calls >= 3, "500 自动退避重试(≥3 次)");
    // 第二次:再次失败 → fails=2 达阈值,进入冷却
    await embedResults(results, { query: "q2" });
    assert.ok(calls >= 6, "第二次仍尝试(触发冷却的那次)");
    // 第三次:冷却期内不再请求(直接降级)
    const before = calls;
    await embedResults(results, { query: "q3" });
    assert.equal(calls, before, "冷却期内不请求 API(直接降级)");
    // 恢复:重置状态(模拟冷却过期/手动恢复)→ API 正常
    resetApiFailState();
    failMode = false;
    const r3 = await embedResults(results, { query: "q3" });
    assert.equal(r3.available, true, "状态重置后 API 恢复");
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.SILICONFLOW_API_KEY;
    else process.env.SILICONFLOW_API_KEY = realKey;
    resetApiFailState();
    resetQVecCache();
  }
});

test("embed后端: WEBSEARCH_EMBED_BACKEND=off 对结果与通用文本都不请求网络", async () => {
  const { embedResults, embedConfiguredTexts } = await import("../../embed.mjs");
  const realBackend = process.env.WEBSEARCH_EMBED_BACKEND;
  const realFetch = globalThis.fetch;
  let calls = 0;
  process.env.WEBSEARCH_EMBED_BACKEND = "off";
  globalThis.fetch = async () => { calls++; throw new Error("不应请求"); };
  try {
    const out = await embedResults([{ title: "t", url: "u", desc: "d" }], { query: "q" });
    assert.equal(out.available, false);
    assert.equal(await embedConfiguredTexts(["标题", "正文"]), null);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
    if (realBackend === undefined) delete process.env.WEBSEARCH_EMBED_BACKEND;
    else process.env.WEBSEARCH_EMBED_BACKEND = realBackend;
  }
});

test("embed API: 单次调用受硬超时约束", async () => {
  const { apiEmbedTexts, resetApiFailState } = await import("../../embed.mjs");
  const realFetch = globalThis.fetch;
  const realKey = process.env.SILICONFLOW_API_KEY;
  process.env.SILICONFLOW_API_KEY = "test-only";
  resetApiFailState();
  globalThis.fetch = async (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const started = Date.now();
  try {
    const out = await apiEmbedTexts(["slow"], { quiet: true, timeoutMs: 250, maxAttempts: 1 });
    assert.equal(out, null);
    assert.ok(Date.now() - started < 1_500, "超时后应快速降级");
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.SILICONFLOW_API_KEY;
    else process.env.SILICONFLOW_API_KEY = realKey;
    resetApiFailState();
  }
});

test("embed API: 单次模式仍允许移除不兼容 dimensions 后纠正请求", async () => {
  const { apiEmbedTexts, resetApiFailState } = await import("../../embed.mjs");
  const realFetch = globalThis.fetch;
  const realKey = process.env.SILICONFLOW_API_KEY;
  process.env.SILICONFLOW_API_KEY = "test-only";
  resetApiFailState();
  let calls = 0;
  globalThis.fetch = async (_url, opts) => {
    calls++;
    const body = JSON.parse(opts.body);
    if (body.dimensions) return { ok: false, status: 400, text: async () => "unsupported dimensions" };
    return { ok: true, status: 200, json: async () => ({ data: [{ embedding: [1, 0] }] }) };
  };
  try {
    const out = await apiEmbedTexts(["text"], { quiet: true, maxAttempts: 1 });
    assert.deepEqual(out, [[1, 0]]);
    assert.equal(calls, 2, "协议纠正一次,不扩张网络错误重试次数");
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.SILICONFLOW_API_KEY;
    else process.env.SILICONFLOW_API_KEY = realKey;
    resetApiFailState();
  }
});

// ---------- tls.mjs(TLS 指纹兜底) ----------


test("tls: parseCurlOutput 单段输出(status/set-cookie/body)", () => {
  const out = "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\nset-cookie: sid=abc; Path=/\r\n\r\n<html>hi</html>";
  const r = parseCurlOutput(out);
  assert.equal(r.status, 200);
  assert.deepEqual(r.setCookies, ["sid=abc; Path=/"]);
  assert.equal(r.body, "<html>hi</html>");
});


test("tls: parseCurlOutput 重定向多段输出(状态取最终,set-cookie 全收,body 含空行还原)", () => {
  const out = [
    "HTTP/1.1 301 Moved Permanently",
    "location: https://final.example/x",
    "set-cookie: r1=1; Path=/",
    "",
    "HTTP/1.1 200 OK",
    "set-cookie: sid=zzz; Path=/",
    "",
    "<html>",
    "line1",
    "",
    "line2",
    "</html>",
  ].join("\r\n");
  const r = parseCurlOutput(out);
  assert.equal(r.status, 200, "重定向后取最终状态码");
  assert.deepEqual(r.setCookies, ["r1=1; Path=/", "sid=zzz; Path=/"], "重定向途中 set-cookie 全收集");
  // 输入用 \r\n 拼接,分段后段内 \r\n 原样保留、段间以 \n\n 还原空行
  assert.equal(r.body, "<html>\r\nline1\n\nline2\r\n</html>", "body 多段拼接还原(空行不丢)");
});


test("tls: parseCurlOutput 错误输出(status 0,不抛)", () => {
  const r = parseCurlOutput("curl: (35) SSL connect error");
  assert.equal(r.status, 0);
  assert.equal(r.body, "");
});


test("tls: isTlsFallbackCandidate 命中 403 / TLS 拦截,不命中 404/超时", () => {
  const mk = (status) => { const e = new Error(`HTTP ${status}`); e.status = status; return e; };
  assert.ok(isTlsFallbackCandidate(mk(403)), "403(Cloudflare/防火墙)应命中");
  assert.ok(!isTlsFallbackCandidate(mk(404)), "404 不应命中");
  assert.ok(!isTlsFallbackCandidate(mk(429)), "429 限流不应命中(指纹无关)");
  assert.ok(isTlsFallbackCandidate(new Error("fetch failed: ECONNRESET")), "握手 RST 应命中");
  assert.ok(isTlsFallbackCandidate(new Error("DEPTH_ZERO_SELF_SIGNED_CERT")), "证书错误应命中");
  assert.ok(isTlsFallbackCandidate({ code: "EPROTO", message: "tls handshake failed" }), "TLS 协议错误应命中");
  assert.ok(!isTlsFallbackCandidate(new Error("This operation was aborted")), "超时 abort 不应命中");
  assert.ok(!isTlsFallbackCandidate(new Error("ENOTFOUND example.com")), "DNS 失败不应命中");
  assert.ok(!isTlsFallbackCandidate(null), "null 不应命中");
});


test("tls: 域名连续失败 2 次进入冷却,冷却期内快速短路(不启动后端)", async () => {
  resetTlsFailState();
  const host = "tls-cooled.invalid";
  recordTlsFailure(host);
  assert.ok(!isTlsHostCooled(host), "1 次失败未达阈值");
  recordTlsFailure(host);
  assert.ok(isTlsHostCooled(host), "连续 2 次失败进入冷却");
  const t0 = Date.now();
  const r = await httpGetViaImpersonate(`https://${host}/x`, {});
  assert.equal(r, null, "冷却期内直接返回 null");
  assert.ok(Date.now() - t0 < 2000, "冷却期内不启动 python/curl(快速失败)");
  resetTlsFailState();
});


test("tls: 成功清零 —— 失败后成功恢复,计数归零不误伤", async () => {
  resetTlsFailState();
  const host = "tls-recover.invalid";
  recordTlsFailure(host);
  recordTlsSuccess(host); // 成功清零
  recordTlsFailure(host);
  assert.ok(!isTlsHostCooled(host), "成功清零后 1 次失败不应进入冷却");
  resetTlsFailState();
});
