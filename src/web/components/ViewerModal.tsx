import { useEffect, useState } from 'react';
import { authHeaders, handleUnauthorized } from '../stores/auth.js';
import { useKbStore } from '../stores/kb.js';

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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const updateDoc = useKbStore((s) => s.updateDoc);

  useEffect(() => {
    function onOpen(e: Event) {
      const d = (e as CustomEvent).detail as { docId: string; startLine?: number; endLine?: number };
      void (async () => {
        const res = await fetch(`/api/kb/docs/${d.docId}`, { headers: authHeaders() });
        if (res.status === 401) { void handleUnauthorized(); return; }
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
        setEditing(false);
        setDraft('');
      })();
    }
    window.addEventListener('open-viewer', onOpen);
    return () => window.removeEventListener('open-viewer', onOpen);
  }, []);

  useEffect(() => {
    if (state.open && state.startLine && !editing) {
      setTimeout(() => {
        const el = document.querySelector('.doc-viewer .hl');
        el?.scrollIntoView({ block: 'center' });
      }, 50);
    }
  }, [state.open, state.startLine, editing]);

  if (!state.open) return null;

  const lines = (editing ? draft : state.text).split('\n');
  return (
    <div className="modal-mask" onClick={(e) => { if (e.target === e.currentTarget && !editing) setState((s) => ({ ...s, open: false })); }}>
      <div className="modal modal-lg">
        <div className="modal-head">
          <div>
            <h3>{state.name}</h3>
            {state.startLine && !editing && (
              <div className="viewer-sub">
                已定位到引用依据：第 <b>{state.startLine}</b> 行附近，高亮部分为被引用的原文片段。
              </div>
            )}
            {editing && (
              <div className="viewer-sub">
                编辑模式：修改后保存会重新切块与嵌入，<b>已有蒸馏知识点将丢失</b>（切块边界变了）。保留文档 ID，对话历史引用不失效。
              </div>
            )}
          </div>
          <button className="icon-btn" onClick={() => { if (editing) setEditing(false); else setState((s) => ({ ...s, open: false })); }}>
            {editing ? '取消' : '✕'}
          </button>
        </div>
        {!editing ? (
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
        ) : (
          <div className="doc-viewer doc-viewer-edit">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              autoFocus
            />
          </div>
        )}
        <div className="viewer-foot">
          {!editing ? (
            <button
              className="btn btn-sm btn-primary"
              onClick={() => { setDraft(state.text); setEditing(true); }}
            >✎ 编辑文档</button>
          ) : (
            <>
              <button
                className="btn btn-sm btn-primary"
                disabled={saving || draft.trim() === state.text.trim()}
                onClick={async () => {
                  if (!state.docId) return;
                  if (!confirm('保存将重新切块并嵌入所有片段，已有蒸馏知识点会丢失。继续？')) return;
                  setSaving(true);
                  const ok = await updateDoc(state.docId, draft);
                  setSaving(false);
                  if (ok) {
                    // 重新拉取更新后的文本展示（行号已变，去掉高亮）
                    const res = await fetch(`/api/kb/docs/${state.docId}`, { headers: authHeaders() });
                    if (res.ok) {
                      const doc = await res.json() as { text: string };
                      setState((s) => ({ ...s, text: doc.text, startLine: null, endLine: null }));
                    }
                    setEditing(false);
                  }
                }}
              >{saving ? '保存中…' : '保存（重新切块+嵌入）'}</button>
              <button className="btn btn-sm btn-ghost" onClick={() => setEditing(false)}>取消</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
