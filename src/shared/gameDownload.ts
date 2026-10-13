import type { CatalogSource } from './discover';

export type GameFileType = 'zip' | '7z' | 'rar' | 'ffpfsc' | 'ffpfs' | 'exfat' | 'pkg';
export function gameFileType(filename: string): GameFileType | null {
  const match = /\.(zip|7z|rar|ffpfsc|ffpfs|exfat|pkg)$/i.exec(filename);
  return match ? match[1].toLowerCase() as GameFileType : null;
}
export function automaticSources(sources: CatalogSource[]): CatalogSource[] {
  return sources.filter(s => s.parts.length === 1 && !s.parts[0].browserRequired &&
    gameFileType(s.parts[0].filename) && Number.isSafeInteger(s.parts[0].sizeBytes) && s.parts[0].sizeBytes! > 0)
    .sort((a,b) => Number(!!b.parts[0].sha256) - Number(!!a.parts[0].sha256));
}
export function matchesGameFileType(bytes: Uint8Array, type: GameFileType): boolean {
  const prefix = (...expected: number[]) => expected.every((n,i) => bytes[i] === n);
  if(type === 'pkg') return prefix(0x7f,0x43,0x4e,0x54);
  if(type === 'exfat') return bytes.length >= 11 && String.fromCharCode(...bytes.slice(3,11)) === 'EXFAT   ';
  // PFS magic and header layout: https://github.com/PSBrew/MkPFS (consts.py and test_pfs.py).
  if(type === 'ffpfsc' || type === 'ffpfs') {
    if(bytes.length < 16) return false;
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    return view.getBigUint64(0,true) === 1n && view.getBigUint64(8,true) === 20130315n;
  }
  if(type === 'zip') return prefix(0x50,0x4b,0x03,0x04) || prefix(0x50,0x4b,0x05,0x06);
  if(type === '7z') return prefix(0x37,0x7a,0xbc,0xaf,0x27,0x1c);
  return prefix(0x52,0x61,0x72,0x21,0x1a,0x07,0x00) || prefix(0x52,0x61,0x72,0x21,0x1a,0x07,0x01,0x00);
}
