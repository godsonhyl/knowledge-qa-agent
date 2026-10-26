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
    searchMsP95: number;
    searchCount: number;
    refusalRate: number;
    /** 拒答原因聚合（按 reason 分组计数）——区分"库没内容"vs"阈值卡住" */
    reasonCounts: Record<string, number>;
    /** 命中通道聚合：kb 知识库 / market-data 行情直查 */
    channelCounts: Record<string, number>;
    /** 慢查询（>3000ms）样本，最近 N 条，含问题原文供诊断 */
    slowQueries: { ms: number; question: string; reason: string; hasEvidence: boolean; ts: number }[];
  };
}

export const httpStats = {
  total: 0,
  searchMsSum: 0,
  searchCount: 0,
  refusals: 0,
  reasonCounts: {} as Record<string, number>,
  channelCounts: {} as Record<string, number>,
  /** 每次检索的耗时样本（用于 P95/慢查询；保留最近 N 条，进程内存级） */
  latencySamples: [] as { ms: number; question: string; reason: string; hasEvidence: boolean; ts: number }[],
};

/** 慢查询样本保留上限（进程内存级；超过则裁最旧的） */
const LATENCY_SAMPLE_MAX = 200;
/** 慢查询阈值（ms）；超过的样本单独高亮，便于排障 */
const SLOW_THRESHOLD_MS = 3000;

/** 记录一次检索。reason 可选（用于拒答原因聚合）；channel 可选（行情直查 vs 知识库）。
 *  question 可选（用于慢查询诊断：定位是哪个问题慢）。 */
export function recordSearch(searchMs: number, hasEvidence: boolean, reason?: string, channel?: string, question?: string): void {
  httpStats.total++;
  httpStats.searchCount++;
  httpStats.searchMsSum += searchMs;
  if (!hasEvidence) httpStats.refusals++;
  if (reason) httpStats.reasonCounts[reason] = (httpStats.reasonCounts[reason] || 0) + 1;
  if (channel) httpStats.channelCounts[channel] = (httpStats.channelCounts[channel] || 0) + 1;
  // 慢查询样本（截断问题文本避免内存膨胀；超长只留前 100 字）
  if (httpStats.latencySamples.length >= LATENCY_SAMPLE_MAX) httpStats.latencySamples.shift();
  httpStats.latencySamples.push({
    ms: searchMs,
    question: question ? question.slice(0, 100) : '',
    reason: reason || '',
    hasEvidence,
    ts: Date.now(),
  });
}

/** 计算 P95 检索耗时（基于 latencySamples） */
function p95Ms(): number {
  const arr = httpStats.latencySamples.map((s) => s.ms).sort((a, b) => a - b);
  if (!arr.length) return 0;
  const idx = Math.min(arr.length - 1, Math.floor(arr.length * 0.95));
  return arr[idx] ?? 0;
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
      searchMsP95: p95Ms(),
      searchCount: httpStats.searchCount,
      refusalRate: httpStats.searchCount ? +(httpStats.refusals / httpStats.searchCount).toFixed(3) : 0,
      reasonCounts: httpStats.reasonCounts,
      channelCounts: httpStats.channelCounts,
      slowQueries: httpStats.latencySamples
        .filter((s) => s.ms >= SLOW_THRESHOLD_MS)
        .slice(-20)
        .reverse(),
    },
  };
  return c.json(m);
});
