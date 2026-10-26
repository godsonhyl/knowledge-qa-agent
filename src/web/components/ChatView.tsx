import { useEffect, useRef, useState } from 'react';
import { Switch, Button, Tag } from 'tdesign-react';
import { SunnyIcon, MoonIcon, MapInformationIcon as MapIcon, TipsIcon, SearchIcon, VerifiedIcon, QuoteIcon, SecuredIcon, LinkIcon, ServerIcon } from 'tdesign-icons-react';
import { useChatStore, type ChatMessage } from '../stores/chat.js';
import { useConfigStore } from '../stores/config.js';
import { useKbStore } from '../stores/kb.js';
import { useCiteStore } from '../stores/cite.js';
import { useThemeStore, type ThemeMode } from '../stores/theme.js';
import { authHeaders } from '../stores/auth.js';
import { REASON_TEXT } from '../qaPrompt.js';
import { EvidenceCard } from './EvidenceCard.js';
import { RichText } from './RichText.js';
import type { ConfigResp, SearchResult, Hit } from '@shared/types.js';

function RateLimitNotice() {
  // 429 限流：服务端返回 {error, retryAfter}。前端展示倒计时 + 禁用提问按钮。
  const [retryAfter, setRetryAfter] = useState<number | null>(null);
  const [reason, setReason] = useState<string>('');
  const [, force] = useState(0);

  // 监听全局 fetch 429：在 ask() / webSearchAnswer 里 throw 429 信息，这里不便挂钩——
  // 改为：useChatStore 的 ask 捕获后写入此组件可见的 sessionStorage 标记，这里轮询。
  // 简化：直接暴露一个 window 事件。
  useEffect(() => {
    function on429(e: Event) {
      const d = (e as CustomEvent).detail || {};
      setReason(d.reason || '已达使用上限');
      setRetryAfter(d.retryAfter || 60);
      force((n) => n + 1);
    }
    window.addEventListener('kqa:rate-limited', on429 as EventListener);
    return () => window.removeEventListener('kqa:rate-limited', on429 as EventListener);
  }, []);

  // 倒计时
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (retryAfter === null) return;
    setLeft(retryAfter);
    const t = setInterval(() => {
      setLeft((n) => {
        if (n <= 1) {
          setRetryAfter(null);
          clearInterval(t);
          return 0;
        }
        return n - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [retryAfter]);

  if (retryAfter === null) return null;
  return (
    <div className="rate-limit-notice" role="alert">
      <b>⏳ {reason}</b> · 约 {left} 秒后恢复
    </div>
  );
}

export function ChatView() {
  const messages = useChatStore((s) => s.messages);
  const ask = useChatStore((s) => s.ask);
  const stop = useChatStore((s) => s.stop);
  const streaming = useChatStore((s) => s.streaming);
  const config = useConfigStore((s) => s.config);
  const retrievalOnly = useConfigStore((s) => s.retrievalOnly);
  const setRetrievalOnly = useConfigStore((s) => s.setRetrievalOnly);
  const newChat = useChatStore((s) => s.newChat);
  const exportConversation = useChatStore((s) => s.exportConversation);
  const docsCount = useKbStore((s) => s.docs.length);

  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  function submit() {
    const q = input.trim();
    if (!q || streaming) return;
    if (!docsCount) return useKbStore.getState().toast('请先导入文档', 'err');
    if (!config?.ready && !retrievalOnly) return useKbStore.getState().toast('未配置大模型', 'err');
    setInput('');
    if (taRef.current) taRef.current.style.height = 'auto';
    void ask(q);
  }

  return (
    <main className="main">
      <header className="topbar">
        <div className="topbar-title">新对话</div>
        <div className="topbar-actions">
          <ThemeToggle />
          <GroupSelect />
          <label className="switch" title="只做检索、不调用大模型">
            <Switch
              size="small"
              value={retrievalOnly}
              onChange={(v: any) => setRetrievalOnly(!!v)}
            />
            <span className="switch-text">仅检索模式</span>
          </label>
          <Button variant="outline" size="small" onClick={newChat}>新对话</Button>
          {messages.length > 0 && (
            <Button
              variant="outline"
              size="small"
              onClick={() => {
                const fmt = confirm('确定 = 导出 Markdown（可读），取消 = 导出 JSON（结构化备份）') ? 'md' : 'json';
                exportConversation(fmt);
              }}
              title="导出当前对话（Markdown 可读 / JSON 结构化备份）"
            >导出</Button>
          )}
        </div>
      </header>

      <div className="chat-scroll" ref={scrollRef}>
        <div className="chat">
          {messages.length === 0 && <Welcome config={config} />}
          {messages.map((m) => (
            <Message key={m.id} msg={m} config={config} />
          ))}
        </div>
      </div>

      <div className="composer-wrap">
        <RateLimitNotice />
        <div className="composer">
          <textarea
            ref={taRef}
            rows={1}
            value={input}
            placeholder="输入问题，优先依据知识库作答…（Enter 发送，Shift+Enter 换行）"
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, 168) + 'px';
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
          ></textarea>
          <div className="composer-actions">
            {streaming && <Button variant="text" size="small" onClick={stop}>停止</Button>}
            <Button
              theme="primary"
              size="small"
              disabled={streaming || !input.trim()}
              onClick={submit}
            >提问</Button>
          </div>
        </div>
        <p className="disclaimer">优先依据知识库检索片段作答；知识库无依据时拒答或联网兜底，兜底回答明确标注非知识库依据，请以引用原文为准。</p>
      </div>
    </main>
  );
}

function ThemeToggle() {
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);
  // 三态循环：system → light → dark → system
  const next: ThemeMode = mode === 'system' ? 'light' : mode === 'light' ? 'dark' : 'system';
  const label = mode === 'system' ? '跟随系统' : mode === 'light' ? '浅色' : '暗色';
  const Icon = mode === 'dark' ? MoonIcon : SunnyIcon;
  return (
    <button
      className="icon-btn"
      title={`主题：${label}（点击切换）`}
      onClick={() => setMode(next)}
      style={{ width: 28, height: 28, border: '1px solid var(--border)' }}
    >
      <Icon />
    </button>
  );
}

/** 知识库分组选择：按 docName 前缀收窄检索范围 */
function GroupSelect() {
  const [groups, setGroups] = useState<{ key: string; label: string; count: number }[]>([]);
  const group = useConfigStore((s) => s.group);
  const setGroup = useConfigStore((s) => s.setGroup);
  useEffect(() => {
    void fetch('/api/kb/groups', { headers: authHeaders() }).then((r) => r.json()).then((d: any) => {
      if (Array.isArray(d?.groups)) setGroups(d.groups);
    }).catch(() => undefined);
  }, []);
  if (groups.length < 2) return null; // 没分组或单一分组不显示
  return (
    <select
      className="group-select"
      value={group || ''}
      onChange={(e) => setGroup(e.target.value || null)}
      title="按知识库分组收窄检索范围"
    >
      <option value="">全部</option>
      {groups.map((g) => (
        <option key={g.key} value={g.key}>{g.label}（{g.count}）</option>
      ))}
    </select>
  );
}

function Welcome({ config }: { config: ConfigResp | null }) {
  const webSearch = !!config?.webSearch;
  return (
    <div className="welcome">
      <div className="welcome-mark">据</div>
      <h2>企业知识问答</h2>
      <p>
        检索导入的知识库，答案仅基于命中原文生成，附可溯源引用。<br />
        无依据时如实拒答{webSearch ? '，可联网搜索补充并标注来源' : ''}，杜绝幻觉与虚构信息。
      </p>
      <div className="welcome-tips">
        <div className="tip">
          <VerifiedIcon /><b>引用溯源</b>答案附 [n] 编号引用，与证据片段一一对应，全部可回溯验证
        </div>
        <div className="tip">
          <SearchIcon /><b>混合检索</b>BM25 词法与 bge-m3 语义向量双路召回，RRF 融合后精排
        </div>
        <div className="tip">
          <MapIcon /><b>原文定位</b>引用可跳转至原文出处，精准高亮对应段落与行号
        </div>
        <div className="tip">
          <QuoteIcon /><b>事实直查</b>命中确定性事实时直接呈现原文，零延迟且无误写
        </div>
        <div className="tip">
          <TipsIcon /><b>诚实拒答</b>知识库无依据时明确说明，不虚构、不冒充、不含糊其辞
        </div>
        <div className="tip">
          {webSearch ? <LinkIcon /> : <SecuredIcon />}
          <b>{webSearch ? '联网兜底' : '企业私有'}</b>
          {webSearch
            ? '拒答后可手动联网搜索补充，结果明确标注非知识库依据'
            : '知识库自建于内网环境，数据不经外部服务，问答全程留痕'}
        </div>
      </div>
      <div className="welcome-kb">
        <ServerIcon />知识库导入支持：拖拽文本与 PDF · Confluence 同步 · 目录批量 · 多分组检索
      </div>
    </div>
  );
}

function Message({ msg, config }: { msg: ChatMessage; config: ConfigResp | null }) {
  const [showTrace, setShowTrace] = useState(false);
  if (msg.role === 'user') {
    return <div className="msg msg-user"><div className="bubble">{msg.question}</div></div>;
  }

  const search = msg.search;
  const noEvidence = !!search && !search.hasEvidence;
  const fallbackAnswered = noEvidence && !!msg.text && !!msg.fallback;
  const webAnswered = noEvidence && !!msg.text && !!msg.webAnswer;
  const retrievalOnlyHit = !!search && search.hasEvidence && !msg.text;
  // 引用密度：无引用句占比 > 0.4 且有有效引用时挂软警告（避免对没引用的答案误报）
  const lowCitation = !!msg.text && !noEvidence && msg.citationGap !== undefined && msg.citationGap > 0.4
    && !msg.fallback && !msg.webAnswer && !!msg.used && msg.used.size > 0;
  const hasTrace = !!search?.trace;

  return (
    <div className="msg msg-bot">
      <div className="bubble">
        <div className="bubble-head">
          {msg.searching && (
            <span className="badge plain" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span className="pulse-indicator"><span className="indicator-dot"></span><span className="indicator-ring"></span></span>
              检索知识库…
            </span>
          )}
          {noEvidence && !fallbackAnswered && !webAnswered && <Tag theme="danger" variant="light" size="small">未检索到依据</Tag>}
          {fallbackAnswered && <Tag theme="warning" variant="light" size="small">未检索到依据 · 模型兜底</Tag>}
          {webAnswered && <Tag theme="warning" variant="light" size="small">未检索到依据 · 联网搜索兜底</Tag>}
          {msg.direct && <Tag theme="success" variant="light" size="small">原文直达</Tag>}
          {retrievalOnlyHit && <Tag theme="success" variant="light" size="small">已找到 {msg.hits?.length || 0} 条依据</Tag>}
          {msg.text && !noEvidence && <Tag theme="success" variant="light" size="small">已回答</Tag>}
          {msg.streaming && (
            <span className="badge plain" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span className="pulse-indicator"><span className="indicator-dot"></span><span className="indicator-ring"></span></span>
              生成中
            </span>
          )}
          {msg.aborted && <Tag theme="warning" variant="light" size="small">已中断</Tag>}
          {hasTrace && (
            <button
              className="aa-btn trace-toggle"
              title="检索链路追踪（改写变体/各路命中/证据门/耗时/拒答原因）"
              onClick={() => setShowTrace((v) => !v)}
            >{showTrace ? '🔧 收起' : '🔧 追踪'}</button>
          )}
        </div>
        {showTrace && hasTrace && search && (
          <SearchTraceView trace={search.trace!} hits={msg.hits} />
        )}
        {msg.searching && (
          <div className="answer thinking-placeholder">
            正在知识库中检索相关内容…
          </div>
        )}
        <div className="answer">
          {fallbackAnswered && (
            <div className="notice notice-warn">
              <b>知识库里没有找到相关内容。</b>以下是模型基于自身知识给出的回答，未有原文依据，请谨慎参考。
            </div>
          )}
          {webAnswered && (
            <div className="notice notice-warn">
              <b>知识库里没有找到相关内容。</b>以下回答基于联网搜索结果（截至搜索时间），非知识库原文依据，请谨慎参考。
            </div>
          )}
          {msg.direct && (
            <div className="notice notice-info">
              <b>原文直达</b>：这个问题命中了高置信片段，未调用大模型，直接展示原文（点击 [1] 角标可定位行号）。
            </div>
          )}
          {msg.marketDirect && (
            <div className="notice notice-info">
              <b>行情直查</b>：命中行情数据接口（东方财富 push2），未调用大模型，直接展示最新快照。收盘时段为收盘价，盘中为实时值；精确历史收盘请以交易所官网为准。
            </div>
          )}
          {(noEvidence && !fallbackAnswered && !webAnswered) && <NoEvidence msg={msg} config={config} />}
          {retrievalOnlyHit && (
            <div className="notice notice-info">
              <b>仅检索模式</b>：未调用大模型，以下为命中片段。
            </div>
          )}
          {msg.text !== undefined && msg.text !== '' && !fallbackAnswered && !webAnswered && (
            msg.used && msg.used.size === 0
              ? (
                <div className="notice notice-warn">
                  <b>这条回答没有标注任何引用编号</b>，无法确认它是否真的来自知识库。
                </div>
              )
              : null
          )}
          {msg.text && (
            <RichText
              text={msg.text}
              hitCount={msg.hits?.length || 0}
              streaming={msg.streaming}
              onCite={(n) => {
                useCiteStore.getState().focus(n);
                document.querySelector('.ev-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
              }}
            />
          )}
          {webAnswered && !!msg.webHits?.length && <WebSources msg={msg} />}
          {msg.text && !msg.streaming && !msg.aborted && (
            <AnswerActions msg={msg} />
          )}
          {!msg.fallback && !msg.webAnswer && !msg.direct && !msg.aborted && msg.text && !msg.streaming && (
            <Followups msg={msg} />
          )}
          {!!msg.factIssues?.length && !msg.fallback && !msg.webAnswer && (
            <div className="notice notice-warn" title="答案中这些数字/IP/版本号在引用片段原文里没有找到，可能是模型转述有出入，请点击角标核对原文">
              <b>事实核对警告</b>：以下数值在引用原文中未找到依据，请核对：
              {msg.factIssues.map((f, i) => (
                <code key={i} style={{ margin: '0 4px' }}>{f}</code>
              ))}
            </div>
          )}
          {lowCitation && (
            <div className="notice notice-warn" title="答案中部分结论句没有标注引用编号，可能并非全部来自知识库，建议核对">
              <b>引用覆盖提示</b>：本回答有部分结论未标注引用编号（{msg.citationGap !== undefined ? Math.round((1 - msg.citationGap) * 100) : 0}% 句带引用），建议核对未标注部分是否确有原文依据。
            </div>
          )}
          {msg.aborted && !msg.text && (
            <div className="notice notice-warn">回答被中断，可重新提问。</div>
          )}
          {!search && msg.streaming && (
            <span className="typing"><i></i><i></i><i></i></span>
          )}
        </div>
        {!!msg.hits?.length && <EvidenceList msg={msg} />}
      </div>
    </div>
  );
}

/** 联网搜索命中的来源列表（可点击，独立于证据卡） */
/** 联网搜索命中的来源列表（可点击，独立于证据卡） */
function WebSources({ msg }: { msg: ChatMessage }) {
  const [collapsed, setCollapsed] = useState(false);
  const hits = msg.webHits || [];
  return (
    <div className="ev-wrap ws-wrap">
      <div className="evidence-head">
        <span>联网来源 · {hits.length} 条（非知识库）</span>
        <button className="collapse-btn" onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? '展开' : '收起'}
        </button>
      </div>
      {!collapsed && (
        <ol className="web-sources">
          {hits.map((h, i) => (
            <li key={i} className="web-source">
              <a href={h.url} target="_blank" rel="noreferrer noopener" className="ws-title" title={h.url}>
                {i + 1}. {h.title || h.url}
              </a>
              <div className="ws-url">{h.url}</div>
              {h.content && <div className="ws-content">{h.content.slice(0, 140)}{h.content.length > 140 ? '…' : ''}</div>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** 跟进问题建议：依据命中片段 + 当前答案生成 3 个"你可能还想问"。
 *  明确标注非知识库依据（LLM 组织的延伸建议）；点击即提问。 */
function Followups({ msg }: { msg: ChatMessage }) {
  const ask = useChatStore((s) => s.ask);
  const streaming = useChatStore((s) => s.streaming);
  if (msg.followupLoading) {
    return (
      <div className="followups followups-loading" title="生成跟进建议中…">
        <span className="followups-label">你可能还想问…</span>
        <span className="followups-spinner"></span>
      </div>
    );
  }
  if (!msg.followups?.length) return null;
  return (
    <div className="followups">
      <div className="followups-label" title="由模型依据当前问答生成，非知识库依据；点击即提问，仍走正常检索流程">
        你可能还想问
      </div>
      <div className="followups-list">
        {msg.followups.map((q, i) => (
          <button
            key={i}
            className="followup-chip"
            disabled={streaming}
            title={streaming ? '当前回答未结束' : '点击提问'}
            onClick={() => { if (!streaming) void ask(q); }}
          >{q}</button>
        ))}
      </div>
    </div>
  );
}

function EvidenceList({ msg }: { msg: ChatMessage }) {
  const [collapsed, setCollapsed] = useState(false);
  const [expandAll, setExpandAll] = useState(false);
  return (
    <div className="ev-wrap">
      <div className="evidence-head">
        <span>引用依据 · {msg.hits?.length || 0} 条</span>
        <div className="ev-head-btns">
          {msg.hits && msg.hits.length > 1 && !collapsed && (
            <button className="collapse-btn" onClick={() => setExpandAll((v) => !v)}>
              {expandAll ? '全部收起' : '全部展开'}
            </button>
          )}
          <button className="collapse-btn" onClick={() => setCollapsed((c) => !c)}>
            {collapsed ? '展开' : '收起'}
          </button>
        </div>
      </div>
      {!collapsed && msg.hits!.map((h, i) => (
        <EvidenceCard key={h.chunkId} no={i + 1} hit={h} defaultOpen={expandAll || i === 0} />
      ))}
    </div>
  );
}

function AnswerActions({ msg }: { msg: ChatMessage }) {
  const ask = useChatStore((s) => s.ask);
  const webSearchAnswer = useChatStore((s) => s.webSearchAnswer);
  const switchPrevVersion = useChatStore((s) => s.switchPrevVersion);
  const config = useConfigStore((s) => s.config);
  const [copied, setCopied] = useState(false);
  const [reneging, setReneging] = useState(false);
  const [voted, setVoted] = useState<'up' | 'down' | null>(null);

  function copy() {
    const text = msg.text || '';
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }).catch(() => {});
  }

  function regen() {
    if (reneging || useChatStore.getState().streaming) return;
    setReneging(true);
    // 原位重新生成：保留历史版本到 prevTexts，不追加新消息
    void ask(msg.question || '', { replaceMsgId: msg.id }).finally(() => setReneging(false));
  }

  function vote(fb: 'up' | 'down') {
    if (voted) return;
    setVoted(fb);
    // 静默上报：失败不打扰用户
    void fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        question: msg.question || '',
        answerExcerpt: (msg.text || '').slice(0, 500),
        hitDocs: (msg.hits || []).slice(0, 5).map((h) => h.docName),
        feedback: fb,
        mode: msg.fallback ? 'fallback' : msg.webAnswer ? 'web' : 'normal',
        convId: null,
      }),
    }).catch(() => undefined);
  }

  return (
    <div className="answer-actions">
      <button className="aa-btn" onClick={copy} title="复制回答（含引用标记）">
        {copied ? '✓ 已复制' : '复制'}
      </button>
      <button className="aa-btn" onClick={regen} disabled={reneging} title="用同样问题重新检索并作答（旧答案保留为历史版本）">
        {reneging ? '生成中…' : '重新生成'}
      </button>
      {!!msg.prevTexts?.length && (
        <button
          className="aa-btn"
          title="切回上一版回答"
          onClick={() => switchPrevVersion(msg.id, -1)}
        >↶ 上一版</button>
      )}
      {config?.webSearch && !msg.webAnswer && (
        <button
          className="aa-btn"
          disabled={!!msg.webSearching || useChatStore.getState().streaming}
          title="知识库答得不满足？联网搜索补充（非知识库依据）"
          onClick={() => void webSearchAnswer(msg.id)}
        >{msg.webSearching ? '搜索中…' : '🌐 联网搜索'}</button>
      )}
      {!msg.fallback && !msg.webAnswer && (
        <>
          <button
            className="aa-btn"
            style={voted === 'up' ? { borderColor: 'var(--ok)', color: 'var(--ok)' } : {}}
            disabled={!!voted}
            title="这条回答有帮助"
            onClick={() => vote('up')}
          >👍</button>
          <button
            className="aa-btn"
            style={voted === 'down' ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : {}}
            disabled={!!voted}
            title="这条回答不准确/没解决我的问题"
            onClick={() => vote('down')}
          >👎</button>
        </>
      )}
    </div>
  );
}

/** 检索链路追踪面板（🔧 展开）：改写变体 / 各路命中 / 证据门 / 耗时 / 拒答原因 / 命中 chunk 明细 */
function SearchTraceView({ trace, hits }: { trace: NonNullable<SearchResult['trace']>; hits?: Hit[] }) {
  const [showChunks, setShowChunks] = useState(false);
  const rows: [string, string][] = [
    ['通道', trace.channel || 'kb'],
    ['证据门', `词法:${trace.gate.lex ? '✓' : '✗'}  向量:${trace.gate.vec ? '✓' : '✗'}`],
    ['词法命中', String(trace.lexHitCount)],
    ['向量命中', String(trace.vecHitCount)],
    ['rerank 保留', String(trace.rerankedCount)],
    ['直查', trace.directAnswer ? '是' : '否'],
    ['拒答原因', trace.reason],
    ['总耗时', `${trace.searchMs}ms`],
  ];
  if (trace.rewriteMs !== undefined) rows.push(['改写耗时', `${trace.rewriteMs}ms`]);
  if (trace.classifyMs !== undefined) rows.push(['分类耗时', `${trace.classifyMs}ms`]);
  if (trace.rerankMs !== undefined) rows.push(['rerank 耗时', `${trace.rerankMs}ms`]);
  return (
    <div className="trace-panel">
      <table className="trace-table">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}><td className="trace-k">{k}</td><td className="trace-v">{v}</td></tr>
          ))}
        </tbody>
      </table>
      {trace.variants.length > 1 && (
        <div className="trace-variants">
          <span className="trace-k">改写变体：</span>
          {trace.variants.map((v, i) => <code key={i}>{v}</code>)}
        </div>
      )}
      {trace.classification?.complex && (
        <div className="trace-variants">
          <span className="trace-k">子问题：</span>
          {trace.classification.subQuestions.map((v, i) => <code key={i}>{v}</code>)}
        </div>
      )}
      {hits && hits.length > 0 && (
        <>
          <button className="trace-chunks-btn" onClick={() => setShowChunks((v) => !v)}>
            {showChunks ? '收起命中明细' : `命中 chunk 明细（${hits.length}）`}
          </button>
          {showChunks && (
            <div className="trace-chunks">
              {hits.map((h, i) => (
                <div key={h.chunkId} className="trace-chunk">
                  <span className="trace-chunk-no">#{i + 1}</span>
                  <span className="trace-chunk-loc">{h.docName} › {h.section} · L{h.startLine}-{h.endLine}</span>
                  <span className="trace-chunk-score" title="融合分">fused={h.fused}</span>
                  <span className="trace-chunk-score" title="归一化相关度">rel={h.rel}</span>
                  {h.lex && (
                    <span className="trace-chunk-lex" title="词法匹配">
                      lex: score={h.lex.score} matched={h.lex.matchedTerms.join(',')}
                    </span>
                  )}
                  {h.sim !== undefined && <span className="trace-chunk-sim" title="向量相似度">sim={h.sim.toFixed(3)}</span>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function NoEvidence({ msg, config }: { msg: ChatMessage; config: ConfigResp | null }) {
  const requestModelNote = useChatStore((s) => s.requestModelNote);
  const webSearchAnswer = useChatStore((s) => s.webSearchAnswer);
  const search = msg.search!;
  const reason = REASON_TEXT[search.reason] || REASON_TEXT['no-match'];
  const near = (search.allScored || []).slice(0, 3);
  const retrievalOnly = useConfigStore((s) => s.retrievalOnly);
  const showActions = config?.ready && !retrievalOnly && !msg.webAnswer;

  return (
    <div className="notice notice-miss">
      <b>知识库里没有找到与「{msg.question}」直接相关的内容，所以这次我不作答。</b><br />
      {reason}<br />
      <span style={{ fontSize: '11.5px', opacity: 0.8 }}>
        建议：换用文档中出现的术语再问一次，或导入相关文档后重试。
        {search.terms.length ? `（本次提取的检索词：${search.terms.slice(0, 6).join('、')}）` : ''}
      </span>
      {near.length > 0 && (
        <div style={{ marginTop: 9, fontSize: 12 }}>
          <div style={{ opacity: 0.6, marginBottom: 4 }}>以下片段相关度较低，仅供参考，未作为依据：</div>
          {near.map((h, i) => (
            <div key={i} style={{ marginBottom: 3 }}>
              · {h.docName}{h.section ? ` › ${h.section}` : ''}
            </div>
          ))}
        </div>
      )}
      {showActions && (
        <div className="no-evidence-actions">
          {!msg.modelNote && (
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => void requestModelNote(msg.id)}
            >让模型补充说明（非知识库依据）</button>
          )}
          {config?.webSearch && (
            <button
              className="btn btn-sm btn-ghost"
              disabled={!!msg.webSearching}
              onClick={() => void webSearchAnswer(msg.id)}
            >{msg.webSearching ? '联网搜索中…' : '🌐 联网搜索（非知识库依据）'}</button>
          )}
        </div>
      )}
      {msg.modelNote && !msg.webAnswer && (
        <div className="notice notice-warn" style={{ marginTop: 8 }}>{msg.modelNote}</div>
      )}
    </div>
  );
}
