/**
 * github.mjs — GitHub 代码仓库搜索(官方 API,匿名 10 req/min 限额内免费)
 *
 * 特点:与通用搜索重叠极低;技术查询的"项目/源码"维度(通用引擎给教程/文档,它给可运行仓库)。
 * 匿名 rate limit 10 次/分钟:聚合一次消耗 1 次,足够;超限失败不影响聚合(由调用方静默跳过)。
 * 可配 GITHUB_TOKEN(或 GH_TOKEN)提升限流(认证后 30 次/分钟)。
 *
 * API: https://api.github.com/search/repositories?q=&per_page=&sort=stars
 */

const GH_API = "https://api.github.com/search/repositories";

import { httpGetJson } from "../http.mjs";

/**
 * GitHub 仓库搜索(按星标排序,取高质量项目)。
 * 查询词缩减:GitHub 对多词查询做 AND 匹配且不拆词,宽泛组合词("learning agent")
 * 或太具体组合("praxy tutor")常 0 结果 —— 依次去掉尾部词重试("praxy tutor" → "praxy"),
 * 首个有结果的候选即返回;限流/非"无匹配"错误不缩减直接返回(避免掩盖真实故障)。
 * @returns {Promise<{engine:"github", mode:"direct", blocked:boolean, reason?:string, results:Array}>}
 */
export async function searchGithub(query, limit) {
  const candidates = [query];
  const words = String(query || "").trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    for (let n = words.length - 1; n >= 1; n--) candidates.push(words.slice(0, n).join(" "));
  }
  for (const q of candidates) {
    const r = await trySearchGithub(q, limit);
    if (r.results.length > 0) return r;
    if (r.blocked && !/无匹配仓库/.test(r.reason || "")) return r; // 限流/网络错误:不缩减,直接报
  }
  return { engine: "github", mode: "direct", blocked: true, reason: "GitHub 无匹配仓库", results: [] };
}

/** 单次 GitHub 查询(候选词) */
async function trySearchGithub(query, limit) {
  const perPage = Math.min(limit || 10, 50);
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  try {
    const url = `${GH_API}?q=${encodeURIComponent(query)}&per_page=${perPage}&sort=stars&order=desc`;
    // 统一走 httpGetJson:同域限速/Cookie/超时(HTTP_TIMEOUT_MS)由 http.mjs 管理
    // 配置 GITHUB_TOKEN 提升匿名 10 req/min 的限额(认证 30 req/min)
    const j = await httpGetJson(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "WebSearchSkill/1.0",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    const items = j?.items || [];
    if (items.length === 0) {
      return { engine: "github", mode: "direct", blocked: true, reason: "GitHub 无匹配仓库", results: [] };
    }
    const results = items.map((r) => {
      const desc = [r.description, `★ ${r.stargazers_count}`, `语言: ${r.language || "?"}`, `Fork ${r.forks_count}`, r.updated_at ? `更新 ${r.updated_at.slice(0, 10)}` : ""]
        .filter(Boolean)
        .join(" · ");
      return {
        title: r.full_name,
        url: r.html_url,
        // 部分仓库把 README/超长内容塞进 description 字段(实测 6.5 万字符),
        // 会拖垮下游 LCS 判定/嵌入/展示;展示与判定都只需前部,截断 512
        desc: desc.length > 512 ? desc.slice(0, 512) + "…" : desc,
      };
    });
    return { engine: "github", mode: "direct", blocked: false, results };
  } catch (e) {
    const m = (e.message || e).toString();
    // 403=rate limit 耗尽,429=限流:给明确原因
    const limitHint = token ? "GitHub API 限额(认证 30 req/min)" : "GitHub API 限额(匿名 10 req/min,可配 GITHUB_TOKEN 提升)";
    const msg = /HTTP 403/.test(m) ? `${limitHint},稍后再试` : m.slice(0, 100);
    return { engine: "github", mode: "direct", blocked: true, reason: msg, results: [] };
  }
}
