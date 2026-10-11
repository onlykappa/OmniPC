import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LibretroThumbnails, pickThumbnail, titleKey } from '../src/main/metadata/libretroThumbnails';
import { tempDir } from './helpers';

const t = tempDir();
afterAll(t.cleanup);
// Real file names from github.com/libretro-thumbnails/Nintendo_-_Nintendo_64 (Named_Boxarts).
const N64 = readFileSync(join(__dirname, 'fixtures', 'libretro', 'n64-boxarts.txt'), 'utf8').split('\n').filter(Boolean);

describe('libretro-thumbnails matching', () => {
  it('normalises punctuation, tags, "The" and "&"', () => {
    expect(titleKey("Aerofighter's Assault")).toBe(titleKey('AeroFighters Assault (USA).png'));
    expect(titleKey("All Star Tennis '99")).toBe(titleKey('All Star Tennis 99 (USA).png'));
    expect(titleKey('The Legend of Zelda - Ocarina of Time')).toBe(titleKey('Legend of Zelda, The - Ocarina of Time (USA).png'));
  });

  it('prefers the exact file name, then the right region, and avoids betas/demos', () => {
    expect(pickThumbnail(N64, '1080 Snowboarding (Japan, USA) (En,Ja)', '1080 Snowboarding', 'USA')).toBe('1080 Snowboarding (Japan, USA) (En,Ja).png');
    expect(pickThumbnail(N64, 'aerofighters', "Aerofighter's Assault", 'USA')).toBe('AeroFighters Assault (USA).png');
    expect(pickThumbnail(N64, 'x', 'AeroGauge', 'Europe')).toBe('AeroGauge (Europe) (En,Fr,De).png');
    expect(pickThumbnail(N64, 'x', 'Aidyn Chronicles - The First Mage', 'USA')).toBe('Aidyn Chronicles - The First Mage (USA).png');
    expect(pickThumbnail(N64, 'x', 'Armorines - Project S.W.A.R.M.', null)).toBe('Armorines - Project S.W.A.R.M. (USA).png');
    expect(pickThumbnail(N64, 'x', 'Some Unknown Game', 'USA')).toBeNull();
  });
});

describe('libretro-thumbnails provider', () => {
  it('downloads the file list once, caches it, and builds raw.githubusercontent URLs', async () => {
    let apiCalls = 0;
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).startsWith('https://api.github.com/repos/libretro-thumbnails/Nintendo_-_Nintendo_64/git/trees/master')) {
        apiCalls++;
        return Response.json({ tree: [
          ...N64.map((n) => ({ path: `Named_Boxarts/${n}`, type: 'blob' })),
          { path: 'Named_Snaps/AeroFighters Assault (USA).png', type: 'blob' },
          { path: 'Named_Titles/AeroFighters Assault (USA).png', type: 'blob' },
          { path: 'Named_Boxarts', type: 'tree' },
        ] });
      }
      return new Response('nope', { status: 404 });
    }) as typeof fetch;
    const lt = new LibretroThumbnails(t.dir, fetchImpl);
    const subj = { gameId: 1, systemId: 'n64' as const, title: "Aerofighter's Assault", serial: null, region: 'USA', primaryPath: 'D:\\Games\\N64\\Aerofighters Assault (U).z64' };
    const art = await lt.artwork(subj);
    expect(art.map((a) => [a.kind, decodeURIComponent(a.location.split('/master/')[1])])).toEqual([
      ['cover', 'Named_Boxarts/AeroFighters Assault (USA).png'],
      ['background', 'Named_Snaps/AeroFighters Assault (USA).png'],
      ['screenshot', 'Named_Titles/AeroFighters Assault (USA).png'],
      ['screenshot', 'Named_Snaps/AeroFighters Assault (USA).png'],
    ]);
    expect(art.every((a) => a.location.startsWith('https://raw.githubusercontent.com/libretro-thumbnails/Nintendo_-_Nintendo_64/master/'))).toBe(true);
    // Second lookup (and a fresh instance reading the disk cache) do not call the API again.
    await lt.artwork({ ...subj, gameId: 2, title: 'AeroGauge' });
    await new LibretroThumbnails(t.dir, fetchImpl).artwork(subj);
    expect(apiCalls).toBe(1);
    // Systems without a collection return nothing without any request.
    expect(await lt.artwork({ ...subj, systemId: 'switch' })).toEqual([]);
  });
});
