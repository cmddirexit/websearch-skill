/**
 * wikipedia.mjs — Wikipedia 百科搜索(MediaWiki API,无 key 无验证)
 *
 * 特点:权威百科条目(定义/背景/概念梳理),与通用搜索引擎重叠极低;
 * 聚合给 Agent 提供"概念定义"维度。enOnly(zh.wikipedia 在 CN 网络不可达,失败静默)。
 *
 * API: /w/api.php?action=query&list=search&srsearch=&format=json&srlimit=
 *   结果只给标题+摘要片段,url 需拼 zh/en.wikipedia.org/wiki/<标题>
 */

const WIKI_API = "https://en.wikipedia.org/w/api.php";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) WebSearchSkill/1.0";

import { httpGetJson } from "../http.mjs";

/**
 * Wikipedia 搜索。
 * @returns {Promise<{engine:"wikipedia", mode:"direct", blocked:boolean, reason?:string, results:Array}>}
 */
export async function searchWikipedia(query, limit) {
  const perPage = Math.min(limit || 10, 50);
  try {
    const url = `${WIKI_API}?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${perPage}`;
    // 统一走 httpGetJson:同域限速/Cookie/超时(HTTP_TIMEOUT_MS)由 http.mjs 管理
    const j = await httpGetJson(url, { headers: { "User-Agent": UA } });
    const items = j?.query?.search || [];
    if (items.length === 0) {
      return { engine: "wikipedia", mode: "direct", blocked: true, reason: "Wikipedia 无结果", results: [] };
    }
    const results = items.map((s) => ({
      title: s.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(s.title.replace(/ /g, "_"))}`,
      // snippet 一般 100~300 字符,但防御性截断防异常长输入(与其它引擎 desc 口径一致)
      desc: (s.snippet || "").replace(/<[^>]+>/g, "").slice(0, 400),
    }));
    return { engine: "wikipedia", mode: "direct", blocked: false, results };
  } catch (e) {
    return { engine: "wikipedia", mode: "direct", blocked: true, reason: (e.message || e).slice(0, 100), results: [] };
  }
}
