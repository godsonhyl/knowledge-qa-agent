/* ============================================================
   server/routes/webSearch.ts —— POST /api/web-search
   拒答后的联网搜索兜底（SearXNG 自托管实例）。
   服务端代理调用，浏览器不直连 SearXNG；返回裁剪后的
   {title,url,content} 列表，前端拼接给 LLM 作答。
   与知识库链路完全隔离：不进 Qdrant、不进 BM25 索引。
   ============================================================ */
import { Hono } from 'hono';
import { ENV, webSearchReady } from '../env.js';

export const webSearch = new Hono();

/** SearXNG 单结果条目（裁剪后下发前端的部分） */
export interface WebHit {
  title: string;
  url: string;
  content: string;
}

webSearch.post('/', async (c) => {
  if (!webSearchReady()) {
    return c.json({ error: '服务端未配置联网搜索（SEARXNG_URL）' }, 503 as 400);
  }
  const body = await c.req.json().catch(() => null);
  const q = body && typeof body.q === 'string' ? body.q.trim() : '';
  if (!q) return c.json({ error: '需要 {q}' }, 400 as 400);

  const limit = typeof body.limit === 'number' ? Math.min(Math.max(body.limit, 1), 10) : 6;

  // http://host/searxng → 搜索端点为 /searxng/search
  const base = ENV.SEARXNG_URL.replace(/\/+$/, '');
  const u = new URL(`${base}/search`);
  u.searchParams.set('q', q);
  u.searchParams.set('format', 'json');

  let upstream: Response;
  try {
    upstream = await fetch(u.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: c.req.raw.signal,
    });
  } catch (err) {
    return c.json({ error: `无法连接搜索服务：${String((err as Error)?.message || err)}` }, 502 as 400);
  }
  if (!upstream.ok) {
    return c.json({ error: `搜索服务返回 ${upstream.status}` }, upstream.status as 400);
  }

  const data: any = await upstream.json().catch(() => null);
  const results: any[] = Array.isArray(data?.results) ? data.results : [];
  const unresponsive: string[] = Array.isArray(data?.unresponsive_engines)
    ? (data.unresponsive_engines as any[]).map((e: any) => String(e?.engine || e?.name || e).slice(0, 40))
    : [];

  const hits: WebHit[] = results.slice(0, limit).map((r) => ({
    title: String(r?.title || '').slice(0, 200),
    url: String(r?.url || '').slice(0, 500),
    content: String(r?.content || '').slice(0, 400),
  }));

  return c.json({
    hits,
    unresponsiveEngines: unresponsive,
    /** 结果为空且无失败引擎 → 网上也没搜到 */
    empty: hits.length === 0,
  });
});
