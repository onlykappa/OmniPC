// Filename parsing for common dump naming conventions (Redump / No-Intro / TOSEC
// style): "Title (USA) (Disc 2) (Rev 1).iso".

const REGION_MAP: Record<string, string> = {
  usa: 'USA', us: 'USA', u: 'USA', 'ntsc-u': 'USA', america: 'USA',
  europe: 'Europe', eur: 'Europe', e: 'Europe', pal: 'Europe', uk: 'Europe', germany: 'Europe', france: 'Europe', spain: 'Europe', italy: 'Europe', australia: 'Europe',
  japan: 'Japan', jpn: 'Japan', j: 'Japan', 'ntsc-j': 'Japan',
  korea: 'Korea', kor: 'Korea', asia: 'Asia', china: 'China', world: 'World', w: 'World',
};

export interface ParsedName {
  title: string;
  baseTitle: string;
  region: string | null;
  discNumber: number | null;
  discTotal: number | null;
  tags: string[];
}

export function parseGameFileName(fileName: string): ParsedName {
  let stem = fileName.replace(/\.[^.\\/]+$/, '');
  // strip a trailing ".nkit" style double extension
  stem = stem.replace(/\.(nkit|dec)$/i, '');
  const tags: string[] = [];
  const tagRe = /[([]([^)\]]*)[)\]]/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(stem))) tags.push(m[1].trim());

  let region: string | null = null;
  let discNumber: number | null = null;
  let discTotal: number | null = null;
  for (const t of tags) {
    const parts = t.split(/\s*,\s*/);
    if (!region) {
      const r = parts.map((p) => REGION_MAP[p.toLowerCase()]).find(Boolean);
      if (r) region = r;
    }
    const d = /^(?:disc|disk|cd|dvd)\s*([0-9]+)(?:\s*of\s*([0-9]+))?$/i.exec(t);
    if (d) {
      discNumber = Number(d[1]);
      if (d[2]) discTotal = Number(d[2]);
    }
  }
  // "Title - Disc 2" / "Title Disc2" without brackets
  if (discNumber === null) {
    const d = /(?:^|[\s_\-])(?:disc|disk|cd)[\s_]*([0-9]{1,2})(?:\s*of\s*([0-9]{1,2}))?\s*$/i.exec(stem.replace(tagRe, '').trim());
    if (d) {
      discNumber = Number(d[1]);
      if (d[2]) discTotal = Number(d[2]);
    }
  }
  let title = stem.replace(/[([][^)\]]*[)\]]/g, '').replace(/[_]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  title = title.replace(/(?:^|[\s\-])(?:disc|disk|cd)[\s_]*[0-9]{1,2}(?:\s*of\s*[0-9]{1,2})?\s*$/i, '').replace(/[\s\-]+$/, '').trim();
  // "Legend of Zelda, The" -> "The Legend of Zelda"
  const article = /^(.*), (The|A|An)(\s*[-:].*)?$/i.exec(title);
  if (article) title = `${article[2]} ${article[1]}${article[3] ?? ''}`;
  if (!title) title = stem.trim();
  const baseTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return { title, baseTitle, region, discNumber, discTotal, tags };
}

/** Normalises PS1/PS2 serials: "SLUS_203.12" -> "SLUS-20312". */
export function normalizePsSerial(raw: string): string | null {
  const m = /([A-Z]{4})[_\-]?(\d{3})\.?(\d{2})/i.exec(raw);
  if (!m) return null;
  return `${m[1].toUpperCase()}-${m[2]}${m[3]}`;
}

export function regionFromPsSerial(serial: string): string | null {
  const p = serial.slice(0, 4).toUpperCase();
  if (/^S[CL]U|^LSP/.test(p) || p === 'SCUS') return 'USA';
  if (/^S[CL]E|^SCED/.test(p)) return 'Europe';
  if (/^S[CL][PM]|^SLPM|^SLPS|^SCPS|^SCAJ/.test(p)) return 'Japan';
  if (/^SLK|^SCK/.test(p)) return 'Korea';
  if (/^SLA|^SCC/.test(p)) return 'Asia';
  return null;
}

export function regionFromNintendoId(id: string): string | null {
  switch (id[3]?.toUpperCase()) {
    case 'E': return 'USA';
    case 'P': case 'D': case 'F': case 'S': case 'I': case 'X': case 'Y': case 'U': return 'Europe';
    case 'J': return 'Japan';
    case 'K': return 'Korea';
    case 'W': return 'Asia';
    default: return null;
  }
}
