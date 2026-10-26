/* ============================================================
   server/routes/feedback.ts —— POST /api/feedback（👍/👎）
   GET  /api/feedback?limit=   列最近反馈（调优用）
   GET  /api/feedback/analysis 负样本诊断聚合（按 mode 分组 + top 问题）
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

/** GET /api/feedback/analysis —— 负样本诊断聚合。
 *  按 mode 分组（normal 排序差 / fallback 兜底失败 / web 联网补救）+ top 问题，
 *  帮助判断是阈值卡了还是 chunk 质量差——检索调优的数据飞轮。 */
feedbackRoute.get('/analysis', async (c) => {
  try {
    const all = await listFeedback(500);
    const downs = all.filter((x) => x.payload.feedback === 'down');
    const ups = all.filter((x) => x.payload.feedback === 'up');
    // 按 mode 分组统计负样本
    const byMode: Record<string, { count: number; samples: { question: string; hitDocs: string[]; ts: number }[] }> = {};
    for (const x of downs) {
      const m = x.payload.mode || 'normal';
      (byMode[m] = byMode[m] || { count: 0, samples: [] });
      byMode[m]!.count++;
      if (byMode[m]!.samples.length < 10) {
        byMode[m]!.samples.push({
          question: x.payload.question,
          hitDocs: x.payload.hitDocs,
          ts: x.payload.ts,
        });
      }
    }
    // 高频问题（去重 + 计数，找聚集出现的负样本）
    const qCount = new Map<string, number>();
    for (const x of downs) qCount.set(x.payload.question, (qCount.get(x.payload.question) || 0) + 1);
    const topQuestions = [...qCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([q, n]) => ({ question: q, count: n }));
    return c.json({
      total: all.length,
      up: ups.length,
      down: downs.length,
      downRate: all.length ? +(downs.length / all.length).toFixed(3) : 0,
      byMode,
      topQuestions,
    });
  } catch (err) {
    return c.json({ error: String((err as Error)?.message || err) }, 500);
  }
});
