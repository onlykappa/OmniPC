// Launch router. Library items never know an emulator executable:
//   Game -> Launch Router -> System -> selected Emulator adapter -> per-game
//   profile overrides -> process
// Every launch is recorded (command, args, pid, exit code, duration, outcome)
// and feeds OmniDoctor. Repeated failures trip crash-loop protection.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { ActiveSession, Finding, LaunchRecord, LaunchResult, OmniError } from '@shared/models';
import { getSystem } from '@shared/systems';
import type { AdapterRegistry } from '../emulators/registry';
import type { EmulatorAdapter, LaunchCommand } from '../emulators/adapter';
import type { EmulatorManager } from '../services/emulatorManager';
import type { LibraryRepo } from '../database/libraryRepo';
import type { LaunchRepo } from '../database/launchRepo';
import type { OpsRepo } from '../database/opsRepo';
import type { SettingsRepo } from '../database/settingsRepo';
import type { EmulatorRepo } from '../database/emulatorRepo';
import type { BiosService } from '../services/biosService';
import type { NotificationService } from '../services/notifications';
import type { EventBus } from '../core/events';
import { OmniFailure } from '../core/errors';
import { logger } from '../core/logger';
import { fileSize } from '../diagnostics/logs';
import { splitArgs } from '../emulators/pcsx2/adapter';
import { normaliseExitCode } from '../emulators/common';
import { isWindows, powershellJson } from '../platform/powershell';

const log = logger.scope('launch');

/** A launch that exits sooner than this without error is treated as suspicious. */
export const EARLY_EXIT_MS = 5000;

export interface LaunchDeps {
  registry: AdapterRegistry;
  emulators: EmulatorManager;
  emuRepo: EmulatorRepo;
  library: LibraryRepo;
  launches: LaunchRepo;
  ops: OpsRepo;
  settings: SettingsRepo;
  bios: BiosService;
  notifications: NotificationService;
  bus: EventBus;
  /** UI hooks (minimise/restore the OmniDeck window). */
  onSessionStart?: (s: ActiveSession) => void;
  onSessionEnd?: (s: ActiveSession) => void;
  spawnImpl?: typeof spawn;
}

export function classifyExit(exitCode: number | null, signal: string | null, durationMs: number, killedByUser: boolean): LaunchRecord['outcome'] {
  if (killedByUser) return 'killed';
  if (exitCode === 0) return durationMs < EARLY_EXIT_MS ? 'early_exit' : 'ok';
  if (exitCode === null && signal) return 'crashed';
  return 'crashed';
}

function omniError(code: string, whatHappened: string, extra: Partial<OmniError> = {}): OmniError {
  return { code, whatHappened, detected: [], probableCause: null, omniCanFix: null, userAction: [], technical: null, ...extra };
}

export class LaunchService {
  private active: { session: ActiveSession; child: ChildProcess; killedByUser: boolean } | null = null;

  constructor(private readonly d: LaunchDeps) {}

  activeSession(): ActiveSession | null {
    return this.active?.session ?? null;
  }

  /** Picks the emulator: game override > per-game profile > first installed implemented adapter for the system. */
  routeEmulator(gameId: number): { adapter: EmulatorAdapter | null; reason: string } {
    const game = this.d.library.getGame(gameId);
    if (!game) return { adapter: null, reason: 'Game not found' };
    const profile = this.d.ops.getGameProfile(gameId);
    const preferred = game.emulator_override ?? profile?.emulatorId ?? null;
    if (preferred) {
      const a = this.d.registry.get(preferred);
      if (a) return { adapter: a, reason: game.emulator_override ? 'Per-game emulator choice' : 'Per-game profile' };
    }
    const candidates = this.d.registry.forSystem(game.system_id);
    const installed = candidates.find((a) => a.manifest.implemented && this.d.emulators.isInstalled(a.manifest.id));
    if (installed) return { adapter: installed, reason: `Default emulator for ${getSystem(game.system_id)?.name}` };
    return { adapter: candidates[0] ?? null, reason: 'Recommended emulator (not installed)' };
  }

  async launchGame(gameId: number, opts: { discIndex?: number; ignoreCrashLoop?: boolean } = {}): Promise<LaunchResult> {
    if (this.active) return { ok: false, launchId: null, error: omniError('ALREADY_RUNNING', `${this.active.session.gameTitle ?? 'A game'} is already running.`, { userAction: ['Exit the running game first.'] }) };
    const game = this.d.library.getGame(gameId);
    if (!game) return { ok: false, launchId: null, error: omniError('GAME_NOT_FOUND', 'This game is no longer in the library.') };
    const sys = getSystem(game.system_id);

    if (game.availability === 'drive_unavailable') {
      return { ok: false, launchId: null, error: omniError('DRIVE_UNAVAILABLE', 'Game drive unavailable.', { detected: [`${game.title} is stored on a drive that is not connected.`], userAction: ['Reconnect the drive. OmniDeck restores the game automatically, even if Windows assigns a different drive letter.'], omniCanFix: { actionId: 'library.remapPaths', label: 'Look for the drive again', safety: 'safe', params: {}, description: 'Re-checks connected drives.' } }) };
    }
    if (game.crash_loop_paused && !opts.ignoreCrashLoop) {
      return { ok: false, launchId: null, blockedByCrashLoop: true, error: omniError('CRASH_LOOP', `${game.title} has failed ${game.consecutive_failures} times in a row.`, { detected: ['OmniDeck paused automatic launching to prevent a crash loop.'], userAction: ['Review the diagnosis, then choose "Try again anyway" or change the game settings.'] }) };
    }

    const { adapter, reason } = this.routeEmulator(gameId);
    if (!adapter) return { ok: false, launchId: null, error: omniError('NO_EMULATOR', `No emulator supports ${sys?.name ?? game.system_id}.`) };
    if (!adapter.manifest.implemented) {
      return { ok: false, launchId: null, error: omniError('ADAPTER_PLANNED', `${sys?.name} games need ${adapter.manifest.name}, whose OmniDeck integration is not implemented yet.`, { userAction: [adapter.manifest.plannedNote ?? 'Watch for an OmniDeck update.'] }) };
    }
    const emuId = adapter.manifest.id;
    if (!this.d.emulators.isInstalled(emuId)) {
      return { ok: false, launchId: null, error: omniError('EMULATOR_NOT_INSTALLED', `${adapter.manifest.name} is not installed yet.`, { detected: [`${sys?.name} games run on ${adapter.manifest.name}.`], omniCanFix: { actionId: 'emulator.install', label: `Install ${adapter.manifest.name}`, safety: 'low', params: { emulatorId: emuId }, description: 'Downloads the official release, configures it and tests it.' } }) };
    }
    const exe = this.d.emulators.executableFor(emuId)!;

    // Preflight: problems we can see before starting anything.
    const preflight: Finding[] = [];
    const files = this.d.library.filesForGame(gameId);
    const file = files[Math.min(opts.discIndex ?? 0, files.length - 1)];
    if (!file || !existsSync(file.path)) {
      return { ok: false, launchId: null, error: omniError('GAME_FILE_MISSING', "We couldn't find this game's file.", { detected: [file ? `${file.path} does not exist.` : 'No file recorded.'], probableCause: 'The file was moved or deleted, or its drive is disconnected.', omniCanFix: { actionId: 'library.rescan', label: 'Rescan library', safety: 'safe', params: {}, description: 'Rescans your game folders.' } }) };
    }
    if (!existsSync(exe)) {
      return { ok: false, launchId: null, error: omniError('EMULATOR_MISSING', `${adapter.manifest.name}'s executable is missing.`, { detected: [exe], probableCause: 'The emulator folder was deleted or quarantined by antivirus.', omniCanFix: { actionId: 'emulator.reinstall', label: `Reinstall ${adapter.manifest.name}`, safety: 'high', params: { emulatorId: emuId }, description: 'Settings and saves are kept.' } }) };
    }
    const bios = (await adapter.biosStatus()).find((b) => b.systemId === game.system_id);
    if (bios?.required && bios.status !== 'found') {
      return { ok: false, launchId: null, error: omniError('BIOS_MISSING', `${bios.label} is ${bios.status === 'invalid' ? 'not valid' : 'missing'}.`, { detected: [`Checked ${bios.expectedLocation}`], probableCause: `${adapter.manifest.name} cannot start ${sys?.name} games without a BIOS.`, userAction: ['Import a BIOS dumped from your own console in Settings > BIOS & Firmware.', 'Automatic repair is unavailable because the BIOS must be supplied by you.'] }) };
    }
    if (file.validation === 'invalid') {
      preflight.push({ id: 'preflight.file', checkId: 'preflight', category: 'library', severity: 'warning', title: 'This game file failed validation', detail: file.validation_note ?? '', subject: null, evidence: [file.path], confidence: 'medium', repair: null, manualSteps: [] });
    }

    // Build the command through the adapter, with per-game profile and custom settings.
    const settings = this.d.emulators.settingsFor(emuId);
    const profile = this.d.ops.getGameProfile(gameId);
    const version = this.d.emuRepo.get(emuId).version;
    let cmd: LaunchCommand;
    try {
      cmd = await adapter.buildLaunch({ gameId, path: file.path, systemId: game.system_id, serial: game.serial, title: game.title }, exe, settings, profile, version);
    } catch (err) {
      const f = OmniFailure.wrap(err, 'LAUNCH_BUILD_FAILED', 'OmniDeck could not prepare the launch command.');
      return { ok: false, launchId: null, error: f.detail };
    }
    const custom = this.d.emuRepo.getCustom(emuId);
    if (custom.customArgs) {
      // Custom emulator args go before the game argument terminator.
      const extra = splitArgs(custom.customArgs);
      const idx = cmd.args.findIndex((a) => a === '--' || a === '-e');
      cmd.args.splice(idx === -1 ? cmd.args.length - 1 : idx, 0, ...extra);
    }
    return this.spawnSession(cmd, { gameId, gameTitle: game.title, emulatorId: emuId, version, routeReason: reason, preflight });
  }

  async launchEmulatorUi(emulatorId: string): Promise<LaunchResult> {
    if (this.active) return { ok: false, launchId: null, error: omniError('ALREADY_RUNNING', 'Something is already running.') };
    const a = this.d.registry.require(emulatorId);
    const exe = this.d.emulators.executableFor(emulatorId);
    if (!exe || !existsSync(exe)) return { ok: false, launchId: null, error: omniError('EMULATOR_NOT_INSTALLED', `${a.manifest.name} is not installed.`) };
    return this.spawnSession(a.buildUiLaunch(exe), { gameId: null, gameTitle: null, emulatorId, version: this.d.emuRepo.get(emulatorId).version, routeReason: 'Emulator UI', preflight: [] });
  }

  private async spawnSession(cmd: LaunchCommand, ctx: { gameId: number | null; gameTitle: string | null; emulatorId: string; version: string | null; routeReason: string; preflight: Finding[] }): Promise<LaunchResult> {
    const logOffset = cmd.logFile ? await fileSize(cmd.logFile) : null;
    const launchId = this.d.launches.start({ gameId: ctx.gameId, emulatorId: ctx.emulatorId, emulatorVersion: ctx.version, command: cmd.command, args: cmd.args, logPath: cmd.logFile, logOffset });
    log.info('launching', { launchId, emulator: ctx.emulatorId, command: cmd.command, args: cmd.args, route: ctx.routeReason, notes: cmd.notes });
    try {
      await cmd.prepare?.();
    } catch (err) {
      await cmd.cleanup?.().catch(() => undefined);
      this.d.launches.finish(launchId, { exitCode: null, signal: null, outcome: 'failed_to_start', stderrTail: `prepare failed: ${(err as Error).message}` });
      return { ok: false, launchId, error: OmniFailure.wrap(err, 'PREPARE_FAILED', 'Preparing the per-game settings failed.').detail };
    }

    const spawnFn = this.d.spawnImpl ?? spawn;
    let child: ChildProcess;
    try {
      child = spawnFn(cmd.command, cmd.args, { cwd: existsSync(cmd.cwd) ? cmd.cwd : undefined, env: { ...process.env, ...(cmd.env ?? {}) }, windowsHide: false, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      await cmd.cleanup?.().catch(() => undefined);
      const rec = this.d.launches.finish(launchId, { exitCode: null, signal: null, outcome: 'failed_to_start', stderrTail: (err as Error).message });
      this.afterExit(rec, ctx.gameId);
      return { ok: false, launchId, error: OmniFailure.wrap(err, 'SPAWN_FAILED', 'The emulator could not be started.').detail };
    }

    const session: ActiveSession = { launchId, gameId: ctx.gameId, gameTitle: ctx.gameTitle, emulatorId: ctx.emulatorId, startedAt: new Date().toISOString(), pid: child.pid ?? null };
    this.active = { session, child, killedByUser: false };
    let tail = '';
    const capture = (d: Buffer) => {
      tail = (tail + d.toString('utf8')).slice(-16384);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    const started = await new Promise<{ ok: true } | { ok: false; error: NodeJS.ErrnoException }>((resolve) => {
      child.once('spawn', () => resolve({ ok: true }));
      child.once('error', (error: NodeJS.ErrnoException) => resolve({ ok: false, error }));
    });
    if (!started.ok) {
      this.active = null;
      await cmd.cleanup?.().catch(() => undefined);
      const rec = this.d.launches.finish(launchId, { exitCode: null, signal: null, outcome: 'failed_to_start', stderrTail: `${started.error.code ?? ''} ${started.error.message}`.trim() });
      this.afterExit(rec, ctx.gameId);
      this.d.bus.emit('launch.ended', { launchId, gameId: ctx.gameId, outcome: 'failed_to_start', needsAnalysis: true });
      return { ok: false, launchId, error: omniError('SPAWN_FAILED', 'The emulator could not be started.', { detected: [`${started.error.code ?? ''}: ${started.error.message}`], probableCause: started.error.code === 'EACCES' || started.error.code === 'EPERM' ? 'Windows or security software blocked the emulator executable.' : started.error.code === 'ENOENT' ? 'The executable does not exist.' : null }) };
    }

    this.d.launches.setPid(launchId, child.pid ?? null);
    this.d.bus.emit('launch.started', session);
    this.d.onSessionStart?.(session);
    this.watchForWindow(session);

    child.once('exit', (code, signal) => {
      void (async () => {
        const killed = this.active?.killedByUser ?? false;
        this.active = null;
        await cmd.cleanup?.().catch((e) => log.error('cleanup failed', e));
        const exitCode = normaliseExitCode(code);
        const duration = Date.now() - new Date(session.startedAt).getTime();
        const outcome = classifyExit(exitCode, signal, duration, killed);
        const rec = this.d.launches.finish(launchId, { exitCode, signal, outcome, stderrTail: tail.trim() ? tail.slice(-8000) : null });
        log.info('session ended', { launchId, exitCode, signal, outcome, durationMs: duration });
        this.afterExit(rec, ctx.gameId);
        this.d.onSessionEnd?.(session);
        this.d.bus.emit('launch.ended', { launchId, gameId: ctx.gameId, outcome, needsAnalysis: outcome === 'crashed' || outcome === 'early_exit' || outcome === 'failed_to_start' });
      })();
    });
    return { ok: true, launchId, error: null, preflight: ctx.preflight };
  }

  /** Warns (without killing anything) if the emulator never shows a window. */
  private watchForWindow(session: ActiveSession): void {
    if (!isWindows || session.pid === null) return;
    const timeout = Math.max(5, this.d.settings.get('launchTimeoutSeconds')) * 1000;
    setTimeout(() => {
      if (this.active?.session.launchId !== session.launchId) return;
      void powershellJson<{ Handle: number }>(`$p = Get-Process -Id ${session.pid} -ErrorAction SilentlyContinue; [pscustomobject]@{ Handle = [int64]($p.MainWindowHandle) } | ConvertTo-Json -Compress`).then((r) => {
        if (r && r.Handle === 0 && this.active?.session.launchId === session.launchId) {
          this.d.ops.addChange('launch.timeout', session.emulatorId, `${session.gameTitle ?? session.emulatorId}: no window ${timeout / 1000}s after launch`);
          this.d.notifications.add('warning', 'Still starting…', `${session.gameTitle ?? 'The emulator'} has not opened a window after ${timeout / 1000} seconds. It may be waiting on a dialog or stuck.`, { dedupeMs: 60000 });
        }
      });
    }, timeout);
  }

  private afterExit(rec: LaunchRecord, gameId: number | null): void {
    if (gameId === null) return;
    const game = this.d.library.getGame(gameId);
    if (!game) return;
    const seconds = (rec.durationMs ?? 0) / 1000;
    if (rec.outcome === 'ok' || (rec.outcome === 'crashed' && seconds > 60) || rec.outcome === 'killed') this.d.library.recordPlay(gameId, rec.startedAt, seconds);
    const failed = rec.outcome === 'crashed' || rec.outcome === 'early_exit' || rec.outcome === 'failed_to_start';
    if (!failed) {
      if (game.consecutive_failures) this.d.library.setFailureState(gameId, 0, false);
      return;
    }
    const n = game.consecutive_failures + 1;
    const threshold = this.d.settings.get('crashLoopThreshold');
    const pause = n >= threshold;
    this.d.library.setFailureState(gameId, n, pause);
    this.d.ops.addChange('launch.failed', rec.emulatorId, `${game.title} ${rec.outcome.replace('_', ' ')} (exit ${rec.exitCode ?? '?'})`);
    if (pause && !game.crash_loop_paused) {
      this.d.notifications.add('warning', `${game.title} paused`, `It failed ${n} times in a row. OmniDeck paused automatic launching to prevent a crash loop.`, { link: `/game/${gameId}` });
    }
  }

  stop(): void {
    if (!this.active) return;
    this.active.killedByUser = true;
    this.active.child.kill();
  }
}
