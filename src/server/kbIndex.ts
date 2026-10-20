/* ============================================================
   server/kbIndex.ts —— 内存 BM25 索引生命周期
   boot 时从 Qdrant 全量加载；文档增删后整体重建（毫秒级）；
   蒸馏单块增量更新。所有变更走 promise 链队列串行化。
   ============================================================ */
import { Retriever } from './search/retriever.js';
import { tokenize, type IndexedChunk } from './bm25.js';
import { scrollAll as qdrantScrollAll } from './qdrant.js';
import { ensureCollections, COLLECTION_CHUNKS, type ChunkPayload } from './kbStore.js';

export class KbIndex {
  retriever = new Retriever();
  #queue: Promise<unknown> = Promise.resolve();
  chunkCount = 0;

  /** 串行化包装：检索与索引变更不会交错 */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.#queue.then(fn, fn);
    this.#queue = p.catch(() => undefined);
    return p;
  }

  async bootstrap(): Promise<void> {
    await ensureCollections();
    await this.run(() => this.rebuild());
  }

  /** 从 Qdrant 全量加载 chunk 构建 BM25 */
  async rebuild(): Promise<void> {
    const points = await qdrantScrollAll<ChunkPayload>(COLLECTION_CHUNKS, null);
    const chunks: IndexedChunk[] = points.map((p) => ({
      chunkId: p.id,
      text: p.payload.text,
      summary: p.payload.summary ?? null,
      docId: p.payload.docId,
      docName: p.payload.docName,
      section: p.payload.section,
      startLine: p.payload.startLine,
      endLine: p.payload.endLine,
      startChar: p.payload.startChar,
      endChar: p.payload.endChar,
      source: p.payload.source,
      addedAt: p.payload.addedAt,
    }));
    this.chunkCount = this.retriever.build(chunks);
  }

  /** 蒸馏后单块更新（不整库重建） */
  updateChunk(chunkId: string, text: string, summary: string | null): void {
    const idx = this.retriever.index;
    if (!idx) return;
    const i = idx.docs.findIndex((d) => d.chunk.chunkId === chunkId);
    if (i < 0) return;
    const textForIndex = summary ? `${text}\n${summary}` : text;
    const tokens = tokenize(textForIndex);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    idx.docs[i] = { chunk: { chunkId, text, summary }, len: tokens.length || 1, tf };
  }
}

export const kbIndex = new KbIndex();
