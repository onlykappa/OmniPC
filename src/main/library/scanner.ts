// Incremental library scanner.
// - only new/modified files are re-identified (size + mtime comparison)
// - removed files are dropped only when their library folder was fully walked
// - if a library folder's drive is missing, games are marked "drive unavailable"
//   (never deleted) and restored automatically when the drive returns, even if
//   Windows assigned a different drive letter (matched by volume serial)

import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ImportPreview, ScanSummary } from '@shared/models';
import { SYSTEMS, type SystemId } from '@shared/systems';
import type { LibraryRepo } from '../database/libraryRepo';
import type { JobContext } from '../core/jobs';
import { logger } from '../core/logger';
import { identifyFile, parseCueFiles, parseM3u } from './identify';
import { fileStat, INCOMPLETE_EXTENSIONS, validateGameFile } from './validate';
import { driveOf, invalidateDriveCache, listDrives, swapDrive } from '../platform/drives';

const log = logger.scope('scanner');

const ALL_EXTENSIONS = new Set(SYSTEMS.flatMap((s) => s.extensions));
const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'node_modules', '.git', 'windows', 'program files', 'program files (x86)']);
const MAX_DEPTH = 10;

export interface CandidateFile {
  path: string;
  folderChain: string[];
}

/** Recursively collects candidate game files, excluding component files (CUE tracks, M3U members). */
export async function collectCandidates(root: string, opts: { excludeDirs?: string[]; signal?: AbortSignal; limit?: number } = {}): Promise<{ files: CandidateFile[]; complete: boolean; errors: string[] }> {
  const files: CandidateFile[] = [];
  const errors: string[] = [];
  const exclude = (opts.excludeDirs ?? []).map((d) => resolve(d).toLowerCase());
  const components = new Set<string>();
  let complete = true;
  let visited = 0;

  async function walk(dir: string, depth: number, chain: string[]): Promise<void> {
    if (opts.signal?.aborted || (opts.limit && files.length >= opts.limit)) {
      complete = false;
      return;
    }
    if (depth > MAX_DEPTH) return;
    if (exclude.some((e) => resolve(dir).toLowerCase() === e || resolve(dir).toLowerCase().startsWith(e + sep))) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      errors.push(`${dir}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
      if (depth === 0) complete = false;
      return;
    }
    // Component files referenced by cue sheets / playlists in this folder.
    for (const e of entries) {
      if (!e.isFile()) continue;
      const ext = extname(e.name).toLowerCase();
      const full = join(dir, e.name);
      if (ext === '.cue') for (const f of await parseCueFiles(full)) components.add(resolve(dir, f).toLowerCase());
      if (ext === '.m3u') for (const f of await parseM3u(full)) {
        const target = resolve(dir, f).toLowerCase();
        components.add(target);
        if (target.endsWith('.cue')) for (const t of await parseCueFiles(resolve(dir, f))) components.add(resolve(dirname(resolve(dir, f)), t).toLowerCase());
      }
    }
    // Folder-format games (PS4/PS5 dumps, PS3 disc/PSN folders): add only the
    // boot executable and do not walk their data files.
    const eboot = entries.find((e) => e.isFile() && e.name.toLowerCase() === 'eboot.bin');
    const hasDir = (n: string) => entries.some((e) => e.isDirectory() && e.name.toLowerCase() === n);
    if (eboot && hasDir('sce_sys')) {
      files.push({ path: join(dir, eboot.name), folderChain: chain });
      return;
    }
    // Extracted Xbox 360 games: the folder boots default.xex.
    const xex = entries.find((e) => e.isFile() && e.name.toLowerCase() === 'default.xex');
    if (xex && depth > 0) {
      files.push({ path: join(dir, xex.name), folderChain: chain });
      return;
    }
    const ps3Game = entries.find((e) => e.isDirectory() && e.name.toUpperCase() === 'PS3_GAME');
    const ps3Usr = ps3Game ? join(dir, ps3Game.name, 'USRDIR') : hasDir('usrdir') && entries.some((e) => e.isFile() && e.name.toUpperCase() === 'PARAM.SFO') ? join(dir, entries.find((e) => e.name.toLowerCase() === 'usrdir')!.name) : null;
    if (ps3Usr) {
      const bootName = (await readdir(ps3Usr).catch(() => [] as string[])).find((n) => n.toUpperCase() === 'EBOOT.BIN');
      if (bootName) {
        files.push({ path: join(ps3Usr, bootName), folderChain: chain });
        return;
      }
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name.toLowerCase())) continue;
        await walk(full, depth + 1, [e.name, ...chain]);
      } else if (e.isFile()) {
        const ext = extname(e.name).toLowerCase();
        if (!ALL_EXTENSIONS.has(ext) && !INCOMPLETE_EXTENSIONS.includes(ext)) continue;
        files.push({ path: full, folderChain: chain });
      }
      if (++visited % 500 === 0) await new Promise((r) => setImmediate(r));
    }
  }

  await walk(root, 0, [basename(root)]);
  return { files: files.filter((f) => !components.has(resolve(f.path).toLowerCase())), complete, errors };
}

export function groupKeyFor(root: string, path: string, baseTitle: string, region: string | null, discNumber: number | null): string {
  const relDir = relative(root, dirname(path)).toLowerCase().replace(/\\/g, '/');
  if (discNumber !== null) return `multi:${relDir}|${baseTitle}|${region ?? ''}`;
  return `file:${relative(root, path).toLowerCase().replace(/\\/g, '/')}`;
}

function chooseTitle(fileTitle: string, internal: string | null, serial: string | null): string {
  const looksLikeId = /^[A-Z0-9]{6}$/.test(fileTitle) || (serial !== null && fileTitle.replace(/[^A-Z0-9]/gi, '').toUpperCase() === serial.replace(/[^A-Z0-9]/gi, '').toUpperCase()) || /^(game|disc|image|default|track ?\d*)$/i.test(fileTitle) || (!/\s/.test(fileTitle) && /[_.]/.test(fileTitle));
  if (looksLikeId && internal) return internal;
  return fileTitle;
}

export class LibraryScanner {
  constructor(private readonly repo: LibraryRepo, private readonly excludeDirs: () => string[]) {}

  async preview(path: string, signal?: AbortSignal): Promise<ImportPreview> {
    const { files } = await collectCandidates(path, { excludeDirs: this.excludeDirs(), signal, limit: 20000 });
    const bySystem: Record<string, number> = {};
    let unrecognized = 0;
    const sample: ImportPreview['sample'] = [];
    for (const f of files) {
      const id = await identifyFile(f.path, f.folderChain);
      if (!id.systemId) {
        unrecognized++;
        continue;
      }
      bySystem[id.systemId] = (bySystem[id.systemId] ?? 0) + 1;
      if (sample.length < 30) sample.push({ path: f.path, systemId: id.systemId, title: id.title });
    }
    return { path, total: files.length - unrecognized, bySystem, unrecognized, sample };
  }

  /** Re-checks library folders whose drive may have come or gone. */
  async refreshAvailability(): Promise<{ available: string[]; unavailable: string[]; remapped: string[] }> {
    invalidateDriveCache();
    const drives = await listDrives(0);
    const available: string[] = [];
    const unavailable: string[] = [];
    const remapped: string[] = [];
    for (const p of this.repo.listPaths()) {
      if (existsSync(p.path)) {
        if (!p.available) {
          this.repo.updatePath(p.id, { available: true });
          this.repo.setAvailabilityForPath(p.id, 'available');
          available.push(p.path);
        }
        continue;
      }
      // Drive letter changed? Find the volume by serial.
      if (p.volumeSerial) {
        const vol = drives.find((d) => d.volumeSerial === p.volumeSerial && d.letter !== driveOf(p.path));
        if (vol) {
          const newPath = swapDrive(p.path, vol.letter);
          if (existsSync(newPath)) {
            const oldPrefix = driveOf(p.path);
            this.repo.remapPathPrefix(p.id, oldPrefix, vol.letter);
            this.repo.updatePath(p.id, { path: newPath, driveLetter: vol.letter, available: true });
            this.repo.setAvailabilityForPath(p.id, 'available');
            remapped.push(`${p.path} → ${newPath}`);
            log.info('library path remapped after drive letter change', { from: p.path, to: newPath });
            continue;
          }
        }
      }
      if (p.available) {
        this.repo.updatePath(p.id, { available: false });
        this.repo.setAvailabilityForPath(p.id, 'drive_unavailable');
        unavailable.push(p.path);
      }
    }
    return { available, unavailable, remapped };
  }

  async scan(opts: { full: boolean; pathIds?: number[]; /** Re-read unchanged files of these systems (after identification improves). */ reidentify?: SystemId[]; /** Re-read unchanged .zip/.7z files. */ reidentifyArchives?: boolean }, ctx?: JobContext): Promise<ScanSummary> {
    const started = Date.now();
    const scanId = randomUUID();
    const summary: ScanSummary = { rootPaths: [], filesSeen: 0, added: 0, updated: 0, removed: 0, unchanged: 0, markedUnavailable: 0, bySystem: {}, unrecognized: 0, duplicates: [], durationMs: 0 };
    ctx?.step('Checking library drives');
    const avail = await this.refreshAvailability();
    summary.markedUnavailable = avail.unavailable.length;
    const paths = this.repo.listPaths().filter((p) => !opts.pathIds || opts.pathIds.includes(p.id));

    for (const lp of paths) {
      ctx?.throwIfCancelled();
      summary.rootPaths.push(lp.path);
      if (!existsSync(lp.path)) {
        ctx?.stepSkipped(`Scan ${lp.path}`, 'Folder or drive unavailable; games kept and marked unavailable');
        continue;
      }
      ctx?.step(`Scanning ${lp.path}`);
      const { files, complete, errors } = await collectCandidates(lp.path, { excludeDirs: this.excludeDirs(), signal: ctx?.signal });
      if (errors.length) log.warn('scan errors', { path: lp.path, errors: errors.slice(0, 20) });
      const touch: number[] = [];
      let i = 0;
      for (const f of files) {
        ctx?.throwIfCancelled();
        i++;
        if (i % 25 === 0) ctx?.progress(i / Math.max(files.length, 1), `${lp.path}: ${i}/${files.length}`);
        summary.filesSeen++;
        const st = await fileStat(f.path);
        if (!st) continue;
        const existing = this.repo.fileByPath(f.path);
        const prev = existing ? this.repo.getGame(existing.game_id) : undefined;
        if (existing && !opts.full && existing.size_bytes === st.size && existing.mtime_ms === st.mtimeMs && !(prev && opts.reidentify?.includes(prev.system_id)) && !(opts.reidentifyArchives && /\.(zip|7z)$/i.test(f.path))) {
          touch.push(existing.id);
          summary.unchanged++;
          const g = prev;
          if (g) summary.bySystem[g.system_id] = (summary.bySystem[g.system_id] ?? 0) + 1;
          continue;
        }
        const id = await identifyFile(f.path, f.folderChain);
        if (!id.systemId) {
          summary.unrecognized++;
          continue;
        }
        const validation = await validateGameFile(f.path, id.systemId, st.size);
        const title = chooseTitle(id.title, id.internalTitle, id.serial);
        const res = this.repo.upsertGameFile({
          systemId: id.systemId as SystemId,
          title,
          region: id.region,
          serial: id.serial,
          // Switch updates and DLC join their game by title ID.
          groupKey: id.systemId === 'switch' && id.serial ? `switch:${id.serial}` : groupKeyFor(lp.path, f.path, id.baseTitle, id.region, id.discNumber),
          contentKind: id.contentKind ?? null,
          libraryPathId: lp.id,
          path: f.path,
          sizeBytes: st.size,
          mtimeMs: st.mtimeMs,
          discNumber: id.discNumber,
          validation: validation.state,
          validationNote: validation.notes.join(' ') || (id.evidence.length ? `Identified: ${id.evidence.join('; ')}` : null),
          scanId,
        });
        if (res.created) summary.added++;
        else summary.updated++;
        summary.bySystem[id.systemId] = (summary.bySystem[id.systemId] ?? 0) + 1;
      }
      this.repo.touchFiles(touch, scanId);
      if (complete) summary.removed += this.repo.removeUnseenFiles(lp.id, scanId);
      else log.warn('scan incomplete; not removing unseen files', { path: lp.path });
      this.repo.updatePath(lp.id, { lastScanAt: new Date().toISOString(), available: true });
      ctx?.stepDone(`${files.length} files`);
    }
    ctx?.step('Checking for duplicates');
    summary.duplicates = this.repo.duplicates();
    summary.durationMs = Date.now() - started;
    log.info('scan complete', { ...summary, duplicates: summary.duplicates.length });
    return summary;
  }
}
