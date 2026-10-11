// Backup/sync folder: cloud-folder suggestions and validation of the folder
// the user picks. OmniPC only writes into "<folder>\OmniPC Save Backups\<PC>".

import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { SaveBackupFolderSuggestion } from '@shared/models';
import { SYNC_FOLDER_NAME, isInsideOrSame } from './backupFiles';

export interface CloudProbe {
  env: Record<string, string | undefined>;
  home: string;
  isDir: (p: string) => boolean;
  readText: (p: string) => string | null;
  /** Drive letters to look for "X:\My Drive" (Google Drive for desktop). */
  driveLetters: string[];
}

export function defaultCloudProbe(home: string): CloudProbe {
  return {
    env: process.env,
    home,
    isDir: (p) => {
      try { return statSync(p).isDirectory(); } catch { return false; }
    },
    readText: (p) => {
      try { return existsSync(p) ? readFileSync(p, 'utf8') : null; } catch { return null; }
    },
    driveLetters: process.platform === 'win32' ? 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('') : [],
  };
}

/** Existing OneDrive / Google Drive / Dropbox folders on this PC. */
export function cloudFolderSuggestions(p: CloudProbe): SaveBackupFolderSuggestion[] {
  const cands: SaveBackupFolderSuggestion[] = [];
  const add = (provider: SaveBackupFolderSuggestion['provider'], path: string | undefined | null) => {
    if (path && isAbsolute(path)) cands.push({ provider, path });
  };
  add('OneDrive', p.env.OneDrive);
  add('OneDrive', p.env.OneDriveConsumer);
  add('OneDrive', p.env.OneDriveCommercial);
  add('OneDrive', join(p.home, 'OneDrive'));
  for (const l of p.driveLetters) add('Google Drive', `${l}:\\My Drive`);
  add('Google Drive', join(p.home, 'Google Drive'));
  add('Google Drive', join(p.home, 'My Drive'));
  add('Google Drive', join(p.home, 'Google Drive', 'My Drive'));
  for (const base of [p.env.LOCALAPPDATA, p.env.APPDATA]) {
    if (!base) continue;
    const text = p.readText(join(base, 'Dropbox', 'info.json'));
    if (!text) continue;
    try {
      const info = JSON.parse(text) as Record<string, { path?: unknown } | undefined>;
      for (const acct of Object.values(info)) if (acct && typeof acct.path === 'string') add('Dropbox', acct.path);
    } catch {
      /* not JSON: ignore */
    }
  }
  add('Dropbox', join(p.home, 'Dropbox'));
  const seen = new Set<string>();
  return cands.filter((c) => {
    const key = resolve(c.path).toLowerCase();
    if (seen.has(key) || !p.isDir(c.path)) return false;
    seen.add(key);
    return true;
  });
}

export interface DestinationRules {
  /** OmniPC's program folder. */
  installDir: string | null;
  /** Every emulator save folder plus OmniPC's Saves folder. */
  saveDirs: string[];
}

/** Rejects folders OmniPC must never write backups into. Returns the reason, or null if allowed. */
export function destinationProblem(folder: string, rules: DestinationRules): string | null {
  if (!isAbsolute(folder)) return 'Choose a full folder path (for example C:\\Users\\you\\OneDrive).';
  const dir = resolve(folder);
  if (dirname(dir) === dir) return 'Choose a folder, not the root of a drive.';
  if (rules.installDir && isInsideOrSame(dir, rules.installDir)) return "That is OmniPC's program folder, which is replaced on every update. Choose another folder.";
  for (const s of rules.saveDirs) {
    if (isInsideOrSame(dir, s)) return `That folder is inside an emulator save folder (${s}). Backups must live outside the saves they protect.`;
  }
  return null;
}

/** Full validation for a newly chosen folder: allowed, exists, and writable (probe file). */
export async function validateDestination(folder: string, rules: DestinationRules, computerFolder: string): Promise<string | null> {
  const problem = destinationProblem(folder, rules);
  if (problem) return problem;
  const s = await stat(folder).catch(() => null);
  if (!s?.isDirectory()) return 'That folder does not exist (is the drive connected?).';
  try {
    const target = join(folder, SYNC_FOLDER_NAME, computerFolder);
    await mkdir(target, { recursive: true });
    const probe = join(target, `.omnipc-write-test-${process.pid}`);
    await writeFile(probe, 'ok');
    await rm(probe, { force: true });
  } catch (e) {
    return `OmniPC cannot write to that folder (${(e as NodeJS.ErrnoException).code ?? 'access denied'}).`;
  }
  return null;
}
