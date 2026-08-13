# Changelog

本技能按语义化版本记录演进历史(提交哈希见 git log,全部为 `main` 分支)。

## 1.4.1 — 证据链可靠性 + 安全修复

> commits `1f0cfe2` `564eb46` `263dd9e`

- 语义证据服从显式嵌入后端配置，`off` 不外发正文；API 使用短超时
- 结构正证据接受语义反证，修复标题关键词填充绕过
- 修复英文正文词界和中文正文 60 字符截断；v1 状态保守冷启动并持久化完整去重 ID
- archive 仅在所有镜像均为基础设施故障时累计全局冷却
- 尊重显式主引擎选择，加固 bing 英文回退，自动发现 Playwright Chromium
- **SSRF 重定向校验**:直连 fetch 拿到最终落地地址后二次校验,拦截公网 URL 302 到
  内网/本地/带凭据地址(盲 SSRF);公网→公网重定向不受影响
- **同域限速状态清理**:`pendingHosts` 链完成自动移除、`lastRequestAt` 超 2000 条
  清最旧,库模式长跑不再无限膨胀
- **content-bayes 账本上限**:事件去重 ID FIFO 裁剪(默认 10000)、token 字典淘汰
  最低频(默认 20000),与 domain-rep 的 META_MAX_EVENTS 哲学对齐
- **GitHub 引擎认证**:支持 `GITHUB_TOKEN`/`GH_TOKEN` 提升匿名 10 req/min 限额
- **异常路径释放浏览器**:CLI 入口 catch 分支同样 closeBrowser,防 chromium 残留
- **Node 版本声明修正**:`>=18` → `>=22.15`(实际依赖 module.registerHooks 等)
- **README 隐私提示**:补充 fetch 正文学习链路会把网页正文前 600 字发给嵌入 API

## 1.4.0 — fetch 兜底链提速

> commit `c358a30`

- **archive 失败冷却**:存档兜底连续失败 2 次 → 冷却 5 分钟(跨进程持久化,
  成功自动恢复);不可达网络下任何 403/5xx 站不再白等 ~20s 存档镜像
  (可调:`WEBSEARCH_ARCHIVE_COOLDOWN_MS` / `WEBSEARCH_ARCHIVE_FAIL_FILE`)
- **login-wall 直接浏览器**:知乎 40362 等登录/会话风控与 Cloudflare 同待遇,
  直连失败后跳过存档直接浏览器 CLI 真实等待轮
- 实测知乎类反爬站 fetch:**33s → 11s(-67%)**

## 1.3.0 — 零词表内容证据链

> commits `2726398` `1b294ce` `e318bd0` `c02b867`

在 LLM 关闭时,仅靠规则 + 语义 + 统计三层零词表信号判断正文质量:

- **句长均匀性**(`content-evidence.mjs`):句长变异系数 CV 两级触发
  (CV<0.1 机械等长独立弱负;CV<0.25 + 营销词/低覆盖组合弱负);
  经真实样本标定,人类条列式文章(CV≈0.21~0.32)不误伤
- **标题-正文语义一致性**(`semantic-evidence.mjs`):复用 embed.mjs API 嵌入,
  余弦 <0.4 → 标题党弱负证据;嵌入不可用静默降级,只产负证据
- **内容级朴素贝叶斯**(`content-bayes.mjs`):自举分类器,最终兜底;
  Paul Graham 风格取最极端 15 token 合成,Laplace 平滑治长尾;
  成熟门槛 40 有效样本(正负各 ≥10),训练只用独立证据源防自反馈;
  持久化 `~/.cache/websearch-content-bayes.json`
- **证据链抽离**(`evidence-chain.mjs`):三级裁决(结构→语义→贝叶斯)+
  训练编排,依赖注入(bayes/embedFn)可测可扩展;`learnFetchContent` 瘦身
- **库导出补齐**(`index.mjs`):`assessSemanticEvidence` / `createContentBayes` /
  `bodyTokens` / `resolveContentEvidence` / `trainBayes` 等
- **文档**:README/SKILL.md 新增「内容质量证据链」章节与调参表
- 新增句长、语义、贝叶斯、证据链和集成测试覆盖

## 1.2.0 — 信誉学习系统重构(v4)

> commit `6957d4f`

- 算法:感知机风格 → **FTRL-Proximal 在线逻辑回归**(每坐标自适应学习率,
  L1 稀疏化 + L2 正则)
- 特征:标题/URL 通道内 **L1 归一化**(长标题相关 bigram 不再当多份证据)
- **四类状态严格分离**:searchScore / contentScore / availabilityScore /
  utilityScore(404 不再污染内容分,可用性只温和影响排序)
- **事件账本**:训练事件全量存盘、加载回放重建(幂等可审计,schema 可迁移),
  时间衰减移到回放时按事件 age 算(90 天半衰期)
- **本地内容证据**(`content-evidence.mjs`):重复行比例 / 营销词密度 /
  标题覆盖度(不依赖 LLM)
- **用户配置**:`websearch.config.json`(引擎/超时/语义/信誉/LLM 可配)
- v3→v4 迁移:有 fetch 样本的旧域名丢弃(无法拆分语义),宁可冷启动
- 测试 270/270

## 1.1.0 — 搜索可靠性与配置硬化

> commits `6d2770b` `46717b8`

- 搜索可靠性加固:排序/过滤/降级链硬化
- 配置校验 + 状态文件原子写(减少中断/并发写损坏)

## 1.0.0 — 初始版本

> commit `99c0afc`

- 网络搜索 + 正文提取:13 引擎(中英聚合)、广告过滤、聚类去重、质量排序
- 反爬三层防线:直连 → 浏览器兜底 → 存档兜底(Chromium 兜底)
- 域名信誉系统(v3:双循环元学习雏形)+ 发布时间 ML 提取
- 浏览器兜底(Termux Chromium)、`timeline` 时间线聚合
