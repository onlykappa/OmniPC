// Cemu adapter (Wii U).
// On Windows Cemu keeps settings.xml, controller profiles, keys.txt, graphic
// packs, shader caches and (by default) mlc01 in %APPDATA%\Cemu, unless a
// folder named "portable" exists next to Cemu.exe, in which case all of that
// lives in <exe dir>\portable (src/gui/wxgui/CemuApp.cpp DeterminePaths).
// There is no CLI option for the config/user-data folder, so OmniPC uses
// portable mode and redirects the only relocatable data folder, mlc01 (the
// emulated NAND with saves, installed updates and DLC), via settings.xml
// <mlc_path>. Layout:
//   Emulators/cemu/app/portable     settings.xml, controllerProfiles/, keys.txt, graphicPacks/, shaderCache/, log.txt
//                                   (carried across updates via persistentAppPaths)
//   Saves/cemu/mlc01                mlc_path (saves under usr/save)
//   BIOS/wiiu/keys.txt              user-supplied disc keys, copied into portable/keys.txt

import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import type { BiosStatus, EmulatorManifest, EmulatorSettings, Finding, GameProfile, HardwareProfile, PerformancePreset, RendererOption, SetupImportCandidate, UniversalButton } from '@shared/models';
import manifestJson from '../manifests/cemu.json';
import type { AdapterCapabilities, AdapterPaths, ConfigInput, ConfigInspection, ConfigWriteResult, EmulatorAdapter, LaunchCommand, LaunchTarget, SmokeTestResult } from '../adapter';
import type { AppPaths } from '../../core/paths';
import type { BackupTarget } from '../../config/backups';
import { atomicWrite } from '../../config/iniFile';
import { hotkeyChords, physicalFor } from '../../controllers/translate';
import { findExeIn } from '../common';
import { runProcess } from '../../platform/exec';
import { fileVersion, isWindows } from '../../platform/powershell';
import { splitArgs } from '../pcsx2/adapter';
import { child, childElements, element, getText, parseXml, serializeXml, setText, textOf, tryParseXml, type XmlDocument, type XmlElement } from './xml';

export const CEMU_MANIFEST = manifestJson as unknown as EmulatorManifest;

/** <Graphic><api> values (src/config/CemuConfig.h enum GraphicAPI: kOpenGL = 0, kVulkan = 1, kMetal = 2). */
export const CEMU_GRAPHIC_API: Record<string, string> = { opengl: '0', vulkan: '1' };
/** <Graphic><FullscreenScaling> (enum FullscreenScaling: kKeepAspectRatio = 0, kStretch = 1). */
const SCALING: Record<string, string> = { keep: '0', stretch: '1' };

/** Controller button ids (src/input/api/Controller.h enum Buttons2). */
const B = {
  ZL: 32, ZR: 33, Up: 34, Down: 35, Left: 36, Right: 37,
  AxisXP: 38, AxisYP: 39, RotationXP: 40, RotationYP: 41, TriggerXP: 42, TriggerYP: 43,
  AxisXN: 44, AxisYN: 45, RotationXN: 46, RotationYN: 47, TriggerXN: 48, TriggerYN: 49,
} as const;

/**
 * XInput button ids = bit index in XINPUT_GAMEPAD.wButtons (XInputController::raw_state);
 * sticks/triggers are the generic axis ids. XInput reports +Y for stick up
 * (VPADController::set_default_mapping XInput case). The Guide button is not
 * exposed by XInputGetState, so it has no id.
 */
export const XINPUT_IDS: Record<UniversalButton, number | null> = {
  DPadUp: 0, DPadDown: 1, DPadLeft: 2, DPadRight: 3, Start: 4, Select: 5, L3: 6, R3: 7, LB: 8, RB: 9,
  A: 12, B: 13, X: 14, Y: 15, Guide: null,
  LT: B.TriggerXP, RT: B.TriggerYP,
  LeftStickUp: B.AxisYP, LeftStickDown: B.AxisYN, LeftStickLeft: B.AxisXN, LeftStickRight: B.AxisXP,
  RightStickUp: B.RotationYP, RightStickDown: B.RotationYN, RightStickLeft: B.RotationXN, RightStickRight: B.RotationXP,
};

/**
 * SDL3 ids = SDL_GamepadButton values (SDLController::raw_state); SDL reports +Y
 * for stick down (VPADController::set_default_mapping SDL case).
 */
export const SDL_IDS: Record<UniversalButton, number | null> = {
  A: 0, B: 1, X: 2, Y: 3, Select: 4, Guide: 5, Start: 6, L3: 7, R3: 8, LB: 9, RB: 10,
  DPadUp: 11, DPadDown: 12, DPadLeft: 13, DPadRight: 14,
  LT: B.TriggerXP, RT: B.TriggerYP,
  LeftStickUp: B.AxisYN, LeftStickDown: B.AxisYP, LeftStickLeft: B.AxisXN, LeftStickRight: B.AxisXP,
  RightStickUp: B.RotationYN, RightStickDown: B.RotationYP, RightStickLeft: B.RotationXN, RightStickRight: B.RotationXP,
};

/** VPADController::ButtonId (src/input/emulated/VPADController.h) -> logical universal button. */
const VPAD_MAP: [number, UniversalButton][] = [
  [1, 'A'], [2, 'B'], [3, 'X'], [4, 'Y'],
  [5, 'LB'], [6, 'RB'], [7, 'LT'], [8, 'RT'],
  [9, 'Start'], [10, 'Select'],
  [11, 'DPadUp'], [12, 'DPadDown'], [13, 'DPadLeft'], [14, 'DPadRight'],
  [15, 'L3'], [16, 'R3'],
  [17, 'LeftStickUp'], [18, 'LeftStickDown'], [19, 'LeftStickLeft'], [20, 'LeftStickRight'],
  [21, 'RightStickUp'], [22, 'RightStickDown'], [23, 'RightStickLeft'], [24, 'RightStickRight'],
  [27, 'Guide'],
];

/** <Hotkeys> element names (wxCemuConfig::Load) and their default keyboard values (raw uKeyboardHotkey). */
const HOTKEYS = {
  exit: { name: 'ExitApplication', keyboard: 0 },
  fastForward: { name: 'ToggleFastForward', keyboard: 0 },
  screenshot: { name: 'TakeScreenshot', keyboard: 351 }, // WXK_F12
  fullscreen: { name: 'ToggleFullscreen', keyboard: 350 }, // WXK_F11
} as const;

/** Options Cemu's boost::program_options parser knows that OmniPC must own (LaunchSettings::HandleCommandline). */
const RESERVED_WITH_VALUE = new Set(['g', 'game', 't', 'title-id', 'm', 'mlc', 'e', 'extract', 'p', 'path', 'o', 'output']);
const RESERVED_FLAGS = new Set(['h', 'help', 'v', 'version', 'f', 'fullscreen']);

type ControllerApi = { api: 'XInput'; uuid: string; displayName: string } | { api: 'SDLController'; uuid: string; displayName: string };

export class CemuAdapter implements EmulatorAdapter {
  readonly manifest = CEMU_MANIFEST;
  readonly capabilities: AdapterCapabilities = {
    perGameProfiles: 'session',
    frameLimit: false,
    vsync: true,
    aspectRatios: [
      { id: 'keep', label: 'Keep aspect ratio' },
      { id: 'stretch', label: 'Stretch to window' },
    ],
    hotkeys: ['exit', 'fastForward', 'screenshot', 'fullscreen'],
    smokeTest: true,
    maxResolutionScale: 1,
  };

  constructor(private readonly app: AppPaths) {}

  paths(): AdapterPaths {
    return {
      app: this.app.emulatorAppDir('cemu'),
      data: this.app.emulatorDataDir('cemu'),
      saves: this.app.emulatorSaveDir('cemu'),
      bios: this.app.systemBiosDir('wiiu'),
      cache: this.app.emulatorCacheDir('cemu'),
    };
  }

  /** Cemu's user-data = config = cache path in portable mode. */
  portableDir(): string {
    return join(this.paths().app, 'portable');
  }

  settingsPath(): string {
    return join(this.portableDir(), 'settings.xml');
  }

  controllerProfilePath(): string {
    return join(this.portableDir(), 'controllerProfiles', 'controller0.xml');
  }

  mlcPath(): string {
    return join(this.paths().saves, 'mlc01');
  }

  async findExecutable(appDir: string): Promise<string | null> {
    return findExeIn(appDir, [/^Cemu\.exe$/i, /^Cemu$/]);
  }

  async detectVersion(executable: string): Promise<string | null> {
    // ProductVersion is "<major>.<minor>.<patch><suffix>" (src/resource/cemu.rc); releases use patch 0 ("2.6.0" = tag v2.6).
    const v = await fileVersion(executable);
    if (!v) return null;
    return v.replace(/^v/, '').replace(/^(\d+\.\d+)\.0(?=$|[^\d.])/, '$1');
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
      // Cemu has no global internal-resolution setting; resolution comes from per-game graphic packs.
      resolutionScale: 1,
      renderer: hw?.graphicsApis.vulkan === false ? 'opengl' : 'vulkan',
      aspectRatio: 'keep',
      fullscreen: true,
      frameLimit: true,
      vsync: preset !== 'performance',
      advanced: {},
    };
  }

  configTargets(): BackupTarget[] {
    return [
      { root: this.paths().app, path: this.settingsPath() },
      { root: this.paths().app, path: this.controllerProfilePath() },
      { root: this.paths().app, path: join(this.portableDir(), 'keys.txt') },
    ];
  }

  private async loadSettings(): Promise<{ doc: XmlDocument; existed: boolean }> {
    const file = this.settingsPath();
    if (!existsSync(file)) return { doc: { prolog: ['<?xml version="1.0" encoding="UTF-8"?>'], root: element('content') }, existed: false };
    const doc = parseXml(await readFile(file, 'utf8'));
    if (doc.root.name !== 'content') throw new Error(`settings.xml root element is <${doc.root.name}>, expected <content>`);
    return { doc, existed: true };
  }

  /** Managed paths: [xml path below <content>, value]. */
  managedPathValues(): [string[], string][] {
    return [[['mlc_path'], this.mlcPath()]];
  }

  graphicsValues(s: EmulatorSettings): [string[], string][] {
    return [
      [['Graphic', 'api'], CEMU_GRAPHIC_API[s.renderer] ?? CEMU_GRAPHIC_API.vulkan],
      [['Graphic', 'VSync'], s.vsync ? '1' : '0'],
      [['Graphic', 'FullscreenScaling'], SCALING[s.aspectRatio] ?? SCALING.keep],
      [['fullscreen'], s.fullscreen ? 'true' : 'false'],
    ];
  }

  /** Startup prompts suppressed through settings.xml (see manifest assumptions). */
  promptValues(): [string[], string][] {
    return [
      // Update check + "There's a new update available" dialog (MainWindow::LoadSettings / OnTimer).
      [['check_update'], 'false'],
      [['receive_untested_updates'], 'false'],
    ];
  }

  async applyConfig(input: ConfigInput, scope: 'all' | 'controller' | 'graphics' | 'paths'): Promise<ConfigWriteResult> {
    const p = this.paths();
    for (const d of [p.app, p.data, p.saves, p.bios, p.cache, this.portableDir(), join(this.portableDir(), 'controllerProfiles'), this.mlcPath()]) await mkdir(d, { recursive: true });
    const notes: string[] = [];
    const changed: string[] = [];
    const { doc, existed } = await this.loadSettings();
    const root = doc.root;
    let settingsChanged = false;
    const set = (path: string[], v: string) => {
      if (!setText(root, path, v)) return;
      settingsChanged = true;
      changed.push(`${path.join('/')} = ${v}`);
    };
    if (scope === 'all' || scope === 'paths') {
      for (const [path, v] of this.managedPathValues()) set(path, v);
      for (const [path, v] of this.promptValues()) set(path, v);
      notes.push(...(await this.syncKeys(changed)));
    }
    if (scope === 'all' || scope === 'graphics') {
      for (const [path, v] of this.graphicsValues(input.settings)) set(path, v);
      for (const [key, value] of Object.entries(input.settings.advanced)) {
        const path = advancedPath(key);
        if (path) set(path, value);
      }
    }
    let api: ControllerApi | null = null;
    if (scope === 'all' || scope === 'controller') {
      api = await this.controllerApi(input.controller.deviceIndex);
      const ids = api.api === 'XInput' ? XINPUT_IDS : SDL_IDS;
      const chords = hotkeyChords(input.hotkeys, this.capabilities.hotkeys);
      const modifier = chords.length ? ids[chords[0].buttons[0]] : null;
      set(['Hotkeys', 'modifiers'], hotkeyValue(getText(root, ['Hotkeys', 'modifiers']), 0, modifier ?? -1));
      for (const action of this.capabilities.hotkeys) {
        const h = HOTKEYS[action as keyof typeof HOTKEYS];
        const chord = chords.find((c) => c.action === action);
        const id = chord ? ids[chord.buttons[1]] : null;
        set(['Hotkeys', h.name], hotkeyValue(getText(root, ['Hotkeys', h.name]), h.keyboard, modifier === null ? -1 : id ?? -1));
      }
      if (await this.writeControllerProfile(input, api)) changed.push(`controllerProfiles/controller0.xml (${api.api} ${api.uuid})`);
      if (api.api === 'XInput') notes.push(`Wii U GamePad mapped to XInput controller ${api.uuid}. Non-XInput pads (e.g. DualSense) can be assigned in Cemu's Input settings; OmniPC then keeps that SDL device and only updates the button mapping.`);
    }
    // The getting-started wizard runs whenever settings.xml is missing (CemuApp::OnInit isFirstStart),
    // so the file is always written, even for a controller-only change.
    if (settingsChanged || !existed) {
      await atomicWrite(this.settingsPath(), serializeXml(doc));
      if (!existed) notes.push('Created Cemu settings.xml (suppresses the first-start Getting Started wizard).');
    }
    return { changed, notes };
  }

  /**
   * Cemu identifies SDL pads by their GUID ("<n>_<guid>", ControllerFactory::CreateController),
   * which OmniPC cannot know in advance; XInput pads are identified by slot ("0".."3").
   * If the user already picked an SDL pad in Cemu, keep it; otherwise use XInput.
   */
  async controllerApi(deviceIndex: number): Promise<ControllerApi> {
    const file = this.controllerProfilePath();
    if (existsSync(file)) {
      const { doc } = tryParseXml(await readFile(file, 'utf8').catch(() => ''));
      const c = doc ? child(doc.root, 'controller') : null;
      const api = c ? getText(c, ['api']) : null;
      const uuid = c ? getText(c, ['uuid']) : null;
      if (api === 'SDLController' && uuid && /^\d+_[0-9a-fA-F]{32}$/.test(uuid)) {
        return { api: 'SDLController', uuid, displayName: getText(c!, ['display_name']) ?? '' };
      }
    }
    const slot = Math.max(0, Math.min(3, deviceIndex));
    return { api: 'XInput', uuid: String(slot), displayName: `Controller ${slot + 1}` };
  }

  /** Writes controller0.xml in InputManager::save's format. Returns true when the file changed. */
  async writeControllerProfile(input: ConfigInput, api: ControllerApi): Promise<boolean> {
    const c = input.controller;
    const ids = api.api === 'XInput' ? XINPUT_IDS : SDL_IDS;
    const file = this.controllerProfilePath();
    const old = existsSync(file) ? await readFile(file, 'utf8').catch(() => '') : '';
    const prev = old ? tryParseXml(old).doc : null;
    const toggle = prev ? getText(prev.root, ['toggle_display']) : null;
    const leaf = (name: string, v: string) => element(name, [{ type: 'text', value: v }]);
    const dz = c.deadzone.toFixed(2);
    const mappings = element('mappings');
    for (const [vpadId, logical] of VPAD_MAP) {
      const id = ids[physicalFor(c, 'wiiu', logical)];
      if (id === null || id === undefined) continue;
      mappings.children.push(element('entry', [leaf('mapping', String(vpadId)), leaf('button', String(id))]));
    }
    const ctrl = element('controller', [
      leaf('api', api.api),
      leaf('uuid', api.uuid),
      leaf('display_name', api.displayName),
      leaf('rumble', c.rumble ? '1' : '0'),
      element('axis', [leaf('deadzone', dz), leaf('range', '1')]),
      element('rotation', [leaf('deadzone', dz), leaf('range', '1')]),
      element('trigger', [leaf('deadzone', '0.15'), leaf('range', '1')]),
      mappings,
    ]);
    const root = element('emulated_controller', [leaf('type', 'Wii U GamePad'), leaf('toggle_display', toggle || '0'), ctrl]);
    const text = serializeXml({ prolog: ['<?xml version="1.0" encoding="UTF-8"?>'], root });
    if (text === old) return false;
    await atomicWrite(file, text);
    return true;
  }

  /**
   * Copies user-supplied keys from BIOS/wiiu into portable/ (Cemu reads keys.txt,
   * otp.bin and seeprom.bin only from its user-data folder). Invalid key lines are
   * commented out because each one would pop an error dialog (KeyCache.cpp).
   * Keys already present only in Cemu's own keys.txt are kept.
   */
  async syncKeys(changed: string[] = []): Promise<string[]> {
    const notes: string[] = [];
    const bios = this.paths().bios;
    const src = join(bios, 'keys.txt');
    const dst = join(this.portableDir(), 'keys.txt');
    if (existsSync(src)) {
      const parsed = parseKeys(await readFile(src, 'utf8'));
      const existing = existsSync(dst) ? await readFile(dst, 'utf8').catch(() => '') : '';
      const extra = parseKeys(existing).keys.filter((k) => !parsed.keys.includes(k) && k !== EXAMPLE_KEY);
      let out = parsed.sanitized;
      if (extra.length) out += `${out.endsWith('\n') ? '' : '\r\n'}# keys that were only in Cemu's own keys.txt (kept by OmniPC)\r\n${extra.join('\r\n')}\r\n`;
      if (out !== existing) {
        await atomicWrite(dst, out);
        changed.push(`keys.txt (${parsed.keys.length} keys from ${src})`);
      }
      if (parsed.invalidLines.length) notes.push(`keys.txt: ignored invalid line(s) ${parsed.invalidLines.join(', ')}; each would show an error dialog in Cemu.`);
    }
    for (const [name, size] of [['otp.bin', 1024], ['seeprom.bin', 512]] as const) {
      const s = join(bios, name);
      const st = await stat(s).catch(() => null);
      if (!st?.isFile() || st.size !== size) continue;
      const d = join(this.portableDir(), name);
      const dst2 = await stat(d).catch(() => null);
      if (dst2 && dst2.size === size && (await readFile(d)).equals(await readFile(s))) continue;
      await mkdir(this.portableDir(), { recursive: true });
      await copyFile(s, d);
      changed.push(`${name} copied from ${bios}`);
    }
    return notes;
  }

  private samePath(a: string, b: string): boolean {
    const n = (s: string) => normalize(s).replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
    return n(a) === n(b);
  }

  async inspectConfig(): Promise<ConfigInspection> {
    const file = this.settingsPath();
    const exists = existsSync(file);
    const text = exists ? await readFile(file, 'utf8').catch(() => '') : '';
    const parsed = exists ? tryParseXml(text) : { doc: null, issues: ['File does not exist'] };
    if (parsed.doc && parsed.doc.root.name !== 'content') parsed.issues.push(`Root element is <${parsed.doc.root.name}>, expected <content>`);
    const ok = !!parsed.doc && parsed.issues.length === 0;
    const drift: ConfigInspection['drift'] = [];
    if (!exists) {
      drift.push({ file, key: 'settings.xml', expected: 'present', actual: null, critical: true });
    } else if (ok) {
      const root = parsed.doc!.root;
      for (const [path, v] of this.managedPathValues()) {
        const actual = getText(root, path);
        if (!actual || !this.samePath(actual, v)) drift.push({ file, key: path.join('/'), expected: v, actual, critical: true });
      }
      if (getText(root, ['check_update']) !== 'false') drift.push({ file, key: 'check_update', expected: 'false', actual: getText(root, ['check_update']), critical: false });
    }
    const files: ConfigInspection['files'] = [{ label: 'settings.xml', path: file, exists, parseOk: ok, issues: parsed.issues }];
    const cp = this.controllerProfilePath();
    if (existsSync(cp)) {
      const r = tryParseXml(await readFile(cp, 'utf8').catch(() => ''));
      files.push({ label: 'Controller profile (controller0.xml)', path: cp, exists: true, parseOk: !!r.doc, issues: r.issues });
    }
    if (existsSync(this.paths().app) && !existsSync(this.portableDir())) {
      drift.push({ file: this.portableDir(), key: 'portable folder', expected: 'present', actual: null, critical: true });
    }
    return { files, drift };
  }

  /** Drops options OmniPC controls; boost would reject a repeated option and exit. Unknown options are ignored by Cemu (allow_unregistered). */
  sanitizeCustomArgs(raw: string): { args: string[]; dropped: string[] } {
    const args: string[] = [];
    const dropped: string[] = [];
    const parts = splitArgs(raw);
    for (let i = 0; i < parts.length; i++) {
      const a = parts[i];
      const m = /^-{1,2}([A-Za-z][\w-]*)(=.*)?$/.exec(a);
      const name = m?.[1].toLowerCase();
      if (name && RESERVED_WITH_VALUE.has(name)) {
        dropped.push(a);
        if (!m![2] && i + 1 < parts.length && !parts[i + 1].startsWith('-')) dropped.push(parts[++i]);
      } else if (name && RESERVED_FLAGS.has(name)) dropped.push(a);
      else args.push(a);
    }
    return { args, dropped };
  }

  async buildLaunch(target: LaunchTarget, executable: string, settings: EmulatorSettings, profile: GameProfile | null, _version: string | null): Promise<LaunchCommand> {
    const args: string[] = [];
    const notes: string[] = [];
    const merged = profile ? { ...settings, ...(profile.overrides as Partial<EmulatorSettings>) } : settings;
    if (merged.fullscreen) args.push('-f');
    if (profile?.customArgs) {
      const { args: extra, dropped } = this.sanitizeCustomArgs(profile.customArgs);
      args.push(...extra);
      if (dropped.length) notes.push(`Ignored custom arguments OmniPC controls (game path, mlc path, fullscreen, version/help/extract): ${dropped.join(' ')}`);
    }
    // -g quick-launches the game without the game list; closing the window exits Cemu (MainWindow ctor).
    args.push('-g', target.path);
    const overrides = profile ? this.profileOverrides(settings, profile) : [];
    const journal = this.journalPath();
    const prepare = async () => {
      await this.syncKeys().catch(() => []);
      if (!overrides.length) return;
      const { doc } = await this.loadSettings();
      const original: Record<string, string | null> = {};
      for (const [path, v] of overrides) {
        original[path.join('/')] = getText(doc.root, path);
        setText(doc.root, path, v);
      }
      await atomicWrite(journal, JSON.stringify(original));
      await atomicWrite(this.settingsPath(), serializeXml(doc));
    };
    const cleanup = overrides.length ? async () => void (await this.restoreJournal()) : undefined;
    if (overrides.length) notes.push(`Per-game profile applied for this session only (${overrides.length} overrides); the overridden settings.xml values are restored when Cemu exits.`);
    return { command: executable, args, targetArgs: 2, cwd: dirname(executable), logFile: this.logFile(), prepare, cleanup, notes };
  }

  private journalPath(): string {
    // Kept outside the app dir so an update during a crashed session cannot lose it.
    return join(this.paths().data, 'settings.xml.omnideck-session.json');
  }

  /**
   * Cemu rewrites settings.xml on exit (MainWindow::OnClose -> SaveSettings), so instead of
   * copying a whole snapshot back (losing play time etc.), only the overridden values are restored.
   */
  private async restoreJournal(): Promise<boolean> {
    const journal = this.journalPath();
    if (!existsSync(journal)) return false;
    let original: Record<string, string | null> = {};
    try {
      original = JSON.parse(await readFile(journal, 'utf8')) as Record<string, string | null>;
    } catch {
      original = {};
    }
    if (existsSync(this.settingsPath())) {
      const { doc } = await this.loadSettings();
      for (const [key, value] of Object.entries(original)) {
        const path = key.split('/');
        if (value === null) removeElement(doc.root, path);
        else setText(doc.root, path, value);
      }
      await atomicWrite(this.settingsPath(), serializeXml(doc));
    }
    await rm(journal, { force: true });
    return true;
  }

  profileOverrides(base: EmulatorSettings, profile: GameProfile): [string[], string][] {
    const o = profile.overrides;
    const merged: EmulatorSettings = { ...base, ...(o as Partial<EmulatorSettings>), advanced: {} };
    const g = this.graphicsValues(merged);
    const out: [string[], string][] = [];
    if (o.renderer !== undefined) out.push(g[0]);
    if (o.vsync !== undefined) out.push(g[1]);
    if (o.aspectRatio !== undefined) out.push(g[2]);
    for (const [key, value] of Object.entries(o.advanced ?? {})) {
      const path = advancedPath(key);
      if (path) out.push([path, value]);
    }
    return out;
  }

  buildUiLaunch(executable: string): LaunchCommand {
    return { command: executable, args: [], cwd: dirname(executable), logFile: this.logFile(), notes: [] };
  }

  async smokeTest(executable: string): Promise<SmokeTestResult> {
    const checks: SmokeTestResult['checks'] = [];
    const appDir = dirname(executable);
    checks.push({ label: 'Executable present', ok: existsSync(executable), detail: executable });
    if (!existsSync(executable)) return { ran: true, ok: false, checks };
    // The release zip ships resources/ (translations, sharedFonts) and gameProfiles/default next to Cemu.exe
    // (.github/workflows/deploy_release.yml copies ./bin); the data path is always the exe folder.
    const fonts = join(appDir, 'resources', 'sharedFonts');
    checks.push({ label: 'Resources present', ok: existsSync(fonts), detail: existsSync(fonts) ? fonts : `${fonts} is missing; the Cemu folder is incomplete` });
    const portable = existsSync(join(appDir, 'portable'));
    checks.push({ label: 'Portable mode active', ok: portable, detail: portable ? 'portable folder next to Cemu.exe' : 'portable folder missing: Cemu would use %APPDATA%\\Cemu' });
    const insp = await this.inspectConfig();
    const cfg = insp.files[0];
    checks.push({ label: 'Configuration parses', ok: cfg.parseOk, detail: cfg.issues.join('; ') || 'settings.xml OK' });
    checks.push({ label: 'First-start wizard suppressed', ok: cfg.exists, detail: cfg.exists ? 'settings.xml exists' : 'settings.xml missing: the Getting Started dialog would block the launch' });
    if (!isWindows) {
      checks.push({ label: 'Executable starts (--version)', ok: true, detail: 'Skipped: only possible on Windows' });
      return { ran: false, ok: checks.every((c) => c.ok), checks };
    }
    // --version prints the version to stdout and exits with code 0 before any paths or settings are touched.
    const r = await runProcess(executable, ['--version'], { timeoutMs: 20000, cwd: appDir });
    const out = `${r.stdout}${r.stderr}`.trim();
    const ok = !r.error && !r.timedOut && /\d+\.\d+/.test(out);
    checks.push({
      label: 'Executable starts (--version)',
      ok,
      detail: r.error ? r.error.message : r.timedOut ? 'Timed out after 20s' : ok ? `Cemu ${out.split(/\r?\n/)[0]}` : `Exit code ${r.code}, no version output${out ? `: ${out.slice(-300)}` : ''}`,
    });
    return { ran: true, ok: checks.every((c) => c.ok), checks };
  }

  async validateEnvironment(hw: HardwareProfile | null, _executable: string | null): Promise<Finding[]> {
    const out: Finding[] = [];
    if (hw && hw.isWindows === false) {
      out.push({
        id: 'cemu.platform', checkId: 'cemu.platform', category: 'emulators', severity: 'warning', title: 'Cemu Windows build on a non-Windows system',
        detail: 'OmniPC installs the Windows build of Cemu.', subject: { kind: 'emulator', id: 'cemu', label: 'Cemu' },
        evidence: [], confidence: 'high', repair: null, manualSteps: [],
      });
    }
    if (hw && hw.graphicsApis.vulkan === false) {
      out.push({
        id: 'cemu.vulkan', checkId: 'cemu.graphics', category: 'graphics', severity: 'info', title: 'Cemu will use OpenGL',
        detail: 'No Vulkan driver was detected. Cemu falls back to OpenGL, which is slower and compiles shaders with more stutter.',
        subject: { kind: 'emulator', id: 'cemu', label: 'Cemu' }, evidence: [], confidence: 'medium', repair: null,
        manualSteps: ['Update the graphics driver to get Vulkan support.'],
      });
    }
    return out;
  }

  saveLocations(): { label: string; path: string }[] {
    return [{ label: 'Wii U saves (mlc01/usr/save)', path: join(this.mlcPath(), 'usr', 'save') }];
  }

  async biosStatus(): Promise<BiosStatus[]> {
    const dir = this.paths().bios;
    const keysFile = join(dir, 'keys.txt');
    const files: BiosStatus['files'] = [];
    let status: BiosStatus['status'] = 'missing';
    let note = 'Only needed for encrypted disc images (.wud/.wux). Put a keys.txt with the disc keys dumped from your own Wii U/games (one 32-digit hex key per line) in this folder. Decrypted dumps (.wua, .rpx folders, .wuhb) need no keys. OmniPC never downloads keys.';
    const st = await stat(keysFile).catch(() => null);
    if (st?.isFile()) {
      const parsed = parseKeys(await readFile(keysFile, 'utf8'));
      const valid = parsed.keys.length > 0 && parsed.invalidLines.length === 0;
      status = parsed.keys.length ? (valid ? 'found' : 'invalid') : 'invalid';
      files.push({
        path: keysFile, sizeBytes: st.size, valid,
        description: parsed.keys.length
          ? `${parsed.keys.length} key(s)${parsed.invalidLines.length ? `; invalid line(s) ${parsed.invalidLines.join(', ')} are ignored` : ''}`
          : 'No 32-digit hex keys found',
      });
      note = valid ? 'OmniPC copies keys.txt into Cemu\'s folder before every launch. Cemu picks the matching key automatically.' : 'keys.txt must contain one 32-digit hex key per line (text after # is a comment).';
    }
    for (const [name, size] of [['otp.bin', 1024], ['seeprom.bin', 512]] as const) {
      const f = join(dir, name);
      const s = await stat(f).catch(() => null);
      if (s?.isFile()) files.push({ path: f, sizeBytes: s.size, valid: s.size === size, description: s.size === size ? `${name} (optional, online play)` : `${name} must be ${size} bytes` });
    }
    return [{
      systemId: 'wiiu', systemName: 'Wii U', label: 'Wii U disc keys (keys.txt)', required: false, requirementKind: 'keys', emulatorId: 'cemu',
      expectedLocation: dir, status, files, note,
    }];
  }

  logFile(): string | null {
    return join(this.portableDir(), 'log.txt');
  }

  cacheDirs(): { label: string; path: string }[] {
    // ActiveSettings::GetCachePath = portable folder; Cemu offers no setting to move it.
    return [{ label: 'Shader cache', path: join(this.portableDir(), 'shaderCache') }];
  }

  async recoverSession(): Promise<string[]> {
    return (await this.restoreJournal()) ? ['Restored Cemu settings.xml values after a per-game session override was interrupted.'] : [];
  }

  async detectExistingSetups(): Promise<SetupImportCandidate[]> {
    const out: SetupImportCandidate[] = [];
    const roaming = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    const roamingDir = join(roaming, 'Cemu');
    if (existsSync(join(roamingDir, 'settings.xml'))) out.push(await this.candidateFromConfigDir('cemu:appdata', 'Cemu (%APPDATA%\\Cemu)', roamingDir));
    // Installer default (src/resource/installer.nsi InstallDir) and common manual locations.
    for (const dir of [join(local, 'Cemu'), 'C:\\Cemu', join(homedir(), 'Cemu')]) {
      const exe = await this.findExecutable(dir);
      if (!exe) continue;
      // Portable folder wins, then a legacy settings.xml next to the exe (CemuApp::DeterminePaths).
      const cfgDir = existsSync(join(dir, 'portable')) ? join(dir, 'portable') : existsSync(join(dir, 'settings.xml')) ? dir : null;
      if (cfgDir) {
        const c = await this.candidateFromConfigDir(`cemu:portable:${dir}`, `Cemu portable installation (${dir})`, cfgDir);
        c.details.unshift(`Executable: ${exe}`);
        c.importable.useInstallation = true;
        out.push(c);
      } else {
        out.push({ id: `cemu:install:${dir}`, source: 'cemu', label: `Cemu installation (${dir})`, path: dir, details: [`Executable: ${exe}`], importable: { settings: false, saves: false, bios: false, romPaths: false, useInstallation: true }, romPaths: [] });
      }
    }
    return out;
  }

  private async candidateFromConfigDir(id: string, label: string, dir: string): Promise<SetupImportCandidate> {
    const file = join(dir, 'settings.xml');
    const { doc } = tryParseXml(existsSync(file) ? await readFile(file, 'utf8').catch(() => '') : '');
    const root = doc?.root ?? null;
    const mlc = (root && getText(root, ['mlc_path'])) || join(dir, 'mlc01');
    const gamePaths = root ? gamePathEntries(root) : [];
    const romPaths = gamePaths.filter((v) => existsSync(v));
    const saves = join(mlc, 'usr', 'save');
    return {
      id, source: 'cemu', label, path: dir,
      details: [`Settings: ${file}`, `mlc01: ${mlc}`, `Game paths: ${gamePaths.join('; ') || 'none'}`],
      importable: { settings: !!root, saves: existsSync(saves), bios: existsSync(join(dir, 'keys.txt')), romPaths: romPaths.length > 0, useInstallation: false },
      romPaths,
    };
  }

  async prepareInstall(appDir: string): Promise<string[]> {
    const dir = join(appDir, 'portable');
    if (existsSync(dir)) return [];
    await mkdir(dir, { recursive: true });
    return ['Enabled Cemu portable mode (portable folder) so its settings stay inside the OmniPC folder.'];
  }

  persistentAppPaths(): string[] {
    // Everything Cemu writes (settings, controller profiles, keys, graphic packs, shader cache,
    // game profiles, accounts' mlc if mlc_path is ever reset) lives in portable/.
    return ['portable'];
  }
}

/** "Graphic/AsyncCompile" or "Graphic|AsyncCompile" -> ['Graphic', 'AsyncCompile'] below <content>. */
function advancedPath(key: string): string[] | null {
  const parts = key.split(/[/|]/).map((s) => s.trim());
  return parts.length && parts.every((s) => /^[A-Za-z_][\w.-]*$/.test(s)) ? parts : null;
}

/** sHotkeyCfg is stored as "<keyboard raw> <controller button id>" (wxCemuConfig.h); keeps the user's keyboard part. */
function hotkeyValue(existing: string | null, defaultKeyboard: number, controller: number): string {
  const kb = existing && /^-?\d+/.test(existing) ? existing.split(/\s+/)[0] : String(defaultKeyboard);
  return `${kb} ${controller}`;
}

function removeElement(root: XmlElement, path: string[]): void {
  const parent = path.length > 1 ? path.slice(0, -1).reduce<XmlElement | null>((el, p) => (el ? child(el, p) : null), root) : root;
  if (!parent) return;
  const target = child(parent, path[path.length - 1]);
  if (target) parent.children = parent.children.filter((c) => c !== target);
}

/** <GamePaths><Entry>path</Entry>... (CemuConfig::Load). */
export function gamePathEntries(root: XmlElement): string[] {
  const gp = child(root, 'GamePaths');
  return gp ? childElements(gp, 'Entry').map(textOf).filter(Boolean) : [];
}

const EXAMPLE_KEY = '541b9889519b27d363cd21604b97c67a';

/** Parses keys.txt like KeyCache_Prepare: text after '#' or ';' is a comment, ' \t-_' are stripped, 32 hex chars per key. */
export function parseKeys(text: string): { keys: string[]; invalidLines: number[]; sanitized: string } {
  const keys: string[] = [];
  const invalidLines: number[] = [];
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  lines.forEach((raw, idx) => {
    const cut = raw.search(/[#;]/);
    const body = (cut >= 0 ? raw.slice(0, cut) : raw).replace(/[ \t\-_]/g, '');
    if (!body) {
      out.push(raw);
      return;
    }
    if (/^[0-9a-fA-F]+$/.test(body)) {
      // Non-hex lines show an error dialog; hex lines of the wrong length are silently skipped by Cemu.
      if (body.length === 32) keys.push(body.toLowerCase());
      out.push(raw);
      return;
    }
    invalidLines.push(idx + 1);
    out.push(`# ${raw.replace(/[#;]/g, '')} (invalid, disabled by OmniPC)`);
  });
  let sanitized = out.join('\r\n');
  if (sanitized && !sanitized.endsWith('\n')) sanitized += '\r\n';
  return { keys, invalidLines, sanitized };
}
