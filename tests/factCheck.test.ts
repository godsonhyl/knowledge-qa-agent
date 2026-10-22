/* ============================================================
   tests/factCheck.test.ts —— 事实抽验逻辑
   §FC-1 答案数字在原文中 → 无警告
   §FC-2 答案 IP 原文没有 → 挂警告
   §FC-3 版本号主段匹配即豁免
   §FC-4 引用标记本身不算事实
   ============================================================ */
import { describe, it, expect } from 'vitest';
import { verifyFacts } from '../src/web/factCheck.js';

describe('factCheck 事实抽验', () => {
  it('§FC-1 答案数字在原文中存在 → 无警告', () => {
    const r = verifyFacts('撮合延迟典型 10 微秒 [1]', ['正文说耗时控制在 10 微秒']);
    expect(r.unsupported).toEqual([]);
  });

  it('§FC-2 答案 IP 原文没有 → 挂警告', () => {
    const r = verifyFacts('部署在 192.168.99.99 [1]', ['正文根本没有这个地址']);
    expect(r.unsupported).toContain('192.168.99.99');
  });

  it('§FC-3 版本号主段匹配即豁免', () => {
    const r = verifyFacts('v1.30.3 已发布 [1]', ['文档记录 v1.30 系列已发布']);
    expect(r.unsupported).toEqual([]);
  });

  it('§FC-4 答案数值来自未引用片段 → 仍算无依据（只看被引用的）', () => {
    const r = verifyFacts('端口 9021 [1]', ['片段一没有端口']);
    expect(r.unsupported).toContain('9021');
  });
});
