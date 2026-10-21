/* ============================================================
   tests/pdf.test.ts —— PDF 文本提取（unpdf）
   §PDF-1 手造最小 PDF → 提取出原文
   §PDF-2 图片型（无文字层）→ PdfNoTextError
   ============================================================ */
import { describe, it, expect } from 'vitest';
import { extractPdfText, PdfNoTextError } from '../src/server/pdf.js';

/** 手造最小单页 PDF：一个 content 流里输出 "Hello PDF Knowledge" 文本。
 *  用原始 PDF 语法的字符串字面量（含正确的 xref 偏移由生成器计算）。
 *  为避免手算 xref 偏移出错，这里运行时动态拼 + 计算偏移。 */
function buildTinyPdf(text: string, withText: boolean): Uint8Array {
  const esc = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const objects: string[] = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const stream = withText
    ? `BT /F1 24 Tf 72 720 Td (${esc}) Tj ET`
    : `q 100 0 0 100 72 700 cm /Im0 Do Q`; // 仅图片占位，无文字
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    out += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return new TextEncoder().encode(out);
}

describe('pdf.ts 文本提取', () => {
  it('§PDF-1 从可解析 PDF 提取原文', async () => {
    const bytes = buildTinyPdf('Hello PDF Knowledge', true);
    const text = await extractPdfText(bytes);
    expect(text).toContain('Hello PDF Knowledge');
  });

  it('§PDF-2 无文字层（图片型）抛 PdfNoTextError', async () => {
    const bytes = buildTinyPdf('ignored', false);
    await expect(extractPdfText(bytes)).rejects.toBeInstanceOf(PdfNoTextError);
  });
});
