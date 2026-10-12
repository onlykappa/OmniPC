// Dolphin adapter (GameCube + Wii).
// Layout:
//   Emulators/dolphin/app        program files (replaced on update)
//   Emulators/dolphin/data/User  passed with -u; Config/, Logs/, StateSaves/, ...
//   Saves/dolphin/GC             memory cards (MemcardAPath/MemcardBPath)
//   Saves/dolphin/Wii            Wii NAND root (NANDRootPath) – holds Wii saves
//   BIOS/gc                      optional GameCube IPL

import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BiosStatus, EmulatorManifest, EmulatorSettings, Finding, GameProfile, HardwareProfile, PerformancePreset, RendererOption, SetupImportCandidate, UniversalButton, UniversalControllerProfile } from '@shared/models';
import type { SystemId } from '@shared/systems';
import manifestJson from '../manifests/dolphin.json';
import type { AdapterCapabilities, AdapterPaths, ConfigInput, ConfigInspection, ConfigWriteResult, EmulatorAdapter, LaunchCommand, LaunchTarget, SmokeTestResult } from '../adapter';
import type { AppPaths } from '../../core/paths';
import type { BackupTarget } from '../../config/backups';
import { loadIni, saveIni } from '../../config/iniFile';
import { checkIni } from '../../config/formats';
import type { IniDocument } from '../../config/ini';
import { hotkeyChords, physicalFor } from '../../controllers/translate';
import { findExeIn, preferredRenderer, resolutionScaleFor } from '../common';
import { runProcess } from '../../platform/exec';
import { fileVersion, isWindows } from '../../platform/powershell';
import { splitArgs } from '../pcsx2/adapter';
import { writeAchievementsConfig, type RaFiles } from '../../achievements/emulatorConfig';
import type { SettingDef } from '@shared/emulatorSettings';
import { DOLPHIN_SETTINGS, dolphinOptimize, dolphinValue } from './settingsSchema';

export const DOLPHIN_MANIFEST = manifestJson as unknown as EmulatorManifest;

/** Values accepted by [Core] GFXBackend. */
export const DOLPHIN_BACKENDS: Record<string, string> = { d3d11: 'D3D', d3d12: 'D3D12', vulkan: 'Vulkan', opengl: 'OGL', software: 'Software Renderer' };
const ASPECTS: Record<string, number> = { auto: 0, '16:9': 1, '4:3': 2, stretch: 3 };

const XINPUT: Record<UniversalButton, string> = {
  A: 'Button A', B: 'Button B', X: 'Button X', Y: 'Button Y',
  LB: 'Shoulder L', RB: 'Shoulder R', LT: 'Trigger L', RT: 'Trigger R', L3: 'Thumb L', R3: 'Thumb R',
  Start: 'Start', Select: 'Back', Guide: 'Guide',
  DPadUp: 'Pad N', DPadDown: 'Pad S', DPadLeft: 'Pad W', DPadRight: 'Pad E',
  LeftStickUp: 'Left Y+', LeftStickDown: 'Left Y-', LeftStickLeft: 'Left X-', LeftStickRight: 'Left X+',
  RightStickUp: 'Right Y+', RightStickDown: 'Right Y-', RightStickLeft: 'Right X-', RightStickRight: 'Right X+',
};

// SDL gamepad naming (SDLGamepad.h); SDL's Y axis grows downwards.
const SDL: Record<UniversalButton, string> = {
  ...XINPUT,
  A: 'Button S', B: 'Button E', X: 'Button W', Y: 'Button N',
  LeftStickUp: 'Left Y-', LeftStickDown: 'Left Y+', RightStickUp: 'Right Y-', RightStickDown: 'Right Y+',
};

/** SDL3 product names Dolphin shows for common pads (best effort; verified in OmniDoctor). */
const SDL_DEVICE_NAMES: Record<string, string> = {
  dualsense: 'DualSense Wireless Controller',
  dualshock4: 'PS4 Controller',
  switch_pro: 'Nintendo Switch Pro Controller',
  generic: 'Controller',
};

// GameCube pad, positional mapping: A south, B west, X east, Y north.
const GC_PAD: [string, UniversalButton][] = [
  ['Buttons/A', 'A'], ['Buttons/B', 'X'], ['Buttons/X', 'B'], ['Buttons/Y', 'Y'], ['Buttons/Z', 'RB'], ['Buttons/Start', 'Start'],
  ['Main Stick/Up', 'LeftStickUp'], ['Main Stick/Down', 'LeftStickDown'], ['Main Stick/Left', 'LeftStickLeft'], ['Main Stick/Right', 'LeftStickRight'],
  ['C-Stick/Up', 'RightStickUp'], ['C-Stick/Down', 'RightStickDown'], ['C-Stick/Left', 'RightStickLeft'], ['C-Stick/Right', 'RightStickRight'],
  ['Triggers/L', 'LT'], ['Triggers/R', 'RT'], ['Triggers/L-Analog', 'LT'], ['Triggers/R-Analog', 'RT'],
  ['D-Pad/Up', 'DPadUp'], ['D-Pad/Down', 'DPadDown'], ['D-Pad/Left', 'DPadLeft'], ['D-Pad/Right', 'DPadRight'],
];

// Emulated Wii Remote + Nunchuk.
const WIIMOTE: [string, UniversalButton][] = [
  ['Buttons/A', 'A'], ['Buttons/B', 'RT'], ['Buttons/1', 'X'], ['Buttons/2', 'Y'], ['Buttons/-', 'Select'], ['Buttons/+', 'Start'], ['Buttons/Home', 'Guide'],
  ['D-Pad/Up', 'DPadUp'], ['D-Pad/Down', 'DPadDown'], ['D-Pad/Left', 'DPadLeft'], ['D-Pad/Right', 'DPadRight'],
  ['IR/Up', 'RightStickUp'], ['IR/Down', 'RightStickDown'], ['IR/Left', 'RightStickLeft'], ['IR/Right', 'RightStickRight'],
  ['Shake/X', 'RB'], ['Shake/Y', 'RB'], ['Shake/Z', 'RB'],
  ['Nunchuk/Buttons/C', 'LB'], ['Nunchuk/Buttons/Z', 'LT'],
  ['Nunchuk/Stick/Up', 'LeftStickUp'], ['Nunchuk/Stick/Down', 'LeftStickDown'], ['Nunchuk/Stick/Left', 'LeftStickLeft'], ['Nunchuk/Stick/Right', 'LeftStickRight'],
];

const HOTKEYS: Partial<Record<string, string>> = {
  exit: 'General/Stop',
  saveState: 'Save State/Save to Selected Slot',
  loadState: 'Load State/Load from Selected Slot',
  volumeUp: 'Volume/Volume Up',
  volumeDown: 'Volume/Volume Down',
  fastForward: 'Emulation Speed/Disable Emulation Speed Limit',
  screenshot: 'General/Take Screenshot',
  fullscreen: 'General/Toggle Fullscreen',
};

export class DolphinAdapter implements EmulatorAdapter {
  readonly manifest = DOLPHIN_MANIFEST;
  readonly capabilities: AdapterCapabilities = {
    perGameProfiles: 'native',
    frameLimit: true,
    vsync: true,
    aspectRatios: [
      { id: 'auto', label: 'Auto' },
      { id: '16:9', label: 'Force 16:9' },
      { id: '4:3', label: 'Force 4:3' },
      { id: 'stretch', label: 'Stretch to window' },
    ],
    hotkeys: ['exit', 'saveState', 'loadState', 'volumeUp', 'volumeDown', 'fastForward', 'screenshot', 'fullscreen'],
    smokeTest: true,
    maxResolutionScale: 8,
  };

  constructor(private readonly app: AppPaths) {}

  paths(): AdapterPaths {
    return {
      app: this.app.emulatorAppDir('dolphin'),
      data: this.app.emulatorDataDir('dolphin'),
      saves: this.app.emulatorSaveDir('dolphin'),
      bios: this.app.systemBiosDir('gc'),
      cache: this.app.emulatorCacheDir('dolphin'),
    };
  }

  userDir(): string {
    return join(this.paths().data, 'User');
  }

  configPath(name: string): string {
    return join(this.userDir(), 'Config', name);
  }

  async findExecutable(appDir: string): Promise<string | null> {
    return findExeIn(appDir, [/^Dolphin\.exe$/i, /^dolphin-emu$/]);
  }

  async detectVersion(executable: string): Promise<string | null> {
    return fileVersion(executable);
  }

  renderers(hw: HardwareProfile | null): RendererOption[] {
    const vk = hw?.graphicsApis.vulkan;
    const dx12 = hw?.graphicsApis.directx12;
    return [
      { id: 'd3d11', label: 'Direct3D 11', available: hw ? hw.isWindows : true },
      { id: 'd3d12', label: 'Direct3D 12', available: dx12 !== false, note: dx12 === false ? 'd3d12.dll not found' : undefined },
      { id: 'vulkan', label: 'Vulkan', available: vk !== false, note: vk === false ? 'No Vulkan driver detected' : undefined },
      { id: 'opengl', label: 'OpenGL', available: true },
      { id: 'software', label: 'Software (very slow)', available: true },
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
    const root = this.paths().data;
    return ['Dolphin.ini', 'GFX.ini', 'GCPadNew.ini', 'WiimoteNew.ini', 'Hotkeys.ini', 'Logger.ini'].map((f) => ({ root, path: this.configPath(f) }));
  }

  private async ensureDirs(): Promise<void> {
    const p = this.paths();
    for (const d of [p.app, this.userDir(), join(this.userDir(), 'Config'), join(this.userDir(), 'Logs'), join(p.saves, 'GC'), join(p.saves, 'Wii'), p.bios, p.cache]) await mkdir(d, { recursive: true });
  }

  managedPathValues(): [string, string, string, string][] {
    const p = this.paths();
    return [
      ['Dolphin.ini', 'General', 'NANDRootPath', join(p.saves, 'Wii')],
      ['Dolphin.ini', 'Core', 'MemcardAPath', join(p.saves, 'GC', 'MemoryCardA.raw')],
      ['Dolphin.ini', 'Core', 'MemcardBPath', join(p.saves, 'GC', 'MemoryCardB.raw')],
    ];
  }

  settingsSchema(): SettingDef[] {
    return DOLPHIN_SETTINGS;
  }

  async readSettings(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const docs = new Map<string, IniDocument | null>();
    for (const d of DOLPHIN_SETTINGS) {
      const [file, section, key] = d.key.split('|');
      if (!docs.has(file)) {
        const path = this.configPath(file);
        docs.set(file, existsSync(path) ? await loadIni(path).catch(() => null) : null);
      }
      const v = docs.get(file)?.get(section, key);
      if (v !== undefined) out[d.key] = v;
    }
    return out;
  }

  optimize(hw: HardwareProfile): { key: string; value: string; reason: string }[] {
    return dolphinOptimize(hw);
  }

  private deviceString(c: UniversalControllerProfile): { device: string; table: Record<UniversalButton, string>; bestEffort: boolean } {
    if (c.controllerKind === 'xbox' || c.controllerKind === 'generic') return { device: `XInput/${c.deviceIndex}/Gamepad`, table: XINPUT, bestEffort: c.controllerKind === 'generic' };
    return { device: `SDL/${c.deviceIndex}/${SDL_DEVICE_NAMES[c.controllerKind] ?? SDL_DEVICE_NAMES.generic}`, table: SDL, bestEffort: true };
  }

  async applyConfig(input: ConfigInput, scope: 'all' | 'controller' | 'graphics' | 'paths'): Promise<ConfigWriteResult> {
    await this.ensureDirs();
    const changed: string[] = [];
    const notes: string[] = [];
    const docs = new Map<string, IniDocument>();
    const doc = async (name: string) => {
      let d = docs.get(name);
      if (!d) docs.set(name, (d = await loadIni(this.configPath(name))));
      return d;
    };
    const set = async (file: string, s: string, k: string, v: string | number | boolean) => {
      const val = typeof v === 'boolean' ? (v ? 'True' : 'False') : v;
      if ((await doc(file)).set(s, k, val)) changed.push(`${file} ${s}.${k} = ${val}`);
    };

    if (scope === 'all' || scope === 'paths') {
      for (const [f, s, k, v] of this.managedPathValues()) await set(f, s, k, v);
      await set('Dolphin.ini', 'Interface', 'ConfirmStop', false);
      await set('Dolphin.ini', 'Analytics', 'PermissionAsked', true);
      await set('Dolphin.ini', 'Analytics', 'Enabled', false);
      await set('Dolphin.ini', 'AutoUpdate', 'UpdateTrack', '');
      await set('Dolphin.ini', 'Core', 'SIDevice0', 6); // standard controller in port 1
      await set('Logger.ini', 'Options', 'WriteToFile', true);
      await set('Logger.ini', 'Options', 'Verbosity', 3);
      for (const cat of ['BOOT', 'CORE', 'VIDEO', 'COMMON', 'DISCIO', 'HOST_GPU', 'MASTER']) await set('Logger.ini', 'Logs', cat, true);
      // Dolphin looks for User/GC/<REGION>/IPL.bin. Users keep IPLs in BIOS/gc
      // (flat IPL.bin is treated as USA, or BIOS/gc/<REGION>/IPL.bin).
      for (const region of ['USA', 'EUR', 'JAP']) {
        const src = [join(this.paths().bios, region, 'IPL.bin'), ...(region === 'USA' ? [join(this.paths().bios, 'IPL.bin')] : [])].find((f) => existsSync(f));
        const dest = join(this.userDir(), 'GC', region, 'IPL.bin');
        if (src && !existsSync(dest)) {
          await mkdir(join(this.userDir(), 'GC', region), { recursive: true });
          await copyFile(src, dest);
          changed.push(`Copied GameCube IPL to ${dest}`);
        }
      }
    }
    if (scope === 'all' || scope === 'graphics') {
      const s = input.settings;
      await set('Dolphin.ini', 'Core', 'GFXBackend', DOLPHIN_BACKENDS[s.renderer] ?? 'D3D');
      await set('Dolphin.ini', 'Display', 'Fullscreen', s.fullscreen);
      await set('Dolphin.ini', 'Core', 'EmulationSpeed', s.frameLimit ? '1.00000000' : '0.00000000');
      await set('GFX.ini', 'Settings', 'InternalResolution', s.resolutionScale);
      await set('GFX.ini', 'Settings', 'AspectRatio', ASPECTS[s.aspectRatio] ?? 0);
      await set('GFX.ini', 'Hardware', 'VSync', s.vsync);
      for (const [key, value] of Object.entries(s.advanced)) {
        const [file, section, name] = key.split('|');
        if (file && section && name && /^(Dolphin|GFX)\.ini$/.test(file)) await set(file, section, name, dolphinValue(key, value));
      }
    }
    if (scope === 'all' || scope === 'controller') {
      const c = input.controller;
      const { device, table, bestEffort } = this.deviceString(c);
      if (bestEffort) notes.push(`Controller mapped to ${device}. Dolphin names non-Xbox controllers by their driver name; if buttons do nothing, open Controllers > Test and re-apply.`);
      const tok = (system: SystemId, l: UniversalButton) => '`' + table[physicalFor(c, system, l)] + '`';
      await set('GCPadNew.ini', 'GCPad1', 'Device', device);
      for (const [k, l] of GC_PAD) await set('GCPadNew.ini', 'GCPad1', k, tok('gc', l));
      if (c.rumble) await set('GCPadNew.ini', 'GCPad1', 'Rumble/Motor', table === XINPUT ? '`Motor L` | `Motor R`' : '`Motor`');
      await set('WiimoteNew.ini', 'Wiimote1', 'Source', 1);
      await set('WiimoteNew.ini', 'Wiimote1', 'Device', device);
      await set('WiimoteNew.ini', 'Wiimote1', 'Extension', 'Nunchuk');
      for (const [k, l] of WIIMOTE) await set('WiimoteNew.ini', 'Wiimote1', k, tok('wii', l));
      await set('Hotkeys.ini', 'Hotkeys', 'Device', device);
      for (const ch of hotkeyChords(input.hotkeys, this.capabilities.hotkeys)) {
        const key = HOTKEYS[ch.action];
        if (!key) continue;
        // @( ) is Dolphin's hotkey-combination syntax: both pressed, inputs suppressed.
        await set('Hotkeys.ini', 'Hotkeys', key, `@(${ch.buttons.map((b) => '`' + table[b] + '`').join('+')})`);
      }
    }
    for (const [name, d] of docs) await saveIni(this.configPath(name), d);
    if (input.achievements && (scope === 'all' || scope === 'paths')) changed.push(...(await writeAchievementsConfig(this.achievements(), input.achievements)));
    return { changed, notes };
  }

  achievements(): RaFiles {
    return { kind: 'dolphin', configDir: join(this.userDir(), 'Config') };
  }

  async inspectConfig(): Promise<ConfigInspection> {
    const files: ConfigInspection['files'] = [];
    for (const t of this.configTargets()) {
      const exists = existsSync(t.path);
      const fmt = exists ? checkIni(await readFile(t.path, 'utf8').catch(() => '')) : { ok: false, issues: ['File does not exist'] };
      files.push({ label: t.path.split(/[\\/]/).pop()!, path: t.path, exists, parseOk: exists && fmt.ok, issues: fmt.issues });
    }
    const drift: ConfigInspection['drift'] = [];
    const main = this.configPath('Dolphin.ini');
    if (existsSync(main)) {
      const d = await loadIni(main);
      for (const [, s, k, v] of this.managedPathValues()) {
        const actual = d.get(s, k) ?? null;
        if (!actual || actual.toLowerCase() !== v.toLowerCase()) drift.push({ file: main, key: `${s}.${k}`, expected: v, actual, critical: true });
      }
    }
    return { files, drift };
  }

  /** Per-game overrides as Dolphin -C arguments (no config files touched). */
  profileArgs(base: EmulatorSettings, profile: GameProfile): string[] {
    const o = profile.overrides;
    const args: string[] = [];
    const c = (v: string) => args.push('-C', v);
    if (o.renderer !== undefined) c(`Dolphin.Core.GFXBackend=${DOLPHIN_BACKENDS[o.renderer] ?? 'D3D'}`);
    if (o.resolutionScale !== undefined) c(`GFX.Settings.InternalResolution=${o.resolutionScale}`);
    if (o.aspectRatio !== undefined) c(`GFX.Settings.AspectRatio=${ASPECTS[o.aspectRatio] ?? 0}`);
    if (o.vsync !== undefined) c(`GFX.Hardware.VSync=${o.vsync ? 'True' : 'False'}`);
    if (o.frameLimit !== undefined) c(`Dolphin.Core.EmulationSpeed=${o.frameLimit ? '1.0' : '0.0'}`);
    if (o.fullscreen !== undefined) c(`Dolphin.Display.Fullscreen=${o.fullscreen ? 'True' : 'False'}`);
    for (const [key, value] of Object.entries(o.advanced ?? {})) {
      const [file, section, name] = key.split('|');
      const system = file === 'GFX.ini' ? 'GFX' : file === 'Dolphin.ini' ? 'Dolphin' : null;
      if (system && section && name) c(`${system}.${section}.${name}=${dolphinValue(key, value)}`);
    }
    void base;
    return args;
  }

  async buildLaunch(target: LaunchTarget, executable: string, settings: EmulatorSettings, profile: GameProfile | null, _version?: string | null): Promise<LaunchCommand> {
    const args = ['-u', this.userDir(), '-b'];
    const notes: string[] = [];
    if (profile) {
      const extra = this.profileArgs(settings, profile);
      if (extra.length) notes.push(`Per-game profile applied with ${extra.length / 2} -C overrides.`);
      args.push(...extra);
      if (profile.customArgs) args.push(...splitArgs(profile.customArgs));
    }
    args.push('-e', target.path);
    return { command: executable, args, cwd: this.paths().app, logFile: join(this.userDir(), 'Logs', 'dolphin.log'), notes };
  }

  buildUiLaunch(executable: string): LaunchCommand {
    return { command: executable, args: ['-u', this.userDir()], cwd: this.paths().app, logFile: join(this.userDir(), 'Logs', 'dolphin.log'), notes: [] };
  }

  async smokeTest(executable: string): Promise<SmokeTestResult> {
    const checks: SmokeTestResult['checks'] = [];
    checks.push({ label: 'Executable present', ok: existsSync(executable), detail: executable });
    if (!existsSync(executable)) return { ran: true, ok: false, checks };
    const sys = existsSync(join(this.paths().app, 'Sys'));
    checks.push({ label: 'Sys data folder present', ok: sys, detail: sys ? 'OK' : 'Dolphin cannot start without its Sys folder' });
    const insp = await this.inspectConfig();
    const main = insp.files.find((f) => f.label === 'Dolphin.ini');
    checks.push({ label: 'Configuration parses', ok: !!main?.parseOk, detail: main?.issues.join('; ') || 'Dolphin.ini OK' });
    if (!isWindows) {
      checks.push({ label: 'Executable starts (--version)', ok: true, detail: 'Skipped: only possible on Windows' });
      return { ran: false, ok: checks.every((c) => c.ok), checks };
    }
    const r = await runProcess(executable, ['--version'], { timeoutMs: 20000, cwd: this.paths().app });
    const ok = !r.error && !r.timedOut && r.code === 0;
    checks.push({ label: 'Executable starts (--version)', ok, detail: r.error ? r.error.message : r.timedOut ? 'Timed out' : `Exit code ${r.code} ${(r.stdout || r.stderr).trim().slice(0, 120)}` });
    return { ran: true, ok: checks.every((c) => c.ok), checks };
  }

  async validateEnvironment(): Promise<Finding[]> {
    return [];
  }

  saveLocations(): { label: string; path: string }[] {
    const p = this.paths();
    return [
      { label: 'GameCube memory cards', path: join(p.saves, 'GC') },
      { label: 'Wii saves (NAND)', path: join(p.saves, 'Wii') },
      { label: 'Save states', path: join(this.userDir(), 'StateSaves') },
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
        const valid = /^ipl\.bin$/i.test(f) && st.size === 2 * 1024 * 1024;
        files.push({ path: full, sizeBytes: st.size, valid, description: valid ? 'GameCube IPL (2 MB)' : /ipl/i.test(f) ? 'Unexpected size for a GameCube IPL (should be 2 MB)' : 'Not used by Dolphin' });
      }
    }
    return [{
      systemId: 'gc', systemName: 'GameCube', label: 'GameCube IPL (optional)', required: false, requirementKind: 'bios', emulatorId: 'dolphin', expectedLocation: dir,
      status: files.some((f) => f.valid) ? 'found' : files.some((f) => /ipl/i.test(f.path)) ? 'invalid' : 'not_applicable', files,
      note: 'Optional. Dolphin runs GameCube games without an IPL. Wii games need no BIOS.',
    }];
  }

  logFile(): string | null {
    return join(this.userDir(), 'Logs', 'dolphin.log');
  }

  cacheDirs(): { label: string; path: string }[] {
    return [{ label: 'Shader cache', path: join(this.userDir(), 'Cache', 'Shaders') }, { label: 'Game list cache', path: join(this.userDir(), 'Cache', 'gamelist.cache') }];
  }

  async recoverSession(): Promise<string[]> {
    return [];
  }

  async detectExistingSetups(): Promise<SetupImportCandidate[]> {
    const out: SetupImportCandidate[] = [];
    const roots = [join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Dolphin Emulator'), join(homedir(), 'Documents', 'Dolphin Emulator')];
    for (const r of roots) {
      const ini = join(r, 'Config', 'Dolphin.ini');
      if (!existsSync(ini)) continue;
      const d = await loadIni(ini);
      const count = Number(d.get('General', 'ISOPaths') ?? 0);
      const romPaths: string[] = [];
      for (let i = 0; i < count; i++) {
        const p = d.get('General', `ISOPath${i}`);
        if (p && existsSync(p)) romPaths.push(p);
      }
      out.push({
        id: `dolphin:${r}`, source: 'dolphin', label: `Dolphin user folder (${r})`, path: r,
        details: [`Settings: ${ini}`, `Game folders: ${romPaths.length}`, `Wii saves: ${existsSync(join(r, 'Wii')) ? 'yes' : 'no'}`],
        importable: { settings: true, saves: existsSync(join(r, 'GC')) || existsSync(join(r, 'Wii')), bios: existsSync(join(r, 'GC', 'USA', 'IPL.bin')), romPaths: romPaths.length > 0, useInstallation: false },
        romPaths,
      });
    }
    for (const dir of ['C:\\Program Files\\Dolphin', 'C:\\Program Files\\Dolphin-x64']) {
      const exe = await this.findExecutable(dir);
      if (exe) out.push({ id: `dolphin:install:${dir}`, source: 'dolphin', label: `Dolphin installation (${dir})`, path: dir, details: [`Executable: ${exe}`], importable: { settings: false, saves: false, bios: false, romPaths: false, useInstallation: true }, romPaths: [] });
    }
    return out;
  }
}
