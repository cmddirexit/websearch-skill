import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUserConfig, resolveUserConfigPath, validateUserConfig } from "../../user-config.mjs";
import { defaultEngineKey, loadEngines } from "../../engines/registry.mjs";
import { llmConfig } from "../../llm-judge.mjs";

const fullConfig = {
  version: 1,
  engines: { default: "baidu", disabled: ["sogou"], order: ["baidu", "bing"] },
  network: { httpTimeoutMs: 4321, fetchTimeoutMs: 9876, totalBudgetMs: 45000, perEngineTimeoutMs: 9000 },
  cache: { directory: "/tmp/websearch-config-test", pageTtlMs: 12345 },
  browser: { path: "/bin/false", navigationTimeoutMs: 7654 },
  semantic: {
    backend: "off",
    localModel: "local/model",
    apiBase: "https://embed.example/v1",
    apiModel: "embed-model",
    apiDimensions: 256,
    relevanceMode: "conservative",
  },
  reputation: { strength: 0.8 },
  llm: { enabled: true, provider: "custom", baseUrl: "https://llm.example/v1", model: "judge-model" },
};

test("user config: 完整合法配置通过且不注入默认值", () => {
  const config = structuredClone(fullConfig);
  assert.equal(validateUserConfig(config), config);
  assert.deepEqual(validateUserConfig({ version: 1 }), { version: 1 });
});

test("user config: 未知字段、敏感字段、类型、范围和冲突直接报错", () => {
  assert.throws(() => validateUserConfig({ search: { defaultLimit: 10 } }), /root\.search.*未知字段/);
  assert.throws(() => validateUserConfig({ llm: { key: "secret" } }), /llm\.key.*未知字段/);
  assert.throws(() => validateUserConfig({ network: { httpTimeoutMs: "1000" } }), /必须是有限数值/);
  assert.throws(() => validateUserConfig({ network: { totalBudgetMs: 1000, perEngineTimeoutMs: 2000 } }), /不能大于/);
  assert.throws(() => validateUserConfig({ semantic: { backend: "magic" } }), /api\|local\|wasm\|off/);
  assert.throws(() => validateUserConfig({ engines: { default: "bing", disabled: ["bing"] } }), /不能同时/);
  assert.throws(() => validateUserConfig({ llm: { enabled: true } }), /必须指定 provider/);
});

test("user config: 文件加载、显式路径缺失和 JSON 损坏均有明确诊断", () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-user-config-"));
  try {
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify(fullConfig));
    assert.deepEqual(loadUserConfig({ file, env: {} }), fullConfig);
    assert.equal(resolveUserConfigPath({ WEBSEARCH_CONFIG: file }), file);
    assert.throws(() => loadUserConfig({ file: join(dir, "missing.json"), env: { WEBSEARCH_CONFIG: "set" } }), /配置文件不存在/);
    writeFileSync(file, "{");
    assert.throws(() => loadUserConfig({ file, env: {} }), /配置文件解析失败/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("user config: 引擎顺序、默认值和禁用项同时作用于聚合与 fallback", () => {
  const engines = loadEngines(undefined, fullConfig.engines);
  assert.deepEqual(Object.keys(engines).slice(0, 2), ["baidu", "bing"]);
  assert.equal(defaultEngineKey(engines, fullConfig.engines), "baidu");
  assert.equal(engines.sogou, undefined);
  assert.ok(!engines.bing.aggregateWith.includes("sogou"));
  assert.ok(!engines.baidu.fallbacks.some((item) => item.label.startsWith("sogou")));
  assert.throws(() => loadEngines(undefined, { disabled: ["ghost"] }), /未知引擎/);
});

test("user config: LLM 文件配置不包含密钥,凭据仍只从环境变量读取", () => {
  assert.equal(llmConfig({}, fullConfig.llm), null, "无环境密钥不得启用外发");
  assert.deepEqual(llmConfig({ WEBSEARCH_LLM_KEY: "env-secret" }, fullConfig.llm), {
    provider: "custom",
    baseURL: "https://llm.example/v1",
    model: "judge-model",
    key: "env-secret",
  });
  assert.equal(llmConfig({ WEBSEARCH_LLM_KEY: "x", WEBSEARCH_LLM_OFF: "1" }, fullConfig.llm), null);
});

test("user config: 独立进程验证 env > 文件 > 内置默认值", () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-user-config-process-"));
  try {
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify(fullConfig));
    const script = `
      import { DEFAULT_SEARCH_LIMIT, HTTP_TIMEOUT_MS, HTTP_FULL_TIMEOUT_MS, TOTAL_BUDGET_MS, CACHE_DIR, NAV_TIMEOUT_MS, EMBED_BACKEND, EMBED_MODEL, EMBED_API_BASE, EMBED_API_MODEL, EMBED_API_DIMENSIONS, REL_MODE, REP_STRENGTH, BROWSER_PATH } from './scripts/lib/config.mjs';
      import { defaultEngineKey, loadEngines } from './scripts/lib/engines/registry.mjs';
      const engines = loadEngines();
      console.log(JSON.stringify({ DEFAULT_SEARCH_LIMIT, HTTP_TIMEOUT_MS, HTTP_FULL_TIMEOUT_MS, TOTAL_BUDGET_MS, CACHE_DIR, NAV_TIMEOUT_MS, EMBED_BACKEND, EMBED_MODEL, EMBED_API_BASE, EMBED_API_MODEL, EMBED_API_DIMENSIONS, REL_MODE, REP_STRENGTH, BROWSER_PATH, engineKeys: Object.keys(engines), defaultEngine: defaultEngineKey(engines) }));
    `;
    const env = { ...process.env, WEBSEARCH_CONFIG: file, WEBSEARCH_HTTP_TIMEOUT_MS: "2222" };
    delete env.NODE_TEST_CONTEXT;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(), env, encoding: "utf8",
    });
    const values = JSON.parse(output);
    assert.equal(values.DEFAULT_SEARCH_LIMIT, 99, "用户配置不得改变默认搜索上限");
    assert.equal(values.defaultEngine, "baidu");
    assert.deepEqual(values.engineKeys.slice(0, 2), ["baidu", "bing"]);
    assert.ok(!values.engineKeys.includes("sogou"));
    assert.equal(values.HTTP_TIMEOUT_MS, 2222, "环境变量覆盖配置文件");
    assert.equal(values.HTTP_FULL_TIMEOUT_MS, 9876);
    assert.equal(values.TOTAL_BUDGET_MS, 45000);
    assert.equal(values.CACHE_DIR, "/tmp/websearch-config-test");
    assert.equal(values.NAV_TIMEOUT_MS, 7654);
    assert.equal(values.EMBED_BACKEND, "off");
    assert.equal(values.EMBED_MODEL, "local/model");
    assert.equal(values.EMBED_API_BASE, "https://embed.example/v1");
    assert.equal(values.EMBED_API_MODEL, "embed-model");
    assert.equal(values.EMBED_API_DIMENSIONS, 256);
    assert.equal(values.REL_MODE, "conservative");
    assert.equal(values.REP_STRENGTH, 0.8);
    assert.equal(values.BROWSER_PATH, "/bin/false");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
