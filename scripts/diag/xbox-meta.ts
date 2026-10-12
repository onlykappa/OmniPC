// Temporary diagnostic (not merged): the user's exact Xbox 360 titles through the real providers.
import { wikipediaProvider, WIKIMEDIA_USER_AGENT, cleanGameTitle } from '../../src/main/metadata/wikipedia';
import { LibretroThumbnails } from '../../src/main/metadata/libretroThumbnails';

const games = ['Batman - Arkham Origins Xbox 360 ISO', 'Dark Souls II Scholar of the First Sin', 'LEGO Star Wars - The Complete Saga', 'game-patches'];
(async () => {
  const lt = new LibretroThumbnails('/tmp/lt-cache', fetch);
  for (const title of games) {
    const subj = { gameId: 1, systemId: 'x360', title, serial: null, region: 'USA', primaryPath: `D:/Games/x360/${title}.iso` } as any;
    console.log(`\n=== ${title}  (clean: "${cleanGameTitle(title)}")`);
    try { console.log('  libretro:', JSON.stringify(await lt.artwork(subj))); } catch (e) { console.log('  libretro THROW', String(e)); }
    for (const q of [`${cleanGameTitle(title)} Xbox 360 video game`, `${cleanGameTitle(title)} video game`]) {
      const params = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', generator: 'search', gsrlimit: '6', gsrnamespace: '0', gsrsearch: q, prop: 'pageimages|pageprops', piprop: 'original', pilicense: 'any', ppprop: 'wikibase-shortdesc|disambiguation' });
      const r = await fetch(`https://en.wikipedia.org/w/api.php?${params}`, { headers: { 'User-Agent': WIKIMEDIA_USER_AGENT } });
      const pages = ((await r.json()) as any).query?.pages ?? [];
      console.log(`  search "${q}" status=${r.status}`);
      for (const p of pages.sort((a: any, b: any) => a.index - b.index)) console.log(`     [${p.index}] ${p.title} | ${p.pageprops?.['wikibase-shortdesc']} | ${p.original?.source?.slice(0, 90) ?? '-'}`);
    }
    try {
      const res = await wikipediaProvider(fetch).lookup(subj, {} as any);
      const art = res?.artwork?.[0]?.location;
      let dl = '';
      if (art) { const d = await fetch(art, { headers: { 'User-Agent': WIKIMEDIA_USER_AGENT }, redirect: 'manual' }); dl = `download=${d.status} ${d.headers.get('content-type')}`; }
      console.log(`  PROVIDER => ${res ? res.sourceId : 'NULL'} art=${art ?? 'NONE'} ${dl} desc=${(res?.metadata?.description ?? '').slice(0, 60)}`);
    } catch (e) { console.log('  PROVIDER THROW', String(e)); }
  }
})();
