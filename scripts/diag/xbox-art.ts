// Temporary diagnostic (not merged): real network lookups for Xbox art.
import { pickArticle, cleanGameTitle, wikipediaProvider, WIKIMEDIA_USER_AGENT } from '../../src/main/metadata/wikipedia';
import { pickThumbnail } from '../../src/main/metadata/libretroThumbnails';

const x360 = ['Halo 3', 'Gears of War 2', 'Forza Horizon', 'Red Dead Redemption', 'Fable II', 'Minecraft Xbox 360 Edition', 'Call of Duty Black Ops II', 'Skate 3', 'Halo Reach', 'Grand Theft Auto V'];
const xbox = ['Halo 2', 'Fable', 'Jet Set Radio Future', 'Halo - Combat Evolved', 'Star Wars Knights of the Old Republic', 'Ninja Gaiden Black'];

async function wiki(title: string, systemId: string) {
  const p = wikipediaProvider(fetch);
  try {
    const r = await p.lookup({ gameId: 1, systemId, title, serial: null, region: null, primaryPath: 'x' } as any, {} as any);
    const art = r?.artwork?.[0]?.location;
    let dl = '';
    if (art) {
      const res = await fetch(art, { headers: { 'User-Agent': WIKIMEDIA_USER_AGENT }, redirect: 'manual' });
      dl = `download=${res.status} ${res.headers.get('content-type')} ${res.headers.get('content-length')}`;
    }
    console.log(`WIKI ${systemId} | ${title} => ${r ? r.sourceId : 'NULL'} | art=${art ?? 'NONE'} ${dl}`);
  } catch (e) { console.log(`WIKI ${systemId} | ${title} => THROW ${e}`); }
}

async function raw(title: string, system: string) {
  const params = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', generator: 'search', gsrlimit: '6', gsrnamespace: '0', gsrsearch: `${cleanGameTitle(title)} ${system} video game`, prop: 'pageimages|pageprops', piprop: 'original', pilicense: 'any', ppprop: 'wikibase-shortdesc|disambiguation' });
  const r = await fetch(`https://en.wikipedia.org/w/api.php?${params}`, { headers: { 'User-Agent': WIKIMEDIA_USER_AGENT } });
  const t = await r.text();
  console.log(`RAW ${title} status=${r.status}`);
  try {
    const pages = JSON.parse(t).query?.pages ?? [];
    for (const p of pages) console.log(`   [${p.index}] ${p.title} | ${p.pageprops?.['wikibase-shortdesc']} | ${p.original?.source ?? '-'}`);
    console.log(`   pick=${pickArticle(pages, title)?.title ?? 'null'}`);
  } catch { console.log(t.slice(0, 400)); }
}

async function libretro(repo: string, titles: string[]) {
  const r = await fetch(`https://api.github.com/repos/libretro-thumbnails/${repo}/git/trees/master?recursive=1`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'OmniPC', ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}) } });
  const body = await r.json() as any;
  const boxes = (body.tree ?? []).filter((e: any) => e.type === 'blob' && e.path.startsWith('Named_Boxarts/')).map((e: any) => e.path.slice(14));
  console.log(`LIBRETRO ${repo} status=${r.status} truncated=${body.truncated} boxarts=${boxes.length} sample=${boxes.slice(0, 5).join(' ; ')}`);
  for (const t of titles) console.log(`   ${t} => ${pickThumbnail(boxes, t, t, null)}`);
}

(async () => {
  for (const t of x360) await wiki(t, 'x360');
  for (const t of xbox) await wiki(t, 'xbox');
  await raw('Halo 3', 'Xbox 360');
  await raw('Gears of War 2', 'Xbox 360');
  await raw('Halo 2', 'Xbox');
  await libretro('Microsoft_-_Xbox', xbox);
  await libretro('Microsoft_-_Xbox_360', x360);
})();
