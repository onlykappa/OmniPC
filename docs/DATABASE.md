# Database

SQLite (`better-sqlite3`), WAL mode, foreign keys on. File: `%USERPROFILE%\OmniPC\Data\omnideck.db`.

## Tables

| Table | Contents |
|---|---|
| `settings` | User settings (JSON values) and internal values (`internal:*`, e.g. the hardware profile) |
| `systems` | Per-system preferences |
| `library_paths` | Game folders with volume serial and drive letter (for drive-letter remapping) |
| `games` | One row per game (multi-disc sets collapse via `group_key`); availability, favourites, play time, crash-loop state |
| `game_files` | Files of a game, size + mtime (incremental scanning), disc number, serial, validation |
| `metadata` | Cached metadata, artwork paths, compatibility, `locked` for user edits |
| `emulators` | Install state, version, paths, health, settings JSON, custom settings |
| `emulator_versions` | Installed versions incl. rollback copies and SHA-256 of the download |
| `controllers` | Controllers seen |
| `profiles` | Universal controller profile |
| `game_profiles` | Per-game overrides |
| `launch_history` | Every launch: command, args, pid, exit code, duration, outcome, stderr tail, log path + offset |
| `diagnostics` | Health reports (last 200) |
| `repairs` | Repair history with undo information |
| `configuration_backups` | Config backup index (files live in `Backups\configs`) |
| `change_log` | Significant changes, used for correlation |
| `notifications` | Notification center |

Indexes cover the library's sort/search columns, launch history per game/emulator and the
change log by time and subject.

## Migrations

`src/main/database/migrations.ts` holds an ordered list; each migration runs once in a
transaction and bumps `PRAGMA user_version`. Never edit a shipped migration — add a new one.
A database newer than the app refuses to open rather than being damaged.

## Backups & recovery

- A backup (SQLite online backup API) is made at startup if the newest is older than 24 h,
  then daily; 7 are kept in `Backups\database`.
- On startup `PRAGMA quick_check` runs. If it fails, the damaged file is quarantined
  (`omnideck.db.corrupt-<timestamp>`), the newest healthy backup is restored, and the user is
  notified. With no healthy backup a fresh database is created and the library is rescanned.
- Game files are never touched by any database operation.
