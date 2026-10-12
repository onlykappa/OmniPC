// Box art and a short description from the game's English Wikipedia article.
// A fallback for games the dedicated art sources do not cover (Xbox 360,
// newer Switch titles, ...). Uses the public MediaWiki API (no key): one
// search request per game; the cover is the article's infobox image on
// upload.wikimedia.org. A page is only used when Wikipedia's own short
// description says it is a video game and its title matches the game.

import { getSystem, type SystemId } from '@shared/systems';
import type { MetadataProvider, MetadataSubject } from './providers';
import { titleKey } from './libretroThumbnails';

export const WIKIPEDIA_HOSTS = ['en.wikipedia.org', 'upload.wikimedia.org'];
/** Wikimedia refuses generic User-Agents; its policy asks for a name and a contact URL. */
export const WIKIMEDIA_USER_AGENT = 'OmniPC (https://github.com/onlykappa/OmniPC)';

/** Removes dump/release noise from file-derived titles ("… Xbox 360 ISO", "[NTSC]", "v1.0"). */
export function cleanGameTitle(title: string): string {
  return title
    .replace(/[([][^)\]]*[)\]]/g, ' ')
    .replace(/[_]+/g, ' ')
    .replace(/\b(iso|xiso|xex|nsp|xci|ntsc(-[uj])?|pal|rgh|jtag|repack|update|dlc|v\d+(\.\d+)*)\b/gi, ' ')
    // The console name only as a trailing tag ("Halo 3 Xbox 360"), never inside
    // a real title ("Minecraft: Xbox 360 Edition").
    .replace(/(\s|-)+(xbox\s*360|x360|xbox)\s*$/i, ' ')
    .replace(/\s+-\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

interface WikiPage {
  title: string;
  index?: number;
  original?: { source: string };
  pageprops?: { 'wikibase-shortdesc'?: string; disambiguation?: string };
  extract?: string;
}

/** Article title without a "(2013 video game)" style suffix. */
const baseTitle = (t: string) => t.replace(/\s*\((\d{4}\s+)?video\s+game\)\s*$/i, '');

/** Picks the article for a game from search results (null when nothing is clearly right). */
export function pickArticle(pages: WikiPage[], title: string): WikiPage | null {
  const want = titleKey(cleanGameTitle(title));
  if (!want) return null;
  const games = [...pages]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .filter((p) => {
      const d = p.pageprops?.['wikibase-shortdesc'] ?? '';
      return !p.pageprops?.disambiguation && /video game/i.test(d) && !/series|franchise|character|compilation of|engine|console/i.test(d);
    });
  const key = (p: WikiPage) => titleKey(baseTitle(p.title).replace(/:/g, ' -'));
  // Exact title; then a close prefix either way ("Cuphead" / "Cuphead: Don't Deal…");
  // then, for the best search hit only, its title as the start of an edition name
  // ("Dark Souls II" for "Dark Souls II Scholar of the First Sin").
  // Prefix matches only for plain titles: "Ninja Gaiden (NES video game)" is a
  // different game from "Ninja Gaiden Black".
  const plain = games.filter((p) => !/\(/.test(baseTitle(p.title)));
  const top = games[0];
  return games.find((p) => key(p) === want)
    ?? plain.find((p) => want.startsWith(key(p)) && key(p).length >= Math.max(6, want.length * 0.6))
    ?? plain.find((p) => key(p).startsWith(want) && want.length >= Math.max(6, key(p).length * 0.6))
    ?? (top && plain.includes(top) && key(top).length >= 8 && want.startsWith(key(top)) ? top : null);
}

/** First release year mentioned in the lead ("… released in 2013 …"). */
function yearFrom(text: string | undefined): number | null {
  const m = /\b(19[7-9]\d|20[0-4]\d)\b/.exec(text ?? '');
  return m ? Number(m[1]) : null;
}

export function wikipediaProvider(fetchImpl: typeof fetch): MetadataProvider {
  return {
    id: 'wikipedia',
    label: 'Wikipedia (box art & description)',
    online: true,
    description: 'Box art and a short description from the game\'s Wikipedia article, for games other sources don\'t cover.',
    async lookup(s: MetadataSubject) {
      const title = cleanGameTitle(s.title);
      if (title.length < 2) return null;
      const system = getSystem(s.systemId as SystemId)?.name ?? '';
      const search = async (q: string) => {
        const params = new URLSearchParams({
          action: 'query', format: 'json', formatversion: '2', generator: 'search', gsrlimit: '6', gsrnamespace: '0', gsrsearch: q,
          // Box art on Wikipedia is almost always a non-free (fair use) file, which
          // PageImages leaves out unless asked for any license.
          prop: 'pageimages|pageprops|extracts', piprop: 'original', pilicense: 'any', exintro: '1', explaintext: '1', exsentences: '4', ppprop: 'wikibase-shortdesc|disambiguation',
        });
        const r = await fetchImpl(`https://en.wikipedia.org/w/api.php?${params}`, { headers: { 'User-Agent': WIKIMEDIA_USER_AGENT } });
        if (!r.ok) throw new Error(`Wikipedia search answered HTTP ${r.status}`);
        const body = (await r.json()) as { query?: { pages?: WikiPage[] } };
        return pickArticle(body.query?.pages ?? [], s.title);
      };
      // With the console name first; some articles only rank without it.
      const page = (await search(`${title} ${system} video game`)) ?? (system ? await search(`${title} video game`) : null);
      if (!page) return null;
      // The API appends tracking parameters ("…boxshot.JPG?utm_source=…"); check the path and drop them.
      const url = page.original?.source ? new URL(page.original.source) : null;
      const img = url ? `${url.origin}${url.pathname}` : null;
      const usable = url && url.protocol === 'https:' && url.host === 'upload.wikimedia.org' && /\.(jpe?g|png|webp)$/i.test(url.pathname);
      return {
        sourceId: `wikipedia:${page.title}`,
        artwork: usable && img ? [{ kind: 'cover', location: img, allowedHosts: WIKIPEDIA_HOSTS }] : [],
        metadata: { description: page.extract?.trim() || null, releaseYear: yearFrom(page.extract), source: 'Wikipedia' },
      };
    },
  };
}
