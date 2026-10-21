/* ============================================================
   server/distillJob.ts —— 后台全库批量蒸馏任务
   触发：POST /api/kb/distill-all（管理员令牌）
   进度：GET /api/kb/distill-status
   中断：POST /api/kb/distill-stop（管理员令牌）
   特点：
   - 单任务串行，同一时刻只跑一个批量蒸馏任务（避免打爆 LLM 网关）
   - 已蒸馏的 chunk 跳过（断点续做）
   - 进度实时更新到内存（前端轮询 GET status）
   - 中断通过 abort flag，已处理的块不回滚
   ============================================================ */
import { listDocs, listChunks, type ChunkPayload } from './kbStore.js';
import { distillChunkInto } from './distill.js';

export interface DistillJobState {
  running: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  total: number;          // 待蒸馏 + 已完成 的 chunk 总数
  done: number;           // 本轮成功蒸馏
  skipped: number;        // 已有 summary 跳过
  failed: number;
  current: string | null; // 当前正在处理的「docName#index」
  lastError: string | null;
  aborted: boolean;
}

const initial: DistillJobState = {
  running: false, startedAt: null, finishedAt: null,
  total: 0, done: 0, skipped: 0, failed: 0,
  current: null, lastError: null, aborted: false,
};

export const distillJob: DistillJobState = { ...initial };

let abortFlag = false;

/** 启动一个批量蒸馏任务。已在跑则拒绝。 */
export async function startDistillJob(): Promise<{ started: boolean; reason?: string }> {
  if (distillJob.running) return { started: false, reason: '已有批量蒸馏任务在运行' };
  // 重置状态
  Object.assign(distillJob, { ...initial, running: true, startedAt: Date.now() });
  abortFlag = false;

  // 不 await：后台跑，立即返回给客户端
  void runDistillJob().catch((err) => {
    distillJob.lastError = String((err as Error)?.message || err);
    distillJob.running = false;
    distillJob.finishedAt = Date.now();
  });
  return { started: true };
}

export function stopDistillJob(): void {
  abortFlag = true;
}

async function runDistillJob(): Promise<void> {
  const docs = await listDocs();
  let total = 0;
  for (const d of docs) total += d.chunkCount - d.distilled;  // 未蒸馏的
  // total 只算未蒸馏的；done/skipped/failed 单独累计
  distillJob.total = total;

  for (const d of docs) {
    if (abortFlag) break;
    const chunks: ChunkPayload[] | null = await listChunks(d.docId);
    if (!chunks) continue;
    for (const c of chunks) {
      if (abortFlag) break;
      if (c.summary && c.summary.trim()) {
        distillJob.skipped++;
        continue;
      }
      distillJob.current = `${d.name}#${c.index}`;
      try {
        await distillChunkInto(d.docId, c.index, c);
        distillJob.done++;
      } catch (err) {
        distillJob.failed++;
        distillJob.lastError = String((err as Error)?.message || err);
        // 单块失败不中断整体，继续下一块
      }
    }
  }

  distillJob.running = false;
  distillJob.finishedAt = Date.now();
  distillJob.current = null;
  distillJob.aborted = abortFlag;
}
