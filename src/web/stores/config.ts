/* ============================================================
   web/stores/config.ts —— 配置（灵敏度/topK/温度/仅检索）持久到 localStorage
   ============================================================ */
import { create } from 'zustand';
import type { ConfigResp } from '@shared/types.js';

interface ConfigState {
  config: ConfigResp | null;
  sensitivity: number;
  topK: number;
  temperature: number;
  retrievalOnly: boolean;
  /** 无据兜底：检索无依据时让 LLM 用自身知识回答（默认开）。关掉则回到纯拒答。 */
  fallbackOnNoEvidence: boolean;
  loadConfig: () => Promise<void>;
  setSensitivity: (v: number) => void;
  setTopK: (v: number) => void;
  setTemperature: (v: number) => void;
  setRetrievalOnly: (v: boolean) => void;
  setFallbackOnNoEvidence: (v: boolean) => void;
  persist: () => void;
}

const LS_KEY = 'kqa.config.v2';

function loadLocal(): { sensitivity: number; topK: number; temperature: number; retrievalOnly: boolean; fallbackOnNoEvidence: boolean } {
  try {
    const r = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    return {
      sensitivity: typeof r.sensitivity === 'number' ? r.sensitivity : 50,
      topK: typeof r.topK === 'number' ? r.topK : 8,
      temperature: typeof r.temperature === 'number' ? r.temperature : 0.2,
      retrievalOnly: Boolean(r.retrievalOnly),
      fallbackOnNoEvidence: typeof r.fallbackOnNoEvidence === 'boolean' ? r.fallbackOnNoEvidence : true,
    };
  } catch {
    return { sensitivity: 50, topK: 8, temperature: 0.2, retrievalOnly: false, fallbackOnNoEvidence: true };
  }
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  config: null,
  ...loadLocal(),
  loadConfig: async () => {
    try {
      const res = await fetch('/api/config', { cache: 'no-store' });
      const c = await res.json() as ConfigResp;
      set({ config: c });
    } catch {
      set({ config: null });
    }
  },
  setSensitivity: (v) => { set({ sensitivity: v }); get().persist(); },
  setTopK: (v) => { set({ topK: v }); get().persist(); },
  setTemperature: (v) => { set({ temperature: v }); get().persist(); },
  setRetrievalOnly: (v) => { set({ retrievalOnly: v }); get().persist(); },
  setFallbackOnNoEvidence: (v) => { set({ fallbackOnNoEvidence: v }); get().persist(); },
  persist: () => {
    const { sensitivity, topK, temperature, retrievalOnly, fallbackOnNoEvidence } = get();
    localStorage.setItem(LS_KEY, JSON.stringify({ sensitivity, topK, temperature, retrievalOnly, fallbackOnNoEvidence }));
  },
}));
