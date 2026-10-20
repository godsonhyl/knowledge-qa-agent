import { useEffect, useState } from 'react';

interface ViewerState {
  open: boolean;
  docId: string | null;
  name: string;
  text: string;
  startLine: number | null;
  endLine: number | null;
}

export function ViewerModal() {
  const [state, setState] = useState<ViewerState>({
    open: false, docId: null, name: '', text: '', startLine: null, endLine: null,
  });

  useEffect(() => {
    function onOpen(e: Event) {
      const d = (e as CustomEvent).detail as { docId: string; startLine?: number; endLine?: number };
      void (async () => {
        const res = await fetch(`/api/kb/docs/${d.docId}`);
        if (!res.ok) return;
        const doc = await res.json() as { name: string; text: string };
        setState({
          open: true,
          docId: d.docId,
          name: doc.name,
          text: doc.text,
          startLine: d.startLine ?? null,
          endLine: d.endLine ?? null,
        });
      })();
    }
    window.addEventListener('open-viewer', onOpen);
    return () => window.removeEventListener('open-viewer', onOpen);
  }, []);

  useEffect(() => {
    if (state.open && state.startLine) {
      // 自动滚动到高亮区
      setTimeout(() => {
        const el = document.querySelector('.doc-viewer .hl');
        el?.scrollIntoView({ block: 'center' });
      }, 50);
    }
  }, [state.open, state.startLine]);

  if (!state.open) return null;

  const lines = state.text.split('\n');
  return (
    <div className="modal-mask" onClick={(e) => { if (e.target === e.currentTarget) setState((s) => ({ ...s, open: false })); }}>
      <div className="modal modal-lg">
        <div className="modal-head">
          <div>
            <h3>{state.name}</h3>
            {state.startLine && (
              <div className="viewer-sub">
                已定位到引用依据：第 <b>{state.startLine}</b> 行附近，高亮部分为被引用的原文片段。
              </div>
            )}
          </div>
          <button className="icon-btn" onClick={() => setState((s) => ({ ...s, open: false }))}>✕</button>
        </div>
        <div className="doc-viewer">
          <pre>
            {lines.map((line, i) => {
              const n = i + 1;
              const isHl = state.startLine !== null && state.endLine !== null
                && n >= state.startLine && n <= state.endLine;
              return (
                <div key={n} className={isHl ? 'hl' : ''}>
                  <span className="ln">{n}</span>
                  <span className="lc">{line}</span>
                </div>
              );
            })}
          </pre>
        </div>
      </div>
    </div>
  );
}
