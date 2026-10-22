/* ============================================================
   shared/types.ts —— 前后端共用的 DTO 类型
   ============================================================ */

/** 单个切片的定位元数据（引用定位契约：行号 + 字符偏移） */
export interface ChunkMeta {
  index: number;
  docId: string;
  docName: string;
  section: string;
  startLine: number;
  endLine: number;
  startChar: number;
  endChar: number;
  text: string;
  summary: string | null;
  summaryAt: number | null;
  source: string;
  addedAt: number;
}

/** 文档元信息（列表用，不含全文） */
export interface DocMeta {
  docId: string;
  name: string;
  source: string;
  size: number;          // trim 后的字符数（与旧版 KB.add 定义一致）
  addedAt: number;
  chunkCount: number;
  distilled: number;     // 已蒸馏块数
}

/** 文档详情（原文查看器用，含全文） */
export interface DocDetail extends DocMeta {
  text: string;
}

/** 检索命中一条 */
export interface Hit {
  chunkId: string;
  docId: string;
  docName: string;
  section: string;
  startLine: number;
  endLine: number;
  startChar: number;
  endChar: number;
  text: string;
  summary: string | null;
  /** 融合分（内部排序用） */
  fused: number;
  /** 展示用归一化相关度 0-1 */
  rel: number;
  /** 词法通道信息（仅 BM25 命中时存在） */
  lex?: {
    score: number;
    matchedTerms: string[];
    matchCount: number;
    rarity: number;
    phraseHit: number;
  };
  /** 向量通道相似度（仅向量命中时存在） */
  sim?: number;
  /** 命中块在文档内的序号（small-to-big 父块合并用，不进 UI） */
  chunkIndex?: number;
  /** 父块上下文：命中的子块在原文里上下各扩 1 块合并的文本（small-to-big 检索）。
   *  仅为喂 LLM 提供更完整上下文，UI/引用定位仍用上面的 startLine/endLine。 */
  parentText?: string;
}

/** POST /api/kb/search 的完整返回 */
export interface SearchResult {
  hits: Hit[];
  /** 低分候选（拒答时 UI 仍展示「相关度较低」列表） */
  allScored: Hit[];
  hasEvidence: boolean;
  reason: string;
  coverage: number;
  matchCount: number;
  termHits: number;
  rarity: number;
  phraseHit: number;
  topScore: number;
  /** 向量通道 top 相似度；向量通道关闭时为 0 */
  topSim: number;
  terms: string[];
  searchMs: number;
  /** 事实直查：命中极强（phraseHit 且回答就在片段里）时为 true；
   *  前端跳过 LLM 直接展示片段，零幻觉零延迟。 */
  directAnswer?: boolean;
}

/** 知识库分组（用于检索时按范围收窄）。由 docName 前缀或手动 tag 派生。 */
export interface KbGroup {
  key: string;
  label: string;
  count: number;
}

export interface SsoConfig {
  /** SSO 是否可用（服务端配置了 OIDC_ISSUER/CLIENT_ID/SECRET） */
  enabled: boolean;
  /** 是否强制鉴权：未登录访问受保护 API → 401/跳登录 */
  required: boolean;
  /** IdP 显示名（如 "SSO登录"），登录按钮文案 */
  providerName: string;
  /** 登录入口：浏览器 GET 此地址即跳 Keycloak authorize */
  loginUrl: string;
  /** 本地账号注册/密码登录是否启用（配了 OIDC_JWT_SECRET） */
  localEnabled: boolean;
  /** 开放注册：localEnabled 即开 */
  registrationEnabled: boolean;
}

export interface ConfigResp {
  ready: boolean;
  baseUrlHost: string;
  model: string;
  confluence: boolean;
  embed: boolean;
  /** 联网搜索兜底是否可用（服务端配置了 SEARXNG_URL 才为 true） */
  webSearch: boolean;
  /** 清空功能是否启用（服务端配置了 ADMIN_TOKEN 才为 true） */
  clearEnabled: boolean;
  /** SSO/OIDC 鉴权配置（绝不下发 secret，仅下发登录入口与开关） */
  sso: SsoConfig;
}

/** POST /api/web-search 返回的联网命中条目（SearXNG 摘要 + Firecrawl 正文抓取） */
export interface WebHit {
  title: string;
  url: string;
  /** 摘要或抓取正文（有正文时为 firecrawl markdown，否则 SearXNG 摘要） */
  content: string;
  /** 是否成功抓取了页面正文（firecrawl）；false 表示仅有 SearXNG 摘要 */
  scraped?: boolean;
}

export interface WebSearchResult {
  hits: WebHit[];
  unresponsiveEngines: string[];
  empty: boolean;
}

export interface ImportResult {
  docId: string;
  chunkCount: number;
  chars: number;
  /** 切块原始数据（供 BM25 增量索引用；客户端忽略） */
  chunks?: { id: string; docName: string; section: string; startLine: number; endLine: number; startChar: number; endChar: number; text: string }[];
}

export interface BulkImportResult {
  added: number;
  failed: { name: string; reason: string }[];
}

export interface KbStats {
  docCount: number;
  totalChars: number;
  totalChunks: number;
  distilled: number;
  bySource: Record<string, { count: number; chars: number; chunks: number }>;
}

/** Confluence 单页返回 */
export interface ConfluencePage {
  pageId: string;
  title: string;
  space: string;
  url: string;
  text: string;
}

/** Confluence 子树返回 */
export interface ConfluenceTree {
  pages: { name: string; title: string; pageId: string; url: string; text: string }[];
  skipped: { name: string; reason: string }[];
  truncated: boolean;
}

export type DocSource = 'file' | 'paste' | 'confluence' | 'seed' | 'test';

export const SOURCE_LABELS: Record<string, string> = {
  file: '文件/目录',
  paste: '粘贴',
  seed: '示例',
  confluence: 'Confluence',
  test: '测试',
};
