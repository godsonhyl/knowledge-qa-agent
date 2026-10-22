/* ============================================================
   server/index.ts —— 服务端入口
   ============================================================ */
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { ENV, configResp, llmReady } from './env.js';
import { kbIndex } from './kbIndex.js';
import { kb } from './routes/kb.js';
import { configRoute } from './routes/config.js';
import { chat } from './routes/chat.js';
import { confluence } from './routes/confluence.js';
import { searchRoute } from './routes/search.js';
import { webSearch } from './routes/webSearch.js';
import { conversationsRoute } from './routes/conversations.js';
import { feedbackRoute } from './routes/feedback.js';
import { metricsRoute } from './routes/metrics.js';
import { staticHandler } from './routes/static.js';
import { certRoute } from './cert.js';

const app = new Hono();

app.route('/api/config', configRoute);
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
  });

  if (ENV.GEN_CERT) certRoute(app, ENV.HOST, ENV.HTTPS_PORT);
}

main().catch((err) => {
  console.error('启动失败：', err);
  process.exit(1);
});
