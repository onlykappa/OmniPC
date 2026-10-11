import type BetterSqlite3 from 'better-sqlite3';
import type { GameAvailability, GameFile, GameMetadata, GameSummary, LibraryPage, LibraryPath, LibraryQuery, ValidationState, DuplicateGroup, CompatibilityInfo } from '@shared/models';
import type { SystemId } from '@shared/systems';

export interface GameRow {
  id: number;
  system_id: SystemId;
  title: string;
  sort_title: string;
  region: string | null;
  serial: string | null;
  group_key: string;
  library_path_id: number | null;
  availability: GameAvailability;
  favorite: number;
  last_played_at: string | null;
  play_time_seconds: number;
  added_at: string;
  updated_at: string;
  validation: ValidationState;
  emulator_override: string | null;
  consecutive_failures: number;
  crash_loop_paused: number;
  cover_thumb: string | null;
  missing_since: string | null;
}

export interface GameFileRow {
  id: number;
  game_id: number;
  path: string;
  size_bytes: number;
  mtime_ms: number;
  disc_number: number | null;
  serial: string | null;
  validation: ValidationState;
  validation_note: string | null;
  last_seen_scan: string | null;
}

export interface MetadataRow {
  game_id: number;
  description: string | null;
  release_year: number | null;
  developer: string | null;
  publisher: string | null;
  genre: string | null;
  players: string | null;
  rating: string | null;
  cover_path: string | null;
  background_path: string | null;
  screenshots: string;
  source: string | null;
  source_id: string | null;
  locked: number;
  fetched_at: string | null;
  compat_rating: string | null;
  compat_source: string | null;
  compat_notes: string | null;
}

const now = () => new Date().toISOString();

export function sortTitle(title: string): string {
  return title.toLowerCase().replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9 ]/g, '').trim();
}

export class LibraryRepo {
  constructor(private readonly db: BetterSqlite3.Database) {}

  // ----- library paths -----
  listPaths(): LibraryPath[] {
    const rows = this.db.prepare(`
      SELECT lp.*, (SELECT COUNT(*) FROM games g WHERE g.library_path_id = lp.id) AS game_count
      FROM library_paths lp ORDER BY lp.path`).all() as any[];
    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      volumeSerial: r.volume_serial,
      driveLetter: r.drive_letter,
      available: !!r.available,
      lastScanAt: r.last_scan_at,
      gameCount: r.game_count,
    }));
  }

  getPath(id: number): LibraryPath | undefined {
    return this.listPaths().find((p) => p.id === id);
  }

  addPath(path: string, volumeSerial: string | null, driveLetter: string | null): LibraryPath {
    this.db.prepare('INSERT INTO library_paths(path, volume_serial, drive_letter, available, added_at) VALUES(?, ?, ?, 1, ?) ON CONFLICT(path) DO NOTHING').run(path, volumeSerial, driveLetter, now());
    return this.listPaths().find((p) => p.path === path)!;
  }

  updatePath(id: number, patch: { path?: string; available?: boolean; volumeSerial?: string | null; driveLetter?: string | null; lastScanAt?: string }): void {
    const cur = this.db.prepare('SELECT * FROM library_paths WHERE id = ?').get(id) as any;
    if (!cur) return;
    this.db.prepare('UPDATE library_paths SET path = ?, available = ?, volume_serial = ?, drive_letter = ?, last_scan_at = ? WHERE id = ?').run(
      patch.path ?? cur.path,
      patch.available === undefined ? cur.available : patch.available ? 1 : 0,
      patch.volumeSerial === undefined ? cur.volume_serial : patch.volumeSerial,
      patch.driveLetter === undefined ? cur.drive_letter : patch.driveLetter,
      patch.lastScanAt ?? cur.last_scan_at,
      id,
    );
  }

  /** Removing a library path removes OmniPC's records only, never files. */
  removePath(id: number): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM games WHERE library_path_id = ?').run(id);
      this.db.prepare('DELETE FROM library_paths WHERE id = ?').run(id);
    })();
  }

  /** Rewrites stored file paths when a drive letter changed (E:\ -> F:\). */
  remapPathPrefix(libraryPathId: number, oldPrefix: string, newPrefix: string): number {
    const files = this.db.prepare('SELECT gf.id, gf.path FROM game_files gf JOIN games g ON g.id = gf.game_id WHERE g.library_path_id = ?').all(libraryPathId) as { id: number; path: string }[];
    const upd = this.db.prepare('UPDATE game_files SET path = ? WHERE id = ?');
    let n = 0;
    this.db.transaction(() => {
      for (const f of files) {
        if (f.path.toLowerCase().startsWith(oldPrefix.toLowerCase())) {
          upd.run(newPrefix + f.path.slice(oldPrefix.length), f.id);
          n++;
        }
      }
    })();
    return n;
  }

  setAvailabilityForPath(libraryPathId: number, availability: GameAvailability): number {
    return this.db.prepare("UPDATE games SET availability = ?, updated_at = ? WHERE library_path_id = ? AND availability != 'missing'").run(availability, now(), libraryPathId).changes;
  }

  // ----- files -----
  filesForPath(libraryPathId: number): GameFileRow[] {
    return this.db.prepare('SELECT gf.* FROM game_files gf JOIN games g ON g.id = gf.game_id WHERE g.library_path_id = ?').all(libraryPathId) as GameFileRow[];
  }

  fileByPath(path: string): GameFileRow | undefined {
    return this.db.prepare('SELECT * FROM game_files WHERE path = ?').get(path) as GameFileRow | undefined;
  }

  filesForGame(gameId: number): GameFileRow[] {
    return this.db.prepare('SELECT * FROM game_files WHERE game_id = ? ORDER BY COALESCE(disc_number, 0), path').all(gameId) as GameFileRow[];
  }

  touchFiles(ids: number[], scanId: string): void {
    const stmt = this.db.prepare('UPDATE game_files SET last_seen_scan = ? WHERE id = ?');
    this.db.transaction(() => { for (const id of ids) stmt.run(scanId, id); })();
  }

  /**
   * Insert or update a game + file. Games are keyed by (system, group_key) so
   * multi-disc sets collapse into one entry.
   */
  upsertGameFile(input: {
    systemId: SystemId;
    title: string;
    region: string | null;
    serial: string | null;
    groupKey: string;
    libraryPathId: number;
    path: string;
    sizeBytes: number;
    mtimeMs: number;
    discNumber: number | null;
    validation: ValidationState;
    validationNote: string | null;
    scanId: string;
  }): { gameId: number; created: boolean; fileCreated: boolean } {
    return this.db.transaction(() => {
      const t = now();
      let game = this.db.prepare('SELECT id FROM games WHERE system_id = ? AND group_key = ?').get(input.systemId, input.groupKey) as { id: number } | undefined;
      let created = false;
      if (!game) {
        const r = this.db.prepare(`INSERT INTO games(system_id, title, sort_title, region, serial, group_key, library_path_id, availability, added_at, updated_at, validation)
          VALUES(?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, ?)`).run(input.systemId, input.title, sortTitle(input.title), input.region, input.serial, input.groupKey, input.libraryPathId, t, t, input.validation);
        game = { id: Number(r.lastInsertRowid) };
        created = true;
      } else {
        this.db.prepare("UPDATE games SET availability = 'available', missing_since = NULL, updated_at = ?, library_path_id = ?, serial = COALESCE(serial, ?), region = COALESCE(region, ?) WHERE id = ?").run(t, input.libraryPathId, input.serial, input.region, game.id);
      }
      const existing = this.fileByPath(input.path);
      let fileCreated = false;
      if (existing) {
        this.db.prepare('UPDATE game_files SET game_id = ?, size_bytes = ?, mtime_ms = ?, disc_number = ?, serial = ?, validation = ?, validation_note = ?, last_seen_scan = ? WHERE id = ?').run(
          game.id, input.sizeBytes, input.mtimeMs, input.discNumber, input.serial, input.validation, input.validationNote, input.scanId, existing.id);
        if (existing.game_id !== game.id) this.deleteGameIfEmpty(existing.game_id);
      } else {
        this.db.prepare('INSERT INTO game_files(game_id, path, size_bytes, mtime_ms, disc_number, serial, validation, validation_note, last_seen_scan) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
          game.id, input.path, input.sizeBytes, input.mtimeMs, input.discNumber, input.serial, input.validation, input.validationNote, input.scanId);
        fileCreated = true;
      }
      this.recomputeGameValidation(game.id);
      return { gameId: game.id, created, fileCreated };
    })();
  }

  recomputeGameValidation(gameId: number): void {
    const states = (this.db.prepare('SELECT validation FROM game_files WHERE game_id = ?').all(gameId) as { validation: ValidationState }[]).map((r) => r.validation);
    const v: ValidationState = states.includes('invalid') ? 'invalid' : states.includes('warning') ? 'warning' : states.every((s) => s === 'ok') && states.length ? 'ok' : 'unchecked';
    this.db.prepare('UPDATE games SET validation = ? WHERE id = ?').run(v, gameId);
  }

  setFileValidation(fileId: number, validation: ValidationState, note: string | null): void {
    const r = this.db.prepare('SELECT game_id FROM game_files WHERE id = ?').get(fileId) as { game_id: number } | undefined;
    this.db.prepare('UPDATE game_files SET validation = ?, validation_note = ? WHERE id = ?').run(validation, note, fileId);
    if (r) this.recomputeGameValidation(r.game_id);
  }

  /** Files under an available library path that were not seen in this scan are gone. */
  removeUnseenFiles(libraryPathId: number, scanId: string): number {
    const gone = this.db.prepare('SELECT gf.id, gf.game_id FROM game_files gf JOIN games g ON g.id = gf.game_id WHERE g.library_path_id = ? AND (gf.last_seen_scan IS NULL OR gf.last_seen_scan != ?)').all(libraryPathId, scanId) as { id: number; game_id: number }[];
    const del = this.db.prepare('DELETE FROM game_files WHERE id = ?');
    let removedGames = 0;
    this.db.transaction(() => {
      for (const f of gone) del.run(f.id);
      for (const gid of new Set(gone.map((g) => g.game_id))) if (this.deleteGameIfEmpty(gid)) removedGames++;
    })();
    return removedGames;
  }

  private deleteGameIfEmpty(gameId: number): boolean {
    const c = this.db.prepare('SELECT COUNT(*) AS c FROM game_files WHERE game_id = ?').get(gameId) as { c: number };
    if (c.c === 0) {
      this.db.prepare('DELETE FROM games WHERE id = ?').run(gameId);
      return true;
    }
    return false;
  }

  // ----- games -----
  query(q: LibraryQuery): LibraryPage {
    const where: string[] = [];
    const params: unknown[] = [];
    if (!q.includeUnavailable) where.push("g.availability != 'missing'");
    if (q.systemId) {
      where.push('g.system_id = ?');
      params.push(q.systemId);
    }
    if (q.favoritesOnly) where.push('g.favorite = 1');
    if (q.search && q.search.trim()) {
      where.push('(g.title LIKE ? OR g.serial LIKE ?)');
      const s = `%${q.search.trim().replace(/[%_]/g, (m) => '\\' + m)}%`;
      params.push(s, s);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}`.replace(/LIKE \?/g, "LIKE ? ESCAPE '\\'") : '';
    const order = {
      title: 'g.sort_title COLLATE NOCASE ASC',
      recent: 'g.last_played_at IS NULL, g.last_played_at DESC',
      added: 'g.added_at DESC, g.id DESC',
      playtime: 'g.play_time_seconds DESC',
    }[q.sort ?? 'title'];
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM games g ${whereSql}`).get(...params) as { c: number }).c;
    const limit = Math.min(Math.max(q.limit ?? 200, 1), 2000);
    const offset = Math.max(q.offset ?? 0, 0);
    const rows = this.db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM game_files f WHERE f.game_id = g.id) AS disc_count FROM games g ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset) as (GameRow & { disc_count: number })[];
    return { total, items: rows.map(toSummary) };
  }

  getGame(id: number): GameRow | undefined {
    return this.db.prepare('SELECT * FROM games WHERE id = ?').get(id) as GameRow | undefined;
  }

  summary(id: number): GameSummary | undefined {
    const r = this.db.prepare('SELECT g.*, (SELECT COUNT(*) FROM game_files f WHERE f.game_id = g.id) AS disc_count FROM games g WHERE g.id = ?').get(id) as (GameRow & { disc_count: number }) | undefined;
    return r ? toSummary(r) : undefined;
  }

  allGames(): GameRow[] {
    return this.db.prepare('SELECT * FROM games').all() as GameRow[];
  }

  countGames(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM games WHERE availability != 'missing'").get() as { c: number }).c;
  }

  countBySystem(): Record<string, number> {
    const rows = this.db.prepare("SELECT system_id, COUNT(*) AS c FROM games WHERE availability != 'missing' GROUP BY system_id").all() as { system_id: string; c: number }[];
    return Object.fromEntries(rows.map((r) => [r.system_id, r.c]));
  }

  setFavorite(id: number, fav: boolean): void {
    this.db.prepare('UPDATE games SET favorite = ? WHERE id = ?').run(fav ? 1 : 0, id);
  }

  setTitle(id: number, title: string): void {
    this.db.prepare('UPDATE games SET title = ?, sort_title = ?, updated_at = ? WHERE id = ?').run(title, sortTitle(title), now(), id);
  }

  setCoverThumb(id: number, thumb: string | null): void {
    this.db.prepare('UPDATE games SET cover_thumb = ? WHERE id = ?').run(thumb, id);
  }

  setEmulatorOverride(id: number, emulatorId: string | null): void {
    this.db.prepare('UPDATE games SET emulator_override = ? WHERE id = ?').run(emulatorId, id);
  }

  recordPlay(id: number, startedAt: string, seconds: number): void {
    this.db.prepare('UPDATE games SET last_played_at = ?, play_time_seconds = play_time_seconds + ? WHERE id = ?').run(startedAt, Math.max(0, Math.round(seconds)), id);
  }

  setFailureState(id: number, consecutiveFailures: number, paused: boolean): void {
    this.db.prepare('UPDATE games SET consecutive_failures = ?, crash_loop_paused = ? WHERE id = ?').run(consecutiveFailures, paused ? 1 : 0, id);
  }

  duplicates(): DuplicateGroup[] {
    const groups: DuplicateGroup[] = [];
    const bySerial = this.db.prepare(`SELECT g.id, g.title, g.system_id, f.serial, f.path, f.size_bytes FROM game_files f JOIN games g ON g.id = f.game_id
      WHERE f.serial IS NOT NULL AND f.serial IN (SELECT serial FROM game_files WHERE serial IS NOT NULL GROUP BY serial HAVING COUNT(*) > 1) ORDER BY f.serial`).all() as any[];
    const map = new Map<string, DuplicateGroup>();
    for (const r of bySerial) {
      const key = `serial:${r.system_id}:${r.serial}`;
      let g = map.get(key);
      if (!g) map.set(key, (g = { key, reason: 'same_serial', games: [] }));
      g.games.push({ id: r.id, title: r.title, path: r.path, sizeBytes: r.size_bytes });
    }
    // Multi-disc sets legitimately share nothing; but identical serial on two files means a real duplicate
    for (const g of map.values()) if (g.games.length > 1) groups.push(g);
    const byTitle = this.db.prepare(`SELECT g.id, g.title, g.system_id, g.sort_title, MIN(f.path) AS path, SUM(f.size_bytes) AS size_bytes FROM games g JOIN game_files f ON f.game_id = g.id
      WHERE (g.system_id || '|' || g.sort_title || '|' || COALESCE(g.region,'')) IN (SELECT system_id || '|' || sort_title || '|' || COALESCE(region,'') FROM games GROUP BY system_id, sort_title, region HAVING COUNT(*) > 1)
      GROUP BY g.id ORDER BY g.sort_title`).all() as any[];
    const tmap = new Map<string, DuplicateGroup>();
    for (const r of byTitle) {
      const key = `title:${r.system_id}:${r.sort_title}`;
      let g = tmap.get(key);
      if (!g) tmap.set(key, (g = { key, reason: 'same_title', games: [] }));
      g.games.push({ id: r.id, title: r.title, path: r.path, sizeBytes: r.size_bytes });
    }
    for (const g of tmap.values()) if (g.games.length > 1 && !groups.some((x) => x.games.some((y) => g.games.some((z) => z.id === y.id)))) groups.push(g);
    return groups;
  }

  // ----- metadata -----
  getMetadata(gameId: number): GameMetadata {
    const r = this.db.prepare('SELECT * FROM metadata WHERE game_id = ?').get(gameId) as MetadataRow | undefined;
    return {
      description: r?.description ?? null,
      releaseYear: r?.release_year ?? null,
      developer: r?.developer ?? null,
      publisher: r?.publisher ?? null,
      genre: r?.genre ?? null,
      players: r?.players ?? null,
      rating: r?.rating ?? null,
      coverPath: r?.cover_path ?? null,
      backgroundPath: r?.background_path ?? null,
      screenshots: r ? safeArray(r.screenshots) : [],
      source: r?.source ?? null,
      sourceId: r?.source_id ?? null,
      locked: !!r?.locked,
      fetchedAt: r?.fetched_at ?? null,
    };
  }

  getCompatibility(gameId: number): CompatibilityInfo | null {
    const r = this.db.prepare('SELECT compat_rating, compat_source, compat_notes FROM metadata WHERE game_id = ?').get(gameId) as Pick<MetadataRow, 'compat_rating' | 'compat_source' | 'compat_notes'> | undefined;
    if (!r?.compat_rating || !r.compat_source) return null;
    return JSON.parse(r.compat_rating) as CompatibilityInfo;
  }

  setCompatibility(gameId: number, info: CompatibilityInfo | null): void {
    this.ensureMetadataRow(gameId);
    this.db.prepare('UPDATE metadata SET compat_rating = ?, compat_source = ?, compat_notes = ? WHERE game_id = ?').run(info ? JSON.stringify(info) : null, info?.source ?? null, info?.notes ?? null, gameId);
  }

  private ensureMetadataRow(gameId: number): void {
    this.db.prepare('INSERT INTO metadata(game_id) VALUES(?) ON CONFLICT(game_id) DO NOTHING').run(gameId);
  }

  saveMetadata(gameId: number, m: Partial<GameMetadata>): GameMetadata {
    this.ensureMetadataRow(gameId);
    const cur = this.getMetadata(gameId);
    const next = { ...cur, ...m };
    this.db.prepare(`UPDATE metadata SET description = ?, release_year = ?, developer = ?, publisher = ?, genre = ?, players = ?, rating = ?, cover_path = ?, background_path = ?, screenshots = ?, source = ?, source_id = ?, locked = ?, fetched_at = ? WHERE game_id = ?`).run(
      next.description, next.releaseYear, next.developer, next.publisher, next.genre, next.players, next.rating, next.coverPath, next.backgroundPath, JSON.stringify(next.screenshots ?? []), next.source, next.sourceId, next.locked ? 1 : 0, next.fetchedAt, gameId);
    return this.getMetadata(gameId);
  }

  clearMetadata(gameId: number): void {
    this.db.prepare('DELETE FROM metadata WHERE game_id = ?').run(gameId);
    this.setCoverThumb(gameId, null);
  }

  gamesForSystems(systems: string[]): GameRow[] {
    if (!systems.length) return [];
    return this.db.prepare(`SELECT g.* FROM games g LEFT JOIN metadata m ON m.game_id = g.id WHERE g.availability != 'missing' AND COALESCE(m.locked, 0) = 0 AND g.system_id IN (${systems.map(() => '?').join(',')})`).all(...systems) as GameRow[];
  }

  /** Games with no cover yet whose metadata was not edited by the user (re-fetch when new providers arrive). */
  gamesWithoutCover(limit = 20000): GameRow[] {
    return this.db.prepare("SELECT g.* FROM games g LEFT JOIN metadata m ON m.game_id = g.id WHERE g.availability != 'missing' AND (m.game_id IS NULL OR (m.cover_path IS NULL AND m.locked = 0)) LIMIT ?").all(limit) as GameRow[];
  }

  gamesNeedingMetadata(limit = 500): GameRow[] {
    return this.db.prepare("SELECT g.* FROM games g LEFT JOIN metadata m ON m.game_id = g.id WHERE g.availability != 'missing' AND (m.game_id IS NULL OR (m.fetched_at IS NULL AND m.locked = 0)) LIMIT ?").all(limit) as GameRow[];
  }
}

function safeArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function toSummary(r: GameRow & { disc_count?: number }): GameSummary {
  return {
    id: r.id,
    title: r.title,
    systemId: r.system_id,
    region: r.region,
    serial: r.serial,
    discCount: r.disc_count ?? 1,
    availability: r.availability,
    favorite: !!r.favorite,
    lastPlayedAt: r.last_played_at,
    playTimeSeconds: r.play_time_seconds,
    addedAt: r.added_at,
    coverThumb: r.cover_thumb,
    validation: r.validation,
  };
}

export function fileRowToDto(f: GameFileRow): GameFile {
  return { path: f.path, sizeBytes: f.size_bytes, discNumber: f.disc_number, validation: f.validation, validationNote: f.validation_note };
}
