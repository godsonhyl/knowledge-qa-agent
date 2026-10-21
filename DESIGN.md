# 知识问答 Agent — 技术设计与运维文档

> **定位**：企业内部知识库的可溯源 RAG 问答服务。所有回答**有据可循**——只基于检索命中的原文片段，每个结论带 `[n]` 引用、点击可定位到原文行；检索无据时明确标注后由大模型兜底或纯拒答，绝不伪装成有据可循。
>
> **适用读者**：负责部署/运维/二次开发的基础设施与平台工程师。本文以 Infra 视角组织：架构 → 技术栈 → 部署 → 运维 → 可观测 → 扩展点。

---

## 1. 架构总览

```
                    ┌─────────────────────────────────────────────┐
                    │            docker compose (kqa-ts-net)       │
  浏览器             │                                             │
  React SPA  ◄────►  │   app (Node 22 alpine)      qdrant (v1.11.3) │
  HTTP :3002        │   Hono server               向量库 + payload │
  HTTPS :3443       │   静态托管 + API + SSE 代理   外部命名卷持久化  │
  (自签 TLS)         │   内存 BM25 (boot 重建)                      │
                    └──────────┬──────────────────────┬────────────┘
                               │                      │
                    ┌──────────▼──────────┐  ┌────────▼─────────┐
                    │  LLM 网关 (OpenAI 兼容)│  │   Confluence      │
                    │  deepseek-v4.1-flash │  │   PAT + 自签 TLS  │
                    │  BAAI/bge-m3 1024维   │  │   CQL 子树递归    │
                    └─────────────────────┘  └──────────────────┘
```

**关键边界**：
- 浏览器**不直连任何 LLM/Confluence/Qdrant**——全部经 app 代理，密钥只驻服务端 env，`/api/config` 仅下发 `{ready, baseUrlHost, model, confluence, embed, clearEnabled}`，key 永不出服务端。
- Qdrant **不暴露宿主端口**，仅 compose 内部网络可达（`http://kqa-ts-qdrant:6333`）。
- app 镜像**运行时零 npm**——宿机 `npm run build` 产出 `dist/`，镜像只 `COPY dist + node_modules`，适配内网无法访问 npm registry 的离线环境。

### 1.1 请求链路（一次问答）

```
POST /api/kb/search  ──► 混合检索（词法 BM25 ∪ 向量 bge-m3 + RRF 融合）
                        └─ 证据门：词法门 OR 向量门
                            ├─ hasEvidence=false ─► 2a 拒答页（不调 LLM）
                            │                     2b 兜底（FALLBACK prompt，醒目标注）
                            └─ hasEvidence=true  ─► ③
POST /api/chat       ──► 证据组装（top-8 片段 + 蒸馏知识点 + 3 轮历史）
                        └─ SSE 原样透传 → 前端流式渲染
                        └─ validateCitations → 角标↔证据卡联动 → 定位原文行
```

---

## 2. 技术栈

> 整体技术选型与 **DeepSeek Harness** 同栈：**Node 22 + TypeScript strict + Hono + React + Vite**。无重型运行时依赖，贴近 stdlib，利于内网离线交付与长期维护。

### 2.1 运行时与语言

| 组件 | 版本 / 选型 | 选型理由 |
|---|---|---|
| **Node.js** | 22 (alpine) | 原生 `fetch` / `Request` / 流式 `Response`，SSE 透传不需 undici |
| **TypeScript** | strict，双 tsconfig（server/web）+ 共享 `@shared` | 跨边界 DTO 类型一致；strict 锁死 null/any |
| **Hono** + @hono/node-server | 极简 HTTP 路由，无框架侵入 | 体积小、与 Node 原生 Request 兼容 |
| **Vite 8**（rolldown） | 前端构建 + dev server | esbuild 级速度 |
| **zustand** | 前端状态 | 无 Provider 样板，chat/config/kb/cite 四 store |
| **React 19** | UI | 自动转义消除 XSS 一整类 |
| **vitest** | 测试 | 与 Vite 共享配置 |

### 2.2 AI 能力接线

| 能力 | 实现 | 调用方式 |
|---|---|---|
| **LLM 生成** | deepseek-v4.1-flash（OpenAI 兼容 `/v1/chat/completions`）| 服务端代理 + SSE 透传（`new Response(upstream.body)`，不重编码） |
| **文本嵌入** | BAAI/bge-m3 1024 维 | `/v1/embeddings`，batch 32 |
| **中文分词** | 自实现 bigram+unigram（无第三方词典）| 内网无分词库；这套分词是检索契约的一部分 |
| **检索** | BM25（内存）+ 向量（Qdrant kNN）+ RRF 融合 | 双通道互补，证据门 OR |
| **知识蒸馏** | LLM 非流式生成 2-4 句知识点 | 服务端取块文（不信任客户端）→ 写回 + 重嵌入 |

### 2.3 存储与基础设施

| 组件 | 用途 |
|---|---|
| **Qdrant v1.11.3** | 双 collection：`kqa_chunks`（1024 维 Cosine + payload）+ `kqa_docs`（伪向量 size-1，存全文供查看器）|
| **docker compose** | 两个服务：app + qdrant；外部命名卷 `kqa_ts_qdrant_data` + 外部网络 `kqa-ts-net` |
| **Node 原生 https** | 自签 TLS（GEN_CERT），`showDirectoryPicker` 需要安全上下文 |
| **node:crypto** | UUIDv5 幂等 chunk ID + `timingSafeEqual` 令牌校验（防时序侧信道）|
| **node:fs** | JSON 快照备份（清空前自动导出）|

---

## 3. 部署

### 3.1 前置条件

- Docker Engine + docker compose plugin
- 内网可达的 LLM 网关（OpenAI 兼容）与（可选）Confluence 实例
- 内网 npm registry（构建机用；**运行容器不需要**）

### 3.2 离线构建（内网无 npm registry 时）

```bash
# 在能访问 npm 的机器上装好依赖（或经跳板机 tar 拉回 node_modules）
npm install
npm run build            # 产出 dist/web + dist/server

# 镜像构建：只 COPY dist + node_modules，运行时不跑 npm
docker compose build
docker compose up -d
```

### 3.3 配置（.env，gitignored）

| 变量 | 必填 | 说明 |
|---|---|---|
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | ✅ | OpenAI 兼容网关 |
| `EMBED_BASE_URL` / `EMBED_API_KEY` / `EMBED_MODEL` / `EMBED_DIM` | ✅ | 嵌入服务（可与 LLM 同网关）|
| `EMBED_VECTOR_GATE` | | 向量证据门开关（0=纯 BM25 降级；校准不过先关）|
| `QDRANT_URL` / `COLLECTION_CHUNKS` / `COLLECTION_DOCS` | ✅ | Qdrant 地址 |
| `CONFLUENCE_BASE_URL` / `CONFLUENCE_PAT` | | Confluence 导入（自签 TLS 用 `CONFLUENCE_INSECURE_TLS=1`）|
| `CONFLUENCE_MAX_PAGES` | | 子树导入上限（默认 200，现网设 10000）|
| `ADMIN_TOKEN` | | **管理员令牌**：设了才允许清空/批量蒸馏/恢复；不设则全部禁用 |
| `GEN_CERT` / `HTTPS_PORT` | | 自签 HTTPS（解锁浏览器安全上下文）|
| `HOST_PORT` / `HTTPS_HOST_PORT` | | 宿主映射（默认 3002 / 3443）|
| `BACKUP_DIR` | | 快照目录（默认 `/app/backups`，compose 挂载到宿机 `./backups`）|

### 3.4 端口与卷

```yaml
app:
  ports: 3002:3000 (http)  /  3443:3443 (https 自签)
  volumes:
    - ./backups:/app/backups        # 清空快照持久化到宿机
  healthcheck: GET /api/config (30s/5s/3)
  restart: unless-stopped           # 抗 OOM 自动拉起
qdrant:
  volumes:
    - kqa_ts_qdrant_data:/qdrant/storage   # 外部命名卷
  # 不映射宿主端口（仅内部网络）
```

### 3.5 安全要点

- **密钥隔离**：所有 key 只在服务端 env；`/api/config` 仅下发非敏感信息。
- **危险操作鉴权**：清空 / 批量蒸馏 / 恢复 三条路径需 `X-Admin-Token` 头，服务端 SHA-256 + `timingSafeEqual` 定长比较。
- **令牌存储**：前端令牌放 `sessionStorage`（会话级，关浏览器即清），降低驻留暴露。
- **清空防护**：UI 两段式红色确认 + 自动 JSON 快照（保留最近 10 份）+ 误清可一条命令恢复。
- **路径穿越**：`backup.ts` 读取快照时校验解析后路径仍在 `backups/` 内。
- **TLS**：Confluence 自签证书用 `rejectUnauthorized=false`（仅限内网受信实例）。

---

## 4. 运维操作手册

### 4.1 健康检查与状态

```bash
# 容器健康
curl -sf http://<host>:3002/api/config | jq .   # {ready, model, confluence, embed, clearEnabled}
docker compose ps

# 知识库规模
curl -s http://<host>:3002/api/kb/stats | jq    # {docCount, totalChunks, distilled, bySource}

# 批量蒸馏进度
curl -s http://<host>:3002/api/kb/distill-status | jq
```

### 4.2 批量蒸馏（管理员）

后台串行调用 LLM 蒸馏全部未处理切片，已蒸馏的自动跳过（断点续做）。

```bash
# 启动
curl -X POST http://<host>:3002/api/kb/distill-all \
  -H "X-Admin-Token: $ADMIN_TOKEN"
# 轮询进度（前端每 2s 自动轮询）
watch -n3 'curl -s http://<host>:3002/api/kb/distill-status | jq "{running,done,skipped,failed,current}"'
# 中止（处理完当前块后退出）
curl -X POST http://<host>:3002/api/kb/distill-stop -H "X-Admin-Token: $ADMIN_TOKEN"
```

**失败块处理**：纯表格 / CLI 命令堆叠 / IP 列表这类无完整语义的块，蒸馏 prompt 产不出 2-4 句知识点，模型拒答——这类块重试不收敛，保留跳过即可，BM25 词法检索不受影响。

### 4.3 清空与恢复

```bash
# 清空（自动备份到 ./backups/kb-<ts>.json）
curl -X DELETE http://<host>:3002/api/kb/docs -H "X-Admin-Token: $ADMIN_TOKEN"
# → {"ok":true,"backup":"kb-2026-10-20T...json"}

# 列出快照
curl -s http://<host>:3002/api/kb/backups | jq

# 从快照恢复（知识点一并写回，省一轮 LLM 调用）
curl -X POST http://<host>:3002/api/kb/restore \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"file":"kb-2026-10-20T04-02-53Z.json"}'
```

### 4.4 重启 / 升级 / 回滚

```bash
# 代码变更后重新构建部署（保留 Qdrant 数据与 backups）
docker compose up -d --build

# 仅重启 app（Qdrant 不动，BM25 索引 boot 时从 Qdrant 全量重建，毫秒级）
docker compose restart app

# 完全回滚：保留 ./backups 与 kqa_ts_qdrant_data 卷即可重建
```

### 4.5 常见问题排查

| 症状 | 排查 |
|---|---|
| `/api/config` 返回 `ready:false` | LLM_* env 未注入容器；`docker compose config` 确认 env 透传 |
| 向量检索误放无关文档 | 调低灵敏度滑块，或临时 `EMBED_VECTOR_GATE=0` 走纯 BM25（行为等同旧版）|
| 蒸馏大量失败 | 多为 LLM 网关瞬时抖动；重启批量蒸馏任务，已成功的自动跳过；残余失败查 `lastError` |
| 容器启动 OOM | `restart: unless-stopped` 会自动拉起；长期方案是给 Qdrant/app 调内存上限 |
| 3443 证书不信任 | 自签证书，浏览器选「继续访问」；SAN 已含本机 IP |
| `showDirectoryPicker` 报错 | 必须安全上下文（HTTPS 或 localhost），用 :3443 访问而非 :3002 的 http://IP |

---

## 5. 可观测性

当前以容器日志为主，无外部 metrics 后端（轻量部署）：

```bash
docker logs -f kqa-ts-app
# 启动横幅：[大模型] [Confluence] [嵌入] [Qdrant] [HTTPS]
# 运行时：[向量] 检索失败降级 / [索引] BM25 已就绪 N chunk
# 蒸馏任务：lastError 字段（经 /api/kb/distill-status 暴露）
```

**可对接的扩展点**（见 §7）：
- `/api/kb/distill-status` 的 `{done,skipped,failed,current}` 可被 Prometheus exporter 抓取
- SSE 透传链路可加 request-id 串联前端 ↔ 上游
- Qdrant 自带 `/metrics`（Prometheus 格式），可在 compose 里开放端口接 Grafana

---

## 6. 核心数据模型与契约

> 契约的完整、权威清单已抽取到 [CONTRACTS.md](./CONTRACTS.md)。本节保留数据模型与防幻觉契约的速览；改动任何阈值或引用规则前，先读 CONTRACTS.md。

### 6.1 Qdrant 双 collection

```jsonc
// kqa_chunks：point per chunk
id = UUIDv5("kqa:v1", `${docId}:${index}`)   // 幂等 upsert，重导入不留孤儿
vectors: { size: 1024, distance: "Cosine" }   // 嵌入输入 = 文档名 + 正文 + 知识点
payload: {
  kind, docId, index, docName, section,
  startLine, endLine, startChar, endChar,    // ★ 引用定位契约
  text, summary, summaryAt, source, addedAt
}
keyword 索引: docId / docName / source

// kqa_docs：point per 文档（存全文，原文查看器用）
vectors: { size: 1, distance: "Cosine" }     // 伪向量 [0]，从不 search
payload: { kind:"doc", name, source, size, addedAt, text }
```

### 6.2 防幻觉契约（产品灵魂）

| 契约 | 实现 |
|---|---|
| 无据不调用 LLM | 前端 `hasEvidence=false` 直接 return，不打 `/api/chat` |
| 兜底不伪装 | FALLBACK prompt 强制开头声明 + 全程禁用 [n] + UI 琥珀色警示 |
| 引用必须有效 | `validateCitations` 校验 [n] ∈ 1..hits；越界保留字面文本 |
| 无引用即警告 | `used.size===0` → 挂「无法确认来自知识库」横幅 |
| 原文级定位 | 每块带 startLine/endLine/startChar/endChar，查看器高亮 |
| 矛盾不裁决 | prompt：标注双方来源，模型不得自行选边 |
| 拒答不泄露 | 低分片段仅在「仅供参考」区展示，不进 prompt |

> **回答规范（2026-10 更新）**：`SYSTEM_PROMPT` 切换为《企业内部知识问答 Agent — 回答规范》。核心转变：**回答质量 ≠ 用了多少检索结果**——先识别意图、判断优先级、压缩合并，再用最少的必要信息解决用户问题，而非"尽可能多使用检索片段"。六原则：意图优先（只回答直接相关，相关但非必要的背景默认不展开）/ 结论优先 / 最小充分 / 证据优先 / 信息去重合并 / 版本管理（新版为主，旧版差异作补充并标注"是否仍在用需确认"）。结构化信息（IP/端口/服务器/账户/运营商/配置项）优先表格，每行一个主体。引用规则强化：`[n]` 独立呈现不打断阅读——表格用独立"来源"列，文字放句末，禁止嵌在名词/数字/名称中间。来源清单仍由 UI「引用依据」区承载。`FALLBACK_SYSTEM_PROMPT` 同步引入意图优先/最小充分。前端联动、`validateCitations`、后端检索链路零改动，44 vitest 全绿。

### 6.3 检索阈值（回归契约，不得改动）

```
needMatches = 3 − 1.2s     s = sensitivity/100 ∈ [0,1]
needRarity  = 0.62 − 0.22s
needScore   = 8 − 4.5s
向量门: topSim ≥ 0.62 − 0.15s   (bge-m3 跨主题中文 cosine 校准值)
```

`tests/evidence.test.ts` 的 §4（应命中 8 条）/ §5（应拒答 7 条）是任何检索层改动的合入门槛——42 个 vitest 必须全绿。

### 6.4 证据门 5 级判定

```
matched          多词命中 + 分数达标
term-hit         单个拉丁术语 + 稀有度够
phrase-hit       命中 query 的连续词组（整词强证据）
high-score       高分 + 至少两词
distinctive-pair 两个高稀有度词
```

---

## 7. 扩展点

| 方向 | 入口 | 说明 |
|---|---|---|
| 外部 metrics | `distillJob` 状态、Qdrant `/metrics` | 接 Prometheus + Grafana |
| 多模型路由 | `routes/chat.ts` | 按 question 路由到不同 LLM |
| 鉴权层 | Hono middleware | 当前仅 ADMIN_TOKEN 守危险操作，普通问答无鉴权；可加 SSO/OIDC 中间件 |
| 索引并发 | `kbIndex.ts` promise 队列 | 已串行化；扩多副本需换共享索引或 Qdrant 全文 |
| 增量备份 | `backup.ts` | 当前仅清空前快照；可加定时 cron 备份 |
| 文档名加权 | `bm25.ts` | 文档名已进索引；可进一步对 docName 命中块加权 |
| 表格类蒸馏 | `distill.ts` | 对纯表格块改用「提取关键字段」而非「概括知识点」prompt，消化当前 ~3% 失败块 |

---

## 8. 目录结构

```
knowledge-qa-agent-ts/
├── docker-compose.yml  Dockerfile  .env(.example)
├── tsconfig.json / tsconfig.server.json / tsconfig.web.json
├── package.json
├── src/
│   ├── shared/        types.ts (前后端 DTO) · seed.ts (校准语料)
│   ├── server/
│   │   ├── index.ts env.ts ids.ts cert.ts
│   │   ├── chunker.ts          切块（标题感知 + 行号/字符偏移表）
│   │   ├── bm25.ts             中文分词 + BM25（文档名/正文/知识点同索引）
│   │   ├── search/{retriever,hybrid}.ts   词法 + 向量 + RRF + 证据门
│   │   ├── embeddings.ts qdrant.ts kbStore.ts kbIndex.ts
│   │   ├── distill.ts distillJob.ts       单块 / 后台批量蒸馏
│   │   ├── backup.ts                      JSON 快照
│   │   ├── confluence.ts                  URL 解析 + CQL 子树
│   │   └── routes/{config,chat,kb,confluence,static}.ts
│   └── web/            stores/ components/ qaPrompt.ts citations.ts
├── tests/             42 vitest（含 §4/§5 检索契约）
├── scripts/e2e.mjs    21 项运行时检查
└── backups/           清空快照（挂载进容器）
```

> **UI 翻新（2026-10）**：前端引入 `tdesign-react`（1.18.4，React 19 兼容）+ `highlight.js`（11.12.0），参照腾讯 WeKnora 的 TDesign 视觉做全量翻新。基座：`main.tsx` 引入 `tdesign-react/dist/tdesign.css`（自带 `:root[theme-mode='dark']` 双主题变量块）；`stores/theme.ts`（zustand persist `kqa.theme`，默认 system）写 `<html theme-mode="dark">` + `.dark` class，顶栏三态切换（系统/浅/暗）。组件：`Button/Switch/Input/Textarea/InputNumber/Slider/Tag` 替换原生控件，`tdesign-icons-react` 替换 emoji 图标。回答渲染（`RichText.tsx`）代码块升级为 WeKnora `chat-code-block` 风：深色底 + 语言标签 + 复制按钮 + `highlight.js/lib/core` 按需注册 11 种语言语法高亮（流式期间跳过高亮，完成后 `hljs.highlight`）。证据卡、欢迎页、弹层、查看器全部 token 化（`--td-brand` 等）。后端零改动，42 vitest 检索契约保持全绿。产物：CSS 495kB（gzip 58.6kB）、JS 547kB（gzip 172.9kB）。

> **PDF 导入（2026-10）**：新增 `POST /api/kb/docs/upload`（multipart/form-data）支持 PDF 二进制导入。服务端 `busboy` 流式落盘到 `os.tmpdir()` 避免大文件整载内存（500MB 上限，落盘阶段边收边校验），`unpdf`（pdf.js 封装）提取全文，空文本/扫描件返回 422，其余复用既有 `addDoc`（切块 + 嵌入 + Qdrant 双 collection upsert + 重名 409）。新增 `src/server/pdf.ts`（`extractPdfText` + `PdfNoTextError`，单测覆盖可解析 PDF 与无文字层两种情况）。前端 Dropzone `accept` 加 `.pdf`，拖拽/目录导入对 PDF 走 `uploadPdfs`（multipart 上传），文本类照旧走 JSON 入口。新增依赖：`unpdf` + `busboy`（+ `@types/busboy` dev）。`tests/pdf.test.ts` 2 个用例，总 44 vitest 全绿。

---

## 9. 快速启动

```bash
cp .env.example .env        # 填 LLM/EMBED/QDRANT/CONFLUENCE/ADMIN_TOKEN
npm install && npm run build
docker compose up -d
# 打开 https://<host>:3443（自签，浏览器选「继续访问」）
# 侧栏导入 Confluence 子树或拖入文件 → 提问
```

**首次管理操作**：
- 批量蒸馏：侧栏「💡 批量蒸馏全库」→ 输入 `ADMIN_TOKEN`
- 清空：两段式红色确认 → 自动快照到 `./backups/`
- 恢复：`curl -X POST .../api/kb/restore -H "X-Admin-Token: ..." -d '{"file":"kb-xxx.json"}'`

---

## 附 A：AI 技术清单

| 技术 | 作用 |
|---|---|
| **RAG**（检索增强生成）| 知识库为唯一事实来源，模型只组织语言 |
| **Hybrid Search**（BM25 + 向量 + RRF）| 精确术语与语义改写双覆盖 |
| **中文无词典二元分词** | bigram+unigram + 动态泛用词过滤 + phraseHit |
| **知识蒸馏** | 切片→LLM 生成知识点→重新嵌入，增强语义召回 |
| **SSE 流式生成** | 透传上游流，前端逐 token 渲染 |
| **防幻觉契约** | 无据不调、引用校验、原文定位、矛盾并列 |
| **无据兜底** | 受控例外，三重标识不伪装成有据 |

---

## 附 B：实际问题示例（实测，非编造）

以下均为对本知识库（302 篇内部文档，含 Confluence 子树导入 + 本地文件）的真实问答，
检索命中与回答均由运行中的服务实测产出。每条回答后的 `[n]` 对应「引用依据」区可点击定位的原文片段。

### B.1 「是什么」类——无完整定义时如实说明并给出已有事实

> **问：gitlab-runner 是什么**

**检索**：8 块全来自 `K8S 应用部署 - GitLab Runner.md`，命中 `term-hit`。

**答**：参考片段中没有对「GitLab Runner 是什么」给出任何定义或作用说明，因此无法据此回答它的性质与用途。

片段中只出现了与它相关的部署形态和配置事实：它以 Helm chart `jd/gitlab-runner` 的形式安装或升级，部署在 `gitlab-runner` 命名空间，可用 `--create-namespace` 自动创建该命名空间 [6]；部署后存在对应的 Pod、Deployment 与 Service 资源可供查询 [6]；其基础配置中 `gitlabUrl` 和 `runnerRegistrationToken` 为必填项，`namespace` 默认 `gitlab-runner`，`replicas` 默认 `2` [7]；文档中还提到「已注册的 Runner」以及重启 Deployment 的操作 [2]。

若要了解 GitLab Runner 的定义、在 CI/CD 中的角色等，需要补充相应资料。

> 体现的契约：知识库缺定义时**不靠模型记忆补**，只列已有事实并指明缺什么。

---

### B.2 「最近更新」类——版本号逐条带引用

> **问：FixGateway 最近更新了什么**

**检索**：命中 `彭博FixGateway.md`（蒸馏后）+ 运行时间规范，`high-score`。

**答**：FixGateway 的更新记录主要出现在彭博 FixGateway 的版本变更中：最新一项是调整 tag 以支持加拿大和巴西市场，并调整入账户心跳的 SQL [5]。再往前是 v1.0.3.20250514，为 MS 的 HTVWAP 增加默认参数支持 [5]；v1.0.2.20250507 为 JPM 的 CLOSE 算法增加参数支持，并为 MS 增加 HTTWAP/HTVWAP 算法支持 [5]；v1.0.1.20250305 修复了盘中重启程序后历史订单 exchid 入库错误的 bug [5]；v1.0.0.20250109 将老版本程序改为 CICD 编译，修正撤单拒单入库异常……

除版本变更外，参考片段只说明了 FixGateway 的运行与取数方式：它采用一次性读取从 Exchange 表获取交易所编号、时区偏移和大洲区域信息 [1]；运行时间上每周一至周六 0:01 启动……这些不属于更新内容。

> 体现的契约：版本号 / 日期 / 算法名逐事实标 [5]；并主动区分「非更新内容」避免误答。

---

### B.3 「介绍系统」类——多文档交叉拼接

> **问：介绍下 TL 交易系统**

**检索**：8 块来自 `TradeLight-发布记录.md` + `TL-衍生品交易系统-准备上线评估.md` + `TD机器.md` + `tddata共享目录依赖梳理.md`，文档名参与匹配把含「TL」「衍生品交易系统」的关键文档拉了上来。

**答**：知识库中没有对 TL 交易系统的整体介绍，只能从片段中拼出零散信息。

从片段标题看，TL 是「衍生品交易系统」，上线前评估把「TL 系统及配套程序相关 bugs 需要修正」单独列为一类问题 [4]。发布记录以组件矩阵的形式维护 TL、TLStruct、TLBroker 与多个 Agent 的配套版本关系，并给出 pair、lspair、BSpread、Inner 四类插件各自要求的最低版本门槛 [1][5][8]。例如 TL v1.1.80.20260119 对应 TLStruct v1.0.57.20251231、TLBroker v1.0.59.20260119、Agent 最低依赖 v1.1.19.20240510 [5]。

版本记录里能看到的系统能力包括：v1.1.79 将股指期货与国债期货的风控粒度由 group 改为 bigacctno……[5]；v1.1.58 股票风控模块增加股票暂停风控指标……[1]……

部署与运维方面，交易机器清单中登记了 TL、BrokerService、JDAPI Relay、洪勤交易等组件 [7]。tddata 共享目录用于跑交易系统周边的配套程序，其中 tlshell-deep 任务重要度 8 分、影响所有 TL 系统，应急时需手动执行 tlshell 中的 deep 操作并重启 TL 交易系统 [6]。

> 体现的契约：多源交叉引用 [1][4][5][7][8]；缺架构/模块职责时如实指出。

---

### B.4 「怎么用」类——步骤式自然叙述

> **问：K8S 普通用户怎么用**

**检索**：3 块全来自 `K8S-普通用户使用.md`，`term-hit`。

**答**：普通用户使用 K8S 主要依靠两类界面：网页端的 Rancher，以及本地安装的命令行工具 K9S；其余监控、告警、日志组件由管理员预装，普通用户一般通过网页查询 [2]。

可用组件方面，Rancher 是 Web 版 K8S 管理界面，Prometheus 负责监控采集并提供网页查询，Grafana 基于 Prometheus 做图形化监控展示，Alertmanager 承担告警的接收、分组、抑制、降噪和路由分发，VictoriaLogs 用于收集 K8S 日志并提供网页查询 [2]。其中只有 K9S 需要本地安装 [2]。

在 Windows 上使用 K9S，需要先准备 kubectl.exe 和 k9s.exe，把这两个可执行文件放在同一目录（例如 C://tools/），再把该目录加入 PATH 环境变量 [3]。

拿到集群访问配置的流程是：打开 Rancher 进入目标 K8s 集群，点击右上角的"下载配置文件"，会得到一个 yaml 文件；然后在用户目录下新建 .kube 文件夹，把该 yaml 放入其中 [1]。K9S 的配置文件位于用户目录下的 .config\k9s\config.yaml，针对 Windows 上卡顿的情况，可以把刷新间隔从 2 秒延长到 10 秒，关闭日志流、事件轮询和 Xray 关系图 [1]。

还有一条使用约束：测试和生产环境的 K8S namespace 需要统一维护，不要自己随便建立 [6]。

> 体现的契约：步骤式但用自然段落叙述（非机械列表），每条结论标来源。

---

### B.5 「怎么安装」类——命令 + 真实部署参数

> **问：kafka 怎么安装**

**检索**：`kafka安装.md` + `中间组件.md`，`term-hit`。

**答**：Kafka 的安装方式是：先从 Apache Kafka 官方下载页面获取最新发行版，安装前确认运行环境的 Java 版本不低于 17 [1]；具体步骤可参照官方 quickstart 页面 [2]。

实际部署时，通常用 `nohup bin/kafka-server-start.sh config/server.properties > kafka.log 2>&1 &` 把服务放到后台运行 [2]。运行状态用 `ps -ef | grep kafka` 查看，停止服务则调用 `bin/kafka-server-stop.sh` 脚本 [2]。

管理端可以选用开源的 provectus kafka-ui：用 `java -jar` 启动其 jar 包，通过 `--spring.config.additional-location=application.yml` 指定外部配置 [2]。

测试环境的实际部署记录显示，Kafka 与 Kafka UI 都装在 192.168.66.70 上，运行用户为 tradesched，目录分别是 /home/tradesched/download/kafka_2.13-4.1.0 和 /home/tradesched/download/kafka-ui；Kafka 的监听配置为 PLAINTEXT 9092 与 CONTROLLER 9093，Kafka UI 占用 8080 端口 [3]。生产环境的部署信息在表中留空，尚未补充 [3]。

> 体现的价值：不只给通用步骤，还把知识库里的真实部署 IP/端口/用户名带出来——这是 RAG 区别于通用模型的关键。

---

### B.6 「能力清单」类——多源拼接

> **问：智能机器人 能做什么**

**检索**：`微信机器人.md` + `企业微信接口.md` + `agent.md` + `智能机器人项目.md`，`phrase-hit`（「智能机器人」整词命中）。

**答**：智能机器人目前能接收并处理用户在企业微信里的多种交互消息：群聊中@机器人或单聊中的文本、图文混排、引用消息，以及单聊中的图片、语音和本地文件消息 [6][1]。用户与机器人交互时，企业微信会把相关消息或事件推送到开发者设置的回调 URL，开发者可以据此被动回复；回调中还会返回 response_url，开发者可先按事件类型作出响应，待业务逻辑处理完后再通过该地址主动调用接口发送消息 [1]。

在业务能力层面，相关智能员工方向是替代日常重复性工作：AI 能关注公司各业务支持群的问题列表与解决情况，定时给出总结；可辅助检索和回答 TD 知识库中的常见问题；agent 还集成一些运维、日常管理功能供内部使用 [8]。对应 agent 的功能包括传入微信群消息列表做总结、知识库查询，以及系统上下线、更新、启动关闭、重启、机器信息查询、业务系统运维命令、配置管理等运维管理操作 [3]。用户可以通过企业微信的 ibot 机器人接入，ibot 后台服务通过 FastAPI 接口接入 agent 服务 [3]。

> 体现的契约：能力清单逐条标来源 [1][3][6][8]，不笼统合并。

---

### B.7 兜底模式（无据时）

> **问：量子纠缠的基本原理是什么**（知识库无此主题）

**检索**：`hasEvidence=false`，`weak-match`。

**答**（琥珀色警示条「未检索到依据 · 模型兜底」+ 开头声明）：

> 知识库中没有找到相关内容，以下回答来自模型自身知识，未经知识库验证，请谨慎参考。
>
> 量子纠缠的基本原理可以概括为：两个或多个量子系统在特定条件下形成一种整体状态……这种关联的关键在于它不能用于超光速传递信息……纠缠也不意味着粒子之间有一条"隐形连线"在传力……

> 体现的契约：三重标识不伪装成有据——开头声明句 + 全程无 [n] 引用 + UI 琥珀色警示。关掉「无据兜底」开关则回到纯拒答页。

