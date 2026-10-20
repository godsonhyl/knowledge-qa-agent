# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

知识问答 Agent —— TS 重构版。一个**有据可循**的问答应用：只根据导入的知识库回答，每条结论标 `[n]` 引用可定位到原文行；检索无据直接拒答，LLM 不被调用。原项目（`/home/knowledge-qa-agent`）是零依赖 vanilla JS + localStorage；本仓库是 TS 重构版：**Hono（Node 22）+ React + Vite + Qdrant**，知识库迁到服务端 Qdrant，检索升级为 BM25 词法 + bge-m3 向量双通道混合（RRF 融合）。

## Commands

```bash
npm install            # Node ≥ 22
npm run build:server  # tsc -p tsconfig.server.json
npm run build:web     # vite build → dist/web
npm test              # vitest run（无需服务，CI 快）
npm run test:watch
npm run typecheck     # 双 tsconfig --noEmit
node dist/server/index.js                          # 启动（需本地 Qdrant）
node scripts/e2e.mjs http://localhost:3000         # 对运行中的 stack 做端到端验收
docker compose up -d                                # 一键起 app + qdrant
```

## 环境变量

服务端持有所有密钥。`/api/config` 只下发 `{ready, model, baseUrlHost, confluence, embed}`，绝不下发 key。

| Var | Meaning |
| --- | --- |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | OpenAI 兼容接口 |
| `EMBED_BASE_URL` / `EMBED_API_KEY` / `EMBED_MODEL` / `EMBED_DIM`(=1024) | 嵌入（默认与 LLM 同网关，bge-m3） |
| `EMBED_VECTOR_GATE` | 向量证据门开关；校准不过先设 `0`（降级 BM25-only） |
| `QDRANT_URL` | compose 内默认 `http://qdrant:6333` |
| `CONFLUENCE_BASE_URL` / `CONFLUENCE_PAT` / `CONFLUENCE_INSECURE_TLS` / `CONFLUENCE_MAX_PAGES` | Confluence 接入 |
| `GEN_CERT` / `HTTPS_PORT` | 自签 HTTPS 端口 3443，解锁浏览器安全上下文（showDirectoryPicker） |

## Architecture

单 pnpm/npm 包，`src/server/` + `src/web/` + `src/shared/`，双 tsconfig + 一个 vitest config。生产：Hono 静态托管 `dist/web`（同源，无 CORS），开发：vite dev proxy `/api` → :3000。

### server.js（Hono 路由）

- `GET /api/config` → 就绪探测。
- `POST /api/chat` → **SSE 原样透传**到 `${LLM_BASE_URL}/chat/completions`（不重编码；客户端断开 abort 上游；校验 messages[0] 是 system）。
- `POST /api/confluence-page` `{url, recursive?}` → 调用 `fetchConfluencePage`，单页或 CQL ancestor 子树（分页拉到 `CONFLUENCE_MAX_PAGES`）。
- `/api/kb/*`：
  - `POST /docs` `{name,text,source}` → 切块 + 嵌入 + Qdrant 双 collection upsert；重名 409。
  - `POST /docs/bulk` ≤50 篇。
  - `GET /docs`（列表，投影排除 text）/ `GET /docs/:id`（含全文）/ `DELETE /docs/:id` / `DELETE /docs`（清空 = drop+recreate）。
  - `GET /docs/:id/chunks`；`POST /docs/:id/chunks/:index/distill`（服务端取块文，LLM 蒸馏，写 payload + 重新 embed + 更新 BM25 索引）。
  - `POST /search` `{question, topK?, sensitivity?}` → `SearchResult`。
  - `GET /stats` → 汇总数据。

### chunker.ts

移植自 `core.js`：`detectHeading` / `chunkDocument`（带 `startLine/endLine/startChar/endChar`）。常量 `CHUNK_TARGET=520 / MAX=760 / MIN=90 / OVERLAP=90` **一字不动**——字符偏移是引用定位契约，selftest §7 是它的回归。char-offset 计算（lineOffsets 表）也合并在 `chunkDocument` 内。

### bm25.ts / search/retriever.ts

逐行移植 `retrieval.js`。STOPWORDS、`tokenize`、`strongTokens`、`buildQueryPhrases`（query 内相邻 bigram 成段 + 长度≥3 拉丁术语）、`BM25Index`(k1=1.5, b=0.72) 全部保留。`Retriever.search` 的证据门阈值 `needMatches=3-1.2s / needRarity=0.62-0.22s / needScore=8-4.5s` **不得改动**——§4（应命中 8 条）/§5（应拒答 7 条）是回归契约。BM25 索引 text+summary 拼接后 tokenize，蒸馏同时增强两个通道。

### search/hybrid.ts

新代码：RRF（k=60）融合 BM25 与向量结果，按 rank 倒数和排序。证据门 = 词法门 OR 向量门（`topSim >= 0.62 - 0.15s`）。嵌入网关挂掉自动降级 BM25-only。`EMBED_VECTOR_GATE=0` 可关闭向量门。

### qdrant.ts / kbStore.ts

plain `fetch` 调 Qdrant REST（不引 SDK）。两个 collection：
- `kqa_chunks`：1024 维 Cosine；payload 含 `kind/docId/index/docName/section/startLine/endLine/startChar/endChar/text/summary/summaryAt/source/addedAt`；payload 索引 `docId/docName/source`。chunk id = `UUIDv5("kqa:v1", ${docId}:${index})` 幂等。
- `kqa_docs`：伪向量(size 1)，存文档全文（原文定位用）。

`ensureCollection` 带 30×2s 重试，容忍 Qdrant 启动慢。**注意 Qdrant 把所有响应包在 `{result:...}` 里**，`scrollAll`/`searchPoints`/`countPoints` 必须 `body.result` 解构——历史上这个坑栽过。

### kbIndex.ts

服务端 BM25 索引生命周期。boot 时从 Qdrant scroll 全量 chunks 重建（毫秒级）。所有检索/变更走 promise 链队列串行化（distill 与 import 不交错 rebuild）。

### web（React + Vite + zustand）

- `stores/config.ts` `stores/chat.ts` `stores/kb.ts`：sensitivity/topK/temperature + retrievalOnly 持久到 `localStorage kqa.config.v2`；对话历史存 `kqa.chat.v2`。**知识库不进 localStorage**（已迁 Qdrant）。
- `qaPrompt.ts`：`SYSTEM_PROMPT` 逐字移植；`REASON_TEXT` 拒答文案。
- `citations.ts`：`validateCitations`（`[n]` 范围校验）+ `renderInlineCitations`（React 元素，自动转义，无 XSS）。
- `stores/chat.ts.ask()`：先调 `/api/kb/search`，**hasEvidence=false 时不调 `/api/chat`**（防幻觉硬约束）；流式回答走 `callModel`（移植 SSE 解析），完成后校验 `used.size`，无引用挂警告；拒答时按用户主动点击才调「让模型补充说明」（明确标注非知识库依据）。
- 组件：Sidebar / Dropzone / ConfluenceImport / DocList / ChatView / Message / EvidenceCard / RichText / Composer / ViewerModal / SummaryModal / SettingsModal / Toast。
- **浏览器直连 LLM 通道已删除**——服务端代理是唯一路径；设置弹窗只读模型信息 + 检索参数。
- `showDirectoryPicker` 仅 Chrome/Edge 86+ 且安全上下文可用——故保留 `GEN_CERT` 自签 HTTPS 端口（3443）。

## 测试即契约

- `tests/chunker.test.ts`：§2 分块、§7 行号+字符偏移精度、§10 长正文 overlap、边界输入。
- `tests/evidence.test.ts`：**§4（应命中 8 条）§5（应拒答 7 条）字面不变**——任何检索调优改动必须先跑过这两组。§6 拒答不泄露片段、§11 phrase-hit 回归、§12 蒸馏后语义近邻命中。
- `tests/confluence.test.ts`：§11 Confluence URL 解析（4 种形式 + 拒绝）+ storage→纯文本 + 引用编号校验。
- `scripts/e2e.mjs`：对运行中的 stack 跑种子导入 + §4/§5 + 引用偏移往返 + chat SSE 透传。

## 关键约束（不要破坏）

- **零重编码 SSE**：chat 透传用 `new Response(upstream.body, ...)` + `X-Accel-Buffering: no`。
- **chunker/bm25/retriever 阈值不可改**——它们是 selftest 契约的具体形式。
- **Qdrant id 必须 UUID/uint**（UUIDv5 幂等）。
- **distill 时服务端从 Qdrant 取块文**，绝不信任客户端传入的 text。
- **localStorage 只存配置 + 对话**，知识库永远在 Qdrant。
- **检索服务端化**：`POST /api/kb/search` 是唯一检索入口；前端不跑 BM25。
- 服务端持有所有密钥；浏览器只看 `/api/config` 的 ready 标志。
