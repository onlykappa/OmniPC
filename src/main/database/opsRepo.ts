// Operational records: diagnostics reports, repairs, config backups, change log,
// notifications, controller/profile data.

import type BetterSqlite3 from 'better-sqlite3';
import type { AppNotification, ChangeEvent, ConfigBackup, DetectedController, GameProfile, HealthReport, RepairRecord, RepairSafety, UniversalControllerProfile } from '@shared/models';

const now = () => new Date().toISOString();
const parse = <T>(s: string | null, fallback: T): T => {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};

export interface RepairUndo {
  kind: 'restore-backups' | 'restore-settings' | 'restore-files' | 'none';
  backupIds?: number[];
  /** restore-files: copies made by OmniDoctor > Games before rewriting a CUE/M3U. */
  files?: { path: string; backup: string }[];
  settings?: Record<string, unknown>;
  emulatorId?: string;
}

export class OpsRepo {
  constructor(private readonly db: BetterSqlite3.Database) {}

  // ----- diagnostics -----
  saveReport(r: Omit<HealthReport, 'id'>): HealthReport {
    const id = Number(this.db.prepare('INSERT INTO diagnostics(run_at, duration_ms, scope, overall, report) VALUES(?, ?, ?, ?, ?)').run(r.runAt, r.durationMs, r.scope, r.overall, JSON.stringify(r)).lastInsertRowid);
    // keep last 200 reports
    this.db.prepare('DELETE FROM diagnostics WHERE id NOT IN (SELECT id FROM diagnostics ORDER BY id DESC LIMIT 200)').run();
    return { ...r, id };
  }

  latestReport(scope?: HealthReport['scope']): HealthReport | null {
    const row = (scope
      ? this.db.prepare('SELECT id, report FROM diagnostics WHERE scope = ? ORDER BY id DESC LIMIT 1').get(scope)
      : this.db.prepare("SELECT id, report FROM diagnostics WHERE scope IN ('full','quick') ORDER BY id DESC LIMIT 1").get()) as { id: number; report: string } | undefined;
    if (!row) return null;
    const r = parse<HealthReport | null>(row.report, null);
    return r ? { ...r, id: row.id } : null;
  }

  // ----- repairs -----
  addRepair(r: { actionId: string; label: string; safety: RepairSafety; subject: string | null; status: RepairRecord['status']; message: string; details: string[]; backupIds: number[]; undo: RepairUndo | null; automatic: boolean }): RepairRecord {
    const id = Number(this.db.prepare('INSERT INTO repairs(action_id, label, safety, subject, started_at, status, message, details, backup_ids, undo, automatic) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      r.actionId, r.label, r.safety, r.subject, now(), r.status, r.message, JSON.stringify(r.details), JSON.stringify(r.backupIds), r.undo ? JSON.stringify(r.undo) : null, r.automatic ? 1 : 0).lastInsertRowid);
    return this.getRepair(id)!;
  }

  getRepair(id: number): RepairRecord | undefined {
    const r = this.db.prepare('SELECT * FROM repairs WHERE id = ?').get(id) as any;
    return r ? this.toRepair(r) : undefined;
  }

  getRepairUndo(id: number): RepairUndo | null {
    const r = this.db.prepare('SELECT undo FROM repairs WHERE id = ?').get(id) as { undo: string | null } | undefined;
    return parse<RepairUndo | null>(r?.undo ?? null, null);
  }

  setRepairStatus(id: number, status: RepairRecord['status']): void {
    this.db.prepare('UPDATE repairs SET status = ? WHERE id = ?').run(status, id);
  }

  repairs(limit: number): RepairRecord[] {
    return (this.db.prepare('SELECT * FROM repairs ORDER BY id DESC LIMIT ?').all(Math.min(limit, 1000)) as any[]).map((r) => this.toRepair(r));
  }

  private toRepair(r: any): RepairRecord {
    const undo = parse<RepairUndo | null>(r.undo, null);
    return {
      id: r.id,
      actionId: r.action_id,
      label: r.label,
      safety: r.safety,
      subject: r.subject,
      startedAt: r.started_at,
      status: r.status,
      message: r.message,
      details: parse<string[]>(r.details, []),
      backupIds: parse<number[]>(r.backup_ids, []),
      undoable: r.status === 'succeeded' && !!undo && undo.kind !== 'none',
      automatic: !!r.automatic,
    };
  }

  // ----- config backups -----
  addBackup(b: Omit<ConfigBackup, 'id' | 'createdAt'>): ConfigBackup {
    const id = Number(this.db.prepare('INSERT INTO configuration_backups(emulator_id, label, reason, created_at, path, files, size_bytes) VALUES(?, ?, ?, ?, ?, ?, ?)').run(b.emulatorId, b.label, b.reason, now(), b.path, JSON.stringify(b.files), b.sizeBytes).lastInsertRowid);
    return this.getBackup(id)!;
  }

  getBackup(id: number): ConfigBackup | undefined {
    const r = this.db.prepare('SELECT * FROM configuration_backups WHERE id = ?').get(id) as any;
    return r ? this.toBackup(r) : undefined;
  }

  backups(emulatorId: string | null): ConfigBackup[] {
    const rows = (emulatorId === null
      ? this.db.prepare('SELECT * FROM configuration_backups ORDER BY id DESC LIMIT 500').all()
      : this.db.prepare('SELECT * FROM configuration_backups WHERE emulator_id = ? ORDER BY id DESC').all(emulatorId)) as any[];
    return rows.map((r) => this.toBackup(r));
  }

  deleteBackup(id: number): void {
    this.db.prepare('DELETE FROM configuration_backups WHERE id = ?').run(id);
  }

  private toBackup(r: any): ConfigBackup {
    return { id: r.id, emulatorId: r.emulator_id, label: r.label, reason: r.reason, createdAt: r.created_at, path: r.path, files: parse<string[]>(r.files, []), sizeBytes: r.size_bytes };
  }

  // ----- change log -----
  addChange(kind: string, subject: string | null, summary: string, data?: unknown): ChangeEvent {
    const at = now();
    const id = Number(this.db.prepare('INSERT INTO change_log(at, kind, subject, summary, data) VALUES(?, ?, ?, ?, ?)').run(at, kind, subject, summary, data === undefined ? null : JSON.stringify(data)).lastInsertRowid);
    return { id, at, kind, subject, summary };
  }

  changes(limit: number, subject?: string): ChangeEvent[] {
    const rows = (subject
      ? this.db.prepare('SELECT id, at, kind, subject, summary FROM change_log WHERE subject = ? ORDER BY id DESC LIMIT ?').all(subject, limit)
      : this.db.prepare('SELECT id, at, kind, subject, summary FROM change_log ORDER BY id DESC LIMIT ?').all(limit)) as ChangeEvent[];
    return rows;
  }

  changesBetween(fromIso: string, toIso: string, subject?: string): ChangeEvent[] {
    return (subject
      ? this.db.prepare('SELECT id, at, kind, subject, summary FROM change_log WHERE at >= ? AND at <= ? AND (subject = ? OR subject IS NULL) ORDER BY id DESC').all(fromIso, toIso, subject)
      : this.db.prepare('SELECT id, at, kind, subject, summary FROM change_log WHERE at >= ? AND at <= ? ORDER BY id DESC').all(fromIso, toIso)) as ChangeEvent[];
  }

  // ----- notifications -----
  addNotification(n: Omit<AppNotification, 'id' | 'at' | 'read'>): AppNotification {
    const at = now();
    const id = Number(this.db.prepare('INSERT INTO notifications(at, level, title, body, read, link) VALUES(?, ?, ?, ?, 0, ?)').run(at, n.level, n.title, n.body, n.link).lastInsertRowid);
    this.db.prepare('DELETE FROM notifications WHERE id NOT IN (SELECT id FROM notifications ORDER BY id DESC LIMIT 300)').run();
    return { id, at, read: false, ...n };
  }

  notifications(): AppNotification[] {
    return (this.db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT 100').all() as any[]).map((r) => ({ id: r.id, at: r.at, level: r.level, title: r.title, body: r.body, read: !!r.read, link: r.link }));
  }

  markRead(ids: number[] | 'all'): void {
    if (ids === 'all') this.db.prepare('UPDATE notifications SET read = 1').run();
    else {
      const stmt = this.db.prepare('UPDATE notifications SET read = 1 WHERE id = ?');
      this.db.transaction(() => { for (const id of ids) stmt.run(id); })();
    }
  }

  recentNotificationExists(title: string, withinMs: number): boolean {
    const since = new Date(Date.now() - withinMs).toISOString();
    return !!this.db.prepare('SELECT 1 FROM notifications WHERE title = ? AND at >= ? LIMIT 1').get(title, since);
  }

  // ----- controllers -----
  upsertController(c: DetectedController): { isNew: boolean } {
    const existing = this.db.prepare('SELECT id FROM controllers WHERE key = ?').get(c.key);
    if (existing) {
      this.db.prepare('UPDATE controllers SET name = ?, kind = ?, api = ?, connection = ?, last_seen = ? WHERE key = ?').run(c.name, c.kind, c.api, c.connection, now(), c.key);
      return { isNew: false };
    }
    this.db.prepare('INSERT INTO controllers(key, name, kind, api, connection, first_seen, last_seen) VALUES(?, ?, ?, ?, ?, ?, ?)').run(c.key, c.name, c.kind, c.api, c.connection, now(), now());
    return { isNew: true };
  }

  knownControllers(): { key: string; name: string; kind: string; lastSeen: string }[] {
    return (this.db.prepare('SELECT key, name, kind, last_seen FROM controllers ORDER BY last_seen DESC').all() as any[]).map((r) => ({ key: r.key, name: r.name, kind: r.kind, lastSeen: r.last_seen }));
  }

  getControllerProfile(): UniversalControllerProfile | null {
    const r = this.db.prepare('SELECT id, data, updated_at FROM profiles ORDER BY id ASC LIMIT 1').get() as { id: number; data: string; updated_at: string } | undefined;
    if (!r) return null;
    const data = parse<Omit<UniversalControllerProfile, 'id' | 'updatedAt'> | null>(r.data, null);
    return data ? { ...data, id: r.id, updatedAt: r.updated_at } : null;
  }

  saveControllerProfile(p: Omit<UniversalControllerProfile, 'id' | 'updatedAt'>): UniversalControllerProfile {
    const existing = this.getControllerProfile();
    const t = now();
    if (existing) this.db.prepare('UPDATE profiles SET name = ?, data = ?, updated_at = ? WHERE id = ?').run(p.name, JSON.stringify(p), t, existing.id);
    else this.db.prepare('INSERT INTO profiles(name, data, updated_at) VALUES(?, ?, ?)').run(p.name, JSON.stringify(p), t);
    return this.getControllerProfile()!;
  }

  // ----- per-game profiles -----
  getGameProfile(gameId: number): GameProfile | null {
    const r = this.db.prepare('SELECT * FROM game_profiles WHERE game_id = ?').get(gameId) as any;
    if (!r) return null;
    return { gameId: r.game_id, emulatorId: r.emulator_id, overrides: parse(r.overrides, {}), customArgs: r.custom_args, notes: r.notes, updatedAt: r.updated_at };
  }

  saveGameProfile(p: Omit<GameProfile, 'updatedAt'>): GameProfile {
    this.db.prepare(`INSERT INTO game_profiles(game_id, emulator_id, overrides, custom_args, notes, updated_at) VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(game_id) DO UPDATE SET emulator_id = excluded.emulator_id, overrides = excluded.overrides, custom_args = excluded.custom_args, notes = excluded.notes, updated_at = excluded.updated_at`).run(
      p.gameId, p.emulatorId, JSON.stringify(p.overrides ?? {}), p.customArgs, p.notes, now());
    return this.getGameProfile(p.gameId)!;
  }

  deleteGameProfile(gameId: number): void {
    this.db.prepare('DELETE FROM game_profiles WHERE game_id = ?').run(gameId);
  }
}
