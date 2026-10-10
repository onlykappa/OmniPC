import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppPaths } from '../src/main/core/paths';
import { Pcsx2Adapter } from '../src/main/emulators/pcsx2/adapter';
import { DolphinAdapter } from '../src/main/emulators/dolphin/adapter';
import { defaultProfile } from '../src/main/controllers/translate';
import { DEFAULT_SETTINGS } from '../src/main/database/settingsRepo';
import { IniDocument } from '../src/main/config/ini';
import { resolutionScaleFor } from '../src/main/emulators/common';
import { classifyTier } from '../src/main/platform/hardware';
import { compareVersions } from '../src/main/emulators/versions';
import type { HardwareProfile } from '../src/shared/models';
import { tempDir } from './helpers';

const t = tempDir();
afterAll(t.cleanup);
const paths = new AppPaths(join(t.dir, 'ud'), t.dir);
const controller = { ...defaultProfile(), id: 1, updatedAt: '' };
const hotkeys = DEFAULT_SETTINGS.hotkeys;

describe('PCSX2 adapter', () => {
  const a = new Pcsx2Adapter(paths);
  const settings = a.defaultSettings(null, 'balanced');

  it('generates folders, paths, graphics, controller and hotkeys in PCSX2.ini', async () => {
    const res = await a.applyConfig({ settings: { ...settings, renderer: 'vulkan', resolutionScale: 3 }, controller, hotkeys, hardware: null }, 'all');
    expect(res.changed.length).toBeGreaterThan(30);
    const ini = IniDocument.parse(readFileSync(a.iniPath(), 'utf8'));
    expect(ini.get('Folders', 'Bios')).toBe(paths.systemBiosDir('ps2'));
    expect(ini.get('Folders', 'MemoryCards')).toBe(join(paths.emulatorSaveDir('pcsx2'), 'memcards'));
    expect(ini.get('EmuCore/GS', 'Renderer')).toBe('14');
    expect(ini.get('EmuCore/GS', 'upscale_multiplier')).toBe('3');
    expect(ini.get('UI', 'SetupWizardIncomplete')).toBe('false');
    // Missing SettingsVersion makes PCSX2 show a blocking "settings failed to load" prompt.
    expect(ini.get('UI', 'SettingsVersion')).toBe('1');
    expect(ini.get('AutoUpdater', 'CheckAtStartup')).toBe('false');
    expect(ini.get('Pad1', 'Cross')).toBe('SDL-0/FaceSouth');
    expect(ini.get('Pad1', 'L2')).toBe('SDL-0/+LeftTrigger');
    expect(ini.get('Pad1', 'LUp')).toBe('SDL-0/-LeftY');
    expect(ini.get('Hotkeys', 'ShutdownVM')).toBe('SDL-0/Back & SDL-0/Start');
    expect(existsSync(join(paths.emulatorSaveDir('pcsx2'), 'memcards'))).toBe(true);
  });

  it('preserves user settings it does not manage and is idempotent', async () => {
    const doc = IniDocument.parse(readFileSync(a.iniPath(), 'utf8'));
    doc.set('EmuCore/GS', 'TriFilter', 2);
    writeFileSync(a.iniPath(), doc.toString());
    const again = await a.applyConfig({ settings: { ...settings, renderer: 'vulkan', resolutionScale: 3 }, controller, hotkeys, hardware: null }, 'all');
    expect(again.changed).toEqual([]);
    expect(IniDocument.parse(readFileSync(a.iniPath(), 'utf8')).get('EmuCore/GS', 'TriFilter')).toBe('2');
  });

  it('applies the universal profile remapping', async () => {
    const swapped = { ...controller, mapping: { ...controller.mapping, A: 'B' as const, B: 'A' as const } };
    await a.applyConfig({ settings, controller: swapped, hotkeys, hardware: null }, 'controller');
    const ini = IniDocument.parse(readFileSync(a.iniPath(), 'utf8'));
    expect(ini.get('Pad1', 'Cross')).toBe('SDL-0/FaceEast');
    expect(ini.get('Pad1', 'Circle')).toBe('SDL-0/FaceSouth');
  });

  it('detects path drift', async () => {
    const doc = IniDocument.parse(readFileSync(a.iniPath(), 'utf8'));
    doc.set('Folders', 'Bios', 'C:\\Elsewhere');
    writeFileSync(a.iniPath(), doc.toString());
    const insp = await a.inspectConfig();
    expect(insp.drift.find((d) => d.key === 'Folders.Bios')?.critical).toBe(true);
    doc.delete('UI', 'SettingsVersion');
    writeFileSync(a.iniPath(), doc.toString());
    expect((await a.inspectConfig()).drift.find((d) => d.key === 'UI.SettingsVersion')?.critical).toBe(true);
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'paths');
    expect((await a.inspectConfig()).drift).toEqual([]);
  });

  it('builds a batch-mode launch with -datapath and the game after "--"', async () => {
    const cmd = await a.buildLaunch({ gameId: 1, path: 'D:\\Games\\Ico.iso', systemId: 'ps2', serial: null, title: 'Ico' }, 'C:\\pcsx2-qt.exe', settings, null, '2.8.2');
    expect(cmd.args.slice(0, 3)).toEqual(['-datapath', a.paths().data, '-nogui']);
    expect(cmd.args.slice(-2)).toEqual(['--', 'D:\\Games\\Ico.iso']);
    expect(cmd.logFile).toMatch(/emulog\.txt$/);
  });

  it('uses -gamecfg on 2.9+ and a reversible session override on older builds', async () => {
    const profile = { gameId: 7, emulatorId: null, overrides: { renderer: 'd3d11', resolutionScale: 2 }, customArgs: '-fastboot', notes: null, updatedAt: '' };
    const nightly = await a.buildLaunch({ gameId: 7, path: 'g.iso', systemId: 'ps2', serial: null, title: 'G' }, 'x.exe', settings, profile, '2.9.113');
    expect(nightly.args).toContain('-gamecfg');
    expect(nightly.args).toContain('-fastboot');
    await nightly.prepare!();
    const cfg = nightly.args[nightly.args.indexOf('-gamecfg') + 1];
    expect(IniDocument.parse(readFileSync(cfg, 'utf8')).get('EmuCore/GS', 'Renderer')).toBe('3');

    const before = readFileSync(a.iniPath(), 'utf8');
    const stable = await a.buildLaunch({ gameId: 7, path: 'g.iso', systemId: 'ps2', serial: null, title: 'G' }, 'x.exe', settings, profile, '2.8.2');
    expect(stable.args).not.toContain('-gamecfg');
    await stable.prepare!();
    expect(IniDocument.parse(readFileSync(a.iniPath(), 'utf8')).get('EmuCore/GS', 'Renderer')).toBe('3');
    await stable.cleanup!();
    expect(readFileSync(a.iniPath(), 'utf8')).toBe(before);
  });

  it('recovers an interrupted session override', async () => {
    const before = readFileSync(a.iniPath(), 'utf8');
    const cmd = await a.buildLaunch({ gameId: 7, path: 'g.iso', systemId: 'ps2', serial: null, title: 'G' }, 'x.exe', settings, { gameId: 7, emulatorId: null, overrides: { resolutionScale: 6 }, customArgs: null, notes: null, updatedAt: '' }, '2.8.0');
    await cmd.prepare!();
    expect(await a.recoverSession()).toHaveLength(1);
    expect(readFileSync(a.iniPath(), 'utf8')).toBe(before);
  });
});

describe('Dolphin adapter', () => {
  const d = new DolphinAdapter(paths);
  const settings = d.defaultSettings(null, 'quality');

  it('writes Dolphin.ini, GFX.ini, pads, hotkeys and logging', async () => {
    await d.applyConfig({ settings: { ...settings, renderer: 'd3d12', resolutionScale: 4, frameLimit: false }, controller, hotkeys, hardware: null }, 'all');
    const main = IniDocument.parse(readFileSync(d.configPath('Dolphin.ini'), 'utf8'));
    const gfx = IniDocument.parse(readFileSync(d.configPath('GFX.ini'), 'utf8'));
    const pad = IniDocument.parse(readFileSync(d.configPath('GCPadNew.ini'), 'utf8'));
    const hk = IniDocument.parse(readFileSync(d.configPath('Hotkeys.ini'), 'utf8'));
    expect(main.get('Core', 'GFXBackend')).toBe('D3D12');
    expect(main.get('Core', 'EmulationSpeed')).toBe('0.00000000');
    expect(main.get('Interface', 'ConfirmStop')).toBe('False');
    expect(main.get('General', 'NANDRootPath')).toBe(join(paths.emulatorSaveDir('dolphin'), 'Wii'));
    expect(gfx.get('Settings', 'InternalResolution')).toBe('4');
    expect(pad.get('GCPad1', 'Device')).toBe('XInput/0/Gamepad');
    expect(pad.get('GCPad1', 'Buttons/A')).toBe('`Button A`');
    expect(pad.get('GCPad1', 'Main Stick/Up')).toBe('`Left Y+`');
    expect(hk.get('Hotkeys', 'General/Stop')).toBe('@(`Back`+`Start`)');
    expect(IniDocument.parse(readFileSync(d.configPath('Logger.ini'), 'utf8')).get('Options', 'WriteToFile')).toBe('True');
  });

  it('uses SDL naming for PlayStation controllers', async () => {
    await d.applyConfig({ settings, controller: { ...controller, controllerKind: 'dualsense' }, hotkeys, hardware: null }, 'controller');
    const pad = IniDocument.parse(readFileSync(d.configPath('GCPadNew.ini'), 'utf8'));
    expect(pad.get('GCPad1', 'Device')).toMatch(/^SDL\/0\//);
    expect(pad.get('GCPad1', 'Buttons/A')).toBe('`Button S`');
    expect(pad.get('GCPad1', 'Main Stick/Up')).toBe('`Left Y-`');
  });

  it('applies per-game profiles as -C overrides without touching files', async () => {
    const cmd = await d.buildLaunch({ gameId: 1, path: 'C:\\g\\melee.iso', systemId: 'gc', serial: 'GALE01', title: 'Melee' }, 'C:\\Dolphin.exe', settings, { gameId: 1, emulatorId: null, overrides: { renderer: 'vulkan', resolutionScale: 2 }, customArgs: null, notes: null, updatedAt: '' }, null);
    expect(cmd.args).toEqual(['-u', d.userDir(), '-b', '-C', 'Dolphin.Core.GFXBackend=Vulkan', '-C', 'GFX.Settings.InternalResolution=2', '-e', 'C:\\g\\melee.iso']);
  });
});

describe('hardware-based configuration', () => {
  const hw = (tier: HardwareProfile['tier'], height = 1440): HardwareProfile => ({ tier, displays: [{ width: height * 16 / 9, height, refreshRate: 60, scaleFactor: 1, primary: true }], isWindows: true, gpus: [], graphicsApis: { directx12: true, vulkan: true, opengl: true, notes: [] } } as unknown as HardwareProfile);
  it('scales resolution by tier and preset, capped by display', () => {
    expect(resolutionScaleFor(hw('low'), 'balanced', 8)).toBe(1);
    expect(resolutionScaleFor(hw('mid'), 'balanced', 8)).toBe(2);
    expect(resolutionScaleFor(hw('enthusiast'), 'quality', 8)).toBe(4);
    expect(resolutionScaleFor(hw('enthusiast', 2160), 'quality', 8)).toBe(5);
    expect(resolutionScaleFor(hw('enthusiast', 1080), 'maximum', 8)).toBe(6);
  });
  it('classifies tiers conservatively', () => {
    expect(classifyTier({ threads: 4, ramMB: 8000, gpus: [{ name: 'Intel UHD', vendor: 'intel', vramMB: null, driverVersion: null }], avx2: true }).tier).toBe('low');
    expect(classifyTier({ threads: 16, ramMB: 32000, gpus: [{ name: 'NVIDIA GeForce RTX 4070', vendor: 'nvidia', vramMB: 12288, driverVersion: null }], avx2: true }).tier).toBe('enthusiast');
    expect(classifyTier({ threads: 8, ramMB: 16000, gpus: [{ name: 'AMD Radeon RX 6600', vendor: 'amd', vramMB: 8192, driverVersion: null }], avx2: true }).tier).toBe('high');
  });
  it('compares versions', () => {
    expect(compareVersions('2.9.0', '2.8.12')).toBe(1);
    expect(compareVersions('v2.8.2', '2.8.2')).toBe(0);
    expect(compareVersions('2509', '2506')).toBe(1);
  });
});
