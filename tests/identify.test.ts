import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { identifyFile } from '../src/main/library/identify';
import { validateGameFile, splitArchiveIssue } from '../src/main/library/validate';
import { nintendoHeader, ps1Bin, ps2Iso, rvz, write } from './fixtures/builders.mjs';
import { tempDir } from './helpers';

const t = tempDir();
afterAll(t.cleanup);

describe('identifyFile', () => {
  it('identifies a PS2 disc from SYSTEM.CNF and extracts the serial', async () => {
    const p = join(t.dir, 'misc', 'Shadow of the Colossus (USA).iso');
    write(p, ps2Iso('SCUS_974.72'));
    const id = await identifyFile(p, ['misc']);
    expect(id.systemId).toBe('ps2');
    expect(id.serial).toBe('SCUS-97472');
    expect(id.region).toBe('USA');
    expect(id.title).toBe('Shadow of the Colossus');
    expect(id.confidence).toBe('high');
  });

  it('identifies a PS1 raw 2352-byte BIN', async () => {
    const p = join(t.dir, 'misc', 'Crash.bin');
    write(p, ps1Bin('SCUS_944.26'));
    const id = await identifyFile(p, ['misc']);
    expect(id.systemId).toBe('ps1');
    expect(id.serial).toBe('SCUS-94426');
  });

  it('identifies GameCube and Wii images and their containers', async () => {
    const gc = join(t.dir, 'x', 'melee.iso');
    write(gc, nintendoHeader('GALE01', 'Super Smash Bros Melee'));
    const wii = join(t.dir, 'x', 'kart.rvz');
    write(wii, rvz('RMCE01', 'Mario Kart Wii', true));
    const a = await identifyFile(gc, ['x']);
    const b = await identifyFile(wii, ['x']);
    expect(a.systemId).toBe('gc');
    expect(a.serial).toBe('GALE01');
    expect(a.internalTitle).toBe('Super Smash Bros Melee');
    expect(b.systemId).toBe('wii');
    expect(b.serial).toBe('RMCE01');
  });

  it('falls back to folder hints for ambiguous unreadable formats', async () => {
    const p = join(t.dir, 'PS2', 'Some Game.iso');
    write(p, Buffer.alloc(4096));
    const id = await identifyFile(p, ['PS2', 'Games']);
    expect(id.systemId).toBe('ps2');
    expect(id.confidence).toBe('medium');
    expect(id.evidence.join(' ')).toMatch(/Folder name/);
  });

  it('uses the extension when it is unambiguous', async () => {
    const p = join(t.dir, 'any', 'game.nds');
    write(p, Buffer.alloc(512));
    expect((await identifyFile(p, ['any'])).systemId).toBe('nds');
  });

  it('identifies a CUE sheet from its first track', async () => {
    write(join(t.dir, 'cue', 'Game (USA).bin'), ps1Bin('SLUS_012.34'));
    write(join(t.dir, 'cue', 'Game (USA).cue'), 'FILE "Game (USA).bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n');
    const id = await identifyFile(join(t.dir, 'cue', 'Game (USA).cue'), ['cue']);
    expect(id.systemId).toBe('ps1');
    expect(id.serial).toBe('SLUS-01234');
  });

  it('returns no system for unrelated files', async () => {
    const p = join(t.dir, 'docs', 'readme.txt');
    write(p, 'hello');
    expect((await identifyFile(p, ['docs'])).systemId).toBeNull();
  });
});

describe('validateGameFile', () => {
  it('flags empty files and unfinished downloads', async () => {
    const empty = join(t.dir, 'v', 'empty.iso');
    write(empty, Buffer.alloc(0));
    expect((await validateGameFile(empty, 'ps2', 0)).state).toBe('invalid');
    const part = join(t.dir, 'v', 'game.iso.crdownload');
    write(part, Buffer.alloc(100));
    expect((await validateGameFile(part, null, 100)).notes.join()).toMatch(/unfinished download/);
  });
  it('flags CUE sheets with missing tracks', async () => {
    const cue = join(t.dir, 'v', 'broken.cue');
    write(cue, 'FILE "missing.bin" BINARY\n');
    const r = await validateGameFile(cue, 'ps1', 30);
    expect(r.state).toBe('invalid');
    expect(r.notes.join()).toMatch(/missing track/);
  });
  it('detects missing split archive pieces', () => {
    write(join(t.dir, 's', 'game.7z.001'), 'a');
    write(join(t.dir, 's', 'game.7z.003'), 'c');
    expect(splitArchiveIssue(join(t.dir, 's', 'game.7z.001'))).toMatch(/missing part \.002/);
  });
  it('accepts a sector-aligned PS2 image', async () => {
    const p = join(t.dir, 'v', 'ok.iso');
    const data = ps2Iso();
    write(p, data);
    expect((await validateGameFile(p, 'ps2', data.length)).state).toBe('ok');
  });
});

describe('archives', () => {
  it('only treats zip/7z as arcade sets in arcade folders', async () => {
    const zip = (p: string) => write(p, Buffer.from('PK\x05\x06' + '\0'.repeat(18), 'latin1'));
    zip(join(t.dir, 'arc', 'mame', 'pacman.zip'));
    zip(join(t.dir, 'arc', 'PS2', 'Some Game.zip'));
    zip(join(t.dir, 'arc', 'downloads', 'game-patches.zip'));
    expect((await identifyFile(join(t.dir, 'arc', 'mame', 'pacman.zip'), ['mame'])).systemId).toBe('arcade');
    // PCSX2 and Xenia cannot open archives: a zip in their folders is not a game.
    expect((await identifyFile(join(t.dir, 'arc', 'PS2', 'Some Game.zip'), ['PS2'])).systemId).toBeNull();
    zip(join(t.dir, 'arc', 'Xbox 360', 'game-patches.zip'));
    expect((await identifyFile(join(t.dir, 'arc', 'Xbox 360', 'game-patches.zip'), ['Xbox 360'])).systemId).toBeNull();
    // RetroArch loads zipped ROMs.
    zip(join(t.dir, 'arc', 'snes', 'Some Game.zip'));
    expect((await identifyFile(join(t.dir, 'arc', 'snes', 'Some Game.zip'), ['snes'])).systemId).toBe('snes');
    expect((await identifyFile(join(t.dir, 'arc', 'downloads', 'game-patches.zip'), ['downloads'])).systemId).toBeNull();
  });
});
