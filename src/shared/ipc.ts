// Typed contract between renderer and main. The renderer calls
// `window.omni.invoke(method, ...args)`; the main process registers exactly one
// handler per method (see src/main/ipc/handlers.ts). Adding a method here makes
// the compiler require a handler.

import type {
  ActiveSession,
  AiContextPreview,
  AppInfo,
  AppUpdateState,
  BiosScanFound,
  AppNotification,
  AppSettings,
  BiosStatus,
  ChangeEvent,
  ConfigBackup,
  ConfigDiff,
  DetectedController,
  DownloadItem,
  EmulatorDetailsDto,
  EmulatorSettings,
  CustomEmulatorSettings,
  EmulatorStatus,
  FailureAnalysis,
  GameDetails,
  GameMetadata,
  GameProfile,
  HardwareProfile,
  HealthReport,
  ImportPreview,
  JobStatus,
  LaunchRecord,
  LaunchResult,
  LibraryPage,
  LibraryPath,
  LibraryQuery,
  PerformancePreset,
  RepairRecord,
  RendererOption,
  SaveBackup,
  SaveBackupFolderSuggestion,
  SaveBackupSettings,
  SaveLocation,
  SearchResult,
  SetupImportCandidate,
  SettingDescriptor,
  StorageKey,
  StorageLocation,
  UniversalControllerProfile,
  GameSummary,
  DuplicateGroup,
} from './models';
import type { SystemId } from './systems';
import type { SteamStatus, SteamSyncOptions, SteamSyncResult } from './steam';

export interface SystemSummary {
  id: SystemId;
  name: string;
  shortName: string;
  manufacturer: string;
  gameCount: number;
  emulatorId: string | null;
  emulatorName: string | null;
  emulatorImplemented: boolean;
  emulatorInstalled: boolean;
  bios: 'found' | 'missing' | 'optional' | 'not_required' | 'invalid';
  accent: string;
}

export interface HomeData {
  continuePlaying: GameSummary[];
  recentlyAdded: GameSummary[];
  favorites: GameSummary[];
  systems: SystemSummary[];
  emulators: EmulatorStatus[];
  health: { overall: number | null; problems: number; warnings: number; lastRunAt: string | null };
  activeSession: ActiveSession | null;
  libraryCount: number;
}

export interface OnboardingInstallPlan {
  systems: SystemId[];
  emulators: { id: string; name: string; implemented: boolean; note: string }[];
  libraryPaths: string[];
  preset: PerformancePreset;
}

export interface DevAdapterReport {
  emulatorId: string;
  manifest: unknown;
  paths: Record<string, string>;
  installedVersion: string | null;
  latestVersion: { version: string; url: string; source: string } | { error: string } | null;
  healthChecks: unknown[];
  sampleLaunchCommand: { command: string; args: string[] } | { error: string } | null;
  latestLog: { path: string; excerpt: string } | null;
}

export interface OmniApi {
  // App
  'app.info': () => AppInfo;
  /** OmniPC self-update: state, check GitHub Releases, download, restart to install. */
  'app.update.state': () => AppUpdateState;
  'app.update.check': () => AppUpdateState;
  'app.update.download': () => AppUpdateState;
  'app.update.install': () => { ok: boolean; reason: string | null };
  'app.settings.get': () => AppSettings;
  'app.settings.set': (patch: Partial<AppSettings>) => AppSettings;
  'app.settings.catalog': () => SettingDescriptor[];
  'app.search': (query: string) => SearchResult[];
  'app.openPath': (path: string) => void;
  'app.openExternal': (url: string) => void;
  'app.pickFolder': (title: string) => string | null;
  'app.pickFile': (title: string, extensions: string[]) => string | null;
  'app.exportDiagnosticPackage': (opts: { includeEmulatorLogs: boolean; includeConfigs: boolean }) => { path: string; files: string[]; excluded: string[] } | null;
  'app.factoryReset': (kind: 'settings' | 'emulator-configs' | 'repair-installation' | 'complete') => { summary: string[] };
  'app.relaunch': (opts: { safeMode: boolean }) => void;
  'app.setConsoleMode': (enabled: boolean) => void;
  'app.changes': (limit: number) => ChangeEvent[];
  'app.logTail': (lines: number) => string;

  // Home / systems
  'home.get': () => HomeData;
  'systems.list': () => SystemSummary[];

  // Hardware
  'hardware.get': () => HardwareProfile | null;
  'hardware.scan': () => HardwareProfile;

  // Library
  'library.query': (q: LibraryQuery) => LibraryPage;
  'library.game': (id: number) => GameDetails | null;
  'library.paths': () => LibraryPath[];
  'library.addPath': (path: string) => LibraryPath;
  'library.removePath': (id: number) => void;
  'library.preview': (path: string) => ImportPreview;
  'library.scan': (opts: { full: boolean }) => { jobId: string };
  'library.setFavorite': (id: number, favorite: boolean) => void;
  'library.duplicates': () => DuplicateGroup[];
  'library.setEmulatorOverride': (id: number, emulatorId: string | null) => void;
  'library.revalidate': (id: number) => GameDetails | null;

  // Metadata
  'metadata.refresh': (gameId: number) => GameMetadata;
  'metadata.update': (gameId: number, patch: Partial<GameMetadata> & { title?: string }) => GameMetadata;
  'metadata.setArtwork': (gameId: number, kind: 'cover' | 'background', filePath: string) => GameMetadata;
  'metadata.clear': (gameId: number) => void;
  'metadata.refreshAll': () => { jobId: string };

  // Emulators
  'emulators.list': () => EmulatorStatus[];
  'emulators.details': (id: string) => EmulatorDetailsDto;
  'emulators.install': (id: string) => { jobId: string };
  'emulators.installForSystems': (systems: SystemId[]) => { jobId: string };
  'emulators.update': (id: string) => { jobId: string };
  'emulators.updateAll': () => { jobId: string };
  'emulators.checkUpdates': () => EmulatorStatus[];
  /** Checks every installed emulator and installs newer releases (failed updates roll back). */
  'emulators.checkAndUpdateAll': () => { jobId: string };
  'emulators.rollback': (id: string) => { jobId: string };
  'emulators.repair': (id: string) => { jobId: string };
  'emulators.resetConfig': (id: string) => { jobId: string };
  'emulators.uninstall': (id: string) => { jobId: string };
  'emulators.launchUi': (id: string) => LaunchResult;
  'emulators.healthCheck': (id: string) => HealthReport;
  'emulators.saveSettings': (id: string, settings: EmulatorSettings) => EmulatorDetailsDto;
  'emulators.saveCustom': (id: string, custom: CustomEmulatorSettings) => EmulatorDetailsDto;
  'emulators.renderers': (id: string) => RendererOption[];
  /** Settings menu: schema, values in the emulator's config now, and OmniPC's saved values. */
  'emulators.settingsView': (id: string) => import('./emulatorSettings').EmulatorSettingsView;
  /** "Optimize for my PC": proposed changes (nothing is applied). */
  'emulators.optimizePreview': (id: string) => import('./emulatorSettings').OptimizeSuggestion[];
  /** Applies the chosen proposals (fields from optimizePreview); configuration is backed up first. */
  'emulators.optimizeApply': (id: string, fields: string[]) => EmulatorDetailsDto;
  'emulators.useExisting': (id: string, executable: string) => EmulatorStatus;

  // Backups
  'backups.list': (emulatorId: string | null) => ConfigBackup[];
  'backups.create': (emulatorId: string, label: string) => ConfigBackup;
  'backups.restore': (backupId: number) => { restored: string[]; safetyBackupId: number };
  'backups.diff': (backupId: number) => ConfigDiff;
  'backups.delete': (backupId: number) => void;

  // Launching
  'launch.game': (gameId: number, opts?: { discIndex?: number; ignoreCrashLoop?: boolean }) => LaunchResult;
  'launch.active': () => ActiveSession | null;
  'launch.stop': () => void;
  'launch.history': (opts: { gameId?: number; emulatorId?: string; limit: number }) => LaunchRecord[];
  'launch.analyze': (launchId: number) => FailureAnalysis;
  'launch.resetCrashLoop': (gameId: number) => void;

  // Profiles
  'profiles.get': (gameId: number) => GameProfile | null;
  'profiles.save': (profile: Omit<GameProfile, 'updatedAt'>) => GameProfile;
  'profiles.delete': (gameId: number) => void;

  // OmniDoctor
  'doctor.latest': () => HealthReport | null;
  'doctor.run': (scope: 'full' | 'quick') => { jobId: string };
  'doctor.finding': (findingId: string) => { finding: import('./models').Finding; report: HealthReport } | null;
  'doctor.repair': (actionId: string, params: Record<string, unknown>, opts: { confirmed: boolean }) => RepairRecord;
  'doctor.repairAllSafe': () => RepairRecord[];
  /** OmniDoctor > Games: games whose files (not emulator) need attention. */
  'doctor.games': () => import('./models').GameProblem[];
  'doctor.history': (limit: number) => RepairRecord[];
  'doctor.undo': (repairId: number) => RepairRecord;
  'doctor.rules': () => { emulatorId: string; rules: { id: string; title: string; severity: string; fix: string | null }[] }[];
  'doctor.aiContext': (question: string, gameId: number | null) => AiContextPreview;
  'doctor.aiAsk': (question: string, gameId: number | null) => { answer: string; provider: string };

  // Controllers
  'controllers.pnp': () => DetectedController[];
  'controllers.reportGamepads': (pads: DetectedController[]) => void;
  'controllers.profile': () => UniversalControllerProfile;
  'controllers.saveProfile': (p: Omit<UniversalControllerProfile, 'id' | 'updatedAt'>) => UniversalControllerProfile;
  'controllers.apply': () => { applied: string[]; skipped: { emulatorId: string; reason: string }[] };

  // RetroAchievements (sign in once; OmniPC configures every supporting emulator)
  'ra.status': () => import('./achievements').RaStatus;
  /** The password is sent to retroachievements.org once and never stored. */
  'ra.login': (username: string, password: string) => import('./achievements').RaStatus;
  'ra.logout': () => import('./achievements').RaStatus;
  'ra.setHardcore': (on: boolean) => import('./achievements').RaStatus;
  'ra.apply': () => import('./achievements').RaStatus;

  // BIOS
  'bios.status': () => BiosStatus[];
  'bios.import': (systemId: SystemId, filePath: string) => BiosStatus;
  'bios.openFolder': (systemId: SystemId) => void;
  /** Scans folders (default: the library's game folders) for BIOS, firmware and key files. */
  'bios.scan': (roots: string[] | null) => BiosScanFound;
  /** Copies the chosen found files into BIOS/<system> (originals untouched). */
  'bios.importFound': (paths: string[]) => { imported: string[]; skipped: string[] };

  // Saves
  'saves.locations': () => SaveLocation[];
  'saves.backup': (emulatorId: string | null) => SaveBackup[];
  'saves.backups': () => SaveBackup[];
  'saves.restore': (backupId: string) => { restoredTo: string; safetyBackup: string };
  /** Existing OneDrive / Google Drive / Dropbox folders to offer as the backup folder. */
  'saves.settingsSuggestions': () => SaveBackupFolderSuggestion[];
  /** Validates (exists, writable, not a save or program folder) and stores the backup folder; null = OmniPC's own folder. */
  'saves.setDestination': (folder: string | null) => SaveBackupSettings;
  /** Backup folder state: problem is set when the chosen folder is missing or unwritable. */
  'saves.destinationStatus': () => { destination: string | null; problem: string | null; activeFolder: string; computer: string };
  /** Opens a backup's folder, or the folder new backups go to (null). */
  'saves.openFolder': (backupId: string | null) => void;

  // Storage
  'storage.locations': () => StorageLocation[];
  'storage.relocate': (key: StorageKey, newPath: string) => { jobId: string };

  // Downloads / jobs
  'downloads.list': () => DownloadItem[];
  'downloads.pause': (id: string) => void;
  'downloads.resume': (id: string) => void;
  'downloads.cancel': (id: string) => void;
  'downloads.retry': (id: string) => void;
  'jobs.list': () => JobStatus[];
  'jobs.cancel': (id: string) => void;

  // Notifications
  'notifications.list': () => AppNotification[];
  'notifications.markRead': (ids: number[] | 'all') => void;

  // Onboarding / import
  'onboarding.plan': (systems: SystemId[]) => OnboardingInstallPlan;
  'onboarding.run': (plan: OnboardingInstallPlan) => { jobId: string };
  'import.detect': () => SetupImportCandidate[];
  'import.apply': (candidateId: string, what: { settings: boolean; saves: boolean; bios: boolean; romPaths: boolean; useInstallation: boolean }) => { summary: string[] };

  // Steam (non-Steam game shortcuts; see src/main/steam)
  'steam.status': (userId?: string | null) => SteamStatus;
  /** Adds/updates OmniPC shortcuts and artwork as a job. Steam must be closed. */
  'steam.sync': (opts: SteamSyncOptions) => { jobId: string };
  /** Removes only OmniPC's shortcuts (and the artwork OmniPC wrote). */
  'steam.removeAll': (opts: { userId?: string }) => SteamSyncResult;
  /** Asks Steam to exit (steam.exe -shutdown) and waits for it. */
  'steam.closeSteam': () => { closed: boolean };

  // Developer
  'dev.adapterReport': (emulatorId: string) => DevAdapterReport;
}

export type OmniMethod = keyof OmniApi;
export type OmniArgs<M extends OmniMethod> = Parameters<OmniApi[M]>;
export type OmniResult<M extends OmniMethod> = ReturnType<OmniApi[M]>;

/** Events pushed from main to renderer. */
export interface OmniEvents {
  'job.update': JobStatus;
  'download.update': DownloadItem;
  'notification': AppNotification;
  'launch.started': ActiveSession;
  'launch.ended': { launchId: number; gameId: number | null; outcome: LaunchRecord['outcome']; needsAnalysis: boolean };
  'library.changed': { reason: string };
  'emulators.changed': { id: string | null };
  'doctor.report': HealthReport;
  'drives.changed': { available: string[]; unavailable: string[] };
  'app.consoleMode': { enabled: boolean };
  'app.update': AppUpdateState;
}

export type OmniEventName = keyof OmniEvents;

/** Error payload transported over IPC (Electron strips custom error props). */
export interface IpcErrorPayload {
  __omniError: true;
  code: string;
  message: string;
  detail: import('./models').OmniError | null;
}
