import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yazl from 'yazl';
import { migrate } from '../src/main/database/migrations';
import { OpsRepo } from '../src/main/database/opsRepo';
import { SettingsRepo } from '../src/main/database/settingsRepo';
import { AppPaths } from '../src/main/core/paths';
import { EventBus } from '../src/main/core/events';
import { JobManager } from '../src/main/core/jobs';
import { SaveService, writeZipAtomically } from '../src/main/services/saveService';
import { AutoSaveBackup, LAST_SCHEDULED_KEY } from '../src/main/saves/autoBackup';
import { computerFolderName, isSafeFolderName, parseBackupFileName, saveBackupSettings, scheduledBackupDue, selectForRetention, SYNC_FOLDER_NAME } from '../src/main/saves/backupFiles';
import { cloudFolderSuggestions, destinationProblem, validateDestination } from '../src/main/saves/cloudFolders';
import type { AdapterRegistry } from '../src/main/emulators/registry';
import type { EmulatorManager } from '../src/main/services/emulatorManager';
import type { LaunchRepo } from '../src/main/database/launchRepo';
import { tempDir } from './helpers';

const t = tempDir('omnideck-savebackup-');
afterAll(t.cleanup);

/** A registry with one fake emulator whose saves live in `saveRoot`. */
function fakeRegistry(saveRoot: string) {
  const adapter = {
    manifest: { id: 'fakeemu', name: 'Fake Emu', implemented: true },
    saveLocations: () => [{ label: 'Memory cards', path: join(saveRoot, 'cards') }, { label: 'Save states', path: join(saveRoot, 'states') }],
  };
  return { implemented: () => [adapter], get: (id: string) => (id === 'fakeemu' ? adapter : undefined), require: () => adapter } as unknown as AdapterRegistry;
}

let n = 0;
function makePc(name: string, opts: { saveRoot?: string; installDir?: string } = {}) {
  const base = join(t.dir, `pc-${name}-${n++}`);
  const saveRoot = opts.saveRoot ?? join(base, 'emu-saves');
  mkdirSync(join(saveRoot, 'cards'), { recursive: true });
  mkdirSync(join(saveRoot, 'states'), { recursive: true });
  const db = new Database(':memory:');
  migrate(db);
  const settings = new SettingsRepo(db);
  const ops = new OpsRepo(db);
  const paths = new AppPaths(join(base, 'userdata'), join(base, 'home'));
  const saves = new SaveService(fakeRegistry(saveRoot), {} as EmulatorManager, paths, ops, settings, { computerName: name, installDir: opts.installDir ?? join(base, 'Program Files', 'OmniPC') });
  return { base, saveRoot, settings, ops, paths, saves };
}

let tick = 1_700_000_000;
/** Writes a save file with a distinct mtime so change detection is deterministic. */
function writeSave(path: string, content: string) {
  writeFileSync(path, content);
  tick += 60;
  utimesSync(path, tick, tick);
}

describe('save backup rules (pure)', () => {
  it('decides when a scheduled backup is due', () => {
    const now = new Date('2026-10-11T12:00:00Z');
    expect(scheduledBackupDue('off', null, now)).toBe(false);
    expect(scheduledBackupDue('daily', null, now)).toBe(true);
    expect(scheduledBackupDue('daily', '2026-10-11T00:00:00Z', now)).toBe(false);
    expect(scheduledBackupDue('daily', '2026-10-10T11:59:00Z', now)).toBe(true);
    expect(scheduledBackupDue('weekly', '2026-10-08T12:00:00Z', now)).toBe(false);
    expect(scheduledBackupDue('weekly', '2026-10-04T12:00:00Z', now)).toBe(true);
    expect(scheduledBackupDue('daily', 'garbage', now)).toBe(true);
    expect(scheduledBackupDue('weekly', '2027-01-01T00:00:00Z', now)).toBe(true); // clock went backwards
  });

  it('parses new and legacy file names', () => {
    expect(parseBackupFileName('pcsx2-2026-10-11T08-30-00-000Z-auto.zip')).toEqual({ emulatorId: 'pcsx2', createdAt: '2026-10-11T08:30:00.000Z', kind: 'auto', legacy: false });
    expect(parseBackupFileName('some-emu-2026-10-11T08-30-00-000Z-pre-update.zip')).toMatchObject({ emulatorId: 'some-emu', kind: 'pre-update' });
    expect(parseBackupFileName('pcsx2-2026-10-11T08-30-00-000Z.zip')).toMatchObject({ emulatorId: 'pcsx2', kind: 'manual', legacy: true });
    expect(parseBackupFileName('holiday-photos.zip')).toBeNull();
    expect(parseBackupFileName('pcsx2-2026-10-11T08-30-00-000Z-auto.zip.partial')).toBeNull();
  });

  it('retention keeps the newest N automatic backups and never selects manual, pre-restore or legacy ones', () => {
    const names = [
      'a-2026-01-01T00-00-00-000Z-auto.zip',
      'a-2026-01-02T00-00-00-000Z-after-play.zip',
      'a-2026-01-03T00-00-00-000Z-pre-update.zip',
      'a-2026-01-04T00-00-00-000Z-auto.zip',
      'a-2025-01-01T00-00-00-000Z-manual.zip',
      'a-2025-01-01T00-00-00-000Z-pre-restore.zip',
      'a-2024-01-01T00-00-00-000Z.zip',
      'b-2026-01-01T00-00-00-000Z-auto.zip',
      'notes.txt',
    ].map((fileName) => ({ fileName }));
    expect(selectForRetention(names, 2).map((x) => x.fileName).sort()).toEqual(['a-2026-01-01T00-00-00-000Z-auto.zip', 'a-2026-01-02T00-00-00-000Z-after-play.zip']);
    expect(selectForRetention(names, 0).map((x) => x.fileName)).not.toContain('a-2026-01-04T00-00-00-000Z-auto.zip'); // always keeps at least one
  });

  it('fills defaults and clamps settings', () => {
    expect(saveBackupSettings(undefined)).toEqual({ schedule: 'daily', afterPlay: true, beforeEmulatorUpdate: true, destination: null, keepPerEmulator: 10 });
    expect(saveBackupSettings({ keepPerEmulator: -4, destination: '  ', schedule: 'hourly' as never })).toMatchObject({ keepPerEmulator: 1, destination: null, schedule: 'daily' });
  });

  it('makes PC names safe folder names', () => {
    expect(computerFolderName('GAMING-PC')).toBe('GAMING-PC');
    expect(computerFolderName('my/pc:..')).toBe('my_pc_');
    expect(computerFolderName('..')).toBe('This PC');
    expect(isSafeFolderName('..')).toBe(false);
    expect(isSafeFolderName('a/b')).toBe(false);
  });

  it('suggests existing cloud folders', () => {
    const dirs = new Set(['/home/u/OneDrive', '/home/u/Dropbox', '/data/Dropbox (Work)', '/home/u/Google Drive']);
    const s = cloudFolderSuggestions({
      env: { OneDrive: '/home/u/OneDrive', LOCALAPPDATA: '/home/u/AppData/Local' },
      home: '/home/u',
      isDir: (p) => dirs.has(p),
      readText: (p) => (p === join('/home/u/AppData/Local', 'Dropbox', 'info.json') ? JSON.stringify({ business: { path: '/data/Dropbox (Work)' } }) : null),
      driveLetters: [],
    });
    expect(s).toEqual([
      { provider: 'OneDrive', path: '/home/u/OneDrive' },
      { provider: 'Google Drive', path: join('/home/u', 'Google Drive') },
      { provider: 'Dropbox', path: '/data/Dropbox (Work)' },
      { provider: 'Dropbox', path: join('/home/u', 'Dropbox') },
    ]);
  });
});

describe('SaveService backups', () => {
  it('writes ZIPs atomically and cleans up after a failure', async () => {
    const dir = join(t.dir, 'atomic');
    mkdirSync(dir, { recursive: true });
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from('x'), 'x.txt');
    await writeZipAtomically(zip, join(dir, 'a.zip'));
    expect(readdirSync(dir)).toEqual(['a.zip']);
    const bad = new yazl.ZipFile();
    bad.addBuffer(Buffer.from('x'), 'x.txt');
    await expect(writeZipAtomically(bad, join(dir, 'missing-subdir', 'b.zip'))).rejects.toThrow();
    expect(readdirSync(dir)).toEqual(['a.zip']);
  });

  it('skips unchanged saves, applies retention and keeps manual backups', async () => {
    const pc = makePc('PC-A');
    pc.settings.set({ saveBackup: { ...saveBackupSettings(null), keepPerEmulator: 2 } });
    writeSave(join(pc.saveRoot, 'cards', 'Mcd001.ps2'), 'card v1');
    // A legacy backup made before backup kinds existed.
    mkdirSync(pc.paths.saveBackups, { recursive: true });
    writeFileSync(join(pc.paths.saveBackups, 'fakeemu-2020-01-01T00-00-00-000Z.zip'), 'legacy');

    const manual = await pc.saves.backup('fakeemu');
    expect(manual).toHaveLength(1);
    expect(manual[0].id).toMatch(/^fakeemu-.*-manual\.zip$/);
    expect(manual[0].kind).toBe('manual');
    expect(await pc.saves.backup('fakeemu', 'auto')).toEqual([]); // unchanged since the manual backup
    expect(await pc.saves.backup(null, 'after-play')).toEqual([]);

    for (let i = 2; i <= 5; i++) {
      writeSave(join(pc.saveRoot, 'cards', 'Mcd001.ps2'), `card v${i}`);
      expect(await pc.saves.backup('fakeemu', i % 2 ? 'auto' : 'after-play')).toHaveLength(1);
      expect(await pc.saves.backup('fakeemu', 'auto')).toEqual([]);
    }
    const files = readdirSync(pc.paths.saveBackups);
    expect(files.filter((f) => /-(auto|after-play)\.zip$/.test(f))).toHaveLength(2);
    expect(files).toContain('fakeemu-2020-01-01T00-00-00-000Z.zip');
    expect(files.filter((f) => f.endsWith('-manual.zip'))).toHaveLength(1);
    expect(files.some((f) => f.endsWith('.partial'))).toBe(false);

    const list = await pc.saves.list();
    expect(list).toHaveLength(4);
    expect(list.find((b) => b.id === 'fakeemu-2020-01-01T00-00-00-000Z.zip')).toMatchObject({ kind: 'manual', computer: 'PC-A', thisComputer: true, location: 'local', createdAt: '2020-01-01T00:00:00.000Z' });

    // Manual backups always run, even when nothing changed.
    expect(await pc.saves.backup('fakeemu', 'manual')).toHaveLength(1);
    // The newest backup matches the current saves, so they count as protected.
    const status = await pc.saves.protectionStatus();
    expect(status).toEqual([expect.objectContaining({ emulatorId: 'fakeemu', upToDate: true })]);
  });

  it('writes to a per-PC subfolder of the backup folder and restores another PC\'s backup here', async () => {
    const cloud = join(t.dir, 'OneDrive');
    mkdirSync(cloud, { recursive: true });
    const a = makePc('PC-A');
    const b = makePc('PC-B');
    await a.saves.setDestination(cloud);
    await b.saves.setDestination(cloud);
    writeSave(join(a.saveRoot, 'cards', 'Mcd001.ps2'), 'A card');
    writeSave(join(b.saveRoot, 'cards', 'Mcd001.ps2'), 'B card');
    writeSave(join(b.saveRoot, 'states', 'slot1.p2s'), 'B state');
    const [madeA] = await a.saves.backup('fakeemu', 'auto');
    const [madeB] = await b.saves.backup('fakeemu', 'manual');
    expect(madeA.path.startsWith(join(cloud, SYNC_FOLDER_NAME, 'PC-A'))).toBe(true);
    expect(madeB.path.startsWith(join(cloud, SYNC_FOLDER_NAME, 'PC-B'))).toBe(true);
    expect(madeA.id).toMatch(/^pc:PC-A\/fakeemu-.*-auto\.zip$/);

    const listA = await a.saves.list();
    const fromB = listA.find((x) => x.computer === 'PC-B');
    expect(fromB).toMatchObject({ thisComputer: false, location: 'destination', kind: 'manual', emulatorId: 'fakeemu' });
    expect(listA.find((x) => x.computer === 'PC-A')?.thisComputer).toBe(true);

    // Restore B's backup on A: goes into A's own save folders, after a safety backup.
    const r = await a.saves.restore(fromB!.id);
    expect(readFileSync(join(a.saveRoot, 'cards', 'Mcd001.ps2'), 'utf8')).toBe('B card');
    expect(readFileSync(join(a.saveRoot, 'states', 'slot1.p2s'), 'utf8')).toBe('B state');
    expect(readFileSync(join(b.saveRoot, 'cards', 'Mcd001.ps2'), 'utf8')).toBe('B card');
    expect(r.safetyBackup).toMatch(/-pre-restore\.zip$/);
    expect(r.safetyBackup.startsWith(join(cloud, SYNC_FOLDER_NAME, 'PC-A'))).toBe(true);

    // Retention on A never touches B's folder.
    a.settings.set({ saveBackup: { ...a.saves.config(), keepPerEmulator: 1 } });
    for (let i = 0; i < 3; i++) {
      writeSave(join(a.saveRoot, 'cards', 'Mcd001.ps2'), `A ${i}`);
      await a.saves.backup('fakeemu', 'auto');
    }
    expect(readdirSync(join(cloud, SYNC_FOLDER_NAME, 'PC-B'))).toHaveLength(1);
    const aFiles = readdirSync(join(cloud, SYNC_FOLDER_NAME, 'PC-A'));
    expect(aFiles.filter((f) => f.endsWith('-auto.zip'))).toHaveLength(1);
    expect(aFiles.filter((f) => f.endsWith('-pre-restore.zip'))).toHaveLength(1);
  });

  it('falls back to OmniPC\'s folder when the backup folder disappears', async () => {
    const pc = makePc('PC-C');
    const usb = join(t.dir, 'usb-backups');
    mkdirSync(usb, { recursive: true });
    await pc.saves.setDestination(usb);
    const { rmSync } = await import('node:fs');
    rmSync(usb, { recursive: true, force: true });
    expect((await pc.saves.destinationStatus()).problem).toMatch(/missing/);
    writeSave(join(pc.saveRoot, 'cards', 'x.sav'), 'x');
    const [made] = await pc.saves.backup('fakeemu', 'manual');
    expect(made.location).toBe('local');
    expect(made.path.startsWith(pc.paths.saveBackups)).toBe(true);
  });

  it('validates the chosen backup folder', async () => {
    const pc = makePc('PC-D');
    const rules = pc.saves.destinationRules();
    expect(destinationProblem('relative/path', rules)).toMatch(/full folder path/);
    expect(destinationProblem(join(pc.saveRoot, 'cards', 'sub'), rules)).toMatch(/inside an emulator save folder/);
    expect(destinationProblem(join(pc.base, 'Program Files', 'OmniPC', 'resources'), rules)).toMatch(/program folder/);
    expect(await validateDestination(join(t.dir, 'does-not-exist'), rules, 'PC-D')).toMatch(/does not exist/);
    await expect(pc.saves.setDestination(join(pc.saveRoot, 'states'))).rejects.toThrow(/inside an emulator save folder/);
    expect(pc.saves.config().destination).toBeNull();
    const ok = join(t.dir, 'Dropbox');
    mkdirSync(ok, { recursive: true });
    expect(await validateDestination(ok, rules, 'PC-D')).toBeNull();
    expect(readdirSync(join(ok, SYNC_FOLDER_NAME, 'PC-D'))).toEqual([]); // probe file removed
  });

  it('rejects unsafe backup ids and archives that escape the save folder', async () => {
    const pc = makePc('PC-E');
    pc.settings.set({ saveBackup: { ...pc.saves.config(), destination: join(t.dir, 'OneDrive') } });
    for (const id of ['../x.zip', '..\\x.zip', 'pc:../evil/x.zip', 'pc:PC-B/../../x.zip', 'pc:PC-B/sub/x.zip', '/etc/passwd', 'x.exe', 'pc:..\\x/y.zip']) {
      await expect(pc.saves.restore(id), id).rejects.toThrow(/Invalid backup id|not found/);
    }
    mkdirSync(pc.paths.saveBackups, { recursive: true });
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(JSON.stringify({ emulatorId: 'fakeemu', locations: [{ index: 0, label: 'Memory cards', path: '/anywhere' }] })), 'omnideck-save-backup.json');
    zip.addBuffer(Buffer.from('ok'), '0/good.sav');
    zip.addBuffer(Buffer.from('evil'), '0/XXXXX/escape.txt');
    const file = join(pc.paths.saveBackups, 'fakeemu-2026-01-01T00-00-00-000Z-manual.zip');
    await writeZipAtomically(zip, file);
    // yazl refuses to write "..": patch the entry name in place (same length).
    writeFileSync(file, Buffer.from(readFileSync(file).toString('latin1').split('0/XXXXX/escape.txt').join('0/../../escape.txt'), 'latin1'));
    await expect(pc.saves.restore('fakeemu-2026-01-01T00-00-00-000Z-manual.zip')).rejects.toThrow(/outside|invalid relative path/);
    expect(existsSync(join(pc.saveRoot, 'escape.txt'))).toBe(false);
    expect(existsSync(join(pc.saveRoot, 'cards', 'good.sav'))).toBe(false); // nothing written at all
  });

  it('restores legacy backups (old name and manifest) to the current save folders', async () => {
    const pc = makePc('PC-F');
    writeSave(join(pc.saveRoot, 'cards', 'Mcd001.ps2'), 'current');
    mkdirSync(pc.paths.saveBackups, { recursive: true });
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(JSON.stringify({ emulatorId: 'fakeemu', createdAt: '2024-05-01T00:00:00.000Z', reason: 'manual', locations: [{ index: 0, label: 'Memory cards', path: 'C:\\Users\\old\\OmniDeck\\Saves\\fake\\cards' }] })), 'omnideck-save-backup.json');
    zip.addBuffer(Buffer.from('old card'), '0/Mcd001.ps2');
    await writeZipAtomically(zip, join(pc.paths.saveBackups, 'fakeemu-2024-05-01T00-00-00-000Z.zip'));
    const [legacy] = await pc.saves.list();
    expect(legacy).toMatchObject({ id: 'fakeemu-2024-05-01T00-00-00-000Z.zip', kind: 'manual', emulatorId: 'fakeemu' });
    const r = await pc.saves.restore(legacy.id);
    expect(readFileSync(join(pc.saveRoot, 'cards', 'Mcd001.ps2'), 'utf8')).toBe('old card');
    expect(r.restoredTo).toBe(join(pc.saveRoot, 'cards'));
    expect(r.safetyBackup).toMatch(/-pre-restore\.zip$/);
  });
});

describe('automatic save backups', () => {
  function setup(name: string) {
    const pc = makePc(name);
    const bus = new EventBus();
    const jobs = new JobManager(bus);
    let hook: ((id: string, what: 'update' | 'rollback' | 'reinstall') => Promise<string>) | null = null;
    const emulators = { setBeforeChangeHook: (h: typeof hook) => { hook = h; } } as unknown as EmulatorManager;
    const launches = { get: (id: number) => ({ id, emulatorId: 'fakeemu', outcome: id === 99 ? 'failed_to_start' : 'ok' }) } as unknown as LaunchRepo;
    const state = { active: null as string | null, now: new Date('2026-10-11T12:00:00Z') };
    const auto = new AutoSaveBackup({ saves: pc.saves, settings: pc.settings, launches, jobs, bus, emulators, activeEmulator: () => state.active, backgroundEnabled: () => true, now: () => state.now, afterPlayDelayMs: 60_000 });
    return { pc, auto, state, hook: () => hook!, bus };
  }

  it('runs a scheduled backup when due and not while a game is running', async () => {
    const { pc, auto, state } = setup('SCHED');
    writeSave(join(pc.saveRoot, 'cards', 'a.sav'), 'a');
    state.active = 'fakeemu';
    expect(await auto.tick()).toBeNull();
    state.active = null;
    expect(await auto.tick()).toHaveLength(1);
    expect(pc.settings.getInternal(LAST_SCHEDULED_KEY, null)).toBe('2026-10-11T12:00:00.000Z');
    state.now = new Date('2026-10-11T18:00:00Z');
    writeSave(join(pc.saveRoot, 'cards', 'a.sav'), 'b');
    expect(await auto.tick()).toBeNull(); // not due yet
    state.now = new Date('2026-10-12T13:00:00Z');
    expect(await auto.tick()).toHaveLength(1);
    state.now = new Date('2026-10-13T14:00:00Z');
    expect(await auto.tick()).toEqual([]); // due, but nothing changed: no new ZIP
    pc.settings.set({ saveBackup: { ...pc.saves.config(), schedule: 'off' } });
    state.now = new Date('2026-11-13T14:00:00Z');
    expect(await auto.tick()).toBeNull();
  });

  it('backs up after play (coalesced, only when changed) and before emulator updates', async () => {
    const { pc, auto, hook } = setup('PLAY');
    writeSave(join(pc.saveRoot, 'cards', 'a.sav'), 'a');
    auto.onSessionEnded(1);
    auto.onSessionEnded(2);
    const made = await auto.flushAfterPlay();
    expect(made).toHaveLength(1);
    expect(made[0].kind).toBe('after-play');
    auto.onSessionEnded(3);
    expect(await auto.flushAfterPlay()).toEqual([]); // saves unchanged
    auto.onSessionEnded(99); // failed to start: nothing queued
    expect(await auto.flushAfterPlay()).toEqual([]);
    auto.stop();

    expect(await hook()('fakeemu', 'update')).toMatch(/unchanged/);
    writeSave(join(pc.saveRoot, 'states', 's.sav'), 's');
    expect(await hook()('fakeemu', 'update')).toMatch(/backed up before update/);
    expect(readdirSync(pc.paths.saveBackups).some((f) => f.endsWith('-pre-update.zip'))).toBe(true);
    pc.settings.set({ saveBackup: { ...pc.saves.config(), beforeEmulatorUpdate: false } });
    expect(await hook()('fakeemu', 'update')).toMatch(/Turned off/);
  });
});
