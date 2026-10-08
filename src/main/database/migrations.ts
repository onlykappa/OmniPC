// Ordered schema migrations. Each migration runs once inside a transaction and
// bumps PRAGMA user_version. Never edit a shipped migration; add a new one.

import type BetterSqlite3 from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  up(db: BetterSqlite3.Database): void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    up(db) {
      db.exec(`
        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE systems (
          id TEXT PRIMARY KEY,
          preferred_emulator TEXT,
          hidden INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE library_paths (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          path TEXT NOT NULL UNIQUE,
          volume_serial TEXT,
          drive_letter TEXT,
          available INTEGER NOT NULL DEFAULT 1,
          last_scan_at TEXT,
          added_at TEXT NOT NULL
        );

        CREATE TABLE games (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          system_id TEXT NOT NULL,
          title TEXT NOT NULL,
          sort_title TEXT NOT NULL,
          region TEXT,
          serial TEXT,
          group_key TEXT NOT NULL,
          library_path_id INTEGER REFERENCES library_paths(id) ON DELETE SET NULL,
          availability TEXT NOT NULL DEFAULT 'available',
          favorite INTEGER NOT NULL DEFAULT 0,
          last_played_at TEXT,
          play_time_seconds INTEGER NOT NULL DEFAULT 0,
          added_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          validation TEXT NOT NULL DEFAULT 'unchecked',
          emulator_override TEXT,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          crash_loop_paused INTEGER NOT NULL DEFAULT 0,
          cover_thumb TEXT,
          missing_since TEXT,
          UNIQUE(system_id, group_key)
        );
        CREATE INDEX idx_games_system ON games(system_id);
        CREATE INDEX idx_games_sort_title ON games(sort_title COLLATE NOCASE);
        CREATE INDEX idx_games_last_played ON games(last_played_at);
        CREATE INDEX idx_games_added ON games(added_at);
        CREATE INDEX idx_games_serial ON games(serial);
        CREATE INDEX idx_games_favorite ON games(favorite) WHERE favorite = 1;

        CREATE TABLE game_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
          path TEXT NOT NULL UNIQUE,
          size_bytes INTEGER NOT NULL,
          mtime_ms INTEGER NOT NULL,
          disc_number INTEGER,
          serial TEXT,
          validation TEXT NOT NULL DEFAULT 'unchecked',
          validation_note TEXT,
          last_seen_scan TEXT
        );
        CREATE INDEX idx_game_files_game ON game_files(game_id);

        CREATE TABLE metadata (
          game_id INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
          description TEXT,
          release_year INTEGER,
          developer TEXT,
          publisher TEXT,
          genre TEXT,
          players TEXT,
          rating TEXT,
          cover_path TEXT,
          background_path TEXT,
          screenshots TEXT NOT NULL DEFAULT '[]',
          source TEXT,
          source_id TEXT,
          locked INTEGER NOT NULL DEFAULT 0,
          fetched_at TEXT,
          compat_rating TEXT,
          compat_source TEXT,
          compat_notes TEXT
        );

        CREATE TABLE emulators (
          id TEXT PRIMARY KEY,
          install_state TEXT NOT NULL DEFAULT 'not_installed',
          version TEXT,
          install_dir TEXT,
          executable TEXT,
          installed_at TEXT,
          updated_at TEXT,
          custom_executable TEXT,
          custom_args TEXT,
          custom_config_active INTEGER NOT NULL DEFAULT 0,
          custom_note TEXT,
          health TEXT NOT NULL DEFAULT 'unknown',
          health_note TEXT,
          last_health_at TEXT,
          latest_version TEXT,
          latest_checked_at TEXT,
          settings TEXT
        );

        CREATE TABLE emulator_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          emulator_id TEXT NOT NULL,
          version TEXT NOT NULL,
          installed_at TEXT NOT NULL,
          source_url TEXT,
          sha256 TEXT,
          status TEXT NOT NULL,
          path TEXT
        );
        CREATE INDEX idx_emulator_versions_emu ON emulator_versions(emulator_id, installed_at);

        CREATE TABLE controllers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          key TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          api TEXT NOT NULL,
          connection TEXT NOT NULL,
          first_seen TEXT NOT NULL,
          last_seen TEXT NOT NULL
        );

        CREATE TABLE profiles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          data TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE game_profiles (
          game_id INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
          emulator_id TEXT,
          overrides TEXT NOT NULL,
          custom_args TEXT,
          notes TEXT,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE launch_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          game_id INTEGER REFERENCES games(id) ON DELETE SET NULL,
          emulator_id TEXT NOT NULL,
          emulator_version TEXT,
          command TEXT NOT NULL,
          args TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          duration_ms INTEGER,
          pid INTEGER,
          exit_code INTEGER,
          signal TEXT,
          outcome TEXT NOT NULL,
          stderr_tail TEXT,
          log_path TEXT,
          log_offset INTEGER
        );
        CREATE INDEX idx_launch_game ON launch_history(game_id, started_at);
        CREATE INDEX idx_launch_emu ON launch_history(emulator_id, started_at);

        CREATE TABLE diagnostics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_at TEXT NOT NULL,
          duration_ms INTEGER NOT NULL,
          scope TEXT NOT NULL,
          overall INTEGER NOT NULL,
          report TEXT NOT NULL
        );
        CREATE INDEX idx_diagnostics_run ON diagnostics(run_at);

        CREATE TABLE repairs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          action_id TEXT NOT NULL,
          label TEXT NOT NULL,
          safety TEXT NOT NULL,
          subject TEXT,
          started_at TEXT NOT NULL,
          status TEXT NOT NULL,
          message TEXT NOT NULL,
          details TEXT NOT NULL DEFAULT '[]',
          backup_ids TEXT NOT NULL DEFAULT '[]',
          undo TEXT,
          automatic INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_repairs_started ON repairs(started_at);

        CREATE TABLE configuration_backups (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          emulator_id TEXT,
          label TEXT NOT NULL,
          reason TEXT NOT NULL,
          created_at TEXT NOT NULL,
          path TEXT NOT NULL,
          files TEXT NOT NULL,
          size_bytes INTEGER NOT NULL
        );
        CREATE INDEX idx_backups_emu ON configuration_backups(emulator_id, created_at);

        CREATE TABLE change_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          kind TEXT NOT NULL,
          subject TEXT,
          summary TEXT NOT NULL,
          data TEXT
        );
        CREATE INDEX idx_change_log_at ON change_log(at);
        CREATE INDEX idx_change_log_subject ON change_log(subject, at);

        CREATE TABLE notifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          level TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          read INTEGER NOT NULL DEFAULT 0,
          link TEXT
        );
      `);
    },
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export function migrate(db: BetterSqlite3.Database, migrations: Migration[] = MIGRATIONS): { from: number; to: number; applied: string[] } {
  const from = db.pragma('user_version', { simple: true }) as number;
  const applied: string[] = [];
  const latest = migrations[migrations.length - 1]?.version ?? 0;
  if (from > latest) {
    throw new Error(`Database schema version ${from} is newer than this OmniDeck build supports (${latest}). Update OmniDeck or restore an older database backup.`);
  }
  for (const m of migrations) {
    if (m.version <= from) continue;
    db.transaction(() => {
      m.up(db);
      db.pragma(`user_version = ${m.version}`);
    })();
    applied.push(`${m.version}: ${m.name}`);
  }
  return { from, to: db.pragma('user_version', { simple: true }) as number, applied };
}
