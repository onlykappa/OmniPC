// Domain models shared between the main process and the renderer.
// Everything here must be structured-clone safe (plain objects, no classes).

import type { SystemId } from './systems';

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

export type GameAvailability = 'available' | 'drive_unavailable' | 'missing';

export type ValidationState = 'ok' | 'warning' | 'invalid' | 'unchecked';

export interface GameFile {
  path: string;
  sizeBytes: number;
  discNumber: number | null;
  validation: ValidationState;
  validationNote: string | null;
}

export interface GameSummary {
  id: number;
  title: string;
  systemId: SystemId;
  region: string | null;
  serial: string | null;
  discCount: number;
  availability: GameAvailability;
  favorite: boolean;
  lastPlayedAt: string | null;
  playTimeSeconds: number;
  addedAt: string;
  coverThumb: string | null;
  validation: ValidationState;
}

export interface GameMetadata {
  description: string | null;
  releaseYear: number | null;
  developer: string | null;
  publisher: string | null;
  genre: string | null;
  players: string | null;
  rating: string | null;
  coverPath: string | null;
  backgroundPath: string | null;
  screenshots: string[];
  source: string | null;
  sourceId: string | null;
  locked: boolean;
  fetchedAt: string | null;
}

export interface CompatibilityInfo {
  rating: 'perfect' | 'playable' | 'ingame' | 'menus' | 'intro' | 'nothing' | 'unknown';
  label: string;
  source: string;
  notes: string | null;
  recommendedEmulator: string | null;
}

export interface GameDetails extends GameSummary {
  files: GameFile[];
  primaryPath: string;
  metadata: GameMetadata;
  compatibility: CompatibilityInfo | null;
  emulatorId: string | null;
  emulatorOverride: string | null;
  profile: GameProfile | null;
  recentLaunches: LaunchRecord[];
  crashLoopPaused: boolean;
  saveLocations: SaveLocation[];
}

export interface LibraryQuery {
  search?: string;
  systemId?: SystemId | null;
  favoritesOnly?: boolean;
  sort?: 'title' | 'recent' | 'added' | 'playtime';
  includeUnavailable?: boolean;
  offset?: number;
  limit?: number;
}

export interface LibraryPage {
  total: number;
  items: GameSummary[];
}

export interface LibraryPath {
  id: number;
  path: string;
  volumeSerial: string | null;
  driveLetter: string | null;
  available: boolean;
  lastScanAt: string | null;
  gameCount: number;
}

export interface ScanSummary {
  rootPaths: string[];
  filesSeen: number;
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  markedUnavailable: number;
  bySystem: Record<string, number>;
  unrecognized: number;
  duplicates: DuplicateGroup[];
  durationMs: number;
}

export interface DuplicateGroup {
  key: string;
  reason: 'same_serial' | 'same_hash' | 'same_title';
  games: { id: number; title: string; path: string; sizeBytes: number }[];
}

export interface ImportPreview {
  path: string;
  total: number;
  bySystem: Record<string, number>;
  unrecognized: number;
  sample: { path: string; systemId: SystemId; title: string }[];
}

// ---------------------------------------------------------------------------
// Emulators
// ---------------------------------------------------------------------------

export type EmulatorInstallState = 'not_installed' | 'installed' | 'external' | 'custom';
export type HealthState = 'ready' | 'attention' | 'error' | 'unknown' | 'not_installed';

export interface EmulatorStatus {
  id: string;
  name: string;
  systems: SystemId[];
  implemented: boolean;
  plannedNote: string | null;
  installState: EmulatorInstallState;
  version: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  installDir: string | null;
  executable: string | null;
  health: HealthState;
  healthNote: string | null;
  customConfig: boolean;
  lastHealthCheckAt: string | null;
  website: string;
  license: string;
  rollbackVersion: string | null;
}

export interface EmulatorDetailsDto extends EmulatorStatus {
  manifest: EmulatorManifest;
  configFiles: { label: string; path: string; exists: boolean }[];
  logFiles: { label: string; path: string; exists: boolean }[];
  saveDirs: { label: string; path: string; exists: boolean }[];
  backups: ConfigBackup[];
  settings: EmulatorSettings;
  customSettings: CustomEmulatorSettings;
  versionHistory: { version: string; installedAt: string; source: string; status: string }[];
}

export interface EmulatorManifest {
  id: string;
  name: string;
  systems: SystemId[];
  website: string;
  repository: string | null;
  license: string;
  implemented: boolean;
  plannedNote?: string;
  download: {
    kind: 'github-release' | 'dolphin-update' | 'versioned-url' | 'none';
    repo?: string;
    /**
     * github-release: how the version is derived. 'tag' (default) uses the tag;
     * 'published-at' uses the publish time (YYYY.MM.DD.HHMM) plus the tag's trailing
     * commit hash, for projects that ship several dated builds per day.
     */
    versionFrom?: 'tag' | 'published-at';
    /** github-release: regex whose first group extracts the version from the asset name (overrides versionFrom). */
    versionPattern?: string;
    /** versioned-url: download URL with a {version} placeholder. */
    urlTemplate?: string;
    track?: string;
    assetPatterns?: string[];
    assetExclude?: string[];
    allowedHosts: string[];
  };
  executable: string;
  supportedExtensions: string[];
  dependencies: string[];
  configFiles: { label: string; path: string; format: 'ini' | 'json' | 'xml' | 'yaml' | 'other' }[];
  logFiles: { label: string; path: string }[];
  saveDirs: { label: string; path: string }[];
  biosRequirements: BiosRequirementSpec[];
  notes: string[];
  assumptions: string[];
}

export interface BiosRequirementSpec {
  systemId: SystemId;
  label: string;
  required: boolean;
  directory: string;
  filenames?: string[];
  validator: 'ps2-romdir' | 'size' | 'any-file' | 'none';
  sizes?: number[];
  note?: string;
}

export type PerformancePreset = 'performance' | 'balanced' | 'quality' | 'maximum';

export interface EmulatorSettings {
  preset: PerformancePreset;
  resolutionScale: number;
  renderer: string;
  aspectRatio: string;
  fullscreen: boolean;
  frameLimit: boolean;
  vsync: boolean;
  /** Free-form adapter-specific advanced values (section/key -> value). */
  advanced: Record<string, string>;
}

export interface CustomEmulatorSettings {
  customExecutable: string | null;
  customArgs: string | null;
  customConfigNote: string | null;
  /** When true OmniDoctor treats deviations from generated config as intentional. */
  customConfigActive: boolean;
}

export interface RendererOption {
  id: string;
  label: string;
  available: boolean;
  note?: string;
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export interface GameProfile {
  gameId: number;
  emulatorId: string | null;
  overrides: Partial<Omit<EmulatorSettings, 'advanced' | 'preset'>> & { advanced?: Record<string, string> };
  customArgs: string | null;
  notes: string | null;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Hardware / system scan
// ---------------------------------------------------------------------------

export interface GpuInfo {
  name: string;
  vendor: 'nvidia' | 'amd' | 'intel' | 'other';
  vramMB: number | null;
  driverVersion: string | null;
}

export interface DisplayInfo {
  width: number;
  height: number;
  refreshRate: number | null;
  scaleFactor: number;
  primary: boolean;
}

export interface DriveInfo {
  letter: string;
  label: string | null;
  fileSystem: string | null;
  totalBytes: number | null;
  freeBytes: number | null;
  type: 'fixed' | 'removable' | 'network' | 'cdrom' | 'unknown';
  volumeSerial: string | null;
}

export interface HardwareProfile {
  scannedAt: string;
  platform: string;
  osName: string;
  osVersion: string;
  osBuild: string | null;
  isWindows: boolean;
  cpu: { model: string; cores: number; threads: number; speedMHz: number; features: string[] };
  ramMB: number;
  gpus: GpuInfo[];
  displays: DisplayInfo[];
  drives: DriveInfo[];
  graphicsApis: { directx12: boolean | null; vulkan: boolean | null; opengl: boolean | null; notes: string[] };
  dependencies: DependencyStatus[];
  tier: 'low' | 'mid' | 'high' | 'enthusiast';
  tierReason: string;
  recommendedPreset: PerformancePreset;
}

export interface DependencyStatus {
  id: string;
  name: string;
  installed: boolean | null;
  version: string | null;
  detail: string;
  fixUrl: string | null;
}

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

export type ControllerKind = 'xbox' | 'dualsense' | 'dualshock4' | 'switch_pro' | 'generic';

export interface DetectedController {
  key: string;
  name: string;
  kind: ControllerKind;
  api: 'XInput' | 'DirectInput' | 'GameInput' | 'Unknown';
  connection: 'USB' | 'Bluetooth' | 'Unknown';
  battery: string | null;
  source: 'gamepad-api' | 'pnp';
  index: number | null;
}

export type UniversalButton =
  | 'A' | 'B' | 'X' | 'Y'
  | 'LB' | 'RB' | 'LT' | 'RT'
  | 'L3' | 'R3'
  | 'Start' | 'Select' | 'Guide'
  | 'DPadUp' | 'DPadDown' | 'DPadLeft' | 'DPadRight'
  | 'LeftStickUp' | 'LeftStickDown' | 'LeftStickLeft' | 'LeftStickRight'
  | 'RightStickUp' | 'RightStickDown' | 'RightStickLeft' | 'RightStickRight';

/**
 * The universal profile maps each logical button to the physical button the user
 * pressed for it during setup. Default is identity. Adapters translate the
 * physical buttons into emulator-specific binding syntax.
 */
export interface UniversalControllerProfile {
  id: number;
  name: string;
  controllerKind: ControllerKind;
  /** Player-1 device index as seen by SDL / XInput (0-based). */
  deviceIndex: number;
  mapping: Record<UniversalButton, UniversalButton>;
  /** Swap A/B and X/Y for Nintendo-layout systems. */
  nintendoLayoutForNintendoSystems: boolean;
  rumble: boolean;
  deadzone: number;
  perSystem: Partial<Record<SystemId, Partial<Record<UniversalButton, UniversalButton>>>>;
  updatedAt: string;
}

export type HotkeyAction = 'exit' | 'saveState' | 'loadState' | 'volumeUp' | 'volumeDown' | 'menu' | 'fastForward' | 'screenshot' | 'fullscreen';

export interface HotkeyConfig {
  modifier: UniversalButton;
  bindings: Record<HotkeyAction, UniversalButton>;
}

// ---------------------------------------------------------------------------
// Launching
// ---------------------------------------------------------------------------

export interface LaunchRecord {
  id: number;
  gameId: number | null;
  emulatorId: string;
  emulatorVersion: string | null;
  command: string;
  args: string[];
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  outcome: 'running' | 'ok' | 'crashed' | 'failed_to_start' | 'early_exit' | 'timeout' | 'killed';
  stderrTail: string | null;
}

export interface LaunchResult {
  ok: boolean;
  launchId: number | null;
  /** When the launch failed before a process existed, the reason. */
  error: OmniError | null;
  blockedByCrashLoop?: boolean;
  preflight?: Finding[];
}

export interface ActiveSession {
  launchId: number;
  gameId: number | null;
  gameTitle: string | null;
  emulatorId: string;
  startedAt: string;
  pid: number | null;
}

// ---------------------------------------------------------------------------
// Diagnostics / OmniDoctor
// ---------------------------------------------------------------------------

export type Severity = 'pass' | 'info' | 'warning' | 'problem';
export type Confidence = 'high' | 'medium' | 'low';
export type RepairSafety = 'safe' | 'low' | 'high' | 'never';

export type DiagnosticCategory =
  | 'windows'
  | 'graphics'
  | 'dependencies'
  | 'controllers'
  | 'storage'
  | 'library'
  | 'bios'
  | 'emulators'
  | 'configuration'
  | 'saves'
  | 'database'
  | 'metadata'
  | 'updates';

export interface RepairSuggestion {
  actionId: string;
  label: string;
  safety: RepairSafety;
  params: Record<string, unknown>;
  description: string;
}

export interface Finding {
  id: string;
  checkId: string;
  category: DiagnosticCategory;
  severity: Severity;
  title: string;
  detail: string;
  subject: { kind: 'system' | 'emulator' | 'game' | 'path' | 'controller' | 'app'; id: string; label: string } | null;
  evidence: string[];
  confidence: Confidence | null;
  repair: RepairSuggestion | null;
  manualSteps: string[];
  ruleId?: string;
}

export interface CategoryScore {
  category: DiagnosticCategory;
  label: string;
  score: number;
  passed: number;
  warnings: number;
  problems: number;
}

export interface HealthReport {
  id: number;
  runAt: string;
  durationMs: number;
  scope: 'full' | 'quick' | 'emulator';
  overall: number;
  categories: CategoryScore[];
  findings: Finding[];
  counts: { passed: number; info: number; warnings: number; problems: number };
}

export interface FailureAnalysis {
  launchId: number;
  gameId: number | null;
  gameTitle: string | null;
  emulatorId: string;
  headline: string;
  whatHappened: string;
  detected: string[];
  probableCause: string | null;
  confidence: Confidence | null;
  evidence: string[];
  findings: Finding[];
  primaryRepair: RepairSuggestion | null;
  userAction: string[];
  technical: { exitCode: number | null; durationMs: number | null; logPath: string | null; logExcerpt: string | null; args: string[] };
  correlatedChanges: ChangeEvent[];
  crashLoop: { failures: number; paused: boolean };
}

export interface RepairRecord {
  id: number;
  actionId: string;
  label: string;
  safety: RepairSafety;
  subject: string | null;
  startedAt: string;
  status: 'succeeded' | 'failed' | 'undone';
  message: string;
  details: string[];
  backupIds: number[];
  undoable: boolean;
  automatic: boolean;
}

export interface ChangeEvent {
  id: number;
  at: string;
  kind: string;
  subject: string | null;
  summary: string;
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

export interface ConfigBackup {
  id: number;
  emulatorId: string | null;
  label: string;
  reason: string;
  createdAt: string;
  path: string;
  files: string[];
  sizeBytes: number;
}

export interface ConfigDiff {
  backupId: number;
  files: { relPath: string; status: 'changed' | 'added' | 'removed' | 'same'; lines: { kind: '+' | '-' | ' '; text: string }[] }[];
}

// ---------------------------------------------------------------------------
// BIOS & firmware
// ---------------------------------------------------------------------------

export interface BiosStatus {
  systemId: SystemId;
  systemName: string;
  label: string;
  required: boolean;
  requirementKind: 'bios' | 'firmware' | 'keys';
  emulatorId: string;
  expectedLocation: string;
  status: 'found' | 'missing' | 'invalid' | 'not_applicable';
  files: { path: string; sizeBytes: number; valid: boolean; description: string }[];
  note: string;
}

// ---------------------------------------------------------------------------
// Saves / storage
// ---------------------------------------------------------------------------

export interface SaveLocation {
  emulatorId: string;
  label: string;
  path: string;
  exists: boolean;
  fileCount: number;
  sizeBytes: number;
  lastModified: string | null;
}

export interface SaveBackup {
  id: string;
  emulatorId: string;
  label: string;
  path: string;
  createdAt: string;
  sizeBytes: number;
}

export type StorageKey = 'emulators' | 'saves' | 'bios' | 'cache' | 'backups' | 'artwork' | 'downloads' | 'logs';

export interface StorageLocation {
  key: StorageKey;
  label: string;
  path: string;
  sizeBytes: number | null;
  freeBytes: number | null;
  relocatable: boolean;
}

// ---------------------------------------------------------------------------
// Downloads & jobs
// ---------------------------------------------------------------------------

export interface DownloadItem {
  id: string;
  name: string;
  source: string;
  url: string;
  version: string | null;
  totalBytes: number | null;
  receivedBytes: number;
  bytesPerSecond: number;
  status: 'queued' | 'downloading' | 'paused' | 'verifying' | 'completed' | 'failed' | 'cancelled';
  verification: string | null;
  error: string | null;
  createdAt: string;
}

export interface JobStatus {
  id: string;
  kind: string;
  label: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  progress: number | null;
  message: string;
  steps: { label: string; state: 'pending' | 'running' | 'done' | 'failed' | 'skipped'; detail?: string }[];
  cancellable: boolean;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Notifications / errors
// ---------------------------------------------------------------------------

export interface AppNotification {
  id: number;
  at: string;
  level: 'info' | 'success' | 'warning' | 'error';
  title: string;
  body: string;
  read: boolean;
  link: string | null;
}

/** Structured error shape. Never "Unknown Error" when context exists. */
export interface OmniError {
  code: string;
  whatHappened: string;
  detected: string[];
  probableCause: string | null;
  omniCanFix: RepairSuggestion | null;
  userAction: string[];
  technical: string | null;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface AppSettings {
  onboardingComplete: boolean;
  consoleModeOnStart: boolean;
  startWithWindows: boolean;
  reduceMotion: boolean;
  theme: 'dark';
  autoRepairSafeIssues: boolean;
  backgroundHealthChecks: boolean;
  metadataOnline: boolean;
  artworkProviders: string[];
  theGamesDbApiKey: string;
  updateChannel: 'stable' | 'nightly';
  checkUpdatesOnStart: boolean;
  defaultPreset: PerformancePreset;
  launchTimeoutSeconds: number;
  crashLoopThreshold: number;
  aiEnabled: boolean;
  aiProvider: 'none' | 'anthropic';
  aiApiKey: string;
  aiModel: string;
  hotkeys: HotkeyConfig;
  devMode: boolean;
}

export interface SettingDescriptor {
  key: string;
  section: string;
  label: string;
  description: string;
  keywords: string[];
  route: string;
}

export interface SearchResult {
  kind: 'game' | 'system' | 'emulator' | 'setting' | 'page';
  id: string;
  title: string;
  subtitle: string;
  route: string;
}

export interface AppInfo {
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  safeMode: boolean;
  dataRoot: string;
  databasePath: string;
  logPath: string;
  dbRecoveredFromBackup: boolean;
  isPackaged: boolean;
}

export interface SetupImportCandidate {
  id: string;
  source: 'pcsx2' | 'dolphin' | 'emudeck' | 'retroarch' | 'rpcs3' | 'cemu' | 'duckstation' | 'ppsspp' | 'kyty' | 'melonds' | 'xenia' | 'xemu';
  label: string;
  path: string;
  details: string[];
  importable: { settings: boolean; saves: boolean; bios: boolean; romPaths: boolean; useInstallation: boolean };
  romPaths: string[];
  /** Save folders to copy (never overwriting OmniDeck files), declared by the adapter. */
  saveCopies?: { from: string; to: string; label: string }[];
  /** BIOS folders whose files are offered to the BIOS importer for a system. */
  biosDirs?: { dir: string; systemId: string }[];
}

export interface AiContextPreview {
  json: string;
  redactions: string[];
  bytes: number;
}
