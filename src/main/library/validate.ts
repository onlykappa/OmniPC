// File validation: catches problems before the emulator does, and lets
// OmniDoctor distinguish "bad game file" from "bad emulator setup".

import { access, constants, open, stat } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { ValidationState } from '@shared/models';
import type { SystemId } from '@shared/systems';
import { parseCueFiles, parseM3u } from './identify';

export interface ValidationResult {
  state: ValidationState;
  notes: string[];
}

export const INCOMPLETE_EXTENSIONS = ['.part', '.crdownload', '.!qb', '.download', '.partial', '.tmp', '.!ut', '.opdownload'];

/** Known exact sizes of full, unmodified Nintendo disc images. */
const GC_FULL_SIZE = 1_459_978_240;
const WII_SL_SIZE = 4_699_979_776;
const WII_DL_SIZE = 8_511_160_320;

export async function validateGameFile(path: string, systemId: SystemId | null, sizeBytes: number): Promise<ValidationResult> {
  const notes: string[] = [];
  let state: ValidationState = 'ok';
  const bad = (n: string) => { state = 'invalid'; notes.push(n); };
  const warn = (n: string) => { if (state !== 'invalid') state = 'warning'; notes.push(n); };
  const ext = extname(path).toLowerCase();

  if (INCOMPLETE_EXTENSIONS.includes(ext)) bad('File looks like an unfinished download.');
  if (sizeBytes === 0) bad('File is empty (0 bytes).');
  try {
    await access(path, constants.R_OK);
    const fh = await open(path, 'r');
    try {
      const b = Buffer.alloc(16);
      await fh.read(b, 0, 16, 0);
    } finally {
      await fh.close();
    }
  } catch (e) {
    bad(`File cannot be read: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    return { state, notes };
  }

  if (ext === '.cue') {
    const files = await parseCueFiles(path);
    if (!files.length) bad('CUE sheet does not reference any track files.');
    for (const f of files) {
      if (!existsSync(join(dirname(path), f))) bad(`CUE sheet references missing track "${f}".`);
    }
  }
  if (ext === '.m3u') {
    const entries = await parseM3u(path);
    if (!entries.length) bad('M3U playlist is empty.');
    for (const f of entries) if (!existsSync(join(dirname(path), f))) bad(`Playlist references missing disc "${f}".`);
  }
  if (['.iso', '.gcm'].includes(ext) && sizeBytes > 0) {
    if (systemId && ['ps2', 'psp', 'ps3'].includes(systemId) && sizeBytes % 2048 !== 0) warn('Image size is not a multiple of 2048 bytes; the dump may be truncated.');
    if (systemId === 'gc' && sizeBytes < GC_FULL_SIZE && sizeBytes % 2048 !== 0) warn('GameCube image is smaller than a full disc and not sector aligned; it may be truncated.');
    if (systemId === 'wii' && sizeBytes !== WII_SL_SIZE && sizeBytes !== WII_DL_SIZE && sizeBytes > 1_000_000_000 && sizeBytes < WII_SL_SIZE) warn('Wii image is not a standard disc size. This is normal for scrubbed/NKit images but can indicate a truncated dump.');
  }
  if (ext === '.bin' && sizeBytes % 2352 !== 0 && sizeBytes % 2048 !== 0) warn('BIN size is not a multiple of a CD sector size; the dump may be incomplete.');
  if (['.zip', '.7z', '.rar'].includes(ext) && systemId && !['arcade'].includes(systemId)) {
    warn('Game is inside a compressed archive. Most disc-based emulators cannot run archived images directly.');
  }
  const split = splitArchiveIssue(path);
  if (split) bad(split);
  if (/\.nkit\./i.test(basename(path))) warn('NKit image: Dolphin can run it, but some features (NetPlay, verification) may not work.');
  return { state, notes };
}

/** Detects missing pieces of split sets like game.7z.001/.002 or game.z01/.zip. */
export function splitArchiveIssue(path: string): string | null {
  const name = basename(path);
  const dir = dirname(path);
  let siblings: string[];
  try { siblings = readdirSync(dir); } catch { return null; }
  const numbered = /^(.*)\.(\d{3})$/.exec(name);
  if (numbered) {
    const base = numbered[1];
    const nums = siblings.map((s) => new RegExp(`^${escapeRe(base)}\\.(\\d{3})$`).exec(s)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
    const first = nums[0] ?? 1;
    for (let i = first; i <= nums[nums.length - 1]; i++) if (!nums.includes(i)) return `Split set "${base}" is missing part .${String(i).padStart(3, '0')}.`;
  }
  const zParts = /^(.*)\.z(\d{2})$/i.exec(name);
  if (zParts && !siblings.some((s) => s.toLowerCase() === `${zParts[1]}.zip`.toLowerCase())) return `Split ZIP "${zParts[1]}" is missing its final .zip part.`;
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function fileStat(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const s = await stat(path);
    return s.isFile() ? { size: s.size, mtimeMs: Math.round(s.mtimeMs) } : null;
  } catch {
    return null;
  }
}
