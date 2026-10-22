/* ============================================================
   server/env.ts —— 类型化环境变量
   ============================================================ */
import { createHash } from 'node:crypto';

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined) return def;
  return v === '1' || v === 'true' || v === 'yes';
}
function int(v: string | undefined, def: number): number {
  const n = parseInt(v || '', 10);
  return Number.isFinite(n) ? n : def;
}

export interface Env {
  PORT: number;
  HOST: string;
  HTTPS_PORT: number;
  GEN_CERT: boolean;

  LLM_BASE_URL: string;
  LLM_API_KEY: string;
  LLM_MODEL: string;

  EMBED_BASE_URL: string;
  EMBED_API_KEY: string;
  EMBED_MODEL: string;
  EMBED_DIM: number;
  EMBED_VECTOR_GATE: boolean;   // 向量证据门开关（校准不过先关）

  /** Reranker 模型（cross-encoder 精排，提升 top-K 精度）。
   *  网关需支持 /v1/rerank（Cohere/TEI/vLLM 兼容）。
   *  留空 → 不启用 rerank，沿用 RRF 排序。 */
  RERANK_MODEL: string;
  /** Rerank 超时（ms），默认 4s */
  RERANK_TIMEOUT_MS: number;

  QDRANT_URL: string;
  COLLECTION_CHUNKS: string;
  COLLECTION_DOCS: string;
  /** 对话历史 collection（默认 kqa_conversations） */
  COLLECTION_CONVS: string;

  CONFLUENCE_BASE_URL: string;
  CONFLUENCE_PAT: string;
  CONFLUENCE_INSECURE_TLS: boolean;
  CONFLUENCE_MAX_PAGES: number;

  /** 联网搜索兜底：自托管 SearXNG 地址（如 http://pypi.jinde.local/searxng）。
   *  未设置 → 拒答页不显示「联网搜索」按钮、API 503。 */
  SEARXNG_URL: string;

  /** 清空知识库的管理员令牌。未设置 → 清空功能完全禁用（按钮隐藏、API 403）。
   *  设置后请求需带 X-Admin-Token 头（UI 侧有登录入口）。 */
  ADMIN_TOKEN: string;
}

export const ENV: Env = {
  PORT: int(process.env.PORT, 3000),
  HOST: process.env.HOST || '0.0.0.0',
  HTTPS_PORT: int(process.env.HTTPS_PORT, 3443),
  GEN_CERT: bool(process.env.GEN_CERT, false),

  LLM_BASE_URL: (process.env.LLM_BASE_URL || '').replace(/\/+$/, ''),
  LLM_API_KEY: process.env.LLM_API_KEY || '',
  LLM_MODEL: process.env.LLM_MODEL || '',

  EMBED_BASE_URL: (process.env.EMBED_BASE_URL || '').replace(/\/+$/, ''),
  EMBED_API_KEY: process.env.EMBED_API_KEY || process.env.LLM_API_KEY || '',
  EMBED_MODEL: process.env.EMBED_MODEL || 'BAAI/bge-m3',
  EMBED_DIM: int(process.env.EMBED_DIM, 1024),
  EMBED_VECTOR_GATE: bool(process.env.EMBED_VECTOR_GATE, true),

  RERANK_MODEL: process.env.RERANK_MODEL || '',
  RERANK_TIMEOUT_MS: int(process.env.RERANK_TIMEOUT_MS, 4000),

  QDRANT_URL: (process.env.QDRANT_URL || 'http://qdrant:6333').replace(/\/+$/, ''),
  COLLECTION_CHUNKS: process.env.COLLECTION_CHUNKS || 'kqa_chunks',
  COLLECTION_DOCS: process.env.COLLECTION_DOCS || 'kqa_docs',
  COLLECTION_CONVS: process.env.COLLECTION_CONVS || 'kqa_conversations',

  CONFLUENCE_BASE_URL: (process.env.CONFLUENCE_BASE_URL || '').replace(/\/+$/, ''),
  CONFLUENCE_PAT: process.env.CONFLUENCE_PAT || '',
  CONFLUENCE_INSECURE_TLS: bool(process.env.CONFLUENCE_INSECURE_TLS, false),
  CONFLUENCE_MAX_PAGES: int(process.env.CONFLUENCE_MAX_PAGES, 200),

  SEARXNG_URL: (process.env.SEARXNG_URL || '').replace(/\/+$/, ''),

  ADMIN_TOKEN: process.env.ADMIN_TOKEN || '',
};

export function llmReady(): boolean {
  return Boolean(ENV.LLM_BASE_URL && ENV.LLM_API_KEY && ENV.LLM_MODEL);
}
export function embedReady(): boolean {
  return Boolean(ENV.EMBED_BASE_URL && ENV.EMBED_MODEL);
}
export function confluenceReady(): boolean {
  return Boolean(ENV.CONFLUENCE_BASE_URL && ENV.CONFLUENCE_PAT);
}
export function webSearchReady(): boolean {
  return Boolean(ENV.SEARXNG_URL);
}
export function rerankReady(): boolean {
  return Boolean(ENV.RERANK_MODEL && ENV.EMBED_BASE_URL);
}

export function safeHost(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return '';
  }
}

/** POST /api/config 的安全下发（绝不包含任何 key） */
export function configResp() {
  return {
    ready: llmReady(),
    baseUrlHost: ENV.LLM_BASE_URL ? safeHost(ENV.LLM_BASE_URL) : '',
    model: ENV.LLM_MODEL,
    confluence: confluenceReady(),
    embed: embedReady(),
    /** 联网搜索兜底是否可用（服务端配置了 SEARXNG_URL） */
    webSearch: webSearchReady(),
    /** 清空功能是否启用：只有配置了 ADMIN_TOKEN 才允许 */
    clearEnabled: Boolean(ENV.ADMIN_TOKEN),
  };
}

// 防未使用告警
void createHash;
