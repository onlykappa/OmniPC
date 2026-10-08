import { afterAll, describe, expect, it } from 'vitest';
import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yazl from 'yazl';
import { extractArchive, findContentRoot, isUnsafeEntry, parse7zListing, resolveInside } from '../src/main/downloads/archive';
import { tempDir } from './helpers';

const t = tempDir();
afterAll(t.cleanup);

function makeZip(path: string, entries: Record<string, string>): Promise<void> {
  const z = new yazl.ZipFile();
  for (const [n, c] of Object.entries(entries)) z.addBuffer(Buffer.from(c), n, { mtime: new Date() });
  return new Promise((r) => { z.outputStream.pipe(createWriteStream(path)).on('close', () => r()); z.end(); });
}

describe('safe extraction', () => {
  it('rejects traversal and absolute entries', () => {
    expect(isUnsafeEntry('../evil.exe')).toMatch(/traversal/);
    expect(isUnsafeEntry('a/../../evil')).toMatch(/traversal/);
    expect(isUnsafeEntry('C:/Windows/evil.dll')).toMatch(/absolute/);
    expect(isUnsafeEntry('/etc/passwd')).toMatch(/absolute/);
    expect(isUnsafeEntry('PCSX2/pcsx2-qt.exe')).toBeNull();
    expect(() => resolveInside(t.dir, '../x')).toThrow();
  });

  it('extracts a normal zip and finds the content root', async () => {
    const zip = join(t.dir, 'ok.zip');
    await makeZip(zip, { 'Dolphin-x64/Dolphin.exe': 'exe', 'Dolphin-x64/Sys/x.txt': 'sys' });
    const dest = join(t.dir, 'out');
    const r = await extractArchive(zip, dest);
    expect(r.files).toBe(2);
    expect(await findContentRoot(dest, 'dolphin.exe')).toBe(join(dest, 'Dolphin-x64'));
  });

  it('refuses a zip-slip archive without writing anything outside', async () => {
    const zip = join(t.dir, 'evil.zip');
    const z = new yazl.ZipFile();
    z.addBuffer(Buffer.from('owned'), 'safe.txt');
    // yazl validates names, so write the malicious name by patching the archive bytes afterwards.
    z.addBuffer(Buffer.from('owned'), 'AAevil.txt');
    await new Promise<void>((r) => { z.outputStream.pipe(createWriteStream(zip)).on('close', () => r()); z.end(); });
    // Same-length replacement keeps every offset in the archive valid.
    writeFileSync(zip, Buffer.from(readFileSync(zip).toString('latin1').split('AAevil.txt').join('../evil.tx'), 'latin1'));
    await expect(extractArchive(zip, join(t.dir, 'evil-out'))).rejects.toThrow(/unsafe path/);
    expect(existsSync(join(t.dir, 'evil.tx'))).toBe(false);
  });

  it('parses 7-Zip technical listings', () => {
    const text = 'Path = a\\b.exe\nFolder = -\nAttributes = A -rwxr-xr-x\n\nPath = a\nFolder = +\nAttributes = D drwxr-xr-x\n\nPath = link\nFolder = -\nAttributes = A lrwxrwxrwx\n';
    const e = parse7zListing(text);
    expect(e).toHaveLength(3);
    expect(e[1].isDir).toBe(true);
    expect(e[2].attributes).toMatch(/lrwx/);
  });
});
