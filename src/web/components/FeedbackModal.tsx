import { useEffect, useState } from 'react';
import { authHeaders } from '../stores/auth.js';
import { useChatStore } from '../stores/chat.js';

interface FbItem {
  id: string;
  question: string;
  answerExcerpt: string;
  hitDocs: string[];
  feedback: 'up' | 'down';
  mode: string;
  ts: number;
}

interface FbAnalysis {
  total: number;
  up: number;
  down: number;
  downRate: number;
  byMode: Record<string, { count: number; samples: { question: string; hitDocs: string[]; ts: number }[] }>;
  topQuestions: { question: string; count: number }[];
}

/** 反馈汇总弹层：检索调优数据视图（负样本 → 拒答误判 or 排序问题） */
export function FeedbackModal() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<FbItem[]>([]);
  const [analysis, setAnalysis] = useState<FbAnalysis | null>(null);
  const [tab, setTab] = useState<'list' | 'analysis'>('list');
  const ask = useChatStore((s) => s.ask);

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
    void fetch('/api/feedback/analysis', { headers: authHeaders() }).then((r) => r.json()).then((d: any) => {
      if (d && typeof d === 'object' && 'byMode' in d) setAnalysis(d as FbAnalysis);
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
              <div className="sg-value">{analysis?.up ?? ups}</div>
            </div>
            <div className="summary-group">
              <div className="sg-label">👎 待改进</div>
              <div className="sg-value">{analysis?.down ?? downs}</div>
            </div>
            <div className="summary-group">
              <div className="sg-label">负样本率</div>
              <div className="sg-value">{analysis ? Math.round(analysis.downRate * 100) + '%' : '—'}</div>
            </div>
          </div>

          {/* tab 切换：明细列表 / 诊断聚合 */}
          <div className="fb-tabs">
            <button className={`fb-tab${tab === 'list' ? ' on' : ''}`} onClick={() => setTab('list')}>负样本明细</button>
            <button className={`fb-tab${tab === 'analysis' ? ' on' : ''}`} onClick={() => setTab('analysis')}>诊断聚合</button>
          </div>

          {tab === 'list' && (
            <>
              {downsList.length > 0 && (
                <>
                  <div className="summary-section-title">👎 负样本（点问题可重跑检索看 trace，判断阈值卡了还是 chunk 质量差）</div>
                  <div className="summary-table-wrap">
                    <table className="summary-table">
                      <thead><tr><th>时间</th><th>问题</th><th>模式</th><th>当时命中</th><th></th></tr></thead>
                      <tbody>
                        {downsList.map((x) => (
                          <tr key={x.id}>
                            <td>{new Date(x.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</td>
                            <td className="s-name" title={x.answerExcerpt}>{x.question}</td>
                            <td>{x.mode}</td>
                            <td className="s-name">{x.hitDocs.join('、') || '—'}</td>
                            <td>
                              <button
                                className="btn btn-sm btn-ghost"
                                title="重跑该问题（在主界面）"
                                onClick={() => { setOpen(false); void ask(x.question); }}
                              >重跑</button>
                            </td>
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
            </>
          )}

          {tab === 'analysis' && analysis && (
            <>
              <div className="summary-section-title">负样本按模式分组（拒答误判 vs 排序差 vs 兜底失败）</div>
              <div className="summary-table-wrap">
                <table className="summary-table">
                  <thead><tr><th>模式</th><th>计数</th><th>典型问题</th></tr></thead>
                  <tbody>
                    {Object.entries(analysis.byMode).map(([mode, info]) => (
                      <tr key={mode}>
                        <td>{mode}</td>
                        <td>{info.count}</td>
                        <td className="s-name">
                          {info.samples.slice(0, 3).map((s, i) => (
                            <div key={i} title={s.hitDocs.join('、')}>{s.question}</div>
                          ))}
                        </td>
                      </tr>
                    ))}
                    {!Object.keys(analysis.byMode).length && <tr><td colSpan={3} className="doc-empty">无负样本</td></tr>}
                  </tbody>
                </table>
              </div>
              {analysis.topQuestions.length > 0 && (
                <>
                  <div className="summary-section-title" style={{ marginTop: 14 }}>高频负样本问题（聚集出现 = 优先排查）</div>
                  <div className="summary-table-wrap">
                    <table className="summary-table">
                      <thead><tr><th>次数</th><th>问题</th><th></th></tr></thead>
                      <tbody>
                        {analysis.topQuestions.map((q, i) => (
                          <tr key={i}>
                            <td>{q.count}</td>
                            <td className="s-name">{q.question}</td>
                            <td>
                              <button
                                className="btn btn-sm btn-ghost"
                                title="重跑该问题"
                                onClick={() => { setOpen(false); void ask(q.question); }}
                              >重跑</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
