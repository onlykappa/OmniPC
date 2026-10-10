// melonDS adapter (Nintendo DS).
// Official Windows builds are compiled with PORTABLE=ON (src/frontend/qt_sdl/CMakeLists.txt
// -> WIN32_PORTABLE), so pathInit() (main.cpp) makes the executable folder the
// "emuDirectory" that holds melonDS.toml and wfcsettings.bin, unless a "portable"
// sub-folder exists next to the exe. There is no command-line option or
// environment variable for the config location (CLI.cpp only knows -b/-f/-a/-A),
// so OmniPC keeps melonDS.toml next to the exe (carried over on updates via
// persistentAppPaths) and points every path setting outside the app folder:
//   Emulators/melonds/app        melonDS.exe + melonDS.toml + wfcsettings.bin
//   Emulators/melonds/data       cheats (.mch) + per-game session journal
//   Saves/melonds/{saves,states} Instance0.SaveFilePath / Instance0.SavestatePath
//   BIOS/nds                     bios7.bin, bios9.bin, firmware.bin (optional)

import { existsSync } from 'node:fs';
import { access, constants, copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import type { BiosStatus, EmulatorManifest, EmulatorSettings, Finding, GameProfile, HardwareProfile, PerformancePreset, RendererOption, SetupImportCandidate, UniversalButton } from '@shared/models';
import manifestJson from '../manifests/melonds.json';
import type { AdapterCapabilities, AdapterPaths, ConfigInput, ConfigInspection, ConfigWriteResult, EmulatorAdapter, LaunchCommand, LaunchTarget, SmokeTestResult } from '../adapter';
import type { AppPaths } from '../../core/paths';
import type { BackupTarget } from '../../config/backups';
import { atomicWrite } from '../../config/iniFile';
import { hotkeyChords, physicalFor } from '../../controllers/translate';
import { findExeIn, resolutionScaleFor } from '../common';
import { fileVersion, isWindows } from '../../platform/powershell';
import { splitArgs } from '../pcsx2/adapter';
import { TomlDocument, checkToml, type TomlScalar } from './toml';

export const MELONDS_MANIFEST = manifestJson as unknown as EmulatorManifest;

type Path = string[];
type Entry = [Path, TomlScalar];

/** 3D.Renderer values (EmuInstance.h renderer3D_* enum, OpenGL enabled in Windows builds). */
export const MELONDS_RENDERERS: Record<string, number> = { software: 0, opengl: 1, compute: 2 };

/** Instance0.Window0.ScreenAspectTop/Bot ids (Screen.h aspectRatios[]). */
const ASPECTS: Record<string, number> = { auto: 0, '4:3': 0, '5:3': 4, '16:9': 1, '21:9': 2, stretch: 3 };

/** BIOS/firmware sizes melonDS accepts (EmuInstance.cpp verifyDSBIOS / verifyDSFirmware). */
export const NDS_BIOS_FILES = {
  bios7: { label: 'ARM7 BIOS', sizes: [0x4000], names: ['bios7.bin', 'biosnds7.rom', 'biosnds7.bin'] },
  bios9: { label: 'ARM9 BIOS', sizes: [0x1000], names: ['bios9.bin', 'biosnds9.rom', 'biosnds9.bin'] },
  firmware: { label: 'Firmware', sizes: [0x20000, 0x40000, 0x80000], names: ['firmware.bin', 'firmware.rom', 'nds_firmware.bin'] },
} as const;
type BiosRole = keyof typeof NDS_BIOS_FILES;

/**
 * melonDS reads joysticks through the raw SDL2 joystick API (EmuInstanceInput.cpp
 * joystickButtonDown), not SDL_GameController, so a binding is a joystick index:
 *   button: n | hat: 0x100 | (hat << 4) | dir (1 up, 2 right, 4 down, 8 left)
 *   axis:   0x10000 | (dir << 20) | (axis << 24), dir 0 = positive, 1 = negative, 2 = trigger
 * One value may hold a button/hat in the low 16 bits (0xFFFF = none) AND an axis.
 * Layout assumed for an Xbox-compatible pad under SDL2 on Windows (RAWINPUT/XInput
 * drivers): buttons A0 B1 X2 Y3 LB4 RB5 Back6 Start7 L3 8 R3 9 Guide10, D-pad = hat 0,
 * axes LeftX0 LeftY1 RightX2 RightY3 LT4 RT5 (RAWINPUT order).
 */
type JoyInput = { button: number } | { hat: number; dir: 1 | 2 | 4 | 8 } | { axis: number; dir: 0 | 1 | 2 };
const SDL_JOY: Record<UniversalButton, JoyInput> = {
  A: { button: 0 }, B: { button: 1 }, X: { button: 2 }, Y: { button: 3 },
  LB: { button: 4 }, RB: { button: 5 }, Select: { button: 6 }, Start: { button: 7 },
  L3: { button: 8 }, R3: { button: 9 }, Guide: { button: 10 },
  DPadUp: { hat: 0, dir: 1 }, DPadRight: { hat: 0, dir: 2 }, DPadDown: { hat: 0, dir: 4 }, DPadLeft: { hat: 0, dir: 8 },
  LeftStickLeft: { axis: 0, dir: 1 }, LeftStickRight: { axis: 0, dir: 0 }, LeftStickUp: { axis: 1, dir: 1 }, LeftStickDown: { axis: 1, dir: 0 },
  RightStickLeft: { axis: 2, dir: 1 }, RightStickRight: { axis: 2, dir: 0 }, RightStickUp: { axis: 3, dir: 1 }, RightStickDown: { axis: 3, dir: 0 },
  LT: { axis: 4, dir: 2 }, RT: { axis: 5, dir: 2 },
};

function lowPart(i: JoyInput): number | null {
  if ('button' in i) return i.button;
  if ('hat' in i) return 0x100 | (i.hat << 4) | i.dir;
  return null;
}
function axisPart(i: JoyInput): number | null {
  return 'axis' in i ? 0x10000 | (i.dir << 20) | (i.axis << 24) : null;
}

/** Encodes one or two physical inputs into a melonDS joystick mapping value. */
export function joyCode(...buttons: UniversalButton[]): number {
  let low: number | null = null;
  let axis: number | null = null;
  for (const b of buttons) {
    const inp = SDL_JOY[b];
    low ??= lowPart(inp);
    axis ??= axisPart(inp);
  }
  return (low ?? 0xffff) | (axis ?? 0);
}

/** DS button (EmuInstance::buttonNames) -> logical universal buttons (first wins for the button part). */
const DS_PAD: [string, UniversalButton[]][] = [
  ['A', ['A']], ['B', ['B']], ['X', ['X']], ['Y', ['Y']],
  ['L', ['LB']], ['R', ['RB']], ['Select', ['Select']], ['Start', ['Start']],
  ['Up', ['DPadUp', 'LeftStickUp']], ['Down', ['DPadDown', 'LeftStickDown']],
  ['Left', ['DPadLeft', 'LeftStickLeft']], ['Right', ['DPadRight', 'LeftStickRight']],
];

/** Universal hotkey actions melonDS has (EmuInstance::hotkeyNames). melonDS has no exit/save-state/menu hotkey. */
const HOTKEY_NAMES = {
  fastForward: 'HK_FastForward',
  fullscreen: 'HK_FullscreenToggle',
  volumeUp: 'HK_VolumeUp',
  volumeDown: 'HK_VolumeDown',
} as const;

/** DS-specific single-button hotkeys OmniPC adds when the button is free. */
const DS_EXTRA_HOTKEYS: [string, UniversalButton][] = [['HK_SwapScreens', 'R3'], ['HK_Mic', 'L3']];

const KNOWN_FLAGS = new Set(['-f', '--fullscreen']);
const KNOWN_PARAM_FLAGS = new Set(['-b', '--boot', '-a', '--archive-file', '-A', '--archive-file-gba']);

/** Files melonDS keeps in its emuDirectory (= exe folder in the official Windows build). */
const PORTABLE_FILES = [
  'melonDS.toml', 'melonDS.ini', 'wfcsettings.bin', 'dldi.bin', 'dsisd.bin', 'portable',
  ...Array.from({ length: 15 }, (_, i) => `wfcsettings.bin.${i + 2}`),
  ...Array.from({ length: 15 }, (_, i) => `melonDS.${i + 2}.ini`),
];

const P = (s: string): Path => s.split('.');

export class MelonDsAdapter implements EmulatorAdapter {
  readonly manifest = MELONDS_MANIFEST;
  readonly capabilities: AdapterCapabilities = {
    perGameProfiles: 'session',
    frameLimit: true,
    vsync: true,
    aspectRatios: [
      { id: 'auto', label: '4:3 (native)' },
      { id: '5:3', label: '5:3 (3DS)' },
      { id: '16:9', label: '16:9' },
      { id: '21:9', label: '21:9' },
      { id: 'stretch', label: 'Fill window' },
    ],
    hotkeys: ['fastForward', 'fullscreen', 'volumeUp', 'volumeDown'],
    smokeTest: true,
    maxResolutionScale: 16,
  };

  constructor(private readonly app: AppPaths) {}

  paths(): AdapterPaths {
    return {
      app: this.app.emulatorAppDir('melonds'),
      data: this.app.emulatorDataDir('melonds'),
      saves: this.app.emulatorSaveDir('melonds'),
      bios: this.app.systemBiosDir('nds'),
      cache: this.app.emulatorCacheDir('melonds'),
    };
  }

  /** melonDS's emuDirectory for the official (WIN32_PORTABLE) build. */
  emuDirectory(): string {
    const portable = join(this.paths().app, 'portable');
    return existsSync(portable) ? portable : this.paths().app;
  }

  tomlPath(): string {
    return join(this.emuDirectory(), 'melonDS.toml');
  }

  async findExecutable(appDir: string): Promise<string | null> {
    return findExeIn(appDir, [/^melonDS\.exe$/i, /^melonDS$/]);
  }

  async detectVersion(executable: string): Promise<string | null> {
    // FileVersion/ProductVersion resource is e.g. "1.1" (res/melon.rc.in).
    const v = await fileVersion(executable);
    return v ? v.replace(/^v/, '').trim() : null;
  }

  renderers(hw: HardwareProfile | null): RendererOption[] {
    const gl = hw?.graphicsApis.opengl;
    return [
      { id: 'software', label: 'Software (native resolution, most accurate)', available: true },
      { id: 'opengl', label: 'OpenGL (upscaling)', available: gl !== false, note: gl === false ? 'No OpenGL driver detected; melonDS falls back to software' : undefined },
      { id: 'compute', label: 'OpenGL compute shader (upscaling, needs OpenGL 4.3)', available: gl !== false, note: gl === false ? 'No OpenGL driver detected' : undefined },
    ];
  }

  defaultSettings(hw: HardwareProfile | null, preset: PerformancePreset): EmulatorSettings {
    // DS screens are 256x192; the 480p-based table needs about twice the multiplier.
    const scale = Math.min(8, resolutionScaleFor(hw, preset, this.capabilities.maxResolutionScale) * 2);
    const gl = hw?.graphicsApis.opengl !== false;
    return {
      preset,
      resolutionScale: gl ? scale : 1,
      renderer: gl ? 'opengl' : 'software',
      aspectRatio: 'auto',
      fullscreen: true,
      frameLimit: true,
      vsync: preset !== 'performance',
      advanced: {},
    };
  }

  configTargets(): BackupTarget[] {
    return [{ root: this.paths().app, path: this.tomlPath() }];
  }

  saveDir(): string {
    return join(this.paths().saves, 'saves');
  }

  stateDir(): string {
    return join(this.paths().saves, 'states');
  }

  cheatDir(): string {
    return join(this.paths().data, 'cheats');
  }

  managedPathValues(): [Path, string][] {
    return [
      [P('Instance0.SaveFilePath'), this.saveDir()],
      [P('Instance0.SavestatePath'), this.stateDir()],
      [P('Instance0.CheatFilePath'), this.cheatDir()],
    ];
  }

  graphicsValues(s: EmulatorSettings): Entry[] {
    const scale = Math.max(1, Math.min(this.capabilities.maxResolutionScale, Math.round(s.resolutionScale)));
    const aspect = ASPECTS[s.aspectRatio] ?? ASPECTS.auto;
    return [
      [P('3D.Renderer'), MELONDS_RENDERERS[s.renderer] ?? MELONDS_RENDERERS.software],
      [P('3D.GL.ScaleFactor'), scale],
      [P('Instance0.Window0.ScreenAspectTop'), aspect],
      [P('Instance0.Window0.ScreenAspectBot'), aspect],
      [P('Screen.VSync'), s.vsync],
      [P('LimitFPS'), s.frameLimit],
    ];
  }

  private async loadToml(): Promise<TomlDocument> {
    const file = this.tomlPath();
    if (!existsSync(file)) return TomlDocument.empty();
    return TomlDocument.parse(await readFile(file, 'utf8'));
  }

  /** Locates each BIOS role in BIOS/nds by known names and validates its size. */
  async findBiosFiles(dir = this.paths().bios): Promise<Record<BiosRole, { path: string; size: number; valid: boolean } | null>> {
    const out = { bios7: null, bios9: null, firmware: null } as Record<BiosRole, { path: string; size: number; valid: boolean } | null>;
    if (!existsSync(dir)) return out;
    const files = await readdir(dir).catch(() => [] as string[]);
    for (const role of Object.keys(NDS_BIOS_FILES) as BiosRole[]) {
      const spec = NDS_BIOS_FILES[role];
      for (const name of spec.names) {
        const hit = files.find((f) => f.toLowerCase() === name);
        if (!hit) continue;
        const st = await stat(join(dir, hit)).catch(() => null);
        if (!st?.isFile()) continue;
        const cand = { path: join(dir, hit), size: st.size, valid: (spec.sizes as readonly number[]).includes(st.size) };
        if (!out[role] || (!out[role]!.valid && cand.valid)) out[role] = cand;
        if (cand.valid) break;
      }
    }
    return out;
  }

  /** True when the three files melonDS needs for external BIOS mode are valid (and the firmware is writable). */
  private async biosSetUsable(f: Awaited<ReturnType<MelonDsAdapter['findBiosFiles']>>): Promise<boolean> {
    if (!f.bios7?.valid || !f.bios9?.valid || !f.firmware?.valid) return false;
    // verifyDSFirmware refuses (modal error) a firmware it cannot write back to.
    return access(f.firmware.path, constants.W_OK).then(() => true, () => false);
  }

  private async configuredBiosValid(doc: TomlDocument): Promise<boolean> {
    const check = async (key: string, sizes: readonly number[]) => {
      const v = doc.getTyped(P(key), 'string');
      if (typeof v !== 'string' || !v) return false;
      const full = isAbsolute(v) ? v : join(this.emuDirectory(), v);
      const st = await stat(full).catch(() => null);
      return !!st?.isFile() && sizes.includes(st.size);
    };
    return (await check('DS.BIOS7Path', NDS_BIOS_FILES.bios7.sizes)) && (await check('DS.BIOS9Path', NDS_BIOS_FILES.bios9.sizes)) && (await check('DS.FirmwarePath', NDS_BIOS_FILES.firmware.sizes));
  }

  async applyConfig(input: ConfigInput, scope: 'all' | 'controller' | 'graphics' | 'paths'): Promise<ConfigWriteResult> {
    const p = this.paths();
    for (const d of [p.app, p.data, p.bios, this.saveDir(), this.stateDir(), this.cheatDir()]) await mkdir(d, { recursive: true });
    const notes: string[] = [];
    const file = this.tomlPath();
    const doc = await this.loadToml();
    const changed: string[] = [];
    const set = (path: Path, v: TomlScalar) => {
      if (doc.set(path, v)) changed.push(`${path.join('.')} = ${v}`);
    };

    if (scope === 'all' || scope === 'paths') {
      for (const [k, v] of this.managedPathValues()) set(k, v);
      // Boot the game directly instead of through the firmware menu (also required by FreeBIOS).
      set(P('Emu.DirectBoot'), true);
      const bios = await this.findBiosFiles();
      if (await this.biosSetUsable(bios)) {
        set(P('DS.BIOS7Path'), bios.bios7!.path);
        set(P('DS.BIOS9Path'), bios.bios9!.path);
        set(P('DS.FirmwarePath'), bios.firmware!.path);
        set(P('Emu.ExternalBIOSEnable'), true);
      } else if (doc.getTyped(P('Emu.ExternalBIOSEnable'), 'bool') === true && !(await this.configuredBiosValid(doc))) {
        // Otherwise every boot stops at a modal "BIOS was not found" error (EmuInstance::verifySetup).
        set(P('Emu.ExternalBIOSEnable'), false);
        notes.push('External DS BIOS was enabled but the configured files are missing or invalid; switched back to melonDS\'s built-in FreeBIOS.');
      }
    }
    if (scope === 'all' || scope === 'graphics') {
      for (const [k, v] of this.graphicsValues(input.settings)) set(k, v);
      for (const [key, value] of Object.entries(input.settings.advanced)) {
        // advanced keys are dotted TOML paths, e.g. "3D.GL.BetterPolygons".
        if (/^\w+(\.\w+)*$/.test(key)) set(P(key), value as TomlScalar);
      }
    }
    if (scope === 'all' || scope === 'controller') {
      const c = input.controller;
      set(P('Instance0.JoystickID'), c.deviceIndex);
      const used = new Set<UniversalButton>();
      for (const [ds, logical] of DS_PAD) {
        const phys = logical.map((l) => physicalFor(c, 'nds', l));
        phys.forEach((b) => used.add(b));
        set(['Instance0', 'Joystick', ds], joyCode(...phys));
      }
      // melonDS hotkeys are single inputs (no chords), so only the chord's action
      // button is bound, and only when no DS button already uses it.
      const chords = hotkeyChords(input.hotkeys, this.capabilities.hotkeys);
      const skipped: string[] = [];
      for (const h of chords) {
        const name = HOTKEY_NAMES[h.action as keyof typeof HOTKEY_NAMES];
        if (!name) continue;
        const btn = h.buttons[1];
        const key = ['Instance0', 'Joystick', name];
        if (!used.has(btn)) {
          set(key, joyCode(btn));
          used.add(btn);
        } else {
          skipped.push(`${h.action} (${btn})`);
          if (doc.getTyped(key, 'int') === joyCode(btn)) set(key, -1);
        }
      }
      for (const [name, btn] of DS_EXTRA_HOTKEYS) {
        const key = ['Instance0', 'Joystick', name];
        if (!used.has(btn)) {
          set(key, joyCode(btn));
          used.add(btn);
        } else if (doc.getTyped(key, 'int') === joyCode(btn)) set(key, -1);
      }
      if (skipped.length) notes.push(`melonDS hotkeys cannot be button combinations; these use a button the DS pad already needs and were not bound: ${skipped.join(', ')}.`);
      if (!c.rumble) notes.push('melonDS has no rumble switch; rumble only happens with a Rumble Pak game in Slot-2.');
    }
    if (changed.length || !existsSync(file)) await atomicWrite(file, doc.toString());
    return { changed, notes };
  }

  private resolvePath(value: string): string {
    const v = value.trim();
    if (!v || isAbsolute(v) || /^[a-zA-Z]:[\\/]/.test(v) || v.startsWith('\\\\')) return v;
    return resolve(this.emuDirectory(), v);
  }

  private samePath(a: string, b: string): boolean {
    const n = (s: string) => normalize(s).replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
    return n(a) === n(b);
  }

  async inspectConfig(): Promise<ConfigInspection> {
    const file = this.tomlPath();
    const exists = existsSync(file);
    const text = exists ? await readFile(file, 'utf8').catch(() => '') : '';
    const fmt = exists ? checkToml(text) : { ok: false, issues: ['File does not exist'] };
    if (exists && !fmt.ok) fmt.issues.push('melonDS discards an unreadable melonDS.toml and overwrites it with defaults when it closes.');
    const drift: ConfigInspection['drift'] = [];
    if (exists && fmt.ok) {
      const doc = TomlDocument.parse(text);
      for (const [k, v] of this.managedPathValues()) {
        const actual = doc.getTyped(k, 'string');
        const a = typeof actual === 'string' ? actual : null;
        if (!a || !this.samePath(this.resolvePath(a), v)) {
          drift.push({ file, key: k.join('.'), expected: v, actual: a, critical: k[1] !== 'CheatFilePath' });
        }
      }
      const ext = doc.getTyped(P('Emu.ExternalBIOSEnable'), 'bool') === true;
      const bios = await this.findBiosFiles();
      const usable = await this.biosSetUsable(bios);
      if (ext && !(await this.configuredBiosValid(doc))) {
        drift.push({ file, key: 'Emu.ExternalBIOSEnable', expected: usable ? 'true (BIOS\\nds files)' : 'false', actual: 'true (files missing or invalid)', critical: true });
      } else if (usable) {
        if (!ext) drift.push({ file, key: 'Emu.ExternalBIOSEnable', expected: 'true', actual: 'false', critical: false });
        for (const [key, role] of [['DS.BIOS7Path', 'bios7'], ['DS.BIOS9Path', 'bios9'], ['DS.FirmwarePath', 'firmware']] as const) {
          const actual = doc.getTyped(P(key), 'string');
          if (typeof actual !== 'string' || !this.samePath(this.resolvePath(actual), bios[role]!.path)) {
            drift.push({ file, key, expected: bios[role]!.path, actual: typeof actual === 'string' ? actual : null, critical: false });
          }
        }
      }
      if (doc.getTyped(P('Emu.DirectBoot'), 'bool') === false) drift.push({ file, key: 'Emu.DirectBoot', expected: 'true', actual: 'false', critical: false });
    }
    return { files: [{ label: 'melonDS.toml', path: file, exists, parseOk: exists && fmt.ok, issues: fmt.issues }], drift };
  }

  /** Keeps only options melonDS's QCommandLineParser knows; anything else opens an error box and exits. */
  sanitizeCustomArgs(raw: string): { args: string[]; dropped: string[] } {
    const args: string[] = [];
    const dropped: string[] = [];
    const parts = splitArgs(raw);
    for (let i = 0; i < parts.length; i++) {
      const a = parts[i];
      const eq = /^(--boot|--archive-file|--archive-file-gba)=(.+)$/.exec(a);
      if (KNOWN_FLAGS.has(a)) args.push(a);
      else if (eq && (eq[1] !== '--boot' || /^(auto|always|never)$/.test(eq[2]))) args.push(a);
      else if (KNOWN_PARAM_FLAGS.has(a) && i + 1 < parts.length) {
        const v = parts[++i];
        if ((a === '-b' || a === '--boot') && !/^(auto|always|never)$/.test(v)) dropped.push(a, v);
        else args.push(a, v);
      } else dropped.push(a);
    }
    return { args, dropped };
  }

  async buildLaunch(target: LaunchTarget, executable: string, settings: EmulatorSettings, profile: GameProfile | null, _version: string | null): Promise<LaunchCommand> {
    const args: string[] = [];
    if (settings.fullscreen) args.push('--fullscreen');
    const notes: string[] = ['melonDS has no exit hotkey: close the window (Alt+F4) or stop the game from OmniPC to return.'];
    let prepare: LaunchCommand['prepare'];
    let cleanup: LaunchCommand['cleanup'];
    const overrides = profile ? this.profileOverrides(settings, profile) : [];
    if (overrides.length) {
      const file = this.tomlPath();
      const journal = this.journalPath();
      prepare = async () => {
        if (existsSync(file)) await copyFile(file, journal);
        const doc = await this.loadToml();
        for (const [k, v] of overrides) doc.set(k, v);
        await atomicWrite(file, doc.toString());
      };
      cleanup = async () => {
        if (existsSync(journal)) {
          await copyFile(journal, file);
          await rm(journal, { force: true });
        }
      };
      notes.push(`Per-game profile applied for this session only (${overrides.length} overrides); global settings are restored when the game exits.`);
    }
    if (profile?.customArgs) {
      const { args: extra, dropped } = this.sanitizeCustomArgs(profile.customArgs);
      args.push(...extra);
      if (dropped.length) notes.push(`Ignored custom arguments melonDS does not support (they would open an error dialog): ${dropped.join(' ')}`);
    }
    // First positional argument = Slot-1 (NDS) ROM; -b auto boots it (CLI.cpp).
    args.push(target.path);
    return { command: executable, args, cwd: this.paths().app, logFile: null, prepare, cleanup, notes };
  }

  private journalPath(): string {
    return join(this.paths().data, 'melonDS.toml.omnideck-session');
  }

  profileOverrides(base: EmulatorSettings, profile: GameProfile): Entry[] {
    const merged: EmulatorSettings = { ...base, ...(profile.overrides as Partial<EmulatorSettings>), advanced: {} };
    const o = profile.overrides;
    const g = this.graphicsValues(merged);
    const out: Entry[] = [];
    if (o.renderer !== undefined) out.push(g[0]);
    if (o.resolutionScale !== undefined) out.push(g[1]);
    if (o.aspectRatio !== undefined) out.push(g[2], g[3]);
    if (o.vsync !== undefined) out.push(g[4]);
    if (o.frameLimit !== undefined) out.push(g[5]);
    for (const [key, value] of Object.entries(o.advanced ?? {})) if (/^[\w.]+$/.test(key)) out.push([P(key), value as TomlScalar]);
    return out;
  }

  buildUiLaunch(executable: string): LaunchCommand {
    return { command: executable, args: [], cwd: this.paths().app, logFile: null, notes: [] };
  }

  async smokeTest(executable: string): Promise<SmokeTestResult> {
    const checks: SmokeTestResult['checks'] = [];
    const exeOk = existsSync(executable);
    checks.push({ label: 'Executable present', ok: exeOk, detail: executable });
    if (!exeOk) return { ran: false, ok: false, checks };
    // Config::Load shows "Unable to write to config" when melonDS.toml cannot be written.
    let writable = true;
    try {
      await access(this.emuDirectory(), constants.W_OK);
      if (existsSync(this.tomlPath())) await access(this.tomlPath(), constants.W_OK);
    } catch {
      writable = false;
    }
    checks.push({ label: 'Config folder writable', ok: writable, detail: writable ? this.emuDirectory() : `${this.emuDirectory()} is read-only: melonDS shows an error at startup and cannot save settings` });
    const insp = await this.inspectConfig();
    const cfg = insp.files[0];
    checks.push({ label: 'Configuration parses', ok: !cfg.exists || cfg.parseOk, detail: cfg.exists ? cfg.issues.join('; ') || 'melonDS.toml OK' : 'Not generated yet (melonDS uses defaults)' });
    const bios = insp.drift.find((d) => d.key === 'Emu.ExternalBIOSEnable' && d.critical);
    checks.push({ label: 'BIOS configuration consistent', ok: !bios, detail: bios ? 'External BIOS is enabled but the configured files are missing or invalid: every boot would stop at an error dialog' : 'OK' });
    checks.push({ label: 'Executable starts', ok: true, detail: isWindows ? 'Skipped: melonDS has no non-interactive self-test flag (--help opens a dialog)' : 'Skipped: only possible on Windows' });
    return { ran: false, ok: checks.every((c) => c.ok), checks };
  }

  async validateEnvironment(hw: HardwareProfile | null, _executable: string | null): Promise<Finding[]> {
    const out: Finding[] = [];
    const subject = { kind: 'emulator' as const, id: 'melonds', label: 'melonDS' };
    if (hw && hw.graphicsApis.opengl === false) {
      out.push({
        id: 'melonds.opengl', checkId: 'melonds.gpu', category: 'emulators', severity: 'warning', title: 'No OpenGL driver for melonDS',
        detail: 'melonDS\'s upscaling renderers need OpenGL (3.2, or 4.3 for the compute renderer). Without it melonDS falls back to the software renderer at native resolution.',
        subject, evidence: hw.graphicsApis.notes, confidence: 'medium', repair: null,
        manualSteps: ['Install the latest graphics driver from your GPU vendor.', 'Or pick the Software renderer for melonDS in OmniPC.'],
      });
    }
    if (hw && hw.isWindows === false) {
      out.push({
        id: 'melonds.platform', checkId: 'melonds.platform', category: 'emulators', severity: 'warning', title: 'melonDS Windows build on a non-Windows system',
        detail: 'OmniPC installs the Windows build of melonDS.', subject, evidence: [], confidence: 'high', repair: null, manualSteps: [],
      });
    }
    return out;
  }

  saveLocations(): { label: string; path: string }[] {
    return [
      { label: 'Game saves (.sav)', path: this.saveDir() },
      { label: 'Save states (.ml1-.ml8)', path: this.stateDir() },
    ];
  }

  async biosStatus(): Promise<BiosStatus[]> {
    const dir = this.paths().bios;
    const found = await this.findBiosFiles();
    const files: BiosStatus['files'] = [];
    for (const role of Object.keys(NDS_BIOS_FILES) as BiosRole[]) {
      const f = found[role];
      const spec = NDS_BIOS_FILES[role];
      if (!f) continue;
      const sizes = spec.sizes.map((s) => `${s / 1024} KB`).join(' / ');
      files.push({
        path: f.path, sizeBytes: f.size, valid: f.valid,
        description: f.valid ? `DS ${spec.label}${role === 'firmware' && f.size === 0x20000 ? ' (128 KB: games boot directly, the firmware menu is not bootable)' : ''}` : `Unexpected size ${f.size} bytes for the DS ${spec.label}; melonDS expects ${sizes}`,
      });
    }
    const all = (Object.keys(NDS_BIOS_FILES) as BiosRole[]).every((r) => found[r]?.valid);
    const status: BiosStatus['status'] = all ? 'found' : files.some((f) => !f.valid) ? 'invalid' : 'missing';
    return [{
      systemId: 'nds', systemName: 'Nintendo DS', label: 'DS BIOS and firmware (optional)', required: false, requirementKind: 'bios', emulatorId: 'melonds', expectedLocation: dir,
      status, files,
      note: all
        ? 'melonDS uses these dumps (external BIOS mode). melonDS writes firmware user settings (e.g. Wi-Fi) back into firmware.bin.'
        : 'Optional: melonDS runs games with its built-in FreeBIOS. For best compatibility (and Wi-Fi), place bios7.bin (16 KB), bios9.bin (4 KB) and firmware.bin (128/256/512 KB) dumped from your own DS here; OmniPC enables external BIOS mode only when all three are valid. OmniPC never downloads BIOS files.',
    }];
  }

  logFile(): string | null {
    // The Windows build discards stdout/stderr unless started from a console (main.cpp).
    return null;
  }

  cacheDirs(): { label: string; path: string }[] {
    return [];
  }

  async recoverSession(): Promise<string[]> {
    const journal = this.journalPath();
    if (!existsSync(journal)) return [];
    await mkdir(dirname(this.tomlPath()), { recursive: true });
    await copyFile(journal, this.tomlPath());
    await rm(journal, { force: true });
    return ['Restored melonDS.toml after a per-game session override was interrupted.'];
  }

  async detectExistingSetups(): Promise<SetupImportCandidate[]> {
    const out: SetupImportCandidate[] = [];
    const home = homedir();
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    const installs = [
      'C:\\melonDS', 'C:\\Program Files\\melonDS', join(local, 'Programs', 'melonDS'), join(home, 'melonDS'),
      join(home, 'Documents', 'melonDS'), join(home, 'Desktop', 'melonDS'), join(home, 'Downloads', 'melonDS'),
      join(home, 'scoop', 'apps', 'melonds', 'current'), join(appData, 'EmuDeck', 'Emulators', 'melonDS'),
    ];
    for (const dir of installs) {
      const exe = await this.findExecutable(dir);
      if (!exe) continue;
      const cfgDir = existsSync(join(dir, 'portable')) ? join(dir, 'portable') : dir;
      const c = await this.candidateFromConfigDir(`melonds:${dir}`, `melonDS (${dir})`, cfgDir);
      if (c) {
        c.details.unshift(`Executable: ${exe}`);
        c.importable.useInstallation = true;
        out.push(c);
      } else {
        out.push({ id: `melonds:install:${dir}`, source: 'melonds', label: `melonDS installation (${dir})`, path: dir, details: [`Executable: ${exe}`], importable: { settings: false, saves: false, bios: false, romPaths: false, useInstallation: true }, romPaths: [] });
      }
    }
    // Non-portable builds: QStandardPaths::ConfigLocation + "melonDS" (main.cpp pathInit).
    for (const dir of [join(local, 'melonDS', 'melonDS'), join(local, 'melonDS')]) {
      const c = await this.candidateFromConfigDir(`melonds:config:${dir}`, `melonDS settings (${dir})`, dir);
      if (c) out.push(c);
    }
    return out;
  }

  private async candidateFromConfigDir(id: string, label: string, dir: string): Promise<SetupImportCandidate | null> {
    const toml = join(dir, 'melonDS.toml');
    const ini = join(dir, 'melonDS.ini');
    const res = (v: string | undefined) => (v ? (/^[a-zA-Z]:|^[\\/]/.test(v) ? v : join(dir, v)) : undefined);
    let v: { bios7?: string; saves?: string; states?: string; lastRom?: string; file: string };
    if (existsSync(toml)) {
      const text = await readFile(toml, 'utf8').catch(() => '');
      let doc: TomlDocument;
      try {
        doc = TomlDocument.parse(text);
      } catch {
        return { id, source: 'melonds', label, path: dir, details: [`Settings: ${toml} (unreadable)`], importable: { settings: false, saves: false, bios: false, romPaths: false, useInstallation: false }, romPaths: [] };
      }
      const s = (k: string) => {
        const x = doc.get(P(k));
        return typeof x === 'string' && x ? x : undefined;
      };
      v = { file: toml, bios7: s('DS.BIOS7Path'), saves: s('Instance0.SaveFilePath'), states: s('Instance0.SavestatePath'), lastRom: s('LastROMFolder') };
    } else if (existsSync(ini)) {
      // melonDS < 1.0 (Config.cpp LegacyFile): flat Key=Value lines.
      const kv = new Map<string, string>();
      for (const line of (await readFile(ini, 'utf8').catch(() => '')).split(/\r?\n/)) {
        const m = /^([A-Za-z_0-9]+)=(.*)$/.exec(line);
        if (m && m[2].trim()) kv.set(m[1], m[2].trim());
      }
      v = { file: ini, bios7: kv.get('BIOS7Path'), saves: kv.get('SaveFilePath'), states: kv.get('SavestatePath'), lastRom: kv.get('LastROMFolder') };
    } else return null;
    const saves = res(v.saves);
    const states = res(v.states);
    const biosDir = v.bios7 ? dirname(res(v.bios7)!) : undefined;
    const romPaths = v.lastRom && existsSync(v.lastRom) ? [v.lastRom] : [];
    const saveCopies: NonNullable<SetupImportCandidate['saveCopies']> = [];
    if (saves && existsSync(saves)) saveCopies.push({ from: saves, to: this.saveDir(), label: 'melonDS game saves' });
    if (states && existsSync(states)) saveCopies.push({ from: states, to: this.stateDir(), label: 'melonDS save states' });
    return {
      id, source: 'melonds', label, path: dir,
      details: [
        `Settings: ${v.file}`,
        `Game saves: ${saves ?? 'next to each ROM (melonDS default); copy the .sav files manually'}`,
        `Save states: ${states ?? 'next to each ROM (melonDS default)'}`,
        ...(biosDir ? [`BIOS folder: ${biosDir}`] : []),
      ],
      importable: { settings: true, saves: saveCopies.length > 0, bios: !!biosDir && existsSync(biosDir), romPaths: romPaths.length > 0, useInstallation: false },
      romPaths,
      saveCopies,
      biosDirs: biosDir ? [{ dir: biosDir, systemId: 'nds' }] : [],
    };
  }

  persistentAppPaths(): string[] {
    return [...PORTABLE_FILES];
  }
}

