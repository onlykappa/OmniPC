import {describe,it,expect,afterAll} from 'vitest';
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {automaticSources,gameFileType,matchesGameFileType} from '../src/shared/gameDownload';
import {DownloadManager} from '../src/main/downloads/downloadManager';
import {EventBus} from '../src/main/core/events';
import {tempDir} from './helpers';

const t=tempDir();afterAll(t.cleanup);
const bytes=Buffer.from([0x50,0x4b,0x03,0x04,1,2,3,4,5,6]);
const request={name:'Fixture',url:'https://example.com/game.zip',version:null,sourceLabel:'Fixture',fileName:'game.zip',allowedHosts:['example.com'],expectedSize:bytes.length,expectedSha256:null,rejectHtml:true,gameFileType:'zip' as const};
let n=0;
function manager(response:()=>Response){return new DownloadManager(join(t.dir,String(n++)),new EventBus(),(async()=>response()) as typeof fetch);}
describe('game payload checks',()=>{
 it('checks PFS, exFAT and console package signatures without accepting a renamed executable',()=>{const pfs=Buffer.alloc(16);pfs.writeBigUInt64LE(1n,0);pfs.writeBigUInt64LE(20130315n,8);expect(matchesGameFileType(pfs,'ffpfsc')).toBe(true);expect(matchesGameFileType(Buffer.from('MZ installer'),'ffpfsc')).toBe(false);expect(matchesGameFileType(Buffer.from([0x7f,0x43,0x4e,0x54]),'pkg')).toBe(true);expect(matchesGameFileType(Buffer.from('xxxEXFAT   '),'exfat')).toBe(true);});
 it('accepts matching bytes, exact file size and checksum',async()=>{const dm=manager(()=>new Response(bytes,{headers:{'content-length':String(bytes.length)}}));const result=await dm.download({...request,expectedSha256:createHash('sha256').update(bytes).digest('hex')});expect(result.verifiedAgainstUpstream).toBe(true);expect(readFileSync(result.path)).toEqual(bytes);});
 it.each(['MZ installer','<html>ad</html>','not a game'])('rejects disguised payload %s even with the expected size',async text=>{const payload=Buffer.from(text);const dm=manager(()=>new Response(payload));await expect(dm.download({...request,expectedSize:payload.length})).rejects.toThrow(/Downloading/);expect(dm.list()[0].error).toMatch(/game file format/);});
 it('stops a disguised executable before saving any payload',async()=>{const payload=Buffer.from('MZ disguised executable payload with expected size');const dm=manager(()=>new Response(payload));await expect(dm.download({...request,expectedSize:payload.length})).rejects.toThrow();expect(dm.list()[0].receivedBytes).toBe(0);});
 it('rejects installer filenames from HTTP headers',async()=>{const dm=manager(()=>new Response(bytes,{headers:{'content-disposition':'attachment; filename="setup.exe"'}}));await expect(dm.download(request)).rejects.toThrow();expect(dm.list()[0].error).toMatch(/installer/);});
 it('rejects a mismatched content length before saving the payload',async()=>{const dm=manager(()=>new Response(bytes,{headers:{'content-length':'500'}}));await expect(dm.download(request)).rejects.toThrow();expect(dm.list()[0].receivedBytes).toBe(0);});
 it('discards an oversized chunked payload',async()=>{const dm=manager(()=>new Response(Buffer.concat([bytes,bytes])));await expect(dm.download(request)).rejects.toThrow();expect(dm.list()[0].error).toMatch(/exceeds/);});
 it('discards a truncated payload',async()=>{const dm=manager(()=>new Response(bytes.subarray(0,8)));await expect(dm.download(request)).rejects.toThrow(/wrong size/);});
 it('requires an exact size and supported single direct archive for automatic selection',()=>{const part={id:'p',filename:'game.zip',url:request.url,browserUrl:null,browserRequired:false,sizeBytes:100,sha256:null,volume:null};const source={id:'s',provider:'Fixture',version:'1',label:'',format:'zip',archivePassword:null,parts:[part]};const valid={...source,id:'hashed',parts:[{...part,sha256:'a'.repeat(64)}]};expect(automaticSources([source,{...source,id:'installer',parts:[{...part,filename:'setup.exe'}]},{...source,id:'missing-size',parts:[{...part,sizeBytes:null}]},{...source,id:'browser',parts:[{...part,browserRequired:true}]},{...source,id:'split',parts:[part,part]},valid]).map(s=>s.id)).toEqual(['hashed','s']);expect(gameFileType('setup.exe')).toBeNull();});
});
