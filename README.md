---
name: websearch
description: 网络搜索与网页正文提取。支持 bing(中文/英文通用)、baidu(中文)、sogou(中文)、sogou-wechat(微信公众号文章)、so360(360搜索·中文)、sm(神马搜索·中文)、toutiao(头条搜索·中文)、marginalia(英文独立索引)、hn(Hacker News 技术讨论)、github(代码仓库)、wikipedia(英文百科)、searx(SearXNG 聚合含 Google)、chinaso(中国搜索·官方 JSON API)十三个搜索引擎,无需 API key。搜索返回结构化结果(标题/摘要/链接),fetch 命令提取网页正文。直连被反爬时自动走降级链(含 Chromium 浏览器兜底——searx/ddg/mojeek/yandex 等验证页实测只有无头浏览器能过)。适用于实时信息、新闻、技术文档、价格行情等任何网络检索需求。内置浏览器检查模式 inspect(DevTools 子集:执行 JS/查元素/监听网络/看 console/截图),复用 stealth + 版本匹配 UA,强风控站(知乎等)检查结果与真实浏览器一致。
metadata:
  license: MIT
---

# WebSearch(网络搜索 + 正文提取)

模块化结构,直连为主,Chromium 浏览器为可选兜底(三层: puppeteer-core → playwright → chromium CLI);
正文提取用 Mozilla 官方 Readability(Firefox 阅读模式同款)+ jsdom,解析失败自动回退自研正则。

**给 agent 的三句话**:直接运行 `node scripts/websearch.mjs search "查询词"` 即可,默认返回 99 条(多引擎聚合拉满)、自动过滤广告/垃圾、聚类输出;不要手动加 `--limit`,确需更少结果时才传。结果不够详细时用 `fetch` 深挖 URL,不要重复搜索。

## 目录

- [快速上手(agent 必读)](#快速上手agent-必读)
- [输出与结果处理流水线](#输出与结果处理流水线)
- [引擎与降级链](#引擎与降级链)
- [浏览器兜底](#浏览器兜底)
- [反爬与礼貌爬取](#反爬与礼貌爬取)(完整武器库见 [docs/ANTIBOT.md](docs/ANTIBOT.md))
- [降级日志约定](#降级日志约定)
- [作为库复用](#作为库复用)
- [扩展新引擎](#扩展新引擎)
- [测试](#测试)
- [配置与环境变量(调参索引)](#配置与环境变量调参索引)
- [维护者笔记](#维护者笔记)

---

## 快速上手(agent 必读)

### 搜索

```bash
# 默认:bing + 多引擎聚合,99 条目标上限,聚类输出
node scripts/websearch.mjs search "查询词"
# 指定引擎 / 平铺输出 / 强制语义或短语聚类
node scripts/websearch.mjs search "查询词" [--engine bing|baidu|cnnews|...] [--flat] [--semantic|--no-semantic] [--since 24h|1w|1m|1y]
```

- **默认 99 条**:多引擎聚合尽量拉满(单引擎单页硬限 ~10 条,99 是目标上限,实际以去重后可得为准)
- **默认聚类**:两阶段流水线 —— ① 规则过滤广告/垃圾 ② 主题聚类,agent 直接看前几个簇即可
- `--flat` 平铺原始结果(关闭聚类与过滤展示,兼容旧输出)
- `--semantic` 强制语义嵌入聚类(不可用时报错提示回退)、`--no-semantic` 强制短语模式

### 正文提取

```bash
node scripts/websearch.mjs fetch "https://example.com/article" [--max 3000]
```

输出 Markdown(标题层级/链接/表格/代码块保留),含 `⏱ 发布时间` 字段。

**发布时间 = 规则候选 + 在线学习裁决**(date-ml.mjs,传统 ML 非 LLM):规则提取多候选
(meta `article:published_time` / JSON-LD / URL 日期段 / 正文“发布时间:…”/ JS 变量 / 列表时间元素),
轻量感知机模型按来源强度+上下文+列表页概率裁决选最可信 —— 频道页 meta 误导(国际在线滚动频道
meta 2018-03-28 但实际列表 2026-08-07)会被列表页识别压掉,宁缺毋错。模型持久化
`~/.cache/websearch-date-model.json`,随 fetch 使用在线收敛(多候选一致性/渲染后验证/列表页形态三重弱监督)。

**频道/滚动/列表页自动输出链接列表**(extractLinkList,DOM 遍历非正则):正文不足(版权壳 127 字符/
SPA 壳/时间戳流)但页面含 ≥3 条新闻链接时,直接输出 `- 日期 [标题](URL)` 列表,发布时间=列表最新条目 ——
不再白跑浏览器兜底(中新网等站点浏览器同样被反爬),解决“频道页只返回版权声明/时间戳”。

**SPA 懒加载壳**(央视网“正在加载”等):正文短且含占位标记 → 自动判残缺,浏览器渲染后重试,拿到完整正文才返回。

**知乎文章页走 SSR 数据槽提取**(`extractZhihuInitialData`,基于通用 `extractSsrEmbeddedJson`):正文 HTML 藏在
`js-initialData` 的 `initialState.entities.articles[].content`,结构化字段(标题/赞/评论/日期)齐全,
比 Readability 抠 DOM 稳。实测 2026-08:未登录 + 干净 chromium CLI + 版本匹配 UA + 低频单次即可抓取
(直连 403 时自动走存档 → 浏览器兜底链)。

### 浏览器检查模式(DevTools 能力子集)

```bash
node scripts/inspect.mjs "<url>" [--js "code"] [--select "sel"] [--network] [--console] [--cookies] [--screenshot out.png]
```

像 DevTools 一样打开页面做交互式检查:执行任意 JS、查元素 outerHTML、监听网络请求、看 console 日志、取 cookie/localStorage、整页截图。复用反爬基建(stealth 注入 + 版本匹配 UA),强风控站(知乎等)检查结果与真实浏览器一致;`--js` 可提取 SSR 内嵌数据(js-initialData/__NEXT_DATA__)或调试反爬页为何被拦。

### 折叠查看

```bash
node scripts/websearch.mjs reveal   # 展开上次搜索被折叠的低相关结果
```

### 辅助命令

```bash
# 时效过滤(--since 对全部引擎生效,非仅 chinaso):超窗且带日期的结果硬剔除
# 解决“国内外大事件”混入 2018-2023 旧闻/高考时政资料/PPT 模板;无日期结果保守保留
node scripts/websearch.mjs search "国内外大事件" --since 1w

# 时间线:复杂事件(美伊冲突等)分散多篇报道,自动串成时间线
# 聚合搜索 → 并行抓取关键文章 → 提取发布时间+要点 → 按月分组输出(抓取预算 75s)
node scripts/websearch.mjs timeline "美伊冲突" --limit 8

# 时效新闻:中国搜索官方 API 时间过滤(24h/1w/1m/1y,结果带新闻来源+日期,首条即最新)
node scripts/websearch.mjs search "北京" --engine chinaso --since 24h --limit 5

# 官方新闻源(人民网/共产党员网),结果带日期、默认只留 30 天内;空查询=今日最新要闻
node scripts/websearch.mjs search "习近平" --engine cnnews --limit 10
node scripts/websearch.mjs search "" --engine cnnews --limit 12

# 平台热搜榜(微博/抖音需 chromium 渲染)
node scripts/websearch.mjs hotlist [weibo|douyin|baidu|toutiao] [--limit N]

# GitHub 热门项目(daily|weekly|monthly,默认 daily,limit 默认 15)
node scripts/websearch.mjs trending [daily|weekly|monthly] [--limit N]
```

### 使用规则

- 默认搜索 99 条(多引擎聚合拉满),调用时**不要手动加 `--limit`**;确需更少结果时才传
- 每个用户问题搜索 1-2 次,不要重复搜同一主题
- 结果不够详细时用 `fetch` 深挖具体 URL,而非重新搜索
- **不要指定引擎**:默认自动聚合 bing+baidu+sogou+so360+sm+toutiao(中文)+marginalia/hn/github/wikipedia(英文);
  只有特殊需求才 `--engine`(cnnews 官方新闻 / github 代码 / wikipedia 百科 / hn 技术讨论)

---

## 输出与结果处理流水线

### 聚类输出格式(默认)

```
🔍 bing 搜索 "免费VPN 下载" → 7 条(过滤后 7 · 聚类 1 组)
🚫 剔除广告 2 条: xxx | yyy
⚠️ 低质 1 条已标记(降权不剔除)
📦 [vpn] 相关度 0.66 · 7 条 · 质量 0.94
   ↳ 簇内主题: 免费下载 / 测评 / 完全免費 ...
   ✓ 正常结果(完整展示 desc + URL)
   ⚠[low:spam-desc] 垃圾页 ·(仅标题)—— 垃圾文案不可信,不给深挖入口
   ⚠[low:desc-empty] 缺摘要页(标题 + URL,不展示 desc)—— 保留 fetch 深挖入口
📋 未归簇 2 条(与查询无共享词/语义距离过远;可能只是聚类漏判,保留 URL 可深挖)
📦 低相关折叠 N 簇 / M 条: [簇名]×n(语义 X.XX) · ...(详情见 reveal)
```

### 平铺输出(--flat)

`N. 标题 → desc → 🔗 URL`,逐条编号;语义可用时按 query↔文档余弦降序重排。

### 结果处理流水线(默认开启,两阶段)

**阶段一 规则过滤**(`scripts/lib/filter.mjs`,零依赖):先剔除广告/垃圾,再聚类。
**阶段二 聚类组织**(`scripts/lib/cluster.mjs`):主题聚合 + 去重 + 质量加权排序。

### 阶段一:规则过滤(广告/噪声)

高精度优先,**硬剔除只认强证据**(ad:*),软信号只降权不误杀:

| 信号 | 级别 | 说明 |
|---|---|---|
| 引擎 SERP 标记 `isAd` | 硬 | 解析器识别广告位/Ad 标签(可扩展) |
| 标题/摘要强标记 | 硬 | `【广告】` `[Sponsored]` `Ad:` 等 |
| 广告联盟域名 | 硬 | doubleclick/googlesyndication/taboola 等黑名单 |
| 跳转 URL | 硬 | `redirect\|goto\|jump\|out...` 路径 + `url=` 等目标参数组合 |
| 短链域名 | 软 | t.cn/bit.ly 等(正常分享也可能用,只降权) |
| 文案垃圾组合 | 软 | 立即/马上/点击 × 下载/注册/优惠/免费 等组合 |
| 质量启发 | 软 | 标题过短/摘要缺失/全大写/超长 URL 等 |

每条结果附加 `quality[0,1]` 与 `flags[]`;垃圾组合进入聚类后靠**质量加权**把所在簇整体压沉。
否定排除实测修正:描述中"无广告/没有广告/广告拦截"不误报。

### 阶段二:聚类组织(双模式,输出契约一致)

**短语模式(零依赖)**:STC 风格 —— 标题提取中文 2~4-gram + 英文词,共享显著短语(df≥2)
关联 → 子集并入 + Jaccard≥0.55 合并。**标签/变体可读性**:标签取**簇内标题两两最长公共子串(LCS)**
中得分最高者(得分=长度+覆盖标题数+含 df 最高 token 加成,站点样板后缀先由 `cleanTitleForLabel`
剥除,避免 LCS 命中"_百度百科/| 知乎"这类样板);簇内差异标注(variants)改为每条标题最长的
独有连续片段。单例簇/无共享片段时回退 df 最高 token。语义模式标签同样用 LCS(保证跨模式可读性一致)。

**语义模式(可选增强,默认自动尝试)**:嵌入余弦 + **贪心首领聚类**(增量质心):
- 无共享词也能聚(近义/跨语言表达)——实测搜“苹果”短语模式被语言拆成 苹果/Apple 两簇,语义模式正确归并为一簇
- 与簇心余弦 ≥0.94 视为**近似重复**(同文转载/镜像页)→ 折叠计数 `含 N 条近似重复`,不重复展示
- **语义转载折叠预处理**(2025-08 新增,零词表):pairwise 余弦落在 [0.75, 0.94) 区间
  (转载级,实测:转载同文 ~0.95、转载换措辞 ~0.78~0.85、同主题不同文 <0.72~0.80)
  且**标题或摘要 LCS 近重复** → 后出现者折叠计数,保留代表条(URL 不丢,折叠详情可查)。
  换措辞转载(标题用词全不同但正文同源,实测 ~0.84)可折叠;同主题不同文(向量可能
  0.75~0.85 但标题摘要都不同)不误杀 —— 比聚合层字符 LCS 硬过滤更准、更软
  (硬过滤已移除:近似转载不再在聚合合并时丢弃,统一由本层语义折叠)。
  阈值 `WEBSEARCH_REPRINT_THRESHOLD` 可调。
- **超大簇动态拆分**(簇 >12 条,`WEBSEARCH_MAX_CLUSTER_SIZE` 可调;信号完全数据驱动、零固定阈值):
  - **语义离群检测**:簇内每个成员与其余成员的相似度中位数 = 归属度,归属度分布用 IQR 盒须法
    (fence = Q1−1.5×IQR)自动判离群 —— 大主题查询混入的无关项(搜“虚拟细胞大赛”混入
    “平安细胞/死亡细胞游戏”文章)自动拆出,不用固定相似度阈值
  - **文本子主题分组**:簇内词频统计,成员归属到“它含有的、df 最高的显著短语”组
    (泛主题词按占比 df≥0.5n 动态排除)—— 子主题词由当前结果集自然涌现
    (结果/入门/融资...),实测“虚拟细胞大赛”29 条大簇拆出“结果出炉/Arc挑战”等子簇
  - 无子结构(内容同质)不拆 —— 不做无意义拆分;拆分动机:均值质心内积虚高
    (27 条主簇成员与质心内积 0.72~0.79 vs pairwise 0.58~0.81)使固定阈值拆不开,故改数据驱动
- **单例语义桶合并**(拆分后剩余单例 ≥3 时启用,`WEBSEARCH_BUCKET_SINGLETONS=0` 关闭):
  单例(文本不共享短语但语义同属一类,如“融资/方案解读/官方站”)用 **UPGMA 平均链接**
  层次聚类合并成小桶(≤`WEBSEARCH_MAX_BUCKET_SIZE`=6 条)。同样零固定阈值:
  合并截止 = 合并高度 ≥ 单例集合 pairwise 的 Q3(75 分位)+ 最大 gap 截断
  (低于 Q3 的相似度在单例集合里“太普通”不构成桶;单例互不相关时 Q3 低,自然零合并);
  平均链接(桶间相似度 = 两桶成员 pairwise 均值)防单链接链式污染。
  实测“虚拟细胞大赛”13 个单例 → 融资桶(注册资本加注/2000亿赌局/晶泰融资/GPT时刻 4 条)+
  方案解读桶(2 条)+ 官方站桶(2 条),真无关者保持单例
- **默认后端 = API(跑分最高,零本地开销)**:自动调用 OpenAI 兼容嵌入 API(默认硅基流动,key 存
  环境变量 `SILICONFLOW_API_KEY` 或技能目录 `.env.json`),模型默认 `Qwen/Qwen3-Embedding-8B`
  (MTEB 多语言榜首,4096 维,中英同主题 0.58~0.72 vs 异主题 0.32~0.45 分离清晰);
  可换 `SILICONFLOW_EMBED_MODEL=BAAI/bge-m3`。API 后端自动用专用阈值 0.5(本地模型阈值 0.42,
  二者相似度分布不同);`SILICONFLOW_API_BASE` 可换其它 OpenAI 兼容提供商
- **API 韧性 + 优化**(实测数据驱动):
  - **MRL 维度压缩**:`EMBED_API_DIMENSIONS=1024`(默认)——Qwen3 输出 4096→1024 维,
    相似度误差 <0.005(报道↔指南 0.903↔0.906),分布不变 → 聚类阈值零改动;
    存储/计算(UPGMA pairwise 等 O(n²)×dim)省 4 倍;不支持的提供商(400/422)自动去掉重试
  - **失败记忆 + 退避重试**:429/5xx/网络错误退避重试(3 次,间隔递增);连续失败 2 次
    → 冷却 5 分钟不再请求(限流/故障时避免每次搜索白等 + 雪上加霜),成功自动恢复
  - **结果向量磁盘缓存**(`~/.cache/websearch-vectors/`,key=sha1(模型+查询+url 列表)):
    同一搜索调参/重跑(改 limit/阈值/引擎)完整复用 {qVec, vectors} 零 API 调用;
    跨进程持久(CLI 每次独立进程也命中),换模型自动失效,目录超 300 文件自动清空
- **本地 WASM 仅作无 key 时兜底**(`WEBSEARCH_EMBED_BACKEND=local` 强制):模型默认
  `Xenova/bge-small-zh-v1.5`(中文优先,~95MB 首次下载,缓存后秒级加载);中英混合场景换
  `WEBSEARCH_EMBED_MODEL=Xenova/multilingual-e5-small`(真正多语言,需同时
  `WEBSEARCH_SIM_THRESHOLD=0.8` 调高聚类阈值)。本地模型已删除(省 ~213MB 缓存),
  如想重启用 `npm run setup:semantic`
- 不可用(未装/加载失败/无 key)静默回退短语模式,零影响主流程;`--no-semantic` 强制关闭

### 相关性打分(双模式共用)

`0.7×查询 token 文本命中率`(按簇内命中文档占比加权,10 条簇仅 1 条相关不会虚高)
`+ 0.3×引擎排名信号`(跨语言兜底),再乘以**质量因子**(0.5 + 0.5×簇内平均质量)。
低于 `noiseScore=0.3` 的簇标记 `⚠️低相关`。

### 语义相关性重排(ML 温和过滤,queryVec 可用时)

不硬筛/不降权,只重排+标注:
- 查询词与结果一起嵌入(embed.mjs 把 query 放批次首位),返回 qVec;每簇/每条计算
  query↔文档余弦 `rel`(ML 相关性,非规则黑名单)
- 簇分数融合:`score = 0.45×semScore + 0.385×textScore + 0.165×rankScore`
  (semWeight=0.45,text/rank 按比例收缩保持和为 1;`WEBSEARCH_SEM_WEIGHT` 可调)
- **效果**:词典/翻译页、导航站、歧义站与查询语义距离远 → semScore 低 → 自然沉底 +
  双低相关判定(`score<noise || semScore<0.32` 标 `⚠️低相关`),但**仍完整展示**;
  用户真查词典时词典页语义分高,不会被误杀 —— 这是域名黑名单/规则降权做不到的
- 簇头显示 `语义 X.XX`,每条结果附 `rel` 字段;flat 模式同样按余弦降序重排
- 无 queryVec(嵌入不可用/无 key)时自动回退 text+rank 原打分,零回归

### 低相关折叠 + reveal(不删 URL,详情可展开)

语义分映射三档(relevance.mjs 纯函数,决策在 `buildPresentation`):
- `relevant`(rel ≥ max(0.5, top×0.6)):标题+摘要+URL 完整展示
- `edge`(rel ≥ max(0.25, top×0.4)) 与 `irrelevant`(rel < 上述):**全部折叠**为一行摘要
  `📦 低相关折叠 N 簇 / M 条: [簇名]×n(语义 X.XX) · ...` —— AI 从簇名即知折叠了什么,语义分辅助判断
- 折叠详情写 `~/.cache/websearch-collapsed.md`(每次搜索覆盖,Markdown):每条含标题+URL+
  数据驱动原因("含查询词但语义无关"/"与查询主题无明显关联",非域名黑名单);**URL 永不丢**
- 搜索完成后自主展开:`websearch.mjs reveal` 命令,或直接读取缓存文件(agent 可任选)
- **阈值自适应**:基于当前结果集最高语义分 top 的比例 + 绝对下限双保险,防模型/语言漂移
- 模式:`WEBSEARCH_REL_MODE=balanced`(默认,折叠)/ `conservative`(只排序不折叠,全展开)/ `aggressive`(同 balanced)
- 语义不可用时全部走原逻辑(零回归);语义模式低相关单例簇同样折叠(聚类漏判的低相关单条自动进折叠区)

### 已知边界与缓解(实测验证)

- **中英别名/跨语言**:搜"苹果"返回 Apple 官网、搜"特斯拉"返回 Tesla 官网——搜索引擎本身已做了语言对齐。
  英文簇即使文本完全不命中也不归零(排名兜底):实测「特斯拉」(无词典)英文官网簇 score 0.29,
  注入品牌词典后「苹果」英文簇 0.17→0.52(仅展示分数提升,簇结构与排序不变)
- **多义混簇**:纯 n-gram 无法区分"苹果(水果)/苹果(公司)" → 每簇输出**簇内差异标注**
  (每条的代表性独有短语,如 `蔷薇科苹 / 苹果公司 / 爱思助手`),提示内部子主题而非强拆;
  语义模式下嵌入本身即可区分(苹果簇/Apple 簇自动分离)
- 顺序敏感性实测影响极小;站名后缀清理是黑名单式方案,刻意不做

### 零词表设计(实测验证)

聚类**不依赖任何手工词表**(无停用词表/无品牌词典),零维护:
- 真实搜索场景主题聚焦,词表命中率极低——三个真实快照(苹果/特斯拉/iPhone)删除词表后簇结构与排序零变化
- 统计替代不可行:结果集内 token 占比会把主题词(apple/特斯拉)误判为泛词误杀;泛词组合(深度解读)
  n-gram 残渣(度解)只有词法分词能根治,词表反而引入标签劣化副作用
- 复用方可按需注入 `stopWords`/`brandAlias`(公共出口 `ZH_STOP`/`BRAND_ALIAS` 提供默认表)

---

## 引擎与降级链

| 引擎 | 直连目标 | 失败/被污染后 | 语言 |
|------|----------|--------|------|
| `bing` (默认) | 中文:cn.bing.com / 英文:global.bing.com | 英文 global 失败回退 cn → 污染检测 → Marginalia → 浏览器兜底 | 中/英 |
| `baidu` | www.baidu.com/s(移动端 UA) | → 自动切 bing | 中文(zhOnly) |
| `sogou` | www.sogou.com/web(桌面 UA) | → baidu → bing | 中文(zhOnly) |
| `so360` | www.so.com/s(桌面 UA,data-mdurl 取真实 URL) | → baidu → bing | 中文(zhOnly) |
| `sm` | m.sm.cn/s(移动 UA,结果直链) | → baidu → bing | 中文(zhOnly) |
| `toutiao` | so.toutiao.com(SSR 数据解析,站内资讯/视频) | → baidu → bing | 中文(zhOnly) |
| `marginalia` | search.marginalia.nu | → (独立引擎,无限流时直出) | 英文(enOnly) |
| `hn` | hn.algolia.com(公开 API) | → marginalia → bing | 英文(enOnly) |
| `github` | api.github.com(匿名限额 10/min) | → bing → marginalia | 中/英 |
| `wikipedia` | en.wikipedia.org(w/api.php) | → marginalia → bing | 英文(enOnly) |
| `searx` | SearXNG 公共实例 priv.au/searxng.site | → bing → marginalia → bing-browser | 中/英 |
| `cnnews` | 官方新闻源白名单(人民网系/共产党员网) | → baidu → bing | 中文 |
| `sogou-wechat` | weixin.sogou.com/weixin(微信公众号文章搜索) | → baidu → bing | 中文 |
| `chinaso` | www.chinaso.com(中国搜索·官方 JSON API,uid cookie) | → baidu → bing | 中文 |

> 候选引擎实测结论(2026-08,未接入原因):夸克 quark.sm.cn(x5sec 反爬——正确接口
> `quark.sm.cn/s?layout=html` + s-data JSON 块,参考 SearXNG quark.py,但本环境 IP 被
> 阿里 x5sec 拉黑,直连+浏览器均无结果)、Yandex(smartcaptcha 验证码,直连+浏览器均无法
> 通过,SearXNG 检测到即放弃)、Ecosia(Ecosia Firewall 403,SearXNG 已移除该引擎)、
> Mojeek(403 自动化检测/TLS 断开,网络层拦截)。AI 搜索(秘塔/Kimi/豆包/纳米)非 SERP
> 网页搜索(LLM 生成答案),不适合作聚合引擎。

降级链规则:`fallbacks` 依次尝试,首个返回非空结果的生效;全部失败打印空结果。
引擎扩展是声明式的(见[扩展新引擎](#扩展新引擎)),新增只改配置不碰调度代码。

### 多引擎聚合(99 条怎么来)

搜索引擎对自动化访问每页硬限 ~10 条(count/first/滚动/点击翻页全部无效,实测 first=11
与首页 10/10 重叠)。`--limit N>10` 时按 `engines.conf.json` 的 `aggregateWith` 并行抓取
多引擎(bing+baidu+marginalia,声明式可扩展)后 URL/标题去重合并:

- 每引擎至少抓满单页(普通引擎 10 条,API 类按 pageLimit)再合并去重,去重后截断到目标条数
- 默认 99 即尽量抓满;单引擎单页硬限 ~10 条,实际输出以去重后可得为准(中文多引擎去重后约 40~60 条)
- 聚合失败自动回退主引擎降级链,永不阻塞;聚合层有**通用失败记忆**:引擎连续失败 2 次 →
  冷却 5 分钟,期内聚合跳过(进程内生效,库模式/常驻进程收益大)

### 语言过滤(zhOnly/enOnly)

聚合时按查询语言自动跳过不适用引擎(英文查询跳过百度避免中文污染,中文查询跳过
marginalia/hn/wikipedia)。hn/github/wikipedia 与通用引擎重叠极低,给同一查询提供
讨论/代码/百科维度的互补结果(实测 "rust async":教程+文档+HN 深度文章+GitHub 项目 24 条)。

### 地域语言污染检测(英文查询)

本设备(CN IP)上 bing/ecosia 按出口 IP 地域返回中文结果,英文技术查询被中文内容稀释
(实测 "web scraping" 仅 0/8 英文结果)。根因实测:cn.bing.com 是必应中国版(合资运营),
www.bing.com 也会 302 重定向到 cn.bing.com,`mkt=en-US` 等参数被忽略或返回无关垃圾
(WhatsApp/WEB.DE 等,实测 6/6 不相关)。

**解法(2025-08 实测)**:`bing.mjs` 按查询语言分流——
- 英文查询优先 `global.bing.com`(国际版,不重定向,`mkt=en-US` 生效):实测英文查询
  0% 中文且全部相关;个别长查询(如 "openai api pricing")global 返回 0 条时自动回退
  cn.bing.com 走下方污染检测
- 中文查询不受影响,永远走 cn.bing.com(中文结果更全)

global 回退到 cn.bing.com 后的旧链路(保底,理论上少触发):
- **自动检测**:英文查询(查询词无中文)且结果中中文标题占比 ≥50% → 判定 `polluted`
- **自动降级**:命中污染后自动尝试 Marginalia(独立索引,不受 CN IP 地域影响,实测返回
  Wikipedia/技术博客等纯英文结果)
- **明确提示**:marginalia 有限流/JS 验证时给出原因,不会静默返回中文垃圾

### 分层解析(站点改版自动降级,不中断)

引擎 parse 统一经 `parse-serp.mjs` 包装,`serp-generic.mjs` 提供两级兜底(纯函数可单测):
- ① 特异性解析器(各引擎原有,精确)—— 命中率达标(双判据)即保级,零回归
- ② 通用 SERP 解析器 —— 站点无关:linkedom 结构签名聚类(只认标签名,免疫类名变更)
- ③ JSON 结构化提取 —— 专治 SSR/JSON 内嵌页(如头条 `T.flow({...})`):
  json5 解析(JS 对象字面量:未引号 key/尾随逗号)+ 递归遍历(字段名/嵌套深度无关)
- 降级判据双保险:绝对比例(specificCount/min(limit, domEntryCount)≥0.5,防冷门查询误报)
  + 相对质量(specificCount≥5 且 ≥ 通用);降级时 CLI 打印 `[degrade] ... 站点可能改版`
- 引擎接入:baidu/so360/sm/sogou/marginalia/searx/toutiao;hn/github/wikipedia 为 API 型不适用

### 各引擎反爬要点

**百度(移动 UA 绕过风控)**:桌面 UA 直连 `www.baidu.com/s` 会被 302 到"安全验证"风控页,
本技能使用**移动端 UA**(`Linux; Android`)请求同一 URL,百度返回完整移动版结果页,实测稳定可用:
- 真实 URL 藏在 `data-log='{..."mu":"真实URL"...}'` 字段(单引号包裹的 JSON,区别于 `rl-link-data-log` 双引号)
- 标题在 `cosc-title-slot` 的 `<!--s-text-->` 包裹内(可能含 `<em>` 高亮)
- 摘要在 `pure-summary` 的 `<!--s-data:JSON-->` 中
- 过滤百度内部域名(baike/recommend_list/aiqicha/weather 卡片)
- JS 渲染的视频/资讯卡片无静态标题,回退显示域名

**Marginalia**:独立索引(非 Google/Bing 聚合),专注英文非商业内容,服务器在欧洲;
关键词 AND 匹配,多词长查询可能 0 结果(提示精简查询词);有温和限流与 1 秒 JS 倒计时验证,
直连间歇失败时自动切浏览器兜底(Termux chromium 实测可过验证);解析锚点
`<h2 class="text-md..."><a href="URL">标题</a></h2>` + 摘要 `p.mt-2`,标题中的 `&shy;`
(软连字符)已由 decodeEntities 移除。

**搜狗(风控降触发策略)**:① 首次搜索前先访问主页建立 cookie 会话(无 cookie 直接搜索更易触发);
② 触发验证码后进入约 5 分钟冷却期,期内聚合/单引擎直接跳过不再请求(避免反复触发),
日志显示 "处于验证码触发后的冷却期" 即为此机制。

**searx**:直连 JSON 被实例 antibot 拦(3s 超时快失败)后自动无头浏览器渲染(实测 priv.au
15.6s/21 块,原始 URL 在 h3 链接,web.archive 链只是 cache_link);实例列表可换
`SEARX_INSTANCE=https://xxx`。公共实例可能挂/限流,引擎内静默降级不影响聚合。

**cnnews(官方新闻源·带日期)**:信源白名单 = 人民网时政/党建/首页 + 共产党员网(静态 HTML
可解析、本设备直连可用);结果自带 `⏱ 发布日期`(从 URL 结构化提取),默认只保留 30 天内新闻;
按日期降序 + 关键词(标题含任一 token)过滤;转载标题去重;单源失败不影响其他源;
适合"今日时政热点"类需求,替代通用引擎的垃圾结果。⚠️ 依赖官方站页面结构,改版时需更新
`extractNewsLinks`(信源列表见 `CN_NEWS_SOURCES`)。

---

## 浏览器兜底

### 安装

```bash
# Termux / Android(实测可用)
pkg install x11-repo
pkg install chromium      # ~655MB,含 chromium-browser 与 chromedriver
cd ~/.pi/agent/skills/websearch
npm i puppeteer-core      # 可选,装了用库驱动;不装自动降级 chromium CLI

# 桌面 Linux/macOS/Windows
cd ~/.pi/agent/skills/websearch
npm i playwright
npx playwright install chromium

# 自定义浏览器路径
export WEBSEARCH_BROWSER_PATH=/path/to/chromium
```

### 三层能力与自动降级

| 层 | 驱动 | 说明 |
|----|------|------|
| 0 | **zendriver**(裸 WebSocket CDP) | Python 3 + 系统 chromium,CF 站实测 3s 直取真实页面(见下) |
| 1 | puppeteer-core + 系统 chromium | Termux/桌面通用,浏览器实例复用 |
| 2 | playwright + 自带浏览器 | 桌面环境,兼容原设计 |
| 3 | chromium CLI `--headless --dump-dom` | 零 npm 依赖,自动降级可用 |

### zendriver 快速通道(2026-08 新增,CF 攻坚最终形态)

关键洞见(社区逆向研究):Playwright/puppeteer 的 `Runtime.enable` CDP 泄漏会被 Cloudflare 检测 →
库模式必拿“Just a moment”验证页;而 **zendriver 走裸 WebSocket CDP + 指纹模拟,无此泄漏**。
实测(2026-08,Termux + Chromium 149):cell.com / nature.com **3s 内直接拿到真实页面**,
无需 CLI 45-90s 等待轮询。集成方式:fetchViaBrowser 优先调 `scripts/lib/engines/zd_solver.py`
(`python3` + `pip install zendriver`,失败自动降级 CLI 轮询,不影响既有链)。

```bash
pip install zendriver   # 一次性安装(python3 已随 Termux 提供)
```

配合提速机制:已知 CF 站点(记忆文件命中)跳过直连 10s 白等,冷启动实测 **9s**;页面缓存热请求 0s。

### Stealth 指纹伪装(2026-08 新增)

浏览器层默认注入 stealth(页面脚本运行前执行,库模式 evaluateOnNewDocument / addInitScript;CLI 模式靠
`--disable-blink-features=AutomationControlled` blink 标志,实测 Chromium 149 把 webdriver 置为 false):

1. **抹自动化特征**:`navigator.webdriver` → undefined(puppeteer/playwright 最大破绽)
2. **补齐真人浏览器常态**:`navigator.languages`、plugins(Chrome PDF 三件套)、`window.chrome` 运行时、
   `permissions.query` 全授权
3. **Canvas 指纹噪声**:toDataURL/toBlob 前对画布像素做 ±1 级扰动 → 每次绘制结果略不同,破坏跨站指纹唯一性
   (对应 2025 反爬攻防下沉:Canvas/WebGL 指纹 + webdriver 检测)
4. **常驻访客画像一致**:视口 1366×768 + locale zh-CN + UA 固定成一组,与既有 Cookie 会话持久化配合 =
   指纹+会话双一致
5. **拟人行为**:等待加随机抖动(800ms 内),分步非匀速滚动(触发懒加载,热搜榜等页面友好)

并发安全:库模式启动带**互斥锁**(聚合时 searx/marginalia/bing-browser 并行触发 getDom
只启动一次共享实例,不再互相抢 profile);共享 profile 被残留孤儿锁住时自动清理换 unique。

浏览器二进制探测:`WEBSEARCH_BROWSER_PATH` → `$PREFIX/lib/chromium/chrome`(Termux)→ 常见系统路径 → PATH。

Termux 实测能力:过 marginalia 的 1 秒 JS 倒计时验证页、渲染 GitHub 趋势等 JS 页面、执行 bing/baidu 搜索。
未安装 chromium 时直连路径不受影响;检测到直连被反爬会提示“浏览器兜底不可用”。

**失败原因分诊(2026-08)**:"浏览器兜底不可用"此前会误导排查(实测多数情况是站点对浏览器同样反爬,
而非浏览器缺失)。现按 `resolveChromiumPath()` 分诊 —— 已装则提示"Chromium 已装,但未取得正文(具体原因:
库模式反爬风控页/CLI 无输出/渲染无正文)",未装才提示 `pkg install chromium`。浏览器二进制探测路径
已硬编码 Termux 默认前缀(`/data/data/com.termux/files/usr`),不依赖 `$PREFIX` env(受限环境也能找到)。
失败原因追踪:`getLastBrowserFailure()`(fetch-flow 降级日志自动带上)。

### Cloudflare Turnstile 攻坚(2026-08,cell.com 等验证页结论)

cell.com 等站直连 403 + Cloudflare Turnstile 托管验证,2026-08 实测三层链路可自动穿透:

1. **库模式 CF 识别**:`getDomViaDriver` 拿到“Just a moment...”页时用 `detectAntibot` 识别为
   cloudflare-turnstile/interstitial → 抛错强制降级 CLI(不再把验证页当成功结果返回)
2. **CLI 真实等待轮询**:第一轮虚拟时间快进(`--virtual-time-budget`,过 JS 倒计时);若拿到 CF 验证页或
   无输出 → 进入真实墙钟等待轮询(Turnstile 交互验证在虚拟时间下会挂起无输出,真实等待才有机会过验证):
   45s → 90s 两轮递增(`CLI_CF_TIMEOUT_MS=90s`),每轮 dump 结果非 CF 验证页即返回,仍为 CF 页继续下一轮
   (CF 对连续尝试有时第 2-3 轮才放行)—— 实测 cell.com 连续 3 次全部成功,第二轮拿到完整正文
3. **验证页不算成功**:`fetchViaBrowser` 对 CF 验证页返回 null,让调用方走错误分诊(明确提示
   “被 CF 验证拦截 + 建议更换网络出口/手动访问”),而非打印无用的验证页正文

诊断增强:CLI 失败时完整 stderr/退出码/命令行落盘 `~/.cache/websearch-browser-debug.log`
(错误消息带日志路径 + 最有信息量的 stderr 行,替代“只留 80 字符”截断);fetch 最终失败时按
`resolveChromiumPath()` 分诊——已装浏览器则报“CF 验证/IP 封锁/需登录”等真实原因,未装才提示安装。

### 提速机制(2026-08,计时实测冷启动 127s → 20s)

- **页面级缓存**:fetch 成功结果缓存 6h(`~/.cache/websearch-page-cache/`),同一 URL 重复抓取
  0s 秒回 —— CF 站点每次 45-90s,缓存是唯一能快速复用的手段
- **CF 站点记忆**:真实等待轮成功/检测到 CF 验证页时把域名记入 `~/.cache/websearch-cf-sites.json`,
  下次同域名直连失败直接走 CLI 快速通道(跳过存档+库模式+虚拟时间轮)
- **网络层失败跳过存档**:直连 fetch failed/aborted(无 HTTP 状态)时 archive 站同样不可达,
  只保留 HTTP 403/5xx(有 status)才试存档(知乎等站 403 场景存档仍有价值)
- **网络层失败跳过库模式**:无 HTTP 状态时库模式(CDP 泄漏)大概率也失败,直接 CLI 真实等待轮

### UA 版本自动匹配(2026-08,知乎 40362 攻坚结论)

反爬站(知乎等)会校验 UA 版本与实际浏览器实现是否一致:UA 写 Chrome 120 但本地是 Chromium 149 →
40362 "您当前请求存在异常"。`browser.mjs` 启动前自动 `chromium --version` 探测实际版本,用
`buildChromeUa(ver)` 动态生成匹配 UA(探测一次缓存,失败回退默认)—— **升级 chromium 零改动**。

Termux 实测 CLI 坑:`--dump-dom` 与 `--user-data-dir` 组合会挂起无输出(profile 初始化死锁),CLI 模式已移除
user-data-dir(默认临时 profile,进程退出即释放)。库模式(CDP 附加 + 共享 profile 残留状态)拿到知乎
40362 风控页时,内容检测命中(统一走 antiblock.mjs `isAntibotContent`)→ 抛错强制降级 CLI 干净通道。

**知乎抓取要诀**:未登录 + 干净无头(无共享 profile)+ 版本匹配 UA + 低频单次;连续高频请求会触发 IP
临时风控(批量需随机 6~14s 间隔、遇 40362 退避 120s;终极方案是登录 cookie z_c0 + 朴素直连,
正文同样在 js-initialData 无需渲染)。

---

## 反爬与礼貌爬取(四层防线)

1. **直连层**:桌面/移动 UA 伪装 + **同域限速**(`DOMAIN_RATE_LIMIT_MS=1500`,库模式多次搜索自动生效)
   + **Cookie 会话持久化**(`~/.cache/websearch-cookies.json`,跨运行共享,模拟"老访客"降低风控判定;24h TTL 自动清理)
2. **TLS 指纹层**(2026-08 新增):Node 原生 fetch(undici)的 TLS 指纹(JA3/JA4)与真实 Chrome 完全不同,
   Cloudflare 系站点/防火墙按指纹拒绝握手(403 / TLS 握手 RST)。直连 fetch 命中候选失败模式时,自动用
   浏览器指纹的 curl 变体重试同一请求:① curl-impersonate 二进制(curl_chrome120 等)② python3 + curl_cffi
   (`pip3 install cffi curl_cffi`,Termux aarch64 实测可用;两者都无时静默跳过,零回归)。set-cookie 自动喂回 jar,
   `WEBSEARCH_TLS_FALLBACK=0` 关闭。
   **失败记忆/冷却**:impersonate 也救不回的网络/IP 硬拦站(如 mojeek 连 BoringSSL 握手都被 RST)连续失败
   2 次 → 冷却 30 分钟(成功清零),期内直连失败不再尝试 impersonate,避免每次搜索都白等 curl 8-10s
   (持久化 `~/.cache/websearch-tls-fail.json`,跨 CLI 进程)。注意:impersonate 返回非 200 同样视为失败
   (否则 403 页面会被误当成功返回,mojeek 实测踩过)。
3. **解析层**:每引擎三级结构回退(主模式 → 老界面/桌面版 → 通用 h2/h3>a 提取),站点小改版不失效;全失效时返回
   blocked + "结构可能已变更"提示
4. **浏览器层**:chromium 真浏览器指纹(TLS/JS/UA 全真)+ stealth 注入(见上),直连被挡自动降级

反爬特征检测统一收敛在 `scripts/lib/antiblock.mjs`(**单一事实来源**,禁止在业务代码另写反爬正则——
曾散落 cli/browser/antiblock 三处导致行为漂移):`detectAntibot`(HTML 类型识别)、`isAntibotContent`
(统一特征检测,含知乎 40362 类 login-wall 风控)、`classifyFetchResult`(抓取结果三分类
full/blocked/empty 纯函数,**反爬≠垃圾**的信号分类出口)。完整武器库架构(模块地图/对策速查/复用接口)
见 `docs/ANTIBOT.md`。

---

## 降级日志约定

调度层降级输出统一带 `[degrade]` 前缀(正常结果无此前缀):

```
[degrade] bing 结果被地域语言污染(英文查询返回大量中文),尝试英文独立索引...
[degrade] Marginalia(英文独立索引)兜底: marginalia 触发 JS 验证或限流(将尝试浏览器兜底)
[degrade] 降级链超时(40s),停止尝试
```

用 `grep '\[degrade\]'` 即可快速区分"预期降级"与"正常路径"。解析命中 0 条时 reason 会提示
"页面结构可能已变更,请运行 npm run fixtures 更新快照"——这是给维护者的故障信号。

**决策追踪(`WEBSEARCH_DEBUG=1`)**:降级日志只给结论,不给过程;排查"为什么拿不到正文/为什么慢"时
开 debug,输出带缩进的完整决策链(每步耗时 + 各通道结果长度),一眼定位卡点:

```
$ WEBSEARCH_DEBUG=1 node scripts/websearch.mjs fetch "https://virtualcellchallenge.org/"
[debug]fetch start: https://virtualcellchallenge.org/ (maxChars=500)
[debug]  直连 fetchPage → 1.6s
[debug]直连结果: 33字符, 分类=empty → 触发兜底
[debug]  fetchViaBrowser 入口: preferCli=false
[debug]      zendriver 快速通道 → 21.3s
[debug]    zendriver 拿到壳(提取 10字符 < 200)→ 继续降级
[debug]    getDom 入口: preferCli=false waitMs=4000
[debug]        库模式(getDomViaDriver) → 8.2s
[debug]      getDom(库模式→虚拟时间→真实等待) → 8.5s
[debug]    ✓ 提取成功: 500字符
[debug]写入缓存: 500字符, 6h TTL
[debug]fetch done(空壳兜底): 32.9s
```

缩进代表调用层级,`→ Xs` 是每步耗时,"拿到壳→继续降级"等中文标注说明每个通道为何被放弃。
搜索/抓取慢、结果异常时先开它看链条,再决定是环境问题(浏览器/网络)还是页面问题。

预算:整条降级链(主引擎 + 所有兜底)合计硬预算 40s(`TOTAL_BUDGET_MS`),每个环节
(含单次浏览器兜底)也受剩余预算约束,超时立即放弃,不会无限拖慢。
库模式用完浏览器兜底后调用 `closeBrowser()` 释放 chromium(CLI 薄壳已自动处理)。

---

## 作为库复用(import)

```js
import { searchBing, searchBaidu, fetchPage, clean, filterResults, clusterResults } from "websearch-skill";

const r = await searchBaidu("北京天气", 5);   // {engine, mode, blocked, reason?, results:[{title,url,desc}]}
const { kept, ads, flagged } = filterResults(r.results);      // 阶段一:剔除广告,标记垃圾
const { clusters, uncovered } = clusterResults(kept, "北京天气"); // 阶段二:主题聚合+质量加权
const page = await fetchPage("https://...", 3000); // {title, metaDesc, body, markdown, url} —— markdown 为 LLM 友好格式
```

反爬/提取工具(独立复用,零业务耦合):

```js
import { isAntibotContent, classifyFetchResult, detectAntibot } from "websearch-skill"; // 统一反爬检测+三分类
import { extractSsrEmbeddedJson, extractZhihuInitialData } from "websearch-skill";       // SSR 数据槽提取
import { getDom, probeChromiumVersion, resolveChromiumPath } from "websearch-skill";     // 浏览器通道+版本探测
```

引擎函数均不抛错、不 exit(参数错误/抓取失败由调用方处理),可安全集成到其他脚本。
库接口:`filterResults` → `clusterResults(kept, query, { vectors })` 两阶段可独立复用;
`detectFlags/scoreQuality/isAdResult` 供自定义策略;`cosine/cosineMatrix` 供自建嵌入流程;
`buildPresentation(clusters)` 可直取 shown/collapsed 分流(折叠/展示决策纯函数)。

---

## 扩展新引擎

### 三步声明式(改配置不碰代码)

1. `engines/` 下实现 search 函数(返回 `{engine, mode, blocked, reason?, results[]}`)
2. `lib/engines/registry.mjs` 的 `ENGINE_IMPLS` / `ENGINE_LABELS` 注册实现与中文名
3. `lib/engines.conf.json` 登记 + 声明降级链(引用已在 registry 注册的 key,否则启动即报错):

```json
{
  "engines": {
    "bing": { "label": "bing(中文/英文通用)", "search": "bing",
      "fallbacks": ["marginalia", "marginalia-browser", "bing-browser"] }
  }
}
```

调度/降级链逻辑无需改动;校验失败(引用未注册引擎)启动即抛错,不静默。

### 聚合伙伴声明(`aggregateWith`)

- 通用引擎写 `"aggregateWith": ["all"]` = 展开为"除自身与专用引擎外全部"(registry 展开,
  行为等价手写列表,新引擎零同步成本)
- 专用引擎(如 cnnews 白名单新闻)保留显式列表,不参与别人的 `"all"`;语言过滤(zhOnly/enOnly)
  在 aggregate.mjs 运行时按查询语言自动跳过,无需在列表里手动排除

### 新引擎实现约定(所有 search 函数统一契约)

```js
// engines/xxx.mjs
// 头部注释记录反爬研究结论(实测 UA/端点/风控特征/解析锚点/降级理由)——
// 这是 DOM 解析类代码最重要的文档:站点改版或反爬升级时,凭注释就能定位
// 是结构变更还是风控,参考 sogou/so360/sm/toutiao 各引擎头部。
export async function searchXxx(query, limit) {
  // ... 返回 {engine:"xxx", mode:"direct", blocked:false, results:[{title,url,desc}]}
  // 被反爬 → blocked:true + reason;主解析函数建议导出并加单元测试
}
```

建议模式(参考 baidu/so360/sm):
- **解析器是纯函数**:`parseXxxHtml(html, limit) → {blocked, reason?, results[]}` 与网络请求分离,可直接喂 fixture 测试
- **直连型引擎用工厂**:`engines/factory.mjs` 的 `createDirectEngine({name, mode, buildUrl, parse, headers})`
  统一"请求→解析→blocked 包装"样板(baidu/sm/so360/toutiao 已用);含会话/冷却/跳转解析的引擎(sogou)保留手写
- **风控检测**:页面长度阈值 + 验证页关键词;命中 → `blocked:true + reason`(reason 会出现在降级/聚合日志)
- **风控降触发策略**(参考 sogou):触发验证码后冷却(模块级 blockedUntil + `setCooldown`),首次搜索先建 cookie 会话
- **URL 真实性**:跳转链在本地解码(正则提取真实 URL),不依赖浏览器;广告块按特征剔除,宁缺勿滥

### fixture 与回归(站点改版时的维护闭环)

1. `scripts/update-fixtures.mjs` 加 target:`{name, url, mobile?, verify: (html) => !parseXxxHtml(html, 8).blocked && parseXxxHtml(html, 8).results.length >= 1}`
2. `npm run fixtures` 重抓真实页快照(存 `fixtures/xxx.html.gz`)
3. `tests.mjs` 加 `真实快照: xxx 搜索页可解析` 用例断言 `!blocked && results.length >= 1`
4. 解析器改版后:先 `npm test` 定位失败 → `npm run fixtures` 重抓 → 仍失败则更新解析器

---

## 测试

```bash
cd ~/.pi/agent/skills/websearch
npm test       # 单元回归 node --experimental-test-module-mocks --test scripts/lib/tests/unit/*.test.mjs(192 用例,≈5s)
       # ⚠ 脚本已带 --experimental-test-module-mocks(cli 决策链测试依赖 mock.module)
       # 手动 node --test 跑 cli.test.mjs 会 skip(提示用 npm test),不崩
       # npm run test:integration 慢测试(浏览器/网络/TLS 后端,5 用例)
       # npm run test:all 全量 197

npm run fixtures   # 重抓真实搜索页快照(站点改版时)
```

测试分三类:
- **纯函数单测**(手写样例 HTML):实体解码、各引擎解析器、污染检测、正文提取、TLS 判定/预算/冷却
- **真实快照回归**(fixtures/*.html.gz):用真实搜索页 HTML 跑解析器,断言能解析出合法结果
- **调度链单测**(cli.test.mjs,mock.module):runFetch 决策链 8 场景 —— 缓存命中/直连达线/空壳兜底/兜底失败/403/CF 记忆/skipZendriver/缓存写入决策;index.test.mjs 冒烟 —— 公共 API 入口可加载(曾因导出不存在的 enWordsFeatures 静默崩溃,171 测试全过也没抓到)

新增解析器(cnnews 的 extractNewsLinks/isArticleUrl、hotlist 各榜单 parse 函数)均带手写样例单测,
改版时先跑 `npm test` 定位解析器失效,再 `npm run fixtures` 重抓快照(或补手写样例)。

> ⚠️ 真实快照测试失败 = 站点改版,解析器对真实结构失效。先 `npm run fixtures` 重抓快照,若仍失败则需更新解析器。

---

## 域名信誉评分 + 双循环元学习(domain-rep.mjs)

中文搜索结果的软文污染是动态演化的(SEO 站群换域名/换路径/换模板),静态黑名单或
`site:` 限定治标不治本。本系统从**每次搜索结果 + 每次 fetch 实测**学习,对域名评分后
**软降权**(压沉不剔除,URL 永不丢),且新域名(站群换域名)无需积累样本即可冷启动预测。

### 双循环结构(元学习)

```
┌─ 内循环(模式学习):已知域名样本(学习式 token 特征 + 实际质量贡献)
│     → 在线更新 token 权重(词袋逻辑回归,特征从数据中涌现、无人工词表)
│ 外循环(冷启动匹配):新域名首次出现(无自身样本)
│     → 提取 token → 模式权重预测初始信誉分,立即软降权/加权
└─ 反馈闭环:新域名每次出现的新数据同时更新
      ① 该域名自身信誉分(域名级学习) ② 模式权重(模式持续演化)
```

### 三级信号(弱→强)

| 信号 | 来源 | 说明 |
|---|---|---|
| **LLM 内容可信度判断**(主) | 每次搜索结果批量调 LLM(OpenAI 兼容,默认 deepseek,可切硅基流动) | 判断每条结果是否 SEO 软文 → 可靠 label 驱动**域名级 + 模式级**学习;失败自动降级 quality |
| 规则质量分 quality + 低质标记 | filter.mjs | 推断信号,仅 LLM 不可用时的兜底 |
| 低相关折叠 | 聚类展示阶段 | 该域结果与查询无关 → 轻负(0.35,不冤枉内容站) |
| fetch 实测正文质量 | fetch 命令回写 | 三分类(`classifyFetchResult`,纯函数):正文完整 → **LLM 判内容可信度**(软文正文完整也能打开,不能因"能抓到"就给正;LLM 失败保底温和正 0.6);**反爬/风控拦截(403/40362/验证码)→ 中性只计 `fetchBlocked` 不降分**(内容可能很好只是被拦,见 `learnFetchBlocked`);真空壳/404/HTTP 错误 → 0.1 负反馈;网络/浏览器环境错误 → 中性不降分;strong 固定大学习率 |

### LLM 判定(为何必要)

回测实证:纯 quality 分学习时,元学习学到的是**主题偏置**(“工程信息平台”类查询的
命中页全是 0.85+,主题词全学正 → 软文站冷启动预测 0.71 > 干净站 0.57,方向反了)。
quality 分是“形态可用性分”,不是“内容可信度分”——软文站形态完全正常。
换成 LLM 判断后:软文模板站冷启动预测降到 **0.35**(降权),干净站/普通站中性;
真实搜索里企业博客软文域名分从 1.00 降到 **0.09** ⚠。

LLM 配置(OpenAI 兼容,默认开箱即用):
- `WEBSEARCH_LLM_BASE_URL` / `WEBSEARCH_LLM_MODEL` / `WEBSEARCH_LLM_KEY`
- 默认 deepseek 直连(读 ~/.pi/agent/auth.json 的 deepseek.key);硅基流动:
  `WEBSEARCH_LLM_BASE_URL=https://api.siliconflow.cn/v1 WEBSEARCH_LLM_MODEL=deepseek-ai/DeepSeek-V3`
- `WEBSEARCH_LLM_OFF=1` 关闭(降级 quality);LLM 失败自动降级 quality 学习并照常保存
- **进程退出前阻塞等待 LLM 判断完成**(学习不丢失):展示先行,结果已输出后才等;
  通常 2-5 秒(冷判断),热缓存/已知域名 0 秒;最坏 = LLM 请求自身 30s 超时 → 降级保存;
  等完这次判断入缓存,后续所有搜索零成本
- 批量判断(一次最多 35 条),返回每条的**低质分 + 类型** → label = 0.05 + 0.9×(1−低质分)

### 低质三类(LLM 判断维度)

| 类型 | 特征 | 示例 |
|---|---|---|
| `soft` SEO 软文 | 发稿商营销文,标题堆砌“推荐榜/测评/免费领取” | 工程信息平台推荐榜 |
| `ad` 广告/推广页 | 落地页,“点击咨询/免费试用/限时优惠”,无实质内容 | 云服务器促销落地页 |
| `ai` 低质 AI 生成文 | AI 批量生产:泛泛而谈、空洞无物、“在当今数字化时代...”式开场 | SEO 站的伪装正文 |
| `normal` 正常 | 有实质信息(教程/问答/论文/官方) | CSDN 教程、知乎问答 |

三类统一映射为低质分(0~1)驱动信誉;类型随判断缓存持久化(`ty` 字段),
fetch 复用搜索阶段的标题类型做综合判断(防“标题软文 + 正文正常”洗白)。

- 注意:推理模型会把 token 花在 reasoning 上,max_tokens 需 ≥4096(默认 8192)

### 关键设计决策

### 学习式 token 特征(非硬匹配)

特征 = 数据自动涌现的 token,**无人工词表、无硬编码规则**:
- 标题:中文 2-gram + 英文/数字词(如 `t:推荐` `t:python`)
- URL:路径段(`u:` 前缀,纯数字段归一化为 `u:n` 防日期过拟合)+ 域名标签(`d:` 前缀)
- 内容:filter.mjs 低质标记映射(`f:spam-desc` 等)

哪个 token 预示低质,**由权重在线学习决定**:token 频繁出现在低质样本 → 权重自动变负,
频繁出现在高质量样本 → 变正;高频泛词被大量不同质量样本平均 → 权重趋 0,自动无害。

### 关键设计决策

- **子域折叠到注册域**:news.xnnews.com.cn → xnnews.com.cn(否则同站不同子域样本切碎)
- **引擎域/功能路径排除**:e.so.com、link.zhihu.com、baidu.com/landing 等不参与
- **公众号加密链接**(weixin.sogou.com/link):域名无法归因 → 只学标题 token,不学 URL
- **fetchScore 与 searchScore 分离**(有效分 0.7/0.3 融合):实测信号不被大量中性搜索样本稀释
- **无特征预测 = 0.5 先验中性**:bias 不参与预测,新域名不冤枉也不放过
- **冷启动预测 0.5 系数压缩**:LLM label 驱动的模式已无偏置,但新主题的泛化词尚未学熟,
  压缩到中性附近避免极端——保守不误伤,负权重驱动的降权仍明显
- **desc-empty 中性化**:知乎等反爬站 desc 为空 ≠ 内容差,不计入内容低质率
- **时间衰减**:30 天未见向 0.5 回归,90 天完全中性(站点会改版,不永久定罪)

### 展示

每条结果附加信誉 badge:`✓[rep:0.82]`(高信誉)/ `⚠[rep:0.31]`(低信誉)/ `[meta:0.71]`(冷启动预测)。
调试:`stats()` 返回最低/最高域名 + 学到的 top 权重(看模式学到了什么词)。

### 持久化

`~/.cache/websearch-domain-rep.json`(跨 CLI 进程增量积累;域名上限 5000,超限清最久未见;token 权重上限 6000)。

---

## 配置与环境变量(调参索引)

所有超时/UA/阈值集中配置于 `scripts/lib/config.mjs`,调参先看这里;以下环境变量可在运行时覆盖:

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `SILICONFLOW_API_KEY`(或技能目录 `.env.json`) | - | 语义嵌入 API key(硅基流动) |
| `SILICONFLOW_EMBED_MODEL` | `Qwen/Qwen3-Embedding-8B` | API 嵌入模型(可换 `BAAI/bge-m3`) |
| `SILICONFLOW_API_BASE` | `https://api.siliconflow.cn/v1` | OpenAI 兼容嵌入 API 基址 |
| `WEBSEARCH_EMBED_BACKEND` | api | `local` 强制本地 WASM 兜底 |
| `WEBSEARCH_EMBED_MODEL` | `Xenova/bge-small-zh-v1.5` | 本地嵌入模型(中英混合换 multilingual-e5-small) |
| `WEBSEARCH_SIM_THRESHOLD` | 0.42(本地)/0.5(API 自动) | 聚类相似度阈值(换 e5-small 需调 0.8) |
| `WEBSEARCH_REPRINT_THRESHOLD` | 0.75 | 语义转载折叠候选门槛(0.75~0.94 区间需标题/摘要 LCS 文本证据) |
| `WEBSEARCH_MAX_CLUSTER_SIZE` | 12 | 超大簇拆分启动阈值(簇成员数超过则做动态拆分检查) |
| `WEBSEARCH_BUCKET_SINGLETONS` | 1(默认开) | 单例语义桶合并(UPGMA,零固定阈值;=0 关闭) |
| `WEBSEARCH_MAX_BUCKET_SIZE` | 6 | 语义桶规模上限(防一桶吞下所有单例) |
| `EMBED_API_DIMENSIONS` | 1024 | API 嵌入 MRL 输出维度压缩(实测 4096→1024 相似度误差<0.005,存储/计算省 4 倍;0=不压缩;不支持的提供商自动回退全维) |
| `WEBSEARCH_SEM_WEIGHT` | 0.45 | 语义相关性在簇分数中的权重 |
| `WEBSEARCH_SEM_NOISE` | 0.32 | 语义低相关判定阈值 |
| `WEBSEARCH_REL_MODE` | balanced | `conservative` 只排序不折叠 / `aggressive` 同 balanced |
| `WEBSEARCH_BROWSER_PATH` | 自动探测 | 指定浏览器可执行文件 |
| `SEARX_INSTANCE` | priv.au/searxng.site | SearXNG 公共实例 |
| `DOMAIN_RATE_LIMIT_MS` | 1500 | 同域连续请求最小间隔 |
| `WEBSEARCH_TLS_FALLBACK` | 1(开) | 直连 fetch 命中 403/TLS 拦截时用浏览器指纹 curl 变体(curl-impersonate/curl_cffi)重试;=0 关闭 |
| `WEBSEARCH_DEBUG` | 0(关) | 结构化决策追踪:输出抓取/降级链完整决策(每步耗时 + 各通道结果长度),快速定位卡点。`WEBSEARCH_DEBUG=1 node scripts/websearch.mjs fetch "URL"` 示例见下 |
| `TLS_FAIL_THRESHOLD` / `TLS_COOLDOWN_MS` | 2 / 30min | TLS 兜底失败记忆:域名连续失败达阈值进入冷却,期内跳过 impersonate(硬拦站不白等);成功清零 |
| `WEBSEARCH_REP_STRENGTH` | 1.6 | 域名信誉分 → quality 乘性因子映射斜率(0.5→1.0,0→0.35,1→1.15) |
| `WEBSEARCH_META_LR` | 0.05 | 元学习 token 权重在线学习率(随样本数递减) |
| `WEBSEARCH_META_STRONG_LR` | 0.2 | fetch 实测等强信号的固定学习率(不被递减 lr 稀释) |
| `WEBSEARCH_META_MIN_SAMPLES` | 30 | 模式库最少样本数,少于时冷启动预测不启用 |
| `WEBSEARCH_META_MAX_WEIGHTS` | 6000 | 学习式 token 权重上限(超限清最久未见一半) |
| `WEBSEARCH_META_L2_DECAY` | 0.001 | 惰性 L2 收缩(每步对激活 token 权重乘 1-λ 向 0 回归;罕见 token 偶然证据被冲淡,防稀疏特征过拟合) |

其他硬编码常量(改 config.mjs):`TOTAL_BUDGET_MS=40s`(降级链总预算)、`HTTP_TIMEOUT_MS=10s`、
`COOKIE_TTL_MS=24h`、`CLUSTER_DUP_THRESHOLD=0.94`(近似重复)、`CNNEWS_MAX_AGE_DAYS=30` 等。

---

## 维护者笔记

### 目录结构

```
websearch/
├── SKILL.md
├── package.json                # 可选依赖: puppeteer-core/playwright;exports 映射支持库导入
├── update-fixtures.mjs         # 抓真实搜索页存 gzip 快照(npm run fixtures)
├── docs/
│   └── ANTIBOT.md              # ★ 反爬武器库架构(模块地图/反爬类型→对策速查/复用接口)
├── scripts/
    ├── websearch.mjs           # CLI 入口(薄壳:catch + exit)
    ├── inspect.mjs             # ★ 浏览器检查模式(DevTools 子集:--js/--select/--network/--console/--cookies/--screenshot)
    ├── setup-semantic.mjs      # ★ 一键启用语义嵌入层(transformers.js + WASM 后端)
    └── lib/
        ├── index.mjs           # 公共 API 出口(库复用入口)
        ├── config.mjs          # ★ 全局配置集中:所有超时/UA/阈值,调参先看这里
        ├── engines.conf.json   # ★ 引擎注册表(声明式):引擎 + 降级链,扩展只改这里
        ├── cooldown.mjs        # 失败记忆/冷却通用工具(引擎失败/API 失败/验证码三处复用)
        ├── persist.mjs         # ★ 跨进程基础设施:CF 站点记忆 / 页面缓存(6h) / 浏览器调试日志 / hostOf(测试可注入临时目录)
        ├── antiblock.mjs       # ★ 统一反爬检测中心:isAntibotContent/classifyFetchResult/detectAntibot/isCfAnti(单一事实来源)
        ├── cli.mjs             # CLI 调度门面:参数解析、引擎调度(runSearch)+ main + re-export runFetch/cacheFetchResult
        ├── format.mjs          # 展示层:搜索结果(过滤→聚类流水线)/抓取/榜单输出 + 页面缓存写入
        ├── fetch-flow.mjs      # 抓取调度:runFetch 决策链(缓存/直连/空壳/CF/404)+ 存档兜底
        ├── learn.mjs           # 域名信誉单例 + LLM 学习队列(queueLLMLearn/waitLLM,展示先行退出前落盘)
        ├── domain-rep.mjs     # 域名信誉实例 + 门面 re-export(双循环元学习编排:域名级+模式级)
        ├── rep-features.mjs   # 信誉特征提取(纯函数):域名解析/引擎域排除 + 学习式 token(标题/URL/内容标记)
        ├── rep-score.mjs      # 信誉评分纯函数:贡献分/增量更新/时间衰减/乘性因子/badge + 元学习权重更新
        ├── http.mjs            # HTTP 封装(UA/超时/限速/Cookie 持久化/httpGetJson/tcpProbe)
        ├── tls.mjs             # TLS 指纹兜底(curl-impersonate/curl_cffi,JA3/JA4 对抗)
        ├── html.mjs            # 实体解码、标签剥离、文本清洗
        ├── filter.mjs          # ★ 广告/噪声规则过滤(硬剔除广告 + 软降权垃圾,零依赖)
        ├── embed.mjs           # 可选语义嵌入层(transformers.js,不可用自动降级)
        ├── cluster.mjs         # ★ 聚类组织门面:clusterResults 主函数 + DEFAULT_OPTIONS + 全部公共导出(re-export)
        ├── cluster-phrase.mjs  # 短语模式:分词工具(cnGrams/enWords/queryTokens/titleTokens...)+ STC 建簇(零依赖)
        ├── cluster-semantic.mjs# 语义模式:余弦/转载检测 + 贪心首领聚类/超大簇拆分/单例桶合并(零固定阈值)
        ├── cluster-labels.mjs  # 可读簇标签/簇内差异标注(站点样板清洗 + LCS,纯字符串工具)
        ├── fetch-page.mjs      # 正文提取:Readability 优先,正则回退,Markdown 输出(turndown)
        ├── fixtures/           # ★ 真实搜索页快照(gzip,测试回归用)
        └── engines/
            ├── bing.mjs        # bing 直连 + /ck/a 链接解码 + 地域污染检测 + 滚动数组 LCS
            ├── baidu.mjs       # baidu 直连(移动 UA)+ 风控检测
            ├── sogou.mjs       # sogou 会话 + 验证码冷却 + 跳转链接解析
            ├── so360.mjs       # 360 搜索直连
            ├── sm.mjs          # 神马搜索直连(移动 UA)
            ├── toutiao.mjs     # 头条搜索直连(T.flow SSR)
            ├── github.mjs      # GitHub 仓库搜索(GitHub API,匿名限额)
            ├── hn.mjs          # Hacker News(Algolia API,英文专用)
            ├── wikipedia.mjs   # Wikipedia(MediaWiki API,英文专用)
            ├── marginalia.mjs  # 英文独立索引(不受 CN IP 地域影响)
            ├── cnnews.mjs      # 官方新闻源白名单(人民网/共产党员网)
            ├── hotlist.mjs     # 平台热搜榜(weibo/douyin/baidu/toutiao)
            ├── trending.mjs    # GitHub 热门项目榜
            ├── searx.mjs       # SearXNG 实例聚合(可选,已排除默认聚合)
            ├── browser.mjs     # Chromium 浏览器兜底(三层能力,可选;stealth/拟人行为已拆子模块)
            ├── browser-stealth.mjs  # stealth 注入脚本(抹 webdriver/补插件/Canvas 噪声,纯静态资源)
            ├── browser-humanize.mjs # 拟人行为(bezierPath 纯函数 + humanize 鼠标/滚动)
            ├── factory.mjs     # 直连型引擎工厂(URL+parse 纯函数即引擎)
            └── registry.mjs    # 引擎注册中心:配置→实现映射 + 引用完整性校验
```

### Termux/Android 语义嵌入适配(为什么默认装不上、怎么绕)

- 根因:transformers.js 的默认后端 `onnxruntime-node` 是原生 glibc 库,无 android 预编译——
  npm 安装时平台校验直接拒绝:`EBADPLATFORM wanted {win32,darwin,linux}`(实测),连二进制都到不了加载阶段
- 绕法:embed.mjs 在 android 平台自动用 `module.registerHooks()` 把 `onnxruntime-node` 重定向到
  `onnxruntime-web` 的 **Node 专用入口**(ort.node.min.mjs,纯 WASM + fs 加载,不用 fetch/blob),
  `sharp`(无 android 运行时,embedding 用不到)重定向到空 shim
- 实测:本设备(Termux bionic + WASM)嵌入正常,384~512 维,模型缓存后加载 1.45s;
  桌面(glibc/macOS/Windows)不注册 hooks,onnxruntime-node 原生库直接可用
- 模型缓存于 `node_modules/@huggingface/transformers/.cache/`(~100-200MB,可删释放)

### 调研结论

网上无轻量 JS 搜索结果聚类库(Carrot2 为 Java),故按 STC/LINGO 经典思想自研。
`--flat` 关闭聚类返回平铺结果(兼容旧输出)。

### 正文提取(Readability)说明

fetch 命令正文提取用 **Mozilla 官方 @mozilla/readability**(Firefox 阅读模式同款)+ jsdom:
1. jsdom 解析 DOM → Readability 逐节点文本密度/链接密度评分,对复杂页面(门户/多栏布局)鲁棒
2. 解析失败或结果 <100 字符 → 自动回退自研正则方案(article/main → class 容器 → body 全文)
3. title 修正:Readability 优先 og:title,当其是站点标语且 <title> 更具体时改用 <title>
4. **Markdown 输出**:Readability 的 article.content(已剔导航)经 turndown 转 Markdown,
   CLI 默认打印 markdown 字段(标题层级/链接/表格/代码块保留);正则回退无 DOM 结构,markdown 即纯文本

已知局限:列表页(如 GitHub 趋势、聚合页)非文章结构,两个方案都会带出导航文本,属 Readability 设计边界。
2026-08 已缓解:正文不足(版权壳/SPA 壳/时间戳流)但页面含 ≥3 条新闻链接时,自动切换为链接列表输出
(`extractLinkList`,DOM 遍历非正则) —— 中新网首页 127 字符版权壳 → 222 条带日期新闻列表。

### trending 命令(GitHub 热门项目榜)实现

- 直连 `github.com/trending`,服务器渲染 HTML 纯正则解析,无 API key、无风控
- 每项:owner/repo · 描述 · 增量⭐(今日/本周/本月,页面只给增量不给总 star)· 语言
- 实现:engines/trending.mjs(parseGithubTrending 纯函数 + fixture 回归)

### hotlist 各榜单实现

| 榜单 | 通道 | 实现 |
|------|------|------|
| `weibo` 微博热搜 | 镜像直连(tophub)→失败自动切官方页 | 官方页需浏览器渲染,jsdom DOM 提取 |
| `douyin` 抖音热榜 | 官方页(www.douyin.com/hot) | 需浏览器渲染(数据由签名 API 异步加载),jsdom 从混淆 class 的 DOM 提取 `a[href^="/hot/"] > h3` |
| `baidu` 百度热搜 | 官方公开 JSON API | 直连,无需浏览器 |
| `toutiao` 头条热榜 | 官方公开 JSON API | 直连,无需浏览器 |

浏览器通道说明:微博/抖音官方接口需登录或签名,**无头浏览器渲染是唯一直连方案**(已修库模式
`isConnected` bug,现 playwright/puppeteer 均可驱动 chromium)。

### 变更记录(2026-08)

**抓取健壮性(问题修复轮)**
- **列表页自动提取**(fetch-page.mjs `extractLinkList`,DOM 遍历非正则):正文不足(版权壳 127 字符/SPA 壳/
  时间戳流)但含 ≥3 条新闻链接 → 输出带日期链接列表,发布时间=列表最新条目。修复:中新网首页空壳
  (222 条列表)、国际在线滚动频道只拿时间戳、频道页 meta 2018-03-28 误导(列表页不再采 meta 日期)
- **SPA 懒加载占位检测**(antiblock.mjs):正文短且含“正在加载/页面加载中”等 → 判 truncated,浏览器渲染后重试
  (央视网“正在加载”壳);列表页结果(≥3 条)直接判 full,不浪费浏览器兜底
- **浏览器兜底失败原因分诊**(browser.mjs + fetch-flow.mjs):`getLastBrowserFailure()` 记录失败阶段,
  降级日志区分“未装 Chromium”与“已装但站点反爬(403/40362)” —— 不再误导性报“浏览器不可用”;
  chromium 探测路径硬编码 Termux 默认前缀,不依赖 `$PREFIX` env
- **发布时间 ML 裁决**(date-ml.mjs,传统在线学习非 LLM):规则候选(meta/JSON-LD/URL/正文/JS 变量/列表时间)
  + 感知机模型选最可信,列表页 meta 降权、仅 meta 的列表页拒绝输出;弱监督反馈(多候选一致性/渲染后验证/
  列表页形态)在线收敛,持久化 `~/.cache/websearch-date-model.json`
- **SERP 日期提取**(bing/baidu):短文本节点扫 "2026年8月5日"/"3小时前" 等 → `date` 字段,旧文沉底/--since 的数据基础

**时效与时间线**
- `--since 24h|1w|1m|1y|YYYY-MM-DD` 结果级硬过滤(cli.mjs,全部引擎生效):超窗且带日期剔除,无日期保守保留
  —— “国内外大事件”混入 2018-2023 旧闻/高考时政/PPT 模板直接剔除;时间意图词扩展(大事件/突发/进展/要闻),
  历史意图保护(19xx/历史/纪念/周年 不启用沉底)
- **timeline 命令**(timeline.mjs):复杂事件(美伊冲突等)分散多篇报道 → 聚合搜索+并行抓取(并发 3,预算 75s)
  + 提取发布时间与首段要点,按月分组输出;无日期文章单列 URL 不丢

**聚合等待与连通性**
- `PER_ENGINE_TIMEOUT_MS=12s`(config.mjs):聚合单引擎独立超时上限,慢引擎不再拖满全局 40s 预算
  (实测 github 曾拖 39997ms → 现 12s 快速放弃)
- TCP 连通性预检(http.mjs `tcpProbe`):聚合前 2s 并发探测各引擎域名(engines.conf.json 的 `host` 字段),
  完全连不通的直接跳过(实测 marginalia/wikipedia 不通)
- 失败记忆持久化(cooldown.mjs,跨 CLI 进程):连续失败 2 次 → 冷却 30 分钟(aggregate)/5 分钟(embed),
  冷却期内直接跳过;成功清零自动恢复。文件: `~/.cache/websearch-engine-fail.json` / `websearch-embed-fail.json`
- github/hn/wikipedia 原生 fetch 改为统一 `httpGetJson`(http.mjs):复用限速/Cookie/超时层,不再手写 AbortSignal

**内存安全(OOM 修复)**
- `longestCommonSubstring`(bing.mjs)改滚动数组(Uint32Array 双行):O(n×m) 矩阵 → O(m) 内存,
  4~9× 更快;原 6.5 万字符 desc 的完整 DP 矩阵 ≈34GB → 19KB
- github desc 数据源截断 512(部分仓库把 README 塞进 API description 字段)
- `isNearDuplicateDesc`(cluster.mjs)4096 字符防御上限;`readableClusterLabel` 标题 200 截断
  (保护 `longestCommonSpan` 完整矩阵)
- embed 文本先截断再拼接(title 200/desc 400 → 总 512),wikipedia snippet 截断 400

**配置/引擎**
- searx 移出聚合(`AGGREGATE_EXCLUDE`,单引擎 `--engine searx` 仍可用);聚合伙伴:
  bing+baidu+sogou+so360+github+sm+toutiao
- 通用冷却工具 cooldown.mjs:aggregate(引擎失败)/embed(API 失败)/sogou(验证码)三处复用,
  embed 冷却从进程内改为持久化(原 CLI 每次独立进程导致冷却失效)
- 删除无引用的实验脚本 experiment-upgma.mjs

**解析层对齐业界主流(DOM 选择器替代正则解析 HTML)**
- 调研:SearXNG(249 引擎 lxml XPath 主力)/Whoogle(BeautifulSoup)/duckduckgo_search(lxml XPath)
  一致做法 —— 结构定位用 DOM 选择器,正则只做文本清洗与内嵌 JSON/JS 数据块提取
- 新建 dom.mjs(linkedom 封装):parseDom/elementText/queryOne/queryAll,对标 SearXNG 的
  eval_xpath/extract_text
- bing/baidu/so360/sm/sogou/marginalia/searx/trending 解析全部从正则改 DOM 选择器
  (如 bing `<h2[^>]*>` → `queryOne(block, "h2 a[href]")`);正则保留的正当用途:
  ① 文本清洗(clean/stripTags)② 内嵌 JSON/JS 数据块(baidu pure-summary/toutiao SSR 字段,
  同 SearXNG acfun.py 的 bigPipe 提取)③ URL/特殊格式清洗
- 单测传 HTML 字符串的解析辅助函数(asElement)兼容字符串/DOM 双输入
- 收敛:linkedom 只在 dom.mjs 导入(单一解析入口,被 10 个文件复用);
  asElement/parseDomOr 抽到 dom.mjs(消除 baidu/marginalia 重复与 8 处畸形 HTML 样板)

**新引擎:chinaso(中国搜索·央媒新闻源)**
- 候选调研:夸克(x5sec 反爬)/Yandex(smartcaptcha)/Ecosia(Firewall 403)/Mojeek(403)
  全部不可接入;chinaso 直连是 SPA 空壳无 SSR,但浏览器渲染实测有效
- chinaso.mjs:SPA 渲染后 DOM 解析(div.list + a.common-title + p.common-summary +
  source-name/time);search 走浏览器兜底(getDom + parseSerp),不参与聚合
  (AGGREGATE_EXCLUDE,单引擎可用),fixtures 浏览器抓取(update-fixtures browser 标志)

**GitHub 调研升级(chinaso 直连 API + sogou-wechat 新增)**
- 查证 SearXNG 源码(249 引擎):chinaso.py 揭示官方 JSON API `/v5/general/v1/web/search`
  (带 uid cookie = base64(random16B) 绕过 IP 限制;无 cookie 返回 "ip control")
  → chinaso 从浏览器(16s/2GB)升级为直连 API(0.6s),浏览器降为 fallback,不再参与聚合
- sogou_wechat.py 揭示微信公众号搜索接口 `weixin.sogou.com/weixin?query=&type=2`
  (li[id^=sogou_vr_] + h3/a + p.txt-info + span.all-time-y2 + timeConvert 脚本)
  → 新增 sogou-wechat 引擎(聚合伙伴,微信生态内容收录),fixtures+2 测试
- tsToDate 从 toutiao.mjs 上移 html.mjs 导出(三处共用)
- 附带核实:ecosia 从未存在于 SearXNG(404);yandex 检测 captcha 即放弃;quark 2025-03 加入
  且持续维护(正确接口 quark.sm.cn/s + s-data JSON 块,本环境 IP 被 x5sec 拦)

**TLS 指纹兜底 + 浏览器 stealth(2026-08 续)**
- 新增 tls.mjs:直连 fetch(undici)TLS 指纹与真实 Chrome 不同,Cloudflare 系/防火墙按 JA3/JA4 拒握手。
  httpGet/httpGetFull 命中候选失败模式(403 / ECONNRESET / EPROTO / 证书错误)时,自动用浏览器指纹
  curl 变体重试:① curl-impersonate 二进制(curl_chrome120 等版本化名内嵌指纹;generic 用
  `--impersonate chrome120`)② python3 + curl_cffi(Termux 实测:先 `pip3 install cffi` 编译,
  再装 `curl_cffi` 0.16 android wheel)。可用性探测一次缓存;两者皆无 → 静默跳过,零回归。
  重定向 set-cookie 全段收集喂回 jar;`WEBSEARCH_TLS_FALLBACK=0` 关闭。纯函数
  parseCurlOutput/isTlsFallbackCandidate 单测 3+1 用例
- 浏览器 stealth(browser.mjs):STEALTH_INIT_SCRIPT 页面脚本前注入 —— 抹 webdriver、补
  languages/plugins/window.chrome/permissions、Canvas toDataURL/toBlob ±1 像素噪声(指纹对抗);
  库模式 playwright 走 newContext+addInitScript、puppeteer 走 evaluateOnNewDocument,统一视口
  1366×768 + locale zh-CN(与 UA 画像一致);CLI 模式加 `--disable-blink-features=AutomationControlled`
  + `--lang=zh-CN`(实测 Chromium 149 webdriver → false)。等待改拟人:随机抖动 + 分步非匀速滚动。
  单测 2 个纯断言 + 2 个 live 测试(库模式 webdriver=undefined、CLI 模式=false,无 chromium 自动 skip)
- 调研结论:marginalia 的 37KB/191KB 页差异是**按 IP 限流轮换**,非 TLS 指纹拦截(直连/impersonate
  双向都观察过好坏互换)→ 未给 marginalia 挂 impersonate,维持原浏览器兜底;mojeek 连 curl_cffi
  BoringSSL 握手都被 RST(网络层拦截),兜底救不回,保持文档记录
- **TLS 失败记忆/冷却**(2026-08 续):impersonate 救不回的网络/IP 硬拦站(如 mojeek)连续失败 2 次 →
  冷却 30 分钟(复用 cooldown.mjs,持久化 `~/.cache/websearch-tls-fail.json`,成功清零不误伤),期内
  httpGetViaImpersonate 直接短路(0ms),不再白等 curl 8-10s;顺手修一个真 bug:impersonate 返回
  非 200(403 页)原会被 tryTlsFallback 误当成功返回,现 status!==200 一律视为失败并累计。测试 +3
  (冷却短路 / 成功清零 / 非 200 不当成功 mock 回归)。实测确认 mojeek 为间歇性硬拦:undici 有时直接
  200(成功清零,冷却不触发是设计意图),连续 403 时段冷却立即生效
- **Scrapling StealthyFetcher 深挖反哺**(2026-08):pip 下载 scrapling 0.4.12 源码(pip 清华镜像,
  GitHub 无梯子拼不通时的替代通道),分析其 stealth 体系并落地到 browser.mjs:
  - **`ignoreDefaultArgs: ["--enable-automation"]`**(库模式):playwright/puppeteer 默认加
    `--enable-automation` 正是 navigator.webdriver=true 的源头,直接移除比 JS 注入更彻底
    (Scrapling 的 HARMFUL_ARGS 做法,patchright 同款思路)
  - **Google referer**:page.goto 默认带 `Referer: https://www.google.com/`(Scrapling google_search
    默认开),让目标站以为是搜索引擎流量;国内站(百度系/微博/抖音/淘宝/B站/知乎/头条/小红书)排除
  - **Chromium 原生 Canvas 噪声 flag**:`--fingerprinting-canvas-image-data-noise`(Chromium 149
    实测接受,替代 JS 注入的更早生效方案,JS 注入保留为双保险)
  - **STEALTH_ARGS 精选**:`--start-maximized`(headless check bypass)、`--test-type`、
    `--force-color-profile=srgb`、`--font-render-hinting=none`(影响 Canvas 字体渲染哈希)、
    `--disable-cookie-encryption`、`--mute-audio`、`--disable-logging`;CLI 模式同步补
  - 未落地:Cloudflare Turnstile 自动求解器(识别 cType → iframe 定位 → 拟人鼠标点击 →
    循环检测 "Just a moment..." 消失,约 100 行,后续按需移植);browserforge 头生成
    (curl_cffi impersonate 已覆盖);disable_resources 提速(有破坏 JS 页风险)
- **Cloudflare Turnstile 求解器移植**(2026-08):Scrapling `_cloudflare_solver` 思路落地 browser.mjs ——
  `detectCloudflareChallenge`(纯函数,单测 7 断言)识别 cType(non-interactive/managed/interactive/
  embedded)→ non-interactive 纯等待自动跳转;interactive 类定位 Turnstile 复选框(CF iframe →
  CSS 选择器退路)→ 拟人点击(坐标略偏中心 + 按下延迟 100-200ms)→ 轮询 "Just a moment..." 消失
  (最多 3 轮,总预算 20s 防拖慢聚合);先检测再动手,普通页面零开销。仅库模式(page 可交互),
  CLI 模式维持 virtual-time-budget 方案。真实验证:marginalia 直连验证页 → 浏览器兜底带 solver
  正常返回结果。测试 +1(142 全过)
- **反爬类型识别器 antiblock.mjs + 贝塞尔拟人轨迹**(2026-08):
  - 新模块 antiblock.mjs:detectAntibot 纯函数识别 6 类反爬(Cloudflare Turnstile /
    Cloudflare interstitial / JS 倒计时 / 限流 / 验证码 / 通用封禁),优先级从具体到通用
    (cType > interstitial > captcha > blocked)。接入 marginalia:blocked reason 带类型标签,
    降级日志 `[degrade] marginalia 触发反爬:JS 倒计时/启用 JS 验证(将尝试浏览器兜底)`
    —— agent 一眼知道被什么挡了、为什么走浏览器兜底。scrapfly Antibot-Detector 思路精简版
  - humanize 升级贝塞尔:bezierPath 纯函数(三次贝塞尔随机控制点),鼠标沿贝塞尔轨迹分步移动
    (8 步非匀速)+ 滚动贝塞尔插值(25% 概率 300-800ms 阅读停顿)—— 对抗 2026 AI 行为风控
    (真人非线性/带停顿 vs 机器匀速直线)。测试 +4(antiblock 3 + bezierPath 1,146 全过)
- **模块重构:依赖方向理清 + CF 求解器独立**(2026-08,可维护性审查落地):
  - 文本工具下沉 html.mjs:`longestCommonSubstring`(原在 engines/bing.mjs!)、
    `normalizeTitle`/`isNearDuplicateTitle`(原在 aggregate.mjs)→ 全部移到纯函数层 html.mjs;
    bing/aggregate re-export 保持外部兼容,cluster.mjs 改直接 import html.mjs。
    依赖方向恢复:cluster(纯算法)/aggregate(调度)/bing(引擎) 都只依赖纯函数层,
    消除 cluster→aggregate→bing 的绕环(聚合模块不再是"调度+工具"杂货铺)
  - CF 求解器独立 engines/cf-solver.mjs(149 行):detectCloudflareChallenge + solveCloudflareChallenge,
    browser.mjs 689→546 行,专注启动管理 + stealth;cf-solver 可单独复用/测试(index.mjs 导出)
  - 全量 146 测试通过,真实链路(marginalia 反爬识别 → 浏览器兜底)回归正常
- **cluster.mjs 拆分三模块**(2026-08,可维护性审查落地):870 行算法杂货铺按职责拆分,cluster.mjs 变门面——
  保留 DEFAULT_OPTIONS + clusterResults 主函数 + 全部 21 个公共导出 re-export(API 零变化,
  index.mjs/CLI/测试零改动):
  - cluster-phrase.mjs:分词工具(cnGrams/enWords/ZH_STOP/BRAND_ALIAS/queryTokens/titleTokens/tokenJaccard) + STC 短语建簇
  - cluster-semantic.mjs:余弦/转载检测(isNearDuplicateDesc/hasReprintTextEvidence) + 语义建簇
    (贪心首领/超大簇拆分/单例桶合并,零固定阈值算法)
  - cluster-labels.mjs:可读簇标签/差异标注(LABEL_SITE_HINTS/cleanTitleForLabel/longestCommonSpan/readableClusterLabel/pickSegment/distinctiveSpan)
  依赖方向保持:三个子模块只依赖纯函数层(html.mjs),cluster.mjs 只做编排。全量 203 测试通过
- **cli.mjs 拆分四模块**(2026-08,可维护性审查落地):709 行上帝模块(参数解析+调度+输出+LLM 学习
  四职责合一、依赖 14 模块)按职责拆分,cli.mjs 变调度门面——
  - learn.mjs:域名信誉单例(rep)+ LLM 学习队列(queueLLMLearn/queueFetchLearn/waitLLM),三处复用
  - format.mjs:展示层(printResults 过滤→聚类流水线 / emitFetchResult / 榜单输出 + 页面缓存写入)
  - fetch-flow.mjs:runFetch 决策链 + 存档兜底;cli.mjs re-export runFetch/cacheFetchResult 保持公共 API
  依赖方向:调度(cli) → 流程(fetch-flow) → 展示(format) → 纯函数层,LLM 学习集中在 learn.mjs。
  cli 决策链单测(mock.module 全局生效)零改动,全量 203 测试通过
- **domain-rep.mjs 拆分三模块**(2026-08,可维护性审查落地):613 行(评分+元学习+实例三合一)拆分——
  - rep-features.mjs:特征提取纯函数(registrableHost/repKeys/cnBigrams/enWords/urlTokens/extractLearnFeatures 等)
  - rep-score.mjs:评分纯函数(clamp/contributionFromQuality/updateScore/effectiveScore/decayedScore/repFactor/repBadge)
    + 元学习权重更新(predictTokens/updateMetaTokens,词袋逻辑回归)
  - domain-rep.mjs:createDomainReputation 实例(load/save/学习/应用)+ 门面 re-export 全部 23 个符号
  公共 API 零变化(index.mjs / domain-rep.test.mjs / backtest-meta.mjs 零改动),全量 203 测试通过
- **元学习算法加固**(2026-08,网络调研验证后落地,解决两个薄弱点):
  - 惰性 L2 收缩(updateMetaTokens):权重按距上次激活的步数差向 0 回归 —— 罕见 token 被 1-2 个
    偶然样本推走后,隔大量样本再现时证据已被冲淡(3000 步后衰减 99%);连续激活的稳定 token
    gap≈1 收缩与推动平衡保持显著;站群连发 5 条同路径证据不被稀释。依据:FTRL(Cornell/Google
    广告点击率场景同构——高维稀疏特征无正则必过拟合,见 Cornell FTRL 文档)
  - 冷启动置信度渐进(lookup):压缩系数从固定 0.5 改为随 weightSamples 线性趋近 1.0
    (刚过门槛 0.505,3000 样本全量)—— Bayesian smoothing 精神:模式越成熟预测越敢偏离中性
  - 新增配置:META_L2_DECAY(0.001,可环境变量覆盖)/ META_TRUST_FULL_SAMPLES(3000);
    meta 结构新增 lastStep(token 上次激活步数,淘汰/清理时同步删除,旧数据兼容)
  203 测试全过,backtest 与修改前一致(零回归)
- **per-token 学习率(2026-08,深挖 backtest 检验 1 后落地)**:全局递减学习率后期(lr≈0.002)
  新出现的软文套路 token 学不动 —— 词袋线性模型下新套路词权重永远起不来。改为
  per-token 学习率 `META_LR/(1+freq×0.01)`(由该 token 自身激活次数决定,与全局样本数无关):
  新 token 回到初始学习率 0.05,稳定 token 平滑回落(AdaGrad/FTRL per-coordinate 同源);
  strong(fetch 实测)仍固定大学习率。对照实验:weightSamples=2000 后 10 条新套路词样本,
  旧算法 -0.0095(冻结)vs 新算法 -0.1807(19 倍)。meta 新增 freq 字段(全链路同步,旧数据兼容)。
- **backtest-meta 检验重写(2026-08,深挖结论)**:检验 1 原期望“日期路径站应显著 <0.5”
  建立在错误假设上 —— u:n(数字路径段)在训练数据里主要来自正常高分站(文章 ID/日期归档),
  学成强正权重(+0.55),词袋模型无组合特征无法表达“软文词×日期路径”交互。改为:
  ① 相对判别期望(a ≤ c ≤ b 排序)② caseA token 分解诊断(看清预测由哪些 token 驱动)
  ③ 新增检验 1b(纯标题词判别,排除 u:n 干扰,差值 >0.05)
- **browser.mjs 拆 stealth/拟人行为**(2026-08):752→634 行——STEALTH_INIT_SCRIPT 提取到
  browser-stealth.mjs(纯静态资源,可单独单测/复用),bezierPath/humanize 提取到
  browser-humanize.mjs(纯函数 + 页面交互);browser.mjs import + re-export,公共 API 零变化
- **测试文件模块化**(2026-08):单文件 tests.mjs(1993 行)→ 按被测模块拆为
  scripts/lib/tests/ 下 9 个测试文件 + 共享 helpers.mjs(loadFixture/assertResultShape/
  clusterFromFixture/mockEngine)。块边界按 `^test(` 行首切分,零括号解析;
  新增测试:加到对应模块文件,共享 fixture 放 helpers.mjs。
- **测试单元/集成双层化**(2026-08):tests/ 按速度分层——`unit/`(141 用例,纯函数
  + 本地 fixture,`npm test` ≈ 3 秒)与 `integration/`(5 用例,真实 Chromium/网络/
  TLS 后端,`npm run test:integration`)。三个命令:
  `npm test`(unit 快回归)/ `npm run test:integration`(慢测试)/ `npm run test:all`(146 全量)。
  慢测试判定:开浏览器(stealth 注入/CLI)、真网络(限速并发)、起 python/curl(TLS impersonate)、
  真跑 main()(B1)。新增测试按此归位。

**知乎反爬攻坚 + 反爬模块重构(2026-08 续)**

- 调研结论:知乎 40362 = 未登录 + 自动化指纹 + UA 版本不匹配 + IP 频率的组合风控;文章页比首页严;
  正文在 SSR `js-initialData`(非 DOM 抠取);主流方案 = 登录 cookie(z_c0) + requests 直连;
  CDP 驱动浏览器(库模式)对知乎不可靠(网上《agent-browser 实战与踩坑》印证)
- 实测突破:未登录 + 干净 chromium CLI(无共享 profile)+ Chrome 149 UA(与本地版本匹配)+ 低频单次
  → 成功抓知乎文章页(474KB 含 Post-RichText)。此前失败的叠加根因:UA 120 版本不符、255MB 共享
  profile 被标记、库模式 CDP 指纹、连续请求触发 IP 临时风控、Termux CLI `--dump-dom`+`--user-data-dir` 死锁
- fetch-page.mjs:`extractSsrEmbeddedJson` 通用 SSR 数据槽提取(js-initialData/__NEXT_DATA__/__INITIAL_STATE__),
  `extractZhihuInitialData` 为知乎特例(标题/赞评/秒级时间戳修正)
- antiblock.mjs 升级为统一检测中心:`isAntibotContent`(合并散落三处的反爬正则,新增 40362/您当前请求
  存在异常 login-wall 类型)+ `classifyFetchResult`(抓取三分类 full/blocked/empty 纯函数);
  cli.mjs 删本地正则改消费分类器,browser.mjs 硬编码 40362 检测改调统一函数 —— 反爬检测单一事实来源
- domain-rep.mjs:`learnFetchBlocked` 反爬拦截中性化(只记 fetchBlocked 计数,不动 fetchScore/元学习),
  与真空壳负反馈(0.1)严格区分 —— 强反爬站(知乎)不再被 40362 误伤降分
- config.mjs:`buildChromeUa(version)`/`buildMobileUa(version)` 参数化;browser.mjs `probeChromiumVersion`
  启动时探测本地 chromium 版本自动生成匹配 UA(升级 chromium 零改动,导出供复用)
- browser.mjs:CLI 模式移除 `--user-data-dir`(Termux 实测 dump-dom+profile 死锁);库模式检测到风控内容
  强制降级 CLI 干净通道
- scripts/inspect.mjs(新):浏览器检查模式(DevTools 子集)—— `--js` 执行任意 JS / `--select` 查元素 /
  `--network` 监听网络(实测揭示知乎首载 403 + SPA 重载 200 的真相)/ `--console` / `--cookies` /
  `--screenshot`;复用 stealth + 版本匹配 UA,强风控站检查结果与真实浏览器一致
- index.mjs:修复 `enWords` 重复导出冲突(domain-rep 版改别名 `enWordsFeatures`);新导出
  isAntibotContent/classifyFetchResult/extractSsrEmbeddedJson/probeChromiumVersion
- 端到端验证:知乎文章页抓取成功(标题/日期/赞评/完整 Markdown),信誉自动恢复
  (fetchScore 0.5→0.837,有效分 0.857 → ✓[rep:0.86]);163 全过
