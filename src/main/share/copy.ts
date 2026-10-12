// "Copy from another PC": finds and pairs with sharing PCs, shows what they
// share (and what this PC already has), and copies a selection as one
// cancellable job.
//
// Safety rules:
//  - files are only written inside the chosen games folder, this PC's BIOS
//    folders, or (through SaveService) the emulator's own save folders;
//  - every path from the other PC is validated segment by segment and then
//    checked with resolveInside;
//  - every file is downloaded to "<name>.omnipc-partial", resumed with Range,
//    checked against size and SHA-256, and only then renamed into place;
//  - an existing different file is never overwritten: the copy is saved as
//    "name (from <PC>).ext" instead;
//  - nothing received is ever executed.

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { getSystem } from '@shared/systems';
import { isLocalAddress, type CopySelection, type DiscoveredPc, type ShareCatalog, type ShareFile, type ShareGameItem, type ShareInfo } from '@shared/share';
import type { CopyEntry, CopySummary, SetupImportResult, ShareCatalogView } from '@shared/shareCopy';
import type { AppNotification, SaveLocation } from '@shared/models';
import type { JobContext, JobManager } from '../core/jobs';
import { JobCancelled } from '../core/jobs';
import { OmniFailure, errorMessage } from '../core/errors';
import { logger } from '../core/logger';
import { resolveInside } from '../downloads/archive';
import { sha256File } from '../downloads/downloadManager';
import { resolveLocalHost, type ShareClient } from './client';
import { gameMatcher, type SetupImporter } from './setupImport';

const log = logger.scope('share-copy');

/** Discovery (implemented by the sharing side's discovery module). */
export interface Discoverer {
  discover(timeoutMs: number): Promise<DiscoveredPc[]>;
}

export interface ShareCopyDeps {
  client: ShareClient;
  discoverer: Discoverer;
  jobs: JobManager;
  paths: { systemBiosDir(systemId: string): string; downloads: string; thumbnails: string };
  library: {
    listPaths(): { path: string }[];
    allGames(): { id: number; system_id: string; title: string; serial: string | null; cover_thumb: string | null }[];
    setCoverThumb(id: number, thumb: string | null): void;
  };
  /** Adds a folder to the library (with drive info). */
  addLibraryPath(path: string): Promise<void>;
  /** Runs a library scan and resolves when it is done. */
  scanLibrary(): Promise<unknown>;
  saves: {
    restoreFromFile(file: string, opts: { fromText: string; expectedEmulatorId?: string }): Promise<{ restoredTo: string; safetyBackup: string }>;
    locations(emulatorId?: string): Promise<SaveLocation[]>;
  };
  setup: SetupImporter;
  ops: { addChange(kind: string, subject: string | null, summary: string, data?: unknown): unknown };
  notifications: { add(level: AppNotification['level'], title: string, body: string, opts?: { link?: string }): unknown };
  documentsDir: string;
  /** Called after copying changed the library or setup (e.g. to emit bus events). */
  onChanged?: (what: 'library' | 'setup') => void;
}

// ----------------------------------------------------------- path safety

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** True when one path segment is a safe Windows file or folder name. */
export function safeSegment(seg: string): boolean {
  if (!seg || seg === '.' || seg === '..' || seg.length > 255) return false;
  if (/[<>:"|?*\\/\u0000-\u001f]/.test(seg)) return false;
  if (/[. ]$/.test(seg)) return false;
  if (RESERVED.test(seg)) return false;
  return true;
}

/**
 * Validates a relative '/'-separated path from the other PC and returns its
 * segments. Rejects '..', absolute paths, drive letters, backslashes and names
 * Windows cannot store.
 */
export function safeRelativePath(p: unknown): string[] {
  const bad = () => new OmniFailure({ code: 'SHARE_UNSAFE_PATH', whatHappened: 'The other PC offered a file with an unsafe name, so it was not copied.', detected: [String(p).slice(0, 300)] });
  if (typeof p !== 'string' || !p || p.length > 1024) throw bad();
  if (p.startsWith('/') || p.includes('\\') || /^[a-z]:/i.test(p) || isAbsolute(p)) throw bad();
  const segs = p.split('/');
  if (!segs.every(safeSegment)) throw bad();
  return segs;
}

/** Resolves an item file under `root`, enforcing every rule above. */
export function targetInside(root: string, ...relParts: string[]): string {
  const segs = relParts.flatMap((r) => safeRelativePath(r));
  return resolveInside(root, segs.join('/'));
}

/** File-name-safe version of a PC name for "(from <PC>)" suffixes. */
function pcLabel(name: string): string {
  const s = String(name ?? '').replace(/[<>:"/\\|?*\u0000-\u001f()]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40).replace(/[. ]+$/, '');
  return s || 'other PC';
}

/** "name (from PC).ext", "name (from PC 2).ext", … */
export function fromName(file: string, pc: string, n: number): string {
  const ext = extname(file);
  const stem = basename(file, ext);
  return join(dirname(file), `${stem} (from ${pcLabel(pc)}${n > 1 ? ` ${n}` : ''})${ext}`);
}

// --------------------------------------------------------------- progress

function fmtBytes(n: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function fmtEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return 'less than a minute left';
  const m = Math.round(seconds / 60);
  if (m < 60) return `about ${m} min left`;
  return `about ${Math.floor(m / 60)} h ${m % 60} min left`;
}

class Progress {
  doneBytes = 0;
  doneItems = 0;
  private samples: { t: number; b: number }[] = [];
  constructor(private readonly ctx: JobContext, readonly totalBytes: number, readonly totalItems: number) {}

  add(bytes: number): void {
    this.doneBytes += bytes;
    this.report();
  }

  /** Bytes that will not be transferred after all (skipped files count as done). */
  itemDone(): void {
    this.doneItems++;
    this.report(true);
  }

  speed(): number {
    const now = Date.now();
    this.samples.push({ t: now, b: this.doneBytes });
    while (this.samples.length > 2 && now - this.samples[0].t > 8000) this.samples.shift();
    const first = this.samples[0];
    const dt = (now - first.t) / 1000;
    return dt > 0.5 ? (this.doneBytes - first.b) / dt : 0;
  }

  private last = 0;
  report(force = false): void {
    const now = Date.now();
    if (!force && now - this.last < 250) return;
    this.last = now;
    const total = Math.max(this.totalBytes, 1);
    const frac = this.totalBytes > 0 ? Math.min(1, this.doneBytes / total) : this.totalItems ? this.doneItems / this.totalItems : null;
    const sp = this.speed();
    const parts = [
      `${Math.min(this.doneItems, this.totalItems)} of ${this.totalItems} items`,
      this.totalBytes > 0 ? `${fmtBytes(Math.min(this.doneBytes, this.totalBytes))} of ${fmtBytes(this.totalBytes)}` : '',
      sp > 0 ? `${fmtBytes(sp)}/s` : '',
      sp > 0 ? fmtEta((this.totalBytes - this.doneBytes) / sp) : '',
    ].filter(Boolean);
    this.ctx.progress(frac, parts.join(' · '));
  }
}

// ----------------------------------------------------------------- service

type FileOutcome = { status: 'copied' | 'skipped' | 'renamed'; path: string; bytes: number };

export class ShareCopyService {
  constructor(private readonly d: ShareCopyDeps) {}

  get client(): ShareClient {
    return this.d.client;
  }

  /** Paired PCs (from memory, not the network). */
  knownPcs(): DiscoveredPc[] {
    return this.d.client.paired().map((s) => ({ deviceId: s.deviceId, name: s.name, address: s.address, port: s.port, version: s.version, paired: true }));
  }

  /** Broadcasts on the local network; also refreshes the address of paired PCs that moved. */
  async discover(timeoutMs = 2000): Promise<DiscoveredPc[]> {
    const found = await this.d.discoverer.discover(timeoutMs).catch((e) => {
      log.warn('discovery failed', { error: errorMessage(e) });
      return [] as DiscoveredPc[];
    });
    const paired = new Set(this.d.client.paired().map((p) => p.deviceId));
    const out = new Map<string, DiscoveredPc>();
    for (const a of found) {
      if (!a || typeof a.deviceId !== 'string' || typeof a.address !== 'string' || !isLocalAddress(a.address)) continue;
      if (paired.has(a.deviceId)) this.d.client.updateAddress(a.deviceId, a.address.replace(/^::ffff:/i, ''), a.port, a.name);
      out.set(a.deviceId, { deviceId: a.deviceId, name: String(a.name ?? 'PC').slice(0, 100), address: a.address.replace(/^::ffff:/i, ''), port: a.port, version: String(a.version ?? ''), paired: paired.has(a.deviceId) });
    }
    // Paired PCs that did not answer are still listed (they may answer when connected directly).
    for (const k of this.knownPcs()) if (!out.has(k.deviceId)) out.set(k.deviceId, k);
    return [...out.values()];
  }

  async connect(address: string, port: number): Promise<ShareInfo> {
    const ip = await resolveLocalHost(address);
    const info = await this.d.client.info(ip, port);
    this.d.client.updateAddress(info.deviceId, ip, port, info.name);
    return info;
  }

  async pairStart(address: string, port: number): Promise<{ requestId: string; server: ShareInfo }> {
    return this.d.client.pairStart(await resolveLocalHost(address), port);
  }

  async pairFinish(requestId: string, code: string): Promise<ShareInfo> {
    const info = await this.d.client.pairFinish(requestId, code);
    this.d.ops.addChange('share.paired', null, `Paired with ${info.name} to copy from it`);
    return info;
  }

  forget(deviceId: string): void {
    const s = this.d.client.paired().find((p) => p.deviceId === deviceId);
    this.d.client.forget(deviceId);
    if (s) this.d.ops.addChange('share.forget', null, `Forgot ${s.name}`);
  }

  /** Default games folder: the first library folder, else Documents\OmniPC Games. */
  suggestDestination(): string {
    return this.d.library.listPaths()[0]?.path ?? join(this.d.documentsDir, 'OmniPC Games');
  }

  // ------------------------------------------------------------ have flags

  async catalogView(deviceId: string): Promise<ShareCatalogView> {
    const catalog = await this.d.client.catalog(deviceId);
    return { catalog, have: await this.haveFlags(catalog) };
  }

  async haveFlags(catalog: ShareCatalog): Promise<ShareCatalogView['have']> {
    const match = gameMatcher(this.d.library.allGames());
    const games: Record<string, boolean> = {};
    for (const g of catalog.games) games[g.id] = match(g.systemId, g.serial, g.title) !== null;
    const bios: Record<string, boolean> = {};
    for (const b of catalog.bios) {
      let all = b.files.length > 0 && !!getSystem(b.systemId);
      for (const f of b.files) {
        if (!all) break;
        try {
          const s = await stat(targetInside(this.d.paths.systemBiosDir(b.systemId), f.path)).catch(() => null);
          all = !!s?.isFile() && s.size === f.size;
        } catch {
          all = false;
        }
      }
      bios[b.id] = all;
    }
    const saves: Record<string, number | null> = {};
    const locs = await this.d.saves.locations().catch(() => [] as SaveLocation[]);
    for (const s of catalog.saves) {
      const mine = locs.filter((l) => l.emulatorId === s.emulatorId);
      const size = mine.reduce((n, l) => n + l.sizeBytes, 0);
      saves[s.id] = mine.some((l) => l.fileCount > 0) ? size : null;
    }
    return { games, bios, saves };
  }

  // ------------------------------------------------------------------ copy

  copy(deviceId: string, selection: CopySelection): { jobId: string; done: Promise<CopySummary> } {
    const server = this.d.client.server(deviceId);
    const sel = normaliseSelection(selection);
    const count = sel.gameIds.length + sel.biosIds.length + sel.savesIds.length + (sel.setup ? 1 : 0);
    if (!count) throw new OmniFailure({ code: 'SHARE_NOTHING_SELECTED', whatHappened: 'Choose something to copy first.' });
    const j = this.d.jobs.start('share.copy', `Copying from ${server.name}`, (ctx) => this.run(deviceId, sel, ctx), { lockKey: 'share.copy' });
    return { jobId: j.id, done: j.done };
  }

  async run(deviceId: string, sel: CopySelection, ctx: JobContext): Promise<CopySummary> {
    const server = this.d.client.server(deviceId);
    const pc = server.name;
    const summary: CopySummary = { from: pc, copied: [], skipped: [], renamed: [], failed: [], bytesCopied: 0, libraryPathAdded: null, setup: null };
    ctx.step(`Connecting to ${pc}`);
    const catalog = await this.d.client.catalog(deviceId, ctx.signal);
    const games = sel.gameIds.map((id) => catalog.games.find((g) => g.id === id)).filter((g): g is ShareGameItem => !!g);
    const bios = sel.biosIds.map((id) => catalog.bios.find((b) => b.id === id)).filter((b): b is NonNullable<typeof b> => !!b);
    const saves = sel.savesIds.map((id) => catalog.saves.find((s) => s.id === id)).filter((s): s is NonNullable<typeof s> => !!s);
    const missing = sel.gameIds.length + sel.biosIds.length + sel.savesIds.length - games.length - bios.length - saves.length;
    if (missing > 0) summary.failed.push({ item: `${missing} item(s)`, reason: `No longer shared by ${pc}` });
    const totalBytes = sum(games.map((g) => sum(g.files.map((f) => f.size)))) + sum(bios.map((b) => sum(b.files.map((f) => f.size)))) + sum(saves.map((s) => s.sizeBytes));
    const progress = new Progress(ctx, totalBytes, games.length + bios.length + saves.length + (sel.setup ? 1 : 0));
    ctx.stepDone(`${progress.totalItems} item(s) · ${fmtBytes(totalBytes)}`);
    const cancelled = () => ctx.signal.aborted;

    try {
      // Setup first, so emulators queued for install download while files copy.
      if (sel.setup) {
        ctx.step('Copying setup');
        try {
          const exp = await this.d.client.setup(deviceId, ctx.signal);
          summary.setup = await this.d.setup.apply(exp, pc);
          summary.copied.push({ item: 'Setup', reason: describeSetup(summary.setup) });
          ctx.stepDone(describeSetup(summary.setup));
          this.d.onChanged?.('setup');
        } catch (err) {
          if (cancelled()) throw new JobCancelled();
          summary.failed.push({ item: 'Setup', reason: errorMessage(err) });
          ctx.stepFailed(errorMessage(err));
        }
        progress.itemDone();
      }

      for (const b of bios) {
        ctx.throwIfCancelled();
        ctx.step(`Copying ${b.label}`);
        const sys = getSystem(b.systemId);
        if (!sys) {
          summary.failed.push({ item: b.label, reason: `Unknown system "${b.systemId}"` });
          progress.add(b.sizeBytes);
          progress.itemDone();
          ctx.stepFailed('Unknown system');
          continue;
        }
        const root = this.d.paths.systemBiosDir(sys.id);
        await this.copyFiles(deviceId, b.id, b.label, root, '', b.files, pc, summary, progress, ctx);
        progress.itemDone();
      }

      for (const s of saves) {
        ctx.throwIfCancelled();
        ctx.step(`Copying ${s.emulatorName} saves`);
        const tmp = join(this.d.paths.downloads, `share-saves-${randomUUID()}.zip`);
        let got = 0;
        try {
          await mkdir(this.d.paths.downloads, { recursive: true });
          await this.d.client.downloadSaves(deviceId, s.emulatorId, tmp, { signal: ctx.signal, onBytes: (n) => { got += n; if (got <= s.sizeBytes) progress.add(n); } });
          const r = await this.d.saves.restoreFromFile(tmp, { fromText: `${pc} (copied over the network)`, expectedEmulatorId: s.emulatorId });
          summary.copied.push({ item: `${s.emulatorName} saves`, reason: `Restored to ${r.restoredTo}. Your previous saves were backed up first (${r.safetyBackup}).` });
          ctx.stepDone('Your previous saves were backed up first');
        } catch (err) {
          if (cancelled()) throw new JobCancelled();
          summary.failed.push({ item: `${s.emulatorName} saves`, reason: errorMessage(err) });
          ctx.stepFailed(errorMessage(err));
        } finally {
          await rm(tmp, { force: true }).catch(() => undefined);
          if (got < s.sizeBytes) progress.add(s.sizeBytes - got);
        }
        progress.itemDone();
      }

      if (games.length) {
        const dest = resolve(sel.gamesDestination ?? this.suggestDestination());
        if (!isAbsolute(sel.gamesDestination ?? dest)) throw new OmniFailure({ code: 'SHARE_BAD_DESTINATION', whatHappened: 'Choose a folder for the games.' });
        await mkdir(dest, { recursive: true });
        const copiedGames: ShareGameItem[] = [];
        for (const g of games) {
          ctx.throwIfCancelled();
          ctx.step(`Copying ${g.title}`, getSystem(g.systemId)?.shortName ?? g.systemId);
          let folderOk = true;
          try {
            safeRelativePath(g.folder);
          } catch (err) {
            folderOk = false;
            summary.failed.push({ item: g.title, reason: errorMessage(err) });
            progress.add(sum(g.files.map((f) => f.size)));
            ctx.stepFailed('Unsafe folder name');
          }
          if (folderOk) {
            const before = summary.failed.length;
            await this.copyFiles(deviceId, g.id, g.title, dest, g.folder, g.files, pc, summary, progress, ctx);
            if (summary.failed.length === before) copiedGames.push(g);
          }
          progress.itemDone();
        }
        ctx.step('Adding the games to your library');
        const known = this.d.library.listPaths().some((p) => samePath(p.path, dest) || isInsidePath(dest, p.path));
        if (!known) {
          await this.d.addLibraryPath(dest);
          summary.libraryPathAdded = dest;
        }
        try {
          await this.d.scanLibrary();
          this.applyCovers(copiedGames);
        } catch (err) {
          ctx.stepFailed(`Library scan: ${errorMessage(err)}`);
        }
        this.d.onChanged?.('library');
      }
    } catch (err) {
      if (err instanceof JobCancelled || cancelled()) {
        this.d.ops.addChange('share.copy', null, `Copy from ${pc} cancelled (${summary.copied.length} copied so far; partial files are kept and resume next time)`);
        throw new JobCancelled();
      }
      throw err;
    }

    const line = `${summary.copied.length} copied · ${summary.skipped.length} already here · ${summary.renamed.length} kept both · ${summary.failed.length} failed`;
    ctx.step('Done', line);
    this.d.ops.addChange('share.copy', null, `Copied from ${pc}: ${line} (${fmtBytes(summary.bytesCopied)})`, { renamed: summary.renamed, failed: summary.failed });
    this.d.notifications.add(summary.failed.length ? 'warning' : 'success', summary.failed.length ? `Copy from ${pc} finished with problems` : `Copied from ${pc}`, line, { link: '/share' });
    return summary;
  }

  /** Copies an item's files into `root/<folder>/<file.path>`, recording each outcome. */
  private async copyFiles(deviceId: string, itemId: string, label: string, root: string, folder: string, files: ShareFile[], pc: string, summary: CopySummary, progress: Progress, ctx: JobContext): Promise<void> {
    const counts = { copied: 0, skipped: 0, renamed: 0, failed: 0 };
    for (const f of files) {
      ctx.throwIfCancelled();
      const entry: CopyEntry = { item: label, file: f.path };
      let target: string;
      try {
        target = folder ? targetInside(root, folder, f.path) : targetInside(root, f.path);
      } catch (err) {
        summary.failed.push({ ...entry, reason: errorMessage(err) });
        progress.add(f.size);
        counts.failed++;
        continue;
      }
      const startBytes = progress.doneBytes;
      try {
        const r = await this.copyOne(deviceId, itemId, f, target, pc, progress, ctx);
        summary.bytesCopied += r.status === 'skipped' ? 0 : r.bytes;
        if (r.status === 'skipped') summary.skipped.push({ ...entry, reason: 'Already on this PC' });
        else if (r.status === 'renamed') summary.renamed.push({ ...entry, savedAs: r.path, reason: 'A different file with this name was already here. Yours was kept and the copy was saved next to it.' });
        else summary.copied.push(entry);
        counts[r.status]++;
      } catch (err) {
        if (err instanceof JobCancelled || ctx.signal.aborted) throw new JobCancelled();
        summary.failed.push({ ...entry, reason: errorMessage(err) });
        counts.failed++;
        // Keep overall progress honest: count the file's bytes as handled.
        const handled = progress.doneBytes - startBytes;
        if (handled < f.size) progress.add(f.size - handled);
      }
    }
    const detail = [counts.copied && `${counts.copied} copied`, counts.skipped && `${counts.skipped} already here`, counts.renamed && `${counts.renamed} kept both`, counts.failed && `${counts.failed} failed`].filter(Boolean).join(', ');
    if (counts.failed) ctx.stepFailed(detail);
    else ctx.stepDone(detail);
  }

  /** Downloads one file with resume and verification. Never overwrites a different existing file. */
  private async copyOne(deviceId: string, itemId: string, f: ShareFile, target: string, pc: string, progress: Progress, ctx: JobContext): Promise<FileOutcome> {
    const remote = await this.d.client.hash(deviceId, itemId, f.path, ctx.signal);
    const accounted = { bytes: 0 };
    const add = (n: number) => {
      const room = Math.max(0, f.size - accounted.bytes);
      accounted.bytes += n;
      progress.add(Math.min(n, room));
    };
    const sameAs = async (p: string): Promise<'same' | 'different' | 'none'> => {
      const s = await stat(p).catch(() => null);
      if (!s) return 'none';
      if (!s.isFile() || s.size !== remote.size) return 'different';
      return (await sha256File(p)) === remote.sha256 ? 'same' : 'different';
    };
    let finalPath = target;
    let renamed = false;
    const existing = await sameAs(target);
    if (existing === 'same') {
      add(f.size);
      return { status: 'skipped', path: target, bytes: remote.size };
    }
    if (existing === 'different') {
      renamed = true;
      for (let n = 1; ; n++) {
        if (n > 50) throw new OmniFailure({ code: 'SHARE_NAME_CONFLICT', whatHappened: 'Too many copies with this name already exist.' });
        const candidate = fromName(target, pc, n);
        const st = await sameAs(candidate);
        if (st === 'same') {
          add(f.size);
          return { status: 'skipped', path: candidate, bytes: remote.size };
        }
        if (st === 'none') {
          finalPath = candidate;
          break;
        }
      }
    }
    const part = `${finalPath}.omnipc-partial`;
    await mkdir(dirname(finalPath), { recursive: true });
    let offset = 0;
    const ps = await stat(part).catch(() => null);
    if (ps?.isFile()) {
      if (ps.size <= remote.size) offset = ps.size;
      else await rm(part, { force: true });
    } else if (ps) {
      throw new OmniFailure({ code: 'SHARE_PARTIAL_BLOCKED', whatHappened: `Something that is not a file is in the way: ${part}` });
    }
    if (offset > 0) add(offset);
    if (offset < remote.size || remote.size === 0) {
      await this.d.client.downloadFile(deviceId, itemId, f.path, part, offset, {
        signal: ctx.signal,
        onBytes: add,
        onRestart: () => { /* server ignored Range: the partial file is rewritten from the start */ },
      });
    }
    if (!existsSync(part)) await writeFile(part, Buffer.alloc(0));
    const got = (await stat(part)).size;
    if (got !== remote.size) {
      await rm(part, { force: true });
      throw new OmniFailure({ code: 'SHARE_SIZE_MISMATCH', whatHappened: 'The copied file has the wrong size and was discarded.', detected: [`Expected ${remote.size} bytes, got ${got}`], userAction: ['Copy again.'] });
    }
    const sha = await sha256File(part);
    if (sha !== remote.sha256) {
      await rm(part, { force: true });
      throw new OmniFailure({ code: 'SHARE_HASH_MISMATCH', whatHappened: 'The copied file did not match the original (checksum mismatch) and was discarded.', detected: [`Expected ${remote.sha256}`, `Got ${sha}`], userAction: ['Copy again. If it keeps failing, the file may be changing on the other PC.'] });
    }
    // A file may have appeared meanwhile: never overwrite it.
    if (existsSync(finalPath)) {
      for (let n = renamed ? 2 : 1; ; n++) {
        const candidate = fromName(target, pc, n);
        if (!existsSync(candidate)) { finalPath = candidate; renamed = true; break; }
        if (n > 50) throw new OmniFailure({ code: 'SHARE_NAME_CONFLICT', whatHappened: 'Too many copies with this name already exist.' });
      }
    }
    await rename(part, finalPath);
    return { status: renamed ? 'renamed' : 'copied', path: finalPath, bytes: remote.size };
  }

  /** Uses the other PC's cover thumbnail for copied games that have none yet. */
  private applyCovers(games: ShareGameItem[]): void {
    const withThumb = games.filter((g) => typeof g.coverThumb === 'string' && g.coverThumb.length < 1_000_000);
    if (!withThumb.length) return;
    const all = this.d.library.allGames();
    const match = gameMatcher(all);
    for (const g of withThumb) {
      const id = match(g.systemId, g.serial, g.title);
      const row = id !== null ? all.find((x) => x.id === id) : undefined;
      if (!row || row.cover_thumb) continue;
      const buf = Buffer.from(g.coverThumb!.replace(/^data:image\/jpeg;base64,/, ''), 'base64');
      if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) continue; // JPEG only
      const file = join(this.d.paths.thumbnails, `shared-${row.id}.jpg`);
      void mkdir(this.d.paths.thumbnails, { recursive: true })
        .then(() => writeFile(file, buf))
        .then(() => this.d.library.setCoverThumb(row.id, file))
        .catch(() => undefined);
    }
  }
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + (Number.isFinite(b) && b > 0 ? b : 0), 0);
}

function samePath(a: string, b: string): boolean {
  return resolve(a).replace(/[\\/]+$/, '').toLowerCase() === resolve(b).replace(/[\\/]+$/, '').toLowerCase();
}

/** True when `child` is inside `parent` (a library folder already covers it). */
function isInsidePath(child: string, parent: string): boolean {
  const c = resolve(child).toLowerCase();
  const p = resolve(parent).toLowerCase().replace(/[\\/]+$/, '');
  return c.startsWith(p + sep);
}

function normaliseSelection(s: CopySelection): CopySelection {
  const ids = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string'))] : []);
  return { gameIds: ids(s?.gameIds), biosIds: ids(s?.biosIds), savesIds: ids(s?.savesIds), setup: s?.setup === true, gamesDestination: typeof s?.gamesDestination === 'string' && s.gamesDestination ? s.gamesDestination : null };
}

function describeSetup(r: SetupImportResult): string {
  return [
    r.settingsApplied.length ? `${r.settingsApplied.length} setting(s)` : '',
    r.emulatorSettingsApplied.length ? `${r.emulatorSettingsApplied.length} emulator(s) configured` : '',
    r.installsQueued.length ? `${r.installsQueued.length} emulator install(s) started` : '',
    r.controllerProfileApplied ? 'controller profile' : '',
    `${r.profilesMatched} game profile(s) matched${r.profilesUnmatched ? `, ${r.profilesUnmatched} not found here` : ''}`,
  ].filter(Boolean).join(' · ');
}
