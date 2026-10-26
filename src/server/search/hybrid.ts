/* ============================================================
   server/search/hybrid.ts —— 混合检索：BM25 + 向量 RRF 融合 + 向量证据门
   ============================================================ */
import { ENV, embedReady } from '../env.js';
import { embed } from '../embeddings.js';
import { searchPoints, buildGroupFilter } from '../qdrant.js';
import { COLLECTION_CHUNKS } from '../kbStore.js';
import { rerankHits } from '../rerank.js';
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
  opts: { topK?: number; sensitivity?: number; variants?: string[]; docNamePrefix?: string | null; source?: string | null },
): Promise<SearchResult & { _trace: { lexHitCount: number; vecHitCount: number; rerankedCount: number; gate: { lex: boolean; vec: boolean }; rerankMs: number } }> {
  const topK = opts.topK || 8;
  const sensitivity = typeof opts.sensitivity === 'number' ? opts.sensitivity : 50;
  const variants = (opts.variants && opts.variants.length > 0) ? opts.variants : [question];
  const started = Date.now();

  // ---- 词法通道（多路：每个变体一次 BM25，rank 取最佳）----
  // 对每个变体单独跑 retriever.search，把各变体的 allScored 合并；
  // 保留每块在"任一变体下"的最佳 rank（用于 RRF 第二轮融合）。
  const lexPerVariant: LexResult[] = [];
  for (const v of variants) {
    lexPerVariant.push(retriever.search(v, { topK, sensitivity }));
  }
  // 主变体（原问题）的证据门判定为准——变体只扩召回，不放宽证据门
  const lex = lexPerVariant[0]!;

  // ---- 向量通道（带分组过滤时也按 filter 收窄）----
  let vecHits: { chunkId: string; sim: number; payload: any }[] = [];
  let topSim = 0;
  if (embedReady() && ENV.EMBED_VECTOR_GATE) {
    try {
      // 对原问题做向量检索（变体不重复嵌入，避免成本翻倍）
      const [vec] = await embed([question]);
      // 构造 Qdrant filter：按 docNamePrefix / source 收窄（知识库分组）
      const filter = buildGroupFilter(opts.docNamePrefix, opts.source);
      const results = await searchPoints(COLLECTION_CHUNKS, vec!, Math.max(topK * 3, 16), filter);
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

  // ---- RRF 融合（多路词法 + 向量，二次 RRF）----
  // 词法多路：每个变体的 allScored 都进池。若指定了分组（docNamePrefix/source），
  // 在 pool 阶段过滤掉不匹配的块（BM25 本身不支持 payload filter，这里在结果上裁剪）。
  const lexPool: LexHit[] = [];
  const lexBestRank = new Map<string, number>();
  lexPerVariant.forEach((lr) => {
    lr.allScored.slice(0, Math.max(topK * 4, 16)).forEach((h, i) => {
      // 分组过滤（BM25 后置裁剪）
      if (opts.docNamePrefix && !(h.chunk.docName || '').startsWith(opts.docNamePrefix)) return;
      if (opts.source && h.chunk.source !== opts.source) return;
      const id = h.chunk.chunkId;
      const r = i + 1;
      const prev = lexBestRank.get(id);
      if (prev === undefined || r < prev) {
        lexBestRank.set(id, r);
        if (!lexPool.some((p) => p.chunk.chunkId === id)) lexPool.push(h);
      }
    });
  });
  const vecPool = vecHits.slice(0, Math.max(topK * 3, 16));

  const fusedMap = new Map<string, { lex?: LexHit; sim?: number; chunkId: string; payload?: any }>();

  lexPool.forEach((h) => {
    const id = h.chunk.chunkId;
    fusedMap.set(id, { ...(fusedMap.get(id) || { chunkId: id }), lex: h });
  });
  vecPool.forEach((h) => {
    const id = h.chunkId;
    fusedMap.set(id, { ...(fusedMap.get(id) || { chunkId: id }), sim: h.sim, payload: h.payload });
  });

  // rank 用"最佳 rank"（多路融合后），不是单路原始位置
  const lexRank = lexBestRank;
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
      chunkIndex: (src.index as number) ?? (lexPayload?.index ?? -1),
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

  // kept：有证据时先取 top-N 候选（默认 max(topK*3, 20)），rerank 精排后截 topK
  let kept: Hit[] = [];
  let rerankMs = 0;
  if (hasEvidence) {
    const rerankPool = all.filter((h) => {
      // 至少在某一通道有非零分
      const lexOk = h.lex ? h.lex.score > 0 : false;
      const vecOk = h.sim !== undefined && h.sim >= Math.max(0.4, vecThreshold(sensitivity) - 0.05);
      return lexOk || vecOk;
    });
    const pool = rerankPool.slice(0, Math.max(topK * 3, 20));
    // rerank 精排（失败/未配置则退回 RRF 排序，截 topK）
    const rerankStart = Date.now();
    const { hits: reranked } = await rerankHits(question, pool, topK);
    rerankMs = Date.now() - rerankStart;
    kept = reranked;
    // 父块上下文（small-to-big）：取命中子块前后各 1 块合并文本，喂 LLM 用
    // 引用定位仍用子块 startLine/endLine（契约不动）
    if (kept.length) {
      const idx = retriever.index;
      if (idx) {
        for (const h of kept) {
          const ci = (h as any).chunkIndex;
          if (typeof ci === 'number' && ci >= 0) {
            h.parentText = idx.parentText(h.docId, ci, 1);
          }
        }
      }
    }
  }

  // ---- 事实直查：命中极强时标记 directAnswer，前端跳过 LLM 直接展示 ----
  // 保守条件：词法门 + phraseHit（整词强证据）+ topScore 很高 →
  // 答案就在片段里，无需 LLM 组织语言（零延迟零幻觉零成本）。
  const directAnswer = hasEvidence
    && lex.phraseHit >= 1
    && lex.topScore >= 18
    && !!kept.length;
  const result: SearchResult = {
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
    directAnswer,
  };
  // 附加追踪信息（不进 SearchResult 的对外 schema，供 search.ts 组装 trace 用）
  return Object.assign(result, {
    _trace: {
      lexHitCount: lex.hits.length,
      vecHitCount: vecHits.length,
      rerankedCount: kept.length,
      gate: { lex: lexGate, vec: vecGate },
      rerankMs: rerankMs,
    },
  });
}
