/* ============================================================
   web/stores/theme.ts —— 主题切换（light / dark / system）
   写 <html theme-mode="dark">，tdesign dist css 自带双主题变量块。
   ============================================================ */
import { create } from 'zustand';

export type ThemeMode = 'light' | 'dark' | 'system';

const LS_KEY = 'kqa.theme';

function readStored(): ThemeMode {
  try {
    const v = localStorage.getItem(LS_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch { /* ignore */ }
  return 'system';
}

function systemDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyTheme(mode: ThemeMode) {
  const dark = mode === 'dark' || (mode === 'system' && systemDark());
  document.documentElement.setAttribute('theme-mode', dark ? 'dark' : 'light');
  // tdesign 同时识别 .dark class；双写保持组件样式一致
  document.documentElement.classList.toggle('dark', dark);
  // 与自签主题同步（避免背景闪白）
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

interface ThemeState {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
  init: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  mode: readStored(),
  setMode: (m) => {
    localStorage.setItem(LS_KEY, m);
    set({ mode: m });
    applyTheme(m);
  },
  init: () => {
    applyTheme(get().mode);
    // 跟随系统：mode==='system' 时监听变化
    if (typeof matchMedia === 'function') {
      const mq = matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener('change', () => {
        if (get().mode === 'system') applyTheme('system');
      });
    }
  },
}));
