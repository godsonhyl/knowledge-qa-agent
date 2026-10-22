/* ============================================================
   server/conversations.ts —— 对话历史持久化（Qdrant collection kqa_conversations）
   仿 kqa_docs 用伪向量 size 1；payload 存对话元信息 + 消息列表。
   单条对话消息 = ChatMessage（与前端 DTO 同形，含 hits/search 等）。
   localStorage 仅作为离线缓存/快速恢复，真相在服务端。
   ============================================================ */
import { ENV } from './env.js';
import { uuidv4 } from './ids.js';
import {
  ensureCollection, scrollAll, upsertPoints, deletePoints,
} from './qdrant.js';
import { COLLECTION_CONVS } from './kbStore.js';

export { COLLECTION_CONVS };

export interface ConvMessage {
  id: number;
  role: 'user' | 'bot';
  question?: string;
  text?: string;
  /** 命中的 docId/docName 摘要（避免存 chunk 全文过大；定位走原 chunkId） */
  hitRefs?: { docName: string; section: string; startLine: number; endLine: number }[];
  used?: number[];
  aborted?: boolean;
  fallback?: boolean;
  webAnswer?: boolean;
  modelNote?: string;
  ts: number;
}

export interface ConvPayload {
  kind: 'conv';
  title: string;
  createdAt: number;
  updatedAt: number;
  /** 消息列表（最近 N 条，超长截断最旧的） */
  messages: ConvMessage[];
  /** 是否置顶 */
  pinned?: boolean;
  /** 所有者（OIDC sub 或本地账号 email）；OIDC_REQUIRED=0 时为空（共享） */
  ownerSub?: string;
}

const MAX_MSGS_KEEP = 50;

export async function ensureConvCollection(): Promise<void> {
  await ensureCollection(COLLECTION_CONVS, 1);
}

/** 新建对话（返回 id） */
export async function createConv(title: string, ownerSub?: string): Promise<string> {
  const id = uuidv4();
  const now = Date.now();
  const payload: ConvPayload = {
    kind: 'conv',
    title: title.slice(0, 80) || '新对话',
    createdAt: now,
    updatedAt: now,
    messages: [],
    ownerSub,
  };
  await upsertPoints(COLLECTION_CONVS, [{ id, vector: [0], payload: payload as any }]);
  return id;
}

/** 列表（按 updatedAt 倒序，pinned 在前）。
 *  ownerSub 非空时按所有者过滤（OIDC_REQUIRED 模式下隔离对话历史）。 */
export async function listConvs(ownerSub?: string): Promise<{ id: string; payload: ConvPayload }[]> {
  const filter = ownerSub ? { must: [{ key: 'ownerSub', match: { value: ownerSub } }] } : null;
  const pts = await scrollAll<ConvPayload>(COLLECTION_CONVS, filter, ['kind', 'title', 'createdAt', 'updatedAt', 'pinned', 'ownerSub']);
  const out = pts.map((p) => ({ id: p.id, payload: p.payload as ConvPayload }));
  out.sort((a, b) => {
    const pa = a.payload.pinned ? 1 : 0;
    const pb = b.payload.pinned ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return (b.payload.updatedAt || 0) - (a.payload.updatedAt || 0);
  });
  return out;
}

/** 用 point id 直接取（scrollAll 的 filter 是 payload 过滤，id 是 point 主键不在 payload 里） */
export async function getConv(id: string): Promise<ConvPayload | null> {
  try {
    const res = await fetch(`${ENV.QDRANT_URL}/collections/${COLLECTION_CONVS}/points/${encodeURIComponent(id)}`, {
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) return null;
    const body: any = await res.json().catch(() => null);
    const pt = body?.result;
    return pt?.payload ? (pt.payload as ConvPayload) : null;
  } catch {
    return null;
  }
}

/** 更新对话（payload 覆盖） */
export async function saveConv(id: string, payload: ConvPayload): Promise<void> {
  payload.updatedAt = Date.now();
  payload.messages = payload.messages.slice(-MAX_MSGS_KEEP);
  await upsertPoints(COLLECTION_CONVS, [{ id, vector: [0], payload: payload as any }]);
}

/** 删除对话 */
export async function deleteConv(id: string): Promise<boolean> {
  await deletePoints(COLLECTION_CONVS, [id]);
  return true;
}

/** 重命名 */
export async function renameConv(id: string, title: string): Promise<void> {
  const p = await getConv(id);
  if (!p) return;
  p.title = title.slice(0, 80);
  await saveConv(id, p);
}

/** 置顶切换 */
export async function togglePinConv(id: string): Promise<void> {
  const p = await getConv(id);
  if (!p) return;
  p.pinned = !p.pinned;
  await saveConv(id, p);
}
