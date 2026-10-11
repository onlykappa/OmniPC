import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppPaths } from '../src/main/core/paths';
import { RyujinxAdapter, blockedDataLocation, countFirmwareNcas, parseKeyFile } from '../src/main/emulators/ryujinx/adapter';
import { REQUIRED_KEYS, RYUJINX_CONFIG_VERSION, defaultRyujinxConfig } from '../src/main/emulators/ryujinx/config';
import { validateManifest } from '../src/main/emulators/registry';
import type { EmulatorAdapter } from '../src/main/emulators/adapter';
import { pickAsset } from '../src/main/downloads/sources';
import { defaultProfile } from '../src/main/controllers/translate';
import { DEFAULT_SETTINGS } from '../src/main/database/settingsRepo';
import type { GameProfile, HardwareProfile } from '../src/shared/models';
import { tempDir } from './helpers';

const t = tempDir();
afterAll(t.cleanup);
const paths = new AppPaths(join(t.dir, 'ud'), t.dir);
const controller = { ...defaultProfile(), id: 1, updatedAt: '' };
const hotkeys = DEFAULT_SETTINGS.hotkeys;
const HEADER_KEY = `header_key = ${'ab'.repeat(32)}`;

type Cfg = Record<string, unknown> & { input_config: Record<string, unknown>[] };

describe('Ryujinx adapter', () => {
  const a = new RyujinxAdapter(paths);
  const settings = a.defaultSettings(null, 'balanced');
  const cfg = () => JSON.parse(readFileSync(a.configPath(), 'utf8')) as Cfg;
  const write = (doc: unknown) => writeFileSync(a.configPath(), JSON.stringify(doc, null, 2));

  it('has a valid manifest selecting the stable Windows x64 zip', () => {
    expect(validateManifest(a.manifest)).toEqual([]);
    expect(a.manifest.implemented).toBe(true);
    expect(a.manifest.executable).toBe('Ryujinx.exe');
    expect(a.manifest.systems).toEqual(['switch']);
    expect(String(a.manifest.download.kind)).toBe('forgejo-release');
    expect(a.manifest.download.allowedHosts).toEqual(['git.ryujinx.app']);
    const names = ['ryujinx-1.3.3-win_x64.7z', 'ryujinx-1.3.3-win_arm64.zip', 'ryujinx-1.3.3-linux_x64.tar.gz', 'ryujinx-1.3.3-x64.AppImage', 'ryujinx-canary-1.3.3-macos_universal.app.tar.gz', 'ryujinx-1.3.3-win_x64.zip']
      .map((name) => ({ name, browser_download_url: `https://git.ryujinx.app/projects/Ryubing/releases/download/1.3.3/${name}`, size: 1 }));
    const hit = pickAsset(names, a.manifest.download.assetPatterns!, a.manifest.download.assetExclude!, []);
    expect(hit?.name).toBe('ryujinx-1.3.3-win_x64.zip');
    expect(new RegExp(a.manifest.download.versionPattern!).exec(hit!.name)?.[1]).toBe('1.3.3');
    expect(new RegExp(a.manifest.download.versionPattern!).exec('ryujinx-canary-1.3.250-win_x64.zip')?.[1]).toBe('1.3.250');
  });

  it('keeps everything in the OmniPC data folder and keys in BIOS/switch', () => {
    expect(a.configPath()).toBe(join(paths.emulatorDataDir('ryujinx'), 'Config.json'));
    expect(a.keysDir()).toBe(join(paths.emulatorDataDir('ryujinx'), 'system'));
    expect(a.paths().bios).toBe(paths.systemBiosDir('switch'));
    expect(a.saveLocations()[0].path).toBe(join(paths.emulatorDataDir('ryujinx'), 'bis', 'user', 'save'));
    expect((a as EmulatorAdapter).persistentAppPaths).toBeUndefined();
  });

  it('default template is a complete Config.json', () => {
    const d = defaultRyujinxConfig();
    expect(d.version).toBe(RYUJINX_CONFIG_VERSION);
    for (const k of REQUIRED_KEYS) expect(d[k], k).toBeDefined();
    expect(d.hide_cursor).toBe(1);
    expect(d.vsync_mode).toBe(0);
    expect(d.gclow_latency).toBe(false);
  });

  it('creates a complete Config.json with prompts suppressed, graphics and keys', async () => {
    mkdirSync(a.paths().bios, { recursive: true });
    writeFileSync(join(a.paths().bios, 'prod.keys'), `${HEADER_KEY}\nmaster_key_00 = ${'cd'.repeat(16)}\n`);
    writeFileSync(join(a.paths().bios, 'title.keys'), `0100000000010000000000000000000${'0'} = ${'ef'.repeat(16)}\n`);
    const res = await a.applyConfig({ settings: { ...settings, renderer: 'opengl', resolutionScale: 3, vsync: false, aspectRatio: 'stretch' }, controller, hotkeys, hardware: null }, 'all');
    expect(res.changed).toContain('Config.json created');
    const c = cfg();
    for (const k of REQUIRED_KEYS) expect(c[k], k).toBeDefined();
    expect(c.update_checker_type).toBe('Off');
    expect(c.check_updates_on_start).toBe(false);
    expect(c.show_confirm_exit).toBe(false);
    expect(c.show_console).toBe(false);
    expect(c.skip_user_profiles).toBe(true);
    expect(c.ignore_applet).toBe(true);
    expect(c.graphics_backend).toBe('OpenGl');
    expect(c.res_scale).toBe(3);
    expect(c.vsync_mode).toBe(1);
    expect(c.aspect_ratio).toBe('Stretched');
    expect(c.start_fullscreen).toBe(true);
    expect(c.docked_mode).toBe(true);
    expect(readFileSync(join(a.keysDir(), 'prod.keys'), 'utf8')).toContain('header_key');
    expect(existsSync(join(a.keysDir(), 'title.keys'))).toBe(true);
    // No controller selected in Ryujinx yet: keyboard player 1 stays, with an explanation.
    expect(c.input_config[0].backend).toBe('WindowKeyboard');
    expect(res.notes.join(' ')).toMatch(/SDL GUID/);
  });

  it('is idempotent', async () => {
    const res = await a.applyConfig({ settings: { ...settings, renderer: 'opengl', resolutionScale: 3, vsync: false, aspectRatio: 'stretch' }, controller, hotkeys, hardware: null }, 'all');
    expect(res.changed).toEqual([]);
  });

  it('uses the custom scale for non-integer factors and writes typed advanced keys', async () => {
    await a.applyConfig({ settings: { ...settings, resolutionScale: 1.5, advanced: { docked_mode: 'false', anti_aliasing: 'Fxaa', max_anisotropy: '16', hotkeys: 'x', 'Bad.Key': '1' } }, controller, hotkeys, hardware: null }, 'graphics');
    const c = cfg();
    expect(c.res_scale).toBe(-1);
    expect(c.res_scale_custom).toBe(1.5);
    expect(c.docked_mode).toBe(false);
    expect(c.anti_aliasing).toBe('Fxaa');
    expect(c.max_anisotropy).toBe(16);
    expect(typeof c.hotkeys).toBe('object');
    expect(c['Bad.Key']).toBeUndefined();
  });

  it('keeps user keys and maps the universal profile onto an existing controller entry', async () => {
    const c = cfg();
    c.user_key = 'keep me';
    c.audio_volume = 0.5;
    c.input_config = [{
      left_joycon_stick: { joystick: 'Left', invert_stick_x: false, invert_stick_y: true, rotate90_cw: false, stick_button: 'LeftStick' },
      right_joycon_stick: { joystick: 'Right', invert_stick_x: false, invert_stick_y: false, rotate90_cw: false, stick_button: 'RightStick' },
      deadzone_left: 0.1, deadzone_right: 0.1, range_left: 1, range_right: 1, trigger_threshold: 0.5,
      motion: { motion_backend: 'GamepadDriver', sensitivity: 100, gyro_deadzone: 1, enable_motion: true },
      rumble: { strong_rumble: 1, weak_rumble: 1, enable_rumble: false, use_hdrumble: false },
      led: { enable_led: false, turn_off_led: false, use_rainbow: false, led_color: 0 },
      left_joycon: { button_minus: 'Minus', button_l: 'LeftShoulder', button_zl: 'LeftTrigger', button_sl: 'SingleLeftTrigger0', button_sr: 'SingleRightTrigger0', dpad_up: 'DpadUp', dpad_down: 'DpadDown', dpad_left: 'DpadLeft', dpad_right: 'DpadRight' },
      right_joycon: { button_plus: 'Plus', button_r: 'RightShoulder', button_zr: 'RightTrigger', button_sl: 'SingleLeftTrigger1', button_sr: 'SingleRightTrigger1', button_x: 'Y', button_b: 'A', button_y: 'X', button_a: 'B' },
      version: 1, backend: 'GamepadSDL3', id: '0-00000003-045e-0000-8e02-000000007200', name: 'Xbox Controller', controller_type: 'ProController', player_index: 'Player1', enable_dynamic_gamepad_swap: false,
    }];
    write(c);
    const profile = { ...controller, deadzone: 0.2, rumble: true, mapping: { ...controller.mapping, A: 'B' as const, B: 'A' as const, X: 'LeftStickUp' as const } };
    const res = await a.applyController(profile);
    const after = cfg();
    expect(after.user_key).toBe('keep me');
    expect(after.audio_volume).toBe(0.5);
    const e = after.input_config[0] as Record<string, Record<string, unknown> & unknown>;
    expect(e.id).toBe('0-00000003-045e-0000-8e02-000000007200');
    expect(e.right_joycon.button_a).toBe('B');
    expect(e.right_joycon.button_b).toBe('A');
    expect(e.right_joycon.button_x).toBe('X'); // stick direction cannot be a button -> default
    expect(e.right_joycon.button_y).toBe('Y');
    expect(e.right_joycon.button_plus).toBe('Plus');
    expect(e.left_joycon.button_minus).toBe('Minus');
    expect(e.left_joycon.button_zl).toBe('LeftTrigger');
    expect(e.left_joycon.button_sl).toBe('SingleLeftTrigger0');
    expect(e.left_joycon_stick.invert_stick_y).toBe(true);
    expect(e.left_joycon_stick.joystick).toBe('Left');
    expect(e.deadzone_left).toBe(0.2);
    expect(e.rumble.enable_rumble).toBe(true);
    expect((e.motion as Record<string, unknown>).enable_motion).toBe(true);
    expect(res.notes.join(' ')).toMatch(/button_x/);
    expect((await a.applyController(profile)).changed).toEqual([]);
  });

  it('maps Switch buttons by label with the identity profile', async () => {
    const res = await a.applyController({ ...controller, nintendoLayoutForNintendoSystems: false });
    expect(res.changed.length).toBe(1);
    const e = cfg().input_config[0] as Record<string, Record<string, unknown>>;
    expect(e.right_joycon.button_a).toBe('A');
    expect(e.right_joycon.button_b).toBe('B');
  });

  it('detects drift, a bad config and an overriding Config.json next to the exe', async () => {
    const good = await a.inspectConfig();
    expect(good.files[0].parseOk).toBe(true);
    expect(good.drift).toEqual([]);
    const c = cfg();
    c.update_checker_type = 'PromptAtStartup';
    c.show_confirm_exit = true;
    c.vsync_mode = 'Switch';
    write(c);
    const bad = await a.inspectConfig();
    expect(bad.drift.map((d) => d.key)).toEqual(expect.arrayContaining(['update_checker_type', 'show_confirm_exit']));
    expect(bad.drift.find((d) => d.key === 'update_checker_type')?.critical).toBe(true);
    expect(bad.files[0].parseOk).toBe(false);
    expect(bad.files[0].issues.join()).toMatch(/vsync_mode must be an integer/);
    mkdirSync(a.paths().app, { recursive: true });
    writeFileSync(join(a.paths().app, 'Config.json'), '{}');
    expect((await a.inspectConfig()).drift.some((d) => d.critical && d.file.endsWith(join('app', 'Config.json')))).toBe(true);
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'paths');
    expect(cfg().update_checker_type).toBe('Off');
    expect(cfg().vsync_mode).toBe('Switch'); // paths scope leaves graphics alone
    writeFileSync(a.configPath(), '{ broken');
    expect((await a.inspectConfig()).files[0].parseOk).toBe(false);
    const res = await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'all');
    expect(res.notes.join()).toMatch(/could not be parsed/);
    expect(cfg().version).toBe(RYUJINX_CONFIG_VERSION);
  });

  it('fills a partial Config.json with defaults instead of leaving it unloadable', async () => {
    write({ version: 70, res_scale: 2, my_key: 1 });
    const res = await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'paths');
    expect(res.notes.join()).toMatch(/incomplete/);
    const c = cfg();
    expect(c.version).toBe(70);
    expect(c.my_key).toBe(1);
    expect(c.res_scale).toBe(2);
    for (const k of REQUIRED_KEYS) expect(c[k], k).toBeDefined();
  });

  it('builds a fullscreen launch with the data folder and the game path last', async () => {
    const target = { gameId: 1, path: 'D:\\Games\\Switch\\Game [0100000000010000].nsp', systemId: 'switch' as const, serial: null, title: 'Game' };
    const cmd = await a.buildLaunch(target, 'C:\\R\\Ryujinx.exe', settings, null, '1.3.3');
    expect(cmd.args).toEqual(['-r', a.paths().data, '--hide-updates', '-f', target.path]);
    expect(cmd.cwd).toBe(a.paths().data);
    expect(cmd.targetArgs).toBe(1);
    expect(cmd.cleanup).toBeUndefined();
    const windowed = await a.buildLaunch(target, 'C:\\R\\Ryujinx.exe', { ...settings, fullscreen: false }, null, null);
    expect(windowed.args).not.toContain('-f');
    const profile: GameProfile = { gameId: 1, emulatorId: 'ryujinx', overrides: { fullscreen: false }, customArgs: '-r C:\\x --fullscreen --docked-mode --install-firmware fw.zip', notes: null, updatedAt: '' };
    const custom = await a.buildLaunch(target, 'C:\\R\\Ryujinx.exe', settings, profile, null);
    expect(custom.args).toEqual(['-r', a.paths().data, '--hide-updates', '--docked-mode', target.path]);
    expect(custom.notes.join()).toMatch(/Ignored custom arguments/);
    expect(a.buildUiLaunch('C:\\R\\Ryujinx.exe').args).toEqual(['-r', a.paths().data, '--hide-updates']);
    expect(a.buildFirmwareInstallLaunch('C:\\R\\Ryujinx.exe', 'D:\\fw').args).toEqual(['-r', a.paths().data, '--hide-updates', '--install-firmware', 'D:\\fw']);
  });

  it('applies per-game overrides for the session and restores them (also after a crash)', async () => {
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'all');
    const before = cfg();
    const profile: GameProfile = { gameId: 2, emulatorId: 'ryujinx', overrides: { renderer: 'opengl', resolutionScale: 4, advanced: { docked_mode: 'false', new_key: 'x' } }, customArgs: null, notes: null, updatedAt: '' };
    const target = { gameId: 2, path: 'D:\\g.xci', systemId: 'switch' as const, serial: null, title: 'G' };
    const cmd = await a.buildLaunch(target, 'C:\\R\\Ryujinx.exe', settings, profile, null);
    await cmd.prepare!();
    let c = cfg();
    expect(c.graphics_backend).toBe('OpenGl');
    expect(c.res_scale).toBe(4);
    expect(c.docked_mode).toBe(false);
    expect(c.new_key).toBe('x');
    // Ryujinx rewrites the file while running; other keys must survive the restore.
    c.window_startup = { ...(c.window_startup as object), window_size_width: 1600 };
    write(c);
    await cmd.cleanup!();
    c = cfg();
    expect(c.graphics_backend).toBe(before.graphics_backend);
    expect(c.res_scale).toBe(before.res_scale);
    expect(c.docked_mode).toBe(before.docked_mode);
    expect(c.new_key).toBeUndefined();
    expect((c.window_startup as Record<string, unknown>).window_size_width).toBe(1600);
    // crash: prepare without cleanup
    const cmd2 = await a.buildLaunch(target, 'C:\\R\\Ryujinx.exe', settings, profile, null);
    await cmd2.prepare!();
    expect(cfg().res_scale).toBe(4);
    expect(await a.recoverSession()).toHaveLength(1);
    expect(cfg().res_scale).toBe(before.res_scale);
    expect(await a.recoverSession()).toEqual([]);
  });

  it('reports keys and firmware status', async () => {
    let st = await a.biosStatus();
    expect(st.map((s) => s.requirementKind)).toEqual(['keys', 'firmware']);
    expect(st[0].status).toBe('found');
    expect(st[0].required).toBe(true);
    expect(st[1].status).toBe('missing');
    expect(st[1].note).toMatch(/Install Firmware/);
    const reg = a.firmwareDir();
    for (const id of ['0a1b', '2c3d']) {
      mkdirSync(join(reg, `${id}.nca`), { recursive: true });
      writeFileSync(join(reg, `${id}.nca`, '00'), 'x');
    }
    mkdirSync(join(reg, 'empty.nca'), { recursive: true });
    expect(countFirmwareNcas(reg)).toBe(2);
    st = await a.biosStatus();
    expect(st[1].status).toBe('found');
    writeFileSync(join(a.paths().bios, 'prod.keys'), 'garbage');
    st = await a.biosStatus();
    // BIOS copy is invalid but the installed copy in data/system is still valid.
    expect(st[0].files.some((f) => !f.valid)).toBe(true);
    expect(st[0].status).toBe('found');
    const sync = await a.syncKeys();
    expect(sync.notes.join()).toMatch(/header_key/);
    expect(readFileSync(join(a.keysDir(), 'prod.keys'), 'utf8')).toContain('header_key');
  });

  it('parses key files', () => {
    expect(parseKeyFile(`${HEADER_KEY}\r\nkey_area_key_application_00 = ${'00'.repeat(16)}\n# c`)).toEqual({ count: 2, hasHeaderKey: true });
    expect(parseKeyFile('header_key = 1234')).toEqual({ count: 1, hasHeaderKey: false });
  });

  it('smoke test checks config, keys and firmware statically', async () => {
    const exe = join(a.paths().app, 'Ryujinx.exe');
    writeFileSync(exe, 'MZ');
    const r = await a.smokeTest(exe);
    expect(r.ran).toBe(false);
    expect(r.checks.find((c) => c.label === 'prod.keys installed')?.ok).toBe(true);
    expect(r.checks.find((c) => c.label === 'Firmware installed')?.ok).toBe(true);
    // app/Config.json from the drift test overrides the managed one
    expect(r.checks.find((c) => c.label.startsWith('No Config.json'))?.ok).toBe(false);
    expect(r.ok).toBe(false);
    expect(await a.findExecutable(a.paths().app)).toBe(exe);
  });

  it('lists only per-game cache folders and the newest log', () => {
    const games = join(a.paths().data, 'games');
    mkdirSync(join(games, '0100000000010000', 'cache', 'shader'), { recursive: true });
    mkdirSync(join(games, '0100000000020000'), { recursive: true });
    writeFileSync(join(games, '0100000000020000', 'updates.json'), '{}');
    expect(a.cacheDirs()).toEqual([{ label: 'PPTC and shader cache (0100000000010000)', path: join(games, '0100000000010000', 'cache') }]);
    mkdirSync(a.logsDir(), { recursive: true });
    writeFileSync(join(a.logsDir(), 'Ryujinx_1.3.3_2026-10-01_10-00-00.log'), 'a');
    expect(a.logFile()).toBe(join(a.logsDir(), 'Ryujinx_1.3.3_2026-10-01_10-00-00.log'));
  });

  it('reads the version from the log name when the exe has none', async () => {
    expect(await a.detectVersion(join(a.paths().app, 'Ryujinx.exe'))).toBe('1.3.3');
  });

  it('warns about data folders Ryujinx refuses and missing Vulkan', async () => {
    expect(blockedDataLocation('C:\\Users\\me\\OneDrive\\OmniPC\\Emulators\\ryujinx\\data', { OneDrive: 'C:\\Users\\me\\OneDrive' })).toBe('OneDrive');
    expect(blockedDataLocation('C:\\Program Files\\OmniPC\\x', { ProgramFiles: 'C:\\Program Files' })).toBe('Program Files');
    expect(blockedDataLocation('D:\\OmniPC\\x', { ProgramFiles: 'C:\\Program Files', OneDrive: 'C:\\Users\\me\\OneDrive' })).toBeNull();
    const hw = {
      isWindows: true, osName: 'Windows 10', osBuild: '18363', ramMB: 4096,
      cpu: { model: 'Old CPU', cores: 2, threads: 2, speedMHz: 2000, features: ['sse3', 'ssse3', 'sse41'] },
      graphicsApis: { directx12: true, vulkan: false, opengl: true, notes: [] }, displays: [], gpus: [], tier: 'low',
    } as unknown as HardwareProfile;
    const ids = (await a.validateEnvironment(hw, null)).map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(['ryujinx.vulkan', 'ryujinx.windows-version', 'ryujinx.cpu', 'ryujinx.ram']));
    expect(a.defaultSettings(hw, 'balanced').renderer).toBe('opengl');
    expect(a.defaultSettings(null, 'balanced').renderer).toBe('vulkan');
  });
});
