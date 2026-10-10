import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppPaths } from '../src/main/core/paths';
import { PpssppAdapter } from '../src/main/emulators/ppsspp/adapter';
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
const a = new PpssppAdapter(paths);
const settings = a.defaultSettings(null, 'balanced');
const ini = () => IniDocument.parse(readFileSync(a.iniPath(), 'utf8'));
const controls = () => IniDocument.parse(readFileSync(a.controlsPath(), 'utf8'));
const list = (v: string | undefined) => (v ?? '').split(',').filter(Boolean);

describe('PPSSPP manifest', () => {
  it('is valid and picks the Windows x64 release zip', () => {
    expect(validateManifest(a.manifest)).toEqual([]);
    expect(a.manifest.implemented).toBe(true);
    const assets = ['PPSSPP-v1.20.4-Windows-ARM64.zip', 'PPSSPP-v1.20.4-Windows-x64.zip', 'PPSSPP-v1.20.4-anylinux-x86_64.AppImage', 'PPSSPPSDL-macOS-v1.20.4.zip']
      .map((name) => ({ name, browser_download_url: `https://github.com/hrydgard/ppsspp/releases/download/v1.20.4/${name}`, size: 1 }));
    expect(pickAsset(assets, a.manifest.download.assetPatterns!, a.manifest.download.assetExclude!, [])?.name).toBe('PPSSPP-v1.20.4-Windows-x64.zip');
  });
});

describe('PPSSPP adapter', () => {
  it('prepareInstall points PPSSPP at the external memory stick via installed.txt', async () => {
    mkdirSync(a.paths().app, { recursive: true });
    writeFileSync(join(a.paths().app, 'PPSSPPWindows64.exe'), '');
    const notes = await a.prepareInstall(a.paths().app);
    expect(notes).toHaveLength(1);
    const txt = readFileSync(a.installedTxt(), 'utf8');
    expect(txt).toBe(a.memstick());
    expect(txt).not.toMatch(/[\r\n]/);
    expect(a.memstick().startsWith(a.paths().data)).toBe(true);
    expect(await a.prepareInstall(a.paths().app)).toEqual([]);
    expect(a.persistentAppPaths()).toEqual(['memstick']);
    expect(await a.findExecutable(a.paths().app)).toBe(join(a.paths().app, 'PPSSPPWindows64.exe'));
  });

  it('generates prompt suppression, graphics, controller and hotkeys', async () => {
    const res = await a.applyConfig({ settings: { ...settings, renderer: 'vulkan', resolutionScale: 4, aspectRatio: 'stretch' }, controller, hotkeys, hardware: null }, 'all');
    expect(res.changed.length).toBeGreaterThan(20);
    const doc = ini();
    expect(doc.get('General', 'FirstRun')).toBe('False');
    expect(doc.get('General', 'CheckForNewVersion')).toBe('False');
    expect(doc.get('General', 'AskForExitConfirmationAfterSeconds')).toBe('0');
    expect(doc.get('Graphics', 'GraphicsBackend')).toBe('3 (VULKAN)');
    expect(doc.get('Graphics', 'SoftwareRenderer')).toBe('False');
    expect(doc.get('Graphics', 'InternalResolution')).toBe('4');
    expect(doc.get('Graphics', 'FullScreen')).toBe('True');
    expect(doc.get('DisplayLayout.Landscape', 'DisplayStretch')).toBe('True');
    expect(doc.get('Control', 'AnalogDeadzone')).toBe('0.15');
    const c = controls();
    // XInput pad 0 = device 20; keyboard defaults are seeded alongside.
    expect(list(c.get('ControlMapping', 'Cross'))).toEqual(['1-54', '10-189', '20-96']);
    expect(list(c.get('ControlMapping', 'Circle'))).toContain('20-97');
    expect(list(c.get('ControlMapping', 'Triangle'))).toContain('20-100');
    expect(list(c.get('ControlMapping', 'L'))).toContain('20-102');
    expect(list(c.get('ControlMapping', 'Up'))).toContain('20-19');
    expect(list(c.get('ControlMapping', 'An.Up'))).toContain('20-4002');
    expect(list(c.get('ControlMapping', 'An.Down'))).toContain('20-4003');
    expect(list(c.get('ControlMapping', 'An.Left'))).toContain('20-4001');
    expect(list(c.get('ControlMapping', 'An.Right'))).toContain('20-4000');
    expect(list(c.get('ControlMapping', 'Exit App'))).toEqual(['20-109:20-108']);
    expect(list(c.get('ControlMapping', 'Save State'))).toEqual(['20-109:20-103']);
    expect(list(c.get('ControlMapping', 'Load State'))).toEqual(['20-109:20-102']);
    expect(list(c.get('ControlMapping', 'Fast-forward'))).toEqual(['1-61', '20-109:20-4036']);
    expect(list(c.get('ControlMapping', 'Pause'))).toEqual(['1-111', '10-109', '10-104', '10-4034', '20-3', '20-109:20-100']);
    expect(list(c.get('ControlMapping', 'SpeedToggle'))).toEqual(['1-68', '20-107']);
    expect(existsSync(join(a.memstick(), 'PSP', 'SAVEDATA'))).toBe(true);
  });

  it('is idempotent and preserves user keys and user bindings', async () => {
    const doc = ini();
    doc.set('Graphics', 'AnisotropyLevel', 4);
    doc.set('Graphics', 'GraphicsBackend', '3'); // PPSSPP also accepts the bare int
    doc.set('Control', 'AnalogDeadzone', '0.150000');
    writeFileSync(a.iniPath(), doc.toString());
    const c = controls();
    c.set('ControlMapping', 'Cross', '20-96,1-54,10-189,1-62'); // reordered + extra keyboard key
    writeFileSync(a.controlsPath(), c.toString());
    const again = await a.applyConfig({ settings: { ...settings, renderer: 'vulkan', resolutionScale: 4, aspectRatio: 'stretch' }, controller, hotkeys, hardware: null }, 'all');
    // Same set of bindings in a different order (as PPSSPP re-saves them) is not a change.
    expect(again.changed).toEqual([]);
    expect(ini().get('Graphics', 'AnisotropyLevel')).toBe('4');
    expect(list(controls().get('ControlMapping', 'Cross'))).toContain('1-62');
  });

  it('applies remapping and device index without touching other pads', async () => {
    const swapped = { ...controller, deviceIndex: 1, mapping: { ...controller.mapping, A: 'B' as const, B: 'A' as const } };
    await a.applyConfig({ settings, controller: swapped, hotkeys, hardware: null }, 'controller');
    const c = controls();
    expect(list(c.get('ControlMapping', 'Cross'))).toEqual(expect.arrayContaining(['20-96', '21-97', '1-54']));
    expect(list(c.get('ControlMapping', 'Circle'))).toContain('21-96');
  });

  it('maps renderers to the GPUBackend enum', async () => {
    await a.applyConfig({ settings: { ...settings, renderer: 'software' }, controller, hotkeys, hardware: null }, 'graphics');
    expect(ini().get('Graphics', 'GraphicsBackend')).toBe('0 (OPENGL)');
    expect(ini().get('Graphics', 'SoftwareRenderer')).toBe('True');
    await a.applyConfig({ settings: { ...settings, renderer: 'd3d11' }, controller, hotkeys, hardware: null }, 'graphics');
    expect(ini().get('Graphics', 'GraphicsBackend')).toBe('2 (DIRECT3D11)');
  });

  it('detects drift on the memory stick location and prompt keys', async () => {
    expect((await a.inspectConfig()).drift).toEqual([]);
    writeFileSync(a.installedTxt(), `${a.memstick()}\r\n`);
    const doc = ini();
    doc.set('General', 'CheckForNewVersion', 'True');
    writeFileSync(a.iniPath(), doc.toString());
    const insp = await a.inspectConfig();
    expect(insp.drift.find((d) => d.key === 'memstick')?.critical).toBe(true);
    expect(insp.drift.find((d) => d.key === 'General.CheckForNewVersion')?.critical).toBe(false);
    expect(insp.files.find((f) => f.label === 'installed.txt')?.parseOk).toBe(false);
    const smoke = await a.smokeTest(join(a.paths().app, 'PPSSPPWindows64.exe'));
    expect(smoke.ran).toBe(false);
    expect(smoke.checks.find((c) => c.label.startsWith('Memory stick location'))?.ok).toBe(false);
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'paths');
    expect((await a.inspectConfig()).drift).toEqual([]);
  });

  it('builds a launch that exits with the game and keeps the game path last', async () => {
    const cmd = await a.buildLaunch({ gameId: 1, path: 'D:\\PSP\\Patapon.iso', systemId: 'psp', serial: 'UCUS98711', title: 'Patapon' }, 'C:\\PPSSPPWindows64.exe', settings, null, '1.20.4');
    expect(cmd.args).toEqual(['--pause-menu-exit', '--fullscreen', 'D:\\PSP\\Patapon.iso']);
    expect(cmd.prepare).toBeUndefined();
    const windowed = await a.buildLaunch({ gameId: 1, path: 'g.cso', systemId: 'psp', serial: null, title: 'G' }, 'x.exe', { ...settings, fullscreen: false }, { gameId: 1, emulatorId: null, overrides: {}, customArgs: '--escape-exit "-x y"', notes: null, updatedAt: '' }, null);
    expect(windowed.args).toEqual(['--pause-menu-exit', '--windowed', '--escape-exit', '-x y', 'g.cso']);
  });

  it('applies per-game overrides for the session and restores only those keys', async () => {
    await a.applyConfig({ settings: { ...settings, resolutionScale: 4 }, controller, hotkeys, hardware: null }, 'graphics');
    const profile = { gameId: 7, emulatorId: null, overrides: { resolutionScale: 8 }, customArgs: null, notes: null, updatedAt: '' };
    const cmd = await a.buildLaunch({ gameId: 7, path: 'g.iso', systemId: 'psp', serial: null, title: 'G' }, 'x.exe', settings, profile, null);
    await cmd.prepare!();
    expect(ini().get('Graphics', 'InternalResolution')).toBe('8');
    // Simulate PPSSPP saving another setting during the session.
    const doc = ini();
    doc.set('Graphics', 'AnisotropyLevel', 16);
    writeFileSync(a.iniPath(), doc.toString());
    await cmd.cleanup!();
    expect(ini().get('Graphics', 'InternalResolution')).toBe('4');
    expect(ini().get('Graphics', 'AnisotropyLevel')).toBe('16');
    // Crash recovery path.
    await cmd.prepare!();
    expect(await a.recoverSession()).toHaveLength(1);
    expect(ini().get('Graphics', 'InternalResolution')).toBe('4');
    expect(await a.recoverSession()).toEqual([]);
  });

  it('needs no BIOS and reports memstick save/cache locations', async () => {
    expect(await a.biosStatus()).toEqual([]);
    expect(a.saveLocations().map((s) => s.path)).toEqual([join(a.memstick(), 'PSP', 'SAVEDATA'), join(a.memstick(), 'PSP', 'PPSSPP_STATE')]);
    expect(a.cacheDirs()[0].path).toBe(join(a.systemDir(), 'CACHE'));
    expect(a.configTargets().map((c) => c.path)).toEqual([a.iniPath(), a.controlsPath()]);
  });

  it('flags graphics backends PPSSPP disabled after crashes', async () => {
    writeFileSync(join(a.systemDir(), 'FailedGraphicsBackends.txt'), 'VULKAN');
    const f = await a.validateEnvironment(null, null);
    expect(f[0]?.id).toBe('ppsspp.failed-backends');
    expect(f[0]?.repair?.params).toEqual({ emulatorId: 'ppsspp', renderer: 'd3d11' });
  });

  it('scales internal resolution for the 272p PSP screen', () => {
    expect(a.defaultSettings(null, 'balanced').resolutionScale).toBe(4);
    expect(a.defaultSettings(null, 'maximum').resolutionScale).toBeLessThanOrEqual(10);
    expect(a.renderers(null).map((r) => r.id)).toEqual(['vulkan', 'd3d11', 'opengl', 'software']);
  });
});
