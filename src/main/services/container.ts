// Composition root. Wires repositories and services together. Contains no
// Electron imports so the whole backend can be exercised by integration tests;
// Electron-specific capabilities arrive through the `Host` interface.

import type { SystemId } from '@shared/systems';
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
import { AutoSaveBackup } from '../saves/autoBackup';
import { StorageService } from './storageService';
import { LibraryScanner } from '../library/scanner';
import { dirname, join } from 'node:path';
import { SwitchTitleDb } from '../metadata/switchTitleDb';
import { MetadataService, defaultProviders, type Thumbnailer } from '../metadata/service';
import { LibretroThumbnails } from '../metadata/libretroThumbnails';
import { OmniDoctor } from '../diagnostics/doctor';
import { RepairEngine } from '../repairs/engine';
import { LaunchService } from '../launching/launchService';
import { ImportService } from '../importers/importService';
import { defaultProfile } from '../controllers/translate';
import { scanHardware } from '../platform/hardware';
import { errorMessage } from '../core/errors';
import { SteamService, defaultSelfLauncher, type SelfLauncher } from '../steam/service';
import { RetroAchievementsService } from '../achievements/service';
import { TokenVault, type SecretCipher, type StoredRaToken } from '../achievements/tokenVault';
import { raUserAgent } from '../achievements/raApi';
import { hostname } from 'node:os';
import { ShareClient } from '../share/client';
import { discover } from '../share/discovery';
import { ShareCopyService, type Discoverer } from '../share/copy';
import { SetupImporter } from '../share/setupImport';
import { ShareServer, type ShareOptions } from '../share/server';

const log = logger.scope('container');

export interface Host {
  thumbnailer: Thumbnailer;
  displays: () => DisplayInfo[];
  onSessionStart?: (gameTitle: string | null) => void;
  onSessionEnd?: () => void;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
  extraAdapters?: (paths: AppPaths) => EmulatorAdapter[];
  /** How Steam shortcuts start OmniPC (defaults to the running executable). */
  selfLauncher?: () => SelfLauncher;
  /** Encrypts secrets at rest (Electron safeStorage); without it the RetroAchievements token is stored unprotected. */
  secretCipher?: SecretCipher;
  appVersion?: string;
  /** Finds sharing PCs on the local network (tests inject a fake). */
  shareDiscoverer?: Discoverer;
  /** Overrides for the "Share this PC" server (tests). */
  share?: ShareOptions;
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
  readonly autoSaveBackup: AutoSaveBackup;
  readonly storage: StorageService;
  readonly scanner: LibraryScanner;
  readonly metadata: MetadataService;
  readonly doctor: OmniDoctor;
  readonly repairs: RepairEngine;
  readonly launcher: LaunchService;
  readonly importer: ImportService;
  readonly steam: SteamService;
  readonly achievements: RetroAchievementsService;
  /** "Copy from another PC" (client side of multi-PC sharing). */
  readonly shareCopy: ShareCopyService;
  readonly share: ShareServer;
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
      achievements: () => this.achievements.credentials(),
      fetchImpl: opts.host.fetchImpl,
    });
    this.achievements = new RetroAchievementsService({
      settings: this.settings,
      registry: this.registry,
      isInstalled: (id) => this.emulators.isInstalled(id),
      backups: this.backups,
      ops: this.ops,
      vault: new TokenVault({ read: () => this.settings.getInternal<StoredRaToken | null>('retroAchievementsToken', null), write: (v) => this.settings.setInternal('retroAchievementsToken', v) }, opts.host.secretCipher ?? null),
      fetchImpl: opts.host.fetchImpl ?? fetch,
      userAgent: raUserAgent(opts.host.appVersion ?? '0.0.0'),
    });
    this.bios = new BiosService(this.registry, this.paths, this.ops);
    this.saves = new SaveService(this.registry, this.emulators, this.paths, this.ops, this.settings, { homeDir: opts.homeDir, installDir: dirname(process.execPath) });
    this.storage = new StorageService(this.paths, this.emuRepo, this.emulators, this.registry, this.ops);
    this.scanner = new LibraryScanner(this.library, () => [this.paths.root, ...Object.values(this.paths.overrides)]);
    this.metadata = new MetadataService(
      this.library,
      this.settings,
      this.paths.artwork,
      this.paths.thumbnails,
      { emulatorAppDir: (id) => (this.emulators.isInstalled(id) ? this.registry.require(id).paths().app : null), fetchImpl: opts.host.fetchImpl ?? fetch },
      opts.host.thumbnailer,
      defaultProviders(new LibretroThumbnails(join(this.paths.cache, 'metadata'), opts.host.fetchImpl ?? fetch), new SwitchTitleDb(join(this.paths.cache, 'metadata'), opts.host.fetchImpl ?? fetch), opts.host.fetchImpl ?? fetch),
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
      saves: this.saves,
      raCanApply: () => !!this.achievements.credentials(),
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
      saves: this.saves,
      achievements: this.achievements,
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
    this.autoSaveBackup = new AutoSaveBackup({ saves: this.saves, settings: this.settings, launches: this.launches, jobs: this.jobs, bus: this.bus, emulators: this.emulators, activeEmulator: () => this.launcher.activeSession()?.emulatorId ?? null, backgroundEnabled: () => !this.safeMode });
    this.importer = new ImportService(this.registry, this.emulators, this.library, this.ops, this.bios, this.paths);
    this.share = new ShareServer({
      library: this.library,
      paths: this.paths,
      saveLocations: () => this.saves.locations(),
      emulatorName: (id) => this.registry.get(id)?.manifest.name ?? id,
      settings: this.settings,
      bus: this.bus,
      appVersion: opts.host.appVersion ?? '0.0.0',
      emulatorIds: () => this.registry.implemented().map((a) => a.manifest.id),
      isInstalled: (id) => this.emulators.isInstalled(id),
      emulatorVersion: (id) => this.emuRepo.get(id).version,
      storedEmulatorSettings: (id) => this.emuRepo.getSettings(id),
      settingsFor: (id) => this.emulators.settingsFor(id),
      controllerProfile: () => this.ops.getControllerProfile(),
      gameProfile: (id) => this.ops.getGameProfile(id),
      exportSaves: (id, dest) => this.saves.exportZip(id, dest),
    }, opts.host.share);
    this.steam = new SteamService({ library: this.library, paths: this.paths, launcher: opts.host.selfLauncher ?? defaultSelfLauncher });
    this.shareCopy = this.createShareCopy(opts.host.shareDiscoverer);
    // When an emulator becomes available, its bundled title/compatibility
    // database can improve metadata for games scanned earlier.
    const installed = new Set(this.registry.implemented().filter((a) => this.emulators.isInstalled(a.manifest.id)).map((a) => a.manifest.id));
    this.bus.on('emulators.changed', ({ id }) => {
      if (!id || installed.has(id) || !this.emulators.isInstalled(id) || this.safeMode) return;
      installed.add(id);
      const systems = this.registry.require(id).manifest.systems;
      const targets = this.library.gamesForSystems(systems);
      if (!targets.length) return;
      this.jobs.start('metadata.refresh', `Updating ${targets.length} game(s) with ${this.registry.require(id).manifest.name} data`, async (ctx) => {
        for (const [i, g] of targets.entries()) {
          ctx.throwIfCancelled();
          await this.metadata.refresh(g.id).catch(() => undefined);
          ctx.progress((i + 1) / targets.length);
        }
        this.bus.emit('library.changed', { reason: 'metadata' });
      }, { lockKey: 'metadata' });
    });
    this.bus.on('launch.ended', (e) => {
      if (e.gameId !== null) this.bus.emit('library.changed', { reason: 'played' });
    });
  }

  hardware(): HardwareProfile | null {
    return this.hardwareProfile;
  }

  private createShareCopy(discoverer: Discoverer | undefined): ShareCopyService {
    const client = new ShareClient({ store: this.settings, identity: () => ({ deviceId: this.share.deviceId, name: hostname() }), fetchImpl: this.opts.host.fetchImpl });
    const setup = new SetupImporter({
      settings: this.settings,
      emulators: this.emulators,
      isKnownEmulator: (id) => !!this.registry.get(id)?.manifest.implemented,
      ops: this.ops,
      library: this.library,
      backup: () => backupDatabase(this.db, this.paths.databaseBackups, 7, 'before-setup-copy'),
    });
    return new ShareCopyService({
      client,
      // Our own deviceId is passed so this PC never finds itself.
      discoverer: discoverer ?? { discover: (ms) => discover(ms, { deviceId: this.share.deviceId }) },
      jobs: this.jobs,
      paths: this.paths,
      library: this.library,
      addLibraryPath: async (p) => {
        const { driveInfoFor, driveOf } = await import('../platform/drives');
        const drive = await driveInfoFor(p).catch(() => null);
        this.library.addPath(p, drive?.volumeSerial ?? null, driveOf(p));
        this.ops.addChange('library.path', null, `Game folder added: ${p}`);
        this.bus.emit('library.changed', { reason: 'paths' });
      },
      scanLibrary: () => this.scanLibrary(false).done,
      saves: this.saves,
      setup,
      ops: this.ops,
      notifications: this.notifications,
      documentsDir: join(this.opts.homeDir, 'Documents'),
      onChanged: (what) => {
        if (what === 'library') this.bus.emit('library.changed', { reason: 'share' });
        else this.bus.emit('emulators.changed', { id: null });
      },
    });
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
      this.notifications.add('warning', 'OmniPC repaired its database', this.dbRecovery.notes.join(' '), { link: '/doctor' });
    }
    if (this.safeMode) {
      log.info('safe mode: background services disabled');
      return;
    }
    // "Share this PC" stays on across restarts when the user left it on.
    if (this.share.wantsEnabled()) await this.share.start().then(() => this.bus.emit('share.changed', this.share.status())).catch((e) => log.warn('sharing could not start', errorMessage(e)));
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
    // New artwork providers: enable them for existing installs once, then
    // re-identify the affected games and fetch art for games without a cover.
    //  v2: libretro-thumbnails (all systems)
    //  v3: Switch eShop listings (titledb); Xbox/360/Switch title IDs are now
    //      read from the game files.
    //  v4: Wikipedia fallback; the Xbox Marketplace image host no longer exists
    //      (and its failure used to stop all online art), so it is removed and
    //      games still without a cover are fetched again.
    const providersVersion = this.settings.getInternal('metadataProvidersVersion', 1);
    // v5: Wikipedia covers were never returned (non-free images were filtered
    // out), so look again for every game still without a cover.
    if (providersVersion < 5) {
      const cur = this.settings.get('artworkProviders').filter((p) => p !== 'xbox-marketplace');
      const add = ['libretro-thumbnails', 'switch-titledb', 'wikipedia'].filter((p) => !cur.includes(p));
      this.settings.set({ artworkProviders: [...cur, ...add] });
      this.settings.setInternal('metadataProvidersVersion', 5);
      if (settings.onboardingComplete && settings.metadataOnline && !this.safeMode) {
        const reidentify: SystemId[] = providersVersion < 3 ? ['xbox', 'x360', 'switch'] : [];
        setTimeout(() => {
          this.jobs.start('metadata.refresh', 'Downloading box art and screenshots', async (ctx) => {
            if (reidentify.length && this.library.listPaths().length) await this.scanner.scan({ full: false, reidentify }, ctx);
            const r = await this.metadata.refreshAll(ctx, { onlyMissing: false, withoutCover: true });
            this.bus.emit('library.changed', { reason: 'metadata' });
            return r;
          }, { lockKey: 'library' });
        }, 25000);
      }
    }
    // Identification v2: .zip/.7z outside arcade/system folders are no longer
    // games (they were all listed as Arcade); re-check existing arcade entries.
    if (this.settings.getInternal('identifyVersion', 1) < 2) {
      this.settings.setInternal('identifyVersion', 2);
      if (settings.onboardingComplete && this.library.listPaths().length) {
        setTimeout(() => {
          this.jobs.start('library.scan', 'Re-checking archives in your library', async (ctx) => {
            const r = await this.scanner.scan({ full: false, reidentify: ['arcade'] }, ctx);
            this.bus.emit('library.changed', { reason: 'scan' });
            return r;
          }, { lockKey: 'library' });
        }, 8000);
      }
    }
    // Validation rules changed (v2: N64 .z64 ROMs were mistaken for split ZIP
    // parts): re-check files previously flagged so stale warnings clear.
    if (this.settings.getInternal('validationVersion', 1) < 2) {
      this.settings.setInternal('validationVersion', 2);
      setTimeout(() => {
        this.jobs.start('library.revalidate', 'Re-checking flagged game files', async (ctx) => {
          const { revalidateGame } = await import('../library/gameFix');
          const ids = (this.db.prepare("SELECT id FROM games WHERE validation IN ('invalid', 'warning') AND availability = 'available'").all() as { id: number }[]).map((r) => r.id);
          for (const [i, id] of ids.entries()) {
            ctx.throwIfCancelled();
            ctx.progress(i / Math.max(ids.length, 1), `${i}/${ids.length}`);
            await revalidateGame(this.library, id);
          }
          this.bus.emit('library.changed', { reason: 'validation' });
          return { checked: ids.length };
        }, { lockKey: 'library' });
      }, 5000);
    }
    if (settings.onboardingComplete) {
      if (this.library.listPaths().length) this.scanLibrary(false);
      if (settings.backgroundHealthChecks) setTimeout(() => this.runHealthCheck('quick'), 8000);
      if (settings.autoUpdateEmulators) setTimeout(() => this.autoUpdateEmulators(), 20000);
      else if (settings.checkUpdatesOnStart) setTimeout(() => void this.emulators.checkUpdates().catch(() => undefined), 15000);
    }
    // Automatic emulator updates every 6 hours while OmniPC is open (setting read at each tick).
    this.timers.push(setInterval(() => this.autoUpdateEmulators(), 6 * 3600 * 1000));
    // Scheduled save backups: checked hourly, skipped while a game is running.
    this.timers.push(...this.autoSaveBackup.start());
    this.timers.push(setInterval(() => void backupDatabase(this.db, this.paths.databaseBackups).catch(() => undefined), 24 * 3600 * 1000));
  }

  /** Runs the unattended check-and-update when enabled; never while a game is running. */
  autoUpdateEmulators(): void {
    const s = this.settings.getAll();
    if (this.safeMode || !s.onboardingComplete || !s.autoUpdateEmulators || this.launcher.activeSession()) return;
    this.emulators.checkAndUpdateAll({ automatic: true, isBusy: () => !!this.launcher.activeSession() }).done.catch((err) => logger.scope('updates').warn('automatic emulator update failed', { error: String(err) }));
  }

  shutdown(): void {
    for (const t of this.timers) clearInterval(t);
    this.autoSaveBackup.stop();
    void this.share.stop();
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}
