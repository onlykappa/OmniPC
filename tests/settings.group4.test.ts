import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppPaths } from '../src/main/core/paths';
import { Shadps4Adapter } from '../src/main/emulators/shadps4/adapter';
import { KytyAdapter } from '../src/main/emulators/kyty/adapter';
import { RyujinxAdapter } from '../src/main/emulators/ryujinx/adapter';
import { optimizeSuggestions, settingsView } from '../src/main/emulators/settingsView';
import { defaultProfile } from '../src/main/controllers/translate';
import { DEFAULT_SETTINGS } from '../src/main/database/settingsRepo';
import { validateSchema } from '../src/shared/emulatorSettings';
import type { GameProfile, HardwareProfile } from '../src/shared/models';
import { tempDir } from './helpers';

const t = tempDir();
afterAll(t.cleanup);
const paths = new AppPaths(join(t.dir, 'ud'), t.dir);
const controller = { ...defaultProfile(), id: 1, updatedAt: '' };
const hotkeys = DEFAULT_SETTINGS.hotkeys;
const hw = (tier: HardwareProfile['tier'], cores = 8, vramMB = 8192, height = 1440): HardwareProfile => ({
  tier, tierReason: 'test', recommendedPreset: tier === 'low' ? 'performance' : tier === 'mid' ? 'balanced' : 'quality',
  cpu: { model: 'Test CPU', cores, threads: cores * 2, speedMHz: 4000, features: ['avx2'] }, ramMB: 16000,
  displays: [{ width: Math.round((height * 16) / 9), height, refreshRate: 60, scaleFactor: 1, primary: true }], isWindows: true,
  gpus: [{ name: 'Test GPU', vendor: 'nvidia', vramMB, driverVersion: null }], graphicsApis: { directx12: true, vulkan: true, opengl: true, notes: [] },
} as unknown as HardwareProfile);
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as Record<string, Record<string, unknown>>;

describe('shadPS4 settings menu', () => {
  const a = new Shadps4Adapter(paths);
  const base = a.defaultSettings(null, 'balanced');

  it('has a valid schema and reads nothing before config.json exists', async () => {
    expect(validateSchema(a.settingsSchema())).toEqual([]);
    expect(await a.readSettings()).toEqual({});
  });

  it('writes typed values into config.json and reads them back', async () => {
    const advanced = { 'GPU.fsr_enabled': 'true', 'GPU.readbacks_mode': '2', 'General.volume_slider': '80', 'General.trophy_notification_side': 'left', 'General.trophy_notification_duration': '4.5', 'General.console_language': '4' };
    // A string where shadPS4 expects a number must not be copied: the typed write wins.
    mkdirSync(a.userDir(), { recursive: true });
    writeFileSync(a.configPath(), JSON.stringify({ GPU: { readbacks_mode: '1' } }));
    await a.applyConfig({ settings: { ...base, advanced }, controller, hotkeys, hardware: null }, 'all');
    const c = json(a.configPath());
    expect(c.GPU.fsr_enabled).toBe(true);
    expect(c.GPU.readbacks_mode).toBe(2);
    expect(c.General.volume_slider).toBe(80);
    expect(c.General.trophy_notification_side).toBe('left');
    expect(c.General.trophy_notification_duration).toBe(4.5);
    expect(c.General.console_language).toBe(4);
    // Managed values are still written.
    expect(c.General.home_dir).toBe(paths.emulatorSaveDir('shadps4'));
    const view = await settingsView(a, { ...base, advanced }, true);
    expect(view.current).toMatchObject({ 'GPU.fsr_enabled': 'true', 'GPU.readbacks_mode': '2', 'General.volume_slider': '80', 'General.trophy_notification_side': 'left', 'General.trophy_notification_duration': '4.5', 'General.console_language': '4' });
    // Values changed inside shadPS4 are picked up.
    c.GPU.fsr_enabled = false;
    writeFileSync(a.configPath(), JSON.stringify(c));
    expect((await a.readSettings())['GPU.fsr_enabled']).toBe('false');
  });

  it('writes per-game menu overrides into custom_configs/<TITLE_ID>.json', async () => {
    const target = { gameId: 3, path: join(t.dir, 'Games', 'CUSA00002', 'eboot.bin'), systemId: 'ps4' as const, serial: null, title: 'T' };
    const profile: GameProfile = { gameId: 3, emulatorId: 'shadps4', overrides: { advanced: { 'GPU.readbacks_mode': '1', 'General.neo_mode': 'true', 'Vulkan.pipeline_cache_enabled': 'false' } }, customArgs: null, notes: null, updatedAt: '' };
    const cmd = await a.buildLaunch(target, 'C:\\s\\shadPS4.exe', base, profile, null);
    await cmd.prepare!();
    const gc = json(a.gameConfigPath('CUSA00002'));
    expect(gc.GPU).toEqual({ readbacks_mode: 1 });
    expect(gc.General).toEqual({ neo_mode: true });
    expect(gc.Vulkan).toEqual({ pipeline_cache_enabled: false });
    expect(cmd.notes.some((n) => n.includes('custom_configs/CUSA00002.json'))).toBe(true);
  });

  it('suggests FSR for large displays and the shader cache for slow CPUs', () => {
    const s = optimizeSuggestions(a, { ...base, advanced: {} }, hw('low', 4, 4096, 1440));
    expect(s.find((x) => x.field === 'advanced:Vulkan.pipeline_cache_enabled')?.to).toBe('On');
    expect(s.some((x) => x.field === 'advanced:GPU.fsr_enabled')).toBe(false);
    expect(optimizeSuggestions(a, { ...base, advanced: {} }, hw('high', 8, 8192, 1440)).find((x) => x.field === 'advanced:GPU.fsr_enabled')?.to).toBe('On');
  });
});

describe('KytyPS5 settings menu', () => {
  const a = new KytyAdapter(paths);
  const base = a.defaultSettings(null, 'balanced');
  const target = { gameId: 5, path: 'D:\\Games\\PPSA00001\\eboot.bin', systemId: 'ps5' as const, serial: 'PPSA00001', title: 'P' };
  const exe = 'C:\\k\\kyty_emulator.exe';

  it('stores menu values as launch options and reads them back', async () => {
    expect(await a.readSettings()).toEqual({});
    const advanced = { 'trophy-notifications': 'false', 'shader-optimization-type': 'Performance', 'vblank-frequency': '120', tessellation: 'true', 'console-language': '2' };
    await a.applyConfig({ settings: { ...base, advanced }, controller, hotkeys, hardware: null }, 'all');
    expect((await a.readConfig())?.managed?.options).toEqual(advanced);
    const view = await settingsView(a, { ...base, advanced }, true);
    expect(view.current).toEqual(advanced);
    const cmd = await a.buildLaunch(target, exe, { ...base, advanced }, null, null);
    const arg = (n: string) => cmd.args[cmd.args.indexOf(n) + 1];
    expect(arg('--trophy-notifications')).toBe('false');
    expect(arg('--shader-optimization-type')).toBe('Performance');
    expect(arg('--vblank-frequency')).toBe('120');
    expect(arg('--console-language')).toBe('2');
    expect(cmd.args).toContain('--tessellation');
  });

  it('applies per-game overrides for that launch only', async () => {
    const settings = { ...base, advanced: { tessellation: 'true', 'vblank-frequency': '60' } };
    const profile: GameProfile = { gameId: 5, emulatorId: 'kyty', overrides: { advanced: { tessellation: 'false', 'vblank-frequency': '30', 'skip-notice-screen': 'true' } }, customArgs: null, notes: null, updatedAt: '' };
    const cmd = await a.buildLaunch(target, exe, settings, profile, null);
    expect(cmd.args).not.toContain('--tessellation');
    expect(cmd.args[cmd.args.indexOf('--vblank-frequency') + 1]).toBe('30');
    expect(cmd.args[cmd.args.indexOf('--skip-notice-screen') + 1]).toBe('true');
    expect(cmd.args[cmd.args.length - 2]).toBe('--game');
  });
});

describe('Ryujinx settings menu', () => {
  const a = new RyujinxAdapter(paths);
  const base = a.defaultSettings(null, 'balanced');
  const cfg = () => JSON.parse(readFileSync(a.configPath(), 'utf8')) as Record<string, unknown>;

  it('writes typed values into a valid Config.json and reads them back', async () => {
    expect(await a.readSettings()).toEqual({});
    const advanced = { max_anisotropy: '16', anti_aliasing: 'SmaaHigh', scaling_filter: 'Fsr', scaling_filter_level: '65', enable_texture_recompression: 'true', audio_volume: '40', dram_size: '2', hide_cursor: '2', docked_mode: 'false', system_language: 'German' };
    await a.applyConfig({ settings: { ...base, advanced }, controller, hotkeys, hardware: null }, 'all');
    const c = cfg();
    expect(c.version).toBe(73);
    expect(c.max_anisotropy).toBe(16);
    expect(c.anti_aliasing).toBe('SmaaHigh');
    expect(c.scaling_filter).toBe('Fsr');
    expect(c.scaling_filter_level).toBe(65);
    expect(c.enable_texture_recompression).toBe(true);
    expect(c.audio_volume).toBe(0.4);
    expect(c.dram_size).toBe(2);
    expect(c.hide_cursor).toBe(2);
    expect(c.docked_mode).toBe(false);
    expect(c.system_language).toBe('German');
    const insp = await a.inspectConfig();
    expect(insp.files[0].parseOk).toBe(true);
    const view = await settingsView(a, { ...base, advanced }, true);
    expect(view.current).toMatchObject(advanced);
    // Defaults of a freshly created file are read too.
    expect(view.current.enable_shader_cache).toBe('true');
    expect(view.current.memory_manager_mode).toBe('HostMappedUnsafe');
  });

  it('applies per-game menu values for the session only', async () => {
    await a.applyConfig({ settings: { ...base, advanced: { audio_volume: '100', max_anisotropy: '-1' } }, controller, hotkeys, hardware: null }, 'graphics');
    const profile: GameProfile = { gameId: 9, emulatorId: 'ryujinx', overrides: { advanced: { audio_volume: '25', max_anisotropy: '8', enable_macro_hle: 'false', backend_threading: 'Off' } }, customArgs: null, notes: null, updatedAt: '' };
    const target = { gameId: 9, path: 'D:\\g.nsp', systemId: 'switch' as const, serial: null, title: 'G' };
    const cmd = await a.buildLaunch(target, 'C:\\R\\Ryujinx.exe', base, profile, null);
    await cmd.prepare!();
    let c = cfg();
    expect(c.audio_volume).toBe(0.25);
    expect(c.max_anisotropy).toBe(8);
    expect(c.enable_macro_hle).toBe(false);
    expect(c.backend_threading).toBe('Off');
    await cmd.cleanup!();
    c = cfg();
    expect(c.audio_volume).toBe(1);
    expect(c.max_anisotropy).toBe(-1);
    expect(c.enable_macro_hle).toBe(true);
    expect(c.backend_threading).toBe('Auto');
  });

  it('suggests texture recompression for low-VRAM GPUs only', () => {
    const low = optimizeSuggestions(a, { ...base, advanced: {} }, hw('mid', 6, 4096));
    expect(low.find((x) => x.field === 'advanced:enable_texture_recompression')?.to).toBe('On');
    expect(low.find((x) => x.field === 'advanced:max_anisotropy')?.to).toBe('16x');
    expect(optimizeSuggestions(a, { ...base, advanced: {} }, hw('high', 8, 12288)).some((x) => x.field === 'advanced:enable_texture_recompression')).toBe(false);
  });
});
