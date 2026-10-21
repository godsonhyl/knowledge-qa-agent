/* ============================================================
   server/pdf.ts —— PDF 文本提取（基于 unpdf / pdf.js）
   仅做 PDF→纯文本，后续切块/嵌入/Qdrant 全部复用既有 addDoc 链路。
   扫描或图片型 PDF（无文字层）提取为空 → 抛错，让上层返回 422。
   ============================================================ */
import { extractText } from 'unpdf';

/** 提取 PDF 全文（合并页，用换行分隔）。
 *  @param bytes PDF 的原始字节
 *  @throws Error 当提取不到任何文本时（疑似扫描/图片型 PDF） */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const { text } = await extractText(bytes, { mergePages: true });
  // 去掉每页常见的前导空白与多余换行；unpdf 在 mergePages 下用 \n\n 分页
  const clean = (text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!clean) {
    throw new PdfNoTextError();
  }
  return clean;
}

export class PdfNoTextError extends Error {
  constructor() {
    super('PDF 中未提取到文本（扫描或图片型 PDF 暂不支持）');
    this.name = 'PdfNoTextError';
  }
}
