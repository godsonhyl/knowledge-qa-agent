# 企业知识问答 Agent（TS 重构版）· 完整需求文档

> 项目代号：**kqa-ts** ｜ 周期：2026-10-20 → 2026-10-27（v2.0.0 → v2.11，47 个提交）
> 交付形态：Docker Compose（app + qdrant），企业内网部署
> 本文档按项目全周期汇总需求演进：初始需求 → 迭代需求 → 产品决策 → 治理需求 → 当前形态。配套文档见 [CONTRACTS.md](./CONTRACTS.md)、[DESIGN.md](./DESIGN.md)、[README.md](./README.md)。

---

## 一、项目背景与初始需求（v2.0.0）

### 1.1 背景

企业内部沉淀了大量技术文档（交易系统部署手册、运维手册、Confluence wiki、PDF 规程），员工查找信息靠翻目录和问老员工。通用问答产品有两个致命问题：**幻觉**（编造不存在的 IP/端口/步骤）与**不可溯源**（答案无法回溯到是哪份文档哪一行）。

原始需求来自一个零依赖的 vanilla JS 原型（`/home/knowledge-qa-agent`）：浏览器 localStorage 存知识库、纯 BM25 检索、`[n]` 引用定位。原型验证了产品思路，但有硬伤：

| 原型硬伤 | 业务后果 |
|---|---|
| 知识库存浏览器 localStorage | 知识不共享，每人拷贝一份，容量上限 ~5MB |
| 单机浏览器架构 | 无法多人协作使用、无法统一管制 |
| 纯 BM25 词法检索 | 词面不一致时检索不到（语义召回为零） |
| 配置与密钥在浏览器 | 无法接入企业网关，密钥暴露 |
| 无鉴权、无审计 | 不能在企业内网合规上线 |

### 1.2 初始需求（PRD v1）

**产品定位**：企业内网、有据可循的知识问答 Agent。核心口号：**检索不到就不答，答案每条结论可定位到原文行**。

**功能需求**：

| 编号 | 需求 | 验收标准 |
|---|---|---|
| FR-1 | 服务端知识库 | 知识库集中存服务端 Qdrant；浏览器只存个人配置与对话 |
| FR-2 | 混合检索 | BM25 词法 + bge-m3 向量双通道，RRF 融合；词面/语义任一命中即可召回 |
| FR-3 | 证据门 | 检索强度不足时拒答，**LLM 不被调用**（防幻觉硬约束） |
| FR-4 | 引用溯源 | 每条结论标 `[n]`，点击定位原文具体行；越界引用不渲染角标 |
| FR-5 | 多格式导入 | 文本拖拽/粘贴、PDF 上传、Confluence 链接导入 |
| FR-6 | 知识蒸馏 | LLM 把 chunk 提炼为 2-4 句知识点，与原文一同进索引 |
| FR-7 | 同源部署 | Hono 静态托管前端，同源无 CORS，`docker compose up` 一键起 |

**非功能需求**：

| 编号 | 需求 |
|---|---|
| NFR-1 | 密钥只在服务端 env；浏览器零密钥 |
| NFR-2 | 引用定位以字符偏移为契约（chunk 边界内 startLine/endLine/startChar/endChar 精确） |
| NFR-3 | 原型的 selftest 阈值（证据门公式、切块常量）**逐位保留**——它们是防幻觉的回归底线 |
| NFR-4 | Node 22 + 零重型依赖（Qdrant REST 用 plain fetch，不引 SDK） |

### 1.3 技术选型决策

| 决策 | 备选 | 选择与理由 |
|---|---|---|
| 服务框架 | Express / Fastify / **Hono** | Hono 轻量、TS 优先、中间件模型适合 SSO/限流分层挂载 |
| 向量库 | pgvector / Milvus / **Qdrant** | Qdrant 有官方 docker 镜像、REST 简单、payload 过滤能力够用 |
| 检索模型 | 纯向量 / **BM25+向量混合** | 保留原型的 BM25 阈值契约，向量补语义召回；RRF 融合不需要训练 |
| 嵌入模型 | OpenAI / **bge-m3（自托管网关）** | 内网无外网，走企业 LLM 网关（OpenAI 兼容协议） |

---

## 二、能力增强期需求（v2.1 → v2.2，2026-10-21/22）

原型上线内测后，用户提出的第一批真实需求。

### 2.1 UI 专业化（v2.1）

**需求动因**：内测用户反馈 UI 不像一个正式产品，想要暗色模式、优雅排版。

- `tdesign-react` 全量翻新，浅/暗双主题 + 跟随系统三态切换
- 回答代码块语法高亮（11 种语言）+ 语言标签 + 复制按钮
- 全部 token 化，换主题不破布局

### 2.2 PDF 导入（v2.1）

**验收契约**（CONTRACTS §8）：仅 multipart `file` 字段；500MB 上限（Content-Length 预检 + 落盘二次校验超限 413）；busboy 流式落盘避免整载内存；扫描/图片型 PDF（无文字层）422 明确提示而不是静默失败；解析后复用既有 addDoc 链路，无新 schema。

### 2.3 回答规范升级（v2.1）

**需求动因**：内测发现 LLM 有"检索到什么就说什么"的倾向，回答堆砌无关细节。

SYSTEM_PROMPT 升级为《企业内部知识问答 Agent — 回答规范》：
- 意图优先 / 结论优先 / 最小充分 / 证据优先 / 信息去重合并 / 版本管理（以最新版为主，旧版冲突不裁决）
- IP/端口/配置项**优先表格化**
- 引用独立呈现：句末标注，不打断阅读（禁止"联通`1`"这类角标嵌在名词里）

### 2.4 拒答后联网搜索兜底

**需求动因**：知识库不覆盖的内容，要么拒答要么靠用户自己去浏览器查——既然内网有 SearXNG 自托管实例，拒答后给用户**主动**点联网搜索的选项。

**契约**（CONTRACTS §10）：与知识库链路**完全隔离**——联网结果不进 Qdrant、不进 BM25、不存 chunk；UI 三重标识（琥珀徽章 + 声明横幅 + 独立"联网来源"列表）；全程禁 `[n]`；不伪装有据。

### 2.5 对话历史持久化（v2.2）

**需求动因**：原型对话只在浏览器 localStorage，清缓存即丢。

- 新 Qdrant collection `kqa_conversations`，每条消息带 `hitRefs`（不存全量 hits 避免膨胀）
- localStorage 仍作当前会话快速恢复，**真相在服务端**

### 2.6 检索能力十项打包（v2.2）

**需求动因**：第一批用户反馈"有些问题明明该命中却拒答了"（召回不足），"有些回答的片段不是最准的那条"（排序不足）。

| 需求 | 动因 | 实现 |
|---|---|---|
| 查询改写多路检索 | 用户问法与文档措辞有差异 | LLM 生成 2-3 变体 + 同义词词典扩展，多路 BM25 融合 |
| Confluence 增量同步 | 全量重导太重 | 按 version 比对，只更新变更页 |
| Reranker 精排 | RRF 只看排名不看语义 | RRF 后 top-N 喂 `/v1/rerank`（cross-encoder）精排 |
| 父子块 small-to-big | 命中子块上下文太碎 | 命中子块前后各扩 1 块合并喂 LLM；引用仍用子块行号 |
| 事实直查 | 高置信命中时 LLM 是多余中间层 | `phraseHit≥1 && topScore≥18` + 断崖式领先 → 跳过 LLM 零幻觉 |
| 知识库分组 | 库大后需收窄范围 | docName 前缀 + source 过滤（Qdrant filter + BM25 后置裁剪） |
| 事实抽验 | 模型可能编造数字/IP | 答案中的硬事实必须在**被引用片段原文**中找到，否则 UI 警告 |
| 同义词词典 | 缩写↔全称等价 | 手维护领域词典（"TL"↔"交易主干"），只扩召回不改阈值 |
| 复杂问题多步检索 | 复合问题单路检索不到全 | LLM 拆 2-4 子问题各自 hybridSearch 合并去重 |
| 定时备份 | 误清不可逆 | 24h 自动 + 手动，快照保留 10 份，一次命令恢复 |

### 2.7 建立"测试即契约"制度

**需求动因**：检索调优容易越调越乱；阈值改动缺一个客观可回放的判定。

- `CONTRACTS.md` 集中记录**不可随意改动**的契约（防幻觉契约 / 检索阈值 / 引用规范 / 回答规范 / 不可改阈值速查）
- 任何检索层改动前先跑 `npm test`：**§4 应命中 8 条 / §5 应拒答 7 条字面不变**，全绿才允许合入

---

## 三、企业治理期需求（v2.3，2026-10-22）

原型要给真实业务部门用，出了"进门"的问题。

### 3.1 SSO/OIDC 单点登录

**需求动因**：参照 `http://hpc-test03:18080/login`（WeKnora）的登录，接入企业 Keycloak（realm `test`）。

| 需求 | 实现 |
|---|---|
| OIDC Authorization Code + PKCE | 纯 node:crypto 实现（RS256 JWT + JWKS 公钥缓存/轮换），零第三方依赖 |
| mandatory + optional 双开关 | `OIDC_REQUIRED=1` 强制；`=0` 可选登录（回归不退化） |
| Keycloak admin 角色免令牌 | `realm_access.roles` 含 admin 即可清空/批量蒸馏，不需要 ADMIN_TOKEN |
| 401 静默续期 | 先 refresh，失败才回登录页 |
| 对话历史隔离 | `OIDC_REQUIRED=1` 时对话带 `ownerSub`，校验所有者 |

### 3.2 本地账号双模式登录

**需求动因**：有些员工不在 Keycloak 里，需要本地注册；同时外网用户可仅用本地账号（WeKnora 模式）。

- scrypt 密码哈希 + HS256 JWT 签发（access 8h / refresh 30d）
- Qdrant `kqa_users` collection，OIDC 首登落库（source=oidc）
- 双模式登录页：SSO 按钮 + 本地表单 + 注册入口，按配置动态显示

### 3.3 用户配额限流 + 审计日志

**需求动因**：多人使用后需要成本与行为治理。

- `RATE_LIMIT_PER_HOUR`（每小时问答数）+ `RATE_LIMIT_BURST`（并发数），超限 429 + 重试秒数
- `AUDIT_LOG_ENABLED` 时记录用户操作到 Qdrant `kqa_audit`：提问 / 导入 / 删除 / 清空 / 登录 / 注册，含 IP 与用户身份

---

## 四、真实使用暴露的问题（关键转折期，2026-10-22 → 26）

### 4.1 联网兜底太弱

**用户反馈**：问"上周五A股大盘收盘行情"，得到长篇"为什么我不能给你数字"的回答。用户说：**"这种基础问题都不能正常回答吗"**。

**改造 A+B**：SearXNG 摘要 400→2000 字符、结果 6→10 条；配 `FIRECRAWL_URL` 后对 Top-3 抓 markdown 正文（≤6000 字）替换摘要，让 LLM 能看到页面表格与数值而不是只有摘要尾巴；JSON/API 端点用 `rawHtml` 抓（markdown 转换会毁掉 JSON）。

### 4.2 行情直查通道的建立与拆除（重要产品决策）

**第二次反馈**：改完后问"中证1000 现货与期货 实时基差"，只答了现货价。用户说：**"上面那个问题简直是答非所问"**。

**试探方案**：建 A（行情类问题跳过知识库直连东财 push2）+ B（期货基差直查，含 IF/IH/IC/IM 到 secid 的映射）。

**关键产品决策（用户主动调整方向）**：**「不要直查，都走知识库 → LLM → 联网兜底」**——直查通道跳过了"先访问知识库"的核心产品定位，会让用户误以为知识库里有答案。

**结果**：v2.8.1 把行情/基差直查通道从主链路移除（`revert` 提交 `6262c9e`），检索主链路统一为**知识库检索 → LLM →（拒答后用户手动）联网兜底**；`marketData.ts` 模块保留未删，需要时可重新挂回。

### 4.3 UX 痛点修复

| 用户反馈 | 根因 | 修复 |
|---|---|---|
| "前端输入 admin token 报错" | `api()` helper 用 `{...init, headers: {...authHeaders()}}` 把 `X-Admin-Token` 覆盖了 | headers 合并顺序调换，`authHeaders()` + `initial.headers` 合并 |
| "刷新后文档列表就没了" | `App.tsx` boot refresh 条件写反了 | 改为 `bootReady = !!config && (!ssoRequired \|\| isAuthed)` |
| "点提问后好久才有响应" | 检索要等 rewrite + BM25/向双路 + rerank 几秒才回包 | 同步插入"检索知识库…"占位气泡，检索返回后**原位替换**（同 msg id） |

---

## 五、头脑风暴驱动的十批优化（2026-10-26）

### 5.1 检索与回答质量

| 批 | 需求 | 实现 | 验收 |
|---|---|---|---|
| 1 | 检索链路追踪 | `SearchResult.trace`（变体/各路命中/证据门/耗时/拒答原因）+ 前端 🔧 面板 | 答错能定位是改写/证据门/LLM 哪一环节 |
| 1 | 兜底可信度排序 | 域名白名单 +100 / 黑名单 −50 / 引擎共识 +10×N；排序在抓取前 | Top-3 正文抓取落在最可信来源 |
| 2 | 多格式文档 | `.docx`(mammoth)/`.xlsx`(sheetjs→markdown 表格保形)/`.pptx`(jszip) | 上传按扩展名分发，NoTextError 422 |
| 2 | 表格保形蒸馏 | `isTableChunk` 检测 GFM 表/`<table>` → 保形 prompt | 表格不被压扁成散文 |
| 2 | 多轮指代解析 | 前端带 `history`，queryRewrite 用 LLM 解析"它/这个"指代 | "那它的基差呢"能命中"螺纹钢主力合约的基差" |
| 4 | 追踪面板 chunk 明细 | fused/rel/lex.matchedTerms/sim 逐块展示 | 检索调优可视化 |
| 5 | 引用密度校验 | `splitSentences` + `citationGap`；<60% 句带引用挂软警告 | 抓"整段散文没标 [n]"的幻觉 |
| 5 | HyDE（可选） | `HYDE_ENABLED=1` 时 LLM 生成 2-4 句假设答案用于向量嵌入 | 词面差异大但语义近的 chunk 也能召回 |
| 8 | 流式引用 | RichText 流式 120ms debounce 重渲染，`[n]` 边流边可点 | 长答案不必等十几秒才能点角标 |

### 5.2 用户体验

| 批 | 需求 | 实现 |
|---|---|---|
| 3 | 配额 429 UX | search 429 派发事件，`RateLimitNotice` 倒计时"约 X 秒后恢复" |
| 5 | 跟进问题建议 | LLM 生成 3 个"你可能还想问"，chip 点即提问，仍走正常检索流程 |
| 5 | 追踪前置 | 🔧 挪到 `bubble-head`，检索返回即可点，不等 LLM 流完 |
| 6 | 重新生成原地替换 | `ask(q, {replaceMsgId})` 原位替换，旧答案归档 `prevTexts`；"上一版"切回 |
| 8 | 对话导出 | Markdown 可读 / JSON 结构化备份，纯前端 Blob |
| 9 | 答案置信度 | rerank rel + 命中数判定高/中/低 Tag；低可信挂 notice 提示核对 |
| 9 | 提问历史 | localStorage 去重 100 条，聚焦下拉显示，按输入过滤 |
| 10补 | 文档内搜索 | ViewerSearch 高亮所有匹配行 + 计数 + ↑/↓ 跳转 |

### 5.3 性能与成本

| 批 | 需求 | 实现 | 收益 |
|---|---|---|---|
| 6 | rerank 缓存 | `(query, chunkIds, topK)` 缓存排序顺序，5min TTL；distill/导入/删除时 invalidate | 重新生成同问题 ~3s → <10ms |
| 7 | 嵌入向量缓存 | sha256(model+text) 缓存到 `kqa_embed_cache`，换模型自动失效 | distill/备份恢复不重复调嵌入网关 |

### 5.4 知识库治理

| 批 | 需求 | 实现 |
|---|---|---|
| 8 | Confluence 远端失效同步（#22） | sync 探 404 标记 `confluenceStale`（不直接删），DocList "⚠ 失效"徽章 + refresh-stale 端点 |
| 10 | 孤儿 chunk 检测 | `recordSearch` 累计每块命中次数，metrics `chunkCoverage` 看 0 命中 |
| 10 | 重复内容检测 | 全文 sha256 → `duplicateOf` 派生 → DocList "⧉ 重复"徽章 |
| 7 | 文档内容更新保留 docId | `PUT /docs/:id` 复用 `updateDocContent`，chunk id 派生幂等，对话历史 ref 不失效 |

### 5.5 运维可观测

| 批 | 需求 | 实现 |
|---|---|---|
| 5 | 依赖健康探针 | `GET /api/health` 分探 Qdrant/LLM/嵌入/SearXNG/Firecrawl（带 ms）；整体 ok 由 Qdrant 决定；公开免鉴权 |
| 8 | P95 慢查询 | `recordSearch` 带问题样本，metrics `searchMsP95` + `slowQueries`（>3s 最近 20 条） |
| 9 | 告警 webhook | `/api/health` 不健康时 POST（`ALERT_WEBHOOK_URL`）；指纹防抖（`ALERT_DEBOUNCE_SEC`） |
| 6 | distill 进度自接 | App 启动探一次 `/distill-status`，正跑则自动接轮询（重启不丢进度条） |
| 9 | 反馈闭环诊断 | `GET /feedback/analysis` 按 mode 分组（拒答误判/排序差/兜底失败）+ top 问题，"重跑"看新 trace |

---

## 六、非功能需求汇总（全周期）

### 6.1 防幻觉硬约束（从未妥协）

| 契约 | 实现位置 |
|---|---|
| **无据不调用 LLM** | `chat.ts ask()`：`hasEvidence=false` 直接 return，不打 `/api/chat` |
| **引用必须有效** | `validateCitations`：`[n]` ∈ 1..hitCount 才渲染角标 |
| **无引用即警告** | 有 text 但 `used.size===0` 挂显式警告横幅 |
| **原文级定位** | chunk 带四向偏移，点击角标 → 证据卡 → 原文行高亮 |
| **无据拒答不泄露** | 拒答时低分片段不进 prompt（只 UI 展示） |
| **矛盾不裁决** | prompt 要求指出矛盾并标来源，模型不选边 |
| **兜底不伪装** | FALLBACK_PROMPT/WEB_SEARCH_PROMPT 强制声明 + 禁 `[n]` |
| **事实抽验** | 数字/IP/版本在被引用原文里找不到 → 挂警告 |
| **引用密度校验** | <60% 句带引用 → 软警告"部分结论未标注" |

### 6.2 安全契约

| 契约 | 说明 |
|---|---|
| 密钥只在服务端 env | `/api/config` 只下发 ready/model/host，绝不下发 key |
| 管理令牌 SHA-256 + timingSafeEqual | 防时序侧信道 |
| distill 不信任客户端 text | 服务端从 Qdrant 取块文，不接客户端传参 |
| 路径穿越校验 | backup.ts 读快照时校验解析后路径仍在 `backups/` 内 |
| localStorage 边界 | 只存配置 + 对话；知识库永远在 Qdrant |
| 密码存储 | scrypt N=16384 + 16 字节 salt；明文绝不落日志 |
| PKCE state 一次性消费 | 5 分钟 TTL，防重放 |

### 6.3 阈值契约（不可改清单）

```
chunker:  CHUNK_TARGET=520 / MAX=760 / MIN=90 / OVERLAP=90
bm25:     k1=1.5 / b=0.72
retriever: needMatches=3−1.2s / needRarity=0.62−0.22s / needScore=8−4.5s
hybrid:   向量门 topSim ≥ 0.62−0.15s
hybrid:   RRF k=60
qdrant:   kqa_chunks 1024 维 Cosine
ids:      UUIDv5 namespace "kqa:v1"，chunk id = UUIDv5(`${docId}:${index}`)
chat:     SSE 透传零重编码
```

### 6.4 回归测试（98 用例全绿为合入门槛）

- `chunker.test.ts`：切块行号 + 字符偏移精度（引用定位契约的回归）
- `evidence.test.ts`：§4 应命中 8 条 / §5 应拒答 7 条（**字面不变**）
- `factCheck.test.ts`：抽验豁免规则（版本号主段/小数字归纳）
- `oidc.test.ts`：PKCE/state 一次性/RS256 篡改/scrypt 往返/HS256 过期
- `embedCache/rerankCache/docUpdate/citationDensity/health/rateLimit` 等：各批次配套

---

## 七、当前形态（v2.11 全景）

### 7.1 检索主链路（唯一路径）

```
用户提问
  ├─ 同步插入"检索知识库…"占位气泡（立即可见反馈）
  ├─ 服务端 /api/kb/search
  │    ├─ queryRewrite（LLM 变体 + 同义词扩展 + 多轮指代解析）
  │    ├─ classifyQuestion（复杂问题拆子问题）【并行 HyDE（可选）】
  │    ├─ BM25 词法通道（多变体） OR bge-m3 向量通道（HyDE 假设文档嵌入 / 原问题）
  │    ├─ 证据门（词法门 OR 向量门；阈值固定不动）
  │    │    └─ 未通过 → hasEvidence=false 直接返回（LLM 不被调用）
  │    ├─ RRF(k=60) 融合排序
  │    └─ rerank（cross-encoder 精排；5min 缓存）
  ├─ 无据拒答页（reason 可解释；低分片段"仅供参考"不进 prompt）
  │    └─ 用户主动点：模型补充说明 / 联网搜索（三重标识非知识库依据）
  ├─ 高置信事实直查（跳过 LLM 零幻觉）
  └─ SSE 流式回答（流式 [n] 角标边出边可点）
       ├─ 事实抽验 + 引用密度校验 + 置信度标签
       └─ 跟进问题建议（可选）
```

### 7.2 系统架构

```
docker compose
├── app（Hono，Node 22）          
│     · /api/config /api/health   就绪与健康探针（免鉴权）
│     · /api/auth/*                OIDC SSO + 本地账号双模式登录
│     · /api/chat                  SSE 原样透传到 OpenAI 兼容网关
│     · /api/kb/*                  知识库 CRUD · 搜索 · 蒸馏 · 更新 · 失效标记
│     · /api/kb/search             检索主链路（trace 可观测）
│     · /api/web-search            SearXNG + Firecrawl 二次抓取 + 可信度排序
│     · /api/confluence-page       Confluence 单页/子树抓取 / 增量同步
│     · /api/feedback              👍/👎 采集 + 诊断分析
│     · /api/metrics               检索指标/P95/慢查询/chunk 覆盖率
│     · 内存 BM25 索引（boot 全量重建 + 增量维护）
│     · rerank 缓存（5min） · 嵌入缓存（Qdrant kqa_embed_cache）
└── qdrant
      · kqa_chunks     1024 维 Cosine，chunk 全 payload
      · kqa_docs       文档全文 + contentHash + confluence 同步元数据
      · kqa_conversations  对话历史（ownerSub 隔离）
      · kqa_users      本地账号 + OIDC 首登
      · kqa_feedback   问答反馈
      · kqa_audit      操作审计（可选）
      · kqa_embed_cache  嵌入向量缓存
```

### 7.3 产品能力一句话

> **企业内网知识问答：能答的每条结论都有据可查，查不到的诚实说"不知道"，多轮对话、多格式文档、多人治理、全程留痕。**

---

## 八、需求演进的三条主线

复盘全周期，需求演进沿三条正交主线推进：

| 主线 | 起点 | 终点 |
|---|---|---|
| **可信度** | 无据拒答 + `[n]` 引用（原型） | 事实抽验 + 引用密度 + 置信度标签 + 反馈闭环诊断 + 健康探针 + 告警（五层防线） |
| **检索能力** | 纯 BM25（原型） | 查询改写 + 同义词 + 多步 + HyDE + rerank + 缓存 + 蒸馏 + 多轮指代（八层增强） |
| **多人化** | 浏览器单机（原型） | 服务端 Qdrant + OIDC SSO + 本地账号 + 限流 + 审计 + 健康探针 + 告警（企业可上线） |

**最关键的三次产品决策**：
1. **知识库服务端化（Qdrant）**：打下了多人使用与治理的基础。
2. **双通道混合检索**：确定了检索能力上限——词面与语义互补。
3. **「不要直查，统一走知识库」**：守住了「有据可循」的产品灵魂——直查再快，也是没有灵魂的捷径。用户能分辨"快"和"对"的区别，评论如"答非所问"背后是产品灵魂不可让步。

---

## 九、约束与变更控制

### 9.1 变更流程
任何检索层改动前：先跑 `npm test`（98 全绿）→ typecheck → build 部署 → `curl /api/health` 验证 → 更新 `CONTRACTS.md` 与 `README.md` changelog 同步。

### 9.2 明确不做（本轮头脑风暴判定）

| 项 | 判定理由 |
|---|---|
| 同义词词典自动学习 | 需要人工复核，性价比低 |
| 命令面板 Cmd+K | 工作量大，内网单人场景需求弱 |
| 答案分享链接 | 需新路由 + 只读视图 + 鉴权调整 |
| 移动端适配 | 内网以桌面为主 |
| 成本追踪（tokens 记账） | SSE 透传改动风险大于收益 |
| Prometheus 格式 | JSON 观察 + 告警 webhook 已覆盖需求 |

### 9.3 延期候选（有真实需求再做）

- 文档版本对比（快照 diff 视图）
- Prometheus scrape 端点
- 反馈数据自动阈值调优建议（需更多负样本聚集后再做）

---

## 附录 A：版本-需求映射速查

| 版本 | 日期 | 需求内容 |
|---|---|---|
| v2.0.0 | 10-20 | TS 重构：Hono + React + Qdrant + 混合检索（FR-1~7） |
| v2.1 | 10-21 | TDesign UI 翻新 + PDF 导入 + 回答规范升级 |
| v2.2 | 10-22 | 检索增强十项 + 联网兜底 + 对话持久化 + 备份 |
| v2.3 | 10-22 | OIDC SSO + 本地账号双模式 + admin 角色 |
| v2.4 | 10-22 | 联网兜底 A+B 增强（摘要→正文 + Firecrawl） |
| v2.5 | 10-26 | 检索追踪 + 行情直查（后拆） + 可信度排序 |
| v2.6 | 10-26 | 多格式文档 + 表格保形 + 多轮上下文 |
| v2.7 | 10-26 | 限流 + 审计日志 |
| v2.8/8.1 | 10-26 | 行情直查建与拆（统一走知识库） |
| v2.9 | 10-26 | 第五六批：引用密度/健康探针/跟进建议/rerank 缓存/429 UX |
| v2.10 | 10-26 | 第七批：嵌入缓存 + 文档内容更新 |
| v2.10.1 | 10-26 | 第八九十批：流式引用/导出/P95/失效标记/置信度/HyDE/孤儿检测/全文搜索 |

## 附录 B：需求来源分类

| 来源 | 占比 | 举例 |
|---|---|---|
| 内测真实使用反馈 | ~40% | "答非所问""好久才有响应""刷新文档没了" |
| 主动头脑风暴（按价值排序执行） | ~35% | 十批优化中的绝大多数 |
| 企业化治理要求 | ~15% | SSO/限流/审计/备份 |
| 原型遗留需求保留 | ~10% | 防幻觉契约、阈值回归、引用定位 |

## 附录 C：当前规模

- 服务端 TypeScript ~6,300 行（27 个模块 + 12 个路由）
- 98 个 vitest 回归测试，`typecheck` 双 tsconfig 通过
- 47 个提交，8 天全周期（包含 2 次完整 revert 决策）
- 47 张 Qdrant collection 协同（7 个业务 collection）
- 1 个 docker compose，一键起 app + qdrant 全栈
