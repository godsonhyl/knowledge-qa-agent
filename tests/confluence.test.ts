import { describe, it, expect } from 'vitest';
import { validateCitations } from '@web/citations.js';
import { parseConfluenceUrl, confluenceStorageToText } from '@server/confluence.js';

/* 移植 selftest §11 Confluence URL 解析 + 引用校验 */

describe('Confluence URL 解析', () => {
  const samples: [string, string][] = [
    ['https://sh-gds-wiki0.jinde.local/pages/viewpage.action?pageId=16908293', '16908293'],
    ['https://wiki.example.com/pages/viewpage.action?pageId=123&spaceKey=DEV', '123'],
    ['https://wiki.example.com/pages/123', '123'],
    ['https://wiki.example.com/rest/api/content/456', '456'],
  ];
  it('识别全部 4 种形式', () => {
    for (const [url, expectId] of samples) {
      const r = parseConfluenceUrl(url);
      expect(r?.pageId, url).toBe(expectId);
    }
  });
  it('非 http(s) 拒绝', () => {
    expect(parseConfluenceUrl('ftp://x/pageId=1')).toBeNull();
  });
  it('无 pageId 拒绝', () => {
    expect(parseConfluenceUrl('https://wiki.example.com/some/other/path')).toBeNull();
  });
});

describe('Confluence storage → 纯文本', () => {
  const sample = '<h1>智能机器人</h1><p>机器人支持 <a href="x">回调</a> 与自动回复。</p><ul><li>webhook 地址</li><li>关键词回复</li></ul><table><tr><td>A1</td><td>B1</td></tr></table>';
  const text = confluenceStorageToText(sample);
  it('保留内容', () => {
    expect(text).toContain('智能机器人');
    expect(text).toContain('回调');
    expect(text).toContain('关键词回复');
  });
  it('表格转管道分隔', () => {
    expect(text).toMatch(/\|/);
    expect(text).toContain('A1');
  });
  it('剥离全部 HTML 标签', () => {
    expect(text).not.toMatch(/<[a-z]+/i);
  });
});

describe('引用编号校验（防幻觉契约）', () => {
  it('范围内的编号被收集', () => {
    const { used } = validateCitations('延迟典型范围见 [1]，P99 见 [2][3]', 3);
    expect(Array.from(used).sort()).toEqual([1, 2, 3]);
  });
  it('超出范围的编号不算引用', () => {
    const { used } = validateCitations('看 [5] 和 [99]', 3);
    expect(used.size).toBe(0);
  });
  it('无引用时 used 为空（触发警告）', () => {
    const { used } = validateCitations('没有任何编号', 3);
    expect(used.size).toBe(0);
  });
});
