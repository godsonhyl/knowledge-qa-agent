/* ============================================================
   server/qdrant.ts —— Qdrant REST 客户端（fetch 封装，不引 SDK）
   ============================================================ */
import { ENV } from './env.js';

export interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface ScrollResult {
  points: (QdrantPoint & { payload: any })[];
  next_page_offset?: unknown;
}

async function qdrantFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${ENV.QDRANT_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    signal: init?.signal ?? undefined,
  });
  return res;
}

async function qdrantJson<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await qdrantFetch(path, init);
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok && body?.status?.error) {
    throw new Error(`Qdrant ${res.status}: ${String(body.status.error).slice(0, 200)}`);
  }
  return { status: res.status, body: body as T };
}

/**
 * 确保 collection 存在；不存在则按 schema 创建。
 * Qdrant 容器可能比 app 后起来（连接层失败）—— 30 × 2s 重试。
 * 注意：GET 返回 404 表示「collection 不存在」→ PUT 创建，这不是错误。
 * 我们的 qdrantJson 在 body 带 error 时 throw——所以这里单独处理 404。
 */
export async function ensureCollection(name: string, dim: number): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${ENV.QDRANT_URL}/collections/${name}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.status === 200) return;                         // 已存在
      if (res.status === 404) {
        // 不存在 → 创建
        const put = await fetch(`${ENV.QDRANT_URL}/collections/${name}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vectors: { size: dim, distance: 'Cosine' } }),
        });
        if (!put.ok) {
          throw new Error(`创建 collection ${name} 失败：${put.status}`);
        }
        return;
      }
      throw new Error(`unexpected status ${res.status}`);
    } catch (err) {
      if (attempt >= 30) throw err;
      // 连接失败（Qdrant 未起）或创建失败 → 等 2s 重试
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/** 创建 payload 字段索引（幂等） */
export async function ensurePayloadIndex(name: string, fields: string[]): Promise<void> {
  try {
    await qdrantJson(`/collections/${name}/index`, {
      method: 'PUT',
      body: JSON.stringify({
        field_map: Object.fromEntries(fields.map((f) => [f, { type: 'keyword' }])),
      }),
    });
  } catch {
    // 索引失败不阻塞主流程（老版本 Qdrant 字段映射语法兼容问题）
  }
}

export async function upsertPoints(name: string, points: QdrantPoint[]): Promise<void> {
  await qdrantJson(`/collections/${name}/points?wait=true`, {
    method: 'PUT',
    body: JSON.stringify({ points }),
  });
}

/** 按 filter 滚动（分页）。projection 排除大字段。 */
export async function scrollAll<T = any>(
  name: string,
  filter: Record<string, unknown> | null,
  include?: string[],
): Promise<{ id: string; payload: T }[]> {
  const out: { id: string; payload: T }[] = [];
  let offset: unknown = undefined;
  for (;;) {
    const body: Record<string, unknown> = {
      limit: 100,
      with_payload: include ? { include } : true,
      ...(filter ? { filter } : {}),
      ...(offset !== undefined ? { offset } : {}),
    };
    const { body: r } = await qdrantJson<{ result: ScrollResult }>(`/collections/${name}/points/scroll`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const sc = r?.result;
    for (const p of sc?.points || []) {
      out.push({ id: String(p.id), payload: p.payload as T });
    }
    if (sc?.next_page_offset === undefined || sc?.next_page_offset === null) break;
    offset = sc.next_page_offset;
  }
  return out;
}

export async function searchPoints(
  name: string,
  vector: number[],
  limit: number,
  filter?: Record<string, unknown>,
): Promise<{ id: string; score: number; payload: any }[]> {
  const { body } = await qdrantJson<{ result: { id: string; score: number; payload: any }[] }>(
    `/collections/${name}/points/search`,
    {
      method: 'POST',
      body: JSON.stringify({ vector, limit, with_payload: true, ...(filter ? { filter } : {}) }),
    },
  );
  return body.result || [];
}

/** 构造知识库分组过滤条件：按 docName 前缀或 source 收窄向量检索 */
export function buildGroupFilter(docNamePrefix?: string | null, source?: string | null): Record<string, unknown> | undefined {
  const must: Record<string, unknown>[] = [];
  if (docNamePrefix) {
    // docName 前缀匹配：Qdrant 用 match.prefix（payload 索引为 keyword）
    must.push({ key: 'docName', match: { prefix: docNamePrefix } });
  }
  if (source) {
    must.push({ key: 'source', match: { value: source } });
  }
  if (!must.length) return undefined;
  return { must };
}

export async function deleteByFilter(name: string, filter: Record<string, unknown>): Promise<void> {
  await qdrantJson(`/collections/${name}/points/delete?wait=true`, {
    method: 'POST',
    body: JSON.stringify({ filter }),
  });
}

export async function deletePoints(name: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await qdrantJson(`/collections/${name}/points/delete?wait=true`, {
    method: 'POST',
    body: JSON.stringify({ points: ids }),
  });
}

export async function countPoints(name: string, filter?: Record<string, unknown>): Promise<number> {
  const { body } = await qdrantJson<{ result: { count: number } }>(
    `/collections/${name}/points/count`,
    { method: 'POST', body: JSON.stringify({ exact: true, ...(filter ? { filter } : {}) }) },
  );
  return body.result?.count ?? 0;
}

export async function dropCollection(name: string): Promise<void> {
  await qdrantJson(`/collections/${name}`, { method: 'DELETE' }).catch(() => undefined);
}
