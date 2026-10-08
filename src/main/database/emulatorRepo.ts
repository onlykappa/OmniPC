import type BetterSqlite3 from 'better-sqlite3';
import type { CustomEmulatorSettings, EmulatorInstallState, EmulatorSettings, HealthState } from '@shared/models';

export interface EmulatorRow {
  id: string;
  install_state: EmulatorInstallState;
  version: string | null;
  install_dir: string | null;
  executable: string | null;
  installed_at: string | null;
  updated_at: string | null;
  custom_executable: string | null;
  custom_args: string | null;
  custom_config_active: number;
  custom_note: string | null;
  health: HealthState;
  health_note: string | null;
  last_health_at: string | null;
  latest_version: string | null;
  latest_checked_at: string | null;
  settings: string | null;
}

export interface EmulatorVersionRow {
  id: number;
  emulator_id: string;
  version: string;
  installed_at: string;
  source_url: string | null;
  sha256: string | null;
  status: 'active' | 'rollback' | 'removed' | 'failed';
  path: string | null;
}

const now = () => new Date().toISOString();

export class EmulatorRepo {
  constructor(private readonly db: BetterSqlite3.Database) {}

  get(id: string): EmulatorRow {
    const row = this.db.prepare('SELECT * FROM emulators WHERE id = ?').get(id) as EmulatorRow | undefined;
    if (row) return row;
    this.db.prepare('INSERT INTO emulators(id) VALUES(?) ON CONFLICT(id) DO NOTHING').run(id);
    return this.db.prepare('SELECT * FROM emulators WHERE id = ?').get(id) as EmulatorRow;
  }

  all(): EmulatorRow[] {
    return this.db.prepare('SELECT * FROM emulators').all() as EmulatorRow[];
  }

  setInstalled(id: string, p: { state: EmulatorInstallState; version: string | null; installDir: string | null; executable: string | null }): void {
    this.get(id);
    this.db.prepare('UPDATE emulators SET install_state = ?, version = ?, install_dir = ?, executable = ?, installed_at = COALESCE(installed_at, ?), updated_at = ? WHERE id = ?').run(p.state, p.version, p.installDir, p.executable, now(), now(), id);
  }

  setUninstalled(id: string): void {
    this.get(id);
    this.db.prepare("UPDATE emulators SET install_state = 'not_installed', version = NULL, install_dir = NULL, executable = NULL, installed_at = NULL, updated_at = ?, health = 'not_installed', health_note = NULL WHERE id = ?").run(now(), id);
  }

  setHealth(id: string, health: HealthState, note: string | null): void {
    this.get(id);
    this.db.prepare('UPDATE emulators SET health = ?, health_note = ?, last_health_at = ? WHERE id = ?').run(health, note, now(), id);
  }

  setLatest(id: string, version: string | null): void {
    this.get(id);
    this.db.prepare('UPDATE emulators SET latest_version = ?, latest_checked_at = ? WHERE id = ?').run(version, now(), id);
  }

  getSettings(id: string): EmulatorSettings | null {
    const r = this.get(id);
    if (!r.settings) return null;
    try { return JSON.parse(r.settings) as EmulatorSettings; } catch { return null; }
  }

  saveSettings(id: string, s: EmulatorSettings): void {
    this.get(id);
    this.db.prepare('UPDATE emulators SET settings = ? WHERE id = ?').run(JSON.stringify(s), id);
  }

  getCustom(id: string): CustomEmulatorSettings {
    const r = this.get(id);
    return { customExecutable: r.custom_executable, customArgs: r.custom_args, customConfigNote: r.custom_note, customConfigActive: !!r.custom_config_active };
  }

  saveCustom(id: string, c: CustomEmulatorSettings): void {
    this.get(id);
    this.db.prepare('UPDATE emulators SET custom_executable = ?, custom_args = ?, custom_note = ?, custom_config_active = ? WHERE id = ?').run(c.customExecutable || null, c.customArgs || null, c.customConfigNote || null, c.customConfigActive ? 1 : 0, id);
  }

  // ----- versions -----
  addVersion(v: Omit<EmulatorVersionRow, 'id'>): number {
    return Number(this.db.prepare('INSERT INTO emulator_versions(emulator_id, version, installed_at, source_url, sha256, status, path) VALUES(?, ?, ?, ?, ?, ?, ?)').run(v.emulator_id, v.version, v.installed_at, v.source_url, v.sha256, v.status, v.path).lastInsertRowid);
  }

  versions(id: string): EmulatorVersionRow[] {
    return this.db.prepare('SELECT * FROM emulator_versions WHERE emulator_id = ? ORDER BY installed_at DESC, id DESC').all(id) as EmulatorVersionRow[];
  }

  setVersionStatus(versionId: number, status: EmulatorVersionRow['status'], path?: string | null): void {
    if (path === undefined) this.db.prepare('UPDATE emulator_versions SET status = ? WHERE id = ?').run(status, versionId);
    else this.db.prepare('UPDATE emulator_versions SET status = ?, path = ? WHERE id = ?').run(status, path, versionId);
  }

  activeVersion(id: string): EmulatorVersionRow | undefined {
    return this.db.prepare("SELECT * FROM emulator_versions WHERE emulator_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(id) as EmulatorVersionRow | undefined;
  }

  rollbackCandidate(id: string): EmulatorVersionRow | undefined {
    return this.db.prepare("SELECT * FROM emulator_versions WHERE emulator_id = ? AND status = 'rollback' ORDER BY id DESC LIMIT 1").get(id) as EmulatorVersionRow | undefined;
  }
}
