/* ============================================================
   server/confluence.ts —— Confluence URL 解析与抓取（移植自 server.js）
   ============================================================ */
import { ENV } from './env.js';
import * as nodeHttps from 'node:https';
import * as nodeHttp from 'node:http';

export interface ParsedConfUrl {
  pageId: string;
  host: string;
  spaceKey: string;
  title: string;
}

export function parseConfluenceUrl(raw: string): ParsedConfUrl | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;

  let pageId = u.searchParams.get('pageId');
  if (!pageId) {
    const m = u.pathname.match(/\/pages\/(\d+)/) || u.pathname.match(/\/rest\/api\/content\/(\d+)/);
    if (m && m[1]) pageId = m[1];
  }
  if (!pageId || !/^\d+$/.test(pageId)) return null;

  return {
    pageId,
    host: u.host,
    spaceKey: u.searchParams.get('spaceKey') || '',
    title: u.searchParams.get('title') || '',
  };
}

/** 极简 storage xhtml → 纯文本（移植自 server.js，零依赖） */
export function confluenceStorageToText(storage: string): string {
  let s = String(storage || '');
  s = s.replace(/<\/(?:td|th)>/gi, ' | ');
  s = s.replace(/<\/tr>/gi, '\n');
  s = s.replace(/<\/(?:p|div|h[1-6]|li|pre|blockquote|table)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&hellip;/g, '…');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** 用 stdlib https get 抓 JSON（支持跳过 TLS 校验，移植自 server.js） */
async function httpsGetJson(apiUrl: string, headers: Record<string, string>, insecure: boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try { u = new URL(apiUrl); } catch { return reject(new Error('Confluence 接口地址不是合法 URL')); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return reject(new Error('Confluence 接口地址必须是 http/https'));

    const lib = u.protocol === 'https:' ? nodeHttps : nodeHttp;
    const opts: any = { method: 'GET', headers: headers || {} };
    if (u.protocol === 'https:' && insecure) opts.rejectUnauthorized = false;

    const req = lib.request(u, opts, (resp: any) => {
      const chunks: Buffer[] = [];
      resp.on('data', (c: Buffer) => chunks.push(c));
      resp.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const ok = resp.statusCode >= 200 && resp.statusCode < 300;
        if (!ok) {
          const err: any = new Error(`HTTP ${resp.statusCode}`);
          err.status = resp.statusCode;
          err.body = body;
          return reject(err);
        }
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('Confluence 返回的内容不是 JSON（需 5.5+）')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Confluence 请求超时（15s）')));
    req.end();
  });
}

export function sanitizeFilename(name: string): string {
  return String(name || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
}

export interface ConfPage {
  pageId: string;
  title: string;
  space: string;
  url: string;
  text: string;
  version: number | null;
}

export interface ConfTree {
  pages: { name: string; title: string; pageId: string; url: string; text: string; version: number | null }[];
  skipped: { name: string; reason: string }[];
  truncated: boolean;
}

export async function fetchConfluencePage(url: string, opts: { recursive?: boolean } = {}): Promise<ConfPage | ConfTree> {
  const info = parseConfluenceUrl(url);
  if (!info) throw new Error('无法从链接中识别 pageId');

  const base = ENV.CONFLUENCE_BASE_URL || `https://${info.host}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (ENV.CONFLUENCE_PAT) headers.Authorization = `Bearer ${ENV.CONFLUENCE_PAT}`;
  const insecure = ENV.CONFLUENCE_INSECURE_TLS;

  async function getPageWithBody(id: string): Promise<ConfPage> {
    const api = `${base}/rest/api/content/${id}?expand=body.storage.title,space,version`;
    let data: any;
    try {
      data = await httpsGetJson(api, headers, insecure);
    } catch (err: any) {
      const msg = String(err?.message || err);
      const status = err?.status;
      if (status === 401 || status === 403) throw new Error('Confluence 拒绝访问（401/403）：PAT 无效或无权限');
      if (status === 404) throw new Error(`页面 ${id} 不存在或无权限查看`);
      if (status) throw new Error(`Confluence 返回 ${status}`);
      if (!insecure && /certificate|self.signed|SSL|TLS|UNABLE_TO_VERIFY/i.test(msg)) {
        throw new Error(`Confluence 站点证书校验失败（${msg}）。设置 CONFLUENCE_INSECURE_TLS=1`);
      }
      throw new Error(`无法连接 Confluence：${msg}`);
    }
    return {
      pageId: String(id),
      title: data.title || `Confluence 页面 ${id}`,
      space: data.space?.key || data.space?.name || (info ? info.spaceKey : '') || '',
      url: `${base}/pages/viewpage.action?pageId=${id}`,
      text: confluenceStorageToText(data?.body?.storage?.value || ''),
      version: data?.version?.number ?? null,
    };
  }

  if (!opts.recursive) {
    const page = await getPageWithBody(info.pageId);
    if (!page.text) throw new Error('页面正文为空（可能是空页或无权限）');
    return page;
  }

  const root = await getPageWithBody(info.pageId);
  const rootTitle = root.title;
  const all: ConfTree['pages'] = [{ name: sanitizeFilename(`${rootTitle}.md`), title: root.title, pageId: root.pageId, url: root.url, text: root.text, version: root.version }];
  const skipped: { name: string; reason: string }[] = [];

  let start = 0;
  const limit = 100;
  let keepGoing = true;
  while (keepGoing && all.length < ENV.CONFLUENCE_MAX_PAGES) {
    const cql = `ancestor=${info.pageId} AND type=page`;
    const api = `${base}/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${limit}&start=${start}`;
    let data: any;
    try {
      data = await httpsGetJson(api, headers, insecure);
    } catch (err) {
      skipped.push({ name: `search(start=${start})`, reason: `CQL 查询失败：${String((err as Error)?.message || err)}` });
      break;
    }
    const results: any[] = Array.isArray(data?.results) ? data.results : [];
    if (!results.length) break;
    for (const r of results) {
      if (all.length >= ENV.CONFLUENCE_MAX_PAGES) { keepGoing = false; break; }
      const id = String(r.id);
      if (all.some((p) => p.pageId === id)) continue;
      try {
        const p = await getPageWithBody(id);
        const name = sanitizeFilename(`${rootTitle}/${p.title}.md`);
        if (!p.text) skipped.push({ name, reason: '正文为空' });
        else all.push({ name, title: p.title, pageId: p.pageId, url: p.url, text: p.text, version: p.version });
      } catch (err) {
        skipped.push({ name: r.title || id, reason: String((err as Error)?.message || err) });
      }
    }
    if (!data?._links?.next) break;
    start += limit;
  }

  return { pages: all, skipped, truncated: all.length >= ENV.CONFLUENCE_MAX_PAGES };
}
