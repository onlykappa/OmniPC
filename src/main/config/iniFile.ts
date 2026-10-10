import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { IniDocument } from './ini';

export async function loadIni(path: string): Promise<IniDocument> {
  if (!existsSync(path)) return IniDocument.empty();
  return IniDocument.parse(await readFile(path, 'utf8'));
}

/** Atomic write: a crash mid-write can never leave a half-written config. */
export async function saveIni(path: string, doc: IniDocument): Promise<void> {
  await atomicWrite(path, doc.toString());
}

export async function atomicWrite(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.omnideck-tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

/** Applies key/value sets to an INI file; returns true if the file changed. */
export async function patchIni(path: string, values: [section: string, key: string, value: string | number | boolean][]): Promise<boolean> {
  const doc = await loadIni(path);
  let changed = !existsSync(path);
  for (const [s, k, v] of values) changed = doc.set(s, k, v) || changed;
  if (changed) await saveIni(path, doc);
  return changed;
}
