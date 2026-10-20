/* ============================================================
   server/routes/chat.ts —— POST /api/chat —— SSE 原样透传
   ============================================================ */
import { Hono } from 'hono';
import { ENV, llmReady, safeHost } from '../env.js';

export const chat = new Hono();

chat.post('/', async (c) => {
  if (!llmReady()) {
    return c.json({
      error: '服务端未配置大模型接口',
      hint: '启动时设置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL',
    }, 503);
  }

  const raw = await c.req.text();
  let payload: any;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    return c.json({ error: '请求体不是合法 JSON' }, 400);
  }

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  if (messages.length === 0) return c.json({ error: 'messages 不能为空' }, 400);
  if (!messages.some((m: any) => m && m.role === 'system')) {
    return c.json({ error: 'messages[0] 必须是 system 消息' }, 400);
  }

  const body = {
    model: payload.model || ENV.LLM_MODEL,
    messages,
    stream: true,
    temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.2,
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ENV.LLM_API_KEY) headers.Authorization = `Bearer ${ENV.LLM_API_KEY}`;

  let upstream: Response;
  try {
    upstream = await fetch(`${ENV.LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: c.req.raw.signal,   // 客户端断开 → 上游 abort
    });
  } catch (err) {
    return c.json({ error: '无法连接大模型服务', hint: String((err as Error)?.message || err) }, 502);
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    return c.json({ error: `大模型服务返回 ${upstream.status}`, detail: text.slice(0, 800) }, upstream.status as 400);
  }

  // 原样透传 SSE（不重编码）
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});
