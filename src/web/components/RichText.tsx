/* ============================================================
   web/components/RichText.tsx —— 轻量 Markdown 渲染
   支持：标题 / 无序·有序列表 / ```代码块（hljs 高亮 + 语言标签 + 复制）/ **加粗** / `代码`
        / GFM 表格 / > 引用块 / 流式光标。
   流式期间代码块不高亮（文本还在变），完成后才 hljs.highlight。
   ============================================================ */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import python from 'highlight.js/lib/languages/python';
import yaml from 'highlight.js/lib/languages/yaml';
import sql from 'highlight.js/lib/languages/sql';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import java from 'highlight.js/lib/languages/java';
import go from 'highlight.js/lib/languages/go';
import { CopyIcon, CheckIcon } from 'tdesign-icons-react';
import { renderInlineCitations } from '../citations.js';
import { useCiteStore } from '../stores/cite.js';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('java', java);
hljs.registerLanguage('go', go);
hljs.registerLanguage('go', go);

const LANG_LABEL: Record<string, string> = {
  javascript: 'JavaScript', js: 'JavaScript', typescript: 'TypeScript', ts: 'TypeScript',
  json: 'JSON', bash: 'Shell', sh: 'Shell', shell: 'Shell', python: 'Python', py: 'Python',
  yaml: 'YAML', yml: 'YAML', sql: 'SQL', xml: 'XML', html: 'HTML', css: 'CSS',
  java: 'Java', go: 'Go',
};

/** 行内格式：**加粗**、`代码`、[n] 引用 */
function inline(text: string, hitCount: number, onCite: (n: number) => void, hoverNo: number | null): ReactNode {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*)|(`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      out.push(<span key={`g${key++}`}>{renderInlineCitations(text.slice(last, m.index), hitCount, onCite, hoverNo)}</span>);
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
    out.push(<span key={`g${key++}`}>{renderInlineCitations(text.slice(last), hitCount, onCite, hoverNo)}</span>);
  }
  return out;
}

/* ---------------- GFM 表格 ---------------- */

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function parseAligns(line: string): ('left' | 'center' | 'right')[] | null {
  const cells = splitRow(line);
  if (!cells.length || !cells.every((c) => /^:?-{2,}:?$/.test(c))) return null;
  return cells.map((c) =>
    c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left',
  );
}

/* ---------------- 引用块 ---------------- */

function blockquote(lines: string[], hitCount: number, onCite: (n: number) => void, hoverNo: number | null): ReactNode {
  return (
    <blockquote key={`bq${lines.length}-${lines[0]?.slice(0, 8)}`}>
      {lines.map((l, i) => (
        <p key={i}>{inline(l, hitCount, onCite, hoverNo)}</p>
      ))}
    </blockquote>
  );
}

/* ---------------- 代码块 ---------------- */

function CodeBlock({ code, lang, streaming }: { code: string; lang: string; streaming?: boolean }) {
  const [copied, setCopied] = useState(false);
  const label = LANG_LABEL[lang] || (lang || 'code');
  // 流式期间不高亮（文本在变），完成后高亮一次
  const html = !streaming && lang && hljs.getLanguage(lang)
    ? hljs.highlight(code, { language: lang }).value
    : !streaming && !lang
      ? hljs.highlightAuto(code).value
      : null;

  function copy() {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }).catch(() => {});
  }

  return (
    <div className="chat-code-block">
      <div className="chat-code-block__head">
        <span className="chat-code-block__lang">{label}</span>
        <button
          className={`chat-code-block__copy${copied ? ' copied' : ''}`}
          onClick={copy}
          title="复制代码"
        >
          {copied ? <CheckIcon /> : <CopyIcon />}<span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>
      <pre className="chat-code-block__pre">
        {html !== null
          ? <code className={`hljs language-${lang || 'auto'}`} dangerouslySetInnerHTML={{ __html: html }} />
          : <code className={`language-${lang || 'auto'}`}>{code}</code>}
      </pre>
    </div>
  );
}

/* ---------------- 主渲染 ---------------- */

export function RichText({ text, hitCount, onCite, streaming }: {
  text: string;
  hitCount: number;
  onCite: (n: number) => void;
  streaming?: boolean;
}): ReactNode {
  const hoverNo = useCiteStore((s) => s.hoverNo);
  // 流式期间按 120ms debounce 重渲染，让 [n] 角标边流边可点（不必等整段流完）。
  // 完成后（streaming=false）直接用最新 text 渲染，不防抖。
  const [debouncedText, setDebouncedText] = useState(text);
  const tRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!streaming) { setDebouncedText(text); return; }
    if (tRef.current) clearTimeout(tRef.current);
    tRef.current = setTimeout(() => setDebouncedText(text), 120);
    return () => { if (tRef.current) clearTimeout(tRef.current); };
  }, [text, streaming]);
  const renderText = streaming ? debouncedText : text;

  const lines = renderText.split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // ```代码块```
    if (line.trim().startsWith('```')) {
      const lang = line.trim().replace(/^```/, '').trim().toLowerCase();
      const code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith('```')) {
        code.push(lines[i] ?? '');
        i++;
      }
      i++; // 跳过结尾 ```
      out.push(<CodeBlock key={`pre${key++}`} code={code.join('\n')} lang={lang} streaming={streaming} />);
      continue;
    }

    // GFM 表格
    if (line.includes('|') && i + 1 < lines.length) {
      const aligns = parseAligns(lines[i + 1] ?? '');
      if (aligns) {
        const head = splitRow(line);
        const rows: string[][] = [];
        i += 2;
        while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim()) {
          rows.push(splitRow(lines[i] ?? ''));
          i++;
        }
        out.push(
          <div key={`tb${key++}`} className="table-wrap">
            <table>
              <thead>
                <tr>{head.map((h, j) => <th key={j} style={{ textAlign: aligns[j] || 'left' }}>{inline(h, hitCount, onCite, hoverNo)}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r, ri) => (
                  <tr key={ri}>
                    {r.map((c, ci) => <td key={ci} style={{ textAlign: aligns[ci] || 'left' }}>{inline(c, hitCount, onCite, hoverNo)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        );
        continue;
      }
    }

    // 标题行
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = Math.min(4, (h[1] ?? '').length);
      const Tag = (`h${level + 2}`) as 'h3';
      out.push(<Tag key={`h${key++}`}>{inline(h[2] ?? '', hitCount, onCite, hoverNo)}</Tag>);
      i++;
      continue;
    }

    // 引用块
    if (/^\s*>\s?/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? '')) {
        q.push((lines[i] ?? '').replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(blockquote(q, hitCount, onCite, hoverNo));
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
          {items.map((it, j) => <li key={j}>{inline(it, hitCount, onCite, hoverNo)}</li>)}
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
          {items.map((it, j) => <li key={j}>{inline(it, hitCount, onCite, hoverNo)}</li>)}
        </ol>,
      );
      continue;
    }

    // 空行跳过
    if (!line.trim()) {
      i++;
      continue;
    }

    // 普通段落
    const para: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim() &&
      !/^(#{1,4}\s|\s*[-*•]\s|\s*\d+[.、)]\s|\s*>|```)/.test(lines[i] ?? '')) {
      para.push(lines[i] ?? '');
      i++;
    }
    if (para.length) {
      out.push(<p key={`p${key++}`}>{inline(para.join('\n'), hitCount, onCite, hoverNo)}</p>);
    } else {
      i++;
    }
  }

  return (
    <div className="rich-text">
      {out}
      {streaming && <span className="stream-cursor" aria-hidden="true" />}
    </div>
  );
}

void useEffect;
