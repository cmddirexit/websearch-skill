/**
 * date-ml.mjs — 发布时间提取:规则候选生成 + 在线学习裁决(传统 ML,非 LLM)
 *
 * 痛点:页面发布时间来源多且互相冲突 —— meta(article:published_time)可能被频道页
 * 元数据误导(国际在线滚动频道 meta 2018-03-28,实际列表 2026-08-07);URL 日期、
 * 正文"发布时间:..."、JSON-LD、JS 变量各执一词。规则拍阈值选一个,选错就错。
 *
 * 设计(规则做候选,ML 做裁决 —— 不训练"从零识别日期"的 NER):
 *   ├─ 候选生成(规则层):meta 多属性名 / JSON-LD / URL 日期段 / 正文上下文 / JS 变量
 *   │    → 每个候选带来源类型 + 上下文特征。规则覆盖率高,格式变化由候选层吸收。
 *   ├─ 列表页识别(逻辑回归):页面是不是列表页(链接密度/有无 article 容器/正文长度/
 *   │    标题频道词/meta 与 URL 日期冲突/时间戳流) → 列表页上 meta 候选大幅降权
 *   ├─ 候选裁决(逻辑回归):加权打分选出最可信候选(来源强度 + 上下文词 + URL 一致性
 *   │    + 时间合理性 + 列表页概率)
 *   └─ 在线学习(弱监督,无需人工标注):
 *        ① 多候选一致性:同页多候选时"多数派日期"≈ 弱 ground truth,选对则权重增强
 *        ② 渲染后验证:浏览器渲染成功的页面,正文出现强规则日期("本文发表于…")
 *        ③ 列表页验证:fetch 列表提取成功/正文达线 → 列表页标签
 *
 * 模型:两个词袋式线性模型(纯 JS 手写,零依赖),per-feature 学习率 + L2 收缩
 * (与 rep-score.mjs 元学习同风格)。冷启动权重 = 规则先验(行为≈现有规则,零回归),
 * 随 fetch 使用在线收敛。持久化 ~/.cache/websearch-date-model.json。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "os";
import path from "path";
import { parseDom, queryAll, elementText } from "./dom.mjs";
import { parseDateFromUrl, normalizeCnDate, extractSerpDate, stripTags } from "./html.mjs";

const MODEL_FILE = path.join(homedir(), ".cache", "websearch-date-model.json");
/** 测试模式(node:test 会设 NODE_TEST_CONTEXT):不读不写模型文件 —— 单测隔离、确定性强,
 * 不会用测试数据污染真实模型(html.test.mjs 的 extractBodyFromHtml 测试会触发 recordFetchOutcome)。 */
const IS_TEST = process.env.NODE_TEST_CONTEXT === "child-v8";

// ==================== 候选生成(规则层) ====================

/** meta 属性名 → 候选来源强度。article:published_time/datePublished 是结构化强信号;
 * 自定义 name=date/pubdate 等较泛,弱一档。 */
const META_DATE_ATTRS = [
  ["article:published_time", "meta-article"],
  ["article:modified_time", "meta-article"],
  ["og:updated_time", "meta-article"],
  ["datePublished", "meta-article"],
  ["dateCreated", "meta-article"],
  ["dateModified", "meta-article"],
  ["date", "meta-generic"],
  ["pubdate", "meta-generic"],
  ["publishdate", "meta-generic"],
  ["publish-date", "meta-generic"],
  ["parsely-pub-date", "meta-generic"],
  ["dc.date", "meta-generic"],
  ["dcterms.created", "meta-generic"],
  ["dcterms.date", "meta-generic"],
];

/** 正文/JS 中"发布时间"强上下文词(候选可信度信号,非提取依据) */
const CTX_STRONG_RE = /发布时间|更新时间|发布于|发表于|刊发|编辑时间|日期|时间[:：]|publish|updated|posted|written on/i;

/**
 * 提取页面全部时间候选(规则层,多来源)。
 * @param {string} html
 * @param {string} url
 * @returns {Array<{date:string, source:string, ctxStrong:boolean}>} date 为 YYYY-MM-DD(已规范化)
 */
export function extractDateCandidates(html, url = "") {
  const cands = [];
  const seen = new Set();
  const add = (date, source, ctxStrong = false) => {
    const d = date || "";
    // 规范化:相对时间(昨天/3小时前)对发布时间无意义(那是 SERP 摘要),正文里也少见,丢弃
    if (!d || !/^20\d{2}-\d{2}-\d{2}$/.test(d)) return;
    const key = `${d}|${source}`;
    if (seen.has(key)) return;
    seen.add(key);
    cands.push({ date: d, source, ctxStrong });
  };
  // 1. meta 标签(property/name/itemprop 三属性名通用匹配)
  const metaRe = /<meta[^>]+(?:property|name|itemprop)=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = metaRe.exec(html)) !== null) {
    const key = m[1].toLowerCase();
    const hit = META_DATE_ATTRS.find(([k]) => k.toLowerCase() === key);
    if (!hit) continue;
    const content = (m[0].match(/content=["']([^"']*)["']/i) || [])[1] || "";
    add(extractSerpDate(content), hit[1]);
  }
  // 2. JSON-LD(datePublished/dateCreated/uploadDate)
  const ldRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = ldRe.exec(html)) !== null) {
    const body = m[1];
    for (const key of ["datePublished", "dateCreated", "uploadDate", "dateModified"]) {
      const dm = body.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
      if (dm) add(extractSerpDate(dm[1]), "jsonld");
    }
  }
  // 3. URL 日期段(新闻站惯例 /2026/0801/、/2026-08-07/、/2026/08-07/)
  add(parseDateFromUrl(url), "url");
  // 4. JS 变量(publishTime/pubDate/createTime/createdAt = "2026-08-07 ...")
  const jsRe = /(?:publishTime|pubDate|createTime|createdAt|issueDate|releaseDate|showTime|pub_time)\s*[:=]\s*["']?(20\d{2}[-\/.]\d{1,2}[-\/.]\d{1,2})/gi;
  while ((m = jsRe.exec(html)) !== null) add(extractSerpDate(m[1]), "js-var");
  // 5. 正文上下文("发布时间:2026-08-07"、"更新于 2026年8月7日"、metaDescription 附近)
  const bodyRe = /(?:发布时间|更新时间|发布于|发表于|刊发时间|编辑时间|日期)[:：]?\s*(20\d{2}[年\/\-.]?\d{1,2}[月\/\-.]?\d{1,2}[日]?)/gi;
  while ((m = bodyRe.exec(html)) !== null) {
    const d = normalizeCnDate(m[1]) || extractSerpDate(m[1]);
    add(d, "body-ctx", true);
    if (cands.filter((c) => c.source === "body-ctx").length >= 3) break; // 防无限
  }
  // 6. 页面时间元素(列表项/时间戳):<time datetime> 与 class 含 time/date 的短文本
  //    —— 滚动频道列表的真实条目时间,列表页上比 meta 可信
  const doc = parseDom(html);
  if (doc) {
    const listTime = [];
    for (const el of queryAll(doc, "time[datetime]")) {
      const d = extractSerpDate(el.getAttribute("datetime") || "");
      if (d) listTime.push(d);
      if (listTime.length >= 10) break;
    }
    if (listTime.length < 10) {
      for (const el of queryAll(doc, "[class*='time'],[class*='date'],[class*='Time'],[class*='Date']")) {
        const t = elementText(el).trim();
        if (t && t.length <= 30) {
          const d = extractSerpDate(t);
          if (d) listTime.push(d);
        }
        if (listTime.length >= 15) break;
      }
    }
    for (const d of listTime) add(d, "list-time");
  }
  return cands;
}

// ==================== 页面特征(列表页识别) ====================

/**
 * 页面级特征(列表页/文章页判别)。全部数值化,供逻辑回归。
 * @param {string} html
 * @param {string} url
 * @param {number} bodyLen 已提取正文长度(0 表示提取失败)
 * @param {string} title
 * @returns {Object} 特征名 → 数值
 */
export function extractPageFeatures(html, url = "", bodyLen = 0, title = "") {
  const feats = {};
  const doc = parseDom(html);
  if (!doc) {
    // 解析失败:退回保守默认(全 0)
    return { linkDensity: 0, hasArticle: 0, bodyShort: 1, bodyMed: 0, titleChannel: 0, metaUrlConflict: 0, tsStream: 0 };
  }
  // 链接密度:a 标签数 / 千字符文本(列表页链接多文本少 → 密度高)
  const anchors = queryAll(doc, "a[href]");
  const textLen = stripTags(html).length || 1;
  feats.linkDensity = Math.min(2, anchors.length / Math.max(1, textLen / 1000));
  // 文章容器:<article>/<main> 存在 = 文章页强信号
  feats.hasArticle = queryAll(doc, "article, main").length > 0 ? 1 : 0;
  // 正文长度分桶(0=提取失败/短壳,<220 短壳,220-1200 中等,>1200 长文)
  feats.bodyShort = bodyLen < 220 ? 1 : 0;
  feats.bodyMed = bodyLen >= 220 && bodyLen < 1200 ? 1 : 0;
  // 标题频道词(频道/滚动/列表/首页/栏目/热点/新闻…)
  feats.titleChannel = /频道|滚动|列表|首页|栏目|热点|新闻|直播|快讯|channel|news|index|archive|list/i.test(title || "") ? 1 : 0;
  // meta 日期与 URL 日期冲突(相差 >30 天 = meta 可能是频道页元数据)
  const metaDates = (html.match(/<meta[^>]+(?:property|name|itemprop)=["'](?:article:published_time|datePublished|date)["'][^>]*>/gi) || [])
    .map((s) => (s.match(/content=["']([^"']*)["']/i) || [])[1])
    .map((d) => extractSerpDate(d))
    .filter(Boolean);
  const urlDate = parseDateFromUrl(url);
  if (urlDate && metaDates.length) {
    const diff = Math.abs(new Date(metaDates[0]).getTime() - new Date(urlDate).getTime()) / 86400000;
    feats.metaUrlConflict = diff > 30 ? 1 : 0;
  } else {
    feats.metaUrlConflict = 0;
  }
  // 时间戳流(滚动频道常见:正文是 "YYYY-MM-DD HH:MM" 序列)
  const ts = html.match(/20\d{2}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}/g);
  feats.tsStream = ts && ts.length >= 3 ? 1 : 0;
  return feats;
}

// ==================== 模型(纯 JS 逻辑回归,在线学习) ====================

/** 线性模型:sigmoid 二分类。w 特征权重,bias 偏置。 */
function makeModel(initW = {}, bias = 0) {
  return { w: { ...initW }, bias, samples: 0 };
}

/** 预测概率 p ∈ (0,1) */
export function predictLinear(features, model) {
  let z = model?.bias || 0;
  for (const [k, v] of Object.entries(features || {})) z += (model?.w?.[k] || 0) * Number(v || 0);
  return 1 / (1 + Math.exp(-z));
}

/** 在线更新:残差 err = label − pred,梯度下降 w += lr×err×v;bias += lr×err。
 * 与 rep-score 的 updateMetaTokens 同风格(无 L2 收缩 —— 特征数少且固定,不会过拟合稀疏)。 */
export function updateLinear(model, features, label, lr = 0.1) {
  const pred = predictLinear(features, model);
  const err = Math.max(-1, Math.min(1, label - pred));
  model.samples = (model.samples || 0) + 1;
  for (const [k, v] of Object.entries(features || {})) {
    const val = Number(v || 0);
    if (val !== 0) model.w[k] = (model.w[k] || 0) + lr * err * val;
  }
  model.bias = (model.bias || 0) + lr * err;
  return pred;
}

// ==================== 模型实例 + 冷启动规则先验 ====================

/**
 * 候选打分特征:来源独热 + 上下文/列表页惩罚。
 * 注意:页面级特征(hasArticle/bodyShort/linkDensity…)在"同页候选 argmax"里对所有
 * 候选同值 → 相互抵消,不参与排序(仅列表页判别模型用)。唯一区分候选的是:
 *   src 来源、ctxStrong 强语境词、listPenalty(仅 meta 类候选在列表页上降权)。
 */
function candFeatures(cand, listProb, urlDate) {
  const f = {};
  f[`src:${cand.source}`] = 1;
  if (cand.ctxStrong) f.ctxStrong = 1;
  // 列表页上 meta 类日期是频道页元数据(如国际在线滚动频道 meta 2018-03-28),
  // 不是页面真实时间 —— 只有 meta 类候选吃这个惩罚,url/list-time 不受影响
  if (/^meta-/.test(cand.source) && listProb > 0.3) f.listPenalty = listProb;
  // URL 日期冲突:非 url 候选与 URL 日期相差 >30 天 → 可疑
  // (meta 可能是 CMS 缓存/频道页元数据;真实文章场景 URL 日期与 meta 通常一致)。
  // 体上下文(body-ctx,“本文发表于…”)因 ctxStrong 加分可压过此惩罚 —— 正文说什么时候就是什么时候。
  if (urlDate && cand.source !== "url") {
    const diff = Math.abs(new Date(cand.date).getTime() - new Date(urlDate).getTime()) / 86400000;
    if (diff > 30) f.urlConflict = 1;
  }
  return f;
}

/** 冷启动先验权重:规则共识(meta-article>jsonld>list-time>url>body-ctx>js-var>meta-generic) */
const CAND_INIT_W = {
  "src:meta-article": 0.7,
  "src:jsonld": 0.55,
  "src:list-time": 0.45,
  "src:url": 0.35,
  "src:body-ctx": 0.25,
  "src:js-var": 0.15,
  "src:meta-generic": 0.1,
  ctxStrong: 0.4,
  listPenalty: -1.2,
  urlConflict: -0.9,
};
/** 列表页判别先验:链接密度/时间戳流/短壳/频道标题/冲突 → 列表;article 容器 → 文章 */
const LIST_INIT_W = {
  linkDensity: 0.6,
  hasArticle: -1.0,
  bodyShort: 0.4,
  bodyMed: -0.2,
  titleChannel: 0.5,
  metaUrlConflict: 0.6,
  tsStream: 0.7,
};

let _model = null;
function getModel() {
  if (_model) return _model;
  _model = { list: makeModel(LIST_INIT_W, -0.5), cand: makeModel(CAND_INIT_W, 0.1), updatedAt: Date.now(), savedAt: 0 };
  if (IS_TEST) return _model; // 测试模式:不加载真实模型,用冷启动先验
  try {
    if (existsSync(MODEL_FILE)) {
      const j = JSON.parse(readFileSync(MODEL_FILE, "utf8"));
      if (j.list) _model.list = { w: { ...LIST_INIT_W, ...(j.list.w || {}) }, bias: j.list.bias ?? -0.5, samples: j.list.samples || 0 };
      if (j.cand) _model.cand = { w: { ...CAND_INIT_W, ...(j.cand.w || {}) }, bias: j.cand.bias ?? 0.1, samples: j.cand.samples || 0 };
    }
  } catch {
    /* 模型文件损坏 → 用先验 */
  }
  return _model;
}

let _dirty = false;
export function saveDateModel() {
  const m = getModel();
  if (IS_TEST) return; // 测试模式不落盘
  if (!_dirty) return;
  try {
    mkdirSync(path.dirname(MODEL_FILE), { recursive: true });
    writeFileSync(MODEL_FILE, JSON.stringify({ version: 1, updatedAt: Date.now(), list: m.list, cand: m.cand }));
    _dirty = false;
  } catch {
    /* 写失败不影响主流程 */
  }
}
process.on("exit", saveDateModel); // CLI 短跑进程退出前落盘(与 cookie jar 同模式)

// ==================== 裁决 + 学习 ====================

/**
 * 发布时间裁决:规则快速路径优先,冲突/可疑时 ML 打分。
 * @param {string} html
 * @param {string} url
 * @param {{bodyLen?:number, title?:string}} [opts]
 * @returns {{date:string, source:string, confidence:number, isList:boolean, cands:Array}}
 */
export function pickDate(html, url = "", opts = {}) {
  const cands = extractDateCandidates(html, url);
  const feats = extractPageFeatures(html, url, opts.bodyLen || 0, opts.title || "");
  const model = getModel();
  const listProb = predictLinear(feats, model.list);
  if (cands.length === 0) return { date: "", source: "none", confidence: 0, isList: listProb > 0.55, cands: [] };
  // 列表页上只有 meta 类候选:meta 是频道页元数据(2018-03-28 类误导),宁缺毋错
  if (listProb > 0.55 && cands.every((c) => /^meta-/.test(c.source))) {
    return { date: "", source: "none", confidence: 0, isList: true, cands };
  }
  // 规则快速路径:唯一候选且是 meta-article/jsonld 强信号 + 页面不像列表页 → 直接采用(零 ML 开销)
  if (cands.length === 1 && /^(meta-article|jsonld)$/.test(cands[0].source) && listProb < 0.45) {
    return { date: cands[0].date, source: cands[0].source, confidence: 0.9, isList: false, cands };
  }
  // ML 裁决:逐候选打分,取最高(同页候选同页面特征,仅 src/ctxStrong/listPenalty/urlConflict 区分)
  const urlDate = cands.find((c) => c.source === "url")?.date || "";
  let best = null;
  let bestScore = -Infinity;
  for (const c of cands) {
    const s = predictLinear(candFeatures(c, listProb, urlDate), model.cand);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  // 弱监督学习:多候选一致性 —— 多数派日期作弱 ground truth,选对增强/选错削弱
  if (cands.length >= 2) {
    const tally = new Map();
    for (const c of cands) tally.set(c.date, (tally.get(c.date) || 0) + 1);
    const consensus = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    if (consensus && consensus[1] >= 2 && best) {
      const label = best.date === consensus[0] ? 1 : 0;
      updateLinear(model.cand, candFeatures(best, listProb, urlDate), label, 0.08);
      _dirty = true;
    }
  }
  return {
    date: best?.date || "",
    source: best?.source || "none",
    confidence: bestScore,
    isList: listProb > 0.55,
    cands,
  };
}

/**
 * fetch 实测反馈(强信号,固定大学习率):页面最终形态 → 列表页标签。
 * 直连/浏览器成功路径调用(握着 html + 结果)。
 * @param {string} url
 * @param {string} html 原始/渲染后 HTML
 * @param {{isList?:boolean, listCount?:number, body?:string, markdown?:string}} result
 */
export function recordFetchOutcome(url, html, result = {}) {
  if (!html) return;
  const model = getModel();
  // bodyLen 优先(列表页结果传提取前正文长度 —— 短壳特征才对);普通文章未显式
  // 传 bodyLen 时必须取正文字符数,不能对正文字符串做 Number() 而恒变成 0。
  const bodyLen = result?.bodyLen !== undefined
    ? Math.max(0, Number(result.bodyLen) || 0)
    : String(result?.markdown || result?.body || "").trim().length;
  const feats = extractPageFeatures(html, url, bodyLen, "");
  // 列表页标签:① 结果明确 isList 且条目达标 → 确为列表页;
  // ② 正文达线(≥200)且列表条目不足 3 → 文章页(不受模型 isList 猜测影响,
  // 打破“模型误判列表 → 无纠正信号”的自我强化回路)。
  let label = null;
  if (result?.isList && (result.listCount || 0) >= 3) label = 1;
  else if (bodyLen >= 200 && (result?.listCount || 0) < 3) label = 0;
  if (label !== null) {
    updateLinear(model.list, feats, label, 0.15);
    _dirty = true;
  }
  // 渲染后正文日期验证:正文出现强规则日期("本文发表于…")→ 对所有候选做监督。
  // 只给当前选择记一次样本无法强化正确候选,也无法压低同页错误来源。
  const strong = html.match(/(?:本文发表于|文章发布时间|发布于|发表于)[:：]?\s*(20\d{2}[年\/\-.]?\d{1,2}[月\/\-.]?\d{1,2}[日]?)/);
  if (strong) {
    const gt = normalizeCnDate(strong[1]) || extractSerpDate(strong[1]);
    const cands = extractDateCandidates(html, url);
    if (gt && cands.length >= 1) {
      const listProb = predictLinear(feats, model.list);
      const urlDate = cands.find((c) => c.source === "url")?.date || "";
      let matched = false;
      for (const cand of cands) {
        const correct = cand.date === gt;
        matched ||= correct;
        updateLinear(model.cand, candFeatures(cand, listProb, urlDate), correct ? 1 : 0, 0.08);
      }
      // 若强规则日期未被候选生成覆盖,仍记录一次漏召回样本供诊断。
      if (!matched) model.cand.samples = (model.cand.samples || 0) + 1;
      _dirty = true;
    }
  }
}

/** 诊断:模型当前权重(维护/测试用) */
export function inspectDateModel() {
  const m = getModel();
  return {
    list: { bias: m.list.bias, samples: m.list.samples, w: { ...m.list.w } },
    cand: { bias: m.cand.bias, samples: m.cand.samples, w: { ...m.cand.w } },
    file: MODEL_FILE,
  };
}

/** 测试钩子:重置为冷启动先验(不写盘) */
export function resetDateModel() {
  _model = { list: makeModel(LIST_INIT_W, -0.5), cand: makeModel(CAND_INIT_W, 0.1), updatedAt: Date.now(), savedAt: 0 };
  _dirty = false;
}
