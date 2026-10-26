# 知识问答 Agent（TS 重构版）

一个**有据可循**的问答应用：只根据导入的知识库回答，每条结论都标注引用编号 `[n]`，点击即可定位到原文的具体行。检索不到依据时直接说「没查到」，不调用大模型。

TS 重构版：**Hono + React + Qdrant**，知识库存服务端 Qdrant（无 localStorage 容量限制），检索为 **BM25 词法 + bge-m3 向量** 双通道混合（RRF 融合），防幻觉契约与原 JS 版完全一致。

> v2.1（2026-10）：UI 按 TDesign 全量翻新（浅/暗双主题、代码块语法高亮）、新增 PDF 导入、回答规范升级为「企业内部知识问答 Agent 规范」（意图优先 / 最小充分 / 表格化 / 引用独立呈现）。详见 [CHANGELOG](#变更记录) 与 [CONTRACTS.md](./CONTRACTS.md)。

## 文档导航

| 文档 | 内容 |
|---|---|
| **README.md**（本文件） | 快速开始 / 架构速览 / 环境变量 / 导入方式 |
| [CONTRACTS.md](./CONTRACTS.md) | **契约与规范**：防幻觉契约、检索阈值契约、引用规范、回答规范、不可改阈值清单 |
| [DESIGN.md](./DESIGN.md) | 技术设计与运维：架构 / 技术栈 / 部署 / 运维 / 可观测 / 扩展点 / 数据模型 |
| [CLAUDE.md](./CLAUDE.md) | Claude Code 工作指南：命令 / 关键约束 / 测试即契约 |

## 快速开始

```bash
# 1. 配置环境变量
cp .env.example .env   # 编辑填入 LLM_API_KEY 等

# 2. 一键起 app + qdrant
docker compose up -d

# 3. 访问
# http://localhost:3000
```

本地开发：

```bash
npm install          # Node ≥ 22
npm run build:server # tsc 编译服务端
npm run build:web    # vite 构建前端
node dist/server/index.js   # 启动（需本地起一个 Qdrant，QDRANT_URL 指向它）
npm test             # vitest 单测（无需服务）
node scripts/e2e.mjs http://localhost:3000   # 端到端验收
```

## 核心约束（防幻觉契约）

1. **检索不到就不答**：服务端混合检索判定「无依据」时直接拒答，大模型不被调用
2. **答案必须带引用**：SYSTEM_PROMPT 强制每个结论标 `[n]`；前端校验编号范围，无有效引用时挂显式警告
3. **引用可核对**：每个 chunk 带 `startLine/endLine/startChar/endChar`，点击引用在原文视图中高亮定位
4. **测试即契约**：`tests/evidence.test.ts` 的 §4（应命中 8 条）/§5（应拒答 7 条）是检索调优的回归底线，改阈值前必须先跑 `npm test`

## 架构

```
docker compose
├── app（Hono，Node 22，多阶段构建，运行时零 node_modules）
│     · /api/config      就绪探测（绝不下发密钥）
│     · /api/chat        SSE 原样透传到 OpenAI 兼容接口
│     · /api/kb/*        知识库 CRUD · 搜索 · 蒸馏 · 统计
│     · /api/confluence-page  按 URL 抓取 Confluence（单页/子树）
│     · BM25 索引在内存（boot 时从 Qdrant 重建）
│     · 静态托管 dist/web（同源）
└── qdrant（qdrant/qdrant:v1.11.3，独立卷）
      · kqa_chunks  1024 维 Cosine + chunk 全 payload
      · kqa_docs    伪向量，存文档全文（原文定位用）
```

**混合检索**：词法通道（BM25，证据门阈值与 JS 版一致）OR 向量通道（bge-m3 相似度 ≥ 阈值），RRF (k=60) 融合排序。嵌入网关故障自动降级 BM25-only。蒸馏的知识点与原文拼接后同时进两个通道的索引。

**蒸馏**：文档列表点 💡 → 客户端逐块调 `/distill` 路由（服务端从 Qdrant 取块文，不信任客户端），LLM 生成 2-4 句概念性知识点存入 chunk.summary。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | OpenAI 兼容接口（服务端持有 Key） |
| `EMBED_BASE_URL` / `EMBED_API_KEY` / `EMBED_MODEL` / `EMBED_DIM` | 嵌入接口（默认与 LLM 同网关） |
| `EMBED_VECTOR_GATE` | 向量证据门开关；阈值校准不过先设 `0` |
| `QDRANT_URL` | compose 内默认 `http://qdrant:6333` |
| `CONFLUENCE_BASE_URL` / `CONFLUENCE_PAT` | Confluence REST + PAT（绕开 SSO） |
| `CONFLUENCE_INSECURE_TLS` | 自签证书的 Confluence 站设 `1` |
| `CONFLUENCE_MAX_PAGES` | 子树导入上限（默认 200） |
| `SEARXNG_URL` | 联网搜索兜底（可选）：自托管 SearXNG 地址；拒答页出现「联网搜索」按钮，结果明确标注非知识库依据 |
| `GEN_CERT` / `HTTPS_PORT` | `1` 时自签 HTTPS 端口 3443，解锁浏览器「选择本机目录」 |

## 导入方式

- **拖拽/点击/粘贴**：文本直传服务端（单篇 ≤ 5MB）
- **PDF 上传**：拖入 `.pdf` 走 `POST /api/kb/docs/upload`，服务端 `unpdf` 解析文本（单篇 ≤ 500MB；扫描/图片型 PDF 返回 422 明确提示）
- **选择本机目录**：浏览器 `showDirectoryPicker`（Chrome/Edge 86+，需 HTTPS 或 localhost——设 `GEN_CERT=1` 后走 3443），目录内 `.txt/.md/.csv/.pdf` 批量导入
- **Confluence 链接**：粘贴页面 URL，「导入页面」单页 /「导入子树」递归全部子孙
- **程序化**：`POST /api/kb/docs/bulk`（≤50 篇/次）

## 从旧 JS 版迁移

知识库不再存浏览器 localStorage——旧版数据需重新导入（Confluence 重导即可）。手动迁移一行命令：旧版 F12 Console 执行 `JSON.stringify(KB.docs)`，对每篇 `curl -X POST .../api/kb/docs -d '{"name":..,"text":..}'`。

## 变更记录

## v2.7（2026-10）

**第三批优化：用户配额限流 + 审计日志（多人使用前的治理准备）**
- 用户配额限流：`RATE_LIMIT_PER_HOUR`（每用户每小时问答上限）+ `RATE_LIMIT_BURST`（并发数上限），超限返回 429 + 重试时间；进程内存级滑动窗口计数，OIDC_REQUIRED=1 时生效，默认 0=不限
- 审计日志：`AUDIT_LOG_ENABLED=1` 时记录用户操作（提问/搜索/导入/删除/清空/登录/注册）到 Qdrant `kqa_audit` collection；异步写不阻塞主路径；含用户/操作/详情/IP
- 新增 `src/server/rateLimit.ts` + `src/server/audit.ts`；`rateLimitMiddleware` 挂在 chat/search/web-search 三个"消耗型"端点
- 新增 `tests/rateLimit.test.ts`（2 用例），总 80 vitest 全绿
- 透传 `RATE_LIMIT_PER_HOUR/RATE_LIMIT_BURST/AUDIT_LOG_ENABLED` 到 docker-compose / .env.example

## v2.6（2026-10）

**第二批体验优化：多格式文档 + 表格保形 + 多轮上下文**
- 多格式文档支持：新增 `docParse.ts`，上传通道扩展到 .docx（mammoth）/ .xlsx（sheetjs，sheet→markdown 表格保形）/ .pptx（jszip 解 a:t 文本）；Dropzone 与目录扫描均接受新格式；下游切块/嵌入/Qdrant 全复用 addDoc 链路
- 表格保形蒸馏：`distill.ts` `isTableChunk` 检测 GFM `|` 表 / HTML `<table>` → 用 `DISTILL_TABLE_SYSTEM_PROMPT` 保留 markdown 表格结构提取关键字段，而非压扁成散文；表格类 chunk 蒸馏失败率下降
- 多轮上下文：前端 `chat.ts` 把最近 3 轮 Q/A 随 `/api/kb/search` 发送 → `queryRewrite` 用 LLM 解析指代（"那它的涨跌幅呢" + 历史"中证1000" → "中证1000指数涨跌幅"）；回答 LLM 端已有 history+引用隔离
- reasoning 模型兼容：`queryRewrite`/`classifyQuestion` 的 max_tokens 120/200 → 2000（deepseek 系 reasoning 消耗 tokens，太小会掐掉 content）
- 新增 `tests/docMulti.test.ts`（8 用例：xlsx 保形/pptx 排序/表格检测），总 77 vitest 全绿
- 契约见 [CONTRACTS.md §12 检索增强契约](./CONTRACTS.md#12-检索增强契约不破坏阈值)

## v2.5（2026-10）

**第一批体验优化：检索链路追踪 + 行情数据直查 + 兜底可信度排序**
- 检索链路追踪：`SearchResult.trace` 返回每次检索的诊断信息（改写变体/词法·向量各路命中数/证据门判定/rerank 保留/各阶段耗时/拒答原因）；前端回答旁 🔧 追踪按钮展开面板；`GET /api/metrics` 增拒答原因聚合 `reasonCounts` 与通道聚合 `channelCounts`——答错时可定位是改写/检索/证据门哪个环节
- 行情数据直查：行情类问题（上证/深成/创业板/沪深300/中证1000/500/上证50）跳过知识库与 LLM，直连东方财富 push2 接口返回最新快照（直连 2.5s 超时自动退 Firecrawl rawHtml 备路 9s）；`directAnswer=true` + 前端"行情直查"标签；定义类问题（"什么是收盘价"）不误伤、正常走知识库
- 兜底来源可信度排序：联网搜索命中按域名白名单（交易所/东财/官方 +100）＞ 黑名单（UGC/内容农场 −50）＞ 引擎共识数（+10×N）排序，且排序在正文抓取前——Top-3 抓取落在最可信来源上；`WebHit.engines` 保留供排序与展示
- 同义词词典增"行情术语"分组；新增 `tests/marketData.test.ts`（6 用例），总 69 vitest 全绿
- 契约见 [CONTRACTS.md §12 检索增强契约](./CONTRACTS.md#12-检索增强契约不破坏阈值)

## v2.4（2026-10）

**联网搜索兜底增强（方案 A+B）——喂给 LLM 的原料从摘要升级到正文**
- 方案 A：SearXNG 摘要截断 400→2000 字符，条数上限 6→10，喂给 LLM 更多有效信息
- 方案 B：配置 `FIRECRAWL_URL` 后，对搜索 Top-3 结果用自托管 Firecrawl `/v2/scrape` 二次抓取页面正文（markdown ≤6000 字符，20s 超时）替换摘要——让模型能看到页面表格/数值而非只有搜索摘要尾巴
- 抓取失败/超时自动回退摘要，不阻塞；`WebHit.scraped` 标记该条已抓正文
- `WEB_SEARCH_SYSTEM_PROMPT` 重写：先立口径与公式、数据带时间戳、多期限/多主体用表格（≤6 行）、区分收盘与实时、给可操作查询路径——对齐专业回答规范
- 新增 `FIRECRAWL_URL` 环境变量（env / docker-compose / .env.example）；契约见 [CONTRACTS.md §10](./CONTRACTS.md#10-联网搜索兜底契约)

## v2.3（2026-10）

**SSO/OIDC 单点登录 + 本地账号注册（WeKnora 模式：双模式登录）**
- 新增 `src/server/oidc.ts`：Authorization Code + PKCE(S256)，纯 node:crypto 验签（RS256 JWT：iss/aud/exp + JWKS 公钥缓存/轮换），零第三方依赖
- 新增 `src/server/users.ts` + `kqa_users` collection（Qdrant）：本地账号注册（scrypt 密码哈希 + 16 字节 salt）、登录签发 HS256 JWT（access 8h / refresh 30d）；OIDC 首次登录自动建号（source=oidc）
- `/api/auth/*` 路由：oidc/config、oidc/login（302 Keycloak）、oidc/callback、register、login、me、refresh、logout；middleware 按 header.alg 分流验证 RS256（Keycloak）与 HS256（本地）
- 登录页（LoginPage.tsx）WeKnora 式双模式：SSO 按钮 + 邮箱密码表单 + 注册切换，按配置动态显示（只配 OIDC_* → 纯 SSO；只配 OIDC_JWT_SECRET → 纯本地；都配 → 双模式）
- 参照 GitLab wiki `oidc-demo-flask` 示例：无 id_token 时回退 userinfo 端点取用户信息；`realm_access.roles` 含 `admin` 的登录用户可免 ADMIN_TOKEN 执行清空/批量蒸馏/恢复；API 401 先静默 refresh 续期再回登录页
- `OIDC_REQUIRED=1` 时对话历史按 ownerSub 隔离（list/get/put/delete/pin/rename 校验所有者）；未配置任何鉴权时行为与历史版本一致（免鉴权）
- 新增 `tests/oidc.test.ts`（15 用例：PKCE/state 一次性消费/RS256 jwt 校验/防伪造/scrypt 往返与 salt 唯一/HS256 签发校验过期篡改），总 63 vitest 全绿
- 契约见 [CONTRACTS.md §13 SSO/OIDC 鉴权契约](./CONTRACTS.md#13-ssooidc-鉴权契约)

### v2.2（2026-10）

**检索/回答/运维全链路优化（10 项）**
- 父子块检索（small-to-big）：命中子块前后各扩 1 块喂 LLM，引用定位仍用子块行号
- 知识库分组：`GET /api/kb/groups` + `docNamePrefix`/`source` 过滤；顶栏 GroupSelect 下拉
- 事实直查：phraseHit+topScore 高 + 断崖式领先 → 跳过 LLM 直接展示片段（零延迟零幻觉）
- 反馈视图：FeedbackModal 负样本表（检索调优数据可视化）
- GET /api/metrics：uptime/内存/索引规模/蒸馏/检索耗时/拒答率
- 索引增量：BM25 增量 addDocChunks/removeDocChunks，单篇导入/删除不整库 rebuild
- 复杂问题多步检索：classifyQuestion 拆子问题各自检索 → 合并去重；简单问题 fast path
- 侧栏工具区重设计：主操作文字按钮 + 次操作图标按钮

### v2.1（2026-10）

**UI 全量翻新（参照 WeKnora / TDesign）**
- 引入 `tdesign-react` + `highlight.js`，暗色模式三态切换（系统/浅/暗，顶栏按钮）
- 回答代码块：深色底 + 语言标签 + 复制按钮 + 11 种语言语法高亮
- 证据卡、欢迎页、弹层、原文查看器全部 token 化

**PDF 导入**
- `POST /api/kb/docs/upload`：`busboy` 流式落盘（500MB 上限）+ `unpdf` 文本提取
- 扫描/图片型 PDF 返回 422；拖拽/目录导入接受 `.pdf`
- 新增 `tests/pdf.test.ts`（2 用例），总 44 vitest 全绿

**回答规范升级**
- `SYSTEM_PROMPT` 切换为《企业内部知识问答 Agent — 回答规范》
- 意图优先 / 最小充分 / 信息去重合并 / 版本管理 / 结构化表格展示
- `[n]` 引用独立呈现：表格用"来源"列，文字放句末，不嵌在名词/数字中间
- 详见 [CONTRACTS.md §4 回答规范](./CONTRACTS.md#4-回答规范)

**基础设施**
- `package.json` 补全真实 `dependencies`（原 lock 无对应声明）
- `.gitignore` 排除 `backups/`（运行时快照）、`pnpm-lock.yaml`

### v2.0.0

TS 重构版首发：Hono + React + Qdrant 混合检索的可溯源问答 Agent。
