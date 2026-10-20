/* ============================================================
   server/chunker.ts —— 文档解析、章节识别、分块
   从 core.js 逐行移植：行号/字符偏移是引用定位契约，不得改语义。
   ============================================================ */

/**
 * 从行首识别标题行，返回该行的标题文本与层级；非标题返回 null。
 * 支持：Markdown # 标题、中文第X章/第X节、一/二/三、数字 1. / 1.1、全大写英文行
 */
export interface Heading {
  level: number;
  text: string;
}

export function detectHeading(line: string): Heading | null {
  const t = line.trim();
  if (!t || t.length > 80) return null;

  let m = t.match(/^(#{1,6})\s+(.*)$/);
  if (m && m[1] && m[2]) return { level: m[1].length, text: m[2].replace(/#+\s*$/, '').trim() };

  m = t.match(/^第\s*([一二三四五六七八九十百零〇\d]+)\s*(章|部分|篇)\s*[:：、.]?\s*(.*)$/);
  if (m) return { level: 1, text: t };

  m = t.match(/^第\s*([一二三四五六七八九十百零〇\d]+)\s*节\s*[:：、.]?\s*(.*)$/);
  if (m) return { level: 2, text: t };

  m = t.match(/^([一二三四五六七八九十]+)\s*[、.．]\s*(\S.*)$/);
  if (m && m[2] && m[2].length <= 40) return { level: 2, text: t };

  m = t.match(/^(\d+(?:\.\d+)*)\s*[、.．)]?\s+(\S.*)$/);
  if (m && m[2] && m[2].length <= 60) {
    const num = m[1]!;
    const level = Math.min(4, num.split('.').length);
    return { level, text: t };
  }

  // 纯大写英文短行
  if (/^[A-Z0-9][A-Z0-9\s\-/&]{2,50}$/.test(t) && /[A-Z]{3,}/.test(t)) {
    return { level: 2, text: t };
  }

  return null;
}

/* ---------------- 分块常量（与 core.js 一致，不得改） ---------------- */

export const CHUNK_TARGET = 520;   // 目标字符数
export const CHUNK_MAX = 760;      // 硬上限
export const CHUNK_MIN = 90;        // 太短的块与后一块合并
export const CHUNK_OVERLAP = 90;   // 相邻块重叠字符数

export interface ChunkRaw {
  id: string;
  docName: string;
  section: string;
  startLine: number;
  endLine: number;
  startChar: number;
  endChar: number;
  text: string;
}

/** 切片带最终字符偏移的完整产物（与旧 KB.add 内的 lineOffsets 逻辑合并） */
export interface ChunkFinal extends ChunkRaw {}

let overlapStartLine = 0;

function currentPath(headingAt: (Heading | null)[], idx: number): string[] {
  const stack: string[] = [];
  for (let i = idx; i >= 0; i--) {
    const h = headingAt[i];
    if (h) stack.unshift(h.text);
    if (stack.length >= 3) break;
  }
  return stack.slice(0, 3);
}

function buildOverlap(buf: string[], startLine: number): { tail: string[]; startLine: number } {
  const tail: string[] = [];
  let len = 0;
  for (let i = buf.length - 1; i >= 0; i--) {
    const l = buf[i]!;
    if (len + l.length > CHUNK_OVERLAP) break;
    tail.unshift(l);
    len += l.length + 1;
    if (tail.length >= 3) break;
  }
  const newStart = tail.length
    ? Math.max(1, startLine + buf.length - tail.length)
    : startLine;
  return { tail, startLine: newStart };
}

function mergeTinyChunks(chunks: ChunkRaw[]): ChunkRaw[] {
  const out: ChunkRaw[] = [];
  for (const c of chunks) {
    const prev = out[out.length - 1];
    if (
      prev &&
      c.text.length < CHUNK_MIN &&
      prev.text.length + c.text.length < CHUNK_MAX &&
      prev.docName === c.docName &&
      prev.endLine >= c.startLine - 2
    ) {
      prev.text = `${prev.text}\n${c.text}`.trim();
      prev.endLine = c.endLine;
      prev.id = `${c.docName}#${out.length - 1}`;
      continue;
    }
    out.push(c);
  }
  return out.map((c, i) => ({ ...c, id: `${c.docName}#${i}` }));
}

/**
 * 将文档切成带定位信息的片段。
 * 每个片段记录：文档名、章节路径、起止行号、字符偏移。
 * 字符偏移在最后统一计算（与旧 KB.add 内的 lineOffsets 一致）。
 */
export function chunkDocument(text: string, docName: string): ChunkFinal[] {
  const trimmed = String(text || '').trim();
  const lines = trimmed.split(/\r?\n/);
  const chunks: ChunkRaw[] = [];
  let buf: string[] = [];
  let bufStart = 0;
  let bufChars = 0;
  let sectionPath: string[] = [];

  const headingAt: (Heading | null)[] = new Array(lines.length).fill(null);
  {
    const stack: (string | undefined)[] = [];
    for (let i = 0; i < lines.length; i++) {
      const h = detectHeading(lines[i]!);
      if (h) {
        stack.length = Math.max(0, h.level - 1);
        stack[h.level - 1] = h.text;
        headingAt[i] = h;
      }
    }
  }

  function flush(endLineIdx: number) {
    if (buf.length === 0) return;
    const body = buf.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (body) {
      chunks.push({
        id: `${docName}#${chunks.length}`,
        docName,
        section: sectionPath.length ? sectionPath.join(' › ') : '',
        startLine: bufStart,
        endLine: endLineIdx + 1,
        startChar: 0,
        endChar: 0,
        text: body,
      });
    }
    buf = [];
    bufChars = 0;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const h = headingAt[i];

    if (h) {
      flush(i - 1);
      sectionPath = currentPath(headingAt, i);
      bufStart = i + 1;
      buf.push(line);
      bufChars += line.length;
      continue;
    }

    if (buf.length === 0) bufStart = i + 1;

    // 超长单行（代码等）：直接切断
    if (line.length > CHUNK_MAX) {
      flush(i - 1);
      const start = i;
      for (let k = 0; k < line.length; k += CHUNK_MAX) {
        const seg = line.slice(k, k + CHUNK_MAX);
        chunks.push({
          id: `${docName}#${chunks.length}`,
          docName,
          section: sectionPath.length ? sectionPath.join(' › ') : '',
          startLine: start + 1,
          endLine: start + 1,
          startChar: 0,
          endChar: 0,
          text: seg,
        });
      }
      bufStart = i + 2;
      continue;
    }

    if (bufChars + line.length > CHUNK_TARGET && bufChars >= CHUNK_MIN) {
      const { tail, startLine } = buildOverlap(buf, bufStart);
      flush(i - 1);
      buf = tail.slice();
      bufChars = tail.join('\n').length;
      bufStart = startLine;
      void overlapStartLine;
    }

    buf.push(line);
    bufChars += line.length + 1;
  }
  flush(lines.length - 1);

  const merged = mergeTinyChunks(chunks);

  // 计算字符偏移（与旧 KB.add 内逻辑一致）
  const lineOffsets: number[] = [];
  let acc = 0;
  for (const l of lines) {
    lineOffsets.push(acc);
    acc += l.length + 1;
  }
  for (const c of merged) {
    c.startChar = lineOffsets[c.startLine - 1] ?? 0;
    c.endChar = Math.min(trimmed.length, c.startChar + c.text.length);
  }

  return merged;
}
