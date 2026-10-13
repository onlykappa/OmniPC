import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import yauzl from 'yauzl';
import type { CatalogGame, CatalogSnapshot, CatalogSource } from '@shared/discover';

/** Data-only JavaScript literal reader. Never evaluates code from the executable. */
export class LiteralReader {
  constructor(private readonly text: string, public offset = 0) {}
  private space() { while (/\s/.test(this.text[this.offset] ?? '') && this.offset < this.text.length) this.offset++; }
  private string(): string {
    const quote = this.text[this.offset++]; let out = '';
    while (this.offset < this.text.length) {
      const char = this.text[this.offset++];
      if (char === quote) return out;
      if (char !== '\\') { out += char; continue; }
      const escaped = this.text[this.offset++];
      const known: Record<string,string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0', '\\': '\\', '"': '"', "'": "'", '/': '/' };
      if (escaped === 'x' || escaped === 'u') {
        let hex: string;
        if (escaped === 'u' && this.text[this.offset] === '{') {
          const end = this.text.indexOf('}', ++this.offset); if (end < 0) throw new Error('Unterminated Unicode escape');
          hex = this.text.slice(this.offset, end); this.offset = end + 1;
        } else { const n = escaped === 'x' ? 2 : 4; hex = this.text.slice(this.offset, this.offset + n); this.offset += n; if (hex.length !== n) throw new Error('Short escape'); }
        if (!/^[0-9a-f]{1,6}$/i.test(hex) || parseInt(hex,16) > 0x10ffff) throw new Error('Invalid Unicode escape');
        out += String.fromCodePoint(parseInt(hex,16));
      } else if (escaped in known) out += known[escaped];
      else throw new Error('Unsupported string escape');
      if (out.length > 100000) throw new Error('Catalog string exceeds limit');
    }
    throw new Error('Unterminated string');
  }
  read(depth = 0): any {
    if (depth > 20) throw new Error('Catalog literal is too deeply nested');
    this.space(); const ch = this.text[this.offset];
    if (ch === '"' || ch === "'") return this.string();
    if (ch === '[') {
      this.offset++; const array: unknown[] = [];
      for (;;) {
        this.space(); if (this.text[this.offset] === ']') { this.offset++; return array; }
        array.push(this.read(depth+1)); if (array.length > 50000) throw new Error('Too many catalog records');
        this.space(); if (this.text[this.offset] === ']') { this.offset++; return array; }
        if (this.text[this.offset++] !== ',') throw new Error('Expected array separator');
      }
    }
    if (ch === '{') {
      this.offset++; const object = Object.create(null);
      for (;;) {
        this.space(); if (this.text[this.offset] === '}') { this.offset++; return object; }
        let key: string;
        if (/['"]/.test(this.text[this.offset])) key = this.string();
        else { const match = /^[A-Za-z_$][\w$]*/.exec(this.text.slice(this.offset)); if (!match) throw new Error('Invalid object key'); key=match[0]; this.offset+=key.length; }
        if (['__proto__','constructor','prototype'].includes(key)) throw new Error('Unsafe object key');
        this.space(); if (this.text[this.offset++] !== ':') throw new Error('Expected object separator');
        object[key] = this.read(depth+1); this.space(); if (this.text[this.offset] === '}') { this.offset++; return object; }
        if (this.text[this.offset++] !== ',') throw new Error('Expected object comma');
      }
    }
    const word = /^(true|false|null)\b/.exec(this.text.slice(this.offset));
    if (word) { this.offset += word[0].length; return JSON.parse(word[0]); }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?/i.exec(this.text.slice(this.offset));
    if (number) { this.offset+=number[0].length; const value=Number(number[0]); if (!Number.isFinite(value)) throw new Error('Invalid number'); return value; }
    throw new Error('Unsupported catalog expression; executable code is not accepted');
  }
}
export function recoverIndex(binary: Buffer): any[] {
  const text = binary.toString('utf8'); const marker = text.indexOf('native/data/catalog.js');
  if (marker < 0) throw new Error('This release has no recognized embedded catalog index. Your existing catalog is unchanged.');
  const result: any[] = [];
  for (const variable of ['games','twins']) {
    const match = new RegExp(`\\bvar ${variable} = \\[`).exec(text.slice(marker, marker + 12*1024*1024));
    if (!match) throw new Error(`Embedded ${variable} index not found`);
    const start = marker + match.index + match[0].length - 1;
    const rows = new LiteralReader(text, start).read();
    if (!Array.isArray(rows)) throw new Error('Catalog index is not an array');
    result.push(...rows);
  }
  const seen = new Set<string>();
  for (const row of result) {
    if (!row || !/^(?:PPSA|CUSA)\d{5}(?:[\w-]*)$/.test(row.id) || typeof row.title !== 'string' || !row.title.trim() || seen.has(row.id)) throw new Error('Catalog contains invalid or duplicate title IDs');
    seen.add(row.id);
  }
  return result;
}
export function httpsURL(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try { const u = new URL(value); if (u.protocol !== 'https:' || u.username || u.password) return null; return u.href; } catch { return null; }
}
const str = (v: unknown) => typeof v === 'string' ? v.slice(0,10000) : '';
const list = (v: unknown): string[] => Array.isArray(v) ? v.filter(x=>typeof x==='string').slice(0,100) : [];
const finite = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
export function groupSources(rows: any[]): CatalogSource[] {
  if (!Array.isArray(rows) || rows.length > 5000) throw new Error('Invalid source list');
  const groups = new Map<string,CatalogSource>(); const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || seen.has(row.id)) throw new Error('Invalid or duplicate source record');
    seen.add(row.id); const url = httpsURL(row.url); if (!url) continue;
    const provider = str(row.provider); const canonical = provider.toLowerCase().replace(/^www\./,'');
    const key = [str(row.record)||row.id,canonical,str(row.version),str(row.format),str(row.archivePassword)].join('|');
    let group = groups.get(key);
    if (!group) {
      group = { id: createHash('sha256').update(key).digest('hex').slice(0,24), provider, version: str(row.version), label: str(row.label).replace(/\s+part\s+\d+\s*$/i,''), format: str(row.format), archivePassword: str(row.archivePassword)||null, parts: [] }; groups.set(key,group);
    }
    if ((str(row.archivePassword)||null) !== group.archivePassword) throw new Error('Archive parts disagree on their password');
    group.parts.push({ id: row.id, url, filename: str(row.filename).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_') || `${row.id}.bin`, browserUrl: httpsURL(row.browserUrl), browserRequired: row.requiresBrowser !== false, sizeBytes: finite(row.sizeBytes), sha256: typeof row.sha256==='string' && /^[a-f0-9]{64}$/i.test(row.sha256) ? row.sha256.toLowerCase():null, volume: str(row.volume)||null });
  }
  for (const group of groups.values()) group.parts.sort((a,b)=>Number(/\d+/.exec(a.volume||'')?.[0]||0)-Number(/\d+/.exec(b.volume||'')?.[0]||0));
  return [...groups.values()];
}
export async function readReleaseZip(file: string, version = 'imported ZIP'): Promise<CatalogSnapshot> {
  if (statSync(file).size > 256*1024*1024) throw new Error('Release ZIP exceeds 256 MB');
  const selected = await new Promise<Map<string,Buffer>>((resolve,reject)=>{
    yauzl.open(file,{lazyEntries:true,validateEntrySizes:true},(err,zip)=>{
      if (err || !zip) return reject(err||new Error('Invalid ZIP'));
      const files = new Map<string,Buffer>(); let bytes=0,entries=0;
      zip.on('error',reject); zip.on('end',()=>resolve(files));
      zip.on('entry',entry=>{
        if (++entries > 10000) { zip.close(); reject(new Error('Too many ZIP entries')); return; }
        if (!/^PPSA99058\/(?:eboot\.bin|data\/(?:pages|releases)\/(?:PPSA|CUSA)\d{5}[\w-]*\.json)$/.test(entry.fileName)) { zip.readEntry(); return; }
        if (files.has(entry.fileName) || entry.uncompressedSize > 96*1024*1024 || bytes + entry.uncompressedSize > 512*1024*1024) { zip.close(); reject(new Error('Catalog ZIP exceeds limits or has duplicate entries')); return; }
        zip.openReadStream(entry,(error,stream)=>{
          if (error||!stream) { zip.close(); reject(error); return; }
          const chunks: Buffer[]=[];let size=0;
          stream.on('data',chunk=>{size+=chunk.length;if(size>entry.uncompressedSize){stream.destroy(new Error('Catalog entry exceeds declared size'));return;}chunks.push(chunk);});
          stream.on('error',error=>{zip.close();reject(error);});
          stream.on('end',()=>{bytes+=size;files.set(entry.fileName,Buffer.concat(chunks));zip.readEntry();});
        });
      });zip.readEntry();
    });
  });
  const binary=selected.get('PPSA99058/eboot.bin');if(!binary)throw new Error('Overdrive executable/index is missing');
  const index=recoverIndex(binary);const games:CatalogGame[]=[];
  for(const row of index){
    const page=selected.get(`PPSA99058/data/pages/${row.id}.json`),release=selected.get(`PPSA99058/data/releases/${row.id}.json`);
    if(!page||!release)throw new Error(`Missing page or source list for ${row.id}`);
    const p=JSON.parse(page.toString('utf8'));const art=row.art||{};
    games.push({id:row.id,title:row.title,platform:row.id.startsWith('CUSA')?'ps4':'ps5',region:str(row.region),work:finite(row.work),developer:str(row.developer),publisher:str(row.publisher),releaseDate:str(row.releaseDate),genres:list(row.genres),cover:httpsURL(art.cover),hero:httpsURL(art.hero),screenshots:Array.isArray(p.shots)?p.shots.map((s:any)=>httpsURL(s.url)).filter(Boolean).slice(0,20):[],description:list(p.about).join('\n\n')||str(p.summary),sizeGb:finite(row.sizeGb),rating:finite(row.metacritic),sources:groupSources(JSON.parse(release.toString('utf8')))});
  }
  const pageCount=[...selected.keys()].filter(n=>n.includes('/data/pages/')).length;
  if(games.length!==pageCount)throw new Error(`Recovered ${games.length} names but found ${pageCount} page records; import rejected`);
  return {version,importedAt:new Date().toISOString(),games};
}
