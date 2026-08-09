/**
 * engines/hotlist.mjs — 平台热搜榜(微博/抖音/百度/头条),与 cnnews(官方要闻)互补
 *
 * 四榜四种通道形态:
 *  - baidu/toutiao: 官方公开 JSON API,直连即可(HTTP → JSON.parse)
 *  - weibo: 镜像(tophub)直连优先,限流时浏览器渲染官方页(s.weibo.com)
 *  - douyin: 数据由前端签名 API 异步加载,必须浏览器渲染后从 DOM 提取
 *
 * 统一契约:每个榜单的 fetch 函数返回 {name, note, items:[{rank,title,heat,url}]};
 * 失败由 fetchHotlist 捕获,置 error 字段,单榜失败不影响其他榜。
 */

import { httpGet } from "../http.mjs";
import { clean } from "../html.mjs";
import { getDom } from "./browser.mjs";
import { JSDOM } from "jsdom";
import { HOTLIST_WEIBO_WAIT_MS, HOTLIST_DOUYIN_WAIT_MS } from "../config.mjs";

/**
 * 解析微博热搜镜像页(tophub.today)。结构:
 * <tr><td align="center">1.</td><td><a href="...">标题</a></td><td class="ws">115万</td>...</tr>
 */
export function parseWeiboHotlist(html, limit) {
  const out = [];
  const re =
    /<tr>\s*<td align="center">([0-9]+)\.<\/td>\s*<td><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/td>\s*<td class="ws">([^<]+)<\/td>/g;
  let m;
  while ((m = re.exec(html)) && out.length < limit) {
    const title = clean(m[3]);
    if (!title) continue;
    out.push({ rank: Number(m[1]), title, heat: clean(m[4]), url: m[2] });
  }
  return out;
}

/**
 * 解析微博热搜官方页(s.weibo.com/top/summary,浏览器渲染后)。
 * 用 jsdom + querySelector(DOM 提取),对结构变化比正则鲁棒:
 *  - 条目行: tbody > tr,标题在 td.td-02 > a
 *  - 热度: td.td-02 > span(具体数字)与 td.td-03(热/新/沸/爆标记)
 *  - 置顶行 td.td-01 含 icon-top;普通行是排名数字
 */
export function parseWeiboOfficialHtml(html, limit) {
  let doc;
  try {
    doc = new JSDOM(html).window.document;
  } catch {
    return [];
  }
  const out = [];
  for (const tr of doc.querySelectorAll("tbody tr")) {
    if (out.length >= limit) break;
    const a = tr.querySelector("td.td-02 a");
    if (!a) continue;
    const title = (a.textContent || "").replace(/\s+/g, " ").trim();
    if (!title || title.length < 2) continue;
    const td01 = tr.querySelector("td.td-01");
    const isTop = /icon-top/.test(td01?.innerHTML || "");
    // 热度:数字(如 1091514)+ 标记(热/新/沸/爆)
    const parts = [];
    const num = (tr.querySelector("td.td-02 span")?.textContent || "").trim();
    if (num) {
      const n = Number(num.replace(/[^0-9]/g, ""));
      parts.push(Number.isFinite(n) && n >= 10000 ? `${(n / 10000).toFixed(1)}万` : num);
    }
    const mark = (tr.querySelector("td.td-03")?.textContent || "").trim();
    if (mark) parts.push(mark);
    let url = a.href || "";
    if (url.startsWith("/")) url = "https://s.weibo.com" + url;
    if (!/^https?:/.test(url)) continue; // 过滤广告行(href=javascript:void(0))
    out.push({ rank: isTop ? 0 : out.length + 1, title, heat: parts.join(" "), url });
  }
  return out;
}

/**
 * 微博热搜双通道:镜像直连(tophub)优先,失败/为空时浏览器抓官方页。
 * 浏览器兜底需要 chromium;不可用则返回镜像结果(可能为空)。
 */
export async function fetchWeiboHotlist(limit) {
  // 通道一:镜像静态页
  try {
    const html = await httpGet(HOT_BOARDS.weibo.url);
    const items = parseWeiboHotlist(html, limit);
    if (items.length > 0) return { name: "微博热搜", note: "镜像通道", items };
  } catch {
    /* 镜像限流 → 走浏览器 */
  }
  // 通道二:官方页(浏览器)
  const html = await getDom("https://s.weibo.com/top/summary", HOTLIST_WEIBO_WAIT_MS);
  if (!html) throw new Error("浏览器兜底不可用(未安装 chromium)");
  const items = parseWeiboOfficialHtml(html, limit);
  if (items.length === 0) throw new Error("官方页解析命中 0 条(可能被登录墙/结构变更)");
  return { name: "微博热搜", note: "官方页(浏览器)", items };
}

/**
 * 解析头条热榜 JSON(hot-board API):{"data":[{"Title","HotValue","Url","ClusterIdStr"}]}
 * HotValue 为绝对热度,转成"万"显示;URL 清理追踪参数。
 */
export function parseToutiaoHotlist(body, limit) {
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    return [];
  }
  const out = [];
  for (const it of json?.data || []) {
    if (out.length >= limit) break;
    const heat = it.HotValue
      ? it.HotValue >= 10000
        ? `${(it.HotValue / 10000).toFixed(1)}万`
        : String(it.HotValue)
      : "";
    let url = (it.Url || "").split("?")[0];
    if (!url) url = `https://www.toutiao.com/trending/${it.ClusterIdStr || ""}/`;
    out.push({ rank: out.length + 1, title: clean(it.Title || ""), heat, url });
  }
  return out;
}

/**
 * 解析百度热搜 JSON:data.cards[0].content[0].content[] = [{word,index,isTop,url}]
 * 置顶条无 index,标为 rank 0;无热度字段,置顶标"置顶"。
 */
export function parseBaiduHotlist(body, limit) {
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    return [];
  }
  const list = json?.data?.cards?.[0]?.content?.[0]?.content || [];
  const out = [];
  for (const it of list) {
    if (out.length >= limit) break;
    out.push({
      rank: it.isTop ? 0 : it.index,
      title: clean(it.word || ""),
      heat: it.isTop ? "置顶" : "",
      url: it.url || "",
    });
  }
  return out;
}

/**
 * 解析抖音热榜官方页(www.douyin.com/hot,浏览器渲染后)。
 * 数据在混淆 class 的 DOM 里: a[href^="/hot/"] > h3 为词条;URL 为
 * /hot/{id}/{encodeURIComponent(词条)},无热度数字(只有上升箭头图标)。
 */
export function parseDouyinHotlist(html, limit) {
  let doc;
  try {
    doc = new JSDOM(html).window.document;
  } catch {
    return [];
  }
  const out = [];
  for (const a of doc.querySelectorAll('a[href^="/hot/"]')) {
    if (out.length >= limit) break;
    const h3 = a.querySelector("h3");
    if (!h3) continue;
    const title = h3.textContent.replace(/\s+/g, " ").trim();
    if (!title) continue;
    let url = a.getAttribute("href") || "";
    if (url.startsWith("/")) url = "https://www.douyin.com" + url;
    out.push({ rank: out.length + 1, title, heat: "", url });
  }
  return out;
}

/** 抖音热榜:数据由前端签名 API 异步加载,必须浏览器渲染后从 DOM 提取 */
export async function fetchDouyinHotlist(limit) {
  const html = await getDom("https://www.douyin.com/hot", HOTLIST_DOUYIN_WAIT_MS);
  if (!html) throw new Error("浏览器兜底不可用(未安装 chromium)");
  const items = parseDouyinHotlist(html, limit);
  if (items.length === 0) throw new Error("抖音热榜解析命中 0 条(页面结构可能已变更)");
  return { name: "抖音热榜", note: "官方页(浏览器渲染)", items };
}

/** 可用榜单注册表(parse 接收 body 文本;fetch 为可选自定义抓取函数,优先级更高) */
export const HOT_BOARDS = {
  weibo: {
    name: "微博热搜",
    url: "https://tophub.today/n/KqndgxeLl9",
    note: "镜像直连+官方页(浏览器)双通道",
    fetch: fetchWeiboHotlist,
  },
  douyin: {
    name: "抖音热榜",
    url: "https://www.douyin.com/hot",
    note: "官方页(浏览器渲染)",
    fetch: fetchDouyinHotlist,
  },
  baidu: {
    name: "百度热搜",
    url: "https://top.baidu.com/api/board?platform=wise&tab=realtime",
    parse: parseBaiduHotlist,
    note: "官方公开 API",
  },
  toutiao: {
    name: "头条热榜",
    url: "https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc",
    parse: parseToutiaoHotlist,
    note: "官方公开 API",
  },
};

/**
 * 抓取指定平台热榜(单平台失败不影响其他平台)。
 * @param {string} [board] weibo | baidu | toutiao;空 → 全部
 * @returns {Promise<Object<string, {name:string, note:string, items:Array, error?:string}>>}
 */
export async function fetchHotlist(board, limit) {
  const boards = board ? [board] : Object.keys(HOT_BOARDS);
  const out = {};
  for (const b of boards) {
    const cfg = HOT_BOARDS[b];
    if (!cfg) {
      out[b] = {
        name: b,
        note: "",
        items: [],
        error: "未知榜单(可选: " + Object.keys(HOT_BOARDS).join("|") + ")",
      };
      continue;
    }
    try {
      if (cfg.fetch) {
        out[b] = await cfg.fetch(limit);
      } else {
        const body = await httpGet(cfg.url);
        out[b] = { name: cfg.name, note: cfg.note, items: cfg.parse(body, limit) };
      }
    } catch (e) {
      out[b] = { name: cfg.name, note: cfg.note, items: [], error: e.message };
    }
  }
  return out;
}
