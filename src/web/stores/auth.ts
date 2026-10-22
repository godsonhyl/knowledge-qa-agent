/* ============================================================
   web/stores/auth.ts —— SSO/OIDC 会话（localStorage Bearer 模式）
   与 WeKnora 相同的存储模型：
   - kqa.token        access_token（每个 API 请求带 Authorization: Bearer）
   - kqa.refreshToken refresh_token（静默续期用）
   - kqa.user         {sub,name,email,username}
   回调页 /api/auth/oidc/callback 负责写入这三项后跳回首页。
   ============================================================ */
import { create } from 'zustand';

const TOKEN_KEY = 'kqa.token';
const REFRESH_KEY = 'kqa.refreshToken';
const USER_KEY = 'kqa.user';

export interface SsoUser {
  sub: string;
  name: string;
  email: string;
  username: string;
}

function readToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
function readRefreshToken(): string {
  try { return localStorage.getItem(REFRESH_KEY) || ''; } catch { return ''; }
}
function readUser(): SsoUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw);
    return u && typeof u.sub === 'string' ? u as SsoUser : null;
  } catch { return null; }
}

interface AuthState {
  token: string;
  refreshToken: string;
  user: SsoUser | null;
  /** 会话是否有效（有 token 即视为已登录；过期由服务端 401 兜底） */
  isAuthed: boolean;
  syncFromStorage: () => void;
  logout: () => Promise<void>;
  clearLocal: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: readToken(),
  refreshToken: readRefreshToken(),
  user: readUser(),
  isAuthed: Boolean(readToken()),
  syncFromStorage: () => {
    set({ token: readToken(), refreshToken: readRefreshToken(), user: readUser(), isAuthed: Boolean(readToken()) });
  },
  logout: async () => {
    // 告知服务端（幂等）；失败不阻塞本地登出
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch { /* ignore */ }
    getClear()();
    set({ token: '', refreshToken: '', user: null, isAuthed: false });
  },
  clearLocal: () => {
    getClear()();
    set({ token: '', refreshToken: '', user: null, isAuthed: false });
  },
}));

function getClear() {
  return () => {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(REFRESH_KEY);
      localStorage.removeItem(USER_KEY);
    } catch { /* ignore */ }
  };
}

/** 所有 API fetch 复用：自动带 Bearer 头（无 token 时返回空 headers，兼容 OIDC_REQUIRED=0） */
export function authHeaders(): Record<string, string> {
  const t = readToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/** 收到 401 的统一处理：清凭证回登录页（refresh 续期为后续优化） */
export function handleUnauthorized(): void {
  getClear()();
  useAuthStore.setState({ token: '', refreshToken: '', user: null, isAuthed: false });
  // 回登录页：整页刷新让 App 重新判定（OIDC_REQUIRED=0 时会照常进主界面）
  window.location.href = '/';
}
