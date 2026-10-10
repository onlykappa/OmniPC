// RPCS3 adapter (PlayStation 3).
// Layout:
//   Emulators/rpcs3/app        program files (replaced on update)
//   Emulators/rpcs3/data       RPCS3_CONFIG_DIR (Utilities/File.cpp fs::get_config_dir):
//                                config/config.yml, config/vfs.yml, config/input_configs/,
//                                GuiConfigs/CurrentSettings.ini, log/RPCS3.log, cache/,
//                                savestates/, dev_flash/ (installed firmware), dev_hdd1/
//   Saves/rpcs3/dev_hdd0       PS3 internal HDD (saves, installed games, trophies) via vfs.yml
//   Saves/rpcs3/dev_usb000     virtual USB stick via vfs.yml
//   BIOS/ps3/PS3UPDAT.PUP      user-supplied firmware, installed with `rpcs3 --installfw`

import { existsSync } from 'node:fs';
import { copyFile, mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import type { BiosStatus, EmulatorManifest, EmulatorSettings, Finding, GameProfile, HardwareProfile, PerformancePreset, RendererOption, SetupImportCandidate, UniversalButton, UniversalControllerProfile } from '@shared/models';
import manifestJson from '../manifests/rpcs3.json';
import type { AdapterCapabilities, AdapterPaths, ConfigInput, ConfigInspection, ConfigWriteResult, EmulatorAdapter, LaunchCommand, LaunchTarget, SmokeTestResult } from '../adapter';
import type { AppPaths } from '../../core/paths';
import type { BackupTarget } from '../../config/backups';
import { atomicWrite, loadIni, saveIni } from '../../config/iniFile';
import { checkIni } from '../../config/formats';
import { hotkeyChords, physicalFor } from '../../controllers/translate';
import { findExeIn, resolutionScaleFor } from '../common';
import { runProcess } from '../../platform/exec';
import { isWindows } from '../../platform/powershell';
import { splitArgs } from '../pcsx2/adapter';
import { YamlDocument, checkYaml } from './yaml';

export const RPCS3_MANIFEST = manifestJson as unknown as EmulatorManifest;

/** Environment variable read by fs::get_config_dir() on Windows (Utilities/File.cpp). */
export const RPCS3_CONFIG_ENV = 'RPCS3_CONFIG_DIR';

/** video_renderer strings (Emu/system_config_types.cpp). No Direct3D backend exists. */
export const RPCS3_RENDERERS: Record<string, string> = { vulkan: 'Vulkan', opengl: 'OpenGL', null: 'Null' };

type YamlValue = [path: string[], value: string | number | boolean];

/** Pad handler per controller kind (Emu/Io/pad_config_types.cpp) and its device prefix (m_name_string, 1-based). */
interface HandlerSpec {
  handler: string;
  devicePrefix: string;
  maxDevices: number;
  /** Stick deadzone range: thumb_max of the handler. */
  thumbMax: number;
  tokens: Record<UniversalButton, string>;
}

const STICKS = {
  LeftStickUp: 'LS Y+', LeftStickDown: 'LS Y-', LeftStickLeft: 'LS X-', LeftStickRight: 'LS X+',
  RightStickUp: 'RS Y+', RightStickDown: 'RS Y-', RightStickLeft: 'RS X-', RightStickRight: 'RS X+',
} as const;

/** Input/xinput_pad_handler.cpp button_list. */
const XINPUT_TOKENS: Record<UniversalButton, string> = {
  A: 'A', B: 'B', X: 'X', Y: 'Y', LB: 'LB', RB: 'RB', LT: 'LT', RT: 'RT', L3: 'LS', R3: 'RS',
  Start: 'Start', Select: 'Back', Guide: 'Guide',
  DPadUp: 'Up', DPadDown: 'Down', DPadLeft: 'Left', DPadRight: 'Right',
  ...STICKS,
};

/** Input/ds4_pad_handler.cpp and dualsense_pad_handler.cpp button_list (positional: A = south = Cross). */
const SONY_TOKENS: Record<UniversalButton, string> = {
  A: 'Cross', B: 'Circle', X: 'Square', Y: 'Triangle', LB: 'L1', RB: 'R1', LT: 'L2', RT: 'R2', L3: 'L3', R3: 'R3',
  Start: 'Options', Select: 'Share', Guide: 'PS Button',
  DPadUp: 'Up', DPadDown: 'Down', DPadLeft: 'Left', DPadRight: 'Right',
  ...STICKS,
};

const HANDLERS: Record<'xinput' | 'ds4' | 'dualsense', HandlerSpec> = {
  xinput: { handler: 'XInput', devicePrefix: 'XInput Pad #', maxDevices: 4, thumbMax: 32767, tokens: XINPUT_TOKENS },
  ds4: { handler: 'DualShock 4', devicePrefix: 'DS4 Pad #', maxDevices: 8, thumbMax: 255, tokens: SONY_TOKENS },
  dualsense: { handler: 'DualSense', devicePrefix: 'DualSense Pad #', maxDevices: 8, thumbMax: 255, tokens: SONY_TOKENS },
};

/** cfg_pad key (Emu/Io/pad_config.h) -> logical universal button (positional DualShock 3 layout). */
const PS3_PAD: [string, UniversalButton][] = [
  ['Cross', 'A'], ['Circle', 'B'], ['Square', 'X'], ['Triangle', 'Y'],
  ['L1', 'LB'], ['R1', 'RB'], ['L2', 'LT'], ['R2', 'RT'], ['L3', 'L3'], ['R3', 'R3'],
  ['Start', 'Start'], ['Select', 'Select'],
  ['Up', 'DPadUp'], ['Down', 'DPadDown'], ['Left', 'DPadLeft'], ['Right', 'DPadRight'],
  ['Left Stick Up', 'LeftStickUp'], ['Left Stick Down', 'LeftStickDown'], ['Left Stick Left', 'LeftStickLeft'], ['Left Stick Right', 'LeftStickRight'],
  ['Right Stick Up', 'RightStickUp'], ['Right Stick Down', 'RightStickDown'], ['Right Stick Left', 'RightStickLeft'], ['Right Stick Right', 'RightStickRight'],
];

const PLAYER = 'Player 1 Input';

/** Forward-slash directory form with a trailing slash, as RPCS3 stores VFS paths (vfs_config.cpp cfg_vfs::get). */
export function rpcs3Dir(p: string): string {
  const s = p.replace(/\\/g, '/');
  return s.endsWith('/') ? s : `${s}/`;
}

function samePath(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  const n = (s: string) => rpcs3Dir(s).toLowerCase();
  return n(a) === n(b);
}

export interface FirmwareInstallResult {
  ok: boolean;
  pup: string | null;
  installedVersion: string | null;
  notes: string[];
}

export class Rpcs3Adapter implements EmulatorAdapter {
  readonly manifest = RPCS3_MANIFEST;
  readonly capabilities: AdapterCapabilities = {
    perGameProfiles: 'native',
    frameLimit: true,
    vsync: true,
    aspectRatios: [
      { id: '16:9', label: '16:9' },
      { id: '4:3', label: '4:3' },
      { id: 'stretch', label: 'Stretch to window' },
    ],
    hotkeys: ['menu'],
    smokeTest: true,
    maxResolutionScale: 4,
  };

  constructor(private readonly app: AppPaths) {}

  paths(): AdapterPaths {
    return {
      app: this.app.emulatorAppDir('rpcs3'),
      data: this.app.emulatorDataDir('rpcs3'),
      saves: this.app.emulatorSaveDir('rpcs3'),
      bios: this.app.systemBiosDir('ps3'),
      cache: this.app.emulatorCacheDir('rpcs3'),
    };
  }

  /** fs::get_config_dir(true) on Windows: <config dir>/config/. */
  configDir(): string {
    return join(this.paths().data, 'config');
  }

  configYml(): string {
    return join(this.configDir(), 'config.yml');
  }

  vfsYml(): string {
    return join(this.configDir(), 'vfs.yml');
  }

  inputYml(): string {
    return join(this.configDir(), 'input_configs', 'global', 'Default.yml');
  }

  activeInputYml(): string {
    return join(this.configDir(), 'input_configs', 'active_input_configurations.yml');
  }

  guiIni(): string {
    return join(this.paths().data, 'GuiConfigs', 'CurrentSettings.ini');
  }

  /** Value for RPCS3_CONFIG_DIR. RPCS3 truncates after the last slash, so the trailing separator is required. */
  configEnvValue(): string {
    const d = this.paths().data;
    return d.endsWith(sep) || d.endsWith('/') ? d : d + sep;
  }

  launchEnv(): Record<string, string> {
    return { [RPCS3_CONFIG_ENV]: this.configEnvValue() };
  }

  /** Effective firmware location (dev_flash) managed through vfs.yml. */
  devFlashDir(): string {
    return join(this.paths().data, 'dev_flash');
  }

  devHdd0Dir(): string {
    return join(this.paths().saves, 'dev_hdd0');
  }

  async findExecutable(appDir: string): Promise<string | null> {
    return findExeIn(appDir, [/^rpcs3\.exe$/i, /^rpcs3$/]);
  }

  /**
   * rpcs3.exe has no VERSIONINFO resource (rpcs3.rc only holds icons), so the
   * version comes from `--version` (QCommandLineParser) on Windows, falling back
   * to the "RPCS3 v<version>" banner RPCS3 writes at the top of RPCS3.log.
   */
  async detectVersion(executable: string): Promise<string | null> {
    if (isWindows && existsSync(executable)) {
      const r = await runProcess(executable, ['--version'], { timeoutMs: 20000, cwd: this.paths().app, env: { ...process.env, ...this.launchEnv(), QT_COMMAND_LINE_PARSER_NO_GUI_MESSAGE_BOXES: '1' } });
      const v = parseRpcs3Version(`${r.stdout}\n${r.stderr}`);
      if (v) return v;
    }
    const log = this.logFile();
    if (log && existsSync(log)) {
      const head = await readHead(log, 4096);
      const v = parseRpcs3Version(head);
      if (v) return v;
    }
    return null;
  }

  renderers(hw: HardwareProfile | null): RendererOption[] {
    const vk = hw?.graphicsApis.vulkan;
    return [
      { id: 'vulkan', label: 'Vulkan (recommended)', available: vk !== false, note: vk === false ? 'No Vulkan driver detected' : undefined },
      { id: 'opengl', label: 'OpenGL', available: true },
    ];
  }

  defaultSettings(hw: HardwareProfile | null, preset: PerformancePreset): EmulatorSettings {
    // resolutionScaleFor assumes ~480p consoles; PS3 games render at 720p, so 2/3 of that scale gives the same output size.
    const scale = Math.max(1, Math.min(this.capabilities.maxResolutionScale, Math.round((resolutionScaleFor(hw, preset, 6) * 2) / 3)));
    return {
      preset,
      resolutionScale: scale,
      renderer: hw?.graphicsApis.vulkan === false ? 'opengl' : 'vulkan',
      aspectRatio: '16:9',
      fullscreen: true,
      frameLimit: true,
      vsync: preset !== 'performance',
      advanced: {},
    };
  }

  configTargets(): BackupTarget[] {
    const root = this.paths().data;
    return [this.configYml(), this.vfsYml(), this.inputYml(), this.guiIni()].map((path) => ({ root, path }));
  }

  private async ensureDirs(): Promise<void> {
    const p = this.paths();
    for (const d of [p.app, p.data, this.configDir(), join(this.configDir(), 'input_configs', 'global'), join(p.data, 'GuiConfigs'), join(p.data, 'log'), this.devFlashDir(), join(p.data, 'dev_hdd1'), this.devHdd0Dir(), join(p.saves, 'dev_usb000'), p.bios, p.cache]) {
      await mkdir(d, { recursive: true });
    }
  }

  /** vfs.yml entries (keys from Emu/vfs_config.h). */
  vfsValues(): YamlValue[] {
    const p = this.paths();
    return [
      [['/dev_hdd0/'], rpcs3Dir(this.devHdd0Dir())],
      [['/dev_hdd1/'], rpcs3Dir(join(p.data, 'dev_hdd1'))],
      [['/dev_flash/'], rpcs3Dir(this.devFlashDir())],
      [['/dev_usb***/', '/dev_usb000', 'Path'], rpcs3Dir(join(p.saves, 'dev_usb000'))],
    ];
  }

  /** config.yml behaviour keys that keep batch launches non-interactive (Emu/system_config.h node_misc). */
  behaviourValues(): YamlValue[] {
    return [
      [['Miscellaneous', 'Exit RPCS3 when process finishes'], true],
      [['Miscellaneous', 'Automatically start games after boot'], true],
    ];
  }

  graphicsValues(s: EmulatorSettings): YamlValue[] {
    const scale = Math.max(1, Math.min(8, Math.round(s.resolutionScale)));
    return [
      [['Video', 'Renderer'], RPCS3_RENDERERS[s.renderer] ?? RPCS3_RENDERERS.vulkan],
      [['Video', 'Resolution Scale'], scale * 100],
      [['Video', 'Aspect ratio'], s.aspectRatio === '4:3' ? '4:3' : '16:9'],
      [['Video', 'Stretch To Display Area'], s.aspectRatio === 'stretch'],
      [['Video', 'VSync Mode'], s.vsync ? 'Full' : 'Disabled'],
      [['Video', 'Frame limit'], s.frameLimit ? 'Auto' : 'Off'],
      [['Miscellaneous', 'Start games in fullscreen mode'], s.fullscreen],
    ];
  }

  /** "Section|Key" or "Section/Sub|Key" advanced values -> YAML path. */
  advancedValues(adv: Record<string, string>): YamlValue[] {
    const out: YamlValue[] = [];
    for (const [key, value] of Object.entries(adv)) {
      const [section, name] = key.split('|');
      if (section && name) out.push([[...section.split('/'), name], value]);
    }
    return out;
  }

  /** GuiConfigs/CurrentSettings.ini keys (rpcs3qt/gui_settings.h) that would otherwise block a launch with a dialog. */
  guiValues(): [string, string, string][] {
    return [
      ['main_window', 'infoBoxEnabledWelcome', 'false'], // welcome_dialog shown by gui_application::exec even with --no-gui
      ['main_window', 'confirmationBoxExitGame', 'false'], // gs_frame::event "Exit Game?" on window close
      ['main_window', 'confirmationBoxBootGame', 'false'],
      ['Meta', 'checkUpdateStart', 'false'], // main_window update check (gui::update_off)
    ];
  }

  controllerSpec(c: UniversalControllerProfile): HandlerSpec {
    if (c.controllerKind === 'dualsense') return HANDLERS.dualsense;
    if (c.controllerKind === 'dualshock4') return HANDLERS.ds4;
    return HANDLERS.xinput;
  }

  controllerValues(input: ConfigInput): { values: YamlValue[]; notes: string[] } {
    const c = input.controller;
    const spec = this.controllerSpec(c);
    const notes: string[] = [];
    const idx = Math.max(0, Math.min(spec.maxDevices - 1, c.deviceIndex));
    if (idx !== c.deviceIndex) notes.push(`${spec.handler} supports ${spec.maxDevices} pads; using pad #${idx + 1}.`);
    if (c.controllerKind === 'switch_pro' || c.controllerKind === 'generic') {
      notes.push('RPCS3 names SDL devices after the controller model, so OmniPC configures the XInput handler. Use Steam Input or another XInput wrapper for this controller, or pick the SDL device once in RPCS3\'s pad settings.');
    }
    const tok = (b: UniversalButton) => spec.tokens[physicalFor(c, 'ps3', b)];
    const cfg = (k: string): string[] => [PLAYER, 'Config', k];
    const values: YamlValue[] = [
      [[PLAYER, 'Handler'], spec.handler],
      [[PLAYER, 'Device'], `${spec.devicePrefix}${idx + 1}`],
    ];
    for (const [key, logical] of PS3_PAD) values.push([cfg(key), tok(logical)]);
    // PS button opens RPCS3's home menu (Input/pad_thread.cpp open_home_menu): Guide, plus the menu hotkey chord.
    const ps = [tok('Guide')];
    for (const ch of hotkeyChords(input.hotkeys, this.capabilities.hotkeys)) {
      if (ch.action === 'menu') ps.push(ch.buttons.map((b) => spec.tokens[physicalFor(c, 'ps3', b)]).join('&'));
    }
    values.push([cfg('PS Button'), [...new Set(ps)].join(',')]);
    const dz = Math.round(Math.max(0, Math.min(1, c.deadzone)) * spec.thumbMax);
    values.push([cfg('Left Stick Deadzone'), dz], [cfg('Right Stick Deadzone'), dz]);
    const rumble = c.rumble ? 100 : 0;
    values.push([cfg('Large Vibration Motor Multiplier'), rumble], [cfg('Small Vibration Motor Multiplier'), rumble]);
    return { values, notes };
  }

  private async loadYaml(path: string): Promise<YamlDocument> {
    if (!existsSync(path)) return YamlDocument.empty();
    return YamlDocument.parse(await readFile(path, 'utf8'));
  }

  private async patchYaml(path: string, values: YamlValue[], label: string, changed: string[]): Promise<void> {
    const doc = await this.loadYaml(path);
    let dirty = !existsSync(path);
    for (const [p, v] of values) {
      if (doc.set(p, v)) {
        dirty = true;
        changed.push(`${label}: ${p.join('.')} = ${v}`);
      }
    }
    if (dirty) await atomicWrite(path, doc.toString());
  }

  async applyConfig(input: ConfigInput, scope: 'all' | 'controller' | 'graphics' | 'paths'): Promise<ConfigWriteResult> {
    await this.ensureDirs();
    const changed: string[] = [];
    const notes: string[] = [];
    if (scope === 'all' || scope === 'paths') {
      await this.patchYaml(this.vfsYml(), this.vfsValues(), 'vfs.yml', changed);
      await this.patchYaml(this.configYml(), this.behaviourValues(), 'config.yml', changed);
      await this.patchGui(changed);
    }
    if (scope === 'all' || scope === 'graphics') {
      await this.patchYaml(this.configYml(), [...this.graphicsValues(input.settings), ...this.advancedValues(input.settings.advanced)], 'config.yml', changed);
    }
    if (scope === 'all' || scope === 'controller') {
      const c = this.controllerValues(input);
      notes.push(...c.notes);
      await this.patchYaml(this.inputYml(), c.values, 'Default.yml', changed);
    }
    return { changed, notes };
  }

  private async patchGui(changed: string[]): Promise<void> {
    const path = this.guiIni();
    if (!existsSync(path)) {
      // QSettings writes "key=value"; seed the file in that style.
      await atomicWrite(path, '[main_window]\r\ninfoBoxEnabledWelcome=false\r\n');
      changed.push('CurrentSettings.ini: main_window.infoBoxEnabledWelcome = false');
    }
    const doc = await loadIni(path);
    let dirty = false;
    for (const [s, k, v] of this.guiValues()) {
      if (doc.set(s, k, v)) {
        dirty = true;
        changed.push(`CurrentSettings.ini: ${s}.${k} = ${v}`);
      }
    }
    if (dirty) await saveIni(path, doc);
  }

  async inspectConfig(): Promise<ConfigInspection> {
    const files: ConfigInspection['files'] = [];
    const drift: ConfigInspection['drift'] = [];
    const yamlFile = async (label: string, path: string) => {
      const exists = existsSync(path);
      const text = exists ? await readFile(path, 'utf8').catch(() => '') : '';
      const fmt = exists ? checkYaml(text) : { ok: false, issues: ['File does not exist'] };
      files.push({ label, path, exists, parseOk: exists && fmt.ok, issues: fmt.issues });
      return exists && fmt.ok ? YamlDocument.parse(text) : null;
    };
    const vfs = await yamlFile('vfs.yml', this.vfsYml());
    if (vfs) {
      for (const [p, expected] of this.vfsValues()) {
        const actual = vfs.get(p) ?? null;
        if (!samePath(actual, String(expected))) drift.push({ file: this.vfsYml(), key: p.join('.'), expected: String(expected), actual, critical: p[0] === '/dev_hdd0/' || p[0] === '/dev_flash/' });
      }
      const emuDir = vfs.get(['$(EmulatorDir)']);
      if (emuDir) drift.push({ file: this.vfsYml(), key: '$(EmulatorDir)', expected: '', actual: emuDir, critical: false });
    }
    const cfg = await yamlFile('config.yml', this.configYml());
    if (cfg) {
      for (const [p, expected] of this.behaviourValues()) {
        const actual = cfg.get(p) ?? null;
        if (actual !== String(expected)) drift.push({ file: this.configYml(), key: p.join('.'), expected: String(expected), actual, critical: false });
      }
    }
    await yamlFile('Controller (input_configs/global/Default.yml)', this.inputYml());
    const active = existsSync(this.activeInputYml()) ? YamlDocument.parse(await readFile(this.activeInputYml(), 'utf8').catch(() => '')) : null;
    const activeGlobal = active?.get(['Active Configurations', 'global']);
    if (activeGlobal && activeGlobal !== 'Default') {
      drift.push({ file: this.activeInputYml(), key: 'Active Configurations.global', expected: 'Default', actual: activeGlobal, critical: false });
    }
    const gui = this.guiIni();
    const guiExists = existsSync(gui);
    const guiText = guiExists ? await readFile(gui, 'utf8').catch(() => '') : '';
    const guiFmt = guiExists ? checkIni(guiText) : { ok: false, issues: ['File does not exist'] };
    files.push({ label: 'CurrentSettings.ini', path: gui, exists: guiExists, parseOk: guiExists && guiFmt.ok, issues: guiFmt.issues });
    if (guiExists && guiFmt.ok) {
      const doc = await loadIni(gui);
      for (const [s, k, v] of this.guiValues()) {
        const actual = doc.get(s, k) ?? null;
        // A welcome dialog or update prompt blocks --no-gui launches.
        if (actual !== v) drift.push({ file: gui, key: `${s}.${k}`, expected: v, actual, critical: k === 'infoBoxEnabledWelcome' });
      }
    }
    return { files, drift };
  }

  /** Overrides from a per-game profile as config.yml paths. */
  profileOverrides(base: EmulatorSettings, profile: GameProfile): YamlValue[] {
    const merged: EmulatorSettings = { ...base, ...(profile.overrides as Partial<EmulatorSettings>), advanced: {} };
    const o = profile.overrides;
    const g = this.graphicsValues(merged);
    const pick = (k: string) => g.filter(([p]) => p[1] === k);
    const out: YamlValue[] = [];
    if (o.renderer !== undefined) out.push(...pick('Renderer'));
    if (o.resolutionScale !== undefined) out.push(...pick('Resolution Scale'));
    if (o.aspectRatio !== undefined) out.push(...pick('Aspect ratio'), ...pick('Stretch To Display Area'));
    if (o.vsync !== undefined) out.push(...pick('VSync Mode'));
    if (o.frameLimit !== undefined) out.push(...pick('Frame limit'));
    if (o.fullscreen !== undefined) out.push(...pick('Start games in fullscreen mode'));
    out.push(...this.advancedValues(o.advanced ?? {}));
    return out;
  }

  /** RPCS3's own per-title config (Emu/system_utils.cpp get_custom_config_path). */
  customConfigPath(serial: string): string {
    return join(this.configDir(), 'custom_configs', `config_${serial}.yml`);
  }

  async buildLaunch(target: LaunchTarget, executable: string, settings: EmulatorSettings, profile: GameProfile | null, _version: string | null): Promise<LaunchCommand> {
    const p = this.paths();
    const args = ['--no-gui'];
    if (settings.fullscreen) args.push('--fullscreen');
    const notes: string[] = [];
    let prepare: LaunchCommand['prepare'];
    const overrides = profile ? this.profileOverrides(settings, profile) : [];
    if (overrides.length) {
      // --config switches RPCS3 to cfg_mode::config_override, which loads ONLY that file
      // (Emu/System.cpp Emulator::Load): build it from the global config + RPCS3's own
      // per-title config + the OmniPC overrides.
      const cfgPath = join(p.data, 'omnideck-gamecfg', `${target.gameId ?? 'adhoc'}.yml`);
      const serial = target.serial && /^[A-Z]{4}\d{5}$/.test(target.serial) ? target.serial : null;
      prepare = async () => {
        const doc = await this.loadYaml(this.configYml());
        if (serial && existsSync(this.customConfigPath(serial))) {
          const custom = await this.loadYaml(this.customConfigPath(serial));
          const merge = (path: string[]) => {
            for (const key of custom.keys(path)) {
              const child = [...path, key];
              const v = custom.get(child);
              if (v !== undefined) doc.set(child, v);
              else merge(child);
            }
          };
          merge([]);
        }
        for (const [path, v] of overrides) doc.set(path, v);
        await atomicWrite(cfgPath, doc.toString());
      };
      args.push('--config', cfgPath);
      notes.push(`Per-game profile applied with --config (${overrides.length} overrides on top of the global settings).`);
    }
    if (profile?.customArgs) args.push(...splitArgs(profile.customArgs));
    // The boot target is a positional argument; anything after "--" would be passed to the game itself.
    args.push(target.path);
    return { command: executable, args, cwd: p.app, env: this.launchEnv(), logFile: this.logFile(), prepare, notes };
  }

  buildUiLaunch(executable: string): LaunchCommand {
    return { command: executable, args: [], cwd: this.paths().app, env: this.launchEnv(), logFile: this.logFile(), notes: [] };
  }

  async smokeTest(executable: string): Promise<SmokeTestResult> {
    const checks: SmokeTestResult['checks'] = [];
    const app = this.paths().app;
    checks.push({ label: 'Executable present', ok: existsSync(executable), detail: executable });
    if (!existsSync(executable)) return { ran: true, ok: false, checks };
    const exeDir = join(executable, '..');
    const missing = ['Qt6Core.dll', 'Qt6Gui.dll', 'Qt6Widgets.dll', join('qt6', 'plugins')].filter((f) => !existsSync(join(exeDir, f)));
    checks.push({ label: 'Qt runtime files present', ok: missing.length === 0, detail: missing.length ? `Missing: ${missing.join(', ')}` : 'Qt6 DLLs and plugins found' });
    const portable = join(exeDir, 'portable');
    checks.push({ label: 'No "portable" folder overriding OmniPC paths', ok: !existsSync(portable), detail: existsSync(portable) ? `${portable} exists, so RPCS3 ignores RPCS3_CONFIG_DIR and keeps everything there` : 'OK' });
    const insp = await this.inspectConfig();
    const broken = insp.files.filter((f) => f.exists && !f.parseOk);
    checks.push({ label: 'Configuration parses', ok: broken.length === 0, detail: broken.map((f) => `${f.label}: ${f.issues.join('; ')}`).join(' | ') || 'config.yml, vfs.yml, Default.yml, CurrentSettings.ini OK' });
    if (!isWindows) {
      checks.push({ label: 'Executable starts (--version)', ok: true, detail: 'Skipped: only possible on Windows' });
      return { ran: false, ok: checks.every((c) => c.ok), checks };
    }
    const r = await runProcess(executable, ['--version'], { timeoutMs: 30000, cwd: app, env: { ...process.env, ...this.launchEnv(), QT_COMMAND_LINE_PARSER_NO_GUI_MESSAGE_BOXES: '1' } });
    const ok = !r.error && !r.timedOut && r.code === 0;
    checks.push({
      label: 'Executable starts (--version)',
      ok,
      detail: r.error ? r.error.message : r.timedOut ? 'Timed out after 30s (another RPCS3 instance may be running)' : `Exit code ${r.code}${parseRpcs3Version(r.stdout) ? `, version ${parseRpcs3Version(r.stdout)}` : ''}`,
    });
    return { ran: true, ok: checks.every((c) => c.ok), checks };
  }

  async validateEnvironment(hw: HardwareProfile | null, executable: string | null): Promise<Finding[]> {
    const out: Finding[] = [];
    const subject = { kind: 'emulator' as const, id: 'rpcs3', label: 'RPCS3' };
    const norm = (x: string) => x.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const data = norm(this.paths().data);
    const od = [process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial].find((o) => !!o && data.startsWith(`${norm(o)}/`));
    if (od) {
      out.push({
        id: 'rpcs3.onedrive', checkId: 'rpcs3.location', category: 'emulators', severity: 'problem', title: 'RPCS3 data folder is inside OneDrive',
        detail: 'RPCS3 refuses to start when its configuration folder is synced by OneDrive ("RPCS3 should never be run from a OneDrive path!").', subject,
        evidence: [`Data folder: ${this.paths().data}`, `OneDrive folder: ${od}`], confidence: 'medium', repair: null,
        manualSteps: ['Move the OmniPC data folder to a location outside OneDrive (Settings > Storage).'],
      });
    }
    if (hw && hw.graphicsApis.vulkan === false) {
      out.push({
        id: 'rpcs3.vulkan', checkId: 'rpcs3.graphics', category: 'graphics', severity: 'warning', title: 'No Vulkan driver detected',
        detail: 'RPCS3 runs best on Vulkan. Without it only the slower OpenGL renderer is available.', subject,
        evidence: hw.graphicsApis.notes, confidence: 'medium', repair: null, manualSteps: ['Install the latest graphics driver from your GPU vendor.'],
      });
    }
    if (hw && hw.cpu.features.length && !hw.cpu.features.includes('avx')) {
      out.push({
        id: 'rpcs3.avx', checkId: 'rpcs3.cpu', category: 'emulators', severity: 'warning', title: 'CPU without AVX',
        detail: 'RPCS3 runs on CPUs without AVX but its recompilers fall back to slower code paths (Utilities/JITLLVM.cpp), so most games will be slow.', subject,
        evidence: [`CPU features: ${hw.cpu.features.join(', ')}`], confidence: 'high', repair: null, manualSteps: [],
      });
    }
    const pup = (await this.firmwareFiles()).find((f) => f.valid);
    if (executable && pup && !(await this.installedFirmwareVersion())) {
      out.push({
        id: 'rpcs3.firmware', checkId: 'rpcs3.firmware', category: 'bios', severity: 'problem', title: 'PS3 firmware found but not installed',
        detail: 'PS3UPDAT.PUP is in the BIOS folder but has not been installed into RPCS3 yet. PS3 games cannot start without it.', subject,
        evidence: [pup.path], confidence: 'high',
        repair: { actionId: 'emulator.installFirmware', label: 'Install PS3 firmware', safety: 'low', params: { emulatorId: 'rpcs3' }, description: 'Opens RPCS3\'s firmware installer for your PS3UPDAT.PUP. Confirm in RPCS3, then close it when it finishes.' },
        manualSteps: [],
      });
    }
    if (executable && existsSync(join(executable, '..', 'portable'))) {
      out.push({
        id: 'rpcs3.portable', checkId: 'rpcs3.paths', category: 'emulators', severity: 'warning', title: 'RPCS3 "portable" folder found',
        detail: 'A "portable" folder next to rpcs3.exe makes RPCS3 ignore OmniPC\'s data folder (fs::get_config_dir checks it first).', subject,
        evidence: [join(executable, '..', 'portable')], confidence: 'high', repair: null, manualSteps: ['Move your data out of the "portable" folder and delete it.'],
      });
    }
    return out;
  }

  saveLocations(): { label: string; path: string }[] {
    const p = this.paths();
    return [
      { label: 'PS3 HDD (saves, installed games, trophies)', path: this.devHdd0Dir() },
      { label: 'Save data', path: join(this.devHdd0Dir(), 'home', '00000001', 'savedata') },
      { label: 'Virtual USB (dev_usb000)', path: join(p.saves, 'dev_usb000') },
      { label: 'Save states', path: join(p.data, 'savestates') },
    ];
  }

  /** Firmware version as RPCS3 reads it (util/sysinfo.cpp utils::get_firmware_version). */
  async installedFirmwareVersion(): Promise<string | null> {
    const f = join(this.devFlashDir(), 'vsh', 'etc', 'version.txt');
    if (!existsSync(f)) return null;
    const text = await readFile(f, 'utf8').catch(() => '');
    const m = /:([^:]*):/.exec(text);
    if (!m) return null;
    const v = m[1].replace(/^0+(?=\d)/, '').replace(/0+$/, '');
    return v.endsWith('.') ? `${v}0` : v || null;
  }

  /** PUP files in the BIOS folder with their header check (Loader/PUP.cpp: magic "SCEUF\0\0\0"). */
  async firmwareFiles(): Promise<BiosStatus['files']> {
    const dir = this.paths().bios;
    const files: BiosStatus['files'] = [];
    if (!existsSync(dir)) return files;
    for (const f of await readdir(dir)) {
      if (!/\.pup$/i.test(f)) continue;
      const full = join(dir, f);
      const st = await stat(full).catch(() => null);
      if (!st?.isFile()) continue;
      const head = await readHead(full, 8, 'latin1');
      const valid = head === 'SCEUF\0\0\0';
      files.push({ path: full, sizeBytes: st.size, valid, description: valid ? 'PS3 system software update (PUP)' : 'Not a PS3 PUP file (bad header)' });
    }
    files.sort((a, b) => Number(/ps3updat\.pup$/i.test(b.path)) - Number(/ps3updat\.pup$/i.test(a.path)));
    return files;
  }

  async biosStatus(): Promise<BiosStatus[]> {
    const files = await this.firmwareFiles();
    const installed = await this.installedFirmwareVersion();
    const pup = files.find((f) => f.valid);
    let status: BiosStatus['status'];
    let note: string;
    if (installed) {
      status = 'found';
      note = `Firmware ${installed} is installed in RPCS3.${pup ? ' To update it, replace the PUP in this folder and run "Install firmware".' : ''}`;
    } else if (pup) {
      status = 'missing';
      note = `${pup.path} is present but not installed yet. Run "Install firmware" so RPCS3 can extract it (rpcs3 --installfw).`;
    } else if (files.length) {
      status = 'invalid';
      note = 'The PUP file in this folder is not a valid PS3 firmware update. Download PS3UPDAT.PUP from Sony\'s official PlayStation website.';
    } else {
      status = 'missing';
      note = 'Commercial games need the official PS3 firmware. Download PS3UPDAT.PUP from Sony\'s PlayStation website, place it in this folder, then run "Install firmware". OmniPC never downloads firmware.';
    }
    return [{
      systemId: 'ps3', systemName: 'PlayStation 3', label: 'PS3 system firmware', required: true, requirementKind: 'firmware', emulatorId: 'rpcs3',
      expectedLocation: this.paths().bios, status, files, note,
    }];
  }

  /**
   * Installs the user's PS3UPDAT.PUP with `rpcs3 --installfw <pup>` (rpcs3.cpp). RPCS3
   * opens its main window, asks the user to confirm ("Install firmware: ...?"), installs
   * into dev_flash and stays open; the call resolves once the user closes RPCS3.
   */
  async installFirmware(executable: string): Promise<FirmwareInstallResult> {
    const files = await this.firmwareFiles();
    const pup = files.find((f) => f.valid)?.path ?? null;
    if (!pup) {
      return { ok: false, pup: null, installedVersion: await this.installedFirmwareVersion(), notes: [files.length ? 'The PUP file in the BIOS folder is not a valid PS3 firmware file.' : `Place PS3UPDAT.PUP in ${this.paths().bios} first.`] };
    }
    if (!existsSync(executable)) return { ok: false, pup, installedVersion: null, notes: [`${executable} does not exist.`] };
    if (!isWindows) return { ok: false, pup, installedVersion: await this.installedFirmwareVersion(), notes: ['Firmware installation runs RPCS3 and is only possible on Windows.'] };
    await this.ensureDirs();
    await this.patchGui([]); // no welcome dialog / update prompt in front of the installer
    const before = await this.installedFirmwareVersion();
    const r = await runProcess(executable, ['--installfw', pup], { timeoutMs: 30 * 60 * 1000, cwd: this.paths().app, env: { ...process.env, ...this.launchEnv() } });
    const after = await this.installedFirmwareVersion();
    const notes: string[] = [];
    if (r.error) notes.push(`RPCS3 could not be started: ${r.error.message}`);
    else if (r.timedOut) notes.push('RPCS3 was closed after 30 minutes.');
    if (after && after !== before) notes.push(`Firmware ${after} installed.`);
    else if (after) notes.push(`Firmware ${after} is installed (unchanged).`);
    else notes.push('No firmware was installed (the installation may have been cancelled in RPCS3).');
    return { ok: !!after, pup, installedVersion: after, notes };
  }

  logFile(): string | null {
    // fs::get_log_dir() on Windows = <config dir>/log/ (Utilities/File.cpp); rpcs3.cpp names it RPCS3.log.
    return join(this.paths().data, 'log', 'RPCS3.log');
  }

  cacheDirs(): { label: string; path: string }[] {
    // rpcs3::utils::get_cache_dir() = fs::get_cache_dir() + "cache/" = <config dir>/cache/ on Windows (not configurable).
    return [{ label: 'PPU/SPU/shader caches', path: join(this.paths().data, 'cache') }];
  }

  async recoverSession(): Promise<string[]> {
    // Per-game overrides are separate --config files (omnideck-gamecfg/) rebuilt before every
    // launch; config.yml itself is never modified for a session, so there is nothing to restore.
    return [];
  }

  async detectExistingSetups(): Promise<SetupImportCandidate[]> {
    const out: SetupImportCandidate[] = [];
    const home = homedir();
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    const dirs = [
      process.env[RPCS3_CONFIG_ENV] ?? '',
      'C:\\RPCS3', 'D:\\RPCS3', 'C:\\Emulators\\RPCS3', 'D:\\Emulators\\RPCS3',
      join(home, 'RPCS3'), join(home, 'Desktop', 'RPCS3'), join(home, 'Documents', 'RPCS3'), join(home, 'Downloads', 'RPCS3'),
      join(appData, 'emudeck', 'Emulators', 'RPCS3'),
      'C:\\Program Files\\RPCS3',
    ].filter(Boolean);
    const seen = new Set<string>();
    for (const dir of dirs) {
      const key = dir.toLowerCase().replace(/[\\/]+$/, '');
      if (seen.has(key) || !existsSync(dir)) continue;
      seen.add(key);
      const exe = await this.findExecutable(dir);
      const cfgDir = existsSync(join(dir, 'portable')) ? join(dir, 'portable') : dir;
      const configYml = [join(cfgDir, 'config', 'config.yml'), join(cfgDir, 'config.yml')].find((f) => existsSync(f)) ?? null;
      if (!exe && !configYml) continue;
      let hdd0 = join(cfgDir, 'dev_hdd0');
      let flash = join(cfgDir, 'dev_flash');
      const vfsPath = [join(cfgDir, 'config', 'vfs.yml'), join(cfgDir, 'vfs.yml')].find((f) => existsSync(f));
      if (vfsPath) {
        const vfs = YamlDocument.parse(await readFile(vfsPath, 'utf8').catch(() => ''));
        const emu = vfs.get(['$(EmulatorDir)']) || rpcs3Dir(cfgDir);
        const resolve = (v: string | undefined, def: string) => (v ? v.replace('$(EmulatorDir)', rpcs3Dir(emu)) : def);
        hdd0 = resolve(vfs.get(['/dev_hdd0/']), hdd0);
        flash = resolve(vfs.get(['/dev_flash/']), flash);
      }
      const saves = join(hdd0, 'home', '00000001', 'savedata');
      const fw = existsSync(join(flash, 'vsh', 'etc', 'version.txt'));
      out.push({
        id: `rpcs3:${key}`, source: 'rpcs3', label: `RPCS3 (${dir})`, path: dir,
        details: [exe ? `Executable: ${exe}` : 'No rpcs3.exe in this folder', configYml ? `Settings: ${configYml}` : 'No config.yml', `PS3 HDD: ${hdd0}`, fw ? 'Firmware installed' : 'No firmware installed'],
        importable: { settings: !!configYml, saves: existsSync(saves), bios: false, romPaths: false, useInstallation: !!exe },
        romPaths: [],
        saveCopies: [{ from: saves, to: join(this.devHdd0Dir(), 'home', '00000001', 'savedata'), label: 'RPCS3 save data' }],
      });
    }
    return out;
  }

  /**
   * The release archive ships config/input_configs/gamecontrollerdb.txt next to the
   * exe; with RPCS3_CONFIG_DIR the SDL handler reads it from the data folder
   * (Input/sdl_pad_handler.cpp), so copy the bundled copy there.
   */
  async prepareInstall(appDir: string): Promise<string[]> {
    const notes: string[] = [];
    const db = join(appDir, 'config', 'input_configs', 'gamecontrollerdb.txt');
    if (existsSync(db)) {
      const dest = join(this.configDir(), 'input_configs', 'gamecontrollerdb.txt');
      await mkdir(join(dest, '..'), { recursive: true });
      await copyFile(db, dest);
      notes.push('Copied the SDL controller database into the RPCS3 data folder.');
    }
    await mkdir(this.paths().data, { recursive: true });
    await writeFile(join(this.paths().data, 'README-OmniPC.txt'), 'This folder is RPCS3\'s configuration directory (RPCS3_CONFIG_DIR) managed by OmniPC. Settings: config\\config.yml. PS3 HDD (saves) lives in the OmniPC Saves folder via config\\vfs.yml.\r\n');
    return notes;
  }

  /**
   * Data RPCS3 writes next to rpcs3.exe when started without OmniPC's
   * RPCS3_CONFIG_DIR (e.g. double-clicked): kept across updates, never deleted.
   */
  persistentAppPaths(): string[] {
    return ['portable', 'dev_hdd0', 'dev_hdd1', 'dev_flash', 'dev_flash2', 'dev_flash3', 'dev_usb000', 'savestates', join('config', 'custom_configs'), join('config', 'config.yml'), join('config', 'vfs.yml')];
  }
}

/** Extracts "0.0.43-20262-8f2fe1a9" from `--version` output ("RPCS3 0.0.43-...") or the log banner ("RPCS3 v0.0.43-... Alpha"). */
export function parseRpcs3Version(text: string): string | null {
  const m = /RPCS3 v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+)*)/.exec(text);
  return m ? m[1] : null;
}

async function readHead(path: string, bytes: number, encoding: BufferEncoding = 'utf8'): Promise<string> {
  const fh = await open(path, 'r').catch(() => null);
  if (!fh) return '';
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString(encoding);
  } finally {
    await fh.close();
  }
}
