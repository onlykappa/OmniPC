// Storage manager: shows where everything lives and relocates folders safely.
// Relocation copies, verifies, switches OmniDeck + emulator configs to the new
// location, and leaves the old copy in place for the user to remove.

import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { StorageKey, StorageLocation } from '@shared/models';
import type { AppPaths } from '../core/paths';
import type { JobContext } from '../core/jobs';
import type { EmulatorRepo } from '../database/emulatorRepo';
import type { EmulatorManager } from './emulatorManager';
import type { AdapterRegistry } from '../emulators/registry';
import type { OpsRepo } from '../database/opsRepo';
import { OmniFailure } from '../core/errors';
import { freeSpace } from '../platform/drives';

const LABELS: Record<StorageKey, string> = { emulators: 'Emulators', saves: 'Saves', bios: 'BIOS & firmware', cache: 'Cache', backups: 'Backups', artwork: 'Artwork', downloads: 'Downloads', logs: 'Logs' };

async function measure(dir: string, budgetMs = 1500): Promise<{ size: number; files: number; complete: boolean }> {
  const start = Date.now();
  let size = 0;
  let files = 0;
  let complete = true;
  const go = async (d: string): Promise<void> => {
    if (Date.now() - start > budgetMs) { complete = false; return; }
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) await go(p);
      else if (e.isFile()) { size += (await stat(p).catch(() => ({ size: 0 }))).size; files++; }
    }
  };
  if (existsSync(dir)) await go(dir);
  return { size, files, complete };
}

export class StorageService {
  constructor(private readonly paths: AppPaths, private readonly emuRepo: EmulatorRepo, private readonly emulators: EmulatorManager, private readonly registry: AdapterRegistry, private readonly ops: OpsRepo) {}

  async locations(): Promise<StorageLocation[]> {
    const keys: StorageKey[] = ['emulators', 'saves', 'bios', 'cache', 'backups', 'artwork', 'downloads', 'logs'];
    return Promise.all(keys.map(async (key) => {
      const p = this.paths.get(key);
      const m = await measure(p);
      return { key, label: LABELS[key], path: p, sizeBytes: m.complete ? m.size : null, freeBytes: await freeSpace(existsSync(p) ? p : this.paths.root), relocatable: key !== 'logs' };
    }));
  }

  async relocate(key: StorageKey, newPath: string, ctx: JobContext): Promise<string[]> {
    if (key === 'logs') throw new OmniFailure({ code: 'NOT_RELOCATABLE', whatHappened: 'The Logs folder cannot be moved separately.' });
    if (this.emulators && key === 'emulators') {
      // Refuse while a game might be running is handled by the caller (LaunchService).
    }
    const from = resolve(this.paths.get(key));
    const to = resolve(newPath);
    if (to === from) throw new OmniFailure({ code: 'SAME_PATH', whatHappened: 'That is already the current location.' });
    if (to.startsWith(from + sep)) throw new OmniFailure({ code: 'NESTED_PATH', whatHappened: 'The new location cannot be inside the current one.' });
    if (existsSync(to) && (await readdir(to)).length) throw new OmniFailure({ code: 'NOT_EMPTY', whatHappened: 'Choose an empty folder (or a folder that does not exist yet).', detected: [to] });
    ctx.step('Measuring');
    const m = await measure(from, 60000);
    const free = await freeSpace(existsSync(to) ? to : resolve(to, '..'));
    if (free !== null && free < m.size * 1.1) throw new OmniFailure({ code: 'DISK_FULL', whatHappened: 'Not enough free space at the new location.', detected: [`Needed ${Math.round(m.size / 1048576)} MB, free ${Math.round(free / 1048576)} MB`] });
    ctx.step(`Copying ${m.files} files (${Math.round(m.size / 1048576)} MB)`);
    await mkdir(to, { recursive: true });
    if (existsSync(from)) await cp(from, to, { recursive: true, errorOnExist: false, force: false, preserveTimestamps: true });
    ctx.throwIfCancelled();
    ctx.step('Verifying copy');
    const after = await measure(to, 60000);
    if (after.files < m.files || after.size < m.size) throw new OmniFailure({ code: 'COPY_INCOMPLETE', whatHappened: 'The copy could not be verified; OmniDeck kept using the original location.', detected: [`Source ${m.files} files / ${m.size} bytes`, `Copy ${after.files} files / ${after.size} bytes`] });
    ctx.step('Switching OmniDeck to the new location');
    this.paths.update({ overrides: { [key]: to } });
    const notes: string[] = [`${LABELS[key]} moved to ${to}`, `The original folder was left in place at ${from}; delete it once you have confirmed everything works.`];
    if (key === 'emulators') {
      for (const row of this.emuRepo.all()) {
        if (row.install_state !== 'installed' || !row.install_dir) continue;
        const rel = (p: string | null) => (p && resolve(p).startsWith(from) ? to + resolve(p).slice(from.length) : p);
        this.emuRepo.setInstalled(row.id, { state: row.install_state, version: row.version, installDir: rel(row.install_dir), executable: rel(row.executable) });
      }
    }
    ctx.step('Updating emulator configurations');
    for (const a of this.registry.implemented()) {
      if (!this.emulators.isInstalled(a.manifest.id)) continue;
      await a.applyConfig(this.emulators.configInput(a.manifest.id), 'paths');
      notes.push(`${a.manifest.name} folder settings updated`);
    }
    this.ops.addChange('storage.relocated', key, `${LABELS[key]} moved from ${from} to ${to}`);
    return notes;
  }
}
