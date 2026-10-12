// "Copy setup" from another PC: applies a SetupExport received from a paired
// PC. Everything is validated field by field; secrets, accounts and
// machine-specific values (paths, start with Windows, onboarding state) are
// never taken, even if the other PC sent them. OmniPC's database is backed up
// and the current settings are snapshotted first, so the import can be undone.

import type { AppSettings, EmulatorSettings, GameProfile, UniversalControllerProfile } from '@shared/models';
import type { SetupExport } from '@shared/share';
import type { SetupImportResult } from '@shared/shareCopy';
import { errorMessage } from '../core/errors';
import { logger } from '../core/logger';

const log = logger.scope('share-setup');

export const SETUP_SNAPSHOT_KEY = 'share.setupSnapshot';

export interface SetupImportDeps {
  settings: { getAll(): AppSettings; set(patch: Partial<AppSettings>): AppSettings; setInternal(key: string, value: unknown): void };
  emulators: {
    isInstalled(id: string): boolean;
    settingsFor(id: string): EmulatorSettings;
    saveSettings(id: string, s: EmulatorSettings): Promise<void>;
    install(id: string): { jobId: string };
    applyControllerProfile(opts: { force: boolean }): Promise<unknown>;
  };
  /** True for emulators this OmniPC has an adapter for. */
  isKnownEmulator(id: string): boolean;
  ops: {
    getControllerProfile(): UniversalControllerProfile | null;
    saveControllerProfile(p: Omit<UniversalControllerProfile, 'id' | 'updatedAt'>): UniversalControllerProfile;
    saveGameProfile(p: Omit<GameProfile, 'updatedAt'>): GameProfile;
    addChange(kind: string, subject: string | null, summary: string, data?: unknown): unknown;
  };
  library: { allGames(): { id: number; system_id: string; title: string; serial: string | null }[] };
  /** Backs up OmniPC's database; returns the backup path. */
  backup(): Promise<string | null>;
}

/** Settings that describe preferences and can be carried between PCs. */
export const IMPORTABLE_SETTINGS = [
  'consoleModeOnStart',
  'reduceMotion',
  'autoRepairSafeIssues',
  'backgroundHealthChecks',
  'metadataOnline',
  'artworkProviders',
  'updateChannel',
  'checkUpdatesOnStart',
  'autoUpdateEmulators',
  'checkAppUpdatesOnStart',
  'defaultPreset',
  'launchTimeoutSeconds',
  'crashLoopThreshold',
  'hotkeys',
  'saveBackup',
] as const satisfies readonly (keyof AppSettings)[];

/** Never copied: secrets, accounts, machine-specific values. Listed for the UI and for tests. */
export const NEVER_COPIED_SETTINGS = ['aiApiKey', 'theGamesDbApiKey', 'retroAchievements', 'startWithWindows', 'onboardingComplete', 'devMode', 'aiEnabled', 'aiProvider', 'aiModel', 'theme'] as const;

const PRESETS = ['performance', 'balanced', 'quality', 'maximum'];
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const shortStr = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length <= max;
const finite = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
/** Values that point at this or another PC's files (drive letters, UNC, absolute paths). */
export const looksLikePath = (v: string): boolean => /^[a-z]:[\\/]/i.test(v) || /^\\\\/.test(v) || /^\//.test(v) || /^~[\\/]/.test(v);

/** The subset of `input` that may be applied on this PC (only keys present, validated). */
export function sanitizeSettings(input: unknown, current: AppSettings): Partial<AppSettings> {
  if (!isObj(input)) return {};
  const out: Partial<AppSettings> = {};
  const bool = (k: 'consoleModeOnStart' | 'reduceMotion' | 'autoRepairSafeIssues' | 'backgroundHealthChecks' | 'metadataOnline' | 'checkUpdatesOnStart' | 'autoUpdateEmulators' | 'checkAppUpdatesOnStart') => {
    if (typeof input[k] === 'boolean') out[k] = input[k];
  };
  for (const k of ['consoleModeOnStart', 'reduceMotion', 'autoRepairSafeIssues', 'backgroundHealthChecks', 'metadataOnline', 'checkUpdatesOnStart', 'autoUpdateEmulators', 'checkAppUpdatesOnStart'] as const) bool(k);
  if (Array.isArray(input.artworkProviders)) out.artworkProviders = input.artworkProviders.filter((p): p is string => shortStr(p, 64) && /^[\w-]+$/.test(p)).slice(0, 32);
  if (input.updateChannel === 'stable' || input.updateChannel === 'nightly') out.updateChannel = input.updateChannel;
  if (typeof input.defaultPreset === 'string' && PRESETS.includes(input.defaultPreset)) out.defaultPreset = input.defaultPreset as AppSettings['defaultPreset'];
  if (finite(input.launchTimeoutSeconds, 5, 600)) out.launchTimeoutSeconds = Math.round(input.launchTimeoutSeconds);
  if (finite(input.crashLoopThreshold, 1, 50)) out.crashLoopThreshold = Math.round(input.crashLoopThreshold);
  if (isObj(input.hotkeys) && shortStr(input.hotkeys.modifier, 32) && isObj(input.hotkeys.bindings)) {
    const bindings = { ...current.hotkeys.bindings };
    for (const k of Object.keys(bindings) as (keyof typeof bindings)[]) {
      const v = input.hotkeys.bindings[k];
      if (shortStr(v, 32)) bindings[k] = v as (typeof bindings)[typeof k];
    }
    out.hotkeys = { modifier: input.hotkeys.modifier as AppSettings['hotkeys']['modifier'], bindings };
  }
  if (isObj(input.saveBackup)) {
    const sb = input.saveBackup;
    const next = { ...current.saveBackup };
    if (sb.schedule === 'off' || sb.schedule === 'daily' || sb.schedule === 'weekly') next.schedule = sb.schedule;
    if (typeof sb.afterPlay === 'boolean') next.afterPlay = sb.afterPlay;
    if (typeof sb.beforeEmulatorUpdate === 'boolean') next.beforeEmulatorUpdate = sb.beforeEmulatorUpdate;
    if (finite(sb.keepPerEmulator, 1, 1000)) next.keepPerEmulator = Math.round(sb.keepPerEmulator);
    // `destination` is a folder on the other PC: never copied.
    out.saveBackup = next;
  }
  return out;
}

function sanitizeAdvanced(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObj(v)) return out;
  for (const [k, val] of Object.entries(v).slice(0, 500)) {
    if (!shortStr(k, 200) || typeof val !== 'string' || val.length > 1000 || looksLikePath(val)) continue;
    out[k] = val;
  }
  return out;
}

/** Applies valid fields from `input` onto this PC's current settings for the emulator. */
export function sanitizeEmulatorSettings(input: unknown, current: EmulatorSettings): EmulatorSettings | null {
  if (!isObj(input)) return null;
  const next: EmulatorSettings = { ...current, advanced: { ...current.advanced } };
  if (typeof input.preset === 'string' && PRESETS.includes(input.preset)) next.preset = input.preset as EmulatorSettings['preset'];
  if (finite(input.resolutionScale, 0.25, 16)) next.resolutionScale = input.resolutionScale;
  if (shortStr(input.renderer, 64)) next.renderer = input.renderer;
  if (shortStr(input.aspectRatio, 64)) next.aspectRatio = input.aspectRatio;
  for (const k of ['fullscreen', 'frameLimit', 'vsync'] as const) if (typeof input[k] === 'boolean') next[k] = input[k];
  Object.assign(next.advanced, sanitizeAdvanced(input.advanced));
  return next;
}

function sanitizeControllerProfile(input: unknown): Omit<UniversalControllerProfile, 'id' | 'updatedAt'> | null {
  if (!isObj(input) || !shortStr(input.name, 100) || !shortStr(input.controllerKind, 32) || !isObj(input.mapping)) return null;
  const strMap = (m: unknown) => (isObj(m) ? Object.fromEntries(Object.entries(m).filter(([k, v]) => shortStr(k, 32) && shortStr(v, 32))) : {});
  const perSystem = isObj(input.perSystem) ? Object.fromEntries(Object.entries(input.perSystem).filter(([k]) => shortStr(k, 32)).map(([k, v]) => [k, strMap(v)])) : {};
  return {
    name: input.name,
    controllerKind: input.controllerKind as UniversalControllerProfile['controllerKind'],
    deviceIndex: finite(input.deviceIndex, 0, 16) ? Math.round(input.deviceIndex) : 0,
    mapping: strMap(input.mapping) as UniversalControllerProfile['mapping'],
    nintendoLayoutForNintendoSystems: input.nintendoLayoutForNintendoSystems === true,
    rumble: input.rumble !== false,
    deadzone: finite(input.deadzone, 0, 1) ? input.deadzone : 0.15,
    perSystem: perSystem as UniversalControllerProfile['perSystem'],
  };
}

/** Case- and punctuation-insensitive title key. */
export function titleKey(title: string): string {
  return String(title ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function serialKey(serial: string | null | undefined): string {
  return String(serial ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Finds the local game for a (system, serial, title) identity. */
export function gameMatcher(games: { id: number; system_id: string; title: string; serial: string | null }[]): (systemId: string, serial: string | null, title: string) => number | null {
  const bySerial = new Map<string, number>();
  const byTitle = new Map<string, number>();
  for (const g of games) {
    if (g.serial && serialKey(g.serial)) bySerial.set(`${g.system_id}|${serialKey(g.serial)}`, g.id);
    const t = titleKey(g.title);
    if (t && !byTitle.has(`${g.system_id}|${t}`)) byTitle.set(`${g.system_id}|${t}`, g.id);
  }
  return (systemId, serial, title) => {
    if (serial && serialKey(serial)) {
      const hit = bySerial.get(`${systemId}|${serialKey(serial)}`);
      if (hit !== undefined) return hit;
    }
    return byTitle.get(`${systemId}|${titleKey(title)}`) ?? null;
  };
}

export class SetupImporter {
  constructor(private readonly d: SetupImportDeps) {}

  async apply(exp: SetupExport, fromName: string): Promise<SetupImportResult> {
    const result: SetupImportResult = { settingsApplied: [], emulatorSettingsApplied: [], installsQueued: [], controllerProfileApplied: false, profilesMatched: 0, profilesUnmatched: 0, backupPath: null, notes: [] };
    if (!isObj(exp)) throw new Error('The setup from the other PC could not be read.');

    // Undo point: database backup plus a snapshot of the current settings.
    const before = this.d.settings.getAll();
    result.backupPath = await this.d.backup().catch((e) => { log.warn('database backup before setup import failed', { error: errorMessage(e) }); return null; });
    this.d.settings.setInternal(SETUP_SNAPSHOT_KEY, { at: new Date().toISOString(), from: fromName, settings: before, controllerProfile: this.d.ops.getControllerProfile(), backupPath: result.backupPath });

    // 1. OmniPC settings: only importable keys that are present.
    const patch = sanitizeSettings(exp.settings, before);
    if (Object.keys(patch).length) {
      this.d.settings.set(patch);
      result.settingsApplied = Object.keys(patch);
    }

    // 2. Emulator settings, and installs of emulators missing here.
    for (const e of Array.isArray(exp.emulators) ? exp.emulators : []) {
      if (!isObj(e) || typeof e.id !== 'string' || !this.d.isKnownEmulator(e.id)) {
        if (isObj(e) && typeof e.id === 'string') result.notes.push(`${e.id}: not available in this version of OmniPC`);
        continue;
      }
      const next = sanitizeEmulatorSettings(e.settings, this.d.emulators.settingsFor(e.id));
      if (next) {
        try {
          await this.d.emulators.saveSettings(e.id, next);
          result.emulatorSettingsApplied.push(e.id);
        } catch (err) {
          result.notes.push(`${e.id} settings: ${errorMessage(err)}`);
        }
      }
      if (e.installed === true && !this.d.emulators.isInstalled(e.id)) {
        try {
          // Installs download from each emulator's official source, as usual.
          const { jobId } = this.d.emulators.install(e.id);
          result.installsQueued.push({ emulatorId: e.id, jobId });
        } catch (err) {
          result.notes.push(`${e.id} install: ${errorMessage(err)}`);
        }
      }
    }

    // 3. Controller profile.
    const profile = sanitizeControllerProfile(exp.controllerProfile);
    if (profile) {
      this.d.ops.saveControllerProfile(profile);
      result.controllerProfileApplied = true;
      await this.d.emulators.applyControllerProfile({ force: false }).catch((err) => result.notes.push(`Controller: ${errorMessage(err)}`));
    }

    // 4. Per-game profiles, matched to this PC's games.
    const match = gameMatcher(this.d.library.allGames());
    for (const p of Array.isArray(exp.profiles) ? exp.profiles : []) {
      if (!isObj(p) || typeof p.systemId !== 'string' || typeof p.title !== 'string' || !isObj(p.profile)) continue;
      const gameId = match(p.systemId, typeof p.serial === 'string' ? p.serial : null, p.title);
      if (gameId === null) {
        result.profilesUnmatched++;
        continue;
      }
      const src = p.profile as Record<string, unknown>;
      const ov = isObj(src.overrides) ? src.overrides : {};
      const overrides: GameProfile['overrides'] = {};
      if (finite(ov.resolutionScale, 0.25, 16)) overrides.resolutionScale = ov.resolutionScale;
      if (shortStr(ov.renderer, 64)) overrides.renderer = ov.renderer;
      if (shortStr(ov.aspectRatio, 64)) overrides.aspectRatio = ov.aspectRatio;
      for (const k of ['fullscreen', 'frameLimit', 'vsync'] as const) if (typeof ov[k] === 'boolean') overrides[k] = ov[k];
      const adv = sanitizeAdvanced(ov.advanced);
      if (Object.keys(adv).length) overrides.advanced = adv;
      this.d.ops.saveGameProfile({
        gameId,
        emulatorId: typeof src.emulatorId === 'string' && this.d.isKnownEmulator(src.emulatorId) ? src.emulatorId : null,
        overrides,
        // Custom command-line arguments are not copied: OmniPC never runs anything it received.
        customArgs: null,
        notes: shortStr(src.notes, 2000) ? src.notes : null,
      });
      result.profilesMatched++;
    }

    const parts = [
      result.settingsApplied.length ? `${result.settingsApplied.length} setting(s)` : '',
      result.emulatorSettingsApplied.length ? `${result.emulatorSettingsApplied.length} emulator(s) configured` : '',
      result.installsQueued.length ? `${result.installsQueued.length} install(s) queued` : '',
      result.controllerProfileApplied ? 'controller profile' : '',
      result.profilesMatched ? `${result.profilesMatched} game profile(s)` : '',
    ].filter(Boolean);
    this.d.ops.addChange('share.setup', null, `Setup copied from ${fromName}: ${parts.join(', ') || 'nothing to apply'}`, { backupPath: result.backupPath });
    return result;
  }
}
