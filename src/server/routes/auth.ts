/* ============================================================
   server/routes/auth.ts —— OIDC 路由（登录/回调/刷新/登出）
   挂载在 /api/auth
   ============================================================ */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { ENV, oidcReady } from '../env.js';
import {
  buildAuthUrl, createNonce, createPkceVerifier, exchangeCode, savePending, takePending,
  verifyIdToken, verifyAccessToken, refreshAccessToken, endSessionUrl, userFromClaims, fetchUserinfo,
  type SsoUser, type JwtClaims,
} from '../oidc.js';

export const authRoute = new Hono();

/** GET /api/auth/oidc/config —— 登录页探测（与 WeKnora 对齐） */
authRoute.get('/oidc/config', (c) => {
  const enabled = oidcReady();
  return c.json({
    success: true,
    enabled,
    provider_display_name: ENV.OIDC_REQUIRED ? 'SSO 登录' : 'SSO 登录（可选）',
  });
});

/** GET /api/auth/oidc/login —— 生成 state+PKCE，302 到 Keycloak authorize */
authRoute.get('/oidc/login', async (c) => {
  if (!oidcReady()) return c.json({ error: 'OIDC 未配置' }, 503);
  try {
    const state = createNonce();
    const verifier = createPkceVerifier();
    savePending(state, verifier);
    const url = await buildAuthUrl(state, verifier);
    return c.redirect(url, 302);
  } catch (err) {
    return c.json({ error: `跳转 SSO 失败：${(err as Error).message}` }, 500);
  }
});

/** GET /api/auth/oidc/callback —— Keycloak 回调：校 state → 换 token → 验 id_token → 写前端 localStorage
 *  返回一段极简 HTML：把 token 注入 localStorage 后跳回首页（与 WeKnora localStorage Bearer 模式一致）。
 *  注：Flask demo 用 userinfo 端点取用户信息；Keycloak 的 id_token 自带 claims，这里优先用 id_token，
 *  无 id_token 时回退 userinfo。roles 取自 access_token 的 realm_access.roles。 */
authRoute.get('/oidc/callback', async (c) => {
  if (!oidcReady()) return c.json({ error: 'OIDC 未配置' }, 503);
  const code = c.req.query('code') || '';
  const state = c.req.query('state') || '';
  const errParam = c.req.query('error') || '';
  if (errParam) return errorPage(c, `SSO 拒绝：${errParam}${c.req.query('error_description') ? ' — ' + c.req.query('error_description') : ''}`);
  if (!code || !state) return errorPage(c, '回调缺少 code/state 参数');
  const verifier = takePending(state);
  if (!verifier) return errorPage(c, '登录状态已过期，请重新登录（state 不匹配或超 5 分钟）');
  try {
    const tokens = await exchangeCode(code, verifier);
    if (!tokens.access_token) return errorPage(c, 'token 端点未返回 access_token');
    // 优先验 id_token 拿 claims；无 id_token 则走 userinfo（与 Flask demo 同路径）
    let claims: JwtClaims | null = null;
    if (tokens.id_token) {
      try { claims = await verifyIdToken(tokens.id_token); } catch { claims = null; }
    }
    if (!claims) {
      const info = await fetchUserinfo(tokens.access_token);
      if (info) claims = info;
    }
    let user: SsoUser | null = null;
    let roles: string[] = [];
    if (claims) {
      user = userFromClaims(claims);
    }
    if (tokens.access_token) {
      // access_token 自带 realm_access.roles（Keycloak 特有），前端 admin 判定用
      try {
        const atClaims = await verifyAccessToken(tokens.access_token);
        const r = (atClaims as any)?.realm_access?.roles;
        if (Array.isArray(r)) roles = r.filter((x: unknown) => typeof x === 'string');
      } catch { /* access_token 验签失败不阻断登录（id_token 已验过） */ }
    }
    return injectTokensPage(c, tokens, user, roles);
  } catch (err) {
    return errorPage(c, `登录失败：${(err as Error).message}`);
  }
});

/** GET /api/auth/me —— 当前登录用户信息（前端探针用；未登录返回 401）。
 *  与 Flask demo 的 g.user 对齐：返回 sub/name/email/username/roles。 */
authRoute.get('/me', async (c) => {
  if (!oidcReady()) return c.json({ error: 'OIDC 未配置' }, 503);
  const auth = c.req.header('Authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!bearer) return c.json({ error: '未登录' }, 401);
  try {
    const claims = await verifyAccessToken(bearer);
    const r = (claims as any)?.realm_access?.roles;
    const roles = Array.isArray(r) ? r.filter((x: unknown) => typeof x === 'string') : [];
    return c.json({ success: true, user: { ...userFromClaims(claims), roles } });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 401);
  }
});

/** POST /api/auth/refresh —— 用 refresh_token 续期 {refreshToken} → {token, refreshToken?} */
authRoute.post('/refresh', async (c) => {
  if (!oidcReady()) return c.json({ error: 'OIDC 未配置' }, 503);
  let body: any;
  try { body = await c.req.json(); } catch { body = {}; }
  const rt = String(body?.refreshToken || '');
  if (!rt) return c.json({ error: '缺少 refreshToken' }, 400);
  try {
    const tokens = await refreshAccessToken(rt);
    return c.json({
      success: true,
      token: tokens.access_token,
      refreshToken: tokens.refresh_token || rt, // Keycloak 可能不返回新 refresh_token，沿用旧的
    });
  } catch (err) {
    return c.json({ success: false, error: (err as Error).message }, 401);
  }
});

/** POST /api/auth/logout —— 清服务端状态；可选跳 Keycloak end_session。
 *  前端负责清 localStorage，本接口仅作幂等收尾。 */
authRoute.post('/logout', async (c) => {
  // 服务端 pending state 本就在回调时删除，这里仅回 ok。
  // 若要单点登出，前端可用 endSessionUrl 跳 Keycloak，本接口返回该 URL（如配置了）。
  const postLogout = ENV.OIDC_REDIRECT_URI ? new URL(ENV.OIDC_REDIRECT_URI).origin + '/' : '/';
  const endUrl = oidcReady() ? await endSessionUrl(postLogout).catch(() => null) : null;
  return c.json({ success: true, endSessionUrl: endUrl });
});

/* ---------- 回调成功页：注入 localStorage 后跳首页 ---------- */
function injectTokensPage(c: Context, tokens: { access_token: string; refresh_token?: string; id_token?: string }, user: SsoUser | null, roles: string[]): Response {
  const token = tokens.access_token;
  const refreshToken = tokens.refresh_token || '';
  const userJson = user ? JSON.stringify(user) : '';
  const rolesJson = JSON.stringify(roles);
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>登录中…</title></head><body>
<p style="font-family:sans-serif;text-align:center;margin-top:40vh">登录成功，正在跳转…</p>
<script>
try {
  localStorage.setItem('kqa.token', ${JSON.stringify(token)});
  localStorage.setItem('kqa.refreshToken', ${JSON.stringify(refreshToken)});
  if (${userJson ? 'true' : 'false'}) localStorage.setItem('kqa.user', ${JSON.stringify(userJson)});
  localStorage.setItem('kqa.roles', ${rolesJson});
} catch (e) {}
location.href = '/';
</script>
</body></html>`;
  return c.html(html);
}

function errorPage(c: Context, msg: string): Response {
  const safe = msg.replace(/[<>&"]/g, (s) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[s]!));
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>登录失败</title></head><body>
<div style="font-family:sans-serif;max-width:480px;margin:20vh auto;text-align:center">
<h2>SSO 登录失败</h2>
<p style="color:#d54941">${safe}</p>
<button onclick="location.href='/'" style="padding:8px 20px;cursor:pointer">返回首页</button>
</div></body></html>`;
  return c.html(html, 400);
}
