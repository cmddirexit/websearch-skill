// llm-judge.mjs — 用 LLM 批量判断搜索结果是否像 SEO 软文/内容农场
//
// 为什么需要:filter.mjs 的 quality 分是"形态可用性分"(有 desc、标题含查询词就高分),
// 软文站形态正常,所以搜索结果学到的 label 全部偏正 → 元学习学到的是主题偏置而非质量模式
// (回测证实:软文站冷启动预测 0.71 > 干净站 0.57,方向性错误)。
// LLM 能直接判断"内容可信度",提供可靠 label 喂给元学习(learnFromResults → metaLabel)。
//
// OpenAI 兼容 API:硅基流动(默认)/ DeepSeek / 任意。配置:
//   WEBSEARCH_LLM_BASE_URL  (默认 https://api.siliconflow.cn/v1)
//   WEBSEARCH_LLM_KEY       (默认读 ~/.pi/agent/auth.json 的 deepseek.key,或 SILICONFLOW_API_KEY 等)
//   WEBSEARCH_LLM_MODEL     (默认 siliconflow 的 deepseek-ai/DeepSeek-V3;用 deepseek 直连时设 deepseek-chat)
//   WEBSEARCH_LLM_OFF=1     (关闭;失败自动降级,不影响主流程)

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "os";
import path from "path";

const DEFAULTS = {
  // 默认 deepseek 直连(auth.json 已有 key,开箱即用);硅基流动/其他 OpenAI 兼容:
  //   WEBSEARCH_LLM_BASE_URL=https://api.siliconflow.cn/v1
  //   WEBSEARCH_LLM_MODEL=deepseek-ai/DeepSeek-V3
  //   WEBSEARCH_LLM_KEY=sk-...
  baseURL: process.env.WEBSEARCH_LLM_BASE_URL || "https://api.deepseek.com",
  model: process.env.WEBSEARCH_LLM_MODEL || "deepseek-v4-flash",
};

function findKey() {
  if (process.env.WEBSEARCH_LLM_KEY) return process.env.WEBSEARCH_LLM_KEY;
  for (const env of ["SILICONFLOW_API_KEY", "SILICONFLOW_KEY", "DEEPSEEK_API_KEY", "OPENAI_API_KEY"]) {
    if (process.env[env]) return process.env[env];
  }
  try {
    const auth = JSON.parse(readFileSync(path.join(homedir(), ".pi/agent/auth.json"), "utf8"));
    if (auth.deepseek?.key) return auth.deepseek.key;
  } catch {}
  return null;
}

let _cfg = null;
export function llmConfig() {
  if (_cfg) return _cfg;
  const key = findKey();
  if (!key) return null;
  _cfg = { baseURL: DEFAULTS.baseURL, model: DEFAULTS.model, key };
  return _cfg;
}

const SOFT_DESC =
  "信息聚合站(如百科/文档/官方)、真实问答社区(知乎/贴吧/论坛)里真人讨论/官方文档不算软文。";

// —— 判断缓存:同 URL+标题 30 天内不重判(agent 常连续搜相似问题,命中则零 LLM 调用) ——
const CACHE_FILE = path.join(homedir(), ".cache", "websearch-llm-judged.json");
const CACHE_MAX = 2000;
const CACHE_TTL_MS = 30 * 86400000;
let _cache = null;
function loadCache() {
  if (_cache) return _cache;
  try { _cache = JSON.parse(readFileSync(CACHE_FILE, "utf8")) || {}; } catch { _cache = {}; }
  return _cache;
}
function cacheKey(r) { return (r?.url || "") + "\u0000" + (r?.title || "").slice(0, 60); }
/** 查询历史判断缓存(供 fetch 复用搜索结果阶段的标题判断) */
export function judgeCacheGet(url, title) {
  const hit = cacheGet({ url, title });
  return hit; // undefined = 无缓存;有则 {s, t, ty?}
}
function cacheGet(r) {
  const c = loadCache();
  const k = cacheKey(r);
  const hit = c[k];
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit; // {s, t, ty?}
  if (hit) delete c[k]; // 过期清理
  return undefined;
}
function cacheSet(r, score, type = "normal") {
  try {
    const c = loadCache();
    c[cacheKey(r)] = { s: score, t: Date.now(), ty: type };
    const keys = Object.keys(c);
    if (keys.length > CACHE_MAX) { // LRU:清最早写入的一半
      const half = keys.slice(0, Math.floor(CACHE_MAX / 2));
      for (const k of half) delete c[k];
    }
    writeFileSync(CACHE_FILE, JSON.stringify(c));
  } catch (e) { console.error(`[llm-judge] 缓存写入失败: ${e.message}`); }
}

let _inFlight = false; // 同一时刻只允许一个进行中的判断(防并发重复调用)

/** 单次 LLM 调用(内部,分片用) */
async function judgeChunk(chunk, cfg) {
  const items = chunk
    .map((r, i) => {
      const d = (r.desc || "").replace(/\s+/g, " ").slice(0, 120);
      const host = (() => { try { return new URL(r.url).host; } catch { return r.url; } })();
      return `${i}. 标题:${r.title || ""}\n   域名:${host}\n   摘要:${d || "(无)"}`;
    })
    .join("\n");
  const prompt = `你是中文搜索引擎质量审核员。判断以下每条搜索结果是不是【低质量内容】,分三类:
1. SEO软文(soft):发稿商批量发布的营销文 —— 标题堆砌"推荐榜/测评/五大平台/口碑/免费下载"等词,摘要空洞重复,目的是引流获客
2. 广告/推广页(ad):落地页/推广页 —— "点击咨询/免费试用/限时优惠/立即购买",无实质内容
3. 低质量AI生成文(ai):AI批量生产的泛泛之谈或拼凑文 —— ①空洞套话:标题吸引眼球、正文空洞无物、无具体数据/代码/案例/细节、通用套话车轱辘话凑字数;②看似信息密集实则编造:堆砌具体数字/人名/流程/政策但无来源可查、内容模板化(典型如期刊投稿指南类页面编造“主编姓名/审稿费/录用率/评审流程”等无法核实的细节)
${SOFT_DESC}
评分规则:0.0=真实可信内容(有实质信息),0.5=普通但中性,1.0=典型低质。可以给 0.1/0.3/0.7 等中间值。
只输出 JSON:{"scores":[每条一个数字,顺序对应],"types":["normal"或"soft"或"ad"或"ai",每条一个]},不要任何解释。

${items}`;
  const resp = await fetch(`${cfg.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      // 推理模型把 token 花在 reasoning_content 上,预算太小 content 会为空 → 加大(便宜模型可承受)
      max_tokens: 8192,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(30000), // 判断任务 30s 内必须返回:慢=放弃(学习是后台增强,不阻塞主流程)
  });
  if (!resp.ok) throw new Error(`LLM ${resp.status} ${(await resp.text()).slice(0, 120)}`);
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content || "";
  if (!text.trim()) throw new Error("LLM 返回空 content(推理 token 耗尽?),reasoning 长度 " + (data?.choices?.[0]?.message?.reasoning_content || "").length);
  const parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ""));
  const scores = parsed.scores;
  if (!Array.isArray(scores)) throw new Error("LLM 返回无 scores: " + text.slice(0, 100));
  const types = parsed.types;
  return chunk.map((_, i) => {
    const s = Number(scores[i]);
    const t = types?.[i];
    return { score: Number.isFinite(s) ? Math.max(0, Math.min(1, s)) : 0.5, type: ["soft", "ad", "ai", "normal"].includes(t) ? t : (Number.isFinite(s) && s >= 0.6 ? "soft" : "normal") };
  });
}

/**
 * 批量判断搜索结果低质可能性(缓存优先 + 分片并发)。
 * 低质三类:SEO软文(soft)/广告页(ad)/低质AI文(ai)。
 * 缓存:同 URL+标题 30 天内不重判(agent 常连续搜相似问题,命中则零 LLM 调用);
 * 并发:未命中项 >12 条时拆片并行(片小推理更快,总耗时接近单片)。
 * @param {Array<{title,url,desc}>} results
 * @param {number} max 单批上限(默认 35)
 * @returns {Promise<number[]|null>} 每条 0(可信)~1(低质) 的分数(数组带 .types 属性);失败/冷却返回 null
 */
export async function judgeResults(results, max = 35) {
  const cfg = llmConfig();
  if (!cfg || process.env.WEBSEARCH_LLM_OFF === "1" || !results?.length) return null;
  if (_inFlight) return null; // 同一时刻只允许一个判断(防并发重复调用)
  const batch = results.slice(0, max);
  const map = new Map();
  const missing = [];
  for (const r of batch) {
    const hit = cacheGet(r);
    if (hit !== undefined) map.set(r.url, { score: hit.s, type: hit.ty || "normal" }); // 旧缓存无 ty,兜底 normal
    else missing.push(r);
  }
  if (missing.length) {
    _inFlight = true;
    try {
      // 分片并发:每片 ≤12 条,最多同时 3 片(片小推理快,总耗时 ≈ 单片)
      const chunks = [];
      for (let i = 0; i < missing.length; i += 12) chunks.push(missing.slice(i, i + 12));
      const resultsArr = await Promise.allSettled(chunks.map((chunk) => judgeChunk(chunk, cfg)));
      missing.forEach((r, i) => {
        const ci = Math.floor(i / 12);
        const got = resultsArr[ci];
        if (got.status === "rejected") console.error(`[llm-judge] 分片 ${ci} 失败: ${got.reason?.message || got.reason}`);
        if (got.status === "fulfilled" && got.value) {
          const item = got.value[i % 12];
          map.set(r.url, item);
          cacheSet(r, item.score, item.type);
        }
      });
    } catch (e) {
      console.error(`[llm-judge] 失败(降级为不用 LLM label): ${e.message}`);
      return null;
    } finally {
      _inFlight = false;
    }
  }
  const scores = batch.map((r) => { const v = map.get(r.url); return v ? v.score : 0.5; });
  scores.types = batch.map((r) => { const v = map.get(r.url); return v ? v.type : "normal"; });
  return scores; // 分数数组(带 .types 属性,调用方可读取类型)
}

/**
 * 单条正文软文判断(fetch 实测用):fetch 成功 ≠ 内容可信 —— 软文正文完整也能打开,
 * 不能因为“能抓到正文”就给正反馈。正文前 snippet 给 LLM 判断是否拼凑软文。
 * @param {string} text 正文文本(截前 600 字即可,内部会截)
 * @param {{title?:string, url?:string}} meta
 * @returns {Promise<number|null>} 0(可信)~1(软文);失败返回 null
 */
export async function judgeText(text, meta = {}) {
  const cfg = llmConfig();
  if (!cfg || process.env.WEBSEARCH_LLM_OFF === "1" || !text?.trim()) return null;
  const snippet = (meta.title ? `标题:${meta.title}\n` : "") + `正文开头:\n${text.replace(/\s+/g, " ").slice(0, 600)}`;
  const prompt = `你是中文内容质量审核员。判断以下文章正文是不是【低质量内容】,分三类:
1. SEO软文(soft):营销推荐文 —— 推荐/测评/排行堆砌、"点击咨询/免费领取/限时优惠"导流
2. 广告/推广页(ad):落地页 —— 推销产品/服务,无实质信息
3. 低质量AI生成文(ai):AI批量生产的泛泛之谈或拼凑文 —— ①空洞套话:通用套话、无具体数据/代码/案例/细节、车轱辘话凑字数、“在当今数字化时代...”式开场;②看似信息密集实则编造:堆砌具体数字/人名/流程但无来源可查、内容模板化(如投稿指南类页面编造无法核实的细节)
${SOFT_DESC}
评分:0.0=真实原创内容(有实质信息),0.5=普通但中性,1.0=典型低质。
只输出 JSON:{"score":0.0~1.0,"type":"normal"或"soft"或"ad"或"ai"},不要解释。

${snippet}`;
  try {
    const resp = await fetch(`${cfg.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 8192,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) throw new Error(`LLM ${resp.status} ${(await resp.text()).slice(0, 120)}`);
    const data = await resp.json();
    const text2 = data?.choices?.[0]?.message?.content || "";
    if (!text2.trim()) throw new Error("LLM 返回空 content");
    const parsed = JSON.parse(text2.replace(/^```json\s*|\s*```$/g, ""));
    const s = Number(parsed.score);
    return Number.isFinite(s) ? Math.max(0, Math.min(1, s)) : null;
  } catch (e) {
    console.error(`[llm-judge] 正文判断失败(降级为温和正反馈): ${e.message}`);
    return null;
  }
}
