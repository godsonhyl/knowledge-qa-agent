/* ============================================================
   web/stores/cite.ts —— 引用角标 ↔ 证据卡联动状态
   点击文中 [n] → 滚动并高亮对应证据卡（focusNo）
   悬停证据卡 → 高亮文中所有同号 [n]（hoverNo）
   ============================================================ */
import { create } from 'zustand';

interface CiteState {
  /** 被「点中」的编号：滚动+高亮对应证据卡 */
  focusNo: number | null;
  /** 被「悬停」的编号：高亮文中所有同号角标 */
  hoverNo: number | null;
  focus: (n: number) => void;
  clearFocus: () => void;
  setHover: (n: number | null) => void;
}

export const useCiteStore = create<CiteState>((set) => ({
  focusNo: null,
  hoverNo: null,
  focus: (n) => set({ focusNo: n }),
  clearFocus: () => set({ focusNo: null }),
  setHover: (n) => set({ hoverNo: n }),
}));
