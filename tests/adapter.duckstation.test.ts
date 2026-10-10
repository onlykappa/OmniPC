import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppPaths } from '../src/main/core/paths';
import { DuckStationAdapter, gameListPaths } from '../src/main/emulators/duckstation/adapter';
import { validateManifest } from '../src/main/emulators/registry';
import { pickAsset } from '../src/main/downloads/sources';
import { defaultProfile } from '../src/main/controllers/translate';
import { DEFAULT_SETTINGS } from '../src/main/database/settingsRepo';
import { IniDocument } from '../src/main/config/ini';
import { tempDir } from './helpers';

const t = tempDir();
afterAll(t.cleanup);
const paths = new AppPaths(join(t.dir, 'ud'), t.dir);
const controller = { ...defaultProfile(), id: 1, updatedAt: '' };
const hotkeys = DEFAULT_SETTINGS.hotkeys;

describe('DuckStation adapter', () => {
  const a = new DuckStationAdapter(paths);
  const settings = a.defaultSettings(null, 'balanced');
  const read = () => IniDocument.parse(readFileSync(a.iniPath(), 'utf8'));

  it('has a valid manifest selecting only the official x64 zip', () => {
    expect(validateManifest(a.manifest)).toEqual([]);
    expect(a.manifest.implemented).toBe(true);
    const names = [
      'duckstation-windows-arm64-release.zip', 'duckstation-windows-x64-installer.exe', 'duckstation-windows-x64-release-symbols.7z',
      'duckstation-windows-x64-sse2-release.zip', 'duckstation-windows-x64-release.zip', 'DuckStation-x64.AppImage',
    ].map((name) => ({ name, browser_download_url: `https://github.com/stenzek/duckstation/releases/download/latest/${name}`, size: 1 }));
    expect(pickAsset(names, a.manifest.download.assetPatterns!, a.manifest.download.assetExclude!, [])?.name).toBe('duckstation-windows-x64-release.zip');
  });

  it('keeps settings.ini in the app dir (portable) and everything else outside', () => {
    expect(a.iniPath()).toBe(join(paths.emulatorAppDir('duckstation'), 'settings.ini'));
    expect(a.paths().bios).toBe(paths.systemBiosDir('ps1'));
  });

  it('generates paths, prompt suppression, graphics, controller and hotkeys in settings.ini', async () => {
    const res = await a.applyConfig({ settings: { ...settings, renderer: 'vulkan', resolutionScale: 4, aspectRatio: '16:9' }, controller, hotkeys, hardware: null }, 'all');
    expect(res.changed.length).toBeGreaterThan(40);
    expect(existsSync(join(a.paths().app, 'portable.txt'))).toBe(true);
    const ini = read();
    const saves = paths.emulatorSaveDir('duckstation');
    expect(ini.get('BIOS', 'SearchDirectory')).toBe(paths.systemBiosDir('ps1'));
    expect(ini.get('MemoryCards', 'Directory')).toBe(join(saves, 'memcards'));
    expect(ini.get('Folders', 'SaveStates')).toBe(join(saves, 'savestates'));
    expect(ini.get('Folders', 'Screenshots')).toBe(join(saves, 'screenshots'));
    expect(ini.get('Folders', 'Cache')).toBe(paths.emulatorCacheDir('duckstation'));
    expect(ini.get('Folders', 'GameSettings')).toBe(join(paths.emulatorDataDir('duckstation'), 'gamesettings'));
    // Setup wizard runs even with -nogui unless this is false.
    expect(ini.get('Main', 'SetupWizardIncomplete')).toBe('false');
    expect(ini.get('Main', 'ConfirmPowerOff')).toBe('false');
    expect(ini.get('AutoUpdater', 'CheckAtStartup')).toBe('false');
    expect(ini.get('Logging', 'LogToFile')).toBe('true');
    expect(ini.get('GPU', 'Renderer')).toBe('Vulkan');
    expect(ini.get('GPU', 'ResolutionScale')).toBe('4');
    expect(ini.get('Display', 'AspectRatio')).toBe('16:9');
    expect(ini.get('Main', 'EmulationSpeed')).toBe('1');
    expect(ini.get('Main', 'StartFullscreen')).toBe('true');
    expect(ini.get('InputSources', 'SDL')).toBe('true');
    expect(ini.get('Pad1', 'Type')).toBe('AnalogController');
    expect(ini.get('Pad1', 'Cross')).toBe('SDL-0/A');
    expect(ini.get('Pad1', 'Triangle')).toBe('SDL-0/Y');
    expect(ini.get('Pad1', 'Select')).toBe('SDL-0/Back');
    expect(ini.get('Pad1', 'L2')).toBe('SDL-0/+LeftTrigger');
    expect(ini.get('Pad1', 'LUp')).toBe('SDL-0/-LeftY');
    expect(ini.get('Pad1', 'RRight')).toBe('SDL-0/+RightX');
    expect(ini.get('Pad1', 'Analog')).toBe('SDL-0/Guide');
    expect(ini.get('Pad1', 'LargeMotor')).toBe('SDL-0/LargeMotor');
    expect(ini.get('Pad1', 'AnalogDeadzone')).toBe('0.15');
    expect(ini.get('Hotkeys', 'PowerOff')).toBe('SDL-0/Back & SDL-0/Start');
    expect(ini.get('Hotkeys', 'SaveSelectedSaveState')).toBe('SDL-0/Back & SDL-0/RightShoulder');
    expect(ini.get('Hotkeys', 'ToggleFastForward')).toBe('SDL-0/Back & SDL-0/+RightTrigger');
    expect(ini.get('Hotkeys', 'OpenPauseMenu')).toBe('SDL-0/Back & SDL-0/Y');
    expect(existsSync(join(saves, 'memcards'))).toBe(true);
    expect(existsSync(paths.systemBiosDir('ps1'))).toBe(true);
  });

  it('preserves user settings it does not manage and is idempotent', async () => {
    const doc = read();
    doc.set('GPU', 'PGXPEnable', true);
    writeFileSync(a.iniPath(), doc.toString());
    const again = await a.applyConfig({ settings: { ...settings, renderer: 'vulkan', resolutionScale: 4, aspectRatio: '16:9' }, controller, hotkeys, hardware: null }, 'all');
    expect(again.changed).toEqual([]);
    expect(read().get('GPU', 'PGXPEnable')).toBe('true');
  });

  it('applies remapping, device index, rumble off and a Guide-based hotkey', async () => {
    const swapped = { ...controller, deviceIndex: 1, rumble: false, mapping: { ...controller.mapping, A: 'B' as const, B: 'A' as const } };
    const guideHotkeys = { ...hotkeys, modifier: 'Guide' as const };
    await a.applyConfig({ settings, controller: swapped, hotkeys: guideHotkeys, hardware: null }, 'controller');
    const ini = read();
    expect(ini.get('Pad1', 'Cross')).toBe('SDL-1/B');
    expect(ini.get('Pad1', 'Circle')).toBe('SDL-1/A');
    expect(ini.get('Pad1', 'LargeMotor')).toBeUndefined();
    expect(ini.get('Pad1', 'Analog')).toBeUndefined();
    expect(ini.get('Hotkeys', 'PowerOff')).toBe('SDL-1/Guide & SDL-1/Start');
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'controller');
  });

  it('detects path drift (incl. relative values) and repairs it', async () => {
    const doc = read();
    doc.set('BIOS', 'SearchDirectory', 'bios');
    doc.set('Main', 'SetupWizardIncomplete', true);
    writeFileSync(a.iniPath(), doc.toString());
    const insp = await a.inspectConfig();
    expect(insp.files[0].parseOk).toBe(true);
    const bios = insp.drift.find((d) => d.key === 'BIOS.SearchDirectory');
    expect(bios?.critical).toBe(true);
    expect(bios?.actual).toBe('bios');
    expect(insp.drift.find((d) => d.key === 'Main.SetupWizardIncomplete')?.critical).toBe(true);
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'paths');
    expect((await a.inspectConfig()).drift).toEqual([]);

    // A relative value that resolves to the managed folder is not drift.
    const rel = read();
    const relBios = join('..', '..', '..', 'ud', 'BIOS', 'ps1');
    rel.set('BIOS', 'SearchDirectory', relBios);
    writeFileSync(a.iniPath(), rel.toString());
    const expected = a.resolveFolder(relBios) === paths.systemBiosDir('ps1');
    expect((await a.inspectConfig()).drift.some((d) => d.key === 'BIOS.SearchDirectory')).toBe(!expected);
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'paths');
  });

  it('builds a -nogui launch with the game after "--" and filters unknown custom args', async () => {
    const cmd = await a.buildLaunch({ gameId: 1, path: 'D:\\PS1\\Vagrant Story.chd', systemId: 'ps1', serial: null, title: 'VS' }, 'C:\\ds\\duckstation-qt-x64-ReleaseLTCG.exe', settings, null, null);
    expect(cmd.args).toEqual(['-nogui', '-fullscreen', '--', 'D:\\PS1\\Vagrant Story.chd']);
    expect(cmd.cwd).toBe(a.paths().app);
    expect(cmd.logFile).toMatch(/duckstation\.log$/);
    const custom = await a.buildLaunch({ gameId: 1, path: 'x.cue', systemId: 'ps1', serial: null, title: 'x' }, 'ds.exe', { ...settings, fullscreen: false }, { gameId: 1, emulatorId: 'duckstation', overrides: {}, customArgs: '-fastboot -state 2 -datapath C:\\x', notes: null, updatedAt: '' }, null);
    expect(custom.args).toEqual(['-nogui', '-fastboot', '-state', '2', '--', 'x.cue']);
    expect(custom.notes.join()).toMatch(/-datapath/);
    expect(a.buildUiLaunch('ds.exe').args).toEqual([]);
  });

  it('applies per-game overrides for the session only and recovers after a crash', async () => {
    const profile = { gameId: 7, emulatorId: 'duckstation', overrides: { resolutionScale: 8, renderer: 'software' }, customArgs: null, notes: null, updatedAt: '' };
    const cmd = await a.buildLaunch({ gameId: 7, path: 'g.cue', systemId: 'ps1', serial: null, title: 'g' }, 'ds.exe', settings, profile, null);
    const before = readFileSync(a.iniPath(), 'utf8');
    await cmd.prepare!();
    expect(read().get('GPU', 'ResolutionScale')).toBe('8');
    expect(read().get('GPU', 'Renderer')).toBe('Software');
    await cmd.cleanup!();
    expect(readFileSync(a.iniPath(), 'utf8')).toBe(before);
    await cmd.prepare!();
    expect(await a.recoverSession()).toHaveLength(1);
    expect(readFileSync(a.iniPath(), 'utf8')).toBe(before);
    expect(await a.recoverSession()).toEqual([]);
  });

  it('reports PS1 BIOS status by size', async () => {
    const dir = paths.systemBiosDir('ps1');
    expect((await a.biosStatus())[0].status).toBe('missing');
    writeFileSync(join(dir, 'broken.bin'), Buffer.alloc(300 * 1024));
    expect((await a.biosStatus())[0].status).toBe('invalid');
    writeFileSync(join(dir, 'scph1001.bin'), Buffer.alloc(512 * 1024));
    writeFileSync(join(dir, 'readme.txt'), 'hi');
    const st = (await a.biosStatus())[0];
    expect(st.status).toBe('found');
    expect(st.files.map((f) => [f.path.endsWith('scph1001.bin'), f.valid]).filter(([n]) => n)).toEqual([[true, true]]);
    expect(st.files).toHaveLength(2);
  });

  it('writes the portable marker on install and lists persistent app paths', async () => {
    const appDir = join(t.dir, 'fresh-app');
    mkdirSync(appDir, { recursive: true });
    expect((await a.prepareInstall(appDir)).length).toBe(1);
    expect(existsSync(join(appDir, 'portable.txt'))).toBe(true);
    expect(await a.prepareInstall(appDir)).toEqual([]);
    const keep = a.persistentAppPaths();
    expect(keep).toContain('settings.ini');
    expect(keep).toContain('playtime.dat');
    // The program's own resources folder must never be treated as user data.
    expect(keep).not.toContain('resources');
  });

  it('smoke test checks resources and skips execution off Windows', async () => {
    const exe = join(a.paths().app, 'duckstation-qt-x64-ReleaseLTCG.exe');
    writeFileSync(exe, '');
    expect(await a.findExecutable(a.paths().app)).toBe(exe);
    const r1 = await a.smokeTest(exe);
    expect(r1.checks.find((c) => c.label === 'Resources present')?.ok).toBe(false);
    mkdirSync(join(a.paths().app, 'resources'), { recursive: true });
    writeFileSync(join(a.paths().app, 'resources', 'duckstation-qt.rcc'), '');
    if (process.platform === 'win32') mkdirSync(join(a.paths().app, 'QtPlugins', 'platforms'), { recursive: true });
    if (process.platform === 'win32') writeFileSync(join(a.paths().app, 'QtPlugins', 'platforms', 'qwindows.dll'), '');
    const r2 = await a.smokeTest(exe);
    if (process.platform !== 'win32') {
      expect(r2.ran).toBe(false);
      expect(r2.ok).toBe(true);
    }
  });

  it('flags CPUs without SSE4.1', async () => {
    const hw = { cpu: { features: ['sse2'] }, isWindows: true } as never;
    const f = await a.validateEnvironment(hw, 'C:\\ds\\duckstation-qt-x64-ReleaseLTCG.exe');
    expect(f[0]?.id).toBe('duckstation.sse41');
    expect(await a.validateEnvironment({ cpu: { features: ['sse41'] }, isWindows: true } as never, 'x.exe')).toEqual([]);
  });

  it('parses repeated [GameList] path keys', () => {
    expect(gameListPaths('[Main]\nPaths = no\n[GameList]\nRecursivePaths = D:\\PS1\nRecursivePaths = E:\\PSX\nPaths = F:\\X\n')).toEqual(['D:\\PS1', 'E:\\PSX', 'F:\\X']);
  });
});
