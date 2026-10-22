/* ============================================================
   server/routes/search.ts —— POST /api/kb/search
   ============================================================ */
import { Hono } from 'hono';
import { kbIndex } from '../kbIndex.js';
import { hybridSearch } from '../search/hybrid.js';
import { rewriteQuery } from '../queryRewrite.js';

export const searchRoute = new Hono();

searchRoute.post('/search', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) return c.json({ error: 'question 不能为空' }, 400);
  const topK = Math.min(12, Math.max(1, Number(body.topK) || 5));
  const sensitivity = Math.min(100, Math.max(0, Number(body.sensitivity) || 50));

  // 查询改写：LLM 把问题扩展为多个同义/术语规范化变体；多路检索后用 RRF 二次融合。
  // 失败/超时静默降级为原问题单路检索（不影响主路径可用性）。
  const variants = await rewriteQuery(question, { sensitivity }).catch(() => [question]);

  const r = await kbIndex.run(() => hybridSearch(question, kbIndex.retriever, { topK, sensitivity, variants }));
  return c.json(r);
});
