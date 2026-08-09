/** User-facing runtime configuration. Internal algorithm constants stay in config.mjs. */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CONFIG_FILE = fileURLToPath(new URL("../../websearch.config.json", import.meta.url));
const ROOT_KEYS = new Set(["version", "engines", "network", "cache", "browser", "semantic", "reputation", "llm"]);
const SECTION_KEYS = {
  engines: new Set(["default", "disabled", "order"]),
  network: new Set(["httpTimeoutMs", "fetchTimeoutMs", "totalBudgetMs", "perEngineTimeoutMs"]),
  cache: new Set(["directory", "pageTtlMs"]),
  browser: new Set(["path", "navigationTimeoutMs"]),
  semantic: new Set(["backend", "localModel", "apiBase", "apiModel", "apiDimensions", "relevanceMode"]),
  reputation: new Set(["strength"]),
  llm: new Set(["enabled", "provider", "baseUrl", "model"]),
};

function fail(path, message) {
  throw new Error(`websearch 配置错误(${path}): ${message}`);
}

function plainObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "必须是对象");
}

function rejectUnknown(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "未知字段");
  }
}

function optionalString(value, path, { nonEmpty = true } = {}) {
  if (value === undefined) return;
  if (typeof value !== "string" || (nonEmpty && !value.trim())) fail(path, "必须是非空字符串");
}

function optionalBoolean(value, path) {
  if (value !== undefined && typeof value !== "boolean") fail(path, "必须是布尔值");
}

function optionalNumber(value, path, min, max, integer = true) {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "必须是有限数值");
  if (integer && !Number.isInteger(value)) fail(path, "必须是整数");
  if (value < min || value > max) fail(path, `必须在 ${min}..${max} 范围内`);
}

function optionalEnum(value, path, allowed) {
  if (value === undefined) return;
  if (!allowed.includes(value)) fail(path, `必须是 ${allowed.join("|")} 之一`);
}

function optionalStringArray(value, path) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    fail(path, "必须是非空字符串数组");
  }
  if (new Set(value).size !== value.length) fail(path, "不能包含重复项");
}

function optionalHttpUrl(value, path) {
  if (value === undefined) return;
  optionalString(value, path);
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") fail(path, "仅允许 http/https URL");
  } catch (error) {
    if (error.message.startsWith("websearch 配置错误")) throw error;
    fail(path, "URL 格式无效");
  }
}

/** Validate without adding defaults, so precedence remains env > file > built-in. */
export function validateUserConfig(config) {
  plainObject(config, "root");
  rejectUnknown(config, ROOT_KEYS, "root");
  if (config.version !== undefined && config.version !== 1) fail("version", "目前只支持版本 1");

  for (const section of Object.keys(SECTION_KEYS)) {
    const value = config[section];
    if (value === undefined) continue;
    plainObject(value, section);
    rejectUnknown(value, SECTION_KEYS[section], section);
  }

  const engines = config.engines || {};
  optionalString(engines.default, "engines.default");
  optionalStringArray(engines.disabled, "engines.disabled");
  optionalStringArray(engines.order, "engines.order");
  if (engines.default && engines.disabled?.includes(engines.default)) {
    fail("engines.default", "不能同时出现在 engines.disabled");
  }

  const network = config.network || {};
  optionalNumber(network.httpTimeoutMs, "network.httpTimeoutMs", 250, 120_000);
  optionalNumber(network.fetchTimeoutMs, "network.fetchTimeoutMs", 500, 300_000);
  optionalNumber(network.totalBudgetMs, "network.totalBudgetMs", 1_000, 300_000);
  optionalNumber(network.perEngineTimeoutMs, "network.perEngineTimeoutMs", 250, 120_000);
  if (network.totalBudgetMs && network.perEngineTimeoutMs && network.perEngineTimeoutMs > network.totalBudgetMs) {
    fail("network.perEngineTimeoutMs", "不能大于 network.totalBudgetMs");
  }

  const cache = config.cache || {};
  optionalString(cache.directory, "cache.directory");
  optionalNumber(cache.pageTtlMs, "cache.pageTtlMs", 0, 30 * 86400_000);

  const browser = config.browser || {};
  optionalString(browser.path, "browser.path");
  optionalNumber(browser.navigationTimeoutMs, "browser.navigationTimeoutMs", 500, 300_000);

  const semantic = config.semantic || {};
  optionalEnum(semantic.backend, "semantic.backend", ["auto", "api", "local", "wasm", "off"]);
  optionalString(semantic.localModel, "semantic.localModel");
  optionalHttpUrl(semantic.apiBase, "semantic.apiBase");
  optionalString(semantic.apiModel, "semantic.apiModel");
  optionalNumber(semantic.apiDimensions, "semantic.apiDimensions", 0, 8192);
  optionalEnum(semantic.relevanceMode, "semantic.relevanceMode", ["balanced", "aggressive", "conservative"]);

  const reputation = config.reputation || {};
  optionalNumber(reputation.strength, "reputation.strength", 0, 3, false);

  const llm = config.llm || {};
  optionalBoolean(llm.enabled, "llm.enabled");
  optionalEnum(llm.provider, "llm.provider", ["deepseek", "siliconflow", "openai", "custom"]);
  optionalHttpUrl(llm.baseUrl, "llm.baseUrl");
  optionalString(llm.model, "llm.model");
  if (llm.enabled && !llm.provider) fail("llm.provider", "llm.enabled=true 时必须指定 provider");
  if (llm.provider === "custom" && (!llm.baseUrl || !llm.model)) {
    fail("llm", "custom provider 必须同时配置 baseUrl 和 model");
  }
  return config;
}

export function resolveUserConfigPath(env = process.env) {
  return env.WEBSEARCH_CONFIG ? resolve(env.WEBSEARCH_CONFIG) : DEFAULT_CONFIG_FILE;
}

export function loadUserConfig({ env = process.env, file = resolveUserConfigPath(env) } = {}) {
  const explicit = Boolean(env.WEBSEARCH_CONFIG);
  if (!existsSync(file)) {
    if (explicit) throw new Error(`websearch 配置文件不存在: ${file}`);
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`websearch 配置文件解析失败(${file}): ${error.message}`);
  }
  return validateUserConfig(parsed);
}

export const USER_CONFIG_FILE = resolveUserConfigPath();
export const USER_CONFIG = loadUserConfig({ file: USER_CONFIG_FILE });
