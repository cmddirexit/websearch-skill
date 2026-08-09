---
name: websearch
description: 网络搜索与网页正文提取。支持 bing(中文/英文通用)、baidu(中文)、sogou(中文)、sogou-wechat(微信公众号文章)、so360(360搜索·中文)、sm(神马搜索·中文)、toutiao(头条搜索·中文)、marginalia(英文独立索引)、hn(Hacker News 技术讨论)、github(代码仓库)、wikipedia(英文百科)、searx(SearXNG 聚合含 Google)、cnnews(官方新闻源)、chinaso(中国搜索·官方 JSON API)十四个搜索引擎,无需 API key。搜索返回结构化结果(标题/摘要/链接),fetch 命令提取网页正文。直连被反爬时自动走降级链(含 Chromium 浏览器兜底——searx/ddg/mojeek/yandex 等验证页实测只有无头浏览器能过)。适用于实时信息、新闻、技术文档、价格行情等任何网络检索需求。详细文档见同目录 README.md。
metadata:
  license: MIT
---

# WebSearch(网络搜索 + 正文提取)

搜索 + 正文提取一体。**详细文档(引擎/降级链/聚类原理/调参/测试)见同目录 README.md**,本文件只放 agent 日常速查。

## 常用命令

```bash
# 搜索:默认多引擎聚合 99 条,自动过滤广告、聚类去重、质量排序
node scripts/websearch.mjs search "查询词"
# 指定引擎(仅在特殊需求时:中文 baidu / 英文 bing / 官方新闻 cnnews / 代码 github / 百科 wikipedia)
node scripts/websearch.mjs search "查询词" --engine baidu
# 时效过滤:只要最近 1 周/1 月/1 年的结果(剔除旧闻/资料/模板,如"国内外大事件")
node scripts/websearch.mjs search "国内外大事件" --since 1w
# 正文提取:返回 Markdown(标题层级/链接/表格保留,含发布时间)
node scripts/websearch.mjs fetch "https://example.com/article" [--max 3000]
# 频道/滚动列表页(中新网首页、国际在线滚动等):自动输出新闻链接列表(标题+日期+URL),不再空壳
# 复杂事件时间线(美伊冲突等分散多篇报道):自动聚合搜索+抓取+按时间排序
node scripts/websearch.mjs timeline "美伊冲突" [--limit 8]
# 展开上次搜索被折叠的低相关结果
node scripts/websearch.mjs reveal
# 辅助:平台热搜榜 / GitHub 热门项目
node scripts/websearch.mjs hotlist [weibo|douyin|baidu|toutiao] [--limit N]
node scripts/websearch.mjs trending [daily|weekly|monthly] [--limit N]
```

## 复杂事件/多篇报道 → 用 timeline(重要)

单次搜索 + 单篇 fetch 只能看到孤点。**美伊冲突、地区局势这类事件分散在多篇报道里(数月跨度),
用 `timeline` 自动串时间线**:聚合搜索 → 并行抓取关键文章 → 提取发布时间+要点 → 按月分组输出。
```bash
node scripts/websearch.mjs timeline "美伊冲突" --limit 8
```
时间线有日期的按时间升序,无日期的单列(URL 不丢);抓取有全局预算(75s),手机上不会拖几分钟。

## agent 使用规则

- 默认搜索拉满(99 条聚合),**不要手动加 `--limit`**;确需更少结果时才传
- 每个问题搜索 **1-2 次**,不要重复搜同一主题
- 结果不够详细时用 `fetch` 深挖具体 URL,而非重新搜索
- **找近期新闻/大事时加 `--since 1w|1m`**:硬剔除旧闻、资料、模板(豆丁/高考时政/PPT 类),
  比默认的"旧文沉底"更彻底;无日期结果保守保留(无法判断不误杀)
- **复杂事件(冲突/局势/连续剧式事件)用 `timeline` 串时间线**,不要逐篇 fetch
- **默认不指定引擎**:自动聚合 bing+baidu+sogou+sogou-wechat+so360+sm+toutiao+marginalia+hn+github+wikipedia 共 11 引擎;
  只有特殊需求才传 `--engine`(cnnews 官方新闻白名单 / github 代码 / wikipedia 百科 / hn 技术讨论),不要因为"中文"或"英文"指定引擎
- 聚类输出看前几个簇即可;低相关折叠区用 `reveal` 展开,URL 永不丢

## 浏览器兜底(自动,常见疑问)

- **报"浏览器兜底不可用"≠ 浏览器没装**:已区分两种情况 —— 未装 Chromium 才会提示安装;
  已装但被站点反爬(403/验证码/40362 风控)时提示"Chromium 已装,但未取得正文(具体原因)",
  这是站点问题不是环境问题,换出口 IP 或稍后再试即可
- **空壳自动列表化**:正文提取不足(版权壳/SPA 壳)但页面含新闻链接时,直接输出链接列表,
  不白跑浏览器兜底(中新网等站点浏览器也被反爬)
- **SPA 懒加载("正在加载"壳)**:自动识别为残缺 → 浏览器渲染后重试,拿到完整正文才返回
- 诊断: `grep '[degrade]'` 看降级日志(现在带失败原因);浏览器细节在 `~/.cache/websearch-browser-debug.log`

## 发布时间提取(ML 自动裁决,无需手动操作)

- 规则提取多候选(meta/URL/正文/JSON-LD/JS 变量/列表时间元素),**在线学习模型裁决**选最可信
  (纯 JS 感知机,非 LLM,零额外成本):频道页 meta 误导(2018-03-28 类)会被列表页识别压掉
- 列表页输出最新条目日期;真文章页输出正文发布时间;拿不到时省略(不误导)
- 模型持久化 `~/.cache/websearch-date-model.json`,随 fetch 使用在线收敛,无需清理

## 域名信誉系统(自动,无需手动操作)

- 每次搜索自动学习域名自身信誉;跨域 token 模式只从显式 LLM 判断或 fetch 等独立证据学习,持久化在
  `~/.cache/websearch-domain-rep.json`(跨进程积累,无需清理)
- 学习信号:默认本地 quality/低质标记只更新当前域名,不反训跨域 token(避免目标泄漏);
  LLM 内容可信度判断是显式选择的跨域模式增强功能
  (`WEBSEARCH_LLM_ENABLED=1` + `WEBSEARCH_LLM_PROVIDER=...`),未启用时不会外发搜索摘要或正文片段;
  fetch 实测为最强信号
- 结果里出现的 `⚠[rep:0.31]`/`✓[rep:0.82]`/`[meta:0.71]` 是信誉 badge
  (低信誉/高信誉/新域名冷启动预测)—— 低信誉仅软降权(排序靠后),**不剔除**

### agent 如何使用信誉 badge(重要)

- **`⚠[rep:≤0.35]` 低信誉**:该域名被反复判为软文/低质 —— **不要当作事实来源引用**;
  若信息重要且仅此一处,可 fetch 验证,但引用时保持存疑
- **`✓[rep:≥0.65]` 高信誉**:该域名历史内容质量稳定 —— 优先深挖、可放心引用
- **`[meta:x.xx]` 冷启动预测**:新域名,无自身样本,模式预测分 —— 仅供参考,
  不可靠时以 fetch 实测为准
- **无 badge**:域名信誉中性或样本不足 —— 按内容正常判断
- **主动教学**:发现一个坏站(404/空壳/拼凑软文)或好站,直接 `fetch` 它 ——
  系统记住,跨会话生效(下次搜索/下次会话的 agent 都继承这个知识)
- 低信誉结果仍会出现在结果里(软降权不剔除),靠 badge + 排序识别,不要完全忽略
  其存在(折叠区可 `reveal` 展开)

- 诊断: `node scripts/backtest-meta.mjs` 查看模式学到什么词(正/负权重)

## 调试 / 测试(维护者用)

- 降级日志:输出里 `grep '[degrade]'`
- 常用配置:复制 `websearch.config.example.json` 为 `websearch.config.json`;优先级为命令行 > 环境变量 >
  用户配置 > 内置默认值。密钥只放环境变量/`.env.json`,默认搜索上限固定 99
- 算法调参:`scripts/lib/config.mjs`(全量参数表见 README「配置与环境变量」)
- 测试:`cd ~/.pi/agent/skills/websearch && npm test`
- 站点改版回归:`npm run fixtures` 重抓真实页快照,仍失败则更新解析器

## 更多

- 原理与边界(聚类算法/语言污染检测/反爬三层防线/已知局限):README.md
- 作为库复用:`import { searchBaidu, fetchPage, clusterResults } from "websearch-skill"`(README「作为库复用」)
- 浏览器兜底安装(Termux):`pkg install x11-repo && pkg install chromium`(README「浏览器兜底」)
