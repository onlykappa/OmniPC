import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { inspectPs2Bios } from '../src/main/bios/validators';
import { ps2Bios, write } from './fixtures/builders.mjs';
import { tempDir } from './helpers';

const t = tempDir();
afterAll(t.cleanup);

describe('PS2 BIOS validation (ROMDIR/ROMVER)', () => {
  it('reads region and version from ROMVER', async () => {
    const p = join(t.dir, 'scph.bin');
    write(p, ps2Bios('0220AC20060905'));
    const info = await inspectPs2Bios(p);
    expect(info.valid).toBe(true);
    expect(info.zone).toBe('USA');
    expect(info.version).toBe('2.20');
    expect(info.description).toMatch(/2006-09-05/);
  });
  it('rejects files without a ROM directory', async () => {
    const p = join(t.dir, 'random.bin');
    write(p, Buffer.alloc(4 * 1024 * 1024, 7));
    expect((await inspectPs2Bios(p)).valid).toBe(false);
  });
  it('rejects implausible sizes', async () => {
    const p = join(t.dir, 'tiny.bin');
    write(p, Buffer.alloc(1000));
    expect((await inspectPs2Bios(p)).description).toMatch(/Unexpected size/);
  });
});
