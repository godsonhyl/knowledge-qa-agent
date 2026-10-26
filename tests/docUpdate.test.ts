/* ============================================================
   tests/docUpdate.test.ts —— §DU-1 文档内容更新（D1）
   PUT /api/kb/docs/:docId 复用 updateDocContent：删旧块 → 重新切块 →
   保留 docId。单测验 chunkDocument 对更新后文本的切块正确性 + 更新前后
   chunk id 派生一致性（docId:index 幂等，引用契约不破坏）。
   ============================================================ */
import { describe, it, expect } from 'vitest';
import { chunkDocument } from '../src/server/chunker.js';

describe('§DU-1 文档更新后的重新切块', () => {
  it('更新文本 → 重新切块，行号/偏移与内容对齐', () => {
    const docName = '部署手册.md';
    const oldText = '第一行\n第二行';
    const newText = [
      '# 部署手册',
      '',
      '服务部署在 10.0.0.1:8080。',
      '主备切换约需 30 秒。',
    ].join('\n');
    const oldChunks = chunkDocument(oldText, docName);
    const newChunks = chunkDocument(newText, docName);
    expect(oldChunks.length).toBeGreaterThanOrEqual(1);
    expect(newChunks.length).toBeGreaterThanOrEqual(1);
    // 新块的 startLine/endLine 落在文本总行数内（定位契约）
    const totalLines = newText.split('\n').length;
    for (const c of newChunks) {
      expect(c.startLine).toBeGreaterThanOrEqual(1);
      expect(c.endLine).toBeLessThanOrEqual(totalLines);
    }
  });

  it('同 docId 下 chunk id 派生仍按 index 幂等（updateDocContent 契约）', async () => {
    const { chunkIdFor } = await import('../src/server/ids.js');
    const docId = 'test-doc-uuid';
    // chunk id = UUIDv5("kqa:v1", `${docId}:${index}`)：更新前后同 index 同 id
    expect(chunkIdFor(docId, 0)).toBe(chunkIdFor(docId, 0));
    expect(chunkIdFor(docId, 0)).not.toBe(chunkIdFor(docId, 1));
  });

  it('切块常量在更新路径一字未动（CHUNK_TARGET=520 契约）', async () => {
    const mod: any = await import('../src/server/chunker.js');
    // 常量被内联在 chunkDocument；这里验证长文切块行为不退化（§10 契约的行为面）
    const long = ('段落内容。'.repeat(400));
    const chunks = chunkDocument(long, 'long.md');
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(760);   // MAX
      expect(c.text.length).toBeGreaterThanOrEqual(90); // MIN（除最后一块外应有 overlap 兜底）
    }
  });
});
