import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppPaths } from '../src/main/core/paths';
import { KytyAdapter, kytyResolutionScale, parseKytyVersion } from '../src/main/emulators/kyty/adapter';
import { validateManifest } from '../src/main/emulators/registry';
import { defaultProfile } from '../src/main/controllers/translate';
import { DEFAULT_SETTINGS } from '../src/main/database/settingsRepo';
import { IniDocument } from '../src/main/config/ini';
import { compareVersions } from '../src/main/emulators/versions';
import type { HardwareProfile } from '../src/shared/models';
import { tempDir } from './helpers';

const t = tempDir();
afterAll(t.cleanup);
const paths = new AppPaths(join(t.dir, 'ud'), t.dir);
const controller = { ...defaultProfile(), id: 1, updatedAt: '' };
const hotkeys = DEFAULT_SETTINGS.hotkeys;
const a = new KytyAdapter(paths);
const json = () => JSON.parse(readFileSync(a.configPath(), 'utf8'));

describe('KytyPS5 adapter', () => {
  const settings = { ...a.defaultSettings(null, 'balanced'), vsync: true };

  it('has a valid manifest for PS5 only, with the official release asset pattern', () => {
    expect(validateManifest(a.manifest)).toEqual([]);
    expect(a.manifest.implemented).toBe(true);
    expect(a.manifest.systems).toEqual(['ps5']);
    const re = new RegExp(a.manifest.download.assetPatterns![0]);
    expect(re.test('KytyPS5-2026-10-10-307fdcf-Windows-x64.zip')).toBe(true);
    expect(re.test('KytyPS5-2026-10-10-307fdcf-Linux-x86_64.tar.gz')).toBe(false);
    expect(re.test('KytyPS5-2026-10-10-307fdcf.zip')).toBe(false);
  });

  it('writes paths, graphics, controller and update-check settings', async () => {
    const res = await a.applyConfig({ settings: { ...settings, resolutionScale: 2, advanced: { gpu: '1', 'amd-cpu': 'true', 'not-an-option': 'x' } }, controller, hotkeys, hardware: null }, 'all');
    expect(res.changed.length).toBeGreaterThan(5);
    const m = json().managed;
    expect(m.workingDirectory).toBe(paths.emulatorSaveDir('kyty'));
    expect(m.logFile).toBe(join(paths.emulatorDataDir('kyty'), 'logs', 'kyty.log'));
    expect([m.screenWidth, m.screenHeight]).toEqual([1920, 1080]);
    expect(m.presentMode).toBe('Fifo');
    expect(m.fullscreen).toBe(true);
    expect(m.controllerVibration).toBe(100);
    expect(m.options).toEqual({ gpu: '1', 'amd-cpu': 'true' });
    expect(json().user).toEqual({ keymap: [], extraArgs: [] });
    const ini = IniDocument.parse(readFileSync(a.launcherIniPath(), 'utf8'));
    expect(ini.get('MainDialog', 'check_updates_on_startup')).toBe('false');
    expect(existsSync(join(paths.emulatorSaveDir('kyty'), '_SaveData'))).toBe(true);
  });

  it('is idempotent and preserves user keys', async () => {
    const doc = json();
    doc.user = { keymap: ['Cross=Space'], extraArgs: ['--tessellation'] };
    doc.mine = 42;
    writeFileSync(a.configPath(), JSON.stringify(doc));
    const ini = IniDocument.parse(readFileSync(a.launcherIniPath(), 'utf8'));
    ini.set('Launcher', 'grid_view', true);
    writeFileSync(a.launcherIniPath(), ini.toString());
    const again = await a.applyConfig({ settings: { ...settings, resolutionScale: 2, advanced: { gpu: '1', 'amd-cpu': 'true' } }, controller, hotkeys, hardware: null }, 'all');
    expect(again.changed).toEqual([]);
    expect(json().user.keymap).toEqual(['Cross=Space']);
    expect(json().mine).toBe(42);
    expect(IniDocument.parse(readFileSync(a.launcherIniPath(), 'utf8')).get('Launcher', 'grid_view')).toBe('true');
  });

  it('translates rumble and reports what cannot be remapped', async () => {
    const swapped = { ...controller, rumble: false, mapping: { ...controller.mapping, A: 'B' as const, B: 'A' as const } };
    const res = await a.applyConfig({ settings, controller: swapped, hotkeys, hardware: null }, 'controller');
    expect(json().managed.controllerVibration).toBe(0);
    expect(res.notes.join()).toMatch(/cannot remap Cross, Circle/);
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'controller');
    expect(a.capabilities.hotkeys).toEqual([]);
  });

  it('maps vsync and resolution, clamping to the launcher resolutions', async () => {
    await a.applyConfig({ settings: { ...settings, vsync: false, resolutionScale: 9 }, controller, hotkeys, hardware: null }, 'graphics');
    expect(json().managed.presentMode).toBe('Mailbox');
    expect([json().managed.screenWidth, json().managed.screenHeight]).toEqual([3840, 2160]);
    const hw = { tier: 'low', displays: [{ primary: true, height: 1080 }] } as unknown as HardwareProfile;
    expect(kytyResolutionScale(hw, 'maximum')).toBe(1);
    expect(kytyResolutionScale({ tier: 'enthusiast', displays: [{ primary: true, height: 2160 }] } as unknown as HardwareProfile, 'maximum')).toBe(4);
  });

  it('detects drift on managed paths and the update check', async () => {
    const doc = json();
    doc.managed.workingDirectory = 'C:\\elsewhere';
    writeFileSync(a.configPath(), JSON.stringify(doc));
    const ini = IniDocument.parse(readFileSync(a.launcherIniPath(), 'utf8'));
    ini.set('MainDialog', 'check_updates_on_startup', true);
    writeFileSync(a.launcherIniPath(), ini.toString());
    const insp = await a.inspectConfig();
    expect(insp.files.every((f) => f.parseOk)).toBe(true);
    expect(insp.drift.find((d) => d.key === 'managed.workingDirectory')?.critical).toBe(true);
    expect(insp.drift.find((d) => d.key === 'MainDialog.check_updates_on_startup')?.actual).toBe('true');
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'paths');
    expect((await a.inspectConfig()).drift).toEqual([]);
  });

  it('flags an unparseable config file', async () => {
    writeFileSync(a.configPath(), '{ broken');
    expect((await a.inspectConfig()).files[0].parseOk).toBe(false);
    const res = await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'all');
    expect(res.notes.join()).toMatch(/regenerated/);
    expect((await a.inspectConfig()).files[0].parseOk).toBe(true);
  });

  it('builds a launch with the game folder last, logs, saves cwd and per-game overrides', async () => {
    const doc = json();
    doc.user = { keymap: ['Cross=Space', 'bogus'], extraArgs: [] };
    writeFileSync(a.configPath(), JSON.stringify(doc));
    const exe = join(paths.emulatorAppDir('kyty'), 'kyty_emulator.exe');
    const game = join(t.dir, 'Games', 'PPSA01234', 'eboot.bin');
    mkdirSync(join(paths.emulatorAppDir('kyty'), '_Patches'), { recursive: true });
    writeFileSync(join(paths.emulatorAppDir('kyty'), '_Patches', 'PPSA01234.json'), '{}');
    const target = { gameId: 7, path: game, systemId: 'ps5' as const, serial: 'PPSA01234', title: 'Test' };
    const profile = { gameId: 7, emulatorId: 'kyty', overrides: { resolutionScale: 1, vsync: false }, customArgs: '--user-name "Player One"', notes: null, updatedAt: '' };
    const cmd = await a.buildLaunch(target, exe, { ...settings, resolutionScale: 2 }, profile, 'KytyPS5-2026-10-10-307fdcf');
    expect(cmd.command).toBe(exe);
    expect(cmd.cwd).toBe(paths.emulatorSaveDir('kyty'));
    expect(cmd.logFile).toBe(a.logFile());
    expect(cmd.args.slice(-2)).toEqual(['--game', join(t.dir, 'Games', 'PPSA01234')]);
    expect(cmd.args).toContain('--fullscreen');
    expect(cmd.args).toContain('--hide-cursor');
    const val = (f: string) => cmd.args[cmd.args.indexOf(f) + 1];
    expect(val('--printf-direction')).toBe('File');
    expect(val('--printf-output-file')).toBe(a.logFile());
    expect(val('--screen-width')).toBe('1280');
    expect(val('--screen-height')).toBe('720');
    expect(val('--present-mode')).toBe('Mailbox');
    expect(val('--controller-vibration')).toBe('100');
    expect(val('--keymap')).toBe('Cross=Space');
    expect(cmd.args.filter((x) => x === '--keymap')).toHaveLength(1);
    expect(val('--game-patch')).toBe(join(paths.emulatorAppDir('kyty'), '_Patches', 'PPSA01234.json'));
    expect(val('--user-name')).toBe('Player One');
    expect(cmd.args.indexOf('--user-name')).toBeLessThan(cmd.args.indexOf('--game'));

    const zar = await a.buildLaunch({ ...target, path: 'D:\\Games\\X.zar', serial: null }, exe, { ...settings, fullscreen: false }, null, null);
    expect(zar.args.slice(-1)).toEqual(['D:\\Games\\X.zar']);
    expect(zar.args).not.toContain('--fullscreen');
    expect(zar.args).not.toContain('--game-patch');
  });

  it('opens the Qt launcher from the data folder for UI use', () => {
    const exe = join(paths.emulatorAppDir('kyty'), 'kyty_emulator.exe');
    writeFileSync(join(paths.emulatorAppDir('kyty'), 'launcher.exe'), '');
    const ui = a.buildUiLaunch(exe);
    expect(ui.command).toBe(join(paths.emulatorAppDir('kyty'), 'launcher.exe'));
    expect(ui.cwd).toBe(paths.emulatorDataDir('kyty'));
  });

  it('reports firmware as not applicable', async () => {
    const st = await a.biosStatus();
    expect(st).toHaveLength(1);
    expect(st[0].status).toBe('not_applicable');
    expect(st[0].systemId).toBe('ps5');
  });

  it('keeps launcher-created user data across updates', () => {
    expect(a.persistentAppPaths()).toEqual(expect.arrayContaining(['_SaveData', '_Trophies', '_DownloadData', '_Patches', 'Kyty.ini']));
    expect(a.saveLocations()[0].path).toBe(join(paths.emulatorSaveDir('kyty'), '_SaveData'));
  });

  it('reports missing Vulkan as a problem and always notes limited compatibility', async () => {
    const hw = { graphicsApis: { vulkan: false, directx12: true, opengl: true, notes: ['vulkan-1.dll missing'] }, gpus: [{ name: 'Old GPU' }] } as unknown as HardwareProfile;
    const f = await a.validateEnvironment(hw, null);
    expect(f.find((x) => x.id === 'kyty.vulkan')?.severity).toBe('problem');
    expect(f.find((x) => x.id === 'kyty.compatibility')?.severity).toBe('info');
    const ok = await a.validateEnvironment({ ...hw, graphicsApis: { ...hw.graphicsApis, vulkan: true } } as HardwareProfile, null);
    expect(ok.find((x) => x.id === 'kyty.vulkan')).toBeUndefined();
    expect(a.renderers(hw)[0].available).toBe(false);
  });

  it('runs static smoke checks and skips execution off Windows', async () => {
    const exe = join(paths.emulatorAppDir('kyty'), 'kyty_emulator.exe');
    writeFileSync(exe, '');
    expect(await a.findExecutable(paths.emulatorAppDir('kyty'))).toBe(exe);
    const r = await a.smokeTest(exe);
    expect(r.checks[0].ok).toBe(true);
    if (process.platform !== 'win32') expect(r.ran).toBe(false);
  });

  it('parses versions and orders release tags by date', () => {
    expect(parseKytyVersion('Release, clang-lld, ver = 0.3.0, git = 307fdcf, date = 2026-10-10')).toBeNull();
    expect(parseKytyVersion('Release, clang-lld, ver = 0.3.0, git = KytyPS5-2026-10-10-307fdcf, date = x')).toBe('KytyPS5-2026-10-10-307fdcf');
    expect(compareVersions('KytyPS5-2026-10-10-307fdcf', 'KytyPS5-2026-10-09-c1926f9')).toBe(1);
    expect(compareVersions('KytyPS5-2026-11-01-0000000', 'KytyPS5-2026-10-31-fffffff')).toBe(1);
  });
});
