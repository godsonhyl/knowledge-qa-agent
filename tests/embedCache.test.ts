/* ============================================================
   tests/embedCache.test.ts —— §EC-1 嵌入向量缓存
   A3：sha256(model+text) 派生确定性 UUID，同 text 同 id 幂等命中；
   维度变化视作未命中（换模型自动失效）。
   不调真实嵌入网关 / Qdrant。
   ============================================================ */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';

describe('§EC-1 嵌入缓存 key 派生', () => {
  // 复刻 embeddings.ts 的 cacheKey + uuidFromKey 逻辑（模块内部私有，同构验证）
  function key(text: string, model: string) {
    return createHash('sha256').update(`${model}\n${text}`).digest('hex');
  }
  function uuidFromKey(k: string) {
    const h = Buffer.from(k, 'hex').subarray(0, 16).toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  }

  it('同 text 同 model → 同 UUID（幂等命中）', () => {
    const u1 = uuidFromKey(key('撮合引擎部署在核心机房，延迟控制在 10 微秒内。', 'BAAI/bge-m3'));
    const u2 = uuidFromKey(key('撮合引擎部署在核心机房，延迟控制在 10 微秒内。', 'BAAI/bge-m3'));
    expect(u1).toBe(u2);
    expect(u1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('不同 text → 不同 UUID', () => {
    const u1 = uuidFromKey(key('片段A', 'BAAI/bge-m3'));
    const u2 = uuidFromKey(key('片段B', 'BAAI/bge-m3'));
    expect(u1).not.toBe(u2);
  });

  it('换嵌入模型 → 不同 key（自动失效）', () => {
    const u1 = uuidFromKey(key('同一片段', 'BAAI/bge-m3'));
    const u2 = uuidFromKey(key('同一片段', 'text-embedding-3-small'));
    expect(u1).not.toBe(u2);
  });

  it('embedInputFor：distill 后 text+summary 拼接参与缓存 key（summary 变即未命中）', async () => {
    const { embedInputFor } = await import('../src/server/embeddings.js');
    const t = '正文片段';
    expect(embedInputFor(t, null)).toBe('正文片段');
    expect(embedInputFor(t, '知识点')).toBe('正文片段\n知识点');
    // 同 text 不同 summary → 不同缓存输入 → 各自缓存
    expect(key(embedInputFor(t, '知识点A'), 'BAAI/bge-m3'))
      .not.toBe(key(embedInputFor(t, '知识点B'), 'BAAI/bge-m3'));
  });
});
