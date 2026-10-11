// Finding Steam: install folder (registry, then default locations), the
// accounts that signed in on this PC (userdata/<accountId> + loginusers.vdf)
// and whether the Steam client is running. Read-only except closeSteam(),
// which asks Steam to exit through its own `-shutdown` switch.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SteamUser } from '@shared/steam';
import { runProcess } from '../platform/exec';
import { isWindows, powershellJson } from '../platform/powershell';
import { logger } from '../core/logger';
import { parseTextVdf, textGet, type TextVdf } from './vdf';

const log = logger.scope('steam');

/** steamid64 = this + 32-bit account id (individual accounts, public universe). */
export const STEAMID64_BASE = 76561197960265728n;

export function accountIdFromSteamId64(id64: string): string | null {
  if (!/^\d{17}$/.test(id64)) return null;
  const v = BigInt(id64) - STEAMID64_BASE;
  return v > 0n && v <= 0xffffffffn ? v.toString() : null;
}

export interface LoginUser {
  accountId: string;
  accountName: string | null;
  personaName: string | null;
  mostRecent: boolean;
  timestamp: number;
}

/** Parses config/loginusers.vdf. Unknown or malformed entries are skipped. */
export function parseLoginUsers(text: string): LoginUser[] {
  let doc: TextVdf;
  try {
    doc = parseTextVdf(text);
  } catch {
    return [];
  }
  const users = textGet(doc, 'users');
  if (!users || typeof users === 'string') return [];
  return Object.entries(users).flatMap(([id64, v]) => {
    const accountId = accountIdFromSteamId64(id64);
    if (!accountId || typeof v === 'string') return [];
    const s = (k: string) => {
      const x = textGet(v, k);
      return typeof x === 'string' && x ? x : null;
    };
    return [{ accountId, accountName: s('AccountName'), personaName: s('PersonaName'), mostRecent: s('MostRecent') === '1', timestamp: Number(s('Timestamp') ?? 0) || 0 }];
  });
}

/**
 * Accounts with a userdata folder, most recently used first. Names and the
 * "most recent" flag come from loginusers.vdf; when no account is flagged the
 * newest Timestamp (then the newest folder) wins.
 */
export function listSteamUsers(steamRoot: string): SteamUser[] {
  const userdata = join(steamRoot, 'userdata');
  let dirs: string[] = [];
  try {
    dirs = readdirSync(userdata, { withFileTypes: true }).filter((d) => d.isDirectory() && /^\d+$/.test(d.name) && d.name !== '0').map((d) => d.name);
  } catch {
    return [];
  }
  let logins: LoginUser[] = [];
  try {
    logins = parseLoginUsers(readFileSync(join(steamRoot, 'config', 'loginusers.vdf'), 'utf8'));
  } catch {
    /* no loginusers.vdf: folder names only */
  }
  const mtime = (id: string) => {
    try {
      return statSync(join(userdata, id)).mtimeMs;
    } catch {
      return 0;
    }
  };
  const rows = dirs.map((id) => {
    const l = logins.find((x) => x.accountId === id);
    return { id, name: l?.personaName ?? l?.accountName ?? `Steam user ${id}`, flagged: !!l?.mostRecent, timestamp: l?.timestamp ?? 0, mtime: mtime(id) };
  });
  rows.sort((a, b) => Number(b.flagged) - Number(a.flagged) || b.timestamp - a.timestamp || b.mtime - a.mtime);
  return rows.map((r, i) => ({ id: r.id, name: r.name, mostRecent: i === 0 }));
}

export interface SteamPlatform {
  /** Steam install folder, or null when Steam is not installed. */
  findSteam(): Promise<string | null>;
  isRunning(): Promise<boolean>;
  /** Asks the running Steam client to exit (steam.exe -shutdown). */
  requestShutdown(steamRoot: string): Promise<void>;
}

const DEFAULT_ROOTS = ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam'];

function looksLikeSteam(dir: string): boolean {
  return existsSync(join(dir, 'steam.exe')) || existsSync(join(dir, 'userdata'));
}

/** The real Windows implementation (registry + process list via PowerShell). */
export const windowsSteamPlatform: SteamPlatform = {
  async findSteam() {
    const reg = await powershellJson<{ SteamPath?: string }>(`Get-ItemProperty -Path 'HKCU:\\Software\\Valve\\Steam' -ErrorAction SilentlyContinue | Select-Object SteamPath | ConvertTo-Json -Compress`, 10000);
    // SteamPath is stored with forward slashes and often lower case.
    const fromReg = reg?.SteamPath ? reg.SteamPath.replace(/\//g, '\\') : null;
    for (const dir of [fromReg, ...DEFAULT_ROOTS]) if (dir && looksLikeSteam(dir)) return dir;
    if (!isWindows) {
      // Development on Linux: the native client's data folder has the same layout.
      for (const dir of [join(process.env.HOME ?? '', '.steam', 'steam'), join(process.env.HOME ?? '', '.local', 'share', 'Steam')]) if (existsSync(join(dir, 'userdata'))) return dir;
    }
    return null;
  },
  async isRunning() {
    if (isWindows) {
      const r = await powershellJson<{ Count: number }>(`[pscustomobject]@{ Count = @(Get-Process -Name steam -ErrorAction SilentlyContinue).Count } | ConvertTo-Json -Compress`, 10000);
      return (r?.Count ?? 0) > 0;
    }
    const r = await runProcess('pgrep', ['-x', 'steam'], { timeoutMs: 5000 });
    return r.code === 0;
  },
  async requestShutdown(steamRoot) {
    const exe = isWindows ? join(steamRoot, 'steam.exe') : 'steam';
    if (isWindows && !existsSync(exe)) throw new Error(`${exe} not found`);
    // Steam forwards -shutdown to the running client and exits; never elevated.
    const r = await runProcess(exe, ['-shutdown'], { timeoutMs: 20000 });
    if (r.error) throw r.error;
    log.info('asked Steam to shut down', { code: r.code, timedOut: r.timedOut });
  },
};
