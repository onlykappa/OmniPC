import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrate } from '../src/main/database/migrations';
import { LibraryRepo } from '../src/main/database/libraryRepo';
import { LibraryScanner } from '../src/main/library/scanner';
import { nintendoHeader, ps1Bin, ps2Iso, write } from './fixtures/builders.mjs';
import { tempDir } from './helpers';

const t = tempDir();
afterAll(t.cleanup);
const root = join(t.dir, 'Games');
const db = new Database(':memory:');
migrate(db);
const repo = new LibraryRepo(db);
const scanner = new LibraryScanner(repo, () => [join(t.dir, 'OmniDeck')]);

beforeAll(() => {
  write(join(root, 'PS2', 'Ico (USA).iso'), ps2Iso('SCUS_971.13'));
  write(join(root, 'PS2', 'Final Fantasy X-2 (USA) (Disc 1).iso'), ps2Iso('SLUS_207.42'));
  write(join(root, 'PS2', 'Final Fantasy X-2 (USA) (Disc 2).iso'), ps2Iso('SLUS_207.43'));
  write(join(root, 'GameCube', 'Wind Waker.iso'), nintendoHeader('GZLE01', 'The Legend of Zelda: The Wind Waker'));
  write(join(root, 'PS1', 'Spyro (USA).bin'), ps1Bin('SCUS_942.28'));
  write(join(root, 'PS1', 'Spyro (USA).cue'), 'FILE "Spyro (USA).bin" BINARY\n  TRACK 01 MODE2/2352\n');
  write(join(root, 'PS2', 'Copy of Ico.iso'), ps2Iso('SCUS_971.13'));
  write(join(root, 'docs', 'notes.txt'), 'not a game');
  write(join(root, 'PS2', 'broken.iso'), Buffer.alloc(0));
  write(join(t.dir, 'OmniDeck', 'Emulators', 'x.iso'), ps2Iso());
});

describe('library scanner', () => {
  let pathId = 0;
  it('previews a folder before importing', async () => {
    const p = await scanner.preview(root);
    expect(p.bySystem.ps2).toBeGreaterThanOrEqual(4);
    expect(p.bySystem.gc).toBe(1);
    expect(p.bySystem.ps1).toBe(1);
  });

  it('imports games, groups multi-disc sets and skips CUE components', async () => {
    pathId = repo.addPath(root, 'ABCD-1234', null).id;
    const s = await scanner.scan({ full: false });
    expect(s.added).toBeGreaterThan(0);
    const all = repo.query({ limit: 100, includeUnavailable: true }).items;
    const ff = all.filter((g) => g.title.startsWith('Final Fantasy X-2'));
    expect(ff).toHaveLength(1);
    expect(ff[0].discCount).toBe(2);
    expect(all.filter((g) => g.systemId === 'ps1')).toHaveLength(1);
    const zelda = all.find((g) => g.systemId === 'gc')!;
    expect(zelda.title).toBe('Wind Waker');
    expect(zelda.serial).toBe('GZLE01');
    expect(all.find((g) => g.title === 'broken')!.validation).toBe('invalid');
  });

  it('never merges unrelated games and reports duplicates without deleting them', () => {
    const dups = repo.duplicates();
    const ico = dups.find((d) => d.reason === 'same_serial' && d.games.some((g) => g.path.includes('Ico')));
    expect(ico?.games).toHaveLength(2);
  });

  it('does not scan OmniDeck-managed folders', () => {
    expect(repo.query({ search: 'x', limit: 50 }).items.some((g) => g.title === 'x')).toBe(false);
  });

  it('rescans incrementally (unchanged files are not re-identified)', async () => {
    const s = await scanner.scan({ full: false });
    expect(s.added).toBe(0);
    expect(s.updated).toBe(0);
    expect(s.unchanged).toBeGreaterThan(5);
    const p = join(root, 'PS2', 'Ico (USA).iso');
    utimesSync(p, new Date(), new Date(Date.now() + 5000));
    expect((await scanner.scan({ full: false })).updated).toBe(1);
  });

  it('removes games whose files were deleted', async () => {
    rmSync(join(root, 'PS2', 'Copy of Ico.iso'));
    const s = await scanner.scan({ full: false });
    expect(s.removed).toBe(1);
  });

  it('keeps games as "drive unavailable" when the folder disappears, and restores them', async () => {
    const before = repo.countGames();
    renameSync(root, root + '-offline');
    const s = await scanner.scan({ full: false });
    expect(s.markedUnavailable).toBe(1);
    expect(repo.countGames()).toBe(before);
    expect(repo.query({ limit: 100, includeUnavailable: true }).items.every((g) => g.availability === 'drive_unavailable')).toBe(true);
    renameSync(root + '-offline', root);
    const r = await scanner.refreshAvailability();
    expect(r.available).toEqual([root]);
    expect(repo.query({ limit: 100 }).items.every((g) => g.availability === 'available')).toBe(true);
    expect(repo.getPath(pathId)!.available).toBe(true);
  });

  it('remaps stored paths when the same drive returns under a new letter', () => {
    const id = repo.addPath('E:\\Games', 'VOL-1', 'E:').id;
    db.prepare("INSERT INTO games(system_id,title,sort_title,group_key,library_path_id,added_at,updated_at) VALUES('ps2','T','t','file:t',?, 'x','x')").run(id);
    const gid = (db.prepare('SELECT id FROM games WHERE group_key = ?').get('file:t') as { id: number }).id;
    db.prepare("INSERT INTO game_files(game_id,path,size_bytes,mtime_ms) VALUES(?, 'E:\\Games\\t.iso', 1, 1)").run(gid);
    expect(repo.remapPathPrefix(id, 'E:', 'F:')).toBe(1);
    expect(repo.filesForGame(gid)[0].path).toBe('F:\\Games\\t.iso');
  });

  it('handles a large library quickly (query uses indexes)', () => {
    const insert = db.prepare("INSERT INTO games(system_id,title,sort_title,group_key,library_path_id,added_at,updated_at) VALUES('ps2',?,?,?,NULL,'2026-01-01','2026-01-01')");
    db.transaction(() => { for (let i = 0; i < 12000; i++) insert.run(`Game ${i}`, `game ${String(i).padStart(5, '0')}`, `bulk:${i}`); })();
    const start = performance.now();
    const page = repo.query({ search: 'Game 11', limit: 200, sort: 'title' });
    expect(page.total).toBeGreaterThan(100);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe('scanner robustness', () => {
  it('reports unreadable roots instead of deleting games', async () => {
    const db2 = new Database(':memory:');
    migrate(db2);
    const r2 = new LibraryRepo(db2);
    r2.addPath(join(t.dir, 'does-not-exist'), null, null);
    const s = await new LibraryScanner(r2, () => []).scan({ full: true });
    expect(s.removed).toBe(0);
  });
  writeFileSync(join(t.dir, '.keep'), '');
});
