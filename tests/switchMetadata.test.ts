import { afterAll, describe, expect, it } from 'vitest';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { parseTitleDb, SwitchTitleDb, switchTitleDbProvider, TITLEDB_URL } from '../src/main/metadata/switchTitleDb';
import { switchBaseTitleId, switchTitleId, identifyFile } from '../src/main/library/identify';
import { write } from './fixtures/builders.mjs';
import { tempDir } from './helpers';

const t = tempDir();
afterAll(t.cleanup);

const img = (n: string) => `https://img-eshop.cdn.nintendo.net/i/${n}.jpg`;
/** Same layout as titledb's US.en.json: pretty-printed with 4 spaces, keyed by nsuId. */
function titledb(n = 120): string {
  const db: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) db[String(70010000000000 + i)] = { id: `0100${(0x10000 + i).toString(16).padStart(9, '0')}000`.toUpperCase(), name: `Filler Game ${i}`, iconUrl: img(`f${i}`), screenshots: [] };
  db['70010000000025'] = { bannerUrl: img('banner'), category: ['Adventure', 'Action', 'Other'], description: 'An open-air adventure.\n', developer: null, iconUrl: img('icon'), id: '01007EF00011E000', isDemo: false, key: 'never-stored', name: 'The Legend of Zelda™: Breath of the Wild', numberOfPlayers: 1, publisher: 'Nintendo', releaseDate: 20170303, screenshots: [img('s1'), img('s2'), 'https://evil.example/x.jpg'] };
  db['70010000000026'] = { id: '01007EF00011E800', name: 'Update entry', iconUrl: img('u') };
  db['70010000000027'] = { id: '0100000000010001', name: 'Demo', isDemo: true };
  return JSON.stringify(db, null, 4);
}

describe('Switch title IDs', () => {
  it('maps updates and DLC to the base game', () => {
    expect(switchBaseTitleId('01007ef00011e000')).toBe('01007EF00011E000');
    expect(switchBaseTitleId('01007EF00011E800')).toBe('01007EF00011E000');
    expect(switchBaseTitleId('01007EF00011F001')).toBe('01007EF00011E000');
    expect(switchBaseTitleId('nope')).toBeNull();
  });
  it('reads the title ID from the file name or the NSP ticket name', async () => {
    expect(await switchTitleId('Zelda BOTW [01007EF00011E000][v0].nsp')).toBe('01007EF00011E000');
    const names = ['0123456789abcdef0123456789abcdef.nca', '01007ef00011e0000000000000000004.tik'];
    const table = Buffer.from(`${names.join('\0')}\0`, 'latin1');
    const head = Buffer.alloc(16);
    head.write('PFS0', 0, 'latin1');
    head.writeUInt32LE(names.length, 4);
    head.writeUInt32LE(table.length, 8);
    const p = join(t.dir, 'sw', 'Breath of the Wild.nsp');
    write(p, Buffer.concat([head, Buffer.alloc(names.length * 24), table, Buffer.alloc(64)]));
    const fh = await open(p, 'r');
    try {
      expect(await switchTitleId(p, fh)).toBe('01007EF00011E000');
    } finally {
      await fh.close();
    }
    const id = await identifyFile(p, ['switch']);
    expect([id.systemId, id.serial]).toEqual(['switch', '01007EF00011E000']);
  });
});

describe('titledb', () => {
  it('keeps only base-game listing fields with eShop images', async () => {
    const titles = await parseTitleDb(Readable.from(titledb().split('\n')));
    const z = titles.find((x) => x.id === '01007EF00011E000')!;
    expect(titles.some((x) => x.name === 'Update entry' || x.name === 'Demo')).toBe(false);
    expect(z.screenshots).toEqual([img('s1'), img('s2')]);
    expect(JSON.stringify(z)).not.toContain('never-stored');
    expect(z.genre).toBe('Adventure, Action');
  });

  it('downloads once, caches, and matches by title ID or by name', async () => {
    let downloads = 0;
    const fetchImpl = (async (u: string) => {
      if (u !== TITLEDB_URL) return new Response('nope', { status: 404 });
      downloads++;
      return new Response(titledb());
    }) as typeof fetch;
    const dir = join(t.dir, 'cache');
    const provider = switchTitleDbProvider(new SwitchTitleDb(dir, fetchImpl));
    const env = { emulatorAppDir: () => null, fetchImpl, theGamesDbApiKey: '' };
    const byId = await provider.lookup({ gameId: 1, systemId: 'switch', title: 'botw', serial: '01007EF00011E000', region: null, primaryPath: 'x.nsp' }, env);
    expect(byId?.title).toBe('The Legend of Zelda: Breath of the Wild');
    expect(byId?.metadata).toMatchObject({ publisher: 'Nintendo', releaseYear: 2017, players: '1' });
    expect(byId?.artwork?.map((a) => a.kind)).toEqual(['cover', 'background', 'screenshot', 'screenshot']);
    // A new instance reads the cached index instead of downloading again.
    const again = switchTitleDbProvider(new SwitchTitleDb(dir, fetchImpl));
    const byName = await again.lookup({ gameId: 2, systemId: 'switch', title: 'Legend of Zelda, The - Breath of the Wild', serial: null, region: null, primaryPath: 'y.xci' }, env);
    expect(byName?.sourceId).toBe('01007EF00011E000');
    expect(downloads).toBe(1);
    expect(await again.lookup({ gameId: 3, systemId: 'ps2', title: 'x', serial: null, region: null, primaryPath: 'z.iso' }, env)).toBeNull();
  });
});
