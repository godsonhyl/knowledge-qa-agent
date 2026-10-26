/* ============================================================
   tests/docMulti.test.ts —— 多格式文档解析 + 表格保形单测
   §DP-1 DOCX 提取（内存构造最小 docx）
   §DP-2 XLSX 提取（含中文字段与多 sheet，验证 markdown 表格保形）
   §DP-3 PPTX 提取（内存构造 pptx）
   §TB-1 isTableChunk：GFM 表格 / HTML 表格 / 非表格
   ============================================================ */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';

const { extractDocxText, extractXlsxText, extractPptxText, NoTextError } = await import('../src/server/docParse.js');
const { isTableChunk } = await import('../src/server/distill.js');

/* 最小可用 xlsx（sheetjs 可写） */
async function makeXlsx(rows: string[][]): Promise<Uint8Array> {
  const XLSX = await import('xlsx');
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '行情');
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new Uint8Array(out as ArrayBuffer);
}

describe('§DP-2 XLSX 提取', () => {
  it('表格保形：sheet 名为节标题，行转 | 竖线表格', async () => {
    const buf = await makeXlsx([
      ['品种', '收盘价', '涨跌幅'],
      ['上证指数', '3668.61', '-0.59%'],
      ['中证1000', '6631.57', '-1.53%'],
    ]);
    const text = await extractXlsxText(buf);
    expect(text).toContain('## 行情');
    expect(text).toContain('| 品种 | 收盘价 | 涨跌幅 |');
    expect(text).toContain('| 上证指数 | 3668.61 | -0.59% |');
  });
  it('空 sheet 抛 NoTextError', async () => {
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), '空');
    const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    await expect(extractXlsxText(new Uint8Array(out as ArrayBuffer))).rejects.toThrow(NoTextError);
  });
});

describe('§DP-3 PPTX 提取', () => {
  it('幻灯片 a:t 文本按页提取', async () => {
    const zip = new JSZip();
    // 最小 pptx：仅 slides（mammoth 不适用，我们自己解）
    const slideXml = (n: number) =>
      `<?xml version="1.0"?><p:sld xmlns:p="x" xmlns:a="y"><p:cSld><p:spTree>` +
      `<a:p><a:r><a:t>第${n}页标题</a:t></a:r></a:p><a:p><a:r><a:t>要点${n}</a:t></a:r></a:p>` +
      `</p:spTree></p:cSld></p:sld>`;
    zip.file('ppt/slides/slide1.xml', slideXml(1));
    zip.file('ppt/slides/slide10.xml', slideXml(10)); // 测排序：10 应在 1 后而不是字典序
    zip.file('ppt/slides/slide2.xml', slideXml(2));
    const buf = await zip.generateAsync({ type: 'uint8array' });
    const text = await extractPptxText(buf);
    expect(text).toContain('第 1 页');
    expect(text).toContain('第 10 页');
    expect(text).toContain('要点10');
    // 排序：第 1 页应在第 10 页前
    expect(text.indexOf('第 1 页')).toBeLessThan(text.indexOf('第 10 页'));
  });
  it('无幻灯片抛 NoTextError', async () => {
    const zip = new JSZip();
    const buf = await zip.generateAsync({ type: 'uint8array' });
    await expect(extractPptxText(buf)).rejects.toThrow(NoTextError);
  });
});

describe('§TB-1 isTableChunk 表格检测', () => {
  it('GFM markdown 表格', () => {
    const md = `| 品种 | 收盘价 |\n| --- | --- |\n| 上证 | 3668 |`;
    expect(isTableChunk(md)).toBe(true);
  });
  it('HTML 表格', () => {
    expect(isTableChunk('<table><tr><td>a</td></tr></table>')).toBe(true);
  });
  it('普通散文不是表格', () => {
    expect(isTableChunk('这是一段普通文本，讲撮合延迟的典型范围。')).toBe(false);
  });
  it('单行竖线不是表格（无分隔行）', () => {
    expect(isTableChunk('| a | b |')).toBe(false);
  });
});
