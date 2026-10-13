import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import type { CatalogGame, CatalogSnapshot, CatalogSource, CatalogTransfer, DiscoverDetail, DiscoverPage, DiscoverQuery } from '@shared/discover';
import type { AppPaths } from '../core/paths';
import type { DownloadManager } from '../downloads/downloadManager';
import type { JobManager } from '../core/jobs';
import type { EventBus } from '../core/events';
import { extractArchive } from '../downloads/archive';
import { readReleaseZip, httpsURL } from './importCatalog';

export const OVERDRIVE_RELEASE = 'https://api.github.com/repos/overdriveps5/overdrive-releases/releases/tags/v0.2.2';
interface LocalGame { id: number; serial: string | null; system_id: string; availability: string }
interface Dependencies { paths: AppPaths; downloads: DownloadManager; jobs: JobManager; bus: EventBus; localGames(): LocalGame[]; scanFolder(folder: string): Promise<void>; fetchImpl?: typeof fetch }
function atomic(file: string, value: unknown) { mkdirSync(dirname(file),{recursive:true});writeFileSync(file+'.tmp',JSON.stringify(value));renameSync(file+'.tmp',file); }
export class DiscoverService {
  private catalog: CatalogSnapshot | null = null;
  private transfers: CatalogTransfer[] = [];
  private note: string | null = null;
  private readonly root: string;
  private readonly catalogFile: string;
  private readonly historyFile: string;
  private importing = false;
  constructor(private readonly deps: Dependencies) {
    this.root=join(deps.paths.data,'Discover');this.catalogFile=join(this.root,'catalog.json');this.historyFile=join(this.root,'transfers.json');
    try { if(existsSync(this.catalogFile)){const c=JSON.parse(readFileSync(this.catalogFile,'utf8'));if(!Array.isArray(c.games)||c.games.length>50000||c.games.some((g:any)=>typeof g.id!=='string'||typeof g.title!=='string'||!Array.isArray(g.sources)))throw new Error('Invalid saved catalog');this.catalog=c;} } catch {this.note='Saved catalog was damaged. Re-import the release ZIP; the old file was preserved.';if(existsSync(this.catalogFile))copyFileSync(this.catalogFile,this.catalogFile+'.damaged-'+Date.now());}
    try { const rows=existsSync(this.historyFile)?JSON.parse(readFileSync(this.historyFile,'utf8')):[];if(!Array.isArray(rows))throw new Error('Invalid history');this.transfers=rows.filter(t=>t&&typeof t.id==='string'&&typeof t.gameId==='string').map(t=>({...t,status:t.status==='downloading'?'interrupted':t.status})); } catch { this.note='Download history could not be read. Downloaded files were left untouched.'; }
  }
  private changed(reason: string) { this.deps.bus.emit('discover.changed',{reason}); }
  private saveHistory() { atomic(this.historyFile,this.transfers);this.changed('downloads'); }
  private installed(): Map<string,number> { const result=new Map<string,number>();for(const g of this.deps.localGames())if(g.availability==='available'&&['ps4','ps5'].includes(g.system_id)&&g.serial)result.set(g.serial.replace(/[^a-z0-9]/gi,'').toUpperCase(),g.id);return result; }
  query(q: DiscoverQuery = {}): DiscoverPage {
    const installed=this.installed();const search=(q.search||'').toLowerCase().trim();
    const cards=(this.catalog?.games||[]).filter(g=>(!q.platform||g.platform===q.platform)&&(!q.genre||g.genres.includes(q.genre))&&(!search||[g.title,g.id,g.publisher,g.developer].some(v=>v.toLowerCase().includes(search)))).map(g=>{
      const libraryGameId=installed.get(g.id.toUpperCase())??null;
      const latest=this.transfers.filter(t=>t.gameId===g.id).at(-1);
      const status=libraryGameId!==null?'in-library':latest?.status==='downloading'?'downloading':latest?.file&&existsSync(latest.file)?latest.status:latest?.status==='failed'||latest?.status==='interrupted'?latest.status:'not-downloaded';
      const {sources,description,screenshots,...summary}=g;return {...summary,sourceCount:sources.length,status,libraryGameId};
    }).filter(c=>!q.status||c.status===q.status).sort((a,b)=>a.title.localeCompare(b.title)||a.id.localeCompare(b.id));
    const offset=Math.max(0,q.offset||0),limit=Math.min(200,Math.max(1,q.limit||48));
    return {items:cards.slice(offset,offset+limit) as DiscoverPage['items'],total:cards.length,catalogCount:this.catalog?.games.length||0,importedAt:this.catalog?.importedAt||null,version:this.catalog?.version||null,genres:[...new Set((this.catalog?.games||[]).flatMap(g=>g.genres))].sort(),recoveryNote:this.note};
  }
  detail(id: string): DiscoverDetail | null { const game=this.catalog?.games.find(g=>g.id===id);if(!game)return null;return {game,libraryGameId:this.installed().get(id.toUpperCase())??null,transfers:this.transfers.filter(t=>t.gameId===id).map(t=>({...t})),editions:this.catalog!.games.filter(g=>g.work!==null&&g.work===game.work&&g.id!==id).map(g=>({id:g.id,title:g.title,platform:g.platform,region:g.region}))}; }
  importZip(file: string, version='Imported ZIP'): { jobId: string } {
    if(this.importing)throw new Error('A catalog import is already running');this.importing=true;
    const job=this.deps.jobs.start('discover-import','Import Overdrive catalog',async ctx=>{
      try {ctx.step('Read catalog metadata');const catalog=await readReleaseZip(file,version);ctx.throwIfCancelled();atomic(this.catalogFile,catalog);this.catalog=catalog;this.note=null;ctx.progress(1,`${catalog.games.length} title/edition entries imported`);this.changed('catalog');return catalog.games.length;}finally{this.importing=false;}
    },{lockKey:'discover-import'});void job.done.catch(()=>{});return {jobId:job.id};
  }
  fetchOfficial(): { jobId: string } {
    if(this.importing)throw new Error('A catalog import is already running');this.importing=true;
    const job=this.deps.jobs.start('discover-import','Load Overdrive v0.2.2 catalog',async ctx=>{
      try {
        ctx.step('Check official release');const response=await (this.deps.fetchImpl??fetch)(OVERDRIVE_RELEASE,{headers:{Accept:'application/vnd.github+json','User-Agent':'OmniPC'},signal:ctx.signal});
        if(!response.ok)throw new Error(`GitHub release check failed: HTTP ${response.status}`);
        const release=await response.json() as {assets?:{name:string;browser_download_url:string;digest?:string;size:number}[]};
        const asset=release.assets?.find(a=>a.name==='Overdrive-PPSA99058.zip');
        if(!asset||!/^sha256:[a-f0-9]{64}$/i.test(asset.digest||'')||!asset.browser_download_url.startsWith('https://github.com/overdriveps5/overdrive-releases/releases/download/'))throw new Error('Official release ZIP or GitHub SHA-256 digest is missing');
        if(asset.size>256*1024*1024)throw new Error('Release ZIP exceeds import limit');
        ctx.step('Download and verify catalog package');
        const outcome=await this.deps.downloads.download({name:'Overdrive catalog package',url:asset.browser_download_url,version:'v0.2.2',sourceLabel:'Official Overdrive GitHub release',fileName:asset.name,allowedHosts:['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'],expectedSha256:asset.digest!.slice(7),expectedSize:asset.size,rejectHtml:true},ctx.signal);
        ctx.step('Recover names, artwork and sources');const catalog=await readReleaseZip(outcome.path,'v0.2.2');ctx.throwIfCancelled();atomic(this.catalogFile,catalog);this.catalog=catalog;this.note=null;this.changed('catalog');return catalog.games.length;
      }finally{this.importing=false;}
    },{lockKey:'discover-import'});void job.done.catch(()=>{});return {jobId:job.id};
  }
  private source(gameId: string, sourceId: string): {game:CatalogGame;source:CatalogSource} {const game=this.catalog?.games.find(g=>g.id===gameId),source=game?.sources.find(s=>s.id===sourceId);if(!game||!source)throw new Error('Catalog game or source no longer exists');return {game,source};}
  browserSource(gameId: string, sourceId: string, partId: string): string { const {source}=this.source(gameId,sourceId);const part=source.parts.find(p=>p.id===partId);const url=httpsURL(part?.browserUrl||part?.url);if(!url)throw new Error('Source has no valid HTTPS address');return url; }
  download(gameId: string,sourceId: string): {jobId:string} {
    const {game,source}=this.source(gameId,sourceId);
    if(source.parts.length!==1||source.parts[0].browserRequired)throw new Error('This source needs browser or multipart handling. Use Open source for its files.');
    if(this.transfers.some(t=>t.gameId===gameId&&t.status==='downloading'))throw new Error('This title already has an active download');
    const part=source.parts[0];const url=httpsURL(part.url);if(!url)throw new Error('Download source is not a valid HTTPS URL');
    const row:CatalogTransfer={id:randomUUID(),gameId,sourceId,title:game.title,status:'downloading',file:null,output:null,error:null,at:new Date().toISOString()};this.transfers.push(row);this.saveHistory();
    const job=this.deps.jobs.start('discover-download',`Download ${game.title}`,async ctx=>{
      try {
        ctx.step('Download file');const host=new URL(url).hostname;const allowedHosts=[host,...host==='archive.org'?['*.archive.org']:[],...host==='github.com'?['release-assets.githubusercontent.com','objects.githubusercontent.com']:[]];
        const result=await this.deps.downloads.download({name:game.title,url,version:source.version||null,sourceLabel:source.provider,fileName:part.filename,allowedHosts,expectedSha256:part.sha256,expectedSize:part.sizeBytes,rejectHtml:true},ctx.signal);
        row.file=result.path;row.status='downloaded';this.saveHistory();
        // Only supported dump layouts are scanned automatically; packages/images remain downloads.
        if(extname(result.path).toLowerCase()==='.zar'){ctx.step('Scan supported game dump');await this.deps.scanFolder(dirname(result.path));}
        return row.file;
      }catch(err){row.status='failed';row.error=(err as Error).message;this.saveHistory();throw err;}
    },{lockKey:`discover-download-${gameId}`});void job.done.catch(()=>{});return {jobId:job.id};
  }
  transferFile(id:string):string { const row=this.transfers.find(t=>t.id===id);if(!row?.file||!existsSync(row.file))throw new Error('Downloaded file is missing');return row.file; }
  extract(id:string):{jobId:string} {
    const row=this.transfers.find(t=>t.id===id);if(!row)throw new Error('Download is not in history');const file=this.transferFile(id);const {source}=this.source(row.gameId,row.sourceId);
    if(source.archivePassword||source.parts.length!==1||!['.zip','.7z'].includes(extname(file).toLowerCase()))throw new Error('Automatic extraction supports single ZIP/7z archives without passwords. Use your archive tool, then Add game folder.');
    const dest=join(this.deps.paths.root,'Games','Discover',`${row.gameId}-${randomUUID().slice(0,8)}`);
    const job=this.deps.jobs.start('discover-extract',`Extract ${row.title}`,async ctx=>{ctx.step('Safely extract archive');await extractArchive(file,dest);ctx.throwIfCancelled();ctx.step('Scan extracted game files');await this.deps.scanFolder(dest);row.output=dest;row.status='extracted';this.saveHistory();return dest;},{cancellable:false,lockKey:`discover-extract-${id}`});void job.done.catch(()=>{});return {jobId:job.id};
  }
  shutdown():void { for(const row of this.transfers)if(row.status==='downloading')row.status='interrupted';if(this.transfers.length)atomic(this.historyFile,this.transfers); }
}
