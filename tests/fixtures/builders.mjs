// Synthetic test fixtures. These are NOT game data: they are minimal files
// with just the header structures OmniDeck's identification code reads.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function dirRecord(name, lba, size, isDir) {
  const nameBuf = Buffer.from(name, 'ascii');
  const len = 33 + nameBuf.length + (nameBuf.length % 2 === 0 ? 1 : 0);
  const r = Buffer.alloc(len);
  r[0] = len;
  r.writeUInt32LE(lba, 2);
  r.writeUInt32BE(lba, 6);
  r.writeUInt32LE(size, 10);
  r.writeUInt32BE(size, 14);
  r[25] = isDir ? 2 : 0;
  r[32] = nameBuf.length;
  nameBuf.copy(r, 33);
  return r;
}

/**
 * Builds a tiny ISO9660 image (2048-byte sectors, or raw 2352 MODE2 when raw=true)
 * with root files { name: content }. Directories are supported one level deep via "DIR/FILE".
 */
export function buildIso({ systemId = 'PLAYSTATION', volumeId = 'TEST', files = {}, raw = false, padSectors = 0 }) {
  const sectors = [];
  const SECT = 2048;
  const put = (lba, data) => { sectors[lba] = Buffer.concat([data, Buffer.alloc(Math.max(0, SECT - data.length))]).subarray(0, SECT); };
  // layout: 16 PVD, 17 terminator, 18 root dir, 19 subdir(s), then files from 24
  let next = 24;
  const rootEntries = [dirRecord('\0', 18, SECT, true), dirRecord('\x01', 18, SECT, true)];
  const subdirs = new Map();
  for (const [path, content] of Object.entries(files)) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'latin1');
    const lba = next;
    next += Math.max(1, Math.ceil(buf.length / SECT));
    for (let i = 0; i * SECT < Math.max(buf.length, 1); i++) put(lba + i, buf.subarray(i * SECT, (i + 1) * SECT));
    const parts = path.split('/');
    if (parts.length === 1) rootEntries.push(dirRecord(`${parts[0]};1`, lba, buf.length, false));
    else {
      if (!subdirs.has(parts[0])) subdirs.set(parts[0], []);
      subdirs.get(parts[0]).push(dirRecord(`${parts[1]};1`, lba, buf.length, false));
    }
  }
  let subLba = 19;
  for (const [name, entries] of subdirs) {
    put(subLba, Buffer.concat([dirRecord('\0', subLba, SECT, true), dirRecord('\x01', 18, SECT, true), ...entries]));
    rootEntries.push(dirRecord(name, subLba, SECT, true));
    subLba++;
  }
  put(18, Buffer.concat(rootEntries));
  const pvd = Buffer.alloc(SECT);
  pvd[0] = 1;
  pvd.write('CD001', 1, 'ascii');
  pvd[6] = 1;
  pvd.write(systemId.padEnd(32), 8, 'ascii');
  pvd.write(volumeId.padEnd(32), 40, 'ascii');
  dirRecord('\0', 18, SECT, true).copy(pvd, 156);
  put(16, pvd);
  const term = Buffer.alloc(SECT);
  term[0] = 255;
  term.write('CD001', 1, 'ascii');
  put(17, term);
  const total = next + padSectors;
  const out = [];
  for (let i = 0; i < total; i++) {
    const s = sectors[i] ?? Buffer.alloc(SECT);
    if (raw) {
      const rs = Buffer.alloc(2352);
      s.copy(rs, 24);
      out.push(rs);
    } else out.push(s);
  }
  return Buffer.concat(out);
}

export function ps2Iso(serial = 'SLUS_203.12', opts = {}) {
  return buildIso({ ...opts, files: { 'SYSTEM.CNF': `BOOT2 = cdrom0:\\${serial};1\r\nVER = 1.00\r\nVMODE = NTSC\r\n`, [serial]: 'ELF' } });
}

export function ps1Bin(serial = 'SCUS_944.55') {
  return buildIso({ raw: true, files: { 'SYSTEM.CNF': `BOOT = cdrom:\\${serial};1\r\nTCB = 4\r\n` } });
}

export function nintendoHeader(id, title, wii = false) {
  const h = Buffer.alloc(0x440);
  h.write(id, 0, 'ascii');
  if (wii) h.writeUInt32BE(0x5d1c9ea3, 0x18);
  else h.writeUInt32BE(0xc2339f3d, 0x1c);
  h.write(title, 0x20, 'latin1');
  return h;
}

export function rvz(id, title, wii = false) {
  const b = Buffer.alloc(0x200);
  b.write('RVZ\x01', 0, 'latin1');
  nintendoHeader(id, title, wii).subarray(0, 0x80).copy(b, 0x58);
  return b;
}

/** A structurally valid PS2 BIOS ROMDIR (RESET, ROMDIR, EXTINFO, ROMVER) – no real BIOS code. */
export function ps2Bios(romver = '0220AC20060905') {
  const size = 4 * 1024 * 1024;
  const b = Buffer.alloc(size);
  const entries = [['RESET', 0x2000], ['ROMDIR', 0x60], ['EXTINFO', 0x30], ['ROMVER', 0x10]];
  const dirAt = 0x2700;
  let off = dirAt;
  for (const [name, fsize] of entries) {
    b.write(name, off, 'latin1');
    b.writeUInt32LE(fsize, off + 12);
    off += 16;
  }
  // ROMVER content lives at the running file offset: 0x2000 + 0x60 + 0x30
  b.write(romver, 0x2000 + 0x60 + 0x30, 'latin1');
  return b;
}

export function write(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

/** A fake emulator executable (Node script) used to test the launch router end-to-end. */
export function fakeEmulatorScript() {
  return `
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const mode = process.env.FAKE_EMU_MODE || 'ok';
if (args.includes('-testconfig') || args.includes('--version')) { console.log('Fake emulator 1.0'); process.exit(0); }
const logIdx = args.indexOf('-logfile');
const log = process.env.FAKE_EMU_LOG;
const say = (l) => { if (log) { fs.mkdirSync(path.dirname(log), { recursive: true }); fs.appendFileSync(log, l + '\\n'); } };
say('Fake emulator started with ' + JSON.stringify(args));
if (mode === 'nobios') { say('Unable to auto locate a BIOS image'); process.exit(1); }
if (mode === 'gsfail') { say('Failed to create render device. This may be due to your GPU'); process.exit(1); }
if (mode === 'crash') { process.exit(3221225477); }
setTimeout(() => { say('Shutting down cleanly'); process.exit(0); }, Number(process.env.FAKE_EMU_MS || 5200));
`;
}

/** Minimal PARAM.SFO with string entries (PS3/PS4/PSP format). */
export function sfo(entries) {
  const keys = Object.keys(entries);
  let keyTable = Buffer.alloc(0);
  let dataTable = Buffer.alloc(0);
  const index = Buffer.alloc(16 * keys.length);
  keys.forEach((k, i) => {
    const data = Buffer.from(`${entries[k]}\0`, 'utf8');
    index.writeUInt16LE(keyTable.length, i * 16);
    index.writeUInt16LE(0x0204, i * 16 + 2);
    index.writeUInt32LE(data.length, i * 16 + 4);
    index.writeUInt32LE(data.length, i * 16 + 8);
    index.writeUInt32LE(dataTable.length, i * 16 + 12);
    keyTable = Buffer.concat([keyTable, Buffer.from(`${k}\0`, 'utf8')]);
    dataTable = Buffer.concat([dataTable, data]);
  });
  const header = Buffer.alloc(20);
  header.writeUInt32BE(0x00505346, 0);
  header.writeUInt32LE(0x0101, 4);
  header.writeUInt32LE(20 + index.length, 8);
  header.writeUInt32LE(20 + index.length + keyTable.length, 12);
  header.writeUInt32LE(keys.length, 16);
  return Buffer.concat([header, index, keyTable, dataTable]);
}
