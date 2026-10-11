// End-to-end acceptance flow (spec sections 76 & 77), exercised against the
// real backend (AppContainer: SQLite, adapters, installer, scanner, launch
// router, OmniDoctor, repair engine). External effects are simulated:
//  - network: a fake fetch serving GitHub/Dolphin release metadata + real 7z archives
//  - emulator: a Node script standing in for pcsx2-qt.exe / Dolphin.exe
// What cannot be tested here (needs Windows + real emulators): actual rendering,
// real controller input inside the emulator, Windows exit codes.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { AppContainer } from '../src/main/services/container';
import { processRunner, runProcess } from '../src/main/platform/exec';
import { IniDocument } from '../src/main/config/ini';
import { fakeEmulatorScript, nintendoHeader, ps2Bios, ps2Iso, write } from './fixtures/builders.mjs';
import { tempDir } from './helpers';

const require_ = createRequire(import.meta.url);
const t = tempDir('omnideck-e2e-');
afterAll(t.cleanup);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2048, 1)]);

async function make7z(srcDir: string, out: string): Promise<void> {
  const bin = (require_('7zip-bin') as { path7za: string }).path7za;
  const { chmodSync } = await import('node:fs');
  chmodSync(bin, 0o755);
  const r = await runProcess(bin, ['a', '-t7z', out, '.'], { cwd: srcDir });
  if (r.code !== 0) throw new Error(r.stderr || r.stdout);
}

const archives: Record<string, Buffer> = {};
let pcsx2Version = '2.8.2';

function fakeFetch(input: string | URL): Promise<Response> {
  const url = String(input);
  if (url === 'https://api.github.com/repos/PCSX2/pcsx2/releases/latest') {
    const a = archives[pcsx2Version];
    return Promise.resolve(Response.json({
      tag_name: `v${pcsx2Version}`, prerelease: false, draft: false, html_url: 'https://github.com/PCSX2/pcsx2/releases',
      assets: [
        { name: `pcsx2-v${pcsx2Version}-windows-x64-Qt-symbols.7z`, browser_download_url: 'https://github.com/PCSX2/pcsx2/releases/download/sym.7z', size: 1 },
        { name: `pcsx2-v${pcsx2Version}-windows-x64-Qt.7z`, browser_download_url: `https://github.com/PCSX2/pcsx2/releases/download/v${pcsx2Version}/pcsx2.7z`, size: a.length, digest: `sha256:${createHash('sha256').update(a).digest('hex')}` },
      ],
    }));
  }
  const m = /releases\/download\/v([\d.]+)\/pcsx2\.7z$/.exec(url);
  if (m) return Promise.resolve(new Response(null, { status: 302, headers: { location: `https://release-assets.githubusercontent.com/pcsx2-${m[1]}.7z` } }));
  const m2 = /release-assets\.githubusercontent\.com\/pcsx2-([\d.]+)\.7z$/.exec(url);
  if (m2) return Promise.resolve(new Response(archives[m2[1]], { headers: { 'content-length': String(archives[m2[1]].length) } }));
  if (url === 'https://dolphin-emu.org/update/latest/beta/') return Promise.resolve(Response.json({ shortrev: '2509', artifacts: [{ system: 'Windows x64', url: 'https://dl.dolphin-emu.org/releases/2509/dolphin-2509-x64.7z' }] }));
  if (url === 'https://dl.dolphin-emu.org/releases/2509/dolphin-2509-x64.7z') return Promise.resolve(new Response(archives.dolphin));
  if (url === 'https://raw.githubusercontent.com/xlenore/ps2-covers/main/covers/default/SCUS-97472.jpg') return Promise.resolve(new Response(PNG, { headers: { 'content-type': 'image/jpeg' } }));
  return Promise.resolve(new Response('not found', { status: 404 }));
}

let c: AppContainer;
const games = join(t.dir, 'Games');

function waitLaunchEnd(): Promise<{ launchId: number; outcome: string; needsAnalysis: boolean }> {
  return new Promise((resolve) => {
    const off = c.bus.on('launch.ended', (e) => { off(); resolve(e); });
  });
}

// Stand-in emulator "executables" are Node scripts: run them through Node on every OS.
const realRun = processRunner.run;
processRunner.run = (cmd, args, opts) => (/(pcsx2-qt|Dolphin)\.exe$/i.test(cmd) ? realRun(process.execPath, [cmd, ...args], opts) : realRun(cmd, args, opts));
afterAll(() => { processRunner.run = realRun; });

beforeAll(async () => {
  for (const v of ['2.8.2', '2.8.3', '2.8.4']) {
    const src = join(t.dir, `pkg-pcsx2-${v}`);
    write(join(src, 'pcsx2-qt.exe'), fakeEmulatorScript());
    write(join(src, 'resources', 'GameIndex.yaml'), 'SCUS-97472:\n  name: "Shadow of the Colossus"\n  region: "NTSC-U"\n  compat: 5\n');
    await make7z(src, join(t.dir, `pcsx2-${v}.7z`));
    archives[v] = readFileSync(join(t.dir, `pcsx2-${v}.7z`));
  }
  const dsrc = join(t.dir, 'pkg-dolphin');
  write(join(dsrc, 'Dolphin-x64', 'Dolphin.exe'), fakeEmulatorScript());
  write(join(dsrc, 'Dolphin-x64', 'Sys', 'wiitdb-en.txt'), 'TITLES = test\nGALE01 = Super Smash Bros. Melee\n');
  await make7z(dsrc, join(t.dir, 'dolphin.7z'));
  archives.dolphin = readFileSync(join(t.dir, 'dolphin.7z'));

  write(join(games, 'PS2', 'sotc.iso'), ps2Iso('SCUS_974.72'));
  write(join(games, 'GameCube', 'Melee (USA).iso'), nintendoHeader('GALE01', 'SUPER SMASH BROS Melee'));

  c = new AppContainer({
    userDataDir: join(t.dir, 'userdata'),
    homeDir: t.dir,
    safeMode: false,
    host: {
      thumbnailer: async (src, dest) => { copyFileSync(src, dest); return true; },
      displays: () => [{ width: 2560, height: 1440, refreshRate: 144, scaleFactor: 1, primary: true }],
      fetchImpl: fakeFetch as typeof fetch,
      // The fake emulator executables are Node scripts.
      spawnImpl: ((cmd: string, args: string[], opts: object) => spawn(process.execPath, [cmd, ...args], opts as never)) as never,
    },
  });
  c.settings.set({ onboardingComplete: true });
  await c.scanHardware();
});

afterAll(() => c?.shutdown());

describe('first end-to-end test: PCSX2', () => {
  it('installs PCSX2 automatically from the official release (verified) and configures it', async () => {
    const { done } = c.emulators.install('pcsx2');
    const smoke = (await done) as { ok: boolean };
    expect(smoke.ok).toBe(true);
    const st = c.emulators.status('pcsx2');
    expect(st.installState).toBe('installed');
    expect(st.version).toBe('2.8.2');
    expect(st.health).toBe('ready');
    expect(c.downloads.list()[0].verification).toMatch(/matches upstream/);
    const ini = IniDocument.parse(readFileSync(join(c.registry.require('pcsx2').paths().data, 'PCSX2', 'inis', 'PCSX2.ini'), 'utf8'));
    expect(ini.get('Folders', 'Bios')).toBe(c.paths.systemBiosDir('ps2'));
    expect(ini.get('Pad1', 'Cross')).toBe('SDL-0/FaceSouth');
    expect(ini.get('Hotkeys', 'ShutdownVM')).toBe('SDL-0/Back & SDL-0/Start');
    expect(c.ops.changes(20).some((x) => x.kind === 'emulator.installed')).toBe(true);
  });

  it('detects the PS2 game in the selected folder with metadata, compatibility and artwork', async () => {
    c.library.addPath(games, null, null);
    await c.scanLibrary(false).done;
    const g = c.library.query({ systemId: 'ps2', limit: 10 }).items[0];
    expect(g.serial).toBe('SCUS-97472');
    expect(g.title).toBe('Shadow of the Colossus');
    expect(g.coverThumb).toBeTruthy();
    expect(c.library.getCompatibility(g.id)?.label).toBe('Playable');
  });

  it('validates a user-supplied BIOS and refuses invalid files', async () => {
    const bad = join(t.dir, 'not-a-bios.bin');
    writeFileSync(bad, Buffer.alloc(4 * 1024 * 1024));
    await expect(c.bios.import('ps2', bad)).rejects.toThrow(/not a valid PlayStation 2 BIOS/);
    const good = join(t.dir, 'SCPH-70012.bin');
    writeFileSync(good, ps2Bios());
    const st = await c.bios.import('ps2', good);
    expect(st.status).toBe('found');
    expect(st.files[0].description).toMatch(/USA v2\.20/);
  });

  it('launches the game, returns, and records play history', async () => {
    const g = c.library.query({ systemId: 'ps2', limit: 1 }).items[0];
    process.env.FAKE_EMU_MODE = 'ok';
    process.env.FAKE_EMU_MS = '5300';
    process.env.FAKE_EMU_LOG = c.registry.require('pcsx2').logFile()!;
    const ended = waitLaunchEnd();
    const r = await c.launcher.launchGame(g.id);
    expect(r.ok).toBe(true);
    expect(c.launcher.activeSession()?.gameId).toBe(g.id);
    const e = await ended;
    expect(e.outcome).toBe('ok');
    const rec = c.launches.get(e.launchId)!;
    expect(rec.args).toContain('-nogui');
    expect(rec.args[rec.args.length - 1]).toBe(join(games, 'PS2', 'sotc.iso'));
    const after = c.library.summary(g.id)!;
    expect(after.lastPlayedAt).not.toBeNull();
    expect(after.playTimeSeconds).toBeGreaterThanOrEqual(5);
  }, 60000);

  it('preserves saves through a configuration reset', async () => {
    const card = join(c.registry.require('pcsx2').saveLocations()[0].path, 'Mcd001.ps2');
    writeFileSync(card, 'memory card data');
    await c.emulators.resetConfig('pcsx2').done;
    expect(readFileSync(card, 'utf8')).toBe('memory card data');
    expect(c.ops.backups('pcsx2').some((b) => b.reason === 'pre-reset')).toBe(true);
  });

  it('breakage #1: removed BIOS is detected before launch, explained, and flagged by OmniDoctor', async () => {
    const g = c.library.query({ systemId: 'ps2', limit: 1 }).items[0];
    const biosDir = c.paths.systemBiosDir('ps2');
    rmSync(biosDir, { recursive: true, force: true });
    const r = await c.launcher.launchGame(g.id);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('BIOS_MISSING');
    expect(r.error?.userAction.join(' ')).toMatch(/supplied by you/);
    const report = await c.doctor.run('quick');
    expect(report.findings.some((f) => f.checkId === 'bios.status' && f.severity === 'problem')).toBe(true);
    mkdirSync(biosDir, { recursive: true });
    writeFileSync(join(biosDir, 'SCPH-70012.bin'), ps2Bios());
  });

  it('breakage #2: malformed config is detected and repaired with a backup, and can be undone', async () => {
    const iniPath = join(c.registry.require('pcsx2').paths().data, 'PCSX2', 'inis', 'PCSX2.ini');
    writeFileSync(iniPath, readFileSync(iniPath, 'utf8') + '\n%%% corrupted line %%%\n[Folders]\nBios = C:\\nowhere\n');
    const report = await c.doctor.run('quick');
    const fmt = report.findings.find((f) => f.id === 'emulators.config:pcsx2:format')!;
    expect(fmt.severity).toBe('problem');
    expect(fmt.repair?.actionId).toBe('config.repairFormat');
    expect(fmt.repair?.safety).toBe('low');
    await expect(c.repairs.run(fmt.repair!.actionId, fmt.repair!.params, { confirmed: false })).rejects.toThrow(/approval/);
    const rec = await c.repairs.run(fmt.repair!.actionId, fmt.repair!.params, { confirmed: true });
    expect(rec.status).toBe('succeeded');
    expect(rec.undoable).toBe(true);
    const fixed = IniDocument.parse(readFileSync(iniPath, 'utf8'));
    expect(fixed.validate()).toEqual([]);
    expect(fixed.get('Folders', 'Bios')).toBe(c.paths.systemBiosDir('ps2'));
    const after = await c.doctor.run('quick');
    expect(after.findings.find((f) => f.id === 'emulators.config:pcsx2:format')).toBeUndefined();
    expect(c.ops.repairs(5)[0].actionId).toBe('config.repairFormat');
  });

  it('breakage #3: renderer failure -> analysis with evidence -> fix and retry', async () => {
    const g = c.library.query({ systemId: 'ps2', limit: 1 }).items[0];
    process.env.FAKE_EMU_MODE = 'gsfail';
    const ended = waitLaunchEnd();
    expect((await c.launcher.launchGame(g.id)).ok).toBe(true);
    const e = await ended;
    expect(e.outcome).toBe('crashed');
    expect(e.needsAnalysis).toBe(true);
    const a = await c.doctor.analyzeLaunch(e.launchId);
    expect(a.headline).toBe('We found the issue.');
    expect(a.confidence).toBe('high');
    expect(a.findings[0].ruleId).toBe('pcsx2.gs-init-failed');
    expect(a.evidence.join()).toMatch(/Failed to create render device/);
    expect(a.primaryRepair?.actionId).toBe('emulator.setRenderer');
    expect(a.primaryRepair?.params.gameId).toBe(g.id);
    const rec = await c.repairs.run(a.primaryRepair!.actionId, a.primaryRepair!.params, { confirmed: true });
    expect(rec.status).toBe('succeeded');
    expect(c.ops.getGameProfile(g.id)?.overrides.renderer).toBeDefined();
    process.env.FAKE_EMU_MODE = 'ok';
    const ended2 = waitLaunchEnd();
    expect((await c.launcher.launchGame(g.id)).ok).toBe(true);
    expect((await ended2).outcome).toBe('ok');
    // global PCSX2 config was not damaged by the per-game override session
    const iniPath = join(c.registry.require('pcsx2').paths().data, 'PCSX2', 'inis', 'PCSX2.ini');
    expect(existsSync(iniPath + '.omnideck-session')).toBe(false);
  }, 60000);

  it('crash-loop protection pauses after repeated failures', async () => {
    const g = c.library.query({ systemId: 'ps2', limit: 1 }).items[0];
    c.settings.set({ crashLoopThreshold: 2 });
    process.env.FAKE_EMU_MODE = 'crash';
    for (let i = 0; i < 2; i++) {
      const ended = waitLaunchEnd();
      await c.launcher.launchGame(g.id);
      await ended;
    }
    const r = await c.launcher.launchGame(g.id);
    expect(r.blockedByCrashLoop).toBe(true);
    expect(r.error?.whatHappened).toMatch(/failed 2 times/);
    await c.repairs.run('launch.resetCrashLoop', { gameId: g.id }, { confirmed: true });
    expect(c.library.getGame(g.id)!.crash_loop_paused).toBe(0);
    process.env.FAKE_EMU_MODE = 'ok';
  }, 30000);

  it('updates with backup + health test, correlates failures with the update, and rolls back', async () => {
    pcsx2Version = '2.8.3';
    expect((await c.emulators.checkUpdates()).find((e) => e.id === 'pcsx2')!.updateAvailable).toBe(true);
    await c.emulators.update('pcsx2').done;
    expect(c.emulators.status('pcsx2').version).toBe('2.8.3');
    expect(c.emulators.status('pcsx2').rollbackVersion).toBe('2.8.2');
    expect(c.ops.backups('pcsx2').some((b) => b.reason === 'pre-update')).toBe(true);
    const g = c.library.query({ systemId: 'ps2', limit: 1 }).items[0];
    process.env.FAKE_EMU_MODE = 'crash';
    for (let i = 0; i < 2; i++) {
      const ended = waitLaunchEnd();
      await c.launcher.launchGame(g.id, { ignoreCrashLoop: true });
      await ended;
    }
    const report = await c.doctor.run('quick');
    const reg = report.findings.find((f) => f.checkId === 'emulators.regression')!;
    expect(reg.title).toMatch(/started failing after the update/);
    expect(reg.repair?.actionId).toBe('emulator.rollback');
    await c.repairs.run('emulator.rollback', { emulatorId: 'pcsx2' }, { confirmed: true });
    expect(c.emulators.status('pcsx2').version).toBe('2.8.2');
    process.env.FAKE_EMU_MODE = 'ok';
    c.library.setFailureState(g.id, 0, false);
  }, 60000);

  it('"Check & update all" installs every newer release in one go', async () => {
    pcsx2Version = '2.8.3';
    const busy = await c.emulators.checkAndUpdateAll({ automatic: false, isBusy: () => true }).done;
    expect(busy.skipped).toEqual(['PCSX2 2.8.3 (a game is running)']);
    expect(c.emulators.status('pcsx2').version).toBe('2.8.2');

    const s = await c.emulators.checkAndUpdateAll({ automatic: false }).done;
    expect(s.updated).toEqual(['PCSX2 2.8.3']);
    expect(s.failed).toEqual([]);
    expect(c.emulators.status('pcsx2').version).toBe('2.8.3');
    expect(c.emulators.status('pcsx2').updateAvailable).toBe(false);

    const again = await c.emulators.checkAndUpdateAll({ automatic: true }).done;
    expect(again).toMatchObject({ checked: 1, updated: [], rolledBack: [], failed: [] });
  }, 60000);

  it('automatically rolls back an update that fails its health test', async () => {
    pcsx2Version = '2.8.4';
    const adapter = c.registry.require('pcsx2');
    const realSmoke = adapter.smokeTest.bind(adapter);
    adapter.smokeTest = async () => ({ ran: true, ok: false, checks: [{ label: 'Executable starts', ok: false, detail: 'Exit code -1073741795' }] });
    try {
      const s = await c.emulators.checkAndUpdateAll({ automatic: true }).done;
      expect(s.rolledBack).toEqual(['PCSX2 2.8.4 (kept 2.8.3)']);
      expect(s.updated).toEqual([]);
    } finally {
      adapter.smokeTest = realSmoke;
    }
    expect(c.emulators.status('pcsx2').version).toBe('2.8.3');
    expect(existsSync(c.emulators.executableFor('pcsx2')!)).toBe(true);
    expect(c.ops.notifications().some((n) => /update rolled back/.test(n.title))).toBe(true);
    pcsx2Version = '2.8.3';
    await c.emulators.checkUpdates();
  }, 60000);
});

describe('second end-to-end test: Dolphin reuses the same infrastructure', () => {
  it('installs Dolphin, identifies the GameCube game, and launches it', async () => {
    // The GameCube game was scanned before Dolphin existed; installing Dolphin
    // refreshes its metadata from Dolphin's bundled GameTDB title list.
    const jobDone = new Promise<void>((resolve) => { const off = c.bus.on('job.update', (j) => { if (j.kind === 'metadata.refresh' && j.state === 'succeeded') { off(); resolve(); } }); });
    await c.emulators.install('dolphin').done;
    expect(c.emulators.status('dolphin').version).toBe('2509');
    await jobDone;
    const g = c.library.query({ systemId: 'gc', limit: 1 }).items[0];
    expect(g.serial).toBe('GALE01');
    expect(g.title).toBe('Super Smash Bros. Melee');
    const d = c.registry.require('dolphin');
    process.env.FAKE_EMU_LOG = d.logFile()!;
    const ended = waitLaunchEnd();
    expect((await c.launcher.launchGame(g.id)).ok).toBe(true);
    const e = await ended;
    expect(e.outcome).toBe('ok');
    const rec = c.launches.get(e.launchId)!;
    expect(rec.args.slice(0, 3)).toEqual(['-u', join(d.paths().data, 'User'), '-b']);
    const pad = IniDocument.parse(readFileSync(join(d.paths().data, 'User', 'Config', 'GCPadNew.ini'), 'utf8'));
    expect(pad.get('GCPad1', 'Device')).toBe('XInput/0/Gamepad');
  }, 60000);

  it('one controller profile change updates every installed emulator', async () => {
    const p = c.controllerProfile();
    const { id: _i, updatedAt: _u, ...rest } = p;
    c.ops.saveControllerProfile({ ...rest, deviceIndex: 1 });
    const r = await c.emulators.applyControllerProfile({ force: false });
    expect(r.applied).toHaveLength(2);
    const pcsx2 = IniDocument.parse(readFileSync(join(c.registry.require('pcsx2').paths().data, 'PCSX2', 'inis', 'PCSX2.ini'), 'utf8'));
    expect(pcsx2.get('Pad1', 'Cross')).toBe('SDL-1/FaceSouth');
    const dol = IniDocument.parse(readFileSync(join(c.registry.require('dolphin').paths().data, 'User', 'Config', 'GCPadNew.ini'), 'utf8'));
    expect(dol.get('GCPad1', 'Device')).toBe('XInput/1/Gamepad');
  });

  it('full health check produces a real score with categories', async () => {
    const report = await c.doctor.run('full');
    expect(report.overall).toBeGreaterThan(0);
    expect(report.categories.length).toBeGreaterThan(4);
    expect(report.counts.passed).toBeGreaterThan(5);
  });

  it('exports a diagnostic package without games, BIOS or saves', async () => {
    const { exportDiagnosticPackage } = await import('../src/main/services/diagnosticPackage');
    const r = await exportDiagnosticPackage({ includeEmulatorLogs: true, includeConfigs: true, extra: {} }, { paths: c.paths, registry: c.registry, ops: c.ops });
    expect(existsSync(r.path)).toBe(true);
    expect(r.files.some((f) => /\.(iso|bin|ps2)$/.test(f))).toBe(false);
    expect(r.files).toContain('pcsx2/config/PCSX2.ini');
  });
});
