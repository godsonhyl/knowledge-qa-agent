/* ============================================================
   server/routes/webSearch.ts —— POST /api/web-search
   拒答后的联网搜索兜底（SearXNG 自托管实例）。
   服务端代理调用，浏览器不直连 SearXNG；返回裁剪后的
   {title,url,content} 列表，前端拼接给 LLM 作答。
   与知识库链路完全隔离：不进 Qdrant、不进 BM25 索引。

   v2.4 增强（方案 A+B）：
   - A: 摘要截断 400→2000，条数上限 10（喂给 LLM 的原料更厚）
   - B: 若配置了 FIRECRAWL_URL，对 Top-N 条结果二次抓取页面正文（markdown），
         替换摘要喂给 LLM——让模型能看到页面表格/数值，而非只有搜索摘要尾巴。
         抓取失败/超时则回退摘要，不阻塞。
   ============================================================ */
import { Hono } from 'hono';
import { ENV, webSearchReady } from '../env.js';
import type { WebHit } from '@shared/types.js';

export const webSearch = new Hono();

/** SearXNG 摘要裁剪上限（方案 A：400→2000，喂给 LLM 更多有效信息） */
const SNIPPET_MAX = 2000;
/** Firecrawl 正文抓取裁剪上限（单页 markdown 太长会撑爆 LLM 上下文） */
const SCRAPE_MAX = 6000;
/** 抓取正文的目标条数（Top-N，按 SearXNG 排序） */
const SCRAPE_TOPN = 3;
/** 每页抓取超时（ms）；失败回退摘要。深页面正文渲染可能需 15-20s */
const SCRAPE_TIMEOUT_MS = 20000;

webSearch.post('/', async (c) => {
  if (!webSearchReady()) {
    return c.json({ error: '服务端未配置联网搜索（SEARXNG_URL）' }, 503 as 400);
  }
  const body = await c.req.json().catch(() => null);
  const q = body && typeof body.q === 'string' ? body.q.trim() : '';
  if (!q) return c.json({ error: '需要 {q}' }, 400 as 400);

  // 方案 A：条数上限 10（原 6）
  const limit = typeof body.limit === 'number' ? Math.min(Math.max(body.limit, 1), 10) : 8;

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

  // 方案 A：摘要截断放宽到 SNIPPET_MAX
  const hits: WebHit[] = results.slice(0, limit).map((r) => ({
    title: String(r?.title || '').slice(0, 200),
    url: String(r?.url || '').slice(0, 500),
    content: String(r?.content || '').slice(0, SNIPPET_MAX),
    scraped: false,
  }));

  // 方案 B：对 Top-N 抓取正文（若配置了 FIRECRAWL_URL）
  const fcBase = ENV.FIRECRAWL_URL.replace(/\/+$/, '');
  if (fcBase) {
    const topN = Math.min(SCRAPE_TOPN, hits.length);
    await Promise.allSettled(
      hits.slice(0, topN).map(async (h, i) => {
        try {
          const md = await scrapePage(fcBase, h.url);
          if (md && md.length > (h.content.length * 1.5)) {
            hits[i] = { ...h, content: md.slice(0, SCRAPE_MAX), scraped: true };
          }
        } catch { /* 抓取失败回退摘要，不阻塞 */ }
      }),
    );
  }

  return c.json({
    hits,
    unresponsiveEngines: unresponsive,
    /** 结果为空且无失败引擎 → 网上也没搜到 */
    empty: hits.length === 0,
  });
});

/** 调用自托管 Firecrawl /v2/scrape 抓取页面正文（markdown），失败返回 null */
async function scrapePage(fcBase: string, url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SCRAPE_TIMEOUT_MS);
  try {
    const res = await fetch(`${fcBase}/v2/scrape`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const d: any = await res.json().catch(() => null);
    if (!d?.success) return null;
    const md = d?.data?.markdown || d?.markdown || '';
    // 过滤极短/无意义内容
    return md.length > 80 ? md : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
