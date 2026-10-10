// RetroArch adapter (NES, SNES, N64, Game Boy/Color/Advance, Mega Drive/Genesis, arcade).
// RetroArch is a frontend; the emulation itself happens in libretro cores
// (one DLL per emulator) that OmniPC downloads from the official libretro
// buildbot into the DATA folder, so a RetroArch update never drops them.
// Layout:
//   Emulators/retroarch/app                 RetroArch-Win64 program files (assets, shaders, autoconfig...)
//   Emulators/retroarch/data/retroarch.cfg  main config, passed with --config
//   Emulators/retroarch/data/cores          libretro cores (libretro_directory)
//   Emulators/retroarch/data/config         per-core/game overrides, core options, remaps (rgui_config_directory)
//   Emulators/retroarch/data/omnideck       OmniPC-generated per-system input files (--appendconfig)
//   Emulators/retroarch/data/logs           retroarch.log
//   Saves/retroarch/{saves,states,screenshots}
//   BIOS/retroarch                          system_directory (shared by every core: BIOS + core system files)
//   Cache/retroarch                         cache_directory (extracted archives)

import { existsSync } from 'node:fs';
import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, normalize, resolve } from 'node:path';
import type { BiosStatus, EmulatorManifest, EmulatorSettings, Finding, GameProfile, HardwareProfile, PerformancePreset, RendererOption, SetupImportCandidate, UniversalButton, UniversalControllerProfile } from '@shared/models';
import type { SystemId } from '@shared/systems';
import manifestJson from '../manifests/retroarch.json';
import type { AdapterCapabilities, AdapterPaths, ComponentInstaller, ConfigInput, ConfigInspection, ConfigWriteResult, EmulatorAdapter, LaunchCommand, LaunchTarget, SmokeTestResult } from '../adapter';
import type { AppPaths } from '../../core/paths';
import type { BackupTarget } from '../../config/backups';
import { atomicWrite } from '../../config/iniFile';
import { hotkeyChords, physicalFor } from '../../controllers/translate';
import { findExeIn, preferredRenderer } from '../common';
import { runProcess } from '../../platform/exec';
import { fileVersion, isWindows } from '../../platform/powershell';
import { OmniFailure } from '../../core/errors';
import { splitArgs } from '../pcsx2/adapter';
import { CfgDocument, checkCfg } from './cfg';

export const RETROARCH_MANIFEST = manifestJson as unknown as EmulatorManifest;

/** Official nightly core builds (the buildbot's "latest" folder is what RetroArch's own Core Downloader uses). */
export const CORE_BASE_URL = 'https://buildbot.libretro.com/nightly/windows/x86_64/latest/';

/** Default core per system (buildbot core names, `<name>_libretro.dll`). */
export const DEFAULT_CORES: Partial<Record<SystemId, string>> = {
  nes: 'mesen',
  snes: 'snes9x',
  n64: 'mupen64plus_next',
  gb: 'gambatte',
  gbc: 'gambatte',
  gba: 'mgba',
  genesis: 'genesis_plus_gx',
  arcade: 'fbneo',
};

/** Extensions the default core cannot run, routed to another core. */
const EXTENSION_CORES: Partial<Record<SystemId, Record<string, string>>> = {
  // Genesis Plus GX has no 32X support; PicoDrive does.
  genesis: { '.32x': 'picodrive' },
};

/** Cores OmniPC knows are valid alternatives (settings.advanced "core|<system>"). */
export const KNOWN_CORES: Partial<Record<SystemId, string[]>> = {
  nes: ['mesen', 'fceumm', 'nestopia', 'quicknes'],
  snes: ['snes9x', 'bsnes', 'bsnes_hd_beta', 'snes9x2010', 'mesen-s'],
  n64: ['mupen64plus_next', 'parallel_n64'],
  gb: ['gambatte', 'sameboy', 'gearboy', 'mgba', 'tgbdual'],
  gbc: ['gambatte', 'sameboy', 'gearboy', 'mgba', 'tgbdual'],
  gba: ['mgba', 'vbam', 'vba_next', 'gpsp'],
  genesis: ['genesis_plus_gx', 'picodrive', 'blastem', 'genesis_plus_gx_wide'],
  arcade: ['fbneo', 'mame2003_plus', 'mame2010', 'mame'],
};

/** video_driver idents on Windows (gfx/video_driver.c video_drivers[]). */
export const RETROARCH_RENDERERS: Record<string, string> = { d3d11: 'd3d11', d3d12: 'd3d12', vulkan: 'vulkan', glcore: 'glcore', gl: 'gl' };

/** aspect_ratio_index values (gfx/video_defines.h enum aspect_ratio). */
const ASPECT_INDEX: Record<string, number> = { '4:3': 0, '16:9': 1, core: 22, full: 24 };

/**
 * XInput tokens (input/drivers_joypad/xinput_joypad.c): buttons are indices into
 * button_index_to_bitmap_code (A,B,X,Y,LB,RB,Start,Back,L3,R3,Guide), the d-pad is
 * hat 0, axes are 0=LX 1=LY 2=RX 3=RY 4=LT 5=RT with XInput's Y axis positive = up.
 */
type Tok = { btn: string } | { axis: string };
export const XINPUT_TOKENS: Record<UniversalButton, Tok> = {
  A: { btn: '0' }, B: { btn: '1' }, X: { btn: '2' }, Y: { btn: '3' },
  LB: { btn: '4' }, RB: { btn: '5' }, Start: { btn: '6' }, Select: { btn: '7' },
  L3: { btn: '8' }, R3: { btn: '9' }, Guide: { btn: '10' },
  DPadUp: { btn: 'h0up' }, DPadDown: { btn: 'h0down' }, DPadLeft: { btn: 'h0left' }, DPadRight: { btn: 'h0right' },
  LT: { axis: '+4' }, RT: { axis: '+5' },
  LeftStickUp: { axis: '+1' }, LeftStickDown: { axis: '-1' }, LeftStickLeft: { axis: '-0' }, LeftStickRight: { axis: '+0' },
  RightStickUp: { axis: '+3' }, RightStickDown: { axis: '-3' }, RightStickLeft: { axis: '-2' }, RightStickRight: { axis: '+2' },
};

/**
 * RetroPad bind base names (configuration.c input_config_bind_map) -> logical
 * universal button. RetroPad uses SNES positions: B = bottom, A = right, Y = left, X = top.
 */
const RETROPAD: [string, UniversalButton][] = [
  ['b', 'A'], ['a', 'B'], ['y', 'X'], ['x', 'Y'],
  ['l', 'LB'], ['r', 'RB'], ['l2', 'LT'], ['r2', 'RT'], ['l3', 'L3'], ['r3', 'R3'],
  ['select', 'Select'], ['start', 'Start'],
  ['up', 'DPadUp'], ['down', 'DPadDown'], ['left', 'DPadLeft'], ['right', 'DPadRight'],
  ['l_x_plus', 'LeftStickRight'], ['l_x_minus', 'LeftStickLeft'], ['l_y_plus', 'LeftStickDown'], ['l_y_minus', 'LeftStickUp'],
  ['r_x_plus', 'RightStickRight'], ['r_x_minus', 'RightStickLeft'], ['r_y_plus', 'RightStickDown'], ['r_y_minus', 'RightStickUp'],
];

/** Meta bind names (configuration.c DECLARE_META_BIND; config prefix "input_"). */
const HOTKEY_BINDS = {
  exit: 'exit_emulator',
  saveState: 'save_state',
  loadState: 'load_state',
  volumeUp: 'volume_up',
  volumeDown: 'volume_down',
  menu: 'menu_toggle',
  fastForward: 'toggle_fast_forward',
  screenshot: 'screenshot',
  fullscreen: 'toggle_fullscreen',
} as const;

/** Optional BIOS/firmware files cores look for in system_directory. */
export const RETROARCH_BIOS: { systemId: SystemId; systemName: string; label: string; file: string; size: number; note: string }[] = [
  { systemId: 'gba', systemName: 'Game Boy Advance', label: 'Game Boy Advance BIOS (optional)', file: 'gba_bios.bin', size: 16384, note: 'mGBA boots games without it (built-in HLE BIOS); a real BIOS improves accuracy and shows the boot logo.' },
  { systemId: 'nes', systemName: 'NES / Famicom', label: 'Famicom Disk System BIOS (only for .fds games)', file: 'disksys.rom', size: 8192, note: 'Needed only for Famicom Disk System (.fds) games; cartridge games never need it.' },
];

/** Command-line options passed through from per-game custom arguments (retroarch.c retroarch_parse_input_and_config). */
const KNOWN_FLAGS = new Set(['-v', '--verbose']);
const KNOWN_PARAM_FLAGS = new Set(['--set-shader', '-M', '--sram-mode', '-e', '--entryslot', '--subsystem']);

export class RetroArchAdapter implements EmulatorAdapter {
  readonly manifest = RETROARCH_MANIFEST;
  readonly capabilities: AdapterCapabilities = {
    perGameProfiles: 'session',
    frameLimit: false,
    vsync: true,
    aspectRatios: [
      { id: 'core', label: 'Core provided (game native)' },
      { id: '4:3', label: '4:3' },
      { id: '16:9', label: '16:9' },
      { id: 'full', label: 'Full (stretch)' },
    ],
    hotkeys: ['exit', 'saveState', 'loadState', 'volumeUp', 'volumeDown', 'menu', 'fastForward', 'screenshot', 'fullscreen'],
    smokeTest: true,
    // Internal resolution is a per-core option (e.g. Mupen64Plus-Next), not a RetroArch setting.
    maxResolutionScale: 1,
  };

  constructor(private readonly app: AppPaths) {}

  paths(): AdapterPaths {
    return {
      app: this.app.emulatorAppDir('retroarch'),
      data: this.app.emulatorDataDir('retroarch'),
      saves: this.app.emulatorSaveDir('retroarch'),
      bios: this.app.systemBiosDir('retroarch'),
      cache: this.app.emulatorCacheDir('retroarch'),
    };
  }

  cfgPath(): string {
    return join(this.paths().data, 'retroarch.cfg');
  }

  coresDir(): string {
    return join(this.paths().data, 'cores');
  }

  private generatedDir(): string {
    return join(this.paths().data, 'omnideck');
  }

  systemInputPath(system: SystemId): string {
    return join(this.generatedDir(), `input-${system}.cfg`);
  }

  private sessionPath(): string {
    return join(this.generatedDir(), 'session.cfg');
  }

  async findExecutable(appDir: string): Promise<string | null> {
    return findExeIn(appDir, [/^retroarch\.exe$/i, /^retroarch$/]);
  }

  async detectVersion(executable: string): Promise<string | null> {
    // retroarch.exe has no VERSIONINFO resource (media/rarch.rc), so fall back to --version.
    const v = await fileVersion(executable);
    if (v) return v.replace(/^v/, '');
    if (!isWindows || !existsSync(executable)) return null;
    const r = await runProcess(executable, ['--version'], { timeoutMs: 15000, cwd: this.paths().app });
    return /Version:\s*(\d+\.\d+(?:\.\d+)*)/.exec(`${r.stdout}${r.stderr}`)?.[1] ?? null;
  }

  renderers(hw: HardwareProfile | null): RendererOption[] {
    const vk = hw?.graphicsApis.vulkan;
    const dx12 = hw?.graphicsApis.directx12;
    return [
      { id: 'd3d11', label: 'Direct3D 11', available: hw ? hw.isWindows : true },
      { id: 'd3d12', label: 'Direct3D 12', available: dx12 !== false, note: dx12 === false ? 'd3d12.dll not found' : undefined },
      { id: 'vulkan', label: 'Vulkan', available: vk !== false, note: vk === false ? 'No Vulkan driver detected' : undefined },
      { id: 'glcore', label: 'OpenGL Core (3.2+)', available: true },
      { id: 'gl', label: 'OpenGL (legacy, widest core compatibility)', available: true },
    ];
  }

  defaultSettings(hw: HardwareProfile | null, preset: PerformancePreset): EmulatorSettings {
    return {
      preset,
      resolutionScale: 1,
      renderer: preferredRenderer(hw, { d3d12: 'd3d12', d3d11: 'd3d11', vulkan: 'vulkan', opengl: 'glcore' }),
      aspectRatio: 'core',
      fullscreen: true,
      frameLimit: true,
      vsync: preset !== 'performance',
      advanced: {},
    };
  }

  configTargets(): BackupTarget[] {
    return [{ root: this.paths().data, path: this.cfgPath() }];
  }

  /** Folder keys OmniPC manages, with whether drift is critical. */
  managedPathValues(): [key: string, value: string, critical: boolean][] {
    const p = this.paths();
    return [
      ['savefile_directory', join(p.saves, 'saves'), true],
      ['savestate_directory', join(p.saves, 'states'), true],
      ['system_directory', p.bios, true],
      ['libretro_directory', this.coresDir(), true],
      ['screenshot_directory', join(p.saves, 'screenshots'), false],
      ['rgui_config_directory', join(p.data, 'config'), false],
      ['input_remapping_directory', join(p.data, 'config', 'remaps'), false],
      ['playlist_directory', join(p.data, 'playlists'), false],
      ['thumbnails_directory', join(p.data, 'thumbnails'), false],
      ['cache_directory', p.cache, false],
      ['log_dir', join(p.data, 'logs'), false],
    ];
  }

  /** Behaviour keys (prompts, logging, save locations) OmniPC pins. */
  behaviourValues(): [string, string | number | boolean][] {
    return [
      // Saves must follow savefile_directory/savestate_directory, never the ROM folder.
      ['savefiles_in_content_dir', false],
      ['savestates_in_content_dir', false],
      ['systemfiles_in_content_dir', false],
      // OmniPC owns retroarch.cfg; per-system input files are --appendconfig'd and
      // must not be baked into it on exit. Users can still "Save Current Configuration".
      ['config_save_on_exit', false],
      // The exit hotkey must quit on the first press: v1.22 "quit_press_twice",
      // newer builds migrate it to "confirm_quit" (configuration.c).
      ['quit_press_twice', false],
      ['confirm_quit', false],
      // "Close Content" in the menu also exits when launched from the command line.
      ['quit_on_close_content', 2],
      // Do not freeze when OmniPC or an overlay briefly holds focus.
      ['pause_nonactive', false],
      ['rgui_show_start_screen', false],
      ['log_verbosity', true],
      ['log_to_file', true],
      ['log_to_file_timestamp', false],
      ['input_joypad_driver', 'xinput'],
      ['input_autodetect_enable', true],
    ];
  }

  graphicsValues(s: EmulatorSettings): [string, string | number | boolean][] {
    return [
      ['video_driver', RETROARCH_RENDERERS[s.renderer] ?? 'd3d11'],
      ['video_fullscreen', s.fullscreen],
      ['video_vsync', s.vsync],
      ['aspect_ratio_index', ASPECT_INDEX[s.aspectRatio] ?? ASPECT_INDEX.core],
    ];
  }

  private async loadCfg(path = this.cfgPath()): Promise<CfgDocument> {
    if (!existsSync(path)) return CfgDocument.empty();
    return CfgDocument.parse(await readFile(path, 'utf8'));
  }

  private async ensureDirs(): Promise<void> {
    const p = this.paths();
    for (const d of [p.data, p.bios, p.cache, this.coresDir(), this.generatedDir(), ...this.managedPathValues().map(([, v]) => v)]) await mkdir(d, { recursive: true });
  }

  /** RetroPad bindings for player 1 as written to the config. */
  padBinds(c: UniversalControllerProfile, system: SystemId | null): [string, string][] {
    const out: [string, string][] = [];
    for (const [base, logical] of RETROPAD) {
      const phys = system ? physicalFor(c, system, logical) : (c.mapping[logical] ?? logical);
      const t = XINPUT_TOKENS[phys];
      if ('btn' in t) out.push([`input_player1_${base}_btn`, t.btn], [`input_player1_${base}_axis`, 'nul']);
      else out.push([`input_player1_${base}_axis`, t.axis], [`input_player1_${base}_btn`, 'nul']);
    }
    return out;
  }

  private bindFor(name: string, b: UniversalButton): [string, string][] {
    const t = XINPUT_TOKENS[b];
    return 'btn' in t ? [[`input_${name}_btn`, t.btn], [`input_${name}_axis`, 'nul']] : [[`input_${name}_axis`, t.axis], [`input_${name}_btn`, 'nul']];
  }

  async applyConfig(input: ConfigInput, scope: 'all' | 'controller' | 'graphics' | 'paths'): Promise<ConfigWriteResult> {
    await this.ensureDirs();
    const notes: string[] = [];
    const cfg = this.cfgPath();
    const doc = await this.loadCfg();
    const changed: string[] = [];
    const set = (k: string, v: string | number | boolean) => {
      if (doc.set(k, v)) changed.push(`${k} = ${v}`);
    };
    if (scope === 'all' || scope === 'paths') {
      for (const [k, v] of this.managedPathValues()) set(k, v);
      for (const [k, v] of this.behaviourValues()) set(k, v);
      const synced = await this.syncBios(null);
      if (synced.length) notes.push(`Copied ${synced.join(', ')} into the RetroArch system folder.`);
    }
    if (scope === 'all' || scope === 'graphics') {
      for (const [k, v] of this.graphicsValues(input.settings)) set(k, v);
      for (const [key, value] of Object.entries(input.settings.advanced)) {
        const [kind, name] = key.split('|');
        if (kind === 'cfg' && name && /^[\w]+$/.test(name)) set(name, value);
      }
    }
    if (scope === 'all' || scope === 'controller') {
      const c = input.controller;
      set('input_player1_joypad_index', c.deviceIndex);
      // Global bindings use the plain mapping; per-system variants (Nintendo layout,
      // per-system overrides) are appended at launch from input-<system>.cfg.
      for (const [k, v] of this.padBinds(c, null)) set(k, v);
      set('input_analog_deadzone', c.deadzone.toFixed(2));
      set('input_rumble_gain', c.rumble ? 100 : 0);
      const chords = hotkeyChords(input.hotkeys, this.capabilities.hotkeys);
      set('input_hotkey_block_delay', 5);
      if (chords.length) for (const [k, v] of this.bindFor('enable_hotkey', input.hotkeys.modifier)) set(k, v);
      for (const h of chords) {
        const name = HOTKEY_BINDS[h.action as keyof typeof HOTKEY_BINDS];
        if (name) for (const [k, v] of this.bindFor(name, h.buttons[1])) set(k, v);
      }
      for (const system of this.manifest.systems) {
        const file = this.systemInputPath(system);
        const text = `# Generated by OmniPC for ${system}; appended with --appendconfig at launch. Edits are overwritten.\n${this.padBinds(c, system).map(([k, v]) => `${k} = "${v}"`).join('\n')}\n`;
        const old = existsSync(file) ? await readFile(file, 'utf8').catch(() => '') : '';
        if (old !== text) {
          await atomicWrite(file, text);
          changed.push(`input-${system}.cfg`);
        }
      }
    }
    if (changed.length || !existsSync(cfg)) await atomicWrite(cfg, doc.toString());
    return { changed, notes };
  }

  /** Resolves a RetroArch path value: ":\" is the executable folder (file_path.c fill_pathname_expand_special). */
  resolveValue(value: string, appDir = this.paths().app): string {
    const v = value.trim();
    if (!v || v === 'default') return v;
    if (/^:[\\/]/.test(v)) return join(appDir, v.slice(2));
    if (isAbsolute(v) || /^[a-zA-Z]:[\\/]/.test(v) || v.startsWith('\\\\')) return v;
    return resolve(appDir, v);
  }

  private samePath(a: string, b: string): boolean {
    const n = (s: string) => normalize(s).replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
    return n(a) === n(b);
  }

  async inspectConfig(): Promise<ConfigInspection> {
    const cfg = this.cfgPath();
    const exists = existsSync(cfg);
    const text = exists ? await readFile(cfg, 'utf8').catch(() => '') : '';
    const fmt = exists ? checkCfg(text) : { ok: false, issues: ['File does not exist'] };
    const drift: ConfigInspection['drift'] = [];
    if (exists && fmt.ok) {
      const doc = CfgDocument.parse(text);
      for (const [k, v, critical] of this.managedPathValues()) {
        const actual = doc.get(k) ?? null;
        if (!actual || !this.samePath(this.resolveValue(actual), v)) drift.push({ file: cfg, key: k, expected: v, actual, critical });
      }
      for (const k of ['savefiles_in_content_dir', 'savestates_in_content_dir'] as const) {
        if (doc.get(k) === 'true') drift.push({ file: cfg, key: k, expected: 'false', actual: 'true', critical: true });
      }
      if (doc.get('quit_press_twice') !== 'false' && doc.get('confirm_quit') !== 'false') {
        drift.push({ file: cfg, key: 'quit_press_twice', expected: 'false', actual: doc.get('quit_press_twice') ?? null, critical: false });
      }
    }
    const files: ConfigInspection['files'] = [{ label: 'retroarch.cfg', path: cfg, exists, parseOk: exists && fmt.ok, issues: fmt.issues }];
    for (const system of this.manifest.systems) {
      const f = this.systemInputPath(system);
      if (!existsSync(f)) drift.push({ file: f, key: `input-${system}.cfg`, expected: 'present', actual: null, critical: false });
    }
    return { files, drift };
  }

  /** Core for a system: settings.advanced "core|<system>" override, extension routing, then the default. */
  coreFor(system: SystemId, romPath: string | null, advanced: Record<string, string> = {}): string | null {
    const override = advanced[`core|${system}`]?.trim();
    if (override && /^[a-z0-9_-]+$/i.test(override)) return override.replace(/_libretro(\.dll)?$/i, '');
    const ext = romPath ? extname(romPath).toLowerCase() : '';
    return EXTENSION_CORES[system]?.[ext] ?? DEFAULT_CORES[system] ?? null;
  }

  corePath(core: string): string {
    return join(this.coresDir(), `${core}_libretro.dll`);
  }

  /** Cores needed for the configured systems (defaults, extension routes and overrides). */
  requiredCores(advanced: Record<string, string> = {}): string[] {
    const set = new Set<string>();
    for (const s of this.manifest.systems) {
      const c = this.coreFor(s, null, advanced);
      if (c) set.add(c);
      for (const extra of Object.values(EXTENSION_CORES[s] ?? {})) set.add(extra);
    }
    return [...set];
  }

  missingCores(advanced: Record<string, string> = {}): string[] {
    return this.requiredCores(advanced).filter((c) => !existsSync(this.corePath(c)));
  }

  sanitizeCustomArgs(raw: string): { args: string[]; dropped: string[] } {
    const args: string[] = [];
    const dropped: string[] = [];
    const parts = splitArgs(raw);
    for (let i = 0; i < parts.length; i++) {
      const a = parts[i];
      const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), true] : [a, false];
      if (KNOWN_FLAGS.has(flag) && !inline) args.push(a);
      else if (KNOWN_PARAM_FLAGS.has(flag) && inline) args.push(a);
      else if (KNOWN_PARAM_FLAGS.has(flag) && i + 1 < parts.length) args.push(a, parts[++i]);
      else dropped.push(a);
    }
    return { args, dropped };
  }

  async buildLaunch(target: LaunchTarget, executable: string, settings: EmulatorSettings, profile: GameProfile | null, _version: string | null): Promise<LaunchCommand> {
    const p = this.paths();
    const advanced = { ...settings.advanced, ...(profile?.overrides.advanced ?? {}) };
    if (!this.manifest.systems.includes(target.systemId)) {
      throw new OmniFailure({ code: 'SYSTEM_NOT_SUPPORTED', whatHappened: `OmniPC does not set up a RetroArch core for ${target.systemId} games.`, userAction: ['Install the dedicated emulator for this system from the Emulators page.'] });
    }
    const core = this.coreFor(target.systemId, target.path, advanced)!;
    const coreFile = this.corePath(core);
    if (!existsSync(coreFile)) {
      throw new OmniFailure({
        code: 'CORE_MISSING', whatHappened: `The RetroArch core "${core}" needed for this game is not installed.`, detected: [`Missing: ${coreFile}`],
        probableCause: 'The core download failed during installation, or the core was removed.',
        userAction: ['Update or reinstall RetroArch from the Emulators page; OmniPC downloads missing cores.', 'Or download it in RetroArch: Main Menu > Online Updater > Core Downloader.'],
      });
    }
    const notes: string[] = [`Core: ${core}`];
    const append = [this.systemInputPath(target.systemId)];
    const overrides = profile ? this.profileOverrides(profile) : [];
    const session = this.sessionPath();
    if (overrides.length) {
      append.push(session);
      notes.push(`Per-game profile applied for this session only (${overrides.length} overrides, via --appendconfig); retroarch.cfg is not modified.`);
    }
    const args = ['--config', this.cfgPath(), '--appendconfig', append.join('|'), '-L', coreFile];
    if (profile?.overrides.fullscreen ?? settings.fullscreen) args.push('-f');
    if (profile?.customArgs) {
      const { args: extra, dropped } = this.sanitizeCustomArgs(profile.customArgs);
      args.push(...extra);
      if (dropped.length) notes.push(`Ignored custom arguments RetroArch does not accept here (unknown options make it exit): ${dropped.join(' ')}`);
    }
    args.push(target.path);
    const prepare = async () => {
      await this.syncBios(target.systemId);
      if (overrides.length) await atomicWrite(session, `# OmniPC per-game session overrides (removed when the game exits)\n${overrides.map(([k, v]) => `${k} = "${v}"`).join('\n')}\n`);
    };
    const cleanup = async () => {
      await rm(session, { force: true });
    };
    return { command: executable, args, cwd: p.app, logFile: this.logFile(), prepare, cleanup, notes };
  }

  profileOverrides(profile: GameProfile): [string, string][] {
    const o = profile.overrides;
    const out: [string, string][] = [];
    const str = (v: string | number | boolean) => (typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v));
    if (o.renderer !== undefined) out.push(['video_driver', RETROARCH_RENDERERS[o.renderer] ?? 'd3d11']);
    if (o.aspectRatio !== undefined) out.push(['aspect_ratio_index', str(ASPECT_INDEX[o.aspectRatio] ?? ASPECT_INDEX.core)]);
    if (o.vsync !== undefined) out.push(['video_vsync', str(o.vsync)]);
    for (const [key, value] of Object.entries(o.advanced ?? {})) {
      const [kind, name] = key.split('|');
      if (kind === 'cfg' && name && /^\w+$/.test(name) && !/["\r\n]/.test(value)) out.push([name, value]);
    }
    return out;
  }

  buildUiLaunch(executable: string): LaunchCommand {
    return { command: executable, args: ['--config', this.cfgPath()], cwd: this.paths().app, logFile: this.logFile(), notes: [] };
  }

  async smokeTest(executable: string): Promise<SmokeTestResult> {
    const checks: SmokeTestResult['checks'] = [];
    const appDir = this.paths().app;
    checks.push({ label: 'Executable present', ok: existsSync(executable), detail: executable });
    if (!existsSync(executable)) return { ran: true, ok: false, checks };
    const insp = await this.inspectConfig();
    const cfg = insp.files[0];
    checks.push({ label: 'Configuration parses', ok: cfg.parseOk, detail: cfg.issues.join('; ') || 'retroarch.cfg OK' });
    const critical = insp.drift.filter((d) => d.critical);
    checks.push({ label: 'Save, BIOS and core folders configured', ok: critical.length === 0, detail: critical.length ? critical.map((d) => `${d.key} is ${d.actual ?? 'unset'} (expected ${d.expected})`).join('; ') : 'savefile/savestate/system/libretro directories point to OmniPC folders' });
    const missing = this.missingCores();
    checks.push({ label: 'Cores installed', ok: missing.length === 0, detail: missing.length ? `Missing: ${missing.map((c) => `${c}_libretro.dll`).join(', ')}` : `${this.requiredCores().length} core(s) in ${this.coresDir()}` });
    if (!isWindows) {
      checks.push({ label: 'Executable starts (--version)', ok: true, detail: 'Skipped: only possible on Windows' });
      return { ran: false, ok: checks.every((c) => c.ok), checks };
    }
    // --version prints and exit(0)s before any config, video or input init (retroarch.c
    // retroarch_parse_input_and_config first pass). frontend_win32_attach_console keeps
    // an already-connected pipe, so the output reaches us.
    const r = await runProcess(executable, ['--version'], { timeoutMs: 20000, cwd: appDir });
    const out = `${r.stdout}${r.stderr}`;
    const ok = !r.error && !r.timedOut && /Version:\s*\d/.test(out);
    checks.push({
      label: 'Executable starts (--version)',
      ok,
      detail: r.error ? r.error.message : r.timedOut ? 'Timed out after 20s' : ok ? (out.match(/Version:[^\r\n]*/)?.[0] ?? 'OK') : `Exit code ${r.code}, no version output${out ? `: ${out.trim().slice(-300)}` : ''}`,
    });
    return { ran: true, ok: checks.every((c) => c.ok), checks };
  }

  async validateEnvironment(hw: HardwareProfile | null, executable: string | null): Promise<Finding[]> {
    const out: Finding[] = [];
    const subject = { kind: 'emulator' as const, id: 'retroarch', label: 'RetroArch' };
    if (executable) {
      const missing = this.missingCores();
      if (missing.length) {
        out.push({
          id: 'retroarch.cores', checkId: 'retroarch.cores', category: 'emulators', severity: 'problem', title: 'RetroArch cores are missing',
          detail: `Games for some systems cannot start because these libretro cores are not in ${this.coresDir()}: ${missing.join(', ')}.`,
          subject, evidence: missing.map((c) => this.corePath(c)), confidence: 'high', repair: null,
          manualSteps: ['Update or reinstall RetroArch from the Emulators page (OmniPC downloads missing cores).', 'Or in RetroArch: Main Menu > Online Updater > Core Downloader (cores are saved to the same folder).'],
        });
      }
    }
    if (hw && hw.isWindows === false) {
      out.push({ id: 'retroarch.platform', checkId: 'retroarch.platform', category: 'emulators', severity: 'warning', title: 'RetroArch Windows build on a non-Windows system', detail: 'OmniPC installs the Windows build of RetroArch and its cores.', subject, evidence: [], confidence: 'high', repair: null, manualSteps: [] });
    }
    const doc = existsSync(this.cfgPath()) ? await this.loadCfg() : null;
    if (hw && doc?.get('video_driver') === 'vulkan' && hw.graphicsApis.vulkan === false) {
      out.push({ id: 'retroarch.vulkan', checkId: 'retroarch.renderer', category: 'emulators', severity: 'warning', title: 'RetroArch is set to Vulkan but no Vulkan driver was found', detail: 'Choose Direct3D 11 or OpenGL Core in RetroArch graphics settings.', subject, evidence: ['video_driver = vulkan'], confidence: 'medium', repair: null, manualSteps: [] });
    }
    return out;
  }

  saveLocations(): { label: string; path: string }[] {
    const p = this.paths();
    return [
      { label: 'Save files (per core)', path: join(p.saves, 'saves') },
      { label: 'Save states (per core)', path: join(p.saves, 'states') },
    ];
  }

  /**
   * Copies user-supplied BIOS files from BIOS/<system> (where OmniPC's BIOS
   * importer puts them) into the shared RetroArch system folder. Never
   * overwrites a same-sized file; returns the copied file names.
   */
  async syncBios(system: SystemId | null): Promise<string[]> {
    const copied: string[] = [];
    for (const b of RETROARCH_BIOS) {
      if (system && b.systemId !== system) continue;
      const src = join(this.app.systemBiosDir(b.systemId), b.file);
      const dest = join(this.paths().bios, b.file);
      const st = await stat(src).catch(() => null);
      if (!st?.isFile() || st.size !== b.size) continue;
      const cur = await stat(dest).catch(() => null);
      if (cur?.isFile()) continue;
      await mkdir(this.paths().bios, { recursive: true });
      await copyFile(src, dest);
      copied.push(b.file);
    }
    return copied;
  }

  async biosStatus(): Promise<BiosStatus[]> {
    const out: BiosStatus[] = [];
    for (const b of RETROARCH_BIOS) {
      const files: BiosStatus['files'] = [];
      for (const dir of [this.paths().bios, this.app.systemBiosDir(b.systemId)]) {
        const full = join(dir, b.file);
        const st = await stat(full).catch(() => null);
        if (!st?.isFile()) continue;
        const valid = st.size === b.size;
        files.push({ path: full, sizeBytes: st.size, valid, description: valid ? `${b.file} (${b.size} bytes)` : `Unexpected size ${st.size} bytes (expected ${b.size})` });
      }
      const anyValid = files.some((f) => f.valid);
      out.push({
        systemId: b.systemId, systemName: b.systemName, label: b.label, required: false, requirementKind: 'bios', emulatorId: 'retroarch',
        expectedLocation: this.paths().bios,
        status: anyValid ? 'found' : files.length ? 'invalid' : 'not_applicable',
        files,
        note: `${b.note} Put ${b.file} in ${this.paths().bios} (RetroArch's system folder) or import it for ${b.systemName}; OmniPC copies it there. OmniPC never downloads BIOS files.`,
      });
    }
    return out;
  }

  logFile(): string | null {
    return join(this.paths().data, 'logs', 'retroarch.log');
  }

  cacheDirs(): { label: string; path: string }[] {
    return [{ label: 'RetroArch cache (extracted archives)', path: this.paths().cache }];
  }

  async recoverSession(): Promise<string[]> {
    // Session overrides live in a separate --appendconfig file; retroarch.cfg is never touched,
    // so a crash only leaves that file behind.
    if (!existsSync(this.sessionPath())) return [];
    await rm(this.sessionPath(), { force: true });
    return ['Removed a leftover RetroArch per-game session file from an interrupted game.'];
  }

  /**
   * Downloads the default core for every system (plus overrides) from the
   * libretro buildbot into data/cores. Each zip must contain exactly one file,
   * <core>_libretro.dll, which must be a PE image; anything else is rejected.
   */
  async installComponents(installer: ComponentInstaller, input: ConfigInput): Promise<string[]> {
    await mkdir(this.coresDir(), { recursive: true });
    const notes: string[] = [];
    const cores = this.requiredCores(input.settings.advanced);
    const present: string[] = [];
    const installed: string[] = [];
    const failed: string[] = [];
    for (const core of cores) {
      if (installer.signal?.aborted) throw new OmniFailure({ code: 'CANCELLED', whatHappened: 'Core installation was cancelled.' });
      if (existsSync(this.corePath(core))) {
        present.push(core);
        continue;
      }
      installer.progress(`Downloading RetroArch core ${core}`);
      let archive: string | null = null;
      const staging = join(this.coresDir(), `.staging-${core}-${Date.now()}`);
      try {
        archive = await installer.download({ name: `RetroArch core ${core}`, url: `${CORE_BASE_URL}${core}_libretro.dll.zip`, fileName: `${core}_libretro.dll.zip` });
        await installer.extract(archive, staging);
        const dll = await this.singleCoreDll(staging, core);
        await rename(dll, this.corePath(core));
        installed.push(core);
      } catch (e) {
        if (installer.signal?.aborted) throw e;
        failed.push(`${core} (${(e as Error).message})`);
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
        if (archive) await installer.cleanup(archive).catch(() => undefined);
      }
    }
    if (installed.length) notes.push(`Installed RetroArch cores: ${installed.join(', ')}.`);
    if (present.length) notes.push(`Already installed: ${present.join(', ')}.`);
    if (failed.length) notes.push(`Could not install: ${failed.join('; ')}. Games for those systems will not start until the core is installed (retry by updating RetroArch).`);
    return notes;
  }

  private async singleCoreDll(dir: string, core: string): Promise<string> {
    const entries = await readdir(dir, { withFileTypes: true });
    const expected = `${core}_libretro.dll`;
    if (entries.length !== 1 || !entries[0].isFile() || entries[0].name.toLowerCase() !== expected.toLowerCase()) {
      throw new OmniFailure({ code: 'BAD_CORE_ARCHIVE', whatHappened: `The ${core} core archive does not contain exactly ${expected}.`, detected: entries.map((e) => e.name) });
    }
    const file = join(dir, entries[0].name);
    const head = Buffer.alloc(2);
    const fh = await open(file, 'r');
    try {
      await fh.read(head, 0, 2, 0);
    } finally {
      await fh.close();
    }
    if (head.toString('latin1') !== 'MZ') throw new OmniFailure({ code: 'BAD_CORE_ARCHIVE', whatHappened: `${expected} is not a Windows DLL.` });
    return file;
  }

  async detectExistingSetups(): Promise<SetupImportCandidate[]> {
    const out: SetupImportCandidate[] = [];
    const appdata = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const dirs: [string, string][] = [
      ['C:\\RetroArch-Win64', 'RetroArch (C:\\RetroArch-Win64, installer default)'],
      [join(appdata, 'RetroArch'), 'RetroArch (%APPDATA%\\RetroArch)'],
      [join(pf86, 'Steam', 'steamapps', 'common', 'RetroArch'), 'RetroArch (Steam)'],
      [join(appdata, 'EmuDeck', 'Emulators', 'RetroArch'), 'RetroArch (EmuDeck)'],
    ];
    for (const [dir, label] of dirs) {
      const exe = await this.findExecutable(dir);
      const cfgFile = join(dir, 'retroarch.cfg');
      if (!exe && !existsSync(cfgFile)) continue;
      out.push(await this.candidateFrom(dir, label, exe));
    }
    return out;
  }

  private async candidateFrom(root: string, label: string, exe: string | null): Promise<SetupImportCandidate> {
    const doc = await this.loadCfg(join(root, 'retroarch.cfg'));
    const dirOf = (key: string, def: string) => {
      const v = doc.get(key);
      return v && v !== 'default' ? this.resolveValue(v, root) : join(root, def);
    };
    const saves = dirOf('savefile_directory', 'saves');
    const states = dirOf('savestate_directory', 'states');
    const system = dirOf('system_directory', 'system');
    const details = [`Config: ${join(root, 'retroarch.cfg')}`, `Saves: ${saves}`, `States: ${states}`, `System/BIOS folder: ${system}`];
    if (exe) details.unshift(`Executable: ${exe}`);
    return {
      id: `retroarch:${root}`, source: 'retroarch', label, path: root, details,
      importable: { settings: false, saves: existsSync(saves) || existsSync(states) || existsSync(system), bios: false, romPaths: false, useInstallation: !!exe },
      romPaths: [],
      saveCopies: [
        { from: saves, to: join(this.paths().saves, 'saves'), label: 'RetroArch save files' },
        { from: states, to: join(this.paths().saves, 'states'), label: 'RetroArch save states' },
        // The system folder mixes BIOS files and core data, so it is copied as a whole
        // into RetroArch's own system folder rather than offered to the per-system BIOS importer.
        { from: system, to: this.paths().bios, label: 'RetroArch system folder (BIOS and core files)' },
      ],
    };
  }
}
