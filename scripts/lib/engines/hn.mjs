/**
 * hn.mjs — Hacker News 技术内容搜索(HN Algolia 公开 API,无 key 无验证)
 *
 * 特点:开发者社区高信噪比(标题即内容,无 SEO 垃圾);与通用搜索引擎重叠极低,
 * 聚合价值高。英文技术查询专用(enOnly)。
 *
 * API: https://hn.algolia.com/api/v1/search?query=&hitsPerPage=&tags=story
 *   - tags=story 只取帖子(排除 comment),含 Ask HN/Show HN
 *   - 返回 hit 的 title / url(可能为空=纯讨论帖) / points / num_comments
 */

const HN_API = "https://hn.algolia.com/api/v1/search";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) WebSearchSkill/1.0";

import { httpGetJson } from "../http.mjs";

/** 标题:无 url 的纯讨论帖标记为 (discussion) */
function buildTitle(hit) {
  const t = hit.title || hit.story_title || "(untitled)";
  return hit.url ? t : `${t} [讨论]`;
}

/**
 * HN 搜索。
 * @returns {Promise<{engine:"hn", mode:"direct", blocked:boolean, reason?:string, results:Array}>}
 */
export async function searchHn(query, limit) {
  const perPage = Math.min(limit || 10, 50);
  try {
    const url = `${HN_API}?query=${encodeURIComponent(query)}&hitsPerPage=${perPage}&tags=story`;
    // 统一走 httpGetJson:同域限速/Cookie/超时(HTTP_TIMEOUT_MS)由 http.mjs 管理
    const j = await httpGetJson(url, { headers: { "User-Agent": UA } });
    const hits = j?.hits || [];
    if (hits.length === 0) {
      return { engine: "hn", mode: "direct", blocked: true, reason: "HN 无结果", results: [] };
    }
    const results = hits.map((h) => {
      const text = (h.story_text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
      return {
        title: buildTitle(h),
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        desc: [text, h.points ? `▲ ${h.points} 分` : "", h.num_comments ? `${h.num_comments} 条评论` : "", h.author ? `by ${h.author}` : "", h.created_at ? new Date(h.created_at).toISOString().slice(0, 10) : ""]
          .filter(Boolean)
          .join(" · "),
      };
    });
    return { engine: "hn", mode: "direct", blocked: false, results };
  } catch (e) {
    return { engine: "hn", mode: "direct", blocked: true, reason: (e.message || e).slice(0, 100), results: [] };
  }
}
