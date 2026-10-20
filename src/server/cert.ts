/* ============================================================
   server/cert.ts —— GEN_CERT 自签 HTTPS（目录选择需安全上下文）
   ============================================================ */
import type { Hono } from 'hono';
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:https';
import { networkInterfaces } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

function ensureSelfSignedCert(): { key: Buffer; cert: Buffer } {
  // 容器内 WORKDIR=/app，__dirname=/app/dist/server → 用环境变量或 process.cwd() 兜底
  const dir = process.env.SSLCERT_DIR || join(process.cwd(), 'sslcert');
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');

  if (existsSync(keyPath) && existsSync(certPath)) {
    return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
  }

  mkdirSync(dir, { recursive: true });
  const ips: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const it of list || []) if (it.family === 'IPv4' && !it.internal) ips.push(it.address);
  }
  const sans = ['DNS:localhost', 'IP:127.0.0.1', ...ips.map((ip) => `IP:${ip}`)].join(',');

  const opensslConf = join(dir, 'openssl.cnf');
  writeFileSync(opensslConf,
    `[req]\ndistinguished_name=req\nx509_extensions=v3\nprompt=no\n\n[req]\nCN=knowledge-qa-agent-ts\n\n[v3]\nsubjectAltName=${sans}\nbasicConstraints=CA:FALSE\n`);

  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '3650', '-subj', '/CN=knowledge-qa-agent-ts', '-config', opensslConf,
  ], { stdio: 'pipe' });
  rmSync(opensslConf, { force: true });
  console.log(`[HTTPS] 已生成自签证书（SAN: ${sans}）`);
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

/**
 * 在另一个端口上以 HTTPS 提供同一个 Hono app。
 * 实现上用 http→app.fetch 的适配（与 @hono/node-server 同样思路，手写以支持 TLS）。
 */
export function certRoute(app: Hono, host: string, httpsPort: number): void {
  try {
    const { key, cert } = ensureSelfSignedCert();
    const server = createServer({ key, cert }, (req, res) => {
      const url = req.url || '/';
      const fullUrl = `https://${req.headers.host || 'localhost'}${url}`;
      const chunks: Buffer[] = [];
      req.on('data', (d: Buffer) => chunks.push(d));
      req.on('end', () => {
        const body = ['GET', 'HEAD'].includes(req.method || 'GET')
          ? undefined
          : Buffer.concat(chunks);
        void Promise.resolve(app.fetch(new Request(fullUrl, {
          method: req.method,
          headers: req.headers as any,
          body: body as any,
          duplex: 'half',
        } as any))).then((webRes: Response): void => {
          res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
          if (!webRes.body) { res.end(); return; }
          const reader = webRes.body.getReader();
          const pump = (): void => {
            void reader.read().then(({ done, value }): void => {
              if (done) { res.end(); return; }
              res.write(Buffer.from(value));
              pump();
            });
          };
          pump();
        }).catch((): void => { res.end(); });
      });
    });
    server.on('error', (err) => console.warn(`[HTTPS] 启动失败：${err.message}`));
    server.listen(httpsPort, host, () => {
      console.log(`[HTTPS] listening on https://${host}:${httpsPort}（自签证书）`);
    });
  } catch (err) {
    console.warn(`[HTTPS] 启动失败：${(err as Error)?.message || err}`);
  }
}
