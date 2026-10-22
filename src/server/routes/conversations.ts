/* ============================================================
   server/routes/conversations.ts —— 对话历史 CRUD
   /api/conversations
   GET    /              列表（标题+时间，不含消息，按 updatedAt 倒序 pinned 优先）
   POST   /              新建 {title?} → {id}
   GET    /:id           取单条（含消息）
   PUT    /:id           覆盖 {title?, messages?, pinned?}
   DELETE /:id           删除
   POST   /:id/pin       置顶切换
   ============================================================ */
import { Hono } from 'hono';
import {
  createConv, listConvs, getConv, saveConv, deleteConv, renameConv, togglePinConv,
  type ConvPayload, type ConvMessage,
} from '../conversations.js';

export const conversationsRoute = new Hono();

conversationsRoute.get('/', async (c) => {
  const all = await listConvs();
  return c.json({ conversations: all.map((x) => ({
    id: x.id,
    title: x.payload.title,
    createdAt: x.payload.createdAt,
    updatedAt: x.payload.updatedAt,
    pinned: !!x.payload.pinned,
    messageCount: x.payload.messages?.length || 0,
  })) });
});

conversationsRoute.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const title = typeof body.title === 'string' ? body.title : '新对话';
  const id = await createConv(title);
  return c.json({ id }, 201);
});

conversationsRoute.get('/:id', async (c) => {
  const id = c.req.param('id');
  const p = await getConv(id);
  if (!p) return c.json({ error: '对话不存在' }, 404 as 400);
  return c.json({ id, ...p });
});

conversationsRoute.put('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const existing = await getConv(id);
  if (!existing) return c.json({ error: '对话不存在' }, 404 as 400);
  const next: ConvPayload = {
    ...existing,
    title: typeof body.title === 'string' ? body.title.slice(0, 80) : existing.title,
    messages: Array.isArray(body.messages) ? (body.messages as ConvMessage[]) : existing.messages,
    pinned: typeof body.pinned === 'boolean' ? body.pinned : existing.pinned,
  };
  await saveConv(id, next);
  return c.json({ ok: true });
});

conversationsRoute.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await deleteConv(id);
  return c.json({ ok: true });
});

conversationsRoute.post('/:id/pin', async (c) => {
  const id = c.req.param('id');
  await togglePinConv(id);
  return c.json({ ok: true });
});

conversationsRoute.post('/:id/rename', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.title !== 'string' || !body.title.trim()) {
    return c.json({ error: '需要 {title}' }, 400 as 400);
  }
  await renameConv(id, body.title);
  return c.json({ ok: true });
});
