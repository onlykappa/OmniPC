// Configuration backup service. Before OmniPC modifies any emulator config it
// snapshots the affected files here. Backups are plain folders containing a copy
// of each file plus a manifest, so users can inspect them without OmniPC.

import { copyFile, mkdir, readFile, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { ConfigBackup, ConfigDiff } from '@shared/models';
import type { OpsRepo } from '../database/opsRepo';
import { logger } from '../core/logger';
import { diffLines } from './diff';
import { redactAchievementFile } from '../achievements/emulatorConfig';

const log = logger.scope('backups');

export interface BackupTarget {
  /** Absolute path of the live file. */
  path: string;
  /** Root the file is relative to; restore maps back via this root. */
  root: string;
}

interface BackupManifest {
  version: 1;
  emulatorId: string | null;
  createdAt: string;
  entries: { rel: string; root: string; existed: boolean }[];
}

export class ConfigBackupService {
  constructor(private readonly dir: string, private readonly ops: OpsRepo, private readonly keepPerEmulator = 25) {}

  /** Snapshot files (and record files that did not exist so restore can remove them). */
  async create(emulatorId: string | null, label: string, reason: string, targets: BackupTarget[]): Promise<ConfigBackup> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const folder = join(this.dir, emulatorId ?? 'omnideck', stamp + '-' + Math.random().toString(36).slice(2, 6));
    await mkdir(folder, { recursive: true });
    const manifest: BackupManifest = { version: 1, emulatorId, createdAt: new Date().toISOString(), entries: [] };
    let size = 0;
    const files: string[] = [];
    for (const t of targets) {
      const rel = safeRelative(t.root, t.path);
      const existed = existsSync(t.path);
      manifest.entries.push({ rel, root: t.root, existed });
      if (!existed) continue;
      const dest = join(folder, 'files', rel);
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(t.path, dest);
      size += (await stat(dest)).size;
      files.push(rel);
    }
    await writeFile(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const rec = this.ops.addBackup({ emulatorId, label, reason, path: folder, files, sizeBytes: size });
    log.info('config backup created', { id: rec.id, emulatorId, reason, files: files.length });
    await this.prune(emulatorId);
    return rec;
  }

  async restore(backupId: number, opts: { safetyBackup: boolean } = { safetyBackup: true }): Promise<{ restored: string[]; safetyBackupId: number | null }> {
    const b = this.ops.getBackup(backupId);
    if (!b) throw new Error(`Backup ${backupId} not found`);
    const manifest = await this.readManifest(b.path);
    let safetyBackupId: number | null = null;
    if (opts.safetyBackup) {
      const safety = await this.create(b.emulatorId, `Before restoring "${b.label}"`, 'pre-restore', manifest.entries.map((e) => ({ root: e.root, path: join(e.root, e.rel) })));
      safetyBackupId = safety.id;
    }
    const restored: string[] = [];
    for (const e of manifest.entries) {
      const live = resolve(e.root, e.rel);
      if (!isInside(e.root, live)) throw new Error(`Refusing to restore outside of ${e.root}: ${e.rel}`);
      if (e.existed) {
        await mkdir(dirname(live), { recursive: true });
        await copyFile(join(b.path, 'files', e.rel), live);
        restored.push(live);
      } else if (existsSync(live)) {
        // File was created after the backup; move it aside rather than deleting.
        await copyFile(live, live + '.omnideck-removed');
        await rm(live);
        restored.push(`${live} (removed; copy kept as .omnideck-removed)`);
      }
    }
    log.info('config backup restored', { backupId, files: restored.length });
    return { restored, safetyBackupId };
  }

  async diff(backupId: number): Promise<ConfigDiff> {
    const b = this.ops.getBackup(backupId);
    if (!b) throw new Error(`Backup ${backupId} not found`);
    const manifest = await this.readManifest(b.path);
    const files: ConfigDiff['files'] = [];
    for (const e of manifest.entries) {
      const live = join(e.root, e.rel);
      // Diffs are shown in the UI: RetroAchievements tokens are blanked.
      const before = e.existed ? redactAchievementFile(e.rel, await readFile(join(b.path, 'files', e.rel), 'utf8').catch(() => '')) : null;
      const now = existsSync(live) ? redactAchievementFile(e.rel, await readFile(live, 'utf8').catch(() => '')) : null;
      if (before === null && now === null) continue;
      if (before === null) files.push({ relPath: e.rel, status: 'added', lines: diffLines('', now!) });
      else if (now === null) files.push({ relPath: e.rel, status: 'removed', lines: diffLines(before, '') });
      else files.push({ relPath: e.rel, status: before === now ? 'same' : 'changed', lines: before === now ? [] : diffLines(before, now) });
    }
    return { backupId, files };
  }

  async delete(backupId: number): Promise<void> {
    const b = this.ops.getBackup(backupId);
    if (!b) return;
    if (isInside(this.dir, b.path)) await rm(b.path, { recursive: true, force: true });
    this.ops.deleteBackup(backupId);
  }

  private async readManifest(folder: string): Promise<BackupManifest> {
    return JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8')) as BackupManifest;
  }

  private async prune(emulatorId: string | null): Promise<void> {
    const all = this.ops.backups(emulatorId ?? null).filter((b) => b.emulatorId === emulatorId);
    for (const old of all.slice(this.keepPerEmulator)) {
      await this.delete(old.id).catch((e) => log.warn('prune failed', e));
    }
  }

  /** Recursively list files under a directory (used to back up whole config dirs). */
  static async listFiles(dir: string, filter: (rel: string) => boolean = () => true, maxFiles = 2000): Promise<string[]> {
    const out: string[] = [];
    async function walk(d: string): Promise<void> {
      if (out.length >= maxFiles) return;
      let entries;
      try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.isFile() && filter(relative(dir, p))) out.push(p);
      }
    }
    await walk(dir);
    return out;
  }
}

export function isInside(root: string, p: string): boolean {
  const r = resolve(root);
  const t = resolve(p);
  const norm = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  return norm(t) === norm(r) || norm(t).startsWith(norm(r.endsWith(sep) ? r : r + sep));
}

function safeRelative(root: string, p: string): string {
  const rel = relative(root, p);
  if (!rel || rel.startsWith('..') || resolve(root, rel) !== resolve(p)) return basename(p);
  return rel;
}
