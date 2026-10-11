import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppPaths } from '../src/main/core/paths';
import { AdapterRegistry } from '../src/main/emulators/registry';
import { Pcsx2Adapter } from '../src/main/emulators/pcsx2/adapter';
import { applySuggestions, optimizeSuggestions, settingsView } from '../src/main/emulators/settingsView';
import { defaultProfile } from '../src/main/controllers/translate';
import { DEFAULT_SETTINGS } from '../src/main/database/settingsRepo';
import { IniDocument } from '../src/main/config/ini';
import { normaliseSetting, validateSchema, type SettingDef } from '../src/shared/emulatorSettings';
import type { HardwareProfile } from '../src/shared/models';
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

describe('settings schema helpers', () => {
  const sel: SettingDef = { key: 'a|b', label: 'A', description: 'd', category: 'graphics', kind: 'select', default: '0', options: [{ value: '0', label: 'Off' }, { value: 'Vulkan', label: 'Vulkan' }] };
  it('normalises values per kind', () => {
    expect(normaliseSetting({ ...sel, kind: 'toggle', default: 'false', options: undefined }, '1')).toBe('true');
    expect(normaliseSetting({ ...sel, kind: 'toggle', default: 'false', options: undefined }, 'garbage')).toBe('false');
    expect(normaliseSetting(sel, 'vulkan')).toBe('Vulkan');
    expect(normaliseSetting(sel, 'nope')).toBe('0');
    expect(normaliseSetting({ ...sel, kind: 'slider', min: 0, max: 200, default: '100', options: undefined }, '500')).toBe('200');
  });
  it('catches schema mistakes', () => {
    expect(validateSchema([sel, sel])).toContain('duplicate key a|b');
    expect(validateSchema([{ ...sel, default: 'x' }])[0]).toMatch(/not an option/);
  });
});

describe('every emulator settings schema', () => {
  const reg = new AdapterRegistry(paths);
  for (const a of reg.implemented()) {
    const defs = a.settingsSchema?.() ?? [];
    if (!defs.length) continue;
    it(`${a.manifest.id}: is valid and complete`, () => {
      expect(validateSchema(defs)).toEqual([]);
      expect(typeof a.readSettings).toBe('function');
      // Suggestions only refer to declared settings and valid values.
      for (const s of a.optimize?.(hw('high')) ?? []) {
        const d = defs.find((x) => x.key === s.key);
        expect(d, s.key).toBeTruthy();
        expect(normaliseSetting(d!, s.value)).toBe(s.value);
      }
    });
  }
});

describe('PCSX2 settings menu', () => {
  const a = new Pcsx2Adapter(paths);
  it('writes menu values into PCSX2.ini and reads them back, including changes made in PCSX2', async () => {
    const settings = { ...a.defaultSettings(null, 'balanced'), advanced: { 'EmuCore/GS|MaxAnisotropy': '16', 'EmuCore/Speedhacks|vuThread': 'true', 'SPU2/Output|StandardVolume': '80' } };
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'all');
    const ini = IniDocument.parse(readFileSync(a.iniPath(), 'utf8'));
    expect(ini.get('EmuCore/GS', 'MaxAnisotropy')).toBe('16');
    expect(ini.get('EmuCore/Speedhacks', 'vuThread')).toBe('true');
    const view = await settingsView(a, settings, true);
    expect(view.current['EmuCore/GS|MaxAnisotropy']).toBe('16');
    expect(view.saved['SPU2/Output|StandardVolume']).toBe('80');
    // Unknown advanced keys (from the old free-form editor) are not shown as menu values.
    expect(Object.keys(view.saved).every((k) => view.defs.some((d) => d.key === k))).toBe(true);
  });

  it('suggests and applies optimizations for the PC', () => {
    const base = { ...a.defaultSettings(null, 'performance'), advanced: {} };
    const s = optimizeSuggestions(a, base, hw('enthusiast', 8));
    expect(s.find((x) => x.field === 'advanced:EmuCore/Speedhacks|vuThread')).toMatchObject({ from: 'Off', to: 'On' });
    const next = applySuggestions(a, base, hw('enthusiast', 8), s.map((x) => x.field));
    expect(next.advanced['EmuCore/Speedhacks|vuThread']).toBe('true');
    expect(optimizeSuggestions(a, next, hw('enthusiast', 8))).toEqual([]);
    // Two-core CPUs do not get MTVU.
    expect(optimizeSuggestions(a, base, hw('low', 2)).some((x) => x.field.includes('vuThread'))).toBe(false);
  });
});
