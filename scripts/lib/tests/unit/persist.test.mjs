// persist.mjs —— CF 站点记忆 / 页面缓存 / 调试日志 / URL 工具(临时目录隔离,不污染真实缓存)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostOf, isKnownCfHost, markCfHost, pageCacheGet, pageCachePut, appendDebugLog } from "../../persist.mjs";

let dir = "";
test.before(() => {
  dir = mkdtempSync(join(tmpdir(), "ws-persist-"));
});
test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("persist: hostOf 提取 hostname,非法 URL 返回空串", () => {
  assert.equal(hostOf("https://www.cell.com/cell-systems/information-for-authors"), "www.cell.com");
  assert.equal(hostOf("https://zhuanlan.zhihu.com/p/1"), "zhuanlan.zhihu.com");
  assert.equal(hostOf("not a url"), "");
  assert.equal(hostOf(""), "");
});

test("persist: markCfHost 幂等,isKnownCfHost 跨调用可见", () => {
  markCfHost("www.cell.com", dir);
  markCfHost("www.cell.com", dir); // 重复标记幂等
  markCfHost("www.nature.com", dir);
  assert.equal(isKnownCfHost("www.cell.com", dir), true);
  assert.equal(isKnownCfHost("www.nature.com", dir), true);
  assert.equal(isKnownCfHost("example.org", dir), false, "未标记域名不可见");
  assert.equal(isKnownCfHost("", dir), false);
  // 落盘文件确实是 JSON 数组
  const raw = JSON.parse(readFileSync(join(dir, "websearch-cf-sites.json"), "utf8"));
  assert.deepEqual(raw, ["www.cell.com", "www.nature.com"]);
});

test("persist: pageCachePut/Get 往返一致,URL hash 片段不参与 key", () => {
  const r = { title: "标题", url: "https://a.com/x", markdown: "正文" };
  pageCachePut("https://a.com/x", r, dir);
  const got = pageCacheGet("https://a.com/x", dir);
  assert.equal(got.title, "标题");
  assert.equal(got.markdown, "正文");
  // 带 hash 的 URL 命中同一缓存(# 不参与 key)
  assert.equal(pageCacheGet("https://a.com/x#section", dir)?.title, "标题");
  assert.equal(pageCacheGet("https://a.com/other", dir), null, "不同 URL 不命中");
});

test("persist: appendDebugLog 落盘可读", () => {
  appendDebugLog("测试日志条目: cell.com CLI 失败诊断", join(dir, "debug.log"));
  const txt = readFileSync(join(dir, "debug.log"), "utf8");
  assert.ok(txt.includes("测试日志条目"), "日志内容应写入");
  assert.ok(txt.includes("==="), "日志应带时间戳分隔行");
});

test("persist: 写入失败静默(目录不存在/只读),不抛异常", () => {
  assert.doesNotThrow(() => markCfHost("x.example.com", join(dir, "no-such-parent")));
  assert.doesNotThrow(() => pageCachePut("https://x.example.com/", {}, join(dir, "no-such-parent")));
  assert.doesNotThrow(() => appendDebugLog("x", join(dir, "no-such-parent", "a.log")));
});
