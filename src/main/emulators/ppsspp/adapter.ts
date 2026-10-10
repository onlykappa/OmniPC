// PPSSPP adapter (PlayStation Portable).
// Layout:
//   Emulators/ppsspp/app                       program files (replaced on update) + installed.txt
//   Emulators/ppsspp/data/memstick             PPSSPP memory stick root (pointed to by app/installed.txt)
//     PSP/SYSTEM/ppsspp.ini, controls.ini      settings
//     PSP/SAVEDATA, PSP/PPSSPP_STATE           game saves, save states (fixed sub-folders)
//     PSP/SYSTEM/CACHE                         shader cache
// No BIOS: the PSP OS is high-level emulated and fonts ship in app/assets/flash0.

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BiosStatus, EmulatorManifest, EmulatorSettings, Finding, GameProfile, HardwareProfile, PerformancePreset, RendererOption, SetupImportCandidate, UniversalButton } from '@shared/models';
import manifestJson from '../manifests/ppsspp.json';
import type { AdapterCapabilities, AdapterPaths, ConfigInput, ConfigInspection, ConfigWriteResult, EmulatorAdapter, LaunchCommand, LaunchTarget, SmokeTestResult } from '../adapter';
import type { AppPaths } from '../../core/paths';
import type { BackupTarget } from '../../config/backups';
import { atomicWrite, loadIni, saveIni } from '../../config/iniFile';
import type { IniDocument } from '../../config/ini';
import { checkIni } from '../../config/formats';
import { hotkeyChords, physicalFor } from '../../controllers/translate';
import { findExeIn, preferredRenderer, resolutionScaleFor } from '../common';
import { fileVersion, isWindows } from '../../platform/powershell';
import { splitArgs } from '../pcsx2/adapter';

export const PPSSPP_MANIFEST = manifestJson as unknown as EmulatorManifest;

/** enum class GPUBackend (Core/ConfigValues.h), written by ConfigTranslator as "<int> (<NAME>)". */
export const PPSSPP_BACKENDS: Record<string, { value: string; software: boolean }> = {
  vulkan: { value: '3 (VULKAN)', software: false },
  d3d11: { value: '2 (DIRECT3D11)', software: false },
  opengl: { value: '0 (OPENGL)', software: false },
  software: { value: '0 (OPENGL)', software: true },
};

/** DEVICE_ID_XINPUT_0 (Common/Input/InputState.h). */
export const XINPUT_DEVICE_BASE = 20;
const KEYBOARD = 1;
const DINPUT_PAD = 10;

/** Axis binding code: AXIS_BIND_NKCODE_START + axis * 2 + (negative ? 1 : 0). */
const axis = (id: number, dir: 1 | -1): number => 4000 + id * 2 + (dir < 0 ? 1 : 0);
const AX = { X: 0, Y: 1, Z: 11, RZ: 14, LTRIGGER: 17, RTRIGGER: 18 } as const;

/** Universal button -> PPSSPP key code as produced by Windows/XinputDevice.cpp. */
export const XINPUT_CODES: Record<UniversalButton, number> = {
  A: 96, B: 97, X: 99, Y: 100,
  LB: 102, RB: 103, LT: axis(AX.LTRIGGER, 1), RT: axis(AX.RTRIGGER, 1),
  L3: 106, R3: 107, Start: 108, Select: 109, Guide: 3,
  DPadUp: 19, DPadDown: 20, DPadLeft: 21, DPadRight: 22,
  // XInput thumb Y axes are positive when pushed up.
  LeftStickUp: axis(AX.Y, 1), LeftStickDown: axis(AX.Y, -1), LeftStickLeft: axis(AX.X, -1), LeftStickRight: axis(AX.X, 1),
  RightStickUp: axis(AX.RZ, 1), RightStickDown: axis(AX.RZ, -1), RightStickLeft: axis(AX.Z, -1), RightStickRight: axis(AX.Z, 1),
};

/** PSP control name (psp_button_names) -> logical universal button (positional: Cross south). */
const PSP_PAD: [string, UniversalButton][] = [
  ['Cross', 'A'], ['Circle', 'B'], ['Square', 'X'], ['Triangle', 'Y'],
  ['L', 'LB'], ['R', 'RB'], ['Start', 'Start'], ['Select', 'Select'],
  ['Up', 'DPadUp'], ['Down', 'DPadDown'], ['Left', 'DPadLeft'], ['Right', 'DPadRight'],
  ['An.Up', 'LeftStickUp'], ['An.Down', 'LeftStickDown'], ['An.Left', 'LeftStickLeft'], ['An.Right', 'LeftStickRight'],
];

const HOTKEY_NAMES = {
  exit: 'Exit App',
  saveState: 'Save State',
  loadState: 'Load State',
  menu: 'Pause',
  fastForward: 'Fast-forward',
  screenshot: 'Screenshot',
  fullscreen: 'Toggle Fullscreen',
} as const;

/**
 * PPSSPP's Windows defaults for keyboard (QWERTY) and DirectInput pads
 * (Core/KeyMapDefaults.cpp). KeyMap::LoadFromIni erases the default of every
 * key missing from [ControlMapping], so these are seeded when OmniDeck creates
 * the section to keep the keyboard and DirectInput pads working.
 */
const SEED_DEFAULTS: Record<string, string[]> = {
  Square: [`${KEYBOARD}-29`, `${DINPUT_PAD}-191`],
  Triangle: [`${KEYBOARD}-47`, `${DINPUT_PAD}-188`],
  Circle: [`${KEYBOARD}-52`, `${DINPUT_PAD}-190`],
  Cross: [`${KEYBOARD}-54`, `${DINPUT_PAD}-189`],
  L: [`${KEYBOARD}-45`, `${DINPUT_PAD}-194`],
  R: [`${KEYBOARD}-51`, `${DINPUT_PAD}-195`],
  Start: [`${KEYBOARD}-62`, `${DINPUT_PAD}-197`],
  Select: [`${KEYBOARD}-50`, `${DINPUT_PAD}-196`],
  Up: [`${KEYBOARD}-19`, `${DINPUT_PAD}-19`],
  Down: [`${KEYBOARD}-20`, `${DINPUT_PAD}-20`],
  Left: [`${KEYBOARD}-21`, `${DINPUT_PAD}-21`],
  Right: [`${KEYBOARD}-22`, `${DINPUT_PAD}-22`],
  'An.Up': [`${KEYBOARD}-37`, `${DINPUT_PAD}-${axis(AX.Y, -1)}`],
  'An.Down': [`${KEYBOARD}-39`, `${DINPUT_PAD}-${axis(AX.Y, 1)}`],
  'An.Left': [`${KEYBOARD}-38`, `${DINPUT_PAD}-${axis(AX.X, -1)}`],
  'An.Right': [`${KEYBOARD}-40`, `${DINPUT_PAD}-${axis(AX.X, 1)}`],
  RapidFire: [`${KEYBOARD}-59`],
  'Fast-forward': [`${KEYBOARD}-61`],
  SpeedToggle: [`${KEYBOARD}-68`, `${XINPUT_DEVICE_BASE}-107`],
  Pause: [`${KEYBOARD}-111`, `${DINPUT_PAD}-109`, `${DINPUT_PAD}-104`, `${DINPUT_PAD}-${axis(AX.LTRIGGER, 1)}`],
  Rewind: [`${KEYBOARD}-67`],
  'Analog limiter': [`${KEYBOARD}-60`],
  'Toggle Debugger': [`${KEYBOARD}-142`],
  'Pause (no menu)': [`${KEYBOARD}-138`],
  'Analog speed': [`${DINPUT_PAD}-${axis(AX.RTRIGGER, 1)}`],
};

type Val = string | number;

export class PpssppAdapter implements EmulatorAdapter {
  readonly manifest = PPSSPP_MANIFEST;
  readonly capabilities: AdapterCapabilities = {
    perGameProfiles: 'session',
    frameLimit: false,
    vsync: true,
    aspectRatios: [
      { id: 'auto', label: 'Native (PSP 16:9)' },
      { id: 'stretch', label: 'Stretch to window' },
    ],
    hotkeys: ['exit', 'saveState', 'loadState', 'menu', 'fastForward', 'screenshot', 'fullscreen'],
    smokeTest: true,
    maxResolutionScale: 10,
  };

  constructor(private readonly app: AppPaths) {}

  paths(): AdapterPaths {
    return {
      app: this.app.emulatorAppDir('ppsspp'),
      data: this.app.emulatorDataDir('ppsspp'),
      saves: this.app.emulatorSaveDir('ppsspp'),
      bios: this.app.systemBiosDir('psp'),
      cache: this.app.emulatorCacheDir('ppsspp'),
    };
  }

  /** PPSSPP memory stick root (g_Config.memStickDirectory). */
  memstick(): string {
    return join(this.paths().data, 'memstick');
  }

  systemDir(): string {
    return join(this.memstick(), 'PSP', 'SYSTEM');
  }

  iniPath(): string {
    return join(this.systemDir(), 'ppsspp.ini');
  }

  controlsPath(): string {
    return join(this.systemDir(), 'controls.ini');
  }

  installedTxt(appDir = this.paths().app): string {
    return join(appDir, 'installed.txt');
  }

  async findExecutable(appDir: string): Promise<string | null> {
    return findExeIn(appDir, [/^PPSSPPWindows64\.exe$/i, /^PPSSPPWindows\.exe$/i, /^PPSSPPSDL$/]);
  }

  async detectVersion(executable: string): Promise<string | null> {
    const v = await fileVersion(executable);
    return v ? v.replace(/^v/, '') : null;
  }

  renderers(hw: HardwareProfile | null): RendererOption[] {
    const vk = hw?.graphicsApis.vulkan;
    return [
      { id: 'vulkan', label: 'Vulkan', available: vk !== false, note: vk === false ? 'No Vulkan driver detected' : undefined },
      { id: 'd3d11', label: 'Direct3D 11', available: hw ? hw.isWindows : true },
      { id: 'opengl', label: 'OpenGL', available: true },
      { id: 'software', label: 'Software (slow, uses OpenGL)', available: true },
    ];
  }

  defaultSettings(hw: HardwareProfile | null, preset: PerformancePreset): EmulatorSettings {
    // resolutionScaleFor assumes ~480p consoles; the PSP renders 272 lines, so double it.
    const scale = Math.min(this.capabilities.maxResolutionScale, resolutionScaleFor(hw, preset, 5) * 2);
    return {
      preset,
      resolutionScale: scale,
      // PPSSPP has no D3D12 backend; D3D11 is the Windows fallback.
      renderer: preferredRenderer(hw, { d3d12: 'd3d11', d3d11: 'd3d11', vulkan: 'vulkan', opengl: 'opengl' }),
      aspectRatio: 'auto',
      fullscreen: true,
      frameLimit: true,
      vsync: preset !== 'performance',
      advanced: {},
    };
  }

  configTargets(): BackupTarget[] {
    const d = this.paths().data;
    return [
      { root: d, path: this.iniPath() },
      { root: d, path: this.controlsPath() },
    ];
  }

  private async ensureDirs(): Promise<void> {
    const p = this.paths();
    const psp = join(this.memstick(), 'PSP');
    for (const dir of [p.data, this.memstick(), psp, this.systemDir(), join(psp, 'SAVEDATA'), join(psp, 'PPSSPP_STATE'), join(psp, 'SCREENSHOT'), p.saves]) {
      await mkdir(dir, { recursive: true });
    }
  }

  /**
   * Writes installed.txt so PPSSPP uses the OmniDeck memstick instead of
   * <exe>/memstick (Windows/main.cpp InitMemstickDirectory). No line ending:
   * fgets keeps a '\r', which would make the path invalid.
   */
  async writeInstalledTxt(appDir = this.paths().app): Promise<boolean> {
    const file = this.installedTxt(appDir);
    const want = this.memstick();
    const have = existsSync(file) ? await readFile(file, 'utf8').catch(() => null) : null;
    if (have === want) return false;
    await atomicWrite(file, want);
    return true;
  }

  async prepareInstall(appDir: string): Promise<string[]> {
    await this.ensureDirs();
    const changed = await this.writeInstalledTxt(appDir);
    return changed ? [`PPSSPP memory stick set to ${this.memstick()} (installed.txt).`] : [];
  }

  /** Safety net: if installed.txt ever goes missing PPSSPP falls back to <app>/memstick. */
  persistentAppPaths(): string[] {
    return ['memstick'];
  }

  /** Startup-prompt suppression; see manifest assumptions for the source references. */
  generalValues(): [string, string, Val][] {
    return [
      ['General', 'FirstRun', 'False'],
      ['General', 'CheckForNewVersion', 'False'],
      // >0 shows a modal Win32 "Are you sure you want to exit?" box when the window is closed.
      ['General', 'AskForExitConfirmationAfterSeconds', 0],
    ];
  }

  graphicsValues(s: EmulatorSettings): [string, string, Val][] {
    const backend = PPSSPP_BACKENDS[s.renderer] ?? PPSSPP_BACKENDS.vulkan;
    return [
      ['Graphics', 'GraphicsBackend', backend.value],
      ['Graphics', 'SoftwareRenderer', backend.software ? 'True' : 'False'],
      ['Graphics', 'InternalResolution', Math.max(1, Math.min(this.capabilities.maxResolutionScale, Math.round(s.resolutionScale)))],
      ['Graphics', 'VerticalSync', s.vsync ? 'True' : 'False'],
      ['Graphics', 'FullScreen', s.fullscreen ? 'True' : 'False'],
      ['DisplayLayout.Landscape', 'DisplayStretch', s.aspectRatio === 'stretch' ? 'True' : 'False'],
    ];
  }

  /** Desired XInput entries per [ControlMapping] key for the profile. */
  controllerBindings(input: ConfigInput): Map<string, string[]> {
    const dev = XINPUT_DEVICE_BASE + Math.max(0, Math.min(3, input.controller.deviceIndex));
    const code = (b: UniversalButton) => `${dev}-${XINPUT_CODES[b]}`;
    const out = new Map<string, string[]>();
    for (const [psp, logical] of PSP_PAD) out.set(psp, [code(physicalFor(input.controller, 'psp', logical))]);
    // Guide opens the pause menu like PPSSPP's own XInput default (NKCODE_HOME).
    out.set('Pause', [code('Guide')]);
    for (const name of Object.values(HOTKEY_NAMES)) if (!out.has(name)) out.set(name, []);
    for (const c of hotkeyChords(input.hotkeys, this.capabilities.hotkeys)) {
      const name = HOTKEY_NAMES[c.action as keyof typeof HOTKEY_NAMES];
      if (!name) continue;
      out.get(name)!.push(c.buttons.map(code).join(':'));
    }
    return out;
  }

  private applyControls(doc: IniDocument, input: ConfigInput): string[] {
    const changed: string[] = [];
    const dev = XINPUT_DEVICE_BASE + Math.max(0, Math.min(3, input.controller.deviceIndex));
    const fresh = !doc.hasSection('ControlMapping');
    const bindings = this.controllerBindings(input);
    const keys = new Set<string>([...bindings.keys(), ...(fresh ? Object.keys(SEED_DEFAULTS) : [])]);
    for (const key of keys) {
      const current = doc.get('ControlMapping', key);
      const existing = current !== undefined ? splitList(current) : fresh ? SEED_DEFAULTS[key] ?? [] : [];
      const managed = bindings.has(key);
      // Drop every mapping that involves our pad; keep keyboard, DirectInput and other pads.
      const kept = managed ? existing.filter((m) => !m.split(':').some((part) => part.split('-')[0] === String(dev))) : existing;
      const desired = [...kept, ...(bindings.get(key) ?? [])];
      if (current !== undefined && sameSet(splitList(current), desired)) continue;
      if (current === undefined && desired.length === 0) continue;
      const value = desired.join(',');
      if (doc.set('ControlMapping', key, value)) changed.push(`ControlMapping.${key} = ${value}`);
    }
    return changed;
  }

  async applyConfig(input: ConfigInput, scope: 'all' | 'controller' | 'graphics' | 'paths'): Promise<ConfigWriteResult> {
    await this.ensureDirs();
    const changed: string[] = [];
    const notes: string[] = [];
    if (scope === 'all' || scope === 'paths' || scope === 'graphics') {
      const doc = await loadIni(this.iniPath());
      const set = (s: string, k: string, v: Val) => {
        if (setLoose(doc, s, k, v)) changed.push(`${s}.${k} = ${v}`);
      };
      if (scope === 'all' || scope === 'paths') {
        if (existsSync(this.paths().app) && (await this.writeInstalledTxt())) changed.push(`installed.txt = ${this.memstick()}`);
        for (const [s, k, v] of this.generalValues()) set(s, k, v);
      }
      if (scope === 'all' || scope === 'graphics') {
        for (const [s, k, v] of this.graphicsValues(input.settings)) set(s, k, v);
        for (const [key, value] of Object.entries(input.settings.advanced)) {
          const [section, name] = key.split('|');
          if (section && name) set(section, name, value);
        }
      }
      if (changed.some((c) => !c.startsWith('installed.txt')) || !existsSync(this.iniPath())) await saveIni(this.iniPath(), doc);
    }
    if (scope === 'all' || scope === 'controller') {
      const ini = await loadIni(this.iniPath());
      if (setLoose(ini, 'Control', 'AnalogDeadzone', input.controller.deadzone.toFixed(2))) {
        changed.push(`Control.AnalogDeadzone = ${input.controller.deadzone.toFixed(2)}`);
        await saveIni(this.iniPath(), ini);
      }
      const doc = await loadIni(this.controlsPath());
      const c = this.applyControls(doc, input);
      if (c.length || !existsSync(this.controlsPath())) await saveIni(this.controlsPath(), doc);
      changed.push(...c);
      if (input.controller.deviceIndex > 3) notes.push('PPSSPP supports XInput pads 0-3 only; bindings were written for pad 3.');
      if (!input.controller.rumble) notes.push('PPSSPP has no rumble switch; vibration only happens in games that use it.');
    }
    return { changed, notes };
  }

  async inspectConfig(): Promise<ConfigInspection> {
    const files: ConfigInspection['files'] = [];
    const drift: ConfigInspection['drift'] = [];
    for (const [label, path] of [['ppsspp.ini', this.iniPath()], ['controls.ini', this.controlsPath()]] as const) {
      const exists = existsSync(path);
      const text = exists ? await readFile(path, 'utf8').catch(() => '') : '';
      const fmt = exists ? checkIni(text) : { ok: false, issues: ['File does not exist'] };
      files.push({ label, path, exists, parseOk: exists && fmt.ok, issues: fmt.issues });
    }
    const txt = this.installedTxt();
    if (existsSync(this.paths().app)) {
      const exists = existsSync(txt);
      const actual = exists ? await readFile(txt, 'utf8').catch(() => null) : null;
      const issues: string[] = [];
      if (!exists) issues.push('Missing: PPSSPP will keep settings and saves inside the program folder');
      else if (actual !== null && /[\r\n]/.test(actual)) issues.push('Contains a line break; PPSSPP keeps the \\r and falls back to Documents\\PPSSPP');
      files.push({ label: 'installed.txt', path: txt, exists, parseOk: exists && issues.length === 0, issues });
      if (actual === null || actual.replace(/^\uFEFF/, '').replace(/\n$/, '').toLowerCase() !== this.memstick().toLowerCase() || /\r/.test(actual)) {
        drift.push({ file: txt, key: 'memstick', expected: this.memstick(), actual, critical: true });
      }
    }
    if (files[0].parseOk) {
      const doc = await loadIni(this.iniPath());
      for (const [s, k, v] of this.generalValues()) {
        const a = doc.get(s, k) ?? null;
        if (a === null || a.toLowerCase() !== String(v).toLowerCase()) drift.push({ file: this.iniPath(), key: `${s}.${k}`, expected: String(v), actual: a, critical: false });
      }
    }
    return { files, drift };
  }

  async buildLaunch(target: LaunchTarget, executable: string, settings: EmulatorSettings, profile: GameProfile | null, _version: string | null): Promise<LaunchCommand> {
    const p = this.paths();
    // --pause-menu-exit: pause menu "Exit" closes PPSSPP (bPauseMenuExitsEmulator is DONT_SAVE, CLI only).
    const args = ['--pause-menu-exit', settings.fullscreen ? '--fullscreen' : '--windowed'];
    const notes: string[] = [];
    let prepare: LaunchCommand['prepare'];
    let cleanup: LaunchCommand['cleanup'];
    const overrides = profile ? this.profileOverrides(settings, profile) : [];
    if (overrides.length) {
      const ini = this.iniPath();
      const journal = this.journalPath();
      prepare = async () => {
        const doc = await loadIni(ini);
        const originals = overrides.map(([s, k]) => [s, k, doc.get(s, k) ?? null] as [string, string, string | null]);
        await atomicWrite(journal, JSON.stringify({ originals }));
        for (const [s, k, v] of overrides) setLoose(doc, s, k, v);
        await saveIni(ini, doc);
      };
      cleanup = async () => {
        await this.restoreJournal();
      };
      notes.push(`Per-game profile applied for this session only (${overrides.length} overrides); the global values are restored when PPSSPP exits. A per-game config created inside PPSSPP takes precedence.`);
    }
    if (profile?.customArgs) args.push(...splitArgs(profile.customArgs));
    // No "--" separator: PPSSPP master rejects unknown "--" options.
    args.push(target.path);
    return { command: executable, args, cwd: p.app, logFile: this.logFile(), prepare, cleanup, notes };
  }

  profileOverrides(base: EmulatorSettings, profile: GameProfile): [string, string, Val][] {
    const merged: EmulatorSettings = { ...base, ...(profile.overrides as Partial<EmulatorSettings>), advanced: {} };
    const g = new Map(this.graphicsValues(merged).map(([s, k, v]) => [`${s}|${k}`, [s, k, v] as [string, string, Val]]));
    const o = profile.overrides;
    const out: [string, string, Val][] = [];
    if (o.renderer !== undefined) out.push(g.get('Graphics|GraphicsBackend')!, g.get('Graphics|SoftwareRenderer')!);
    if (o.resolutionScale !== undefined) out.push(g.get('Graphics|InternalResolution')!);
    if (o.vsync !== undefined) out.push(g.get('Graphics|VerticalSync')!);
    if (o.aspectRatio !== undefined) out.push(g.get('DisplayLayout.Landscape|DisplayStretch')!);
    for (const [key, value] of Object.entries(o.advanced ?? {})) {
      const [section, name] = key.split('|');
      if (section && name) out.push([section, name, value]);
    }
    return out;
  }

  private journalPath(): string {
    return `${this.iniPath()}.omnideck-session`;
  }

  /** Restores only the keys a session override changed, keeping everything else PPSSPP saved on exit. */
  private async restoreJournal(): Promise<boolean> {
    const journal = this.journalPath();
    if (!existsSync(journal)) return false;
    let originals: [string, string, string | null][] = [];
    try {
      originals = (JSON.parse(await readFile(journal, 'utf8')) as { originals: [string, string, string | null][] }).originals ?? [];
    } catch {
      originals = [];
    }
    const doc = await loadIni(this.iniPath());
    for (const [s, k, v] of originals) {
      if (v === null) doc.delete(s, k);
      else doc.set(s, k, v);
    }
    await saveIni(this.iniPath(), doc);
    await rm(journal, { force: true });
    return true;
  }

  buildUiLaunch(executable: string): LaunchCommand {
    return { command: executable, args: [], cwd: this.paths().app, logFile: this.logFile(), notes: [] };
  }

  async smokeTest(executable: string): Promise<SmokeTestResult> {
    const checks: SmokeTestResult['checks'] = [];
    const exeOk = existsSync(executable);
    checks.push({ label: 'Executable present', ok: exeOk, detail: executable });
    if (!exeOk) return { ran: false, ok: false, checks };
    const flash0 = join(this.paths().app, 'assets', 'flash0');
    checks.push({ label: 'assets\\flash0 present', ok: existsSync(flash0), detail: existsSync(flash0) ? flash0 : 'PPSSPP needs its assets folder (fonts, UI atlas) next to the executable' });
    const insp = await this.inspectConfig();
    const memDrift = insp.drift.find((d) => d.key === 'memstick');
    checks.push({ label: 'Memory stick location (installed.txt)', ok: !memDrift, detail: memDrift ? `Expected ${memDrift.expected}, found ${memDrift.actual ?? 'nothing'}` : this.memstick() });
    let writable = true;
    try {
      await mkdir(this.memstick(), { recursive: true });
      const probe = join(this.memstick(), '_omnideck_write_test.tmp');
      await writeFile(probe, '');
      await rm(probe, { force: true });
    } catch {
      writable = false;
    }
    checks.push({ label: 'Memory stick writable', ok: writable, detail: writable ? this.memstick() : 'PPSSPP silently falls back to Documents\\PPSSPP when the memory stick is read-only' });
    const cfg = insp.files.filter((f) => f.exists && f.label.endsWith('.ini'));
    checks.push({ label: 'Configuration parses', ok: cfg.every((f) => f.parseOk), detail: cfg.flatMap((f) => f.issues).join('; ') || (cfg.length ? cfg.map((f) => f.label).join(', ') + ' OK' : 'Not generated yet (PPSSPP uses defaults)') });
    checks.push({ label: 'Executable starts', ok: true, detail: isWindows ? 'Skipped: PPSSPP has no non-interactive self-test flag' : 'Skipped: only possible on Windows' });
    return { ran: false, ok: checks.every((c) => c.ok), checks };
  }

  async validateEnvironment(hw: HardwareProfile | null, _executable: string | null): Promise<Finding[]> {
    const out: Finding[] = [];
    const subject = { kind: 'emulator' as const, id: 'ppsspp', label: 'PPSSPP' };
    const failedFile = join(this.systemDir(), 'FailedGraphicsBackends.txt');
    if (existsSync(failedFile)) {
      const failed = (await readFile(failedFile, 'utf8').catch(() => '')).split(',').map((s) => s.trim()).filter(Boolean);
      if (failed.length) {
        const all = failed.includes('ALL');
        out.push({
          id: 'ppsspp.failed-backends', checkId: 'ppsspp.graphics', category: 'graphics', severity: all ? 'problem' : 'warning',
          title: all ? 'PPSSPP could not start with any graphics backend' : `PPSSPP disabled graphics backend(s): ${failed.join(', ')}`,
          detail: all ? 'PPSSPP shows a blocking error at startup. Update your graphics driver.' : 'PPSSPP crashed while starting these backends and will skip them. Updating your graphics driver usually fixes this.',
          subject, evidence: [`${failedFile}: ${failed.join(',')}`], confidence: 'high',
          repair: all ? null : { actionId: 'emulator.setRenderer', label: 'Switch PPSSPP to Direct3D 11', safety: 'low', params: { emulatorId: 'ppsspp', renderer: 'd3d11' }, description: 'Direct3D 11 is the most compatible PPSSPP backend on Windows.' },
          manualSteps: ['Update your graphics driver.', `Delete ${failedFile} to let PPSSPP retry the backend.`],
        });
      }
    }
    if (hw && hw.graphicsApis.vulkan === false) {
      const doc = existsSync(this.iniPath()) ? await loadIni(this.iniPath()) : null;
      const backend = doc?.get('Graphics', 'GraphicsBackend') ?? '';
      if (/^3\b|vulkan/i.test(backend)) {
        out.push({
          id: 'ppsspp.vulkan-missing', checkId: 'ppsspp.graphics', category: 'graphics', severity: 'warning', title: 'PPSSPP is set to Vulkan but no Vulkan driver was found',
          detail: 'PPSSPP will fail to initialise Vulkan and ask to switch backends.', subject, evidence: [`GraphicsBackend = ${backend}`], confidence: 'medium',
          repair: { actionId: 'emulator.setRenderer', label: 'Switch PPSSPP to Direct3D 11', safety: 'low', params: { emulatorId: 'ppsspp', renderer: 'd3d11' }, description: 'Uses the Direct3D 11 backend instead.' }, manualSteps: [],
        });
      }
    }
    return out;
  }

  saveLocations(): { label: string; path: string }[] {
    const psp = join(this.memstick(), 'PSP');
    return [
      { label: 'Game saves (SAVEDATA)', path: join(psp, 'SAVEDATA') },
      { label: 'Save states', path: join(psp, 'PPSSPP_STATE') },
    ];
  }

  async biosStatus(): Promise<BiosStatus[]> {
    return [];
  }

  logFile(): string | null {
    return join(this.systemDir(), 'DUMP', 'log.txt');
  }

  cacheDirs(): { label: string; path: string }[] {
    return [{ label: 'Shader cache', path: join(this.systemDir(), 'CACHE') }];
  }

  async recoverSession(): Promise<string[]> {
    return (await this.restoreJournal()) ? ['Restored ppsspp.ini after a per-game session override was interrupted.'] : [];
  }

  async detectExistingSetups(): Promise<SetupImportCandidate[]> {
    const out: SetupImportCandidate[] = [];
    const source: SetupImportCandidate['source'] = 'ppsspp';
    const addMemstick = (id: string, label: string, root: string) => {
      const sys = join(root, 'PSP', 'SYSTEM');
      if (!existsSync(join(sys, 'ppsspp.ini'))) return;
      const saves = join(root, 'PSP', 'SAVEDATA');
      out.push({
        id, source, label, path: root,
        details: [`Settings: ${join(sys, 'ppsspp.ini')}`, `Game saves: ${saves}`, `Save states: ${join(root, 'PSP', 'PPSSPP_STATE')}`],
        importable: { settings: true, saves: existsSync(saves), bios: false, romPaths: false, useInstallation: false },
        romPaths: [],
        saveCopies: [
          { from: saves, to: join(this.memstick(), 'PSP', 'SAVEDATA'), label: 'PPSSPP game saves' },
          { from: join(root, 'PSP', 'PPSSPP_STATE'), to: join(this.memstick(), 'PSP', 'PPSSPP_STATE'), label: 'PPSSPP save states' },
        ],
      });
    };
    addMemstick('ppsspp:documents', 'PPSSPP (Documents\\PPSSPP)', join(homedir(), 'Documents', 'PPSSPP'));
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    const installs = ['C:\\Program Files\\PPSSPP', 'C:\\Program Files (x86)\\PPSSPP', join(appData, 'EmuDeck', 'Emulators', 'PPSSPP')];
    for (const dir of installs) {
      const exe = await this.findExecutable(dir);
      if (!exe) continue;
      // Portable installs keep the memstick next to the exe; installed.txt redirects it.
      let mem = join(dir, 'memstick');
      if (existsSync(join(dir, 'installed.txt'))) {
        const first = (await readFile(join(dir, 'installed.txt'), 'utf8').catch(() => '')).replace(/^\uFEFF/, '').split('\n')[0].trim();
        mem = first || join(homedir(), 'Documents', 'PPSSPP');
      }
      addMemstick(`ppsspp:memstick:${dir}`, `PPSSPP memory stick (${mem})`, mem);
      out.push({ id: `ppsspp:install:${dir}`, source, label: `PPSSPP installation (${dir})`, path: dir, details: [`Executable: ${exe}`], importable: { settings: false, saves: false, bios: false, romPaths: false, useInstallation: true }, romPaths: [] });
    }
    // De-duplicate memsticks found through several routes.
    const seen = new Set<string>();
    return out.filter((c) => {
      const k = `${c.path.toLowerCase()}|${c.importable.useInstallation}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
}

function splitList(v: string): string[] {
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

/** Sets a value unless it already matches case-insensitively (PPSSPP rewrites True/False and enums itself). */
function setLoose(doc: IniDocument, section: string, key: string, value: Val): boolean {
  const cur = doc.get(section, key);
  if (cur !== undefined && cur.toLowerCase() === String(value).toLowerCase()) return false;
  if (cur !== undefined && cur.trim() !== '' && !Number.isNaN(Number(cur)) && Number(cur) === Number(value)) return false;
  if (cur !== undefined && typeof value === 'string' && /^\d+ \(/.test(value) && cur.trim() === value.split(' ')[0]) return false;
  return doc.set(section, key, value);
}
