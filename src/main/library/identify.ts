// Content-based game identification. Reads only headers (a few KB), never whole
// images. Results carry evidence so the UI and OmniDoctor can explain how a
// file was classified.

import { inflateRawSync, inflateSync } from 'node:zlib';
import { basename, dirname, extname } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { getSystem, systemsForExtension, systemsForFolderName, type SystemId } from '@shared/systems';
import { fileReader, openIsoVolume, parseSfo, readFileFromIso, rootEntries, withFile, type ByteReader } from './iso9660';
import { normalizePsSerial, parseGameFileName, regionFromNintendoId, regionFromPsSerial } from './names';

export interface Identification {
  systemId: SystemId | null;
  title: string;
  baseTitle: string;
  region: string | null;
  serial: string | null;
  discNumber: number | null;
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];
  /** Title found inside the image header (GameCube/Wii/PSP). */
  internalTitle: string | null;
}

async function readHead(fh: FileHandle, pos: number, len: number): Promise<Buffer> {
  return fileReader(fh)(pos, len);
}

interface Sniff {
  systemId: SystemId;
  serial?: string | null;
  internalTitle?: string | null;
  region?: string | null;
  discNumber?: number | null;
  evidence: string;
  confidence?: 'high' | 'medium';
}

/** Nintendo optical disc header (GameCube / Wii), first 0x80 bytes. */
export function sniffNintendoHeader(h: Buffer, where: string): Sniff | null {
  if (h.length < 0x60) return null;
  const isWii = h.readUInt32BE(0x18) === 0x5d1c9ea3;
  const isGc = h.readUInt32BE(0x1c) === 0xc2339f3d;
  if (!isWii && !isGc) return null;
  const id = h.toString('ascii', 0, 6).replace(/[^\x20-\x7e]/g, '');
  const title = h.toString('latin1', 0x20, 0x60).replace(/\0[\s\S]*$/, '').trim();
  return {
    systemId: isWii ? 'wii' : 'gc',
    serial: /^[A-Z0-9]{6}$/.test(id) ? id : null,
    internalTitle: title || null,
    region: regionFromNintendoId(id),
    discNumber: isGc && h[6] > 0 ? h[6] + 1 : null,
    evidence: `${isWii ? 'Wii' : 'GameCube'} disc header magic found ${where} (game ID ${id})`,
    confidence: 'high',
  };
}

async function sniffNintendo(fh: FileHandle): Promise<Sniff | null> {
  const head = await readHead(fh, 0, 0x8100);
  if (head.length < 0x60) return null;
  const magic4 = head.toString('latin1', 0, 4);
  if (magic4 === 'RVZ\x01' || magic4 === 'WIA\x01') return sniffNintendoHeader(head.subarray(0x58, 0x58 + 0x80), `in ${magic4.slice(0, 3)} container`);
  if (magic4 === 'WBFS') return sniffNintendoHeader(head.subarray(0x200, 0x280), 'in WBFS container');
  if (magic4 === 'CISO' && head.length >= 0x8080) {
    const hit = sniffNintendoHeader(head.subarray(0x8000, 0x8080), 'in CISO container');
    if (hit) return hit;
  }
  if (head.readUInt32LE(0) === 0xb10bc001) {
    // GCZ: inflate the first block to reach the disc header.
    try {
      const numBlocks = head.readUInt32LE(28);
      const p0 = head.readBigUInt64LE(32);
      const p1 = numBlocks > 1 ? head.readBigUInt64LE(40) : null;
      const dataStart = 32 + numBlocks * 12;
      const uncompressed = (p0 & (1n << 63n)) !== 0n;
      const off0 = Number(p0 & ~(1n << 63n));
      const len = p1 ? Number((p1 & ~(1n << 63n)) - BigInt(off0)) : 0x8000;
      const blk = await readHead(fh, dataStart + off0, Math.min(len, 0x40000));
      const data = uncompressed ? blk : inflateSync(blk);
      return sniffNintendoHeader(data, 'in GCZ container');
    } catch {
      return null;
    }
  }
  return sniffNintendoHeader(head, 'at image start');
}

/** Reader over a PSP-style CSO (CISO v1 with raw-deflate blocks). */
function csoReader(fh: FileHandle, head: Buffer): ByteReader | null {
  if (head.toString('latin1', 0, 4) !== 'CISO') return null;
  const headerSize = head.readUInt32LE(4);
  const blockSize = head.readUInt32LE(16);
  const align = head[21];
  if (!(headerSize === 0x18 || headerSize === 0) || blockSize !== 2048) return null;
  const raw = fileReader(fh);
  return async (pos, len) => {
    const out: Buffer[] = [];
    let p = pos;
    let remaining = len;
    while (remaining > 0) {
      const block = Math.floor(p / blockSize);
      const idx = await raw(0x18 + block * 4, 8);
      if (idx.length < 8) break;
      const a = idx.readUInt32LE(0);
      const b = idx.readUInt32LE(4);
      const plain = (a & 0x80000000) !== 0;
      const start = (a & 0x7fffffff) << align;
      const end = (b & 0x7fffffff) << align;
      const comp = await raw(start, end - start);
      let data: Buffer;
      try {
        data = plain ? comp : inflateRawSync(comp);
      } catch {
        break;
      }
      const inner = p % blockSize;
      const take = Math.min(remaining, data.length - inner);
      if (take <= 0) break;
      out.push(data.subarray(inner, inner + take));
      p += take;
      remaining -= take;
    }
    return Buffer.concat(out);
  };
}

async function sniffIso(fh: FileHandle, reader: ByteReader): Promise<Sniff | null> {
  const vol = await openIsoVolume(reader);
  if (!vol) return null;
  const sys = vol.systemId.toUpperCase();
  const root = await rootEntries(vol).catch(() => []);
  const names = new Set(root.map((e) => e.name.toUpperCase()));
  if (names.has('PSP_GAME') || sys.includes('PSP GAME')) {
    const sfo = await readFileFromIso(vol, 'PSP_GAME/PARAM.SFO');
    const p = sfo ? parseSfo(sfo) : {};
    const discId = typeof p.DISC_ID === 'string' ? p.DISC_ID : null;
    return { systemId: 'psp', serial: discId, internalTitle: typeof p.TITLE === 'string' ? p.TITLE : null, region: null, evidence: 'ISO9660 volume contains PSP_GAME', confidence: 'high' };
  }
  if (names.has('PS3_DISC.SFB') || names.has('PS3_GAME')) {
    const sfo = await readFileFromIso(vol, 'PS3_GAME/PARAM.SFO');
    const p = sfo ? parseSfo(sfo) : {};
    return { systemId: 'ps3', serial: typeof p.TITLE_ID === 'string' ? p.TITLE_ID : null, internalTitle: typeof p.TITLE === 'string' ? p.TITLE : null, evidence: 'Disc image contains PS3_DISC.SFB/PS3_GAME', confidence: 'high' };
  }
  if (names.has('SYSTEM.CNF')) {
    const cnf = (await readFileFromIso(vol, 'SYSTEM.CNF', 4096))?.toString('latin1') ?? '';
    const boot2 = /BOOT2\s*=\s*cdrom0:\\?([^;\r\n]+)/i.exec(cnf);
    const boot1 = /BOOT\s*=\s*cdrom:\\?([^;\r\n]+)/i.exec(cnf);
    if (boot2) {
      const serial = normalizePsSerial(boot2[1]);
      return { systemId: 'ps2', serial, region: serial ? regionFromPsSerial(serial) : null, evidence: `SYSTEM.CNF boots ${boot2[1].trim()} (BOOT2 = PlayStation 2)`, confidence: 'high' };
    }
    if (boot1) {
      const serial = normalizePsSerial(boot1[1]);
      return { systemId: 'ps1', serial, region: serial ? regionFromPsSerial(serial) : null, evidence: `SYSTEM.CNF boots ${boot1[1].trim()} (BOOT = PlayStation)`, confidence: 'high' };
    }
  }
  if (sys.startsWith('PLAYSTATION')) {
    // PS1 discs without SYSTEM.CNF boot PSX.EXE.
    return { systemId: vol.layout.sectorSize === 2352 ? 'ps1' : 'ps2', evidence: `ISO9660 system identifier "${vol.systemId}"`, confidence: 'medium' };
  }
  return null;
}

const XDVDFS_MAGIC = 'MICROSOFT*XBOX*MEDIA';
async function sniffXbox(fh: FileHandle): Promise<Sniff | null> {
  const probes: { base: number; system: SystemId; label: string }[] = [
    { base: 0x18300000, system: 'xbox', label: 'Xbox (Redump layout)' },
    { base: 0xfd90000, system: 'x360', label: 'Xbox 360 XGD2' },
    { base: 0x2080000, system: 'x360', label: 'Xbox 360 XGD3' },
    { base: 0, system: 'x360', label: 'XISO (extracted; Xbox or Xbox 360)' },
  ];
  for (const p of probes) {
    const h = await readHead(fh, p.base + 0x10000, 20);
    if (h.toString('latin1') === XDVDFS_MAGIC) return { systemId: p.system, evidence: `XDVDFS signature found (${p.label})`, confidence: p.base === 0 ? 'medium' : 'high' };
  }
  return null;
}

/** CHD v5: decide CD vs DVD from the first metadata tag. */
async function sniffChd(fh: FileHandle): Promise<{ media: 'cd' | 'dvd' | 'gd' | null; evidence: string } | null> {
  const h = await readHead(fh, 0, 124);
  if (h.toString('latin1', 0, 8) !== 'MComprHD') return null;
  const version = h.readUInt32BE(12);
  if (version !== 5) return { media: null, evidence: `CHD version ${version}` };
  const logical = Number(h.readBigUInt64BE(32));
  const metaOffset = Number(h.readBigUInt64BE(48));
  if (metaOffset > 0) {
    const meta = await readHead(fh, metaOffset, 4);
    const tag = meta.toString('latin1');
    if (tag === 'CHT2' || tag === 'CHCD' || tag === 'CHTR') return { media: 'cd', evidence: `CHD contains CD track metadata (${tag})` };
    if (tag === 'DVD ') return { media: 'dvd', evidence: 'CHD contains DVD metadata' };
    if (tag === 'CHGD' || tag === 'CHGT') return { media: 'gd', evidence: 'CHD contains GD-ROM metadata' };
  }
  return { media: logical > 900 * 1024 * 1024 ? 'dvd' : 'cd', evidence: `CHD logical size ${Math.round(logical / 1048576)} MB` };
}

export async function parseCueFiles(cuePath: string): Promise<string[]> {
  const text = await readFile(cuePath, 'utf8').catch(() => '');
  const out: string[] = [];
  for (const m of text.matchAll(/^\s*FILE\s+"?([^"\r\n]+?)"?\s+\w+\s*$/gim)) out.push(m[1]);
  return out;
}

export async function parseM3u(path: string): Promise<string[]> {
  const text = await readFile(path, 'utf8').catch(() => '');
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

/**
 * Identify a file. `folderChain` is the list of parent folder names (nearest
 * first) used as hints for ambiguous formats.
 */
export async function identifyFile(path: string, folderChain: string[]): Promise<Identification> {
  const ext = extname(path).toLowerCase();
  const parsed = parseGameFileName(basename(path));
  const evidence: string[] = [];
  const hinted = folderChain.flatMap((f) => systemsForFolderName(f)).map((s) => s.id);
  const candidates = systemsForExtension(ext).map((s) => s.id);
  const result: Identification = { systemId: null, title: parsed.title, baseTitle: parsed.baseTitle, region: parsed.region, serial: null, discNumber: parsed.discNumber, confidence: 'low', evidence, internalTitle: null };
  if (candidates.length === 0) return result;

  const apply = (s: Sniff) => {
    result.systemId = s.systemId;
    result.serial = s.serial ?? null;
    result.internalTitle = s.internalTitle ?? null;
    result.region = parsed.region ?? s.region ?? null;
    if (result.discNumber === null && s.discNumber) result.discNumber = s.discNumber;
    result.confidence = s.confidence ?? 'medium';
    evidence.push(s.evidence);
  };

  const unambiguous = candidates.length === 1;
  if (unambiguous) {
    result.systemId = candidates[0];
    result.confidence = 'high';
    evidence.push(`Extension ${ext} is only used by ${getSystem(candidates[0])?.name}`);
  }

  try {
    await withFile(path, async (fh) => {
      if (['.iso', '.gcm', '.rvz', '.wia', '.wbfs', '.gcz', '.ciso', '.bin', '.img', '.cso'].includes(ext)) {
        const head = await readHead(fh, 0, 0x20);
        if (ext === '.cso' || (ext === '.ciso' && head.toString('latin1', 0, 4) === 'CISO' && head.readUInt32LE(16) === 2048)) {
          const reader = csoReader(fh, head);
          const s = reader ? await sniffIso(fh, reader) : null;
          if (s) return apply(s);
        }
        const n = ['.iso', '.gcm', '.rvz', '.wia', '.wbfs', '.gcz', '.ciso'].includes(ext) ? await sniffNintendo(fh) : null;
        if (n) return apply(n);
        if (['.iso', '.bin', '.img'].includes(ext)) {
          const s = await sniffIso(fh, fileReader(fh));
          if (s) return apply(s);
        }
        if (ext === '.iso') {
          const x = await sniffXbox(fh);
          if (x) {
            // An extracted XISO can be either Xbox or 360; prefer a folder hint.
            if (x.confidence === 'medium' && hinted.includes('xbox')) x.systemId = 'xbox';
            return apply(x);
          }
        }
      } else if (ext === '.chd') {
        const c = await sniffChd(fh);
        if (c) {
          evidence.push(c.evidence);
          const pick = (opts: SystemId[]) => hinted.find((h) => opts.includes(h)) ?? null;
          if (c.media === 'dvd') result.systemId = pick(['ps2', 'psp']) ?? 'ps2';
          else if (c.media === 'cd') result.systemId = pick(['ps1', 'ps2']) ?? 'ps1';
          if (result.systemId) result.confidence = 'medium';
        }
      }
    });
  } catch (err) {
    evidence.push(`Could not read file header: ${(err as Error).message}`);
  }

  if (ext === '.cue' && !result.systemId) {
    // A cue's system is determined by its first data track.
    const files = await parseCueFiles(path);
    if (files[0]) {
      const inner = await identifyFile(`${dirname(path)}/${files[0]}`, folderChain).catch(() => null);
      if (inner?.systemId && candidates.includes(inner.systemId)) {
        result.systemId = inner.systemId;
        result.serial = inner.serial;
        result.region = result.region ?? inner.region;
        result.confidence = inner.confidence;
        evidence.push(`Determined from first track ${files[0]}: ${inner.evidence.join('; ')}`);
      }
    }
  }

  if (!result.systemId || (!unambiguous && result.confidence === 'low')) {
    const hit = hinted.find((h) => candidates.includes(h));
    if (hit) {
      result.systemId = hit;
      result.confidence = 'medium';
      evidence.push(`Folder name suggests ${getSystem(hit)?.name}`);
    }
  } else if (hinted.length && result.systemId && !hinted.includes(result.systemId) && result.confidence !== 'high') {
    evidence.push(`Folder hint (${hinted.join(', ')}) disagrees with content`);
  }

  if (result.internalTitle && !parsed.region && result.title.length < 3) result.title = result.internalTitle;
  return result;
}
