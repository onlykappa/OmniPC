// Windows integration via PowerShell. Only scripts authored in this repository
// are executed; nothing downloaded is ever passed here. Output is JSON.

import { runProcess } from './exec';
import { logger } from '../core/logger';

const log = logger.scope('powershell');

export const isWindows = process.platform === 'win32';

export async function powershellJson<T>(script: string, timeoutMs = 20000): Promise<T | null> {
  if (!isWindows) return null;
  // -EncodedCommand avoids every quoting problem with the script text.
  const wrapped = `$ErrorActionPreference = 'SilentlyContinue'; $ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`;
  const encoded = Buffer.from(wrapped, 'utf16le').toString('base64');
  const res = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { timeoutMs });
  if (res.error || res.timedOut) {
    log.warn('powershell failed', { error: res.error?.message, timedOut: res.timedOut });
    return null;
  }
  const text = res.stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    log.warn('powershell returned non-JSON output', { sample: text.slice(0, 200) });
    return null;
  }
}

/** Returns arrays even when PowerShell collapses single results into an object. */
export function asArray<T>(v: T | T[] | null | undefined): T[] {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** Reads a file's version resource (FileVersion/ProductVersion). */
export async function fileVersion(path: string): Promise<string | null> {
  if (!isWindows) return null;
  const escaped = path.replace(/'/g, "''");
  const r = await powershellJson<{ ProductVersion?: string; FileVersion?: string }>(`(Get-Item -LiteralPath '${escaped}').VersionInfo | Select-Object ProductVersion, FileVersion | ConvertTo-Json -Compress`, 10000);
  const v = (r?.ProductVersion || r?.FileVersion || '').trim();
  return v || null;
}
