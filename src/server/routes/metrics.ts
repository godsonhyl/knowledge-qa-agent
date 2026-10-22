/* ============================================================
   server/routes/metrics.ts —— GET /api/metrics
   运行指标（JSON，非 Prometheus 格式——内网轻量观测够用；
   要接 Prometheus 可在此端点做格式转换）。
   进程内存级统计（重启归零），不打外部存储。
   ============================================================ */
import { Hono } from 'hono';
import { kbIndex } from '../kbIndex.js';
import { getStats } from '../kbStore.js';
import { distillJob } from '../distillJob.js';

export const metricsRoute = new Hono();

export interface Metrics {
  uptimeSec: number;
  mem: { rssMb: number; heapUsedMb: number; heapTotalMb: number };
  index: { chunkCount: number; docCount: number; totalChars: number; distilled: number };
  distill: { running: boolean; done: number; failed: number; skipped: number; lastError: string | null };
  http: {
    totalRequests: number;
    searchMsAvg: number;
    searchCount: number;
    refusalRate: number;
  };
}

export const httpStats = {
  total: 0,
  searchMsSum: 0,
  searchCount: 0,
  refusals: 0,
};

export function recordSearch(searchMs: number, hasEvidence: boolean): void {
  httpStats.total++;
  httpStats.searchCount++;
  httpStats.searchMsSum += searchMs;
  if (!hasEvidence) httpStats.refusals++;
}

export function recordRequest(): void {
  httpStats.total++;
}

metricsRoute.get('/', async (c) => {
  const mem = process.memoryUsage();
  let stats = { docCount: 0, totalChars: 0, totalChunks: 0, distilled: 0 };
  try { stats = await getStats(); } catch { /* Qdrant 不可用时置零 */ }
  const m: Metrics = {
    uptimeSec: Math.round(process.uptime()),
    mem: {
      rssMb: +(mem.rss / 1024 / 1024).toFixed(1),
      heapUsedMb: +(mem.heapUsed / 1024 / 1024).toFixed(1),
      heapTotalMb: +(mem.heapTotal / 1024 / 1024).toFixed(1),
    },
    index: {
      chunkCount: kbIndex.chunkCount,
      docCount: stats.docCount,
      totalChars: stats.totalChars,
      distilled: stats.distilled,
    },
    distill: {
      running: !!distillJob?.running,
      done: distillJob?.done || 0,
      failed: distillJob?.failed || 0,
      skipped: distillJob?.skipped || 0,
      lastError: distillJob?.lastError || null,
    },
    http: {
      totalRequests: httpStats.total,
      searchMsAvg: httpStats.searchCount ? Math.round(httpStats.searchMsSum / httpStats.searchCount) : 0,
      searchCount: httpStats.searchCount,
      refusalRate: httpStats.searchCount ? +(httpStats.refusals / httpStats.searchCount).toFixed(3) : 0,
    },
  };
  return c.json(m);
});
