// Editing the "shortcuts" map of shortcuts.vdf. Pure functions over the parsed
// document so they can be tested without Steam.
//
// OmniPC's own entries are recognised by two marks together: an "OmniPC" tag
// and LaunchOptions containing --launch-game=<gameId>. Everything else in the
// file (the user's other non-Steam games, unknown fields, field order) is left
// exactly as it was.

import { int, str, vdfGet, vdfSet, vdfString, type BinaryVdf, type VdfEntry, type VdfMap } from './vdf';
import { LAUNCH_GAME_ARG } from './launchArg';

export const OMNIPC_TAG = 'OmniPC';

/** What OmniPC wants Steam to have for one game. */
export interface ShortcutSpec {
  gameId: number;
  appName: string;
  /** Quoted executable path, exactly as stored in "Exe". */
  exe: string;
  /** Quoted working directory. */
  startDir: string;
  icon: string;
  launchOptions: string;
  /** Tags besides "OmniPC" (e.g. the system name). */
  tags: string[];
}

export interface ShortcutChange {
  added: number[];
  updated: number[];
  removed: { gameId: number; appId: number }[];
  /** Steam app id (unsigned) per game id that has an OmniPC entry after the change. */
  appIds: Map<number, number>;
  changed: boolean;
}

// --------------------------------------------------------------- app ids

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Standard CRC-32 (IEEE 802.3, as zlib) of the UTF-8 bytes of `text`. */
export function crc32(text: string): number {
  let c = 0xffffffff;
  for (const b of Buffer.from(text, 'utf8')) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Steam's id for a non-Steam shortcut: crc32(exe + appName) with the top bit
 * set, as an unsigned 32-bit number. `exe` is the quoted "Exe" value. Steam
 * names custom artwork after this id (grid/<id>p.png etc.) and keeps the
 * value OmniPC writes into the entry's "appid" field.
 */
export function shortcutAppId(exe: string, appName: string): number {
  return (crc32(exe + appName) | 0x80000000) >>> 0;
}

/** The legacy 64-bit id (used by older Steam for Big Picture grid names and steam://rungameid/). */
export function shortcutGameId64(appId: number): bigint {
  return (BigInt(appId >>> 0) << 32n) | 0x02000000n;
}

/** File names (without extension) Steam looks for in userdata/<id>/config/grid. */
export function gridNames(appId: number): { portrait: string; wide: string; hero: string; logo: string } {
  const id = String(appId >>> 0);
  return { portrait: `${id}p`, wide: id, hero: `${id}_hero`, logo: `${id}_logo` };
}

// ------------------------------------------------------------ entries

export function shortcutsMap(doc: BinaryVdf): VdfMap {
  const e = vdfGet(doc.root, 'shortcuts');
  if (e?.node.type === 'map') return e.node;
  const m: VdfMap = { type: 'map', entries: [] };
  if (e) e.node = m;
  else doc.root.entries.push({ key: 'shortcuts', node: m });
  return m;
}

export function emptyShortcutsDoc(): BinaryVdf {
  return { root: { type: 'map', entries: [{ key: 'shortcuts', node: { type: 'map', entries: [] } }] }, trailing: Buffer.alloc(0) };
}

function tagValues(entry: VdfMap): string[] {
  const t = vdfGet(entry, 'tags')?.node;
  if (t?.type !== 'map') return [];
  return t.entries.flatMap((e) => (e.node.type === 'string' ? [e.node.value] : []));
}

/** The OmniPC game id of an entry, or null when the entry is not one of OmniPC's. */
export function omniGameId(entry: VdfEntry): number | null {
  if (entry.node.type !== 'map') return null;
  if (!tagValues(entry.node).includes(OMNIPC_TAG)) return null;
  const m = new RegExp(`${LAUNCH_GAME_ARG}=(\\d+)`).exec(vdfString(entry.node, 'LaunchOptions') ?? '');
  return m ? Number(m[1]) : null;
}

/** Unsigned app id stored in an entry ("appid" is a signed int32). */
export function entryAppId(entry: VdfMap): number | null {
  const n = vdfGet(entry, 'appid')?.node;
  return n?.type === 'int32' ? n.value >>> 0 : null;
}

export function listOmniShortcuts(doc: BinaryVdf): { gameId: number; appId: number | null; appName: string | null }[] {
  return shortcutsMap(doc).entries.flatMap((e) => {
    const gameId = omniGameId(e);
    if (gameId === null || e.node.type !== 'map') return [];
    return [{ gameId, appId: entryAppId(e.node), appName: vdfString(e.node, 'AppName') }];
  });
}

function newEntry(spec: ShortcutSpec, appId: number): VdfMap {
  return {
    type: 'map',
    entries: [
      { key: 'appid', node: int(appId) },
      { key: 'AppName', node: str(spec.appName) },
      { key: 'Exe', node: str(spec.exe) },
      { key: 'StartDir', node: str(spec.startDir) },
      { key: 'icon', node: str(spec.icon) },
      { key: 'ShortcutPath', node: str('') },
      { key: 'LaunchOptions', node: str(spec.launchOptions) },
      { key: 'IsHidden', node: int(0) },
      { key: 'AllowDesktopConfig', node: int(1) },
      { key: 'AllowOverlay', node: int(1) },
      { key: 'OpenVR', node: int(0) },
      { key: 'Devkit', node: int(0) },
      { key: 'DevkitGameID', node: str('') },
      { key: 'DevkitOverrideAppID', node: int(0) },
      { key: 'LastPlayTime', node: int(0) },
      { key: 'FlatpakAppID', node: str('') },
      { key: 'tags', node: { type: 'map', entries: [OMNIPC_TAG, ...spec.tags].map((t, i) => ({ key: String(i), node: str(t) })) } },
    ],
  };
}

/** Updates the fields OmniPC owns; user changes such as IsHidden or extra tags are kept. */
function updateEntry(entry: VdfMap, spec: ShortcutSpec, appId: number): boolean {
  const before = JSON.stringify(entry);
  vdfSet(entry, 'appid', int(appId));
  vdfSet(entry, 'AppName', str(spec.appName));
  vdfSet(entry, 'Exe', str(spec.exe));
  vdfSet(entry, 'StartDir', str(spec.startDir));
  vdfSet(entry, 'icon', str(spec.icon));
  vdfSet(entry, 'LaunchOptions', str(spec.launchOptions));
  let tags = vdfGet(entry, 'tags');
  if (tags?.node.type !== 'map') {
    vdfSet(entry, 'tags', { type: 'map', entries: [] });
    tags = vdfGet(entry, 'tags')!;
  }
  const tagMap = tags.node as VdfMap;
  const have = new Set(tagValues(entry));
  for (const t of [OMNIPC_TAG, ...spec.tags]) {
    if (have.has(t)) continue;
    tagMap.entries.push({ key: String(tagMap.entries.length), node: str(t) });
    have.add(t);
  }
  return JSON.stringify(entry) !== before;
}

/**
 * Adds or updates entries for `specs`. With `removeOthers`, OmniPC entries for
 * games not in `specs` are removed (whole-library sync); `removeGameIds`
 * removes specific games. Non-OmniPC entries are never modified.
 */
export function applyShortcuts(doc: BinaryVdf, specs: ShortcutSpec[], opts: { removeOthers?: boolean; removeGameIds?: number[] } = {}): ShortcutChange {
  const map = shortcutsMap(doc);
  const wanted = new Map(specs.map((s) => [s.gameId, s]));
  const remove = new Set(opts.removeGameIds ?? []);
  const result: ShortcutChange = { added: [], updated: [], removed: [], appIds: new Map(), changed: false };
  const seen = new Set<number>();
  const kept: VdfEntry[] = [];
  for (const e of map.entries) {
    const gameId = omniGameId(e);
    if (gameId === null || e.node.type !== 'map') {
      kept.push(e);
      continue;
    }
    const spec = wanted.get(gameId);
    // Drop duplicates of the same game, removed games and (whole sync) stale games.
    if (seen.has(gameId) || remove.has(gameId) || (!spec && opts.removeOthers)) {
      result.removed.push({ gameId, appId: entryAppId(e.node) ?? 0 });
      continue;
    }
    seen.add(gameId);
    kept.push(e);
    if (spec) {
      const appId = shortcutAppId(spec.exe, spec.appName);
      if (updateEntry(e.node, spec, appId)) result.updated.push(gameId);
      result.appIds.set(gameId, appId);
    } else {
      const appId = entryAppId(e.node);
      if (appId !== null) result.appIds.set(gameId, appId);
    }
  }
  for (const spec of specs) {
    if (seen.has(spec.gameId) || remove.has(spec.gameId)) continue;
    const appId = shortcutAppId(spec.exe, spec.appName);
    kept.push({ key: '', node: newEntry(spec, appId) });
    result.added.push(spec.gameId);
    result.appIds.set(spec.gameId, appId);
    seen.add(spec.gameId);
  }
  if (result.removed.length || result.added.length) {
    // Keys of the shortcuts map are positions ("0", "1", …) and must stay contiguous.
    map.entries = kept.map((e, i) => ({ ...e, key: String(i), keyRaw: undefined }));
  }
  result.changed = result.added.length + result.updated.length + result.removed.length > 0;
  return result;
}

/** Makes Steam app names unique: same title on two systems gets the system appended, and so on. */
export function uniqueAppNames(games: { id: number; title: string; system: string; region: string | null }[]): Map<number, string> {
  const out = new Map<number, string>();
  const count = (names: Map<number, string>) => {
    const c = new Map<string, number>();
    for (const n of names.values()) c.set(n.toLowerCase(), (c.get(n.toLowerCase()) ?? 0) + 1);
    return c;
  };
  for (const g of games) out.set(g.id, g.title);
  let c = count(out);
  for (const g of games) if (c.get(g.title.toLowerCase())! > 1) out.set(g.id, `${g.title} (${g.system})`);
  c = count(out);
  for (const g of games) {
    const n = out.get(g.id)!;
    if (c.get(n.toLowerCase())! > 1 && g.region) out.set(g.id, `${g.title} (${g.system}, ${g.region})`);
  }
  c = count(out);
  for (const g of games) {
    const n = out.get(g.id)!;
    if (c.get(n.toLowerCase())! > 1) out.set(g.id, `${n} #${g.id}`);
  }
  return out;
}
