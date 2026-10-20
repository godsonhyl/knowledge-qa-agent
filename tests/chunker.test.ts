import { describe, it, expect } from 'vitest';
import { chunkDocument, detectHeading, CHUNK_MAX } from '@server/chunker.js';
import { SEED_DOCS } from '@shared/seed.js';

/* 移植自 selftest.js §2 分块质量 */

describe('detectHeading', () => {
  it('识别 Markdown # 标题', () => {
    expect(detectHeading('# 标题')?.level).toBe(1);
    expect(detectHeading('## 二级')?.level).toBe(2);
    expect(detectHeading('### 1.1 xxx')?.level).toBe(3);
  });
  it('识别中文章节', () => {
    expect(detectHeading('第一章 概述')?.level).toBe(1);
    expect(detectHeading('第二节 说明')?.level).toBe(2);
    expect(detectHeading('一、总则')?.level).toBe(2);
    expect(detectHeading('1.2 具体内容')?.level).toBe(2);
  });
  it('非标题返回 null', () => {
    expect(detectHeading('正文段落内容')).toBeNull();
    expect(detectHeading('')).toBeNull();
    expect(detectHeading('   ')).toBeNull();
  });
});

describe('chunkDocument（移植 selftest §2/§10）', () => {
  it('示例知识库 3 篇文档分块合法', () => {
    for (const d of SEED_DOCS) {
      const chunks = chunkDocument(d.text, d.name);
      expect(chunks.length).toBeGreaterThan(0);
      const hasSection = chunks.some((c) => c.section);
      expect(hasSection).toBe(true);
      const lineCount = d.text.split(/\r?\n/).length;
      for (const c of chunks) {
        expect(c.startLine).toBeGreaterThanOrEqual(1);
        expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
        expect(c.endLine).toBeLessThanOrEqual(lineCount);
        expect(c.text.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('长正文单段分块不崩溃（overlap 路径回归，旧 bufStart 作用域 bug）', () => {
    const longDoc = `# 标题\n\n${'正文内容测试。'.repeat(80)}\n`.repeat(50);
    const chunks = chunkDocument(longDoc, '长正文.md');
    expect(chunks.length).toBeGreaterThanOrEqual(50);
  });

  it('极短文档可入库', () => {
    const chunks = chunkDocument('# 标题\n\n短', '短.md');
    expect(chunks.length).toBe(1);
  });

  it('超长单行被切断为多块', () => {
    const chunks = chunkDocument('x'.repeat(CHUNK_MAX * 2 + 100), 'code.md');
    expect(chunks.length).toBe(3);
    expect(chunks.every((c) => c.text.length <= CHUNK_MAX)).toBe(true);
  });

  it('空文档返回空数组', () => {
    expect(chunkDocument('   ', 'x.md')).toEqual([]);
  });
});

describe('字符偏移（移植 selftest §7 引用定位准确性）', () => {
  const doc = SEED_DOCS[0]!;
  const trimmed = doc.text.trim();
  const chunks = chunkDocument(doc.text, doc.name);
  const norm = (s: string) => s.replace(/\s+/g, '');

  it('每个片段的行号与字符偏移都能定位到原文', () => {
    for (const h of chunks) {
      const lines = trimmed.split(/\r?\n/);
      const byLine = lines.slice(h.startLine - 1, h.endLine).join('\n');
      const head = norm(h.text).slice(0, 30);
      expect(norm(byLine)).toContain(head);

      // 字符偏移：从 startChar 取出的内容必须与块正文开头一致
      const byChar = norm(trimmed.slice(h.startChar, h.startChar + h.text.length + 40)).slice(0, 30);
      expect(byChar.startsWith(head)).toBe(true);

      // endChar 不得越界
      expect(h.startChar).toBeGreaterThanOrEqual(0);
      expect(h.endChar).toBeLessThanOrEqual(trimmed.length);
      expect(h.endChar).toBeGreaterThanOrEqual(h.startChar);
    }
  });
});
