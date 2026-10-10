// SQLite access with integrity checking, migrations, rotating backups and
// automatic recovery. If the database is damaged OmniPC restores the newest
// healthy backup; if none exists it starts fresh and rescans. Game files are
// never touched by any of this: they remain ordinary user-owned files.

import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { migrate } from './migrations';
import { logger } from '../core/logger';

const log = logger.scope('db');

export interface OpenResult {
  db: BetterSqlite3.Database;
  recovered: 'none' | 'from_backup' | 'fresh';
  notes: string[];
}

export function isHealthy(file: string): { ok: boolean; reason: string | null } {
  if (!existsSync(file)) return { ok: false, reason: 'missing' };
  let probe: BetterSqlite3.Database | null = null;
  try {
    probe = new Database(file, { readonly: true, fileMustExist: true });
    const res = probe.pragma('quick_check', { simple: true });
    return res === 'ok' ? { ok: true, reason: null } : { ok: false, reason: String(res) };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  } finally {
    try { probe?.close(); } catch { /* ignore */ }
  }
}

function configure(db: BetterSqlite3.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
}

export function listBackups(backupDir: string): string[] {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .filter((f) => /^omnideck-\d{8}T\d{6}.*\.db$/.test(f))
    .map((f) => join(backupDir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

export function openDatabase(file: string, backupDir: string): OpenResult {
  mkdirSync(dirname(file), { recursive: true });
  const notes: string[] = [];
  let recovered: OpenResult['recovered'] = 'none';

  if (existsSync(file)) {
    const health = isHealthy(file);
    if (!health.ok) {
      const quarantine = `${file}.corrupt-${Date.now()}`;
      log.error('database failed integrity check; quarantining', { reason: health.reason, quarantine });
      renameSync(file, quarantine);
      for (const sidecar of ['-wal', '-shm']) if (existsSync(file + sidecar)) renameSync(file + sidecar, quarantine + sidecar);
      notes.push(`Database integrity check failed (${health.reason}). The damaged copy was kept at ${quarantine}.`);
      const good = listBackups(backupDir).find((b) => isHealthy(b).ok);
      if (good) {
        copyFileSync(good, file);
        recovered = 'from_backup';
        notes.push(`Restored the most recent healthy backup: ${good}.`);
      } else {
        recovered = 'fresh';
        notes.push('No healthy backup was found. A new database was created; rescan your library to repopulate it. Your game files were not touched.');
      }
    }
  }

  const db = new Database(file);
  configure(db);
  const m = migrate(db);
  if (m.applied.length) log.info('migrations applied', m);
  return { db, recovered, notes };
}

/** Online backup using SQLite's backup API; keeps the newest `keep` copies. */
export async function backupDatabase(db: BetterSqlite3.Database, backupDir: string, keep = 7, tag = ''): Promise<string> {
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
  const dest = join(backupDir, `omnideck-${stamp}${tag ? '-' + tag : ''}.db`);
  await db.backup(dest);
  const all = listBackups(backupDir);
  for (const old of all.slice(keep)) {
    try { unlinkSync(old); } catch { /* ignore */ }
  }
  return dest;
}

export function newestBackupAgeHours(backupDir: string): number | null {
  const b = listBackups(backupDir)[0];
  if (!b) return null;
  return (Date.now() - statSync(b).mtimeMs) / 3_600_000;
}
