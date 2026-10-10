// Xenia Canary adapter (Xbox 360).
// Layout (all passed on the command line, src/xenia/app/xenia_main.cc OnInitialize):
//   Emulators/xenia/app                       xenia_canary.exe + LICENSE (replaced on update)
//   Emulators/xenia/data                      --storage_root: xenia-canary.config.toml, config/<TITLEID>.config.toml
//                                             (Xenia's own per-game configs), patches/, plugins/, xconfig.settings,
//                                             recent.toml, cache/ cache0/ cache1/ (guest cache partitions)
//   Emulators/xenia/data/logs/xenia.log       --log_file
//   Saves/xenia                               --content_root: <XUID>/<TitleID>/00000001 saves, profiles
//                                             (<XUID>/FFFE07D1/00010000), installed DLC/title updates
//   Cache/xenia                               --cache_root: host shader/pipeline storage
//   BIOS/x360                                 unused (Xenia needs no firmware)

import { existsSync } from 'node:fs';
import { mkdir, open, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BiosStatus, EmulatorManifest, EmulatorSettings, Finding, GameProfile, HardwareProfile, PerformancePreset, RendererOption, SetupImportCandidate } from '@shared/models';
import manifestJson from '../manifests/xenia.json';
import type { AdapterCapabilities, AdapterPaths, ConfigInput, ConfigInspection, ConfigWriteResult, EmulatorAdapter, LaunchCommand, LaunchTarget, SmokeTestResult } from '../adapter';
import type { AppPaths } from '../../core/paths';
import type { BackupTarget } from '../../config/backups';
import { atomicWrite } from '../../config/iniFile';
import { UNIVERSAL_BUTTONS, physicalFor } from '../../controllers/translate';
import { findExeIn, resolutionScaleFor } from '../common';
import { isWindows } from '../../platform/powershell';
import { splitArgs } from '../pcsx2/adapter';
import { TomlDocument, checkToml, type TomlValue } from './toml';

export const XENIA_MANIFEST = manifestJson as unknown as EmulatorManifest;

/** Global config file name (src/xenia/config.cc config::config_name). */
export const XENIA_CONFIG_NAME = 'xenia-canary.config.toml';

/**
 * cvar::IConfigVarUpdate::kLastCommittedUpdateDate at the verified commit (base/cvar.h).
 * Written as [Config] defaults_date into a config OmniDeck creates: without it Xenia
 * treats the file as ancient and resets every cvar with an UPDATE_from_* history
 * (config.cc ReadConfig -> ApplyUpdates(0)).
 */
export const XENIA_DEFAULTS_DATE = 2026040912;

/** Max integer draw resolution scale per axis is 7 (gpu/texture_cache.h); >3 needs huge VRAM. */
const MAX_SCALE = 3;

/** One managed cvar: [category (TOML table), name, value]. */
export type XeniaValue = [table: string, key: string, value: TomlValue];

export class XeniaAdapter implements EmulatorAdapter {
  readonly manifest = XENIA_MANIFEST;
  readonly capabilities: AdapterCapabilities = {
    perGameProfiles: 'native',
    frameLimit: true,
    vsync: true,
    aspectRatios: [
      { id: 'auto', label: 'Keep aspect ratio (letterbox)' },
      { id: 'stretch', label: 'Stretch to window' },
    ],
    // Xenia's controller hotkeys are a fixed Guide+button table (app/emulator_window.cc
    // controller_hotkey_map) behind the controller_hotkeys cvar; none can be rebound.
    hotkeys: [],
    smokeTest: true,
    maxResolutionScale: MAX_SCALE,
  };

  constructor(private readonly app: AppPaths) {}

  paths(): AdapterPaths {
    return {
      app: this.app.emulatorAppDir('xenia'),
      data: this.app.emulatorDataDir('xenia'),
      saves: this.app.emulatorSaveDir('xenia'),
      bios: this.app.systemBiosDir('x360'),
      cache: this.app.emulatorCacheDir('xenia'),
    };
  }

  configPath(): string {
    return join(this.paths().data, XENIA_CONFIG_NAME);
  }

  logPath(): string {
    return join(this.paths().data, 'logs', 'xenia.log');
  }

  /** Xenia's own per-title config folder (config.cc LoadGameConfig: <storage_root>/config/<TITLEID>.config.toml). */
  gameConfigDir(): string {
    return join(this.paths().data, 'config');
  }

  async findExecutable(appDir: string): Promise<string | null> {
    return findExeIn(appDir, [/^xenia_canary\.exe$/i, /^xenia_canary$/, /^xenia\.exe$/i]);
  }

  /**
   * xenia_canary.exe has no VERSIONINFO resource (app/main_resources.rc only holds the icon)
   * and no flag that prints a version and exits (--help shows a message box on GUI launches),
   * so the installed version is the release OmniDeck installed.
   */
  async detectVersion(_executable: string): Promise<string | null> {
    return null;
  }

  renderers(hw: HardwareProfile | null): RendererOption[] {
    const dx = hw?.graphicsApis.directx12;
    const vk = hw?.graphicsApis.vulkan;
    return [
      { id: 'd3d12', label: 'Direct3D 12 (recommended)', available: dx !== false, note: dx === false ? 'Direct3D 12 needs Windows 10 and a feature level 11_0 GPU' : undefined },
      { id: 'vulkan', label: 'Vulkan', available: vk !== false, note: vk === false ? 'No Vulkan driver detected' : undefined },
    ];
  }

  defaultSettings(hw: HardwareProfile | null, preset: PerformancePreset): EmulatorSettings {
    // Xbox 360 games render at ~720p; resolutionScaleFor assumes ~480p, so 2/3 gives the same output size.
    const scale = Math.max(1, Math.min(MAX_SCALE, Math.round((resolutionScaleFor(hw, preset, 6) * 2) / 3)));
    return {
      preset,
      resolutionScale: scale,
      // Upstream's "any" order tries D3D12 first on Windows (xenia_main.cc CreateGraphicsSystem).
      renderer: hw && hw.graphicsApis.directx12 === false && hw.graphicsApis.vulkan !== false ? 'vulkan' : 'd3d12',
      aspectRatio: 'auto',
      fullscreen: true,
      frameLimit: true,
      vsync: true,
      advanced: {},
    };
  }

  configTargets(): BackupTarget[] {
    return [{ root: this.paths().data, path: this.configPath() }];
  }

  private async ensureDirs(): Promise<void> {
    const p = this.paths();
    for (const d of [p.data, join(p.data, 'logs'), this.gameConfigDir(), p.saves, p.cache, p.bios]) await mkdir(d, { recursive: true });
  }

  /** Forward slashes, as Xenia stores paths (base/cvar.h CommandVar<path>::ToString). */
  static tomlPath(p: string): string {
    return p.replace(/\\/g, '/');
  }

  /** Storage cvars + settings that keep launches free of side effects. */
  pathValues(): XeniaValue[] {
    const p = this.paths();
    return [
      ['Storage', 'content_root', XeniaAdapter.tomlPath(p.saves)],
      ['Storage', 'cache_root', XeniaAdapter.tomlPath(p.cache)],
      // Discord rich presence (app/xenia_main.cc, default true): no dialog, but a network side effect.
      ['General', 'discord', false],
    ];
  }

  graphicsValues(s: EmulatorSettings): XeniaValue[] {
    const scale = Math.max(1, Math.min(MAX_SCALE, Math.round(Number.isFinite(s.resolutionScale) ? s.resolutionScale : 1)));
    return [
      ['GPU', 'gpu', s.renderer === 'vulkan' ? 'vulkan' : 'd3d12'],
      ['GPU', 'draw_resolution_scale_x', scale],
      ['GPU', 'draw_resolution_scale_y', scale],
      ['GPU', 'vsync', s.vsync],
      // 0 = unlimited (gpu/gpu_flags.cc framerate_limit); with vsync on Xenia caps at 60 anyway.
      ['GPU', 'framerate_limit', s.frameLimit ? 60 : 0],
      ['Display', 'fullscreen', s.fullscreen],
      ['Display', 'present_letterbox', s.aspectRatio !== 'stretch'],
    ];
  }

  /**
   * settings.advanced: "Category|cvar" -> value. Types are inferred (true/false, integer,
   * decimal); wrap a value in single quotes to force a string. A wrong type makes Xenia
   * reset the cvar and show a warning box (config.cc ReadConfig), so only use known cvars.
   */
  advancedValues(adv: Record<string, string>): XeniaValue[] {
    const out: XeniaValue[] = [];
    for (const [k, raw] of Object.entries(adv ?? {})) {
      const [table, key] = k.split('|');
      if (!table || !key || !/^[A-Za-z0-9_]+$/.test(key)) continue;
      out.push([table, key, inferValue(String(raw))]);
    }
    return out;
  }

  controllerValues(input: ConfigInput): { values: XeniaValue[]; notes: string[] } {
    const c = input.controller;
    const notes: string[] = [];
    // hid=xinput -> XInput + keyboard; hid=any skips XInput and uses SDL + keyboard (xenia_main.cc CreateAll).
    const hid = c.controllerKind === 'xbox' ? 'xinput' : 'sdl';
    const dz = Math.round(Math.max(0, Math.min(0.99, c.deadzone)) * 100) / 100;
    const values: XeniaValue[] = [
      ['HID', 'hid', hid],
      ['HID', 'vibration', c.rumble],
      ['HID', 'left_stick_deadzone_percentage', { float: dz }],
      ['HID', 'right_stick_deadzone_percentage', { float: dz }],
    ];
    const remapped = UNIVERSAL_BUTTONS.filter((b) => physicalFor(c, 'x360', b) !== b);
    if (remapped.length) notes.push(`Xenia has no gamepad button remapping, so the remapped buttons (${remapped.join(', ')}) keep their standard Xbox 360 layout. Use Steam Input to remap them.`);
    if (c.deviceIndex !== 0) notes.push('Xenia assigns players in controller connection order (XInput slot / SDL device order); it has no setting to pick a specific controller for player 1.');
    if (hid === 'sdl') notes.push('Non-Xbox controllers use Xenia\'s SDL input driver with the standard Xbox layout (South = A).');
    return { values, notes };
  }

  async readConfig(): Promise<TomlDocument | null> {
    if (!existsSync(this.configPath())) return null;
    return TomlDocument.parse(await readFile(this.configPath(), 'utf8').catch(() => ''));
  }

  async applyConfig(input: ConfigInput, scope: 'all' | 'controller' | 'graphics' | 'paths'): Promise<ConfigWriteResult> {
    await this.ensureDirs();
    const path = this.configPath();
    const existed = existsSync(path);
    const notes: string[] = [];
    let doc = existed ? TomlDocument.parse(await readFile(path, 'utf8')) : TomlDocument.empty();
    if (existed && doc.issues.length) {
      notes.push(`${XENIA_CONFIG_NAME} could not be parsed (${doc.issues[0]}) and was regenerated; the previous file is kept in the configuration backup.`);
      doc = TomlDocument.empty();
    }
    const changed: string[] = [];
    // A file OmniDeck creates (or regenerates) gets the defaults version Xenia expects.
    if (doc.toString() === '' && doc.set('Config', 'defaults_date', XENIA_DEFAULTS_DATE)) changed.push(`Config.defaults_date = ${XENIA_DEFAULTS_DATE}`);
    const values: XeniaValue[] = [];
    if (scope === 'all' || scope === 'paths') values.push(...this.pathValues());
    if (scope === 'all' || scope === 'graphics') values.push(...this.graphicsValues(input.settings), ...this.advancedValues(input.settings.advanced));
    if (scope === 'all' || scope === 'controller') {
      const c = this.controllerValues(input);
      values.push(...c.values);
      notes.push(...c.notes);
    }
    for (const [t, k, v] of values) {
      if (doc.set(t, k, v)) changed.push(`${t}.${k} = ${typeof v === 'object' ? v.float : v}`);
    }
    if (changed.length || !existed) await atomicWrite(path, doc.toString());
    return { changed, notes };
  }

  async inspectConfig(): Promise<ConfigInspection> {
    const files: ConfigInspection['files'] = [];
    const drift: ConfigInspection['drift'] = [];
    const path = this.configPath();
    const exists = existsSync(path);
    const text = exists ? await readFile(path, 'utf8').catch(() => '') : '';
    const fmt = exists ? checkToml(text) : { ok: false, issues: ['File does not exist'] };
    const issues = [...fmt.issues];
    if (exists && fmt.ok) {
      const doc = TomlDocument.parse(text);
      const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      for (const [t, k, v] of this.pathValues()) {
        const actual = doc.get(t, k) ?? null;
        const ok = typeof v === 'string' ? actual !== null && norm(actual) === norm(v) : actual === String(v);
        // content_root holds profiles and saves: pointing elsewhere hides them from OmniDeck backups.
        if (!ok) drift.push({ file: path, key: `${t}.${k}`, expected: String(v), actual, critical: k === 'content_root' });
      }
      // A wrongly typed value is reset by Xenia with a blocking warning box (config.cc ReadConfig).
      const expectTypes: [string, string, 'string' | 'integer' | 'boolean' | 'float'][] = [
        ['GPU', 'gpu', 'string'], ['GPU', 'draw_resolution_scale_x', 'integer'], ['GPU', 'draw_resolution_scale_y', 'integer'],
        ['GPU', 'vsync', 'boolean'], ['GPU', 'framerate_limit', 'integer'], ['Display', 'fullscreen', 'boolean'],
        ['HID', 'hid', 'string'], ['HID', 'vibration', 'boolean'], ['Storage', 'content_root', 'string'], ['Storage', 'cache_root', 'string'],
      ];
      for (const [t, k, ty] of expectTypes) {
        const actual = doc.type(t, k);
        if (actual && actual !== ty && !(ty === 'float' && actual === 'integer')) issues.push(`${t}.${k} is a ${actual}, Xenia expects a ${ty} (it would show a warning and reset it)`);
      }
    }
    files.push({ label: XENIA_CONFIG_NAME, path, exists, parseOk: exists && issues.length === 0, issues });
    return { files, drift };
  }

  /** Command-line cvar overrides for a per-game profile (cvars from the command line beat every config, base/cvar.h UpdateValue). */
  profileArgs(base: EmulatorSettings, profile: GameProfile): string[] {
    const o = profile.overrides;
    const merged: EmulatorSettings = { ...base, ...(o as Partial<EmulatorSettings>), advanced: {} };
    const g = this.graphicsValues(merged);
    const pick = (...keys: string[]) => g.filter(([, k]) => keys.includes(k));
    const vals: XeniaValue[] = [];
    if (o.renderer !== undefined) vals.push(...pick('gpu'));
    if (o.resolutionScale !== undefined) vals.push(...pick('draw_resolution_scale_x', 'draw_resolution_scale_y'));
    if (o.vsync !== undefined) vals.push(...pick('vsync'));
    if (o.frameLimit !== undefined) vals.push(...pick('framerate_limit'));
    if (o.aspectRatio !== undefined) vals.push(...pick('present_letterbox'));
    vals.push(...this.advancedValues(o.advanced ?? {}));
    return vals.map(([, k, v]) => `--${k}=${typeof v === 'object' ? v.float : v}`);
  }

  /** Flags that pin every Xenia data location to OmniDeck folders (xenia_main.cc, base/logging.cc). */
  rootArgs(): string[] {
    const p = this.paths();
    return [`--storage_root=${p.data}`, `--content_root=${p.saves}`, `--cache_root=${p.cache}`, `--log_file=${this.logPath()}`];
  }

  async buildLaunch(target: LaunchTarget, executable: string, settings: EmulatorSettings, profile: GameProfile | null, _version: string | null): Promise<LaunchCommand> {
    const notes: string[] = [];
    const args = this.rootArgs();
    const fullscreen = profile?.overrides.fullscreen ?? settings.fullscreen;
    // emulator_window.cc OnEmulatorInitialized: --fullscreen enters fullscreen once the window is ready.
    if (fullscreen) args.push('--fullscreen');
    else if (profile?.overrides.fullscreen === false) args.push('--fullscreen=false');
    if (profile) {
      const extra = this.profileArgs(settings, profile);
      if (extra.length) {
        args.push(...extra);
        notes.push(`Per-game profile applied as ${extra.length} command-line cvar override(s); Xenia's own per-title config (${join(this.gameConfigDir(), '<TITLEID>.config.toml')}) is still loaded underneath.`);
      }
      if (profile.customArgs) args.push(...splitArgs(profile.customArgs));
    }
    // The positional "target" option (xenia_main.cc AddPositionalOption) must come last.
    args.push(target.path);
    const p = this.paths();
    return {
      command: executable,
      args,
      cwd: dirname(executable),
      logFile: this.logPath(),
      prepare: async () => {
        await mkdir(dirname(this.logPath()), { recursive: true });
        await mkdir(p.saves, { recursive: true });
        await mkdir(p.cache, { recursive: true });
      },
      notes,
    };
  }

  buildUiLaunch(executable: string): LaunchCommand {
    return { command: executable, args: this.rootArgs(), cwd: dirname(executable), logFile: this.logPath(), notes: [] };
  }

  async smokeTest(executable: string): Promise<SmokeTestResult> {
    const checks: SmokeTestResult['checks'] = [];
    const exeOk = existsSync(executable);
    checks.push({ label: 'Executable present', ok: exeOk, detail: executable });
    if (!exeOk) return { ran: false, ok: false, checks };
    const size = (await stat(executable).catch(() => null))?.size ?? 0;
    // The release workflow rejects executables <= 100000 bytes (.github/workflows/Windows_x86.yml).
    checks.push({ label: 'Executable is complete', ok: size > 100000, detail: `${size} bytes` });
    const build = await readBuildInfo(executable);
    checks.push({ label: 'Build information', ok: true, detail: build ?? 'No build string found (not an official Canary build?)' });
    const insp = await this.inspectConfig();
    const f = insp.files[0];
    checks.push({ label: 'Configuration parses', ok: !f.exists || f.parseOk, detail: f.exists ? f.issues.join('; ') || `${XENIA_CONFIG_NAME} OK` : 'Not created yet (written on first configure)' });
    // xenia_canary has no flag that checks and exits: --help opens a message box when no
    // console is attached (base/cvar.cc ParseLaunchArguments), so it is never executed here.
    checks.push({ label: 'Executable starts', ok: true, detail: 'Skipped: Xenia has no non-interactive self-test flag' });
    return { ran: false, ok: checks.every((c) => c.ok), checks };
  }

  async validateEnvironment(hw: HardwareProfile | null, executable: string | null): Promise<Finding[]> {
    const out: Finding[] = [];
    const subject = { kind: 'emulator' as const, id: 'xenia', label: 'Xenia Canary' };
    if (hw && hw.cpu.features.length && !hw.cpu.features.includes('avx')) {
      out.push({
        id: 'xenia.avx', checkId: 'xenia.cpu', category: 'emulators', severity: 'problem', title: 'CPU without AVX',
        detail: 'Xenia Canary is built with /arch:AVX and refuses to start on CPUs without AVX ("Your CPU does not support AVX, which is required by Xenia").', subject,
        evidence: [`CPU: ${hw.cpu.model}`, `Features: ${hw.cpu.features.join(', ')}`], confidence: 'high', repair: null, manualSteps: [],
      });
    }
    if (hw && hw.graphicsApis.directx12 === false && hw.graphicsApis.vulkan === false) {
      out.push({
        id: 'xenia.gpu', checkId: 'xenia.graphics', category: 'graphics', severity: 'problem', title: 'No Direct3D 12 or Vulkan support detected',
        detail: 'Xenia needs Direct3D 12 (Windows 10, feature level 11_0) or Vulkan 1.0; otherwise it stops with "Unable to initialize the graphics subsystem".', subject,
        evidence: hw.graphicsApis.notes, confidence: 'medium', repair: null, manualSteps: ['Install the latest graphics driver from your GPU vendor.'],
      });
    }
    if (executable) {
      const stray = ['content', XENIA_CONFIG_NAME].map((f) => join(dirname(executable), f)).filter((f) => existsSync(f));
      if (stray.length) {
        out.push({
          id: 'xenia.app-data', checkId: 'xenia.paths', category: 'saves', severity: 'info', title: 'Xenia data in the program folder',
          detail: `Xenia was started outside OmniDeck at some point and kept data next to xenia_canary.exe (portable is the default on Windows). OmniDeck uses ${this.paths().data} and ${this.paths().saves}; the program-folder data is kept across updates, copy profiles/saves over if you need them.`,
          subject, evidence: stray, confidence: 'high', repair: null, manualSteps: [],
        });
      }
    }
    if (!(await this.hasProfile())) {
      out.push({
        id: 'xenia.profile', checkId: 'xenia.profile', category: 'saves', severity: 'info', title: 'No Xenia profile yet',
        detail: 'Xenia shows a "No Profiles Found" window until a profile exists, and games cannot save without one. Open Xenia (without a game) and create a profile once in Profiles > Create profile.',
        subject, evidence: [this.paths().saves], confidence: 'medium', repair: null, manualSteps: ['Open Xenia from OmniDeck, choose Profiles > Create profile, then sign in to it.'],
      });
    }
    return out;
  }

  /** Profiles live in <content_root>/<XUID>/FFFE07D1/00010000/<XUID> (kernel/xam/profile_manager.cc GetProfilePath). */
  async hasProfile(): Promise<boolean> {
    const root = this.paths().saves;
    if (!existsSync(root)) return false;
    for (const d of await readdir(root).catch(() => [] as string[])) {
      if (/^[0-9A-F]{16}$/i.test(d) && existsSync(join(root, d, 'FFFE07D1', '00010000'))) return true;
    }
    return false;
  }

  saveLocations(): { label: string; path: string }[] {
    const p = this.paths();
    return [
      { label: 'Profiles, saves, DLC and title updates (content)', path: p.saves },
      { label: 'Xenia settings and per-game configs', path: p.data },
    ];
  }

  async biosStatus(): Promise<BiosStatus[]> {
    // Xenia is a high-level emulator: no Xbox 360 firmware/keys are used.
    return [];
  }

  logFile(): string | null {
    return this.logPath();
  }

  cacheDirs(): { label: string; path: string }[] {
    return [{ label: 'Shader and pipeline storage (cache_root)', path: this.paths().cache }];
  }

  async recoverSession(): Promise<string[]> {
    // Per-game overrides are command-line cvars only; nothing on disk is changed for a session.
    return [];
  }

  async detectExistingSetups(): Promise<SetupImportCandidate[]> {
    const out: SetupImportCandidate[] = [];
    const home = homedir();
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    const documents = join(home, 'Documents');
    const dirs = [
      'C:\\Xenia', 'D:\\Xenia', 'C:\\Emulators\\Xenia', 'D:\\Emulators\\Xenia', 'C:\\Xenia Canary', 'C:\\xenia_canary',
      join(home, 'Xenia'), join(home, 'Desktop', 'Xenia'), join(home, 'Downloads', 'xenia_canary'), join(home, 'Downloads', 'Xenia'),
      join(appData, 'emudeck', 'Emulators', 'xenia'),
      // Non-portable storage root: Documents\Xenia (xenia_main.cc + base/filesystem_win.cc GetUserFolder).
      join(documents, 'Xenia'),
    ];
    const seen = new Set<string>();
    for (const dir of dirs) {
      const key = dir.toLowerCase().replace(/[\\/]+$/, '');
      if (seen.has(key) || !existsSync(dir)) continue;
      seen.add(key);
      const exe = await this.findExecutable(dir);
      const cfg = [join(dir, XENIA_CONFIG_NAME), join(dir, 'xenia.config.toml')].find((f) => existsSync(f)) ?? null;
      if (!exe && !cfg) continue;
      let content = join(dir, 'content');
      if (cfg) {
        const doc = TomlDocument.parse(await readFile(cfg, 'utf8').catch(() => ''));
        const custom = doc.get('Storage', 'content_root');
        if (custom) content = /^([A-Za-z]:|[\\/])/.test(custom) ? custom : join(dir, custom);
      }
      out.push({
        id: `xenia:${key}`, source: 'xenia', label: `Xenia (${dir})`, path: dir,
        details: [exe ? `Executable: ${exe}` : 'No xenia_canary.exe in this folder', cfg ? `Settings: ${cfg}` : 'No config file', `Content (profiles, saves): ${content}`],
        importable: { settings: false, saves: existsSync(content), bios: false, romPaths: false, useInstallation: !!exe },
        romPaths: [],
        saveCopies: [{ from: content, to: this.paths().saves, label: 'Xenia content (profiles, saves, DLC, title updates)' }],
      });
    }
    return out;
  }

  /**
   * Started without OmniDeck's flags, Xenia keeps everything next to the exe (portable is the
   * Windows default, xenia_main.cc). Those paths are carried across updates and never deleted.
   */
  persistentAppPaths(): string[] {
    return ['portable.txt', XENIA_CONFIG_NAME, 'content', 'config', 'patches', 'plugins', 'cache0', 'cache1', 'cache', 'cache_host', 'xconfig.settings', 'recent.toml', 'gamecontrollerdb.txt'];
  }
}

function inferValue(raw: string): TomlValue {
  const s = raw.trim();
  if (/^'.*'$/.test(s) || /^".*"$/.test(s)) return s.slice(1, -1);
  if (s === 'true' || s === 'false') return s === 'true';
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return { float: Number(s) };
  return s;
}

/** "<branch>@<short commit> on <date>" compiled into the binary (app/emulator_window.cc base_title_). */
export async function readBuildInfo(executable: string): Promise<string | null> {
  const fh = await open(executable, 'r').catch(() => null);
  if (!fh) return null;
  try {
    const size = (await fh.stat()).size;
    const chunk = 4 * 1024 * 1024;
    const buf = Buffer.alloc(chunk + 256);
    for (let pos = 0; pos < Math.min(size, 128 * 1024 * 1024); pos += chunk) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      const m = /([A-Za-z0-9_./-]{2,64})@([0-9a-f]{7,40}) on ([ -~]{6,40}?)\0/.exec(buf.subarray(0, bytesRead).toString('latin1'));
      if (m) return `${m[1]}@${m[2]} on ${m[3]}`;
      if (bytesRead < buf.length) break;
    }
    return null;
  } finally {
    await fh.close();
  }
}
