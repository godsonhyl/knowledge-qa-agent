import { useState } from 'react';
import type { Hit } from '@shared/types.js';

export function EvidenceCard({ no, hit, defaultOpen }: { no: number; hit: Hit; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const loc = `${hit.docName}${hit.section ? ' › ' + hit.section : ''}`;
  return (
    <div className={`ev-card${open ? ' open' : ''}`} data-no={String(no)}>
      <div className="ev-head" onClick={() => setOpen((o) => !o)}>
        <span className="ev-no">{no}</span>
        <span className="ev-loc">{loc} <b>· 第 {hit.startLine}-{hit.endLine} 行</b></span>
        <span className="ev-score" title="融合相关度">{hit.rel}</span>
        <span className="ev-chev">▶</span>
      </div>
      {open && (
        <div className="ev-body">
          <div className="ev-text">{hit.text.slice(0, 700)}{hit.text.length > 700 ? '\n…' : ''}</div>
          {hit.summary && (
            <div className="ev-summary" title="LLM 蒸馏的知识点">💡 {hit.summary}</div>
          )}
          <div className="ev-actions">
            <button
              className="ev-link"
              onClick={() => window.dispatchEvent(new CustomEvent('open-viewer', {
                detail: { docId: hit.docId, startLine: hit.startLine, endLine: hit.endLine },
              }))}
            >在原文中定位 →</button>
          </div>
        </div>
      )}
    </div>
  );
}
