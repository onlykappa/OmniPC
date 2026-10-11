// Ryujinx adapter (Nintendo Switch), for Ryubing: the community-maintained continuation of
// Ryujinx (MIT, https://git.ryujinx.app/projects/Ryubing) after the original project was
// discontinued in October 2024. Upstream source references in this file are paths in that
// repository (verified at master 793ca017, 2026-08-05; config format version 73).
//
// Layout:
//   Emulators/ryujinx/app            Ryujinx.exe (self-contained single-file .NET build).
//                                    Ryujinx also creates app/Logs (log folder for every
//                                    non-portable launch mode on Windows, AppDataManager.SetUpLogsDir).
//   Emulators/ryujinx/data           data root, passed with "-r <dir>" (--root-data-dir,
//                                    AppDataManager.Initialize LaunchMode.Custom) on every launch:
//     Config.json                    settings (Program.ReloadConfig: <data>/Config.json)
//     system/prod.keys, title.keys   keys (AppDataManager.KeysDirPath), copied from BIOS/switch
//     bis/system/Contents/registered installed firmware (ContentManager.InstallFirmware)
//     bis/user/save                  game saves (emulated NAND; not relocatable: AppDataManager
//                                    CustomNandPath is an unimplemented TODO)
//     games/<title id>/              per-game cache (cache/cpu = PPTC, cache/shader), updates.json,
//                                    dlc.json, mods.json, optional per-game Config.json
//   BIOS/switch                      user-supplied prod.keys / title.keys (+ optional firmware dump)

import { existsSync, readdirSync, statSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import type { BiosStatus, EmulatorManifest, EmulatorSettings, Finding, GameProfile, HardwareProfile, PerformancePreset, RendererOption, SetupImportCandidate, UniversalButton, UniversalControllerProfile } from '@shared/models';
import manifestJson from '../manifests/ryujinx.json';
import type { AdapterCapabilities, AdapterPaths, ConfigInput, ConfigInspection, ConfigWriteResult, EmulatorAdapter, LaunchCommand, LaunchTarget, SmokeTestResult } from '../adapter';
import type { AppPaths } from '../../core/paths';
import type { BackupTarget } from '../../config/backups';
import { atomicWrite } from '../../config/iniFile';
import { physicalFor } from '../../controllers/translate';
import { findExeIn } from '../common';
import { fileVersion, isWindows } from '../../platform/powershell';
import { splitArgs } from '../pcsx2/adapter';
import { MANAGED_TYPES, REQUIRED_KEYS, RYUJINX_CONFIG_VERSION, VSYNC_MODE, defaultRyujinxConfig, hasType, isObject, parseConfig, serializeConfig, setKey, type Json, type JsonObject } from './config';

export const RYUJINX_MANIFEST = manifestJson as unknown as EmulatorManifest;

const ID = 'ryujinx';

/** OmniPC aspect ratio ids -> Ryujinx AspectRatio enum names (src/Ryujinx.Common/Configuration/AspectRatioExtensions.cs). */
export const RYUJINX_ASPECT: Record<string, string> = {
  '4:3': 'Fixed4x3', '16:9': 'Fixed16x9', '16:10': 'Fixed16x10', '21:9': 'Fixed21x9', '32:9': 'Fixed32x9', stretch: 'Stretched',
};

/** GraphicsBackend enum names (src/Ryujinx.Common/Configuration/GraphicsBackend.cs). */
export const RYUJINX_BACKEND: Record<string, string> = { vulkan: 'Vulkan', opengl: 'OpenGl' };

/**
 * Universal (physical) buttons -> GamepadInputId names (src/Ryujinx.Common/Configuration/Hid/Controller/GamepadInputId.cs).
 * SDL3Gamepad maps A/B/X/Y by the button LABEL (SDL_GetGamepadButtonLabel), so "A" is the button printed A on an
 * Xbox pad (bottom) and Cross on a PlayStation pad. Back = Minus and Start = Plus share values. Stick directions
 * have no button id (a stick is bound as a whole), so they are not bindable to buttons.
 */
export const GAMEPAD_INPUT: Partial<Record<UniversalButton, string>> = {
  A: 'A', B: 'B', X: 'X', Y: 'Y',
  LB: 'LeftShoulder', RB: 'RightShoulder', LT: 'LeftTrigger', RT: 'RightTrigger',
  L3: 'LeftStick', R3: 'RightStick',
  Start: 'Plus', Select: 'Minus', Guide: 'Guide',
  DPadUp: 'DpadUp', DPadDown: 'DpadDown', DPadLeft: 'DpadLeft', DPadRight: 'DpadRight',
};

/**
 * Switch outputs -> logical universal button. Like the other Nintendo adapters (Cemu VPAD_MAP), Nintendo
 * buttons map by label (Switch A = universal A). The profile's nintendoLayoutForNintendoSystems flag swaps
 * to positional A/B X/Y (Ryujinx's own default for non-Nintendo pads, InputConfigDefaults isNintendoStyle).
 */
const SWITCH_BUTTONS: [group: 'left_joycon' | 'right_joycon', key: string, logical: UniversalButton][] = [
  ['left_joycon', 'dpad_up', 'DPadUp'], ['left_joycon', 'dpad_down', 'DPadDown'], ['left_joycon', 'dpad_left', 'DPadLeft'], ['left_joycon', 'dpad_right', 'DPadRight'],
  ['left_joycon', 'button_minus', 'Select'], ['left_joycon', 'button_l', 'LB'], ['left_joycon', 'button_zl', 'LT'],
  ['right_joycon', 'button_a', 'A'], ['right_joycon', 'button_b', 'B'], ['right_joycon', 'button_x', 'X'], ['right_joycon', 'button_y', 'Y'],
  ['right_joycon', 'button_plus', 'Start'], ['right_joycon', 'button_r', 'RB'], ['right_joycon', 'button_zr', 'RT'],
];

/** CLI options OmniPC controls (src/Ryujinx/Utilities/CommandLineState.cs ParseArguments, Program.Main). */
const RESERVED_WITH_VALUE = new Set(['-r', '--root-data-dir', '--install-firmware']);
const RESERVED_FLAGS = new Set(['-f', '--fullscreen', '--no-gui', 'nogui']);

/** Fields of the session journal: Config.json key -> original value (undefined = key was absent). */
type Journal = Record<string, Json | { __omnipcAbsent: true }>;

export class RyujinxAdapter implements EmulatorAdapter {
  readonly manifest = RYUJINX_MANIFEST;
  readonly capabilities: AdapterCapabilities = {
    perGameProfiles: 'session',
    // VSyncMode Switch = 60 Hz frame limit with vsync, Unbounded = neither; they cannot be set separately.
    frameLimit: false,
    vsync: true,
    aspectRatios: [
      { id: '16:9', label: '16:9 (Switch)' },
      { id: '16:10', label: '16:10' },
      { id: '21:9', label: '21:9' },
      { id: '32:9', label: '32:9' },
      { id: '4:3', label: '4:3' },
      { id: 'stretch', label: 'Stretch to window' },
    ],
    // Ryujinx hotkeys are keyboard keys only (KeyboardHotkeys, AppHost.GetHotkeyState); no controller chords.
    hotkeys: [],
    smokeTest: true,
    maxResolutionScale: 4,
  };

  constructor(private readonly app: AppPaths) {}

  paths(): AdapterPaths {
    return {
      app: this.app.emulatorAppDir(ID),
      data: this.app.emulatorDataDir(ID),
      saves: this.app.emulatorSaveDir(ID),
      bios: this.app.systemBiosDir('switch'),
      cache: this.app.emulatorCacheDir(ID),
    };
  }

  configPath(): string {
    return join(this.paths().data, 'Config.json');
  }

  keysDir(): string {
    return join(this.paths().data, 'system');
  }

  firmwareDir(): string {
    return join(this.paths().data, 'bis', 'system', 'Contents', 'registered');
  }

  saveDir(): string {
    return join(this.paths().data, 'bis', 'user', 'save');
  }

  logsDir(): string {
    return join(this.paths().app, 'Logs');
  }

  /** Optional place for the user's own firmware dump (folder of .nca files or a firmware .zip), used for the guided install. */
  firmwareSourceDir(): string {
    return join(this.paths().bios, 'firmware');
  }

  async findExecutable(appDir: string): Promise<string | null> {
    return findExeIn(appDir, [/^Ryujinx\.exe$/i, /^Ryujinx$/]);
  }

  /**
   * CI publishes with -p:Version=<x.y.z> (.forgejo/workflows/release.yml), giving FileVersion x.y.z.0.
   * Fallback: the newest log name Ryujinx_<version>_<date>.log (FileLogTarget.PrepareLogFile).
   */
  async detectVersion(executable: string): Promise<string | null> {
    const v = await fileVersion(executable);
    const m = v ? /^v?(\d+\.\d+\.\d+)(?:\.0)?(?=$|[^\d.])/.exec(v.trim()) : null;
    if (m && m[1] !== '1.0.0') return m[1];
    const logs = join(dirname(executable), 'Logs');
    const names = existsSync(logs) ? await readdir(logs).catch(() => [] as string[]) : [];
    const versions = names.map((n) => /^Ryujinx(?:_Canary)?_(\d+\.\d+\.\d+)_/.exec(n)?.[1]).filter((x): x is string => !!x);
    return versions.length ? versions.sort(compareVersions).pop()! : null;
  }

  renderers(hw: HardwareProfile | null): RendererOption[] {
    const vk = hw?.graphicsApis.vulkan;
    return [
      { id: 'vulkan', label: 'Vulkan (recommended)', available: vk !== false, note: vk === false ? 'No Vulkan driver detected' : undefined },
      { id: 'opengl', label: 'OpenGL', available: true },
    ];
  }

  defaultSettings(hw: HardwareProfile | null, preset: PerformancePreset): EmulatorSettings {
    return {
      preset,
      resolutionScale: ryujinxResolutionScale(hw, preset),
      renderer: hw?.graphicsApis.vulkan === false ? 'opengl' : 'vulkan',
      aspectRatio: '16:9',
      fullscreen: true,
      frameLimit: true,
      vsync: true,
      advanced: {},
    };
  }

  configTargets(): BackupTarget[] {
    const root = this.paths().data;
    return [{ root, path: this.configPath() }];
  }

  async ensureDirs(): Promise<void> {
    const p = this.paths();
    for (const d of [p.data, this.keysDir(), p.bios, p.cache]) await mkdir(d, { recursive: true });
  }

  /** Values that suppress modal dialogs; see manifest assumptions for the source of each. */
  promptValues(): Record<string, Json> {
    return {
      update_checker_type: 'Off',
      check_updates_on_start: false,
      show_confirm_exit: false,
      show_console: false,
      logging_enable_trace: false,
      graphics_shaders_dump_path: '',
      skip_user_profiles: true,
      ignore_applet: true,
      enable_file_log: true,
    };
  }

  graphicsValues(s: EmulatorSettings): Record<string, Json> {
    const scale = Number.isFinite(s.resolutionScale) && s.resolutionScale > 0 ? s.resolutionScale : 1;
    const integer = Number.isInteger(scale) && scale >= 1 && scale <= 4;
    return {
      graphics_backend: RYUJINX_BACKEND[s.renderer] ?? RYUJINX_BACKEND.vulkan,
      // res_scale 1..4 = 1x..4x, -1 = custom factor in res_scale_custom (SettingsViewModel, MainWindow.UpdateGraphicsConfig).
      res_scale: integer ? scale : -1,
      ...(integer ? {} : { res_scale_custom: Math.min(8, Math.round(scale * 100) / 100) }),
      vsync_mode: s.vsync ? VSYNC_MODE.switch : VSYNC_MODE.unbounded,
      aspect_ratio: RYUJINX_ASPECT[s.aspectRatio] ?? RYUJINX_ASPECT['16:9'],
      start_fullscreen: s.fullscreen,
    };
  }

  async readConfig(): Promise<{ doc: JsonObject | null; existed: boolean }> {
    const file = this.configPath();
    if (!existsSync(file)) return { doc: null, existed: false };
    return { doc: parseConfig(await readFile(file, 'utf8').catch(() => '')), existed: true };
  }

  async applyConfig(input: ConfigInput, scope: 'all' | 'controller' | 'graphics' | 'paths'): Promise<ConfigWriteResult> {
    await this.ensureDirs();
    const notes: string[] = [];
    const changed: string[] = [];
    const { doc: parsed, existed } = await this.readConfig();
    let doc: JsonObject;
    if (parsed && REQUIRED_KEYS.every((k) => parsed[k] !== undefined)) {
      doc = parsed;
    } else {
      doc = defaultRyujinxConfig();
      if (parsed) {
        // Keep the user's keys on top of a complete default file.
        for (const [k, v] of Object.entries(parsed)) doc[k] = v;
        notes.push('Config.json was incomplete; missing settings were filled with Ryujinx defaults.');
      } else if (existed) {
        notes.push('Config.json could not be parsed and was recreated (the previous file is kept in the configuration backup).');
      } else {
        notes.push('Created Ryujinx Config.json (update check, exit confirmation and console window turned off).');
      }
      changed.push('Config.json created');
    }
    const set = (k: string, v: Json) => {
      if (setKey(doc, k, v)) changed.push(`Config.json ${k} = ${JSON.stringify(v)}`);
    };

    if (scope === 'all' || scope === 'paths') {
      for (const [k, v] of Object.entries(this.promptValues())) set(k, v);
      const keys = await this.syncKeys();
      changed.push(...keys.changed);
      notes.push(...keys.notes);
    }
    if (scope === 'all' || scope === 'graphics') {
      for (const [k, v] of Object.entries(this.graphicsValues(input.settings))) set(k, v);
      if (doc.docked_mode === undefined) set('docked_mode', true);
      for (const [k, v] of Object.entries(advancedValues(input.settings.advanced ?? {}, doc))) set(k, v);
    }
    if (scope === 'all' || scope === 'controller') {
      const r = applyController(doc, input.controller);
      changed.push(...r.changed);
      notes.push(...r.notes);
    }

    if (changed.some((c) => c.startsWith('Config.json'))) await atomicWrite(this.configPath(), serializeConfig(doc));
    return { changed, notes };
  }

  /** Controller-only update of an existing Config.json (creates a complete one first if needed). */
  async applyController(controller: UniversalControllerProfile): Promise<ConfigWriteResult> {
    const { doc: parsed } = await this.readConfig();
    const complete = !!parsed && REQUIRED_KEYS.every((k) => parsed[k] !== undefined);
    const doc: JsonObject = complete ? parsed! : { ...defaultRyujinxConfig(), ...(parsed ?? {}) };
    const r = applyController(doc, controller);
    if (!complete) r.changed.unshift('Config.json created');
    if (r.changed.length) {
      await this.ensureDirs();
      await atomicWrite(this.configPath(), serializeConfig(doc));
    }
    return r;
  }

  /**
   * Copies prod.keys / title.keys / console.keys from BIOS/switch into <data>/system, the only
   * key folder Ryujinx reads in custom-data-dir mode (VirtualFileSystem.ReloadKeySet; ~/.switch is
   * only read in UserProfile mode). Keys found only in <data>/system are left alone.
   */
  async syncKeys(): Promise<{ changed: string[]; notes: string[] }> {
    const changed: string[] = [];
    const notes: string[] = [];
    for (const name of ['prod.keys', 'title.keys', 'console.keys']) {
      const src = join(this.paths().bios, name);
      const st = await stat(src).catch(() => null);
      if (!st?.isFile()) continue;
      const text = await readFile(src, 'utf8').catch(() => '');
      if (name === 'prod.keys' && !parseKeyFile(text).hasHeaderKey) {
        notes.push(`${src} does not contain header_key; it was not copied. Dump prod.keys again from your Switch.`);
        continue;
      }
      const dst = join(this.keysDir(), name);
      if (existsSync(dst) && (await readFile(dst)).equals(await readFile(src))) continue;
      await mkdir(this.keysDir(), { recursive: true });
      await copyFile(src, dst);
      changed.push(`${name} copied to ${this.keysDir()}`);
    }
    return { changed, notes };
  }

  async inspectConfig(): Promise<ConfigInspection> {
    const file = this.configPath();
    const exists = existsSync(file);
    const text = exists ? await readFile(file, 'utf8').catch(() => '') : '';
    const doc = exists ? parseConfig(text) : null;
    const issues: string[] = [];
    if (!exists) issues.push('File does not exist');
    else if (!doc) issues.push('Not a valid JSON object; Ryujinx would rename it to Config.json.<date>.invalid and start with defaults');
    if (doc) {
      for (const k of REQUIRED_KEYS) if (doc[k] === undefined) issues.push(`Missing "${k}"; Ryujinx cannot load a partial Config.json`);
      for (const [k, t] of Object.entries(MANAGED_TYPES)) {
        const v = doc[k];
        if (v !== undefined && v !== null && !hasType(v, t)) issues.push(`${k} must be ${t === 'integer' ? 'an integer' : `a ${t}`}`);
      }
      const ver = doc.version;
      if (typeof ver === 'number' && ver > RYUJINX_CONFIG_VERSION) issues.push(`Config version ${ver} is newer than OmniPC knows (${RYUJINX_CONFIG_VERSION}); managed keys are still applied.`);
    }
    const files: ConfigInspection['files'] = [{ label: 'Config.json', path: file, exists, parseOk: !!doc && issues.length === 0, issues }];
    const drift: ConfigInspection['drift'] = [];
    if (!exists) drift.push({ file, key: 'Config.json', expected: 'present', actual: null, critical: true });
    if (doc) {
      for (const [k, v] of Object.entries(this.promptValues())) {
        if (k === 'enable_file_log' || k === 'skip_user_profiles' || k === 'ignore_applet') continue;
        if (JSON.stringify(doc[k]) !== JSON.stringify(v)) {
          // Each of these shows a modal dialog that blocks a fullscreen launch.
          drift.push({ file, key: k, expected: JSON.stringify(v), actual: doc[k] === undefined ? null : JSON.stringify(doc[k]), critical: k !== 'show_console' && k !== 'check_updates_on_start' });
        }
      }
    }
    // A Config.json next to Ryujinx.exe wins over <data>/Config.json (Program.ReloadConfig localConfigurationPath).
    const local = join(this.paths().app, 'Config.json');
    if (existsSync(local)) drift.push({ file: local, key: 'Config.json next to Ryujinx.exe', expected: 'absent (OmniPC uses the data folder)', actual: local, critical: true });
    const invalid = (existsSync(this.paths().data) ? await readdir(this.paths().data).catch(() => [] as string[]) : []).filter((n) => /^Config\.json\..+\.invalid$/.test(n));
    if (invalid.length) files[0].issues.push(`Ryujinx rejected an earlier Config.json (${invalid.sort().pop()}); usually the installed Ryujinx is older than config version ${RYUJINX_CONFIG_VERSION}.`);
    if (!existsSync(join(this.keysDir(), 'prod.keys')) && existsSync(join(this.paths().bios, 'prod.keys'))) {
      drift.push({ file: join(this.keysDir(), 'prod.keys'), key: 'prod.keys', expected: `copy of ${join(this.paths().bios, 'prod.keys')}`, actual: null, critical: true });
    }
    return { files, drift };
  }

  /** Drops options OmniPC controls. Every unrecognised argument would become the game path (CommandLineState default case). */
  sanitizeCustomArgs(raw: string): { args: string[]; dropped: string[] } {
    const args: string[] = [];
    const dropped: string[] = [];
    const parts = splitArgs(raw);
    for (let i = 0; i < parts.length; i++) {
      const a = parts[i];
      if (RESERVED_WITH_VALUE.has(a)) {
        dropped.push(a);
        if (i + 1 < parts.length) dropped.push(parts[++i]);
      } else if (RESERVED_FLAGS.has(a)) dropped.push(a);
      else args.push(a);
    }
    return { args, dropped };
  }

  async buildLaunch(target: LaunchTarget, executable: string, settings: EmulatorSettings, profile: GameProfile | null, _version: string | null): Promise<LaunchCommand> {
    const notes: string[] = [];
    const merged = profile ? { ...settings, ...(profile.overrides as Partial<EmulatorSettings>) } : settings;
    // -r: data root; --hide-updates: never show the update notification (MainWindow.CheckLaunchState);
    // -f: start the game fullscreen (MainWindow.SwitchToGameControl).
    const args = ['-r', this.paths().data, '--hide-updates'];
    if (merged.fullscreen) args.push('-f');
    if (profile?.customArgs) {
      const { args: extra, dropped } = this.sanitizeCustomArgs(profile.customArgs);
      args.push(...extra);
      if (dropped.length) notes.push(`Ignored custom arguments OmniPC controls (data folder, fullscreen, firmware install, headless mode): ${dropped.join(' ')}`);
    }
    // The game path is the last positional argument (CommandLineState default case -> MainWindow.DeferLoadApplication).
    args.push(target.path);
    const overrides = profile ? this.profileOverrides(settings, profile) : {};
    const hasOverrides = Object.keys(overrides).length > 0;
    if (hasOverrides) notes.push(`Per-game profile applied for this session only (${Object.keys(overrides).join(', ')}); Config.json is restored when Ryujinx exits.`);
    notes.push('In Ryujinx, Escape leaves fullscreen and a second Escape stops the game (back to the Ryujinx game list); close the window (Alt+F4) to exit Ryujinx.');
    return {
      command: executable,
      args,
      targetArgs: 1,
      // Ryujinx refuses to start when the working directory is inside Program Files or OneDrive (Program.Main).
      cwd: this.paths().data,
      // Ryujinx writes a new Ryujinx_<version>_<timestamp>.log per start, so the session log name is not known in advance.
      logFile: null,
      prepare: async () => {
        await this.ensureDirs();
        await this.syncKeys().catch(() => null);
        if (hasOverrides) await this.applySessionOverrides(overrides);
      },
      cleanup: hasOverrides ? async () => void (await this.restoreJournal()) : undefined,
      notes,
    };
  }

  /** Config.json values that differ for this game's profile. */
  profileOverrides(base: EmulatorSettings, profile: GameProfile): Record<string, Json> {
    const o = profile.overrides;
    const merged: EmulatorSettings = { ...base, ...(o as Partial<EmulatorSettings>), advanced: {} };
    const g = this.graphicsValues(merged);
    const out: Record<string, Json> = {};
    if (o.renderer !== undefined) out.graphics_backend = g.graphics_backend;
    if (o.vsync !== undefined) out.vsync_mode = g.vsync_mode;
    if (o.aspectRatio !== undefined) out.aspect_ratio = g.aspect_ratio;
    if (o.resolutionScale !== undefined) {
      out.res_scale = g.res_scale;
      if (g.res_scale_custom !== undefined) out.res_scale_custom = g.res_scale_custom;
    }
    Object.assign(out, advancedValues(o.advanced ?? {}, {}));
    return out;
  }

  private journalPath(): string {
    return join(this.paths().data, 'Config.json.omnideck-session.json');
  }

  private async applySessionOverrides(overrides: Record<string, Json>): Promise<void> {
    const { doc } = await this.readConfig();
    if (!doc) return;
    const journal: Journal = {};
    for (const [k, v] of Object.entries(overrides)) {
      journal[k] = doc[k] === undefined ? { __omnipcAbsent: true } : doc[k];
      doc[k] = v;
    }
    if (!existsSync(this.journalPath())) await atomicWrite(this.journalPath(), JSON.stringify(journal));
    await atomicWrite(this.configPath(), serializeConfig(doc));
  }

  /** Ryujinx may rewrite Config.json while running (window state etc.), so only the overridden keys are restored. */
  private async restoreJournal(): Promise<boolean> {
    const jp = this.journalPath();
    if (!existsSync(jp)) return false;
    let journal: Journal = {};
    try {
      journal = JSON.parse(await readFile(jp, 'utf8')) as Journal;
    } catch {
      journal = {};
    }
    const { doc } = await this.readConfig();
    if (doc) {
      for (const [k, v] of Object.entries(journal)) {
        if (isObject(v) && v.__omnipcAbsent === true) delete doc[k];
        else doc[k] = v as Json;
      }
      await atomicWrite(this.configPath(), serializeConfig(doc));
    }
    await rm(jp, { force: true });
    return true;
  }

  buildUiLaunch(executable: string): LaunchCommand {
    return {
      command: executable,
      args: ['-r', this.paths().data, '--hide-updates'],
      cwd: this.paths().data,
      logFile: null,
      prepare: async () => {
        await this.ensureDirs();
        await this.syncKeys().catch(() => null);
      },
      notes: ['Opens Ryujinx with the OmniPC-managed data folder (keys, firmware, saves, settings).'],
    };
  }

  /**
   * Guided firmware install: "--install-firmware <dir|.zip|.xci>" opens Ryujinx, which asks the user to
   * confirm (MainWindow.OnApplyTemplate -> MainWindowViewModel.HandleFirmwareInstallation shows a
   * confirmation dialog), so this is NOT a silent install. Requires prod.keys first.
   */
  buildFirmwareInstallLaunch(executable: string, source: string): LaunchCommand {
    return {
      command: executable,
      args: ['-r', this.paths().data, '--hide-updates', '--install-firmware', source],
      cwd: this.paths().data,
      logFile: null,
      prepare: async () => {
        await this.ensureDirs();
        await this.syncKeys().catch(() => null);
      },
      notes: ['Ryujinx opens and asks you to confirm the firmware installation. Close Ryujinx afterwards.'],
    };
  }

  async smokeTest(executable: string): Promise<SmokeTestResult> {
    const checks: SmokeTestResult['checks'] = [];
    const exeOk = existsSync(executable);
    checks.push({ label: 'Executable present', ok: exeOk, detail: executable });
    if (!exeOk) return { ran: true, ok: false, checks };
    const insp = await this.inspectConfig();
    const cfg = insp.files[0];
    checks.push({ label: 'Config.json loads', ok: cfg.parseOk, detail: cfg.issues.join('; ') || cfg.path });
    const prompts = insp.drift.filter((d) => d.file === cfg.path && d.critical);
    checks.push({ label: 'Startup dialogs suppressed', ok: cfg.exists && prompts.length === 0, detail: prompts.length ? `Would show a dialog: ${prompts.map((d) => d.key).join(', ')}` : cfg.exists ? 'Update check, exit confirmation and debug prompts are off' : 'Config.json missing' });
    const keys = existsSync(join(this.keysDir(), 'prod.keys'));
    checks.push({ label: 'prod.keys installed', ok: keys, detail: keys ? join(this.keysDir(), 'prod.keys') : `Missing: Ryujinx shows a "keys not found" error instead of starting the game. Put prod.keys in ${this.paths().bios}.` });
    const fw = countFirmwareNcas(this.firmwareDir());
    checks.push({ label: 'Firmware installed', ok: fw > 0, detail: fw > 0 ? `${fw} system NCAs in ${this.firmwareDir()}` : 'No firmware installed; most games will not start. Install it once with Tools > Install Firmware in Ryujinx.' });
    const local = join(dirname(executable), 'Config.json');
    if (existsSync(local)) checks.push({ label: 'No Config.json next to Ryujinx.exe', ok: false, detail: `${local} overrides the OmniPC-managed settings` });
    // Ryujinx.exe has no flag that prints and exits: unknown arguments are treated as a game path
    // and open the GUI (CommandLineState), so the executable is never started here.
    checks.push({ label: 'Executable starts', ok: true, detail: isWindows ? 'Skipped: Ryujinx has no non-interactive check flag' : 'Skipped: only possible on Windows' });
    return { ran: false, ok: checks.every((c) => c.ok), checks };
  }

  async validateEnvironment(hw: HardwareProfile | null, _executable: string | null): Promise<Finding[]> {
    const subject = { kind: 'emulator' as const, id: ID, label: 'Ryujinx' };
    const out: Finding[] = [];
    if (hw && hw.graphicsApis.vulkan === false) {
      out.push({
        id: 'ryujinx.vulkan', checkId: 'ryujinx.graphics', category: 'graphics', severity: 'info', title: 'Ryujinx will use OpenGL',
        detail: 'No Vulkan driver was detected. Ryujinx can render with OpenGL 4.5+, but Vulkan is faster and compiles shaders with less stutter.',
        subject, evidence: hw.graphicsApis.notes, confidence: 'medium', repair: null, manualSteps: ['Update the graphics driver to get Vulkan support.'],
      });
    }
    if (hw && hw.isWindows && hw.osBuild && Number(hw.osBuild) > 0 && Number(hw.osBuild) < 19041) {
      out.push({
        id: 'ryujinx.windows-version', checkId: 'ryujinx.platform', category: 'emulators', severity: 'problem', title: 'Ryujinx needs Windows 10 version 2004 or newer',
        detail: 'Ryujinx exits at startup on Windows builds older than 19041 (20H1).', subject, evidence: [`${hw.osName} build ${hw.osBuild}`], confidence: 'high', repair: null,
        manualSteps: ['Update Windows.'],
      });
    }
    if (hw && hw.cpu.features.length && !hw.cpu.features.includes('sse42')) {
      out.push({
        id: 'ryujinx.cpu', checkId: 'ryujinx.cpu', category: 'emulators', severity: 'warning', title: 'This CPU may be too old for Ryujinx',
        detail: 'Ryujinx is built on .NET 10, whose x64 baseline expects SSE4.2-class CPUs, and its CPU recompiler is much slower without SSE4.1/4.2.', subject,
        evidence: [`CPU: ${hw.cpu.model}`, `Features: ${hw.cpu.features.join(', ')}`], confidence: 'medium', repair: null, manualSteps: [],
      });
    }
    if (hw && hw.ramMB > 0 && hw.ramMB < 8 * 1024) {
      out.push({
        id: 'ryujinx.ram', checkId: 'ryujinx.memory', category: 'emulators', severity: 'warning', title: 'Ryujinx recommends at least 8 GB of RAM',
        detail: `This PC has ${Math.round(hw.ramMB / 1024)} GB of RAM. Games may stutter or crash.`, subject, evidence: [], confidence: 'medium', repair: null, manualSteps: [],
      });
    }
    const data = this.paths().data;
    const blocked = blockedDataLocation(data);
    if (blocked) {
      out.push({
        id: 'ryujinx.location', checkId: 'ryujinx.platform', category: 'emulators', severity: 'problem', title: `Ryujinx refuses to run from ${blocked}`,
        detail: `Ryujinx shows a message and exits when it is started from a folder inside ${blocked}. OmniPC starts it in ${data}.`, subject,
        evidence: [data], confidence: 'high', repair: null, manualSteps: ['Move the OmniPC data folder (Settings > Storage) outside OneDrive and Program Files.'],
      });
    }
    return out;
  }

  saveLocations(): { label: string; path: string }[] {
    return [
      { label: 'Switch game saves (bis/user/save)', path: this.saveDir() },
      { label: 'Switch system saves and user profiles (bis/system/save)', path: join(this.paths().data, 'bis', 'system', 'save') },
    ];
  }

  async biosStatus(): Promise<BiosStatus[]> {
    const bios = this.paths().bios;
    const base = { systemId: 'switch' as const, systemName: 'Nintendo Switch', emulatorId: ID };

    // Keys
    const keyFiles: BiosStatus['files'] = [];
    let keysStatus: BiosStatus['status'] = 'missing';
    for (const dir of [bios, this.keysDir()]) {
      for (const name of ['prod.keys', 'title.keys']) {
        const p = join(dir, name);
        const st = await stat(p).catch(() => null);
        if (!st?.isFile()) continue;
        const parsed = parseKeyFile(await readFile(p, 'utf8').catch(() => ''));
        const valid = name === 'prod.keys' ? parsed.hasHeaderKey : parsed.count > 0;
        keyFiles.push({
          path: p, sizeBytes: st.size, valid,
          description: name === 'prod.keys'
            ? valid ? `${parsed.count} keys${dir === bios ? '' : ' (installed in Ryujinx)'}` : 'No header_key found; not a usable prod.keys'
            : valid ? `${parsed.count} title keys (optional)` : 'No title keys found',
        });
        if (name === 'prod.keys') keysStatus = valid ? 'found' : keysStatus === 'found' ? 'found' : 'invalid';
      }
    }
    const keysNote = keysStatus === 'found'
      ? 'OmniPC copies prod.keys (and title.keys) from this folder into Ryujinx\'s system folder before every launch. Keys must come from a firmware at least as new as the installed firmware.'
      : 'Required. Dump prod.keys (and optionally title.keys) from your own Switch (e.g. with Lockpick_RCM) and put them in this folder. OmniPC never downloads keys.';

    // Firmware
    const fw = countFirmwareNcas(this.firmwareDir());
    const srcDir = this.firmwareSourceDir();
    const srcFiles = existsSync(srcDir) ? await readdir(srcDir).catch(() => [] as string[]) : [];
    const srcNcas = srcFiles.filter((n) => /\.nca$/i.test(n)).length;
    const srcZip = srcFiles.find((n) => /\.zip$/i.test(n));
    const fwFiles: BiosStatus['files'] = fw > 0 ? [{ path: this.firmwareDir(), sizeBytes: 0, valid: true, description: `${fw} installed system NCAs` }] : [];
    if (srcNcas || srcZip) fwFiles.push({ path: srcZip ? join(srcDir, srcZip) : srcDir, sizeBytes: 0, valid: true, description: srcZip ? 'Firmware package to install' : `${srcNcas} firmware NCAs to install` });
    const fwNote = fw > 0
      ? 'Firmware is installed in Ryujinx (bis/system/Contents/registered). To update it, install a newer firmware dump with Tools > Install Firmware.'
      : `Required for most games. Dump the firmware from your own Switch (e.g. with TegraExplorer or Lockpick/DBI) and install it once in Ryujinx: open Ryujinx from OmniPC, then Tools > Install Firmware > Install a firmware from XCI or ZIP / from a directory. Ryujinx has no silent install option; you can keep the dump in ${srcDir}. prod.keys must be installed first. OmniPC never downloads firmware.`;

    return [
      { ...base, label: 'Switch keys (prod.keys, title.keys)', required: true, requirementKind: 'keys', expectedLocation: bios, status: keysStatus, files: keyFiles, note: keysNote },
      { ...base, label: 'Switch firmware', required: true, requirementKind: 'firmware', expectedLocation: this.firmwareDir(), status: fw > 0 ? 'found' : 'missing', files: fwFiles, note: fwNote },
    ];
  }

  /** Newest Ryujinx log (a new Ryujinx_<version>_<timestamp>.log is written per start; Ryujinx keeps 3). */
  logFile(): string | null {
    const dir = this.logsDir();
    if (!existsSync(dir)) return null;
    try {
      const logs = readdirSync(dir).filter((n) => /\.log$/i.test(n)).map((n) => ({ n, t: statSync(join(dir, n)).mtimeMs }));
      logs.sort((a, b) => a.t - b.t);
      return logs.length ? join(dir, logs[logs.length - 1].n) : null;
    } catch {
      return null;
    }
  }

  /** PPTC (games/<id>/cache/cpu) and shader caches (games/<id>/cache/shader); games/<id> also holds update/DLC lists, so only cache/ is listed. */
  cacheDirs(): { label: string; path: string }[] {
    const games = join(this.paths().data, 'games');
    if (!existsSync(games)) return [];
    try {
      return readdirSync(games)
        .filter((id) => /^[0-9a-f]{16}$/i.test(id) && existsSync(join(games, id, 'cache')))
        .map((id) => ({ label: `PPTC and shader cache (${id})`, path: join(games, id, 'cache') }));
    } catch {
      return [];
    }
  }

  async recoverSession(): Promise<string[]> {
    return (await this.restoreJournal()) ? ['Restored Ryujinx Config.json values after a per-game session override was interrupted.'] : [];
  }

  /** %APPDATA%\Ryujinx (default user-profile data) and portable installs (folder "portable" next to Ryujinx.exe). */
  async detectExistingSetups(): Promise<SetupImportCandidate[]> {
    const out: SetupImportCandidate[] = [];
    const roaming = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    const dataDir = join(roaming, 'Ryujinx');
    if (existsSync(join(dataDir, 'Config.json'))) out.push(await this.candidateFromDataDir(`${ID}:appdata`, 'Ryujinx (%APPDATA%\\Ryujinx)', dataDir));
    const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    for (const dir of [join(local, 'Ryujinx'), join(homedir(), 'Ryujinx'), join(homedir(), 'Desktop', 'Ryujinx'), join(homedir(), 'Downloads', 'publish'), 'C:\\Ryujinx', 'C:\\Emulators\\Ryujinx']) {
      const exe = await this.findExecutable(dir);
      if (!exe) continue;
      const portable = join(dir, 'portable');
      if (existsSync(portable)) {
        const c = await this.candidateFromDataDir(`${ID}:portable:${dir}`, `Ryujinx portable installation (${dir})`, portable);
        c.details.unshift(`Executable: ${exe}`);
        c.importable.useInstallation = true;
        out.push(c);
      } else {
        out.push({ id: `${ID}:install:${dir}`, source: ID, label: `Ryujinx installation (${dir})`, path: dir, details: [`Executable: ${exe}`], importable: { settings: false, saves: false, bios: false, romPaths: false, useInstallation: true }, romPaths: [] });
      }
    }
    return out;
  }

  private async candidateFromDataDir(id: string, label: string, dir: string): Promise<SetupImportCandidate> {
    const cfg = existsSync(join(dir, 'Config.json')) ? parseConfig(await readFile(join(dir, 'Config.json'), 'utf8').catch(() => '')) : null;
    const gameDirs = Array.isArray(cfg?.game_dirs) ? (cfg!.game_dirs as Json[]).filter((v): v is string => typeof v === 'string') : [];
    const romPaths = gameDirs.filter((d) => existsSync(d));
    const saves = join(dir, 'bis', 'user', 'save');
    const keys = join(dir, 'system');
    const hasKeys = existsSync(join(keys, 'prod.keys'));
    return {
      id, source: ID, label, path: dir,
      details: [`Settings: ${join(dir, 'Config.json')}`, `Saves: ${saves}`, `Keys: ${hasKeys ? join(keys, 'prod.keys') : 'none'}`, `Firmware: ${countFirmwareNcas(join(dir, 'bis', 'system', 'Contents', 'registered'))} NCAs`, `Game folders: ${gameDirs.join('; ') || 'none'}`],
      importable: { settings: false, saves: existsSync(saves), bios: hasKeys, romPaths: romPaths.length > 0, useInstallation: false },
      romPaths,
      saveCopies: existsSync(saves) ? [{ from: saves, to: this.saveDir(), label: 'Switch game saves' }] : [],
      biosDirs: hasKeys ? [{ dir: keys, systemId: 'switch' }] : [],
    };
  }
}

/** SetupImportCandidate.source does not list 'ryujinx' yet (shared models change requested). */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Switch renders 720p (handheld) / up to 1080p (docked), so 2x already targets 1440p-4K. */
export function ryujinxResolutionScale(hw: HardwareProfile | null, preset: PerformancePreset): number {
  const tier = hw?.tier ?? 'mid';
  const table: Record<HardwareProfile['tier'], Record<PerformancePreset, number>> = {
    low: { performance: 1, balanced: 1, quality: 1, maximum: 2 },
    mid: { performance: 1, balanced: 1, quality: 2, maximum: 2 },
    high: { performance: 1, balanced: 2, quality: 2, maximum: 3 },
    enthusiast: { performance: 1, balanced: 2, quality: 3, maximum: 4 },
  };
  let scale = table[tier][preset];
  const display = hw?.displays.find((d) => d.primary) ?? hw?.displays[0];
  if (display && preset !== 'maximum') scale = Math.min(scale, display.height >= 2000 ? 3 : display.height >= 1400 ? 2 : 1);
  return Math.max(1, Math.min(4, scale));
}

/** Counts installed firmware NCAs (<id>.nca directories holding "00", ContentManager.SaveNca / LoadEntries). */
export function countFirmwareNcas(registered: string): number {
  if (!existsSync(registered)) return 0;
  try {
    return readdirSync(registered).filter((n) => /\.nca$/i.test(n) && existsSync(join(registered, n, '00'))).length;
  } catch {
    return 0;
  }
}

/** "name = hex" lines as read by LibHac ExternalKeyReader; header_key (64 hex digits) is required to read any NCA. */
export function parseKeyFile(text: string): { count: number; hasHeaderKey: boolean } {
  let count = 0;
  let hasHeaderKey = false;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*[=,]\s*([0-9A-Fa-f]+)\s*$/.exec(line);
    if (!m) continue;
    count++;
    if (m[1].toLowerCase() === 'header_key' && m[2].length === 64) hasHeaderKey = true;
  }
  return { count, hasHeaderKey };
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** Returns "OneDrive" or "Program Files" when Ryujinx would refuse this working directory (Program.Main). */
export function blockedDataLocation(dir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const n = (s: string) => normalize(s).replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
  const d = n(dir);
  const inside = (root: string | undefined) => !!root && (d === n(root) || d.startsWith(`${n(root)}/`));
  if (inside(env.OneDrive) || inside(env.OneDriveConsumer) || inside(env.OneDriveCommercial)) return 'OneDrive';
  if (inside(env.ProgramFiles) || inside(env['ProgramFiles(x86)'])) return 'Program Files';
  return null;
}

/**
 * settings.advanced entries whose key is a top-level snake_case Config.json key with a primitive
 * value (e.g. "docked_mode": "false", "anti_aliasing": "Fxaa", "enable_texture_recompression": "true")
 * are written, typed after the existing value. Structured keys (input, hotkeys, lists) are refused.
 */
function advancedValues(adv: Record<string, string>, doc: JsonObject): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [key, raw] of Object.entries(adv)) {
    if (!/^[a-z][a-z0-9_]*$/.test(key) || key === 'version') continue;
    const existing = doc[key];
    if (existing !== undefined && existing !== null && typeof existing === 'object') continue;
    const v = String(raw).trim();
    if (typeof existing === 'boolean' || (existing === undefined && /^(true|false)$/i.test(v))) {
      if (/^(true|false|1|0)$/i.test(v)) out[key] = /^(true|1)$/i.test(v);
    } else if (typeof existing === 'number' || (existing === undefined && /^-?\d+(\.\d+)?$/.test(v))) {
      if (/^-?\d+(\.\d+)?$/.test(v)) out[key] = Number(v);
    } else {
      out[key] = v;
    }
  }
  return out;
}

/**
 * Applies the universal profile to the player-1 input entry. A gamepad is identified by
 * "<n>-<SDL GUID with the CRC zeroed>" (SDL3GamepadDriver.GenerateGamepadId), which OmniPC
 * cannot know before Ryujinx has seen the pad, so an existing controller entry keeps its
 * device and only its mapping is rewritten; a keyboard-only player 1 is left as is.
 */
function applyController(doc: JsonObject, profile: UniversalControllerProfile): { changed: string[]; notes: string[] } {
  const changed: string[] = [];
  const notes: string[] = [];
  if (!Array.isArray(doc.input_config)) doc.input_config = [];
  const list = doc.input_config as Json[];
  const idx = list.findIndex((e) => isObject(e) && e.player_index === 'Player1' && (e.backend === 'GamepadSDL3' || e.backend === 'GamepadSDL2'));
  if (idx < 0) {
    notes.push('Ryujinx identifies controllers by their SDL GUID, which OmniPC cannot know in advance. Open Ryujinx from OmniPC once, choose your controller for Player 1 in Options > Settings > Input and save; OmniPC then keeps that device and applies its button mapping.');
    return { changed, notes };
  }
  const before = JSON.stringify(list[idx]);
  const entry = list[idx] as JsonObject;
  const unsupported: string[] = [];
  for (const [group, key, logical] of SWITCH_BUTTONS) {
    const physical = physicalFor(profile, 'switch', logical);
    let token = GAMEPAD_INPUT[physical];
    if (!token) {
      unsupported.push(`${key} -> ${physical}`);
      token = GAMEPAD_INPUT[logical]!;
    }
    if (!isObject(entry[group])) entry[group] = {};
    (entry[group] as JsonObject)[key] = token;
  }
  for (const [group, stick, click] of [['left_joycon_stick', 'Left', 'L3'], ['right_joycon_stick', 'Right', 'R3']] as const) {
    if (!isObject(entry[group])) entry[group] = { invert_stick_x: false, invert_stick_y: false, rotate90_cw: false };
    const g = entry[group] as JsonObject;
    // A stick is bound as a whole; it follows wherever the profile maps that stick's "up" direction.
    const up = physicalFor(profile, 'switch', stick === 'Left' ? 'LeftStickUp' : 'RightStickUp');
    g.joystick = up.startsWith('RightStick') ? 'Right' : up.startsWith('LeftStick') ? 'Left' : stick;
    g.stick_button = GAMEPAD_INPUT[physicalFor(profile, 'switch', click)] ?? GAMEPAD_INPUT[click]!;
  }
  const dz = Math.round(Math.max(0, Math.min(0.9, Number.isFinite(profile.deadzone) ? profile.deadzone : 0.1)) * 1000) / 1000;
  entry.deadzone_left = dz;
  entry.deadzone_right = dz;
  if (typeof entry.range_left !== 'number') entry.range_left = 1;
  if (typeof entry.range_right !== 'number') entry.range_right = 1;
  if (typeof entry.trigger_threshold !== 'number') entry.trigger_threshold = 0.5;
  if (!isObject(entry.rumble)) entry.rumble = { strong_rumble: 1, weak_rumble: 1, enable_rumble: profile.rumble, use_hdrumble: false };
  else (entry.rumble as JsonObject).enable_rumble = profile.rumble;
  if (JSON.stringify(entry) !== before) changed.push(`Config.json input_config Player1 (${String(entry.name ?? entry.id)}) mapping`);
  if (unsupported.length) notes.push(`Ryujinx cannot bind ${unsupported.join(', ')} (stick directions are not buttons); the default button is used instead.`);
  if (profile.deviceIndex !== 0) notes.push('OmniPC keeps the controller chosen for Player 1 in Ryujinx; the profile\'s device index is not used.');
  return { changed, notes };
}

