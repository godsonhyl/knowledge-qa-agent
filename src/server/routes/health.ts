/* ============================================================
   server/routes/health.ts —— GET /api/health
   依赖健康探针：分别探 Qdrant / LLM 网关 / 嵌入网关 / SearXNG / Firecrawl
   各自可达性（带 ms），运维排障时一眼定位是哪个依赖挂了。
   公开端点（免鉴权）——外部监控可直接打；不暴露任何 key。
   整体健康 = Qdrant 可达（其他降级不影响主链路可用性，标 ok=false 但不挂 503）。
   ============================================================ */
import { Hono } from 'hono';
import { ENV, llmReady, embedReady, webSearchReady, confluenceReady, rerankReady, oidcReady, localAuthReady } from '../env.js';
import { kbIndex } from '../kbIndex.js';

export const healthRoute = new Hono();

/** 单次探针超时（ms）；依赖慢响应也算不可达，避免探针自身拖死监控 */
const PROBE_TIMEOUT_MS = 3000;

export interface Probe {
  ok: boolean;
  ms: number;
  /** 不可达时的简短原因（"未配置" / "超时" / "HTTP 502" / "连接失败"）；可达则省略 */
  detail?: string;
}

/** 探一个 HTTP 端点：2xx/3xx/4xx 都算"可达"（4xx 常是鉴权问题但说明服务在），
 *  5xx 与连接失败/超时才算不可达。 */
async function probeHttp(url: string, headers?: Record<string, string>): Promise<Probe> {
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    const ok = res.status < 500;
    return { ok, ms: Date.now() - start, detail: ok ? undefined : `HTTP ${res.status}` };
  } catch (e) {
    const err = e as Error;
    return { ok: false, ms: Date.now() - start, detail: err.name === 'AbortError' ? '超时' : '连接失败' };
  } finally {
    clearTimeout(timer);
  }
}

/** 未配置的依赖统一占位（不算挂，只是没启用） */
function unconfigured(): Probe {
  return { ok: false, ms: 0, detail: '未配置' };
}

healthRoute.get('/', async (c) => {
  // 并行探针（互不阻塞，单个慢不拖累其他）
  const [qdrant, llm, embed, searxng, firecrawl] = await Promise.all([
    probeHttp(`${ENV.QDRANT_URL}/collections`),
    llmReady()
      ? probeHttp(`${ENV.LLM_BASE_URL}/models`, { Authorization: `Bearer ${ENV.LLM_API_KEY}` })
      : Promise.resolve(unconfigured()),
    embedReady()
      ? probeHttp(`${ENV.EMBED_BASE_URL}/models`, { Authorization: `Bearer ${ENV.EMBED_API_KEY}` })
      : Promise.resolve(unconfigured()),
    webSearchReady()
      ? probeHttp(`${ENV.SEARXNG_URL}/healthz`)
      : Promise.resolve(unconfigured()),
    ENV.FIRECRAWL_URL
      ? probeHttp(`${ENV.FIRECRAWL_URL}/`)
      : Promise.resolve(unconfigured()),
  ]);

  // 整体健康：Qdrant 是主链路依赖（检索/对话都靠它）；其他降级不影响主链路可用性
  const overall = qdrant.ok;

  return c.json({
    ok: overall,
    uptimeSec: Math.round(process.uptime()),
    deps: { qdrant, llm, embed, searxng, firecrawl },
    index: {
      chunkCount: kbIndex.chunkCount,
      ready: kbIndex.chunkCount > 0,
    },
    config: {
      llm: llmReady(),
      embed: embedReady(),
      confluence: confluenceReady(),
      webSearch: webSearchReady(),
      rerank: rerankReady(),
      oidc: oidcReady(),
      localAuth: localAuthReady(),
      oidcRequired: ENV.OIDC_REQUIRED,
    },
  }, overall ? 200 : 503);
});
