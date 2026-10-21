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
