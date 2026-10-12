// Read-only inspection of the firmware installed in a Ryujinx data folder.
//
// Ryujinx keeps installed system titles in <data>/bis/system/Contents/registered,
// one folder per content archive named "<content id>.nca" that holds the archive
// itself (ContentManager.InstallFirmware writes "<id>.nca/00"; LoadEntries loads
// every sub-folder of "registered" that contains a file, using its first file).
// Archives are encrypted, so without keys only the layout and sizes can be checked:
// that is what "installed" means here, and anything Ryujinx would not load, or that
// looks incomplete, is reported as present but inconclusive rather than missing.
//
// Nothing here writes, moves or deletes anything, and key files are never read.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** An NCA always starts with a 0xC00-byte header, so anything smaller is not one. */
const NCA_MIN_BYTES = 0xc00;
/**
 * A full Switch firmware has a couple of hundred system titles. Far fewer usually
 * means an interrupted install or a partial copy, so it is not reported as installed.
 */
const PLAUSIBLE_MIN_TITLES = 20;
const CONTENT_ID_NCA = /^[0-9a-f]{32}\.nca$/i;

export type FirmwareState = 'installed' | 'inconclusive' | 'missing';

export interface FirmwareInspection {
  /** The data folder inspected (the folder that holds bis/). */
  dataDir: string;
  registeredDir: string;
  state: FirmwareState;
  /** Content archives Ryujinx would load. */
  loadable: number;
  totalBytes: number;
  /** One-line result, e.g. "Installed (231 system titles)". */
  summary: string;
  /** Supporting facts for diagnostics (paths and counts only, never file contents). */
  evidence: string[];
}

export function registeredDirOf(dataDir: string): string {
  return join(dataDir, 'bis', 'system', 'Contents', 'registered');
}

function filesIn(dir: string): { name: string; size: number }[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => ({ name: e.name, size: statSync(join(dir, e.name)).size }));
  } catch {
    return [];
  }
}

function subdirsIn(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Inspects <dataDir>/bis/system/Contents/registered without changing anything. */
export function inspectFirmware(dataDir: string): FirmwareInspection {
  const registeredDir = registeredDirOf(dataDir);
  const base = { dataDir, registeredDir, loadable: 0, totalBytes: 0 };
  if (!existsSync(registeredDir)) {
    return { ...base, state: 'missing', summary: 'Not installed (no firmware folder)', evidence: [`${registeredDir} does not exist`] };
  }

  let loadable = 0;
  let totalBytes = 0;
  let emptyOrTiny = 0;
  let oddNames = 0;
  let nested = 0;
  const looseNcas = filesIn(registeredDir).filter((f) => /\.nca$/i.test(f.name)).length;
  const dirs = subdirsIn(registeredDir);
  for (const d of dirs) {
    const path = join(registeredDir, d);
    const files = filesIn(path);
    if (!files.length) {
      // Ryujinx skips folders without files. A folder of "<id>.nca" folders is a
      // firmware copied one level too deep (e.g. registered/registered/...).
      if (subdirsIn(path).some((n) => /\.nca$/i.test(n))) nested++;
      else emptyOrTiny++;
      continue;
    }
    // LoadEntries opens the first file it finds; "00" is what Ryujinx itself writes.
    const nca = files.find((f) => f.name === '00') ?? files[0];
    if (nca.size < NCA_MIN_BYTES) {
      emptyOrTiny++;
      continue;
    }
    loadable++;
    totalBytes += nca.size;
    if (!CONTENT_ID_NCA.test(d)) oddNames++;
  }

  const evidence = [`${registeredDir}: ${dirs.length} folder(s), ${loadable} loadable system title(s), ${(totalBytes / 1048576).toFixed(0)} MB`];
  if (emptyOrTiny) evidence.push(`${emptyOrTiny} folder(s) are empty or hold a file too small to be a content archive (interrupted install or partial copy?)`);
  if (nested) evidence.push(`${nested} folder(s) contain .nca folders one level too deep; Ryujinx does not load these (was a "registered" folder copied inside another?)`);
  if (looseNcas) evidence.push(`${looseNcas} loose .nca file(s) directly in "registered"; Ryujinx only loads .nca folders there`);
  if (oddNames) evidence.push(`${oddNames} loadable folder(s) are not named like Ryujinx's own "<content id>.nca" folders`);
  const result = { ...base, loadable, totalBytes, evidence };

  if (!dirs.length && !looseNcas) return { ...result, state: 'missing', summary: 'Not installed (firmware folder is empty)' };
  if (!loadable) return { ...result, state: 'inconclusive', summary: 'Present, validation inconclusive (nothing Ryujinx can load)' };
  if (loadable < PLAUSIBLE_MIN_TITLES) return { ...result, state: 'inconclusive', summary: `Present, validation inconclusive (only ${loadable} system title(s); a complete firmware has far more)` };
  if (emptyOrTiny || nested || looseNcas) return { ...result, state: 'inconclusive', summary: `Present, validation inconclusive (${loadable} system titles, plus damaged or misplaced entries)` };
  return { ...result, state: 'installed', summary: `Installed (${loadable} system titles)` };
}

/**
 * Data folders a Ryujinx executable uses on its own, in Ryujinx's order
 * (AppDataManager): a "portable" folder next to the executable, else the user
 * profile folder (%APPDATA%\Ryujinx on Windows).
 */
export function ownDataDirs(executableDir: string, appData: string): { dir: string; label: string }[] {
  const portable = join(executableDir, 'portable');
  if (existsSync(portable)) return [{ dir: portable, label: 'portable folder next to Ryujinx.exe' }];
  return [{ dir: join(appData, 'Ryujinx'), label: '%APPDATA%\\Ryujinx' }];
}
