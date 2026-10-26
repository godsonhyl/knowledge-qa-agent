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
  /** 定时备份间隔（ms，默认 24h）；设 0 关闭 */
  BACKUP_INTERVAL_MS: number;

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
  /** 联网搜索正文抓取：自托管 Firecrawl 地址（如 http://pypi.jinde.local/firecrawl）。
   *  可选——设置后对搜索命中 Top-N 二次抓取页面正文，喂给 LLM 的不再只是摘要。 */
  FIRECRAWL_URL: string;

  /** 清空知识库的管理员令牌。未设置 → 清空功能完全禁用（按钮隐藏、API 403）。
   *  设置后请求需带 X-Admin-Token 头（UI 侧有登录入口）。 */
  ADMIN_TOKEN: string;

  /** ---- SSO/OIDC 鉴权（Keycloak 等兼容 IdP，Authorization Code + PKCE）----
   *  配齐 ISSUER/CLIENT_ID/CLIENT_SECRET 才启用；OIDC_REQUIRED=1 时未登录访问受保护 API → 401/跳登录。
   *  未配置 → 行为同现状（所有 API 免鉴权），回归不退化。 */
  OIDC_ISSUER: string;
  OIDC_CLIENT_ID: string;
  OIDC_CLIENT_SECRET: string;
  OIDC_REDIRECT_URI: string;
  OIDC_SCOPE: string;
  /** 1 = 强制鉴权（全部需登录）；0 = 可选（登录入口可见但不强制）。默认 0 */
  OIDC_REQUIRED: boolean;
  /** 本地账号模式 HMAC 密钥（HS256 JWT 签发/校验）。配了才启用本地注册/登录。
   *  与 OIDC_* 互不依赖：可只配此项（纯本地账号）、只配 OIDC_*（纯 SSO）、或都配（双模式）。 */
  OIDC_JWT_SECRET: string;

  /** ---- 用户配额/限流（可选，OIDC_REQUIRED=1 时生效）----
   *  RATE_LIMIT_PER_HOUR：每用户每小时问答次数上限（默认 0=不限）。
   *  RATE_LIMIT_BURST：并发请求数上限（默认 0=不限）。
   *  进程内存级计数（重启归零），不依赖外部存储。 */
  RATE_LIMIT_PER_HOUR: number;
  RATE_LIMIT_BURST: number;
  /** 审计日志：是否记录用户操作（提问/删除/清空等）到 kqa_audit collection。默认 0=关 */
  AUDIT_LOG_ENABLED: boolean;
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
  BACKUP_INTERVAL_MS: int(process.env.BACKUP_INTERVAL_MS, 24 * 60 * 60 * 1000),

  QDRANT_URL: (process.env.QDRANT_URL || 'http://qdrant:6333').replace(/\/+$/, ''),
  COLLECTION_CHUNKS: process.env.COLLECTION_CHUNKS || 'kqa_chunks',
  COLLECTION_DOCS: process.env.COLLECTION_DOCS || 'kqa_docs',
  COLLECTION_CONVS: process.env.COLLECTION_CONVS || 'kqa_conversations',

  CONFLUENCE_BASE_URL: (process.env.CONFLUENCE_BASE_URL || '').replace(/\/+$/, ''),
  CONFLUENCE_PAT: process.env.CONFLUENCE_PAT || '',
  CONFLUENCE_INSECURE_TLS: bool(process.env.CONFLUENCE_INSECURE_TLS, false),
  CONFLUENCE_MAX_PAGES: int(process.env.CONFLUENCE_MAX_PAGES, 200),

  SEARXNG_URL: (process.env.SEARXNG_URL || '').replace(/\/+$/, ''),
  FIRECRAWL_URL: (process.env.FIRECRAWL_URL || '').replace(/\/+$/, ''),

  ADMIN_TOKEN: process.env.ADMIN_TOKEN || '',

  OIDC_ISSUER: (process.env.OIDC_ISSUER || '').replace(/\/+$/, ''),
  OIDC_CLIENT_ID: process.env.OIDC_CLIENT_ID || '',
  OIDC_CLIENT_SECRET: process.env.OIDC_CLIENT_SECRET || '',
  OIDC_REDIRECT_URI: (process.env.OIDC_REDIRECT_URI || '').replace(/\/+$/, ''),
  OIDC_SCOPE: process.env.OIDC_SCOPE || 'openid profile email',
  OIDC_REQUIRED: bool(process.env.OIDC_REQUIRED, false),
  OIDC_JWT_SECRET: process.env.OIDC_JWT_SECRET || '',

  RATE_LIMIT_PER_HOUR: int(process.env.RATE_LIMIT_PER_HOUR, 0),
  RATE_LIMIT_BURST: int(process.env.RATE_BURST || process.env.RATE_LIMIT_BURST, 0),
  AUDIT_LOG_ENABLED: bool(process.env.AUDIT_LOG_ENABLED, false),
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
export function oidcReady(): boolean {
  return Boolean(ENV.OIDC_ISSUER && ENV.OIDC_CLIENT_ID && ENV.OIDC_CLIENT_SECRET);
}
/** 本地账号模式：配了 OIDC_JWT_SECRET 才启用注册/密码登录 */
export function localAuthReady(): boolean {
  return Boolean(ENV.OIDC_JWT_SECRET);
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
    /** SSO/OIDC 鉴权配置（仅下发登录入口与开关，绝不下发 secret） */
    sso: {
      enabled: oidcReady(),
      required: (oidcReady() || localAuthReady()) && ENV.OIDC_REQUIRED,
      providerName: 'SSO 登录',
      loginUrl: '/api/auth/oidc/login',
      /** 本地账号注册/密码登录是否启用（配了 OIDC_JWT_SECRET） */
      localEnabled: localAuthReady(),
      /** 开放注册：localAuthReady() 即开 */
      registrationEnabled: localAuthReady(),
    },
  };
}

// 防未使用告警
void createHash;
