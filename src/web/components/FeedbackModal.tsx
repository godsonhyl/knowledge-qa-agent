import { useEffect, useState } from 'react';
import { authHeaders } from '../stores/auth.js';

interface FbItem {
  id: string;
  question: string;
  answerExcerpt: string;
  hitDocs: string[];
  feedback: 'up' | 'down';
  mode: string;
  ts: number;
}

/** 反馈汇总弹层：检索调优数据视图（负样本 → 拒答误判 or 排序问题） */
export function FeedbackModal() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<FbItem[]>([]);

  useEffect(() => {
    function onOpen() { setOpen(true); }
    window.addEventListener('open-feedback', onOpen);
    return () => window.removeEventListener('open-feedback', onOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    void fetch('/api/feedback?limit=100', { headers: authHeaders() }).then((r) => r.json()).then((d: any) => {
      if (Array.isArray(d?.feedback)) setItems(d.feedback);
    }).catch(() => undefined);
  }, [open]);

  if (!open) return null;
  const ups = items.filter((x) => x.feedback === 'up').length;
  const downs = items.length - ups;
  const downsList = items.filter((x) => x.feedback === 'down');
  const upsList = items.filter((x) => x.feedback === 'up').slice(0, 20);

  return (
    <div className="modal-mask" onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="modal modal-lg">
        <div className="modal-head">
          <div>
            <h3>问答反馈汇总</h3>
            <div className="viewer-sub">检索调优数据：负样本聚集出现的问法/主题，即是阈值或文档需要补的洞</div>
          </div>
          <button className="icon-btn" onClick={() => setOpen(false)}>✕</button>
        </div>
        <div className="modal-body">
          <div className="summary-groups">
            <div className="summary-group">
              <div className="sg-label">👍 有帮助</div>
              <div className="sg-value">{ups}</div>
            </div>
            <div className="summary-group">
              <div className="sg-label">👎 待改进</div>
              <div className="sg-value">{downs}</div>
            </div>
          </div>
          {downsList.length > 0 && (
            <>
              <div className="summary-section-title">👎 负样本（应重点分析：是拒答误判还是排序差）</div>
              <div className="summary-table-wrap">
                <table className="summary-table">
                  <thead><tr><th>时间</th><th>问题</th><th>模式</th><th>当时命中</th></tr></thead>
                  <tbody>
                    {downsList.map((x) => (
                      <tr key={x.id}>
                        <td>{new Date(x.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</td>
                        <td className="s-name" title={x.answerExcerpt}>{x.question}</td>
                        <td>{x.mode}</td>
                        <td className="s-name">{x.hitDocs.join('、') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {upsList.length > 0 && (
            <>
              <div className="summary-section-title" style={{ marginTop: 14 }}>👍 正样本（最近 20 条）</div>
              <div className="summary-table-wrap">
                <table className="summary-table">
                  <thead><tr><th>时间</th><th>问题</th><th>当时命中</th></tr></thead>
                  <tbody>
                    {upsList.map((x) => (
                      <tr key={x.id}>
                        <td>{new Date(x.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</td>
                        <td className="s-name">{x.question}</td>
                        <td className="s-name">{x.hitDocs.join('、') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {!items.length && <div className="doc-empty">还没有反馈数据</div>}
        </div>
      </div>
    </div>
  );
}
