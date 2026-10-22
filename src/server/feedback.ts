/* ============================================================
   server/feedback.ts —— 问答反馈（👍/👎）持久化
   存 Qdrant kqa_feedback（伪向量 size 1）：
   question / hits 摘要 / answer 摘录 / feedback(up/down) / ts / convId。
   用于检索调优：负样本 → 看是拒答误判（应命中未命中）还是排序问题。
   ============================================================ */
import { uuidv4 } from './ids.js';
import { ensureCollection, scrollAll, upsertPoints, deletePoints } from './qdrant.js';

export const COLLECTION_FEEDBACK = 'kqa_feedback';

export interface FeedbackPayload {
  kind: 'feedback';
  question: string;
  /** 回答正文的摘录（前 500 字） */
  answerExcerpt: string;
  /** 检索命中的文档名列表（截 5 个），用于分析"命中质量" */
  hitDocs: string[];
  /** up | down */
  feedback: 'up' | 'down';
  /** 拒答 / 兜底 / 正常 */
  mode: string;
  convId: string | null;
  ts: number;
}

export async function ensureFeedbackCollection(): Promise<void> {
  await ensureCollection(COLLECTION_FEEDBACK, 1);
}

export async function addFeedback(p: Omit<FeedbackPayload, 'kind' | 'ts'>): Promise<string> {
  const id = uuidv4();
  const payload: FeedbackPayload = { ...p, kind: 'feedback', ts: Date.now() };
  await upsertPoints(COLLECTION_FEEDBACK, [{ id, vector: [0], payload: payload as any }]);
  return id;
}

export async function listFeedback(limit = 100): Promise<{ id: string; payload: FeedbackPayload }[]> {
  const pts = await scrollAll<FeedbackPayload>(COLLECTION_FEEDBACK, null);
  const out = pts.map((p) => ({ id: p.id, payload: p.payload as FeedbackPayload }));
  // 最新在前，截 limit
  out.sort((a, b) => (b.payload.ts || 0) - (a.payload.ts || 0));
  // 删除 max 500 条之外的最旧记录（防无限膨胀）
  if (out.length > 500) {
    const toDelete = out.slice(500).map((x) => x.id);
    await deletePoints(COLLECTION_FEEDBACK, toDelete);
  }
  return out.slice(0, limit);
}

export async function removeFeedback(id: string): Promise<void> {
  await deletePoints(COLLECTION_FEEDBACK, [id]);
}
