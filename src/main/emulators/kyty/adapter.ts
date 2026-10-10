// KytyPS5 adapter (PlayStation 5, experimental).
// Layout:
//   Emulators/kyty/app                 program files (kyty_emulator.exe, launcher.exe, kyty_updater.exe)
//   Emulators/kyty/data/omnideck-kyty.json  OmniDeck-owned launch options (KytyPS5 has no config file;
//                                       every option is a command-line flag, see src/main.cpp)
//   Emulators/kyty/data/Kyty.ini       Qt launcher settings (portable: used when launched with cwd=data)
//   Emulators/kyty/data/logs/kyty.log  emulator log (--printf-direction File)
//   Saves/kyty                         working directory of kyty_emulator; it creates
//                                       _SaveData/<TITLE_ID>, _Trophies, _DownloadData, _TempData,
//                                       _PipelineCache relative to the working directory.
//   BIOS/ps5                           unused (no firmware/modules needed)

import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { BiosStatus, EmulatorManifest, EmulatorSettings, Finding, GameProfile, HardwareProfile, PerformancePreset, RendererOption, SetupImportCandidate, UniversalButton } from '@shared/models';
import manifestJson from '../manifests/kyty.json';
import type { AdapterCapabilities, AdapterPaths, ConfigInput, ConfigInspection, ConfigWriteResult, EmulatorAdapter, LaunchCommand, LaunchTarget, SmokeTestResult } from '../adapter';
import type { AppPaths } from '../../core/paths';
import type { BackupTarget } from '../../config/backups';
import { atomicWrite, loadIni, saveIni } from '../../config/iniFile';
import { checkIni, checkJson } from '../../config/formats';
import { physicalFor } from '../../controllers/translate';
import { findExeIn } from '../common';
import { runProcess } from '../../platform/exec';
import { isWindows } from '../../platform/powershell';
import { splitArgs } from '../pcsx2/adapter';

export const KYTY_MANIFEST = manifestJson as unknown as EmulatorManifest;

/** Video-out resolutions offered by the upstream launcher (src/launcher/include/configuration.h Resolution). */
export const KYTY_RESOLUTIONS: Record<number, [number, number]> = {
  1: [1280, 720],
  2: [1920, 1080],
  3: [2560, 1440],
  4: [3840, 2160],
};

/** Release tags: KytyPS5-<UTC date>-<short sha> (.github/workflows/build.yml metadata job). */
export const KYTY_TAG_RE = /^KytyPS5-\d{4}-\d{2}-\d{2}-[0-9a-f]{7,40}$/;

/**
 * Value-taking options OmniDeck lets users pass through settings.advanced
 * (key = option without the leading dashes). Validated in src/main.cpp ParseArgs.
 */
const ADVANCED_VALUE_OPTIONS = new Set([
  'gpu', 'user-name', 'user-id', 'console-language', 'controller-color', 'controller-volume', 'vblank-frequency',
  'skip-notice-screen', 'trophy-notifications', 'readback-linear-images', 'sync-raw-image-buffers', 'shader-optimization-type', 'mic',
]);
/** Flag options (present when the advanced value is "true"). */
const ADVANCED_FLAG_OPTIONS = new Set(['hide-cursor', 'amd-cpu', 'redzone', 'tessellation', 'playgo-hack', 'vr']);

/**
 * SDL3 gamepad buttons are mapped to DualSense controls with a fixed table
 * (window.cpp ControllerButtonToPadButton); this is the universal-button view of it.
 */
const FIXED_PAD: [string, UniversalButton][] = [
  ['Cross', 'A'], ['Circle', 'B'], ['Square', 'X'], ['Triangle', 'Y'],
  ['L1', 'LB'], ['R1', 'RB'], ['L2', 'LT'], ['R2', 'RT'], ['L3', 'L3'], ['R3', 'R3'], ['Options', 'Start'],
];

export interface KytyManaged {
  workingDirectory: string;
  logFile: string;
  screenWidth: number;
  screenHeight: number;
  fullscreen: boolean;
  presentMode: 'Fifo' | 'Mailbox' | 'Immediate';
  controllerVibration: number;
  /** settings.advanced pass-through options (option name without dashes -> value). */
  options: Record<string, string>;
}

/** On-disk shape of omnideck-kyty.json. Unknown keys are preserved. */
export interface KytyConfigFile {
  _comment?: string;
  managed?: Partial<KytyManaged>;
  /** User-owned: never touched by OmniDeck. */
  user?: { keymap?: string[]; extraArgs?: string[] };
  [k: string]: unknown;
}

const COMMENT = 'Written by OmniDeck PC. KytyPS5 has no settings file; OmniDeck turns "managed" into kyty_emulator command-line flags. Put your own --keymap entries (e.g. "Cross=Space") in user.keymap and extra flags in user.extraArgs; OmniDeck never changes "user".';

export class KytyAdapter implements EmulatorAdapter {
  readonly manifest = KYTY_MANIFEST;
  readonly capabilities: AdapterCapabilities = {
    perGameProfiles: 'native',
    frameLimit: false,
    vsync: true,
    aspectRatios: [],
    // KytyPS5 has no gamepad hotkeys (only F11/Alt+Enter on the keyboard and window close).
    hotkeys: [],
    smokeTest: true,
    maxResolutionScale: 4,
  };

  constructor(private readonly app: AppPaths) {}

  paths(): AdapterPaths {
    return {
      app: this.app.emulatorAppDir('kyty'),
      data: this.app.emulatorDataDir('kyty'),
      saves: this.app.emulatorSaveDir('kyty'),
      bios: this.app.systemBiosDir('ps5'),
      cache: this.app.emulatorCacheDir('kyty'),
    };
  }

  configPath(): string {
    return join(this.paths().data, 'omnideck-kyty.json');
  }

  launcherIniPath(): string {
    return join(this.paths().data, 'Kyty.ini');
  }

  logPath(): string {
    return join(this.paths().data, 'logs', 'kyty.log');
  }

  async findExecutable(appDir: string): Promise<string | null> {
    return findExeIn(appDir, [/^kyty_emulator\.exe$/i, /^kyty_emulator$/]);
  }

  /**
   * kyty_emulator has no version resource; --help prints "ver = 0.3.0, git = <git describe>".
   * Official CI builds describe to a short hash (the tag is created after the build), so a
   * release tag is only returned when the binary actually reports one.
   */
  async detectVersion(executable: string): Promise<string | null> {
    if (!isWindows || !existsSync(executable)) return null;
    const r = await runProcess(executable, ['--help'], { timeoutMs: 15000, cwd: dirname(executable) });
    return parseKytyVersion(r.stdout);
  }

  renderers(hw: HardwareProfile | null): RendererOption[] {
    const vk = hw?.graphicsApis.vulkan;
    return [{ id: 'vulkan', label: 'Vulkan 1.3', available: vk !== false, note: vk === false ? 'No Vulkan driver detected; KytyPS5 cannot run' : undefined }];
  }

  defaultSettings(hw: HardwareProfile | null, preset: PerformancePreset): EmulatorSettings {
    return {
      preset,
      resolutionScale: kytyResolutionScale(hw, preset),
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
    return [{ root, path: this.configPath() }, { root, path: this.launcherIniPath() }];
  }

  private async ensureDirs(): Promise<void> {
    const p = this.paths();
    for (const d of [p.data, join(p.data, 'logs'), p.saves, join(p.saves, '_SaveData'), p.cache]) await mkdir(d, { recursive: true });
  }

  managedPaths(): { workingDirectory: string; logFile: string } {
    return { workingDirectory: this.paths().saves, logFile: this.logPath() };
  }

  graphicsValues(s: EmulatorSettings): Pick<KytyManaged, 'screenWidth' | 'screenHeight' | 'fullscreen' | 'presentMode' | 'options'> {
    const [w, h] = KYTY_RESOLUTIONS[clampScale(s.resolutionScale)];
    const options: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.advanced ?? {})) {
      const name = k.replace(/^-+/, '');
      if (ADVANCED_VALUE_OPTIONS.has(name) || ADVANCED_FLAG_OPTIONS.has(name)) options[name] = String(v);
    }
    // Fifo = vsync; Mailbox is upstream's default (src/common/emulatorConfig.h).
    return { screenWidth: w, screenHeight: h, fullscreen: s.fullscreen, presentMode: s.vsync ? 'Fifo' : 'Mailbox', options };
  }

  async readConfig(): Promise<KytyConfigFile | null> {
    if (!existsSync(this.configPath())) return null;
    try {
      const j = JSON.parse(await readFile(this.configPath(), 'utf8')) as unknown;
      return j && typeof j === 'object' && !Array.isArray(j) ? (j as KytyConfigFile) : null;
    } catch {
      return null;
    }
  }

  async applyConfig(input: ConfigInput, scope: 'all' | 'controller' | 'graphics' | 'paths'): Promise<ConfigWriteResult> {
    await this.ensureDirs();
    const existed = existsSync(this.configPath());
    const parsed = await this.readConfig();
    const notes: string[] = [];
    if (existed && !parsed) notes.push('omnideck-kyty.json could not be parsed and was regenerated (the previous file is kept in the configuration backup).');
    const doc: KytyConfigFile = parsed ?? {};
    const managed: Partial<KytyManaged> = { ...(doc.managed ?? {}) };
    const changed: string[] = [];
    const set = <K extends keyof KytyManaged>(k: K, v: KytyManaged[K]) => {
      if (JSON.stringify(managed[k]) !== JSON.stringify(v)) {
        managed[k] = v;
        changed.push(`managed.${k} = ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
      }
    };

    if (scope === 'all' || scope === 'paths') {
      const mp = this.managedPaths();
      set('workingDirectory', mp.workingDirectory);
      set('logFile', mp.logFile);
      // The Qt launcher checks GitHub for updates on startup and can replace the program
      // files itself (src/launcher/src/mainDialog.cpp FindInterpreter, [MainDialog]
      // check_updates_on_startup, default true). OmniDeck manages versions instead.
      const ini = await loadIni(this.launcherIniPath());
      let iniChanged = !existsSync(this.launcherIniPath());
      if (ini.set('MainDialog', 'check_updates_on_startup', false)) {
        iniChanged = true;
        changed.push('Kyty.ini MainDialog.check_updates_on_startup = false');
      }
      if (iniChanged) await saveIni(this.launcherIniPath(), ini);
    }
    if (scope === 'all' || scope === 'graphics') {
      const g = this.graphicsValues(input.settings);
      set('screenWidth', g.screenWidth);
      set('screenHeight', g.screenHeight);
      set('fullscreen', g.fullscreen);
      set('presentMode', g.presentMode);
      set('options', g.options);
    }
    if (scope === 'all' || scope === 'controller') {
      set('controllerVibration', input.controller.rumble ? 100 : 0);
      const remapped = FIXED_PAD.filter(([, logical]) => physicalFor(input.controller, 'ps5', logical) !== logical).map(([n]) => n);
      if (remapped.length) notes.push(`KytyPS5 has a fixed gamepad layout and cannot remap ${remapped.join(', ')}; the universal profile remapping is not applied for PS5.`);
      if (input.controller.deviceIndex !== 0) notes.push('KytyPS5 has no controller selection; every connected SDL gamepad drives the emulated DualSense.');
    }

    const out: KytyConfigFile = { ...doc, _comment: COMMENT, managed, user: doc.user ?? { keymap: [], extraArgs: [] } };
    if (changed.length || !existed || !parsed) await atomicWrite(this.configPath(), `${JSON.stringify(out, null, 2)}\n`);
    return { changed, notes };
  }

  async inspectConfig(): Promise<ConfigInspection> {
    const files: ConfigInspection['files'] = [];
    const drift: ConfigInspection['drift'] = [];
    const cfg = this.configPath();
    const cfgExists = existsSync(cfg);
    const cfgText = cfgExists ? await readFile(cfg, 'utf8').catch(() => '') : '';
    const cfgFmt = cfgExists ? checkJson(cfgText) : { ok: false, issues: ['File does not exist'] };
    files.push({ label: 'omnideck-kyty.json', path: cfg, exists: cfgExists, parseOk: cfgExists && cfgFmt.ok, issues: cfgFmt.issues });
    if (cfgExists && cfgFmt.ok) {
      const m = (await this.readConfig())?.managed ?? {};
      const mp = this.managedPaths();
      const cmp = (key: 'workingDirectory' | 'logFile', critical: boolean) => {
        const actual = typeof m[key] === 'string' ? (m[key] as string) : null;
        if (!actual || actual.toLowerCase() !== mp[key].toLowerCase()) drift.push({ file: cfg, key: `managed.${key}`, expected: mp[key], actual, critical });
      };
      // The working directory decides where KytyPS5 writes _SaveData.
      cmp('workingDirectory', true);
      cmp('logFile', false);
    }
    const ini = this.launcherIniPath();
    const iniExists = existsSync(ini);
    const iniText = iniExists ? await readFile(ini, 'utf8').catch(() => '') : '';
    const iniFmt = iniExists ? checkIni(iniText) : { ok: false, issues: ['File does not exist'] };
    files.push({ label: 'Kyty.ini', path: ini, exists: iniExists, parseOk: iniExists && iniFmt.ok, issues: iniFmt.issues });
    if (iniExists && iniFmt.ok) {
      const v = (await loadIni(ini)).get('MainDialog', 'check_updates_on_startup') ?? null;
      if (v !== 'false') drift.push({ file: ini, key: 'MainDialog.check_updates_on_startup', expected: 'false', actual: v, critical: false });
    }
    return { files, drift };
  }

  /** <game>/eboot.bin -> <game> (KytyPS5 loads /app0/eboot.bin from a directory); .zar/.elf as-is. */
  gameArgument(path: string): string {
    return basename(path).toLowerCase() === 'eboot.bin' ? dirname(path) : path;
  }

  async buildLaunch(target: LaunchTarget, executable: string, settings: EmulatorSettings, profile: GameProfile | null, _version: string | null): Promise<LaunchCommand> {
    const p = this.paths();
    const doc = (await this.readConfig()) ?? {};
    const managed = doc.managed ?? {};
    const notes: string[] = [];
    const merged: EmulatorSettings = profile
      ? { ...settings, ...(profile.overrides as Partial<EmulatorSettings>), advanced: { ...settings.advanced, ...(profile.overrides.advanced ?? {}) } }
      : settings;
    if (profile && Object.keys(profile.overrides).length) notes.push('Per-game profile applied as command-line options for this launch.');
    const g = this.graphicsValues(merged);
    const vibration = typeof managed.controllerVibration === 'number' ? managed.controllerVibration : 100;
    const logFile = this.logPath();

    const args = [
      '--printf-direction', 'File',
      '--printf-output-file', logFile,
      '--screen-width', String(g.screenWidth),
      '--screen-height', String(g.screenHeight),
      '--present-mode', g.presentMode,
      '--controller-vibration', String(vibration),
    ];
    if (g.fullscreen) args.push('--fullscreen');
    for (const [name, value] of Object.entries(g.options)) {
      if (ADVANCED_FLAG_OPTIONS.has(name)) {
        if (/^(true|1|yes|on)$/i.test(value) && !args.includes(`--${name}`)) args.push(`--${name}`);
      } else args.push(`--${name}`, value);
    }
    if (g.fullscreen && !args.includes('--hide-cursor') && g.options['hide-cursor'] === undefined) args.push('--hide-cursor');
    for (const k of Array.isArray(doc.user?.keymap) ? doc.user.keymap : []) {
      if (typeof k === 'string' && /^[^=]+=.+$/.test(k)) args.push('--keymap', k);
    }
    for (const a of Array.isArray(doc.user?.extraArgs) ? doc.user.extraArgs : []) if (typeof a === 'string' && a) args.push(a);
    // Cheat plans saved by the upstream launcher (src/launcher/src/cheatFile.cpp PlanPath).
    if (target.serial && /^PPSA\d{5}$/i.test(target.serial)) {
      const plan = join(dirname(executable), '_Patches', `${target.serial.toUpperCase()}.json`);
      if (existsSync(plan)) {
        args.push('--game-patch', plan);
        notes.push(`Game patch ${plan} applied.`);
      }
    }
    if (profile?.customArgs) args.push(...splitArgs(profile.customArgs));
    args.push('--game', this.gameArgument(target.path));
    // Saves/trophies are written relative to the working directory (libSaveData.cpp, emulator.cpp).
    const cwd = p.saves;
    return {
      command: executable,
      args,
      targetArgs: 2,
      cwd,
      logFile,
      prepare: async () => {
        await mkdir(cwd, { recursive: true });
        await mkdir(dirname(logFile), { recursive: true });
      },
      notes,
    };
  }

  /**
   * Opens the upstream Qt launcher. Its working directory is the data folder so it uses the
   * portable data/Kyty.ini (update check disabled). Note: games started from the launcher run
   * with the program folder as working directory, so their saves land in app/_SaveData.
   */
  buildUiLaunch(executable: string): LaunchCommand {
    const launcher = join(dirname(executable), isWindows || executable.toLowerCase().endsWith('.exe') ? 'launcher.exe' : 'launcher');
    const notes = ['Games started from the KytyPS5 launcher keep their saves in the program folder (upstream behaviour); OmniDeck carries them across updates.'];
    if (!existsSync(launcher)) notes.push(`${launcher} not found; KytyPS5 has no UI without the launcher.`);
    return { command: existsSync(launcher) ? launcher : executable, args: existsSync(launcher) ? [] : ['--help'], cwd: this.paths().data, logFile: this.logPath(), notes };
  }

  async smokeTest(executable: string): Promise<SmokeTestResult> {
    const checks: SmokeTestResult['checks'] = [];
    const exeOk = existsSync(executable);
    checks.push({ label: 'Executable present', ok: exeOk, detail: executable });
    if (!exeOk) return { ran: true, ok: false, checks };
    const dir = dirname(executable);
    const pthread = join(dir, 'libwinpthread-1.dll');
    // Installed by CMakeLists.txt only for clang-cl builds (the official Windows releases).
    checks.push({ label: 'libwinpthread-1.dll present', ok: true, detail: existsSync(pthread) ? pthread : 'Not present (only shipped with clang-cl builds; official releases include it)' });
    const insp = await this.inspectConfig();
    const cfg = insp.files[0];
    checks.push({ label: 'Configuration parses', ok: cfg.parseOk, detail: insp.files.flatMap((f) => f.issues.map((i) => `${f.label}: ${i}`)).join('; ') || 'omnideck-kyty.json and Kyty.ini OK' });
    if (!isWindows) {
      checks.push({ label: 'Executable starts (--help)', ok: true, detail: 'Skipped: only possible on Windows' });
      return { ran: false, ok: checks.every((c) => c.ok), checks };
    }
    // --help prints usage and exits 0 without creating a window (src/main.cpp Main).
    const r = await runProcess(executable, ['--help'], { timeoutMs: 20000, cwd: dir });
    const ok = !r.error && !r.timedOut && r.code === 0 && /--game/.test(r.stdout);
    checks.push({
      label: 'Executable starts (--help)',
      ok,
      detail: r.error ? r.error.message : r.timedOut ? 'Timed out after 20s' : `Exit code ${r.code}${r.stdout ? `: ${r.stdout.split(/\r?\n/)[0].slice(0, 200)}` : ''}`,
    });
    return { ran: true, ok: checks.every((c) => c.ok), checks };
  }

  async validateEnvironment(hw: HardwareProfile | null, _executable: string | null): Promise<Finding[]> {
    const subject = { kind: 'emulator' as const, id: 'kyty', label: 'KytyPS5' };
    const out: Finding[] = [];
    if (hw && hw.graphicsApis.vulkan === false) {
      out.push({
        id: 'kyty.vulkan', checkId: 'kyty.graphics', category: 'emulators', severity: 'problem', title: 'KytyPS5 needs Vulkan 1.3',
        detail: 'No Vulkan driver was detected. KytyPS5 only renders with Vulkan 1.3 and exits immediately without it.', subject,
        evidence: [...hw.graphicsApis.notes, `GPUs: ${hw.gpus.map((g) => g.name).join(', ') || 'none detected'}`], confidence: 'high', repair: null,
        manualSteps: ['Install the latest graphics driver from your GPU vendor (NVIDIA, AMD or Intel).', 'Make sure the GPU supports Vulkan 1.3 (roughly NVIDIA GTX 900 series, AMD RX 400 series, Intel Arc / UHD 600+ or newer).'],
      });
    } else if (hw && hw.graphicsApis.vulkan === null) {
      out.push({
        id: 'kyty.vulkan-unknown', checkId: 'kyty.graphics', category: 'emulators', severity: 'warning', title: 'Vulkan support could not be confirmed',
        detail: 'KytyPS5 requires Vulkan 1.3. OmniDeck could not determine whether a Vulkan driver is installed.', subject, evidence: hw.graphicsApis.notes, confidence: 'low', repair: null,
        manualSteps: ['Install the latest graphics driver from your GPU vendor.'],
      });
    }
    out.push({
      id: 'kyty.compatibility', checkId: 'kyty.compatibility', category: 'emulators', severity: 'info', title: 'KytyPS5 is experimental',
      detail: 'KytyPS5 boots 2D games and a selection of 3D games; most PS5 games do not run yet, and compatibility, stability and performance change between daily builds. Check https://kytyps5.github.io/ before troubleshooting a game.',
      subject, evidence: [], confidence: 'high', repair: null, manualSteps: [],
    });
    const stray = join(this.paths().app, '_SaveData');
    if (existsSync(stray)) {
      out.push({
        id: 'kyty.app-saves', checkId: 'kyty.saves', category: 'saves', severity: 'info', title: 'KytyPS5 saves in the program folder',
        detail: `Games started from the KytyPS5 launcher saved to ${stray}. Games started from OmniDeck save to ${join(this.paths().saves, '_SaveData')}. OmniDeck keeps both across updates; copy title folders between them if you switch.`,
        subject, evidence: [stray], confidence: 'high', repair: null, manualSteps: [],
      });
    }
    return out;
  }

  saveLocations(): { label: string; path: string }[] {
    const s = this.paths().saves;
    return [
      { label: 'Game saves', path: join(s, '_SaveData') },
      { label: 'Trophies', path: join(s, '_Trophies') },
      { label: 'Downloaded game data', path: join(s, '_DownloadData') },
    ];
  }

  async biosStatus(): Promise<BiosStatus[]> {
    return [{
      systemId: 'ps5', systemName: 'PlayStation 5', label: 'PlayStation 5 firmware', required: false, requirementKind: 'firmware', emulatorId: 'kyty',
      expectedLocation: this.paths().bios, status: 'not_applicable', files: [],
      note: 'KytyPS5 needs no firmware or system modules (high-level emulation). Nothing to place here.',
    }];
  }

  logFile(): string | null {
    return this.logPath();
  }

  cacheDirs(): { label: string; path: string }[] {
    return [{ label: 'Vulkan pipeline cache', path: join(this.paths().saves, '_PipelineCache') }];
  }

  async recoverSession(): Promise<string[]> {
    // Per-game options are command-line only; nothing is written for a session.
    return [];
  }

  /**
   * SetupImportCandidate.source has no 'kyty' value yet, so existing launcher setups
   * (%ProgramData%\Kyty\Kyty.ini or a portable Kyty.ini next to launcher.exe) are not offered.
   */
  async detectExistingSetups(): Promise<SetupImportCandidate[]> {
    return [];
  }

  /** User data the upstream launcher keeps next to the executables (mainDialog.cpp, cheatFile.cpp). */
  persistentAppPaths(): string[] {
    return ['_SaveData', '_Trophies', '_DownloadData', '_Patches', 'Kyty.ini'];
  }
}

function clampScale(n: number): number {
  return Math.max(1, Math.min(4, Math.round(Number.isFinite(n) ? n : 2)));
}

/** PS5 video-out resolution step (1=720p, 2=1080p, 3=1440p, 4=2160p) by preset, hardware tier and display. */
export function kytyResolutionScale(hw: HardwareProfile | null, preset: PerformancePreset): number {
  const base: Record<PerformancePreset, number> = { performance: 1, balanced: 2, quality: 3, maximum: 4 };
  const tierCap: Record<HardwareProfile['tier'], number> = { low: 1, mid: 2, high: 3, enthusiast: 4 };
  let scale = Math.min(base[preset], tierCap[hw?.tier ?? 'mid']);
  const display = hw?.displays.find((d) => d.primary) ?? hw?.displays[0];
  if (display) scale = Math.min(scale, display.height >= 2000 ? 4 : display.height >= 1400 ? 3 : 2);
  return clampScale(scale);
}

/** Extracts a release tag from `kyty_emulator --help` output, or null when only a hash is reported. */
export function parseKytyVersion(stdout: string): string | null {
  const m = /git = ([^,\s]+)/.exec(stdout);
  return m && KYTY_TAG_RE.test(m[1]) ? m[1] : null;
}
