# 反爬武器库(ANTIBOT)

本技能的反爬对抗模块体系。**原则:检测单一事实来源、失败分类后再惩罚、降级链逐层可选增强。**

## 模块地图

| 模块 | 职责 | 对付的反爬 |
|------|------|-----------|
| `antiblock.mjs` | **统一检测中心**:`detectAntibot`(HTML 类型识别)+ `isAntibotContent`(内容/消息特征)+ `classifyFetchResult`(抓取三分类) | 所有类型的判定入口 |
| `tls.mjs` | curl-impersonate / curl_cffi 浏览器 TLS 指纹(JA3/JA4) | TLS 握手指纹拦截 |
| `engines/browser.mjs` | 三层浏览器兜底(puppeteer→playwright→chromium CLI)+ stealth + CF 求解 + **UA 版本自动探测** | JS 渲染/验证码/自动化指纹 |
| `http.mjs` | cookie jar / 域限速 / UA 注入 + `tryTlsFallback` 接入 tls.mjs | 基础会话 |
| `cooldown.mjs` | 连续失败 → 冷却期跳过 | 限流 |
| `fetch-page.mjs` | Readability 正文 + **`extractSsrEmbeddedJson`**(js-initialData/__NEXT_DATA__/__INITIAL_STATE__)+ 知乎特例 | SSR 数据隐藏 |
| `domain-rep.mjs` | `learnFetchBlocked`:反爬拦截**中性化**(只记计数不降分) | 信誉系统不被反爬误伤 |
| `config.mjs` | `buildChromeUa(version)` / `buildMobileUa(version)` | UA 版本匹配 |

## 核心原则

1. **检测单一事实来源**:所有反爬特征正则只在 `antiblock.mjs`(cli/browser/fetch 都不许自己写正则)。
2. **失败 ≠ 垃圾**:抓取失败必须三分类后再惩罚 —— `full`(LLM 判可信度)/ `blocked`(反爬,中性)/ `empty`(真空壳,负反馈)。
3. **UA 必须与真实浏览器版本匹配**:知乎实测 Chrome120 UA + Chromium149 → 40362。`browser.mjs` 自动探测版本生成 UA,升级 chromium 无需改代码。
4. **降级链逐层失败继续**:直连 → TLS 指纹兜底 → 存档(archive.org)→ 浏览器(库模式 → CLI)。每层失败静默降级,不误伤信誉。
5. **频率克制**:强风控站连续请求触发 IP 临时封禁。批量场景随机间隔 6~14s,遇 40362 退避 120s。

## 反爬类型 → 对策速查

| 反爬类型 | 识别信号 | 对策 |
|---------|---------|------|
| UA 检测 | 403,换 UA 即好 | UA 版本与真实浏览器**精确匹配**(`buildChromeUa` + 自动探测) |
| TLS 指纹 | 403/握手 RST,换 UA 无效 | `tls.mjs`(curl-impersonate) |
| 登录/会话风控 | 40362 类风控 JSON | 干净浏览器通道(CLI 新 profile + 匹配 UA)+ 低频;终极:登录 cookie(z_c0) |
| 自动化指纹 | CDP/无头特征被识别 | 库模式→CLI 降级(CLI 无 CDP 附加、随机 profile) |
| JS 渲染 | 200 无正文 | `browser.mjs getDom` |
| Cloudflare Turnstile | "Just a moment" | `cf-solver.mjs` + 浏览器 |
| IP 频率限制 | 429/临时全站 403 | `cooldown.mjs` + 随机间隔 |
| SSR 数据隐藏 | DOM 抠不到正文 | `extractSsrEmbeddedJson`(js-initialData 等) |

## 复用接口(库方式)

```js
import {
  detectAntibot,        // html → {type, label} | null(识别反爬类型)
  isAntibotContent,     // text → boolean(统一反爬特征检测)
  classifyFetchResult,  // {body, markdown, metaDesc, title} → {kind: "full"|"blocked"|"empty"}
} from "websearch-skill";

import { httpGetViaImpersonate, isTlsFallbackCandidate } from "websearch-skill"; // TLS 指纹兜底
import { getDom, fetchViaBrowser } from "websearch-skill";                       // 浏览器通道
import { extractSsrEmbeddedJson, extractZhihuInitialData } from "websearch-skill"; // SSR 提取
import { createCooldown } from "websearch-skill";                                 // 失败冷却
```

## 测试

`npm test`(163 用例,含 antiblock 检测/stealth/SSR 提取等)。新增检测特征时同步加用例到
`scripts/lib/tests/unit/browser-stealth.test.mjs`。

## 已知边界

- archive.org 兜底依赖网络可达(CN 网络下常不通,代码保留自动生效)。
- 知乎文章页:未登录 + 干净 CLI + 匹配 UA + 低频可抓(2026-08 实测);批量/高频需登录 cookie。
- `isAntibotContent` 的 `/403/` 会误命中正文数字,使用场景限定"短内容/错误信息/风控页头部",配合长度判定。
