import { useEffect, useState } from 'react';
import { useKbStore } from '../stores/kb.js';
import { SOURCE_LABELS } from '@shared/types.js';

export function SummaryModal() {
  const [open, setOpen] = useState(false);
  const docs = useKbStore((s) => s.docs);
  const toast = useKbStore((s) => s.toast);

  useEffect(() => {
    function onOpen() { setOpen(true); }
    window.addEventListener('open-summary', onOpen);
    return () => window.removeEventListener('open-summary', onOpen);
  }, []);

  if (!open) return null;

  const totalChunks = docs.reduce((s, d) => s + d.chunkCount, 0);
  const distilled = docs.reduce((s, d) => s + d.distilled, 0);
  const totalChars = docs.reduce((s, d) => s + d.size, 0);

  const bySource: Record<string, { count: number; chars: number; chunks: number }> = {};
  for (const d of docs) {
    const k = d.source || 'unknown';
    (bySource[k] = bySource[k] || { count: 0, chars: 0, chunks: 0 });
    bySource[k]!.count++;
    bySource[k]!.chars += d.size;
    bySource[k]!.chunks += d.chunkCount;
  }

  async function copy(fmt: 'md' | 'csv') {
    let text: string;
    if (fmt === 'md') {
      text = [
        '| # | 名称 | 来源 | 字符 | 片段 | 知识点 | 导入时间 |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        ...docs.map((d, i) =>
          `| ${i + 1} | ${d.name.replace(/\|/g, '\\|')} | ${SOURCE_LABELS[d.source] || d.source} | ${d.size} | ${d.chunkCount} | ${d.distilled}/${d.chunkCount} | ${new Date(d.addedAt).toLocaleString('zh-CN', { hour12: false })} |`),
      ].join('\n');
    } else {
      text = [
        '序号,名称,来源,字符,片段,知识点,导入时间',
        ...docs.map((d, i) =>
          [i + 1, d.name, SOURCE_LABELS[d.source] || d.source, d.size, d.chunkCount, d.distilled, new Date(d.addedAt).toISOString()]
            .map((x) => `"${String(x).replace(/"/g, '""')}"`).join(',')),
      ].join('\n');
    }
    try {
      await navigator.clipboard.writeText(text);
      toast(`已复制 ${docs.length} 篇文档清单（${fmt === 'md' ? 'Markdown' : 'CSV'}）`, 'ok');
    } catch {
      toast('复制失败', 'err');
    }
  }

  return (
    <div className="modal-mask" onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="modal modal-lg">
        <div className="modal-head">
          <div>
            <h3>知识库汇总</h3>
            <div className="viewer-sub">
              {docs.length} 篇 · {totalChars.toLocaleString()} 字符 · {totalChunks} 片段 · 知识点 {distilled}/{totalChunks}
            </div>
          </div>
          <button className="icon-btn" onClick={() => setOpen(false)}>✕</button>
        </div>
        <div className="modal-body">
          <div className="summary-groups">
            {Object.entries(bySource).sort((a, b) => b[1].count - a[1].count).map(([k, v]) => (
              <div key={k} className="summary-group">
                <div className="sg-label">{SOURCE_LABELS[k] || k}</div>
                <div className="sg-value">{v.count}</div>
                <div className="sg-sub">{v.chars.toLocaleString()} 字 · {v.chunks} 片段</div>
              </div>
            ))}
          </div>
          <div className="summary-toolbar">
            <button className="btn btn-sm btn-ghost" onClick={() => void copy('md')}>复制为 Markdown</button>
            <button className="btn btn-sm btn-ghost" onClick={() => void copy('csv')}>复制为 CSV</button>
          </div>
          <div className="summary-table-wrap">
            <table className="summary-table">
              <thead>
                <tr><th>#</th><th>名称</th><th>来源</th><th>字符</th><th>片段</th><th>知识点</th><th>导入时间</th></tr>
              </thead>
              <tbody>
                {docs.map((d, i) => (
                  <tr key={d.docId}>
                    <td>{i + 1}</td>
                    <td className="s-name" title={d.name}>{d.name}</td>
                    <td>{SOURCE_LABELS[d.source] || d.source}</td>
                    <td>{d.size.toLocaleString()}</td>
                    <td>{d.chunkCount}</td>
                    <td>{d.distilled}/{d.chunkCount}</td>
                    <td>{new Date(d.addedAt).toLocaleString('zh-CN', { hour12: false })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
