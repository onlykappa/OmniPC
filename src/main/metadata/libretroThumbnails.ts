// Box art, title screens and in-game screenshots from the libretro-thumbnails
// project (github.com/libretro-thumbnails): one community repository per
// system, the same artwork RetroArch shows. Needs no account or API key.
//
// Each repository holds Named_Boxarts/, Named_Titles/ and Named_Snaps/ with
// PNGs named after No-Intro/Redump titles ("AeroFighters Assault (USA).png").
// OmniPC downloads the repository's file list once (GitHub API, cached for
// two weeks), matches the game by name, and fetches only the images it needs
// from raw.githubusercontent.com. Images are cached locally and never shared.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { SystemId } from '@shared/systems';
import type { ArtworkCandidate, MetadataProvider, MetadataSubject } from './providers';

/** libretro-thumbnails repository per OmniPC system (verified to exist). */
export const LIBRETRO_THUMB_REPOS: Partial<Record<SystemId, string>> = {
  nes: 'Nintendo_-_Nintendo_Entertainment_System',
  snes: 'Nintendo_-_Super_Nintendo_Entertainment_System',
  n64: 'Nintendo_-_Nintendo_64',
  gb: 'Nintendo_-_Game_Boy',
  gbc: 'Nintendo_-_Game_Boy_Color',
  gba: 'Nintendo_-_Game_Boy_Advance',
  nds: 'Nintendo_-_Nintendo_DS',
  gc: 'Nintendo_-_GameCube',
  wii: 'Nintendo_-_Wii',
  wiiu: 'Nintendo_-_Wii_U',
  genesis: 'Sega_-_Mega_Drive_-_Genesis',
  ps1: 'Sony_-_PlayStation',
  ps2: 'Sony_-_PlayStation_2',
  psp: 'Sony_-_PlayStation_Portable',
  ps3: 'Sony_-_PlayStation_3',
  ps4: 'Sony_-_PlayStation_4',
  xbox: 'Microsoft_-_Xbox',
  x360: 'Microsoft_-_Xbox_360',
};

export const LIBRETRO_HOSTS = ['api.github.com', 'raw.githubusercontent.com'];
const TTL_MS = 14 * 24 * 3600 * 1000;
const KINDS = ['Named_Boxarts', 'Named_Titles', 'Named_Snaps'] as const;
type Kind = (typeof KINDS)[number];

/** Comparable key: no region/language tags, no punctuation, "The" ignored. */
export function titleKey(name: string): string {
  return name
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/\s*[([].*$/, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/,\s*the\b/g, '')
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]/g, '');
}

const UNWANTED = /\((?:[^)]*\b(?:beta|proto|prototype|demo|kiosk|sample|pirate|hack|unl|aftermarket|program|debug)\b[^)]*)\)/i;

function regionScore(name: string, region: string | null): number {
  const tags = (name.match(/\(([^)]*)\)/g) ?? []).join(' ').toLowerCase();
  const want = (region ?? '').toLowerCase();
  if (want && tags.includes(want)) return 3;
  if (/\busa\b|\bworld\b/.test(tags)) return 2;
  if (/\beurope\b/.test(tags)) return 1;
  return 0;
}

/**
 * Picks the best file for a game: exact file-name match first, then same
 * title with the closest region, avoiding betas/demos/hacks, shortest name.
 */
export function pickThumbnail(names: string[], fileStem: string, title: string, region: string | null): string | null {
  const exact = names.find((n) => n.slice(0, -extname(n).length).toLowerCase() === fileStem.toLowerCase());
  if (exact) return exact;
  const keys = [titleKey(fileStem), titleKey(title)].filter(Boolean);
  const hits = names.filter((n) => keys.includes(titleKey(n)));
  if (!hits.length) return null;
  return hits
    .map((n) => ({ n, score: (UNWANTED.test(n) ? -10 : 0) + regionScore(n, region) - n.length / 1000 }))
    .sort((a, b) => b.score - a.score)[0].n;
}

interface Index { fetchedAt: number; files: Record<Kind, string[]> }

export class LibretroThumbnails {
  private memory = new Map<string, Promise<Index | null>>();
  constructor(private readonly cacheDir: string, private readonly fetchImpl: typeof fetch) {}

  /** File list of one repository: from memory, then disk cache, then the GitHub API. */
  index(repo: string): Promise<Index | null> {
    let p = this.memory.get(repo);
    if (!p) {
      p = this.load(repo).catch(() => null);
      this.memory.set(repo, p);
      // A failed lookup (offline, rate limit) is retried on the next refresh.
      void p.then((v) => { if (!v) this.memory.delete(repo); });
    }
    return p;
  }

  private async load(repo: string): Promise<Index | null> {
    const file = join(this.cacheDir, 'libretro-thumbnails', `${repo}.json`);
    const cached = await readFile(file, 'utf8').then((t) => JSON.parse(t) as Index).catch(() => null);
    if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached;
    const r = await this.fetchImpl(`https://api.github.com/repos/libretro-thumbnails/${repo}/git/trees/master?recursive=1`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'OmniPC', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!r.ok) return cached; // rate-limited or offline: keep using an older list if there is one
    const body = (await r.json()) as { tree?: { path: string; type: string }[] };
    const files = { Named_Boxarts: [], Named_Titles: [], Named_Snaps: [] } as Record<Kind, string[]>;
    for (const e of body.tree ?? []) {
      if (e.type !== 'blob' || !/\.png$/i.test(e.path)) continue;
      const [dir, name] = [e.path.slice(0, e.path.indexOf('/')), e.path.slice(e.path.indexOf('/') + 1)];
      if ((KINDS as readonly string[]).includes(dir) && name && !name.includes('/')) files[dir as Kind].push(name);
    }
    const idx: Index = { fetchedAt: Date.now(), files };
    await mkdir(join(this.cacheDir, 'libretro-thumbnails'), { recursive: true });
    await writeFile(file, JSON.stringify(idx));
    return idx;
  }

  async artwork(s: MetadataSubject): Promise<ArtworkCandidate[]> {
    const repo = LIBRETRO_THUMB_REPOS[s.systemId];
    if (!repo) return [];
    const idx = await this.index(repo);
    if (!idx) return [];
    const stem = basename(s.primaryPath, extname(s.primaryPath));
    const url = (kind: Kind, name: string) => `https://raw.githubusercontent.com/libretro-thumbnails/${repo}/master/${kind}/${encodeURIComponent(name)}`;
    const out: ArtworkCandidate[] = [];
    const box = pickThumbnail(idx.files.Named_Boxarts, stem, s.title, s.region);
    if (box) out.push({ kind: 'cover', location: url('Named_Boxarts', box), allowedHosts: LIBRETRO_HOSTS });
    const titleShot = pickThumbnail(idx.files.Named_Titles, stem, s.title, s.region);
    const snap = pickThumbnail(idx.files.Named_Snaps, stem, s.title, s.region);
    if (snap) out.push({ kind: 'background', location: url('Named_Snaps', snap), allowedHosts: LIBRETRO_HOSTS });
    if (titleShot) out.push({ kind: 'screenshot', location: url('Named_Titles', titleShot), allowedHosts: LIBRETRO_HOSTS });
    if (snap) out.push({ kind: 'screenshot', location: url('Named_Snaps', snap), allowedHosts: LIBRETRO_HOSTS });
    return out;
  }
}

export function libretroThumbnailsProvider(lt: LibretroThumbnails): MetadataProvider {
  return {
    id: 'libretro-thumbnails',
    label: 'libretro-thumbnails (box art & screenshots, all systems)',
    online: true,
    description: 'Box art, title screens and screenshots from the libretro-thumbnails community collection on GitHub (the artwork RetroArch uses). No account needed.',
    async lookup(s) {
      const artwork = await lt.artwork(s);
      return artwork.length ? { artwork, metadata: { source: 'libretro-thumbnails' } } : null;
    },
  };
}
