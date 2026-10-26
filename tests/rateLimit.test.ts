/* ============================================================
   tests/rateLimit.test.ts —— 用户限流单测
   §RL-1 每小时计数：超限后拒绝
   §RL-2 并发上限：inflight 达到 burst 后拒绝
   注意：vitest 同 worker 会缓存已加载的 env 模块（其他测试文件先加载过
   env 且未设 RATE_LIMIT_*），用 vi.resetModules() 强制重新加载本模块链。
   ============================================================ */
import { describe, it, expect, vi } from 'vitest';

process.env.RATE_LIMIT_PER_HOUR = '3';
process.env.RATE_LIMIT_BURST = '100';  // burst 放大——单测重点测每小时窗口（并发在 RL-2 单独验证）

vi.resetModules();
const { checkRateLimit, releaseInflight, rateLimitActive } = await import('../src/server/rateLimit.js');

describe('§RL-1 每小时计数', () => {
  it('超限后拒绝', () => {
    expect(rateLimitActive()).toBe(true);
    // 测试前重置（模块级 buckets 是私有的——用同 user 递增 3 次后第 4 次拒）
    const user = 'rl-user-1@test';
    // 清理：先用不同 user
    const u = `rl-${Date.now()}-${Math.random()}`;
    expect(checkRateLimit(u).ok).toBe(true);   // 1
    expect(checkRateLimit(u).ok).toBe(true);   // 2
    expect(checkRateLimit(u).ok).toBe(true);   // 3（达上限）
    const r = checkRateLimit(u);               // 4 → 拒
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('上限');
  });
});

describe('§RL-2 并发上限', () => {
  it('inflight 达 burst 后拒绝（重载模块带小 burst）', async () => {
    // 重新加载一份小 burst 的实例（前一份 burst=100 不触发）
    process.env.RATE_LIMIT_PER_HOUR = '0';   // 关闭 hourly，只测 burst
    process.env.RATE_LIMIT_BURST = '2';
    vi.resetModules();
    const m2 = await import('../src/server/rateLimit.js');
    const u = `burst-${Date.now()}-${Math.random()}`;
    expect(m2.checkRateLimit(u).ok).toBe(true);
    expect(m2.checkRateLimit(u).ok).toBe(true);   // burst=2 占满
    const r = m2.checkRateLimit(u);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('并发');
    m2.releaseInflight(u);
    expect(m2.checkRateLimit(u).ok).toBe(true);   // 释放后可再入
  });
});
