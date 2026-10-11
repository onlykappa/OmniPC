// Nintendo Switch names, descriptions, icons, banners and screenshots from
// titledb (github.com/blawar/titledb), a community index of eShop listings.
// The images themselves are Nintendo's eShop pictures on img-eshop.cdn.nintendo.net.
//
// titledb's US.en.json is large (about 90 MB), so OmniPC downloads it only
// when the library has Switch games, reads it one entry at a time, and keeps a
// small index (name, publisher, date, description, image links) on disk for
// 30 days. Only listing fields are kept: titledb entries can carry other
// fields (e.g. "key") which OmniPC never reads or stores.

import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { ArtworkCandidate, MetadataProvider, MetadataSubject } from './providers';
import { titleKey } from './libretroThumbnails';

export const TITLEDB_URL = 'https://raw.githubusercontent.com/blawar/titledb/master/US.en.json';
export const ESHOP_IMAGE_HOSTS = ['img-eshop.cdn.nintendo.net'];
const TTL_MS = 30 * 24 * 3600 * 1000;

export interface SwitchTitle {
  id: string;
  name: string;
  publisher: string | null;
  developer: string | null;
  releaseDate: number | null;
  description: string | null;
  genre: string | null;
  players: number | null;
  icon: string | null;
  banner: string | null;
  screenshots: string[];
}

interface RawEntry {
  id?: string | null;
  name?: string | null;
  publisher?: string | null;
  developer?: string | null;
  releaseDate?: number | null;
  description?: string | null;
  category?: string[] | null;
  numberOfPlayers?: number | null;
  iconUrl?: string | null;
  bannerUrl?: string | null;
  screenshots?: string[] | null;
  isDemo?: boolean | null;
}

const eshopUrl = (u: unknown): string | null => (typeof u === 'string' && /^https:\/\/img-eshop\.cdn\.nintendo\.net\/[\w./-]+$/.test(u) ? u : null);

/** Keeps only the listing fields of one titledb entry. */
export function toSwitchTitle(e: RawEntry): SwitchTitle | null {
  if (!e.id || !/^0100[0-9a-f]{9}000$/i.test(e.id) || !e.name || e.isDemo) return null;
  return {
    id: e.id.toUpperCase(),
    name: e.name,
    publisher: e.publisher ?? null,
    developer: e.developer ?? null,
    releaseDate: typeof e.releaseDate === 'number' ? e.releaseDate : null,
    description: e.description?.trim().slice(0, 1500) || null,
    genre: e.category?.filter((c) => c && c !== 'Other').slice(0, 3).join(', ') || null,
    players: typeof e.numberOfPlayers === 'number' ? e.numberOfPlayers : null,
    icon: eshopUrl(e.iconUrl),
    banner: eshopUrl(e.bannerUrl),
    screenshots: (e.screenshots ?? []).map(eshopUrl).filter((u): u is string => !!u).slice(0, 4),
  };
}

/**
 * Parses titledb's pretty-printed JSON ({ "<nsuId>": { ... }, ... }) entry by
 * entry, so the whole file never has to be held in memory.
 */
export async function parseTitleDb(lines: AsyncIterable<string>): Promise<SwitchTitle[]> {
  const out = new Map<string, SwitchTitle>();
  let buf: string[] | null = null;
  for await (const line of lines) {
    if (buf === null) {
      if (/^ {4}"[^"]+": \{\s*$/.test(line)) buf = ['{'];
      continue;
    }
    if (/^ {4}\},?\s*$/.test(line)) {
      try {
        const t = toSwitchTitle(JSON.parse(`${buf.join('\n')}\n}`) as RawEntry);
        // Several eShop listings can share a title ID; keep the one with the most pictures.
        if (t && (!out.has(t.id) || t.screenshots.length > out.get(t.id)!.screenshots.length)) out.set(t.id, t);
      } catch {
        /* skip a malformed entry */
      }
      buf = null;
      continue;
    }
    buf.push(line);
  }
  return [...out.values()];
}

interface Index { fetchedAt: number; titles: SwitchTitle[] }

export class SwitchTitleDb {
  private loading: Promise<{ byId: Map<string, SwitchTitle>; byName: Map<string, SwitchTitle> } | null> | null = null;
  constructor(private readonly cacheDir: string, private readonly fetchImpl: typeof fetch) {}

  private get indexFile(): string {
    return join(this.cacheDir, 'switch-titledb.json');
  }

  private lookupTables() {
    if (!this.loading) {
      this.loading = this.load().catch(() => null);
      void this.loading.then((v) => { if (!v) this.loading = null; });
    }
    return this.loading;
  }

  private async load() {
    let idx = await readFile(this.indexFile, 'utf8').then((t) => JSON.parse(t) as Index).catch(() => null);
    if (!idx || Date.now() - idx.fetchedAt > TTL_MS) idx = (await this.download()) ?? idx;
    if (!idx) return null;
    const byId = new Map(idx.titles.map((t) => [t.id, t]));
    const byName = new Map<string, SwitchTitle>();
    for (const t of idx.titles) {
      const k = titleKey(t.name.replace(/[™®©]/g, ''));
      if (k && !byName.has(k)) byName.set(k, t);
    }
    return { byId, byName };
  }

  private async download(): Promise<Index | null> {
    await mkdir(this.cacheDir, { recursive: true });
    const tmp = join(this.cacheDir, 'switch-titledb.download');
    try {
      const r = await this.fetchImpl(TITLEDB_URL, { headers: { 'User-Agent': 'OmniPC' } });
      if (!r.ok || !r.body) return null;
      await pipeline(Readable.fromWeb(r.body as unknown as WebReadableStream), createWriteStream(tmp));
      const titles = await parseTitleDb(createInterface({ input: createReadStream(tmp, 'utf8'), crlfDelay: Infinity }));
      if (titles.length < 100) return null; // not the file we expect
      const idx: Index = { fetchedAt: Date.now(), titles };
      await writeFile(`${this.indexFile}.tmp`, JSON.stringify(idx));
      await rename(`${this.indexFile}.tmp`, this.indexFile);
      return idx;
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  async find(s: MetadataSubject): Promise<SwitchTitle | null> {
    const t = await this.lookupTables();
    if (!t) return null;
    if (s.serial && t.byId.has(s.serial.toUpperCase())) return t.byId.get(s.serial.toUpperCase())!;
    return t.byName.get(titleKey(s.title.replace(/[™®©]/g, ''))) ?? null;
  }

  /** For tests and diagnostics: whether a cached index exists. */
  async hasIndex(): Promise<boolean> {
    return !!(await stat(this.indexFile).catch(() => null));
  }
}

export function switchTitleDbProvider(db: SwitchTitleDb): MetadataProvider {
  return {
    id: 'switch-titledb',
    label: 'Nintendo eShop listings via titledb (Switch)',
    online: true,
    description: 'Names, descriptions, icons, banners and screenshots for Switch games from the titledb community index of eShop listings. Matched by title ID, or by name.',
    async lookup(s) {
      if (s.systemId !== 'switch') return null;
      const t = await db.find(s);
      if (!t) return null;
      const artwork: ArtworkCandidate[] = [];
      if (t.icon) artwork.push({ kind: 'cover', location: t.icon, allowedHosts: ESHOP_IMAGE_HOSTS });
      if (t.banner) artwork.push({ kind: 'background', location: t.banner, allowedHosts: ESHOP_IMAGE_HOSTS });
      for (const u of t.screenshots) artwork.push({ kind: 'screenshot', location: u, allowedHosts: ESHOP_IMAGE_HOSTS });
      const year = t.releaseDate ? Math.floor(t.releaseDate / 10000) : null;
      return {
        title: t.name.replace(/[™®©]/g, '').trim(),
        sourceId: t.id,
        artwork,
        metadata: {
          description: t.description,
          publisher: t.publisher,
          developer: t.developer,
          releaseYear: year && year > 2000 ? year : null,
          genre: t.genre,
          players: t.players ? String(t.players) : null,
          source: 'titledb',
        },
      };
    },
  };
}
