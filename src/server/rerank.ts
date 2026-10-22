/* ============================================================
   server/rerank.ts —— Cross-encoder 精排（提升 top-K 精度）
   RRF 融合后取 top-N（默认 20）候选 → 调 /v1/rerank 逐对打分 →
   按 relevance_score 重排 → 截 top-K。
   失败/超时静默沿用 RRF 排序（不阻塞主路径）。
   ============================================================ */
import { ENV, rerankReady } from './env.js';
import type { Hit } from '@shared/types.js';

export interface RerankResult {
  index: number;
  relevance_score: number;
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
 *  - 命中数 ≤ topK 时不调（本就够少，不必再排） */
export async function rerankHits(
  query: string,
  hits: Hit[],
  topK: number,
): Promise<{ hits: Hit[]; reranked: boolean }> {
  if (hits.length <= topK || hits.length < 2) {
    return { hits, reranked: false };
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
  sorted.forEach((h, i) => {
    const idx = hits.indexOf(h);
    const s = byIdx.get(idx) ?? 0;
    h.rel = maxS > 0 ? Number((s / maxS).toFixed(3)) : h.rel;
    void i;
  });
  return { hits: sorted, reranked: true };
}
