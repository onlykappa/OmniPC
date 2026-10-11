// "Add to Steam": writes OmniPC games into a Steam account's shortcuts.vdf as
// non-Steam shortcuts that run `OmniPC.exe --launch-game=<id>`, and copies the
// game's cover/background into the account's grid folder.
//
// Safety rules:
//  - Steam must be closed (it rewrites shortcuts.vdf from memory on exit).
//  - shortcuts.vdf is backed up (Backups/steam) and written atomically.
//  - Only OmniPC's own entries are added/changed/removed; other shortcuts and
//    unknown fields are preserved byte for byte.
//  - Only grid images OmniPC wrote are replaced or deleted; they are tracked in
//    Data/steam-shortcuts.json. A user's custom image is never overwritten.

import { copyFile, mkdir, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { SteamStatus, SteamSyncOptions, SteamSyncResult, SteamUser } from '@shared/steam';
import { getSystem } from '@shared/systems';
import type { AppPaths } from '../core/paths';
import type { LibraryRepo, GameRow } from '../database/libraryRepo';
import type { JobContext } from '../core/jobs';
import { OmniFailure } from '../core/errors';
import { logger } from '../core/logger';
import { atomicWrite } from '../config/iniFile';
import { listSteamUsers, windowsSteamPlatform, type SteamPlatform } from './discovery';
import { parseBinaryVdf, serializeBinaryVdf, type BinaryVdf } from './vdf';
import { applyShortcuts, emptyShortcutsDoc, gridNames, listOmniShortcuts, uniqueAppNames, type ShortcutSpec } from './shortcuts';
import { LAUNCH_GAME_ARG } from './launchArg';

const log = logger.scope('steam');
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const KEEP_BACKUPS = 20;

/** How Steam starts OmniPC. `args` go before --launch-game (e.g. the app folder in development). */
export interface SelfLauncher {
  exe: string;
  startDir: string;
  args: string[];
}

/** Packaged OmniPC: the installed exe, or the portable exe rather than its temporary unpacked copy. */
export function defaultSelfLauncher(): SelfLauncher {
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  return { exe, startDir: dirname(exe), args: [] };
}

interface TrackedUser {
  /** game id -> app id and the grid file names OmniPC wrote for it. */
  [gameId: string]: { appId: number; files: string[] };
}
interface TrackFile {
  version: 1;
  users: Record<string, TrackedUser>;
  lastSync: SteamSyncResult | null;
}

export interface SteamServiceDeps {
  library: LibraryRepo;
  paths: AppPaths;
  launcher: () => SelfLauncher;
  platform?: SteamPlatform;
  /** Polling interval/limit while waiting for Steam to exit (tests shorten them). */
  shutdownWait?: { intervalMs: number; timeoutMs: number };
}

const quote = (p: string) => `"${p}"`;

export class SteamService {
  private readonly platform: SteamPlatform;

  constructor(private readonly d: SteamServiceDeps) {
    this.platform = d.platform ?? windowsSteamPlatform;
  }

  private get trackFile(): string {
    return join(this.d.paths.data, 'steam-shortcuts.json');
  }

  private get backupDir(): string {
    return join(this.d.paths.backups, 'steam');
  }

  private readTrack(): TrackFile {
    try {
      const t = JSON.parse(readFileSync(this.trackFile, 'utf8')) as TrackFile;
      if (t && t.version === 1 && t.users) return t;
    } catch {
      /* first run */
    }
    return { version: 1, users: {}, lastSync: null };
  }

  private async writeTrack(t: TrackFile): Promise<void> {
    await atomicWrite(this.trackFile, JSON.stringify(t, null, 2));
  }

  launchOptionsFor(gameId: number): string {
    const l = this.d.launcher();
    return [...l.args.map(quote), `${LAUNCH_GAME_ARG}=${gameId}`].join(' ');
  }

  private async locate(): Promise<{ root: string; users: SteamUser[] } | null> {
    const root = await this.platform.findSteam();
    return root ? { root, users: listSteamUsers(root) } : null;
  }

  private pickUser(users: SteamUser[], requested?: string | null): SteamUser {
    if (requested) {
      const u = users.find((x) => x.id === requested);
      if (!u) throw new OmniFailure({ code: 'STEAM_USER_NOT_FOUND', whatHappened: `Steam account ${requested} has no folder on this PC.`, userAction: ['Pick another account, or sign in to Steam once with that account.'] });
      return u;
    }
    const u = users.find((x) => x.mostRecent) ?? users[0];
    if (!u) throw new OmniFailure({ code: 'STEAM_NO_USERS', whatHappened: 'No Steam account has signed in on this PC yet.', userAction: ['Start Steam and sign in once, then close Steam and try again.'] });
    return u;
  }

  private shortcutsFile(root: string, userId: string): string {
    return join(root, 'userdata', userId, 'config', 'shortcuts.vdf');
  }

  private gridDir(root: string, userId: string): string {
    return join(root, 'userdata', userId, 'config', 'grid');
  }

  private async readShortcuts(file: string): Promise<BinaryVdf> {
    if (!existsSync(file)) return emptyShortcutsDoc();
    try {
      return parseBinaryVdf(await readFile(file));
    } catch (err) {
      throw OmniFailure.wrap(err, 'STEAM_SHORTCUTS_UNREADABLE', "OmniPC couldn't read Steam's shortcuts file, so it left it untouched.", { probableCause: 'shortcuts.vdf is damaged or in an unexpected format.', userAction: [`Check ${file}. Steam rebuilds it when you add a non-Steam game yourself.`] });
    }
  }

  async status(userId?: string | null): Promise<SteamStatus> {
    const loc = await this.locate();
    const running = await this.platform.isRunning().catch(() => false);
    const track = this.readTrack();
    const l = this.d.launcher();
    const launcher = { exe: l.exe, launchOptions: this.launchOptionsFor(1).replace(/=1$/, '=<game>') };
    if (!loc) return { installed: false, steamPath: null, users: [], userId: null, running, shortcutsCount: 0, gameIds: [], lastSync: track.lastSync, launcher };
    const user = userId ? loc.users.find((u) => u.id === userId) : loc.users.find((u) => u.mostRecent) ?? loc.users[0];
    let gameIds: number[] = [];
    if (user) {
      try {
        gameIds = listOmniShortcuts(await this.readShortcuts(this.shortcutsFile(loc.root, user.id))).map((s) => s.gameId);
      } catch (err) {
        log.warn('could not read shortcuts.vdf', err);
      }
    }
    return { installed: true, steamPath: loc.root, users: loc.users, userId: user?.id ?? null, running, shortcutsCount: gameIds.length, gameIds, lastSync: track.lastSync, launcher };
  }

  /** Asks Steam to exit and waits until it has. */
  async closeSteam(): Promise<{ closed: boolean }> {
    if (!(await this.platform.isRunning())) return { closed: true };
    const loc = await this.locate();
    if (!loc) throw new OmniFailure({ code: 'STEAM_NOT_FOUND', whatHappened: 'Steam is running but OmniPC could not find its folder.', userAction: ['Exit Steam from its tray icon (Exit), then try again.'] });
    await this.platform.requestShutdown(loc.root);
    const wait = this.d.shutdownWait ?? { intervalMs: 1000, timeoutMs: 60000 };
    const until = Date.now() + wait.timeoutMs;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, wait.intervalMs));
      if (!(await this.platform.isRunning())) {
        log.info('Steam closed');
        return { closed: true };
      }
    }
    return { closed: false };
  }

  private async requireClosed(): Promise<void> {
    if (await this.platform.isRunning()) {
      throw new OmniFailure({
        code: 'STEAM_RUNNING',
        whatHappened: 'Steam is running.',
        probableCause: 'Steam keeps its shortcut list in memory and overwrites shortcuts.vdf when it exits, which would undo OmniPC’s changes.',
        userAction: ['Close Steam (OmniPC can do this for you on the Steam page), then try again.'],
      });
    }
  }

  private selectGames(opts: SteamSyncOptions): { games: GameRow[]; whole: boolean } {
    const all = this.d.library.allGames().filter((g) => g.availability !== 'missing');
    if (Array.isArray(opts.gameIds)) {
      const ids = new Set(opts.gameIds);
      return { games: all.filter((g) => ids.has(g.id)), whole: false };
    }
    if (opts.systems?.length) {
      const systems = new Set(opts.systems);
      return { games: all.filter((g) => systems.has(g.system_id)), whole: false };
    }
    return { games: all, whole: true };
  }

  private specsFor(games: GameRow[]): ShortcutSpec[] {
    const l = this.d.launcher();
    // Names are made unique across the whole library so they don't change with the selection.
    const names = uniqueAppNames(this.d.library.allGames().map((g) => ({ id: g.id, title: g.title, system: getSystem(g.system_id)?.shortName ?? g.system_id, region: g.region })));
    return games.map((g) => ({
      gameId: g.id,
      appName: names.get(g.id) ?? g.title,
      exe: quote(l.exe),
      startDir: quote(l.startDir),
      icon: '',
      launchOptions: this.launchOptionsFor(g.id),
      tags: [getSystem(g.system_id)?.name ?? g.system_id],
    }));
  }

  /** Adds/updates shortcuts (and artwork) for the selected games. */
  async sync(opts: SteamSyncOptions, ctx?: JobContext): Promise<SteamSyncResult> {
    const { games, whole } = this.selectGames(opts);
    return this.write(opts.userId, ctx, { specs: this.specsFor(games), removeOthers: whole });
  }

  /** Removes every OmniPC shortcut (and the artwork OmniPC wrote) for the account. */
  async removeAll(userId?: string, ctx?: JobContext): Promise<SteamSyncResult> {
    return this.write(userId, ctx, { specs: [], removeOthers: true });
  }

  private async write(userId: string | undefined, ctx: JobContext | undefined, plan: { specs: ShortcutSpec[]; removeOthers: boolean }): Promise<SteamSyncResult> {
    ctx?.step('Checking Steam');
    const loc = await this.locate();
    if (!loc) throw new OmniFailure({ code: 'STEAM_NOT_FOUND', whatHappened: 'Steam is not installed.', userAction: ['Install Steam from store.steampowered.com, sign in once, then try again.'] });
    const user = this.pickUser(loc.users, userId);
    await this.requireClosed();
    const file = this.shortcutsFile(loc.root, user.id);
    const doc = await this.readShortcuts(file);
    ctx?.stepDone(`${user.name} (${loc.root})`);

    ctx?.step('Updating shortcuts');
    const change = applyShortcuts(doc, plan.specs, { removeOthers: plan.removeOthers });
    let backup: string | null = null;
    if (change.changed) {
      backup = await this.backup(file, user.id);
      await atomicWrite(file, serializeBinaryVdf(doc));
      log.info('shortcuts.vdf updated', { user: user.id, added: change.added.length, updated: change.updated.length, removed: change.removed.length, backup });
    }
    ctx?.stepDone(`${change.added.length} added, ${change.updated.length} updated, ${change.removed.length} removed`);

    ctx?.step('Copying artwork');
    const track = this.readTrack();
    const tracked: TrackedUser = (track.users[user.id] ??= {});
    const grid = this.gridDir(loc.root, user.id);
    // Removed games, and games whose app id changed (renamed), lose the art OmniPC wrote.
    for (const r of change.removed) {
      await this.deleteTracked(grid, tracked[r.gameId]?.files ?? []);
      delete tracked[r.gameId];
    }
    let artwork = 0;
    for (const [i, spec] of plan.specs.entries()) {
      ctx?.throwIfCancelled();
      ctx?.progress(plan.specs.length ? i / plan.specs.length : null);
      const appId = change.appIds.get(spec.gameId);
      if (appId === undefined) continue;
      const prev = tracked[spec.gameId];
      if (prev && prev.appId !== appId) {
        await this.deleteTracked(grid, prev.files);
        delete tracked[spec.gameId];
      }
      const written = await this.copyArtwork(grid, appId, spec.gameId, tracked[spec.gameId]?.files ?? []);
      artwork += written.copied;
      tracked[spec.gameId] = { appId, files: written.files };
    }
    if (!Object.keys(tracked).length) delete track.users[user.id];
    ctx?.stepDone(`${artwork} image(s)`);

    const result: SteamSyncResult = { userId: user.id, added: change.added.length, updated: change.updated.length, removed: change.removed.length, artwork, backup, at: new Date().toISOString() };
    track.lastSync = result;
    await this.writeTrack(track);
    return result;
  }

  private async backup(file: string, userId: string): Promise<string | null> {
    if (!existsSync(file)) return null;
    await mkdir(this.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = join(this.backupDir, `shortcuts-${userId}-${stamp}.vdf`);
    await copyFile(file, dest);
    // Keep the newest backups per account.
    const mine = (await readdir(this.backupDir)).filter((f) => f.startsWith(`shortcuts-${userId}-`) && f.endsWith('.vdf')).sort();
    for (const old of mine.slice(0, Math.max(0, mine.length - KEEP_BACKUPS))) await rm(join(this.backupDir, old), { force: true });
    return dest;
  }

  private async deleteTracked(grid: string, files: string[]): Promise<void> {
    for (const f of files) {
      // Only plain file names OmniPC recorded, never a path.
      if (basename(f) !== f) continue;
      await unlink(join(grid, f)).catch(() => undefined);
    }
  }

  /**
   * Copies cover -> <id>p, background (or first screenshot) -> <id>_hero and
   * <id> (wide). A slot that already has an image OmniPC didn't write is left
   * alone. Returns the files OmniPC now owns for this game.
   */
  private async copyArtwork(grid: string, appId: number, gameId: number, owned: string[]): Promise<{ copied: number; files: string[] }> {
    const m = this.d.library.getMetadata(gameId);
    const usable = (p: string | null | undefined) => (p && IMAGE_EXT.has(extname(p).toLowerCase()) && existsSync(p) ? p : null);
    const cover = usable(m.coverPath);
    const background = usable(m.backgroundPath) ?? m.screenshots.map(usable).find((p) => p) ?? null;
    const names = gridNames(appId);
    const slots: [string, string | null][] = [[names.portrait, cover], [names.hero, background], [names.wide, background]];
    const existing = existsSync(grid) ? await readdir(grid) : [];
    const files: string[] = [];
    let copied = 0;
    for (const [slot, src] of slots) {
      const inSlot = existing.filter((f) => IMAGE_EXT.has(extname(f).toLowerCase()) && f.slice(0, -extname(f).length) === slot);
      if (inSlot.some((f) => !owned.includes(f))) {
        // The user's own artwork wins; drop any older OmniPC copy next to it.
        for (const f of inSlot) if (owned.includes(f)) await unlink(join(grid, f)).catch(() => undefined);
        continue;
      }
      const target = src ? slot + extname(src).toLowerCase() : null;
      // Our older image with another extension (or no source any more) goes.
      for (const f of inSlot) if (f !== target) await unlink(join(grid, f)).catch(() => undefined);
      if (!src || !target) continue;
      await mkdir(grid, { recursive: true });
      const dest = join(grid, target);
      if (!(await sameFile(src, dest))) {
        await copyFile(src, dest);
        copied++;
      }
      files.push(target);
    }
    return { copied, files };
  }
}

async function sameFile(a: string, b: string): Promise<boolean> {
  if (!existsSync(b)) return false;
  try {
    const [x, y] = await Promise.all([readFile(a), readFile(b)]);
    return x.equals(y);
  } catch {
    return false;
  }
}
