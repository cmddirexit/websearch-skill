/**
 * registry.mjs — 引擎注册中心
 *
 * 职责:把 engines.conf.json(声明式)里的字符串 key 映射到真实实现函数,
 * 并做完整性校验(引用的引擎必须已注册,否则启动即报错)。
 * cli.mjs 只消费 loadEngines() 的结果,不关心实现细节。
 *
 * 扩展新引擎三步:
 *   1. engines/ 下实现 search 函数(返回 {engine, mode, blocked, reason?, results[]})
 *   2. 本文件 ENGINE_IMPLS / ENGINE_LABELS 注册
 *   3. engines.conf.json 登记 + 声明降级链(聚合伙伴可直接写 ["all"] = 除自身与专用引擎外全部)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { searchBing } from "./bing.mjs";
import { searchBaidu } from "./baidu.mjs";
import { searchSogou } from "./sogou.mjs";
import { searchSogouWechat } from "./sogou-wechat.mjs";
import { searchSo360 } from "./so360.mjs";
import { searchSm } from "./sm.mjs";
import { searchToutiao } from "./toutiao.mjs";
import { searchMarginalia } from "./marginalia.mjs";
import { searchCnnews } from "./cnnews.mjs";
import { searchHn } from "./hn.mjs";
import { searchGithub } from "./github.mjs";
import { searchWikipedia } from "./wikipedia.mjs";
import { searchSearx } from "./searx.mjs";
import { searchChinaso } from "./chinaso.mjs";
import { searchBingViaBrowser } from "./bing-browser.mjs";
import { searchMarginaliaViaBrowser } from "./marginalia-browser.mjs";
import { USER_CONFIG } from "../user-config.mjs";

/** key → 实现函数(所有可被 search/fallbacks 引用的引擎都必须在此注册) */
export const ENGINE_IMPLS = {
  bing: searchBing,
  baidu: searchBaidu,
  sogou: searchSogou,
  "sogou-wechat": searchSogouWechat,
  so360: searchSo360,
  sm: searchSm,
  toutiao: searchToutiao,
  marginalia: searchMarginalia,
  cnnews: searchCnnews,
  hn: searchHn,
  github: searchGithub,
  wikipedia: searchWikipedia,
  searx: searchSearx,
  chinaso: searchChinaso,
  "marginalia-browser": searchMarginaliaViaBrowser,
  "bing-browser": searchBingViaBrowser,
};

/** key → 人类可读名(降级日志/输出用;浏览器兜底引擎也在此命名) */
export const ENGINE_LABELS = {
  bing: "bing(中文/英文通用)",
  baidu: "baidu(中文)",
  sogou: "sogou(中文)",
  "sogou-wechat": "sogou-wechat(微信公众号文章)",
  so360: "so360(360搜索·中文)",
  sm: "sm(神马搜索·中文)",
  toutiao: "toutiao(头条搜索·中文)",
  marginalia: "marginalia(英文独立索引)",
  cnnews: "cnnews(官方新闻源·带日期)",
  hn: "hn(Hacker News 技术讨论)",
  github: "github(代码仓库)",
  wikipedia: "wikipedia(英文百科)",
  searx: "searx(SearXNG 聚合,含 Google)",
  chinaso: "chinaso(中国搜索·央媒新闻源)",
  "marginalia-browser": "marginalia(浏览器)",
  "bing-browser": "bing(浏览器)",
};

/** 不参与通用聚合 "all" 的专用引擎
 * cnnews=官方新闻白名单,气质与通用搜索不同;
 * searx=公共 SearXNG 实例需梯子/触发浏览器兜底(本机无梯子,库模式易 OOM),聚合时排除
 * (单引擎 --engine searx 仍可用,不受影响) */
// 不参与多引擎聚合的引擎(浏览器兜底型/专属型;单引擎 --engine xxx 仍可用)
const AGGREGATE_EXCLUDE = new Set(["cnnews", "searx", "chinaso"]);

const CONF_FILE = fileURLToPath(new URL("../engines.conf.json", import.meta.url));

/**
 * 加载并校验引擎配置。
 * @param {string} [confPath] 配置路径(默认正式配置;测试可注入临时文件)
 * @returns {Object<string, {label:string, search:Function, fallbacks:Array<{label:string, fn:Function}>}>}
 */
export function loadEngines(confPath = CONF_FILE, userConfig = USER_CONFIG.engines || {}) {
  const raw = JSON.parse(readFileSync(confPath, "utf8"));
  const engines = raw?.engines;
  if (!engines || typeof engines !== "object") {
    throw new Error("engines.conf.json 缺少 engines 字段");
  }
  const knownKeys = Object.keys(engines);
  for (const key of [...(userConfig.disabled || []), ...(userConfig.order || []), userConfig.default].filter(Boolean)) {
    if (!engines[key]) throw new Error(`用户配置引用未知引擎: ${key}`);
  }
  const disabled = new Set(userConfig.disabled || []);
  const enabledKeys = knownKeys.filter((key) => !disabled.has(key));
  if (enabledKeys.length === 0) throw new Error("用户配置禁用了全部搜索引擎");
  const orderedKeys = [
    ...(userConfig.order || []).filter((key) => !disabled.has(key)),
    ...enabledKeys.filter((key) => !(userConfig.order || []).includes(key)),
  ];
  const out = {};
  for (const key of orderedKeys) {
    const cfg = engines[key];
    const search = ENGINE_IMPLS[cfg?.search];
    if (!search) throw new Error(`引擎 "${key}" 的 search "${cfg?.search}" 未在 ENGINE_IMPLS 注册`);
    const fallbacks = [];
    for (const f of cfg?.fallbacks || []) {
      const fn = ENGINE_IMPLS[f];
      if (!fn) throw new Error(`引擎 "${key}" 的 fallback "${f}" 未在 ENGINE_IMPLS 注册`);
      if (disabled.has(f)) continue;
      fallbacks.push({ label: ENGINE_LABELS[f] || f, fn });
    }
    // 聚合伙伴:["all"] 展开为“除自身与专用引擎外全部”(保持声明序,行为与手写列表等价);
    // 显式列表则原样使用(如 cnnews 只聚合 bing/baidu/github)
    let aggregateWith = cfg.aggregateWith || [];
    if (aggregateWith.includes("all")) {
      aggregateWith = orderedKeys.filter((k) => k !== key && !AGGREGATE_EXCLUDE.has(k));
    } else {
      aggregateWith = aggregateWith.filter((partner) => !disabled.has(partner));
    }
    out[key] = { label: cfg.label || key, search, fallbacks, aggregateWith, zhOnly: !!cfg.zhOnly, enOnly: !!cfg.enOnly, pageLimit: cfg.pageLimit || 10, host: cfg.host || "" };
    // 校验聚合伙伴已注册(声明式完整性)
    for (const p of out[key].aggregateWith) {
      if (!ENGINE_IMPLS[p]) throw new Error(`引擎 "${key}" 的 aggregateWith "${p}" 未在 ENGINE_IMPLS 注册`);
    }
  }
  return out;
}

export function defaultEngineKey(engines, userConfig = USER_CONFIG.engines || {}) {
  if (userConfig.default) {
    if (!engines[userConfig.default]) throw new Error(`默认引擎不可用: ${userConfig.default}`);
    return userConfig.default;
  }
  if (engines.bing) return "bing";
  return Object.keys(engines)[0];
}
