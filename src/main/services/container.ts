// Composition root. Wires repositories and services together. Contains no
// Electron imports so the whole backend can be exercised by integration tests;
// Electron-specific capabilities arrive through the `Host` interface.

import { mkdir } from 'node:fs/promises';
import type { spawn } from 'node:child_process';
import type BetterSqlite3 from 'better-sqlite3';
import type { DetectedController, DisplayInfo, HardwareProfile, UniversalControllerProfile } from '@shared/models';
import { AppPaths } from '../core/paths';
import { EventBus } from '../core/events';
import { JobManager } from '../core/jobs';
import { logger } from '../core/logger';
import { openDatabase, backupDatabase, newestBackupAgeHours } from '../database/db';
import { SettingsRepo } from '../database/settingsRepo';
import { LibraryRepo } from '../database/libraryRepo';
import { EmulatorRepo } from '../database/emulatorRepo';
import { LaunchRepo } from '../database/launchRepo';
import { OpsRepo } from '../database/opsRepo';
import { ConfigBackupService } from '../config/backups';
import { DownloadManager } from '../downloads/downloadManager';
import { AdapterRegistry } from '../emulators/registry';
import type { EmulatorAdapter } from '../emulators/adapter';
import { EmulatorManager } from './emulatorManager';
import { NotificationService } from './notifications';
import { BiosService } from './biosService';
import { SaveService } from './saveService';
import { StorageService } from './storageService';
import { LibraryScanner } from '../library/scanner';
import { MetadataService, type Thumbnailer } from '../metadata/service';
import { OmniDoctor } from '../diagnostics/doctor';
import { RepairEngine } from '../repairs/engine';
import { LaunchService } from '../launching/launchService';
import { ImportService } from '../importers/importService';
import { defaultProfile } from '../controllers/translate';
import { scanHardware } from '../platform/hardware';
import { errorMessage } from '../core/errors';

const log = logger.scope('container');

export interface Host {
  thumbnailer: Thumbnailer;
  displays: () => DisplayInfo[];
  onSessionStart?: (gameTitle: string | null) => void;
  onSessionEnd?: () => void;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
  extraAdapters?: (paths: AppPaths) => EmulatorAdapter[];
}

export interface ContainerOptions {
  userDataDir: string;
  homeDir: string;
  safeMode: boolean;
  host: Host;
}

export class AppContainer {
  readonly paths: AppPaths;
  readonly bus = new EventBus();
  readonly jobs: JobManager;
  readonly db: BetterSqlite3.Database;
  readonly dbRecovery: { recovered: 'none' | 'from_backup' | 'fresh'; notes: string[] };
  readonly settings: SettingsRepo;
  readonly library: LibraryRepo;
  readonly emuRepo: EmulatorRepo;
  readonly launches: LaunchRepo;
  readonly ops: OpsRepo;
  readonly backups: ConfigBackupService;
  readonly downloads: DownloadManager;
  readonly registry: AdapterRegistry;
  readonly notifications: NotificationService;
  readonly emulators: EmulatorManager;
  readonly bios: BiosService;
  readonly saves: SaveService;
  readonly storage: StorageService;
  readonly scanner: LibraryScanner;
  readonly metadata: MetadataService;
  readonly doctor: OmniDoctor;
  readonly repairs: RepairEngine;
  readonly launcher: LaunchService;
  readonly importer: ImportService;
  readonly safeMode: boolean;
  private hardwareProfile: HardwareProfile | null;
  private pads: { pads: DetectedController[]; reportedAt: number | null } = { pads: [], reportedAt: null };
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly opts: ContainerOptions) {
    this.safeMode = opts.safeMode;
    this.paths = new AppPaths(opts.userDataDir, opts.homeDir);
    this.paths.ensureBaseLayout();
    logger.configure({ dir: this.paths.logs });
    this.jobs = new JobManager(this.bus);
    const opened = openDatabase(this.paths.database, this.paths.databaseBackups);
    this.db = opened.db;
    this.dbRecovery = { recovered: opened.recovered, notes: opened.notes };
    this.settings = new SettingsRepo(this.db);
    this.library = new LibraryRepo(this.db);
    this.emuRepo = new EmulatorRepo(this.db);
    this.launches = new LaunchRepo(this.db);
    this.ops = new OpsRepo(this.db);
    this.hardwareProfile = this.settings.getInternal<HardwareProfile | null>('hardware', null);
    this.backups = new ConfigBackupService(this.paths.configBackups, this.ops);
    this.downloads = new DownloadManager(this.paths.downloads, this.bus, opts.host.fetchImpl ?? fetch);
    this.registry = new AdapterRegistry(this.paths, opts.host.extraAdapters?.(this.paths) ?? []);
    this.notifications = new NotificationService(this.ops, this.bus);
    this.emulators = new EmulatorManager({
      registry: this.registry,
      emuRepo: this.emuRepo,
      ops: this.ops,
      settings: this.settings,
      downloads: this.downloads,
      jobs: this.jobs,
      backups: this.backups,
      paths: this.paths,
      bus: this.bus,
      notifications: this.notifications,
      hardware: () => this.hardwareProfile,
      controllerProfile: () => this.controllerProfile(),
    });
    this.bios = new BiosService(this.registry, this.paths, this.ops);
    this.saves = new SaveService(this.registry, this.emulators, this.paths, this.ops);
    this.storage = new StorageService(this.paths, this.emuRepo, this.emulators, this.registry, this.ops);
    this.scanner = new LibraryScanner(this.library, () => [this.paths.root, ...Object.values(this.paths.overrides)]);
    this.metadata = new MetadataService(
      this.library,
      this.settings,
      this.paths.artwork,
      this.paths.thumbnails,
      { emulatorAppDir: (id) => (this.emulators.isInstalled(id) ? this.registry.require(id).paths().app : null), fetchImpl: opts.host.fetchImpl ?? fetch },
      opts.host.thumbnailer,
    );
    const checkDeps = {
      registry: this.registry,
      emulators: this.emulators,
      emuRepo: this.emuRepo,
      library: this.library,
      launches: this.launches,
      ops: this.ops,
      settings: this.settings,
      paths: this.paths,
      db: this.db,
      bios: this.bios,
      hardware: () => this.hardwareProfile,
      controllers: () => this.pads,
      bus: this.bus,
    };
    this.doctor = new OmniDoctor(checkDeps);
    this.repairs = new RepairEngine({
      ops: this.ops,
      settings: this.settings,
      library: this.library,
      registry: this.registry,
      emulators: this.emulators,
      backups: this.backups,
      paths: this.paths,
      scanner: this.scanner,
      metadata: this.metadata,
      db: this.db,
      bus: this.bus,
      scanLibrary: () => this.scanLibrary(false).done,
      rescanHardware: () => this.scanHardware(),
    });
    this.launcher = new LaunchService({
      registry: this.registry,
      emulators: this.emulators,
      emuRepo: this.emuRepo,
      library: this.library,
      launches: this.launches,
      ops: this.ops,
      settings: this.settings,
      bios: this.bios,
      notifications: this.notifications,
      bus: this.bus,
      spawnImpl: opts.host.spawnImpl,
      onSessionStart: (s) => opts.host.onSessionStart?.(s.gameTitle),
      onSessionEnd: () => opts.host.onSessionEnd?.(),
    });
    this.importer = new ImportService(this.registry, this.emulators, this.library, this.ops, this.bios, this.paths);
    this.bus.on('launch.ended', (e) => {
      if (e.gameId !== null) this.bus.emit('library.changed', { reason: 'played' });
    });
  }

  hardware(): HardwareProfile | null {
    return this.hardwareProfile;
  }

  async scanHardware(): Promise<HardwareProfile> {
    const hw = await scanHardware(this.opts.host.displays());
    this.hardwareProfile = hw;
    this.settings.setInternal('hardware', hw);
    this.ops.addChange('hardware.scanned', null, `Computer scanned: ${hw.cpu.model}, ${hw.gpus.map((g) => g.name).join(' + ') || 'no GPU'}, ${Math.round(hw.ramMB / 1024)} GB RAM (${hw.tier} tier)`);
    return hw;
  }

  controllerProfile(): UniversalControllerProfile {
    return this.ops.getControllerProfile() ?? this.ops.saveControllerProfile(defaultProfile());
  }

  controllerState(): { pads: DetectedController[]; reportedAt: number | null } {
    return this.pads;
  }

  /** Renderer reports gamepads it sees (Gamepad API); new devices are announced once. */
  reportGamepads(pads: DetectedController[]): void {
    const before = new Set(this.pads.pads.map((p) => p.key));
    this.pads = { pads, reportedAt: Date.now() };
    for (const p of pads) {
      const { isNew } = this.ops.upsertController(p);
      if (!before.has(p.key)) {
        if (isNew) this.notifications.add('info', 'New controller detected', `${p.name} (${p.connection === 'Unknown' ? p.api : p.connection}). It will be used as Player ${p.index !== null ? p.index + 1 : 1}.`, { link: '/controllers', dedupeMs: 60000 });
        this.ops.addChange('controller.connected', null, `${p.name} connected`);
      }
    }
    for (const k of before) if (!pads.some((p) => p.key === k)) this.ops.addChange('controller.disconnected', null, `Controller disconnected (${k})`);
  }

  scanLibrary(full: boolean): { id: string; done: Promise<unknown> } {
    return this.jobs.start('library.scan', full ? 'Full library rescan' : 'Scanning library', async (ctx) => {
      const summary = await this.scanner.scan({ full }, ctx);
      this.bus.emit('library.changed', { reason: 'scan' });
      if (summary.added) {
        this.notifications.add('success', `${summary.added} new game${summary.added === 1 ? '' : 's'} imported`, Object.entries(summary.bySystem).map(([k, v]) => `${k.toUpperCase()}: ${v}`).join(' · '), { link: '/library' });
        this.ops.addChange('library.scan', null, `Library scan: ${summary.added} added, ${summary.removed} removed, ${summary.unchanged} unchanged`);
      }
      if (summary.markedUnavailable) this.notifications.add('warning', 'Game drive disconnected', `${summary.markedUnavailable} game folder(s) are unavailable. Games are kept and return when the drive is reconnected.`, { dedupeMs: 600000 });
      ctx.step('Fetching metadata for new games');
      if (!this.safeMode) await this.metadata.refreshAll(ctx, { onlyMissing: true });
      this.bus.emit('library.changed', { reason: 'metadata' });
      return summary;
    }, { lockKey: 'library' });
  }

  runHealthCheck(scope: 'full' | 'quick'): { id: string; done: Promise<unknown> } {
    return this.jobs.start('doctor.run', scope === 'full' ? 'Full health check' : 'Quick health check', async (ctx) => {
      const report = await this.doctor.run(scope, (f, label) => ctx.progress(f, label));
      if (this.settings.get('autoRepairSafeIssues') && !this.safeMode) {
        const suggestions = report.findings.filter((f) => f.repair?.safety === 'safe' && (f.severity === 'warning' || f.severity === 'problem')).map((f) => ({ actionId: f.repair!.actionId, params: f.repair!.params }));
        const auto = await this.repairs.runSafe(suggestions, true);
        if (auto.length) {
          ctx.message(`Automatically applied ${auto.length} safe repair(s)`);
          return this.doctor.run(scope);
        }
      }
      return report;
    }, { lockKey: 'doctor', cancellable: false });
  }

  /** Startup sequence: recover sessions, close orphans, back up DB, background checks. */
  async startup(): Promise<void> {
    await mkdir(this.paths.downloads, { recursive: true });
    const orphans = this.launches.closeOrphans();
    if (orphans) log.warn(`closed ${orphans} launch record(s) left running by a previous session`);
    for (const note of await this.emulators.recoverSessions()) this.ops.addChange('session.recovered', null, note);
    if (this.dbRecovery.recovered !== 'none') {
      this.notifications.add('warning', 'OmniDeck repaired its database', this.dbRecovery.notes.join(' '), { link: '/doctor' });
    }
    if (this.safeMode) {
      log.info('safe mode: background services disabled');
      return;
    }
    const age = newestBackupAgeHours(this.paths.databaseBackups);
    if (age === null || age > 24) await backupDatabase(this.db, this.paths.databaseBackups).catch((e) => log.warn('db backup failed', errorMessage(e)));
    if (!this.hardwareProfile) await this.scanHardware().catch((e) => log.warn('hardware scan failed', errorMessage(e)));
    const settings = this.settings.getAll();
    // Drive watcher: detects removed/reconnected game drives without a full scan.
    this.timers.push(setInterval(() => {
      void this.scanner.refreshAvailability().then((r) => {
        if (r.available.length || r.unavailable.length || r.remapped.length) {
          this.bus.emit('drives.changed', { available: [...r.available, ...r.remapped], unavailable: r.unavailable });
          this.bus.emit('library.changed', { reason: 'drives' });
          if (r.unavailable.length) this.notifications.add('warning', 'Game drive disconnected', `${r.unavailable.join(', ')} is unavailable. Your games are kept.`, { dedupeMs: 300000 });
          if (r.available.length || r.remapped.length) this.notifications.add('success', 'Game drive reconnected', [...r.available, ...r.remapped].join(', '), { dedupeMs: 300000 });
        }
      }).catch(() => undefined);
    }, 15000));
    if (settings.onboardingComplete) {
      if (this.library.listPaths().length) this.scanLibrary(false);
      if (settings.backgroundHealthChecks) setTimeout(() => this.runHealthCheck('quick'), 8000);
      if (settings.checkUpdatesOnStart) setTimeout(() => void this.emulators.checkUpdates().catch(() => undefined), 15000);
    }
    this.timers.push(setInterval(() => void backupDatabase(this.db, this.paths.databaseBackups).catch(() => undefined), 24 * 3600 * 1000));
  }

  shutdown(): void {
    for (const t of this.timers) clearInterval(t);
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}
