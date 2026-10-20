/* ============================================================
   web/stores/chat.ts —— 对话状态（SSE 流式 + 引用校验 + localStorage）
   ============================================================ */
import { create } from 'zustand';
import type { SearchResult, Hit } from '@shared/types.js';
import { SYSTEM_PROMPT, REASON_TEXT } from '../qaPrompt.js';
import { validateCitations } from '../citations.js';

export interface ChatMessage {
  id: number;
  role: 'user' | 'bot';
  question?: string;
  search?: SearchResult;
  hits?: Hit[];
  /** 流式回答文本（完成后固化） */
  text?: string;
  /** 引用校验结果 */
  used?: Set<number>;
  streaming?: boolean;
  aborted?: boolean;
  modelNote?: string;     // 拒答后"让模型补充说明"的文本
}

interface ChatState {
  messages: ChatMessage[];
  streaming: boolean;
  abort: AbortController | null;
  ask: (question: string) => Promise<void>;
  stop: () => void;
  newChat: () => void;
  requestModelNote: (msgId: number) => Promise<void>;
  restore: () => void;
}

const LS_KEY = 'kqa.chat.v2';
let msgId = 0;

function serialize(messages: ChatMessage[]): string {
  return JSON.stringify(messages.slice(-30).map((m) => ({
    ...m,
    used: m.used ? Array.from(m.used) : undefined,
    streaming: false,
  })));
}

function deserialize(): ChatMessage[] {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
    return arr.map((m: any) => ({ ...m, used: m.used ? new Set(m.used) : undefined }));
  } catch {
    return [];
  }
}

/** SSE 解析（移植自 app.js callModel）：返回完整文本；中断返回 null */
async function callModel(messages: { role: string; content: string }[], signal: AbortSignal): Promise<string | null> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
    signal,
  }).catch((e: Error) => {
    if (e.name === 'AbortError') throw e;
    throw new Error(`网络请求失败：${e.message}`);
  });

  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = j.error || j.detail || ''; } catch { /* ignore */ }
    throw new Error(`模型接口返回 ${res.status}：${String(detail).slice(0, 200)}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let out = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split(/\r?\n\r?\n/);
    buf = parts.pop() || '';
    for (const part of parts) {
      const line = part.split(/\r?\n/).find((l) => l.startsWith('data:'));
      if (!line) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        if (json.error) throw new Error(json.error.message || json.error);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) out += delta;
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
  }
  return out;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  streaming: false,
  abort: null,

  ask: async (question) => {
    const cfgStore = await import('./config.js');
    const cfg = cfgStore.useConfigStore.getState();
    if (get().streaming) return;

    const { sensitivity, topK, retrievalOnly } = cfg;
    const userMsg: ChatMessage = { id: ++msgId, role: 'user', question };

    // 1. 检索（服务端做）
    const searchR = await fetch('/api/kb/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, topK, sensitivity }),
    });
    const search = await searchR.json() as SearchResult;

    const botId = ++msgId;
    const botMsg: ChatMessage = {
      id: botId, role: 'bot', question, search, hits: search.hits, streaming: true,
    };
    set((s) => ({ messages: [...s.messages, userMsg, botMsg], }));
    localStorage.setItem(LS_KEY, serialize(get().messages));

    // 2. 无据拒答（LLM 不被调用）
    if (!search.hasEvidence || retrievalOnly) {
      set((s) => ({
        messages: s.messages.map((m) => m.id === botId ? { ...m, streaming: false } : m),
      }));
      localStorage.setItem(LS_KEY, serialize(get().messages));
      return;
    }

    // 3. 构建 evidence prompt，流式调 LLM
    const evidenceBlock = search.hits.map((h, i) => {
      const loc = `${h.docName}${h.section ? ' › ' + h.section : ''}（第 ${h.startLine}-${h.endLine} 行）`;
      const summaryLine = h.summary ? `\n（知识点：${h.summary}）` : '';
      return `【片段 ${i + 1}】来源：${loc}\n${h.text}${summaryLine}`;
    }).join('\n\n');
    const userPrompt = `「参考片段」如下：\n\n${evidenceBlock}\n\n---\n\n问题：${question}\n\n请严格依据上述片段作答，并为每个结论标注来源编号。如果片段不足，直接说明未找到。`;

    const abort = new AbortController();
    set({ streaming: true, abort });

    try {
      const out = await callModel([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ], abort.signal);
      const text = (out || '').trim();
      if (text) {
        const { used } = validateCitations(text, search.hits.length);
        set((s) => ({
          messages: s.messages.map((m) => m.id === botId
            ? { ...m, text, used, streaming: false }
            : m),
        }));
      } else {
        set((s) => ({
          messages: s.messages.map((m) => m.id === botId
            ? { ...m, text: '', streaming: false, aborted: true }
            : m),
        }));
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        set((s) => ({
          messages: s.messages.map((m) => m.id === botId ? { ...m, streaming: false, aborted: true } : m),
        }));
      } else {
        set((s) => ({
          messages: s.messages.map((m) => m.id === botId
            ? { ...m, streaming: false, text: `⚠️ ${e?.message || e}` }
            : m),
        }));
      }
    }
    set({ streaming: false, abort: null });
    localStorage.setItem(LS_KEY, serialize(get().messages));
  },

  stop: () => {
    get().abort?.abort();
  },

  newChat: () => {
    set({ messages: [] });
    localStorage.removeItem(LS_KEY);
  },

  requestModelNote: async (msgId2) => {
    const msg = get().messages.find((m) => m.id === msgId2);
    if (!msg || !msg.question) return;
    const near = msg.search?.allScored?.slice(0, 3) || [];
    const nearCtx = near.length
      ? `\n\n（检索到的低分片段，供参考，不足以支撑回答：\n${near.map((h, i) => `${i + 1}. ${h.docName}${h.section ? ' › ' + h.section : ''}：${h.text.slice(0, 200)}`).join('\n')}\n）`
      : '';
    const messages = [
      {
        role: 'system',
        content: '你是知识库问答助手的拒答辅助。用户的问题在知识库里没有检索到依据，主回答已如实告知「没查到」。你的任务是给出一段简短、诚实的补充说明，帮助用户推进。规则：1. 开头明确说知识库里没有这个主题，不要假装知道。2. 可以基于你的通用理解解释这个概念通常指什么、或建议导入哪类文档，但必须避免给出长篇的、像正式答案的输出。3. 全文不超过 5 句话。4. 不要使用引用编号，不要编造知识库内容。',
      },
      { role: 'user', content: `问题：${msg.question}${nearCtx}\n\n请给出补充说明。` },
    ];
    try {
      const out = await callModel(messages, new AbortController().signal);
      set((s) => ({
        messages: s.messages.map((m) => m.id === msgId2 ? { ...m, modelNote: (out || '').trim() || '（模型没有返回内容）' } : m),
      }));
    } catch (e: any) {
      set((s) => ({
        messages: s.messages.map((m) => m.id === msgId2 ? { ...m, modelNote: `⚠️ ${e?.message || e}` } : m),
      }));
    }
  },

  restore: () => {
    const msgs = deserialize();
    msgId = msgs.length ? msgs[msgs.length - 1]!.id : 0;
    set({ messages: msgs });
  },
}));

void REASON_TEXT;
