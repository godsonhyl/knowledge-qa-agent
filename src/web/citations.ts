/* ============================================================
   web/citations.ts —— 引用编号校验（移植自 app.js）
   ============================================================ */
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useCiteStore } from './stores/cite.js';

export interface CitationValidation {
  used: Set<number>;
}

/** 校验回答里的 [n] 是否落在 1..hitCount 范围内 */
export function validateCitations(text: string, hitCount: number): CitationValidation {
  const used = new Set<number>();
  const re = /\[(\d{1,2})\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = parseInt(m[1]!, 10);
    if (n >= 1 && n <= hitCount) used.add(n);
  }
  return { used };
}

/** 把 [n] 渲染成可点击角标（超出范围则保留字面文本）。React 自动转义，无 XSS。
 *  hoverNo 非空时（证据卡悬停中），同号角标加 hl 类高亮。
 *  角标自身悬停也会反向高亮证据卡（写入 citeStore.hoverNo）。 */
export function renderInlineCitations(
  text: string,
  hitCount: number,
  onClick: (n: number) => void,
  hoverNo: number | null = null,
): ReactNode {
  const setHover = useCiteStore.getState().setHover;
  const parts: ReactNode[] = [];
  const re = /\[(\d{1,2})\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const n = parseInt(m[1]!, 10);
    if (n >= 1 && n <= hitCount) {
      parts.push(
        createElement('button', {
          key: `c${m.index}`,
          className: `cite${hoverNo === n ? ' hl' : ''}`,
          'data-no': String(n),
          onClick: () => onClick(n),
          onMouseEnter: () => setHover(n),
          onMouseLeave: () => setHover(null),
          title: `查看依据 ${n}`,
        }, n),
      );
    } else {
      parts.push(m[0]);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
