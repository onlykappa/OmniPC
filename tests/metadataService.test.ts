// MetadataService failure handling: one network hiccup must not switch a source
// off for a whole refresh, and a refresh explains why no cover was found.
import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { migrate } from '../src/main/database/migrations';
import { LibraryRepo } from '../src/main/database/libraryRepo';
import { SettingsRepo } from '../src/main/database/settingsRepo';
import { MetadataService } from '../src/main/metadata/service';
import type { MetadataProvider } from '../src/main/metadata/providers';
import { tempDir } from './helpers';

const t = tempDir();
afterAll(t.cleanup);
const JPEG = Buffer.alloc(4096, 0xff);

function setup(provider: MetadataProvider, fetchImpl: typeof fetch, titles: string[]) {
  const db = new Database(':memory:');
  migrate(db);
  const repo = new LibraryRepo(db);
  const settings = new SettingsRepo(db);
  settings.set({ artworkProviders: [provider.id], metadataOnline: true });
  const lp = repo.addPath(join(t.dir, 'games'), null, null);
  const ids = titles.map((title, i) => repo.upsertGameFile({ systemId: 'x360', title, region: 'USA', serial: null, groupKey: `g${i}`, libraryPathId: lp.id, path: join(t.dir, 'games', `${title}.iso`), sizeBytes: 1, mtimeMs: 1, discNumber: null, validation: 'ok', validationNote: null, scanId: 's' }).gameId);
  const svc = new MetadataService(repo, settings, join(t.dir, 'art'), join(t.dir, 'thumbs'), { emulatorAppDir: () => null, fetchImpl }, async () => false, [provider]);
  return { repo, svc, ids };
}

const wiki = (calls: string[], failFor: Set<string>): MetadataProvider => ({
  id: 'wikipedia', label: 'Wikipedia', online: true, description: '',
  async lookup(s) {
    calls.push(s.title);
    if (failFor.has(s.title)) throw new TypeError('fetch failed');
    return { sourceId: `wikipedia:${s.title}`, artwork: [{ kind: 'cover', location: `https://upload.wikimedia.org/${encodeURIComponent(s.title)}.jpg`, allowedHosts: ['upload.wikimedia.org'] }], metadata: { description: `${s.title} is a game.` } };
  },
});

describe('MetadataService', () => {
  it('keeps using a source after a single network failure, and stops after repeated ones', async () => {
    const calls: string[] = [];
    const img = (async () => new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } })) as unknown as typeof fetch;
    const { repo, svc, ids } = setup(wiki(calls, new Set(['A'])), img, ['A', 'B']);
    await svc.refreshAll(undefined, { onlyMissing: false, withoutCover: true });
    expect(calls).toEqual(['A', 'B']);
    expect(repo.getMetadata(ids[1]).coverPath).toBeTruthy();

    const calls2: string[] = [];
    const s2 = setup(wiki(calls2, new Set(['1', '2', '3', '4'])), img, ['1', '2', '3', '4', '5']);
    await s2.svc.refreshAll(undefined, { onlyMissing: false, withoutCover: true });
    expect(calls2).toEqual(['1', '2', '3']); // switched off after 3 in a row
  });

  it('explains why there is no cover, and a manual refresh retries skipped sources', async () => {
    const calls: string[] = [];
    const refused = (async () => new Response('Forbidden', { status: 403 })) as unknown as typeof fetch;
    const { svc, ids } = setup(wiki(calls, new Set()), refused, ['Batman - Arkham Origins']);
    const m = await svc.refresh(ids[0], { force: true });
    expect(m.coverPath).toBeNull();
    expect(m.description).toBe('Batman - Arkham Origins is a game.');
    expect(m.refreshNotes?.join(' ')).toContain('download refused by upload.wikimedia.org (HTTP 403)');

    const failing = new Set(['X']);
    const s = setup(wiki([], failing), refused, ['X']);
    for (let i = 0; i < 3; i++) await s.svc.refresh(s.ids[0]);
    failing.clear();
    // Without force the source stays skipped; a manual refresh tries it again.
    expect((await s.svc.refresh(s.ids[0])).refreshNotes?.join(' ')).toMatch(/skipped/);
    expect((await s.svc.refresh(s.ids[0], { force: true })).refreshNotes?.join(' ')).not.toMatch(/skipped/);
  });
});
