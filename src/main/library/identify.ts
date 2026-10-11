// Content-based game identification. Reads only headers (a few KB), never whole
// images. Results carry evidence so the UI and OmniDoctor can explain how a
// file was classified.

import { inflateRawSync, inflateSync } from 'node:zlib';
import { basename, dirname, extname, join } from 'node:path';
import { existsSync } from 'node:fs';
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
    const h = await readHead(fh, p.base + 0x10000, 32);
    if (h.toString('latin1', 0, 20) !== XDVDFS_MAGIC) continue;
    const boot = await xdvdfsBootInfo(fh, p.base, h.readUInt32LE(20), h.readUInt32LE(24)).catch(() => null);
    if (boot) return { systemId: boot.system, serial: boot.titleId, internalTitle: boot.title, evidence: `XDVDFS image boots ${boot.system === 'xbox' ? 'default.xbe' : 'default.xex'} (title ID ${boot.titleId})`, confidence: 'high' };
    return { systemId: p.system, evidence: `XDVDFS signature found (${p.label})`, confidence: p.base === 0 ? 'medium' : 'high' };
  }
  return null;
}

/**
 * Finds default.xbe (Xbox) or default.xex (Xbox 360) in an XDVDFS root
 * directory and reads the title ID (and, for XBE, the title name). The
 * directory is a binary tree of entries: left/right offsets in dwords, start
 * sector, size, attributes, name length, name.
 */
async function xdvdfsBootInfo(fh: FileHandle, base: number, rootSector: number, rootSize: number): Promise<{ system: SystemId; titleId: string; title: string | null } | null> {
  if (!rootSector || !rootSize || rootSize > 1 << 20) return null;
  const dir = await readHead(fh, base + rootSector * 2048, rootSize);
  const seen = new Set<number>();
  const stack = [0];
  while (stack.length) {
    const off = stack.pop()!;
    if (seen.has(off) || off + 14 > dir.length) continue;
    seen.add(off);
    const left = dir.readUInt16LE(off) * 4;
    const right = dir.readUInt16LE(off + 2) * 4;
    if (left === 0xffff * 4) continue; // padding
    const sector = dir.readUInt32LE(off + 4);
    const size = dir.readUInt32LE(off + 8);
    const name = dir.toString('latin1', off + 14, off + 14 + dir[off + 13]).toLowerCase();
    if (left) stack.push(left);
    if (right) stack.push(right);
    const at = base + sector * 2048;
    if (name === 'default.xbe') {
      const h = await readHead(fh, at, Math.min(size, 0x1000));
      if (h.toString('latin1', 0, 4) !== 'XBEH') return null;
      const cert = h.readUInt32LE(0x118) - h.readUInt32LE(0x104);
      const c = cert >= 0 && cert + 0x5c <= h.length ? h.subarray(cert) : await readHead(fh, at + cert, 0x5c);
      const titleId = c.readUInt32LE(8).toString(16).toUpperCase().padStart(8, '0');
      const title = c.toString('utf16le', 0x0c, 0x5c).replace(/\0[\s\S]*$/, '').trim() || null;
      return { system: 'xbox', titleId, title };
    }
    if (name === 'default.xex') {
      const h = await readHead(fh, at, Math.min(size, 0x1000));
      if (h.toString('latin1', 0, 4) !== 'XEX2') return null;
      const count = Math.min(h.readUInt32BE(0x14), 64);
      for (let i = 0; i < count; i++) {
        if (h.readUInt32BE(0x18 + i * 8) !== 0x00040006) continue;
        const info = h.readUInt32BE(0x1c + i * 8);
        const b = info + 16 <= h.length ? h.subarray(info) : await readHead(fh, at + info, 16);
        return { system: 'x360', titleId: b.readUInt32BE(12).toString(16).toUpperCase().padStart(8, '0'), title: null };
      }
      return null;
    }
  }
  return null;
}

/** Base-game title ID for a Switch title, update or DLC ID (16 hex digits, upper case). */
export function switchBaseTitleId(id: string): string | null {
  if (!/^0100[0-9a-f]{12}$/i.test(id)) return null;
  let n = BigInt(`0x${id}`);
  const low = n & 0xfffn;
  if (low === 0x800n) n -= 0x800n; // update
  else if (low !== 0n) n = (n & ~0xfffn) - 0x1000n; // DLC: base + 0x1000 + index
  return n.toString(16).toUpperCase().padStart(16, '0');
}

/**
 * Switch title ID: from "[0100...]" in the file name, or for NSPs from the
 * ticket file name inside the (unencrypted) PFS0 header. XCI contents are
 * encrypted, so XCI files rely on the file name.
 */
export async function switchTitleId(path: string, fh?: FileHandle): Promise<string | null> {
  const fromName = /[[(]\s*(0100[0-9a-f]{12})\s*[\])]/i.exec(basename(path))?.[1];
  if (fromName) return switchBaseTitleId(fromName);
  if (!fh || !/\.nsp$/i.test(path)) return null;
  const h = await readHead(fh, 0, 16);
  if (h.toString('latin1', 0, 4) !== 'PFS0') return null;
  const count = h.readUInt32LE(4);
  const strSize = h.readUInt32LE(8);
  if (count === 0 || count > 4096 || strSize > 1 << 20) return null;
  const table = await readHead(fh, 16 + count * 24, strSize);
  for (const name of table.toString('latin1').split('\0')) {
    const m = /^(0100[0-9a-f]{12})[0-9a-f]{16}\.(tik|cert)$/i.exec(name);
    if (m) return switchBaseTitleId(m[1]);
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
/**
 * Folder-format games booted through their executable:
 *   PS4  <game>/eboot.bin + <game>/sce_sys/param.sfo (PS5: sce_sys/param.json)
 *   PS3  <game>/PS3_GAME/USRDIR/EBOOT.BIN + PS3_GAME/PARAM.SFO (disc), or
 *        <TITLEID>/USRDIR/EBOOT.BIN + <TITLEID>/PARAM.SFO (installed/PSN)
 */
export async function identifyFolderGame(path: string): Promise<Identification | null> {
  if (basename(path).toLowerCase() !== 'eboot.bin') return null;
  const dir = dirname(path);
  const folderTitle = basename(dir);
  const make = (systemId: SystemId, title: string, serial: string | null, evidence: string): Identification => {
    const parsed = parseGameFileName(title);
    return { systemId, title, baseTitle: parsed.baseTitle, region: serial ? regionFromPsSerial(serial) : null, serial, discNumber: null, confidence: 'high', evidence: [evidence], internalTitle: title };
  };
  const sfo = async (file: string) => parseSfo(await readFile(file).catch(() => Buffer.alloc(0)));
  const ps4Sfo = join(dir, 'sce_sys', 'param.sfo');
  if (existsSync(ps4Sfo)) {
    const p = await sfo(ps4Sfo);
    const serial = typeof p.TITLE_ID === 'string' ? p.TITLE_ID : null;
    return make('ps4', (typeof p.TITLE === 'string' && p.TITLE) || folderTitle, serial, 'eboot.bin with sce_sys/param.sfo (PlayStation 4 game folder)');
  }
  const ps5Json = join(dir, 'sce_sys', 'param.json');
  if (existsSync(ps5Json)) {
    let title = folderTitle;
    let serial: string | null = null;
    try {
      const j = JSON.parse(await readFile(ps5Json, 'utf8')) as { titleId?: string; localizedParameters?: Record<string, { titleName?: string }> & { defaultLanguage?: string } };
      serial = j.titleId ?? null;
      const lp = j.localizedParameters;
      const lang = lp?.defaultLanguage;
      const name = lang && typeof lp?.[lang] === 'object' ? (lp[lang] as { titleName?: string }).titleName : undefined;
      if (name) title = name;
    } catch {
      /* folder name is used */
    }
    return make('ps5', title, serial, 'eboot.bin with sce_sys/param.json (PlayStation 5 game folder)');
  }
  if (basename(dir).toUpperCase() === 'USRDIR') {
    const gameDir = dirname(dir);
    const ps3Sfo = [join(gameDir, 'PARAM.SFO'), join(gameDir, 'param.sfo')].find((f) => existsSync(f));
    if (ps3Sfo) {
      const p = await sfo(ps3Sfo);
      const serial = typeof p.TITLE_ID === 'string' ? p.TITLE_ID : null;
      const outer = basename(gameDir).toUpperCase() === 'PS3_GAME' ? basename(dirname(gameDir)) : basename(gameDir);
      return make('ps3', (typeof p.TITLE === 'string' && p.TITLE) || outer, serial, 'USRDIR/EBOOT.BIN with PARAM.SFO (PlayStation 3 game folder)');
    }
  }
  return null;
}

export async function identifyFile(path: string, folderChain: string[]): Promise<Identification> {
  const folderGame = await identifyFolderGame(path);
  if (folderGame) return folderGame;
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
      } else if (['.nsp', '.xci', '.nsz', '.xcz'].includes(ext)) {
        const id = await switchTitleId(path, fh).catch(() => null);
        if (id) {
          result.serial = id;
          evidence.push(`Switch title ID ${id}`);
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
