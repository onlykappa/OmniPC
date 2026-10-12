// shadPS4 adapter (PlayStation 4).
// Layout:
//   Emulators/shadps4/app                      shadPS4.exe (core build, no Qt launcher)
//   Emulators/shadps4/data                     working directory; contains the portable "user"
//                                              folder, which shadPS4 uses when <cwd>/user exists
//                                              (src/common/path_util.cpp UserPaths)
//   Emulators/shadps4/data/user/config.json    emulator settings (src/core/emulator_settings.cpp)
//   Emulators/shadps4/data/user/custom_configs/<TITLE_ID>.json   native per-game overrides
//   Emulators/shadps4/data/user/input_config/default.ini, global.ini   bindings + hotkeys
//   Emulators/shadps4/data/user/log/shad_log.txt                      game log
//   Saves/shadps4                              General.home_dir: <user id>/savedata/<TITLE_ID>,
//                                              <user id>/trophy
//   BIOS/ps4                                   General.sys_modules_dir: optional firmware
//                                              modules (*.sprx) dumped by the user;
//   BIOS/ps4/fonts                             General.font_dir: optional dumped system fonts
//                                              (font/, font2/)

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { BiosStatus, EmulatorManifest, EmulatorSettings, Finding, GameProfile, HardwareProfile, HotkeyAction, PerformancePreset, RendererOption, SetupImportCandidate, UniversalButton, UniversalControllerProfile, HotkeyConfig } from '@shared/models';
import manifestJson from '../manifests/shadps4.json';
import type { AdapterCapabilities, AdapterPaths, ConfigInput, ConfigInspection, ConfigWriteResult, EmulatorAdapter, LaunchCommand, LaunchTarget, SmokeTestResult } from '../adapter';
import type { AppPaths } from '../../core/paths';
import type { BackupTarget } from '../../config/backups';
import { atomicWrite } from '../../config/iniFile';
import { checkJson } from '../../config/formats';
import { hotkeyChords, physicalFor } from '../../controllers/translate';
import { findExeIn } from '../common';
import { runProcess } from '../../platform/exec';
import { fileVersion, isWindows } from '../../platform/powershell';
import { splitArgs } from '../pcsx2/adapter';
import type { SettingDef } from '@shared/emulatorSettings';
import { SHADPS4_SETTINGS, SHADPS4_TYPES, shadps4Optimize } from './settingsSchema';

export const SHADPS4_MANIFEST = manifestJson as unknown as EmulatorManifest;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type JsonObject = { [k: string]: Json };

/** Video-out resolutions reported to games (GPU.internal_screen_width/height, video_out.cpp RegisterLib). */
export const SHADPS4_RESOLUTIONS: Record<number, [number, number]> = { 1: [1280, 720], 2: [1920, 1080] };

/** Default users created by UserManager::CreateDefaultUsers (src/core/user_manager.cpp). */
export const SHADPS4_USER_IDS = [1000, 1001, 1002, 1003];

/** Firmware modules shadPS4 can load from sys_modules (README "Firmware files", sysmodule_internal.cpp, linker.cpp). */
export const SHADPS4_SYS_MODULES = [
  'libSceAt9Enc.sprx', 'libSceAudiodec.sprx', 'libSceAudiodecCpu.sprx', 'libSceAudiodecCpuDdp.sprx',
  'libSceAudiodecCpuDtsHdLbr.sprx', 'libSceAudiodecCpuHevag.sprx', 'libSceAudiodecCpuM4aac.sprx', 'libSceAvPlayer.sprx',
  'libSceAvPlayerStreaming.sprx', 'libSceBeisobmf.sprx', 'libSceBemp2sys.sprx', 'libSceCesCs.sprx',
  'libSceFont.sprx', 'libSceFontFt.sprx', 'libSceFreeTypeOl.sprx', 'libSceFreeTypeOptOl.sprx',
  'libSceFreeTypeOt.sprx', 'libSceJpegDec.sprx', 'libSceJpegEnc.sprx', 'libSceJson.sprx',
  'libSceJson2.sprx', 'libSceLibcInternal.sprx', 'libSceNgs2.sprx', 'libScePngEnc.sprx',
  'libScePsmKitSystem.sprx', 'libSceRtc.sprx', 'libSceRudp.sprx', 'libSceSystemGesture.sprx',
  'libSceUlt.sprx', 'libSceWkFontConfig.sprx', 'libSceXml.sprx', 'libSceDepth.sprx',
  'libScePadTracker.sprx', 'libSceMoveTracker.sprx',
];

/** Groups in config.json (EmulatorSettingsImpl::Save). */
const GROUPS = ['General', 'Network', 'Log', 'Debug', 'Input', 'Audio', 'GPU', 'Vulkan'];

/** JSON types of the keys OmniPC manages; a wrong type makes shadPS4 abort while loading (Load -> UNREACHABLE_MSG). */
const MANAGED_TYPES: Record<string, 'string' | 'boolean' | 'integer'> = {
  'General.home_dir': 'string',
  'General.sys_modules_dir': 'string',
  'General.font_dir': 'string',
  'General.show_splash': 'boolean',
  'Log.enable': 'boolean',
  'Log.separate': 'boolean',
  'GPU.full_screen': 'boolean',
  'GPU.full_screen_mode': 'string',
  'GPU.present_mode': 'string',
  'GPU.window_width': 'integer',
  'GPU.window_height': 'integer',
  'GPU.internal_screen_width': 'integer',
  'GPU.internal_screen_height': 'integer',
  'Input.use_unified_input_config': 'boolean',
};

/** PS4 outputs OmniPC binds for the gamepad, with the universal (Xbox-layout) logical button they represent. */
const PAD_OUTPUTS: [string, UniversalButton][] = [
  ['cross', 'A'], ['circle', 'B'], ['square', 'X'], ['triangle', 'Y'],
  ['l1', 'LB'], ['r1', 'RB'], ['l2', 'LT'], ['r2', 'RT'], ['l3', 'L3'], ['r3', 'R3'],
  ['options', 'Start'], ['touchpad_center', 'Select'],
  ['pad_up', 'DPadUp'], ['pad_down', 'DPadDown'], ['pad_left', 'DPadLeft'], ['pad_right', 'DPadRight'],
];
const STICK_OUTPUTS = ['axis_left_x', 'axis_left_y', 'axis_right_x', 'axis_right_y'];

/** SDL gamepad input tokens (input_handler.h string_to_cbutton_map / string_to_axis_map) for physical buttons. */
const PHYSICAL_TOKEN: Partial<Record<UniversalButton, string>> = {
  A: 'cross', B: 'circle', X: 'square', Y: 'triangle',
  LB: 'l1', RB: 'r1', LT: 'l2', RT: 'r2', L3: 'l3', R3: 'r3',
  Start: 'options', Select: 'back',
  DPadUp: 'pad_up', DPadDown: 'pad_down', DPadLeft: 'pad_left', DPadRight: 'pad_right',
};

/** Every gamepad token the parser accepts as an input (used to recognise controller lines). */
const CONTROLLER_TOKENS = new Set([
  'triangle', 'circle', 'cross', 'square', 'l1', 'r1', 'l3', 'r3', 'pad_up', 'pad_down', 'pad_left', 'pad_right', 'options',
  'touchpad_left', 'touchpad_center', 'touchpad_right', 'back', 'share', 'lpaddle_high', 'lpaddle_low', 'rpaddle_high', 'rpaddle_low',
  'qam', 'r4', 'l4', 'r5', 'l5', 'l2', 'r2',
  'axis_left_x', 'axis_left_y', 'axis_right_x', 'axis_right_y',
  'axis_left_x_plus', 'axis_left_x_minus', 'axis_left_y_plus', 'axis_left_y_minus',
  'axis_right_x_plus', 'axis_right_x_minus', 'axis_right_y_plus', 'axis_right_y_minus',
]);

/** OmniPC hotkey actions -> shadPS4 hotkey outputs (input_handler.h string_to_hotkey_map). */
const HOTKEY_OUTPUT: Partial<Record<HotkeyAction, string>> = {
  exit: 'hotkey_quit',
  fullscreen: 'hotkey_fullscreen',
  volumeUp: 'hotkey_volume_up',
  volumeDown: 'hotkey_volume_down',
  screenshot: 'hotkey_screenshot_with_overlays',
  menu: 'hotkey_emulator_settings',
};

/** Upstream keyboard defaults for those hotkeys (input_handler.cpp GetInputConfigFile, default_bindings_to_add). */
const HOTKEY_KEYBOARD_DEFAULT: Record<string, string> = {
  hotkey_quit: 'lctrl, lshift, end',
  hotkey_fullscreen: 'f11',
  hotkey_volume_up: 'kpplus',
  hotkey_volume_down: 'kpminus',
  hotkey_screenshot_with_overlays: 'lalt, f12',
  hotkey_emulator_settings: 'f3',
};

/** Keyboard part of upstream GetDefaultInputConfig (input_handler.cpp), used when default.ini does not exist yet. */
const DEFAULT_KEYBOARD_INI = `#Feeling lost? Check out the Help section!

# Keyboard bindings

triangle = kp8
circle = kp6
cross = kp2
square = kp4
# Alternatives for users without a keypad
triangle = c
circle = b
cross = n
square = v

l1 = q
r1 = u
l2 = e
r2 = o
l3 = x
r3 = m

options = enter
touchpad_center = space

pad_up = up
pad_down = down
pad_left = left
pad_right = right

axis_left_x_minus = a
axis_left_x_plus = d
axis_left_y_minus = w
axis_left_y_plus = s

axis_right_x_minus = j
axis_right_x_plus = l
axis_right_y_minus = i
axis_right_y_plus = k

override_controller_color = false, 0, 0, 255
`;
const DEFAULT_GLOBAL_INI = `# Anything put here will be loaded for all games,
# alongside the game's config or default.ini depending on your preference.
`;

const BLOCK_START = '# >>> OmniPC managed bindings (generated from the OmniPC controller profile; edits inside this block are replaced) >>>';
const BLOCK_END = '# <<< OmniPC managed bindings <<<';

const TITLE_ID_RE = /^[A-Z]{4}\d{5}$/;

export class Shadps4Adapter implements EmulatorAdapter {
  readonly manifest = SHADPS4_MANIFEST;
  readonly capabilities: AdapterCapabilities = {
    perGameProfiles: 'native',
    frameLimit: false,
    vsync: true,
    aspectRatios: [],
    hotkeys: ['exit', 'fullscreen', 'volumeUp', 'volumeDown', 'screenshot', 'menu'],
    smokeTest: true,
    maxResolutionScale: 2,
  };

  constructor(private readonly app: AppPaths) {}

  paths(): AdapterPaths {
    return {
      app: this.app.emulatorAppDir('shadps4'),
      data: this.app.emulatorDataDir('shadps4'),
      saves: this.app.emulatorSaveDir('shadps4'),
      bios: this.app.systemBiosDir('ps4'),
      cache: this.app.emulatorCacheDir('shadps4'),
    };
  }

  /** Portable user directory: shadPS4 uses <cwd>/user when it exists (path_util.cpp UserPaths). */
  userDir(): string {
    return join(this.paths().data, 'user');
  }

  configPath(): string {
    return join(this.userDir(), 'config.json');
  }

  gameConfigPath(titleId: string): string {
    return join(this.userDir(), 'custom_configs', `${titleId}.json`);
  }

  inputConfigPath(name: 'default' | 'global'): string {
    return join(this.userDir(), 'input_config', `${name}.ini`);
  }

  logPath(): string {
    return join(this.userDir(), 'log', 'shad_log.txt');
  }

  fontsDir(): string {
    return join(this.paths().bios, 'fonts');
  }

  async findExecutable(appDir: string): Promise<string | null> {
    return findExeIn(appDir, [/^shadps4\.exe$/i, /^shadps4$/i]);
  }

  /** shadPS4.exe has a VERSIONINFO resource (src/dist/shadps4.rc) with MAJOR.MINOR.PATCH.0. */
  async detectVersion(executable: string): Promise<string | null> {
    const v = await fileVersion(executable);
    if (!v) return null;
    return v.replace(/^v\.?/i, '').replace(/^(\d+\.\d+\.\d+)\.0$/, '$1');
  }

  renderers(hw: HardwareProfile | null): RendererOption[] {
    const vk = hw?.graphicsApis.vulkan;
    return [{ id: 'vulkan', label: 'Vulkan 1.3', available: vk !== false, note: vk === false ? 'No Vulkan driver detected; shadPS4 cannot run' : undefined }];
  }

  defaultSettings(hw: HardwareProfile | null, preset: PerformancePreset): EmulatorSettings {
    return {
      preset,
      resolutionScale: shadps4ResolutionScale(hw, preset),
      renderer: 'vulkan',
      aspectRatio: 'auto',
      fullscreen: true,
      frameLimit: true,
      vsync: preset !== 'performance',
      advanced: {},
    };
  }

  configTargets(): BackupTarget[] {
    const root = this.paths().data;
    return [
      { root, path: this.configPath() },
      { root, path: this.inputConfigPath('default') },
      { root, path: this.inputConfigPath('global') },
    ];
  }

  /**
   * Creates the portable user folder and the four default user homes. UserManager::CreateDefaultUsers
   * runs on every start and shows a modal "Save Migration" dialog whenever <home_dir>/1000 does not
   * exist yet (user_manager.cpp AskMigrationOption), so the homes must exist before shadPS4 starts.
   */
  async ensureDirs(): Promise<void> {
    const p = this.paths();
    for (const d of [p.data, this.userDir(), join(this.userDir(), 'log'), join(this.userDir(), 'input_config'), join(this.userDir(), 'custom_configs'), p.saves, p.bios, this.fontsDir(), join(this.fontsDir(), 'font'), join(this.fontsDir(), 'font2'), p.cache]) {
      await mkdir(d, { recursive: true });
    }
    for (const id of SHADPS4_USER_IDS) {
      for (const sub of ['savedata', 'trophy', 'inputs']) await mkdir(join(p.saves, String(id), sub), { recursive: true });
    }
  }

  managedPaths(): Record<'General.home_dir' | 'General.sys_modules_dir' | 'General.font_dir', string> {
    return { 'General.home_dir': this.paths().saves, 'General.sys_modules_dir': this.paths().bios, 'General.font_dir': this.fontsDir() };
  }

  graphicsValues(s: EmulatorSettings): Record<string, Json> {
    const [w, h] = SHADPS4_RESOLUTIONS[clampScale(s.resolutionScale)];
    return {
      'GPU.full_screen': s.fullscreen,
      // Mailbox is upstream's default; Fifo = vsync (vk_swapchain.cpp FindPresentMode).
      'GPU.present_mode': s.vsync ? 'Fifo' : 'Mailbox',
      'GPU.internal_screen_width': w,
      'GPU.internal_screen_height': h,
      'GPU.window_width': w,
      'GPU.window_height': h,
    };
  }

  settingsSchema(): SettingDef[] {
    return SHADPS4_SETTINGS;
  }

  async readSettings(): Promise<Record<string, string>> {
    const doc = await this.readConfig().catch(() => null);
    const out: Record<string, string> = {};
    if (!doc) return out;
    for (const d of SHADPS4_SETTINGS) {
      const v = getJson(doc, d.key);
      if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') out[d.key] = String(v);
    }
    return out;
  }

  optimize(hw: HardwareProfile): { key: string; value: string; reason: string }[] {
    return shadps4Optimize(hw);
  }

  async readConfig(): Promise<JsonObject | null> {
    return readJsonObject(this.configPath());
  }

  async applyConfig(input: ConfigInput, scope: 'all' | 'controller' | 'graphics' | 'paths'): Promise<ConfigWriteResult> {
    await this.ensureDirs();
    const notes: string[] = [];
    const changed: string[] = [];
    const existed = existsSync(this.configPath());
    const parsed = await this.readConfig();
    if (existed && !parsed) notes.push('config.json could not be parsed and was regenerated with OmniPC values (the previous file is kept in the configuration backup); shadPS4 fills in its defaults on the next start.');
    const doc: JsonObject = parsed ?? {};
    const set = (path: string, v: Json) => {
      if (setJson(doc, path, v)) changed.push(`config.json ${path} = ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    };

    if (scope === 'all' || scope === 'paths') {
      for (const [k, v] of Object.entries(this.managedPaths())) set(k, v);
      // No splash, one predictable log file.
      set('General.show_splash', false);
      set('Log.enable', true);
      set('Log.separate', false);
    }
    if (scope === 'all' || scope === 'graphics') {
      for (const [k, v] of Object.entries(this.graphicsValues(input.settings))) set(k, v);
      for (const [k, v] of Object.entries(advancedValues(input.settings.advanced ?? {}, doc))) set(k, v);
    }
    if (scope === 'all' || scope === 'controller') {
      // The universal profile is written to default.ini, which is only used for every game when unified input config is on.
      set('Input.use_unified_input_config', true);
      const r = await this.applyController(input.controller, input.hotkeys);
      changed.push(...r.changed);
      notes.push(...r.notes);
    }

    if (changed.some((c) => c.startsWith('config.json')) || !existed || !parsed) await atomicWrite(this.configPath(), `${JSON.stringify(doc, null, 2)}\n`);
    return { changed, notes };
  }

  /** Writes the managed controller/hotkey blocks into input_config/default.ini and global.ini. */
  async applyController(controller: UniversalControllerProfile, hotkeys: HotkeyConfig): Promise<ConfigWriteResult> {
    const changed: string[] = [];
    const notes: string[] = [];
    const def = this.inputConfigPath('default');
    const defText = existsSync(def) ? await readFile(def, 'utf8') : DEFAULT_KEYBOARD_INI;
    const binding = controllerBlock(controller);
    notes.push(...binding.notes);
    const newDef = replaceBlock(defText, binding.lines, (output, inputs) => {
      if (output === 'analog_deadzone') return /^(leftjoystick|rightjoystick),/.test(inputs);
      return (PAD_OUTPUTS.some(([o]) => o === output) || STICK_OUTPUTS.includes(output)) && isControllerInput(inputs);
    });
    if (newDef !== defText || !existsSync(def)) {
      await atomicWrite(def, newDef);
      changed.push('input_config/default.ini controller bindings');
    }

    const glob = this.inputConfigPath('global');
    const globText = existsSync(glob) ? await readFile(glob, 'utf8') : DEFAULT_GLOBAL_INI;
    const hk = hotkeyBlock(hotkeys, this.capabilities.hotkeys, globText);
    notes.push(...hk.notes);
    const managedHotkeys = new Set(Object.values(HOTKEY_OUTPUT));
    const newGlob = replaceBlock(globText, hk.lines, (output, inputs) => managedHotkeys.has(output) && isControllerInput(inputs));
    if (newGlob !== globText || !existsSync(glob)) {
      await atomicWrite(glob, newGlob);
      changed.push('input_config/global.ini controller hotkeys');
    }
    if (!controller.rumble) notes.push('shadPS4 has no setting to turn off controller vibration; rumble stays on.');
    if (controller.deviceIndex !== 0) notes.push('shadPS4 assigns connected SDL gamepads to players in connection order; OmniPC cannot pick a specific device for player 1.');
    return { changed, notes };
  }

  async inspectConfig(): Promise<ConfigInspection> {
    const files: ConfigInspection['files'] = [];
    const drift: ConfigInspection['drift'] = [];
    const cfg = this.configPath();
    const exists = existsSync(cfg);
    const text = exists ? await readFile(cfg, 'utf8').catch(() => '') : '';
    const fmt = exists ? checkJson(text) : { ok: false, issues: ['File does not exist'] };
    const issues = [...fmt.issues];
    let doc: JsonObject | null = null;
    if (exists && fmt.ok) {
      const j = JSON.parse(text) as Json;
      if (j && typeof j === 'object' && !Array.isArray(j)) doc = j;
      else issues.push('Top level is not a JSON object');
    }
    if (doc) {
      for (const g of GROUPS) if (doc[g] !== undefined && !isObject(doc[g])) issues.push(`"${g}" must be an object`);
      for (const [k, t] of Object.entries(MANAGED_TYPES)) {
        const v = getJson(doc, k);
        if (v !== undefined && !hasType(v, t)) issues.push(`${k} must be a ${t}; shadPS4 aborts on start with a wrong type`);
      }
    }
    files.push({ label: 'config.json', path: cfg, exists, parseOk: exists && fmt.ok && issues.length === 0, issues });
    if (doc) {
      for (const [k, expected] of Object.entries(this.managedPaths())) {
        const v = getJson(doc, k);
        const actual = typeof v === 'string' ? v : null;
        if (!actual || normPath(actual) !== normPath(expected)) drift.push({ file: cfg, key: k, expected, actual, critical: k !== 'General.font_dir' });
      }
      const sep = getJson(doc, 'Log.separate');
      if (sep !== false) drift.push({ file: cfg, key: 'Log.separate', expected: 'false', actual: sep === undefined ? null : JSON.stringify(sep), critical: false });
      const uni = getJson(doc, 'Input.use_unified_input_config');
      if (uni === false) drift.push({ file: cfg, key: 'Input.use_unified_input_config', expected: 'true', actual: 'false', critical: false });
    }
    for (const name of ['default', 'global'] as const) {
      const p = this.inputConfigPath(name);
      const ex = existsSync(p);
      const t = ex ? await readFile(p, 'utf8').catch(() => '') : '';
      const iss: string[] = ex ? [] : ['File does not exist'];
      if (ex && t.includes(BLOCK_START) !== t.includes(BLOCK_END)) iss.push('OmniPC managed block is incomplete');
      files.push({ label: `input_config/${name}.ini`, path: p, exists: ex, parseOk: ex && iss.length === 0, issues: iss });
    }
    const home1000 = join(this.paths().saves, '1000');
    if (!existsSync(home1000)) drift.push({ file: home1000, key: 'user 1000 home folder', expected: home1000, actual: null, critical: true });
    return { files, drift };
  }

  /** Writes per-game overrides into shadPS4's native custom_configs/<TITLE_ID>.json (EmulatorSettingsImpl::Load(serial)). */
  async writeGameConfig(titleId: string, overrides: GameProfile['overrides'], base: EmulatorSettings): Promise<string[]> {
    const merged: EmulatorSettings = { ...base, ...(overrides as Partial<EmulatorSettings>) };
    const values: Record<string, Json> = {};
    if (overrides.fullscreen !== undefined) values['GPU.full_screen'] = merged.fullscreen;
    if (overrides.vsync !== undefined) values['GPU.present_mode'] = merged.vsync ? 'Fifo' : 'Mailbox';
    if (overrides.resolutionScale !== undefined) {
      // Only the window size is overridable per game; the video-out size (internal_screen_*) is global.
      const [w, h] = SHADPS4_RESOLUTIONS[clampScale(merged.resolutionScale)];
      values['GPU.window_width'] = w;
      values['GPU.window_height'] = h;
    }
    const path = this.gameConfigPath(titleId);
    const doc = (await readJsonObject(path)) ?? {};
    // Menu settings overridden for this game (every schema key is in shadPS4's GetOverrideableFields).
    Object.assign(values, advancedValues(overrides.advanced ?? {}, doc));
    if (!Object.keys(values).length) return [];
    let changed = !existsSync(path);
    for (const [k, v] of Object.entries(values)) changed = setJson(doc, k, v) || changed;
    if (changed) await atomicWrite(path, `${JSON.stringify(doc, null, 2)}\n`);
    return Object.keys(values);
  }

  async buildLaunch(target: LaunchTarget, executable: string, settings: EmulatorSettings, profile: GameProfile | null, _version: string | null): Promise<LaunchCommand> {
    const notes: string[] = [];
    const fullscreen = profile?.overrides.fullscreen ?? settings.fullscreen;
    const titleId = gameTitleId(target);
    const hasOverrides = !!profile && (Object.keys(profile.overrides).some((k) => k !== 'advanced') || Object.keys(profile.overrides.advanced ?? {}).length > 0);
    if (hasOverrides && !titleId) notes.push('Per-game overrides need the PS4 title ID (e.g. CUSA00001); only fullscreen is applied for this launch.');
    const args = ['--fullscreen', fullscreen ? 'true' : 'false'];
    if (profile?.customArgs) args.push(...splitArgs(profile.customArgs));
    // -g accepts an eboot.bin path or a game folder (main.cpp, emulator.cpp Run appends eboot.bin to folders).
    args.push('-g', target.path);
    return {
      command: executable,
      args,
      targetArgs: 2,
      // shadPS4 picks <cwd>/user as its data folder (path_util.cpp UserPaths).
      cwd: this.paths().data,
      logFile: this.logPath(),
      prepare: async () => {
        await this.ensureDirs();
        if (hasOverrides && titleId && profile) {
          const keys = await this.writeGameConfig(titleId, profile.overrides, settings);
          if (keys.length) notes.push(`Per-game settings written to custom_configs/${titleId}.json (${keys.join(', ')}).`);
        }
      },
      notes,
    };
  }

  /** Big Picture mode (-b): shadPS4's built-in controller-friendly game list and settings. */
  buildUiLaunch(executable: string): LaunchCommand {
    return { command: executable, args: ['-b'], cwd: this.paths().data, logFile: join(this.userDir(), 'log', 'shadps4.log'), prepare: () => this.ensureDirs(), notes: ['Opens shadPS4 Big Picture mode with the OmniPC-managed user folder.'] };
  }

  async smokeTest(executable: string): Promise<SmokeTestResult> {
    const checks: SmokeTestResult['checks'] = [];
    const exeOk = existsSync(executable);
    checks.push({ label: 'Executable present', ok: exeOk, detail: executable });
    if (!exeOk) return { ran: true, ok: false, checks };
    const insp = await this.inspectConfig();
    const cfg = insp.files[0];
    checks.push({ label: 'config.json parses', ok: cfg.parseOk, detail: cfg.issues.join('; ') || cfg.path });
    const userOk = existsSync(this.userDir());
    checks.push({ label: 'Portable user folder present', ok: userOk, detail: userOk ? this.userDir() : 'Missing: shadPS4 would use %APPDATA%\\shadPS4 instead. Run "Apply configuration".' });
    if (!isWindows) {
      checks.push({ label: 'Executable starts (--help)', ok: true, detail: 'Skipped: only possible on Windows' });
      return { ran: false, ok: checks.every((c) => c.ok), checks };
    }
    // CLI11 prints usage for --help and exits 0 before any window or config is created (main.cpp).
    // cwd = data so the static user-path setup uses the portable folder, not %APPDATA%.
    const r = await runProcess(executable, ['--help'], { timeoutMs: 20000, cwd: userOk ? this.paths().data : dirname(executable) });
    const ok = !r.error && !r.timedOut && r.code === 0 && /--game/.test(r.stdout);
    checks.push({
      label: 'Executable starts (--help)',
      ok,
      detail: r.error ? r.error.message : r.timedOut ? 'Timed out after 20s' : `Exit code ${r.code}${r.stdout ? `: ${r.stdout.split(/\r?\n/)[0].slice(0, 200)}` : ''}`,
    });
    return { ran: true, ok: checks.every((c) => c.ok), checks };
  }

  async validateEnvironment(hw: HardwareProfile | null, _executable: string | null): Promise<Finding[]> {
    const subject = { kind: 'emulator' as const, id: 'shadps4', label: 'shadPS4' };
    const out: Finding[] = [];
    if (hw && hw.graphicsApis.vulkan === false) {
      out.push({
        id: 'shadps4.vulkan', checkId: 'shadps4.graphics', category: 'emulators', severity: 'problem', title: 'shadPS4 needs Vulkan 1.3',
        detail: 'No Vulkan driver was detected. shadPS4 only renders with Vulkan 1.3 and stops at startup without it.', subject,
        evidence: [...hw.graphicsApis.notes, `GPUs: ${hw.gpus.map((g) => g.name).join(', ') || 'none detected'}`], confidence: 'high', repair: null,
        manualSteps: ['Install the latest graphics driver from your GPU vendor (NVIDIA, AMD or Intel).', 'Make sure the GPU supports Vulkan 1.3.'],
      });
    } else if (hw && hw.graphicsApis.vulkan === null) {
      out.push({
        id: 'shadps4.vulkan-unknown', checkId: 'shadps4.graphics', category: 'emulators', severity: 'warning', title: 'Vulkan support could not be confirmed',
        detail: 'shadPS4 requires Vulkan 1.3. OmniPC could not determine whether a Vulkan driver is installed.', subject, evidence: hw.graphicsApis.notes, confidence: 'low', repair: null,
        manualSteps: ['Install the latest graphics driver from your GPU vendor.'],
      });
    }
    if (hw && hw.cpu.features.length && !hw.cpu.features.includes('avx2')) {
      out.push({
        id: 'shadps4.avx2', checkId: 'shadps4.cpu', category: 'emulators', severity: 'problem', title: 'shadPS4 needs a CPU with AVX2',
        detail: 'Official shadPS4 builds target x86-64-v3 (AVX2, BMI, FMA). On this CPU it crashes immediately with an illegal-instruction error.', subject,
        evidence: [`CPU: ${hw.cpu.model}`, `Features: ${hw.cpu.features.join(', ')}`], confidence: 'high', repair: null, manualSteps: ['shadPS4 cannot run on this processor.'],
      });
    }
    out.push({
      id: 'shadps4.compatibility', checkId: 'shadps4.compatibility', category: 'emulators', severity: 'info', title: 'PS4 compatibility varies per game',
      detail: 'shadPS4 is early in development: some games are playable, many boot with glitches or not at all, and results change between releases. Check https://github.com/shadps4-compatibility/shadps4-game-compatibility before troubleshooting a game. Some games also need firmware modules or system fonts dumped from your own PS4.',
      subject, evidence: [], confidence: 'high', repair: null, manualSteps: [],
    });
    return out;
  }

  saveLocations(): { label: string; path: string }[] {
    const s = this.paths().saves;
    return [
      { label: 'Game saves (user 1)', path: join(s, '1000', 'savedata') },
      { label: 'Trophies (user 1)', path: join(s, '1000', 'trophy') },
      { label: 'All PS4 user folders', path: s },
    ];
  }

  async biosStatus(): Promise<BiosStatus[]> {
    const dir = this.paths().bios;
    const names = existsSync(dir) ? await readdir(dir).catch(() => [] as string[]) : [];
    const lower = new Map(SHADPS4_SYS_MODULES.map((m) => [m.toLowerCase(), m]));
    const files: BiosStatus['files'] = [];
    for (const n of names) {
      const known = lower.get(n.toLowerCase());
      if (!known && !/\.sprx$/i.test(n)) continue;
      const p = join(dir, n);
      const st = await stat(p).catch(() => null);
      if (!st?.isFile()) continue;
      files.push({ path: p, sizeBytes: st.size, valid: !!known && st.size > 0, description: known ? `Firmware module ${known}` : 'Not a module shadPS4 loads from sys_modules' });
    }
    const valid = files.filter((f) => f.valid);
    const status: BiosStatus['status'] = valid.length ? 'found' : files.length ? 'invalid' : 'missing';
    const note = valid.length
      ? `${valid.length} of ${SHADPS4_SYS_MODULES.length} supported firmware modules found; shadPS4 loads them from this folder (General.sys_modules_dir). Missing ones fall back to built-in emulation.`
      : 'Optional. shadPS4 runs many games without firmware, but some need modules dumped from your own PS4 (e.g. libSceLibcInternal.sprx, libSceNgs2.sprx, libSceFont.sprx). Place the .sprx files here (per-game ones in a <TITLE_ID> subfolder) and dumped system fonts in fonts\\font and fonts\\font2. OmniPC never downloads firmware.';
    return [{
      systemId: 'ps4', systemName: 'PlayStation 4', label: 'PS4 firmware modules (sys_modules)', required: false, requirementKind: 'firmware', emulatorId: 'shadps4',
      expectedLocation: dir, status, files, note,
    }];
  }

  logFile(): string | null {
    return this.logPath();
  }

  cacheDirs(): { label: string; path: string }[] {
    return [{ label: 'Pipeline/shader cache', path: join(this.userDir(), 'cache') }];
  }

  async recoverSession(): Promise<string[]> {
    // Per-game settings use shadPS4's own custom_configs files; nothing is swapped for a session.
    return [];
  }

  /**
   * SetupImportCandidate.source has no 'shadps4' value yet, so existing installs
   * (%APPDATA%\shadPS4 or a portable "user" folder next to shadPS4.exe) are not offered.
   */
  async detectExistingSetups(): Promise<SetupImportCandidate[]> {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampScale(n: number): number {
  return Math.max(1, Math.min(2, Math.round(Number.isFinite(n) ? n : 2)));
}

/** 1 = 720p, 2 = 1080p video-out by preset, hardware tier and display. */
export function shadps4ResolutionScale(hw: HardwareProfile | null, preset: PerformancePreset): number {
  if (preset === 'performance' || hw?.tier === 'low') return 1;
  const display = hw?.displays.find((d) => d.primary) ?? hw?.displays[0];
  if (display && display.height < 1000) return 1;
  return 2;
}

function isObject(v: Json | undefined): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasType(v: Json, t: 'string' | 'boolean' | 'integer'): boolean {
  return t === 'integer' ? typeof v === 'number' && Number.isInteger(v) && v >= 0 : typeof v === t;
}

function normPath(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
}

async function readJsonObject(path: string): Promise<JsonObject | null> {
  if (!existsSync(path)) return null;
  try {
    const j = JSON.parse(await readFile(path, 'utf8')) as Json;
    return isObject(j) ? j : null;
  } catch {
    return null;
  }
}

export function getJson(doc: JsonObject, path: string): Json | undefined {
  const [g, k] = path.split('.');
  const grp = doc[g];
  return isObject(grp) ? grp[k] : undefined;
}

/** Sets Group.key, creating the group; returns true when the value changed. */
export function setJson(doc: JsonObject, path: string, v: Json): boolean {
  const [g, k] = path.split('.');
  if (!isObject(doc[g])) doc[g] = {};
  const grp = doc[g] as JsonObject;
  if (JSON.stringify(grp[k]) === JSON.stringify(v)) return false;
  grp[k] = v;
  return true;
}

/**
 * settings.advanced entries of the form "Group.key" (e.g. "GPU.readbacks_mode") are written to
 * config.json. Values are typed after the existing value (shadPS4 rejects mismatched types).
 */
function advancedValues(adv: Record<string, string>, doc: JsonObject): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [key, raw] of Object.entries(adv)) {
    const m = /^([A-Za-z]+)\.([A-Za-z0-9_]+)$/.exec(key);
    if (!m || !GROUPS.includes(m[1]) || MANAGED_TYPES[key] === 'string' && /_dir$/.test(m[2])) continue;
    const v = String(raw).trim();
    const declared = SHADPS4_TYPES[key];
    if (declared) {
      // Menu settings: write the JSON type shadPS4 expects, whatever is in the file now.
      if (declared === 'boolean') {
        if (/^(true|false|1|0)$/i.test(v)) out[key] = /^(true|1)$/i.test(v);
      } else if (declared === 'string') out[key] = v;
      else if (/^-?\d+(\.\d+)?$/.test(v)) out[key] = declared === 'integer' ? Math.round(Number(v)) : Number(v);
      continue;
    }
    const existing = getJson(doc, key);
    if (typeof existing === 'boolean' || (existing === undefined && /^(true|false)$/i.test(v))) {
      if (/^(true|false|1|0)$/i.test(v)) out[key] = /^(true|1)$/i.test(v);
    } else if (typeof existing === 'number' || (existing === undefined && /^-?\d+(\.\d+)?$/.test(v))) {
      if (/^-?\d+(\.\d+)?$/.test(v)) out[key] = Number(v);
    } else if (existing === undefined || typeof existing === 'string') {
      out[key] = v;
    }
  }
  return out;
}

/** Title ID from the library serial or the game folder name (shadPS4 keys per-game files by it). */
function gameTitleId(target: LaunchTarget): string | null {
  const s = target.serial?.replace(/[-_\s]/g, '').toUpperCase() ?? '';
  if (TITLE_ID_RE.test(s)) return s;
  const folder = basename(basename(target.path).toLowerCase() === 'eboot.bin' ? dirname(target.path) : target.path).toUpperCase();
  const m = /^([A-Z]{4}\d{5})/.exec(folder);
  return m ? m[1] : null;
}

/** True when every input token on the right-hand side is a gamepad token (keyboard/mouse lines are user-owned). */
function isControllerInput(inputs: string): boolean {
  const toks = inputs.split(',').map((t) => t.replace(/:\d+$/, '')).filter(Boolean);
  return toks.length > 0 && toks.every((t) => CONTROLLER_TOKENS.has(t));
}

/**
 * Replaces (or appends) the OmniPC block and drops lines outside it for which `managed(output, inputs)`
 * is true, so the universal mapping is not doubled by older controller lines. Other lines are kept verbatim.
 */
function replaceBlock(text: string, block: string[], managed: (output: string, inputs: string) => boolean): string {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const kept: string[] = [];
  let insertAt = -1;
  let inBlock = false;
  for (const line of lines) {
    if (line.trim() === BLOCK_START) {
      inBlock = true;
      if (insertAt < 0) insertAt = kept.length;
      continue;
    }
    if (inBlock) {
      if (line.trim() === BLOCK_END) inBlock = false;
      continue;
    }
    const compact = line.replace(/\s+/g, '').replace(/#.*$/, '');
    const eq = compact.indexOf('=');
    if (eq > 0 && managed(compact.slice(0, eq).replace(/:\d+$/, ''), compact.slice(eq + 1))) continue;
    kept.push(line);
  }
  const blockLines = [BLOCK_START, ...block, BLOCK_END];
  if (insertAt < 0) {
    while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
    if (kept.length) kept.push('');
    insertAt = kept.length;
  }
  kept.splice(insertAt, 0, ...blockLines);
  return kept.join(eol) + eol;
}

function controllerBlock(profile: UniversalControllerProfile): { lines: string[]; notes: string[] } {
  const lines: string[] = [];
  const unsupported: string[] = [];
  for (const [output, logical] of PAD_OUTPUTS) {
    const physical = physicalFor(profile, 'ps4', logical);
    let token = PHYSICAL_TOKEN[physical];
    if (!token) {
      unsupported.push(`${output} -> ${physical}`);
      token = PHYSICAL_TOKEN[logical]!;
    }
    lines.push(`${output} = ${token}`);
  }
  for (const s of STICK_OUTPUTS) lines.push(`${s} = ${s}`);
  // analog_deadzone range: 1 (almost none) to 127 (input_handler.cpp default config comment).
  const inner = Math.max(1, Math.min(127, Math.round((Number.isFinite(profile.deadzone) ? profile.deadzone : 0.15) * 127)));
  lines.push(`analog_deadzone = leftjoystick, ${inner}, 127`, `analog_deadzone = rightjoystick, ${inner}, 127`);
  const notes = unsupported.length ? [`shadPS4 cannot bind ${unsupported.join(', ')} (no such gamepad input); the default button is used instead.`] : [];
  return { lines, notes };
}

function hotkeyBlock(cfg: HotkeyConfig, supported: HotkeyAction[], globalText: string): { lines: string[]; notes: string[] } {
  const lines: string[] = [];
  const notes: string[] = [];
  // Outputs that already have a user line outside the managed block keep the user's keyboard binding.
  const outside = new Set<string>();
  let inBlock = false;
  for (const raw of globalText.split(/\r?\n/)) {
    const t = raw.trim();
    if (t === BLOCK_START) inBlock = true;
    else if (t === BLOCK_END) inBlock = false;
    else if (!inBlock) {
      const c = t.replace(/\s+/g, '').replace(/#.*$/, '');
      const eq = c.indexOf('=');
      if (eq > 0 && !isControllerInput(c.slice(eq + 1))) outside.add(c.slice(0, eq));
    }
  }
  for (const { action, buttons } of hotkeyChords(cfg, supported)) {
    const output = HOTKEY_OUTPUT[action];
    if (!output) continue;
    const toks = buttons.map((b) => PHYSICAL_TOKEN[b]);
    if (toks.some((t) => !t)) {
      notes.push(`Hotkey ${action} uses ${buttons.join('+')}, which shadPS4 cannot read as gamepad input; it was not bound.`);
    } else lines.push(`${output} = ${toks.join(', ')}`);
    // Writing the output stops shadPS4 from adding its keyboard default, so keep that explicitly.
    if (!outside.has(output)) lines.push(`${output} = ${HOTKEY_KEYBOARD_DEFAULT[output]}`);
  }
  return { lines, notes };
}
