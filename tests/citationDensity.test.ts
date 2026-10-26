/* ============================================================
   tests/citationDensity.test.ts —— §CD-1 引用密度校验
   A1 引用密度校验：把答案按句切，统计无引用句比例。
   - 句末标点（。！？.!?）或换行切句
   - citationGap = citedSentenceCount / sentenceCount（带引用句占比，越低越警告）
   - > 0.4（即带引用句 < 60%）时前端挂软警告
   与现有 factCheck 兼容：unsupported 仍只抓硬事实。
   ============================================================ */
import { describe, it, expect } from 'vitest';
import { verifyFacts, splitSentences } from '../src/web/factCheck.js';

describe('§CD-1 引用密度校验', () => {
  it('全部句子带引用 → citationGap=1（不警告）', () => {
    const ans = '系统部署在 10.0.0.1 [1]。撮合延迟约 10 微秒 [2]。自成交检查每周执行 [1]。';
    const r = verifyFacts(ans, ['正文说 10.0.0.1 与 10 微秒']);
    expect(r.sentenceCount).toBe(3);
    expect(r.citedSentenceCount).toBe(3);
    expect(r.citationGap).toBe(1);
    expect(r.unsupported).toEqual([]);
  });

  it('多数句子无引用 → citationGap < 0.6（前端会挂软警告）', () => {
    const ans = '系统部署在 10.0.0.1 [1]。撮合引擎采用订单簿驱动。撮合延迟约 10 微秒 [2]。清算 T+1。风控实时。';
    const r = verifyFacts(ans, ['正文说 10.0.0.1 与 10 微秒']);
    expect(r.sentenceCount).toBe(5);
    expect(r.citedSentenceCount).toBe(2);
    expect(r.citationGap).toBeCloseTo(0.4, 1);
  });

  it('整段散文零引用 → citationGap=0', () => {
    const ans = '系统部署在中心机房。撮合引擎采用订单簿驱动。清算 T+1。';
    const r = verifyFacts(ans, ['无关正文']);
    expect(r.citedSentenceCount).toBe(0);
    expect(r.citationGap).toBe(0);
  });

  it('splitSentences 按句末标点与换行切', () => {
    const s = splitSentences('第一句。第二句！第三句？\n第四句');
    expect(s.length).toBe(4);
    expect(s[0]).toBe('第一句。');
    expect(s[3]).toBe('第四句');
  });

  it('引用密度不影响 unsupported（硬事实仍照常校验）', () => {
    const ans = '部署在 192.168.99.99 [1] 但端口 9999 没标 [2]。';
    const r = verifyFacts(ans, ['片段里没这两个值']);
    expect(r.unsupported).toContain('192.168.99.99');
    expect(r.unsupported).toContain('9999');
  });
});
