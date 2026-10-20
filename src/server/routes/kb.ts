/* ============================================================
   server/routes/kb.ts —— 知识库 API 路由
   ============================================================ */
import { Hono } from 'hono';
import {
  addDoc, bulkAddDocs, listDocs, getDoc, removeDoc, clearAll,
  listChunks, getStats, KbError,
} from '../kbStore.js';
import { kbIndex } from '../kbIndex.js';
import { distillChunkInto } from '../distill.js';
import type { DocSource } from '@shared/types.js';

export const kb = new Hono();

function jsonError(c: any, err: unknown) {
  if (err instanceof KbError) {
    return c.json({ error: err.message }, err.status as 400);
  }
  return c.json({ error: String((err as Error)?.message || err) }, 500);
}

const SOURCES: DocSource[] = ['file', 'paste', 'confluence', 'seed', 'test'];

/** POST /api/kb/docs —— 单篇导入 */
kb.post('/docs', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.name !== 'string' || typeof body.text !== 'string') {
    return c.json({ error: '需要 {name, text}' }, 400);
  }
  const source: DocSource = SOURCES.includes(body.source) ? body.source : 'file';
  try {
    const r = await kbIndex.run(() => addDoc(body.name, body.text, source));
    await kbIndex.run(() => kbIndex.rebuild());
    return c.json(r, 201);
  } catch (err) {
    return jsonError(c, err);
  }
});

/** POST /api/kb/docs/bulk —— 批量导入（≤50） */
kb.post('/docs/bulk', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !Array.isArray(body.docs)) {
    return c.json({ error: '需要 {docs:[{name,text,source}]}' }, 400);
  }
  if (body.docs.length > 50) return c.json({ error: '单次最多 50 篇' }, 400);
  try {
    const r = await bulkAddDocs(body.docs.map((d: any) => ({
      name: String(d.name || ''), text: String(d.text || ''),
      source: SOURCES.includes(d.source) ? d.source : 'file',
    })));
    await kbIndex.run(() => kbIndex.rebuild());
    return c.json(r, 201);
  } catch (err) {
    return jsonError(c, err);
  }
});

/** GET /api/kb/docs —— 列表 */
kb.get('/docs', async (c) => {
  const docs = await listDocs();
  return c.json({ docs });
});

/** GET /api/kb/docs/:docId —— 详情（含全文） */
kb.get('/docs/:docId', async (c) => {
  const docId = c.req.param('docId');
  const doc = await getDoc(docId);
  if (!doc) return c.json({ error: '文档不存在' }, 404);
  const p = doc.payload;
  return c.json({
    docId,
    name: p.name, source: p.source, size: p.size, addedAt: p.addedAt, text: p.text,
  });
});

/** DELETE /api/kb/docs/:docId —— 删除一篇 */
kb.delete('/docs/:docId', async (c) => {
  const ok = await removeDoc(c.req.param('docId'));
  if (!ok) return c.json({ error: '文档不存在' }, 404);
  await kbIndex.run(() => kbIndex.rebuild());
  return c.json({ ok: true });
});

/** DELETE /api/kb/docs —— 清空 */
kb.delete('/docs', async (c) => {
  await clearAll();
  await kbIndex.run(() => kbIndex.rebuild());
  return c.json({ ok: true });
});

/** GET /api/kb/docs/:docId/chunks —— 切片列表 */
kb.get('/docs/:docId/chunks', async (c) => {
  const chunks = await listChunks(c.req.param('docId'));
  if (!chunks) return c.json({ error: '文档不存在' }, 404);
  return c.json({ chunks });
});

/** POST /api/kb/docs/:docId/chunks/:index/distill —— 蒸馏单块 */
kb.post('/docs/:docId/chunks/:index/distill', async (c) => {
  const docId = c.req.param('docId');
  const index = parseInt(c.req.param('index'), 10);
  if (!Number.isFinite(index)) return c.json({ error: 'index 非法' }, 400);
  try {
    const summary = await distillChunk(docId, index);
    return c.json({ index, summary, summaryAt: Date.now() });
  } catch (err) {
    const msg = String((err as Error)?.message || err);
    if (msg.includes('不存在')) return c.json({ error: msg }, 404);
    if (msg.includes('未配置')) return c.json({ error: msg }, 503);
    return c.json({ error: msg }, 502);
  }
});

/** GET /api/kb/stats —— 汇总 */
kb.get('/stats', async (c) => {
  return c.json(await getStats());
});

// 蒸馏调用：从 Qdrant 取块文（不信任客户端）→ LLM 非流式 → 写 payload + 重新 embed + 更新 BM25
async function distillChunk(docId: string, index: number): Promise<string> {
  const chunks = await listChunks(docId);
  if (!chunks) throw new Error('文档不存在');
  const chunk = chunks.find((c) => c.index === index);
  if (!chunk) throw new Error('片段不存在');
  return distillChunkInto(docId, index, chunk);
}
