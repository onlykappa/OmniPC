// BIOS/firmware validators. They inspect structure only; OmniDeck never
// downloads or distributes BIOS files.

import { open, stat } from 'node:fs/promises';

export interface Ps2BiosInfo {
  valid: boolean;
  description: string;
  zone: string | null;
  version: string | null;
}

const ZONES: Record<string, string> = { J: 'Japan', A: 'USA', E: 'Europe', H: 'Asia', C: 'China', T: 'T10K', X: 'Test', P: 'Free' };

/**
 * Mirrors PCSX2's own check (pcsx2/ps2/BiosTools.cpp LoadBiosVersion): find the
 * ROMDIR "RESET" entry, walk 16-byte entries to ROMVER and read the version
 * string, e.g. "0220AC20060905" -> v2.20 USA console, 2006-09-05.
 */
export async function inspectPs2Bios(path: string): Promise<Ps2BiosInfo> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (e) {
    return { valid: false, description: `Cannot read file: ${(e as Error).message}`, zone: null, version: null };
  }
  if (size < 512 * 1024 || size > 16 * 1024 * 1024) return { valid: false, description: `Unexpected size ${size} bytes for a PS2 BIOS`, zone: null, version: null };
  const fh = await open(path, 'r');
  try {
    const scanLen = Math.min(size, 512 * 1024 * 16);
    const buf = Buffer.alloc(scanLen);
    await fh.read(buf, 0, scanLen, 0);
    let pos = -1;
    for (let i = 0; i + 16 <= buf.length; i += 16) {
      if (buf.toString('latin1', i, i + 5) === 'RESET' && buf[i + 5] === 0) {
        pos = i;
        break;
      }
    }
    if (pos === -1) return { valid: false, description: 'No PS2 ROM directory (RESET entry) found. This is not a PS2 BIOS image.', zone: null, version: null };
    let fileOffset = 0;
    for (let i = pos; i + 16 <= buf.length; i += 16) {
      const name = buf.toString('latin1', i, i + 10).replace(/\0.*$/s, '');
      if (!name) break;
      const fileSize = buf.readUInt32LE(i + 12);
      if (name === 'ROMVER') {
        const rv = Buffer.alloc(14);
        await fh.read(rv, 0, 14, fileOffset);
        const romver = rv.toString('latin1');
        if (!/^\d{4}[A-Z][A-Z]\d{8}$/.test(romver)) return { valid: false, description: 'ROMVER entry is malformed; the dump may be corrupt.', zone: null, version: null };
        const zone = ZONES[romver[4]] ?? romver[4];
        const version = `${Number(romver.slice(0, 2))}.${romver.slice(2, 4)}`;
        const date = `${romver.slice(6, 10)}-${romver.slice(10, 12)}-${romver.slice(12, 14)}`;
        const kind = romver[5] === 'C' ? 'Console' : romver[5] === 'D' ? 'Devel' : '';
        return { valid: true, description: `${zone} v${version} (${date}) ${kind}`.trim(), zone, version };
      }
      fileOffset += fileSize % 0x10 === 0 ? fileSize : (fileSize + 0x10) & ~0xf;
    }
    return { valid: false, description: 'ROM directory found but no ROMVER entry; the dump may be incomplete.', zone: null, version: null };
  } finally {
    await fh.close();
  }
}
