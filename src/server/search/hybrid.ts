/* ============================================================
   server/search/hybrid.ts —— 混合检索：BM25 + 向量 RRF 融合 + 向量证据门
   ============================================================ */
import { ENV, embedReady } from '../env.js';
import { embed } from '../embeddings.js';
import { searchPoints } from '../qdrant.js';
import { COLLECTION_CHUNKS } from '../kbStore.js';
import type { Retriever, LexHit, LexResult } from './retriever.js';
import type { Hit, SearchResult } from '@shared/types.js';

const RRF_K = 60;   // Reciprocal Rank Fusion 常数

/** 向量门阈值（sensitivity 0-100 线性松弛） */
function vecThreshold(sensitivity: number): number {
  const s = sensitivity / 100;
  return 0.62 - s * 0.15;   // 0.62 → 0.47
}

export interface HybridHit extends Hit {}

export async function hybridSearch(
  question: string,
  retriever: Retriever,
  opts: { topK?: number; sensitivity?: number },
): Promise<SearchResult> {
  const topK = opts.topK || 8;
  const sensitivity = typeof opts.sensitivity === 'number' ? opts.sensitivity : 50;
  const started = Date.now();

  // ---- 词法通道 ----
  const lex: LexResult = retriever.search(question, { topK, sensitivity });

  // ---- 向量通道 ----
  let vecHits: { chunkId: string; sim: number; payload: any }[] = [];
  let topSim = 0;
  if (embedReady() && ENV.EMBED_VECTOR_GATE) {
    try {
      const [vec] = await embed([question]);
      const results = await searchPoints(COLLECTION_CHUNKS, vec!, Math.max(topK * 3, 16));
      vecHits = results.map((r) => ({ chunkId: r.id, sim: r.score, payload: r.payload }));
      topSim = vecHits.length ? vecHits[0]!.sim : 0;
    } catch (err) {
      // 向量挂掉降级 BM25-only
      console.warn(`[向量] 检索失败，降级 BM25：${(err as Error)?.message || err}`);
    }
  }

  // ---- 证据门：词法门 OR 向量门 ----
  const lexGate = lex.hasEvidence;
  const vecGate = topSim >= vecThreshold(sensitivity);
  const hasEvidence = lexGate || vecGate;
  const reason = lexGate ? lex.reason : (vecGate ? 'vector-sim' : lex.reason);

  // ---- RRF 融合（仅用于排序与 kept 截取）----
  const lexPool = lex.allScored.slice(0, Math.max(topK * 4, 16));
  const vecPool = vecHits.slice(0, Math.max(topK * 3, 16));

  const fusedMap = new Map<string, { lex?: LexHit; sim?: number; chunkId: string; payload?: any }>();

  lexPool.forEach((h, i) => {
    const id = h.chunk.chunkId;
    fusedMap.set(id, { ...(fusedMap.get(id) || { chunkId: id }), lex: h });
    void i;
  });
  vecPool.forEach((h, i) => {
    const id = h.chunkId;
    fusedMap.set(id, { ...(fusedMap.get(id) || { chunkId: id }), sim: h.sim, payload: h.payload });
    void i;
  });

  const lexRank = new Map<string, number>();
  lexPool.forEach((h, i) => lexRank.set(h.chunk.chunkId, i + 1));
  const vecRank = new Map<string, number>();
  vecPool.forEach((h, i) => vecRank.set(h.chunkId, i + 1));

  const all: Hit[] = [];
  for (const [id, e] of fusedMap) {
    let f = 0;
    if (lexRank.has(id)) f += 1 / (RRF_K + (lexRank.get(id) || 0));
    if (vecRank.has(id)) f += 1 / (RRF_K + (vecRank.get(id) || 0));
    const lexPayload = e.lex?.chunk;
    const vecPayload = e.payload;
    // 定位元数据：优先向量通道的完整 payload；词法通道的 chunk 也带透传字段
    const src = vecPayload || lexPayload;
    if (!src) continue;
    all.push({
      chunkId: id,
      docId: (src.docId as string) || (lexPayload?.docId ?? ''),
      docName: (src.docName as string) || (lexPayload?.docName ?? ''),
      section: (src.section as string) || (lexPayload?.section ?? ''),
      startLine: (src.startLine as number) || (lexPayload?.startLine ?? 0),
      endLine: (src.endLine as number) || (lexPayload?.endLine ?? 0),
      startChar: (src.startChar as number) || (lexPayload?.startChar ?? 0),
      endChar: (src.endChar as number) || (lexPayload?.endChar ?? 0),
      text: (src.text as string) || lexPayload?.text || '',
      summary: (src.summary as string | null) ?? lexPayload?.summary ?? null,
      fused: Number(f.toFixed(4)),
      rel: 0,
      lex: e.lex ? {
        score: e.lex.score,
        matchedTerms: e.lex.matchedTerms,
        matchCount: e.lex.matchCount,
        rarity: e.lex.rarity,
        phraseHit: e.lex.phraseHit,
      } : undefined,
      sim: e.sim,
    });
  }
  all.sort((a, b) => b.fused - a.fused);
  const maxFused = all.length ? all[0]!.fused : 1;
  for (const h of all) h.rel = Number((h.fused / maxFused).toFixed(3));

  // kept：有证据时按融合排序取前 topK；无证据时为空
  let kept: Hit[] = [];
  if (hasEvidence) {
    kept = all.filter((h) => {
      // 至少在某一通道有非零分
      const lexOk = h.lex ? h.lex.score > 0 : false;
      const vecOk = h.sim !== undefined && h.sim >= Math.max(0.4, vecThreshold(sensitivity) - 0.05);
      return lexOk || vecOk;
    }).slice(0, topK);
  }

  return {
    hits: kept,
    allScored: all.slice(0, topK),
    hasEvidence,
    reason,
    coverage: lex.coverage,
    matchCount: lex.matchCount,
    termHits: lex.termHits,
    rarity: lex.rarity,
    phraseHit: lex.phraseHit,
    topScore: lex.topScore,
    topSim: Number(topSim.toFixed(3)),
    terms: lex.terms,
    searchMs: Date.now() - started,
  };
}
