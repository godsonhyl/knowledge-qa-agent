/* ============================================================
   server/rerank.ts —— Cross-encoder 精排（提升 top-K 精度）
   RRF 融合后取 top-N（默认 20）候选 → 调 /v1/rerank 逐对打分 →
   按 relevance_score 重排 → 截 top-K。
   失败/超时静默沿用 RRF 排序（不阻塞主路径）。

   v2.9 增 rerank 结果缓存（A2）：
   - 重新生成同一问题会重跑 rerank（一次网关调用）。
   - 按 (query, sorted chunkIds, topK) 缓存排序后的 chunkId 顺序 + rel，
     TTL 5min；命中后用当前 hits 重新组装（text 变了也按旧顺序排，
     5min 内通常不会 distill 同一文档；distill 时主动清缓存兜底）。
   ============================================================ */
import { ENV, rerankReady } from './env.js';
import { createHash } from 'node:crypto';
import type { Hit } from '@shared/types.js';

export interface RerankResult {
  index: number;
  relevance_score: number;
}

/** rerank 结果缓存条目：存排序后的 chunkId 顺序 + 归一化 rel，不存 text（text 可能变） */
interface CacheEntry {
  /** 按 rerank 排序后的 chunkId 列表（截到 topK） */
  order: string[];
  /** 对应的归一化 rel（与 order 一一对应） */
  rels: number[];
  ts: number;
}

const RERANK_CACHE_TTL_MS = 5 * 60 * 1000;   // 5 分钟
const rerankCache = new Map<string, CacheEntry>();
/** 缓存上限（避免内存膨胀；LRU 粗近似——超过就整体清） */
const RERANK_CACHE_MAX = 200;

function cacheKey(query: string, chunkIds: string[], topK: number): string {
  const h = createHash('sha256');
  h.update(query);
  h.update('||');
  h.update(chunkIds.slice().sort().join(','));
  h.update('||');
  h.update(String(topK));
  return h.digest('hex').slice(0, 16);
}

/** distill / 导入 / 删除文档后调用，清掉所有 rerank 缓存（排序可能失效） */
export function invalidateRerankCache(): void {
  rerankCache.clear();
}

/** 调网关 /v1/rerank 对 (query, documents) 逐对打分。
 *  网关需支持 Cohere/TEI/vLLM 兼容的 rerank 端点。
 *  返回按 relevance_score 降序的 {index, score} 列表；失败返回 null。 */
export async function rerank(
  query: string,
  documents: string[],
  opts: { topN?: number } = {},
): Promise<RerankResult[] | null> {
  if (!rerankReady() || !documents.length) return null;
  const base = (ENV.EMBED_BASE_URL || ENV.LLM_BASE_URL).replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ENV.RERANK_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/rerank`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(ENV.EMBED_API_KEY ? { Authorization: `Bearer ${ENV.EMBED_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: ENV.RERANK_MODEL,
        query,
        documents,
        top_n: opts.topN ?? documents.length,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data: any = await res.json().catch(() => null);
    const results: any[] = Array.isArray(data?.results) ? data.results : [];
    return results.map((r) => ({
      index: Number(r?.index ?? r?.document?.index ?? 0),
      relevance_score: Number(r?.relevance_score ?? r?.score ?? 0),
    }));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 对 hits 做 rerank 精排，返回重排后的 top-K。
 *  - 取 hits 文本字段（正文优先，蒸馏知识点作补充）作为 documents
 *  - rerank 失败 → 原样返回（RRF 排序不退化）
 *  - 命中数 ≤ topK 时不调（本就够少，不必再排）
 *  - 缓存：5min 内同 (query, chunkIds, topK) 命中复用上次排序结果，
 *    重新生成同问题从 ~3s 降到 <10ms；缓存只存 chunkId 顺序 + rel，不存 text。 */
export async function rerankHits(
  query: string,
  hits: Hit[],
  topK: number,
): Promise<{ hits: Hit[]; reranked: boolean }> {
  if (hits.length <= topK || hits.length < 2) {
    return { hits, reranked: false };
  }

  // ---- 缓存命中检查 ----
  const chunkIds = hits.map((h) => h.chunkId);
  const key = cacheKey(query, chunkIds, topK);
  const cached = rerankCache.get(key);
  if (cached && Date.now() - cached.ts < RERANK_CACHE_TTL_MS) {
    // 缓存有效：按缓存的 chunkId 顺序重组当前 hits（text 可能已变，但顺序沿用）
    const byId = new Map(hits.map((h) => [h.chunkId, h]));
    const ordered: Hit[] = [];
    for (let i = 0; i < cached.order.length && i < topK; i++) {
      const h = byId.get(cached.order[i]!);
      if (h) {
        h.rel = cached.rels[i] ?? h.rel;
        ordered.push(h);
      }
    }
    // 缓存里的 chunk 可能在 hits 里找不全（被删了）——补上剩余的
    if (ordered.length < topK) {
      const used = new Set(ordered.map((h) => h.chunkId));
      for (const h of hits) {
        if (ordered.length >= topK) break;
        if (!used.has(h.chunkId)) ordered.push(h);
      }
    }
    return { hits: ordered, reranked: true };
  }

  // documents 取正文（截断避免超长）；正文空则用 docName+section
  const docs = hits.map((h) => {
    const t = (h.text || '').slice(0, 500);
    if (t) return t;
    return [h.docName, h.section].filter(Boolean).join(' ').slice(0, 200);
  });
  const ranked = await rerank(query, docs, { topN: hits.length });
  if (!ranked || !ranked.length) return { hits, reranked: false };
  // 按 relevance_score 降序重排 hits
  const byIdx = new Map<number, number>();
  ranked.forEach((r) => byIdx.set(r.index, r.relevance_score));
  const sorted = hits
    .map((h, i) => ({ h, s: byIdx.get(i) ?? 0 }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.h)
    .slice(0, topK);
  // rel 字段更新为 rerank 分数（归一化到 0-1，便于 UI 展示）
  const maxS = sorted.length ? (byIdx.get(hits.indexOf(sorted[0]!)) ?? 1) : 1;
  const rels: number[] = [];
  sorted.forEach((h, i) => {
    const idx = hits.indexOf(h);
    const s = byIdx.get(idx) ?? 0;
    h.rel = maxS > 0 ? Number((s / maxS).toFixed(3)) : h.rel;
    rels.push(h.rel);
    void i;
  });

  // ---- 写入缓存 ----
  if (rerankCache.size >= RERANK_CACHE_MAX) rerankCache.clear();
  rerankCache.set(key, {
    order: sorted.map((h) => h.chunkId),
    rels,
    ts: Date.now(),
  });

  return { hits: sorted, reranked: true };
}
