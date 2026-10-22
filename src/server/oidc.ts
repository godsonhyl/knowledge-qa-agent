/* ============================================================
   server/oidc.ts —— OIDC (Keycloak) 核心逻辑
   Authorization Code + PKCE(S256)，纯 stdlib：node:crypto + fetch。
   无第三方依赖（不引 jose），与项目"贴近 stdlib"风格一致。
   ============================================================
   流程：
   - fetchDiscovery() 拉 issuer 的 /.well-known/openid-configuration，缓存
   - buildAuthUrl(state, verifier) → Keycloak authorize 跳转 URL
   - exchangeCode(code, verifier) → {access_token, id_token, refresh_token, ...}
   - verifyIdToken(idToken) → 校验 iss/aud/exp + RS256 签名（JWKS）
   - verifyAccessToken(token) → 同上校验，供 authMiddleware 用
   - refreshToken(rt) → 用 refresh_token 续期
   ============================================================ */
import { createHash, createVerify, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ENV, oidcReady } from './env.js';

/* ---------- base64url ---------- */
function b64uEncode(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}
function b64uDecode(str: string): Buffer {
  return Buffer.from(str, 'base64url');
}

/* ---------- PKCE ---------- */
/** 生成 PKCE verifier（43-128 字符，base64url 96 字节） */
export function createPkceVerifier(): string {
  return b64uEncode(randomBytes(48));
}
/** S256 challenge = base64url(SHA256(verifier_ascii)) */
export function pkceChallenge(verifier: string): string {
  return b64uEncode(createHash('sha256').update(verifier).digest());
}
/** 32 字节随机 state */
export function createNonce(): string {
  return randomUUID().replace(/-/g, '') + randomBytes(8).toString('hex');
}

/* ---------- state/verifier 内存暂存（单实例，5 分钟 TTL） ---------- */
interface PendingState {
  state: string;
  verifier: string;
  createdAt: number;
}
const pending = new Map<string, PendingState>();
const STATE_TTL = 5 * 60 * 1000;
function gcPending(): void {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.createdAt > STATE_TTL) pending.delete(k);
}
export function savePending(state: string, verifier: string): void {
  gcPending();
  pending.set(state, { state, verifier, createdAt: Date.now() });
}
export function takePending(state: string): string | null {
  gcPending();
  const v = pending.get(state);
  if (!v) return null;
  pending.delete(state);
  return v.verifier;
}

/* ---------- OIDC Discovery 缓存 ---------- */
export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}
let discoCache: { doc: OidcDiscovery; at: number } | null = null;
const DISCO_TTL = 60 * 60 * 1000; // 1h

export async function fetchDiscovery(force = false): Promise<OidcDiscovery> {
  if (!oidcReady()) throw new Error('OIDC 未配置');
  if (!force && discoCache && Date.now() - discoCache.at < DISCO_TTL) return discoCache.doc;
  const url = `${ENV.OIDC_ISSUER}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OIDC discovery 失败：${res.status} ${ENV.OIDC_ISSUER}`);
  const doc = await res.json() as OidcDiscovery;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error('OIDC discovery 缺少必要端点');
  }
  discoCache = { doc, at: Date.now() };
  return doc;
}

/* ---------- JWKS 缓存 ---------- */
interface Jwk { kid?: string; kty: string; n?: string; e?: string; x5c?: string[]; }
let jwksCache: { keys: Jwk[]; at: number; uri: string } | null = null;
const JWKS_TTL = 24 * 60 * 60 * 1000; // 24h

async function fetchJwks(uri: string, force = false): Promise<Jwk[]> {
  if (!force && jwksCache && jwksCache.uri === uri && Date.now() - jwksCache.at < JWKS_TTL) {
    return jwksCache.keys;
  }
  const res = await fetch(uri);
  if (!res.ok) throw new Error(`JWKS 拉取失败：${res.status}`);
  const doc = await res.json() as { keys: Jwk[] };
  jwksCache = { keys: doc.keys || [], at: Date.now(), uri };
  return jwksCache.keys;
}

/** 从 JWKS 的 RSA 公钥 (n, e) 拼成 PEM（PKCS#1 RSAPublicKey） */
function rsaPemFromJwk(jwk: Jwk): string {
  if (!jwk.n || !jwk.e) throw new Error('JWK 缺少 n/e');
  const n = b64uDecode(jwk.n);
  const e = b64uDecode(jwk.e);
  // RSAPublicKey ::= SEQUENCE { modulus INTEGER, exponent INTEGER }
  const der = encodeRsaPub(n, e);
  return derToPem(der, 'RSA PUBLIC KEY');
}

function encodeRsaPub(n: Buffer, e: Buffer): Buffer {
  // 防止正整数被误判为负：前导 0
  const nEnc = n[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), n]) : n;
  const eEnc = e[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), e]) : e;
  return derSeq(derInt(nEnc), derInt(eEnc));
}
function derInt(buf: Buffer): Buffer {
  const len = buf.length;
  return Buffer.concat([Buffer.from([0x02]), derLen(len), buf]);
}
function derSeq(...parts: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from([0x30]), derLen(parts.reduce((s, b) => s + b.length, 0)), ...parts]);
}
function derLen(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x100) return Buffer.from([0x81, len]);
  if (len < 0x10000) return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
  throw new Error('DER 长度溢出');
}
function derToPem(der: Buffer, label: string): string {
  const b64 = der.toString('base64');
  const lines = b64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/* ---------- JWT 解析 ---------- */
interface JwtHeader { alg: string; kid?: string; typ?: string; }
interface JwtClaims {
  iss: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  email?: string;
  name?: string;
  preferred_username?: string;
}
function decodeJwtPart(part: string): any {
  const json = b64uDecode(part).toString('utf-8');
  return JSON.parse(json);
}
function decodeJwt(token: string): { header: JwtHeader; claims: JwtClaims; sig: Buffer; signed: Buffer } {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed JWT');
  const header = decodeJwtPart(parts[0]!) as JwtHeader;
  const claims = decodeJwtPart(parts[1]!) as JwtClaims;
  const sig = b64uDecode(parts[2]!);
  const signed = Buffer.from(`${parts[0]!}.${parts[1]!}`);
  return { header, claims, sig, signed };
}

/* ---------- 签名验证 ---------- */
async function findKey(kid: string | undefined): Promise<string> {
  const disco = await fetchDiscovery();
  const keys = await fetchJwks(disco.jwks_uri);
  // kid 缺失时遍历 RSA 签名键
  const cand = kid ? keys.find((k) => k.kid === kid) : keys.find((k) => k.kty === 'RSA');
  if (!cand) {
    // 强制刷新一次 JWKS（kid 轮换）
    const fresh = await fetchJwks(disco.jwks_uri, true);
    const c2 = kid ? fresh.find((k) => k.kid === kid) : fresh.find((k) => k.kty === 'RSA');
    if (!c2) throw new Error('JWKS 中无匹配公钥');
    return rsaPemFromJwk(c2);
  }
  return rsaPemFromJwk(cand);
}

/** 验证一个 JWT 的签名与标准 claims，返回 claims。alg 必须是 RS256。 */
export async function verifyJwt(token: string): Promise<JwtClaims> {
  const { header, claims, sig, signed } = decodeJwt(token);
  if (header.alg !== 'RS256') throw new Error(`不支持的 alg：${header.alg}（仅支持 RS256）`);
  if (!claims.iss) throw new Error('缺少 iss');
  // iss 必须等于配置的 issuer
  if (claims.iss !== ENV.OIDC_ISSUER) throw new Error(`iss 不匹配：${claims.iss}`);
  // aud 必须包含 client_id
  const aud = claims.aud;
  const audOk = !aud ? false : Array.isArray(aud) ? aud.includes(ENV.OIDC_CLIENT_ID) : aud === ENV.OIDC_CLIENT_ID;
  if (!audOk) throw new Error(`aud 不匹配`);
  // exp
  if (claims.exp) {
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp < now) throw new Error(`token 已过期（exp=${claims.exp}）`);
  }
  const pem = await findKey(header.kid);
  const verifier = createVerify('RSA-SHA256');
  verifier.update(signed);
  verifier.end();
  const ok = verifier.verify(pem, sig);
  if (!ok) throw new Error('签名验证失败');
  return claims;
}

/** middleware 用：校验 access_token（Keycloak 的 access_token 同样是 RS256 JWT） */
export async function verifyAccessToken(token: string): Promise<JwtClaims> {
  return verifyJwt(token);
}

/** 回调用：校验 id_token */
export async function verifyIdToken(token: string): Promise<JwtClaims> {
  return verifyJwt(token);
}

/* ---------- 构造 authorize URL ---------- */
export async function buildAuthUrl(state: string, verifier: string): Promise<string> {
  const disco = await fetchDiscovery();
  const challenge = pkceChallenge(verifier);
  const u = new URL(disco.authorization_endpoint);
  u.searchParams.set('client_id', ENV.OIDC_CLIENT_ID);
  u.searchParams.set('redirect_uri', ENV.OIDC_REDIRECT_URI);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', ENV.OIDC_SCOPE);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

/* ---------- 用 code 换 token ---------- */
export interface TokenSet {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
}
export async function exchangeCode(code: string, verifier: string): Promise<TokenSet> {
  const disco = await fetchDiscovery();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: ENV.OIDC_REDIRECT_URI,
    client_id: ENV.OIDC_CLIENT_ID,
    client_secret: ENV.OIDC_CLIENT_SECRET,
    code_verifier: verifier,
  });
  const res = await fetch(disco.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`token 端点返回 ${res.status}：${txt.slice(0, 300)}`);
  }
  return await res.json() as TokenSet;
}

/* ---------- refresh_token 续期 ---------- */
export async function refreshAccessToken(refreshToken: string): Promise<TokenSet> {
  const disco = await fetchDiscovery();
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: ENV.OIDC_CLIENT_ID,
    client_secret: ENV.OIDC_CLIENT_SECRET,
  });
  const res = await fetch(disco.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`refresh 返回 ${res.status}：${txt.slice(0, 300)}`);
  }
  return await res.json() as TokenSet;
}

/* ---------- end session URL（登出跳 IdP） ---------- */
export async function endSessionUrl(postLogoutUri: string): Promise<string | null> {
  const disco = await fetchDiscovery().catch(() => null);
  if (!disco?.end_session_endpoint) return null;
  const u = new URL(disco.end_session_endpoint);
  u.searchParams.set('post_logout_redirect_uri', postLogoutUri);
  return u.toString();
}

/* ---------- 从 claims 提取前端可展示用户信息 ---------- */
export interface SsoUser {
  sub: string;
  name: string;
  email: string;
  username: string;
}
export function userFromClaims(c: JwtClaims): SsoUser {
  return {
    sub: c.sub || '',
    name: c.name || c.preferred_username || c.email || c.sub || '',
    email: c.email || '',
    username: c.preferred_username || c.email || c.sub || '',
  };
}

// 防未使用告警
void timingSafeEqual;
