/* ============================================================
   server/routes/search.ts —— POST /api/kb/search
   ============================================================ */
import { Hono } from 'hono';
import { kbIndex } from '../kbIndex.js';
import { hybridSearch } from '../search/hybrid.js';

export const searchRoute = new Hono();

searchRoute.post('/search', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) return c.json({ error: 'question 不能为空' }, 400);
  const topK = Math.min(12, Math.max(1, Number(body.topK) || 5));
  const sensitivity = Math.min(100, Math.max(0, Number(body.sensitivity) || 50));

  const r = await kbIndex.run(() => hybridSearch(question, kbIndex.retriever, { topK, sensitivity }));
  return c.json(r);
});
