/* ============================================================
   server/embeddings.ts —— 嵌入客户端（OpenAI 兼容 /v1/embeddings）
   bge-m3 输入上限 8192 token：chunk ≤760 字 + summary ≤1000 字，远在内。

   v2.10 增嵌入向量缓存（A3）：
   - 按 sha256(EMBED_MODEL + '\n' + text) 缓存向量到 Qdrant kqa_embed_cache
     （伪向量 size 1 collection，payload 存 vector 数组 + dim）。
   - distill 只改 summary 不改 text 时，text 部分的向量可直接复用；
     重导同名文档 / 恢复备份时不重复调嵌入网关。
   - 查询未命中才调网关；写回是异步 fire-and-forget，不阻塞主路径。
   - 缓存键含 model 与 dim——换模型自动失效（不会拿旧模型的向量混用）。
   ============================================================ */
import { ENV, embedReady } from './env.js';
import { createHash } from 'node:crypto';
import { ensureCollection, upsertPoints, dropCollection } from './qdrant.js';

const EMBED_BATCH = 32;
/** 嵌入缓存 collection（伪向量存 payload.vector） */
const COLLECTION_EMBED_CACHE = 'kqa_embed_cache';
/** 单 collection 缓存条数上限：超过时整体清空（LRU 粗近似，避免无限膨胀） */
const EMBED_CACHE_MAX = 20000;

let cacheEnsured = false;
async function ensureCacheCollection(): Promise<void> {
  if (cacheEnsured) return;
  await ensureCollection(COLLECTION_EMBED_CACHE, 1);
  cacheEnsured = true;
}

/** 缓存 key：sha256(model + '\n' + text) → hex（Qdrant point id 用 UUIDv5 派生） */
function cacheKey(text: string): string {
  return createHash('sha256').update(`${ENV.EMBED_MODEL}\n${text}`).digest('hex');
}

/** 从 sha256 key 确定性派生 UUID 形态 id（Qdrant 要求 UUID/uint；幂等：同 text 同 id） */
function uuidFromKey(key: string): string {
  // 用 sha256 首 16 字节拼成 UUID 形态（确定性、幂等）
  const bytes = Buffer.from(key, 'hex').subarray(0, 16);
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

async function cacheGet(text: string): Promise<number[] | null> {
  try {
    await ensureCacheCollection();
    const id = uuidFromKey(cacheKey(text));
    const res = await fetch(`${ENV.QDRANT_URL}/collections/${COLLECTION_EMBED_CACHE}/points`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id], with_payload: true }),
    });
    if (!res.ok) return null;
    const body: any = await res.json();
    const p = body?.result?.[0];
    if (!p?.payload?.vector) return null;
    const v = p.payload.vector as number[];
    if (v.length !== ENV.EMBED_DIM) return null;  // dim 变了（换配置）视作未命中
    return v;
  } catch {
    return null;  // 缓存故障不阻塞主路径
  }
}

async function cachePut(text: string, vector: number[]): Promise<void> {
  try {
    await ensureCacheCollection();
    const id = uuidFromKey(cacheKey(text));
    // 条数上限：超过则整体清（vectors 是大数组，存 20000 条已不小）
    const cnt = await fetch(`${ENV.QDRANT_URL}/collections/${COLLECTION_EMBED_CACHE}/points/count`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exact: true }),
    }).then((r) => r.json()).catch(() => null) as { result?: { count?: number } } | null;
    if (cnt?.result?.count && cnt.result.count > EMBED_CACHE_MAX) {
      await dropCollection(COLLECTION_EMBED_CACHE);
      cacheEnsured = false;
      await ensureCacheCollection();
    }
    await upsertPoints(COLLECTION_EMBED_CACHE, [{
      id,
      vector: [0],   // 伪向量（payload 才是真内容）
      payload: { kind: 'embed-cache', text: text.slice(0, 100), vector },
    }]);
  } catch {
    // 缓存写失败静默——不影响正确性，只是下次还得调网关
  }
}

/** 清空嵌入缓存（clearAll 时调用，注意别把 vector 数据一起删——不过 clearAll 连 chunks 都删了，一并清） */
export async function invalidateEmbedCache(): Promise<void> {
  try {
    await dropCollection(COLLECTION_EMBED_CACHE);
    cacheEnsured = false;
  } catch { /* 不存在即无事 */ }
}

/** 带缓存的批量嵌入：先查缓存，未命中的分批调网关，结果异步写回。
 *  返回与 input 等长的向量数组（顺序保持）。 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (!embedReady()) throw new Error('服务端未配置嵌入模型（EMBED_BASE_URL / EMBED_MODEL）');
  const out: number[][] = new Array(texts.length).fill(null);
  const missIdx: number[] = [];
  for (let i = 0; i < texts.length; i++) {
    const cached = await cacheGet(texts[i]!);
    if (cached) out[i] = cached;
    else missIdx.push(i);
  }
  // 未命中的分批调网关
  for (let b = 0; b < missIdx.length; b += EMBED_BATCH) {
    const batchIdx = missIdx.slice(b, b + EMBED_BATCH);
    const batchTexts = batchIdx.map((i) => texts[i]!);
    const vecs = await embedBatch(batchTexts);
    for (let k = 0; k < batchIdx.length; k++) {
      out[batchIdx[k]!] = vecs[k]!;
      void cachePut(batchTexts[k]!, vecs[k]!);   // 异步写回，不阻塞
    }
  }
  return out as number[][];
}

async function embedBatch(batch: string[]): Promise<number[][]> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${ENV.EMBED_BASE_URL}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(ENV.EMBED_API_KEY ? { Authorization: `Bearer ${ENV.EMBED_API_KEY}` } : {}),
        },
        body: JSON.stringify({ model: ENV.EMBED_MODEL, input: batch }),
      });
      if (!res.ok) throw new Error(`嵌入接口返回 ${res.status}`);
      const data = (await res.json()) as {
        data: { embedding: number[]; index: number }[];
      };
      const vecs = (data.data || []).sort((a, b) => a.index - b.index).map((d) => d.embedding);
      if (vecs.length !== batch.length) throw new Error(`嵌入返回 ${vecs.length} 条，期望 ${batch.length}`);
      for (const v of vecs) {
        if (v.length !== ENV.EMBED_DIM) {
          throw new Error(`嵌入维度 ${v.length} 与配置 EMBED_DIM=${ENV.EMBED_DIM} 不符`);
        }
      }
      return vecs;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`嵌入失败：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

/** 嵌入单条（chunk 入库/更新用）：text + summary 拼接，与 BM25 索引口径一致 */
export function embedInputFor(text: string, summary: string | null): string {
  return summary ? `${text}\n${summary}` : text;
}

