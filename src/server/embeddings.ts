/* ============================================================
   server/embeddings.ts —— 嵌入客户端（OpenAI 兼容 /v1/embeddings）
   bge-m3 输入上限 8192 token：chunk ≤760 字 + summary ≤1000 字，远在内。
   ============================================================ */
import { ENV, embedReady } from './env.js';

const EMBED_BATCH = 32;

/**
 * 批量嵌入。返回与 input 等长的向量数组。
 * 失败重试一次；维度不符硬失败（配置错的保护）。
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (!embedReady()) throw new Error('服务端未配置嵌入模型（EMBED_BASE_URL / EMBED_MODEL）');
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    out.push(...(await embedBatch(batch)));
  }
  return out;
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
