// Regression tests for Ryujinx firmware detection (false "No firmware installed"
// when firmware was installed by Ryujinx itself outside OmniPC's data folder).
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppPaths } from '../src/main/core/paths';
import { EventBus } from '../src/main/core/events';
import { migrate } from '../src/main/database/migrations';
import { EmulatorRepo } from '../src/main/database/emulatorRepo';
import { OpsRepo } from '../src/main/database/opsRepo';
import { SettingsRepo } from '../src/main/database/settingsRepo';
import { RyujinxAdapter, firmwareCheck } from '../src/main/emulators/ryujinx/adapter';
import { inspectFirmware, registeredDirOf } from '../src/main/emulators/ryujinx/firmware';
import { EmulatorManager, type EmulatorManagerDeps } from '../src/main/services/emulatorManager';
import type { AdapterRegistry } from '../src/main/emulators/registry';
import { tempDir } from './helpers';

const t = tempDir('omnipc ryujinx fw ');
afterAll(t.cleanup);
let n = 0;
/** A fresh folder whose path contains spaces, like "C:\Users\First Last\...". */
const fresh = (label: string) => {
  const d = join(t.dir, `case ${++n} ${label}`);
  mkdirSync(d, { recursive: true });
  return d;
};

/** Writes firmware the way Ryujinx installs it: registered/<32-hex id>.nca/00. */
function installFirmware(dataDir: string, titles = 40, bytes = 0x4000): void {
  const reg = registeredDirOf(dataDir);
  for (let i = 0; i < titles; i++) {
    const id = createHash('md5').update(`${dataDir}:${i}`).digest('hex');
    mkdirSync(join(reg, `${id}.nca`), { recursive: true });
    writeFileSync(join(reg, `${id}.nca`, '00'), Buffer.alloc(bytes, i));
  }
}

function makeExe(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const exe = join(dir, 'Ryujinx.exe');
  writeFileSync(exe, 'MZ');
  return exe;
}

/** Path, size and content hash of every file under the given folders. */
function snapshot(...roots: string[]): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${p}|${statSync(p).size}|${statSync(p).mtimeMs}|${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
    }
  };
  roots.forEach(walk);
  return out.sort();
}

const KEY_MARKER = 'f00dfeedcafebeef'.repeat(4);

describe('Ryujinx firmware detection', () => {
  const oldAppData = process.env.APPDATA;
  let appData: string;
  beforeEach(() => {
    appData = fresh('AppData Roaming');
    process.env.APPDATA = appData;
  });
  afterEach(() => {
    process.env.APPDATA = oldAppData;
  });

  const setup = () => {
    const root = fresh('OmniDeck');
    const paths = new AppPaths(join(root, 'ud'), root);
    const a = new RyujinxAdapter(paths);
    return { a, managedData: a.paths().data, managedExe: makeExe(a.paths().app) };
  };

  it('1. finds firmware in the default %APPDATA%\\Ryujinx of an installation outside OmniPC and says where it is', async () => {
    const { a } = setup();
    const exe = makeExe(join(fresh('Downloads'), 'ryujinx-canary-1.3.351-win_x64', 'publish'));
    installFirmware(join(appData, 'Ryujinx'), 238);
    const r = a.firmwareReport(exe);
    expect(r.own?.state).toBe('installed');
    expect(r.own?.loadable).toBe(238);
    expect(r.own?.label).toBe('%APPDATA%\\Ryujinx');
    const check = firmwareCheck(r);
    // Never "No firmware installed" when it is installed somewhere Ryujinx uses.
    expect(check.detail).not.toMatch(/No firmware installed|Not installed \(no firmware folder\) in/);
    expect(check.detail).toContain('Firmware: Installed (238 system titles)');
    expect(check.detail).toContain(join(appData, 'Ryujinx'));
    // ...but OmniPC starts Ryujinx with its own data folder, so games started from OmniPC can't use it.
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/OmniPC starts Ryujinx with its own data folder/);
    a.setActiveExecutable(exe);
    const fw = (await a.biosStatus())[1];
    expect(fw.files.some((f) => f.path === registeredDirOf(join(appData, 'Ryujinx')) && /Installed \(238/.test(f.description))).toBe(true);
    expect(fw.note).toContain(join(appData, 'Ryujinx'));
  });

  it('2. uses the portable folder of a portable installation instead of %APPDATA%', () => {
    const { a } = setup();
    const dir = join(fresh('Emulators'), 'Ryujinx Portable');
    const exe = makeExe(dir);
    installFirmware(join(dir, 'portable'), 50);
    installFirmware(join(appData, 'Ryujinx'), 30);
    const r = a.firmwareReport(exe);
    expect(r.own?.dataDir).toBe(join(dir, 'portable'));
    expect(r.own?.label).toMatch(/portable/);
    expect(r.own?.loadable).toBe(50);
  });

  it('3. reports firmware in OmniPC\'s managed installation as installed', async () => {
    const { a, managedData, managedExe } = setup();
    installFirmware(managedData, 231);
    const r = a.firmwareReport(managedExe);
    expect(r.own).toBeNull(); // managed install: only the folder OmniPC passes with -r
    const check = firmwareCheck(r);
    expect(check).toMatchObject({ ok: true, label: 'Firmware installed' });
    expect(check.detail).toMatch(/^Firmware: Installed \(231 system titles\)/);
    a.setActiveExecutable(managedExe);
    expect((await a.biosStatus())[1].status).toBe('found');
    const smoke = await a.smokeTest(managedExe);
    expect(smoke.checks.find((c) => c.label === 'Firmware installed')?.ok).toBe(true);
  });

  it('4. reports missing firmware', async () => {
    const { a, managedExe } = setup();
    const r = a.firmwareReport(managedExe);
    expect(r.active.state).toBe('missing');
    const check = firmwareCheck(r);
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/Not installed \(no firmware folder\)/);
    a.setActiveExecutable(managedExe);
    expect((await a.biosStatus())[1].status).toBe('missing');
  });

  it('5. an existing folder without usable content is not reported as installed', async () => {
    const { a, managedData, managedExe } = setup();
    const reg = registeredDirOf(managedData);
    mkdirSync(reg, { recursive: true });
    expect(inspectFirmware(managedData)).toMatchObject({ state: 'missing', summary: 'Not installed (firmware folder is empty)' });
    // Folders with empty or tiny files (interrupted install / failed copy).
    for (let i = 0; i < 30; i++) {
      mkdirSync(join(reg, `${i.toString(16).padStart(32, '0')}.nca`), { recursive: true });
      writeFileSync(join(reg, `${i.toString(16).padStart(32, '0')}.nca`, '00'), 'x');
    }
    const fw = inspectFirmware(managedData);
    expect(fw.state).toBe('inconclusive');
    expect(fw.loadable).toBe(0);
    expect(fw.summary).toBe('Present, validation inconclusive (nothing Ryujinx can load)');
    expect(firmwareCheck(a.firmwareReport(managedExe)).ok).toBe(false);
    a.setActiveExecutable(managedExe);
    expect((await a.biosStatus())[1].status).toBe('invalid');
    // A handful of real titles is present but not a complete firmware.
    const partial = fresh('partial firmware');
    installFirmware(partial, 5);
    expect(inspectFirmware(partial)).toMatchObject({ state: 'inconclusive', loadable: 5 });
  });

  it('6. handles nested .nca structures: Ryujinx\'s own layout is valid, a copy one level too deep is flagged', () => {
    const good = fresh('nested good');
    installFirmware(good, 40);
    // Ryujinx loads the first file of each <id>.nca folder; it does not have to be named "00".
    const reg = registeredDirOf(good);
    const first = readdirSync(reg)[0];
    writeFileSync(join(reg, first, '01'), Buffer.alloc(0x2000));
    expect(inspectFirmware(good)).toMatchObject({ state: 'installed', loadable: 40 });

    // "registered" copied inside "registered": nothing loads.
    const deep = fresh('nested deep');
    installFirmware(join(deep, 'tmp'), 40);
    mkdirSync(registeredDirOf(deep), { recursive: true });
    renameSync(registeredDirOf(join(deep, 'tmp')), join(registeredDirOf(deep), 'registered'));
    const fw = inspectFirmware(deep);
    expect(fw.state).toBe('inconclusive');
    expect(fw.loadable).toBe(0);
    expect(fw.evidence.join(' ')).toMatch(/one level too deep/);

    // Loose .nca files directly in "registered" are not loaded by Ryujinx either.
    const loose = fresh('loose files');
    mkdirSync(registeredDirOf(loose), { recursive: true });
    for (let i = 0; i < 25; i++) writeFileSync(join(registeredDirOf(loose), `${i.toString(16).padStart(32, '0')}.nca`), Buffer.alloc(0x2000));
    expect(inspectFirmware(loose)).toMatchObject({ state: 'inconclusive', loadable: 0 });
    expect(inspectFirmware(loose).evidence.join(' ')).toMatch(/loose \.nca file/);
  });

  it('7. re-tests a stale stored health result instead of reporting it', async () => {
    const { a, managedData, managedExe } = setup();
    const db = new Database(':memory:');
    migrate(db);
    const emuRepo = new EmulatorRepo(db);
    const settings = new SettingsRepo(db);
    const registry = { implemented: () => [a], get: (id: string) => (id === 'ryujinx' ? a : undefined), require: () => a } as unknown as AdapterRegistry;
    const mgr = new EmulatorManager({ registry, emuRepo, settings, ops: new OpsRepo(db), bus: new EventBus() } as unknown as EmulatorManagerDeps);
    emuRepo.setInstalled('ryujinx', { state: 'installed', version: '1.3.3', installDir: a.paths().app, executable: managedExe });
    // A result from an older version (no fingerprint): "No firmware installed".
    emuRepo.setHealth('ryujinx', 'error', 'Firmware installed: No firmware installed; most games will not start.');
    installFirmware(managedData, 200);
    expect(await mgr.refreshStaleHealth('ryujinx')).toBe(true);
    expect(emuRepo.get('ryujinx').health_note ?? '').not.toMatch(/Firmware/);
    // Up to date: not re-tested.
    expect(await mgr.refreshStaleHealth('ryujinx')).toBe(false);
    // Firmware removed outside OmniPC: the stored "passed" result is stale again.
    rmSync(registeredDirOf(managedData), { recursive: true });
    expect(await mgr.refreshStaleHealth('ryujinx')).toBe(true);
    expect(emuRepo.get('ryujinx').health_note).toMatch(/Firmware: Not installed/);
    // Switching to another executable invalidates it too.
    const other = makeExe(join(fresh('Other Ryujinx'), 'publish'));
    emuRepo.setInstalled('ryujinx', { state: 'external', version: null, installDir: join(other, '..'), executable: other });
    expect(await mgr.refreshStaleHealth('ryujinx')).toBe(true);
    db.close();
  });

  it('8. inspects the data folder of the installation actually in use when several exist', () => {
    const { a } = setup();
    const one = join(fresh('Ryujinx One'), 'app');
    const two = join(fresh('Ryujinx Two'), 'app');
    const exe1 = makeExe(one);
    const exe2 = makeExe(two);
    installFirmware(join(one, 'portable'), 60);
    mkdirSync(join(two, 'portable'), { recursive: true });
    installFirmware(join(appData, 'Ryujinx'), 70);
    expect(a.firmwareReport(exe1).own).toMatchObject({ dataDir: join(one, 'portable'), loadable: 60 });
    // exe2 is portable too (its folder exists, empty): its own folder, not %APPDATA%.
    expect(a.firmwareReport(exe2).own).toMatchObject({ dataDir: join(two, 'portable'), state: 'missing' });
    a.setActiveExecutable(exe1);
    expect(a.firmwareReport().own?.loadable).toBe(60);
    a.setActiveExecutable(exe2);
    expect(a.firmwareReport().own?.loadable).toBe(0);
  });

  it('9. handles paths with spaces', () => {
    const dir = join(fresh('Program Files Like'), 'My Emulators', 'Ryujinx Canary 1.3');
    installFirmware(dir, 25);
    const fw = inspectFirmware(dir);
    expect(fw).toMatchObject({ state: 'installed', loadable: 25 });
    expect(fw.registeredDir).toContain('Ryujinx Canary 1.3');
  });

  it('10. never changes keys, firmware or configuration, and never reads key contents into results', async () => {
    const { a, managedData } = setup();
    const userData = join(appData, 'Ryujinx');
    installFirmware(userData, 238);
    mkdirSync(join(userData, 'system'), { recursive: true });
    writeFileSync(join(userData, 'system', 'prod.keys'), `header_key = ${KEY_MARKER}\n`);
    writeFileSync(join(userData, 'system', 'title.keys'), `0100000000000000 = ${KEY_MARKER}\n`);
    writeFileSync(join(userData, 'Config.json'), '{"version":73}');
    const exe = makeExe(join(fresh('Downloads'), 'publish'));
    const before = snapshot(userData, join(exe, '..'), managedData);
    a.setActiveExecutable(exe);
    const out = JSON.stringify([a.firmwareReport(exe), await a.biosStatus(), a.healthFingerprint(exe), firmwareCheck(a.firmwareReport(exe)), await a.smokeTest(exe)]);
    expect(snapshot(userData, join(exe, '..'), managedData)).toEqual(before);
    expect(out).not.toContain(KEY_MARKER);
  });
});
