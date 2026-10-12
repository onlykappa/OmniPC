import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { identifyFile } from '../src/main/library/identify';
import { pickThumbnail } from '../src/main/metadata/libretroThumbnails';
import { write } from './fixtures/builders.mjs';
import { tempDir } from './helpers';

const t = tempDir();
afterAll(t.cleanup);

/** Minimal extracted XISO: XDVDFS descriptor at sector 32, root directory, one boot executable. */
function xiso(exeName: string, exe: Buffer): Buffer {
  const img = Buffer.alloc(40 * 2048);
  img.write('MICROSOFT*XBOX*MEDIA', 0x10000, 'latin1');
  img.writeUInt32LE(33, 0x10014); // root directory sector
  img.writeUInt32LE(2048, 0x10018);
  const dir = Buffer.alloc(2048, 0xff);
  // Entry 0: a folder (right subtree -> the executable entry at dword 6)
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(6, 2); dir.writeUInt32LE(0, 4); dir.writeUInt32LE(0, 8); dir[12] = 0x10; dir[13] = 5; dir.write('media', 14, 'latin1');
  const o = 24;
  dir.writeUInt16LE(0, o); dir.writeUInt16LE(0, o + 2); dir.writeUInt32LE(34, o + 4); dir.writeUInt32LE(exe.length, o + 8); dir[o + 12] = 0x20; dir[o + 13] = exeName.length; dir.write(exeName, o + 14, 'latin1');
  dir.copy(img, 33 * 2048);
  exe.copy(img, 34 * 2048);
  return img;
}

function xbe(titleId: number, title: string): Buffer {
  const b = Buffer.alloc(0x400);
  b.write('XBEH', 0, 'latin1');
  b.writeUInt32LE(0x10000, 0x104); // base address
  b.writeUInt32LE(0x10000 + 0x200, 0x118); // certificate address
  b.writeUInt32LE(titleId, 0x200 + 8);
  b.write(title, 0x200 + 0x0c, 'utf16le');
  return b;
}

function xex(titleId: number): Buffer {
  const b = Buffer.alloc(0x200);
  b.write('XEX2', 0, 'latin1');
  b.writeUInt32BE(2, 0x14);
  b.writeUInt32BE(0x00010001, 0x18); b.writeUInt32BE(0, 0x1c);
  b.writeUInt32BE(0x00040006, 0x20); b.writeUInt32BE(0x100, 0x24); // execution info
  b.writeUInt32BE(titleId, 0x100 + 12);
  return b;
}

describe('Xbox discs', () => {
  it('reads title ID and name from default.xbe, even without a folder hint', async () => {
    const p = join(t.dir, 'games', 'halo_ce.iso');
    write(p, xiso('default.xbe', xbe(0x4d530004, 'Halo')));
    const id = await identifyFile(p, ['games']);
    expect([id.systemId, id.serial, id.internalTitle, id.confidence]).toEqual(['xbox', '4D530004', 'Halo', 'high']);
  });
  it('recognises Xbox 360 discs from default.xex', async () => {
    const p = join(t.dir, 'games', 'Gears.iso');
    write(p, xiso('default.xex', xex(0x4d5307e6)));
    const id = await identifyFile(p, ['xbox']);
    expect([id.systemId, id.serial]).toEqual(['x360', '4D5307E6']);
  });
  it('matches box art by the main title before a subtitle', () => {
    const names = ['Halo 2 (USA).png', 'Halo - Combat Evolved (USA).png', 'Halo - Combat Evolved (Europe).png'];
    expect(pickThumbnail(names, 'halo_ce', 'Halo', 'USA')).toBe('Halo - Combat Evolved (USA).png');
    expect(pickThumbnail(names, 'Halo 2', 'Halo 2', null)).toBe('Halo 2 (USA).png');
  });
});

describe('Xbox 360 game folders', () => {
  it('imports an extracted game folder through its default.xex', async () => {
    const Database = (await import('better-sqlite3')).default;
    const { migrate } = await import('../src/main/database/migrations');
    const { LibraryRepo } = await import('../src/main/database/libraryRepo');
    const { LibraryScanner } = await import('../src/main/library/scanner');
    const root = join(t.dir, 'x360lib');
    write(join(root, 'Gears of War (USA)', 'default.xex'), xex(0x4d5307e6));
    write(join(root, 'Gears of War (USA)', 'media', 'intro.xex'), xex(0x4d5307e6));
    const db = new Database(':memory:');
    migrate(db);
    const repo = new LibraryRepo(db);
    repo.addPath(root, null, null);
    await new LibraryScanner(repo, () => []).scan({ full: true });
    const games = repo.query({ limit: 10, includeUnavailable: true }).items;
    expect(games.map((g) => [g.title, g.systemId, g.serial])).toEqual([['Gears of War', 'x360', '4D5307E6']]);
  });
});
