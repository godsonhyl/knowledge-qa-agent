/* ============================================================
   server/routes/feedback.ts —— POST /api/feedback（👍/👎）
   GET  /api/feedback?limit=   列最近反馈（调优用）
   POST /api/feedback          {question, answerExcerpt?, hitDocs?, feedback, mode?, convId?}
   ============================================================ */
import { Hono } from 'hono';
import { addFeedback, listFeedback, ensureFeedbackCollection } from '../feedback.js';

export const feedbackRoute = new Hono();

feedbackRoute.post('/', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.question !== 'string' || !body.question.trim()) {
    return c.json({ error: '需要 {question, feedback}' }, 400 as 400);
  }
  const feedback = body.feedback === 'up' ? 'up' : body.feedback === 'down' ? 'down' : null;
  if (!feedback) return c.json({ error: 'feedback 必须是 up 或 down' }, 400 as 400);

  try {
    await ensureFeedbackCollection();
    const id = await addFeedback({
      question: String(body.question).slice(0, 300),
      answerExcerpt: String(body.answerExcerpt || '').slice(0, 500),
      hitDocs: Array.isArray(body.hitDocs)
        ? body.hitDocs.slice(0, 5).map((d: unknown) => String(d).slice(0, 120))
        : [],
      feedback,
      mode: String(body.mode || 'normal').slice(0, 20),
      convId: body.convId && typeof body.convId === 'string' ? body.convId.slice(0, 64) : null,
    });
    return c.json({ id }, 201);
  } catch (err) {
    return c.json({ error: String((err as Error)?.message || err) }, 500);
  }
});

feedbackRoute.get('/', async (c) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 100));
    const all = await listFeedback(limit);
    return c.json({ feedback: all.map((x) => ({ id: x.id, ...x.payload })) });
  } catch (err) {
    return c.json({ error: String((err as Error)?.message || err) }, 500);
  }
});
