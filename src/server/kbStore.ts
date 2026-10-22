/* ============================================================
   server/kbStore.ts —— 知识库读写层（Qdrant 之上的领域操作）
   ============================================================ */
import { ENV, embedReady } from './env.js';
import { uuidv4, chunkIdFor } from './ids.js';
import { chunkDocument } from './chunker.js';
import { embed, embedInputFor } from './embeddings.js';
import {
  ensureCollection, ensurePayloadIndex, upsertPoints, scrollAll,
  deleteByFilter, deletePoints, dropCollection,
} from './qdrant.js';
import type { DocMeta, ChunkMeta, ImportResult, BulkImportResult, DocSource, KbStats } from '@shared/types.js';

export const COLLECTION_CHUNKS = ENV.COLLECTION_CHUNKS;
export const COLLECTION_DOCS = ENV.COLLECTION_DOCS;
export const COLLECTION_CONVS = ENV.COLLECTION_CONVS || 'kqa_conversations';

const MAX_DOC_CHARS = 5 * 1024 * 1024; // 5MB = 与旧版单篇上限一致

export interface DocPayload {
  kind: 'doc';
  name: string;
  source: string;
  size: number;
  addedAt: number;
  text: string;
  /** Confluence 文档的 pageId（增量同步用；非 Confluence 文档为 null） */
  confluencePageId?: string | null;
  /** Confluence 文档的版本号（增量同步：变更则重切块重嵌入） */
  confluenceVersion?: number | null;
  /** 最后同步时间（ms） */
  syncedAt?: number | null;
}

export interface ChunkPayload {
  kind: 'chunk';
  docId: string;
  index: number;
  docName: string;
  section: string;
  startLine: number;
  endLine: number;
  startChar: number;
  endChar: number;
  text: string;
  summary: string | null;
  summaryAt: number | null;
  source: string;
  addedAt: number;
}

let payloadIndexEnsured = false;

export async function ensureCollections(): Promise<void> {
  await ensureCollection(COLLECTION_CHUNKS, ENV.EMBED_DIM);
  await ensureCollection(COLLECTION_DOCS, 1);
  if (!payloadIndexEnsured) {
    await ensurePayloadIndex(COLLECTION_CHUNKS, ['docId', 'docName', 'source']);
    await ensurePayloadIndex(COLLECTION_DOCS, ['name', 'source']);
    payloadIndexEnsured = true;
  }
  // 对话历史 collection（伪向量 size 1，payload 存消息列表）
  await ensureCollection(COLLECTION_CONVS, 1);
}

/** 按名字查文档（去重检查用） */
export async function findDocByName(name: string): Promise<{ id: string; payload: DocPayload } | null> {
  const pts = await scrollAll<DocPayload>(COLLECTION_DOCS, { must: [{ key: 'name', match: { value: name } }] });
  return pts.length ? { id: pts[0]!.id, payload: pts[0]!.payload } : null;
}

/** 导入一篇文档：切块 → 嵌入 → 双 collection upsert。重名返回 dup error。
 *  opts.confluencePageId / confluenceVersion：Confluence 文档的增量同步元数据（非 Confluence 不传）。 */
export async function addDoc(
  name: string, text: string, source: DocSource,
  opts: { confluencePageId?: string; confluenceVersion?: number } = {},
): Promise<ImportResult> {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new KbError(400, '内容为空');
  if (trimmed.length > MAX_DOC_CHARS) throw new KbError(413, `文档超过 ${Math.round(MAX_DOC_CHARS / 1024 / 1024)}MB 上限`);

  const dup = await findDocByName(name);
  if (dup) throw new KbError(409, `文档已存在：${name}`);

  const raw = chunkDocument(trimmed, name);
  if (!raw.length) throw new KbError(400, '解析后没有可用的内容片段');

  const docId = uuidv4();
  const addedAt = Date.now();
  const withEmbed = embedReady();

  // 分批嵌入（块数可能上百）
  const inputs = raw.map((c) => embedInputFor(c.text, null));
  const vectors: number[][] = [];
  if (withEmbed) {
    for (let i = 0; i < inputs.length; i += 32) {
      vectors.push(...await embed(inputs.slice(i, i + 32)));
    }
  } else {
    // 无嵌入服务时用零向量占位（检索只走 BM25，向量门自动失效）
    for (let i = 0; i < raw.length; i++) vectors.push(new Array(ENV.EMBED_DIM).fill(0));
  }

  const chunkPoints = raw.map((c, i) => ({
    id: chunkIdFor(docId, i),
    vector: vectors[i]!,
    payload: {
      kind: 'chunk', docId, index: i, docName: name, section: c.section,
      startLine: c.startLine, endLine: c.endLine, startChar: c.startChar, endChar: c.endChar,
      text: c.text, summary: null, summaryAt: null, source, addedAt,
    } satisfies ChunkPayload,
  }));
  await upsertPoints(COLLECTION_CHUNKS, chunkPoints);

  const docPoint = {
    id: docId,
    vector: [0],
    payload: {
      kind: 'doc', name, source, size: trimmed.length, addedAt, text: trimmed,
      confluencePageId: opts.confluencePageId ?? null,
      confluenceVersion: opts.confluenceVersion ?? null,
      syncedAt: Date.now(),
    } satisfies DocPayload,
  };
  await upsertPoints(COLLECTION_DOCS, [docPoint]);

  // 返回 raw chunks 供路由层做 BM25 增量索引（避免全量 rebuild）
  return { docId, chunkCount: raw.length, chars: trimmed.length, chunks: raw };
}

export async function bulkAddDocs(docs: { name: string; text: string; source: DocSource }[]): Promise<BulkImportResult> {
  const failed: { name: string; reason: string }[] = [];
  let added = 0;
  for (const d of docs.slice(0, 50)) {
    try {
      await addDoc(d.name, d.text, d.source);
      added++;
    } catch (err) {
      failed.push({ name: d.name, reason: err instanceof KbError ? err.message : String((err as Error)?.message || err) });
    }
  }
  return { added, failed };
}

/**
 * 批量恢复：从快照导入，**已有蒸馏知识点一并写回**，省一轮 LLM 蒸馏调用。
 * 返回 {added, failed, summariesRestored}。同 bulkAddDocs 一样去重（重名跳过并记 failed）。
 */
export async function restoreFromBackup(entries: { name: string; text: string; source: DocSource; summaries: (string | null)[] }[]): Promise<{ added: number; failed: { name: string; reason: string }[]; summariesRestored: number }> {
  const failed: { name: string; reason: string }[] = [];
  let added = 0;
  let summariesRestored = 0;
  for (const d of entries) {
    try {
      // addDoc 已处理重复，直接报 409 给下面的 catch
      const imp = await addDoc(d.name, d.text, d.source);
      added++;
      // 写回蒸馏的知识点（addDoc 创建的块按 0..N 顺序，与快照 summaries 对齐）
      if (Array.isArray(d.summaries) && d.summaries.length) {
        let restored = 0;
        for (let i = 0; i < d.summaries.length; i++) {
          const s = d.summaries[i];
          if (s && String(s).trim()) {
            const updated = await setChunkSummary(imp.docId, i, s);
            if (updated) restored++;
          }
        }
        summariesRestored += restored;
      }
    } catch (err) {
      failed.push({ name: d.name, reason: err instanceof KbError ? err.message : String((err as Error)?.message || err) });
    }
  }
  return { added, failed, summariesRestored };
}

/** 文档列表（payload 投影排除 text） */
export async function listDocs(): Promise<DocMeta[]> {
  const docs = await scrollAll<DocPayload>(
    COLLECTION_DOCS, null, ['kind', 'name', 'source', 'size', 'addedAt', 'confluencePageId', 'confluenceVersion', 'syncedAt'],
  );
  const metas: DocMeta[] = [];
  for (const d of docs) {
    const all = await scrollAll<ChunkPayload>(COLLECTION_CHUNKS, { must: [{ key: 'docId', match: { value: d.id } }] });
    const distilled = all.filter((c) => c.payload.summary && String(c.payload.summary).trim()).length;
    metas.push({
      docId: d.id,
      name: d.payload.name,
      source: d.payload.source,
      size: d.payload.size,
      addedAt: d.payload.addedAt,
      chunkCount: all.length,
      distilled,
    });
  }
  metas.sort((a, b) => a.addedAt - b.addedAt);
  return metas;
}

export async function getDoc(docId: string): Promise<{ payload: DocPayload } | null> {
  // 按 point id 直接取（Qdrant 支持 ids 查询）
  const res = await fetch(`${ENV.QDRANT_URL}/collections/${COLLECTION_DOCS}/points`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [docId], with_payload: true }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { result: { payload: DocPayload }[] };
  const p = body.result?.[0];
  return p ? { payload: p.payload } : null;
}

/** 原子更新一篇文档：删除旧块 → 重新切块嵌入 → upsert doc + chunks。
 *  保留 docId（不动 docName 时换内容仍幂等：chunk id 是 docId:index 派生）。
 *  用于 Confluence 增量同步——text 变了就重新切块，version/pageId 元数据回写。 */
export async function updateDocContent(
  docId: string,
  newText: string,
  meta: { confluenceVersion?: number | null; syncedAt?: number } = {},
): Promise<void> {
  const existing = await getDoc(docId);
  if (!existing) throw new KbError(404, '文档不存在');
  const trimmed = String(newText || '').trim();
  if (!trimmed) throw new KbError(400, '内容为空');

  // 删除旧块
  await deleteByFilter(COLLECTION_CHUNKS, { must: [{ key: 'docId', match: { value: docId } }] });

  // 重新切块嵌入（与 addDoc 一致，但保留原 docId）
  const raw = chunkDocument(trimmed, existing.payload.name);
  const vectors: number[][] = [];
  if (embedReady()) {
    const inputs = raw.map((c) => embedInputFor(c.text, null));
    for (let i = 0; i < inputs.length; i += 32) {
      vectors.push(...await embed(inputs.slice(i, i + 32)));
    }
  } else {
    for (let i = 0; i < raw.length; i++) vectors.push(new Array(ENV.EMBED_DIM).fill(0));
  }
  const chunkPoints = raw.map((c, i) => ({
    id: chunkIdFor(docId, i),
    vector: vectors[i]!,
    payload: {
      kind: 'chunk', docId, index: i, docName: existing.payload.name, section: c.section,
      startLine: c.startLine, endLine: c.endLine, startChar: c.startChar, endChar: c.endChar,
      text: c.text, summary: null, summaryAt: null, source: existing.payload.source,
      addedAt: existing.payload.addedAt,
    } satisfies ChunkPayload,
  }));
  await upsertPoints(COLLECTION_CHUNKS, chunkPoints);

  const newDocPayload: DocPayload = {
    ...existing.payload,
    size: trimmed.length,
    text: trimmed,
    confluenceVersion: meta.confluenceVersion ?? existing.payload.confluenceVersion ?? null,
    syncedAt: meta.syncedAt ?? Date.now(),
  };
  await upsertPoints(COLLECTION_DOCS, [{ id: docId, vector: [0], payload: newDocPayload as unknown as Record<string, unknown> }]);
}

export async function removeDoc(docId: string): Promise<boolean> {
  const doc = await getDoc(docId);
  if (!doc) return false;
  await deleteByFilter(COLLECTION_CHUNKS, { must: [{ key: 'docId', match: { value: docId } }] });
  await deletePoints(COLLECTION_DOCS, [docId]);
  return true;
}

export async function clearAll(): Promise<void> {
  await dropCollection(COLLECTION_CHUNKS);
  await dropCollection(COLLECTION_DOCS);
  payloadIndexEnsured = false;
  await ensureCollections();
}

/**
 * 导出全库为备份条目列表：每篇文档取全文 + 每块的蒸馏知识点。
 * 清空前调用此函数写出 JSON 快照；恢复时直接把 summary 写回，省一轮 LLM 调用。
 */
export async function exportForBackup(): Promise<{ name: string; text: string; source: string; summaries: (string | null)[] }[]> {
  const docs = await scrollAll<DocPayload>(COLLECTION_DOCS, null);
  const out: { name: string; text: string; source: string; summaries: (string | null)[] }[] = [];
  for (const d of docs) {
    const chunks = await scrollAll<ChunkPayload>(COLLECTION_CHUNKS, { must: [{ key: 'docId', match: { value: d.id } }] });
    chunks.sort((a, b) => a.payload.index - b.payload.index);
    out.push({
      name: d.payload.name,
      text: d.payload.text,
      source: d.payload.source,
      summaries: chunks.map((c) => c.payload.summary),
    });
  }
  return out;
}

export async function listChunks(docId: string): Promise<ChunkPayload[] | null> {
  const doc = await getDoc(docId);
  if (!doc) return null;
  const pts = await scrollAll<ChunkPayload>(COLLECTION_CHUNKS, { must: [{ key: 'docId', match: { value: docId } }] });
  const sorted = pts.map((p) => p.payload).sort((a, b) => a.index - b.index);
  return sorted;
}

/** 写入某块的知识点（蒸馏结果） */
export async function setChunkSummary(docId: string, index: number, summary: string): Promise<ChunkPayload | null> {
  const pts = await scrollAll<ChunkPayload>(
    COLLECTION_CHUNKS,
    { must: [{ key: 'docId', match: { value: docId } }] },
  );
  const target = pts.find((p) => p.payload.index === index);
  if (!target) return null;
  await fetch(`${ENV.QDRANT_URL}/collections/${COLLECTION_CHUNKS}/points/payload?wait=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      payload: { summary, summaryAt: Date.now() },
      points: [target.id],
    }),
  });
  // 重新嵌入该块（summary 参与向量输入）
  if (embedReady()) {
    const vec = (await embed([embedInputFor(target.payload.text, summary)]))[0]!;
    await fetch(`${ENV.QDRANT_URL}/collections/${COLLECTION_CHUNKS}/points`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points: [{ id: target.id, vector: vec }] }),
    });
  }
  return { ...target.payload, summary, summaryAt: Date.now() };
}

export async function getStats(): Promise<KbStats> {
  const docs = await listDocs();
  const totalChunks = docs.reduce((s, d) => s + d.chunkCount, 0);
  const distilled = docs.reduce((s, d) => s + d.distilled, 0);
  const totalChars = docs.reduce((s, d) => s + d.size, 0);
  const bySource: KbStats['bySource'] = {};
  for (const d of docs) {
    const k = d.source || 'unknown';
    (bySource[k] = bySource[k] || { count: 0, chars: 0, chunks: 0 });
    bySource[k]!.count++;
    bySource[k]!.chars += d.size;
    bySource[k]!.chunks += d.chunkCount;
  }
  return { docCount: docs.length, totalChars, totalChunks, distilled, bySource };
}

/** 业务错误（带 HTTP 状态码） */
export class KbError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
