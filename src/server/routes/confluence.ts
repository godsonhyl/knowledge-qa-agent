/* ============================================================
   server/routes/confluence.ts —— POST /api/confluence-page
   ============================================================ */
import { Hono } from 'hono';
import { ENV, confluenceReady } from '../env.js';
import { fetchConfluencePage } from '../confluence.js';

export const confluence = new Hono();

confluence.post('/', async (c) => {
  if (!confluenceReady()) {
    return c.json({
      error: '服务端未配置 Confluence 接入',
      hint: '设置 CONFLUENCE_BASE_URL 与 CONFLUENCE_PAT',
    }, 503);
  }

  const raw = await c.req.text();
  let payload: any;
  try { payload = JSON.parse(raw || '{}'); }
  catch { return c.json({ error: '请求体不是合法 JSON' }, 400); }

  const link = typeof payload.url === 'string' ? payload.url.trim() : '';
  if (!link) return c.json({ error: 'url 不能为空' }, 400);
  const recursive = payload.recursive === true;

  try {
    const r = await fetchConfluencePage(link, { recursive });
    return c.json(r, 200);
  } catch (err) {
    const msg = String((err as Error)?.message || err);
    if (msg.includes('无法从链接中识别')) return c.json({ error: msg }, 400);
    return c.json({ error: msg }, 502);
  }
});

void ENV;
