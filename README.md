# WebSearch Skill

面向 Agent 的网络搜索与正文提取工具。它聚合 14 个搜索源，对结果做广告过滤、URL 去重、
主题聚类和相关性排序，并在直连失败时按预算降级到备用引擎、存档或 Chromium。

默认搜索目标上限固定为 **99**。这是聚合上限，不保证实际一定返回 99 条；最终数量取决于
各引擎的单页限制、网络可用性、语言过滤和 URL 去重。

## 能力

- 多引擎并行搜索，单个引擎失败不会拖垮整次查询
- 中文、英文查询自动选择适用搜索源
- 广告硬过滤，低质量结果软降权，URL 不因标题相同而丢失
- 短语聚类零依赖可用，语义嵌入不可用时自动回退
- 网页正文转 Markdown，支持文章页、频道页、SPA 和部分 SSR 数据
- 直连、TLS 指纹、网页存档、Chromium 多层降级
- 搜索结果时效过滤、事件时间线、平台热榜和 GitHub Trending
- 路径级站点信誉与在线学习；外部 LLM 判断默认关闭
- 用户配置严格校验，密钥与普通配置分离

## 环境要求

- Node.js 22.15 或更高版本(依赖 `module.registerHooks`、`Headers.getSetCookie`、`import.meta.resolve` 等较新 API)
- npm
- Chromium 可选；只在浏览器渲染和强反爬兜底时需要

```bash
git clone https://github.com/cmddirexit/websearch-skill.git
cd websearch-skill
npm ci
node scripts/websearch.mjs help
```

`playwright` 和 `puppeteer-core` 是可选浏览器依赖。没有 Chromium 时，普通搜索和直连正文
提取仍可工作，浏览器兜底会给出明确诊断。

## 快速使用

### 搜索

```bash
# 默认多引擎聚合，目标上限 99，按主题聚类输出
node scripts/websearch.mjs search "Node.js 22 release notes"

# 指定引擎或更小的临时上限
node scripts/websearch.mjs search "北京今日新闻" --engine chinaso --limit 20

# 平铺结果、强制语义模式或关闭语义模式
node scripts/websearch.mjs search "向量数据库" --flat
node scripts/websearch.mjs search "向量数据库" --semantic
node scripts/websearch.mjs search "向量数据库" --no-semantic

# 只保留给定时间窗口内有日期的结果；无日期结果会保守保留
node scripts/websearch.mjs search "人工智能政策" --since 1w
```

`--since` 支持 `24h`、`1w`、`1m`、`1y`。默认无需传 `--limit 99`；只有确实需要减少
结果时才使用 `--limit N`。

### 正文提取

```bash
node scripts/websearch.mjs fetch "https://example.com/article" --max 5000
```

输出为 Markdown，尽量保留标题、列表、链接、表格、代码块和发布时间。正文不足时会识别
频道/滚动列表；SPA 空壳会尝试浏览器渲染。用户传入的抓取 URL 只允许 HTTP/HTTPS，拒绝
内嵌凭据、localhost 和显式的非公网 IP 地址。

### 时间线与榜单

```bash
# 聚合多篇报道，提取时间与要点后排序
node scripts/websearch.mjs timeline "地区冲突进展" --limit 8

# 展开上次搜索折叠的低相关结果
node scripts/websearch.mjs reveal

# 平台热榜
node scripts/websearch.mjs hotlist weibo --limit 20
node scripts/websearch.mjs hotlist baidu --limit 20

# GitHub Trending
node scripts/websearch.mjs trending weekly --limit 15
```

### 浏览器检查

```bash
node scripts/inspect.mjs "https://example.com" --select "main"
node scripts/inspect.mjs "https://example.com" --js "document.title" --network --console
node scripts/inspect.mjs "https://example.com" --screenshot page.png
```

检查模式提供常用 DevTools 能力：执行页面 JavaScript、查询 DOM、查看网络请求和 console、
读取页面可见存储以及截图。它复用搜索模块的 Chromium 路径、UA 版本匹配和 stealth 设置。

## 搜索引擎

| Key | 用途 | 语言 |
|---|---|---|
| `bing` | 默认通用搜索 | 中/英 |
| `baidu` | 百度网页搜索 | 中文 |
| `sogou` | 搜狗网页搜索 | 中文 |
| `sogou-wechat` | 微信公众号文章 | 中文 |
| `so360` | 360 搜索 | 中文 |
| `sm` | 神马搜索 | 中文 |
| `toutiao` | 头条搜索 | 中文 |
| `chinaso` | 中国搜索新闻 API | 中文 |
| `cnnews` | 官方新闻源列表 | 中文为主 |
| `marginalia` | 独立非商业网页索引 | 英文 |
| `hn` | Hacker News 技术讨论 | 英文 |
| `github` | GitHub 仓库 | 中/英 |
| `wikipedia` | 英文 Wikipedia | 英文 |
| `searx` | 公共 SearXNG 实例 | 中/英 |

默认引擎及聚合伙伴由内部的 `scripts/lib/engines.conf.json` 定义。中文查询会跳过仅英文引擎，
英文查询会跳过仅中文引擎。`cnnews`、`chinaso` 和 `searx` 属于专用源，不参加通用的
`all` 聚合，但可以用 `--engine` 显式调用。

## 配置

复制模板后按需修改：

```bash
cp websearch.config.example.json websearch.config.json
```

默认读取仓库根目录的 `websearch.config.json`。该文件已被 `.gitignore` 忽略，也可以选择
其他路径：

```bash
WEBSEARCH_CONFIG=/absolute/path/websearch.config.json \
  node scripts/websearch.mjs search "查询词"
```

配置优先级为：

```text
命令行参数 > 环境变量 > websearch.config.json > 内置默认值
```

显式指定的配置文件不存在、JSON 无法解析、含未知字段或值越界时，程序会在启动阶段报错。
配置不会静默接受拼错的字段。

### 配置分区

| 分区 | 字段 | 说明 |
|---|---|---|
| `engines` | `default`, `disabled`, `order` | 默认引擎、禁用项和聚合顺序 |
| `network` | `httpTimeoutMs`, `fetchTimeoutMs`, `totalBudgetMs`, `perEngineTimeoutMs` | 网络与调度预算 |
| `cache` | `directory`, `pageTtlMs` | 缓存根目录和页面 TTL |
| `browser` | `path`, `navigationTimeoutMs` | Chromium 路径和导航超时 |
| `semantic` | `backend`, `localModel`, `apiBase`, `apiModel`, `apiDimensions`, `relevanceMode` | 语义嵌入与展示模式 |
| `reputation` | `strength` | 信誉分对排序的影响强度 |
| `llm` | `enabled`, `provider`, `baseUrl`, `model` | 可选内容可信度判断，不含密钥 |

完整结构和合法示例见 [`websearch.config.example.json`](websearch.config.example.json)。

默认结果上限 **99 不可写入配置文件**。临时减少结果使用 `--limit N`，避免不同运行环境在
无感知的情况下改变 Agent 的默认召回范围。

### 密钥

密钥不得写入 `websearch.config.json`。语义嵌入密钥使用环境变量：

```bash
export SILICONFLOW_API_KEY="..."
```

语义嵌入也兼容仓库根目录的 `.env.json`：

```json
{
  "SILICONFLOW_API_KEY": "..."
}
```

`.env.json` 已被 Git 忽略。建议把文件权限设为 `0600`。

> **隐私提示**:配置 `SILICONFLOW_API_KEY` 后,默认 `semantic.backend=auto` 会把**每次搜索的
> 查询词与结果标题/摘要发送到嵌入 API**(默认硅基流动)做向量化;此外 `fetch` 正文提取的
> 学习链路还会把**网页正文前 600 字**发送给嵌入 API 做标题-正文一致性判断。若不想把搜索
> 或正文内容外传,将 `semantic.backend` 设为 `local`/`wasm`(本地模型)或 `off`(短语聚类,零外部依赖)。

外部 LLM 判断默认关闭。启用时必须明确 provider，并通过对应环境变量提供密钥：

| Provider | 密钥环境变量 |
|---|---|
| `deepseek` | `DEEPSEEK_API_KEY` |
| `siliconflow` | `SILICONFLOW_API_KEY` 或 `SILICONFLOW_KEY` |
| `openai` | `OPENAI_API_KEY` |
| `custom` | `WEBSEARCH_LLM_KEY` |

已知 provider 不会借用其他 provider 的密钥。`custom` 还需要 `baseUrl` 和 `model`，可放在
配置文件中，也可用 `WEBSEARCH_LLM_BASE_URL`、`WEBSEARCH_LLM_MODEL` 覆盖。

### 常用环境变量

| 环境变量 | 默认值 | 作用 |
|---|---:|---|
| `WEBSEARCH_CONFIG` | `./websearch.config.json` | 用户配置文件路径 |
| `WEBSEARCH_HTTP_TIMEOUT_MS` | `10000` | 搜索页请求超时 |
| `WEBSEARCH_FETCH_TIMEOUT_MS` | `20000` | 正文请求超时 |
| `WEBSEARCH_TOTAL_BUDGET_MS` | `40000` | 一次搜索的总预算 |
| `WEBSEARCH_PER_ENGINE_TIMEOUT_MS` | `12000` | 聚合时单引擎上限 |
| `WEBSEARCH_CACHE_DIR` | `~/.cache` | 缓存根目录 |
| `WEBSEARCH_PAGE_CACHE_TTL_MS` | `21600000` | 页面缓存 TTL |
| `WEBSEARCH_BROWSER_PATH` | 自动探测 | Chromium 可执行文件 |
| `WEBSEARCH_NAV_TIMEOUT_MS` | `20000` | 浏览器导航超时 |
| `WEBSEARCH_EMBED_BACKEND` | `auto` | `api`, `local`, `wasm`, `off` |
| `WEBSEARCH_EMBED_MODEL` | `Xenova/bge-small-zh-v1.5` | 本地模型 |
| `SILICONFLOW_API_BASE` | `https://api.siliconflow.cn/v1` | 嵌入 API 地址 |
| `SILICONFLOW_EMBED_MODEL` | `Qwen/Qwen3-Embedding-8B` | 嵌入 API 模型 |
| `EMBED_API_DIMENSIONS` | `1024` | API 输出维度，`0` 表示不压缩 |
| `WEBSEARCH_REL_MODE` | `balanced` | `balanced`, `aggressive`, `conservative` |
| `WEBSEARCH_REP_STRENGTH` | `1.6` | 信誉分影响强度 |
| `WEBSEARCH_LLM_ENABLED` | `0` | 设为 `1` 才允许调用外部 LLM |
| `WEBSEARCH_LLM_OFF` | `0` | 设为 `1` 强制关闭外部 LLM |
| `WEBSEARCH_DEBUG` | `0` | 输出抓取与降级决策日志 |
| `WEBSEARCH_TLS_FALLBACK` | `1` | 启用 TLS 指纹兜底 |
| `SEARX_INSTANCE` | 公共实例 | 自定义 SearXNG 地址 |
| `GITHUB_TOKEN` | 无 | GitHub 引擎认证 token(`GH_TOKEN` 亦可),把匿名 10 次/分钟提到 30 次/分钟 |

更多算法阈值属于维护者参数，集中在 `scripts/lib/config.mjs`，不进入用户配置文件。

## 结果处理

处理顺序如下：

```text
多引擎并行抓取
  -> 规范化 URL 去重
  -> 广告过滤与质量评分
  -> 短语或语义聚类
  -> 查询相关性与站点信誉重排
  -> 低相关折叠（URL 保留，可 reveal）
```

URL 是聚合去重的身份键。标题相同但 URL 不同的结果会全部保留，近似转载只在聚类展示层
折叠，并保留 `duplicateItems` 和代表 URL，避免丢失不同版本或来源。

### 聚类

短语模式从标题提取中文 n-gram 和英文词，以共享短语形成主题簇，不依赖外部模型。语义模式
使用向量余弦、增量质心和近似转载证据，能处理近义表达和部分跨语言结果。API、本地模型或
WASM 不可用时会回退到短语模式，不影响搜索主流程。

`balanced`(默认)按三档分级:相关簇完整展示、边缘簇仅标题+URL(摘要易误导 LLM 引用,故省略)、
无关簇折叠;`aggressive` 把边缘+无关都折叠成一行;`conservative` 只排序、不折叠。折叠详情写入
缓存并可用 `reveal` 查看,搜索 URL 不会因低相关判断被删除。

### 信誉与在线学习

历史文档把这部分称为“元学习”，更准确的定义是：用于新域名冷启动的跨域在线先验，
不是 MAML 一类 learning-to-learn 算法。当前实现使用按标题/URL 通道归一化的
FTRL-Proximal 稀疏逻辑回归。

- 信誉同时维护注册域名和首个有效路径段，避免同站不同内容区互相污染
- 搜索结果中的启发式质量只更新当前站点，不训练跨域模式
- 抓取可用性与内容质量完全分离：404、空壳和抓取成功都不能直接证明内容好坏
- 模型主动选择 `fetch` 只更新独立的使用价值分：同一 URL 每日去重，至少三次独立选择后
  才开始微升排序，最大约 3%；它不代表内容可信，不训练跨域模型，未被选择也不是负反馈
- 不启用 LLM 时，正文重复、推广密度、标题正文一致性等高精度本地结构证据仍可训练；
  模棱两可的正文保持中性
- 跨域模型同时具备足够正负证据后才启用，避免单类样本投毒
- 新域名使用跨域先验；自身证据增加后平滑淡出，不会在首个样本后突然失效
- 训练事件按来源和内容去重，只保存 URL 哈希、特征、标签、置信度和时间，不保存正文；
  状态可回放重建并按 90 天半衰期降权
- 信誉只软影响排序而不删除结果
- 状态文件采用同目录临时文件加原子替换，减少中断或并发写造成的损坏

首次加载旧 v3 状态时，仅迁移未混入旧抓取反馈的域名搜索历史；旧跨域权重和无法拆分内容/
可用性语义的条目会被丢弃，并在下次保存时写成 v4。

启用 LLM 会把搜索标题、域名、摘要或正文片段发送给指定服务商，因此必须由使用者显式开启。
LLM 只是可选标签源，不是在线先验运行的必要条件。

真实回测使用持久化事件，而不是检查当前权重是否“看起来合理”：

```bash
node scripts/backtest-meta.mjs
```

脚本输出按域名隔离的 5-fold 验证和时间后 20% 留出验证，包括 Brier score、低质召回率和
正常内容误伤率。事件不足时会明确失败，不会用构造样例冒充效果验证。

### 内容质量证据链（零词表）

`fetch` 回写内容证据时按三级裁决，全部模棱两可则保持中性（不训练）：

```
结构负证据 → 语义反证 → 结构正证据 → 贝叶斯(历史标注自举)
```

高精度结构负证据立即生效；结构正证据必须先接受标题-正文语义反证，避免正文填充
标题关键词后绕过一致性检测。

**1. 结构证据**（`content-evidence.mjs`，纯规则、同步、零依赖）

- 重复行比例 ≥45% → 模板拼接(0.2)；营销短语 ≥3 且短文/重复 → 推广文(0.15)；
  标题覆盖 <8% → 文不对题(0.25)
- 实质长文（≥1200 字符且标题覆盖≥25%）→ 0.82；短对齐文 → 0.72（置信度更低）
- 句长均匀性两级触发：CV<0.1（机械等长句，只能模板/机器产生）→ 独立弱负(0.35)；
  CV<0.25 且叠加营销词或低标题覆盖 → 组合弱负(0.35)。经真实样本标定：
  人类条列式文章 CV≈0.21~0.32 不误伤，机械模板 CV≈0.02 命中

**2. 语义证据**（`semantic-evidence.mjs`，标题-正文嵌入余弦，零词表标题党检测）

- 严格服从 `semantic.backend` / `WEBSEARCH_EMBED_BACKEND` 的
  `off|api|local|wasm|auto` 配置；`off` 不读取密钥、不发送正文
- API 单次调用默认 2.5 秒硬超时且不重试；`auto` 下 API 不可用才回退本地模型
- 余弦 <0.4 → 标题党弱负证据(0.25)，置信度随错位加深；只产负证据，
  高相似度交给结构证据判断，不可用则返回 null

**3. 内容贝叶斯**（`content-bayes.mjs`，自举分类器，最终兜底）

- 特征 = 中文 bigram + 英文词（零人工词表）；推理取最偏离 0.5 的 K 个 token 合成
  （Paul Graham 风格），Laplace 平滑治长尾
- 训练只用独立证据源（结构/语义/LLM 标签）；贝叶斯自身预测（`bayes-v1`）不训练自己，
  防自反馈循环
- 成熟门槛：有效样本 ≥40 且正/负类各 ≥10，未成熟时静默降级（预测返回 null）
- 持久化 `~/.cache/websearch-content-bayes.json`（token 计数 + 去重 ID，损坏则冷启动）

内容贝叶斯 v2 修复了英文词界和中文正文截断。旧 v1 token 语义不可无损转换，首次加载时
会保守冷启动，不复用已污染计数。

调参（环境变量）：`WEBSEARCH_BAYES_MIN_SAMPLES`(40)、`WEBSEARCH_BAYES_MIN_CLASS_SAMPLES`(10)、
`WEBSEARCH_BAYES_TOP_K`(15)；语义阈值在 `semantic-evidence.mjs` 顶部常量。
语义证据 API 超时可用 `WEBSEARCH_SEMANTIC_EVIDENCE_TIMEOUT_MS` 调整。

证据链裁决抽离在 `evidence-chain.mjs`（`resolveContentEvidence` / `trainBayes`），
bayes 与嵌入函数可注入，便于单测与扩展新证据源。

## 可靠性与降级

搜索侧使用总预算和单引擎超时，并行收集可用结果。连续失败的引擎会进入冷却期，成功后自动
恢复；引擎注册、fallback 和聚合关系由 `engines.conf.json` 统一校验。

archive 冷却只统计网络、限流和服务端故障；某个 URL 没有快照或快照无正文不会让整个
archive 服务进入冷却。

正文抓取按场景使用以下路径：

```text
页面缓存
  -> HTTP 直连
  -> TLS 指纹兜底（适用时）
  -> Chromium 渲染（优先，能过 JS 渲染/验证页）
  -> 网页存档（浏览器失败后的最后手段，适用时）
  -> 返回可用的保底结果或明确错误
```

浏览器层按 `puppeteer-core -> playwright -> Chromium CLI` 探测可用实现，并记录详细失败原因。
完整的反爬架构与诊断方法见 [`docs/ANTIBOT.md`](docs/ANTIBOT.md)。

缓存默认位于 `~/.cache`，包括 Cookie、页面正文、引擎冷却、嵌入向量、折叠详情、日期模型和
信誉状态。Cookie 和状态写入使用限制权限；敏感文件不要提交到仓库。

## Chromium

Termux / Android：

```bash
pkg install x11-repo
pkg install chromium
```

桌面系统安装 Chrome 或 Chromium 后，如未被自动发现，可显式指定：

```bash
export WEBSEARCH_BROWSER_PATH=/path/to/chromium
```

也可以在 `websearch.config.json` 的 `browser.path` 中配置非敏感的本机路径。环境变量优先。

## 作为库使用

`package.json` 提供 ESM 入口：

```js
import {
  fetchPage,
  filterResults,
  clusterResults,
  loadEngines,
  validateFetchUrl,
} from "websearch-skill";

const engines = loadEngines();
const response = await engines.bing.search("Node.js streams", 10, {});
const { kept, removed } = filterResults(response.results);
const clusters = clusterResults(kept, "Node.js streams");
```

引擎统一返回：

```js
{
  engine: "bing",
  mode: "web",
  blocked: false,
  reason: "",
  results: [
    { title: "...", url: "https://...", desc: "..." }
  ]
}
```

公共导出集中在 `scripts/lib/index.mjs`。内容质量证据链也可作为库复用：

```js
import {
  assessContentEvidence,      // 结构证据(纯规则,同步)
  assessSemanticEvidence,     // 语义证据(标题-正文嵌入余弦,异步)
  createContentBayes,         // 内容贝叶斯实例(可注入 file 隔离持久化)
  resolveContentEvidence,     // 证据链裁决:结构→语义→贝叶斯
  trainBayes,                 // 贝叶斯训练编排(独立证据源,防自反馈)
} from "websearch-skill";
```

## 扩展引擎

1. 在 `scripts/lib/engines/` 新增搜索实现，并遵守统一返回契约。
2. 在 `scripts/lib/engines/registry.mjs` 的 `ENGINE_IMPLS` 和 `ENGINE_LABELS` 注册。
3. 在 `scripts/lib/engines.conf.json` 声明 `search`、`fallbacks`、`aggregateWith`、语言和分页信息。
4. 为解析器添加手写 HTML 单测；需要真实页面结构时再添加 gzip fixture。

`aggregateWith: ["all"]` 会展开为除自身和专用引擎外的所有已启用引擎。用户配置禁用的引擎
会同时从直接选择、聚合伙伴和 fallback 中移除。

站点改版时先跑单元测试定位解析器，再按需更新快照：

```bash
npm run fixtures
```

## 开发流程(分支策略)

仓库使用双分支 + PR 保护:

```
main ──────────────► 稳定版(受保护:禁止直接 push,必须 PR + 1 approve)
   \                ▲
    \  merge        │ PR
     └───► dev ─────┘ 开发/测试分支(新功能先落这里)
```

流程:

```bash
# 1. 在 dev 分支开发(默认工作分支)
git checkout dev && git pull
# ...开发 + 修改...
# 2. 本地测试通过(npm test 全绿)后推 dev
git add -A && git commit -m "..." && git push
# 3. 建 PR 合并到 main
gh pr create --base main --head dev --title "..." --body "..."
gh pr merge --merge   # 会要求 approve(自己 approve: gh pr review --approve)
# 4. 合并后打 tag
git checkout main && git pull && git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z
```

规则:
- **main 受保护**:直接 `git push origin main` 会被 GitHub 拒绝,必须走 PR
- 每次合并前必须 `npm test` 全绿(无 CI,靠提交者执行)
- 版本号语义化 + tag(见 CHANGELOG.md)
- 紧急修复可直接从 main 切 hotfix 分支,同样走 PR

## 测试

```bash
npm test                  # 262 个单元测试
npm run test:integration  # 网络、浏览器和 TLS 集成测试
npm run test:all          # 全部测试
npm ci --dry-run --ignore-scripts
```

集成测试会根据本机能力跳过需要 Chromium 的用例。真实网络和公共搜索实例具有波动性，失败时
先看 `[degrade]` 日志和 `~/.cache/websearch-browser-debug.log`，再判断是站点结构变化、反爬、
网络不可达还是本地浏览器缺失。

## 项目结构

```text
.
├── SKILL.md                         # Agent Skills 入口与日常速查
├── README.md                        # 本文档
├── websearch.config.example.json    # 用户配置模板
├── docs/ANTIBOT.md                  # 反爬与浏览器降级说明
├── scripts/websearch.mjs            # CLI 入口
├── scripts/inspect.mjs              # 浏览器检查工具
├── scripts/lib/config.mjs           # 内部默认值和算法参数
├── scripts/lib/user-config.mjs      # 用户配置加载与校验
├── scripts/lib/engines.conf.json    # 内部引擎拓扑
├── scripts/lib/engines/             # 搜索源与浏览器实现
└── scripts/lib/tests/               # 单元和集成测试
```

## License

MIT
