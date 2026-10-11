// "Scan for BIOS & keys": walks folders the user chooses and recognises
// BIOS, firmware and key files the user already has (from their own
// consoles), so they can be copied into the right BIOS/<system> folder.
// Recognition uses only sizes, file names and header bytes. Nothing is
// downloaded, originals are never moved or modified, and only small headers
// are read (large files such as firmware updates are not hashed).

import { open, readdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { SystemId } from '@shared/systems';
import { inspectPs2Bios } from './validators';

export interface BiosCandidate {
  path: string;
  sizeBytes: number;
  systemId: SystemId;
  kind: 'bios' | 'firmware' | 'keys';
  /** What OmniPC thinks this file is, e.g. "PlayStation 2 BIOS". */
  label: string;
  valid: boolean;
  detail: string;
  /** File name it gets in BIOS/<system> (the original name unless an emulator needs a fixed one). */
  destName: string;
}

const KB = 1024;
const MB = 1024 * 1024;

async function head(path: string, len: number): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** PS4 firmware modules shadPS4 can use (names as the console stores them). */
const SPRX = /^lib[\w-]+\.sprx$/i;

/** Classifies one file. Returns null when it is not a BIOS/firmware/key file OmniPC knows. */
export async function identifyBiosFile(path: string, size: number): Promise<Omit<BiosCandidate, 'path' | 'sizeBytes'> | null> {
  const name = basename(path);
  const lower = name.toLowerCase();
  const ext = extname(lower);
  const c = (systemId: SystemId, kind: BiosCandidate['kind'], label: string, valid: boolean, detail: string, destName = name) => ({ systemId, kind, label, valid, detail, destName });

  // --- exact names first (they disambiguate equal sizes) ---
  if (lower === 'bios7.bin') return c('nds', 'bios', 'Nintendo DS ARM7 BIOS', size === 16 * KB, size === 16 * KB ? '16 KB' : `Unexpected size ${size} bytes (expected 16 KB)`);
  if (lower === 'bios9.bin') return c('nds', 'bios', 'Nintendo DS ARM9 BIOS', size === 4 * KB, size === 4 * KB ? '4 KB' : `Unexpected size ${size} bytes (expected 4 KB)`);
  if (lower === 'firmware.bin' && [128 * KB, 256 * KB, 512 * KB].includes(size)) return c('nds', 'firmware', 'Nintendo DS firmware', true, `${size / KB} KB`);
  if (/^gba_?bios\.bin$/.test(lower)) return c('gba', 'bios', 'Game Boy Advance BIOS (optional)', size === 16 * KB, size === 16 * KB ? '16 KB' : `Unexpected size ${size} bytes (expected 16 KB)`, 'gba_bios.bin');
  if (lower === 'disksys.rom') return c('nes', 'bios', 'Famicom Disk System BIOS', size === 8 * KB, size === 8 * KB ? '8 KB' : `Unexpected size ${size} bytes (expected 8 KB)`);
  if (lower === 'keys.txt') {
    const text = (await head(path, Math.min(size, 256 * KB))).toString('utf8');
    const keys = text.split(/\r?\n/).filter((l) => /^\s*[0-9a-f]{32}\b/i.test(l)).length;
    return keys ? c('wiiu', 'keys', 'Wii U keys (keys.txt)', true, `${keys} key line(s)`) : null;
  }
  if (lower === 'otp.bin' && size === 1024) return c('wiiu', 'keys', 'Wii U OTP (otp.bin)', true, '1024 bytes');
  if (lower === 'seeprom.bin' && size === 512) return c('wiiu', 'keys', 'Wii U SEEPROM (seeprom.bin)', true, '512 bytes');
  if (/^ipl\.bin$/.test(lower)) return c('gc', 'bios', 'GameCube IPL (boot ROM)', size === 2 * MB, size === 2 * MB ? '2 MB' : `Unexpected size ${size} bytes (expected 2 MB)`, 'IPL.bin');
  if (SPRX.test(name) && size > 0) return c('ps4', 'firmware', 'PS4 firmware module (shadPS4)', true, `${Math.round(size / KB)} KB`);
  if (lower === 'ps3updat.pup' || ext === '.pup') {
    const h = await head(path, 8);
    const ok = h.subarray(0, 5).toString('latin1') === 'SCEUF';
    return c('ps3', 'firmware', 'PS3 system software (PS3UPDAT.PUP)', ok, ok ? `${Math.round(size / MB)} MB` : 'Not a PS3 update file (missing SCEUF header)', 'PS3UPDAT.PUP');
  }

  // --- Original Xbox (xemu) ---
  if (size === 512 && /mcpx/.test(lower)) return c('xbox', 'bios', 'Xbox MCPX boot ROM', true, '512 bytes');
  if (ext === '.qcow2') {
    const h = await head(path, 4);
    if (h.toString('latin1', 0, 3) === 'QFI' && h[3] === 0xfb) return c('xbox', 'bios', 'Xbox hard disk image (xemu)', true, `${Math.round(size / MB)} MB qcow2. Your Xbox saves live inside this image.`);
  }
  if ((size === 256 * KB || size === 1 * MB) && ext === '.bin' && /xbox|complex|cromwell|evox|xemu|4627|5838|5933|flash/.test(lower)) {
    return c('xbox', 'bios', 'Xbox flash BIOS', true, `${size / KB} KB`);
  }

  // --- PlayStation 2: ROMDIR structure ---
  if (size >= 2 * MB && size <= 16 * MB && (ext === '.bin' || ext === '.rom' || ext === '')) {
    const info = await inspectPs2Bios(path).catch(() => null);
    if (info?.valid) return c('ps2', 'bios', 'PlayStation 2 BIOS', true, info.description);
  }

  // --- PlayStation: 512 KB with the Sony copyright string near the start ---
  if (size === 512 * KB && (ext === '.bin' || ext === '.rom' || ext === '')) {
    const h = (await head(path, 0x400)).toString('latin1');
    if (/Sony Computer Entertainment/i.test(h)) return c('ps1', 'bios', 'PlayStation BIOS', true, '512 KB');
  }
  return null;
}

/** Common game/media extensions that are never BIOS files; skipped without opening them. */
const SKIP_EXT = new Set(['.iso', '.chd', '.cso', '.rvz', '.wbfs', '.wua', '.wux', '.wud', '.xiso', '.nsp', '.xci', '.7z', '.zip', '.rar', '.mp4', '.mkv', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.exe', '.dll', '.pdf', '.mp3', '.flac', '.wav', '.m3u', '.cue']);
const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'windows', 'program files', 'program files (x86)', 'node_modules', '.git']);

export interface BiosScanResult {
  candidates: BiosCandidate[];
  filesSeen: number;
  errors: string[];
}

/** Recursively scans `roots` (depth-limited) for BIOS, firmware and key files. */
export async function scanForBios(roots: string[], opts: { maxDepth?: number; signal?: AbortSignal } = {}): Promise<BiosScanResult> {
  const out: BiosScanResult = { candidates: [], filesSeen: 0, errors: [] };
  const seen = new Set<string>();
  const maxDepth = opts.maxDepth ?? 8;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (opts.signal?.aborted || depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      out.errors.push(`${dir}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && !SKIP_DIRS.has(e.name.toLowerCase())) await walk(full, depth + 1);
        continue;
      }
      if (!e.isFile() || SKIP_EXT.has(extname(e.name).toLowerCase())) continue;
      const key = full.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.filesSeen++;
      try {
        const st = await stat(full);
        if (st.size === 0) continue;
        const id = await identifyBiosFile(full, st.size);
        if (id) out.candidates.push({ path: full, sizeBytes: st.size, ...id });
      } catch (err) {
        out.errors.push(`${full}: ${(err as Error).message}`);
      }
    }
  };
  for (const r of roots) await walk(r, 0);
  out.candidates.sort((a, b) => a.systemId.localeCompare(b.systemId) || a.path.localeCompare(b.path));
  return out;
}
