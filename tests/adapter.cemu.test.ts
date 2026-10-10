import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AppPaths } from '../src/main/core/paths';
import { CemuAdapter, parseKeys } from '../src/main/emulators/cemu/adapter';
import { childElements, getText, parseXml, serializeXml, setText, textOf } from '../src/main/emulators/cemu/xml';
import { validateManifest } from '../src/main/emulators/registry';
import { pickAsset } from '../src/main/downloads/sources';
import { defaultProfile } from '../src/main/controllers/translate';
import { DEFAULT_SETTINGS } from '../src/main/database/settingsRepo';
import { tempDir } from './helpers';

const t = tempDir();
afterAll(t.cleanup);
const paths = new AppPaths(join(t.dir, 'ud'), t.dir);
const controller = { ...defaultProfile(), id: 1, updatedAt: '' };
const hotkeys = DEFAULT_SETTINGS.hotkeys;

describe('Cemu XML helpers', () => {
  it('round-trips unknown elements, attributes and comments', () => {
    const src = '<?xml version="1.0" encoding="UTF-8"?>\n<content>\n    <!-- c -->\n    <GraphicPack>\n        <Entry filename="a &amp; b" disabled="true"/>\n    </GraphicPack>\n    <mlc_path>C:\\x &lt;y&gt;</mlc_path>\n    <GamePaths/>\n</content>\n';
    const doc = parseXml(src);
    expect(serializeXml(doc)).toBe(src);
    expect(getText(doc.root, ['mlc_path'])).toBe('C:\\x <y>');
    expect(setText(doc.root, ['mlc_path'], 'C:\\x <y>')).toBe(false);
    expect(setText(doc.root, ['Graphic', 'api'], '1')).toBe(true);
    expect(serializeXml(doc)).toContain('    <Graphic>\n        <api>1</api>\n    </Graphic>');
  });

  it('rejects truncated documents', () => {
    expect(() => parseXml('<content><a>1</a>')).toThrow(/Unclosed/);
    expect(() => parseXml('<content><a>1</b></content>')).toThrow(/Unexpected closing/);
  });
});

describe('Cemu adapter', () => {
  const a = new CemuAdapter(paths);
  const settings = a.defaultSettings(null, 'balanced');
  const xml = () => parseXml(readFileSync(a.settingsPath(), 'utf8')).root;
  const pad = () => parseXml(readFileSync(a.controllerProfilePath(), 'utf8')).root;
  const mapping = () => {
    const ctrl = childElements(pad(), 'controller')[0];
    const m = new Map<number, number>();
    for (const e of childElements(childElements(ctrl, 'mappings')[0], 'entry')) m.set(Number(getText(e, ['mapping'])), Number(getText(e, ['button'])));
    return m;
  };

  it('has a valid manifest selecting only the Windows zip', () => {
    expect(validateManifest(a.manifest)).toEqual([]);
    expect(a.manifest.implemented).toBe(true);
    expect(a.manifest.dependencies).toEqual([]);
    const names = ['cemu-2.6-macos-12-x64.dmg', 'cemu-2.6-ubuntu-22.04-x64.zip', 'cemu-2.6-windows-x64-installer.exe', 'Cemu-2.6-x86_64.AppImage', 'cemu-2.6-windows-x64.zip']
      .map((name) => ({ name, browser_download_url: `https://github.com/cemu-project/Cemu/releases/download/v2.6/${name}`, size: 1 }));
    expect(pickAsset(names, a.manifest.download.assetPatterns!, a.manifest.download.assetExclude!, [])?.name).toBe('cemu-2.6-windows-x64.zip');
    expect(pickAsset([{ name: 'cemu-2.0-95-windows-x64.zip', browser_download_url: 'x', size: 1 }], a.manifest.download.assetPatterns!, [], [])?.name).toBe('cemu-2.0-95-windows-x64.zip');
  });

  it('keeps config in app/portable and mlc01 in Saves', () => {
    expect(a.settingsPath()).toBe(join(paths.emulatorAppDir('cemu'), 'portable', 'settings.xml'));
    expect(a.mlcPath()).toBe(join(paths.emulatorSaveDir('cemu'), 'mlc01'));
    expect(a.paths().bios).toBe(paths.systemBiosDir('wiiu'));
  });

  it('writes settings.xml (wizard/update suppression, mlc, graphics, hotkeys) and an XInput GamePad profile', async () => {
    const res = await a.applyConfig({ settings: { ...settings, renderer: 'opengl', aspectRatio: 'stretch', vsync: true }, controller, hotkeys, hardware: null }, 'all');
    expect(res.changed.length).toBeGreaterThan(8);
    expect(existsSync(a.settingsPath())).toBe(true);
    expect(existsSync(a.mlcPath())).toBe(true);
    const root = xml();
    expect(root.name).toBe('content');
    expect(getText(root, ['mlc_path'])).toBe(a.mlcPath());
    expect(getText(root, ['check_update'])).toBe('false');
    expect(getText(root, ['Graphic', 'api'])).toBe('0');
    expect(getText(root, ['Graphic', 'VSync'])).toBe('1');
    expect(getText(root, ['Graphic', 'FullscreenScaling'])).toBe('1');
    expect(getText(root, ['fullscreen'])).toBe('true');
    // modifier Select = XInput Back (bit 5); exit Start (4), fast forward RT (TriggerYP 43), screenshot X (14), fullscreen A (12)
    expect(getText(root, ['Hotkeys', 'modifiers'])).toBe('0 5');
    expect(getText(root, ['Hotkeys', 'ExitApplication'])).toBe('0 4');
    expect(getText(root, ['Hotkeys', 'ToggleFastForward'])).toBe('0 43');
    expect(getText(root, ['Hotkeys', 'TakeScreenshot'])).toBe('351 14');
    expect(getText(root, ['Hotkeys', 'ToggleFullscreen'])).toBe('350 12');

    const p = pad();
    expect(p.name).toBe('emulated_controller');
    expect(getText(p, ['type'])).toBe('Wii U GamePad');
    expect(getText(p, ['controller', 'api'])).toBe('XInput');
    expect(getText(p, ['controller', 'uuid'])).toBe('0');
    expect(getText(p, ['controller', 'rumble'])).toBe('1');
    expect(getText(p, ['controller', 'axis', 'deadzone'])).toBe('0.15');
    const m = mapping();
    expect(m.get(1)).toBe(12); // Wii U A <- XInput A
    expect(m.get(2)).toBe(13); // B <- B
    expect(m.get(7)).toBe(42); // ZL <- left trigger
    expect(m.get(9)).toBe(4); // Plus <- Start
    expect(m.get(10)).toBe(5); // Minus <- Back
    expect(m.get(17)).toBe(39); // StickL up <- +Y (XInput)
    expect(m.get(22)).toBe(47); // StickR down <- RotationYN
    expect(m.has(27)).toBe(false); // Home: XInput has no Guide
  });

  it('preserves user settings and is idempotent', async () => {
    const root = xml();
    setText(root, ['Graphic', 'AsyncCompile'], 'true');
    setText(root, ['Hotkeys', 'ExitApplication'], '27 4');
    writeFileSync(a.settingsPath(), serializeXml({ prolog: ['<?xml version="1.0" encoding="UTF-8"?>'], root }));
    const before = readFileSync(a.settingsPath(), 'utf8');
    const again = await a.applyConfig({ settings: { ...settings, renderer: 'opengl', aspectRatio: 'stretch', vsync: true }, controller, hotkeys, hardware: null }, 'all');
    expect(again.changed).toEqual([]);
    expect(readFileSync(a.settingsPath(), 'utf8')).toBe(before);
    expect(getText(xml(), ['Graphic', 'AsyncCompile'])).toBe('true');
    // The user's keyboard part of a hotkey is kept.
    expect(getText(xml(), ['Hotkeys', 'ExitApplication'])).toBe('27 4');
  });

  it('keeps a user-selected SDL pad and writes SDL ids; honours remaps, rumble and Nintendo layout', async () => {
    const file = a.controllerProfilePath();
    const sdlUuid = '0_030000005e0400008e02000000007200';
    writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>\n<emulated_controller><type>Wii U GamePad</type><toggle_display>1</toggle_display><controller><api>SDLController</api><uuid>${sdlUuid}</uuid><display_name>DualSense</display_name></controller></emulated_controller>`);
    const custom = { ...controller, rumble: false, nintendoLayoutForNintendoSystems: true };
    await a.applyConfig({ settings, controller: custom, hotkeys: { ...hotkeys, modifier: 'Guide' as const }, hardware: null }, 'controller');
    const p = pad();
    expect(getText(p, ['controller', 'api'])).toBe('SDLController');
    expect(getText(p, ['controller', 'uuid'])).toBe(sdlUuid);
    expect(getText(p, ['toggle_display'])).toBe('1');
    expect(getText(p, ['controller', 'rumble'])).toBe('0');
    const m = mapping();
    expect(m.get(1)).toBe(1); // Nintendo layout: Wii U A <- east button (SDL 1)
    expect(m.get(17)).toBe(45); // SDL stick up = AxisYN
    expect(m.get(27)).toBe(5); // Home <- Guide
    expect(getText(xml(), ['Hotkeys', 'modifiers'])).toBe('0 5');
    expect(getText(xml(), ['Hotkeys', 'ExitApplication'])).toBe('27 6');

    // XInput cannot see Guide: a Guide-modifier disables controller hotkeys instead of binding garbage.
    writeFileSync(file, '<emulated_controller><type>Wii U GamePad</type></emulated_controller>');
    await a.applyConfig({ settings, controller: { ...controller, deviceIndex: 2 }, hotkeys: { ...hotkeys, modifier: 'Guide' as const }, hardware: null }, 'controller');
    expect(getText(pad(), ['controller', 'uuid'])).toBe('2');
    expect(getText(xml(), ['Hotkeys', 'modifiers'])).toBe('0 -1');
    expect(getText(xml(), ['Hotkeys', 'TakeScreenshot'])).toBe('351 -1');
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'controller');
  });

  it('detects mlc and update-check drift and repairs them', async () => {
    const root = xml();
    setText(root, ['mlc_path'], 'C:\\Elsewhere\\mlc01');
    setText(root, ['check_update'], 'true');
    writeFileSync(a.settingsPath(), serializeXml({ prolog: [], root }));
    const insp = await a.inspectConfig();
    expect(insp.files[0].parseOk).toBe(true);
    expect(insp.drift.find((d) => d.key === 'mlc_path')?.critical).toBe(true);
    expect(insp.drift.find((d) => d.key === 'check_update')?.critical).toBe(false);
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'paths');
    expect((await a.inspectConfig()).drift).toEqual([]);

    writeFileSync(a.settingsPath(), '<content><mlc_path>x</mlc_path>');
    expect((await a.inspectConfig()).files[0].parseOk).toBe(false);
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'all').catch(() => null);
    writeFileSync(a.settingsPath(), '<?xml version="1.0" encoding="UTF-8"?>\n<content/>\n');
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'all');
    expect((await a.inspectConfig()).drift).toEqual([]);
  });

  it('builds -f -g launches and filters reserved custom args', async () => {
    const exe = join(a.paths().app, 'Cemu.exe');
    const cmd = await a.buildLaunch({ gameId: 1, path: 'D:\\WiiU\\Zelda.wua', systemId: 'wiiu', serial: null, title: 'Z' }, exe, settings, null, null);
    expect(cmd.args).toEqual(['-f', '-g', 'D:\\WiiU\\Zelda.wua']);
    expect(cmd.cwd).toBe(a.paths().app);
    expect(cmd.logFile).toBe(join(a.portableDir(), 'log.txt'));
    expect(cmd.cleanup).toBeUndefined();
    const custom = await a.buildLaunch({ gameId: 1, path: 'g.rpx', systemId: 'wiiu', serial: null, title: 'g' }, exe, { ...settings, fullscreen: false }, { gameId: 1, emulatorId: 'cemu', overrides: {}, customArgs: '--force-interpreter -mlc C:\\x --game=y.rpx -f -u', notes: null, updatedAt: '' }, null);
    expect(custom.args).toEqual(['--force-interpreter', '-u', '-g', 'g.rpx']);
    expect(custom.notes.join()).toMatch(/-mlc C:\\x/);
    expect(a.buildUiLaunch(exe).args).toEqual([]);
  });

  it('applies per-game overrides for the session only, restoring only the overridden keys', async () => {
    await a.applyConfig({ settings: { ...settings, renderer: 'opengl', advanced: { 'Graphic/AsyncCompile': 'true' } }, controller, hotkeys, hardware: null }, 'graphics');
    const profile = { gameId: 7, emulatorId: 'cemu', overrides: { renderer: 'vulkan', advanced: { 'Graphic/AsyncCompile': 'false', 'Graphic/NewKey': '3' } }, customArgs: null, notes: null, updatedAt: '' };
    const cmd = await a.buildLaunch({ gameId: 7, path: 'g.wua', systemId: 'wiiu', serial: null, title: 'g' }, 'Cemu.exe', { ...settings, renderer: 'opengl' }, profile, null);
    await cmd.prepare!();
    expect(getText(xml(), ['Graphic', 'api'])).toBe('1');
    expect(getText(xml(), ['Graphic', 'NewKey'])).toBe('3');
    // Cemu rewrites settings.xml on exit; simulate a change it made during the session.
    const during = xml();
    setText(during, ['GameCache', 'time'], '42');
    writeFileSync(a.settingsPath(), serializeXml({ prolog: [], root: during }));
    await cmd.cleanup!();
    const after = xml();
    expect(getText(after, ['Graphic', 'api'])).toBe('0');
    expect(getText(after, ['Graphic', 'AsyncCompile'])).toBe('true');
    expect(getText(after, ['Graphic', 'NewKey'])).toBeNull();
    expect(getText(after, ['GameCache', 'time'])).toBe('42');
    // Crash recovery.
    await cmd.prepare!();
    expect(await a.recoverSession()).toHaveLength(1);
    expect(getText(xml(), ['Graphic', 'api'])).toBe('0');
    expect(await a.recoverSession()).toEqual([]);
  });

  it('reports keys.txt status and copies sanitized keys into the portable folder', async () => {
    const dir = paths.systemBiosDir('wiiu');
    expect((await a.biosStatus())[0].status).toBe('missing');
    expect((await a.biosStatus())[0].requirementKind).toBe('keys');
    writeFileSync(join(dir, 'keys.txt'), '# my keys\r\nnot a key\r\n');
    expect((await a.biosStatus())[0].status).toBe('invalid');
    writeFileSync(join(a.portableDir(), 'keys.txt'), '541b9889519b27d363cd21604b97c67a # example key\r\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\r\n');
    writeFileSync(join(dir, 'keys.txt'), '# my keys\r\n0123-4567-89ab-cdef-0123-4567-89ab-cdef # game\r\nzzz\r\n');
    const st = (await a.biosStatus())[0];
    expect(st.status).toBe('invalid');
    expect(st.files[0].description).toMatch(/1 key/);
    const res = await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'paths');
    expect(res.changed.some((c) => c.startsWith('keys.txt'))).toBe(true);
    const copied = readFileSync(join(a.portableDir(), 'keys.txt'), 'utf8');
    expect(parseKeys(copied).keys).toEqual(['0123456789abcdef0123456789abcdef', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
    expect(parseKeys(copied).invalidLines).toEqual([]);
    expect((await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'paths')).changed).toEqual([]);
    writeFileSync(join(dir, 'keys.txt'), '0123456789abcdef0123456789abcdef\r\n');
    writeFileSync(join(dir, 'otp.bin'), Buffer.alloc(1024));
    const ok = (await a.biosStatus())[0];
    expect(ok.status).toBe('found');
    expect(ok.files.find((f) => f.path.endsWith('otp.bin'))?.valid).toBe(true);
    await a.applyConfig({ settings, controller, hotkeys, hardware: null }, 'paths');
    expect(existsSync(join(a.portableDir(), 'otp.bin'))).toBe(true);
  });

  it('creates the portable folder on install and keeps it across updates', async () => {
    const appDir = join(t.dir, 'fresh-app');
    mkdirSync(appDir, { recursive: true });
    expect((await a.prepareInstall(appDir)).length).toBe(1);
    expect(existsSync(join(appDir, 'portable'))).toBe(true);
    expect(await a.prepareInstall(appDir)).toEqual([]);
    expect(a.persistentAppPaths()).toEqual(['portable']);
  });

  it('smoke test checks resources/portable/settings and skips execution off Windows', async () => {
    const exe = join(a.paths().app, 'Cemu.exe');
    writeFileSync(exe, '');
    expect(await a.findExecutable(a.paths().app)).toBe(exe);
    const r1 = await a.smokeTest(exe);
    expect(r1.checks.find((c) => c.label === 'Resources present')?.ok).toBe(false);
    mkdirSync(join(a.paths().app, 'resources', 'sharedFonts'), { recursive: true });
    const r2 = await a.smokeTest(exe);
    expect(r2.checks.find((c) => c.label === 'First-start wizard suppressed')?.ok).toBe(true);
    if (process.platform !== 'win32') {
      expect(r2.ran).toBe(false);
      expect(r2.ok).toBe(true);
    }
  });

  it('parses keys like KeyCache_Prepare', () => {
    const r = parseKeys('; c\n0123456789ABCDEF0123456789ABCDEF;x\n0123\nxyz # bad\n');
    expect(r.keys).toEqual(['0123456789abcdef0123456789abcdef']);
    expect(r.invalidLines).toEqual([4]);
    expect(textOf(parseXml('<a> x </a>').root)).toBe('x');
    expect(dirname(a.controllerProfilePath()).endsWith('controllerProfiles')).toBe(true);
  });
});
