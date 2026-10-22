/* ============================================================
   server/index.ts —— 服务端入口
   ============================================================ */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { serve } from '@hono/node-server';
import { ENV, configResp, llmReady, oidcReady } from './env.js';
import { kbIndex } from './kbIndex.js';
import { startBackupTimer } from './backup.js';
import { kb } from './routes/kb.js';
import { configRoute } from './routes/config.js';
import { chat } from './routes/chat.js';
import { confluence } from './routes/confluence.js';
import { searchRoute } from './routes/search.js';
import { webSearch } from './routes/webSearch.js';
import { conversationsRoute } from './routes/conversations.js';
import { feedbackRoute } from './routes/feedback.js';
import { metricsRoute } from './routes/metrics.js';
import { authRoute } from './routes/auth.js';
import { verifyAccessToken } from './oidc.js';
import { staticHandler } from './routes/static.js';
import { certRoute } from './cert.js';

const app = new Hono();

// ---- SSO/OIDC 鉴权 ----
// 放行：/api/config（前端探测就绪）、/api/auth/*（登录流程本身）。
// 受保护：其余 /api/*。OIDC_REQUIRED=0 时鉴权不强制（保留现状免鉴权），仅校验带了 token 的请求。
const PUBLIC_PREFIXES = ['/api/config', '/api/auth'];
async function authMiddleware(c: Context, next: () => Promise<void>): Promise<void | Response> {
  const path = new URL(c.req.url).pathname;
  if (PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(p + '/'))) return next();
  if (!oidcReady()) return next();           // 未配置 OIDC → 行为同现状
  const required = ENV.OIDC_REQUIRED;
  const auth = c.req.header('Authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (bearer) {
    try {
      const claims = await verifyAccessToken(bearer);
      // 注入用户信息到 context（routes 可选读取）
      c.set('ssoUser', {
        sub: claims.sub || '',
        name: claims.name || claims.preferred_username || claims.email || '',
        email: claims.email || '',
        username: claims.preferred_username || claims.email || claims.sub || '',
        // realm 角色（Keycloak access_token 在 realm_access.roles）；管理员判定用
        roles: Array.isArray((claims as any).realm_access?.roles) ? (claims as any).realm_access.roles : [],
      });
      return next();
    } catch (err) {
      // token 无效：若强制鉴权 → 401；否则放行（降级为匿名，与 =0 行为一致）
      if (!required) return next();
      return c.json({ error: 'token 无效或已过期', detail: (err as Error).message }, 401);
    }
  }
  // 无 token
  if (!required) return next();
  // API 请求 → 401；浏览器导航（Accept: text/html）→ 跳登录
  if (c.req.header('Accept')?.includes('text/html')) {
    return c.redirect('/api/auth/oidc/login', 302);
  }
  return c.json({ error: '未登录', loginUrl: '/api/auth/oidc/login' }, 401);
}

app.use('/api/*', authMiddleware);
app.route('/api/config', configRoute);
app.route('/api/auth', authRoute);
app.route('/api/chat', chat);
app.route('/api/confluence-page', confluence);
app.route('/api/kb', kb);
app.route('/api/kb', searchRoute);
app.route('/api/web-search', webSearch);
app.route('/api/conversations', conversationsRoute);
app.route('/api/feedback', feedbackRoute);
app.route('/api/metrics', metricsRoute);
app.get('/api/*', (c) => c.json({ error: 'not found' }, 404));
app.get('*', staticHandler);

async function main() {
  // 启动 Qdrant + 索引
  try {
    await kbIndex.bootstrap();
    console.log(`[索引] BM25 已就绪 · ${kbIndex.chunkCount} 个 chunk`);
  } catch (err) {
    console.error(`[索引] 初始化失败：${(err as Error)?.message || err}`);
    // 不退出 —— 让 /api/config 等仍可访问，Qdrant 稍后起来后手动重启
  }

  serve({ fetch: app.fetch, port: ENV.PORT, hostname: ENV.HOST }, (info) => {
    console.log(`[知识问答 Agent] listening on http://${ENV.HOST}:${info.port}`);
    console.log(llmReady()
      ? `[大模型] ${ENV.LLM_MODEL} @ ${new URL(ENV.LLM_BASE_URL).host}（Key 已注入）`
      : '[大模型] 未配置。请设置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL');
    console.log(`[Confluence] ${ENV.CONFLUENCE_BASE_URL && ENV.CONFLUENCE_PAT
      ? `已接入 ${new URL(ENV.CONFLUENCE_BASE_URL).host}`
      : '未配置'}`);
    console.log(`[联网搜索] ${ENV.SEARXNG_URL
      ? `SearXNG @ ${new URL(ENV.SEARXNG_URL).host}（拒答兜底已启用）`
      : '未配置。设置 SEARXNG_URL 启用拒答后的联网搜索'}`);
    console.log(`[嵌入] ${ENV.EMBED_BASE_URL
      ? `${ENV.EMBED_MODEL} ${ENV.EMBED_DIM}维（向量门 ${ENV.EMBED_VECTOR_GATE ? '开' : '关'}）`
      : '未配置'}`);
    console.log(`[Qdrant] ${ENV.QDRANT_URL} · ${ENV.COLLECTION_CHUNKS}/${ENV.COLLECTION_DOCS}`);
    console.log(`[SSO/OIDC] ${oidcReady()
      ? `${ENV.OIDC_ISSUER}（client ${ENV.OIDC_CLIENT_ID}，${ENV.OIDC_REQUIRED ? '强制鉴权' : '可选登录'}）`
      : '未配置。设置 OIDC_* 启用单点登录'}`);
    // 定时备份（默认 24h，设 0 关闭；存于 BACKUP_DIR，自动 prune 10 份）
    if (ENV.BACKUP_INTERVAL_MS > 0) {
      startBackupTimer(ENV.BACKUP_INTERVAL_MS);
      console.log(`[备份] 定时备份已启用（每 ${Math.round(ENV.BACKUP_INTERVAL_MS / 60000)} 分钟），存于 ${process.env.BACKUP_DIR || './backups'}`);
    } else {
      console.log('[备份] 定时备份已关闭（BACKUP_INTERVAL_MS=0）');
    }
  });

  if (ENV.GEN_CERT) certRoute(app, ENV.HOST, ENV.HTTPS_PORT);
}

main().catch((err) => {
  console.error('启动失败：', err);
  process.exit(1);
});
