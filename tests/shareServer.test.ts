// "Share this PC" (sharing side of "Copy from another PC"): a real server on
// 127.0.0.1 over a temporary library and BIOS folder.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppContainer } from '../src/main/services/container';
import { isLocalAddress, type PairResult, type SetupExport, type ShareCatalog, type ShareServerStatus } from '../src/shared/share';
import { parseRange, MAX_CODE_ATTEMPTS } from '../src/main/share/server';
import { DiscoveryResponder, discover, parseProbe } from '../src/main/share/discovery';
import { ps1Bin, ps2Bios, sfo, write } from './fixtures/builders.mjs';
import { tempDir } from './helpers';

const t = tempDir('omnipc-share-');
afterAll(t.cleanup);
const games = join(t.dir, 'Games');
let c: AppContainer;
let base = '';

async function call(path: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  return fetch(`${base}${path}`, { ...init, headers });
}
const post = (path: string, body: unknown) => call(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

async function pair(name = 'Laptop', deviceId: string = randomUUID()): Promise<{ token: string; deviceId: string }> {
  c.share.openPairing(10);
  const r = await post('/v1/pair/request', { deviceId, name });
  expect(r.status).toBe(200);
  const { requestId } = (await r.json()) as { requestId: string };
  const code = c.share.status().pending.find((p) => p.requestId === requestId)!.code;
  const ok = await post('/v1/pair/confirm', { requestId, code });
  expect(ok.status).toBe(200);
  const res = (await ok.json()) as PairResult;
  return { token: res.token, deviceId };
}

beforeAll(async () => {
  // PS1 cue/bin set in its own folder.
  write(join(games, 'PS1', 'Crash', 'Crash (USA).cue'), 'FILE "Crash (USA) (Track 1).bin" BINARY\r\n  TRACK 01 MODE2/2352\r\n    INDEX 01 00:00:00\r\nFILE "Crash (USA) (Track 2).bin" BINARY\r\n  TRACK 02 AUDIO\r\n    INDEX 01 00:00:00\r\n');
  write(join(games, 'PS1', 'Crash', 'Crash (USA) (Track 1).bin'), ps1Bin('SCUS_949.00'));
  write(join(games, 'PS1', 'Crash', 'Crash (USA) (Track 2).bin'), Buffer.alloc(4096, 7));
  write(join(games, 'PS1', 'Crash', 'notes.txt'), 'not part of the game');
  // PS4 folder game.
  write(join(games, 'PS4', 'CUSA00001', 'eboot.bin'), Buffer.alloc(64, 1));
  write(join(games, 'PS4', 'CUSA00001', 'sce_sys', 'param.sfo'), sfo({ TITLE: 'Test Game PS4', TITLE_ID: 'CUSA00001' }));
  write(join(games, 'PS4', 'CUSA00001', 'data', 'stage1.bin'), Buffer.alloc(300_000, 2));

  c = new AppContainer({
    userDataDir: join(t.dir, 'userdata'),
    homeDir: t.dir,
    safeMode: false,
    host: {
      thumbnailer: async () => false,
      displays: () => [],
      fetchImpl: (() => Promise.resolve(new Response('no', { status: 404 }))) as typeof fetch,
      appVersion: '1.4.0',
      share: { port: 0, host: '127.0.0.1', discoveryPort: null, name: 'Desk\u0007PC', tmpDir: join(t.dir, 'tmp') },
    },
  });
  write(join(t.dir, 'tmp', '.keep'), '');
  c.settings.set({ onboardingComplete: true, metadataOnline: false, theGamesDbApiKey: 'TGDB-SECRET', aiApiKey: 'sk-ant-SECRET', aiEnabled: true });
  c.settings.setInternal('retroAchievementsToken', { token: 'RA-SECRET' });
  c.library.addPath(games, null, null);
  await c.scanLibrary(false).done;
  // BIOS: a recognised PS2 BIOS, an unknown file, and Switch keys.
  write(join(c.paths.systemBiosDir('ps2'), 'SCPH-70012.bin'), ps2Bios());
  write(join(c.paths.systemBiosDir('ps2'), 'readme.txt'), 'hello');
  write(join(c.paths.systemBiosDir('switch'), 'prod.keys'), `header_key = ${'ab'.repeat(32)}\n`);
  const st = await c.share.setEnabled(true);
  expect(st.enabled).toBe(true);
  base = `http://127.0.0.1:${st.port}`;
});

afterAll(async () => {
  await c?.share.stop();
  c?.shutdown();
});

describe('local address check', () => {
  it('accepts private, link-local and loopback addresses only', () => {
    for (const a of ['127.0.0.1', '::1', '10.1.2.3', '192.168.0.5', '172.16.0.1', '172.31.255.1', '169.254.1.1', '::ffff:192.168.1.2', 'fd12:3456::1', 'fe80::1']) expect(isLocalAddress(a)).toBe(true);
    for (const a of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '2001:db8::1', '::ffff:1.1.1.1', '']) expect(isLocalAddress(a)).toBe(false);
  });

  it('refuses a request from a public address with 403', async () => {
    const req = Object.assign(new EventEmitter(), { method: 'GET', url: '/v1/info', headers: {}, socket: { remoteAddress: '8.8.8.8' } }) as unknown as IncomingMessage;
    const out = await new Promise<{ status: number; body: string }>((resolve) => {
      let status = 0;
      const res = { headersSent: false, writeHead: (s: number) => { status = s; return res; }, end: (b: Buffer) => resolve({ status, body: String(b) }), destroy: () => undefined } as unknown as ServerResponse;
      c.share.handle(req, res);
    });
    expect(out.status).toBe(403);
    expect(out.body).toMatch(/local network/);
  });
});

describe('auth and pairing', () => {
  it('serves /v1/info without a token and nothing else', async () => {
    const r = await call('/v1/info');
    expect(r.status).toBe(200);
    const info = (await r.json()) as { name: string; deviceId: string; version: string; protocol: number };
    expect(info).toMatchObject({ name: 'Desk PC', version: '1.4.0', protocol: 1 });
    expect(info.deviceId).toBe(c.share.status().deviceId);
    for (const p of ['/v1/catalog', '/v1/file?item=0123456789abcdef&path=a', '/v1/hash?item=0123456789abcdef&path=a', '/v1/saves?emulatorId=duckstation', '/v1/setup']) {
      expect((await call(p)).status).toBe(401);
      expect((await call(p, { token: 'f'.repeat(64) })).status).toBe(401);
    }
  });

  it('refuses pairing unless the user opened it', async () => {
    c.share.closePairing();
    expect((await post('/v1/pair/request', { deviceId: randomUUID(), name: 'x' })).status).toBe(403);
  });

  it('pairs: request -> code shown here -> confirm -> token works; only the token hash is stored', async () => {
    const events: ShareServerStatus[] = [];
    const off = c.bus.on('share.changed', (s) => events.push(s));
    const { token, deviceId } = await pair('Living\nroom <PC>');
    off();
    expect(events.some((e) => e.pending.length === 1 && /^\d{6}$/.test(e.pending[0].code))).toBe(true);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const dev = c.share.status().paired.find((d) => d.deviceId === deviceId)!;
    expect(dev.name).toBe('Living room PC');
    expect(JSON.stringify(c.settings.getInternal('share.paired', []))).not.toContain(token);
    expect(JSON.stringify(c.settings.getInternal('share.paired', []))).toContain(createHash('sha256').update(token).digest('hex'));
    expect((await call('/v1/catalog', { token })).status).toBe(200);
  });

  it('locks a request after 5 wrong codes', async () => {
    c.share.openPairing(10);
    const { requestId } = (await (await post('/v1/pair/request', { deviceId: randomUUID(), name: 'Bad' })).json()) as { requestId: string };
    const code = c.share.status().pending.find((p) => p.requestId === requestId)!.code;
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < MAX_CODE_ATTEMPTS - 1; i++) expect((await post('/v1/pair/confirm', { requestId, code: wrong })).status).toBe(403);
    expect((await post('/v1/pair/confirm', { requestId, code: wrong })).status).toBe(429);
    expect((await post('/v1/pair/confirm', { requestId, code })).status).toBe(429);
    expect(c.share.status().pending.some((p) => p.requestId === requestId)).toBe(false);
  });

  it('allows at most 5 pending requests', async () => {
    c.share.closePairing();
    c.share.openPairing(10);
    for (let i = 0; i < 5; i++) expect((await post('/v1/pair/request', { deviceId: `dev-${i}`, name: `PC ${i}` })).status).toBe(200);
    expect((await post('/v1/pair/request', { deviceId: 'dev-6', name: 'PC 6' })).status).toBe(429);
    c.share.rejectPending(c.share.status().pending[0].requestId);
    expect(c.share.status().pending).toHaveLength(4);
    c.share.closePairing();
    expect(c.share.status().pending).toHaveLength(0);
  });

  it('expires pairing requests after 5 minutes', async () => {
    c.share.openPairing(30);
    const { requestId } = (await (await post('/v1/pair/request', { deviceId: randomUUID(), name: 'Slow' })).json()) as { requestId: string };
    const code = c.share.status().pending.find((p) => p.requestId === requestId)!.code;
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 5 * 60_000 + 1000 });
    try {
      expect((await post('/v1/pair/confirm', { requestId, code })).status).toBe(404);
    } finally {
      vi.useRealTimers();
    }
  });

  it('revoking a PC stops its token at once', async () => {
    const { token, deviceId } = await pair('Old PC');
    expect((await call('/v1/catalog', { token })).status).toBe(200);
    c.share.revoke(deviceId);
    expect(c.share.status().paired.some((d) => d.deviceId === deviceId)).toBe(false);
    expect((await call('/v1/catalog', { token })).status).toBe(401);
  });
});

describe('catalog and files', () => {
  let token = '';
  let cat: ShareCatalog;
  beforeAll(async () => {
    token = (await pair('Copier')).token;
    cat = (await (await call('/v1/catalog', { token })).json()) as ShareCatalog;
  });

  it('lists a cue/bin game with its referenced tracks only', () => {
    const g = cat.games.find((x) => x.systemId === 'ps1')!;
    expect(g).toBeTruthy();
    expect(g.folder).toBe('PS1');
    expect(g.files.map((f) => f.path)).toEqual(['Crash (USA) (Track 1).bin', 'Crash (USA) (Track 2).bin', 'Crash (USA).cue']);
    expect(g.sizeBytes).toBe(g.files.reduce((s, f) => s + f.size, 0));
    expect(g.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('lists every file of a folder game relative to the game folder', () => {
    const g = cat.games.find((x) => x.systemId === 'ps4')!;
    expect(g.title).toBe('Test Game PS4');
    expect(g.serial).toBe('CUSA00001');
    expect(g.folder).toBe('PS4/CUSA00001');
    expect(g.files.map((f) => f.path)).toEqual(['data/stage1.bin', 'eboot.bin', 'sce_sys/param.sfo']);
  });

  it('groups BIOS files by system and category', () => {
    const ps2 = cat.bios.filter((b) => b.systemId === 'ps2');
    expect(ps2).toHaveLength(1);
    expect(ps2[0]).toMatchObject({ category: 'bios', label: 'PlayStation 2 BIOS' });
    expect(ps2[0].files.map((f) => f.path).sort()).toEqual(['SCPH-70012.bin', 'readme.txt']);
    const sw = cat.bios.find((b) => b.systemId === 'switch')!;
    expect(sw).toMatchObject({ category: 'keys', files: [{ path: 'prod.keys' }] });
    expect(sw.label).toMatch(/keys/);
  });

  it('downloads a file, and a byte range of it', async () => {
    const g = cat.games.find((x) => x.systemId === 'ps4')!;
    const src = readFileSync(join(games, 'PS4', 'CUSA00001', 'data', 'stage1.bin'));
    const q = `/v1/file?item=${g.id}&path=${encodeURIComponent('data/stage1.bin')}`;
    const full = await call(q, { token });
    expect(full.status).toBe(200);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await full.arrayBuffer()).equals(src)).toBe(true);
    const part = await call(q, { token, headers: { range: 'bytes=100000-' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 100000-${src.length - 1}/${src.length}`);
    expect(Buffer.from(await part.arrayBuffer()).equals(src.subarray(100000))).toBe(true);
    const mid = await call(q, { token, headers: { range: 'bytes=10-19' } });
    expect(Buffer.from(await mid.arrayBuffer()).equals(src.subarray(10, 20))).toBe(true);
    expect((await call(q, { token, headers: { range: `bytes=${src.length}-` } })).status).toBe(416);
  });

  it('parses ranges', () => {
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange('bytes=0-4', 10)).toEqual({ start: 0, end: 4 });
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange('bytes=5-100', 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange('bytes=10-', 10)).toBe('invalid');
    expect(parseRange('bytes=5-2', 10)).toBe('invalid');
  });

  it('refuses unknown paths, traversal and unknown items', async () => {
    const g = cat.games.find((x) => x.systemId === 'ps1')!;
    for (const p of ['notes.txt', '../PS4/CUSA00001/eboot.bin', '..\\..\\userdata\\bootstrap.json', join(games, 'PS1', 'Crash', 'notes.txt'), '/etc/passwd', 'Crash (USA).cue/../notes.txt', '']) {
      const r = await call(`/v1/file?item=${g.id}&path=${encodeURIComponent(p)}`, { token });
      expect([403, 404]).toContain(r.status);
      const h = await call(`/v1/hash?item=${g.id}&path=${encodeURIComponent(p)}`, { token });
      expect([403, 404]).toContain(h.status);
    }
    expect((await call(`/v1/file?item=0123456789abcdef&path=eboot.bin`, { token })).status).toBe(404);
    expect((await call(`/v1/file?item=../../etc&path=passwd`, { token })).status).toBe(404);
  });

  it('never follows a symbolic link', async () => {
    const link = join(c.paths.systemBiosDir('ps1'), 'scph1001.bin');
    try {
      symlinkSync(join(t.dir, 'userdata', 'bootstrap.json'), link);
    } catch {
      return; // symlinks need privileges on some Windows setups
    }
    c.share.invalidateCatalog();
    const fresh = (await (await call('/v1/catalog', { token })).json()) as ShareCatalog;
    expect(fresh.bios.some((b) => b.systemId === 'ps1')).toBe(false);
  });

  it('hashes match the file contents', async () => {
    const g = cat.games.find((x) => x.systemId === 'ps1')!;
    for (const f of g.files) {
      const r = await call(`/v1/hash?item=${g.id}&path=${encodeURIComponent(f.path)}`, { token });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { sha256: string; size: number };
      const data = readFileSync(join(games, 'PS1', 'Crash', f.path));
      expect(body).toEqual({ sha256: createHash('sha256').update(data).digest('hex'), size: data.length });
    }
  });

  it('sends a fresh save backup ZIP without adding it to this PC\'s backups', async () => {
    const loc = c.registry.require('duckstation').saveLocations()[0];
    write(join(loc.path, 'shared_card_1.mcd'), Buffer.alloc(128 * 1024, 3));
    c.share.invalidateCatalog();
    const fresh = (await (await call('/v1/catalog', { token })).json()) as ShareCatalog;
    expect(fresh.saves.find((s) => s.emulatorId === 'duckstation')).toMatchObject({ fileCount: 1, sizeBytes: 128 * 1024 });
    const before = (await c.saves.list()).length;
    const r = await call('/v1/saves?emulatorId=duckstation', { token });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/zip');
    expect(r.headers.get('content-disposition')).toMatch(/duckstation-.*-manual\.zip/);
    const zip = Buffer.from(await r.arrayBuffer());
    expect(zip.subarray(0, 2).toString('latin1')).toBe('PK');
    expect((await c.saves.list()).length).toBe(before);
    expect((await call('/v1/saves?emulatorId=pcsx2', { token })).status).toBe(404);
  });

  it('exports the setup without secrets or paths', async () => {
    c.ops.saveGameProfile({ gameId: c.library.allGames()[0].id, emulatorId: null, overrides: { resolutionScale: 3, advanced: { 'Folders/Bios': 'C:\\Users\\me\\bios', 'GS/Upscale': '3' } }, customArgs: null, notes: 'n' });
    const r = await call('/v1/setup', { token });
    expect(r.status).toBe(200);
    const text = await r.text();
    const s = JSON.parse(text) as SetupExport;
    for (const secret of ['TGDB-SECRET', 'sk-ant-SECRET', 'RA-SECRET', t.dir, 'C:\\\\Users']) expect(text).not.toContain(secret);
    for (const k of ['theGamesDbApiKey', 'aiApiKey', 'retroAchievements', 'saveBackup', 'consoleModeOnStart', 'startWithWindows', 'onboardingComplete']) expect(s.settings).not.toHaveProperty(k);
    expect(s.settings.hotkeys).toBeTruthy();
    expect(s.profiles).toHaveLength(1);
    expect(s.profiles[0].profile.overrides.advanced).toEqual({ 'GS/Upscale': '3' });
    expect(s.from.name).toBe('Desk PC');
    const fresh = (await (await call('/v1/catalog', { token })).json()) as ShareCatalog;
    expect(fresh.setup.perGameProfiles).toBe(1);
  });

  it('hides what the user does not share', async () => {
    const g = cat.games[0];
    c.share.setSharing({ games: false, saves: false, setup: false });
    try {
      const fresh = (await (await call('/v1/catalog', { token })).json()) as ShareCatalog;
      expect(fresh.games).toEqual([]);
      expect(fresh.saves).toEqual([]);
      expect(fresh.bios.length).toBeGreaterThan(0);
      expect((await call(`/v1/file?item=${g.id}&path=${encodeURIComponent(g.files[0].path)}`, { token })).status).toBe(403);
      expect((await call('/v1/saves?emulatorId=duckstation', { token })).status).toBe(403);
      expect((await call('/v1/setup', { token })).status).toBe(403);
    } finally {
      c.share.setSharing({ games: true, saves: true, setup: true });
    }
    expect((await call(`/v1/file?item=${g.id}&path=${encodeURIComponent(g.files[0].path)}`, { token })).status).toBe(200);
  });
});

describe('discovery', () => {
  it('answers a probe with an announce over loopback, and ignores junk', async () => {
    const probePort = await new Promise<number>((resolve) => {
      const s = createSocket('udp4');
      s.bind(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
    const r = new DiscoveryResponder({ port: probePort, host: '127.0.0.1', announce: () => ({ deviceId: 'server-1', name: 'Desk', port: 47632, version: '1.4.0' }) });
    await r.start();
    try {
      // Malformed packets are ignored and do not stop the responder.
      const junk = createSocket('udp4');
      await new Promise<void>((resolve) => junk.send(Buffer.from('{nope'), probePort, '127.0.0.1', () => resolve()));
      junk.close();
      const found = await discover(500, { port: probePort, targets: ['127.0.0.1'], deviceId: 'client-1' });
      expect(found).toEqual([{ deviceId: 'server-1', name: 'Desk', address: '127.0.0.1', port: 47632, version: '1.4.0', paired: false }]);
      // A PC does not discover itself.
      expect(await discover(300, { port: probePort, targets: ['127.0.0.1', '127.0.0.1'], deviceId: 'server-1' })).toEqual([]);
    } finally {
      await r.stop();
    }
    expect(parseProbe(Buffer.from(JSON.stringify({ kind: 'omnipc-probe', protocol: 1, deviceId: '../x' })))).toBeNull();
    expect(parseProbe(Buffer.from('null'))).toBeNull();
  });

  it('stops serving when sharing is turned off', async () => {
    const st = await c.share.setEnabled(false);
    expect(st.enabled).toBe(false);
    await expect(fetch(`${base}/v1/info`)).rejects.toThrow();
    const again = await c.share.setEnabled(true);
    base = `http://127.0.0.1:${again.port}`;
    expect((await call('/v1/info')).status).toBe(200);
  });
});
