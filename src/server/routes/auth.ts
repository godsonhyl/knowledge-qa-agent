/* ============================================================
   server/routes/auth.ts —— OIDC 路由（登录/回调/刷新/登出）
   挂载在 /api/auth
   ============================================================ */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { ENV, oidcReady, localAuthReady } from '../env.js';
import {
  buildAuthUrl, createNonce, createPkceVerifier, exchangeCode, savePending, takePending,
  verifyIdToken, verifyAccessToken, refreshAccessToken, endSessionUrl, userFromClaims, fetchUserinfo,
  type SsoUser, type JwtClaims,
} from '../oidc.js';
import {
  ensureUsersCollection, findUserByEmail, findUserByOidcSub, createUser, touchLogin,
  hashPassword, verifyPassword, isValidEmail, signLocalJwt, verifyLocalJwt, isLocalJwt,
  type UserPayload,
} from '../users.js';

export const authRoute = new Hono();

/** GET /api/auth/oidc/config —— 登录页探测（与 WeKnora 对齐） */
authRoute.get('/oidc/config', (c) => {
  const enabled = oidcReady();
  const localEnabled = localAuthReady();
  return c.json({
    success: true,
    enabled,
    localEnabled,
    registrationEnabled: localEnabled,
    provider_display_name: ENV.OIDC_REQUIRED ? 'SSO 登录' : 'SSO 登录（可选）',
  });
});

/* ---------- 把内部 UserPayload 转成前端 SsoUser ---------- */
function toFrontUser(u: UserPayload): SsoUser {
  return {
    sub: u.oidcSub || u.email,
    name: u.name || u.username || u.email,
    email: u.email,
    username: u.username || u.email,
  };
}

/* ---------- 本地账号：注册 ---------- */
/** POST /api/auth/register {email, password, name?} → {token, refreshToken, user} */
authRoute.post('/register', async (c) => {
  if (!localAuthReady()) return c.json({ error: '本地账号未启用：服务端需设置 OIDC_JWT_SECRET' }, 503);
  await ensureUsersCollection();
  let body: any;
  try { body = await c.req.json(); } catch { body = {}; }
  const email = String(body?.email || '').trim();
  const password = String(body?.password || '');
  const name = String(body?.name || '').trim();
  if (!isValidEmail(email)) return c.json({ error: '邮箱格式不正确' }, 400);
  if (password.length < 6) return c.json({ error: '密码至少 6 位' }, 400);
  if (await findUserByEmail(email)) return c.json({ error: '该邮箱已注册' }, 409);
  const { hash, salt } = hashPassword(password);
  const username = name || email.split('@')[0]!;
  const { payload } = await createUser({
    email, username, name: name || username,
    passwordHash: hash, passwordSalt: salt,
    roles: ['user'], source: 'local',
  });
  const frontUser = toFrontUser(payload);
  const token = signLocalJwt({ type: 'access', sub: payload.email, email: payload.email, name: payload.name, username: payload.username, roles: payload.roles, source: 'local' });
  const refreshToken = signLocalJwt({ type: 'refresh', sub: payload.email, email: payload.email, name: payload.name, username: payload.username, roles: payload.roles, source: 'local' });
  return c.json({ success: true, token, refreshToken, user: frontUser }, 201);
});

/* ---------- 本地账号：登录 ---------- */
/** POST /api/auth/login {email, password} → {token, refreshToken, user} */
authRoute.post('/login', async (c) => {
  if (!localAuthReady()) return c.json({ error: '本地账号未启用：服务端需设置 OIDC_JWT_SECRET' }, 503);
  await ensureUsersCollection();
  let body: any;
  try { body = await c.req.json(); } catch { body = {}; }
  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');
  if (!email || !password) return c.json({ error: '邮箱和密码不能为空' }, 400);
  const found = await findUserByEmail(email);
  if (!found || !found.payload.passwordHash || !found.payload.passwordSalt) {
    return c.json({ error: '邮箱或密码错误' }, 401);
  }
  if (!verifyPassword(password, found.payload.passwordSalt, found.payload.passwordHash)) {
    return c.json({ error: '邮箱或密码错误' }, 401);
  }
  await touchLogin(found.id, found.payload);
  const frontUser = toFrontUser(found.payload);
  const token = signLocalJwt({ type: 'access', sub: found.payload.email, email: found.payload.email, name: found.payload.name, username: found.payload.username, roles: found.payload.roles, source: 'local' });
  const refreshToken = signLocalJwt({ type: 'refresh', sub: found.payload.email, email: found.payload.email, name: found.payload.name, username: found.payload.username, roles: found.payload.roles, source: 'local' });
  return c.json({ success: true, token, refreshToken, user: frontUser });
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
    // OIDC 首次登录落库（kqa_users source=oidc）；再次登录只 touchLogin
    if (user?.sub) {
      try {
        const existing = await findUserByOidcSub(user.sub);
        if (existing) {
          existing.payload.roles = roles.length ? roles : existing.payload.roles;
          existing.payload.lastLoginAt = Date.now();
          await touchLogin(existing.id, existing.payload);
        } else if (user.email) {
          await createUser({
            email: user.email, username: user.username, name: user.name,
            roles: roles.length ? roles : ['user'], source: 'oidc', oidcSub: user.sub,
          });
        }
      } catch { /* 落库失败不阻断登录 */ }
    }
    return injectTokensPage(c, tokens, user, roles);
  } catch (err) {
    return errorPage(c, `登录失败：${(err as Error).message}`);
  }
});

/** GET /api/auth/me —— 当前登录用户信息（前端探针用；未登录返回 401）。
 *  与 Flask demo 的 g.user 对齐：返回 sub/name/email/username/roles。
 *  兼容两种 token：OIDC 的 RS256（Keycloak 签）与本地 HS256（我们签）。 */
authRoute.get('/me', async (c) => {
  if (!oidcReady() && !localAuthReady()) return c.json({ error: '鉴权未配置' }, 503);
  const auth = c.req.header('Authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!bearer) return c.json({ error: '未登录' }, 401);
  try {
    if (isLocalJwt(bearer)) {
      const claims = verifyLocalJwt(bearer);
      return c.json({ success: true, user: { sub: claims.sub, name: claims.name, email: claims.email, username: claims.username, roles: claims.roles } });
    }
    const claims = await verifyAccessToken(bearer);
    const r = (claims as any)?.realm_access?.roles;
    const roles = Array.isArray(r) ? r.filter((x: unknown) => typeof x === 'string') : [];
    return c.json({ success: true, user: { ...userFromClaims(claims), roles } });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 401);
  }
});

/** POST /api/auth/refresh —— 用 refresh_token 续期 {refreshToken} → {token, refreshToken?}
 *  兼容两种 token：OIDC refresh_token（RS256，转 Keycloak 换）与本地 HS256 refresh（重签） */
authRoute.post('/refresh', async (c) => {
  if (!oidcReady() && !localAuthReady()) return c.json({ error: '鉴权未配置' }, 503);
  let body: any;
  try { body = await c.req.json(); } catch { body = {}; }
  const rt = String(body?.refreshToken || '');
  if (!rt) return c.json({ error: '缺少 refreshToken' }, 400);
  try {
    // 本地 refresh_token（HS256）：重签 access + refresh
    if (isLocalJwt(rt)) {
      const claims = verifyLocalJwt(rt);
      if (claims.type !== 'refresh') return c.json({ success: false, error: '非 refresh token' }, 401);
      const token = signLocalJwt({ type: 'access', sub: claims.sub, email: claims.email, name: claims.name, username: claims.username, roles: claims.roles, source: claims.source });
      const refreshToken = signLocalJwt({ type: 'refresh', sub: claims.sub, email: claims.email, name: claims.name, username: claims.username, roles: claims.roles, source: claims.source });
      return c.json({ success: true, token, refreshToken });
    }
    // OIDC refresh_token：转 Keycloak 换
    if (!oidcReady()) return c.json({ success: false, error: 'OIDC 未配置' }, 503);
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
