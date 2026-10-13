import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yazl from 'yazl';
import { LiteralReader, recoverIndex, groupSources, readReleaseZip } from '../src/main/discover/importCatalog';
import { DiscoverService } from '../src/main/discover/service';
import { AppPaths } from '../src/main/core/paths';
import { EventBus } from '../src/main/core/events';
import { JobManager } from '../src/main/core/jobs';
import type { DownloadManager } from '../src/main/downloads/downloadManager';
const roots:string[]=[];
afterEach(()=>{for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
function dir(){const r=mkdtempSync(join(tmpdir(),'discover-test-'));roots.push(r);return r;}
const binary=(records:any[])=>Buffer.from(`header\0 // native/data/catalog.js\n var games = ${JSON.stringify(records)};\n var twins = [];\0 footer`);
const record={id:'PPSA00001',title:'Fixture game',art:{cover:'https://example.com/cover.png'},platform:'ps5',genres:['Adventure']};
const release={id:'r1',record:'source-row-1',provider:'Fixture host',format:'zip',version:'1.0',filename:'game.zip',url:'https://example.com/game.zip',requiresBrowser:false};
async function zip(file:string, entries:Record<string,Buffer>){const zip=new yazl.ZipFile();for(const [name,bytes]of Object.entries(entries))zip.addBuffer(bytes,name);zip.end();const chunks:Buffer[]=[];await new Promise<void>((resolve,reject)=>{zip.outputStream.on('data',c=>chunks.push(c));zip.outputStream.on('end',resolve);zip.outputStream.on('error',reject);});writeFileSync(file,Buffer.concat(chunks));}
async function releaseZip(root:string){const file=join(root,'release.zip');await zip(file,{'PPSA99058/eboot.bin':binary([record]),'PPSA99058/data/pages/PPSA00001.json':Buffer.from(JSON.stringify({about:['Description'],summary:'Summary',shots:[{url:'https://example.com/shot.jpg'}]})),'PPSA99058/data/releases/PPSA00001.json':Buffer.from(JSON.stringify([release]))});return file;}
function service(root:string,download:any=async()=>{throw new Error('Not expected')},locals:any[]=[]){const paths=new AppPaths(join(root,'profile'),root);paths.ensureBaseLayout();const bus=new EventBus();const jobs=new JobManager(bus);let scanned:string|null=null;const s=new DiscoverService({paths,jobs,bus,downloads:{download} as unknown as DownloadManager,localGames:()=>locals,scanFolder:async folder=>{scanned=folder;}});return {s,jobs,paths,getScanned:()=>scanned};}
describe('data-only embedded catalog import',()=>{
 it('parses JS literal hex escapes and trailing commas without executing code',()=>{
  expect(new LiteralReader('[{id:"PPSA00001",title:"A\\xAE game",art:{cover:null},},]').read()[0].title).toBe('A® game');
  for(const text of ['[(()=>1)()]','[{title:process.exit()}]','[{"__proto__":{polluted:true}}]'])expect(()=>new LiteralReader(text).read()).toThrow();
 });
 it('recovers both visible cards and edition twins, rejects duplicate IDs',()=>{
  const bytes=Buffer.from(`native/data/catalog.js\nvar games = [${JSON.stringify(record)}];\nvar twins = [${JSON.stringify({...record,id:'CUSA00002'})}];`);expect(recoverIndex(bytes)).toHaveLength(2);expect(()=>recoverIndex(binary([record,record]))).toThrow(/duplicate/);
 });
 it('joins real ZIP entries by ID and validates missing records',async()=>{
  const root=dir(),file=await releaseZip(root);const catalog=await readReleaseZip(file,'fixture');expect(catalog.games[0].title).toBe('Fixture game');expect(catalog.games[0].sources[0].parts[0].filename).toBe('game.zip');expect(catalog.games[0].screenshots).toEqual(['https://example.com/shot.jpg']);
  const bad=join(root,'missing.zip');await zip(bad,{'PPSA99058/eboot.bin':binary([record])});await expect(readReleaseZip(bad)).rejects.toThrow(/Missing/);
 });
 it('keeps provider mirrors separate, orders multipart sets and rejects duplicate records',()=>{
  const groups=groupSources([{...release,id:'p2',volume:'part 2',provider:'VikingFile',requiresBrowser:true},{...release,id:'p1',volume:'part 1',provider:'Vikingfile',requiresBrowser:true},{...release,id:'mirror',provider:'Other host',requiresBrowser:true}]);expect(groups).toHaveLength(2);expect(groups[0].parts.map(p=>p.id)).toEqual(['p1','p2']);expect(()=>groupSources([release,release])).toThrow(/duplicate/);
 });
 it('does not accept credentials, non-HTTPS sources, or unsafe file names',()=>{
  expect(groupSources([{...release,url:'file:///tmp/game'}])).toHaveLength(0);expect(groupSources([{...release,url:'https://user:secret@example.com/game'}])).toHaveLength(0);expect(groupSources([{...release,filename:'../bad.zip'}])[0].parts[0].filename).not.toContain('/');
 });
});
describe('Discover state and local Library boundary',()=>{
 it('imports once, persists across restart and matches only exact local title IDs',async()=>{
  const root=dir(),file=await releaseZip(root),{s,jobs}=service(root,undefined,[{id:12,serial:'PPSA-00001',availability:'available',system_id:'ps5'}]);await jobs.wait(s.importZip(file).jobId);expect(s.query({}).items[0].libraryGameId).toBe(12);expect(s.query({status:'not-downloaded'}).total).toBe(0);
  const restored=service(root,undefined,[{id:13,serial:'PPSA99999',availability:'available',system_id:'ps5'}]);expect(restored.s.query({}).items[0].status).toBe('not-downloaded');expect(restored.s.query({search:'PPSA00001'}).total).toBe(1);expect(restored.s.query({platform:'ps4'}).total).toBe(0);
 });
 it('an unsuccessful import preserves the previous catalog',async()=>{
  const root=dir(),{s,jobs}=service(root);await jobs.wait(s.importZip(await releaseZip(root)).jobId);const bad=join(root,'bad.zip');writeFileSync(bad,'not a zip');await jobs.wait(s.importZip(bad).jobId);expect(s.query({}).catalogCount).toBe(1);
 });
 it('stores completed file history, passes scoped download rules, and never inserts catalog-only games into Library',async()=>{
  const root=dir();let request:any;const file=join(root,'downloaded.zip');writeFileSync(file,'fixture');const {s,jobs}=service(root,async(r:any)=>{request=r;return {path:file,sha256:'0'.repeat(64),verifiedAgainstUpstream:false,sizeBytes:7};});await jobs.wait(s.importZip(await releaseZip(root)).jobId);const source=s.detail('PPSA00001')!.game.sources[0];await jobs.wait(s.download('PPSA00001',source.id).jobId);expect(request.rejectHtml).toBe(true);expect(request.allowedHosts).toEqual(['example.com']);expect(s.query({}).items[0].status).toBe('downloaded');expect(s.detail('PPSA00001')!.libraryGameId).toBeNull();expect(service(root).s.detail('PPSA00001')!.transfers[0].file).toBe(file);
 });
 it('refuses browser and split sources as one-click transfers',async()=>{
  const root=dir(),file=join(root,'browser.zip');await zip(file,{'PPSA99058/eboot.bin':binary([record]),'PPSA99058/data/pages/PPSA00001.json':Buffer.from('{}'),'PPSA99058/data/releases/PPSA00001.json':Buffer.from(JSON.stringify([{...release,requiresBrowser:true}]))});const {s,jobs}=service(root);await jobs.wait(s.importZip(file).jobId);expect(()=>s.download('PPSA00001',s.detail('PPSA00001')!.game.sources[0].id)).toThrow(/browser/);expect(s.browserSource('PPSA00001',s.detail('PPSA00001')!.game.sources[0].id,'r1')).toBe(release.url);
 });
 it('extracts a supported archive into a new folder and invokes the normal library scan',async()=>{
  const root=dir(),archive=join(root,'game.zip');await zip(archive,{'Game/eboot.bin':Buffer.from('fixture')});const {s,jobs,getScanned}=service(root,async()=>({path:archive}));await jobs.wait(s.importZip(await releaseZip(root)).jobId);await jobs.wait(s.download('PPSA00001',s.detail('PPSA00001')!.game.sources[0].id).jobId);await jobs.wait(s.extract(s.detail('PPSA00001')!.transfers[0].id).jobId);expect(getScanned()).toBeTruthy();expect(readFileSync(join(getScanned()!,'Game','eboot.bin'),'utf8')).toBe('fixture');expect(s.detail('PPSA00001')!.transfers[0].status).toBe('extracted');
 });
 it('marks unfinished transfers interrupted after restart and preserves damaged catalog data',()=>{
  const root=dir(),{paths}=service(root);const folder=join(paths.data,'Discover');mkdirSync(folder,{recursive:true});writeFileSync(join(folder,'transfers.json'),JSON.stringify([{id:'x',gameId:'PPSA00001',status:'downloading'}]));writeFileSync(join(folder,'catalog.json'),'{broken');const restored=service(root);expect(restored.s.query({}).recoveryNote).toMatch(/damaged/);
 });
});
