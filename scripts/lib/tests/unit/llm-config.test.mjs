import { test } from "node:test";
import assert from "node:assert/strict";
import { llmConfig } from "../../llm-judge.mjs";
import { CACHE_DIR, envNumber } from "../../config.mjs";

test("LLM 默认关闭:发现通用 API key 也不启用外发", () => {
  assert.equal(llmConfig({ OPENAI_API_KEY: "openai-secret" }), null);
  assert.equal(llmConfig({ SILICONFLOW_API_KEY: "sf-secret" }), null);
});

test("LLM provider 与凭据严格绑定,不跨服务商取 key", () => {
  assert.equal(llmConfig({
    WEBSEARCH_LLM_ENABLED: "1",
    WEBSEARCH_LLM_PROVIDER: "deepseek",
    OPENAI_API_KEY: "wrong-provider-key",
  }), null);

  const deepseek = llmConfig({
    WEBSEARCH_LLM_ENABLED: "1",
    WEBSEARCH_LLM_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "deepseek-key",
  });
  assert.deepEqual(deepseek, {
    provider: "deepseek",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-chat",
    key: "deepseek-key",
  });

  const openai = llmConfig({
    WEBSEARCH_LLM_ENABLED: "1",
    WEBSEARCH_LLM_PROVIDER: "openai",
    OPENAI_API_KEY: "openai-key",
  });
  assert.equal(openai?.baseURL, "https://api.openai.com/v1");
  assert.equal(openai?.key, "openai-key");
});

test("LLM custom provider 要求显式 key/base/model,OFF 始终优先", () => {
  assert.equal(llmConfig({
    WEBSEARCH_LLM_ENABLED: "1",
    WEBSEARCH_LLM_PROVIDER: "custom",
    WEBSEARCH_LLM_KEY: "k",
  }), null);
  assert.equal(llmConfig({
    WEBSEARCH_LLM_ENABLED: "1",
    WEBSEARCH_LLM_OFF: "1",
    WEBSEARCH_LLM_PROVIDER: "openai",
    OPENAI_API_KEY: "k",
  }), null);
  assert.deepEqual(llmConfig({
    WEBSEARCH_LLM_ENABLED: "1",
    WEBSEARCH_LLM_PROVIDER: "custom",
    WEBSEARCH_LLM_KEY: "k",
    WEBSEARCH_LLM_BASE_URL: "https://llm.example/v1/",
    WEBSEARCH_LLM_MODEL: "model-a",
  }), {
    provider: "custom",
    baseURL: "https://llm.example/v1",
    model: "model-a",
    key: "k",
  });
});

test("配置:数值 0 不被默认值覆盖,单测缓存与用户 HOME 隔离", () => {
  assert.equal(envNumber("ZERO", 1024, { ZERO: "0" }), 0);
  assert.equal(envNumber("BAD", 1024, { BAD: "not-a-number" }), 1024);
  assert.match(CACHE_DIR, /websearch-test-/);
  assert.ok(!CACHE_DIR.startsWith(`${process.env.HOME}/.cache`));
});
