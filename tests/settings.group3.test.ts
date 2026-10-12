import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppPaths } from '../src/main/core/paths';
import { RetroArchAdapter } from '../src/main/emulators/retroarch/adapter';
import { CfgDocument } from '../src/main/emulators/retroarch/cfg';
import { MelonDsAdapter } from '../src/main/emulators/melonds/adapter';
import { TomlDocument as MelonToml } from '../src/main/emulators/melonds/toml';
import { XemuAdapter } from '../src/main/emulators/xemu/adapter';
import { TomlDocument as XemuToml } from '../src/main/emulators/xemu/toml';
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
const profile = (emulatorId: string, advanced: Record<string, string>): GameProfile => ({ gameId: 9, emulatorId, overrides: { advanced }, customArgs: null, notes: null, updatedAt: '' });

describe('RetroArch settings menu', () => {
  const a = new RetroArchAdapter(paths);
  it('writes cfg| values into retroarch.cfg and reads them back', async () => {
    expect(await a.readSettings()).toEqual({});
    const settings = { ...a.defaultSettings(null, 'balanced'), advanced: { 'cfg|video_smooth': 'true', 'cfg|menu_driver': 'xmb', 'cfg|video_frame_delay': '4', 'cfg|audio_volume': '-6', 'core|snes': 'bsnes' } };
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'all');
    const cfg = CfgDocument.parse(readFileSync(a.cfgPath(), 'utf8'));
    expect(cfg.get('video_smooth')).toBe('true');
    expect(cfg.get('menu_driver')).toBe('xmb');
    expect(cfg.get('video_frame_delay')).toBe('4');
    expect(cfg.get('core|snes')).toBeUndefined();
    // Values RetroArch itself writes (floats, legacy booleans) are normalised.
    cfg.set('fastforward_ratio', '4.000000');
    cfg.set('video_black_frame_insertion', 'true');
    writeFileSync(a.cfgPath(), cfg.toString());
    const view = await settingsView(a, settings, true);
    expect(view.current['cfg|video_smooth']).toBe('true');
    expect(view.current['cfg|menu_driver']).toBe('xmb');
    expect(view.current['cfg|video_frame_delay']).toBe('4');
    expect(view.current['cfg|audio_volume']).toBe('-6');
    expect(view.current['cfg|fastforward_ratio']).toBe('4');
    expect(view.current['cfg|video_black_frame_insertion']).toBe('1');
    expect(view.saved['core|snes']).toBeUndefined();
  });

  it('applies per-game values through the session append file', async () => {
    mkdirSync(a.coresDir(), { recursive: true });
    writeFileSync(a.corePath('snes9x'), 'MZ');
    const settings = a.defaultSettings(null, 'balanced');
    const target = { gameId: 9, path: 'g.sfc', systemId: 'snes' as const, serial: null, title: 'G' };
    const cmd = await a.buildLaunch(target, 'retroarch.exe', settings, profile('retroarch', { 'cfg|run_ahead_enabled': 'true', 'cfg|run_ahead_frames': '2' }), null);
    await cmd.prepare!();
    const s = CfgDocument.parse(readFileSync(join(a.paths().data, 'omnideck', 'session.cfg'), 'utf8'));
    expect(s.get('run_ahead_enabled')).toBe('true');
    expect(s.get('run_ahead_frames')).toBe('2');
    await cmd.cleanup!();
  });

  it('suggests run-ahead only on strong PCs', () => {
    const base = { ...a.defaultSettings(null, 'quality'), advanced: {} };
    expect(optimizeSuggestions(a, base, hw('enthusiast')).some((x) => x.field === 'advanced:cfg|run_ahead_enabled')).toBe(true);
    expect(optimizeSuggestions(a, base, hw('low', 2)).some((x) => x.field === 'advanced:cfg|run_ahead_enabled')).toBe(false);
  });
});

describe('melonDS settings menu', () => {
  const a = new MelonDsAdapter(paths);
  const read = () => MelonToml.parse(readFileSync(a.tomlPath(), 'utf8'));
  it('writes typed TOML values (bool/int) and reads them back', async () => {
    expect(await a.readSettings()).toEqual({});
    const settings = { ...a.defaultSettings(null, 'balanced'), advanced: { 'JIT.Enable': 'true', 'Audio.Interpolation': '3', 'Instance0.Audio.Volume': '128', 'Instance0.Window0.ScreenLayout': '2', 'Instance0.Firmware.Username': 'Player' } };
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'all');
    const doc = read();
    expect(doc.getTyped(['JIT', 'Enable'], 'bool')).toBe(true);
    expect(doc.getTyped(['Audio', 'Interpolation'], 'int')).toBe(3);
    expect(doc.getTyped(['Instance0', 'Audio', 'Volume'], 'int')).toBe(128);
    expect(doc.getTyped(['Instance0', 'Window0', 'ScreenLayout'], 'int')).toBe(2);
    expect(doc.getTyped(['Instance0', 'Firmware', 'Username'], 'string')).toBe('Player');
    const view = await settingsView(a, settings, true);
    expect(view.current['JIT.Enable']).toBe('true');
    expect(view.current['Audio.Interpolation']).toBe('3');
    expect(view.current['Instance0.Audio.Volume']).toBe('128');
    expect(view.current['Instance0.Firmware.Username']).toBe('Player');
    // A free-form key keeps the type already in the file.
    await a.applyConfig({ settings: { ...settings, advanced: { 'Screen.VSyncInterval': '2' } }, controller, hotkeys, hardware: null }, 'graphics');
    expect(read().getTyped(['Screen', 'VSyncInterval'], 'int')).toBe(2);
  });

  it('applies typed per-game overrides for the session', async () => {
    const settings = a.defaultSettings(null, 'balanced');
    const cmd = await a.buildLaunch({ gameId: 9, path: 'g.nds', systemId: 'nds', serial: null, title: 'g' }, 'm.exe', settings, profile('melonds', { '3D.GL.BetterPolygons': 'true', 'Instance0.Window0.ScreenRotation': '1' }), null);
    const before = readFileSync(a.tomlPath(), 'utf8');
    await cmd.prepare!();
    expect(read().getTyped(['3D', 'GL', 'BetterPolygons'], 'bool')).toBe(true);
    expect(read().getTyped(['Instance0', 'Window0', 'ScreenRotation'], 'int')).toBe(1);
    await cmd.cleanup!();
    expect(readFileSync(a.tomlPath(), 'utf8')).toBe(before);
  });

  it('suggests the JIT', () => {
    const s = optimizeSuggestions(a, { ...a.defaultSettings(null, 'balanced'), advanced: {} }, hw('mid'));
    expect(s.find((x) => x.field === 'advanced:JIT.Enable')).toMatchObject({ from: 'Off', to: 'On' });
  });
});

describe('xemu settings menu', () => {
  const a = new XemuAdapter(paths);
  const read = (p = a.configPath()) => XemuToml.parse(readFileSync(p, 'utf8'));
  it('writes typed values (enum strings, floats, bools) and reads them back', async () => {
    expect(await a.readSettings()).toEqual({});
    const settings = { ...a.defaultSettings(null, 'balanced'), advanced: { 'sys.mem_limit': '128', 'audio.volume_limit': '50', 'general.skip_boot_anim': 'true', 'display.filtering': 'nearest', 'perf.cache_shaders': 'true' } };
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'all');
    const doc = read();
    expect(doc.get(['sys', 'mem_limit'])).toBe('128');
    expect(doc.get(['audio', 'volume_limit'])).toBe(0.5);
    expect(doc.get(['general', 'skip_boot_anim'])).toBe(true);
    expect(doc.get(['display', 'filtering'])).toBe('nearest');
    // Defaults are not added to a file that does not already hold the key.
    expect(doc.get(['perf', 'cache_shaders'])).toBeUndefined();
    const view = await settingsView(a, settings, true);
    expect(view.current['sys.mem_limit']).toBe('128');
    expect(view.current['audio.volume_limit']).toBe('50');
    expect(view.current['general.skip_boot_anim']).toBe('true');
    expect(view.current['display.filtering']).toBe('nearest');
  });

  it('applies per-game values in the game config file', async () => {
    const before = readFileSync(a.configPath(), 'utf8');
    const settings = a.defaultSettings(null, 'balanced');
    const cmd = await a.buildLaunch({ gameId: 9, path: 'g.iso', systemId: 'xbox', serial: null, title: 'G' }, 'x.exe', settings, profile('xemu', { 'sys.avpack': 'vga', 'audio.hrtf': 'false', 'audio.volume_limit': '25' }), null);
    await cmd.prepare!();
    const g = read(a.gameConfigPath(9));
    expect(g.get(['sys', 'avpack'])).toBe('vga');
    expect(g.get(['audio', 'hrtf'])).toBe(false);
    expect(g.get(['audio', 'volume_limit'])).toBe(0.25);
    expect(readFileSync(a.configPath(), 'utf8')).toBe(before);
  });
});
