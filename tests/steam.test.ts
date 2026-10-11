import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32 as zlibCrc32 } from 'node:zlib';
import type { GameMetadata } from '@shared/models';
import { parseBinaryVdf, serializeBinaryVdf, parseTextVdf, vdfString, type BinaryVdf, type VdfMap } from '../src/main/steam/vdf';
import { applyShortcuts, crc32, emptyShortcutsDoc, gridNames, listOmniShortcuts, shortcutAppId, shortcutsMap, uniqueAppNames, type ShortcutSpec } from '../src/main/steam/shortcuts';
import { accountIdFromSteamId64, listSteamUsers, parseLoginUsers, type SteamPlatform } from '../src/main/steam/discovery';
import { parseLaunchGameArg } from '../src/main/steam/launchArg';
import { SteamService } from '../src/main/steam/service';
import { AppPaths } from '../src/main/core/paths';
import type { GameRow, LibraryRepo } from '../src/main/database/libraryRepo';
import { tempDir } from './helpers';

const t = tempDir('omnipc-steam-');
afterAll(t.cleanup);

// --- a hand-built binary shortcuts.vdf, as Steam writes it ------------------

const S = (k: string, v: string) => Buffer.concat([Buffer.from([0x01]), Buffer.from(k + '\0' + v + '\0', 'utf8')]);
const I = (k: string, v: number) => { const b = Buffer.alloc(4); b.writeInt32LE(v); return Buffer.concat([Buffer.from([0x02]), Buffer.from(k + '\0'), b]); };
const M = (k: string, ...children: Buffer[]) => Buffer.concat([Buffer.from([0x00]), Buffer.from(k + '\0', 'utf8'), ...children, Buffer.from([0x08])]);

function userShortcut(index: string, name: string): Buffer {
  return M(index,
    I('appid', -123456789),
    S('AppName', name),
    S('Exe', '"D:\\Games\\Other\\game.exe"'),
    S('StartDir', '"D:\\Games\\Other\\"'),
    S('icon', ''),
    S('LaunchOptions', '-fullscreen'),
    I('IsHidden', 0),
    I('LastPlayTime', 1700000000),
    // Fields OmniPC doesn't know: a uint64 (0x07), a float (0x03) and a future string.
    Buffer.concat([Buffer.from([0x07]), Buffer.from('SomeU64\0'), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])]),
    Buffer.concat([Buffer.from([0x03]), Buffer.from('SomeFloat\0'), Buffer.from([0, 0, 0x80, 0x3f])]),
    S('FutureField', 'keep me ✓'),
    M('tags', S('0', 'Favorites')),
  );
}

const fileWithUserEntries = () => Buffer.concat([M('shortcuts', userShortcut('0', 'My Other Game'), userShortcut('1', 'Second Game')), Buffer.from([0x08])]);

const spec = (gameId: number, appName: string, system = 'Nintendo 64'): ShortcutSpec => ({
  gameId,
  appName,
  exe: '"C:\\Program Files\\OmniPC\\OmniPC.exe"',
  startDir: '"C:\\Program Files\\OmniPC"',
  icon: '',
  launchOptions: `--launch-game=${gameId}`,
  tags: [system],
});

describe('binary VDF', () => {
  it('round-trips byte for byte, including unknown field types', () => {
    const buf = fileWithUserEntries();
    const doc = parseBinaryVdf(buf);
    expect(serializeBinaryVdf(doc).equals(buf)).toBe(true);
    const first = shortcutsMap(doc).entries[0].node as VdfMap;
    expect(vdfString(first, 'appname')).toBe('My Other Game');
    expect(vdfString(first, 'FutureField')).toBe('keep me ✓');
  });

  it('keeps invalid UTF-8 bytes and trailing bytes intact', () => {
    const odd = Buffer.concat([Buffer.from([0x00]), Buffer.from('shortcuts\0'), Buffer.from([0x01]), Buffer.from('k\0'), Buffer.from([0xff, 0xfe, 0x41, 0x00]), Buffer.from([0x08, 0x08, 0x0a])]);
    expect(serializeBinaryVdf(parseBinaryVdf(odd)).equals(odd)).toBe(true);
  });

  it('rejects damaged files instead of guessing', () => {
    expect(() => parseBinaryVdf(Buffer.from([0x00, 0x61, 0x00, 0x01, 0x62]))).toThrow();
    expect(() => parseBinaryVdf(Buffer.from([0x00, 0x61, 0x00, 0x09, 0x62, 0x00]))).toThrow(/unknown value type/);
  });

  it('parses text VDF (loginusers.vdf)', () => {
    const v = parseTextVdf('"a"\n{\n\t"b"\t\t"x \\"y\\""\n\t// comment\n\t"c" { "d" "1" }\n}\n');
    expect(v).toEqual({ a: { b: 'x "y"', c: { d: '1' } } });
  });
});

describe('Steam app ids and grid names', () => {
  it('CRC-32 matches the standard check value and zlib', () => {
    expect(crc32('123456789')).toBe(0xcbf43926);
    expect(crc32('"C:\\OmniPC.exe"Ünïcode')).toBe(zlibCrc32('"C:\\OmniPC.exe"Ünïcode'));
  });

  it('computes crc32(exe + name) | 0x80000000', () => {
    // Computed independently: (zlib.crc32('"C:\\Program Files\\OmniPC\\OmniPC.exe"Super Mario 64') | 0x80000000) >>> 0
    expect(shortcutAppId('"C:\\Program Files\\OmniPC\\OmniPC.exe"', 'Super Mario 64')).toBe(3090621629);
    expect(shortcutAppId('"C:\\Program Files\\OmniPC\\OmniPC.exe"', 'Super Mario 64') | 0).toBe(-1204345667);
  });

  it('names grid files after the unsigned id', () => {
    expect(gridNames(3090621629)).toEqual({ portrait: '3090621629p', wide: '3090621629', hero: '3090621629_hero', logo: '3090621629_logo' });
  });
});

describe('editing shortcuts', () => {
  it('adds OmniPC entries with all fields and leaves other shortcuts untouched', () => {
    const original = fileWithUserEntries();
    const doc = parseBinaryVdf(original);
    const r = applyShortcuts(doc, [spec(7, 'Super Mario 64')]);
    expect(r.added).toEqual([7]);
    const map = shortcutsMap(doc);
    expect(map.entries.map((e) => e.key)).toEqual(['0', '1', '2']);
    const e = map.entries[2].node as VdfMap;
    expect(e.entries.map((x) => x.key)).toEqual(['appid', 'AppName', 'Exe', 'StartDir', 'icon', 'ShortcutPath', 'LaunchOptions', 'IsHidden', 'AllowDesktopConfig', 'AllowOverlay', 'OpenVR', 'Devkit', 'DevkitGameID', 'DevkitOverrideAppID', 'LastPlayTime', 'FlatpakAppID', 'tags']);
    expect(e.entries[0].node).toEqual({ type: 'int32', value: -1204345667 });
    expect(vdfString(e, 'LaunchOptions')).toBe('--launch-game=7');
    // The user's two entries serialise to exactly the original bytes.
    const out = serializeBinaryVdf(doc);
    const userBytes = original.subarray(0, original.length - 2); // minus the two end markers
    expect(out.subarray(0, userBytes.length).equals(userBytes)).toBe(true);
    expect(listOmniShortcuts(parseBinaryVdf(out))).toEqual([{ gameId: 7, appId: 3090621629, appName: 'Super Mario 64' }]);
  });

  it('updates only OmniPC entries and keeps user changes to them', () => {
    const doc = parseBinaryVdf(fileWithUserEntries());
    applyShortcuts(doc, [spec(7, 'Super Mario 64'), spec(8, 'Zelda')]);
    const ours = shortcutsMap(doc).entries[2].node as VdfMap;
    ours.entries.find((x) => x.key === 'IsHidden')!.node = { type: 'int32', value: 1 };
    const r = applyShortcuts(doc, [spec(7, 'Super Mario 64 (Renamed)'), spec(8, 'Zelda')]);
    expect(r.updated).toEqual([7]);
    expect(r.added).toEqual([]);
    expect(vdfString(ours, 'AppName')).toBe('Super Mario 64 (Renamed)');
    expect(ours.entries.find((x) => x.key === 'IsHidden')!.node).toEqual({ type: 'int32', value: 1 });
    expect(applyShortcuts(doc, [spec(7, 'Super Mario 64 (Renamed)'), spec(8, 'Zelda')]).changed).toBe(false);
  });

  it('removes only OmniPC entries (whole-library sync and remove all)', () => {
    const original = fileWithUserEntries();
    const doc = parseBinaryVdf(original);
    applyShortcuts(doc, [spec(7, 'A'), spec(8, 'B')]);
    // A user shortcut that merely mentions --launch-game but has no OmniPC tag is not ours.
    shortcutsMap(doc).entries.push({ key: '4', node: { type: 'map', entries: [{ key: 'AppName', node: { type: 'string', value: 'Lookalike' } }, { key: 'LaunchOptions', node: { type: 'string', value: '--launch-game=9' } }] } });
    const partial = applyShortcuts(doc, [spec(8, 'B')], { removeOthers: true });
    expect(partial.removed.map((x) => x.gameId)).toEqual([7]);
    expect(shortcutsMap(doc).entries.map((e) => e.key)).toEqual(['0', '1', '2', '3']);
    const all = applyShortcuts(doc, [], { removeOthers: true });
    expect(all.removed.map((x) => x.gameId)).toEqual([8]);
    const names = shortcutsMap(doc).entries.map((e) => vdfString(e.node as VdfMap, 'AppName'));
    expect(names).toEqual(['My Other Game', 'Second Game', 'Lookalike']);
  });

  it('makes app names unique', () => {
    const n = uniqueAppNames([
      { id: 1, title: 'Tetris', system: 'GB', region: null },
      { id: 2, title: 'Tetris', system: 'NES', region: 'USA' },
      { id: 3, title: 'Tetris', system: 'NES', region: 'Japan' },
      { id: 4, title: 'Zelda', system: 'NES', region: null },
    ]);
    expect([...n.values()]).toEqual(['Tetris (GB)', 'Tetris (NES, USA)', 'Tetris (NES, Japan)', 'Zelda']);
  });
});

describe('Steam accounts', () => {
  const loginusers = `"users"
{
	"76561198000000001"
	{
		"AccountName"		"alice_acc"
		"PersonaName"		"Alice"
		"MostRecent"		"0"
		"Timestamp"		"1700000000"
	}
	"76561198000000002"
	{
		"AccountName"		"bob_acc"
		"PersonaName"		"Bob"
		"MostRecent"		"1"
		"Timestamp"		"1600000000"
	}
}
`;

  it('converts steamid64 to the 32-bit account id', () => {
    expect(accountIdFromSteamId64('76561198000000001')).toBe('39734273');
    expect(accountIdFromSteamId64('123')).toBeNull();
  });

  it('parses loginusers.vdf', () => {
    const u = parseLoginUsers(loginusers);
    expect(u.map((x) => [x.accountId, x.personaName, x.mostRecent])).toEqual([['39734273', 'Alice', false], ['39734274', 'Bob', true]]);
  });

  it('lists userdata folders with the most recent account first', () => {
    const root = join(t.dir, 'steam-users');
    for (const id of ['0', '39734273', '39734274', '555']) mkdirSync(join(root, 'userdata', id), { recursive: true });
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'config', 'loginusers.vdf'), loginusers);
    const users = listSteamUsers(root);
    expect(users[0]).toEqual({ id: '39734274', name: 'Bob', mostRecent: true });
    expect(users.map((u) => u.id).sort()).toEqual(['39734273', '39734274', '555']);
    expect(users.find((u) => u.id === '555')!.name).toBe('Steam user 555');
  });
});

describe('--launch-game argument', () => {
  it('parses both forms and ignores junk', () => {
    expect(parseLaunchGameArg(['OmniPC.exe', '--launch-game=42'])).toBe(42);
    expect(parseLaunchGameArg(['electron.exe', 'C:\\app', '--launch-game', '7'])).toBe(7);
    expect(parseLaunchGameArg(['OmniPC.exe', '--launch-game="12"'])).toBe(12);
    expect(parseLaunchGameArg(['OmniPC.exe', '--launch-game=abc'])).toBeNull();
    expect(parseLaunchGameArg(['OmniPC.exe', '--launch-game=0'])).toBeNull();
    expect(parseLaunchGameArg(['OmniPC.exe', '--console'])).toBeNull();
  });
});

describe('SteamService with a fake Steam folder', () => {
  const steamRoot = join(t.dir, 'Steam');
  const userId = '39734274';
  const configDir = join(steamRoot, 'userdata', userId, 'config');
  const grid = join(configDir, 'grid');
  const vdfFile = join(configDir, 'shortcuts.vdf');
  const art = join(t.dir, 'art');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(art, { recursive: true });
  writeFileSync(vdfFile, fileWithUserEntries());
  writeFileSync(join(art, 'mario-cover.png'), 'cover-1');
  writeFileSync(join(art, 'mario-bg.jpg'), 'background-1');
  writeFileSync(join(art, 'zelda-cover.jpg'), 'zelda-cover');

  const games: GameRow[] = [
    { id: 7, system_id: 'n64', title: 'Super Mario 64', region: null, availability: 'available' } as GameRow,
    { id: 8, system_id: 'nes', title: 'Zelda', region: null, availability: 'available' } as GameRow,
  ];
  const meta: Record<number, Partial<GameMetadata>> = {
    7: { coverPath: join(art, 'mario-cover.png'), backgroundPath: join(art, 'mario-bg.jpg'), screenshots: [] },
    8: { coverPath: join(art, 'zelda-cover.jpg'), backgroundPath: null, screenshots: [] },
  };
  const library = {
    allGames: () => games,
    getMetadata: (id: number) => ({ coverPath: null, backgroundPath: null, screenshots: [], ...meta[id] }) as GameMetadata,
  } as unknown as LibraryRepo;
  let running = false;
  const platform: SteamPlatform = {
    findSteam: async () => steamRoot,
    isRunning: async () => running,
    requestShutdown: async () => { setTimeout(() => (running = false), 20); },
  };
  const paths = new AppPaths(join(t.dir, 'userData'), t.dir);
  const svc = new SteamService({ library, paths, platform, launcher: () => ({ exe: 'C:\\Program Files\\OmniPC\\OmniPC.exe', startDir: 'C:\\Program Files\\OmniPC', args: [] }), shutdownWait: { intervalMs: 10, timeoutMs: 2000 } });
  const marioId = shortcutAppId('"C:\\Program Files\\OmniPC\\OmniPC.exe"', 'Super Mario 64');
  const zeldaId = shortcutAppId('"C:\\Program Files\\OmniPC\\OmniPC.exe"', 'Zelda');
  const readDoc = (): BinaryVdf => parseBinaryVdf(readFileSync(vdfFile));

  it('refuses to write while Steam is running, and closes Steam on request', async () => {
    running = true;
    await expect(svc.sync({ gameIds: 'all' })).rejects.toMatchObject({ detail: { code: 'STEAM_RUNNING' } });
    expect((await svc.status()).running).toBe(true);
    expect(await svc.closeSteam()).toEqual({ closed: true });
    expect(running).toBe(false);
  });

  it('adds all games with artwork and a backup', async () => {
    // A picture the user set in Steam for Zelda's wide slot must survive.
    mkdirSync(grid, { recursive: true });
    writeFileSync(join(grid, `${zeldaId}p.png`), 'user custom art');
    const r = await svc.sync({ gameIds: 'all' });
    expect(r).toMatchObject({ userId, added: 2, updated: 0, removed: 0 });
    expect(r.backup && existsSync(r.backup)).toBeTruthy();
    expect(readFileSync(r.backup!).equals(fileWithUserEntries())).toBe(true);
    expect(listOmniShortcuts(readDoc()).map((s) => [s.gameId, s.appId])).toEqual([[7, marioId], [8, zeldaId]]);
    expect(readFileSync(join(grid, `${marioId}p.png`), 'utf8')).toBe('cover-1');
    expect(readFileSync(join(grid, `${marioId}_hero.jpg`), 'utf8')).toBe('background-1');
    expect(readFileSync(join(grid, `${marioId}.jpg`), 'utf8')).toBe('background-1');
    expect(readFileSync(join(grid, `${zeldaId}p.png`), 'utf8')).toBe('user custom art');
    expect(existsSync(join(grid, `${zeldaId}p.jpg`))).toBe(false);
    expect(r.artwork).toBe(3);
    const st = await svc.status();
    expect(st).toMatchObject({ installed: true, userId, shortcutsCount: 2, gameIds: [7, 8] });
  });

  it('re-sync updates art OmniPC wrote, and renames move the art', async () => {
    writeFileSync(join(art, 'mario-cover.webp'), 'cover-2');
    meta[7].coverPath = join(art, 'mario-cover.webp');
    games[0].title = 'Super Mario 64 DX';
    const r = await svc.sync({ gameIds: [7] });
    expect(r).toMatchObject({ added: 0, updated: 1, removed: 0 });
    const newId = shortcutAppId('"C:\\Program Files\\OmniPC\\OmniPC.exe"', 'Super Mario 64 DX');
    expect(existsSync(join(grid, `${marioId}p.png`))).toBe(false);
    expect(readFileSync(join(grid, `${newId}p.webp`), 'utf8')).toBe('cover-2');
    // User entries are still byte-identical at the start of the file.
    const original = fileWithUserEntries();
    expect(readFileSync(vdfFile).subarray(0, original.length - 2).equals(original.subarray(0, original.length - 2))).toBe(true);
  });

  it('whole-library sync removes games that left the library; removeAll removes only ours', async () => {
    games.splice(1, 1); // Zelda removed from the library
    const r = await svc.sync({ gameIds: 'all' });
    expect(r).toMatchObject({ added: 0, removed: 1 });
    expect(readFileSync(join(grid, `${zeldaId}p.png`), 'utf8')).toBe('user custom art');
    const all = await svc.removeAll();
    expect(all.removed).toBe(1);
    const doc = readDoc();
    expect(listOmniShortcuts(doc)).toEqual([]);
    expect(serializeBinaryVdf(doc).equals(fileWithUserEntries())).toBe(true);
    expect(readdirSync(grid)).toEqual([`${zeldaId}p.png`]);
    expect(readdirSync(join(paths.backups, 'steam')).length).toBeGreaterThanOrEqual(3);
  });

  it('creates shortcuts.vdf when the account has none', async () => {
    const other = join(steamRoot, 'userdata', '555', 'config');
    mkdirSync(other, { recursive: true });
    const r = await svc.sync({ userId: '555', gameIds: [7] });
    expect(r).toMatchObject({ added: 1, backup: null });
    const doc = parseBinaryVdf(readFileSync(join(other, 'shortcuts.vdf')));
    expect(listOmniShortcuts(doc).map((s) => s.gameId)).toEqual([7]);
    expect(serializeBinaryVdf(emptyShortcutsDoc()).equals(Buffer.from([0x00, ...Buffer.from('shortcuts\0'), 0x08, 0x08]))).toBe(true);
  });
});
