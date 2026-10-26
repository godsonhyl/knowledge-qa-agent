/* ============================================================
   server/routes/search.ts —— POST /api/kb/search
   ============================================================ */
import { Hono } from 'hono';
import { kbIndex } from '../kbIndex.js';
import { hybridSearch } from '../search/hybrid.js';
import { rewriteQuery } from '../queryRewrite.js';
import { classifyQuestion, mergeHits } from '../multiStep.js';
import { isMarketQuery, tryMarketDirect } from '../marketData.js';
import { recordSearch } from './metrics.js';
import type { SearchResult, SearchTrace } from '@shared/types.js';

export const searchRoute = new Hono();

searchRoute.post('/search', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) return c.json({ error: 'question 不能为空' }, 400);
  const topK = Math.min(12, Math.max(1, Number(body.topK) || 5));
  const sensitivity = Math.min(100, Math.max(0, Number(body.sensitivity) || 50));
  // 知识库分组（可选）：按 docName 前缀或 source 收窄检索
  const docNamePrefix = typeof body.docNamePrefix === 'string' && body.docNamePrefix ? body.docNamePrefix : null;
  const source = typeof body.source === 'string' && body.source ? body.source : null;
  const started = Date.now();

  // ---- 行情数据直查通道（检索前优先判定；命中则跳过知识库检索）----
  if (isMarketQuery(question)) {
    const md = await tryMarketDirect(question).catch(() => null);
    if (md) {
      const r: SearchResult = {
        hits: [], allScored: [], hasEvidence: true, reason: 'market-data',
        coverage: 1, matchCount: 1, termHits: 1, rarity: 1, phraseHit: 1, topScore: 100,
        topSim: 0, terms: [], searchMs: Date.now() - started,
        directAnswer: true,
        trace: {
          question, variants: [question], lexHitCount: 0, vecHitCount: 0,
          rerankedCount: 0, directAnswer: true, gate: { lex: true, vec: false },
          reason: 'market-data', channel: 'market-data', searchMs: Date.now() - started,
        },
      };
      // 行情直查的文本放在 hits[0].text（前端直查分支取 top.text）
      r.hits = [{ chunkId: 'market', docId: 'market', docName: '行情直查', section: md.name,
        startLine: 0, endLine: 0, startChar: 0, endChar: 0,
        text: md.text, summary: null, fused: 100, rel: 1 }];
      recordSearch(r.searchMs, true, 'market-data', 'market-data');
      return c.json(r);
    }
    // 行情问题但接口失败 → 继续走知识库（可能知识库里有相关文档）
  }

  // 查询改写：LLM 把问题扩展为多个同义/术语规范化变体；多路检索后用 RRF 二次融合。
  // 失败/超时静默降级为原问题单路检索（不影响主路径可用性）。
  const rewriteStart = Date.now();
  const variants = await rewriteQuery(question, { sensitivity }).catch(() => [question]);
  const rewriteMs = Date.now() - rewriteStart;

  // 复杂问题多步检索：LLM 判定复合问题 → 拆子问题 → 各自 hybridSearch → 合并。
  // 简单问题走 fast path（无额外 LLM 调用）；复合问题额外一次 LLM 调用（2.5s 超时）。
  const classifyStart = Date.now();
  const classification = await classifyQuestion(question).catch(() => ({ complex: false, subQuestions: [] as string[] }));
  const classifyMs = Date.now() - classifyStart;

  let r: SearchResult;
  let hybridTrace: { lexHitCount: number; vecHitCount: number; rerankedCount: number; gate: { lex: boolean; vec: boolean }; rerankMs: number } | null = null;
  if (classification.complex && classification.subQuestions.length >= 2) {
    // 子问题各自检索（带同样的分组过滤 + 改写），合并去重
    const subResults: SearchResult[] = [];
    for (const sq of classification.subQuestions) {
      const sv = await rewriteQuery(sq, { sensitivity }).catch(() => [sq]);
      const sr = await kbIndex.run(() => hybridSearch(sq, kbIndex.retriever, {
        topK, sensitivity, variants: sv, docNamePrefix, source,
      }));
      subResults.push(sr);
    }
    // 合并：把原问题的检索结果也并入（兜底），保证不漏
    const primary = await kbIndex.run(() => hybridSearch(question, kbIndex.retriever, {
      topK, sensitivity, variants, docNamePrefix, source,
    }));
    hybridTrace = (primary as any)._trace;
    subResults.push(primary);
    const merged = mergeHits(subResults);
    r = {
      hits: merged.hits.slice(0, topK),
      allScored: merged.hits.slice(0, topK),
      hasEvidence: primary.hasEvidence,
      reason: primary.reason,
      coverage: primary.coverage,
      matchCount: primary.matchCount,
      termHits: primary.termHits,
      rarity: primary.rarity,
      phraseHit: primary.phraseHit,
      topScore: primary.topScore,
      topSim: primary.topSim,
      terms: primary.terms,
      searchMs: 0, // 后面会替换为累计耗时
      directAnswer: false, // 复杂问题不走直查
    };
    r.searchMs = Date.now() - started;
  } else {
    const hr = await kbIndex.run(() => hybridSearch(question, kbIndex.retriever, {
      topK, sensitivity, variants, docNamePrefix, source,
    }));
    hybridTrace = (hr as any)._trace;
    r = hr;
  }

  // 组装检索链路追踪
  r.trace = {
    question,
    variants,
    classification: classification.complex ? { complex: true, subQuestions: classification.subQuestions } : undefined,
    lexHitCount: hybridTrace?.lexHitCount ?? 0,
    vecHitCount: hybridTrace?.vecHitCount ?? 0,
    rerankedCount: hybridTrace?.rerankedCount ?? 0,
    directAnswer: !!r.directAnswer,
    gate: hybridTrace?.gate ?? { lex: r.hasEvidence, vec: false },
    reason: r.reason,
    channel: 'kb',
    searchMs: r.searchMs,
    rewriteMs,
    classifyMs,
    rerankMs: hybridTrace?.rerankMs,
  };

  recordSearch(r.searchMs, r.hasEvidence, r.reason, r.trace?.channel);
  return c.json(r);
});
