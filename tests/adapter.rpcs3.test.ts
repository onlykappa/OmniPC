import { afterAll, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { AppPaths } from '../src/main/core/paths';
import { Rpcs3Adapter, parseRpcs3Version, rpcs3Dir } from '../src/main/emulators/rpcs3/adapter';
import { YamlDocument, checkYaml } from '../src/main/emulators/rpcs3/yaml';
import { defaultProfile } from '../src/main/controllers/translate';
import { DEFAULT_SETTINGS } from '../src/main/database/settingsRepo';
import { IniDocument } from '../src/main/config/ini';
import { tempDir } from './helpers';

const t = tempDir();
afterAll(t.cleanup);
const paths = new AppPaths(join(t.dir, 'ud'), t.dir);
const controller = { ...defaultProfile(), id: 1, updatedAt: '' };
const hotkeys = DEFAULT_SETTINGS.hotkeys;
const fixtures = join(__dirname, 'fixtures', 'rpcs3');
const yml = (p: string) => YamlDocument.parse(readFileSync(p, 'utf8'));

describe('RPCS3 YAML editor', () => {
  it('reads and merges yaml-cpp output without touching unrelated lines', () => {
    const text = readFileSync(join(fixtures, 'config.yml'), 'utf8');
    const doc = YamlDocument.parse(text);
    expect(checkYaml(text).ok).toBe(true);
    expect(doc.get(['Video', 'Renderer'])).toBe('OpenGL');
    expect(doc.get(['Video', 'Vulkan', 'Adapter'])).toBe('');
    expect(doc.get(['Miscellaneous', 'Window Title Format'])).toBe('FPS: %F | %R | %V | %T [%t]');
    expect(doc.get(['Core', 'Libraries LLE'])).toBeUndefined();
    expect(doc.set(['Video', 'Renderer'], 'Vulkan')).toBe(true);
    expect(doc.set(['Video', 'Renderer'], 'Vulkan')).toBe(false);
    expect(doc.set(['Video', 'Vulkan', 'Exclusive Fullscreen Mode'], 'Disable')).toBe(true);
    expect(doc.set(['Savestate', 'Start Paused'], true)).toBe(true);
    expect(doc.set(['Log', 'RSX'], 'Warning')).toBe(true);
    const out = doc.toString();
    expect(out).toContain('    - libsysutil.sprx\n');
    expect(out).toContain('  Window Title Format: "FPS: %F | %R | %V | %T [%t]"\n');
    expect(out).toContain('Log:\n  RSX: Warning\n');
    expect(out).toContain('Savestate:\n  Start Paused: true\n');
    expect(checkYaml(out).ok).toBe(true);
    const again = YamlDocument.parse(out);
    expect(again.get(['Video', 'Vulkan', 'Exclusive Fullscreen Mode'])).toBe('Disable');
    expect(again.get(['Video', 'Performance Overlay', 'Font'])).toBe('n023055ms.ttf');
    expect(again.get(['Core', 'PPU Threads'])).toBe('2');
  });

  it('quotes values that would otherwise be comments and flags truncated files', () => {
    const doc = YamlDocument.empty();
    doc.set(['Player 1 Input', 'Device'], 'XInput Pad #1');
    expect(doc.toString()).toBe("Player 1 Input:\n  Device: 'XInput Pad #1'\n");
    expect(YamlDocument.parse(doc.toString()).get(['Player 1 Input', 'Device'])).toBe('XInput Pad #1');
    expect(checkYaml('Video:\n  Renderer: "Vulk\n').ok).toBe(false);
    expect(checkYaml('Video:\n\tRenderer: Vulkan\n').ok).toBe(false);
    expect(checkYaml('Video:\n  Renderer: Vulkan\n      Oops: 1\n').ok).toBe(false);
  });
});

describe('RPCS3 adapter', () => {
  const a = new Rpcs3Adapter(paths);
  const p = a.paths();
  const settings = a.defaultSettings(null, 'balanced');

  it('generates vfs, config, gui and controller files', async () => {
    mkdirSync(a.configDir(), { recursive: true });
    copyFileSync(join(fixtures, 'config.yml'), a.configYml());
    copyFileSync(join(fixtures, 'vfs.yml'), a.vfsYml());
    const res = await a.applyConfig({ settings: { ...settings, renderer: 'vulkan', resolutionScale: 2, aspectRatio: '4:3' }, controller, hotkeys, hardware: null }, 'all');
    expect(res.changed.length).toBeGreaterThan(30);

    const vfs = yml(a.vfsYml());
    expect(vfs.get(['/dev_hdd0/'])).toBe(rpcs3Dir(join(p.saves, 'dev_hdd0')));
    expect(vfs.get(['/dev_hdd0/'])).toMatch(/\/$/);
    expect(vfs.get(['/dev_flash/'])).toBe(rpcs3Dir(join(p.data, 'dev_flash')));
    expect(vfs.get(['/dev_usb***/', '/dev_usb000', 'Path'])).toBe(rpcs3Dir(join(p.saves, 'dev_usb000')));
    expect(vfs.get(['/dev_usb***/', '/dev_usb000', 'Serial'])).toBe('');
    expect(vfs.get(['/dev_flash2/'])).toBe('$(EmulatorDir)dev_flash2/');

    const cfg = yml(a.configYml());
    expect(cfg.get(['Video', 'Renderer'])).toBe('Vulkan');
    expect(cfg.get(['Video', 'Resolution Scale'])).toBe('200');
    expect(cfg.get(['Video', 'Aspect ratio'])).toBe('4:3');
    expect(cfg.get(['Video', 'Resolution'])).toBe('1280x720');
    expect(cfg.get(['Miscellaneous', 'Exit RPCS3 when process finishes'])).toBe('true');
    expect(cfg.get(['Miscellaneous', 'Start games in fullscreen mode'])).toBe('true');
    expect(cfg.get(['Core', 'PPU Decoder'])).toBe('Recompiler (LLVM)');

    const gui = IniDocument.parse(readFileSync(a.guiIni(), 'utf8'));
    expect(gui.get('main_window', 'infoBoxEnabledWelcome')).toBe('false');
    expect(gui.get('main_window', 'confirmationBoxExitGame')).toBe('false');
    expect(gui.get('Meta', 'checkUpdateStart')).toBe('false');
    expect(readFileSync(a.guiIni(), 'utf8')).toMatch(/^checkUpdateStart=false/m);

    const pad = yml(a.inputYml());
    expect(pad.get(['Player 1 Input', 'Handler'])).toBe('XInput');
    expect(pad.get(['Player 1 Input', 'Device'])).toBe('XInput Pad #1');
    expect(pad.get(['Player 1 Input', 'Config', 'Cross'])).toBe('A');
    expect(pad.get(['Player 1 Input', 'Config', 'L2'])).toBe('LT');
    expect(pad.get(['Player 1 Input', 'Config', 'L3'])).toBe('LS');
    expect(pad.get(['Player 1 Input', 'Config', 'Select'])).toBe('Back');
    expect(pad.get(['Player 1 Input', 'Config', 'Left Stick Up'])).toBe('LS Y+');
    expect(pad.get(['Player 1 Input', 'Config', 'Right Stick Left'])).toBe('RS X-');
    expect(pad.get(['Player 1 Input', 'Config', 'PS Button'])).toBe('Guide,Back&Y');
    expect(pad.get(['Player 1 Input', 'Config', 'Left Stick Deadzone'])).toBe(String(Math.round(0.15 * 32767)));
    expect(pad.get(['Player 1 Input', 'Config', 'Large Vibration Motor Multiplier'])).toBe('100');
    expect(existsSync(join(p.saves, 'dev_hdd0'))).toBe(true);
  });

  it('preserves user settings it does not manage and is idempotent', async () => {
    const doc = yml(a.configYml());
    doc.set(['Video', 'Anisotropic Filter Override'], 16);
    writeFileSync(a.configYml(), doc.toString());
    const again = await a.applyConfig({ settings: { ...settings, renderer: 'vulkan', resolutionScale: 2, aspectRatio: '4:3' }, controller, hotkeys, hardware: null }, 'all');
    expect(again.changed).toEqual([]);
    expect(yml(a.configYml()).get(['Video', 'Anisotropic Filter Override'])).toBe('16');
  });

  it('translates DualSense controllers, remaps and disables rumble', async () => {
    const ds = { ...controller, controllerKind: 'dualsense' as const, deviceIndex: 1, rumble: false, mapping: { ...controller.mapping, A: 'B' as const, B: 'A' as const } };
    await a.applyConfig({ settings, controller: ds, hotkeys, hardware: null }, 'controller');
    const pad = yml(a.inputYml());
    expect(pad.get(['Player 1 Input', 'Handler'])).toBe('DualSense');
    expect(pad.get(['Player 1 Input', 'Device'])).toBe('DualSense Pad #2');
    expect(pad.get(['Player 1 Input', 'Config', 'Cross'])).toBe('Circle');
    expect(pad.get(['Player 1 Input', 'Config', 'Circle'])).toBe('Cross');
    expect(pad.get(['Player 1 Input', 'Config', 'Start'])).toBe('Options');
    expect(pad.get(['Player 1 Input', 'Config', 'PS Button'])).toBe('PS Button,Share&Triangle');
    expect(pad.get(['Player 1 Input', 'Config', 'Left Stick Deadzone'])).toBe(String(Math.round(0.15 * 255)));
    expect(pad.get(['Player 1 Input', 'Config', 'Small Vibration Motor Multiplier'])).toBe('0');
  });

  it('detects path and prompt drift', async () => {
    expect((await a.inspectConfig()).drift).toEqual([]);
    const vfs = yml(a.vfsYml());
    vfs.set(['/dev_hdd0/'], '$(EmulatorDir)dev_hdd0/');
    writeFileSync(a.vfsYml(), vfs.toString());
    const gui = IniDocument.parse(readFileSync(a.guiIni(), 'utf8'));
    gui.set('main_window', 'infoBoxEnabledWelcome', 'true');
    writeFileSync(a.guiIni(), gui.toString());
    const insp = await a.inspectConfig();
    expect(insp.drift.find((d) => d.key === '/dev_hdd0/')?.critical).toBe(true);
    expect(insp.drift.find((d) => d.key === 'main_window.infoBoxEnabledWelcome')?.critical).toBe(true);
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'paths');
    expect((await a.inspectConfig()).drift).toEqual([]);
    writeFileSync(a.configYml(), 'Video:\n  Renderer: "Vulk');
    expect((await a.inspectConfig()).files.find((f) => f.label === 'config.yml')?.parseOk).toBe(false);
    copyFileSync(join(fixtures, 'config.yml'), a.configYml());
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'all');
  });

  it('builds a --no-gui launch with RPCS3_CONFIG_DIR and the boot path last', async () => {
    const game = 'D:\\PS3\\Demon\'s Souls\\PS3_GAME\\USRDIR\\EBOOT.BIN';
    const cmd = await a.buildLaunch({ gameId: 1, path: game, systemId: 'ps3', serial: 'BLUS30443', title: 'DS' }, 'C:\\rpcs3.exe', settings, null, '0.0.43');
    expect(cmd.args).toEqual(['--no-gui', '--fullscreen', game]);
    expect(cmd.env?.RPCS3_CONFIG_DIR).toBe(p.data + sep);
    expect(cmd.logFile).toBe(join(p.data, 'log', 'RPCS3.log'));
    expect(a.buildUiLaunch('C:\\rpcs3.exe').env?.RPCS3_CONFIG_DIR).toBe(p.data + sep);
    const windowed = await a.buildLaunch({ gameId: 1, path: 'g.iso', systemId: 'ps3', serial: null, title: 'G' }, 'x.exe', { ...settings, fullscreen: false }, null, null);
    expect(windowed.args).toEqual(['--no-gui', 'g.iso']);
  });

  it('applies per-game profiles natively with --config built from the global + custom config', async () => {
    mkdirSync(join(a.configDir(), 'custom_configs'), { recursive: true });
    writeFileSync(a.customConfigPath('BLUS30443'), 'Core:\n  SPU Block Size: Mega\nVideo:\n  Write Color Buffers: true\n  Vulkan:\n    Adapter: "My GPU"\n');
    const before = readFileSync(a.configYml(), 'utf8');
    const profile = { gameId: 7, emulatorId: null, overrides: { renderer: 'opengl', resolutionScale: 3, advanced: { 'Video/Vulkan|Asynchronous Texture Streaming': 'true' } }, customArgs: '--hidpi 0', notes: null, updatedAt: '' };
    const cmd = await a.buildLaunch({ gameId: 7, path: 'g\\EBOOT.BIN', systemId: 'ps3', serial: 'BLUS30443', title: 'G' }, 'x.exe', settings, profile, null);
    const i = cmd.args.indexOf('--config');
    expect(i).toBeGreaterThan(0);
    expect(cmd.args.slice(-3)).toEqual(['--hidpi', '0', 'g\\EBOOT.BIN']);
    await cmd.prepare!();
    const g = yml(cmd.args[i + 1]);
    expect(g.get(['Video', 'Renderer'])).toBe('OpenGL');
    expect(g.get(['Video', 'Resolution Scale'])).toBe('300');
    expect(g.get(['Video', 'Vulkan', 'Asynchronous Texture Streaming'])).toBe('true');
    expect(g.get(['Core', 'SPU Block Size'])).toBe('Mega');
    expect(g.get(['Video', 'Write Color Buffers'])).toBe('true');
    expect(g.get(['Video', 'Vulkan', 'Adapter'])).toBe('My GPU');
    expect(g.get(['Miscellaneous', 'Exit RPCS3 when process finishes'])).toBe('true');
    expect(readFileSync(a.configYml(), 'utf8')).toBe(before);
    expect(await a.recoverSession()).toEqual([]);
  });

  it('reports firmware: missing, PUP present, invalid PUP, installed', async () => {
    expect((await a.biosStatus())[0].status).toBe('missing');
    mkdirSync(p.bios, { recursive: true });
    writeFileSync(join(p.bios, 'PS3UPDAT.PUP'), Buffer.concat([Buffer.from('NOTAPUP!'), Buffer.alloc(64)]));
    expect((await a.biosStatus())[0].status).toBe('invalid');
    writeFileSync(join(p.bios, 'PS3UPDAT.PUP'), Buffer.concat([Buffer.from('SCEUF\0\0\0', 'latin1'), Buffer.alloc(64)]));
    const pending = (await a.biosStatus())[0];
    expect(pending.status).toBe('missing');
    expect(pending.files[0].valid).toBe(true);
    expect(pending.note).toMatch(/Install firmware/);
    mkdirSync(join(a.devFlashDir(), 'vsh', 'etc'), { recursive: true });
    writeFileSync(join(a.devFlashDir(), 'vsh', 'etc', 'version.txt'), 'release:04.9200:\nbuild:12345,67890:\n');
    const ok = (await a.biosStatus())[0];
    expect(ok.status).toBe('found');
    expect(ok.requirementKind).toBe('firmware');
    expect(await a.installedFirmwareVersion()).toBe('4.92');
  });

  it('installFirmware refuses without a valid PUP and runs only on Windows', async () => {
    const r = await a.installFirmware(join(t.dir, 'missing.exe'));
    expect(r.ok).toBe(false);
    expect(r.pup).toBe(join(p.bios, 'PS3UPDAT.PUP'));
  });

  it('parses versions from --version output and the log banner', () => {
    expect(parseRpcs3Version('RPCS3 0.0.43-20262-8f2fe1a9\n')).toBe('0.0.43-20262-8f2fe1a9');
    expect(parseRpcs3Version('·! 0:00:00.000 SYS: RPCS3 v0.0.43-20262-8f2fe1a9 Alpha | HEAD')).toBe('0.0.43-20262-8f2fe1a9');
  });

  it('copies the bundled SDL database and lists persistent app paths', async () => {
    const appDir = join(t.dir, 'fakeapp');
    mkdirSync(join(appDir, 'config', 'input_configs'), { recursive: true });
    writeFileSync(join(appDir, 'config', 'input_configs', 'gamecontrollerdb.txt'), '# db\n');
    expect(await a.prepareInstall(appDir)).toHaveLength(1);
    expect(readFileSync(join(a.configDir(), 'input_configs', 'gamecontrollerdb.txt'), 'utf8')).toBe('# db\n');
    expect(a.persistentAppPaths()).toContain('dev_hdd0');
    expect(a.persistentAppPaths()).toContain('portable');
  });

  it('smoke test checks static files and skips execution off Windows', async () => {
    const appDir = join(t.dir, 'smoke');
    mkdirSync(join(appDir, 'qt6', 'plugins'), { recursive: true });
    for (const f of ['rpcs3.exe', 'Qt6Core.dll', 'Qt6Gui.dll', 'Qt6Widgets.dll']) writeFileSync(join(appDir, f), '');
    const r = await a.smokeTest(join(appDir, 'rpcs3.exe'));
    if (process.platform !== 'win32') {
      expect(r.ran).toBe(false);
      expect(r.ok).toBe(true);
    }
    mkdirSync(join(appDir, 'portable'));
    expect((await a.smokeTest(join(appDir, 'rpcs3.exe'))).checks.find((c) => c.label.includes('portable'))?.ok).toBe(false);
  });

  it('scales resolution for 720p output and prefers Vulkan', () => {
    expect(a.defaultSettings(null, 'balanced').resolutionScale).toBe(1);
    expect(a.defaultSettings(null, 'quality').resolutionScale).toBe(2);
    expect(a.defaultSettings(null, 'balanced').renderer).toBe('vulkan');
  });
});
