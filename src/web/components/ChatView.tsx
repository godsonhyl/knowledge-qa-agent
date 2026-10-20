import { useEffect, useRef, useState } from 'react';
import { useChatStore, type ChatMessage } from '../stores/chat.js';
import { useConfigStore } from '../stores/config.js';
import { useKbStore } from '../stores/kb.js';
import { REASON_TEXT } from '../qaPrompt.js';
import { EvidenceCard } from './EvidenceCard.js';
import { RichText } from './RichText.js';
import type { ConfigResp } from '@shared/types.js';

export function ChatView() {
  const messages = useChatStore((s) => s.messages);
  const ask = useChatStore((s) => s.ask);
  const stop = useChatStore((s) => s.stop);
  const streaming = useChatStore((s) => s.streaming);
  const config = useConfigStore((s) => s.config);
  const retrievalOnly = useConfigStore((s) => s.retrievalOnly);
  const setRetrievalOnly = useConfigStore((s) => s.setRetrievalOnly);
  const newChat = useChatStore((s) => s.newChat);
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
          <label className="switch" title="只做检索、不调用大模型">
            <input
              type="checkbox"
              checked={retrievalOnly}
              onChange={(e) => setRetrievalOnly(e.target.checked)}
            />
            <span className="switch-text">仅检索模式</span>
          </label>
          <button className="btn btn-sm btn-ghost" onClick={newChat}>新对话</button>
        </div>
      </header>

      <div className="chat-scroll" ref={scrollRef}>
        <div className="chat">
          {messages.length === 0 && <Welcome />}
          {messages.map((m) => (
            <Message key={m.id} msg={m} config={config} />
          ))}
        </div>
      </div>

      <div className="composer-wrap">
        <div className="composer">
          <textarea
            ref={taRef}
            rows={1}
            value={input}
            placeholder="基于知识库提问…（Enter 发送，Shift+Enter 换行）"
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
            {streaming && <button className="btn btn-ghost btn-sm" onClick={stop}>停止</button>}
            <button
              className="btn btn-primary btn-sm"
              disabled={streaming || !input.trim()}
              onClick={submit}
            >提问</button>
          </div>
        </div>
        <p className="disclaimer">回答由大模型基于检索片段生成，可能存在误差；请以引用原文为准。</p>
      </div>
    </main>
  );
}

function Welcome() {
  return (
    <div className="welcome">
      <div className="welcome-mark">据</div>
      <h2>我只根据知识库回答</h2>
      <p>
        提问后我会先在知识库里检索片段，再让大模型<b>仅基于检索到的原文</b>作答。<br />
        每个结论都会标出引用编号，点击可定位到原文位置。<br />
        <b>检索不到依据时，我会直接说「没查到」，不会靠模型记忆作答。</b>
      </p>
    </div>
  );
}

function Message({ msg, config }: { msg: ChatMessage; config: ConfigResp | null }) {
  if (msg.role === 'user') {
    return <div className="msg msg-user"><div className="bubble">{msg.question}</div></div>;
  }

  const search = msg.search;
  const noEvidence = !!search && !search.hasEvidence;
  const retrievalOnlyHit = !!search && search.hasEvidence && !msg.text;

  return (
    <div className="msg msg-bot">
      <div className="bubble">
        <div className="bubble-head">
          {noEvidence && <span className="badge miss">未检索到依据</span>}
          {retrievalOnlyHit && <span className="badge ok">已找到 {msg.hits?.length || 0} 条依据</span>}
          {msg.text && <span className="badge ok">已回答</span>}
          {msg.streaming && <span className="badge">生成中</span>}
          {msg.aborted && <span className="badge warn">已中断</span>}
        </div>
        <div className="answer">
          {noEvidence && <NoEvidence msg={msg} config={config} />}
          {retrievalOnlyHit && (
            <div className="notice notice-info">
              <b>仅检索模式</b>：未调用大模型，以下为命中片段。
            </div>
          )}
          {msg.text !== undefined && msg.text !== '' && (
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
              onCite={() => {
                document.querySelector('.ev-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
              }}
            />
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

function EvidenceList({ msg }: { msg: ChatMessage }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="ev-wrap">
      <div className="evidence-head">
        <span>引用依据 · {msg.hits?.length || 0} 条</span>
        <button className="collapse-btn" onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? '展开' : '收起'}
        </button>
      </div>
      {!collapsed && msg.hits!.map((h, i) => (
        <EvidenceCard key={h.chunkId} no={i + 1} hit={h} defaultOpen={i === 0} />
      ))}
    </div>
  );
}

function NoEvidence({ msg, config }: { msg: ChatMessage; config: ConfigResp | null }) {
  const requestModelNote = useChatStore((s) => s.requestModelNote);
  const search = msg.search!;
  const reason = REASON_TEXT[search.reason] || REASON_TEXT['no-match'];
  const near = (search.allScored || []).slice(0, 3);
  const retrievalOnly = useConfigStore((s) => s.retrievalOnly);

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
      {config?.ready && !retrievalOnly && !msg.modelNote && (
        <button
          className="btn btn-sm btn-ghost"
          style={{ marginTop: 8 }}
          onClick={() => void requestModelNote(msg.id)}
        >让模型补充说明（非知识库依据）</button>
      )}
      {msg.modelNote && (
        <div className="notice notice-warn" style={{ marginTop: 8 }}>{msg.modelNote}</div>
      )}
    </div>
  );
}
