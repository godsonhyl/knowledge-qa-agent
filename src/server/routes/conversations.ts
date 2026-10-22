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
import { ENV } from '../env.js';
import {
  createConv, listConvs, getConv, saveConv, deleteConv, renameConv, togglePinConv,
  type ConvPayload, type ConvMessage,
} from '../conversations.js';

export const conversationsRoute = new Hono();

/** 从 context 取当前登录用户 sub（OIDC_REQUIRED 模式下用于隔离对话历史） */
function ownerOf(c: { get: (k: string) => any }): string | undefined {
  if (!ENV.OIDC_REQUIRED) return undefined;
  const u = c.get('ssoUser');
  return u?.sub || undefined;
}

conversationsRoute.get('/', async (c) => {
  const all = await listConvs(ownerOf(c));
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
  const id = await createConv(title, ownerOf(c));
  return c.json({ id }, 201);
});

conversationsRoute.get('/:id', async (c) => {
  const id = c.req.param('id');
  const p = await getConv(id);
  if (!p) return c.json({ error: '对话不存在' }, 404 as 400);
  // 隔离：REQUIRED 模式下，非本人对话返回 404（不泄露存在性）
  const owner = ownerOf(c);
  if (owner && p.ownerSub && p.ownerSub !== owner) return c.json({ error: '对话不存在' }, 404 as 400);
  return c.json({ id, ...p });
});

conversationsRoute.put('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const existing = await getConv(id);
  if (!existing) return c.json({ error: '对话不存在' }, 404 as 400);
  const owner = ownerOf(c);
  if (owner && existing.ownerSub && existing.ownerSub !== owner) return c.json({ error: '对话不存在' }, 404 as 400);
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
  const existing = await getConv(id);
  if (!existing) return c.json({ ok: true }); // 幂等
  const owner = ownerOf(c);
  if (owner && existing.ownerSub && existing.ownerSub !== owner) return c.json({ error: '对话不存在' }, 404 as 400);
  await deleteConv(id);
  return c.json({ ok: true });
});

conversationsRoute.post('/:id/pin', async (c) => {
  const id = c.req.param('id');
  const existing = await getConv(id);
  if (!existing) return c.json({ error: '对话不存在' }, 404 as 400);
  const owner = ownerOf(c);
  if (owner && existing.ownerSub && existing.ownerSub !== owner) return c.json({ error: '对话不存在' }, 404 as 400);
  await togglePinConv(id);
  return c.json({ ok: true });
});

conversationsRoute.post('/:id/rename', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.title !== 'string' || !body.title.trim()) {
    return c.json({ error: '需要 {title}' }, 400 as 400);
  }
  const existing = await getConv(id);
  if (!existing) return c.json({ error: '对话不存在' }, 404 as 400);
  const owner = ownerOf(c);
  if (owner && existing.ownerSub && existing.ownerSub !== owner) return c.json({ error: '对话不存在' }, 404 as 400);
  await renameConv(id, body.title);
  return c.json({ ok: true });
});
