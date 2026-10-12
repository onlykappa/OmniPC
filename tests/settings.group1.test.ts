import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppPaths } from '../src/main/core/paths';
import { DolphinAdapter } from '../src/main/emulators/dolphin/adapter';
import { DuckStationAdapter } from '../src/main/emulators/duckstation/adapter';
import { PpssppAdapter } from '../src/main/emulators/ppsspp/adapter';
import { settingsView } from '../src/main/emulators/settingsView';
import { defaultProfile } from '../src/main/controllers/translate';
import { DEFAULT_SETTINGS } from '../src/main/database/settingsRepo';
import { IniDocument } from '../src/main/config/ini';
import type { GameProfile } from '../src/shared/models';
import { tempDir } from './helpers';

const t = tempDir();
afterAll(t.cleanup);
const paths = new AppPaths(join(t.dir, 'ud'), t.dir);
const controller = { ...defaultProfile(), id: 1, updatedAt: '' };
const hotkeys = DEFAULT_SETTINGS.hotkeys;
const parse = (file: string) => IniDocument.parse(readFileSync(file, 'utf8'));
const profile = (emulatorId: string, advanced: Record<string, string>): GameProfile => ({ gameId: 3, emulatorId, overrides: { advanced }, customArgs: null, notes: null, updatedAt: '' });
const target = { gameId: 3, path: 'game.iso', systemId: 'gc', serial: null, title: 'Game' } as const;

describe('Dolphin settings menu', () => {
  const a = new DolphinAdapter(paths);

  it('returns nothing before Dolphin has a config', async () => {
    expect(await a.readSettings()).toEqual({});
  });

  it('writes toggles as True/False and enums as integers into Dolphin.ini and GFX.ini, and reads them back', async () => {
    const advanced = {
      'Dolphin.ini|Core|CPUThread': 'true',
      'GFX.ini|Hacks|EFBAccessEnable': 'false',
      'GFX.ini|Enhancements|MaxAnisotropy': '4',
      'GFX.ini|Settings|ShaderCompilationMode': '2',
      'Dolphin.ini|DSP|Volume': '70',
      'Dolphin.ini|Core|Overclock': '1.5',
    };
    const settings = { ...a.defaultSettings(null, 'balanced'), advanced };
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'all');
    const main = parse(a.configPath('Dolphin.ini'));
    const gfx = parse(a.configPath('GFX.ini'));
    expect(main.get('Core', 'CPUThread')).toBe('True');
    expect(main.get('DSP', 'Volume')).toBe('70');
    expect(main.get('Core', 'Overclock')).toBe('1.5');
    expect(gfx.get('Hacks', 'EFBAccessEnable')).toBe('False');
    expect(gfx.get('Enhancements', 'MaxAnisotropy')).toBe('4');
    expect(gfx.get('Settings', 'ShaderCompilationMode')).toBe('2');
    // Core settings are still written.
    expect(gfx.get('Settings', 'InternalResolution')).toBe(String(settings.resolutionScale));

    const view = await settingsView(a, settings, true);
    expect(view.current).toMatchObject({ 'Dolphin.ini|Core|CPUThread': 'true', 'GFX.ini|Hacks|EFBAccessEnable': 'false', 'GFX.ini|Enhancements|MaxAnisotropy': '4', 'Dolphin.ini|DSP|Volume': '70', 'Dolphin.ini|Core|Overclock': '1.5' });
  });

  it('picks up values Dolphin itself saved (float overclock, True/False)', async () => {
    const file = a.configPath('Dolphin.ini');
    const doc = parse(file);
    doc.set('Core', 'Overclock', '2.00000000');
    doc.set('Core', 'EnableCheats', 'True');
    writeFileSync(file, doc.toString());
    const view = await settingsView(a, { ...a.defaultSettings(null, 'balanced'), advanced: {} }, true);
    expect(view.current['Dolphin.ini|Core|Overclock']).toBe('2');
    expect(view.current['Dolphin.ini|Core|EnableCheats']).toBe('true');
  });

  it('passes per-game values as -C overrides with Dolphin encoding', async () => {
    const cmd = await a.buildLaunch({ ...target }, 'Dolphin.exe', a.defaultSettings(null, 'balanced'), profile('dolphin', { 'GFX.ini|Settings|wideScreenHack': 'true', 'GFX.ini|Settings|MSAA': '4', 'Dolphin.ini|DSP|Volume': '50' }), null);
    expect(cmd.args).toEqual(expect.arrayContaining(['-C', 'GFX.Settings.wideScreenHack=True', 'GFX.Settings.MSAA=4', 'Dolphin.DSP.Volume=50']));
  });
});

describe('DuckStation settings menu', () => {
  const a = new DuckStationAdapter(paths);

  it('returns nothing before DuckStation has a config', async () => {
    expect(await a.readSettings()).toEqual({});
  });

  it('writes enum names, booleans and numbers into settings.ini and reads them back', async () => {
    const advanced = {
      'GPU|PGXPEnable': 'true',
      'GPU|TextureFilter': 'JINC2',
      'Audio|OutputVolume': '80',
      'CPU|OverclockEnable': 'true',
      'CPU|OverclockPercent': '150',
      'BIOS|PatchFastBoot': 'false',
    };
    const settings = { ...a.defaultSettings(null, 'balanced'), advanced };
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'all');
    const ini = parse(a.iniPath());
    expect(ini.get('GPU', 'PGXPEnable')).toBe('true');
    expect(ini.get('GPU', 'TextureFilter')).toBe('JINC2');
    expect(ini.get('Audio', 'OutputVolume')).toBe('80');
    // 150% is stored as the fraction 3/2 (Settings::CPUOverclockPercentToFraction).
    expect(ini.get('CPU', 'OverclockNumerator')).toBe('3');
    expect(ini.get('CPU', 'OverclockDenominator')).toBe('2');
    expect(ini.get('CPU', 'OverclockPercent')).toBeUndefined();
    // The menu value wins over OmniPC's own fast-boot default.
    expect(ini.get('BIOS', 'PatchFastBoot')).toBe('false');

    const view = await settingsView(a, settings, true);
    expect(view.current).toMatchObject({ 'GPU|PGXPEnable': 'true', 'GPU|TextureFilter': 'JINC2', 'Audio|OutputVolume': '80', 'CPU|OverclockPercent': '150', 'BIOS|PatchFastBoot': 'false' });
  });

  it('applies per-game values for the session only', async () => {
    const settings = { ...a.defaultSettings(null, 'balanced'), advanced: {} };
    const cmd = await a.buildLaunch({ ...target, systemId: 'ps1' }, 'ds.exe', settings, profile('duckstation', { 'GPU|WidescreenHack': 'true', 'Console|Region': 'PAL', 'CPU|OverclockPercent': '200' }), null);
    await cmd.prepare!();
    const ini = parse(a.iniPath());
    expect(ini.get('GPU', 'WidescreenHack')).toBe('true');
    expect(ini.get('Console', 'Region')).toBe('PAL');
    expect(ini.get('CPU', 'OverclockNumerator')).toBe('2');
    expect(ini.get('CPU', 'OverclockDenominator')).toBe('1');
    await cmd.cleanup!();
    const after = parse(a.iniPath());
    expect(after.get('GPU', 'WidescreenHack')).toBeUndefined();
    expect(after.get('CPU', 'OverclockNumerator')).toBe('3');
  });
});

describe('PPSSPP settings menu', () => {
  const a = new PpssppAdapter(paths);

  it('returns nothing before PPSSPP has a config', async () => {
    expect(await a.readSettings()).toEqual({});
  });

  it('writes toggles as True/False and choices as integers into ppsspp.ini, and reads them back', async () => {
    const advanced = {
      'General|EnableCheats': 'true',
      'Graphics|HardwareTransform': 'false',
      'Graphics|TexScalingLevel': '3',
      'SystemParam|GameLanguage': '0',
      'Sound|GameVolume': '60',
    };
    const settings = { ...a.defaultSettings(null, 'balanced'), advanced };
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'all');
    const ini = parse(a.iniPath());
    expect(ini.get('General', 'EnableCheats')).toBe('True');
    expect(ini.get('Graphics', 'HardwareTransform')).toBe('False');
    expect(ini.get('Graphics', 'TexScalingLevel')).toBe('3');
    expect(ini.get('SystemParam', 'GameLanguage')).toBe('0');
    expect(ini.get('Sound', 'GameVolume')).toBe('60');

    const view = await settingsView(a, settings, true);
    expect(view.current).toMatchObject({ 'General|EnableCheats': 'true', 'Graphics|HardwareTransform': 'false', 'Graphics|TexScalingLevel': '3', 'SystemParam|GameLanguage': '0', 'Sound|GameVolume': '60' });
  });

  it('applies per-game values for the session only', async () => {
    const settings = { ...a.defaultSettings(null, 'balanced'), advanced: {} };
    const cmd = await a.buildLaunch({ ...target, systemId: 'psp' }, 'PPSSPPWindows64.exe', settings, profile('ppsspp', { 'Graphics|SkipBufferEffects': 'true', 'CPU|CPUSpeed': '333' }), null);
    await cmd.prepare!();
    const ini = parse(a.iniPath());
    expect(ini.get('Graphics', 'SkipBufferEffects')).toBe('True');
    expect(ini.get('CPU', 'CPUSpeed')).toBe('333');
    await cmd.cleanup!();
    expect(parse(a.iniPath()).get('Graphics', 'SkipBufferEffects')).toBeUndefined();
    expect(parse(a.iniPath()).get('General', 'EnableCheats')).toBe('True');
  });
});
