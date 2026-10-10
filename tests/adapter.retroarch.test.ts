import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppPaths } from '../src/main/core/paths';
import { CORE_BASE_URL, RetroArchAdapter } from '../src/main/emulators/retroarch/adapter';
import { CfgDocument, checkCfg } from '../src/main/emulators/retroarch/cfg';
import { validateManifest } from '../src/main/emulators/registry';
import { sourceForManifest } from '../src/main/downloads/sources';
import { defaultProfile } from '../src/main/controllers/translate';
import { DEFAULT_SETTINGS } from '../src/main/database/settingsRepo';
import type { ComponentInstaller } from '../src/main/emulators/adapter';
import type { GameProfile } from '../src/shared/models';
import { tempDir } from './helpers';

const t = tempDir();
afterAll(t.cleanup);
const paths = new AppPaths(join(t.dir, 'ud'), t.dir);
const controller = { ...defaultProfile(), id: 1, updatedAt: '' };
const hotkeys = DEFAULT_SETTINGS.hotkeys;

describe('RetroArch cfg format', () => {
  it('parses quoted/unquoted values, preserves comments and updates in place', () => {
    const doc = CfgDocument.parse('# comment\nvideo_driver = "gl"\naudio_volume = 0.0\n#include "x.cfg"\n');
    expect(doc.get('video_driver')).toBe('gl');
    expect(doc.get('audio_volume')).toBe('0.0');
    expect(doc.set('video_driver', 'gl')).toBe(false);
    expect(doc.set('video_driver', 'vulkan')).toBe(true);
    expect(doc.set('new_key', true)).toBe(true);
    expect(doc.toString()).toBe('# comment\nvideo_driver = "vulkan"\naudio_volume = 0.0\n#include "x.cfg"\nnew_key = "true"\n');
    expect(checkCfg('video_driver = "gl\n').ok).toBe(false);
    expect(checkCfg('a = "C:\\Games\\x y"\n').ok).toBe(true);
  });
});

describe('RetroArch adapter', () => {
  const a = new RetroArchAdapter(paths);
  const settings = a.defaultSettings(null, 'balanced');
  const read = () => CfgDocument.parse(readFileSync(a.cfgPath(), 'utf8'));
  const p = a.paths();

  it('has a valid versioned-url manifest on buildbot', async () => {
    expect(validateManifest(a.manifest)).toEqual([]);
    expect(a.manifest.implemented).toBe(true);
    const src = sourceForManifest(a.manifest)!;
    const fetchImpl = (async () => new Response(JSON.stringify({ tag_name: 'v1.22.2' }), { status: 200 })) as unknown as typeof fetch;
    const rel = await src.resolveLatest({ fetchImpl } as never);
    expect(rel.version).toBe('1.22.2');
    expect(rel.url).toBe('https://buildbot.libretro.com/stable/1.22.2/windows/x86_64/RetroArch.7z');
    expect(rel.sha256).toBeNull();
  });

  it('keeps config, cores and BIOS outside the program folder', () => {
    expect(a.cfgPath()).toBe(join(paths.emulatorDataDir('retroarch'), 'retroarch.cfg'));
    expect(a.coresDir()).toBe(join(paths.emulatorDataDir('retroarch'), 'cores'));
    expect(p.bios).toBe(paths.systemBiosDir('retroarch'));
  });

  it('generates paths, prompt suppression, graphics, controller and hotkeys', async () => {
    const res = await a.applyConfig({ settings: { ...settings, renderer: 'vulkan', aspectRatio: '4:3' }, controller, hotkeys, hardware: null }, 'all');
    expect(res.changed.length).toBeGreaterThan(60);
    const c = read();
    expect(c.get('savefile_directory')).toBe(join(p.saves, 'saves'));
    expect(c.get('savestate_directory')).toBe(join(p.saves, 'states'));
    expect(c.get('system_directory')).toBe(paths.systemBiosDir('retroarch'));
    expect(c.get('libretro_directory')).toBe(a.coresDir());
    expect(c.get('rgui_config_directory')).toBe(join(p.data, 'config'));
    expect(c.get('cache_directory')).toBe(paths.emulatorCacheDir('retroarch'));
    expect(c.get('log_dir')).toBe(join(p.data, 'logs'));
    expect(c.get('log_to_file')).toBe('true');
    expect(c.get('log_verbosity')).toBe('true');
    expect(c.get('savefiles_in_content_dir')).toBe('false');
    expect(c.get('config_save_on_exit')).toBe('false');
    expect(c.get('quit_press_twice')).toBe('false');
    expect(c.get('confirm_quit')).toBe('false');
    expect(c.get('quit_on_close_content')).toBe('2');
    expect(c.get('pause_nonactive')).toBe('false');
    expect(c.get('rgui_show_start_screen')).toBe('false');
    expect(c.get('video_driver')).toBe('vulkan');
    expect(c.get('video_fullscreen')).toBe('true');
    expect(c.get('aspect_ratio_index')).toBe('0');
    expect(c.get('input_joypad_driver')).toBe('xinput');
    expect(c.get('input_player1_joypad_index')).toBe('0');
    // RetroPad B (bottom) = XInput A (0), RetroPad A (right) = XInput B (1).
    expect(c.get('input_player1_b_btn')).toBe('0');
    expect(c.get('input_player1_a_btn')).toBe('1');
    expect(c.get('input_player1_y_btn')).toBe('2');
    expect(c.get('input_player1_x_btn')).toBe('3');
    expect(c.get('input_player1_select_btn')).toBe('7');
    expect(c.get('input_player1_start_btn')).toBe('6');
    expect(c.get('input_player1_up_btn')).toBe('h0up');
    expect(c.get('input_player1_l2_axis')).toBe('+4');
    expect(c.get('input_player1_l2_btn')).toBe('nul');
    expect(c.get('input_player1_l_y_plus_axis')).toBe('-1');
    expect(c.get('input_player1_l_y_minus_axis')).toBe('+1');
    expect(c.get('input_player1_r_x_plus_axis')).toBe('+2');
    expect(c.get('input_analog_deadzone')).toBe('0.15');
    expect(c.get('input_rumble_gain')).toBe('100');
    expect(c.get('input_enable_hotkey_btn')).toBe('7');
    expect(c.get('input_exit_emulator_btn')).toBe('6');
    expect(c.get('input_save_state_btn')).toBe('5');
    expect(c.get('input_load_state_btn')).toBe('4');
    expect(c.get('input_menu_toggle_btn')).toBe('3');
    expect(c.get('input_volume_up_btn')).toBe('h0up');
    expect(c.get('input_toggle_fast_forward_axis')).toBe('+5');
    expect(c.get('input_toggle_fast_forward_btn')).toBe('nul');
    expect(existsSync(join(p.saves, 'states'))).toBe(true);
    expect(existsSync(a.systemInputPath('snes'))).toBe(true);
  });

  it('writes per-system bindings honouring the Nintendo layout swap', async () => {
    const nintendo = { ...controller, nintendoLayoutForNintendoSystems: true };
    await a.applyConfig({ settings, controller: nintendo, hotkeys, hardware: null }, 'controller');
    const snes = CfgDocument.parse(readFileSync(a.systemInputPath('snes'), 'utf8'));
    const gen = CfgDocument.parse(readFileSync(a.systemInputPath('genesis'), 'utf8'));
    // SNES B (RetroPad b) on the button labelled B on an Xbox pad (right, index 1).
    expect(snes.get('input_player1_b_btn')).toBe('1');
    expect(snes.get('input_player1_a_btn')).toBe('0');
    expect(gen.get('input_player1_b_btn')).toBe('0');
    // Global config keeps the plain mapping.
    expect(read().get('input_player1_b_btn')).toBe('0');
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'controller');
  });

  it('preserves user keys and is idempotent', async () => {
    writeFileSync(a.cfgPath(), readFileSync(a.cfgPath(), 'utf8') + 'menu_driver = "ozone"\n# my note\n');
    const input = { settings: { ...settings, renderer: 'vulkan', aspectRatio: '4:3' }, controller, hotkeys, hardware: null };
    const res = await a.applyConfig(input, 'all');
    expect(res.changed).toEqual([]);
    const text = readFileSync(a.cfgPath(), 'utf8');
    expect(text).toContain('menu_driver = "ozone"');
    expect(text).toContain('# my note');
  });

  it('detects drift on critical paths and parse errors', async () => {
    const c = read();
    c.set('savefile_directory', ':\\saves');
    c.set('savestates_in_content_dir', 'true');
    writeFileSync(a.cfgPath(), c.toString());
    const insp = await a.inspectConfig();
    expect(insp.files[0].parseOk).toBe(true);
    const d = insp.drift.find((x) => x.key === 'savefile_directory')!;
    expect(d.critical).toBe(true);
    expect(d.actual).toBe(':\\saves');
    expect(insp.drift.find((x) => x.key === 'savestates_in_content_dir')?.critical).toBe(true);
    expect(insp.drift.find((x) => x.key === 'system_directory')).toBeUndefined();
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'paths');
    expect((await a.inspectConfig()).drift).toEqual([]);
    const good = readFileSync(a.cfgPath(), 'utf8');
    writeFileSync(a.cfgPath(), good + 'broken = "unterminated\n');
    expect((await a.inspectConfig()).files[0].parseOk).toBe(false);
    writeFileSync(a.cfgPath(), good);
  });

  it('builds a fullscreen launch with config, per-system input, core and ROM last', async () => {
    const target = { gameId: 1, path: 'D:\\ROMs\\snes\\Game (USA).sfc', systemId: 'snes' as const, serial: null, title: 'Game' };
    await expect(a.buildLaunch(target, 'C:\\ra\\retroarch.exe', settings, null, null)).rejects.toThrow(/core "snes9x"/);
    mkdirSync(a.coresDir(), { recursive: true });
    writeFileSync(a.corePath('snes9x'), 'MZ');
    const cmd = await a.buildLaunch(target, 'C:\\ra\\retroarch.exe', settings, null, null);
    expect(cmd.args).toEqual(['--config', a.cfgPath(), '--appendconfig', a.systemInputPath('snes'), '-L', a.corePath('snes9x'), '-f', target.path]);
    expect(cmd.logFile).toBe(join(p.data, 'logs', 'retroarch.log'));
    expect(cmd.cwd).toBe(p.app);
  });

  it('routes cores by extension and advanced override, refuses unsupported systems', async () => {
    expect(a.coreFor('genesis', 'x.32x')).toBe('picodrive');
    expect(a.coreFor('genesis', 'x.md')).toBe('genesis_plus_gx');
    expect(a.coreFor('nes', 'x.nes', { 'core|nes': 'fceumm' })).toBe('fceumm');
    expect(a.coreFor('nes', 'x.nes', { 'core|nes': '../evil' })).toBe('mesen');
    expect(a.requiredCores()).toEqual(expect.arrayContaining(['mesen', 'snes9x', 'mupen64plus_next', 'gambatte', 'mgba', 'genesis_plus_gx', 'picodrive', 'fbneo']));
    const ps1 = { gameId: 2, path: 'x.cue', systemId: 'ps1' as const, serial: null, title: 'x' };
    await expect(a.buildLaunch(ps1, 'retroarch.exe', settings, null, null)).rejects.toThrow(/does not set up/);
  });

  it('applies per-game profiles through a session append file and filters custom args', async () => {
    const target = { gameId: 1, path: 'D:\\ROMs\\snes\\Game.sfc', systemId: 'snes' as const, serial: null, title: 'Game' };
    const profile: GameProfile = { gameId: 1, emulatorId: 'retroarch', overrides: { renderer: 'glcore', fullscreen: false, advanced: { 'cfg|video_smooth': 'true' } }, customArgs: '--verbose --bogus --set-shader "crt.slangp"', notes: null, updatedAt: '' };
    const cmd = await a.buildLaunch(target, 'retroarch.exe', settings, profile, null);
    const session = join(p.data, 'omnideck', 'session.cfg');
    expect(cmd.args[3]).toBe(`${a.systemInputPath('snes')}|${session}`);
    expect(cmd.args).not.toContain('-f');
    expect(cmd.args).toContain('--verbose');
    expect(cmd.args).toContain('crt.slangp');
    expect(cmd.args).not.toContain('--bogus');
    expect(cmd.args[cmd.args.length - 1]).toBe(target.path);
    const before = readFileSync(a.cfgPath(), 'utf8');
    await cmd.prepare!();
    const s = CfgDocument.parse(readFileSync(session, 'utf8'));
    expect(s.get('video_driver')).toBe('glcore');
    expect(s.get('video_smooth')).toBe('true');
    expect(readFileSync(a.cfgPath(), 'utf8')).toBe(before);
    expect(await a.recoverSession()).toHaveLength(1);
    await cmd.cleanup!();
    expect(existsSync(session)).toBe(false);
    expect(await a.recoverSession()).toEqual([]);
  });

  it('reports optional BIOS and copies imported BIOS into the system folder', async () => {
    let st = await a.biosStatus();
    expect(st.find((b) => b.systemId === 'gba')?.status).toBe('not_applicable');
    mkdirSync(paths.systemBiosDir('gba'), { recursive: true });
    writeFileSync(join(paths.systemBiosDir('gba'), 'gba_bios.bin'), Buffer.alloc(16384));
    mkdirSync(paths.systemBiosDir('nes'), { recursive: true });
    writeFileSync(join(paths.systemBiosDir('nes'), 'disksys.rom'), Buffer.alloc(100));
    const res = await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'paths');
    expect(res.notes.join()).toMatch(/gba_bios\.bin/);
    expect(existsSync(join(p.bios, 'gba_bios.bin'))).toBe(true);
    expect(existsSync(join(p.bios, 'disksys.rom'))).toBe(false);
    st = await a.biosStatus();
    expect(st.find((b) => b.systemId === 'gba')?.status).toBe('found');
    expect(st.find((b) => b.systemId === 'nes')?.status).toBe('invalid');
  });

  it('installs missing cores from the buildbot, skips present ones and rejects bad archives', async () => {
    const urls: string[] = [];
    const dl = join(t.dir, 'dl');
    mkdirSync(dl, { recursive: true });
    const installer: ComponentInstaller = {
      download: async (o) => {
        urls.push(o.url);
        const f = join(dl, o.fileName);
        writeFileSync(f, o.fileName);
        return f;
      },
      extract: async (archive, dest) => {
        mkdirSync(dest, { recursive: true });
        const name = archive.split(/[\\/]/).pop()!.replace(/\.zip$/, '');
        if (name.startsWith('fbneo')) {
          writeFileSync(join(dest, name), 'MZ');
          writeFileSync(join(dest, 'evil.exe'), 'MZ');
        } else if (name.startsWith('mgba')) writeFileSync(join(dest, name), 'not a dll');
        else writeFileSync(join(dest, name), 'MZ core');
      },
      cleanup: async () => undefined,
      progress: () => undefined,
    };
    const notes = await a.installComponents(installer, { settings, controller, hotkeys, hardware: null });
    expect(urls).toContain(`${CORE_BASE_URL}mesen_libretro.dll.zip`);
    expect(urls.every((u) => u.startsWith('https://buildbot.libretro.com/nightly/windows/x86_64/latest/'))).toBe(true);
    expect(urls).not.toContain(`${CORE_BASE_URL}snes9x_libretro.dll.zip`);
    expect(existsSync(a.corePath('mesen'))).toBe(true);
    expect(existsSync(a.corePath('fbneo'))).toBe(false);
    expect(existsSync(a.corePath('mgba'))).toBe(false);
    expect(existsSync(join(a.coresDir(), 'evil.exe'))).toBe(false);
    expect(notes.join(' ')).toMatch(/Could not install: .*fbneo/);
    expect(notes.join(' ')).toMatch(/Already installed: snes9x/);
    expect(a.missingCores().sort()).toEqual(['fbneo', 'mgba']);
    const smoke = await a.smokeTest(join(t.dir, 'nope.exe'));
    expect(smoke.ok).toBe(false);
  });

  it('smoke test checks config and cores statically off Windows', async () => {
    mkdirSync(p.app, { recursive: true });
    const exe = join(p.app, 'retroarch.exe');
    writeFileSync(exe, 'MZ');
    expect(await a.findExecutable(p.app)).toBe(exe);
    writeFileSync(a.corePath('fbneo'), 'MZ');
    writeFileSync(a.corePath('mgba'), 'MZ');
    const r = await a.smokeTest(exe);
    if (process.platform !== 'win32') expect(r.ran).toBe(false);
    expect(r.checks.find((c) => c.label === 'Cores installed')?.ok).toBe(true);
    expect(r.checks.find((c) => c.label === 'Configuration parses')?.ok).toBe(true);
  });

  it('offers saves and the system folder of an existing setup', async () => {
    const root = join(t.dir, 'RetroArch-Win64');
    mkdirSync(join(root, 'saves'), { recursive: true });
    writeFileSync(join(root, 'retroarch.exe'), 'MZ');
    writeFileSync(join(root, 'retroarch.cfg'), 'savefile_directory = ":\\saves"\nsystem_directory = "default"\n');
    const c = await (a as unknown as { candidateFrom: (r: string, l: string, e: string | null) => Promise<import('../src/shared/models').SetupImportCandidate> }).candidateFrom(root, 'test', join(root, 'retroarch.exe'));
    expect(c.source).toBe('retroarch');
    expect(c.importable.useInstallation).toBe(true);
    expect(c.saveCopies?.[0].from).toBe(join(root, 'saves'));
    expect(c.saveCopies?.[2]).toEqual({ from: join(root, 'system'), to: p.bios, label: expect.any(String) });
  });
});
