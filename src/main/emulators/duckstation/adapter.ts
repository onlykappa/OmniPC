// DuckStation adapter (PlayStation).
// DuckStation has no -datapath option: its data root is the executable folder
// when portable.txt (or settings.ini) sits next to it, otherwise
// Documents\DuckStation / %LOCALAPPDATA%\DuckStation (src/core/core.cpp SetDataRoot).
// OmniPC therefore runs it in portable mode and redirects every folder key to
// OmniPC-managed locations, so only a handful of files stay in the app dir.
// Layout:
//   Emulators/duckstation/app       program files + portable.txt + settings.ini (carried across updates)
//   Emulators/duckstation/data      gamesettings, inputprofiles, cheats, patches, covers, textures, shaders, ...
//   Saves/duckstation/{memcards,savestates,screenshots,videos}
//   BIOS/ps1                        [BIOS] SearchDirectory
//   Cache/duckstation               [Folders] Cache (+ gameicons)

import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import type { BiosStatus, EmulatorManifest, EmulatorSettings, Finding, GameProfile, HardwareProfile, PerformancePreset, RendererOption, SetupImportCandidate, UniversalButton } from '@shared/models';
import manifestJson from '../manifests/duckstation.json';
import type { AdapterCapabilities, AdapterPaths, ConfigInput, ConfigInspection, ConfigWriteResult, EmulatorAdapter, LaunchCommand, LaunchTarget, SmokeTestResult } from '../adapter';
import type { AppPaths } from '../../core/paths';
import type { BackupTarget } from '../../config/backups';
import { loadIni, saveIni } from '../../config/iniFile';
import { checkIni } from '../../config/formats';
import { hotkeyChords, physicalFor } from '../../controllers/translate';
import { findExeIn, preferredRenderer, resolutionScaleFor } from '../common';
import { runProcess } from '../../platform/exec';
import { fileVersion, isWindows } from '../../platform/powershell';
import { splitArgs } from '../pcsx2/adapter';

export const DUCKSTATION_MANIFEST = manifestJson as unknown as EmulatorManifest;

/** [GPU] Renderer names (src/core/settings.cpp s_gpu_renderer_names, Windows build). */
export const DUCKSTATION_RENDERERS: Record<string, string> = {
  auto: 'Automatic', d3d11: 'D3D11', d3d12: 'D3D12', vulkan: 'Vulkan', opengl: 'OpenGL', software: 'Software',
};

/** [Display] AspectRatio values (Settings::ParseDisplayAspectRatio). */
const ASPECTS: Record<string, string> = { auto: 'Auto (Game Native)', '4:3': '4:3', '16:9': '16:9', stretch: 'Stretch To Fill' };

/** BIOS image sizes DuckStation accepts (src/core/bios.h BIOS_SIZE, BIOS_SIZE_PS2, BIOS_SIZE_PS3). */
export const PS1_BIOS_SIZES: Record<number, string> = {
  0x80000: 'PlayStation BIOS image (512 KB)',
  0x400000: 'PlayStation 2 BIOS image (4 MB, DuckStation can boot PS1 games with it)',
  0x3e66f0: 'PlayStation 3 BIOS image (DuckStation can boot PS1 games with it)',
};

/** SDL gamepad tokens (src/util/sdl_input_source.cpp s_button_info / s_axis_info). */
const SDL_TOKENS: Record<UniversalButton, string> = {
  A: 'A', B: 'B', X: 'X', Y: 'Y',
  LB: 'LeftShoulder', RB: 'RightShoulder', LT: '+LeftTrigger', RT: '+RightTrigger',
  L3: 'LeftStick', R3: 'RightStick', Start: 'Start', Select: 'Back', Guide: 'Guide',
  DPadUp: 'DPadUp', DPadDown: 'DPadDown', DPadLeft: 'DPadLeft', DPadRight: 'DPadRight',
  LeftStickUp: '-LeftY', LeftStickDown: '+LeftY', LeftStickLeft: '-LeftX', LeftStickRight: '+LeftX',
  RightStickUp: '-RightY', RightStickDown: '+RightY', RightStickLeft: '-RightX', RightStickRight: '+RightX',
};

/** AnalogController binding name -> logical universal button (src/core/analog_controller.cpp s_binding_info). */
const PS1_PAD: [string, UniversalButton][] = [
  ['Cross', 'A'], ['Circle', 'B'], ['Square', 'X'], ['Triangle', 'Y'],
  ['L1', 'LB'], ['R1', 'RB'], ['L2', 'LT'], ['R2', 'RT'], ['L3', 'L3'], ['R3', 'R3'],
  ['Select', 'Select'], ['Start', 'Start'],
  ['Up', 'DPadUp'], ['Down', 'DPadDown'], ['Left', 'DPadLeft'], ['Right', 'DPadRight'],
  ['LUp', 'LeftStickUp'], ['LDown', 'LeftStickDown'], ['LLeft', 'LeftStickLeft'], ['LRight', 'LeftStickRight'],
  ['RUp', 'RightStickUp'], ['RDown', 'RightStickDown'], ['RLeft', 'RightStickLeft'], ['RRight', 'RightStickRight'],
];

/** [Hotkeys] names (src/core/hotkeys.cpp). */
const HOTKEY_NAMES = {
  exit: 'PowerOff',
  saveState: 'SaveSelectedSaveState',
  loadState: 'LoadSelectedSaveState',
  volumeUp: 'AudioVolumeUp',
  volumeDown: 'AudioVolumeDown',
  menu: 'OpenPauseMenu',
  fastForward: 'ToggleFastForward',
  screenshot: 'Screenshot',
  fullscreen: 'ToggleFullscreen',
} as const;

/** Command-line options DuckStation understands; anything else pops a modal "Unknown parameter" box. */
const KNOWN_FLAGS = new Set(['-batch', '-nogui', '-bios', '-fastboot', '-resume', '-fullscreen', '-nofullscreen', '-bigpicture', '-earlyconsole']);
const KNOWN_PARAM_FLAGS = new Set(['-state', '-statefile', '-exe']);

/** Files DuckStation writes directly into its data root (= app dir in portable mode). */
const PORTABLE_FILES = ['settings.ini', 'playtime.dat', 'custom_properties.ini', 'gamecontrollerdb.txt'];
/** Default sub-folders of the data root, in case the user resets a folder to its default inside DuckStation. */
const PORTABLE_DEFAULT_DIRS = ['memcards', 'savestates', 'screenshots', 'videos', 'gamesettings', 'inputprofiles', 'cheats', 'patches', 'covers', 'textures', 'shaders', 'subchannels', 'bios'];

export class DuckStationAdapter implements EmulatorAdapter {
  readonly manifest = DUCKSTATION_MANIFEST;
  readonly capabilities: AdapterCapabilities = {
    perGameProfiles: 'session',
    frameLimit: true,
    vsync: true,
    aspectRatios: [
      { id: 'auto', label: 'Auto (game native)' },
      { id: '4:3', label: '4:3' },
      { id: '16:9', label: '16:9' },
      { id: 'stretch', label: 'Stretch to fill' },
    ],
    hotkeys: ['exit', 'saveState', 'loadState', 'volumeUp', 'volumeDown', 'menu', 'fastForward', 'screenshot', 'fullscreen'],
    smokeTest: true,
    maxResolutionScale: 16,
  };

  constructor(private readonly app: AppPaths) {}

  paths(): AdapterPaths {
    return {
      app: this.app.emulatorAppDir('duckstation'),
      data: this.app.emulatorDataDir('duckstation'),
      saves: this.app.emulatorSaveDir('duckstation'),
      bios: this.app.systemBiosDir('ps1'),
      cache: this.app.emulatorCacheDir('duckstation'),
    };
  }

  /** DuckStation's DataRoot in portable mode. */
  dataRoot(): string {
    return this.paths().app;
  }

  iniPath(): string {
    return join(this.dataRoot(), 'settings.ini');
  }

  async findExecutable(appDir: string): Promise<string | null> {
    return findExeIn(appDir, [/^duckstation-qt-x64-ReleaseLTCG\.exe$/i, /^duckstation-qt-x64-ReleaseLTCG-SSE2\.exe$/i, /^duckstation-qt.*\.exe$/i, /^duckstation-qt$/]);
  }

  async detectVersion(executable: string): Promise<string | null> {
    // The version resource holds e.g. "0.1.12074" (scmversion/update_rc_version.bat).
    const v = await fileVersion(executable);
    return v ? v.replace(/^v/, '') : null;
  }

  renderers(hw: HardwareProfile | null): RendererOption[] {
    const vk = hw?.graphicsApis.vulkan;
    const dx12 = hw?.graphicsApis.directx12;
    return [
      { id: 'auto', label: 'Automatic (DuckStation decides)', available: true },
      { id: 'd3d11', label: 'Direct3D 11', available: hw ? hw.isWindows : true },
      { id: 'd3d12', label: 'Direct3D 12', available: dx12 !== false, note: dx12 === false ? 'd3d12.dll not found' : undefined },
      { id: 'vulkan', label: 'Vulkan', available: vk !== false, note: vk === false ? 'No Vulkan driver detected' : undefined },
      { id: 'opengl', label: 'OpenGL', available: true },
      { id: 'software', label: 'Software (native resolution, most accurate)', available: true },
    ];
  }

  defaultSettings(hw: HardwareProfile | null, preset: PerformancePreset): EmulatorSettings {
    // resolutionScaleFor assumes ~480p consoles; most PS1 games render at ~240p,
    // so the same output size needs twice the multiplier.
    const scale = Math.min(this.capabilities.maxResolutionScale, resolutionScaleFor(hw, preset, this.capabilities.maxResolutionScale) * 2);
    return {
      preset,
      resolutionScale: scale,
      renderer: preferredRenderer(hw, { d3d12: 'd3d12', d3d11: 'd3d11', vulkan: 'vulkan', opengl: 'opengl' }),
      aspectRatio: 'auto',
      fullscreen: true,
      frameLimit: true,
      vsync: preset !== 'performance',
      advanced: {},
    };
  }

  configTargets(): BackupTarget[] {
    return [{ root: this.paths().app, path: this.iniPath() }];
  }

  private dataSub(name: string): string {
    return join(this.paths().data, name);
  }

  private async ensureDirs(): Promise<void> {
    const p = this.paths();
    const dirs = [p.app, p.data, p.bios, p.cache, ...this.managedPathValues().map(([, , v]) => v)];
    for (const d of dirs) await mkdir(d, { recursive: true });
  }

  /** Folder keys OmniPC manages (EmuFolders::LoadConfig). Everything else is left as the user set it. */
  managedPathValues(): [string, string, string][] {
    const p = this.paths();
    return [
      ['BIOS', 'SearchDirectory', p.bios],
      ['MemoryCards', 'Directory', join(p.saves, 'memcards')],
      ['Folders', 'SaveStates', join(p.saves, 'savestates')],
      ['Folders', 'Screenshots', join(p.saves, 'screenshots')],
      ['Folders', 'Videos', join(p.saves, 'videos')],
      ['Folders', 'Cache', p.cache],
      ['Folders', 'GameIcons', join(p.cache, 'gameicons')],
      ['Folders', 'GameSettings', this.dataSub('gamesettings')],
      ['Folders', 'InputProfiles', this.dataSub('inputprofiles')],
      ['Folders', 'Cheats', this.dataSub('cheats')],
      ['Folders', 'Patches', this.dataSub('patches')],
      ['Folders', 'Covers', this.dataSub('covers')],
      ['Folders', 'Textures', this.dataSub('textures')],
      ['Folders', 'Shaders', this.dataSub('shaders')],
      ['Folders', 'Subchannels', this.dataSub('subchannels')],
      ['Folders', 'UserResources', this.dataSub('resources')],
    ];
  }

  graphicsValues(s: EmulatorSettings): [string, string, string | number | boolean][] {
    const scale = Math.max(1, Math.min(this.capabilities.maxResolutionScale, Math.round(s.resolutionScale)));
    return [
      ['GPU', 'Renderer', DUCKSTATION_RENDERERS[s.renderer] ?? DUCKSTATION_RENDERERS.auto],
      ['GPU', 'ResolutionScale', scale],
      ['Display', 'AspectRatio', ASPECTS[s.aspectRatio] ?? ASPECTS.auto],
      ['Display', 'VSync', s.vsync],
      ['Main', 'EmulationSpeed', s.frameLimit ? 1 : 0],
      ['Main', 'StartFullscreen', s.fullscreen],
    ];
  }

  async applyConfig(input: ConfigInput, scope: 'all' | 'controller' | 'graphics' | 'paths'): Promise<ConfigWriteResult> {
    await this.ensureDirs();
    const notes: string[] = [];
    const ini = this.iniPath();
    const doc = await loadIni(ini);
    const changed: string[] = [];
    const set = (s: string, k: string, v: string | number | boolean) => {
      if (doc.set(s, k, v)) changed.push(`${s}.${k} = ${v}`);
    };
    if (scope === 'all' || scope === 'paths') {
      for (const [s, k, v] of this.managedPathValues()) set(s, k, v);
      // Startup prompts that would block a controller-only/batch launch:
      // setup wizard (qthost.cpp InitializeFoldersAndConfig runs it even with -nogui),
      // update check (mainwindow.cpp startupUpdateCheck), confirm close (requestShutdown).
      set('Main', 'SetupWizardIncomplete', false);
      set('Main', 'ConfirmPowerOff', false);
      set('AutoUpdater', 'CheckAtStartup', false);
      set('Logging', 'LogToFile', true);
      set('BIOS', 'PatchFastBoot', true);
    }
    if (scope === 'all' || scope === 'graphics') {
      for (const [s, k, v] of this.graphicsValues(input.settings)) set(s, k, v);
      for (const [key, value] of Object.entries(input.settings.advanced)) {
        const [section, name] = key.split('|');
        if (section && name) set(section, name, value);
      }
    }
    if (scope === 'all' || scope === 'controller') {
      const c = input.controller;
      const dev = `SDL-${c.deviceIndex}`;
      const tok = (b: UniversalButton) => `${dev}/${SDL_TOKENS[b]}`;
      set('InputSources', 'SDL', true);
      set('InputSources', 'XInput', false);
      set('Pad1', 'Type', 'AnalogController');
      for (const [ps1, logical] of PS1_PAD) set('Pad1', ps1, tok(physicalFor(c, 'ps1', logical)));
      // Analog-mode toggle on the Guide button (DuckStation's own automapper does
      // the same), unless that button is part of a hotkey chord.
      const chords = hotkeyChords(input.hotkeys, this.capabilities.hotkeys);
      const analogBtn = physicalFor(c, 'ps1', 'Guide');
      if (!chords.some((h) => h.buttons.includes(analogBtn))) set('Pad1', 'Analog', tok(analogBtn));
      else if (new RegExp(`^SDL-\\d+/${SDL_TOKENS[analogBtn].replace(/[+]/g, '\\+')}$`).test(doc.get('Pad1', 'Analog') ?? '')) {
        doc.delete('Pad1', 'Analog');
        changed.push(`Pad1.Analog removed (${analogBtn} is used by a hotkey)`);
      }
      if (c.rumble) {
        set('Pad1', 'LargeMotor', `${dev}/LargeMotor`);
        set('Pad1', 'SmallMotor', `${dev}/SmallMotor`);
      } else {
        if (doc.delete('Pad1', 'LargeMotor')) changed.push('Pad1.LargeMotor removed');
        if (doc.delete('Pad1', 'SmallMotor')) changed.push('Pad1.SmallMotor removed');
      }
      set('Pad1', 'AnalogDeadzone', c.deadzone.toFixed(2));
      for (const h of chords) {
        const name = HOTKEY_NAMES[h.action as keyof typeof HOTKEY_NAMES];
        if (name) set('Hotkeys', name, h.buttons.map(tok).join(' & '));
      }
    }
    if (changed.length || !existsSync(ini)) await saveIni(ini, doc);
    // Without this marker DuckStation would silently use %LOCALAPPDATA%\DuckStation
    // if settings.ini ever went missing.
    if (!existsSync(join(this.paths().app, 'portable.txt'))) {
      await this.writePortableMarker(this.paths().app);
      notes.push('Enabled DuckStation portable mode (portable.txt).');
    }
    return { changed, notes };
  }

  /** Resolves a folder value the way EmuFolders::LoadPathFromSettings does (relative to DataRoot). */
  resolveFolder(value: string): string {
    const v = value.trim();
    if (!v) return v;
    if (isAbsolute(v) || /^[a-zA-Z]:[\\/]/.test(v) || v.startsWith('\\\\')) return v;
    return resolve(this.dataRoot(), v);
  }

  private samePath(a: string, b: string): boolean {
    const n = (s: string) => normalize(s).replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
    return n(a) === n(b);
  }

  async inspectConfig(): Promise<ConfigInspection> {
    const ini = this.iniPath();
    const exists = existsSync(ini);
    const text = exists ? await readFile(ini, 'utf8').catch(() => '') : '';
    const fmt = exists ? checkIni(text) : { ok: false, issues: ['File does not exist'] };
    const drift: ConfigInspection['drift'] = [];
    if (exists && fmt.ok) {
      const doc = await loadIni(ini);
      for (const [s, k, v] of this.managedPathValues()) {
        const actual = doc.get(s, k) ?? null;
        if (!actual || !this.samePath(this.resolveFolder(actual), v)) {
          drift.push({ file: ini, key: `${s}.${k}`, expected: v, actual, critical: k === 'SearchDirectory' || (s === 'MemoryCards' && k === 'Directory') || k === 'SaveStates' });
        }
      }
      if (doc.get('Main', 'SetupWizardIncomplete') !== 'false') {
        drift.push({ file: ini, key: 'Main.SetupWizardIncomplete', expected: 'false', actual: doc.get('Main', 'SetupWizardIncomplete') ?? null, critical: true });
      }
      if (doc.get('AutoUpdater', 'CheckAtStartup') === 'true') {
        drift.push({ file: ini, key: 'AutoUpdater.CheckAtStartup', expected: 'false', actual: 'true', critical: false });
      }
    }
    const portable = join(this.paths().app, 'portable.txt');
    const files: ConfigInspection['files'] = [{ label: 'settings.ini', path: ini, exists, parseOk: exists && fmt.ok, issues: fmt.issues }];
    if (existsSync(this.paths().app) && !existsSync(portable)) {
      drift.push({ file: portable, key: 'portable.txt', expected: 'present', actual: null, critical: !exists });
    }
    return { files, drift };
  }

  /** Filters custom args so an unknown option can never trigger DuckStation's modal error box. */
  sanitizeCustomArgs(raw: string): { args: string[]; dropped: string[] } {
    const args: string[] = [];
    const dropped: string[] = [];
    const parts = splitArgs(raw);
    for (let i = 0; i < parts.length; i++) {
      const a = parts[i];
      if (KNOWN_FLAGS.has(a)) args.push(a);
      else if (KNOWN_PARAM_FLAGS.has(a) && i + 1 < parts.length) args.push(a, parts[++i]);
      else dropped.push(a);
    }
    return { args, dropped };
  }

  async buildLaunch(target: LaunchTarget, executable: string, settings: EmulatorSettings, profile: GameProfile | null, _version: string | null): Promise<LaunchCommand> {
    const p = this.paths();
    // -nogui: no main window and implied batch mode, so powering off exits (qthost.cpp).
    const args = ['-nogui'];
    if (settings.fullscreen) args.push('-fullscreen');
    const notes: string[] = [];
    let prepare: LaunchCommand['prepare'];
    let cleanup: LaunchCommand['cleanup'];
    const overrides = profile ? this.profileOverrides(settings, profile) : [];
    if (overrides.length) {
      const ini = this.iniPath();
      const journal = this.journalPath();
      prepare = async () => {
        if (existsSync(ini)) await copyFile(ini, journal);
        const doc = await loadIni(ini);
        for (const [s, k, v] of overrides) doc.set(s, k, v);
        await saveIni(ini, doc);
      };
      cleanup = async () => {
        if (existsSync(journal)) {
          await copyFile(journal, ini);
          await rm(journal, { force: true });
        }
      };
      notes.push(`Per-game profile applied for this session only (${overrides.length} overrides); global settings are restored when the game exits.`);
    }
    if (profile?.customArgs) {
      const { args: extra, dropped } = this.sanitizeCustomArgs(profile.customArgs);
      args.push(...extra);
      if (dropped.length) notes.push(`Ignored custom arguments DuckStation does not support (they would open an error dialog): ${dropped.join(' ')}`);
    }
    args.push('--', target.path);
    return { command: executable, args, cwd: p.app, logFile: this.logFile(), prepare, cleanup, notes };
  }

  private journalPath(): string {
    // Kept outside the app dir so an update during a crashed session cannot lose it.
    return join(this.paths().data, 'settings.ini.omnideck-session');
  }

  profileOverrides(base: EmulatorSettings, profile: GameProfile): [string, string, string | number | boolean][] {
    const merged: EmulatorSettings = { ...base, ...(profile.overrides as Partial<EmulatorSettings>), advanced: { ...(profile.overrides.advanced ?? {}) } };
    const out: [string, string, string | number | boolean][] = [];
    const o = profile.overrides;
    const g = this.graphicsValues(merged);
    if (o.renderer !== undefined) out.push(g[0]);
    if (o.resolutionScale !== undefined) out.push(g[1]);
    if (o.aspectRatio !== undefined) out.push(g[2]);
    if (o.vsync !== undefined) out.push(g[3]);
    if (o.frameLimit !== undefined) out.push(g[4]);
    for (const [key, value] of Object.entries(o.advanced ?? {})) {
      const [section, name] = key.split('|');
      if (section && name) out.push([section, name, value]);
    }
    return out;
  }

  buildUiLaunch(executable: string): LaunchCommand {
    return { command: executable, args: [], cwd: this.paths().app, logFile: this.logFile(), notes: [] };
  }

  async smokeTest(executable: string): Promise<SmokeTestResult> {
    const checks: SmokeTestResult['checks'] = [];
    const appDir = this.paths().app;
    checks.push({ label: 'Executable present', ok: existsSync(executable), detail: executable });
    if (!existsSync(executable)) return { ran: true, ok: false, checks };
    // Core::SetAppRootAndResources / QtHost::LoadResources refuse to start without these.
    const rcc = join(appDir, 'resources', 'duckstation-qt.rcc');
    checks.push({ label: 'Resources present', ok: existsSync(rcc), detail: existsSync(rcc) ? rcc : `${rcc} is missing; DuckStation refuses to start` });
    const qwindows = join(appDir, 'QtPlugins', 'platforms', 'qwindows.dll');
    if (isWindows) checks.push({ label: 'Qt platform plugin present', ok: existsSync(qwindows), detail: existsSync(qwindows) ? qwindows : `${qwindows} is missing` });
    const portable = existsSync(join(appDir, 'portable.txt')) || existsSync(this.iniPath());
    checks.push({ label: 'Portable mode active', ok: portable, detail: portable ? 'portable.txt / settings.ini next to the executable' : 'portable.txt missing: DuckStation would use %LOCALAPPDATA%\\DuckStation' });
    const insp = await this.inspectConfig();
    const cfg = insp.files[0];
    checks.push({ label: 'Configuration parses', ok: cfg.parseOk, detail: cfg.issues.join('; ') || 'settings.ini OK' });
    const wizard = insp.drift.find((d) => d.key === 'Main.SetupWizardIncomplete');
    checks.push({ label: 'First-run wizard suppressed', ok: !wizard, detail: wizard ? 'SetupWizardIncomplete is not false: the setup wizard would block launches' : 'SetupWizardIncomplete = false' });
    if (!isWindows) {
      checks.push({ label: 'Executable starts (-version)', ok: true, detail: 'Skipped: only possible on Windows' });
      return { ran: false, ok: checks.every((c) => c.ok), checks };
    }
    // -version prints to stderr and exits (code 1) before any settings are loaded;
    // it proves the exe and its DLLs/CRT load and the CPU passes the SSE4.1 check.
    const r = await runProcess(executable, ['-version'], { timeoutMs: 20000, cwd: appDir });
    const out = `${r.stderr}${r.stdout}`;
    const ok = !r.error && !r.timedOut && /DuckStation Version/i.test(out);
    checks.push({
      label: 'Executable starts (-version)',
      ok,
      detail: r.error ? r.error.message : r.timedOut ? 'Timed out after 20s (a hardware-check dialog may be open)' : ok ? out.trim().split(/\r?\n/)[0] : `Exit code ${r.code}, no version output${out ? `: ${out.trim().slice(-300)}` : ''}`,
    });
    return { ran: true, ok: checks.every((c) => c.ok), checks };
  }

  async validateEnvironment(hw: HardwareProfile | null, executable: string | null): Promise<Finding[]> {
    const out: Finding[] = [];
    const features = hw?.cpu.features ?? [];
    const sse2Build = !!executable && /sse2/i.test(executable);
    if (hw && executable && !sse2Build && features.length > 0 && !features.includes('sse41')) {
      out.push({
        id: 'duckstation.sse41', checkId: 'duckstation.cpu', category: 'emulators', severity: 'problem', title: 'DuckStation needs SSE4.1',
        detail: 'The standard DuckStation x64 build requires a CPU with SSE4.1 and refuses to start without it. Only the legacy SSE2 build works on this CPU, which OmniPC cannot install automatically yet.',
        subject: { kind: 'emulator', id: 'duckstation', label: 'DuckStation' },
        evidence: [`CPU features: ${features.join(', ')}`], confidence: 'high', repair: null,
        manualSteps: ['Download duckstation-windows-x64-sse2-release.zip from github.com/stenzek/duckstation/releases and use "Use existing installation" in OmniPC.'],
      });
    }
    if (hw && hw.isWindows === false) {
      out.push({
        id: 'duckstation.platform', checkId: 'duckstation.platform', category: 'emulators', severity: 'warning', title: 'DuckStation Windows build on a non-Windows system',
        detail: 'OmniPC installs the Windows build of DuckStation.', subject: { kind: 'emulator', id: 'duckstation', label: 'DuckStation' },
        evidence: [], confidence: 'high', repair: null, manualSteps: [],
      });
    }
    return out;
  }

  saveLocations(): { label: string; path: string }[] {
    const p = this.paths();
    return [
      { label: 'Memory cards', path: join(p.saves, 'memcards') },
      { label: 'Save states', path: join(p.saves, 'savestates') },
    ];
  }

  async biosStatus(): Promise<BiosStatus[]> {
    const dir = this.paths().bios;
    const files: BiosStatus['files'] = [];
    if (existsSync(dir)) {
      for (const f of await readdir(dir)) {
        const full = join(dir, f);
        const st = await stat(full).catch(() => null);
        if (!st?.isFile()) continue;
        const known = PS1_BIOS_SIZES[st.size];
        // Ignore small companion files (readme, checksums); report odd-sized images as invalid.
        if (!known && st.size < 256 * 1024) continue;
        files.push({ path: full, sizeBytes: st.size, valid: !!known, description: known ?? `Unexpected size ${st.size} bytes; DuckStation only accepts 512 KB, 4 MB (PS2) or PS3 BIOS images` });
      }
    }
    const anyValid = files.some((f) => f.valid);
    return [{
      systemId: 'ps1', systemName: 'PlayStation', label: 'PlayStation BIOS', required: true, requirementKind: 'bios', emulatorId: 'duckstation', expectedLocation: dir,
      status: anyValid ? 'found' : files.length ? 'invalid' : 'missing', files,
      note: anyValid
        ? 'DuckStation picks the BIOS matching each game\'s region from this folder (identified by hash). Keep a BIOS for every region you play.'
        : 'Place a BIOS dumped from your own PlayStation (e.g. SCPH-1001.bin, 512 KB) in this folder. OmniPC never downloads BIOS files.',
    }];
  }

  logFile(): string | null {
    return join(this.dataRoot(), 'duckstation.log');
  }

  cacheDirs(): { label: string; path: string }[] {
    return [{ label: 'Shader and game list cache', path: this.paths().cache }];
  }

  async recoverSession(): Promise<string[]> {
    const journal = this.journalPath();
    if (!existsSync(journal)) return [];
    await mkdir(this.paths().app, { recursive: true });
    await copyFile(journal, this.iniPath());
    await rm(journal, { force: true });
    return ['Restored DuckStation settings.ini after a per-game session override was interrupted.'];
  }

  async detectExistingSetups(): Promise<SetupImportCandidate[]> {
    const out: SetupImportCandidate[] = [];
    const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    const dataRoots = [
      { id: 'documents', label: 'DuckStation (Documents\\DuckStation)', dir: join(homedir(), 'Documents', 'DuckStation') },
      { id: 'localappdata', label: 'DuckStation (%LOCALAPPDATA%\\DuckStation)', dir: join(local, 'DuckStation') },
    ];
    for (const r of dataRoots) {
      const ini = join(r.dir, 'settings.ini');
      if (!existsSync(ini)) continue;
      out.push(await this.candidateFromDataRoot(`duckstation:${r.id}`, r.label, r.dir));
    }
    // Installer default (src/installer/installer_ui.cpp) and a manual Program Files copy.
    for (const dir of [join(local, 'Programs', 'DuckStation'), 'C:\\Program Files\\DuckStation']) {
      const exe = await this.findExecutable(dir);
      if (!exe) continue;
      if (existsSync(join(dir, 'portable.txt')) || existsSync(join(dir, 'settings.ini'))) {
        const c = await this.candidateFromDataRoot(`duckstation:portable:${dir}`, `DuckStation portable installation (${dir})`, dir);
        c.details.unshift(`Executable: ${exe}`);
        c.importable.useInstallation = true;
        out.push(c);
      } else {
        out.push({ id: `duckstation:install:${dir}`, source: 'duckstation', label: `DuckStation installation (${dir})`, path: dir, details: [`Executable: ${exe}`], importable: { settings: false, saves: false, bios: false, romPaths: false, useInstallation: true }, romPaths: [] });
      }
    }
    return out;
  }

  private async candidateFromDataRoot(id: string, label: string, root: string): Promise<SetupImportCandidate> {
    const ini = join(root, 'settings.ini');
    const text = existsSync(ini) ? await readFile(ini, 'utf8').catch(() => '') : '';
    const doc = await loadIni(ini);
    const res = (v: string | undefined, def: string) => (v ? (/^[a-zA-Z]:|^[\\/]/.test(v) ? v : join(root, v)) : join(root, def));
    const bios = res(doc.get('BIOS', 'SearchDirectory'), 'bios');
    const mem = res(doc.get('MemoryCards', 'Directory'), 'memcards');
    const states = res(doc.get('Folders', 'SaveStates'), 'savestates');
    const romPaths = gameListPaths(text).map((v) => res(v, v)).filter((v) => existsSync(v));
    return {
      id, source: 'duckstation', label, path: root,
      details: [`Settings: ${ini}`, `BIOS folder: ${bios}`, `Memory cards: ${mem}`, `Save states: ${states}`],
      importable: { settings: true, saves: existsSync(mem) || existsSync(states), bios: existsSync(bios), romPaths: romPaths.length > 0, useInstallation: false },
      romPaths,
      saveCopies: [
        { from: mem, to: join(this.paths().saves, 'memcards'), label: 'DuckStation memory cards' },
        { from: states, to: join(this.paths().saves, 'savestates'), label: 'DuckStation save states' },
      ],
      biosDirs: [{ dir: bios, systemId: 'ps1' }],
    };
  }

  /** Portable marker: makes DuckStation's DataRoot the exe folder (core.cpp SetDataRoot). */
  private async writePortableMarker(appDir: string): Promise<void> {
    await mkdir(appDir, { recursive: true });
    await writeFile(join(appDir, 'portable.txt'), 'Created by OmniPC: DuckStation keeps settings.ini in this folder (portable mode). Saves are redirected to the OmniPC Saves folder.\r\n');
  }

  async prepareInstall(appDir: string): Promise<string[]> {
    const notes: string[] = [];
    if (!existsSync(join(appDir, 'portable.txt'))) {
      await this.writePortableMarker(appDir);
      notes.push('Enabled DuckStation portable mode (portable.txt) so settings stay inside the OmniPC folder.');
    }
    return notes;
  }

  persistentAppPaths(): string[] {
    return [...PORTABLE_FILES, ...PORTABLE_DEFAULT_DIRS];
  }
}

/** [GameList] Paths / RecursivePaths are string lists stored as repeated keys. */
export function gameListPaths(iniText: string): string[] {
  const out: string[] = [];
  let section = '';
  for (const raw of iniText.split(/\r?\n/)) {
    const line = raw.trim();
    const sec = /^\[(.*)\]$/.exec(line);
    if (sec) {
      section = sec[1].toLowerCase();
      continue;
    }
    if (section !== 'gamelist') continue;
    const m = /^(Paths|RecursivePaths)\s*=\s*(.+)$/i.exec(line);
    if (m) out.push(m[2].trim());
  }
  return out;
}
