import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createWriteStream, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import yazl from 'yazl';
import { migrate } from '../src/main/database/migrations';
import { LibraryRepo } from '../src/main/database/libraryRepo';
import { LibraryScanner } from '../src/main/library/scanner';
import { applyCueRepair, applyM3uRebuild, diagnoseGames, extractGameArchive, planCueRepair, planM3uRebuild, restoreFiles, revalidateGame } from '../src/main/library/gameFix';
import { splitArchiveIssue, validateGameFile } from '../src/main/library/validate';
import { ps1Bin, write } from './fixtures/builders.mjs';
import { tempDir } from './helpers';

const t = tempDir();
afterAll(t.cleanup);

function makeZip(path: string, entries: Record<string, Buffer | string>): Promise<void> {
  const z = new yazl.ZipFile();
  for (const [n, c] of Object.entries(entries)) z.addBuffer(Buffer.from(c), n, { mtime: new Date() });
  return new Promise((r) => { z.outputStream.pipe(createWriteStream(path)).on('close', () => r()); z.end(); });
}

describe('N64 .z64 ROMs are not split ZIP parts', () => {
  it('accepts a lone .z64 ROM', async () => {
    const p = join(t.dir, 'n64', 'All-Star Baseball 2000 (U) [!].z64');
    write(p, Buffer.alloc(4096, 1));
    expect(splitArchiveIssue(p)).toBeNull();
    expect((await validateGameFile(p, 'n64', 4096)).state).toBe('ok');
  });
  it('still flags a real split ZIP with no final .zip', () => {
    write(join(t.dir, 'split', 'big.z01'), 'a');
    write(join(t.dir, 'split', 'big.z02'), 'b');
    expect(splitArchiveIssue(join(t.dir, 'split', 'big.z01'))).toMatch(/missing its final \.zip/);
  });
});

describe('CUE repair', () => {
  it('points FILE entries at renamed track files and can be undone', async () => {
    const dir = join(t.dir, 'cue1');
    write(join(dir, 'Game (USA) (Track 01).bin'), ps1Bin());
    write(join(dir, 'Game (USA) (Track 02).bin'), Buffer.alloc(2352));
    const cue = join(dir, 'Game (USA).cue');
    const original = 'FILE "game (usa) (track 1).bin" BINARY\r\n  TRACK 01 MODE2/2352\r\nFILE "Game (USA) (Track 2).bin" BINARY\r\n  TRACK 02 AUDIO\r\n';
    write(cue, original);
    expect((await validateGameFile(cue, 'ps1', 100)).state).toBe('invalid');
    const plan = await planCueRepair(cue);
    expect(plan.changes.map((c) => c.to)).toEqual(['Game (USA) (Track 01).bin', 'Game (USA) (Track 02).bin']);
    const backup = await applyCueRepair(cue, plan);
    expect(readFileSync(cue, 'utf8')).toContain('FILE "Game (USA) (Track 01).bin" BINARY');
    expect((await validateGameFile(cue, 'ps1', 100)).state).toBe('ok');
    await restoreFiles([{ path: cue, backup }]);
    expect(readFileSync(cue, 'utf8')).toBe(original);
  });
  it('matches a single-track sheet whose .bin was renamed', async () => {
    const dir = join(t.dir, 'cue2');
    write(join(dir, 'Spyro.bin'), ps1Bin());
    write(join(dir, 'Spyro.cue'), 'FILE "SCUS-94228.bin" BINARY\n  TRACK 01 MODE2/2352\n');
    expect((await planCueRepair(join(dir, 'Spyro.cue'))).changes).toEqual([{ from: 'SCUS-94228.bin', to: 'Spyro.bin' }]);
  });
  it('does not guess when nothing matches', async () => {
    const dir = join(t.dir, 'cue3');
    write(join(dir, 'A.bin'), 'x');
    write(join(dir, 'B.bin'), 'x');
    write(join(dir, 'C.cue'), 'FILE "C (Track 1).bin" BINARY\nFILE "C (Track 2).bin" BINARY\n');
    expect((await planCueRepair(join(dir, 'C.cue'))).changes).toEqual([]);
  });
});

describe('M3U rebuild', () => {
  it('rebuilds a playlist from the disc files in the folder, in disc order', async () => {
    const dir = join(t.dir, 'm3u');
    for (const n of [1, 2, 3]) {
      write(join(dir, `Final Fantasy VII (USA) (Disc ${n}).cue`), `FILE "Final Fantasy VII (USA) (Disc ${n}).bin" BINARY\n`);
      write(join(dir, `Final Fantasy VII (USA) (Disc ${n}).bin`), 'x');
    }
    const m3u = join(dir, 'Final Fantasy VII (USA).m3u');
    write(m3u, 'FF7 (Disc 1).cue\nFF7 (Disc 2).cue\n');
    const discs = await planM3uRebuild(m3u);
    expect(discs).toEqual([1, 2, 3].map((n) => `Final Fantasy VII (USA) (Disc ${n}).cue`));
    await applyM3uRebuild(m3u, discs!);
    expect((await validateGameFile(m3u, 'ps1', 100)).state).toBe('ok');
    expect(await planM3uRebuild(m3u)).toBeNull();
  });
});

describe('zipped disc games', () => {
  it('extracts next to the archive, keeps it, and clears the warning', async () => {
    const dir = join(t.dir, 'zip');
    const zip = join(dir, 'Crash (USA).zip');
    write(join(dir, '.keep'), '');
    await makeZip(zip, { 'Crash (USA).bin': ps1Bin(), 'Crash (USA).cue': 'FILE "Crash (USA).bin" BINARY\n' });
    expect((await validateGameFile(zip, 'ps1', 100)).notes.join()).toMatch(/compressed archive/);
    const r = await extractGameArchive(zip);
    expect(existsSync(zip)).toBe(true);
    expect(readdirSync(r.folder).sort()).toEqual(['Crash (USA).bin', 'Crash (USA).cue']);
    expect((await validateGameFile(zip, 'ps1', 100)).state).toBe('ok');
    await expect(extractGameArchive(zip)).rejects.toThrow(/already exists/);
    expect(readdirSync(dir).some((n) => n.includes('omnipc-extracting'))).toBe(false);
  });
});

describe('diagnoseGames', () => {
  it('lists problem games with fixes and clears after revalidation', async () => {
    const root = join(t.dir, 'lib');
    write(join(root, 'PS1', 'Tekken 3 (USA).bin'), ps1Bin('SCUS_944.26'));
    write(join(root, 'PS1', 'Tekken 3 (USA).cue'), 'FILE "tekken 3 (usa).BIN" BINARY\n  TRACK 01 MODE2/2352\n');
    const db = new Database(':memory:');
    migrate(db);
    const repo = new LibraryRepo(db);
    repo.addPath(root, null, null);
    await new LibraryScanner(repo, () => []).scan({ full: true });
    const problems = await diagnoseGames(db);
    // Linux is case sensitive, so the lower-case reference is "missing" here.
    const tekken = problems.find((p) => p.title.startsWith('Tekken'));
    if (process.platform !== 'win32') {
      expect(tekken?.issues[0].kind).toBe('cue-missing-track');
      expect(tekken?.issues[0].fixes[0].actionId).toBe('game.repairCue');
      const file = repo.filesForGame(tekken!.gameId)[0];
      await applyCueRepair(file.path, await planCueRepair(file.path));
      expect(await revalidateGame(repo, tekken!.gameId)).toBe(0);
      expect((await diagnoseGames(db)).find((p) => p.gameId === tekken!.gameId)).toBeUndefined();
    }
    repo.setFailureState(repo.query({ limit: 10, includeUnavailable: true }).items[0].id, 3, true);
    expect((await diagnoseGames(db)).some((p) => p.issues.some((i) => i.kind === 'crash-loop'))).toBe(true);
  });
});
