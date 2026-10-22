/* ============================================================
   web/stores/convs.ts —— 服务端对话历史（zustand）
   真相在服务端 Qdrant（kqa_conversations）；localStorage 仅作
   当前会话的当前对话 id（kqa.convId）。chat store 在每轮
   ask 完成后调 syncToServer 保存消息。
   ============================================================ */
import { create } from 'zustand';
import { authHeaders, handleUnauthorized } from './auth.js';

export interface ConvSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  messageCount: number;
}

interface ConvMsgWire {
  id: number;
  role: 'user' | 'bot';
  question?: string;
  text?: string;
  hitRefs?: { docName: string; section: string; startLine: number; endLine: number }[];
  used?: number[];
  aborted?: boolean;
  fallback?: boolean;
  webAnswer?: boolean;
  modelNote?: string;
  ts: number;
}

interface ConvDetail extends ConvSummary {
  messages: ConvMsgWire[];
}

interface ConvState {
  convs: ConvSummary[];
  /** 当前对话 id（null = 尚未创建，首次 ask 时懒建） */
  currentId: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
  /** 确保当前对话存在（首次提问懒建），返回 id */
  ensureCurrent: (title?: string) => Promise<string>;
  /** 把消息列表同步到服务端（每轮 ask 完成后调用） */
  syncMessages: (id: string, messages: ConvMsgWire[]) => Promise<void>;
  /** 切换对话：loadMessages 给 chat store 重建 */
  openConv: (id: string) => Promise<ConvDetail | null>;
  renameConv: (id: string, title: string) => Promise<void>;
  togglePin: (id: string) => Promise<void>;
  removeConv: (id: string) => Promise<void>;
  /** 新对话：清 currentId + localStorage（不清服务端记录） */
  startNew: () => void;
}

const LS_KEY = 'kqa.convId';

async function api<T>(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(path, { ...init, headers: { ...authHeaders() } });
  let data: any = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401) { void handleUnauthorized(); return { ok: false, status: 401, data: null as any }; }
  return { ok: res.ok, status: res.status, data };
}

export const useConvStore = create<ConvState>((set, get) => ({
  convs: [],
  currentId: (() => { try { return localStorage.getItem(LS_KEY); } catch { return null; } })(),
  loading: false,

  refresh: async () => {
    set({ loading: true });
    try {
      const r = await api<{ conversations: ConvSummary[] }>('/api/conversations');
      set({ convs: r.data.conversations || [], loading: false });
    } catch {
      set({ loading: false });
    }
  },

  ensureCurrent: async (title) => {
    const cur = get().currentId;
    if (cur) {
      // 校验存在（可能已被删）
      const r = await api(`/api/conversations/${cur}`);
      if (r.ok) return cur;
    }
    const r = await api<{ id: string }>('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: (title || '新对话').slice(0, 60) }),
    });
    if (!r.ok) throw new Error('创建对话失败');
    localStorage.setItem(LS_KEY, r.data.id);
    set({ currentId: r.data.id });
    await get().refresh();
    return r.data.id;
  },

  syncMessages: async (id, messages) => {
    // 节流：失败不阻塞 UI，静默重试交由下轮 ask 的 sync
    await api(`/api/conversations/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
    }).catch(() => undefined);
    // 更新列表时间戳（不整页刷新，只改 updatedAt 排序字段）
    set((s) => ({
      convs: (s.convs || []).map((cv) =>
        cv.id === id ? { ...cv, updatedAt: Date.now(), messageCount: messages.length } : cv),
    }));
  },

  openConv: async (id) => {
    const r = await api<ConvDetail>(`/api/conversations/${id}`);
    if (!r.ok) return null;
    localStorage.setItem(LS_KEY, id);
    set({ currentId: id });
    return r.data;
  },

  renameConv: async (id, title) => {
    await api(`/api/conversations/${id}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    set((s) => ({ convs: (s.convs || []).map((c) => c.id === id ? { ...c, title } : c) }));
  },

  togglePin: async (id) => {
    await api(`/api/conversations/${id}/pin`, { method: 'POST' });
    await get().refresh();
  },

  removeConv: async (id) => {
    await api(`/api/conversations/${id}`, { method: 'DELETE' });
    if (get().currentId === id) {
      localStorage.removeItem(LS_KEY);
      set({ currentId: null });
    }
    await get().refresh();
  },

  startNew: () => {
    localStorage.removeItem(LS_KEY);
    set({ currentId: null });
  },
}));

export type { ConvMsgWire };
