/* ============================================================
   server/backup.ts —— 知识库 JSON 快照（导出再清的兜底）
   清空前自动导出 ./backups/kb-<时间戳>.json，误清后可用
   恢复脚本重新导入。快照只存 {name,text,source,summary[]}——
   原文可重新切块/嵌入，蒸馏结果无需重新调 LLM。
   ============================================================ */
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export interface KbBackupEntry {
  name: string;
  text: string;
  source: string;
  /** 每块蒸馏的知识点，恢复时直接写回（省一轮 LLM 调用） */
  summaries: (string | null)[];
}

export interface KbBackupFile {
  version: 1;
  exportedAt: number;
  docCount: number;
  docs: KbBackupEntry[];
}

function backupDir(): string {
  // 容器内 USER=node 无法写 /app；默认用可写的 /tmp/kqa-backups。
  // 宿机部署优先用 BACKUP_DIR 环境变量（挂卷或宿目录）持久化。
  const dir = process.env.BACKUP_DIR || join(process.cwd(), 'backups');
  try {
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    // 回退到 /tmp（容器内 node 用户可写）
    const fallback = '/tmp/kqa-backups';
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

/** 导出全库快照。返回文件绝对路径；docs 为空时返回 null（无从备份）。 */
export function writeKbBackup(docs: KbBackupEntry[]): string | null {
  if (!docs.length) return null;
  const dir = backupDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `kb-${stamp}.json`);
  const data: KbBackupFile = {
    version: 1,
    exportedAt: Date.now(),
    docCount: docs.length,
    docs,
  };
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
  return file;
}

/** 列出已有快照（新→旧），用于 UI 提示与管理 */
export function listKbBackups(): { file: string; exportedAt: number; docCount: number; size: number }[] {
  const dir = backupDir();
  if (!existsSync(dir)) return [];
  const out: { file: string; exportedAt: number; docCount: number; size: number }[] = [];
  for (const name of readdirSync(dir)) {
    if (!/^kb-.*\.json$/.test(name)) continue;
    try {
      const full = join(dir, name);
      const raw = JSON.parse(readFileSync(full, 'utf-8')) as KbBackupFile;
      out.push({
        file: full,
        exportedAt: raw.exportedAt,
        docCount: raw.docCount,
        size: JSON.stringify(raw).length,
      });
    } catch {
      // 损坏的快照跳过
    }
  }
  out.sort((a, b) => b.exportedAt - a.exportedAt);
  return out;
}

/** 读取一个快照文件（恢复用；path 参数限制在 backups 目录内） */
export function readKbBackup(file: string): KbBackupFile | null {
  const dir = backupDir();
  const full = join(dir, file);
  // 防路径穿越：解析后必须仍在 backups 目录内
  if (!full.startsWith(dir)) return null;
  if (!existsSync(full)) return null;
  try {
    const raw = JSON.parse(readFileSync(full, 'utf-8')) as KbBackupFile;
    if (raw.version !== 1 || !Array.isArray(raw.docs)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** 清理旧快照，只保留最近 N 份（默认 10） */
export function pruneKbBackups(keep = 10): void {
  const dir = backupDir();
  const all = listKbBackups();
  for (const b of all.slice(keep)) {
    if (!b.file.startsWith(dir)) continue;
    try { unlinkSync(b.file); } catch { /* ignore */ }
  }
}

/** 启动定时备份：按间隔（默认 24h）周期性导出快照。
 *  与"清空前备份"互补——这是"非破坏性"的快照，用于防范渐进误删/腐化。
 *  定时器句柄暴露供停止用。 */
export function startBackupTimer(intervalMs: number = 24 * 60 * 60 * 1000): ReturnType<typeof setTimeout> | null {
  if (intervalMs < 60 * 1000) intervalMs = 60 * 1000;  // 最低 1 分钟
  const timer = setInterval(async () => {
    try {
      const { exportForBackup } = await import('./kbStore.js');
      const docs = await exportForBackup();
      if (docs.length) {
        writeKbBackup(docs);
        pruneKbBackups();
      }
    } catch (err) {
      console.warn(`[备份] 定时备份失败：${(err as Error)?.message || err}`);
    }
  }, intervalMs);
  return timer;
}

void unlinkSync;
