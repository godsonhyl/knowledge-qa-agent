/* ============================================================
   server/rateLimit.ts —— 用户配额/限流（进程内存级）
   OIDC_REQUIRED=1 时生效；未配置上限（RATE_LIMIT_PER_HOUR=0）则不限流。
   两条限流：
   - 每小时问答次数（RATE_LIMIT_PER_HOUR）：滑动窗口计数，超限返回 429
   - 并发数（RATE_LIMIT_BURST）：正在进行的 /api/chat + /api/kb/search 请求数
   进程内存级（重启归零），不依赖外部存储——单实例够用。
   ============================================================ */
import { ENV } from './env.js';

interface UserBucket {
  /** 每小时窗口内已用次数 */
  count: number;
  /** 当前窗口起始时间（ms） */
  windowStart: number;
}

const buckets = new Map<string, UserBucket>();
/** 当前并发中的请求数（按用户） */
const inflight = new Map<string, number>();
const HOUR_MS = 60 * 60 * 1000;

/** 检查是否允许该请求通过。返回 {ok, retryAfterSec?}。
 *  通过后自动计入计数（hourly + inflight）。
 *  调用方在请求结束时必须调 releaseInflight()。 */
export function checkRateLimit(userSub: string): { ok: true } | { ok: false; retryAfterSec: number; reason: string } {
  const perHour = ENV.RATE_LIMIT_PER_HOUR;
  const burst = ENV.RATE_LIMIT_BURST;
  if (perHour <= 0 && burst <= 0) return { ok: true };

  // 并发检查
  if (burst > 0) {
    const cur = inflight.get(userSub) || 0;
    if (cur >= burst) {
      return { ok: false, retryAfterSec: 5, reason: `并发请求数已达上限（${burst}），请稍后重试` };
    }
  }

  // 每小时次数检查
  if (perHour > 0) {
    const now = Date.now();
    let b = buckets.get(userSub);
    if (!b || now - b.windowStart >= HOUR_MS) {
      b = { count: 0, windowStart: now };
      buckets.set(userSub, b);
    }
    if (b.count >= perHour) {
      const retryAfterSec = Math.ceil((b.windowStart + HOUR_MS - now) / 1000);
      return { ok: false, retryAfterSec, reason: `本小时提问次数已达上限（${perHour}次），${Math.ceil(retryAfterSec / 60)}分钟后重置` };
    }
    b.count++;
  }

  // 计入并发
  if (burst > 0) inflight.set(userSub, (inflight.get(userSub) || 0) + 1);
  return { ok: true };
}

/** 请求结束后释放并发计数（hourly 不退——已消耗的次数不退） */
export function releaseInflight(userSub: string): void {
  if (ENV.RATE_LIMIT_BURST <= 0) return;
  const cur = inflight.get(userSub) || 0;
  if (cur <= 1) inflight.delete(userSub);
  else inflight.set(userSub, cur - 1);
}

/** 是否启用限流 */
export function rateLimitActive(): boolean {
  return ENV.RATE_LIMIT_PER_HOUR > 0 || ENV.RATE_LIMIT_BURST > 0;
}
