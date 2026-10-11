// Automatic save backups:
//  - scheduled (daily/weekly), checked every hour, never while a game runs
//  - after a play session ends (coalesced per emulator, only if saves changed)
//  - before an emulator update or rollback (non-fatal)
// Unchanged saves never produce a new ZIP (SaveService compares fingerprints).

import type { SaveBackup } from '@shared/models';
import type { SaveService } from '../services/saveService';
import type { SettingsRepo } from '../database/settingsRepo';
import type { LaunchRepo } from '../database/launchRepo';
import type { JobManager } from '../core/jobs';
import type { EventBus } from '../core/events';
import type { EmulatorManager } from '../services/emulatorManager';
import { errorMessage } from '../core/errors';
import { logger } from '../core/logger';
import { scheduledBackupDue } from './backupFiles';

const log = logger.scope('saves');

export const LAST_SCHEDULED_KEY = 'saveBackup.lastScheduledAt';

export interface AutoSaveBackupDeps {
  saves: SaveService;
  settings: SettingsRepo;
  launches: LaunchRepo;
  jobs: JobManager;
  bus: EventBus;
  emulators: EmulatorManager;
  /** Emulator of the running game/session, or null. */
  activeEmulator: () => string | null;
  /** False in Safe Mode: no background backups (pre-update backups still run). */
  backgroundEnabled: () => boolean;
  now?: () => Date;
  /** How long to wait after a session ends before backing up (lets emulators flush files). */
  afterPlayDelayMs?: number;
}

export class AutoSaveBackup {
  private pendingAfterPlay = new Set<string>();
  private afterPlayTimer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;

  constructor(private readonly d: AutoSaveBackupDeps) {
    d.saves.setRunningEmulatorProbe(d.activeEmulator);
    d.emulators.setBeforeChangeHook((id, what) => this.beforeEmulatorChange(id, what));
    d.bus.on('launch.ended', (e) => this.onSessionEnded(e.launchId));
  }

  private now(): Date {
    return this.d.now?.() ?? new Date();
  }

  /** Hourly check plus one shortly after startup. Returns the timers so the owner can clear them. */
  start(): NodeJS.Timeout[] {
    return [setTimeout(() => void this.tick(), 90_000), setInterval(() => void this.tick(), 3600 * 1000)];
  }

  /** Runs a scheduled backup when one is due. Returns the job's result, or null when nothing ran. */
  async tick(): Promise<SaveBackup[] | null> {
    const s = this.d.saves.config();
    if (!this.d.backgroundEnabled() || this.running) return null;
    if (!scheduledBackupDue(s.schedule, this.d.settings.getInternal<string | null>(LAST_SCHEDULED_KEY, null), this.now())) return null;
    if (this.d.activeEmulator()) return null; // a game is running; the next hourly check retries
    const job = this.d.jobs.start('saves.autoBackup', 'Backing up saves (scheduled)', async (ctx) => {
      ctx.step('Backing up changed saves');
      const made = await this.d.saves.backup(null, 'auto');
      this.d.settings.setInternal(LAST_SCHEDULED_KEY, this.now().toISOString());
      ctx.stepDone(made.length ? `${made.length} emulator(s) backed up` : 'No saves changed since the last backup');
      return made;
    }, { lockKey: 'saves', cancellable: false });
    this.running = job.done;
    try {
      return await job.done;
    } catch (e) {
      log.warn('scheduled save backup failed', { error: errorMessage(e) });
      return null;
    } finally {
      this.running = null;
    }
  }

  onSessionEnded(launchId: number): void {
    if (!this.d.backgroundEnabled() || !this.d.saves.config().afterPlay) return;
    const rec = this.d.launches.get(launchId);
    if (!rec || rec.outcome === 'failed_to_start') return;
    this.pendingAfterPlay.add(rec.emulatorId);
    if (this.afterPlayTimer) clearTimeout(this.afterPlayTimer);
    this.afterPlayTimer = setTimeout(() => void this.flushAfterPlay(), this.d.afterPlayDelayMs ?? 20_000);
    this.afterPlayTimer.unref?.();
  }

  /** Backs up every emulator with a finished session (coalesced). Emulators still running wait for their next end. */
  async flushAfterPlay(): Promise<SaveBackup[]> {
    this.afterPlayTimer = null;
    const active = this.d.activeEmulator();
    const ids = [...this.pendingAfterPlay].filter((id) => id !== active);
    for (const id of ids) this.pendingAfterPlay.delete(id);
    if (!ids.length) return [];
    const job = this.d.jobs.start('saves.autoBackup', 'Backing up saves after playing', async () => {
      const out: SaveBackup[] = [];
      for (const id of ids) out.push(...(await this.d.saves.backup(id, 'after-play')));
      return out;
    }, { lockKey: 'saves', cancellable: false });
    try {
      return await job.done;
    } catch (e) {
      log.warn('after-play save backup failed', { error: errorMessage(e) });
      return [];
    }
  }

  /** Called by EmulatorManager before it replaces an emulator build. Never throws. */
  async beforeEmulatorChange(emulatorId: string, what: 'update' | 'rollback' | 'reinstall'): Promise<string> {
    if (!this.d.saves.config().beforeEmulatorUpdate) return 'Turned off in Settings';
    try {
      const made = await this.d.saves.backup(emulatorId, 'pre-update');
      return made.length ? `Saves backed up before ${what}` : 'Saves unchanged since the last backup';
    } catch (e) {
      log.warn('save backup before emulator change failed', { emulatorId, what, error: errorMessage(e) });
      return `Save backup failed (${errorMessage(e)}); continuing`;
    }
  }

  stop(): void {
    if (this.afterPlayTimer) clearTimeout(this.afterPlayTimer);
    this.afterPlayTimer = null;
  }
}
