import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanForBios } from '../src/main/bios/scan';
import { BiosService } from '../src/main/services/biosService';
import { AdapterRegistry } from '../src/main/emulators/registry';
import { AppPaths } from '../src/main/core/paths';
import { migrate } from '../src/main/database/migrations';
import { OpsRepo } from '../src/main/database/opsRepo';
import { ps2Bios, write } from './fixtures/builders.mjs';
import { tempDir } from './helpers';

const t = tempDir();
afterAll(t.cleanup);
const dumps = join(t.dir, 'My Dumps');

function ps1Bios(): Buffer {
  const b = Buffer.alloc(512 * 1024, 0);
  b.write('Sony Computer Entertainment Inc.', 0x108, 'latin1');
  return b;
}

write(join(dumps, 'PS2', 'SCPH-70012.bin'), ps2Bios('0220AC20060905'));
write(join(dumps, 'PS1', 'scph1001.bin'), ps1Bios());
write(join(dumps, 'DS', 'bios7.bin'), Buffer.alloc(16 * 1024, 1));
write(join(dumps, 'DS', 'bios9.bin'), Buffer.alloc(4 * 1024, 1));
write(join(dumps, 'DS', 'firmware.bin'), Buffer.alloc(256 * 1024, 1));
write(join(dumps, 'gba_bios.bin'), Buffer.alloc(16 * 1024, 2));
write(join(dumps, 'disksys.rom'), Buffer.alloc(8 * 1024, 3));
write(join(dumps, 'GC', 'IPL.bin'), Buffer.alloc(2 * 1024 * 1024, 4));
write(join(dumps, 'WiiU', 'keys.txt'), '# my console\n' + 'ab'.repeat(16) + ' # common\n');
write(join(dumps, 'WiiU', 'otp.bin'), Buffer.alloc(1024, 5));
write(join(dumps, 'WiiU', 'seeprom.bin'), Buffer.alloc(512, 6));
write(join(dumps, 'PS3', 'PS3UPDAT.PUP'), Buffer.concat([Buffer.from('SCEUF\0\0\0', 'latin1'), Buffer.alloc(4096, 7)]));
write(join(dumps, 'Xbox', 'mcpx_1.0.bin'), Buffer.alloc(512, 8));
write(join(dumps, 'Xbox', 'Complex_4627.bin'), Buffer.alloc(256 * 1024, 9));
write(join(dumps, 'Xbox', 'xbox_hdd.qcow2'), Buffer.concat([Buffer.from([0x51, 0x46, 0x49, 0xfb]), Buffer.alloc(4096)]));
write(join(dumps, 'PS4', 'sys_modules', 'libSceNgs2.sprx'), Buffer.alloc(2048, 1));
// Decoys that must not be picked up
write(join(dumps, 'random-512k.bin'), Buffer.alloc(512 * 1024, 9));
write(join(dumps, 'fake.PUP'), Buffer.alloc(64, 1));
write(join(dumps, 'game.iso'), Buffer.alloc(2048, 1));
write(join(dumps, 'notes', 'keys.txt'), 'no keys here\n');

describe('Scan for BIOS & keys', () => {
  it('recognises BIOS, firmware and key files by size, name and header', async () => {
    const r = await scanForBios([dumps]);
    const by = Object.fromEntries(r.candidates.map((c) => [c.path.slice(dumps.length + 1).replace(/\\/g, '/'), `${c.systemId}:${c.valid ? 'ok' : 'bad'}`]));
    expect(by).toEqual({
      'PS2/SCPH-70012.bin': 'ps2:ok',
      'PS1/scph1001.bin': 'ps1:ok',
      'DS/bios7.bin': 'nds:ok',
      'DS/bios9.bin': 'nds:ok',
      'DS/firmware.bin': 'nds:ok',
      'gba_bios.bin': 'gba:ok',
      'disksys.rom': 'nes:ok',
      'GC/IPL.bin': 'gc:ok',
      'WiiU/keys.txt': 'wiiu:ok',
      'WiiU/otp.bin': 'wiiu:ok',
      'WiiU/seeprom.bin': 'wiiu:ok',
      'PS3/PS3UPDAT.PUP': 'ps3:ok',
      'Xbox/mcpx_1.0.bin': 'xbox:ok',
      'Xbox/Complex_4627.bin': 'xbox:ok',
      'Xbox/xbox_hdd.qcow2': 'xbox:ok',
      'PS4/sys_modules/libSceNgs2.sprx': 'ps4:ok',
      'fake.PUP': 'ps3:bad',
    });
  });

  it('copies chosen files into BIOS/<system>, never touches originals, and skips duplicates', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const paths = new AppPaths(join(t.dir, 'ud'), t.dir);
    const bios = new BiosService(new AdapterRegistry(paths), paths, new OpsRepo(db));
    const scan = await bios.scan([dumps]);
    expect(scan.found.every((f) => !f.alreadyImported)).toBe(true);
    const pick = scan.found.filter((f) => f.valid).map((f) => f.path);
    const r = await bios.importFound([...pick, join(dumps, 'fake.PUP'), join(dumps, 'random-512k.bin')]);
    expect(r.imported).toHaveLength(16);
    expect(r.skipped).toHaveLength(2);
    expect(readFileSync(join(paths.systemBiosDir('ps2'), 'SCPH-70012.bin')).equals(readFileSync(join(dumps, 'PS2', 'SCPH-70012.bin')))).toBe(true);
    expect(existsSync(join(paths.systemBiosDir('gc'), 'IPL.bin'))).toBe(true);
    expect(existsSync(join(paths.systemBiosDir('wiiu'), 'keys.txt'))).toBe(true);
    expect(existsSync(join(paths.systemBiosDir('ps3'), 'PS3UPDAT.PUP'))).toBe(true);
    expect(existsSync(join(paths.systemBiosDir('ps4'), 'libSceNgs2.sprx'))).toBe(true);
    expect(existsSync(join(dumps, 'PS2', 'SCPH-70012.bin'))).toBe(true);

    const again = await bios.scan([dumps]);
    expect(again.found.filter((f) => f.valid).every((f) => f.alreadyImported)).toBe(true);
    expect((await bios.importFound(pick)).imported).toEqual([]);
    // Scanning OmniPC's own BIOS folder is refused (it would only find itself).
    expect((await bios.scan([paths.bios])).roots).toEqual([]);
    const status = await bios.status();
    expect(status.find((s) => s.systemId === 'ps2')?.status).toBe('found');
  });
});
