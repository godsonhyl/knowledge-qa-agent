/* ============================================================
   web/stores/kb.ts —— 知识库状态（文档列表/导入/蒸馏）
   ============================================================ */
import { create } from 'zustand';
import type { DocMeta, KbStats } from '@shared/types.js';
import { SEED_DOCS } from '@shared/seed.js';

export interface ToastMsg {
  id: number;
  text: string;
  type: '' | 'ok' | 'err';
}

interface KbState {
  docs: DocMeta[];
  stats: KbStats | null;
  loading: boolean;
  distill: { docId: string; done: number; total: number } | null;
  distillAbort: AbortController | null;
  toasts: ToastMsg[];
  refresh: () => Promise<void>;
  toast: (text: string, type?: '' | 'ok' | 'err') => void;
  dismissToast: (id: number) => void;
  addDoc: (name: string, text: string, source: string) => Promise<boolean>;
  importFiles: (files: { name: string; text: string }[]) => Promise<void>;
  importDir: (files: { name: string; text: string }[]) => Promise<void>;
  importConfluence: (url: string, recursive: boolean) => Promise<void>;
  loadSeed: () => Promise<void>;
  removeDoc: (docId: string) => Promise<void>;
  clearAll: () => Promise<void>;
  startDistill: (docId: string) => Promise<void>;
  stopDistill: () => void;
}

const LOCAL_EXTS = new Set(['.txt', '.md', '.csv']);
const FILES_LIMIT = 500;
let toastId = 0;

async function api<T>(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(path, init);
  let data: any = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { ok: res.ok, status: res.status, data };
}

async function readTextFile(name: string, file: File): Promise<string> {
  let text = await file.text();
  if (/\.html?$/i.test(name)) {
    text = text
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\n{3,}/g, '\n\n');
  }
  return text;
}

export const useKbStore = create<KbState>((set, get): KbState => ({
  docs: [],
  stats: null,
  loading: false,
  distill: null,
  distillAbort: null,
  toasts: [],

  refresh: async () => {
    set({ loading: true });
    try {
      const [docsR] = await Promise.all([api<{ docs: DocMeta[] }>('/api/kb/docs')]);
      set({ docs: docsR.data.docs || [] });
      set({ loading: false });
    } catch {
      set({ loading: false });
    }
  },

  toast: (text, type = '') => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, text, type }] }));
    setTimeout(() => get().dismissToast(id), type === 'err' ? 8000 : 3200);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  addDoc: async (name, text, source) => {
    const r = await api<{ docId: string; chunkCount: number; error?: string }>('/api/kb/docs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, text, source }),
    });
    if (r.ok) return true;
    if (r.status === 409) get().toast(`已跳过重复文档：${name}`);
    else get().toast(`导入失败：${r.data?.error || r.status}`, 'err');
    return false;
  },

  importFiles: async (files) => {
    let ok = 0;
    for (const f of files) {
      if (await get().addDoc(f.name, f.text, 'file')) ok++;
    }
    if (ok) get().toast(`已导入 ${ok} 篇文档`, 'ok');
    await get().refresh();
  },

  importDir: async (files) => {
    // 过滤扩展名+隐藏条目+500 上限（此处收到的已是过滤后的）
    let ok = 0;
    let dup = 0;
    const fails: string[] = [];
    for (const f of files.slice(0, FILES_LIMIT)) {
      const r = await api<{ error?: string }>('/api/kb/docs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: f.name, text: f.text, source: 'file' }),
      });
      if (r.ok) ok++;
      else if (r.status === 409) dup++;
      else fails.push(`${f.name}：${r.data?.error || 'failed'}`);
    }
    if (ok) get().toast(`已导入 ${ok} 篇文档`, 'ok');
    if (dup) get().toast(`已跳过重复文档 ${dup} 篇`);
    if (fails.length) get().toast(`${fails.length} 篇未导入：${fails[0]}`, 'err');
    await get().refresh();
  },

  importConfluence: async (url, recursive) => {
    get().toast(recursive ? '抓取子树中…' : '抓取中…');
    const r = await api<{ pages?: { name: string; text: string }[]; text?: string; title?: string; skipped?: unknown[]; truncated?: boolean; error?: string }>('/api/confluence-page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, recursive }),
    });
    if (!r.ok) {
      get().toast(`导入失败：${r.data?.error || r.status}`, 'err');
      return;
    }
    if (!recursive) {
      const name = `${r.data.title || 'Confluence 页面'}.md`;
      await get().addDoc(name, r.data.text || '', 'confluence');
    } else {
      const pages = r.data.pages || [];
      let ok = 0; let dup = 0;
      for (const p of pages) {
        const rr = await api<{ error?: string }>('/api/kb/docs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: p.name, text: p.text, source: 'confluence' }),
        });
        if (rr.ok) ok++;
        else if (rr.status === 409) dup++;
      }
      if (ok) get().toast(`已导入 ${ok} 篇 Confluence 页面`, 'ok');
      if (dup) get().toast(`已跳过重复页面 ${dup} 篇`);
      if (r.data.truncated) get().toast('子树页面过多，达到 200 页上限，仅导入前一部分', 'err');
      if ((r.data.skipped || []).length) get().toast(`${(r.data.skipped as unknown[]).length} 个被跳过`, 'err');
    }
    await get().refresh();
  },

  loadSeed: async () => {
    const r = await api<{ added: number; error?: string }>('/api/kb/docs/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docs: SEED_DOCS }),
    });
    if (r.ok && r.data?.added) get().toast(`已载入 ${(r.data as { added: number }).added} 篇示例文档`, 'ok');
    else get().toast('示例知识库已存在', 'err');
    await get().refresh();
  },

  removeDoc: async (docId) => {
    await api(`/api/kb/docs/${docId}`, { method: 'DELETE' });
    get().toast('已删除', 'ok');
    await get().refresh();
  },

  clearAll: async () => {
    await api('/api/kb/docs', { method: 'DELETE' });
    get().toast('知识库已清空', 'ok');
    await get().refresh();
  },

  startDistill: async (docId) => {
    if (get().distill) return get().toast('蒸馏进行中', 'err');
    const r = await api<{ chunks: { index: number; summary: string | null }[] }>(`/api/kb/docs/${docId}/chunks`);
    if (!r.ok) return get().toast('获取切片失败', 'err');
    const pending = (r.data.chunks || []).filter((c) => !c.summary || !c.summary.trim());
    const total = (r.data.chunks || []).length;
    if (!pending.length) {
      get().toast('全部切片已蒸馏过');
      return;
    }
    const abort = new AbortController();
    set({ distill: { docId, done: total - pending.length, total }, distillAbort: abort });
    let failed = 0;
    for (const c of pending) {
      if (abort.signal.aborted) break;
      try {
        const dr = await fetch(`/api/kb/docs/${docId}/chunks/${c.index}/distill`, {
          method: 'POST',
          signal: abort.signal,
        });
        if (!dr.ok) failed++;
      } catch {
        break;
      }
      set((s) => ({ distill: s.distill ? { ...s.distill, done: s.distill.done + 1 } : null }));
    }
    const done = get().distill?.done ?? 0;
    set({ distill: null, distillAbort: null });
    get().toast(`蒸馏完成：${done}/${total}${failed ? `（${failed} 失败）` : ''}`, failed ? 'err' : 'ok');
    await get().refresh();
  },
  stopDistill: () => {
    get().distillAbort?.abort();
  },
}));

export { readTextFile, LOCAL_EXTS };
