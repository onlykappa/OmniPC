import type BetterSqlite3 from 'better-sqlite3';
import type { LaunchRecord } from '@shared/models';

interface LaunchRow {
  id: number;
  game_id: number | null;
  emulator_id: string;
  emulator_version: string | null;
  command: string;
  args: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  pid: number | null;
  exit_code: number | null;
  signal: string | null;
  outcome: LaunchRecord['outcome'];
  stderr_tail: string | null;
  log_path: string | null;
  log_offset: number | null;
}

function toRecord(r: LaunchRow): LaunchRecord {
  let args: string[] = [];
  try { args = JSON.parse(r.args); } catch { /* ignore */ }
  return {
    id: r.id,
    gameId: r.game_id,
    emulatorId: r.emulator_id,
    emulatorVersion: r.emulator_version,
    command: r.command,
    args,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationMs: r.duration_ms,
    pid: r.pid,
    exitCode: r.exit_code,
    signal: r.signal,
    outcome: r.outcome,
    stderrTail: r.stderr_tail,
  };
}

export class LaunchRepo {
  constructor(private readonly db: BetterSqlite3.Database) {}

  start(p: { gameId: number | null; emulatorId: string; emulatorVersion: string | null; command: string; args: string[]; logPath: string | null; logOffset: number | null }): number {
    return Number(this.db.prepare("INSERT INTO launch_history(game_id, emulator_id, emulator_version, command, args, started_at, outcome, log_path, log_offset) VALUES(?, ?, ?, ?, ?, ?, 'running', ?, ?)").run(
      p.gameId, p.emulatorId, p.emulatorVersion, p.command, JSON.stringify(p.args), new Date().toISOString(), p.logPath, p.logOffset).lastInsertRowid);
  }

  setPid(id: number, pid: number | null): void {
    this.db.prepare('UPDATE launch_history SET pid = ? WHERE id = ?').run(pid, id);
  }

  finish(id: number, p: { exitCode: number | null; signal: string | null; outcome: LaunchRecord['outcome']; stderrTail: string | null }): LaunchRecord {
    const row = this.db.prepare('SELECT started_at FROM launch_history WHERE id = ?').get(id) as { started_at: string };
    const ended = new Date();
    const duration = ended.getTime() - new Date(row.started_at).getTime();
    this.db.prepare('UPDATE launch_history SET ended_at = ?, duration_ms = ?, exit_code = ?, signal = ?, outcome = ?, stderr_tail = ? WHERE id = ?').run(ended.toISOString(), duration, p.exitCode, p.signal, p.outcome, p.stderrTail, id);
    return this.get(id)!;
  }

  get(id: number): LaunchRecord | undefined {
    const r = this.db.prepare('SELECT * FROM launch_history WHERE id = ?').get(id) as LaunchRow | undefined;
    return r ? toRecord(r) : undefined;
  }

  logInfo(id: number): { logPath: string | null; logOffset: number | null } {
    const r = this.db.prepare('SELECT log_path, log_offset FROM launch_history WHERE id = ?').get(id) as { log_path: string | null; log_offset: number | null } | undefined;
    return { logPath: r?.log_path ?? null, logOffset: r?.log_offset ?? null };
  }

  history(opts: { gameId?: number; emulatorId?: string; limit: number }): LaunchRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.gameId !== undefined) { where.push('game_id = ?'); params.push(opts.gameId); }
    if (opts.emulatorId) { where.push('emulator_id = ?'); params.push(opts.emulatorId); }
    const sql = `SELECT * FROM launch_history ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...params, Math.min(opts.limit, 500)) as LaunchRow[]).map(toRecord);
  }

  /** Marks launches left 'running' by a previous OmniDeck crash. */
  closeOrphans(): number {
    return this.db.prepare("UPDATE launch_history SET outcome = 'killed', ended_at = COALESCE(ended_at, started_at) WHERE outcome = 'running'").run().changes;
  }

  /** Recent outcomes for an emulator, newest first (used for update regression detection). */
  outcomesSince(emulatorId: string, sinceIso: string): LaunchRecord[] {
    return (this.db.prepare('SELECT * FROM launch_history WHERE emulator_id = ? AND started_at >= ? ORDER BY id DESC').all(emulatorId, sinceIso) as LaunchRow[]).map(toRecord);
  }

  lastSuccessBefore(emulatorId: string, beforeIso: string): LaunchRecord | undefined {
    const r = this.db.prepare("SELECT * FROM launch_history WHERE emulator_id = ? AND started_at < ? AND outcome = 'ok' ORDER BY id DESC LIMIT 1").get(emulatorId, beforeIso) as LaunchRow | undefined;
    return r ? toRecord(r) : undefined;
  }
}
