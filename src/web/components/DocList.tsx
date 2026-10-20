import { useKbStore } from '../stores/kb.js';
import { SOURCE_LABELS } from '@shared/types.js';

export function DocList() {
  const docs = useKbStore((s) => s.docs);
  const removeDoc = useKbStore((s) => s.removeDoc);
  const startDistill = useKbStore((s) => s.startDistill);
  const distill = useKbStore((s) => s.distill);

  return (
    <ul className="doc-list">
      {docs.map((d) => {
        const isDistilling = distill?.docId === d.docId;
        return (
          <li key={d.docId} className="doc-item">
            <span className="doc-icon">📄</span>
            <div className="doc-meta">
              <div className="doc-name" title={d.name}>{d.name}</div>
              <div className="doc-sub">
                {d.chunkCount} 片段 · {d.size} 字
                {d.distilled ? ` · 💡${d.distilled}/${d.chunkCount}` : ''}
                {isDistilling ? ` · 蒸馏中 ${distill!.done}/${distill!.total}` : ''}
              </div>
            </div>
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
          </li>
        );
      })}
      <div className="kb-count">{docs.length} 篇</div>
    </ul>
  );
}

void SOURCE_LABELS;
