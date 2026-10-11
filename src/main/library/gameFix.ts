// OmniDoctor > Games: finds games that will not run because of the game files
// themselves (not the emulator) and offers fixes. Every fix is conservative:
//  - original game files are never deleted or modified;
//  - CUE sheets and M3U playlists are only rewritten after a backup copy is
//    written next to them (undoable from Repair History);
//  - archives are extracted into a new folder next to the archive, which is kept.

import { existsSync } from 'node:fs';
import { copyFile, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import type { GameIssue, GameProblem, RepairSuggestion } from '@shared/models';
import type { SystemId } from '@shared/systems';
import { extractArchive } from '../downloads/archive';
import { parseCueFiles, parseM3u } from './identify';
import type { LibraryRepo } from '../database/libraryRepo';
import { DISC_SYSTEMS, fileStat, validateGameFile } from './validate';

const fix = (actionId: string, label: string, safety: RepairSuggestion['safety'], params: Record<string, unknown>, description: string): RepairSuggestion => ({ actionId, label, safety, params, description });

interface Row {
  id: number;
  title: string;
  system_id: SystemId;
  availability: string;
  consecutive_failures: number;
  crash_loop_paused: number;
  file_id: number | null;
  path: string | null;
  validation: string | null;
  validation_note: string | null;
}

/** Games with invalid/warning files, unavailable drives or repeated launch failures. */
export async function diagnoseGames(db: BetterSqlite3.Database, opts: { limit?: number } = {}): Promise<GameProblem[]> {
  const rows = db.prepare(`
    SELECT g.id, g.title, g.system_id, g.availability, g.consecutive_failures, g.crash_loop_paused,
           f.id AS file_id, f.path, f.validation, f.validation_note
    FROM games g LEFT JOIN game_files f ON f.game_id = g.id
    WHERE g.validation IN ('invalid', 'warning') OR g.availability != 'available' OR g.crash_loop_paused = 1 OR g.consecutive_failures > 0
    ORDER BY g.sort_title COLLATE NOCASE, f.path`).all() as Row[];
  const byGame = new Map<number, Row[]>();
  for (const r of rows) byGame.set(r.id, [...(byGame.get(r.id) ?? []), r]);
  const out: GameProblem[] = [];
  for (const [gameId, files] of byGame) {
    if (opts.limit && out.length >= opts.limit) break;
    const g = files[0];
    const issues: GameIssue[] = [];
    if (g.availability !== 'available') {
      issues.push({ kind: 'unavailable', severity: 'warning', title: 'Game drive is not connected', detail: 'The drive or network folder holding this game is not reachable. The game is kept in your library.', fixes: [fix('library.remapPaths', 'Re-detect game drives', 'safe', {}, 'Looks for the drive again, including at a different drive letter.')], manualSteps: ['Reconnect the drive or network share.'] });
    } else {
      for (const f of files) if (f.file_id !== null && f.path) issues.push(...(await fileIssues(gameId, g.system_id, f.file_id, f.path, f.validation ?? 'ok', f.validation_note ?? '')));
    }
    if (g.crash_loop_paused) {
      issues.push({ kind: 'crash-loop', severity: 'problem', title: 'Launching is paused after repeated crashes', detail: `The emulator crashed ${g.consecutive_failures} time(s) in a row, so OmniPC stopped launching it automatically.`, fixes: [fix('launch.resetCrashLoop', 'Allow launching again', 'safe', { gameId }, 'Clears the crash counter so the game can be launched.')], manualSteps: ['Check the game page for the emulator log of the last crash.'] });
    } else if (g.consecutive_failures > 0) {
      issues.push({ kind: 'failures', severity: 'warning', title: `Last ${g.consecutive_failures} launch(es) failed`, detail: 'The emulator exited with an error. If you fixed the cause, reset the counter.', fixes: [fix('launch.resetCrashLoop', 'Reset failure count', 'safe', { gameId }, 'Clears the failure counter.')], manualSteps: [] });
    }
    if (!issues.length) continue;
    const primary = files.find((f) => f.path)?.path ?? '';
    out.push({ gameId, title: g.title, systemId: g.system_id, path: primary, issues });
  }
  return out;
}

async function fileIssues(gameId: number, systemId: SystemId, fileId: number, path: string, validation: string, note: string): Promise<GameIssue[]> {
  if (!existsSync(path)) {
    return [{ kind: 'missing-file', severity: 'problem', title: 'Game file is missing', detail: `${path} no longer exists. It may have been moved or renamed.`, fixes: [fix('library.rescan', 'Rescan library', 'safe', {}, 'Updates the library with files that moved or were removed.')], manualSteps: ['If you moved the game, make sure its new folder is in Settings > Library.'] }];
  }
  if (validation === 'ok' || validation === 'unchecked') return [];
  const out: GameIssue[] = [];
  const revalidate = fix('game.revalidate', 'Check again', 'safe', { gameId }, 'Re-runs the file checks for this game.');
  const ext = extname(path).toLowerCase();
  const name = basename(path);
  const sev = validation === 'invalid' ? 'problem' : 'warning';
  let handled = false;
  if (/CUE sheet references missing track|CUE sheet does not reference/.test(note)) {
    handled = true;
    const plan = ext === '.cue' ? await planCueRepair(path) : null;
    out.push({
      kind: 'cue-missing-track', severity: 'problem', title: 'CUE sheet points at track files that are not there',
      detail: plan?.changes.length ? `OmniPC found the matching track file(s) under a different name:\n${plan.changes.map((c) => `${c.from} → ${c.to}`).join('\n')}` : 'The track files named in the CUE sheet were not found next to it.',
      fixes: plan?.changes.length ? [fix('game.repairCue', 'Fix CUE sheet', 'low', { gameId, fileId }, `Rewrites ${name} to point at the track files that exist. A backup copy is kept and the change can be undone.`)] : [revalidate],
      manualSteps: plan?.changes.length ? [] : ['Copy the missing .bin track file(s) next to the .cue, or re-dump the disc.'],
    });
  }
  if (/Playlist references missing disc|M3U playlist is empty/.test(note)) {
    handled = true;
    const plan = ext === '.m3u' ? await planM3uRebuild(path) : null;
    out.push({
      kind: 'm3u-missing-disc', severity: 'problem', title: 'Multi-disc playlist lists discs that are not there',
      detail: plan?.length ? `OmniPC can rebuild it from the disc files in the folder:\n${plan.join('\n')}` : 'The disc files named in the playlist were not found.',
      fixes: plan?.length ? [fix('game.rebuildM3u', 'Rebuild playlist', 'low', { gameId, fileId }, `Rewrites ${name} with the disc files found next to it. A backup copy is kept and the change can be undone.`)] : [revalidate],
      manualSteps: plan?.length ? [] : ['Put every disc of the game in the same folder as the .m3u.'],
    });
  }
  if (/compressed archive/.test(note)) {
    handled = true;
    const canExtract = ['.zip', '.7z'].includes(ext) && DISC_SYSTEMS.includes(systemId);
    out.push({
      kind: 'archived', severity: 'warning', title: 'Game is still zipped',
      detail: 'This emulator cannot run disc images from inside an archive.',
      fixes: canExtract ? [fix('game.extractArchive', 'Extract game', 'low', { gameId, fileId }, `Extracts ${name} into a new folder next to it and rescans your library. The archive is kept; you can delete it yourself afterwards.`)] : [],
      manualSteps: canExtract ? [] : ['Extract the archive with 7-Zip or WinRAR, then rescan your library.'],
    });
  }
  if (/Split (set|ZIP)/.test(note)) {
    handled = true;
    out.push({ kind: 'split-archive', severity: 'problem', title: 'Part of a split archive is missing', detail: note, fixes: [revalidate], manualSteps: ['Download or copy the missing part into the same folder, then press "Check again".'] });
  }
  if (/unfinished download|empty \(0 bytes\)/.test(note)) {
    handled = true;
    out.push({ kind: 'incomplete', severity: 'problem', title: 'Game file is incomplete', detail: note, fixes: [revalidate], manualSteps: ['Finish the download or copy the file again from your original dump.'] });
  }
  if (/cannot be read/.test(note)) {
    handled = true;
    out.push({ kind: 'unreadable', severity: 'problem', title: 'Game file cannot be read', detail: note, fixes: [revalidate], manualSteps: ['Check the drive is healthy and the file is not open in another program or blocked by antivirus.'] });
  }
  if (/truncated|incomplete|not a standard disc size|not sector aligned/.test(note) && !/unfinished download/.test(note)) {
    handled = true;
    out.push({ kind: 'suspicious-size', severity: 'warning', title: 'Image size looks unusual', detail: note, fixes: [revalidate], manualSteps: ['If the game crashes or freezes, re-dump it or verify it against a Redump/No-Intro checksum.'] });
  }
  if (!handled) out.push({ kind: 'other', severity: sev, title: validation === 'invalid' ? 'Game file failed validation' : 'Game file has a warning', detail: note || path, fixes: [revalidate], manualSteps: [] });
  return out;
}

// ------------------------------------------------------------------ CUE

/** Name key tolerant of case, punctuation and leading zeros ("Track 1" == "track 01"). */
function looseKey(name: string): string {
  return name.toLowerCase().replace(/\d+/g, (n) => String(Number(n))).replace(/[^a-z0-9]/g, '');
}

const TRACK_EXT = ['.bin', '.img', '.iso', '.wav', '.ape', '.flac', '.mp3', '.ogg', '.raw'];

export interface CuePlan { changes: { from: string; to: string }[]; unresolved: string[] }

/** Works out which existing files the CUE's missing FILE entries should point at. */
export async function planCueRepair(cuePath: string): Promise<CuePlan> {
  const dir = dirname(cuePath);
  const refs = await parseCueFiles(cuePath);
  const siblings = (await readdir(dir).catch(() => [] as string[])).filter((s) => TRACK_EXT.includes(extname(s).toLowerCase()));
  const referenced = new Set(refs.filter((r) => existsSync(join(dir, r))).map((r) => basename(r).toLowerCase()));
  const missing = refs.filter((r) => !existsSync(join(dir, r)));
  const changes: CuePlan['changes'] = [];
  const unresolved: string[] = [];
  const taken = new Set<string>(referenced);
  for (const ref of missing) {
    const want = basename(ref.replace(/\\/g, '/'));
    const free = siblings.filter((s) => !taken.has(s.toLowerCase()));
    // 1. same name in another case / different separators / leading zeros
    let hit = free.find((s) => s.toLowerCase() === want.toLowerCase()) ?? free.find((s) => looseKey(s) === looseKey(want));
    // 2. single-track sheet whose .bin was renamed along with the .cue
    if (!hit && refs.length === 1) {
      const stem = basename(cuePath, extname(cuePath)).toLowerCase();
      hit = free.find((s) => basename(s, extname(s)).toLowerCase() === stem) ?? (free.length === 1 ? free[0] : undefined);
    }
    if (hit) {
      changes.push({ from: ref, to: hit });
      taken.add(hit.toLowerCase());
    } else unresolved.push(ref);
  }
  return { changes, unresolved };
}

/** Rewrites FILE lines per the plan. Returns the backup path. */
export async function applyCueRepair(cuePath: string, plan: CuePlan): Promise<string> {
  const text = await readFile(cuePath, 'utf8');
  const map = new Map(plan.changes.map((c) => [c.from, c.to]));
  const next = text.replace(/^(\s*FILE\s+)"?([^"\r\n]+?)"?(\s+\w+\s*)$/gim, (line, pre: string, ref: string, post: string) => (map.has(ref) ? `${pre}"${map.get(ref)}"${post}` : line));
  const backup = await backupFile(cuePath);
  await writeFile(cuePath, next, 'utf8');
  return backup;
}

// ------------------------------------------------------------------ M3U

const DISC_EXT = ['.cue', '.chd', '.pbp', '.iso', '.cso', '.rvz', '.gcz', '.ccd', '.mds'];

/** Disc files for the playlist, in disc order, or null when the folder does not hold a clear set. */
export async function planM3uRebuild(m3uPath: string): Promise<string[] | null> {
  const dir = dirname(m3uPath);
  const base = looseKey(basename(m3uPath, extname(m3uPath)).replace(/\s*\((disc|disk|cd)\s*\d+\)/i, ''));
  const files = await readdir(dir).catch(() => [] as string[]);
  const discs = files
    .map((f) => ({ f, m: /\((?:disc|disk|cd)\s*(\d+)(?:\s*of\s*\d+)?\)/i.exec(f) }))
    .filter((x) => x.m && DISC_EXT.includes(extname(x.f).toLowerCase()))
    .filter((x) => looseKey(x.f.slice(0, x.m!.index)).startsWith(base.slice(0, Math.max(4, Math.min(base.length, 12)))));
  // Prefer .cue over .bin-like formats when both exist for the same disc.
  const byDisc = new Map<number, string>();
  for (const { f, m } of discs) {
    const n = Number(m![1]);
    const cur = byDisc.get(n);
    if (!cur || DISC_EXT.indexOf(extname(f).toLowerCase()) < DISC_EXT.indexOf(extname(cur).toLowerCase())) byDisc.set(n, f);
  }
  const ordered = [...byDisc.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
  if (ordered.length < 2) return null;
  const current = await parseM3u(m3uPath);
  if (current.length === ordered.length && current.every((c, i) => c === ordered[i])) return null;
  return ordered;
}

export async function applyM3uRebuild(m3uPath: string, discs: string[]): Promise<string> {
  const backup = await backupFile(m3uPath);
  await writeFile(m3uPath, `${discs.join('\r\n')}\r\n`, 'utf8');
  return backup;
}

// ------------------------------------------------------------------ archives

/**
 * Extracts a zipped game into "<archive folder>/<archive name>/". Extraction
 * goes to a temporary folder first, so a failed or cancelled extraction never
 * leaves a half-extracted game behind. The archive itself is kept.
 */
export async function extractGameArchive(archivePath: string): Promise<{ folder: string; files: number }> {
  const folder = extractedFolderFor(archivePath);
  if (existsSync(folder)) throw new Error(`${folder} already exists. Delete or rename it first.`);
  const tmp = `${folder}.omnipc-extracting`;
  await rm(tmp, { recursive: true, force: true });
  try {
    const r = await extractArchive(archivePath, tmp);
    await rename(tmp, folder);
    return { folder, files: r.files };
  } catch (e) {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
}

export function extractedFolderFor(archivePath: string): string {
  return join(dirname(archivePath), basename(archivePath, extname(archivePath)));
}

// ------------------------------------------------------------------ backups

/** Copies a file to "<name>.omnipc-<timestamp>.bak" next to it. */
export async function backupFile(path: string): Promise<string> {
  const backup = `${path}.omnipc-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  await copyFile(path, backup);
  return backup;
}

/** Restores files from backups made by backupFile (used by Undo). */
export async function restoreFiles(files: { path: string; backup: string }[]): Promise<string[]> {
  const done: string[] = [];
  for (const f of files) {
    if (!(await stat(f.backup).catch(() => null))) continue;
    await copyFile(f.backup, f.path);
    done.push(f.path);
  }
  return done;
}

/** Re-runs file validation for one game. Returns the number of files still not OK. */
export async function revalidateGame(library: LibraryRepo, gameId: number): Promise<number> {
  const g = library.getGame(gameId);
  if (!g) return 0;
  let bad = 0;
  for (const f of library.filesForGame(gameId)) {
    const st = await fileStat(f.path);
    const v = st ? await validateGameFile(f.path, g.system_id, st.size) : { state: 'invalid' as const, notes: ['File not found'] };
    library.setFileValidation(f.id, v.state, v.notes.join(' ') || null);
    if (v.state !== 'ok') bad++;
  }
  return bad;
}
