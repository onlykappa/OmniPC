// Drive enumeration and volume identity. Volume serial numbers let OmniDeck
// recognise an external game drive even when Windows assigns a new letter.

import { statfs } from 'node:fs/promises';
import { parse as parsePath } from 'node:path';
import type { DriveInfo } from '@shared/models';
import { asArray, isWindows, powershellJson } from './powershell';

interface WinDisk { DeviceID: string; VolumeName?: string; FileSystem?: string; Size?: number; FreeSpace?: number; DriveType?: number; VolumeSerialNumber?: string }

const DRIVE_TYPES: Record<number, DriveInfo['type']> = { 2: 'removable', 3: 'fixed', 4: 'network', 5: 'cdrom' };

let cache: { at: number; drives: DriveInfo[] } | null = null;

export async function listDrives(maxAgeMs = 5000): Promise<DriveInfo[]> {
  if (cache && Date.now() - cache.at < maxAgeMs) return cache.drives;
  let drives: DriveInfo[];
  if (isWindows) {
    const disks = asArray(await powershellJson<WinDisk[] | WinDisk>('Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID, VolumeName, FileSystem, Size, FreeSpace, DriveType, VolumeSerialNumber | ConvertTo-Json -Compress'));
    drives = disks.map((d) => ({
      letter: d.DeviceID.toUpperCase(),
      label: d.VolumeName || null,
      fileSystem: d.FileSystem || null,
      totalBytes: d.Size ?? null,
      freeBytes: d.FreeSpace ?? null,
      type: DRIVE_TYPES[d.DriveType ?? 0] ?? 'unknown',
      volumeSerial: d.VolumeSerialNumber || null,
    }));
  } else {
    const s = await statfs('/').catch(() => null);
    drives = [{ letter: '/', label: null, fileSystem: null, totalBytes: s ? s.blocks * s.bsize : null, freeBytes: s ? s.bavail * s.bsize : null, type: 'fixed', volumeSerial: null }];
  }
  cache = { at: Date.now(), drives };
  return drives;
}

export function invalidateDriveCache(): void {
  cache = null;
}

/** "E:\\Games\\PS2" -> "E:" ; "/home/x" -> "/" */
export function driveOf(path: string): string {
  if (/^[a-zA-Z]:/.test(path)) return path.slice(0, 2).toUpperCase();
  if (path.startsWith('\\\\')) return path.split('\\').slice(0, 4).join('\\');
  return parsePath(path).root || '/';
}

export async function driveInfoFor(path: string): Promise<DriveInfo | null> {
  const letter = driveOf(path);
  return (await listDrives()).find((d) => d.letter === letter) ?? null;
}

export async function freeSpace(path: string): Promise<number | null> {
  try {
    const s = await statfs(path);
    return s.bavail * s.bsize;
  } catch {
    const d = await driveInfoFor(path);
    return d?.freeBytes ?? null;
  }
}

/** Replace the drive prefix of a path, e.g. ("E:\\Games", "F:") -> "F:\\Games". */
export function swapDrive(path: string, newLetter: string): string {
  if (/^[a-zA-Z]:/.test(path)) return newLetter.toUpperCase() + path.slice(2);
  return path;
}
