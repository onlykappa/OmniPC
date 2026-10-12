// Save manager: shows save locations and makes ZIP backups. Restores always
// back up the current saves first. OmniPC never deletes save data; the only
// files it ever removes are its own automatic backup ZIPs (retention).
//
// Backups go to OmniPC's Backups\saves folder, or — when a backup/sync folder
// is chosen (e.g. OneDrive) — to "<folder>\OmniPC Save Backups\<PC name>\" so
// several PCs can share one cloud folder. Backups of other PCs found there are
// listed and can be restored here.

import { createWriteStream, existsSync } from 'node:fs';
import { access, constants, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import yazl from 'yazl';
import yauzl from 'yauzl';
import type { SaveBackup, SaveBackupFolderSuggestion, SaveBackupKind, SaveBackupSettings, SaveLocation } from '@shared/models';
import type { AdapterRegistry } from '../emulators/registry';
import type { EmulatorAdapter } from '../emulators/adapter';
import type { EmulatorManager } from './emulatorManager';
import type { AppPaths } from '../core/paths';
import type { OpsRepo } from '../database/opsRepo';
import type { SettingsRepo } from '../database/settingsRepo';
import { OmniFailure } from '../core/errors';
import { logger } from '../core/logger';
import { resolveInside } from '../downloads/archive';
import {
  MANIFEST_NAME,
  SAVE_BACKUP_KINDS,
  SYNC_FOLDER_NAME,
  backupFileName,
  computerFolderName,
  fingerprintOf,
  isAutomaticKind,
  isSafeFolderName,
  parseBackupFileName,
  sameFingerprint,
  saveBackupSettings,
  selectForRetention,
  type SaveFingerprint,
} from '../saves/backupFiles';
import { cloudFolderSuggestions, defaultCloudProbe, destinationProblem, validateDestination, type CloudProbe, type DestinationRules } from '../saves/cloudFolders';

const log = logger.scope('saves');

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

export interface SaveServiceOptions {
  /** Defaults to this PC's host name. */
  computerName?: string;
  /** OmniPC's program folder; never accepted as a backup folder. */
  installDir?: string | null;
  /** The user's profile folder, where cloud clients usually keep their folders. */
  homeDir?: string;
  /** Overrides cloud-folder detection (tests). */
  cloudProbe?: CloudProbe;
}

export interface BackupOptions {
  /** Skip emulators whose saves did not change since their last backup. Default: true for automatic kinds. */
  onlyIfChanged?: boolean;
}

interface FingerprintRecord {
  fp: SaveFingerprint;
  file: string;
}

interface BackupRoot {
  dir: string;
  location: SaveBackup['location'];
  computer: string;
  thisComputer: boolean;
  idPrefix: string;
}

const FINGERPRINTS_KEY = 'saveBackup.fingerprints';

export class SaveService {
  readonly computer: string;
  private chain: Promise<unknown> = Promise.resolve();
  private memFingerprints: Record<string, FingerprintRecord> = {};
  private runningEmulator: () => string | null = () => null;

  constructor(
    private readonly registry: AdapterRegistry,
    private readonly emulators: EmulatorManager,
    private readonly paths: AppPaths,
    private readonly ops: OpsRepo,
    private readonly settingsRepo?: SettingsRepo,
    private readonly opts: SaveServiceOptions = {},
  ) {
    this.computer = computerFolderName(opts.computerName ?? hostname());
  }

  /** Lets restore refuse while the emulator it would write into is running. */
  setRunningEmulatorProbe(fn: () => string | null): void {
    this.runningEmulator = fn;
  }

  config(): SaveBackupSettings {
    return saveBackupSettings(this.settingsRepo?.get('saveBackup'));
  }

  /** One backup/restore at a time, so automatic and manual runs never interleave. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  // ------------------------------------------------------------ destination

  destinationRules(): DestinationRules {
    const saveDirs = [this.paths.saves];
    for (const a of this.registry.implemented()) for (const l of a.saveLocations()) saveDirs.push(l.path);
    return { installDir: this.opts.installDir ?? null, saveDirs };
  }

  /** The chosen backup/sync folder's state (null destination = OmniPC's own folder). */
  async destinationStatus(): Promise<{ destination: string | null; problem: string | null }> {
    const { destination } = this.config();
    if (!destination) return { destination, problem: null };
    const rule = destinationProblem(destination, this.destinationRules());
    if (rule) return { destination, problem: rule };
    const s = await stat(destination).catch(() => null);
    if (!s?.isDirectory()) return { destination, problem: 'The backup folder is missing (drive disconnected or folder removed). Backups are going to OmniPC\'s own Backups folder until it is back.' };
    const ours = join(destination, SYNC_FOLDER_NAME, this.computer);
    try {
      await access(existsSync(ours) ? ours : destination, constants.W_OK);
    } catch {
      return { destination, problem: 'OmniPC cannot write to the backup folder. Backups are going to OmniPC\'s own Backups folder.' };
    }
    return { destination, problem: null };
  }

  /** Validates and stores the backup/sync folder (null = OmniPC's own Backups folder). */
  async setDestination(folder: string | null): Promise<SaveBackupSettings> {
    if (!this.settingsRepo) throw new OmniFailure({ code: 'NO_SETTINGS', whatHappened: 'Settings are not available.' });
    const cur = this.config();
    if (folder !== null && typeof folder !== 'string') throw new OmniFailure({ code: 'BAD_BACKUP_FOLDER', whatHappened: 'Invalid folder.' });
    if (folder !== null) {
      const problem = await validateDestination(folder, this.destinationRules(), this.computer);
      if (problem) throw new OmniFailure({ code: 'BAD_BACKUP_FOLDER', whatHappened: problem });
    }
    this.settingsRepo.set({ saveBackup: { ...cur, destination: folder } });
    this.ops.addChange('saves.destination', null, folder ? `Save backups now go to ${join(folder, SYNC_FOLDER_NAME, this.computer)}` : "Save backups now go to OmniPC's Backups folder");
    return this.config();
  }

  suggestions(): SaveBackupFolderSuggestion[] {
    return cloudFolderSuggestions(this.opts.cloudProbe ?? defaultCloudProbe(this.opts.homeDir ?? dirname(this.paths.root)));
  }

  /** Where new backups are written. Falls back to OmniPC's folder if the chosen one is unusable. */
  activeFolder(): { dir: string; location: SaveBackup['location'] } {
    const { destination } = this.config();
    if (destination && existsSync(destination) && !destinationProblem(destination, this.destinationRules())) {
      return { dir: join(destination, SYNC_FOLDER_NAME, this.computer), location: 'destination' };
    }
    if (destination) log.warn('save backup folder unavailable; using the local backups folder', { destination });
    return { dir: this.paths.saveBackups, location: 'local' };
  }

  private roots(): BackupRoot[] {
    const out: BackupRoot[] = [{ dir: this.paths.saveBackups, location: 'local', computer: this.computer, thisComputer: true, idPrefix: '' }];
    const sync = this.syncRoot();
    if (sync) out.push({ dir: sync, location: 'destination', computer: '', thisComputer: false, idPrefix: 'pc:' });
    return out;
  }

  private syncRoot(): string | null {
    const { destination } = this.config();
    return destination ? join(destination, SYNC_FOLDER_NAME) : null;
  }

  // ------------------------------------------------------------- locations

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

  // ---------------------------------------------------------------- backup

  /**
   * Backs up one emulator's saves (or all). `kind` is recorded in the file
   * name and manifest. Automatic kinds skip unchanged saves and apply
   * retention afterwards; manual and pre-restore backups always run and are
   * never removed automatically.
   */
  backup(emulatorId: string | null, kind: SaveBackupKind | string = 'manual', opts: BackupOptions = {}): Promise<SaveBackup[]> {
    return this.exclusive(() => this.backupUnlocked(emulatorId, normaliseKind(kind), opts));
  }

  private async backupUnlocked(emulatorId: string | null, kind: SaveBackupKind, opts: BackupOptions): Promise<SaveBackup[]> {
    const created: SaveBackup[] = [];
    const onlyIfChanged = opts.onlyIfChanged ?? isAutomaticKind(kind);
    const target = this.activeFolder();
    await mkdir(target.dir, { recursive: true });
    for (const a of this.registry.implemented()) {
      if (emulatorId && a.manifest.id !== emulatorId) continue;
      const b = await this.backupOne(a, kind, onlyIfChanged, target);
      if (b) created.push(b);
    }
    return created;
  }

  private async backupOne(a: EmulatorAdapter, kind: SaveBackupKind, onlyIfChanged: boolean, target: { dir: string; location: SaveBackup['location'] }): Promise<SaveBackup | null> {
    const id = a.manifest.id;
    const locs = a.saveLocations().filter((l) => existsSync(l.path));
    if (!locs.length) return null;
    const perLoc = await Promise.all(locs.map(async (l) => ({ l, files: await walk(l.path) })));
    const all = perLoc.flatMap((x) => x.files);
    if (!all.length) return null;
    const fp = fingerprintOf(all);
    const prev = this.fingerprints()[id];
    if (onlyIfChanged && prev && sameFingerprint(prev.fp, fp) && existsSync(prev.file)) {
      log.info('saves unchanged since the last backup; skipped', { emulatorId: id, kind });
      return null;
    }
    const now = new Date();
    let name = backupFileName(id, now, kind);
    for (let i = 1; existsSync(join(target.dir, name)); i++) name = backupFileName(id, new Date(now.getTime() + i), kind);
    const dest = join(target.dir, name);
    const { zip, manifest } = this.buildZip(id, kind, now, fp, perLoc);
    await writeZipAtomically(zip, dest);
    const s = await stat(dest);
    this.setFingerprint(id, { fp, file: dest });
    const label = `${a.manifest.name} saves (${all.length} files)`;
    this.ops.addChange('saves.backup', id, `${label} backed up${kind === 'manual' ? '' : ` (${KIND_TEXT[kind]})`}`);
    if (isAutomaticKind(kind)) await this.prune(target.dir, id).catch((e) => log.warn('save backup retention failed', { error: String(e) }));
    return { id: target.location === 'destination' ? `pc:${this.computer}/${name}` : name, emulatorId: id, label, path: dest, createdAt: manifest.createdAt, sizeBytes: s.size, kind, computer: this.computer, thisComputer: true, location: target.location };
  }

  private buildZip(id: string, kind: SaveBackupKind, now: Date, fp: SaveFingerprint, perLoc: { l: { label: string; path: string }; files: { path: string }[] }[]) {
    const zip = new yazl.ZipFile();
    const manifest = { app: 'OmniPC', emulatorId: id, createdAt: now.toISOString(), kind, reason: kind, computer: this.computer, fingerprint: fp, locations: perLoc.map(({ l }, i) => ({ index: i, label: l.label, path: l.path })) };
    zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), MANIFEST_NAME);
    for (const [i, { l, files }] of perLoc.entries()) {
      for (const f of files) zip.addFile(f.path, `${i}/${relative(l.path, f.path).replace(/\\/g, '/')}`);
    }
    return { zip, manifest };
  }

  /**
   * Writes one emulator's saves, in the save backup ZIP format, to `dest`
   * (used to send saves to another PC). It is not recorded as a backup of
   * this PC: no fingerprint, change entry or retention. Null when the
   * emulator has no save files. `fileName` is the backup name to use.
   */
  exportZip(emulatorId: string, dest: string): Promise<{ fileName: string; fileCount: number } | null> {
    return this.exclusive(async () => {
      const a = this.registry.get(emulatorId);
      if (!a || !a.manifest.implemented) return null;
      const perLoc = await Promise.all(a.saveLocations().filter((l) => existsSync(l.path)).map(async (l) => ({ l, files: await walk(l.path) })));
      const all = perLoc.flatMap((x) => x.files);
      if (!all.length) return null;
      const now = new Date();
      const { zip } = this.buildZip(emulatorId, 'manual', now, fingerprintOf(all), perLoc);
      await writeZipAtomically(zip, dest);
      return { fileName: backupFileName(emulatorId, now, 'manual'), fileCount: all.length };
    });
  }

  private fingerprints(): Record<string, FingerprintRecord> {
    return this.settingsRepo ? this.settingsRepo.getInternal<Record<string, FingerprintRecord>>(FINGERPRINTS_KEY, {}) : this.memFingerprints;
  }

  private setFingerprint(emulatorId: string, rec: FingerprintRecord): void {
    const all = { ...this.fingerprints(), [emulatorId]: rec };
    if (this.settingsRepo) this.settingsRepo.setInternal(FINGERPRINTS_KEY, all);
    else this.memFingerprints = all;
  }

  /**
   * Retention: removes this PC's automatic backups of `emulatorId` beyond the
   * newest N, only from one of OmniPC's own backup folders for this PC.
   */
  private async prune(dir: string, emulatorId: string): Promise<string[]> {
    const ours = [this.paths.saveBackups, ...(this.syncRoot() ? [join(this.syncRoot()!, this.computer)] : [])];
    if (!ours.includes(dir)) return [];
    const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => parseBackupFileName(f)?.emulatorId === emulatorId).map((fileName) => ({ fileName }));
    const removed: string[] = [];
    for (const { fileName } of selectForRetention(files, this.config().keepPerEmulator)) {
      await rm(join(dir, fileName), { force: true });
      removed.push(fileName);
    }
    if (removed.length) log.info('removed old automatic save backups', { emulatorId, removed });
    return removed;
  }

  // ------------------------------------------------------------------ list

  async list(): Promise<SaveBackup[]> {
    const out: SaveBackup[] = [];
    for (const root of this.roots()) {
      if (!existsSync(root.dir)) continue;
      if (root.location === 'local') {
        out.push(...(await this.listFolder(root)));
        continue;
      }
      for (const e of await readdir(root.dir, { withFileTypes: true }).catch(() => [])) {
        if (!e.isDirectory() || !isSafeFolderName(e.name)) continue;
        out.push(...(await this.listFolder({ ...root, dir: join(root.dir, e.name), computer: e.name, thisComputer: e.name.toLowerCase() === this.computer.toLowerCase(), idPrefix: `pc:${e.name}/` })));
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async listFolder(root: BackupRoot): Promise<SaveBackup[]> {
    const out: SaveBackup[] = [];
    for (const f of await readdir(root.dir).catch(() => [] as string[])) {
      if (!/^[\w.-]+\.zip$/.test(f)) continue;
      const s = await stat(join(root.dir, f)).catch(() => null);
      if (!s?.isFile()) continue;
      const parsed = parseBackupFileName(f);
      if (!parsed && root.location !== 'local') continue;
      const emu = parsed?.emulatorId ?? f.split('-')[0];
      out.push({ id: `${root.idPrefix}${f}`, emulatorId: emu, label: `${this.registry.get(emu)?.manifest.name ?? emu} saves`, path: join(root.dir, f), createdAt: parsed?.createdAt ?? s.mtime.toISOString(), sizeBytes: s.size, kind: parsed?.kind ?? 'manual', computer: root.computer, thisComputer: root.thisComputer, location: root.location });
    }
    return out;
  }

  /** Maps a backup id to its file, accepting only files directly inside the known backup folders. */
  resolveBackupId(backupId: string): string {
    const bad = () => new OmniFailure({ code: 'BAD_BACKUP', whatHappened: 'Invalid backup id.' });
    if (typeof backupId !== 'string') throw bad();
    let file: string;
    const local = /^([\w.-]+\.zip)$/.exec(backupId);
    const remote = /^pc:([^/\\]+)\/([\w.-]+\.zip)$/.exec(backupId);
    if (local) {
      file = resolveInside(this.paths.saveBackups, local[1]);
    } else if (remote) {
      const sync = this.syncRoot();
      if (!sync || !isSafeFolderName(remote[1])) throw bad();
      file = resolveInside(sync, `${remote[1]}/${remote[2]}`);
    } else {
      throw bad();
    }
    if (basename(file).startsWith('.')) throw bad();
    if (!existsSync(file)) throw new OmniFailure({ code: 'BAD_BACKUP', whatHappened: 'Backup not found.' });
    return file;
  }

  // --------------------------------------------------------------- restore

  /**
   * Restores a backup (this PC's or another PC's) into this PC's save folders
   * for that emulator, after backing up the current saves. Save locations are
   * matched by label (then position); paths stored in the backup are never
   * used as targets, so a backup from another PC cannot write elsewhere.
   */
  restore(backupId: string): Promise<{ restoredTo: string; safetyBackup: string }> {
    return this.exclusive(async () => {
      const file = this.resolveBackupId(backupId);
      const entries = await readZip(file);
      const manifestEntry = entries.get(MANIFEST_NAME);
      if (!manifestEntry) throw new OmniFailure({ code: 'BAD_BACKUP', whatHappened: 'This file is not an OmniPC save backup.' });
      let manifest: { emulatorId?: unknown; locations?: { index?: unknown; label?: unknown }[] };
      try {
        manifest = JSON.parse(manifestEntry.toString('utf8')) as typeof manifest;
      } catch {
        throw new OmniFailure({ code: 'BAD_BACKUP', whatHappened: 'The backup description inside this file is damaged.' });
      }
      const emuId = typeof manifest.emulatorId === 'string' ? manifest.emulatorId : '';
      const a = this.registry.get(emuId);
      if (!a || !a.manifest.implemented) throw new OmniFailure({ code: 'BAD_BACKUP', whatHappened: `This backup belongs to an emulator OmniPC does not know (${emuId || 'unknown'}).` });
      const parsed = parseBackupFileName(basename(file));
      if (parsed && parsed.emulatorId !== emuId) throw new OmniFailure({ code: 'BAD_BACKUP', whatHappened: 'The backup file name and its contents do not match.' });
      if (this.runningEmulator() === emuId) throw new OmniFailure({ code: 'EMULATOR_RUNNING', whatHappened: `${a.manifest.name} is running. Close it before restoring saves.` });
      const current = a.saveLocations();
      const stored = Array.isArray(manifest.locations) ? manifest.locations : [];
      const targetFor = (idx: string) => {
        const m = stored.find((l) => String(l.index) === idx);
        const byLabel = m && typeof m.label === 'string' ? current.find((l) => l.label === m.label) : undefined;
        return byLabel ?? (m && /^\d+$/.test(idx) ? current[Number(idx)] : undefined);
      };
      // Plan every write first: one bad entry rejects the whole restore before anything is written.
      const plan: { target: string; root: string; data: Buffer }[] = [];
      for (const [name, data] of entries) {
        if (name === MANIFEST_NAME) continue;
        const [idx, ...rest] = name.split('/');
        const loc = targetFor(idx);
        if (!loc || !rest.length || !rest.join('/')) continue;
        plan.push({ target: resolveInside(loc.path, rest.join('/')), root: loc.path, data });
      }
      if (!plan.length) throw new OmniFailure({ code: 'BAD_BACKUP', whatHappened: 'This backup contains no save files for the save folders on this PC.' });
      const safety = await this.backupUnlocked(emuId, 'pre-restore', { onlyIfChanged: false });
      for (const p of plan) {
        await mkdir(dirname(p.target), { recursive: true });
        await writeFile(p.target, p.data);
      }
      const from = parsed ? `${basename(file)}${backupId.startsWith('pc:') ? ` from ${backupId.slice(3).split('/')[0]}` : ''}` : basename(file);
      this.ops.addChange('saves.restore', emuId, `Saves restored from ${from}`);
      return { restoredTo: [...new Set(plan.map((p) => p.root))].join(', '), safetyBackup: safety[0]?.path ?? 'nothing to back up' };
    });
  }

  // ---------------------------------------------------------------- status

  /** Per emulator with save files: when it was last backed up on this PC and whether that backup is current. */
  async protectionStatus(): Promise<{ emulatorId: string; name: string; lastBackupAt: string | null; upToDate: boolean }[]> {
    const backups = (await this.list()).filter((b) => b.thisComputer);
    const fps = this.fingerprints();
    const out: { emulatorId: string; name: string; lastBackupAt: string | null; upToDate: boolean }[] = [];
    for (const a of this.registry.implemented()) {
      const files = (await Promise.all(a.saveLocations().filter((l) => existsSync(l.path)).map((l) => walk(l.path)))).flat();
      if (!files.length) continue;
      const rec = fps[a.manifest.id];
      out.push({
        emulatorId: a.manifest.id,
        name: a.manifest.name,
        lastBackupAt: backups.find((b) => b.emulatorId === a.manifest.id)?.createdAt ?? null,
        upToDate: !!rec && sameFingerprint(rec.fp, fingerprintOf(files)) && existsSync(rec.file),
      });
    }
    return out;
  }

  /** Folder to show in Explorer: the backup's own folder, or where new backups go. */
  async folderFor(backupId: string | null): Promise<string> {
    if (backupId) return dirname(this.resolveBackupId(backupId));
    const dir = this.activeFolder().dir;
    await mkdir(dir, { recursive: true });
    return dir;
  }
}

const KIND_TEXT: Record<SaveBackupKind, string> = {
  manual: 'manual',
  auto: 'scheduled',
  'pre-update': 'before emulator update',
  'pre-restore': 'before restore',
  'after-play': 'after playing',
};

function normaliseKind(kind: string): SaveBackupKind {
  return (SAVE_BACKUP_KINDS as readonly string[]).includes(kind) ? (kind as SaveBackupKind) : 'manual';
}

/** Writes to a hidden temp file next to the target, then renames, so sync clients never see half a ZIP. */
export async function writeZipAtomically(zip: yazl.ZipFile, dest: string): Promise<void> {
  const tmp = join(dirname(dest), `.${basename(dest)}.partial`);
  try {
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(tmp);
      out.on('close', () => resolve()).on('error', reject);
      zip.outputStream.on('error', reject).pipe(out);
      zip.end();
    });
    await rename(tmp, dest);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
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
