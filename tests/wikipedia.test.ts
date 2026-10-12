import { describe, expect, it } from 'vitest';
import { cleanGameTitle, pickArticle, wikipediaProvider } from '../src/main/metadata/wikipedia';

const page = (title: string, desc: string, index: number, img = `https://upload.wikimedia.org/wikipedia/en/a/ab/${title.replace(/\W/g, '_')}.jpg`) => ({ title, index, original: { source: img }, pageprops: { 'wikibase-shortdesc': desc }, extract: `${title} is a 2013 action-adventure game.` });

describe('Wikipedia artwork', () => {
  it('cleans dump names', () => {
    expect(cleanGameTitle('Batman - Arkham Origins Xbox 360 ISO')).toBe('Batman - Arkham Origins');
    expect(cleanGameTitle('Red_Dead_Redemption (USA) [NTSC-U]')).toBe('Red Dead Redemption');
    expect(cleanGameTitle('Minecraft: Xbox 360 Edition')).toBe('Minecraft: Xbox 360 Edition');
    expect(cleanGameTitle('God of War II')).toBe('God of War II');
    expect(cleanGameTitle('Halo_3_Xbox360')).toBe('Halo 3');
  });

  it('picks the matching video game article and ignores look-alikes', () => {
    const pages = [
      page('Batman (franchise)', 'American media franchise', 1),
      page('Batman: Arkham Origins Blackgate', '2013 video game', 2),
      page('Batman: Arkham Origins', '2013 video game', 3),
    ];
    expect(pickArticle(pages, 'Batman - Arkham Origins Xbox 360 ISO')?.title).toBe('Batman: Arkham Origins');
    expect(pickArticle([page('Cuphead (video game)', '2017 video game', 1)], 'Cuphead')?.title).toBe('Cuphead (video game)');
    expect(pickArticle([page('Hollow Knight', 'Fictional character', 1)], 'Hollow Knight')).toBeNull();
    expect(pickArticle([page('Mario Kart', 'Video game series', 1)], 'Mario Kart 8 Deluxe')).toBeNull();
    // Only the best hit may match by edition prefix; short names never do.
    expect(pickArticle([page('Mario Kart 8', '2014 video game', 1)], 'Mario Kart 8 Deluxe')?.title).toBe('Mario Kart 8');
    expect(pickArticle([page('Halo 3', '2007 video game', 1), page('Halo', '2001 video game', 2)], 'Halo Wars')).toBeNull();
  });

  it('returns the infobox cover and lead text, only from Wikimedia', async () => {
    const fetchImpl = (async (u: string) => {
      expect(u).toContain('en.wikipedia.org/w/api.php');
      expect(new URL(u).searchParams.get('gsrsearch')).toBe('Dark Souls II Scholar of the First Sin Xbox 360 video game');
      // Game covers are non-free files; without this Wikipedia returns no image.
      expect(new URL(u).searchParams.get('pilicense')).toBe('any');
      return Response.json({ query: { pages: [page('Dark Souls II', '2014 video game', 1, 'https://upload.wikimedia.org/wikipedia/en/d/df/Dark_Souls_II_cover.jpg')] } });
    }) as typeof fetch;
    const p = wikipediaProvider(fetchImpl);
    const r = await p.lookup({ gameId: 1, systemId: 'x360', title: 'Dark Souls II Scholar of the First Sin', serial: null, region: null, primaryPath: 'x' }, { emulatorAppDir: () => null, fetchImpl, theGamesDbApiKey: '' });
    expect(r?.artwork?.[0]).toMatchObject({ kind: 'cover', allowedHosts: ['en.wikipedia.org', 'upload.wikimedia.org'] });
    expect(r?.metadata?.releaseYear).toBe(2013);
    const svg = wikipediaProvider((async () => Response.json({ query: { pages: [page('Cuphead', '2017 video game', 1, 'https://upload.wikimedia.org/x/logo.svg')] } })) as unknown as typeof fetch);
    expect((await svg.lookup({ gameId: 1, systemId: 'switch', title: 'Cuphead', serial: null, region: null, primaryPath: 'x' }, { emulatorAppDir: () => null, fetchImpl, theGamesDbApiKey: '' }))?.artwork).toEqual([]);
  });

  it('searches again without the console name when the first search finds nothing', async () => {
    const queries: string[] = [];
    const fetchImpl = (async (u: string) => {
      const q = new URL(u).searchParams.get('gsrsearch')!;
      queries.push(q);
      return Response.json({ query: { pages: q.includes('Xbox') ? [] : [page('Fable II', '2008 video game', 1)] } });
    }) as typeof fetch;
    const r = await wikipediaProvider(fetchImpl).lookup({ gameId: 1, systemId: 'x360', title: 'Fable II', serial: null, region: null, primaryPath: 'x' }, { emulatorAppDir: () => null, fetchImpl, theGamesDbApiKey: '' });
    expect(queries).toEqual(['Fable II Xbox 360 video game', 'Fable II video game']);
    expect(r?.sourceId).toBe('wikipedia:Fable II');
  });
});
