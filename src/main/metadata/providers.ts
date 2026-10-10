// Metadata & artwork providers. Each provider is independent and optional.
// Offline providers run first; online providers only run when enabled in
// Settings and only talk to their own documented hosts.

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { CompatibilityInfo, GameMetadata } from '@shared/models';
import type { SystemId } from '@shared/systems';
import { loadPcsx2Index, loadWiiTdb, pcsx2Compat } from './titleDatabases';

export interface MetadataSubject {
  gameId: number;
  systemId: SystemId;
  title: string;
  serial: string | null;
  region: string | null;
  primaryPath: string;
}

export interface ArtworkCandidate {
  kind: 'cover' | 'background' | 'screenshot';
  /** Either a local file path or an https URL. */
  location: string;
  allowedHosts?: string[];
}

export interface ProviderResult {
  title?: string;
  metadata?: Partial<GameMetadata>;
  compatibility?: CompatibilityInfo | null;
  artwork?: ArtworkCandidate[];
  sourceId?: string | null;
}

export interface MetadataProvider {
  id: string;
  label: string;
  online: boolean;
  description: string;
  lookup(s: MetadataSubject, env: ProviderEnv): Promise<ProviderResult | null>;
}

export interface ProviderEnv {
  emulatorAppDir(id: string): string | null;
  fetchImpl: typeof fetch;
  theGamesDbApiKey: string;
}

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];

/** Artwork the user already keeps next to their games (e.g. Game.png, media/covers/Game.jpg). */
export const localFilesProvider: MetadataProvider = {
  id: 'local-files',
  label: 'Artwork next to your games',
  online: false,
  description: 'Uses images named like the game file, or inside media/covers, boxart or covers folders.',
  async lookup(s) {
    const dir = dirname(s.primaryPath);
    const stem = basename(s.primaryPath, extname(s.primaryPath));
    const candidates: string[] = [];
    for (const folder of [dir, join(dir, 'media', 'covers'), join(dir, 'covers'), join(dir, 'boxart'), join(dir, '..', 'media', 'covers')]) {
      for (const name of [stem, s.serial ?? '', s.title]) {
        if (!name) continue;
        for (const e of IMAGE_EXTS) candidates.push(join(folder, name + e));
      }
    }
    const hit = candidates.find((c) => existsSync(c));
    if (hit) return { artwork: [{ kind: 'cover', location: hit }] };
    // also accept "folder.jpg"/"cover.png" when the game has its own folder
    const entries = await readdir(dir).catch(() => [] as string[]);
    const generic = entries.find((e) => /^(cover|folder|boxart)\.(png|jpe?g|webp)$/i.test(e));
    return generic ? { artwork: [{ kind: 'cover', location: join(dir, generic) }] } : null;
  },
};

/** Title + compatibility from databases shipped with installed emulators. */
export const emulatorDatabasesProvider: MetadataProvider = {
  id: 'emulator-databases',
  label: 'Emulator game databases (offline)',
  online: false,
  description: "Reads PCSX2's GameIndex.yaml and Dolphin's GameTDB title list from the installed emulators.",
  async lookup(s, env) {
    if (s.systemId === 'ps2' && s.serial) {
      const dir = env.emulatorAppDir('pcsx2');
      if (!dir) return null;
      const index = await loadPcsx2Index(join(dir, 'resources', 'GameIndex.yaml'));
      const e = index?.get(s.serial);
      if (!e) return null;
      return {
        title: e.nameEn || e.name || undefined,
        metadata: { source: 'PCSX2 GameIndex', sourceId: s.serial },
        compatibility: pcsx2Compat(e.compat),
        sourceId: s.serial,
      };
    }
    if ((s.systemId === 'gc' || s.systemId === 'wii') && s.serial) {
      const dir = env.emulatorAppDir('dolphin');
      if (!dir) return null;
      const db = (await loadWiiTdb(join(dir, 'Sys', 'wiitdb-en.txt'))) ?? (await loadWiiTdb(join(dir, 'Data', 'Sys', 'wiitdb-en.txt')));
      const title = db?.get(s.serial) ?? db?.get(s.serial.slice(0, 4));
      return title ? { title, metadata: { source: 'GameTDB title list (bundled with Dolphin)', sourceId: s.serial }, sourceId: s.serial } : null;
    }
    return null;
  },
};

function gameTdbRegion(region: string | null, id: string): string {
  if (region === 'USA' || id[3] === 'E') return 'US';
  if (region === 'Japan' || id[3] === 'J') return 'JA';
  if (region === 'Korea' || id[3] === 'K') return 'KO';
  return 'EN';
}

/** GameTDB cover art, the same source Dolphin itself uses for its cover display. */
export const gameTdbProvider: MetadataProvider = {
  id: 'gametdb',
  label: 'GameTDB covers (GameCube/Wii)',
  online: true,
  description: 'Downloads cover art from art.gametdb.com, the source Dolphin uses.',
  async lookup(s) {
    if (!(s.systemId === 'gc' || s.systemId === 'wii') || !s.serial || !/^[A-Z0-9]{6}$/.test(s.serial)) return null;
    const region = gameTdbRegion(s.region, s.serial);
    return {
      artwork: [
        { kind: 'cover', location: `https://art.gametdb.com/wii/cover/${region}/${s.serial}.png`, allowedHosts: ['art.gametdb.com'] },
        { kind: 'background', location: `https://art.gametdb.com/wii/coverfullHQ/${region}/${s.serial}.png`, allowedHosts: ['art.gametdb.com'] },
      ],
    };
  },
};

/** Community PS2 cover collection commonly configured in PCSX2's cover downloader. */
export const ps2CoversProvider: MetadataProvider = {
  id: 'ps2-covers',
  label: 'PS2 covers (xlenore/ps2-covers on GitHub)',
  online: true,
  description: 'Downloads PS2 covers by serial from the community xlenore/ps2-covers repository.',
  async lookup(s) {
    if (s.systemId !== 'ps2' || !s.serial) return null;
    return { artwork: [{ kind: 'cover', location: `https://raw.githubusercontent.com/xlenore/ps2-covers/main/covers/default/${encodeURIComponent(s.serial)}.jpg`, allowedHosts: ['raw.githubusercontent.com'] }] };
  },
};

/** TheGamesDB platform ids (https://api.thegamesdb.net/v1/Platforms). */
export const TGDB_PLATFORMS: Partial<Record<SystemId, number>> = {
  ps1: 10, ps2: 11, ps3: 12, psp: 13, gc: 2, wii: 9, wiiu: 38, nds: 8, xbox: 14, x360: 15,
  nes: 7, snes: 6, n64: 3, gb: 4, gbc: 41, gba: 5, genesis: 18, arcade: 23,
};

interface TgdbResponse {
  data?: { games?: { id: number; game_title: string; release_date?: string; overview?: string; players?: number; rating?: string; developers?: number[]; publishers?: number[]; genres?: number[] }[] };
  include?: { boxart?: { base_url?: { original?: string; large?: string }; data?: Record<string, { type: string; side?: string; filename: string }[]> } };
}

/** TheGamesDB (requires the user's own API key from thegamesdb.net). */
export const theGamesDbProvider: MetadataProvider = {
  id: 'thegamesdb',
  label: 'TheGamesDB (needs your API key)',
  online: true,
  description: 'Descriptions, release dates and box art from TheGamesDB.net using your personal API key.',
  async lookup(s, env) {
    const platform = TGDB_PLATFORMS[s.systemId];
    if (!env.theGamesDbApiKey || !platform) return null;
    const url = new URL('https://api.thegamesdb.net/v1.1/Games/ByGameName');
    url.searchParams.set('apikey', env.theGamesDbApiKey);
    url.searchParams.set('name', s.title);
    url.searchParams.set('filter[platform]', String(platform));
    url.searchParams.set('fields', 'overview,players,rating');
    url.searchParams.set('include', 'boxart');
    const r = await env.fetchImpl(url, { headers: { 'User-Agent': 'OmniPC-PC' } });
    if (!r.ok) throw new Error(`TheGamesDB HTTP ${r.status}`);
    const body = (await r.json()) as TgdbResponse;
    const games = body.data?.games ?? [];
    const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, '');
    const best = games.find((g) => norm(g.game_title) === norm(s.title)) ?? games[0];
    if (!best) return null;
    const base = body.include?.boxart?.base_url?.large ?? body.include?.boxart?.base_url?.original;
    const art = body.include?.boxart?.data?.[String(best.id)] ?? [];
    const front = art.find((a) => a.type === 'boxart' && a.side === 'front');
    const fanart = art.find((a) => a.type === 'fanart');
    const artwork: ArtworkCandidate[] = [];
    if (base && front) artwork.push({ kind: 'cover', location: base + front.filename, allowedHosts: ['cdn.thegamesdb.net'] });
    if (base && fanart) artwork.push({ kind: 'background', location: base + fanart.filename, allowedHosts: ['cdn.thegamesdb.net'] });
    return {
      metadata: {
        description: best.overview ?? null,
        releaseYear: best.release_date ? Number(best.release_date.slice(0, 4)) || null : null,
        players: best.players ? String(best.players) : null,
        rating: best.rating ?? null,
        source: 'TheGamesDB',
        sourceId: String(best.id),
      },
      artwork,
      sourceId: String(best.id),
    };
  },
};

export const ALL_PROVIDERS: MetadataProvider[] = [localFilesProvider, emulatorDatabasesProvider, gameTdbProvider, ps2CoversProvider, theGamesDbProvider];
