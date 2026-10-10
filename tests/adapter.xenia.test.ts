import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppPaths } from '../src/main/core/paths';
import { XENIA_DEFAULTS_DATE, XeniaAdapter } from '../src/main/emulators/xenia/adapter';
import { TomlDocument, checkToml, formatTomlValue } from '../src/main/emulators/xenia/toml';
import { defaultProfile } from '../src/main/controllers/translate';
import { DEFAULT_SETTINGS } from '../src/main/database/settingsRepo';
import { tempDir } from './helpers';

const t = tempDir();
afterAll(t.cleanup);
const paths = new AppPaths(join(t.dir, 'ud'), t.dir);
const controller = { ...defaultProfile(), id: 1, updatedAt: '' };
const hotkeys = DEFAULT_SETTINGS.hotkeys;
const toml = (p: string) => TomlDocument.parse(readFileSync(p, 'utf8'));
const fwd = (p: string) => p.replace(/\\/g, '/');

// Shape written by Xenia's config::SaveConfig (config.cc).
const XENIA_CONFIG = [
  '[APU]',
  "apu = 'any'                                       \t# Audio system. Use: [any, nop, sdl, xaudio2]",
  '',
  '[Config]',
  'defaults_date = 2026040912                        \t# Do not modify - internal version of the default values in the config, for',
  '                                                  \t# seamless updates if default value of any option is changed.',
  '',
  '[Display]',
  'fullscreen = false                                \t# Whether to launch the emulator in fullscreen.',
  "postprocess_antialiasing = ''                     \t# Post-processing anti-aliasing effect to apply to the image output of the",
  '                                                  \t# game.',
  '',
  '[GPU]',
  "gpu = 'any'                                       \t# Graphics system. Use: [any, d3d12, vulkan, null]",
  'draw_resolution_scale_x = 1                       \t# Integer pixel width scale',
  'draw_resolution_scale_y = 1                       \t# Integer pixel width scale',
  'vsync = true                                      \t# Enable VSYNC.',
  '',
  '[HID]',
  "hid = 'any'                                       \t# Input system. Use: [any, nop, sdl, keyboard, xinput]",
  'left_stick_deadzone_percentage = 0.0              \t# Defines deadzone level for left stick.',
  '',
  '[Storage]',
  "cache_root = ''                                   \t# Root path for files used to speed up certain parts",
  "content_root = ''                                 \t# Root path for guest content storage (saves, etc.)",
  '',
].join('\n');

describe('Xenia TOML editor', () => {
  it('replaces values in place, keeps comments and appends missing keys/tables', () => {
    const doc = TomlDocument.parse(XENIA_CONFIG);
    expect(doc.issues).toEqual([]);
    expect(doc.get('GPU', 'gpu')).toBe('any');
    expect(doc.type('HID', 'left_stick_deadzone_percentage')).toBe('float');
    expect(doc.set('GPU', 'gpu', 'vulkan')).toBe(true);
    expect(doc.set('GPU', 'gpu', 'vulkan')).toBe(false);
    expect(doc.set('HID', 'left_stick_deadzone_percentage', { float: 0 })).toBe(false);
    expect(doc.set('HID', 'vibration', false)).toBe(true);
    expect(doc.set('Display', 'present_letterbox', false)).toBe(true);
    expect(doc.set('General', 'discord', false)).toBe(true);
    expect(doc.set('Storage', 'content_root', 'C:/O D/it\'s')).toBe(true);
    const out = doc.toString();
    expect(out).toMatch(/^gpu = 'vulkan' +\t# Graphics system\. Use: \[any, d3d12, vulkan, null\]$/m);
    expect(out).toContain("hid = 'any'");
    expect(out).toContain('left_stick_deadzone_percentage = 0.0              \t# Defines');
    expect(out).toContain('\t# game.\npresent_letterbox = false\n');
    expect(out).toMatch(/\[General\]\ndiscord = false\n$/);
    expect(out).toContain('content_root = "C:/O D/it\'s"');
    const again = TomlDocument.parse(out);
    expect(again.issues).toEqual([]);
    expect(again.get('Storage', 'content_root')).toBe("C:/O D/it's");
    expect(again.get('HID', 'vibration')).toBe('false');
  });

  it('formats cvar types and flags malformed or duplicate entries', () => {
    expect(formatTomlValue({ float: 1 })).toBe('1.0');
    expect(formatTomlValue({ float: 0.15 })).toBe('0.15');
    expect(formatTomlValue(3)).toBe('3');
    expect(formatTomlValue('a\\b')).toBe("'a\\b'");
    expect(checkToml(XENIA_CONFIG).ok).toBe(true);
    expect(checkToml('[GPU]\ngpu = \'vulk\n').ok).toBe(false);
    expect(checkToml('[GPU]\nvsync = true\nvsync = false\n').ok).toBe(false);
    expect(checkToml('[GPU\nvsync = true\n').ok).toBe(false);
    const ml = TomlDocument.parse("[A]\ntext = '''\nline1\nline2'''\nafter = 1\n");
    expect(ml.issues).toEqual([]);
    expect(ml.get('A', 'text')).toBe('line1\nline2');
    expect(ml.set('A', 'text', 'x')).toBe(true);
    expect(ml.toString()).toBe("[A]\ntext = 'x'\nafter = 1\n");
  });
});

describe('Xenia adapter', () => {
  const a = new XeniaAdapter(paths);
  const p = a.paths();
  const settings = a.defaultSettings(null, 'balanced');

  it('creates a config with paths, defaults_date, graphics and controller', async () => {
    const res = await a.applyConfig({ settings: { ...settings, renderer: 'vulkan', resolutionScale: 2, aspectRatio: 'stretch' }, controller, hotkeys, hardware: null }, 'all');
    expect(res.changed.length).toBeGreaterThan(10);
    const doc = toml(a.configPath());
    expect(doc.issues).toEqual([]);
    expect(doc.get('Config', 'defaults_date')).toBe(String(XENIA_DEFAULTS_DATE));
    expect(doc.get('Storage', 'content_root')).toBe(fwd(p.saves));
    expect(doc.get('Storage', 'cache_root')).toBe(fwd(p.cache));
    expect(doc.get('General', 'discord')).toBe('false');
    expect(doc.get('GPU', 'gpu')).toBe('vulkan');
    expect(doc.get('GPU', 'draw_resolution_scale_x')).toBe('2');
    expect(doc.type('GPU', 'draw_resolution_scale_y')).toBe('integer');
    expect(doc.get('GPU', 'framerate_limit')).toBe('60');
    expect(doc.get('Display', 'fullscreen')).toBe('true');
    expect(doc.get('Display', 'present_letterbox')).toBe('false');
    expect(doc.get('HID', 'hid')).toBe('xinput');
    expect(doc.get('HID', 'vibration')).toBe('true');
    expect(doc.raw('HID', 'left_stick_deadzone_percentage')).toBe('0.15');
    expect(doc.type('HID', 'right_stick_deadzone_percentage')).toBe('float');
  });

  it('merges into a Xenia-written config, preserves user keys and is idempotent', async () => {
    writeFileSync(a.configPath(), XENIA_CONFIG);
    const input = { settings: { ...settings, renderer: 'd3d12', resolutionScale: 3 }, controller, hotkeys, hardware: null };
    await a.applyConfig(input, 'all');
    const doc = toml(a.configPath());
    expect(doc.get('APU', 'apu')).toBe('any');
    expect(doc.get('GPU', 'gpu')).toBe('d3d12');
    expect(doc.get('GPU', 'draw_resolution_scale_x')).toBe('3');
    expect(doc.get('Config', 'defaults_date')).toBe('2026040912');
    expect(readFileSync(a.configPath(), 'utf8')).toContain('\t# Whether to launch the emulator in fullscreen.');
    doc.set('APU', 'apu', 'xaudio2');
    writeFileSync(a.configPath(), doc.toString());
    expect((await a.applyConfig(input, 'all')).changed).toEqual([]);
    expect(toml(a.configPath()).get('APU', 'apu')).toBe('xaudio2');
  });

  it('translates non-Xbox controllers to SDL and reports unsupported remaps', async () => {
    const ds = { ...controller, controllerKind: 'dualsense' as const, deviceIndex: 1, rumble: false, deadzone: 0.2, mapping: { ...controller.mapping, A: 'B' as const, B: 'A' as const } };
    const r = await a.applyConfig({ settings, controller: ds, hotkeys, hardware: null }, 'controller');
    const doc = toml(a.configPath());
    expect(doc.get('HID', 'hid')).toBe('sdl');
    expect(doc.get('HID', 'vibration')).toBe('false');
    expect(doc.get('HID', 'left_stick_deadzone_percentage')).toBe('0.2');
    expect(r.notes.join(' ')).toMatch(/no gamepad button remapping/);
    expect(r.notes.join(' ')).toMatch(/connection order/);
    expect(a.capabilities.hotkeys).toEqual([]);
  });

  it('applies advanced cvars with inferred types', async () => {
    await a.applyConfig({ settings: { ...settings, advanced: { 'GPU|readback_resolve': 'fast', 'Kernel|apply_title_update': 'false', 'APU|apu_max_queued_frames': '64', 'GPU|x_float': '1.5', 'General|s': "'123'" } }, controller, hotkeys, hardware: null }, 'graphics');
    const doc = toml(a.configPath());
    expect(doc.raw('GPU', 'readback_resolve')).toBe("'fast'");
    expect(doc.raw('Kernel', 'apply_title_update')).toBe('false');
    expect(doc.raw('APU', 'apu_max_queued_frames')).toBe('64');
    expect(doc.raw('GPU', 'x_float')).toBe('1.5');
    expect(doc.raw('General', 's')).toBe("'123'");
  });

  it('detects path drift, wrong types and parse errors', async () => {
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'all');
    expect((await a.inspectConfig()).drift).toEqual([]);
    const doc = toml(a.configPath());
    doc.set('Storage', 'content_root', 'D:/elsewhere');
    doc.set('GPU', 'draw_resolution_scale_x', '2');
    writeFileSync(a.configPath(), doc.toString());
    const insp = await a.inspectConfig();
    expect(insp.drift.find((d) => d.key === 'Storage.content_root')?.critical).toBe(true);
    expect(insp.files[0].parseOk).toBe(false);
    expect(insp.files[0].issues.join()).toMatch(/draw_resolution_scale_x is a string/);
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'all');
    const fixed = await a.inspectConfig();
    expect(fixed.drift).toEqual([]);
    expect(fixed.files[0].parseOk).toBe(true);
    writeFileSync(a.configPath(), "[GPU]\ngpu = 'd3d1");
    expect((await a.inspectConfig()).files[0].parseOk).toBe(false);
    const regen = await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'all');
    expect(regen.notes.join()).toMatch(/regenerated/);
    expect(toml(a.configPath()).issues).toEqual([]);
  });

  it('builds a launch with storage flags, fullscreen and the game path last', async () => {
    const game = 'D:\\X360\\Halo 3\\default.xex';
    const cmd = await a.buildLaunch({ gameId: 1, path: game, systemId: 'x360', serial: null, title: 'Halo 3' }, 'C:\\xenia\\xenia_canary.exe', settings, null, null);
    expect(cmd.args).toEqual([`--storage_root=${p.data}`, `--content_root=${p.saves}`, `--cache_root=${p.cache}`, `--log_file=${join(p.data, 'logs', 'xenia.log')}`, '--fullscreen', game]);
    expect(cmd.logFile).toBe(join(p.data, 'logs', 'xenia.log'));
    const windowed = await a.buildLaunch({ gameId: 1, path: 'g.iso', systemId: 'x360', serial: null, title: 'G' }, 'x.exe', { ...settings, fullscreen: false }, null, null);
    expect(windowed.args).not.toContain('--fullscreen');
    expect(windowed.args.at(-1)).toBe('g.iso');
    expect(a.buildUiLaunch('x.exe').args).toEqual(cmd.args.slice(0, 4));
  });

  it('applies per-game profiles as command-line cvars without touching the config', async () => {
    const before = readFileSync(a.configPath(), 'utf8');
    const profile = { gameId: 7, emulatorId: null, overrides: { renderer: 'vulkan', resolutionScale: 1, vsync: false, fullscreen: false, advanced: { 'GPU|readback_resolve': 'full' } }, customArgs: '--mount_scratch', notes: null, updatedAt: '' };
    const cmd = await a.buildLaunch({ gameId: 7, path: 'g.iso', systemId: 'x360', serial: null, title: 'G' }, 'x.exe', settings, profile, null);
    expect(cmd.args).toContain('--fullscreen=false');
    expect(cmd.args).toContain('--gpu=vulkan');
    expect(cmd.args).toContain('--draw_resolution_scale_x=1');
    expect(cmd.args).toContain('--draw_resolution_scale_y=1');
    expect(cmd.args).toContain('--vsync=false');
    expect(cmd.args).toContain('--readback_resolve=full');
    expect(cmd.args.slice(-2)).toEqual(['--mount_scratch', 'g.iso']);
    await cmd.prepare?.();
    expect(readFileSync(a.configPath(), 'utf8')).toBe(before);
    expect(await a.recoverSession()).toEqual([]);
  });

  it('has no BIOS, reports profiles and lists persistent app paths', async () => {
    expect(await a.biosStatus()).toEqual([]);
    expect(await a.hasProfile()).toBe(false);
    expect((await a.validateEnvironment(null, null)).map((f) => f.id)).toContain('xenia.profile');
    mkdirSync(join(p.saves, 'E030000000000001', 'FFFE07D1', '00010000'), { recursive: true });
    expect(await a.hasProfile()).toBe(true);
    const noAvx = await a.validateEnvironment({ cpu: { model: 'Old', cores: 2, threads: 2, speedMHz: 2000, features: ['sse2'] }, graphicsApis: { directx12: true, vulkan: true, notes: [] } } as never, null);
    expect(noAvx.map((f) => f.id)).toContain('xenia.avx');
    expect(a.persistentAppPaths()).toContain('content');
    expect(a.persistentAppPaths()).toContain('xenia-canary.config.toml');
  });

  it('smoke test is static and reads the embedded build string', async () => {
    const dir = join(t.dir, 'smoke');
    mkdirSync(dir, { recursive: true });
    const exe = join(dir, 'xenia_canary.exe');
    writeFileSync(exe, Buffer.concat([Buffer.alloc(200000), Buffer.from('canary_experimental@c3ec0ba on 2026-10-10\0', 'latin1')]));
    const r = await a.smokeTest(exe);
    expect(r.ran).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.label === 'Build information')?.detail).toBe('canary_experimental@c3ec0ba on 2026-10-10');
    expect(await a.findExecutable(dir)).toBe(exe);
  });

  it('detects nothing when no setups exist and scales for 720p', async () => {
    expect(Array.isArray(await a.detectExistingSetups())).toBe(true);
    expect(a.defaultSettings(null, 'balanced').resolutionScale).toBe(1);
    expect(a.defaultSettings(null, 'quality').resolutionScale).toBe(2);
    expect(a.defaultSettings(null, 'balanced').renderer).toBe('d3d12');
  });
});
