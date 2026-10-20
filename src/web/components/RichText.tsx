/* ============================================================
   web/components/RichText.tsx —— 轻量 Markdown 渲染（React 版 renderRichText）
   React 自动转义替代 escapeHtml，引用角标通过 renderInlineCitations 注入。
   ============================================================ */
import type { ReactNode } from 'react';
import { renderInlineCitations } from '../citations.js';

/** 行内格式：**加粗**、`代码`、[n] 引用 */
function inline(text: string, hitCount: number, onCite: (n: number) => void): ReactNode {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*)|(`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      out.push(...toArr(renderInlineCitations(text.slice(last, m.index), hitCount, onCite), key++));
    }
    const tok = m[0];
    if (tok.startsWith('**')) {
      out.push(<b key={`b${m.index}`}>{tok.slice(2, -2)}</b>);
    } else {
      out.push(<code key={`k${m.index}`}>{tok.slice(1, -1)}</code>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    out.push(...toArr(renderInlineCitations(text.slice(last), hitCount, onCite), key++));
  }
  return out;
}

function toArr(node: ReactNode, base: number): ReactNode[] {
  // renderInlineCitations 返回数组或单节点；包一层 span 保证 key 稳定
  return [<span key={`g${base}`}>{node}</span>];
}

export function RichText({ text, hitCount, onCite }: { text: string; hitCount: number; onCite: (n: number) => void }): ReactNode {
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // ```代码块```
    if (line.trim().startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith('```')) {
        code.push(lines[i] ?? '');
        i++;
      }
      i++; // 跳过结尾 ```
      out.push(<pre key={`pre${key++}`} className="code-block">{code.join('\n')}</pre>);
      continue;
    }

    // 标题行
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = Math.min(4, (h[1] ?? '').length);
      const Tag = (`h${level + 2}`) as 'h3';
      out.push(<Tag key={`h${key++}`}>{inline(h[2] ?? '', hitCount, onCite)}</Tag>);
      i++;
      continue;
    }

    // 无序列表
    if (/^\s*[-*•]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*[-*•]\s+/, ''));
        i++;
      }
      out.push(
        <ul key={`ul${key++}`}>
          {items.map((it, j) => <li key={j}>{inline(it, hitCount, onCite)}</li>)}
        </ul>,
      );
      continue;
    }

    // 有序列表
    if (/^\s*\d+[.、)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.、)]\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*\d+[.、)]\s+/, ''));
        i++;
      }
      out.push(
        <ol key={`ol${key++}`}>
          {items.map((it, j) => <li key={j}>{inline(it, hitCount, onCite)}</li>)}
        </ol>,
      );
      continue;
    }

    // 空行跳过
    if (!line.trim()) {
      i++;
      continue;
    }

    // 普通段落（连续非空行合并）
    const para: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim() &&
      !/^(#{1,4}\s|\s*[-*•]\s|\s*\d+[.、)]\s|```)/.test(lines[i] ?? '')) {
      para.push(lines[i] ?? '');
      i++;
    }
    if (para.length) {
      out.push(<p key={`p${key++}`}>{inline(para.join('\n'), hitCount, onCite)}</p>);
    } else {
      i++;
    }
  }

  return <div className="rich-text">{out}</div>;
}
