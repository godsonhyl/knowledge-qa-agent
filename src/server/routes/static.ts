/* ============================================================
   server/routes/static.ts —— 静态托管（同源，无 CORS）
   ============================================================ */
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import type { Context } from 'hono';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(__dirname, '..', '..', '..', 'dist', 'web');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export async function staticHandler(c: Context): Promise<Response> {
  let rel = decodeURIComponent(new URL(c.req.url).pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const root = WEB_ROOT;
  const target = join(root, normalize(rel).replace(/^(\.\.[/\\])+/, ''));

  // 防目录穿越
  if (!target.startsWith(root)) return c.notFound();

  async function serve(path: string): Promise<Response | null> {
    try {
      const st = await stat(path);
      if (!st.isFile()) return null;
      const buf = await readFile(path);
      const ext = extname(path).toLowerCase();
      return new Response(buf, {
        headers: {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Content-Length': String(st.size),
          'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
        },
      });
    } catch {
      return null;
    }
  }

  const hit = await serve(target);
  if (hit) return hit;
  // SPA：回退 index.html
  const fallback = await serve(join(root, 'index.html'));
  if (fallback) return fallback;
  return c.notFound();
}
