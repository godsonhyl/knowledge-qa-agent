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
      index: p.payload.index,
    }));
    this.chunkCount = this.retriever.build(chunks);
  }

  /** 蒸馏后单块更新（不整库重建） */
  updateChunk(chunkId: string, text: string, summary: string | null, docName?: string): void {
    const idx = this.retriever.index;
    if (!idx) return;
    const i = idx.docs.findIndex((d) => d.chunk.chunkId === chunkId);
    if (i < 0) return;
    // 与 build() 对齐：文档名 + 正文 + 知识点
    const docNamePrefix = docName ? `${docName}\n` : '';
    const textForIndex = `${docNamePrefix}${text}${summary ? '\n' + summary : ''}`;
    const tokens = tokenize(textForIndex);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    idx.docs[i] = { chunk: { chunkId, text, summary, docName }, len: tokens.length || 1, tf };
  }

  /** 增量加入一篇文档的块（不整库重建）：
   *  追加 docs + 逐块累计 df + avgLen 滚动重算。库越大越避免全量 scroll+rebuild。
   *  df 是"含该词的块数"，只增不重算（新增只会加 1），删除时才整表重算。 */
  addDocChunks(chunks: IndexedChunk[]): void {
    const idx = this.retriever.index;
    if (!idx) return;   // 索引未初始化（Qdrant 未起来时先导入了）→ 下次 rebuild 会带上
    let lenSum = idx.avgLen * idx.docs.length;
    for (const chunk of chunks) {
      const docName = chunk.docName ? `${chunk.docName}\n` : '';
      const textForIndex = `${docName}${chunk.text}${chunk.summary ? '\n' + chunk.summary : ''}`;
      const tokens = tokenize(textForIndex);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
      lenSum += tokens.length || 1;
      idx.docs.push({ chunk, len: tokens.length || 1, tf });
      for (const t of tf.keys()) idx.df.set(t, (idx.df.get(t) || 0) + 1);
      // byDocIndex 注册（父块检索用）
      if (chunk.docId != null && chunk.index != null) {
        idx.registerDocIndex(chunk.docId, chunk.index, idx.docs.length - 1);
      }
    }
    idx.avgLen = idx.docs.length ? lenSum / idx.docs.length : 1;
    this.chunkCount = idx.docs.length;
  }

  /** 移除一篇文档的全部块（增量，不整库重建）。
   *  df 重算：删块后"含该词的块数"可能下降，须从剩余 docs 重算一遍（O(全库 token)，
   *  毫秒级——删除是低频操作，且远小于全量 scroll+rebuild 的网络开销）。 */
  removeDocChunks(docId: string): void {
    const idx = this.retriever.index;
    if (!idx) return;
    idx.removeByDocId(docId);
    this.chunkCount = idx.docs.length;
  }
}

export const kbIndex = new KbIndex();
