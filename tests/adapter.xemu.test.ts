import { afterAll, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppPaths } from '../src/main/core/paths';
import { XemuAdapter, parseXemuVersion } from '../src/main/emulators/xemu/adapter';
import { TomlDocument, checkToml, formatValue } from '../src/main/emulators/xemu/toml';
import { defaultProfile } from '../src/main/controllers/translate';
import { DEFAULT_SETTINGS } from '../src/main/database/settingsRepo';
import { tempDir } from './helpers';

const t = tempDir();
afterAll(t.cleanup);
const paths = new AppPaths(join(t.dir, 'ud'), t.dir);
const controller = { ...defaultProfile(), id: 1, updatedAt: '' };
const hotkeys = DEFAULT_SETTINGS.hotkeys;
const fixtures = join(__dirname, 'fixtures', 'xemu');
const toml = (p: string) => TomlDocument.parse(readFileSync(p, 'utf8'));

describe('xemu TOML editor', () => {
  it('reads xemu delta output and edits values without touching other lines', () => {
    const text = readFileSync(join(fixtures, 'xemu.toml'), 'utf8');
    expect(checkToml(text).ok).toBe(true);
    const doc = TomlDocument.parse(text);
    expect(doc.get(['general', 'games_dir'])).toBe('D:\\Games\\Xbox');
    expect(doc.get(['display', 'ui', 'scale'])).toBe(1.5);
    expect(doc.get(['sys', 'files', 'dvd_path'])).toBe('D:\\Games\\Xbox\\Halo, CE.iso');
    const maps = doc.get(['input', 'gamepad_mappings']) as Record<string, unknown>[];
    expect(maps).toHaveLength(2);
    expect(maps[0]).toEqual({ gamepad_id: '030000005e0400008e02000000007200', enable_rumble: false, controller_mapping: { a: 0 } });
    expect(doc.get(['input', 'gamepad_mappings'])).toBeDefined();
    expect(doc.get(['display', 'quality', 'surface_scale'])).toBeUndefined();

    expect(doc.set(['display', 'renderer'], 'VULKAN')).toBe(false);
    expect(doc.set(['display', 'renderer'], 'OPENGL')).toBe(true);
    expect(doc.set(['display', 'window', 'vsync'], false)).toBe(true); // existing section
    expect(doc.set(['display', 'quality', 'surface_scale'], 3)).toBe(true); // new section
    expect(doc.set(['sys', 'files', 'flashrom_path'], "C:\\it's\\bios.bin")).toBe(true); // needs a basic string
    expect(doc.set(['perf', 'cache_shaders'], false)).toBe(true);
    const out = doc.toString();
    expect(out).toContain("games_dir = 'D:\\Games\\Xbox'\n");
    expect(out).toContain("renderer = 'OPENGL'\n");
    expect(out).toContain('last_height = 1080\nvsync = false\n');
    expect(out).toContain('[display.quality]\nsurface_scale = 3\n');
    expect(out).toContain('flashrom_path = "C:\\\\it\'s\\\\bios.bin"\n');
    expect(out).toContain("{ gamepad_id = '030000005e0400008e02000000007200', enable_rumble = false, controller_mapping = { a = 0}}");
    const again = TomlDocument.parse(out);
    expect(again.get(['sys', 'files', 'flashrom_path'])).toBe("C:\\it's\\bios.bin");
    expect(again.get(['display', 'quality', 'surface_scale'])).toBe(3);
    expect(again.get(['perf', 'cache_shaders'])).toBe(false);
  });

  it('handles inline tables, dotted keys, CRLF and array-of-tables sections', () => {
    const doc = TomlDocument.parse('# comment\r\ngeneral.show_welcome = true\r\n[display]\r\nui = { fit = "center" }\r\n');
    expect(doc.get(['display', 'ui', 'fit'])).toBe('center');
    expect(doc.set(['display', 'ui', 'aspect_ratio'], '16x9')).toBe(true);
    expect(doc.set(['general', 'updates', 'check'], false)).toBe(true);
    expect(doc.set(['general', 'show_welcome'], false)).toBe(true);
    const out = doc.toString();
    expect(out).toBe("# comment\r\ngeneral.show_welcome = false\r\ngeneral.updates.check = false\r\n[display]\r\nui = { fit = 'center', aspect_ratio = '16x9' }\r\n");
    expect(doc.set(['audio', 'hrtf'], false)).toBe(true);
    expect(doc.toString().endsWith("\r\n\r\n[audio]\r\nhrtf = false\r\n")).toBe(true);
    const aot = TomlDocument.parse('[[input.gamepad_mappings]]\ngamepad_id = "x"\n[input.gamepad_mappings.controller_mapping]\na = 1\n');
    expect(aot.hasArrayTables(['input', 'gamepad_mappings'])).toBe(true);
    expect(() => aot.set(['input', 'gamepad_mappings', 'enable_rumble'], false)).toThrow();
    expect(formatValue([{ a: 1 }])).toBe('[\n    { a = 1 }\n    ]');
  });

  it('flags files toml++ would reject', () => {
    expect(checkToml('[general]\nshow_welcome = false\nshow_welcome = true\n').ok).toBe(false);
    expect(checkToml('[general]\n[general]\n').ok).toBe(false);
    expect(checkToml("[sys.files]\nhdd_path = 'C:\\x\n").ok).toBe(false);
    expect(checkToml('a = [1, 2\n').ok).toBe(false);
    expect(checkToml('a = 1 b = 2\n').ok).toBe(false);
    expect(checkToml('s = """multi\nline"""\nt = \'\'\'raw\\n\'\'\'\nd = 1979-05-27 07:32:00\nh = 0xff\n').ok).toBe(true);
  });
});

describe('xemu adapter', () => {
  const a = new XemuAdapter(paths);
  const p = a.paths();
  const settings = a.defaultSettings(null, 'balanced');
  const bios = (f: string) => join(p.bios, f);

  it('reports each system file with size validation, missing first', async () => {
    let st = await a.biosStatus();
    expect(st).toHaveLength(3);
    expect(st.every((s) => s.status === 'missing' && s.required && s.systemId === 'xbox')).toBe(true);
    mkdirSync(p.bios, { recursive: true });
    writeFileSync(bios('mcpx_1.0.bin'), Buffer.alloc(511));
    writeFileSync(bios('Complex_4627.bin'), Buffer.alloc(256 * 1024));
    writeFileSync(bios('xbox_hdd.qcow2'), Buffer.concat([Buffer.from('QFI\xfb', 'latin1'), Buffer.alloc(60)]));
    st = await a.biosStatus();
    expect(st[0].label).toBe('Xbox MCPX boot ROM');
    expect(st[0].status).toBe('invalid');
    expect(st[0].files[0].description).toMatch(/expected 512/);
    expect(st.find((s) => s.label === 'Xbox flash BIOS')?.status).toBe('found');
    expect(st.find((s) => s.label === 'Xbox hard disk image')?.status).toBe('found');
    writeFileSync(bios('mcpx_1.0.bin'), Buffer.alloc(512));
    writeFileSync(bios('eeprom.bin'), Buffer.alloc(256, 1));
    st = await a.biosStatus();
    expect(st.every((s) => s.status === 'found')).toBe(true);
    writeFileSync(bios('broken_hdd.img'), 'not qcow');
    const hdd = (await a.biosStatus()).find((s) => s.label === 'Xbox hard disk image')!;
    expect(hdd.status).toBe('found');
    expect(hdd.files.find((f) => f.path.endsWith('broken_hdd.img'))?.valid).toBe(false);
  });

  it('generates paths, graphics and controller settings while keeping user keys', async () => {
    mkdirSync(p.data, { recursive: true });
    copyFileSync(join(fixtures, 'xemu.toml'), a.configPath());
    const res = await a.applyConfig({ settings: { ...settings, renderer: 'opengl', resolutionScale: 3, aspectRatio: '16:9', vsync: false }, controller, hotkeys, hardware: null }, 'all');
    expect(res.changed.length).toBeGreaterThan(5);
    const doc = toml(a.configPath());
    expect(doc.get(['general', 'show_welcome'])).toBe(false);
    expect(doc.get(['general', 'updates', 'check'])).toBe(false);
    expect(doc.get(['sys', 'files', 'bootrom_path'])).toBe(bios('mcpx_1.0.bin'));
    expect(doc.get(['sys', 'files', 'flashrom_path'])).toBe(bios('Complex_4627.bin'));
    expect(doc.get(['sys', 'files', 'hdd_path'])).toBe(bios('xbox_hdd.qcow2'));
    expect(doc.get(['sys', 'files', 'eeprom_path'])).toBe(join(p.saves, 'eeprom.bin'));
    expect(readFileSync(join(p.saves, 'eeprom.bin'))).toEqual(Buffer.alloc(256, 1));
    expect(doc.get(['general', 'screenshot_dir'])).toBe(join(p.saves, 'screenshots'));
    expect(doc.get(['display', 'renderer'])).toBe('OPENGL');
    expect(doc.get(['display', 'quality', 'surface_scale'])).toBe(3);
    expect(doc.get(['display', 'window', 'fullscreen_on_startup'])).toBe(true);
    expect(doc.get(['display', 'window', 'vsync'])).toBe(false);
    expect(doc.get(['display', 'ui', 'aspect_ratio'])).toBe('16x9');
    expect(doc.get(['display', 'ui', 'fit'])).toBeUndefined(); // default value, not written
    // user keys preserved
    expect(doc.get(['general', 'games_dir'])).toBe('D:\\Games\\Xbox');
    expect(doc.get(['display', 'ui', 'scale'])).toBe(1.5);
    expect(doc.get(['input', 'bindings', 'port1'])).toBe('030000005e0400008e02000000007200');
    expect(doc.get(['sys', 'files', 'dvd_path'])).toBe('D:\\Games\\Xbox\\Halo, CE.iso');
    // controller: identity mapping keeps defaults; rumble turned back on where it was off
    const maps = doc.get(['input', 'gamepad_mappings']) as { enable_rumble?: boolean; controller_mapping?: Record<string, number> }[];
    expect(maps[0].enable_rumble).toBe(true);
    expect(maps[0].controller_mapping).toEqual({ a: 0 });
    expect(maps[1]).toEqual({ gamepad_id: '03000000de280000ff11000001000000' });
    expect(res.notes.some((n) => /deadzone/.test(n))).toBe(true);
    expect(res.notes.some((n) => /Back\+Start/.test(n))).toBe(true); // default menu hotkey Select+Y is not xemu's
  });

  it('is idempotent and keeps a user key', async () => {
    const doc = toml(a.configPath());
    doc.set(['audio', 'use_dsp'], true);
    writeFileSync(a.configPath(), doc.toString());
    const again = await a.applyConfig({ settings: { ...settings, renderer: 'opengl', resolutionScale: 3, aspectRatio: '16:9', vsync: false }, controller, hotkeys, hardware: null }, 'all');
    expect(again.changed).toEqual([]);
    expect(toml(a.configPath()).get(['audio', 'use_dsp'])).toBe(true);
  });

  it('translates remaps, trigger swaps and disabled rumble into SDL indices', async () => {
    const remap = { ...controller, rumble: false, mapping: { ...controller.mapping, A: 'B' as const, B: 'A' as const, LT: 'RT' as const, RT: 'LT' as const, LeftStickUp: 'LeftStickDown' as const, LB: 'LT' as const } };
    const r = await a.applyConfig({ settings, controller: remap, hotkeys: { ...hotkeys, modifier: 'Select', bindings: { ...hotkeys.bindings, menu: 'Start' } }, hardware: null }, 'controller');
    const maps = toml(a.configPath()).get(['input', 'gamepad_mappings']) as { enable_rumble?: boolean; controller_mapping?: Record<string, number | boolean> }[];
    for (const m of maps) {
      expect(m.enable_rumble).toBe(false);
      expect(m.controller_mapping).toMatchObject({ a: 1, b: 0, axis_trigger_left: 5, axis_trigger_right: 4, invert_axis_left_y: true });
      expect(m.controller_mapping?.lshoulder).toBeUndefined(); // LT is an axis: White keeps its default
    }
    expect(r.notes.some((n) => /lshoulder/.test(n))).toBe(true);
    expect(r.notes.some((n) => /Back\+Start/.test(n))).toBe(false);
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'controller');
    const back = toml(a.configPath()).get(['input', 'gamepad_mappings']) as { controller_mapping?: Record<string, number | boolean> }[];
    expect(back[0].controller_mapping).toMatchObject({ a: 0, b: 1, axis_trigger_left: 4, invert_axis_left_y: false });
  });

  it('notes when no controller has been seen yet', async () => {
    const root = join(t.dir, 'other');
    const b = new XemuAdapter(new AppPaths(join(root, 'ud'), root));
    const r = await b.applyConfig({ settings, controller, hotkeys, hardware: null }, 'all');
    expect(r.notes.some((n) => /SDL GUID/.test(n))).toBe(true);
    expect(r.notes.some((n) => /MCPX/.test(n))).toBe(true);
    const doc = toml(b.configPath());
    expect(doc.get(['input', 'gamepad_mappings'])).toBeUndefined();
    expect(doc.get(['sys', 'files', 'bootrom_path'])).toBeUndefined();
    expect((await b.applyConfig({ settings, controller, hotkeys, hardware: null }, 'all')).changed).toEqual([]);
  });

  it('detects drift on the first-boot flag and system file paths', async () => {
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'all');
    expect((await a.inspectConfig()).drift).toEqual([]);
    const doc = toml(a.configPath());
    doc.set(['general', 'show_welcome'], true);
    doc.set(['sys', 'files', 'flashrom_path'], 'C:\\elsewhere\\bios.bin');
    doc.set(['general', 'updates', 'check'], true);
    writeFileSync(a.configPath(), doc.toString());
    let insp = await a.inspectConfig();
    expect(insp.drift.find((d) => d.key === 'general.show_welcome')?.critical).toBe(true);
    expect(insp.drift.find((d) => d.key === 'sys.files.flashrom_path')?.critical).toBe(true);
    expect(insp.drift.find((d) => d.key === 'general.updates.check')?.critical).toBe(false);
    // xemu drops default-valued keys: a removed show_welcome means "true" again.
    writeFileSync(a.configPath(), readFileSync(a.configPath(), 'utf8').replace('show_welcome = true\n', ''));
    insp = await a.inspectConfig();
    expect(insp.drift.find((d) => d.key === 'general.show_welcome')?.actual).toBeNull();
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'paths');
    expect((await a.inspectConfig()).drift).toEqual([]);
    const saved = readFileSync(a.configPath(), 'utf8');
    writeFileSync(a.configPath(), '[general]\nshow_welcome = fals');
    expect((await a.inspectConfig()).files[0].parseOk).toBe(false);
    expect((await a.smokeTest(join(t.dir, 'nope.exe'))).ok).toBe(false);
    writeFileSync(a.configPath(), saved);
  });

  it('builds a launch with -config_path, -full-screen and -dvd_path <game> last', async () => {
    const game = 'D:\\Xbox\\Halo, Combat Evolved.iso';
    const cmd = await a.buildLaunch({ gameId: 1, path: game, systemId: 'xbox', serial: null, title: 'Halo' }, 'C:\\xemu\\xemu.exe', settings, null, '0.8.136');
    expect(cmd.args).toEqual(['-config_path', a.configPath(), '-full-screen', '-dvd_path', game]);
    expect(cmd.cwd).toBe(p.data);
    expect(cmd.logFile).toBe(join(p.data, 'xemu.log'));
    // prepare re-points system files added after the last applyConfig
    const doc = toml(a.configPath());
    doc.set(['sys', 'files', 'hdd_path'], 'C:\\old.qcow2');
    writeFileSync(a.configPath(), doc.toString());
    await cmd.prepare!();
    expect(toml(a.configPath()).get(['sys', 'files', 'hdd_path'])).toBe(bios('xbox_hdd.qcow2'));
    const windowed = await a.buildLaunch({ gameId: 1, path: 'g.iso', systemId: 'xbox', serial: null, title: 'G' }, 'x.exe', { ...settings, fullscreen: false }, null, null);
    expect(windowed.args).toEqual(['-config_path', a.configPath(), '-dvd_path', 'g.iso']);
    expect(a.buildUiLaunch('x.exe').args).toEqual(['-config_path', a.configPath()]);
  });

  it('applies per-game profiles through a separate -config_path file', async () => {
    const before = readFileSync(a.configPath(), 'utf8');
    const profile = { gameId: 7, emulatorId: null, overrides: { renderer: 'vulkan', resolutionScale: 4, advanced: { 'general.skip_boot_anim': 'true' } }, customArgs: '-snapshot', notes: null, updatedAt: '' };
    const cmd = await a.buildLaunch({ gameId: 7, path: 'g.iso', systemId: 'xbox', serial: null, title: 'G' }, 'x.exe', settings, profile, null);
    expect(cmd.args.slice(0, 2)).toEqual(['-config_path', a.gameConfigPath(7)]);
    expect(cmd.args.slice(-3)).toEqual(['-snapshot', '-dvd_path', 'g.iso']);
    await cmd.prepare!();
    const g = toml(a.gameConfigPath(7));
    expect(g.get(['display', 'renderer'])).toBe('VULKAN');
    expect(g.get(['display', 'quality', 'surface_scale'])).toBe(4);
    expect(g.get(['general', 'skip_boot_anim'])).toBe(true);
    expect(g.get(['general', 'show_welcome'])).toBe(false);
    expect(g.get(['sys', 'files', 'bootrom_path'])).toBe(bios('mcpx_1.0.bin'));
    expect(readFileSync(a.configPath(), 'utf8')).toBe(before);
    expect(await a.recoverSession()).toEqual([]);
  });

  it('smoke test, versions, CPU check and portable paths', async () => {
    const appDir = join(t.dir, 'smoke');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'xemu.exe'), 'MZ\x90\x00');
    const r = await a.smokeTest(join(appDir, 'xemu.exe'));
    expect(r.ran).toBe(false);
    expect(r.ok).toBe(true);
    expect(await a.findExecutable(appDir)).toBe(join(appDir, 'xemu.exe'));
    expect(parseXemuVersion('xemu_version: 0.8.136\nxemu_commit: abc\n')).toBe('0.8.136');
    const hw = { cpu: { model: 'Old CPU', cores: 4, threads: 4, speedMHz: 3000, features: ['sse41', 'avx'] }, graphicsApis: { directx12: true, vulkan: true, opengl: true, notes: [] } } as never;
    const f = await a.validateEnvironment(hw, join(appDir, 'xemu.exe'));
    expect(f.find((x) => x.id === 'xemu.avx2')?.severity).toBe('problem');
    writeFileSync(join(appDir, 'xemu.toml'), '');
    expect((await a.validateEnvironment(null, join(appDir, 'xemu.exe'))).some((x) => x.id === 'xemu.portable')).toBe(true);
    expect(a.persistentAppPaths()).toContain('xemu.toml');
    expect(await a.prepareInstall(appDir)).toEqual([]);
    expect(existsSync(join(p.data, 'README-OmniDeck.txt'))).toBe(true);
    expect(a.defaultSettings(null, 'balanced').renderer).toBe('opengl');
    expect(a.manifest.implemented).toBe(true);
  });

  it('finds existing xemu setups and offers their system file folders', async () => {
    const home = join(t.dir, 'home');
    const prev = process.env.APPDATA;
    process.env.APPDATA = join(home, 'AppData', 'Roaming');
    try {
      const pref = join(process.env.APPDATA, 'xemu', 'xemu');
      mkdirSync(pref, { recursive: true });
      const own = join(t.dir, 'mybios');
      mkdirSync(own, { recursive: true });
      writeFileSync(join(own, 'mcpx.bin'), Buffer.alloc(512));
      writeFileSync(join(pref, 'xemu.toml'), `[sys.files]\nbootrom_path = '${join(own, 'mcpx.bin')}'\nhdd_path = 'Z:\\nope.qcow2'\n`);
      const c = (await a.detectExistingSetups()).find((x) => x.path === pref)!;
      expect(c.importable.settings).toBe(true);
      expect(c.importable.bios).toBe(true);
      expect(c.biosDirs).toEqual([{ dir: own, systemId: 'xbox' }]);
      expect(c.details.some((d) => d.includes('(missing)'))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = prev;
    }
  });
});
