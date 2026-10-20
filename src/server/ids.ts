/* ============================================================
   server/ids.ts —— UUID 生成（不引 uuid 库）
   - uuidv4：随机 UUID
   - uuidv5：基于命名空间 + 名称的确定性 UUID（用于 chunk 幂等 upsert）
   ============================================================ */
import { createHash, randomUUID } from 'node:crypto';

/** UUIDv4 —— 用于 docId（每次导入新 id） */
export function uuidv4(): string {
  return randomUUID();
}

const UUIDV5_NAMESPACE = '6e1a9b3f-2c4d-5e8a-9f1b-3d5c7e9a1b2d'; // 固定命名空间

/**
 * UUIDv5（sha1 based）—— 给 chunk 用：同一 docId+index 永远生成同一 UUID，
 * 让 Qdrant upsert 幂等，重导入不留孤儿。
 */
export function uuidv5(name: string): string {
  // RFC 4122 v5：sha1(namespace_bytes || name_bytes)，取前 16 字节，置版本与变体位
  const nsBytes = Buffer.from(UUIDV5_NAMESPACE.replace(/-/g, ''), 'hex');
  const nameBytes = Buffer.from(name, 'utf8');
  const buf = Buffer.concat([nsBytes, nameBytes]);
  const hash = createHash('sha1').update(buf).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8]! & 0x3f) | 0x80; // variant
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** 给某文档的第 i 块生成确定性 UUID */
export function chunkIdFor(docId: string, index: number): string {
  return uuidv5(`kqa:v1:${docId}:${index}`);
}
