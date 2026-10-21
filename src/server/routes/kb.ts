/* ============================================================
   server/routes/kb.ts —— 知识库 API 路由
   ============================================================ */
import { Hono } from 'hono';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createWriteStream, unlink } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import Busboy from 'busboy';
import {
  addDoc, bulkAddDocs, listDocs, getDoc, removeDoc, clearAll,
  listChunks, getStats, KbError,
  exportForBackup, restoreFromBackup,
} from '../kbStore.js';
import { kbIndex } from '../kbIndex.js';
import { distillChunkInto } from '../distill.js';
import { ENV, llmReady } from '../env.js';
import { writeKbBackup, listKbBackups, readKbBackup, pruneKbBackups } from '../backup.js';
import { startDistillJob, stopDistillJob, distillJob } from '../distillJob.js';
import { extractPdfText, PdfNoTextError } from '../pdf.js';
import type { DocSource } from '@shared/types.js';

export const kb = new Hono();

function jsonError(c: any, err: unknown) {
  if (err instanceof KbError) {
    return c.json({ error: err.message }, err.status as 400);
  }
  return c.json({ error: String((err as Error)?.message || err) }, 500);
}

const SOURCES: DocSource[] = ['file', 'paste', 'confluence', 'seed', 'test'];

/** 管理员令牌校验：没配 ADMIN_TOKEN 或令牌错误都返回 403。
 *  hash 后 timingSafeEqual 定长比较，防时序侧信道。 */
function adminGate(c: any): boolean {
  if (!ENV.ADMIN_TOKEN) return false;
  const token = c.req.header('X-Admin-Token') || '';
  const a = createHash('sha256').update(token).digest();
  const b = createHash('sha256').update(ENV.ADMIN_TOKEN).digest();
  return timingSafeEqual(a, b);
}

function adminError(c: any) {
  return c.json({ error: ENV.ADMIN_TOKEN ? '管理员令牌错误' : '功能未启用：服务端需设置 ADMIN_TOKEN' }, 403);
}

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

/** POST /api/kb/docs/upload —— 二进制文件上传导入（目前用于 PDF）。
 *  multipart/form-data：file（必填，二进制）+ source（可选，默认 file）。
 *  用 busboy 流式解析 + 临时文件落盘，避免 500MB 整载内存。
 *  单篇上限 500MB（PDF 是二进制，比文本类大得多）。
 *  - 413：超过大小上限（Content-Length 预检 + 落盘后二次校验）
 *  - 422：PDF 提取不到文本（扫描/图片型）
 *  - 409：重名（走 addDoc 的 KbError）
 *  其余链路（切块/嵌入/Qdrant upsert/重名 409）与 /docs 完全一致。 */
const PDF_MAX_BYTES = 500 * 1024 * 1024;

kb.post('/docs/upload', async (c) => {
  const cl = Number(c.req.header('Content-Length') || '0');
  if (cl && cl > PDF_MAX_BYTES) {
    return c.json({ error: `文件过大，PDF 上限 500MB（收到 ${(cl / 1024 / 1024).toFixed(1)}MB）` }, 413 as 400);
  }
  const contentType = c.req.header('Content-Type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return c.json({ error: '需要 multipart/form-data 上传' }, 400 as 400);
  }

  // 流式落盘：busboy 边收边写临时文件，避免 500MB 整载内存
  const tmpDir = await mkdtemp(join(tmpdir(), 'kqa-pdf-'));
  let savedName = '';
  let savedPath = '';
  let source: DocSource = 'file';
  let savedSize = 0;
  let fileFieldMissing = true;

  try {
    await new Promise<void>((resolve, reject) => {
      const bb = Busboy({ headers: { 'content-type': contentType } });
      bb.on('file', (_name, stream, info) => {
        fileFieldMissing = false;
        savedName = info.filename || `upload-${Date.now()}.pdf`;
        savedPath = join(tmpDir, 'part.bin');
        const ws = createWriteStream(savedPath);
        stream.on('data', (chunk) => {
          savedSize += (chunk as Buffer).length;
          // 落盘阶段提前拦截超限，避免写到磁盘爆满
          if (savedSize > PDF_MAX_BYTES && !ws.destroyed) {
            ws.destroy();
            reject(Object.assign(new Error('PAYLOAD_TOO_LARGE'), { status: 413 }));
            stream.destroy();
          }
        });
        stream.pipe(ws);
      });
      bb.on('field', (name, val) => {
        if (name === 'source' && typeof val === 'string' && SOURCES.includes(val as DocSource)) {
          source = val as DocSource;
        }
      });
      bb.on('finish', resolve);
      bb.on('error', reject);
      // @hono/node-server 把 web Request.body 暴露为 ReadableStream；转 Node stream 喂给 busboy
      Readable.fromWeb(c.req.raw.body as any).pipe(bb);
    });
  } catch (err: any) {
    if (err?.status === 413) {
      return c.json({ error: `文件过大，PDF 上限 500MB` }, 413 as 400);
    }
    return c.json({ error: `上传解析失败：${String(err?.message || err)}` }, 400 as 400);
  }

  if (fileFieldMissing) {
    return c.json({ error: '缺少 file 字段（二进制文件）' }, 400 as 400);
  }
  if (savedSize > PDF_MAX_BYTES) {
    return c.json({ error: `文件过大，PDF 上限 500MB（收到 ${(savedSize / 1024 / 1024).toFixed(1)}MB）` }, 413 as 400);
  }
  if (!/\.pdf$/i.test(savedName)) {
    return c.json({ error: 'upload 通道目前仅支持 .pdf；文本类请用 /api/kb/docs' }, 400 as 400);
  }

  // 解析：读临时文件 → unpdf 提取文本
  const { readFile } = await import('node:fs/promises');
  let text: string;
  try {
    const buf = new Uint8Array(await readFile(savedPath));
    text = await extractPdfText(buf);
  } catch (err) {
    if (err instanceof PdfNoTextError) {
      return c.json({ error: err.message }, 422 as 400);
    }
    return c.json({ error: `PDF 解析失败：${String((err as Error)?.message || err)}` }, 422 as 400);
  } finally {
    unlink(savedPath, () => {});
    // rmdir 临时目录（Node 22 有 rm recursive）
    import('node:fs/promises').then(({ rm }) => rm(tmpDir, { recursive: true, force: true })).catch(() => {});
  }

  try {
    const r = await kbIndex.run(() => addDoc(savedName, text, source));
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

/** DELETE /api/kb/docs/:docId —— 删除一篇（管理员令牌） */
kb.delete('/docs/:docId', async (c) => {
  if (!adminGate(c)) return adminError(c);
  const ok = await removeDoc(c.req.param('docId'));
  if (!ok) return c.json({ error: '文档不存在' }, 404);
  await kbIndex.run(() => kbIndex.rebuild());
  return c.json({ ok: true });
});

/** DELETE /api/kb/docs —— 清空（仅管理员，需 ADMIN_TOKEN 环境变量 + X-Admin-Token 头）
 *  清空前自动导出 JSON 快照到 ./backups/kb-<时间戳>.json，并只保留最近 10 份。 */
kb.delete('/docs', async (c) => {
  if (!ENV.ADMIN_TOKEN) {
    return c.json({ error: '清空功能未启用：服务端需设置 ADMIN_TOKEN' }, 403);
  }
  const token = c.req.header('X-Admin-Token') || '';
  // 定长比较防时序侧信道（token 错也走完整个 hash 计算）
  const a = createHash('sha256').update(token).digest();
  const b = createHash('sha256').update(ENV.ADMIN_TOKEN).digest();
  if (!timingSafeEqual(a, b)) {
    return c.json({ error: '管理员令牌错误' }, 403);
  }

  // 清空前导出快照（兜底）——即使导出失败也继续清空，避免「想清却清不掉」
  let backup: string | null = null;
  let backupError: string | undefined;
  try {
    const docs = await exportForBackup();
    backup = writeKbBackup(docs);
    pruneKbBackups(10);
  } catch (err) {
    backupError = String((err as Error)?.message || err);
  }

  await clearAll();
  await kbIndex.run(() => kbIndex.rebuild());
  return c.json({ ok: true, backup: backup || undefined, backupError });
});

/** GET /api/kb/backups —— 列出已有快照（管理用，非管理员也能看，只含元信息） */
kb.get('/backups', async (c) => {
  const all = listKbBackups();
  return c.json({ backups: all.map((b) => ({ file: b.file.split('/').pop(), exportedAt: b.exportedAt, docCount: b.docCount, size: b.size })) });
});

/** POST /api/kb/restore —— 从快照恢复（管理员令牌校验，避免任意人覆盖知识库） */
kb.post('/restore', async (c) => {
  if (!ENV.ADMIN_TOKEN) return c.json({ error: '恢复功能未启用：服务端需设置 ADMIN_TOKEN' }, 403);
  const token = c.req.header('X-Admin-Token') || '';
  const a = createHash('sha256').update(token).digest();
  const expected = createHash('sha256').update(ENV.ADMIN_TOKEN).digest();
  if (!timingSafeEqual(a, expected)) {
    return c.json({ error: '管理员令牌错误' }, 403);
  }
  const body = await c.req.json().catch(() => null);
  const file = body && typeof body.file === 'string' ? body.file : '';
  const bk = readKbBackup(file);
  if (!bk) return c.json({ error: '快照不存在或损坏' }, 404);
  try {
    const r = await restoreFromBackup(bk.docs.map((d) => ({
      name: d.name, text: d.text, source: (SOURCES.includes(d.source as DocSource) ? d.source : 'file') as DocSource,
      summaries: d.summaries,
    })));
    await kbIndex.run(() => kbIndex.rebuild());
    return c.json({ ...r, from: file, exportedAt: bk.exportedAt });
  } catch (err) {
    return jsonError(c, err);
  }
});

/** GET /api/kb/docs/:docId/chunks —— 切片列表 */
kb.get('/docs/:docId/chunks', async (c) => {
  const chunks = await listChunks(c.req.param('docId'));
  if (!chunks) return c.json({ error: '文档不存在' }, 404);
  return c.json({ chunks });
});

/** POST /api/kb/distill-all —— 启动后台全库批量蒸馏（管理员） */
kb.post('/distill-all', async (c) => {
  if (!ENV.ADMIN_TOKEN) return c.json({ error: '批量蒸馏未启用：服务端需设置 ADMIN_TOKEN' }, 403);
  const token = c.req.header('X-Admin-Token') || '';
  const a = createHash('sha256').update(token).digest();
  const expected = createHash('sha256').update(ENV.ADMIN_TOKEN).digest();
  if (!timingSafeEqual(a, expected)) return c.json({ error: '管理员令牌错误' }, 403);
  if (!llmReady()) return c.json({ error: '服务端未配置大模型' }, 503);
  const r = await startDistillJob();
  if (!r.started) return c.json({ error: r.reason }, 409);
  return c.json({ ok: true, started: true });
});

/** GET /api/kb/distill-status —— 批量蒸馏进度（公开只读，前端轮询） */
kb.get('/distill-status', async (c) => {
  return c.json(distillJob);
});

/** POST /api/kb/distill-stop —— 中断批量蒸馏（管理员） */
kb.post('/distill-stop', async (c) => {
  if (!ENV.ADMIN_TOKEN) return c.json({ error: '未启用' }, 403);
  const token = c.req.header('X-Admin-Token') || '';
  const a = createHash('sha256').update(token).digest();
  const expected = createHash('sha256').update(ENV.ADMIN_TOKEN).digest();
  if (!timingSafeEqual(a, expected)) return c.json({ error: '管理员令牌错误' }, 403);
  stopDistillJob();
  return c.json({ ok: true });
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
