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

/** access_token 里带的 realm 角色（用于管理员判定：前端按角色显示清空按钮、跳过令牌输入）。
 *  优先读回调页写入的 kqa.roles；缺省（如直接从站外进入）则解码 token payload 兜底。 */
function readRoles(): string[] {
  try {
    const saved = localStorage.getItem('kqa.roles');
    if (saved) {
      const r = JSON.parse(saved);
      if (Array.isArray(r)) return r.filter((x: unknown) => typeof x === 'string');
    }
    const t = localStorage.getItem(TOKEN_KEY);
    if (!t) return [];
    const payload = t.split('.')[1];
    if (!payload) return [];
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    const roles = claims?.realm_access?.roles;
    return Array.isArray(roles) ? roles.filter((r: unknown) => typeof r === 'string') : [];
  } catch { return []; }
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
  roles: string[];
  /** SSO 模式下的管理员角色（realm_access.roles 含 admin） */
  isAdmin: boolean;
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
  roles: readRoles(),
  isAdmin: readRoles().includes('admin'),
  isAuthed: Boolean(readToken()),
  syncFromStorage: () => {
    const roles = readRoles();
    set({ token: readToken(), refreshToken: readRefreshToken(), user: readUser(), roles, isAdmin: roles.includes('admin'), isAuthed: Boolean(readToken()) });
  },
  logout: async () => {
    // 告知服务端（幂等）；失败不阻塞本地登出
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch { /* ignore */ }
    getClear()();
    set({ token: '', refreshToken: '', user: null, roles: [], isAdmin: false, isAuthed: false });
  },
  clearLocal: () => {
    getClear()();
    set({ token: '', refreshToken: '', user: null, roles: [], isAdmin: false, isAuthed: false });
  },
}));

function getClear() {
  return () => {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(REFRESH_KEY);
      localStorage.removeItem(USER_KEY);
      localStorage.removeItem('kqa.roles');
    } catch { /* ignore */ }
  };
}

/** 所有 API fetch 复用：自动带 Bearer 头（无 token 时返回空 headers，兼容 OIDC_REQUIRED=0） */
export function authHeaders(): Record<string, string> {
  const t = readToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/** 收到 401 的统一处理：先尝试用 refresh_token 静默续期一次；失败再清凭证回登录页 */
export async function handleUnauthorized(): Promise<void> {
  const rt = readRefreshToken();
  if (rt && !refreshing) {
    refreshing = true;
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      });
      if (res.ok) {
        const d: any = await res.json().catch(() => null);
        if (d?.success && d.token) {
          localStorage.setItem(TOKEN_KEY, d.token);
          if (d.refreshToken) localStorage.setItem(REFRESH_KEY, d.refreshToken);
          throw new TokenRefreshed();
        }
      }
    } catch (e) {
      if (e instanceof TokenRefreshed) { refreshing = false; return; }
      // 网络错误继续走登出
    } finally { refreshing = false; }
  }
  getClear()();
  useAuthStore.setState({ token: '', refreshToken: '', user: null, roles: [], isAdmin: false, isAuthed: false });
  // 回登录页：整页刷新让 App 重新判定（OIDC_REQUIRED=0 时会照常进主界面）
  window.location.href = '/';
}

class TokenRefreshed extends Error {}
let refreshing = false;
