// What this PC offers to another PC ("Copy from another PC"). Built from the
// library, the BIOS folders and the save locations. Every shared file is
// listed here with its absolute path, server side only; the network side may
// only serve a file whose (item id, relative path) pair is in this index.

import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ShareBiosItem, ShareFile, ShareGameItem, ShareSavesItem } from '@shared/share';
import { getSystem, SYSTEMS, type SystemId } from '@shared/systems';
import type { LibraryRepo, GameRow, GameFileRow } from '../database/libraryRepo';
import type { AppPaths } from '../core/paths';
import { identifyBiosFile } from '../bios/scan';
import { parseCueFiles, parseM3u } from '../library/identify';
import { logger } from '../core/logger';

const log = logger.scope('share');

/** Largest cover thumbnail sent inline in the catalog. */
export const MAX_THUMB_BYTES = 60 * 1024;

export interface IndexedItem {
  kind: 'game' | 'bios';
  /** Relative path ('/' separators) -> absolute path on this PC. */
  files: Map<string, string>;
}

export interface BuiltCatalog {
  games: ShareGameItem[];
  bios: ShareBiosItem[];
  saves: ShareSavesItem[];
  index: Map<string, IndexedItem>;
  builtAt: number;
}

export interface CatalogDeps {
  library: Pick<LibraryRepo, 'allGames' | 'filesForGame'>;
  paths: Pick<AppPaths, 'bios' | 'systemBiosDir'>;
  /** Save locations per emulator (SaveService.locations). */
  saveLocations: () => Promise<{ emulatorId: string; fileCount: number; sizeBytes: number; lastModified: string | null }[]>;
  emulatorName: (id: string) => string;
}

export interface CatalogScope { games: boolean; bios: boolean; saves: boolean }

/** Stable short id for an item: sha1(kind + key), 16 hex characters. */
export function itemId(kind: string, key: string): string {
  return createHash('sha1').update(`${kind}\0${key}`).digest('hex').slice(0, 16);
}

/** Relative path with '/' separators, or null when `abs` is not strictly inside `root`. */
export function toRelative(root: string, abs: string): string | null {
  const rel = relative(root, abs);
  if (!rel || isAbsolute(rel) || rel.split(/[\\/]/).some((p) => p === '..' || p === '')) return null;
  return rel.split(sep).join('/');
}

interface FoundFile { abs: string; size: number; mtimeMs: number }

/** Regular files only (symbolic links and junctions are skipped, never followed). */
async function fileInfo(abs: string): Promise<FoundFile | null> {
  const st = await lstat(abs).catch(() => null);
  if (!st || st.isSymbolicLink() || !st.isFile()) return null;
  return { abs, size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
}

/** Recursively lists regular files under `dir` without following links. */
export async function walkFiles(dir: string, maxFiles = 200_000): Promise<FoundFile[]> {
  const out: FoundFile[] = [];
  const go = async (d: string, depth: number): Promise<void> => {
    if (depth > 32 || out.length >= maxFiles) return;
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) await go(p, depth + 1);
      else if (e.isFile()) {
        const f = await fileInfo(p);
        if (f) out.push(f);
      }
    }
  };
  await go(dir, 0);
  return out;
}

/** Deepest folder containing every path. */
function commonDir(paths: string[]): string {
  let root = dirname(resolve(paths[0]));
  const inside = (p: string) => {
    const rel = relative(root, resolve(p));
    return !!rel && !isAbsolute(rel) && !rel.startsWith('..');
  };
  while (!paths.every(inside)) {
    const up = dirname(root);
    if (up === root) break;
    root = up;
  }
  return root;
}

/** The game folder of a folder-format game (PS3/PS4/PS5 eboot.bin, Xbox 360 default.xex), else null. */
export function folderGameRoot(systemId: SystemId, mainFile: string): string | null {
  const name = basename(mainFile).toLowerCase();
  const dir = dirname(mainFile);
  if (systemId === 'x360' && name === 'default.xex') return dir;
  if (name !== 'eboot.bin') return null;
  if (systemId === 'ps4' || systemId === 'ps5') return dir;
  if (systemId === 'ps3' && basename(dir).toUpperCase() === 'USRDIR') {
    const gameDir = dirname(dir);
    return basename(gameDir).toUpperCase() === 'PS3_GAME' ? dirname(gameDir) : gameDir;
  }
  return null;
}

/** The absolute files of one game: its file rows plus cue/m3u components, or the whole folder for folder-format games. */
async function gameFiles(game: GameRow, rows: GameFileRow[]): Promise<{ root: string; files: FoundFile[]; folderGame: boolean } | null> {
  if (!rows.length) return null;
  const folder = folderGameRoot(game.system_id, rows[0].path);
  if (folder) {
    const files = await walkFiles(folder);
    return files.length ? { root: folder, files, folderGame: true } : null;
  }
  const wanted = new Map<string, string>();
  const add = (p: string) => wanted.set(resolve(p).toLowerCase(), resolve(p));
  for (const r of rows) {
    add(r.path);
    const lower = r.path.toLowerCase();
    const dir = dirname(r.path);
    if (lower.endsWith('.cue')) for (const f of await parseCueFiles(r.path)) add(resolve(dir, f));
    if (lower.endsWith('.m3u')) {
      for (const f of await parseM3u(r.path)) {
        const target = resolve(dir, f);
        add(target);
        if (target.toLowerCase().endsWith('.cue')) for (const t of await parseCueFiles(target)) add(resolve(dirname(target), t));
      }
    }
  }
  const files = (await Promise.all([...wanted.values()].map(fileInfo))).filter((f): f is FoundFile => !!f);
  if (!files.length) return null;
  // The main file's folder, widened only if a referenced component lives elsewhere.
  const root = commonDir([rows[0].path, ...files.map((f) => f.abs)]);
  return { root, files, folderGame: false };
}

async function coverThumb(path: string | null): Promise<string | null> {
  if (!path) return null;
  const f = await fileInfo(path);
  if (!f || f.size === 0 || f.size > MAX_THUMB_BYTES) return null;
  return (await readFile(path).catch(() => null))?.toString('base64') ?? null;
}

function toShareFiles(root: string, found: FoundFile[]): { files: ShareFile[]; map: Map<string, string> } {
  const files: ShareFile[] = [];
  const map = new Map<string, string>();
  for (const f of found) {
    const rel = toRelative(root, f.abs);
    if (!rel || map.has(rel)) continue;
    map.set(rel, f.abs);
    files.push({ path: rel, size: f.size, mtimeMs: f.mtimeMs });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, map };
}

/** Folder-name-safe version of a game folder name. */
function safeSegment(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 120) || 'Game';
}

export async function buildGames(deps: CatalogDeps, index: Map<string, IndexedItem>): Promise<ShareGameItem[]> {
  const out: ShareGameItem[] = [];
  for (const g of deps.library.allGames()) {
    if (g.availability !== 'available') continue;
    try {
      const rows = deps.library.filesForGame(g.id);
      const set = await gameFiles(g, rows);
      if (!set) continue;
      const { files, map } = toShareFiles(set.root, set.files);
      if (!files.length) continue;
      const id = itemId('game', `${g.system_id}|${resolve(rows[0].path).toLowerCase()}`);
      const sys = getSystem(g.system_id)?.shortName ?? g.system_id;
      index.set(id, { kind: 'game', files: map });
      out.push({
        kind: 'game',
        id,
        title: g.title,
        systemId: g.system_id,
        region: g.region,
        serial: g.serial,
        folder: set.folderGame ? `${sys}/${safeSegment(basename(set.root))}` : sys,
        files,
        sizeBytes: files.reduce((s, f) => s + f.size, 0),
        coverThumb: await coverThumb(g.cover_thumb),
      });
    } catch (e) {
      log.warn('could not list a game for sharing', { gameId: g.id, error: String(e) });
    }
  }
  return out.sort((a, b) => a.systemId.localeCompare(b.systemId) || a.title.localeCompare(b.title));
}

export async function buildBios(deps: CatalogDeps, index: Map<string, IndexedItem>): Promise<ShareBiosItem[]> {
  const out: ShareBiosItem[] = [];
  for (const sys of SYSTEMS) {
    const dir = deps.paths.systemBiosDir(sys.id);
    const st = await lstat(dir).catch(() => null);
    if (!st?.isDirectory()) continue;
    const groups = new Map<ShareBiosItem['category'], { found: FoundFile[]; identified: boolean }>();
    for (const f of await walkFiles(dir, 20_000)) {
      if (f.size === 0) continue;
      const id = await identifyBiosFile(f.abs, f.size).catch(() => null);
      const category = id?.kind ?? 'bios';
      const g = groups.get(category) ?? { found: [], identified: false };
      g.found.push(f);
      if (id) g.identified = true;
      groups.set(category, g);
    }
    for (const [category, g] of groups) {
      const { files, map } = toShareFiles(dir, g.found);
      if (!files.length) continue;
      const id = itemId('bios', `${sys.id}|${category}`);
      index.set(id, { kind: 'bios', files: map });
      const label = category === 'keys' ? `${sys.name} keys` : category === 'firmware' ? `${sys.name} firmware` : g.identified ? `${sys.name} BIOS` : `${sys.name} BIOS files`;
      out.push({ kind: 'bios', id, systemId: sys.id, label, category, files, sizeBytes: files.reduce((s, f) => s + f.size, 0) });
    }
  }
  return out;
}

export async function buildSaves(deps: CatalogDeps): Promise<ShareSavesItem[]> {
  const by = new Map<string, ShareSavesItem>();
  for (const l of await deps.saveLocations()) {
    if (!l.fileCount) continue;
    const cur = by.get(l.emulatorId) ?? { kind: 'saves' as const, id: itemId('saves', l.emulatorId), emulatorId: l.emulatorId, emulatorName: deps.emulatorName(l.emulatorId), fileCount: 0, sizeBytes: 0, lastModified: null };
    cur.fileCount += l.fileCount;
    cur.sizeBytes += l.sizeBytes;
    if (l.lastModified && (!cur.lastModified || l.lastModified > cur.lastModified)) cur.lastModified = l.lastModified;
    by.set(l.emulatorId, cur);
  }
  return [...by.values()];
}

/** Builds the catalog for the shared kinds; kinds not shared are empty and absent from the index. */
export async function buildCatalog(deps: CatalogDeps, scope: CatalogScope): Promise<BuiltCatalog> {
  const index = new Map<string, IndexedItem>();
  return {
    games: scope.games ? await buildGames(deps, index) : [],
    bios: scope.bios ? await buildBios(deps, index) : [],
    saves: scope.saves ? await buildSaves(deps) : [],
    index,
    builtAt: Date.now(),
  };
}
