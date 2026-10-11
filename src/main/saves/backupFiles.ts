// Save-backup naming, scheduling and retention rules. Pure functions only, so
// the decisions that can delete files or skip a backup are easy to test.
//
// File names: <emulatorId>-<stamp>-<kind>.zip, e.g.
//   pcsx2-2026-10-11T08-30-00-000Z-auto.zip
// Backups made before kinds existed are named <emulatorId>-<stamp>.zip and
// count as manual, so they are never removed automatically.

import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { SaveBackupKind, SaveBackupSettings } from '@shared/models';
import { DEFAULT_SETTINGS } from '../database/settingsRepo';

export const SAVE_BACKUP_KINDS: readonly SaveBackupKind[] = ['manual', 'auto', 'pre-update', 'pre-restore', 'after-play'];
/** Kinds OmniPC creates on its own; only these are subject to retention. */
export const AUTOMATIC_KINDS: readonly SaveBackupKind[] = ['auto', 'after-play', 'pre-update'];
/** Folder created inside the chosen backup/sync folder; one subfolder per PC below it. */
export const SYNC_FOLDER_NAME = 'OmniPC Save Backups';
export const MANIFEST_NAME = 'omnideck-save-backup.json';

const NAME_RE = /^([a-z0-9-]+?)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)(?:-(manual|auto|pre-update|pre-restore|after-play))?\.zip$/;

export function backupStamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

export function backupFileName(emulatorId: string, d: Date, kind: SaveBackupKind): string {
  return `${emulatorId}-${backupStamp(d)}-${kind}.zip`;
}

/** Parses an OmniPC backup file name; null for anything OmniPC did not create. */
export function parseBackupFileName(name: string): { emulatorId: string; createdAt: string; kind: SaveBackupKind; legacy: boolean } | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const [, emulatorId, stamp, kind] = m;
  const iso = stamp.replace(/^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/, '$1$2:$3:$4.$5');
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return { emulatorId, createdAt: new Date(t).toISOString(), kind: (kind as SaveBackupKind | undefined) ?? 'manual', legacy: !kind };
}

export function isAutomaticKind(kind: SaveBackupKind): boolean {
  return AUTOMATIC_KINDS.includes(kind);
}

/** The settings with defaults filled in and the retention count clamped. */
export function saveBackupSettings(raw: Partial<SaveBackupSettings> | null | undefined): SaveBackupSettings {
  const d = DEFAULT_SETTINGS.saveBackup;
  const s = { ...d, ...(raw ?? {}) };
  const keep = Number.isFinite(s.keepPerEmulator) ? Math.round(s.keepPerEmulator) : d.keepPerEmulator;
  return {
    schedule: s.schedule === 'off' || s.schedule === 'weekly' ? s.schedule : 'daily',
    afterPlay: !!s.afterPlay,
    beforeEmulatorUpdate: !!s.beforeEmulatorUpdate,
    destination: typeof s.destination === 'string' && s.destination.trim() ? s.destination : null,
    keepPerEmulator: Math.min(1000, Math.max(1, keep)),
  };
}

const HOUR = 3600 * 1000;
export const SCHEDULE_INTERVAL_MS = { daily: 24 * HOUR, weekly: 7 * 24 * HOUR } as const;

/** Whether a scheduled backup run is due. */
export function scheduledBackupDue(schedule: SaveBackupSettings['schedule'], lastRunIso: string | null, now: Date): boolean {
  if (schedule === 'off') return false;
  if (!lastRunIso) return true;
  const last = Date.parse(lastRunIso);
  if (Number.isNaN(last)) return true;
  // A clock that went backwards (last run "in the future") also triggers a run.
  if (last > now.getTime()) return true;
  return now.getTime() - last >= SCHEDULE_INTERVAL_MS[schedule];
}

/** Cheap summary of an emulator's save files used to skip identical backups. */
export interface SaveFingerprint {
  fileCount: number;
  totalSize: number;
  newestMtime: number;
}

export function fingerprintOf(files: { size: number; mtime: number }[]): SaveFingerprint {
  return { fileCount: files.length, totalSize: files.reduce((s, f) => s + f.size, 0), newestMtime: files.reduce((m, f) => Math.max(m, Math.floor(f.mtime)), 0) };
}

export function sameFingerprint(a: SaveFingerprint | null | undefined, b: SaveFingerprint | null | undefined): boolean {
  return !!a && !!b && a.fileCount === b.fileCount && a.totalSize === b.totalSize && a.newestMtime === b.newestMtime;
}

/**
 * Which backups retention removes: for each emulator, automatic backups beyond
 * the newest `keep`. Manual, pre-restore and legacy (unnamed-kind) backups are
 * never selected. Callers pass only this PC's backups in OmniPC's own folders.
 */
export function selectForRetention<T extends { fileName: string }>(items: T[], keep: number): T[] {
  const byEmu = new Map<string, { item: T; createdAt: string }[]>();
  for (const item of items) {
    const p = parseBackupFileName(item.fileName);
    if (!p || p.legacy || !isAutomaticKind(p.kind)) continue;
    if (!byEmu.has(p.emulatorId)) byEmu.set(p.emulatorId, []);
    byEmu.get(p.emulatorId)!.push({ item, createdAt: p.createdAt });
  }
  const out: T[] = [];
  for (const list of byEmu.values()) {
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.item.fileName.localeCompare(a.item.fileName));
    out.push(...list.slice(Math.max(1, keep)).map((x) => x.item));
  }
  return out;
}

/** A PC name usable as a folder name on every file system cloud clients sync to. */
export function computerFolderName(hostname: string): string {
  const clean = hostname.replace(/[^\w .()-]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 64);
  return clean && isSafeFolderName(clean) ? clean : 'This PC';
}

/** A single path segment: no separators, no "." / "..", no reserved characters. */
export function isSafeFolderName(name: string): boolean {
  return /^[\w .()-]{1,64}$/.test(name) && name !== '.' && name !== '..' && !/^\s|[\s.]$/.test(name);
}

/** True when `child` is `parent` or lies inside it (case-insensitive on Windows). */
export function isInsideOrSame(child: string, parent: string, win32 = process.platform === 'win32'): boolean {
  const norm = (p: string) => (win32 ? resolve(p).toLowerCase() : resolve(p));
  const rel = relative(norm(parent), norm(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
