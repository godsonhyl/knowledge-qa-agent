# 契约与规范

本文件集中记录**不可随意改动**的契约与**必须遵守**的规范。这些是产品正确性的硬约束：改阈值会破坏检索回归、改引用规则会破坏溯源联动、改回答规范会改变产品定位。

> 改动任何一条前，先跑 `npm test`（44 vitest）。`tests/evidence.test.ts` 的 §4/§5 是检索阈值的字面回归。

---

## 1. 防幻觉契约（产品灵魂）

知识问答 Agent 的核心定位是「有据可循」——绝不伪装成有据可循。五条硬约束：

| 契约 | 实现位置 | 说明 |
|---|---|---|
| **无据不调用 LLM** | `src/web/stores/chat.ts` ask() | `hasEvidence=false` 直接 return，不打 `/api/chat`；仅检索模式同理 |
| **兜底不伪装** | `FALLBACK_SYSTEM_PROMPT` + ChatView | 无据兜底是受控例外：开头强制声明句 + 全程禁用 `[n]` + UI 琥珀色「未检索到依据 · 模型兜底」徽章；关掉「无据兜底」开关则回到纯拒答 |
| **引用必须有效** | `src/web/citations.ts` validateCitations | `[n]` ∈ 1..hits 才渲染为可点击角标；越界保留字面文本（不当引用） |
| **无引用即警告** | ChatView Message | 有 `text` 但 `used.size===0` → 挂「这条回答没有标注任何引用编号」横幅 |
| **原文级定位** | chunker + Qdrant payload + ViewerModal | 每块带 `startLine/endLine/startChar/endChar`，点击角标→证据卡→原文行高亮 |

**不可改**：
- 无据拒答时**低分片段不进 prompt**（只在 UI「仅供参考」区展示，避免污染模型）。
- 矛盾不裁决：prompt 要求指出矛盾并分别标来源，模型不得自行选边。

---

## 2. 引用规范

`[n]` 引用是「可溯源」的核心交互，必须满足：

### 2.1 角标格式
- `[1]`、`[2][3]`（多源并列），编号对应「参考片段」序号（1-based）。
- 范围 `1..hitCount`；越界由 `validateCitations` 判定为无效，保留字面 `[n]` 文本不渲染为角标。

### 2.2 放置规则（v2.1 强化）
引用必须**独立呈现，不打断阅读**：

| 场景 | 规则 | 反例（禁止） |
|---|---|---|
| 文字 | `[n]` 放结论句**句末** | `联通1`、`出口5`（贴在名词/数字上） |
| 表格 | 用独立「来源」列放 `[n]` | 把 `[n]` 塞进 IP/主体/运营商值单元格 |
| 多源 | 句末 `[1][3]` 并列 | 分散到句中多处 |

### 2.3 来源清单
- **由 UI 自动展开**：前端「引用依据」区按命中顺序列出证据卡，每卡可点击定位原文。
- **不依赖 LLM 写文末「来源：」段**：避免模型漏写或乱写 `[n]` 破坏 `validateCitations`。

### 2.4 联动机制（不可破坏）
- 点击文中 `[n]` → `useCiteStore.focus(n)` → 对应证据卡滚动 + 高亮（`ev-card.focused`）。
- 悬停证据卡 → `useCiteStore.setHover(n)` → 文中所有同号 `[n]` 加 `cite.hl` 高亮。
- 实现：`src/web/stores/cite.ts` + `citations.ts` renderInlineCitations + `EvidenceCard.tsx`。

---

## 3. 检索阈值契约（回归底线）

`src/server/search/retriever.ts` 与 `bm25.ts` 的阈值是 selftest 契约的具体形式，**不得改动**：

```
needMatches = 3 − 1.2s        s = sensitivity/100 ∈ [0,1]
needRarity  = 0.62 − 0.22s
needScore   = 8 − 4.5s
向量门:  topSim ≥ 0.62 − 0.15s   (bge-m3 跨主题中文 cosine 校准值)
```

- 证据门 = 词法门 OR 向量门（双通道互补）。
- `EMBED_VECTOR_GATE=0` 可关向量门降级 BM25-only（校准不过时用）。
- `tests/evidence.test.ts`：
  - **§4 应命中 8 条**（术语命中、短语命中、高分命中）
  - **§5 应拒答 7 条**（无关主题、零星字词）
  - 这两组是任何检索层改动的合入门槛——检索相关 vitest 必须全绿。

### 证据门 5 级判定
```
matched          多词命中 + 分数达标
term-hit         单个拉丁术语 + 稀有度够
phrase-hit       命中 query 的连续词组（整词强证据）
high-score       高分 + 至少两词
distinctive-pair 两个高稀有度词
```

### 切块常量（不可改）
`src/server/chunker.ts`：`CHUNK_TARGET=520 / MAX=760 / MIN=90 / OVERLAP=90`。字符偏移是引用定位契约，`tests/chunker.test.ts` §7 是它的回归。

---

## 4. 回答规范

`src/web/qaPrompt.ts` 的 `SYSTEM_PROMPT` 实现本规范。这是《企业内部知识问答 Agent — 回答规范》的落地。

### 4.1 第一原则
**回答质量 ≠ 用了多少检索结果。** 质量取决于是否用最少的必要信息准确解决了问题。常见错误：把"尽可能完整回答"理解成"尽可能多用检索片段"，导致堆砌无关细节、新旧交替、淹没有用信息。

### 4.2 回答前内部检查（按顺序）
1. 意图识别：用户到底想知道什么？（只想要 IP，就别提主备切换）
2. 优先级：哪些片段直接回答核心问题？哪些是相关但非必要的背景？哪些是旧版/历史？
3. 压缩：多个片段的同一事实合并为一个表述，不复述。
4. 版本：以最新有效版本为主；旧版差异作补充，标注"是否仍在用需确认"。
5. 能否更紧凑：能否用一句话或一个表格回答？

### 4.3 六条核心原则
1. **意图优先**：先判断核心问题，只回答直接相关。相关但非必要的背景默认不展开，除非用户追问。
2. **结论优先**：第一句直接回答，不写开场白，不介绍检索过程。
3. **最小充分**：只提供必需信息。宁可少不可多。
4. **证据优先**：所有事实有片段依据，不自行推测，不用自身记忆/常识补事实。
5. **信息去重与合并**：重复事实合并为一处；同一对象多条信息合并到一行/一格。
6. **版本管理**：新版为主；旧版与新版冲突时旧版作补充，标注"是否仍在使用需确认"，不自行裁决。

### 4.4 结构化展示
- IP、端口、服务器、账户、运营商、配置项等**优先表格**，每行一个主体，相关字段并列。
- 禁止用大段文字堆叠多个 IP/主体/运营商。
- 真正的步骤或条目可用列表，不要把陈述句硬拆成列表。

### 4.5 详略与篇幅
- 简单事实：默认简短（一两句）。
- 实体列表：优先表格。
- 不为显示检索能力而罗列所有相关资料——**检索到不代表要回答**。
- 未证实的历史记录不表述为当前状态。
- 仅当用户明确要求「详细」「完整」「分析原因」时才深入展开。

### 4.6 兜底模式（无据）
`FALLBACK_SYSTEM_PROMPT` 保持防伪装内核：
- 开头强制声明「知识库中没有找到相关内容，以下回答来自模型自身知识，未经知识库验证，请谨慎参考。」
- 全程禁 `[n]`（无片段，`[n]` 会误导）。
- 同样遵循意图优先/最小充分/结构化展示。
- 不编造具体数字、名称、版本号、日期。

---

## 5. SSE 透传契约

`src/server/routes/chat.ts`：
- **零重编码**：`new Response(upstream.body, ...)` + `X-Accel-Buffering: no`，原样透传上游 SSE。
- 客户端断开时 abort 上游（不浪费网关额度）。
- 校验 `messages[0]` 是 system 角色。
- 服务端持有 Key，浏览器只看 `/api/config` 的 ready 标志。

---

## 6. Qdrant 数据契约

### 6.1 双 collection
```
kqa_chunks：1024 维 Cosine；chunk id = UUIDv5("kqa:v1", `${docId}:${index}`) 幂等
payload: kind, docId, index, docName, section,
         startLine, endLine, startChar, endChar,  // ★ 引用定位
         text, summary, summaryAt, source, addedAt
keyword 索引: docId / docName / source

kqa_docs：伪向量 size 1，存全文（原文查看器用）
payload: kind:"doc", name, source, size, addedAt, text
```

### 6.2 不可破坏的坑
- **Qdrant 所有响应包在 `{result:...}` 里**：`scrollAll`/`searchPoints`/`countPoints` 必须 `body.result` 解构。
- **id 必须 UUID/uint**（UUIDv5 幂等，重导不留孤儿）。
- `ensureCollection` 带 30×2s 重试（容忍 Qdrant 启动慢）。

---

## 7. 密钥与安全契约

- **所有密钥只驻服务端 env**：`/api/config` 仅下发 `{ready, baseUrlHost, model, confluence, embed, clearEnabled}`，绝不下发 key。
- **危险操作鉴权**：清空 / 批量蒸馏 / 恢复 需 `X-Admin-Token`，服务端 SHA-256 + `timingSafeEqual` 定长比较（防时序侧信道）。
- **令牌存储**：前端令牌放 `sessionStorage`（会话级，关浏览器即清）。
- **清空防护**：UI 两段式红色确认 + 自动 JSON 快照（保留最近 10 份）+ 误清可一条命令恢复。
- **路径穿越**：`backup.ts` 读快照时校验解析后路径仍在 `backups/` 内。
- **distill 不信任客户端 text**：服务端从 Qdrant 取块文蒸馏，绝不信任客户端传入。
- **localStorage 边界**：只存配置 + 对话（`kqa.config.v2` / `kqa.chat.v2`），**知识库永远在 Qdrant**。

---

## 8. PDF 导入契约

`POST /api/kb/docs/upload`：
- **仅 multipart/form-data**，`file` 字段（二进制）+ 可选 `source`。
- **单篇上限 500MB**：`Content-Length` 预检 + busboy 落盘阶段边收边校验，超限 413。
- **流式落盘**：busboy 写 `os.tmpdir()`，避免整载内存；解析后立即删除。
- **仅 `.pdf`**：其他类型引导走 `/api/kb/docs`（JSON 文本入口）。
- **扫描/图片型 PDF**（无文字层）→ 422 `{error: "PDF 中未提取到文本..."}`。
- 文本提取后**复用既有 addDoc 链路**：切块 + 嵌入 + Qdrant 双 collection upsert + 重名 409。无新 collection、无新 payload 字段。

---

## 9. 主题契约

- `html[theme-mode='dark']` + `.dark` class 双写（兼容 tdesign 与自定义）。
- `stores/theme.ts`：persist `kqa.theme`，默认 `system`，三态 `light | dark | system`。
- tdesign dist css 自带 `:root[theme-mode='dark']` 双主题变量块；app 自定义令牌在 `html[theme-mode='dark']` 下做覆盖块。
- 首帧前落定主题（`main.tsx` 调 `useThemeStore.getState().init()`），避免暗色用户看到白闪。

---

## 10. 联网搜索兜底契约

拒答后的可选兜底（SearXNG 自托管实例），与知识库链路**完全隔离**：

| 契约 | 实现 | 说明 |
|---|---|---|
| **手动触发** | 拒答页「联网搜索」按钮 | 绝不自动联网；用户主动点击才调用。有据可循时此路径不存在 |
| **不伪装有据** | `WEB_SEARCH_SYSTEM_PROMPT` | 开头强制声明「基于联网搜索结果…未经知识库验证」；全程禁 `[n]`（联网结果不是知识库参考片段） |
| **UI 三重标识** | 琥珀色徽章「未检索到依据 · 联网搜索兜底」+ 声明横幅 + 独立「联网来源」列表（非证据卡） | 联网来源与知识库证据卡在视觉与结构上完全分开 |
| **服务端代理** | `POST /api/web-search` | 浏览器不直连 SearXNG；`SEARXNG_URL` 只在服务端 env；返回裁剪后 `{title,url,content,scraped}`（title≤200 / url≤500 / content≤2000 字符摘要） |
| **正文二次抓取**（v2.4） | `FIRECRAWL_URL` 配置后，对 Top-3 命中调 Firecrawl `/v2/scrape` 抓 markdown 正文（≤6000 字符，20s 超时）替换摘要 | 让 LLM 看到页面表格/数值而非只有搜索摘要；抓取失败/超时回退摘要，不阻塞；`scraped=true` 标记该条已抓正文 |
| **不污染知识库** | — | 联网结果不进 Qdrant、不进 BM25 索引、不存 chunk；仅存在于该条消息的 `webHits`（localStorage 对话记录） |
| **空结果诚实** | `empty=true` + `unresponsiveEngines` | 搜不到就明说「联网也没有找到」+ 限流引擎列表，不硬凑 |

**配置**：`SEARXNG_URL`（必需，env / docker-compose）；`FIRECRAWL_URL`（可选，正文抓取）。未设置 `SEARXNG_URL` → `/api/config` 返回 `webSearch:false`，拒答页不显示按钮，API 503。

**调用链**：拒答 → 用户点按钮 → `POST /api/web-search {q,limit≤10}` → SearXNG `format=json` → 摘要裁剪 ≤2000 → （若配 `FIRECRAWL_URL`）Top-3 调 `/v2/scrape` 抓正文替换摘要 → 前端拼 webCtx → `callModel(WEB_SEARCH_SYSTEM_PROMPT)`（先立口径/数据带时间戳/多期限用表格/标注局限/给查询路径）→ `validateCitations(ans, 0)`（任何 `[n]` 都判无效，不渲染角标）→ 展示 + 联网来源列表。

---

## 11. 事实抽验契约

回答生成后（仅正常问答，兜底/联网不适用），前端 `factCheck.ts` 依据 `verifyFacts`（`tests/factCheck.test.ts` §FC-1..4）做启发式核对：

- 抽取答案中的**硬事实**：IP、端口、版本号、≥3 位整数——剔除 `[n]` 引用标记自身。
- 只在被 `[n]` 引用的片段原文中查找；找不到 → `msg.factIssues` 挂 UI 警告「事实核对警告」。
- **豁免**（宽松匹配避免误报刷屏）：版本号主段匹配即算支持；<200 的 3-4 位数（常见归纳）豁免；数值去前导零匹配。
- 最多展示 5 个缺失值；这是提示核对，不自动拒答。

## 12. 检索增强契约（不破坏阈值）

各增强均**不改** retriever/bm25/chunker 阈值，只扩召回面或重排序：

| 增强 | 实现 | 失败退路 |
|---|---|---|
| 查询改写 | `queryRewrite.ts`：LLM 生成 2-3 变体 + 同义词词典扩展；多路词法融合后与向量做二轮 RRF | LLM 失败/超时 3.5s → `[原问题]+词典` |
| Reranker | `rerank.ts`：RRF 后取 top-N(`max(topK*3,20)`) → 网关 `/v1/rerank` → 截 topK | 失败/未配置 → 沿用 RRF 排序 |
| 同义词词典 | `synonyms.ts`：`expandQueryWithSynonyms` 命中 alias → canonical 补入变体；最多 2 组 | 无词典命中 → 无变体 |
| 父子块（small-to-big） | `BM25Index.parentText`：命中子块前后各扩 1 块合并 → `Hit.parentText` 喂 LLM；引用定位仍用子块行号 | 索引未初始化时跳过（等下次 rebuild） |
| 知识库分组 | `GET /api/kb/groups` 派生 + `/api/kb/search` 支持 `docNamePrefix`/`source`（Qdrant filter + BM25 后置裁剪） | 无分组参数 → 全库检索 |
| 事实直查 | `phraseHit≥1 && topScore≥18` + 断崖式领先 → `directAnswer=true`；前端跳过 LLM 直接展示 | 不满足条件 → 正常走 LLM |
| 复杂问题多步 | `multiStep.ts` `classifyQuestion`（2.5s 超时，max_tokens=2000 reasoning 兼容）拆 2-4 子问题，各自 `hybridSearch` → `mergeHits` 去重合并 | 失败/简单问题 → fast path 单路检索 |
| 多轮上下文（v2.6） | 前端 `chat.ts` 发 `history`（最近 3 轮 Q/A，A 截 500 字）→ `search.ts` 透传 → `queryRewrite` 用 LLM 解析指代（"它/这个/上面提到的"）后改写变体 | 无 history 或 LLM 失败 → 原问题单路检索 |
| 多格式文档（v2.6） | `docParse.ts`：DOCX(mammoth) / XLSX(sheetjs→markdown 表格保形) / PPTX(jszip 解 a:t 文本)；`/docs/upload` 按 .ext 分发；Dropzone 接受 .docx/.xlsx/.pptx | 解析为空抛 `NoTextError` → 422 |
| 表格保形蒸馏（v2.6） | `distill.ts` `isTableChunk` 检测 GFM `|` 表 / `<table>` → 用 `DISTILL_TABLE_SYSTEM_PROMPT` 要求保留 markdown 表格结构，提取关键字段 | 非表格 → 原 `DISTILL_SYSTEM_PROMPT` 概括 |
| 索引增量 | `BM25Index.addDocChunks`/`removeDocChunks` 增量维护 df/avgLen/byDocIndex；单篇导入/删除不整库 rebuild | 索引未初始化时跳过 |
| 检索链路追踪 | `SearchResult.trace`（变体/各路命中/证据门/耗时/拒答原因/通道）；前端 🔧 展开面板；`recordSearch` 聚合 `reasonCounts`/`channelCounts` 进 metrics | trace 未生成时面板不显示 |
| ~~行情数据直查~~（v2.8.1 已按产品决策移除） | 检索主链路统一为：**知识库 → LLM →（拒答后用户手动）联网兜底**，任何问题不再被外部数据源截胡；`marketData.ts` 模块保留未删（判定函数 + push2 取数能力），需要时可重新挂回 | — |
| 兜底来源可信度排序 | `webSearch.ts` `rankByCredibility`：域名白名单 +100（交易所/东财/官方）/黑名单 −50（UGC/内容农场）+ 引擎共识 +10×N；排序在抓取前（Top-N 抓最可信来源） | 排序失败退回 SearXNG 原序 |
| 运维指标 | `GET /api/metrics` + `search.recordSearch` 上报；进程内存级（重启归零） | Qdrant 不可用时 stats 置零 |
| 反馈数据 | `POST/GET /api/feedback`，Qdrant `kqa_feedback`，自动 prune 500 条 | — |

证据门以主变体判定为准（变体只扩召回，不放宽门）。

## 13. SSO/OIDC 鉴权契约

参照 WeKnora 的 OIDC 接入（Authorization Code + PKCE S256）+ 本地账号双模式，IdP 为 Keycloak（`http://sso.jinde.local/realms/test`）。

| 契约 | 实现 |
|---|---|
| **未配置即不启用** | 未配 `OIDC_*` 且未配 `OIDC_JWT_SECRET` → 中间件直接放行，所有 API 免鉴权（与历史行为一致，回归不退化）；登录页不出现 |
| **双模式开关** | `OIDC_*` 启用 SSO；`OIDC_JWT_SECRET` 启用本地账号（注册/密码登录）。两者独立，可单开、可并存（WeKnora 式登录页：SSO 按钮 + 本地表单 + 注册入口） |
| **密钥隔离** | `OIDC_CLIENT_SECRET`/`OIDC_JWT_SECRET` 只在服务端 env；`/api/config` 仅下发 `{enabled, required, providerName, loginUrl, localEnabled, registrationEnabled}` |
| **放行白名单** | `/api/config`（就绪探测）+ `/api/auth/*`（登录/注册流程本身）免鉴权；其余 `/api/*` 受保护 |
| **强制开关** | `OIDC_REQUIRED=0`（默认）：鉴权不强制；`=1`：无 token → API 401、HTML 导航 302 回首页由前端渲染登录页 |
| **token 双源** | OIDC 的 RS256 JWT（Keycloak 签，JWKS 验签）与本地 HS256 JWT（我们签，HMAC secret 验签）。middleware 按 header.alg 分流：HS256→本地，RS256→OIDC |
| **本地 JWT 契约** | iss=aud=`"kqa"`；access 8h / refresh 30d；claims 带 sub/email/name/username/roles/source；签名 HMAC-SHA256 + timingSafeEqual |
| **密码存储** | scrypt（node:crypto 内置，N=16384）+ 16 字节随机 salt；明文密码绝不落库/落日志 |
| **OIDC 首登落库** | OIDC 回调把用户写入 `kqa_users`（source=oidc，oidcSub=sub）；重复登录仅更新 lastLoginAt/roles |
| **对话历史隔离** | `OIDC_REQUIRED=1` 时对话带 `ownerSub`（sub），list/get/put/delete/pin/rename 校验所有者；`=0` 时无 owner（共享，历史行为） |
| **PKCE** | verifier 48 字节随机，`S256` challenge；state + verifier 存服务端内存 Map，**一次性消费**（防重放），5 分钟 TTL |
| **401 处理** | 前端先静默 `POST /api/auth/refresh`（HS256 重签 / RS256 转 Keycloak）续期一次；失败才清凭证回登录页 |
| **检索单测不受影响** | §4/§5 直接调 retriever，不经 HTTP 鉴权层；`tests/oidc.test.ts` 用本地生成 RSA 密钥 + 假 IdP 覆盖 PKCE/state/jwt 校验/防伪造/scrypt/HS256 |

**Keycloak 侧配置**：realm `test` 新建 confidential client（如 `kqa-test`），开启 Standard Flow，Valid Redirect URI 填 `http://<host>:3002/api/auth/oidc/callback`（HTTPS 部署用 `https://<host>:3443/...`）。

---

## 14. 测试即契约

| 测试 | 覆盖契约 |
|---|---|
| `tests/chunker.test.ts` | §2 分块、§7 行号+字符偏移精度、§10 长正文 overlap、边界输入 |
| `tests/evidence.test.ts` | **§4（应命中 8 条）§5（应拒答 7 条）字面不变**；§6 拒答不泄露片段；§11 phrase-hit；§12 蒸馏后语义近邻命中 |
| `tests/confluence.test.ts` | §11 Confluence URL 解析（4 种形式 + 拒绝）+ storage→纯文本 + 引用编号校验 |
| `tests/pdf.test.ts` | §PDF-1 可解析 PDF 提取原文；§PDF-2 无文字层抛 `PdfNoTextError` |
| `tests/factCheck.test.ts` | §FC-1 数字在原文无警告；§FC-2 IP 无依据挂警告；§FC-3 版本主段豁免；§FC-4 只看被引用片段 |
| `tests/oidc.test.ts` | §13 SSO/OIDC + 本地账号：PKCE challenge、state 一次性消费、RS256 jwt（iss/aud/exp）校验、签名篡改；scrypt 密码往返/salt 唯一、HS256 签发/校验/过期/篡改 |
| `scripts/e2e.mjs` | 对运行中的 stack：种子导入 + §4/§5 + 引用偏移往返 + chat SSE 透传 |

**合入门槛**：任何检索层改动前先跑 `npm test`（80 全绿）；UI 改动后跑 `npm run typecheck` + `build`。

---

## 附：不可改阈值速查

| 位置 | 常量 | 值 |
|---|---|---|
| `chunker.ts` | `CHUNK_TARGET / MAX / MIN / OVERLAP` | 520 / 760 / 90 / 90 |
| `bm25.ts` | `k1 / b` | 1.5 / 0.72 |
| `retriever.ts` | `needMatches / needRarity / needScore` | `3−1.2s / 0.62−0.22s / 8−4.5s` |
| `hybrid.ts` | 向量门 `topSim` | `0.62 − 0.15s` |
| `hybrid.ts` | RRF `k` | 60 |
| `qdrant.ts` | chunk 维度 | 1024 Cosine |
| `ids.ts` | UUIDv5 namespace | `"kqa:v1"` |
| `chat.ts` | SSE 透传 | 零重编码 |
