/* ============================================================
   server/audit.ts —— 审计日志（Qdrant kqa_audit collection）
   记录用户操作：提问/搜索/文档导入/删除/清空/蒸馏/登录等。
   AUDIT_LOG_ENABLED=1 时启用；进程异步写（不阻塞主路径）。
   ============================================================ */
import { ENV } from './env.js';
import { uuidv4 } from './ids.js';
import { ensureCollection, upsertPoints } from './qdrant.js';

export const COLLECTION_AUDIT = 'kqa_audit';

let auditEnsured = false;

export interface AuditEntry {
  kind: 'audit';
  /** 时间戳（ms） */
  ts: number;
  /** 用户 sub（本地账号=email，OIDC=sub） */
  userSub: string;
  /** 用户名/邮箱（便于审计日志可读） */
  username: string;
  /** 操作类型：search / chat / doc_import / doc_delete / clear_all / distill / login / logout / register / feedback */
  action: string;
  /** 操作详情摘要（≤500 字符）——不存完整请求体，只存关键信息 */
  detail: string;
  /** 来源 IP */
  ip: string;
}

/** 异步记录一条审计日志（不阻塞主路径；失败静默丢弃） */
export function audit(userSub: string, username: string, action: string, detail: string, ip: string): void {
  if (!ENV.AUDIT_LOG_ENABLED || !userSub) return;
  const entry: AuditEntry = {
    kind: 'audit',
    ts: Date.now(),
    userSub,
    username: username || userSub,
    action,
    detail: (detail || '').slice(0, 500),
    ip: (ip || '').slice(0, 60),
  };
  // 异步写，不 await——审计不能拖慢主路径
  void writeAudit(entry).catch(() => { /* 审计写失败静默丢弃 */ });
}

async function writeAudit(entry: AuditEntry): Promise<void> {
  if (!auditEnsured) {
    await ensureCollection(COLLECTION_AUDIT, 1);
    auditEnsured = true;
  }
  const id = uuidv4();
  await upsertPoints(COLLECTION_AUDIT, [{ id, vector: [0], payload: entry as any }]);
}
