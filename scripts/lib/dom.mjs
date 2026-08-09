/**
 * dom.mjs — DOM 解析辅助层(linkedom)
 *
 * 对齐业界主流做法(SearXNG 的 eval_xpath/extract_text、Whoogle 的 BeautifulSoup):
 *  - 结构定位用 CSS 选择器(queryOne/queryAll),不用正则匹配 HTML 标签
 *  - 文本提取用 DOM 遍历(elementText),正则只保留文本清洗(html.mjs clean)
 *
 * 各引擎的 parse 函数从"正则解析"迁移到本层:如 bing 的
 *   `<h2[^>]*>...<a...>` 正则 → `queryOne(block, "h2 a")`
 * 抗属性顺序/嵌套变化,站点改版时只需改选择器。
 *
 * 注意:linkedom 对部分复杂 CSS 选择器支持有限(伪类等),queryOne/queryAll
 * 内部 try/catch 兜底返回 null/[],调用方按"无匹配"降级即可。
 */
import { parseHTML } from "linkedom";

/** 解析 HTML → linkedom document;畸形/空 HTML 返回 null(调用方自行降级) */
export function parseDom(html) {
  if (!html || typeof html !== "string") return null;
  try {
    return parseHTML(html).document;
  } catch {
    return null;
  }
}

/** 元素可见文本:只收集 TEXT_NODE,避免 linkedom 的 textContent 混入
 * href/aria-label 等属性值(实测 tilk 链接 textContent 含 "https://...") */
export function elementText(el) {
  let out = "";
  for (const node of el?.childNodes || []) {
    if (node.nodeType === 3) out += node.textContent; // TEXT_NODE
    else if (node.nodeType === 1 && !/^(script|style)$/i.test(node.tagName || "")) out += elementText(node);
  }
  return out;
}

/** 查询首个匹配元素;无匹配/选择器不支持 → null */
export function queryOne(root, selector) {
  try {
    return root?.querySelector(selector) || null;
  } catch {
    return null;
  }
}

/** 查询全部匹配元素(数组);无匹配/选择器不支持 → [] */
export function queryAll(root, selector) {
  try {
    return root?.querySelectorAll ? Array.from(root.querySelectorAll(selector)) : [];
  } catch {
    return [];
  }
}

/**
 * 兼容字符串/DOM 元素输入:字符串先 parseDom(单测与调用方都可能传字符串)。
 * 单测直接传 HTML 字符串的解析辅助函数用(如 extractBlockTitle/extractMarginaliaDesc)。
 * @returns {Document|null} 字符串解析失败返回 null
 */
export function asElement(input) {
  return typeof input === "string" ? parseDom(input) : input || null;
}

/**
 * parseDom + 空结果兜底:特异性解析器解析畸形 HTML 时返回空结果,
 * 让 parseSerp 判据自动降级到通用层(层②③),不中断解析链。
 * @param {string} html
 * @param {*} fallback 解析失败时返回的值(默认 {blocked:false, results:[]})
 */
export function parseDomOr(html, fallback = { blocked: false, results: [] }) {
  return parseDom(html) || fallback;
}
