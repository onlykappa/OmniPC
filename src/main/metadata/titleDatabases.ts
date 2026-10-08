// Local title/compatibility databases shipped *with the emulators themselves*.
// Reading them requires no network and no scraping:
// - PCSX2: resources/GameIndex.yaml (serial -> name, region, compat rating)
// - Dolphin: Sys/wiitdb-en.txt (GameTDB ID -> title)

import { readFile, stat } from 'node:fs/promises';
import type { CompatibilityInfo } from '@shared/models';

export interface Pcsx2IndexEntry {
  name: string;
  nameEn: string | null;
  region: string | null;
  compat: number | null;
}

/**
 * Streaming-friendly parser for the subset of GameIndex.yaml we need. Top-level
 * keys are serials; we read `name`, `name-en`, `region` and `compat` only.
 */
export function parsePcsx2GameIndex(text: string): Map<string, Pcsx2IndexEntry> {
  const out = new Map<string, Pcsx2IndexEntry>();
  let current: Pcsx2IndexEntry | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const top = /^([A-Z]{2,5}-\d{3,5}):\s*$/.exec(line);
    if (top) {
      current = { name: '', nameEn: null, region: null, compat: null };
      out.set(top[1], current);
      continue;
    }
    if (!current || !line.startsWith('  ') || line.startsWith('    ')) continue;
    const kv = /^ {2}([\w-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const value = unquote(kv[2]);
    switch (kv[1]) {
      case 'name': current.name = value; break;
      case 'name-en': current.nameEn = value; break;
      case 'region': current.region = value; break;
      case 'compat': current.compat = Number.parseInt(value, 10); break;
    }
  }
  return out;
}

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1).replace(/\\"/g, '"');
  return t;
}

/** PCSX2 CompatibilityRating: 0 Unknown, 1 Nothing, 2 Intro, 3 Menu, 4 InGame, 5 Playable, 6 Perfect. */
export function pcsx2Compat(compat: number | null): CompatibilityInfo | null {
  if (compat === null || Number.isNaN(compat) || compat <= 0) return null;
  const table: Record<number, [CompatibilityInfo['rating'], string]> = {
    1: ['nothing', 'Does not boot'],
    2: ['intro', 'Intro only'],
    3: ['menus', 'Menus only'],
    4: ['ingame', 'In-game (with issues)'],
    5: ['playable', 'Playable'],
    6: ['perfect', 'Perfect'],
  };
  const t = table[compat];
  if (!t) return null;
  return { rating: t[0], label: t[1], source: 'PCSX2 GameIndex.yaml (bundled with PCSX2)', notes: null, recommendedEmulator: 'pcsx2' };
}

export function regionFromPcsx2(region: string | null): string | null {
  if (!region) return null;
  if (/NTSC-U/i.test(region)) return 'USA';
  if (/NTSC-J/i.test(region)) return 'Japan';
  if (/NTSC-K/i.test(region)) return 'Korea';
  if (/NTSC-C|NTSC-HK|NTSC-T/i.test(region)) return 'Asia';
  if (/PAL/i.test(region)) return 'Europe';
  return null;
}

export function parseWiiTdb(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z0-9]{4,6})\s*=\s*(.+)$/.exec(line);
    if (m) out.set(m[1], m[2].trim());
  }
  return out;
}

const cache = new Map<string, { mtimeMs: number; value: unknown }>();

async function cached<T>(path: string, parse: (text: string) => T): Promise<T | null> {
  try {
    const s = await stat(path);
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === s.mtimeMs) return hit.value as T;
    const value = parse(await readFile(path, 'utf8'));
    cache.set(path, { mtimeMs: s.mtimeMs, value });
    return value;
  } catch {
    return null;
  }
}

export const loadPcsx2Index = (path: string) => cached(path, parsePcsx2GameIndex);
export const loadWiiTdb = (path: string) => cached(path, parseWiiTdb);
