// Metadata orchestration: runs enabled providers in order, caches results in
// SQLite and artwork on disk, and generates small thumbnails for grids.
// Metadata is fetched once and cached; it is never re-downloaded on startup.
// User edits lock a game's metadata so automatic refreshes don't overwrite them.

import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { GameMetadata } from '@shared/models';
import type { LibraryRepo } from '../database/libraryRepo';
import type { SettingsRepo } from '../database/settingsRepo';
import type { JobContext } from '../core/jobs';
import { logger } from '../core/logger';
import { hostAllowed } from '../downloads/sources';
import { SwitchTitleDb, switchTitleDbProvider } from './switchTitleDb';
import { wikipediaProvider } from './wikipedia';
import { ALL_PROVIDERS, theGamesDbProvider, type ArtworkCandidate, type MetadataProvider, type MetadataSubject, type ProviderEnv } from './providers';
import { libretroThumbnailsProvider, type LibretroThumbnails } from './libretroThumbnails';

/**
 * Provider order: offline sources, then system-specific online art (GameTDB,
 * PS2 covers), then libretro-thumbnails for every system, then TheGamesDB.
 * The first provider that supplies a cover wins; later ones fill gaps.
 */
export function defaultProviders(lt: LibretroThumbnails, switchDb: SwitchTitleDb, fetchImpl: typeof fetch = fetch): MetadataProvider[] {
  const base = ALL_PROVIDERS.filter((p) => p !== theGamesDbProvider);
  return [...base, switchTitleDbProvider(switchDb), libretroThumbnailsProvider(lt), wikipediaProvider(fetchImpl), theGamesDbProvider];
}

const MAX_SCREENSHOTS = 4;

const log = logger.scope('metadata');

/** Produces a JPEG thumbnail; implemented with Electron's nativeImage at runtime. */
export type Thumbnailer = (src: string, dest: string, width: number) => Promise<boolean>;

export class MetadataService {
  /**
   * Online providers / image hosts that failed with a network error during the
   * current refresh. They are skipped for the rest of it, so one dead server
   * (or a site blocked on this network) never stops the other sources.
   */
  private failedProviders = new Set<string>();
  private failedHosts = new Set<string>();

  constructor(
    private readonly repo: LibraryRepo,
    private readonly settings: SettingsRepo,
    private readonly artDir: string,
    private readonly thumbDir: string,
    private readonly env: Omit<ProviderEnv, 'theGamesDbApiKey'>,
    private readonly thumbnailer: Thumbnailer,
    private readonly providers: MetadataProvider[] = ALL_PROVIDERS,
  ) {}

  private enabledProviders(): MetadataProvider[] {
    const s = this.settings.getAll();
    return this.providers.filter((p) => {
      if (p.id === 'thegamesdb') return s.metadataOnline && !!s.theGamesDbApiKey;
      if (!s.artworkProviders.includes(p.id)) return false;
      return !p.online || s.metadataOnline;
    });
  }

  private subject(gameId: number): MetadataSubject | null {
    const g = this.repo.getGame(gameId);
    if (!g) return null;
    const files = this.repo.filesForGame(gameId);
    if (!files.length) return null;
    return { gameId, systemId: g.system_id, title: g.title, serial: g.serial ?? files.find((f) => f.serial)?.serial ?? null, region: g.region, primaryPath: files[0].path };
  }

  async refresh(gameId: number, opts: { force?: boolean } = {}): Promise<GameMetadata> {
    const subj = this.subject(gameId);
    if (!subj) return this.repo.getMetadata(gameId);
    const current = this.repo.getMetadata(gameId);
    if (current.locked && !opts.force) return current;
    const env: ProviderEnv = { ...this.env, theGamesDbApiKey: this.settings.get('theGamesDbApiKey') };
    const patch: Partial<GameMetadata> = {};
    const sources: string[] = [];
    let cover: string | null = null;
    let background: string | null = null;
    const screenshots: string[] = [];
    for (const p of this.enabledProviders()) {
      if (p.online && this.failedProviders.has(p.id)) continue;
      // Wikipedia only fills gaps: skip it when a cover and a description were already found.
      if (p.id === 'wikipedia' && cover && patch.description) continue;
      let res;
      try {
        res = await p.lookup(subj, env);
      } catch (err) {
        log.warn(`provider ${p.id} failed`, { gameId, error: (err as Error).message });
        if (p.online && /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN/i.test(String((err as Error).message))) this.failedProviders.add(p.id);
        continue;
      }
      if (!res) continue;
      let contributed = false;
      if (res.title && !current.locked && res.title !== subj.title) {
        this.repo.setTitle(gameId, res.title);
        subj.title = res.title;
        contributed = true;
      }
      if (res.compatibility !== undefined) {
        this.repo.setCompatibility(gameId, res.compatibility);
        contributed ||= res.compatibility !== null;
      }
      for (const [k, v] of Object.entries(res.metadata ?? {})) {
        if (k === 'source' || k === 'sourceId') continue;
        if (v !== null && v !== undefined && (patch as Record<string, unknown>)[k] == null) {
          (patch as Record<string, unknown>)[k] = v;
          contributed = true;
        }
      }
      if (res.title || res.compatibility) contributed = true;
      for (const a of res.artwork ?? []) {
        if (a.kind === 'cover' && !cover && (cover = await this.fetchArtwork(gameId, a))) contributed = true;
        if (a.kind === 'background' && !background && (background = await this.fetchArtwork(gameId, a))) contributed = true;
        if (a.kind === 'screenshot' && screenshots.length < MAX_SCREENSHOTS) {
          const shot = await this.fetchArtwork(gameId, a, screenshots.length);
          if (shot) { screenshots.push(shot); contributed = true; }
        }
      }
      if (contributed) {
        sources.push(p.label);
        if (!patch.sourceId && res.sourceId) patch.sourceId = res.sourceId;
      }
    }
    const next = this.repo.saveMetadata(gameId, {
      ...patch,
      coverPath: cover ?? (current.coverPath && existsSync(current.coverPath) ? current.coverPath : null),
      backgroundPath: background ?? (current.backgroundPath && existsSync(current.backgroundPath) ? current.backgroundPath : null),
      screenshots: screenshots.length ? screenshots : (current.screenshots ?? []).filter((p) => existsSync(p)),
      source: sources.length ? sources.join(', ') : current.source,
      fetchedAt: new Date().toISOString(),
    });
    await this.updateThumb(gameId, next.coverPath);
    return this.repo.getMetadata(gameId);
  }

  async refreshAll(ctx?: JobContext, opts: { onlyMissing: boolean; withoutCover?: boolean } = { onlyMissing: true }): Promise<{ processed: number }> {
    const games = opts.withoutCover ? this.repo.gamesWithoutCover() : opts.onlyMissing ? this.repo.gamesNeedingMetadata(5000) : this.repo.allGames();
    this.failedProviders.clear();
    this.failedHosts.clear();
    let i = 0;
    for (const g of games) {
      ctx?.throwIfCancelled();
      await this.refresh(g.id).catch((e) => log.warn('refresh failed', { id: g.id, e: (e as Error).message }));
      i++;
      ctx?.progress(i / games.length, `${i}/${games.length}: ${g.title}`);
    }
    return { processed: i };
  }

  private async fetchArtwork(gameId: number, a: ArtworkCandidate, index?: number): Promise<string | null> {
    await mkdir(this.artDir, { recursive: true });
    if (!/^https:/i.test(a.location)) {
      if (!existsSync(a.location)) return null;
      // Local art is referenced in place (user-owned files stay where they are).
      return a.location;
    }
    if (!a.allowedHosts || !hostAllowed(a.location, a.allowedHosts)) return null;
    const host = new URL(a.location).host;
    if (this.failedHosts.has(host)) return null;
    const ext = (extname(new URL(a.location).pathname) || '.jpg').toLowerCase();
    const dest = join(this.artDir, `${gameId}-${a.kind}${index !== undefined ? `-${index}` : ''}${ext}`);
    try {
      const r = await this.env.fetchImpl(a.location, { headers: { 'User-Agent': 'OmniPC-PC' }, redirect: 'manual' });
      if (!r.ok) return null;
      const type = r.headers.get('content-type') ?? '';
      if (!/^image\//.test(type)) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 512 || buf.length > 25 * 1024 * 1024) return null;
      await writeFile(dest, buf);
      return dest;
    } catch (err) {
      if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN/i.test(String((err as Error).message))) this.failedHosts.add(host);
      return null;
    }
  }

  private async updateThumb(gameId: number, cover: string | null): Promise<void> {
    if (!cover) {
      this.repo.setCoverThumb(gameId, null);
      return;
    }
    await mkdir(this.thumbDir, { recursive: true });
    const dest = join(this.thumbDir, `${gameId}.jpg`);
    const ok = await this.thumbnailer(cover, dest, 360).catch(() => false);
    this.repo.setCoverThumb(gameId, ok ? dest : cover);
  }

  /** Manual edit from the correction UI; locks metadata against automatic refresh. */
  async update(gameId: number, patch: Partial<GameMetadata> & { title?: string }): Promise<GameMetadata> {
    const { title, ...rest } = patch;
    if (title && title.trim()) this.repo.setTitle(gameId, title.trim());
    const m = this.repo.saveMetadata(gameId, { ...rest, locked: true, source: 'Edited by you' });
    if (rest.coverPath !== undefined) await this.updateThumb(gameId, m.coverPath);
    return m;
  }

  async setArtwork(gameId: number, kind: 'cover' | 'background', filePath: string): Promise<GameMetadata> {
    await mkdir(join(this.artDir, 'custom'), { recursive: true });
    const dest = join(this.artDir, 'custom', `${gameId}-${kind}${extname(filePath).toLowerCase() || '.png'}`);
    await copyFile(filePath, dest);
    const m = this.repo.saveMetadata(gameId, kind === 'cover' ? { coverPath: dest, locked: true } : { backgroundPath: dest, locked: true });
    if (kind === 'cover') await this.updateThumb(gameId, dest);
    return m;
  }

  async clear(gameId: number): Promise<void> {
    const m = this.repo.getMetadata(gameId);
    for (const p of [m.coverPath, m.backgroundPath, ...(m.screenshots ?? [])]) {
      if (p && p.startsWith(this.artDir)) await rm(p, { force: true }).catch(() => undefined);
    }
    await rm(join(this.thumbDir, `${gameId}.jpg`), { force: true }).catch(() => undefined);
    this.repo.clearMetadata(gameId);
  }

  providerList(): { id: string; label: string; online: boolean; description: string }[] {
    return this.providers.map((p) => ({ id: p.id, label: p.label, online: p.online, description: p.description }));
  }
}
