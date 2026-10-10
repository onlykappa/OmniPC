// PCSX2 adapter (PlayStation 2).
// Layout:
//   Emulators/pcsx2/app      program files (replaced on update)
//   Emulators/pcsx2/data     passed as -datapath; PCSX2 uses data/PCSX2/{inis,logs,cache,...}
//   Saves/pcsx2/{memcards,sstates,snaps}
//   BIOS/ps2

import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BiosStatus, EmulatorSettings, Finding, GameProfile, HardwareProfile, PerformancePreset, RendererOption, SetupImportCandidate, UniversalButton } from '@shared/models';
import manifestJson from '../manifests/pcsx2.json';
import type { EmulatorManifest } from '@shared/models';
import type { AdapterCapabilities, AdapterPaths, ConfigInput, ConfigInspection, ConfigWriteResult, EmulatorAdapter, LaunchCommand, LaunchTarget, SmokeTestResult } from '../adapter';
import type { AppPaths } from '../../core/paths';
import type { BackupTarget } from '../../config/backups';
import { loadIni, saveIni } from '../../config/iniFile';
import { checkIni } from '../../config/formats';
import { physicalFor, hotkeyChords } from '../../controllers/translate';
import { findExeIn, preferredRenderer, resolutionScaleFor } from '../common';
import { runProcess } from '../../platform/exec';
import { fileVersion, isWindows } from '../../platform/powershell';
import { inspectPs2Bios } from '../../bios/validators';
import { compareVersions } from '../versions';
import { readFile } from 'node:fs/promises';

export const PCSX2_MANIFEST = manifestJson as unknown as EmulatorManifest;

/** pcsx2/VMManager.cpp SETTINGS_VERSION; checked against [UI] SettingsVersion at startup. */
export const PCSX2_SETTINGS_VERSION = 1;

/** GSRendererType enum values (pcsx2/Config.h). */
export const PCSX2_RENDERERS = { auto: -1, d3d11: 3, d3d12: 15, vulkan: 14, opengl: 12, software: 13 } as const;

const SDL_TOKENS: Record<UniversalButton, string> = {
  A: 'FaceSouth', B: 'FaceEast', X: 'FaceWest', Y: 'FaceNorth',
  LB: 'LeftShoulder', RB: 'RightShoulder', LT: '+LeftTrigger', RT: '+RightTrigger',
  L3: 'LeftStick', R3: 'RightStick', Start: 'Start', Select: 'Back', Guide: 'Guide',
  DPadUp: 'DPadUp', DPadDown: 'DPadDown', DPadLeft: 'DPadLeft', DPadRight: 'DPadRight',
  LeftStickUp: '-LeftY', LeftStickDown: '+LeftY', LeftStickLeft: '-LeftX', LeftStickRight: '+LeftX',
  RightStickUp: '-RightY', RightStickDown: '+RightY', RightStickLeft: '-RightX', RightStickRight: '+RightX',
};

/** DualShock 2 binding name -> logical universal button. */
const PS2_PAD: [string, UniversalButton][] = [
  ['Cross', 'A'], ['Circle', 'B'], ['Square', 'X'], ['Triangle', 'Y'],
  ['L1', 'LB'], ['R1', 'RB'], ['L2', 'LT'], ['R2', 'RT'], ['L3', 'L3'], ['R3', 'R3'],
  ['Select', 'Select'], ['Start', 'Start'],
  ['Up', 'DPadUp'], ['Down', 'DPadDown'], ['Left', 'DPadLeft'], ['Right', 'DPadRight'],
  ['LUp', 'LeftStickUp'], ['LDown', 'LeftStickDown'], ['LLeft', 'LeftStickLeft'], ['LRight', 'LeftStickRight'],
  ['RUp', 'RightStickUp'], ['RDown', 'RightStickDown'], ['RLeft', 'RightStickLeft'], ['RRight', 'RightStickRight'],
];

const HOTKEY_NAMES = {
  exit: 'ShutdownVM',
  saveState: 'SaveStateToSlot',
  loadState: 'LoadStateFromSlot',
  volumeUp: 'IncreaseVolume',
  volumeDown: 'DecreaseVolume',
  menu: 'OpenPauseMenu',
  fastForward: 'ToggleTurbo',
  fullscreen: 'ToggleFullscreen',
} as const;

const ASPECTS: Record<string, string> = { auto: 'Auto 4:3/3:2', '4:3': '4:3', '16:9': '16:9', stretch: 'Stretch' };

export class Pcsx2Adapter implements EmulatorAdapter {
  readonly manifest = PCSX2_MANIFEST;
  readonly capabilities: AdapterCapabilities = {
    perGameProfiles: 'native',
    frameLimit: false,
    vsync: true,
    aspectRatios: [
      { id: 'auto', label: 'Auto (4:3 / 3:2)' },
      { id: '4:3', label: '4:3' },
      { id: '16:9', label: '16:9' },
      { id: 'stretch', label: 'Stretch to window' },
    ],
    hotkeys: ['exit', 'saveState', 'loadState', 'volumeUp', 'volumeDown', 'menu', 'fastForward', 'fullscreen'],
    smokeTest: true,
    maxResolutionScale: 8,
  };

  constructor(private readonly app: AppPaths) {}

  paths(): AdapterPaths {
    return {
      app: this.app.emulatorAppDir('pcsx2'),
      data: this.app.emulatorDataDir('pcsx2'),
      saves: this.app.emulatorSaveDir('pcsx2'),
      bios: this.app.systemBiosDir('ps2'),
      cache: this.app.emulatorCacheDir('pcsx2'),
    };
  }

  /** PCSX2's DataRoot when launched with -datapath <data>. */
  dataRoot(): string {
    return join(this.paths().data, 'PCSX2');
  }

  iniPath(): string {
    return join(this.dataRoot(), 'inis', 'PCSX2.ini');
  }

  async findExecutable(appDir: string): Promise<string | null> {
    return findExeIn(appDir, [/^pcsx2-qt\.exe$/i, /^pcsx2-qtx64.*\.exe$/i, /^pcsx2.*\.exe$/i, /^pcsx2-qt$/]);
  }

  async detectVersion(executable: string): Promise<string | null> {
    const v = await fileVersion(executable);
    return v ? v.replace(/^v/, '') : null;
  }

  renderers(hw: HardwareProfile | null): RendererOption[] {
    const vk = hw?.graphicsApis.vulkan;
    const dx12 = hw?.graphicsApis.directx12;
    return [
      { id: 'auto', label: 'Automatic (PCSX2 decides)', available: true },
      { id: 'd3d11', label: 'Direct3D 11', available: hw ? hw.isWindows : true },
      { id: 'd3d12', label: 'Direct3D 12', available: dx12 !== false, note: dx12 === false ? 'd3d12.dll not found' : undefined },
      { id: 'vulkan', label: 'Vulkan', available: vk !== false, note: vk === false ? 'No Vulkan driver detected' : undefined },
      { id: 'opengl', label: 'OpenGL', available: true },
      { id: 'software', label: 'Software (slow, most compatible)', available: true },
    ];
  }

  defaultSettings(hw: HardwareProfile | null, preset: PerformancePreset): EmulatorSettings {
    return {
      preset,
      resolutionScale: resolutionScaleFor(hw, preset, this.capabilities.maxResolutionScale),
      renderer: preferredRenderer(hw, { d3d12: 'd3d12', d3d11: 'd3d11', vulkan: 'vulkan', opengl: 'opengl' }),
      aspectRatio: 'auto',
      fullscreen: true,
      frameLimit: true,
      vsync: preset !== 'performance',
      advanced: {},
    };
  }

  configTargets(): BackupTarget[] {
    return [{ root: this.paths().data, path: this.iniPath() }];
  }

  private async ensureDirs(): Promise<void> {
    const p = this.paths();
    for (const d of [p.app, p.data, this.dataRoot(), join(this.dataRoot(), 'inis'), join(this.dataRoot(), 'logs'), join(p.saves, 'memcards'), join(p.saves, 'sstates'), join(p.saves, 'snaps'), p.bios, p.cache]) {
      await mkdir(d, { recursive: true });
    }
  }

  /** Values OmniPC manages in PCSX2.ini. Everything else is left as the user set it. */
  managedPathValues(): [string, string, string][] {
    const p = this.paths();
    return [
      ['Folders', 'Bios', p.bios],
      ['Folders', 'MemoryCards', join(p.saves, 'memcards')],
      ['Folders', 'Savestates', join(p.saves, 'sstates')],
      ['Folders', 'Snapshots', join(p.saves, 'snaps')],
      ['Folders', 'Cache', p.cache],
    ];
  }

  graphicsValues(s: EmulatorSettings): [string, string, string | number | boolean][] {
    const renderer = PCSX2_RENDERERS[s.renderer as keyof typeof PCSX2_RENDERERS] ?? PCSX2_RENDERERS.auto;
    return [
      ['EmuCore/GS', 'Renderer', renderer],
      ['EmuCore/GS', 'upscale_multiplier', s.resolutionScale],
      ['EmuCore/GS', 'AspectRatio', ASPECTS[s.aspectRatio] ?? ASPECTS.auto],
      ['EmuCore/GS', 'VsyncEnable', s.vsync],
      ['UI', 'StartFullscreen', s.fullscreen],
    ];
  }

  async applyConfig(input: ConfigInput, scope: 'all' | 'controller' | 'graphics' | 'paths'): Promise<ConfigWriteResult> {
    await this.ensureDirs();
    const doc = await loadIni(this.iniPath());
    const changed: string[] = [];
    const set = (s: string, k: string, v: string | number | boolean) => {
      if (doc.set(s, k, v)) changed.push(`${s}.${k} = ${v}`);
    };
    if (scope === 'all' || scope === 'paths') {
      for (const [s, k, v] of this.managedPathValues()) set(s, k, v);
      // First-run and update prompts would interrupt controller-only use.
      // Without a matching UI.SettingsVersion PCSX2 shows a modal "Settings failed
      // to load" prompt on startup (QtHost.cpp InitializeConfig), which hangs
      // -testconfig and batch launches.
      set('UI', 'SettingsVersion', PCSX2_SETTINGS_VERSION);
      set('UI', 'SetupWizardIncomplete', false);
      set('UI', 'ConfirmShutdown', false);
      set('UI', 'HideMouseCursor', true);
      set('AutoUpdater', 'CheckAtStartup', false);
      set('Logging', 'EnableFileLogging', true);
      set('EmuCore', 'EnableFastBoot', true);
    }
    if (scope === 'all' || scope === 'graphics') {
      for (const [s, k, v] of this.graphicsValues(input.settings)) set(s, k, v);
      for (const [key, value] of Object.entries(input.settings.advanced)) {
        const [section, name] = key.split('|');
        if (section && name) set(section, name, value);
      }
    }
    if (scope === 'all' || scope === 'controller') {
      const dev = `SDL-${input.controller.deviceIndex}`;
      set('InputSources', 'SDL', true);
      set('InputSources', 'XInput', false);
      set('Pad1', 'Type', 'DualShock2');
      for (const [ps2, logical] of PS2_PAD) set('Pad1', ps2, `${dev}/${SDL_TOKENS[physicalFor(input.controller, 'ps2', logical)]}`);
      if (input.controller.rumble) {
        set('Pad1', 'LargeMotor', `${dev}/LargeMotor`);
        set('Pad1', 'SmallMotor', `${dev}/SmallMotor`);
      } else {
        doc.delete('Pad1', 'LargeMotor');
        doc.delete('Pad1', 'SmallMotor');
      }
      set('Pad1', 'Deadzone', input.controller.deadzone.toFixed(2));
      for (const c of hotkeyChords(input.hotkeys, this.capabilities.hotkeys)) {
        const name = HOTKEY_NAMES[c.action as keyof typeof HOTKEY_NAMES];
        if (!name) continue;
        set('Hotkeys', name, c.buttons.map((b) => `${dev}/${SDL_TOKENS[b]}`).join(' & '));
      }
    }
    if (changed.length || !existsSync(this.iniPath())) await saveIni(this.iniPath(), doc);
    return { changed, notes: [] };
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
        if (!actual || actual.toLowerCase() !== v.toLowerCase()) drift.push({ file: ini, key: `${s}.${k}`, expected: v, actual, critical: k === 'Bios' || k === 'MemoryCards' });
      }
      const sv = doc.get('UI', 'SettingsVersion') ?? null;
      if (sv !== String(PCSX2_SETTINGS_VERSION)) drift.push({ file: ini, key: 'UI.SettingsVersion', expected: String(PCSX2_SETTINGS_VERSION), actual: sv, critical: true });
      if (doc.get('UI', 'SetupWizardIncomplete') === 'true') drift.push({ file: ini, key: 'UI.SetupWizardIncomplete', expected: 'false', actual: 'true', critical: false });
    }
    return { files: [{ label: 'PCSX2.ini', path: ini, exists, parseOk: exists && fmt.ok, issues: fmt.issues }], drift };
  }

  /** -gamecfg exists from v2.9 (nightly); stable 2.8.x needs session overrides. */
  supportsGameCfg(version: string | null): boolean {
    return !!version && compareVersions(version, '2.9.0') >= 0;
  }

  async buildLaunch(target: LaunchTarget, executable: string, settings: EmulatorSettings, profile: GameProfile | null, version: string | null): Promise<LaunchCommand> {
    const p = this.paths();
    const args = ['-datapath', p.data, '-nogui'];
    if (settings.fullscreen) args.push('-fullscreen');
    const notes: string[] = [];
    let prepare: LaunchCommand['prepare'];
    let cleanup: LaunchCommand['cleanup'];
    const overrides = profile ? this.profileOverrides(settings, profile) : [];
    if (overrides.length) {
      if (this.supportsGameCfg(version)) {
        const cfgDir = join(this.dataRoot(), 'omnideck-gamecfg');
        const cfgPath = join(cfgDir, `${target.gameId ?? 'adhoc'}.ini`);
        prepare = async () => {
          await mkdir(cfgDir, { recursive: true });
          const doc = await loadIni(cfgPath);
          for (const [s, k, v] of overrides) doc.set(s, k, v);
          await saveIni(cfgPath, doc);
        };
        args.push('-gamecfg', cfgPath);
        notes.push(`Per-game profile applied with -gamecfg (${overrides.length} overrides).`);
      } else {
        const ini = this.iniPath();
        const journal = `${ini}.omnideck-session`;
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
        notes.push(`Per-game profile applied for this session only (PCSX2 ${version ?? '?'} has no -gamecfg); global settings are restored when the game exits.`);
      }
    }
    if (profile?.customArgs) args.push(...splitArgs(profile.customArgs));
    args.push('--', target.path);
    return { command: executable, args, cwd: p.app, logFile: join(this.dataRoot(), 'logs', 'emulog.txt'), prepare, cleanup, notes };
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
    for (const [key, value] of Object.entries(o.advanced ?? {})) {
      const [section, name] = key.split('|');
      if (section && name) out.push([section, name, value]);
    }
    return out;
  }

  buildUiLaunch(executable: string): LaunchCommand {
    return { command: executable, args: ['-datapath', this.paths().data], cwd: this.paths().app, logFile: join(this.dataRoot(), 'logs', 'emulog.txt'), notes: [] };
  }

  async smokeTest(executable: string): Promise<SmokeTestResult> {
    const checks: SmokeTestResult['checks'] = [];
    checks.push({ label: 'Executable present', ok: existsSync(executable), detail: executable });
    if (!existsSync(executable)) return { ran: true, ok: false, checks };
    const resources = join(this.paths().app, 'resources');
    checks.push({ label: 'Resources folder present', ok: existsSync(resources), detail: existsSync(resources) ? resources : 'PCSX2 refuses to start without its resources folder' });
    const ini = await this.inspectConfig();
    checks.push({ label: 'Configuration parses', ok: ini.files.every((f) => f.parseOk), detail: ini.files.flatMap((f) => f.issues).join('; ') || 'PCSX2.ini OK' });
    if (!isWindows) {
      checks.push({ label: 'Executable starts (-testconfig)', ok: true, detail: 'Skipped: only possible on Windows' });
      return { ran: false, ok: checks.every((c) => c.ok), checks };
    }
    const r = await runProcess(executable, ['-datapath', this.paths().data, '-testconfig'], { timeoutMs: 30000, cwd: this.paths().app });
    const ok = !r.error && !r.timedOut && r.code === 0;
    checks.push({
      label: 'Executable starts (-testconfig)',
      ok,
      detail: r.error ? r.error.message : r.timedOut ? 'Timed out after 30s' : `Exit code ${r.code}${r.stderr ? `: ${r.stderr.trim().slice(-300)}` : ''}`,
    });
    return { ran: true, ok: checks.every((c) => c.ok), checks };
  }

  async validateEnvironment(hw: HardwareProfile | null, executable: string | null): Promise<Finding[]> {
    const out: Finding[] = [];
    if (hw && executable && /avx2/i.test(executable) && !hw.cpu.features.includes('avx2')) {
      out.push({
        id: 'pcsx2.avx2', checkId: 'pcsx2.cpu', category: 'emulators', severity: 'problem', title: 'PCSX2 AVX2 build on a CPU without AVX2',
        detail: 'This PCSX2 build requires AVX2, which your CPU does not support. It will crash immediately.', subject: { kind: 'emulator', id: 'pcsx2', label: 'PCSX2' },
        evidence: [`CPU features: ${hw.cpu.features.join(', ')}`], confidence: 'high',
        repair: { actionId: 'emulator.reinstall', label: 'Reinstall PCSX2 (compatible build)', safety: 'high', params: { emulatorId: 'pcsx2' }, description: 'Downloads the build that matches your CPU.' }, manualSteps: [],
      });
    }
    return out;
  }

  saveLocations(): { label: string; path: string }[] {
    const p = this.paths();
    return [
      { label: 'Memory cards', path: join(p.saves, 'memcards') },
      { label: 'Save states', path: join(p.saves, 'sstates') },
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
        if (st.size < 256 * 1024) continue; // nvram/mec companion files
        const info = await inspectPs2Bios(full);
        files.push({ path: full, sizeBytes: st.size, valid: info.valid, description: info.description });
      }
    }
    const anyValid = files.some((f) => f.valid);
    return [{
      systemId: 'ps2', systemName: 'PlayStation 2', label: 'PlayStation 2 BIOS', required: true, requirementKind: 'bios', emulatorId: 'pcsx2', expectedLocation: dir,
      status: anyValid ? 'found' : files.length ? 'invalid' : 'missing', files,
      note: anyValid ? 'PCSX2 will use the first valid BIOS it finds in this folder.' : 'Place a BIOS dumped from your own PS2 in this folder. OmniPC never downloads BIOS files.',
    }];
  }

  logFile(): string | null {
    return join(this.dataRoot(), 'logs', 'emulog.txt');
  }

  cacheDirs(): { label: string; path: string }[] {
    return [{ label: 'Shader cache', path: this.paths().cache }];
  }

  async recoverSession(): Promise<string[]> {
    const ini = this.iniPath();
    const journal = `${ini}.omnideck-session`;
    if (!existsSync(journal)) return [];
    await copyFile(journal, ini);
    await rm(journal, { force: true });
    return ['Restored PCSX2.ini after a per-game session override was interrupted.'];
  }

  async detectExistingSetups(): Promise<SetupImportCandidate[]> {
    const out: SetupImportCandidate[] = [];
    const docs = join(homedir(), 'Documents', 'PCSX2');
    if (existsSync(join(docs, 'inis', 'PCSX2.ini'))) {
      const doc = await loadIni(join(docs, 'inis', 'PCSX2.ini'));
      const resolve = (v: string | undefined, def: string) => (v ? (/^[a-zA-Z]:|^\//.test(v) ? v : join(docs, v)) : join(docs, def));
      const bios = resolve(doc.get('Folders', 'Bios'), 'bios');
      const mem = resolve(doc.get('Folders', 'MemoryCards'), 'memcards');
      const romPaths = Object.entries(doc.entries('GameList')).filter(([k]) => /Paths/i.test(k)).map(([, v]) => v).filter((v) => existsSync(v));
      out.push({
        id: 'pcsx2:documents', source: 'pcsx2', label: 'PCSX2 (Documents\\PCSX2)', path: docs,
        details: [`Settings: ${join(docs, 'inis', 'PCSX2.ini')}`, `BIOS folder: ${bios}`, `Memory cards: ${mem}`],
        importable: { settings: true, saves: existsSync(mem), bios: existsSync(bios), romPaths: romPaths.length > 0, useInstallation: false },
        romPaths,
      });
    }
    for (const dir of ['C:\\Program Files\\PCSX2', 'C:\\Program Files (x86)\\PCSX2']) {
      const exe = await this.findExecutable(dir);
      if (exe) out.push({ id: `pcsx2:install:${dir}`, source: 'pcsx2', label: `PCSX2 installation (${dir})`, path: dir, details: [`Executable: ${exe}`], importable: { settings: false, saves: false, bios: false, romPaths: false, useInstallation: true }, romPaths: [] });
    }
    return out;
  }

  /** Writes portable.txt-free layout marker so users can tell the folder is OmniPC managed. */
  async writeReadme(): Promise<void> {
    await mkdir(this.paths().data, { recursive: true });
    await writeFile(join(this.paths().data, 'README-OmniPC.txt'), 'This folder is PCSX2\'s data directory managed by OmniPC (-datapath). Settings: PCSX2\\inis\\PCSX2.ini. Saves live in the OmniPC Saves folder.\r\n');
  }
}

/** Splits a user-provided argument string respecting double quotes. Never passed to a shell. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2]);
  return out;
}
