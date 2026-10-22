/* ============================================================
   tests/oidc.test.ts —— OIDC 核心单测（不打真实 IdP）
   §OIDC-1 PKCE challenge = base64url(SHA256(verifier))
   §OIDC-2 state 暂存：savePending/takePending 一次性消费 + TTL
   §OIDC-3 jwt 解析 + iss/aud/exp 校验（用本地生成 RSA 密钥签名）
   §OIDC-4 alg 不符 / 签名被篡改 → 拒绝
   ============================================================ */
import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPairSync, sign as rsaSign, createHash } from 'node:crypto';
import { vi } from 'vitest';

// ---- 测试前把 env 指到测试值（oidc.ts 读 ENV）----
const TEST_ISSUER = 'http://kc-test.local/realms/t';
const TEST_CLIENT = 'kqa-test';
process.env.OIDC_ISSUER = TEST_ISSUER;
process.env.OIDC_CLIENT_ID = TEST_CLIENT;
process.env.OIDC_CLIENT_SECRET = 'sec';
process.env.OIDC_JWT_SECRET = 'test-jwt-secret-for-local-acct';

// 动态 import 以便 env 在模块加载前生效
const { createPkceVerifier, pkceChallenge, savePending, takePending, createNonce } = await import('../src/server/oidc.js');

/* ---- 伪造 IdP：discovery + jwks + token 端点 ---- */
let jwkForVerify: { kid: string; kty: string; n: string; e: string } | null = null;

function b64u(buf: Buffer): string { return buf.toString('base64url'); }

beforeAll(() => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; n: string; e: string };
  jwkForVerify = { ...jwk, kid: 'test-kid', kty: jwk.kty };
  // monkey-patch 全局 fetch：discovery/jwks 都走假数据
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: any, init?: any) => {
    const url = String(input);
    if (url === `${TEST_ISSUER}/.well-known/openid-configuration`) {
      return new Response(JSON.stringify({
        issuer: TEST_ISSUER,
        authorization_endpoint: `${TEST_ISSUER}/protocol/openid-connect/auth`,
        token_endpoint: `${TEST_ISSUER}/protocol/openid-connect/token`,
        jwks_uri: `${TEST_ISSUER}/protocol/openid-connect/certs`,
      }), { status: 200 });
    }
    if (url === `${TEST_ISSUER}/protocol/openid-connect/certs`) {
      return new Response(JSON.stringify({ keys: [jwkForVerify] }), { status: 200 });
    }
    // token 交换/刷新：返回假 token set
    if (url === `${TEST_ISSUER}/protocol/openid-connect/token`) {
      return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt' }), { status: 200 });
    }
    return realFetch(input as any, init);
  });
  // 保存私钥供签名函数使用
  (globalThis as any).__t = { privateKey };
});

/** 用测试私钥签发一个 RS256 JWT */
function issueJwt(claims: Record<string, unknown>, kid = 'test-kid', mutateSig = false): string {
  const header = { alg: 'RS256', kid, typ: 'JWT' };
  const h = b64u(Buffer.from(JSON.stringify(header)));
  const p = b64u(Buffer.from(JSON.stringify(claims)));
  const signed = Buffer.from(`${h}.${p}`);
  let sig = rsaSign('RSA-SHA256', signed, (globalThis as any).__t.privateKey);
  if (mutateSig) { sig[0] = sig[0]! ^ 0xff; }
  return `${h}.${p}.${b64u(sig)}`;
}

describe('§OIDC-1 PKCE', () => {
  it('challenge = base64url(SHA256(verifier))', () => {
    const v = createPkceVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
    expect(pkceChallenge(v)).toBe(b64u(createHash('sha256').update(v).digest()));
  });
});

describe('§OIDC-2 state 暂存', () => {
  it('savePending/takePending 一次性消费', () => {
    const st = createNonce();
    savePending(st, 'verifier-1');
    expect(takePending(st)).toBe('verifier-1');
    expect(takePending(st)).toBeNull(); // 二次消费必须失败（防重放）
  });
  it('未知 state → null', () => {
    expect(takePending('nonexistent-state-xyz')).toBeNull();
  });
});

describe('§OIDC-3 id_token 校验', () => {
  it('合法 RS256 token 通过（iss/aud/exp 正确）', async () => {
    const { verifyIdToken } = await import('../src/server/oidc.js');
    const token = issueJwt({
      iss: TEST_ISSUER, aud: TEST_CLIENT,
      exp: Math.floor(Date.now() / 1000) + 300,
      sub: 'user-1', email: 'u@jinde.local', name: '测试用户', preferred_username: 'u1',
    });
    const claims = await verifyIdToken(token);
    expect(claims.sub).toBe('user-1');
  });
  it('iss 不匹配 → 拒绝', async () => {
    const { verifyIdToken } = await import('../src/server/oidc.js');
    const token = issueJwt({ iss: 'http://evil.local', aud: TEST_CLIENT, exp: Math.floor(Date.now() / 1000) + 300 });
    await expect(verifyIdToken(token)).rejects.toThrow();
  });
  it('aud 不匹配 → 拒绝', async () => {
    const { verifyIdToken } = await import('../src/server/oidc.js');
    const token = issueJwt({ iss: TEST_ISSUER, aud: 'other-client', exp: Math.floor(Date.now() / 1000) + 300 });
    await expect(verifyIdToken(token)).rejects.toThrow();
  });
  it('exp 已过期 → 拒绝', async () => {
    const { verifyIdToken } = await import('../src/server/oidc.js');
    const token = issueJwt({ iss: TEST_ISSUER, aud: TEST_CLIENT, exp: Math.floor(Date.now() / 1000) - 10 });
    await expect(verifyIdToken(token)).rejects.toThrow();
  });
});

describe('§OIDC-4 防伪造', () => {
  it('签名被篡改 → 拒绝', async () => {
    const { verifyIdToken } = await import('../src/server/oidc.js');
    const token = issueJwt({ iss: TEST_ISSUER, aud: TEST_CLIENT, exp: Math.floor(Date.now() / 1000) + 300 }, 'test-kid', true);
    await expect(verifyIdToken(token)).rejects.toThrow();
  });
});

/* ============================================================
   §LOCAL 本地账号：scrypt 哈希 + HS256 JWT
   动态 import 以确保 env 在模块加载前生效（同 oidc.js 处理）
   ============================================================ */
async function loadUsers() {
  return await import('../src/server/users.js');
}

describe('§LOCAL-1 scrypt 密码哈希', () => {
  it('hashPassword → verifyPassword 往返', async () => {
    const { hashPassword, verifyPassword } = await loadUsers();
    const { hash, salt } = hashPassword('P@ssw0rd!');
    expect(hash).not.toBe('');
    expect(salt).not.toBe('');
    expect(verifyPassword('P@ssw0rd!', salt, hash)).toBe(true);
  });
  it('错误密码校验失败', async () => {
    const { hashPassword, verifyPassword } = await loadUsers();
    const { hash, salt } = hashPassword('correct');
    expect(verifyPassword('wrong', salt, hash)).toBe(false);
  });
  it('相同密码每次 salt 不同（防彩虹表）', async () => {
    const { hashPassword } = await loadUsers();
    const a = hashPassword('same');
    const b = hashPassword('same');
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('§LOCAL-2 HS256 JWT 签发/校验', () => {
  it('合法 token 校验通过', async () => {
    const { signLocalJwt, verifyLocalJwt, isLocalJwt } = await loadUsers();
    const token = signLocalJwt({
      type: 'access', sub: 'u@jinde.local', email: 'u@jinde.local',
      name: '测试', username: 'u', roles: ['user'], source: 'local',
    });
    expect(isLocalJwt(token)).toBe(true);
    const claims = verifyLocalJwt(token);
    expect(claims.sub).toBe('u@jinde.local');
    expect(claims.email).toBe('u@jinde.local');
    expect(claims.roles).toEqual(['user']);
    expect(claims.iss).toBe('kqa');
  });
  it('过期 token 拒绝', async () => {
    const { signLocalJwt, verifyLocalJwt } = await loadUsers();
    const token = signLocalJwt({
      type: 'access', sub: 'x', email: 'x', name: 'x', username: 'x', roles: [], source: 'local', ttl: -10,
    });
    expect(() => verifyLocalJwt(token)).toThrow();
  });
  it('签名篡改拒绝', async () => {
    const { signLocalJwt, verifyLocalJwt } = await loadUsers();
    const token = signLocalJwt({
      type: 'access', sub: 'x', email: 'x', name: 'x', username: 'x', roles: [], source: 'local',
    });
    const tampered = token.slice(0, -2) + 'AA';
    expect(() => verifyLocalJwt(tampered)).toThrow();
  });
  it('isLocalJwt 识别 RS256 token 返回 false', async () => {
    const { isLocalJwt } = await loadUsers();
    // 用 OIDC 测试里签的 RS256 token（alg=RS256）
    const rs = issueJwt({ iss: TEST_ISSUER, aud: TEST_CLIENT, exp: Math.floor(Date.now() / 1000) + 300 });
    expect(isLocalJwt(rs)).toBe(false);
  });
});
