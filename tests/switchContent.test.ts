import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { migrate } from '../src/main/database/migrations';
import { LibraryRepo } from '../src/main/database/libraryRepo';
import { LibraryScanner } from '../src/main/library/scanner';
import { registerContent, newestUpdate } from '../src/main/emulators/ryujinx/content';
import { write } from './fixtures/builders.mjs';
import { tempDir } from './helpers';

const t = tempDir();
afterAll(t.cleanup);

/** NSP (PFS0) whose header lists the given file names. */
function nsp(names: string[]): Buffer {
  const table = Buffer.from(`${names.join('\0')}\0`, 'latin1');
  const h = Buffer.alloc(16);
  h.write('PFS0', 0, 'latin1');
  h.writeUInt32LE(names.length, 4);
  h.writeUInt32LE(table.length, 8);
  return Buffer.concat([h, Buffer.alloc(names.length * 24), table, Buffer.alloc(256)]);
}

const root = join(t.dir, 'Switch');
const base = join(root, 'Zelda BOTW [01007EF00011E000][v0].nsp');
const upd1 = join(root, 'Zelda BOTW [01007EF00011E800][v65536].nsp');
const upd2 = join(root, 'Zelda BOTW [01007EF00011E800][v196608].nsp');
const dlc = join(root, 'Zelda BOTW DLC.nsp');

describe('Switch updates and DLC', () => {
  it('keeps updates and DLC with their game instead of listing them as games', async () => {
    write(base, nsp(['aaaa.nca', '01007ef00011e0000000000000000004.tik']));
    write(upd1, nsp(['bbbb.nca']));
    write(upd2, nsp(['cccc.nca']));
    // DLC named without a title ID: found from the ticket inside the NSP.
    write(dlc, nsp(['0123456789abcdef0123456789abcdef.nca', 'feedfeedfeedfeedfeedfeedfeedfeed.cnmt.nca', '01007ef00011f0010000000000000004.tik']));
    const db = new Database(':memory:');
    migrate(db);
    const repo = new LibraryRepo(db);
    repo.addPath(root, null, null);
    await new LibraryScanner(repo, () => []).scan({ full: true });
    const games = repo.query({ limit: 50, includeUnavailable: true }).items;
    expect(games).toHaveLength(1);
    expect(games[0].discCount).toBe(1);
    const files = repo.filesForGame(games[0].id);
    expect(files[0].path).toBe(base); // the game itself is launched
    expect(files.map((f) => f.content_kind).sort()).toEqual(['dlc', 'update', 'update', null].sort());
  });

  it('registers the newest update and the DLC with Ryujinx, keeping exact title IDs', async () => {
    utimesSync(upd1, new Date(), new Date()); // newer file, older version: version number wins
    expect(await newestUpdate([upd1, upd2])).toBe(upd2);
    const data = join(t.dir, 'ryujinx');
    const notes = await registerContent(data, '01007EF00011E000', [{ path: upd1, kind: 'update' }, { path: upd2, kind: 'update' }, { path: dlc, kind: 'dlc' }]);
    expect(notes.join(' ')).toMatch(/1 DLC enabled/);
    const gameDir = join(data, 'games', '01007ef00011e000');
    const updates = JSON.parse(readFileSync(join(gameDir, 'updates.json'), 'utf8'));
    expect(updates).toEqual({ selected: upd2, paths: [upd1, upd2] });
    const dlcText = readFileSync(join(gameDir, 'dlc.json'), 'utf8');
    // 0x01007EF00011F001 is above 2^53: written as an exact integer.
    expect(dlcText).toContain(`"title_id": ${BigInt('0x01007EF00011F001').toString()}`);
    expect(dlcText).toContain('"path": "/0123456789abcdef0123456789abcdef.nca"');
    // Running again keeps the user's choices and does not duplicate entries.
    write(join(gameDir, 'updates.json'), JSON.stringify({ selected: upd1, paths: [upd1, upd2] }));
    await registerContent(data, '01007EF00011E000', [{ path: upd1, kind: 'update' }, { path: upd2, kind: 'update' }, { path: dlc, kind: 'dlc' }]);
    expect(JSON.parse(readFileSync(join(gameDir, 'updates.json'), 'utf8')).selected).toBe(upd2);
    expect(readFileSync(join(gameDir, 'dlc.json'), 'utf8').match(/"dlc_nca_list"/g)).toHaveLength(1);
  });
});
