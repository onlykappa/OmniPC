// Safe archive extraction. Every entry is validated before anything is written:
// no absolute paths, no drive letters, no ".." traversal, no links. After
// extraction we re-verify that every file landed inside the destination.

import { createWriteStream, existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import yauzl from 'yauzl';
import { runProcess } from '../platform/exec';
import { OmniFailure } from '../core/errors';

export function isUnsafeEntry(name: string): string | null {
  const n = name.replace(/\\/g, '/');
  if (n.includes('\0')) return 'contains NUL';
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n) || isAbsolute(n)) return 'absolute path';
  if (n.split('/').some((p) => p === '..')) return 'parent directory traversal';
  return null;
}

export function resolveInside(dest: string, entry: string): string {
  const target = resolve(dest, normalize(entry.replace(/\\/g, '/')));
  const root = resolve(dest);
  if (target !== root && !target.startsWith(root.endsWith(sep) ? root : root + sep)) {
    throw new OmniFailure({ code: 'ARCHIVE_TRAVERSAL', whatHappened: 'The archive tried to write outside its destination folder and was rejected.', detected: [entry] });
  }
  return target;
}

export async function extractArchive(archivePath: string, dest: string): Promise<{ files: number }> {
  await mkdir(dest, { recursive: true });
  const lower = archivePath.toLowerCase();
  if (lower.endsWith('.zip')) return extractZip(archivePath, dest);
  if (lower.endsWith('.7z')) return extract7z(archivePath, dest);
  throw new OmniFailure({ code: 'UNSUPPORTED_ARCHIVE', whatHappened: `OmniDeck cannot extract ${archivePath}: unsupported archive type.` });
}

function extractZip(archivePath: string, dest: string): Promise<{ files: number }> {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (err, zip) => {
      if (err || !zip) return reject(OmniFailure.wrap(err, 'ARCHIVE_INVALID', 'The downloaded ZIP archive could not be opened. It may be damaged.'));
      let files = 0;
      zip.on('error', (e) => reject(OmniFailure.wrap(e, 'ARCHIVE_INVALID', 'The ZIP archive is damaged.')));
      zip.on('end', () => resolvePromise({ files }));
      zip.on('entry', (entry: yauzl.Entry) => {
        const bad = isUnsafeEntry(entry.fileName);
        if (bad) {
          zip.close();
          return reject(new OmniFailure({ code: 'ARCHIVE_TRAVERSAL', whatHappened: 'The archive contains an unsafe path and was rejected.', detected: [`${entry.fileName}: ${bad}`] }));
        }
        // Unix symlink entries (mode 0120000) are refused.
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (mode === 0o120000) {
          zip.close();
          return reject(new OmniFailure({ code: 'ARCHIVE_LINK', whatHappened: 'The archive contains a symbolic link and was rejected.', detected: [entry.fileName] }));
        }
        let target: string;
        try {
          target = resolveInside(dest, entry.fileName);
        } catch (e) {
          zip.close();
          return reject(e);
        }
        if (/\/$/.test(entry.fileName)) {
          mkdir(target, { recursive: true }).then(() => zip.readEntry(), reject);
          return;
        }
        mkdir(dirname(target), { recursive: true }).then(() => {
          zip.openReadStream(entry, (e2, stream) => {
            if (e2 || !stream) return reject(OmniFailure.wrap(e2, 'ARCHIVE_INVALID', 'Failed reading an entry from the archive.'));
            const out = createWriteStream(target);
            stream.on('error', reject);
            out.on('error', reject);
            out.on('close', () => {
              files++;
              zip.readEntry();
            });
            stream.pipe(out);
          });
        }, reject);
      });
      zip.readEntry();
    });
  });
}

async function sevenZipBinary(): Promise<string> {
  // 7zip-bin ships 7za for every platform.
  const mod = (await import('7zip-bin')) as unknown as { path7za: string; default?: { path7za: string } };
  let p = mod.path7za ?? mod.default?.path7za;
  // When packaged with asar, binaries live in app.asar.unpacked.
  p = p.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
  if (process.platform !== 'win32') await chmod(p, 0o755).catch(() => undefined);
  return p;
}

export function parse7zListing(text: string): { path: string; isDir: boolean; attributes: string }[] {
  const entries: { path: string; isDir: boolean; attributes: string }[] = [];
  const blocks = text.split(/\r?\n\r?\n/);
  for (const b of blocks) {
    const path = /^Path = (.*)$/m.exec(b)?.[1];
    if (!path || /^Type = /m.test(b)) continue; // archive header block has Type =
    const folder = /^Folder = ([+-])$/m.exec(b)?.[1] === '+';
    const attributes = /^Attributes = (.*)$/m.exec(b)?.[1] ?? '';
    entries.push({ path, isDir: folder || attributes.startsWith('D'), attributes });
  }
  return entries;
}

async function extract7z(archivePath: string, dest: string): Promise<{ files: number }> {
  const bin = await sevenZipBinary();
  const list = await runProcess(bin, ['l', '-slt', '-ba', '--', archivePath], { timeoutMs: 120000 });
  if (list.error || list.code !== 0) {
    throw new OmniFailure({ code: 'ARCHIVE_INVALID', whatHappened: 'The downloaded 7z archive could not be read. It may be damaged or incomplete.', technical: (list.stderr || list.error?.message || '').slice(0, 2000) });
  }
  const entries = parse7zListing(list.stdout);
  for (const e of entries) {
    const bad = isUnsafeEntry(e.path);
    if (bad) throw new OmniFailure({ code: 'ARCHIVE_TRAVERSAL', whatHappened: 'The archive contains an unsafe path and was rejected.', detected: [`${e.path}: ${bad}`] });
    if (/(^|\s)l[rwx-]{9}/.test(e.attributes)) {
      throw new OmniFailure({ code: 'ARCHIVE_LINK', whatHappened: 'The archive contains a link and was rejected.', detected: [e.path] });
    }
    resolveInside(dest, e.path);
  }
  const x = await runProcess(bin, ['x', '-y', '-snl-', `-o${dest}`, '--', archivePath], { timeoutMs: 600000 });
  if (x.error || x.code !== 0) {
    throw new OmniFailure({ code: 'EXTRACT_FAILED', whatHappened: 'Extracting the archive failed.', probableCause: /space/i.test(x.stderr) ? 'The drive may be out of space.' : 'The archive may be damaged.', technical: (x.stderr || x.stdout).slice(-2000) });
  }
  // Post-extraction verification: everything must be a regular file/dir inside dest.
  const files = await verifyTree(dest);
  return { files };
}

async function verifyTree(root: string): Promise<number> {
  let count = 0;
  async function walk(d: string): Promise<void> {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const st = await lstat(p);
      if (st.isSymbolicLink()) {
        await rm(p, { force: true });
        throw new OmniFailure({ code: 'ARCHIVE_LINK', whatHappened: 'Extraction produced a symbolic link; it was removed and the install aborted.', detected: [relative(root, p)] });
      }
      if (st.isDirectory()) await walk(p);
      else count++;
    }
  }
  if (existsSync(root)) await walk(root);
  return count;
}

/**
 * Archives often wrap content in one top-level folder (e.g. "Dolphin-x64/").
 * Returns the directory that actually contains `marker` (an executable name).
 */
export async function findContentRoot(dir: string, marker: string, depth = 3): Promise<string | null> {
  const want = marker.toLowerCase();
  async function search(d: string, level: number): Promise<string | null> {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    if (entries.some((e) => e.isFile() && e.name.toLowerCase() === want)) return d;
    if (level >= depth) return null;
    for (const e of entries) if (e.isDirectory()) {
      const hit = await search(join(d, e.name), level + 1);
      if (hit) return hit;
    }
    return null;
  }
  return search(dir, 0);
}
