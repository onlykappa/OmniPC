// Save manager: shows save locations and makes ZIP backups. Restores always
// back up the current saves first. OmniDeck never deletes save data.

import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import yazl from 'yazl';
import yauzl from 'yauzl';
import type { SaveBackup, SaveLocation } from '@shared/models';
import type { AdapterRegistry } from '../emulators/registry';
import type { EmulatorManager } from './emulatorManager';
import type { AppPaths } from '../core/paths';
import type { OpsRepo } from '../database/opsRepo';
import { OmniFailure } from '../core/errors';
import { resolveInside } from '../downloads/archive';

async function walk(dir: string): Promise<{ path: string; size: number; mtime: number }[]> {
  const out: { path: string; size: number; mtime: number }[] = [];
  const go = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) await go(p);
      else if (e.isFile()) {
        const s = await stat(p);
        out.push({ path: p, size: s.size, mtime: s.mtimeMs });
      }
    }
  };
  await go(dir);
  return out;
}

export class SaveService {
  constructor(private readonly registry: AdapterRegistry, private readonly emulators: EmulatorManager, private readonly paths: AppPaths, private readonly ops: OpsRepo) {}

  async locations(emulatorId?: string): Promise<SaveLocation[]> {
    const out: SaveLocation[] = [];
    for (const a of this.registry.implemented()) {
      if (emulatorId && a.manifest.id !== emulatorId) continue;
      for (const l of a.saveLocations()) {
        const files = existsSync(l.path) ? await walk(l.path) : [];
        out.push({ emulatorId: a.manifest.id, label: `${a.manifest.name}: ${l.label}`, path: l.path, exists: existsSync(l.path), fileCount: files.length, sizeBytes: files.reduce((s, f) => s + f.size, 0), lastModified: files.length ? new Date(Math.max(...files.map((f) => f.mtime))).toISOString() : null });
      }
    }
    return out;
  }

  async backup(emulatorId: string | null, reason = 'manual'): Promise<SaveBackup[]> {
    const created: SaveBackup[] = [];
    await mkdir(this.paths.saveBackups, { recursive: true });
    for (const a of this.registry.implemented()) {
      if (emulatorId && a.manifest.id !== emulatorId) continue;
      const locs = a.saveLocations().filter((l) => existsSync(l.path));
      if (!locs.length) continue;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = join(this.paths.saveBackups, `${a.manifest.id}-${stamp}.zip`);
      const zip = new yazl.ZipFile();
      const manifest = { emulatorId: a.manifest.id, createdAt: new Date().toISOString(), reason, locations: locs.map((l, i) => ({ index: i, label: l.label, path: l.path })) };
      zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), 'omnideck-save-backup.json');
      let count = 0;
      for (const [i, l] of locs.entries()) {
        for (const f of await walk(l.path)) {
          zip.addFile(f.path, `${i}/${relative(l.path, f.path).replace(/\\/g, '/')}`);
          count++;
        }
      }
      if (!count) continue;
      await new Promise<void>((resolve, reject) => {
        zip.outputStream.pipe(createWriteStream(dest)).on('close', () => resolve()).on('error', reject);
        zip.end();
      });
      const s = await stat(dest);
      created.push({ id: basename(dest), emulatorId: a.manifest.id, label: `${a.manifest.name} saves (${count} files)`, path: dest, createdAt: manifest.createdAt, sizeBytes: s.size });
      this.ops.addChange('saves.backup', a.manifest.id, `${a.manifest.name} saves backed up (${count} files)`);
    }
    return created;
  }

  async list(): Promise<SaveBackup[]> {
    if (!existsSync(this.paths.saveBackups)) return [];
    const out: SaveBackup[] = [];
    for (const f of await readdir(this.paths.saveBackups)) {
      if (!f.endsWith('.zip')) continue;
      const s = await stat(join(this.paths.saveBackups, f));
      const emu = f.split('-')[0];
      out.push({ id: f, emulatorId: emu, label: `${this.registry.get(emu)?.manifest.name ?? emu} saves`, path: join(this.paths.saveBackups, f), createdAt: s.mtime.toISOString(), sizeBytes: s.size });
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Restores a backup into its original locations after backing up the current saves. */
  async restore(backupId: string): Promise<{ restoredTo: string; safetyBackup: string }> {
    if (!/^[\w.\-]+\.zip$/.test(backupId)) throw new OmniFailure({ code: 'BAD_BACKUP', whatHappened: 'Invalid backup id.' });
    const file = join(this.paths.saveBackups, backupId);
    if (!existsSync(file)) throw new OmniFailure({ code: 'BAD_BACKUP', whatHappened: 'Backup not found.' });
    const entries = await readZip(file);
    const manifestEntry = entries.get('omnideck-save-backup.json');
    if (!manifestEntry) throw new OmniFailure({ code: 'BAD_BACKUP', whatHappened: 'This file is not an OmniDeck save backup.' });
    const manifest = JSON.parse(manifestEntry.toString('utf8')) as { emulatorId: string; locations: { index: number; path: string }[] };
    const safety = await this.backup(manifest.emulatorId, 'pre-restore');
    const targets: string[] = [];
    for (const [name, data] of entries) {
      if (name === 'omnideck-save-backup.json') continue;
      const [idx, ...rest] = name.split('/');
      const loc = manifest.locations.find((l) => String(l.index) === idx);
      if (!loc || !rest.length) continue;
      const target = resolveInside(loc.path, rest.join('/'));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
      targets.push(loc.path);
    }
    this.ops.addChange('saves.restore', manifest.emulatorId, `Saves restored from ${backupId}`);
    return { restoredTo: [...new Set(targets)].join(', '), safetyBackup: safety[0]?.path ?? 'nothing to back up' };
  }
}

function readZip(file: string): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const out = new Map<string, Buffer>();
      zip.on('entry', (e: yauzl.Entry) => {
        if (/\/$/.test(e.fileName)) return zip.readEntry();
        zip.openReadStream(e, (e2, s) => {
          if (e2 || !s) return reject(e2);
          const chunks: Buffer[] = [];
          s.on('data', (c: Buffer) => chunks.push(c));
          s.on('end', () => { out.set(e.fileName, Buffer.concat(chunks)); zip.readEntry(); });
        });
      });
      zip.on('end', () => resolve(out));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

