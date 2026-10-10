import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrate } from '../src/main/database/migrations';
import { OpsRepo } from '../src/main/database/opsRepo';
import { ConfigBackupService } from '../src/main/config/backups';
import { tempDir } from './helpers';

const t = tempDir();
afterAll(t.cleanup);

describe('configuration backups', () => {
  const db = new Database(':memory:');
  migrate(db);
  const ops = new OpsRepo(db);
  const svc = new ConfigBackupService(join(t.dir, 'backups'), ops, 3);
  const root = join(t.dir, 'emu');
  const ini = join(root, 'inis', 'PCSX2.ini');
  const extra = join(root, 'inis', 'new.ini');
  mkdirSync(join(root, 'inis'), { recursive: true });

  it('backs up, diffs and restores (with a safety backup first)', async () => {
    writeFileSync(ini, '[UI]\nTheme = dark\n');
    const b = await svc.create('pcsx2', 'Before change', 'test', [{ root, path: ini }, { root, path: extra }]);
    expect(b.files).toEqual([join('inis', 'PCSX2.ini')]);
    writeFileSync(ini, '[UI]\nTheme = light\n');
    writeFileSync(extra, 'created later');
    const diff = await svc.diff(b.id);
    const f = diff.files.find((x) => x.relPath.endsWith('PCSX2.ini'))!;
    expect(f.status).toBe('changed');
    expect(f.lines.some((l) => l.kind === '-' && l.text.includes('dark'))).toBe(true);
    expect(diff.files.find((x) => x.relPath.endsWith('new.ini'))!.status).toBe('added');
    const r = await svc.restore(b.id);
    expect(readFileSync(ini, 'utf8')).toContain('dark');
    expect(existsSync(extra)).toBe(false);
    expect(existsSync(extra + '.omnideck-removed')).toBe(true);
    expect(r.safetyBackupId).not.toBeNull();
    expect(ops.getBackup(r.safetyBackupId!)!.reason).toBe('pre-restore');
  });

  it('keeps a bounded number of revisions', async () => {
    for (let i = 0; i < 5; i++) await svc.create('pcsx2', `rev ${i}`, 'test', [{ root, path: ini }]);
    expect(ops.backups('pcsx2').length).toBe(3);
  });
});

describe('data root after the rename to OmniPC', () => {
  it('uses %USERPROFILE%\\OmniPC for new installs and keeps an existing OmniDeck folder', async () => {
    const { mkdirSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: j } = await import('node:path');
    const { AppPaths: P } = await import('../src/main/core/paths');
    const fresh = mkdtempSync(j(tmpdir(), 'omnipc-home-'));
    expect(P.defaultRoot(fresh)).toBe(j(fresh, 'OmniPC'));
    const upgraded = mkdtempSync(j(tmpdir(), 'omnipc-home-'));
    mkdirSync(j(upgraded, 'OmniDeck'));
    expect(P.defaultRoot(upgraded)).toBe(j(upgraded, 'OmniDeck'));
    mkdirSync(j(upgraded, 'OmniPC'));
    expect(P.defaultRoot(upgraded)).toBe(j(upgraded, 'OmniPC'));
  });
});
