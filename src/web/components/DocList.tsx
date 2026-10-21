import { useMemo, useState } from 'react';
import { Input } from 'tdesign-react';
import { SearchIcon } from 'tdesign-icons-react';
import { useKbStore } from '../stores/kb.js';

export function DocList() {
  const docs = useKbStore((s) => s.docs);
  const removeDoc = useKbStore((s) => s.removeDoc);
  const startDistill = useKbStore((s) => s.startDistill);
  const distill = useKbStore((s) => s.distill);
  const [filter, setFilter] = useState('');

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return docs;
    return docs.filter((d) => d.name.toLowerCase().includes(q));
  }, [docs, filter]);

  return (
    <div className="doc-list-wrap">
      <div className="doc-list-toolbar">
        <Input
          className="doc-filter"
          value={filter}
          clearable
          placeholder="筛选文档…"
          prefixIcon={<SearchIcon />}
          onChange={(v: any) => setFilter(v ?? '')}
        />
        <span className="doc-count-chip" title={`${docs.length} 篇文档`}>{docs.length}</span>
      </div>
      {filter && (
        <div className="doc-filter-note">
          {shown.length ? `匹配 ${shown.length} 篇` : '无匹配文档'}
        </div>
      )}

      <ul className="doc-list">
        {shown.map((d) => {
          const isDistilling = distill?.docId === d.docId;
          return (
            <li key={d.docId} className="doc-item">
              <div className="doc-meta">
                <div className="doc-name" title={d.name}>{d.name}</div>
                <div className="doc-sub">
                  {d.chunkCount} 片段 · {d.size} 字
                  {d.distilled ? ` · 💡${d.distilled}/${d.chunkCount}` : ''}
                  {isDistilling ? ` · 蒸馏中 ${distill!.done}/${distill!.total}` : ''}
                </div>
              </div>
              <div className="doc-actions">
                <button
                  className="icon-btn"
                  title="查看原文"
                  onClick={() => window.dispatchEvent(new CustomEvent('open-viewer', { detail: { docId: d.docId } }))}
                >👁</button>
                <button
                  className="icon-btn"
                  title="蒸馏知识点"
                  disabled={!!distill}
                  onClick={() => void startDistill(d.docId)}
                >💡</button>
                <button
                  className="icon-btn"
                  title="删除"
                  onClick={() => {
                    if (!confirm(`删除「${d.name}」？`)) return;
                    void removeDoc(d.docId);
                  }}
                >✕</button>
              </div>
            </li>
          );
        })}
        {!shown.length && !filter && <li className="doc-empty">还没有文档，先拖入文件或从 Confluence 导入</li>}
      </ul>
    </div>
  );
}
