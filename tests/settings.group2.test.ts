import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppPaths } from '../src/main/core/paths';
import { Rpcs3Adapter } from '../src/main/emulators/rpcs3/adapter';
import { CemuAdapter } from '../src/main/emulators/cemu/adapter';
import { XeniaAdapter } from '../src/main/emulators/xenia/adapter';
import { YamlDocument } from '../src/main/emulators/rpcs3/yaml';
import { getText, parseXml } from '../src/main/emulators/cemu/xml';
import { TomlDocument } from '../src/main/emulators/xenia/toml';
import { optimizeSuggestions, settingsView } from '../src/main/emulators/settingsView';
import { defaultProfile } from '../src/main/controllers/translate';
import { DEFAULT_SETTINGS } from '../src/main/database/settingsRepo';
import type { GameProfile, HardwareProfile } from '../src/shared/models';
import { tempDir } from './helpers';

const t = tempDir();
afterAll(t.cleanup);
const paths = new AppPaths(join(t.dir, 'ud'), t.dir);
const controller = { ...defaultProfile(), id: 1, updatedAt: '' };
const hotkeys = DEFAULT_SETTINGS.hotkeys;
const hw = (tier: HardwareProfile['tier'], cores = 8): HardwareProfile => ({
  tier, tierReason: 'test', recommendedPreset: tier === 'low' ? 'performance' : tier === 'mid' ? 'balanced' : 'quality',
  cpu: { model: 'Test CPU', cores, threads: cores * 2, speedMHz: 4000, features: ['avx2'] }, ramMB: 16000,
  displays: [{ width: 2560, height: 1440, refreshRate: 60, scaleFactor: 1, primary: true }], isWindows: true,
  gpus: [{ name: 'Test GPU', vendor: 'nvidia', vramMB: 8192, driverVersion: null }], graphicsApis: { directx12: true, vulkan: true, opengl: true, notes: [] },
} as unknown as HardwareProfile);
const profile = (advanced: Record<string, string>): GameProfile => ({ gameId: 7, emulatorId: null, overrides: { advanced }, customArgs: null, notes: null, updatedAt: '' } as unknown as GameProfile);

describe('RPCS3 settings menu', () => {
  const a = new Rpcs3Adapter(paths);
  it('reads nothing before config.yml exists', async () => {
    expect(await a.readSettings()).toEqual({});
  });

  it('writes menu values into config.yml and reads them back', async () => {
    const advanced = {
      'Video|Write Color Buffers': 'true',
      'Core|SPU Decoder': 'Recompiler (ASMJIT)',
      'Audio|Master Volume': '80',
      'System|Language': 'English (UK)',
      'Video/Performance Overlay|Enabled': 'true',
    };
    const settings = { ...a.defaultSettings(null, 'balanced'), advanced };
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'all');
    const doc = YamlDocument.parse(readFileSync(a.configYml(), 'utf8'));
    expect(doc.get(['Video', 'Write Color Buffers'])).toBe('true');
    expect(doc.get(['Core', 'SPU Decoder'])).toBe('Recompiler (ASMJIT)');
    expect(doc.get(['Audio', 'Master Volume'])).toBe('80');
    expect(doc.get(['System', 'Language'])).toBe('English (UK)');
    expect(doc.get(['Video', 'Performance Overlay', 'Enabled'])).toBe('true');
    // Core settings are still written by OmniPC.
    expect(doc.get(['Video', 'Renderer'])).toBe('Vulkan');
    const view = await settingsView(a, settings, true);
    expect(view.current).toMatchObject(advanced);
    expect(view.current['Video|Renderer']).toBeUndefined();
  });

  it('applies per-game menu values through the --config file', async () => {
    const settings = { ...a.defaultSettings(null, 'balanced'), advanced: { 'Video|Write Color Buffers': 'true' } };
    const cmd = await a.buildLaunch({ gameId: 7, path: 'g\\EBOOT.BIN', systemId: 'ps3', serial: null, title: 'G' }, 'x.exe', settings, profile({ 'Video|Write Color Buffers': 'false', 'Core|SPU XFloat Accuracy': 'Accurate' }), null);
    await cmd.prepare!();
    const g = YamlDocument.parse(readFileSync(cmd.args[cmd.args.indexOf('--config') + 1], 'utf8'));
    expect(g.get(['Video', 'Write Color Buffers'])).toBe('false');
    expect(g.get(['Core', 'SPU XFloat Accuracy'])).toBe('Accurate');
    // The global config is untouched.
    expect(YamlDocument.parse(readFileSync(a.configYml(), 'utf8')).get(['Video', 'Write Color Buffers'])).toBe('true');
  });

  it('suggests hardware-based optimizations', () => {
    const base = { ...a.defaultSettings(null, 'performance'), advanced: {} };
    const s = optimizeSuggestions(a, base, hw('enthusiast'));
    expect(s.find((x) => x.field === 'advanced:Video|Output Scaling Mode')?.to).toBe('FidelityFX Super Resolution (FSR)');
    expect(optimizeSuggestions(a, base, hw('low')).some((x) => x.field === 'advanced:Video|Accurate ZCULL stats')).toBe(true);
  });
});

describe('Cemu settings menu', () => {
  const a = new CemuAdapter(paths);
  const xml = () => parseXml(readFileSync(a.settingsPath(), 'utf8')).root;
  it('reads nothing before settings.xml exists', async () => {
    expect(await a.readSettings()).toEqual({});
  });

  it('writes menu values into settings.xml and reads them back', async () => {
    const advanced = {
      'Graphic/AsyncCompile': 'false',
      'Graphic/UpscaleFilter': '3',
      'Audio/TVVolume': '60',
      'console_language': '3',
      'Graphic/Overlay/Position': '2',
    };
    const settings = { ...a.defaultSettings(null, 'balanced'), advanced };
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'graphics');
    const root = xml();
    expect(getText(root, ['Graphic', 'AsyncCompile'])).toBe('false');
    expect(getText(root, ['Graphic', 'UpscaleFilter'])).toBe('3');
    expect(getText(root, ['Audio', 'TVVolume'])).toBe('60');
    expect(getText(root, ['console_language'])).toBe('3');
    expect(getText(root, ['Graphic', 'Overlay', 'Position'])).toBe('2');
    expect(getText(root, ['Graphic', 'api'])).toBe('1');
    const view = await settingsView(a, settings, true);
    expect(view.current).toMatchObject(advanced);
  });

  it('applies per-game menu values for the session and restores them', async () => {
    const settings = { ...a.defaultSettings(null, 'balanced'), advanced: { 'Graphic/AsyncCompile': 'false' } };
    const cmd = await a.buildLaunch({ gameId: 7, path: 'g.wua', systemId: 'wiiu', serial: null, title: 'g' }, 'Cemu.exe', settings, profile({ 'Graphic/AsyncCompile': 'true', 'Graphic/DownscaleFilter': '1' }), null);
    await cmd.prepare!();
    expect((await a.readSettings())['Graphic/AsyncCompile']).toBe('true');
    expect(getText(xml(), ['Graphic', 'DownscaleFilter'])).toBe('1');
    await cmd.cleanup!();
    expect(getText(xml(), ['Graphic', 'AsyncCompile'])).toBe('false');
    expect(getText(xml(), ['Graphic', 'DownscaleFilter'])).toBeNull();
  });

  it('suggests hardware-based optimizations', () => {
    const base = { ...a.defaultSettings(null, 'performance'), advanced: { 'Graphic/AsyncCompile': 'false' } };
    expect(optimizeSuggestions(a, base, hw('high')).find((x) => x.field === 'advanced:Graphic/AsyncCompile')).toMatchObject({ from: 'Off', to: 'On' });
  });
});

describe('Xenia settings menu', () => {
  const a = new XeniaAdapter(paths);
  const toml = () => TomlDocument.parse(readFileSync(a.configPath(), 'utf8'));
  it('reads nothing before the config exists', async () => {
    expect(await a.readSettings()).toEqual({});
  });

  it('writes menu values with the cvar TOML types and reads them back', async () => {
    const advanced = {
      'APU|mute': 'true',
      'GPU|anisotropic_override': '5',
      'Display|postprocess_ffx_cas_additional_sharpness': '1',
      'Display|postprocess_scaling_and_sharpening': 'fsr',
      'Content|license_mask': '1',
      'GPU|readback_resolve': 'fast',
    };
    const settings = { ...a.defaultSettings(null, 'balanced'), advanced };
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'all');
    const doc = toml();
    expect(doc.raw('APU', 'mute')).toBe('true');
    expect(doc.raw('GPU', 'anisotropic_override')).toBe('5');
    // A double cvar must stay a TOML float even for a whole number.
    expect(doc.raw('Display', 'postprocess_ffx_cas_additional_sharpness')).toBe('1.0');
    expect(doc.type('Display', 'postprocess_scaling_and_sharpening')).toBe('string');
    expect(doc.raw('Content', 'license_mask')).toBe('1');
    expect(doc.get('GPU', 'readback_resolve')).toBe('fast');
    const view = await settingsView(a, settings, true);
    expect(view.current).toMatchObject(advanced);
  });

  it('shows Xenia\'s empty-string defaults as their named options', async () => {
    const doc = toml();
    doc.set('Display', 'postprocess_antialiasing', '');
    writeFileSync(a.configPath(), doc.toString());
    expect((await a.readSettings())['Display|postprocess_antialiasing']).toBe('none');
  });

  it('passes per-game menu values as command-line cvars', () => {
    const args = a.profileArgs(a.defaultSettings(null, 'balanced'), profile({ 'APU|mute': 'false', 'Display|postprocess_ffx_fsr_sharpness_reduction': '0.5', 'GPU|occlusion_query': 'strict' }));
    expect(args).toEqual(expect.arrayContaining(['--mute=false', '--postprocess_ffx_fsr_sharpness_reduction=0.5', '--occlusion_query=strict']));
  });

  it('suggests hardware-based optimizations', () => {
    const base = { ...a.defaultSettings(null, 'performance'), advanced: {} };
    const s = optimizeSuggestions(a, base, hw('enthusiast'));
    expect(s.find((x) => x.field === 'advanced:GPU|anisotropic_override')?.to).toBe('16x');
    expect(s.some((x) => x.field === 'advanced:Display|postprocess_scaling_and_sharpening')).toBe(true);
  });
});
