/**
 * engines/factory.mjs — 直连型引擎工厂
 *
 * 消除 baidu/sm/so360/toutiao 等"请求 → 解析 → blocked 包装"样板:
 * 直连搜索引擎的 search 函数形态统一(httpGet + parse + blocked 包装),
 * 抽成工厂后引擎文件只保留:URL 构造 + parse 纯函数 + 反爬注释。
 *
 * 不适用的引擎(sogou/bing/marginalia/searx 等)保留手写 search:
 *  - sogou: 会话建立 + 风控冷却 + 跳转链接解析,不是纯直连
 *  - bing:  地域污染检测需要查询词参与(工厂签名不含 query 上下文)
 */

import { httpGet } from "../http.mjs";

/**
 * 创建直连型 search 函数。
 * @param {Object} cfg
 * @param {string} cfg.name  引擎 key(返回值的 engine 字段)
 * @param {string} cfg.mode  mode 枚举:mobile|web|ssr|json(见 index.mjs 契约)
 * @param {(query:string, limit:number)=>string} cfg.buildUrl
 * @param {(html:string, limit:number)=>{blocked:boolean, reason?:string, results:Array}} cfg.parse
 * @param {Object} [cfg.headers] 自定义请求头(如移动端 UA);默认桌面 UA
 * @returns {(query:string, limit:number)=>Promise<{engine, mode, blocked, reason?, results}>}
 */
export function createDirectEngine({ name, mode, buildUrl, parse, headers }) {
  return async function search(query, limit) {
    const url = typeof buildUrl === "function" ? buildUrl(query, limit) : buildUrl;
    const html = await httpGet(url, headers ? { headers } : {});
    const { blocked, reason, results, parsedBy, hitRate, specificCount, genericCount } = parse(html, limit);
    // parsedBy/hitRate 为 parseSerp 包装器产物(分层解析途径),透传给调用方做降级提示
    if (blocked) return { engine: name, mode, blocked: true, reason, results: [], ...(parsedBy ? { parsedBy } : {}) };
    return {
      engine: name,
      mode,
      blocked: false,
      results,
      ...(parsedBy ? { parsedBy, hitRate, specificCount, genericCount } : {}),
    };
  };
}
