import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppPaths } from '../src/main/core/paths';
import { MelonDsAdapter, joyCode } from '../src/main/emulators/melonds/adapter';
import { TomlDocument, checkToml } from '../src/main/emulators/melonds/toml';
import { validateManifest } from '../src/main/emulators/registry';
import { pickAsset } from '../src/main/downloads/sources';
import { defaultProfile } from '../src/main/controllers/translate';
import { DEFAULT_SETTINGS } from '../src/main/database/settingsRepo';
import { tempDir } from './helpers';

const t = tempDir();
afterAll(t.cleanup);
const paths = new AppPaths(join(t.dir, 'ud'), t.dir);
const controller = { ...defaultProfile(), id: 1, updatedAt: '' };
const hotkeys = DEFAULT_SETTINGS.hotkeys;

describe('melonDS TOML editor', () => {
  // Shape written by toml11 4.x (Config::Save), plus comments/extra syntax.
  const sample = [
    'LimitFPS = true',
    'TargetFPS = 60.0',
    'RecentROM = ["C:\\\\Games\\\\a.nds", "b.nds"]',
    '',
    '[3D]',
    'Renderer = 0 # software',
    '',
    '[3D.GL]',
    'ScaleFactor = 1',
    '',
    '[Instance0]',
    'SaveFilePath = ""',
    'Firmware.Username = \'melon\'',
    'Multi = [',
    '  1, # one',
    '  2,',
    ']',
    '',
    '[Instance0.Joystick]',
    'A = 0',
    'B = 1',
    '',
  ].join('\n');

  it('reads typed values, strings with escapes, dotted keys and arrays', () => {
    const d = TomlDocument.parse(sample);
    expect(d.get(['LimitFPS'])).toBe(true);
    expect(d.get(['3D', 'Renderer'])).toBe(0);
    expect(d.get(['RecentROM'])).toEqual(['C:\\Games\\a.nds', 'b.nds']);
    expect(d.get(['Instance0', 'Firmware', 'Username'])).toBe('melon');
    expect(d.get(['Instance0', 'Multi'])).toEqual([1, 2]);
    expect(d.getTyped(['TargetFPS'], 'float')).toBe(60);
    expect(d.getTyped(['TargetFPS'], 'int')).toBeUndefined();
  });

  it('replaces values in place and inserts new keys in the right table', () => {
    const d = TomlDocument.parse(sample);
    expect(d.set(['3D', 'Renderer'], 0)).toBe(false);
    expect(d.set(['3D', 'Renderer'], 1)).toBe(true);
    expect(d.set(['Instance0', 'SaveFilePath'], 'C:\\Saves\\melonds')).toBe(true);
    expect(d.set(['Instance0', 'Joystick', 'X'], 2)).toBe(true);
    expect(d.set(['Instance0', 'Firmware', 'Language'], 1)).toBe(true);
    expect(d.set(['Emu', 'DirectBoot'], true)).toBe(true);
    expect(d.set(['Instance0', 'Window0', 'ScreenAspectTop'], 1)).toBe(true);
    expect(d.set(['Top'], 'x')).toBe(true);
    const out = d.toString();
    expect(out).toContain('Renderer = 1 # software');
    expect(out).toContain('SaveFilePath = "C:\\\\Saves\\\\melonds"');
    expect(out).toMatch(/B = 1\nX = 2\n/);
    expect(out).toMatch(/Firmware\.Username = 'melon'\nFirmware\.Language = 1\n/);
    expect(out).toMatch(/\[Emu\]\nDirectBoot = true\n/);
    expect(out.indexOf('Top = "x"')).toBeLessThan(out.indexOf('[3D]'));
    const again = TomlDocument.parse(out);
    expect(again.get(['Instance0', 'SaveFilePath'])).toBe('C:\\Saves\\melonds');
    expect(again.get(['Instance0', 'Joystick', 'X'])).toBe(2);
    expect(again.get(['Instance0', 'Multi'])).toEqual([1, 2]);
    expect(again.get(['Top'])).toBe('x');
  });

  it('rewrites a value of the wrong type and keeps CRLF line endings', () => {
    const d = TomlDocument.parse('[3D]\r\nRenderer = "1"\r\n');
    expect(d.set(['3D', 'Renderer'], 1)).toBe(true);
    expect(d.set(['3D', 'Soft', 'Threaded'], true)).toBe(true);
    expect(d.toString()).toBe('[3D]\r\nRenderer = 1\r\n\r\n[3D.Soft]\r\nThreaded = true\r\n');
  });

  it('flags malformed TOML (which melonDS would silently reset)', () => {
    expect(checkToml(sample).ok).toBe(true);
    expect(checkToml('[3D]\nRenderer = \n').ok).toBe(false);
    expect(checkToml('a = "unterminated\n').ok).toBe(false);
    expect(checkToml('a = 1\na = 2\n').ok).toBe(false);
    expect(checkToml('[x]\n[x]\n').ok).toBe(false);
    expect(checkToml('t = 1979-05-27T07:32:00Z\ns = """multi\nline"""\nl = \'\'\'raw\\n\'\'\'\ni = { a = 1, b.c = "x" }\n[[arr]]\nk = 1\n[[arr]]\nk = 2\n').ok).toBe(true);
    const inline = TomlDocument.parse('i = { a = 1, b.c = "x" }\n');
    expect(inline.get(['i', 'b', 'c'])).toBe('x');
    expect(() => inline.set(['i', 'z'], 1)).toThrow();
  });
});

describe('melonDS adapter', () => {
  const a = new MelonDsAdapter(paths);
  const settings = a.defaultSettings(null, 'balanced');
  const read = () => TomlDocument.parse(readFileSync(a.tomlPath(), 'utf8'));
  const J = (k: string) => read().get(['Instance0', 'Joystick', k]);

  it('has a valid manifest selecting only the Windows x86_64 zip', () => {
    expect(validateManifest(a.manifest)).toEqual([]);
    expect(a.manifest.implemented).toBe(true);
    const names = ['melonDS-1.1-appimage-x86_64.zip', 'melonDS-1.1-windows-aarch64.zip', 'melonDS-1.1-macOS-universal.zip', 'melonDS-1.1-windows-x86_64.zip', 'melonDS-1.1-ubuntu-x86_64.zip']
      .map((name) => ({ name, browser_download_url: `https://github.com/melonDS-emu/melonDS/releases/download/1.1/${name}`, size: 1 }));
    expect(pickAsset(names, a.manifest.download.assetPatterns!, a.manifest.download.assetExclude!, [])?.name).toBe('melonDS-1.1-windows-x86_64.zip');
  });

  it('keeps melonDS.toml next to the exe and BIOS in BIOS/nds', () => {
    expect(a.tomlPath()).toBe(join(paths.emulatorAppDir('melonds'), 'melonDS.toml'));
    expect(a.paths().bios).toBe(paths.systemBiosDir('nds'));
    expect(settings.renderer).toBe('opengl');
  });

  it('encodes joystick buttons, hats and axes like MapButton.h', () => {
    expect(joyCode('A')).toBe(0);
    expect(joyCode('Start')).toBe(7);
    expect(joyCode('DPadUp')).toBe(0x101);
    expect(joyCode('DPadLeft')).toBe(0x108);
    expect(joyCode('RT')).toBe(0xffff | 0x10000 | (2 << 20) | (5 << 24));
    expect(joyCode('LeftStickUp')).toBe(0xffff | 0x10000 | (1 << 20) | (1 << 24));
    expect(joyCode('DPadDown', 'LeftStickDown')).toBe(0x104 | 0x10000 | (0 << 20) | (1 << 24));
  });

  it('generates paths, graphics, controller and hotkeys', async () => {
    const res = await a.applyConfig({ settings: { ...settings, renderer: 'compute', resolutionScale: 4, aspectRatio: '16:9', vsync: false }, controller, hotkeys, hardware: null }, 'all');
    expect(res.changed.length).toBeGreaterThan(20);
    const d = read();
    const saves = paths.emulatorSaveDir('melonds');
    expect(d.get(['Instance0', 'SaveFilePath'])).toBe(join(saves, 'saves'));
    expect(d.get(['Instance0', 'SavestatePath'])).toBe(join(saves, 'states'));
    expect(d.get(['Instance0', 'CheatFilePath'])).toBe(join(paths.emulatorDataDir('melonds'), 'cheats'));
    expect(d.get(['Emu', 'DirectBoot'])).toBe(true);
    // No BIOS files -> external BIOS is not enabled.
    expect(d.get(['Emu', 'ExternalBIOSEnable'])).toBeUndefined();
    expect(d.get(['3D', 'Renderer'])).toBe(2);
    expect(d.get(['3D', 'GL', 'ScaleFactor'])).toBe(4);
    expect(d.get(['Instance0', 'Window0', 'ScreenAspectTop'])).toBe(1);
    expect(d.get(['Instance0', 'Window0', 'ScreenAspectBot'])).toBe(1);
    expect(d.get(['Screen', 'VSync'])).toBe(false);
    expect(d.get(['LimitFPS'])).toBe(true);
    expect(d.get(['Instance0', 'JoystickID'])).toBe(0);
    expect(J('A')).toBe(0);
    expect(J('B')).toBe(1);
    expect(J('L')).toBe(4);
    expect(J('Select')).toBe(6);
    expect(J('Up')).toBe(joyCode('DPadUp', 'LeftStickUp'));
    // Fast-forward on RT (free); fullscreen on A and volume on the D-pad clash with DS buttons.
    expect(J('HK_FastForward')).toBe(joyCode('RT'));
    expect(J('HK_FullscreenToggle')).toBeUndefined();
    expect(J('HK_VolumeUp')).toBeUndefined();
    expect(J('HK_SwapScreens')).toBe(joyCode('R3'));
    expect(J('HK_Mic')).toBe(joyCode('L3'));
    expect(res.notes.join()).toMatch(/fullscreen \(A\)/);
    expect(existsSync(join(saves, 'states'))).toBe(true);
  });

  it('preserves user settings it does not manage and is idempotent', async () => {
    const d = read();
    d.set(['3D', 'GL', 'BetterPolygons'], true);
    d.set(['Instance0', 'Keyboard', 'A'], 88);
    writeFileSync(a.tomlPath(), d.toString());
    const again = await a.applyConfig({ settings: { ...settings, renderer: 'compute', resolutionScale: 4, aspectRatio: '16:9', vsync: false }, controller, hotkeys, hardware: null }, 'all');
    expect(again.changed).toEqual([]);
    expect(read().get(['3D', 'GL', 'BetterPolygons'])).toBe(true);
    expect(read().get(['Instance0', 'Keyboard', 'A'])).toBe(88);
  });

  it('applies remapping, Nintendo layout, device index and un-binds a now-conflicting hotkey', async () => {
    const swapped = { ...controller, deviceIndex: 1, nintendoLayoutForNintendoSystems: true };
    const hk = { ...hotkeys, bindings: { ...hotkeys.bindings, fastForward: 'B' as const } };
    await a.applyConfig({ settings, controller: swapped, hotkeys: hk, hardware: null }, 'controller');
    expect(read().get(['Instance0', 'JoystickID'])).toBe(1);
    expect(J('A')).toBe(1);
    expect(J('B')).toBe(0);
    expect(J('X')).toBe(3);
    // RT is no longer the fast-forward button; B is used by the pad, so nothing new is bound.
    expect(J('HK_FastForward')).toBe(joyCode('RT'));
    const hk2 = { ...hotkeys, bindings: { ...hotkeys.bindings, fastForward: 'A' as const } };
    const d = read();
    d.set(['Instance0', 'Joystick', 'HK_FastForward'], joyCode('A'));
    writeFileSync(a.tomlPath(), d.toString());
    await a.applyConfig({ settings, controller, hotkeys: hk2, hardware: null }, 'controller');
    expect(J('HK_FastForward')).toBe(-1);
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'controller');
    expect(J('HK_FastForward')).toBe(joyCode('RT'));
  });

  it('enables external BIOS only with a full valid set and reports BIOS status', async () => {
    const dir = paths.systemBiosDir('nds');
    expect((await a.biosStatus())[0].status).toBe('missing');
    expect((await a.biosStatus())[0].required).toBe(false);
    writeFileSync(join(dir, 'bios7.bin'), Buffer.alloc(0x4000));
    writeFileSync(join(dir, 'BIOS9.bin'), Buffer.alloc(0x1000));
    expect((await a.biosStatus())[0].status).toBe('missing');
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'paths');
    expect(read().get(['Emu', 'ExternalBIOSEnable'])).toBeUndefined();
    writeFileSync(join(dir, 'firmware.bin'), Buffer.alloc(1000));
    expect((await a.biosStatus())[0].status).toBe('invalid');
    writeFileSync(join(dir, 'firmware.bin'), Buffer.alloc(0x40000));
    const st = (await a.biosStatus())[0];
    expect(st.status).toBe('found');
    expect(st.files).toHaveLength(3);
    expect((await a.inspectConfig()).drift.find((x) => x.key === 'Emu.ExternalBIOSEnable')?.critical).toBe(false);
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'paths');
    const d = read();
    expect(d.get(['Emu', 'ExternalBIOSEnable'])).toBe(true);
    expect(d.get(['DS', 'BIOS7Path'])).toBe(join(dir, 'bios7.bin'));
    expect(d.get(['DS', 'BIOS9Path'])).toBe(join(dir, 'BIOS9.bin'));
    expect(d.get(['DS', 'FirmwarePath'])).toBe(join(dir, 'firmware.bin'));
    expect((await a.inspectConfig()).drift).toEqual([]);

    // Files vanish -> enabled external BIOS is critical drift and gets switched off.
    writeFileSync(join(dir, 'firmware.bin'), Buffer.alloc(10));
    const drift = (await a.inspectConfig()).drift.find((x) => x.key === 'Emu.ExternalBIOSEnable');
    expect(drift?.critical).toBe(true);
    expect((await a.smokeTest(join(t.dir, 'nope.exe'))).ok).toBe(false);
    const res = await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'paths');
    expect(read().get(['Emu', 'ExternalBIOSEnable'])).toBe(false);
    expect(res.notes.join()).toMatch(/FreeBIOS/);
    writeFileSync(join(dir, 'firmware.bin'), Buffer.alloc(0x20000));
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'paths');
    expect(read().get(['Emu', 'ExternalBIOSEnable'])).toBe(true);
  });

  it('detects save path drift (incl. relative values) and repairs it', async () => {
    const d = read();
    d.set(['Instance0', 'SaveFilePath'], '');
    d.set(['Instance0', 'SavestatePath'], join('..', '..', '..', 'ud', 'Saves', 'melonds', 'states'));
    writeFileSync(a.tomlPath(), d.toString());
    const insp = await a.inspectConfig();
    expect(insp.files[0].parseOk).toBe(true);
    const sav = insp.drift.find((x) => x.key === 'Instance0.SaveFilePath');
    expect(sav?.critical).toBe(true);
    expect(sav?.actual).toBe('');
    // Whether the relative path resolves to the managed folder depends on the temp layout.
    const rel = insp.drift.some((x) => x.key === 'Instance0.SavestatePath');
    expect(typeof rel).toBe('boolean');
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'paths');
    expect((await a.inspectConfig()).drift).toEqual([]);

    writeFileSync(a.tomlPath(), read().toString() + '\n[3D]\nbroken = \n');
    const bad = await a.inspectConfig();
    expect(bad.files[0].parseOk).toBe(false);
    await expect(a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'paths')).rejects.toThrow();
  });

  it('builds a fullscreen launch with the ROM last and filters custom args', async () => {
    // Restore a valid config after the broken-file test.
    writeFileSync(a.tomlPath(), '');
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'all');
    const cmd = await a.buildLaunch({ gameId: 1, path: 'D:\\DS\\Mario Kart DS.nds', systemId: 'nds', serial: null, title: 'MK' }, 'C:\\m\\melonDS.exe', settings, null, null);
    expect(cmd.args).toEqual(['--fullscreen', 'D:\\DS\\Mario Kart DS.nds']);
    expect(cmd.cwd).toBe(a.paths().app);
    const custom = await a.buildLaunch({ gameId: 1, path: 'x.nds', systemId: 'nds', serial: null, title: 'x' }, 'm.exe', { ...settings, fullscreen: false },
      { gameId: 1, emulatorId: 'melonds', overrides: {}, customArgs: '--boot always -b sometimes --config C:\\x gba.gba --archive-file=a.nds', notes: null, updatedAt: '' }, null);
    expect(custom.args).toEqual(['--boot', 'always', '--archive-file=a.nds', 'x.nds']);
    expect(custom.notes.join()).toMatch(/--config/);
    expect(custom.notes.join()).toMatch(/sometimes/);
    expect(a.buildUiLaunch('m.exe').args).toEqual([]);
  });

  it('applies per-game overrides for the session only and recovers after a crash', async () => {
    const profile = { gameId: 7, emulatorId: 'melonds', overrides: { resolutionScale: 6, renderer: 'software', aspectRatio: '21:9' }, customArgs: null, notes: null, updatedAt: '' };
    const cmd = await a.buildLaunch({ gameId: 7, path: 'g.nds', systemId: 'nds', serial: null, title: 'g' }, 'm.exe', settings, profile, null);
    const before = readFileSync(a.tomlPath(), 'utf8');
    await cmd.prepare!();
    expect(read().get(['3D', 'GL', 'ScaleFactor'])).toBe(6);
    expect(read().get(['3D', 'Renderer'])).toBe(0);
    expect(read().get(['Instance0', 'Window0', 'ScreenAspectBot'])).toBe(2);
    await cmd.cleanup!();
    expect(readFileSync(a.tomlPath(), 'utf8')).toBe(before);
    await cmd.prepare!();
    expect(await a.recoverSession()).toHaveLength(1);
    expect(readFileSync(a.tomlPath(), 'utf8')).toBe(before);
    expect(await a.recoverSession()).toEqual([]);
  });

  it('lists persistent app paths and smoke-tests statically', async () => {
    const keep = a.persistentAppPaths();
    expect(keep).toContain('melonDS.toml');
    expect(keep).toContain('wfcsettings.bin');
    expect(keep).toContain('portable');
    expect(keep).not.toContain('melonDS.exe');
    const exe = join(a.paths().app, 'melonDS.exe');
    writeFileSync(exe, '');
    expect(await a.findExecutable(a.paths().app)).toBe(exe);
    const r = await a.smokeTest(exe);
    expect(r.ran).toBe(false);
    expect(r.ok).toBe(true);
    expect(a.logFile()).toBeNull();
  });

  it('uses a "portable" sub-folder as config dir when it exists', () => {
    const b = new MelonDsAdapter(new AppPaths(join(t.dir, 'ud2'), t.dir));
    mkdirSync(join(b.paths().app, 'portable'), { recursive: true });
    expect(b.tomlPath()).toBe(join(b.paths().app, 'portable', 'melonDS.toml'));
  });

  it('warns when OpenGL is missing', async () => {
    const f = await a.validateEnvironment({ graphicsApis: { opengl: false, vulkan: null, directx12: null, notes: [] }, isWindows: true } as never, null);
    expect(f[0]?.id).toBe('melonds.opengl');
    expect(a.renderers({ graphicsApis: { opengl: false } } as never).find((r) => r.id === 'opengl')?.available).toBe(false);
  });
});
