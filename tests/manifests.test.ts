import { afterAll, describe, expect, it } from 'vitest';
import { AdapterRegistry, validateManifest } from '../src/main/emulators/registry';
import { AppPaths } from '../src/main/core/paths';
import { PlannedAdapter } from '../src/main/emulators/planned';
import { SYSTEMS } from '../src/shared/systems';
import { tempDir } from './helpers';

describe('emulator manifests & registry', () => {
  const t = tempDir();
  const reg = new AdapterRegistry(new AppPaths(t.dir, t.dir));

  it('loads every manifest without validation errors', () => {
    for (const a of reg.all()) expect(validateManifest(a.manifest), a.manifest.id).toEqual([]);
  });

  it('marks only real integrations as implemented', () => {
    for (const a of reg.all()) expect(a.manifest.implemented, a.manifest.id).toBe(!(a instanceof PlannedAdapter));
    expect(reg.implemented().map((a) => a.manifest.id)).toEqual(expect.arrayContaining(['cemu', 'dolphin', 'duckstation', 'kyty', 'pcsx2', 'ppsspp', 'rpcs3', 'xenia', 'melonds', 'xemu', 'retroarch', 'shadps4']));
  });

  it('every system has at least one emulator in the registry', () => {
    for (const s of SYSTEMS) expect(reg.forSystem(s.id).length, s.id).toBeGreaterThan(0);
    expect(reg.forSystem('ps4')[0].manifest.id).toBe('shadps4');
    expect(reg.forSystem('ps5')[0].manifest.id).toBe('kyty');
  });

  it('routes systems to the preferred emulator first', () => {
    expect(reg.forSystem('ps2')[0].manifest.id).toBe('pcsx2');
    expect(reg.forSystem('wii')[0].manifest.id).toBe('dolphin');
  });

  it('rejects unsafe manifests', () => {
    const m = { ...reg.require('pcsx2').manifest, download: { ...reg.require('pcsx2').manifest.download, allowedHosts: ['https://evil.example/x'] } };
    expect(validateManifest(m).join()).toMatch(/bare host/);
  });

  it('planned adapters refuse to install or launch', async () => {
    const planned = new PlannedAdapter({ ...reg.require('pcsx2').manifest, id: 'future', implemented: false }, new AppPaths(t.dir, t.dir));
    await expect(planned.buildLaunch()).rejects.toThrow(/not implemented/);
  });
  afterAll(t.cleanup);
});
