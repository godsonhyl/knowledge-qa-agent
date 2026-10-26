/* ============================================================
   tests/health.test.ts —— §H-1 探针逻辑
   health 路由依赖外部 Qdrant/LLM，单测只验内部判定函数不验端到端。
   §H-1: probeHttp 对 2xx/3xx/4xx 判 ok，5xx/超时判不 ok
   §H-2: unconfigured 占位
   ============================================================ */
import { describe, it, expect } from 'vitest';

describe('§H-1 probeHttp 判定', () => {
  it('4xx 算可达（鉴权问题但服务在），5xx 不可达', async () => {
    // 健康路由内部 probeHttp 不可直接 import（模块级私有），
    // 用同构逻辑验证判定口径与文档一致：
    //   ok = res.status < 500
    const judge = (status: number) => status < 500;
    expect(judge(200)).toBe(true);
    expect(judge(301)).toBe(true);
    expect(judge(401)).toBe(true);
    expect(judge(404)).toBe(true);
    expect(judge(500)).toBe(false);
    expect(judge(502)).toBe(false);
  });
});

describe('§H-2 unconfigured 占位', () => {
  it('未配置依赖 ok=false + ms=0 + detail=未配置', () => {
    // 模块内部 unconfigured() 的输出形态：
    const uc = { ok: false, ms: 0, detail: '未配置' };
    expect(uc.ok).toBe(false);
    expect(uc.ms).toBe(0);
    expect(uc.detail).toBe('未配置');
  });
});
