import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppPaths } from '../src/main/core/paths';
import { Shadps4Adapter, shadps4ResolutionScale } from '../src/main/emulators/shadps4/adapter';
import { validateManifest } from '../src/main/emulators/registry';
import { defaultProfile } from '../src/main/controllers/translate';
import { DEFAULT_SETTINGS } from '../src/main/database/settingsRepo';
import type { HardwareProfile } from '../src/shared/models';
import { tempDir } from './helpers';

const t = tempDir();
afterAll(t.cleanup);
const paths = new AppPaths(join(t.dir, 'ud'), t.dir);
const controller = { ...defaultProfile(), id: 1, updatedAt: '' };
const hotkeys = DEFAULT_SETTINGS.hotkeys;
const a = new Shadps4Adapter(paths);
const cfg = () => JSON.parse(readFileSync(a.configPath(), 'utf8'));
const ini = (n: 'default' | 'global') => readFileSync(a.inputConfigPath(n), 'utf8');
const lines = (text: string) => text.split(/\r?\n/).map((l) => l.trim());

describe('shadPS4 adapter', () => {
  const settings = { ...a.defaultSettings(null, 'balanced'), vsync: true };

  it('has a valid manifest for PS4 with the official stable asset pattern', () => {
    expect(validateManifest(a.manifest)).toEqual([]);
    expect(a.manifest.systems).toEqual(['ps4']);
    expect(a.manifest.executable).toBe('shadPS4.exe');
    const re = new RegExp(a.manifest.download.assetPatterns![0]);
    expect(re.test('shadps4-win64-sdl-0.19.0.zip')).toBe(true);
    expect(re.test('shadps4-linux-sdl-0.19.0.zip')).toBe(false);
    expect(re.test('shadps4-win64-sdl-2026-10-10-811bfcd.zip')).toBe(false);
    expect(new RegExp(a.manifest.download.versionPattern!).exec('shadps4-win64-sdl-0.19.0.zip')?.[1]).toBe('0.19.0');
  });

  it('writes paths, graphics, controller and hotkey settings', async () => {
    const res = await a.applyConfig({ settings: { ...settings, resolutionScale: 2, advanced: { 'GPU.readbacks_mode': '1', 'Bogus.key': 'x', 'General.home_dir': 'C:\\x' } }, controller, hotkeys, hardware: null }, 'all');
    expect(res.changed.length).toBeGreaterThan(8);
    const c = cfg();
    expect(c.General.home_dir).toBe(paths.emulatorSaveDir('shadps4'));
    expect(c.General.sys_modules_dir).toBe(paths.systemBiosDir('ps4'));
    expect(c.General.font_dir).toBe(join(paths.systemBiosDir('ps4'), 'fonts'));
    expect(c.General.show_splash).toBe(false);
    expect(c.Log.separate).toBe(false);
    expect(c.GPU.full_screen).toBe(true);
    expect(c.GPU.present_mode).toBe('Fifo');
    expect([c.GPU.internal_screen_width, c.GPU.internal_screen_height]).toEqual([1920, 1080]);
    expect(c.GPU.readbacks_mode).toBe(1);
    expect(c.Bogus).toBeUndefined();
    expect(c.Input.use_unified_input_config).toBe(true);
    // Portable user folder + user homes that suppress the "Save Migration" dialog.
    expect(existsSync(a.userDir())).toBe(true);
    for (const id of [1000, 1001, 1002, 1003]) expect(existsSync(join(paths.emulatorSaveDir('shadps4'), String(id), 'savedata'))).toBe(true);
    const def = lines(ini('default'));
    expect(def).toContain('cross = cross');
    expect(def).toContain('touchpad_center = back');
    expect(def).toContain('cross = kp2'); // keyboard bindings kept
    expect(def).toContain('analog_deadzone = leftjoystick, 19, 127');
    const glob = lines(ini('global'));
    expect(glob).toContain('hotkey_quit = back, options');
    expect(glob).toContain('hotkey_quit = lctrl, lshift, end');
    expect(glob).toContain('hotkey_fullscreen = back, cross');
    expect(glob.some((l) => l.startsWith('hotkey_pause'))).toBe(false);
  });

  it('is idempotent and preserves user keys and keyboard lines', async () => {
    const c = cfg();
    c.Audio = { sdl_main_output_device: 'Speakers' };
    c.Mine = { x: 1 };
    writeFileSync(a.configPath(), JSON.stringify(c));
    writeFileSync(a.inputConfigPath('default'), `${ini('default')}r1 = p\n`);
    const input = { settings: { ...settings, resolutionScale: 2, advanced: { 'GPU.readbacks_mode': '1' } }, controller, hotkeys, hardware: null };
    const again = await a.applyConfig(input, 'all');
    expect(again.changed).toEqual([]);
    expect(cfg().Audio.sdl_main_output_device).toBe('Speakers');
    expect(cfg().Mine).toEqual({ x: 1 });
    expect(lines(ini('default'))).toContain('r1 = p');
  });

  it('remaps the gamepad and replaces older controller lines without doubling them', async () => {
    writeFileSync(a.inputConfigPath('default'), 'cross = n\ncross = cross\ncircle = circle\nanalog_deadzone = leftjoystick, 5, 127\n');
    const swapped = { ...controller, deadzone: 0.3, mapping: { ...controller.mapping, A: 'B' as const, B: 'A' as const, Y: 'Guide' as const } };
    const res = await a.applyConfig({ settings, controller: swapped, hotkeys, hardware: null }, 'controller');
    const def = lines(ini('default'));
    expect(def).toContain('cross = circle');
    expect(def).toContain('circle = cross');
    expect(def).toContain('cross = n');
    expect(def.filter((l) => l === 'cross = cross')).toHaveLength(0);
    expect(def.filter((l) => l.startsWith('analog_deadzone = leftjoystick'))).toEqual(['analog_deadzone = leftjoystick, 38, 127']);
    expect(def).toContain('triangle = triangle');
    expect(res.notes.join()).toMatch(/cannot bind triangle -> Guide/);
    const again = await a.applyConfig({ settings, controller: swapped, hotkeys, hardware: null }, 'controller');
    expect(again.changed).toEqual([]);
  });

  it('detects drift on managed paths, bad types and the missing user home', async () => {
    const c = cfg();
    c.General.home_dir = 'C:\\elsewhere';
    c.GPU.window_width = '1920';
    writeFileSync(a.configPath(), JSON.stringify(c));
    const insp = await a.inspectConfig();
    expect(insp.drift.find((d) => d.key === 'General.home_dir')?.critical).toBe(true);
    expect(insp.files[0].parseOk).toBe(false);
    expect(insp.files[0].issues.join()).toMatch(/window_width/);
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'all');
    const ok = await a.inspectConfig();
    expect(ok.drift).toEqual([]);
    expect(ok.files.every((f) => f.parseOk)).toBe(true);
  });

  it('regenerates an unparseable config.json', async () => {
    writeFileSync(a.configPath(), '{ broken');
    expect((await a.inspectConfig()).files[0].parseOk).toBe(false);
    const res = await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'all');
    expect(res.notes.join()).toMatch(/regenerated/);
    expect(cfg().General.home_dir).toBe(paths.emulatorSaveDir('shadps4'));
  });

  it('builds a launch with -g <eboot.bin> last, portable cwd and native per-game config', async () => {
    const exe = join(paths.emulatorAppDir('shadps4'), 'shadPS4.exe');
    const game = join(t.dir, 'Games', 'CUSA00001', 'eboot.bin');
    const target = { gameId: 7, path: game, systemId: 'ps4' as const, serial: null, title: 'Test' };
    const profile = { gameId: 7, emulatorId: 'shadps4', overrides: { vsync: false, fullscreen: false, resolutionScale: 1 }, customArgs: '--show-fps', notes: null, updatedAt: '' };
    const cmd = await a.buildLaunch(target, exe, settings, profile, '0.19.0');
    expect(cmd.command).toBe(exe);
    expect(cmd.cwd).toBe(paths.emulatorDataDir('shadps4'));
    expect(cmd.targetArgs).toBe(2);
    expect(cmd.args.slice(-2)).toEqual(['-g', game]);
    expect(cmd.args.slice(0, 2)).toEqual(['--fullscreen', 'false']);
    expect(cmd.args.indexOf('--show-fps')).toBeLessThan(cmd.args.indexOf('-g'));
    expect(cmd.logFile).toBe(join(paths.emulatorDataDir('shadps4'), 'user', 'log', 'shad_log.txt'));
    mkdirSync(join(a.userDir(), 'custom_configs'), { recursive: true });
    writeFileSync(a.gameConfigPath('CUSA00001'), JSON.stringify({ Audio: { audio_backend: 1 } }));
    await cmd.prepare!();
    const gc = JSON.parse(readFileSync(a.gameConfigPath('CUSA00001'), 'utf8'));
    expect(gc.GPU).toEqual({ full_screen: false, present_mode: 'Mailbox', window_width: 1280, window_height: 720 });
    expect(gc.Audio.audio_backend).toBe(1);

    const plain = await a.buildLaunch({ ...target, path: join(t.dir, 'Games', 'X', 'eboot.bin') }, exe, settings, null, null);
    expect(plain.args).toEqual(['--fullscreen', 'true', '-g', join(t.dir, 'Games', 'X', 'eboot.bin')]);
    expect(a.buildUiLaunch(exe).args).toEqual(['-b']);
    expect(await a.recoverSession()).toEqual([]);
  });

  it('reports optional firmware modules from BIOS/ps4', async () => {
    let st = await a.biosStatus();
    expect(st[0].required).toBe(false);
    expect(st[0].status).toBe('missing');
    writeFileSync(join(paths.systemBiosDir('ps4'), 'libSceNgs2.sprx'), 'x');
    writeFileSync(join(paths.systemBiosDir('ps4'), 'other.sprx'), 'x');
    st = await a.biosStatus();
    expect(st[0].status).toBe('found');
    expect(st[0].files.filter((f) => f.valid)).toHaveLength(1);
    expect(st[0].files).toHaveLength(2);
  });

  it('flags missing Vulkan/AVX2 and always notes compatibility', async () => {
    const hw = { graphicsApis: { vulkan: false, directx12: true, opengl: true, notes: [] }, gpus: [{ name: 'Old GPU' }], cpu: { model: 'Old CPU', features: ['sse42', 'avx'] } } as unknown as HardwareProfile;
    const f = await a.validateEnvironment(hw, null);
    expect(f.find((x) => x.id === 'shadps4.vulkan')?.severity).toBe('problem');
    expect(f.find((x) => x.id === 'shadps4.avx2')?.severity).toBe('problem');
    expect(f.find((x) => x.id === 'shadps4.compatibility')?.severity).toBe('info');
    const ok = await a.validateEnvironment({ ...hw, graphicsApis: { ...hw.graphicsApis, vulkan: true }, cpu: { ...hw.cpu, features: ['avx2'] } } as HardwareProfile, null);
    expect(ok.map((x) => x.id)).toEqual(['shadps4.compatibility']);
    expect(a.renderers(hw)[0].available).toBe(false);
  });

  it('picks the video-out resolution by preset and hardware', () => {
    expect(shadps4ResolutionScale(null, 'performance')).toBe(1);
    expect(shadps4ResolutionScale(null, 'quality')).toBe(2);
    expect(shadps4ResolutionScale({ tier: 'low', displays: [] } as unknown as HardwareProfile, 'maximum')).toBe(1);
  });

  it('runs static smoke checks and skips execution off Windows', async () => {
    const exe = join(paths.emulatorAppDir('shadps4'), 'shadPS4.exe');
    mkdirSync(paths.emulatorAppDir('shadps4'), { recursive: true });
    writeFileSync(exe, '');
    expect(await a.findExecutable(paths.emulatorAppDir('shadps4'))).toBe(exe);
    const r = await a.smokeTest(exe);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    if (process.platform !== 'win32') expect(r.ran).toBe(false);
    expect(a.saveLocations()[0].path).toBe(join(paths.emulatorSaveDir('shadps4'), '1000', 'savedata'));
  });
});
