/* ============================================================
   server/docParse.ts —— 多格式文档文本提取（PDF 之外的补充）
   支持：.docx（mammoth）/ .xlsx（sheetjs）/ .pptx（jszip+XML 自提取）
   与 pdf.ts 同模式：函数 + *NoTextError；提取为空抛错 → 上层 422。
   切块/嵌入/Qdrant 全部复用既有 addDoc 链路（文本无关格式）。
   ============================================================ */

/** 公共空文本错误（与 PdfNoTextError 同语义，路由层 instanceof 判空） */
export class NoTextError extends Error {
  constructor(fmt: string) {
    super(`${fmt} 中未提取到文本（空文档或纯图片内容暂不支持）`);
    this.name = 'NoTextError';
  }
}

function cleanText(s: string): string {
  const out = (s || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return out;
}

/* ---------- DOCX ---------- */
/** mammoth 提取 docx 段落文本（表格自动转 markdown 行——mammoth 内置） */
export async function extractDocxText(bytes: Uint8Array): Promise<string> {
  const mammoth = await import('mammoth');
  const buf = Buffer.from(bytes);
  const { value: html } = await mammoth.convertToHtml({ buffer: buf });
  // HTML → 文本（保留表格竖线结构：mammoth 输出 <table>，转成 |a|b| 行）
  const text = htmlTableToMd(html);
  const clean = cleanText(text);
  if (!clean) throw new NoTextError('DOCX');
  return clean;
}

/** mammoth 的 <table> HTML 转 markdown 表格行（保形）；其余标签剥成文本 */
function htmlTableToMd(html: string): string {
  let out = html;
  // 表格：<tr>→一行，<td>/<th>→"值"竖线分隔
  out = out.replace(/<table[^>]*>/gi, '\n\n');
  out = out.replace(/<\/table>/gi, '\n\n');
  out = out.replace(/<\/tr>/gi, ' |\n');
  out = out.replace(/<tr[^>]*>/gi, '| ');
  out = out.replace(/<\/t[dh]>/gi, ' | ');
  out = out.replace(/<t[dh][^>]*>/gi, '');
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<\/p>/gi, '\n\n');
  out = out.replace(/<[^>]+>/g, '');
  return out
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/* ---------- XLSX ---------- */
/** sheetjs 提取 xlsx：每个 sheet 一节（"## sheet名"标题 + markdown 表格），
 *  表格保形——这是"表格语义保形"的关键入口之一。 */
export async function extractXlsxText(bytes: Uint8Array): Promise<string> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(bytes, { type: 'array' });
  const parts: string[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const rows: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
    if (!rows.length) continue;
    parts.push(`## ${name}`);
    for (const row of rows) {
      const cells = row.map((c) => String(c ?? '').replace(/\|/g, '丨').replace(/\n/g, ' '));
      if (cells.every((c) => !c.trim())) continue;
      parts.push(`| ${cells.join(' | ')} |`);
    }
    parts.push('');
  }
  const clean = cleanText(parts.join('\n'));
  if (!clean) throw new NoTextError('XLSX');
  return clean;
}

/* ---------- PPTX ---------- */
/** pptx：jszip 解压 → PowerPoint/slides/slideN.xml → 抽 <a:t> 文本（每页一节）
 *  不引重型 pptx 库——幻灯片文本都在 a:t 节点里，顺带抽备注 slideN.xml.rels 中的 notes */
export async function extractPptxText(bytes: Uint8Array): Promise<string> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(bytes);
  const parts: string[] = [];
  // 幻灯片按编号排序
  const slideNames: string[] = [];
  zip.forEach((path: string) => {
    const m = path.match(/^ppt\/slides\/slide(\d+)\.xml$/);
    if (m) slideNames.push(path);
  });
  slideNames.sort((a, b) => {
    const na = Number(a.match(/slide(\d+)\.xml/)![1]);
    const nb = Number(b.match(/slide(\d+)\.xml/)![1]);
    return na - nb;
  });
  for (const path of slideNames) {
    const xml = await zip.file(path)!.async('string');
    // <a:t> 是 PPTX 的最小文本单元（段落 a:p 内可多个 a:t）
    const texts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]!);
    // 按段落 a:p 重建行
    const paraSplit = xml.split(/<\/a:p>/).map((para) =>
      [...para.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]!).join(''));
    const lines = paraSplit.filter((l) => l.trim().length > 0);
    if (!lines.length && !texts.length) continue;
    const num = path.match(/slide(\d+)\.xml/)![1];
    parts.push(`### 第 ${num} 页`, ...(lines.length ? lines : texts), '');
  }
  const clean = cleanText(parts.join('\n'));
  if (!clean) throw new NoTextError('PPTX');
  return clean;
}
