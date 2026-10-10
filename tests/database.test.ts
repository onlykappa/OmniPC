import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backupDatabase, isHealthy, openDatabase } from '../src/main/database/db';
import { LATEST_SCHEMA_VERSION, migrate, type Migration } from '../src/main/database/migrations';
import { LibraryRepo } from '../src/main/database/libraryRepo';
import { SettingsRepo, DEFAULT_SETTINGS } from '../src/main/database/settingsRepo';
import { tempDir } from './helpers';

const t = tempDir();
afterAll(t.cleanup);

describe('migrations', () => {
  it('migrates a fresh database to the latest version with all tables and indexes', () => {
    const db = new Database(':memory:');
    const r = migrate(db);
    expect(r.from).toBe(0);
    expect(r.to).toBe(LATEST_SCHEMA_VERSION);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((x) => x.name);
    for (const name of ['games', 'systems', 'emulators', 'emulator_versions', 'library_paths', 'metadata', 'controllers', 'profiles', 'game_profiles', 'launch_history', 'diagnostics', 'repairs', 'configuration_backups', 'settings', 'change_log', 'notifications']) expect(tables).toContain(name);
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map((x) => x.name);
    expect(idx).toContain('idx_games_sort_title');
  });

  it('is idempotent and applies only newer migrations', () => {
    const db = new Database(':memory:');
    migrate(db);
    const extra: Migration = { version: LATEST_SCHEMA_VERSION + 1, name: 'test column', up: (d) => d.exec('ALTER TABLE games ADD COLUMN test_col TEXT') };
    expect(migrate(db).applied).toEqual([]);
    expect(migrate(db, [{ version: 1, name: 'x', up: () => { throw new Error('must not rerun'); } }, extra]).applied).toEqual([`${extra.version}: test column`]);
  });

  it('refuses to run against a newer schema', () => {
    const db = new Database(':memory:');
    db.pragma('user_version = 999');
    expect(() => migrate(db)).toThrow(/newer/);
  });
});

describe('database recovery', () => {
  it('restores the newest healthy backup when the database is corrupt', async () => {
    const file = join(t.dir, 'data', 'omnideck.db');
    const backups = join(t.dir, 'backups');
    const first = openDatabase(file, backups);
    new LibraryRepo(first.db).addPath('D:\\Games', null, 'D:');
    await backupDatabase(first.db, backups);
    first.db.close();
    writeFileSync(file, Buffer.from('this is definitely not sqlite'.repeat(200)));
    expect(isHealthy(file).ok).toBe(false);
    const second = openDatabase(file, backups);
    expect(second.recovered).toBe('from_backup');
    expect(new LibraryRepo(second.db).listPaths().map((p) => p.path)).toEqual(['D:\\Games']);
    expect(readdirSync(join(t.dir, 'data')).some((f) => f.includes('.corrupt-'))).toBe(true);
    second.db.close();
  });

  it('starts fresh (without touching game files) when no backup exists', () => {
    const file = join(t.dir, 'fresh', 'omnideck.db');
    const gameFile = join(t.dir, 'fresh', 'game.iso');
    writeFileSync(join(t.dir, 'fresh-marker'), '');
    openDatabase(file, join(t.dir, 'nobackups')).db.close();
    writeFileSync(gameFile, 'game');
    writeFileSync(file, 'garbage');
    const r = openDatabase(file, join(t.dir, 'nobackups'));
    expect(r.recovered).toBe('fresh');
    expect(existsSync(gameFile)).toBe(true);
    r.db.close();
  });
});

describe('settings repo', () => {
  it('returns defaults and persists patches', () => {
    const db = new Database(':memory:');
    migrate(db);
    const s = new SettingsRepo(db);
    expect(s.getAll()).toEqual(DEFAULT_SETTINGS);
    s.set({ defaultPreset: 'quality', crashLoopThreshold: 5 });
    expect(s.get('defaultPreset')).toBe('quality');
    expect(s.getAll().crashLoopThreshold).toBe(5);
  });
});
