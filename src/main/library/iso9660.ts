// Minimal ISO9660 reader: enough to read the primary volume descriptor and
// files near the root (SYSTEM.CNF on PlayStation discs, PSP_GAME/PARAM.SFO).
// Works over any byte reader so it can sit on top of plain images, raw
// 2352-byte BIN images and block-compressed CSO images.

import { open, type FileHandle } from 'node:fs/promises';

export type ByteReader = (pos: number, len: number) => Promise<Buffer>;

export interface SectorLayout {
  sectorSize: 2048 | 2352;
  dataOffset: number;
}

export interface IsoVolume {
  read: ByteReader;
  layout: SectorLayout;
  systemId: string;
  volumeId: string;
  rootLba: number;
  rootSize: number;
}

export function fileReader(fh: FileHandle): ByteReader {
  return async (pos, len) => {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, pos);
    return buf.subarray(0, bytesRead);
  };
}

function readSector(vol: Pick<IsoVolume, 'read' | 'layout'>, lba: number, len = 2048): Promise<Buffer> {
  return vol.read(lba * vol.layout.sectorSize + vol.layout.dataOffset, len);
}

const LAYOUTS: SectorLayout[] = [
  { sectorSize: 2048, dataOffset: 0 },
  { sectorSize: 2352, dataOffset: 24 }, // MODE2/2352 (PS1/PS2 CD)
  { sectorSize: 2352, dataOffset: 16 }, // MODE1/2352
];

export async function openIsoVolume(read: ByteReader, layouts: SectorLayout[] = LAYOUTS): Promise<IsoVolume | null> {
  for (const layout of layouts) {
    const pvd = await readSector({ read, layout }, 16);
    if (pvd.length < 190 || pvd[0] !== 1 || pvd.toString('ascii', 1, 6) !== 'CD001') continue;
    const root = pvd.subarray(156, 156 + 34);
    return {
      read,
      layout,
      systemId: pvd.toString('ascii', 8, 40).trim(),
      volumeId: pvd.toString('ascii', 40, 72).trim(),
      rootLba: root.readUInt32LE(2),
      rootSize: root.readUInt32LE(10),
    };
  }
  return null;
}

export interface DirEntry { name: string; lba: number; size: number; isDir: boolean }

export async function readDirectory(vol: IsoVolume, lba: number, size: number): Promise<DirEntry[]> {
  const entries: DirEntry[] = [];
  const sectors = Math.min(Math.ceil(size / 2048), 64);
  for (let s = 0; s < sectors; s++) {
    const data = await readSector(vol, lba + s);
    let off = 0;
    while (off + 33 < data.length) {
      const len = data[off];
      if (len === 0) break;
      const nameLen = data[off + 32];
      const flags = data[off + 25];
      if (!(nameLen === 1 && (data[off + 33] === 0 || data[off + 33] === 1))) {
        const rawName = data.toString('ascii', off + 33, off + 33 + nameLen);
        entries.push({ name: rawName.replace(/;\d+$/, ''), lba: data.readUInt32LE(off + 2), size: data.readUInt32LE(off + 10), isDir: (flags & 2) !== 0 });
      }
      off += len;
    }
  }
  return entries;
}

export async function rootEntries(vol: IsoVolume): Promise<DirEntry[]> {
  return readDirectory(vol, vol.rootLba, vol.rootSize);
}

export async function readFileFromIso(vol: IsoVolume, path: string, maxBytes = 64 * 1024): Promise<Buffer | null> {
  const parts = path.split('/').filter(Boolean);
  let lba = vol.rootLba;
  let size = vol.rootSize;
  for (let i = 0; i < parts.length; i++) {
    const entries = await readDirectory(vol, lba, size);
    const hit = entries.find((e) => e.name.toUpperCase() === parts[i].toUpperCase());
    if (!hit) return null;
    if (i < parts.length - 1 ? !hit.isDir : hit.isDir) return null;
    lba = hit.lba;
    size = hit.size;
  }
  const out: Buffer[] = [];
  let remaining = Math.min(size, maxBytes);
  for (let s = 0; remaining > 0; s++) {
    const chunk = await readSector(vol, lba + s, Math.min(2048, remaining));
    if (!chunk.length) break;
    out.push(chunk);
    remaining -= chunk.length;
  }
  return Buffer.concat(out);
}

export async function withFile<T>(path: string, fn: (fh: FileHandle) => Promise<T>): Promise<T> {
  const fh = await open(path, 'r');
  try {
    return await fn(fh);
  } finally {
    await fh.close();
  }
}

/** Parses a PSP/PS3 PARAM.SFO into key/value pairs. */
export function parseSfo(buf: Buffer): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (buf.length < 20 || buf.readUInt32BE(0) !== 0x00505346) return out; // "\0PSF"
  const keyTable = buf.readUInt32LE(8);
  const dataTable = buf.readUInt32LE(12);
  const count = buf.readUInt32LE(16);
  for (let i = 0; i < count && 20 + i * 16 + 16 <= buf.length; i++) {
    const e = 20 + i * 16;
    const keyOff = buf.readUInt16LE(e);
    const fmt = buf.readUInt16LE(e + 2);
    const len = buf.readUInt32LE(e + 4);
    const dataOff = buf.readUInt32LE(e + 12);
    const keyEnd = buf.indexOf(0, keyTable + keyOff);
    const key = buf.toString('utf8', keyTable + keyOff, keyEnd === -1 ? undefined : keyEnd);
    const start = dataTable + dataOff;
    if (start + len > buf.length) continue;
    if (fmt === 0x0404) out[key] = buf.readUInt32LE(start);
    else out[key] = buf.toString('utf8', start, start + len).replace(/\0+$/, '');
  }
  return out;
}
