// The emulator adapter contract. Core services (installer, launch router,
// OmniDoctor, repair engine) only talk to adapters through this interface, so
// adding an emulator means adding an adapter + manifest, not editing the core.

import type {
  BiosStatus,
  EmulatorManifest,
  EmulatorSettings,
  Finding,
  GameProfile,
  HardwareProfile,
  HotkeyAction,
  HotkeyConfig,
  PerformancePreset,
  RendererOption,
  SetupImportCandidate,
  UniversalControllerProfile,
} from '@shared/models';
import type { SystemId } from '@shared/systems';
import type { BackupTarget } from '../config/backups';
import type { AppPaths } from '../core/paths';

export interface AdapterPaths {
  /** Program files (replaced on update). */
  app: string;
  /** Emulator user data/config root (survives updates). */
  data: string;
  saves: string;
  bios: string;
  cache: string;
}

export interface LaunchTarget {
  gameId: number | null;
  path: string;
  systemId: SystemId;
  serial: string | null;
  title: string;
}

export interface LaunchCommand {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  /**
   * How many trailing args form the game target (default 1). Emulator-level
   * custom args are inserted before them, e.g. 2 for "-dvd_path <game>".
   */
  targetArgs?: number;
  /** Emulator log written during this session (for failure analysis). */
  logFile: string | null;
  /** Steps executed right before spawning (e.g. session config overrides). */
  prepare?: () => Promise<void>;
  /** Always executed after the process exits (even on crash). */
  cleanup?: () => Promise<void>;
  notes: string[];
}

export interface ConfigWriteResult {
  changed: string[];
  notes: string[];
}

export interface ConfigInspection {
  files: { label: string; path: string; exists: boolean; parseOk: boolean; issues: string[] }[];
  /** Managed values that differ from what OmniDeck expects (paths, folders). */
  drift: { file: string; key: string; expected: string; actual: string | null; critical: boolean }[];
}

export interface SmokeTestResult {
  ran: boolean;
  ok: boolean;
  checks: { label: string; ok: boolean; detail: string }[];
}

export interface ConfigInput {
  settings: EmulatorSettings;
  controller: UniversalControllerProfile;
  hotkeys: HotkeyConfig;
  hardware: HardwareProfile | null;
}

export interface AdapterCapabilities {
  /** native = emulator supports per-game override files/args; session = OmniDeck applies and restores; none */
  perGameProfiles: 'native' | 'session' | 'none';
  frameLimit: boolean;
  vsync: boolean;
  aspectRatios: { id: string; label: string }[];
  hotkeys: HotkeyAction[];
  smokeTest: boolean;
  maxResolutionScale: number;
}

export interface EmulatorAdapter {
  readonly manifest: EmulatorManifest;
  readonly capabilities: AdapterCapabilities;

  paths(): AdapterPaths;
  /** Locates the main executable inside an install directory. */
  findExecutable(appDir: string): Promise<string | null>;
  /** Reads the installed version from the binary when possible. */
  detectVersion(executable: string): Promise<string | null>;
  renderers(hw: HardwareProfile | null): RendererOption[];
  defaultSettings(hw: HardwareProfile | null, preset: PerformancePreset): EmulatorSettings;

  /** Files OmniDeck may modify; these are snapshotted before every change. */
  configTargets(): BackupTarget[];
  /** Creates folders and writes OmniDeck-managed settings (merging with user settings). */
  applyConfig(input: ConfigInput, scope: 'all' | 'controller' | 'graphics' | 'paths'): Promise<ConfigWriteResult>;
  inspectConfig(): Promise<ConfigInspection>;

  buildLaunch(target: LaunchTarget, executable: string, settings: EmulatorSettings, profile: GameProfile | null, version: string | null): Promise<LaunchCommand>;
  buildUiLaunch(executable: string): LaunchCommand;

  smokeTest(executable: string): Promise<SmokeTestResult>;
  /** Emulator-specific environment checks beyond the generic ones. */
  validateEnvironment(hw: HardwareProfile | null, executable: string | null): Promise<Finding[]>;

  saveLocations(): { label: string; path: string }[];
  biosStatus(): Promise<BiosStatus[]>;
  logFile(): string | null;
  /** Caches that can be cleared safely (shader caches etc). */
  cacheDirs(): { label: string; path: string }[];
  /** Restores any session overrides left behind by a crash. */
  recoverSession(): Promise<string[]>;
  /** Finds pre-existing installations of this emulator on the PC. */
  detectExistingSetups(): Promise<SetupImportCandidate[]>;

  /**
   * Optional: runs after program files are placed in `appDir` (install,
   * update, rollback), e.g. to write a portable-mode marker. Returns notes.
   */
  prepareInstall?(appDir: string): Promise<string[]>;
  /**
   * Optional: paths relative to the app dir that hold user data for emulators
   * that can only keep data next to their executable. They are carried over on
   * update/rollback and moved to the data folder (never deleted) on uninstall.
   */
  persistentAppPaths?(): string[];
  /**
   * Optional: extra downloads after the main install (e.g. RetroArch cores).
   * Every URL must be on the manifest's allowedHosts; nothing downloaded is executed.
   */
  installComponents?(installer: ComponentInstaller, input: ConfigInput): Promise<string[]>;
}

export interface ComponentInstaller {
  /** Downloads `url` (allowedHosts-checked, SHA-256 recorded/verified) and returns the local file. */
  download(opts: { name: string; url: string; fileName: string; expectedSha256?: string | null }): Promise<string>;
  /** Extracts an archive with path sanitising. */
  extract(archive: string, dest: string): Promise<void>;
  /** Removes a downloaded temp file. */
  cleanup(file: string): Promise<void>;
  progress(message: string): void;
  signal?: AbortSignal;
}

export interface AdapterDeps {
  paths: AppPaths;
}

/** Expand {data}/{saves}/{bios}/{app} placeholders from the manifest. */
export function expandManifestPath(template: string, p: AdapterPaths, biosRoot: string): string {
  return template
    .replace('{data}', p.data)
    .replace('{saves}', p.saves)
    .replace('{app}', p.app)
    .replace('{cache}', p.cache)
    .replace('{bios}', biosRoot)
    .replace(/[\\/]+/g, process.platform === 'win32' ? '\\' : '/');
}
