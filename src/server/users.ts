/* ============================================================
   server/users.ts —— 本地账号 + OIDC 用户落库
   - Qdrant collection kqa_users（伪向量 size 1，payload 存用户）
   - 密码用 scrypt（node:crypto 内置，无第三方依赖）+ 16 字节 salt
   - 本地账号签 HS256 JWT（OIDC_JWT_SECRET）；OIDC token 仍由 Keycloak 签 RS256
   ============================================================ */
import { scryptSync, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { ENV } from './env.js';
import { uuidv4 } from './ids.js';
import {
  ensureCollection, ensurePayloadIndex, scrollAll, upsertPoints,
} from './qdrant.js';

export const COLLECTION_USERS = 'kqa_users';

export interface UserPayload {
  kind: 'user';
  /** 邮箱（本地账号登录用；OIDC 也存） */
  email: string;
  /** 显示名/用户名 */
  username: string;
  name: string;
  /** 本地账号密码哈希（scrypt）；OIDC 账号无此字段 */
  passwordHash?: string;
  passwordSalt?: string;
  /** realm 角色（OIDC: realm_access.roles；本地: 默认 ["user"]，admin 可由管理员后台或初始账号配置） */
  roles: string[];
  /** 'local' = 本地注册；'oidc' = OIDC 首次登录自动建号 */
  source: 'local' | 'oidc';
  /** OIDC 用户的 subject（Keycloak sub），用于 OIDC 登录匹配本地记录 */
  oidcSub?: string;
  createdAt: number;
  lastLoginAt: number | null;
}

let usersIndexEnsured = false;

export async function ensureUsersCollection(): Promise<void> {
  await ensureCollection(COLLECTION_USERS, 1);
  if (!usersIndexEnsured) {
    await ensurePayloadIndex(COLLECTION_USERS, ['email', 'username', 'oidcSub']);
    usersIndexEnsured = true;
  }
}

/* ---------- 密码哈希（scrypt） ---------- */
const SCRYPT_KEYLEN = 32;
const SCRYPT_N = 16384;

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N });
  return { hash: hash.toString('base64'), salt: salt.toString('base64') };
}

export function verifyPassword(password: string, saltB64: string, hashB64: string): boolean {
  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N });
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* ---------- 本地 HS256 JWT（签发 + 校验） ---------- */
const LOCAL_ISSUER = 'kqa';
const LOCAL_AUDIENCE = 'kqa';
const ACCESS_TTL = 8 * 60 * 60;          // 8h
const REFRESH_TTL = 30 * 24 * 60 * 60;  // 30d

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}
function b64urlDecode(str: string): Buffer {
  return Buffer.from(str, 'base64url');
}

export interface LocalClaims {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  type: 'access' | 'refresh';
  email: string;
  name: string;
  username: string;
  roles: string[];
  source: 'local' | 'oidc';
}

/** 签发本地 HS256 JWT */
export function signLocalJwt(claims: Omit<LocalClaims, 'iss' | 'aud' | 'iat' | 'exp'> & { ttl?: number }): string {
  if (!ENV.OIDC_JWT_SECRET) throw new Error('本地账号未启用（缺 OIDC_JWT_SECRET）');
  const now = Math.floor(Date.now() / 1000);
  const ttl = claims.ttl ?? (claims.type === 'refresh' ? REFRESH_TTL : ACCESS_TTL);
  const full: LocalClaims = {
    iss: LOCAL_ISSUER, aud: LOCAL_AUDIENCE, iat: now, exp: now + ttl,
    type: claims.type, sub: claims.sub, email: claims.email, name: claims.name,
    username: claims.username, roles: claims.roles, source: claims.source,
  };
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify(full));
  const signed = Buffer.from(`${header}.${payload}`);
  const sig = createHmac('sha256', ENV.OIDC_JWT_SECRET).update(signed).digest();
  return `${header}.${payload}.${b64url(sig)}`;
}

/** 校验本地 HS256 JWT；返回 claims。仅校 HS256（OIDC 的 RS256 由 oidc.ts 处理） */
export function verifyLocalJwt(token: string): LocalClaims {
  if (!ENV.OIDC_JWT_SECRET) throw new Error('本地账号未启用');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed JWT');
  const header = JSON.parse(b64urlDecode(parts[0]!).toString('utf-8'));
  if (header.alg !== 'HS256') throw new Error(`非本地 HS256 token（alg=${header.alg}）`);
  const claims = JSON.parse(b64urlDecode(parts[1]!).toString('utf-8')) as LocalClaims;
  if (claims.iss !== LOCAL_ISSUER) throw new Error('iss 不匹配');
  if (claims.aud !== LOCAL_AUDIENCE) throw new Error('aud 不匹配');
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp && claims.exp < now) throw new Error('token 已过期');
  const signed = Buffer.from(`${parts[0]!}.${parts[1]!}`);
  const expected = createHmac('sha256', ENV.OIDC_JWT_SECRET).update(signed).digest();
  const actual = b64urlDecode(parts[2]!);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('签名验证失败');
  }
  return claims;
}

/** 判断一个 token 是否是本地 HS256（不解签，只看 header.alg） */
export function isLocalJwt(token: string): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const header = JSON.parse(b64urlDecode(parts[0]!).toString('utf-8'));
    return header.alg === 'HS256';
  } catch { return false; }
}

/* ---------- Qdrant 用户 CRUD ---------- */

export async function findUserByEmail(email: string): Promise<{ id: string; payload: UserPayload } | null> {
  const pts = await scrollAll<UserPayload>(COLLECTION_USERS, { must: [{ key: 'email', match: { value: email.toLowerCase() } }] });
  return pts.length ? { id: pts[0]!.id, payload: pts[0]!.payload as UserPayload } : null;
}

export async function findUserByOidcSub(sub: string): Promise<{ id: string; payload: UserPayload } | null> {
  const pts = await scrollAll<UserPayload>(COLLECTION_USERS, { must: [{ key: 'oidcSub', match: { value: sub } }] });
  return pts.length ? { id: pts[0]!.id, payload: pts[0]!.payload as UserPayload } : null;
}

export async function createUser(payload: Omit<UserPayload, 'kind' | 'createdAt' | 'lastLoginAt'>): Promise<{ id: string; payload: UserPayload }> {
  await ensureUsersCollection();
  const id = uuidv4();
  const full: UserPayload = {
    ...payload,
    email: payload.email.toLowerCase(),
    kind: 'user',
    createdAt: Date.now(),
    lastLoginAt: null,
  };
  await upsertPoints(COLLECTION_USERS, [{ id, vector: [0], payload: full as any }]);
  return { id, payload: full };
}

/** 记录最后登录时间（payload 覆盖写） */
export async function touchLogin(id: string, payload: UserPayload): Promise<void> {
  payload.lastLoginAt = Date.now();
  await upsertPoints(COLLECTION_USERS, [{ id, vector: [0], payload: payload as any }]);
}

/** 邮箱校验：简版，防止明显非法输入 */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 120;
}
