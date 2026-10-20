import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Db } from '../db';
import type { Repository } from '../db/repository';
import { errorMessage, logger } from '../logger';

const PREFIX = 'quote-agent-';
const SUFFIX = '.sqlite';

export interface BackupResult {
  file: string;
  bytes: number;
  enquiries: number;
  /** Older backups removed to stay within the keep limit. */
  removed: string[];
}

/** 20261020-020000 (UTC): sorts the same alphabetically and by time. */
function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

/** Backup files in `dir`, oldest first. */
export function listBackups(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith(SUFFIX))
    .sort()
    .map((f) => path.join(dir, f));
}

/** Open a backup read-only and prove it is a healthy database. Throws if it is not. */
export function verifyBackup(file: string): { enquiries: number } {
  let copy: Database.Database | undefined;
  try {
    copy = new Database(file, { readonly: true, fileMustExist: true });
    const verdict = copy.pragma('integrity_check', { simple: true });
    if (verdict !== 'ok') throw new Error(`integrity check said: ${String(verdict)}`);
    return { enquiries: (copy.prepare('SELECT COUNT(*) AS n FROM enquiries').get() as { n: number }).n };
  } catch (err) {
    throw new Error(`${path.basename(file)} is not a usable backup (${errorMessage(err)})`);
  } finally {
    copy?.close();
  }
}

/**
 * Take a consistent copy of the live database (SQLite's online backup: safe while the service is running),
 * verify the copy, then drop the oldest copies beyond `keep`.
 */
export async function createBackup(db: Db, dir: string, keep: number, now: Date = new Date()): Promise<BackupResult> {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${PREFIX}${stamp(now)}${SUFFIX}`);
  const partial = `${file}.partial`;
  try {
    await db.backup(partial);
    fs.renameSync(partial, file);
  } finally {
    fs.rmSync(partial, { force: true });
  }
  const { enquiries } = verifyBackup(file);
  // Opening a WAL-mode copy (even read-only) leaves side files behind; the backup itself is the single .sqlite file.
  for (const side of [`${file}-wal`, `${file}-shm`]) fs.rmSync(side, { force: true });

  const removed: string[] = [];
  const all = listBackups(dir);
  for (const old of all.slice(0, Math.max(0, all.length - keep))) {
    if (old !== file) {
      for (const f of [old, `${old}-wal`, `${old}-shm`]) fs.rmSync(f, { force: true });
      removed.push(path.basename(old));
    }
  }
  return { file, bytes: fs.statSync(file).size, enquiries, removed };
}

/** Take a backup and remember the outcome (shown on the dashboard, used by the health check). */
export async function runBackup(
  db: Db,
  repo: Repository,
  cfg: { dir: string; keep: number },
  now: Date = new Date(),
): Promise<BackupResult> {
  try {
    const result = await createBackup(db, cfg.dir, cfg.keep, now);
    repo.setMeta('last_backup_at', now.toISOString());
    repo.setMeta('last_backup_file', path.basename(result.file));
    repo.setMeta('last_backup_ok', '1');
    repo.setMeta('last_backup_error', '');
    logger.info('Database backup written', { file: path.basename(result.file), kb: Math.round(result.bytes / 1024), pruned: result.removed.length });
    return result;
  } catch (err) {
    repo.setMeta('last_backup_ok', '0');
    repo.setMeta('last_backup_error', errorMessage(err).slice(0, 300));
    logger.error('Database backup FAILED', { error: errorMessage(err) });
    throw err;
  }
}

/**
 * Replace the database file with a backup. STOP THE SERVICE FIRST. The backup is verified before anything is
 * touched, and the current file is kept next to it as `.before-restore-<time>`.
 */
export function restoreBackup(backupFile: string, targetDb: string, now: Date = new Date()): { safetyCopy: string | null; enquiries: number } {
  const { enquiries } = verifyBackup(backupFile); // a bad backup must never replace a good database
  let safetyCopy: string | null = null;
  if (fs.existsSync(targetDb)) {
    safetyCopy = `${targetDb}.before-restore-${stamp(now)}`;
    fs.copyFileSync(targetDb, safetyCopy);
  }
  fs.mkdirSync(path.dirname(path.resolve(targetDb)), { recursive: true });
  const incoming = `${targetDb}.restoring`;
  fs.copyFileSync(backupFile, incoming);
  fs.rmSync(`${targetDb}-wal`, { force: true });
  fs.rmSync(`${targetDb}-shm`, { force: true });
  fs.renameSync(incoming, targetDb);
  return { safetyCopy, enquiries };
}
