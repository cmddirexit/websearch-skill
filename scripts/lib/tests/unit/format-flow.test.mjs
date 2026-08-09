import { test, mock } from "node:test";
import assert from "node:assert/strict";

const embeddedOrders = [];

mock.module("../../embed.mjs", {
  exports: {
    embedResults: async (results) => {
      embeddedOrders.push(results.map((r) => r.url));
      return { available: false };
    },
  },
});

mock.module("../../learn.mjs", {
  exports: {
    rep: { applyToResults: (results) => results },
    queueLLMLearn: () => {},
  },
});

const { printResults } = await import("../../format.mjs");

test("format: 时间重排后的结果顺序与嵌入输入严格一致", async () => {
  embeddedOrders.length = 0;
  const log = mock.method(console, "log", () => {});
  const error = mock.method(console, "error", () => {});
  try {
    await printResults({
      engine: "mock",
      mode: "direct",
      results: [
        { title: "历史技术报道", url: "https://old.example/a", date: "2020-01-01", desc: "历史内容摘要完整" },
        { title: "今日技术进展", url: "https://fresh.example/b", date: "2026-08-09", desc: "今天发布的内容摘要" },
      ],
    }, "最新技术进展", false, true);
  } finally {
    log.mock.restore();
    error.mock.restore();
  }
  assert.deepEqual(
    embeddedOrders[0],
    ["https://fresh.example/b", "https://old.example/a"],
    "向量必须按最终传给聚类的重排结果生成",
  );
});
