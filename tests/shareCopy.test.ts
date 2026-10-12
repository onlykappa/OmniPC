// "Copy from another PC" (client side) against a fake sharing PC that
// implements the contract in src/shared/share.ts on 127.0.0.1.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrate } from '../src/main/database/migrations';
import { OpsRepo } from '../src/main/database/opsRepo';
import { SettingsRepo } from '../src/main/database/settingsRepo';
import { AppPaths } from '../src/main/core/paths';
import { EventBus } from '../src/main/core/events';
import { JobManager } from '../src/main/core/jobs';
import { SaveService } from '../src/main/services/saveService';
import { ShareClient, resolveLocalHost, PAIRED_SERVERS_KEY } from '../src/main/share/client';
import { ShareCopyService, safeRelativePath, type Discoverer } from '../src/main/share/copy';
import { SetupImporter, sanitizeSettings, SETUP_SNAPSHOT_KEY } from '../src/main/share/setupImport';
import { DEFAULT_SETTINGS } from '../src/main/database/settingsRepo';
import type { AdapterRegistry } from '../src/main/emulators/registry';
import type { EmulatorManager } from '../src/main/services/emulatorManager';
import type { EmulatorSettings } from '../src/shared/models';
import type { CopySummary } from '../src/shared/shareCopy';
import { SHARE_PROTOCOL_VERSION, type SetupExport, type ShareBiosItem, type ShareCatalog, type ShareGameItem, type ShareInfo } from '../src/shared/share';
import { tempDir } from './helpers';

const t = tempDir('omnipc-sharecopy-');
afterAll(t.cleanup);

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// ------------------------------------------------------------ fake server

interface FakeServer {
  port: number;
  info: ShareInfo;
  code: string;
  token: string;
  files: Map<string, Buffer>; // `${item}|${path}` -> bytes
  hashOverride: Map<string, string>;
  ranges: string[];
  catalog: Omit<ShareCatalog, 'server'>;
  setup: SetupExport | null;
  saves: Map<string, Buffer>;
  close(): Promise<void>;
}

async function startFakeServer(name = 'Living Room PC'): Promise<FakeServer> {
  const state: Omit<FakeServer, 'port' | 'close'> = {
    info: { protocol: SHARE_PROTOCOL_VERSION, deviceId: `dev-${name.replace(/\W/g, '')}`, name, version: '1.4.0', pairingOpen: true },
    code: '482913',
    token: 'token-0123456789abcdef0123456789abcdef',
    files: new Map(),
    hashOverride: new Map(),
    ranges: [],
    catalog: { games: [], bios: [], saves: [], setup: { emulators: [], perGameProfiles: 0, hasControllerProfile: false } },
    setup: null,
    saves: new Map(),
  };
  const pending = new Map<string, string>();
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const readBody = () => new Promise<any>((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')));
    });
    if (url.pathname === '/v1/info') return send(200, state.info);
    if (url.pathname === '/v1/pair/request' && req.method === 'POST') {
      if (!state.info.pairingOpen) return send(403, { error: 'pairing closed' });
      return void readBody().then((b: { deviceId: string }) => {
        const id = `req-${pending.size + 1}`;
        pending.set(id, b.deviceId);
        send(200, { requestId: id });
      });
    }
    if (url.pathname === '/v1/pair/confirm' && req.method === 'POST') {
      return void readBody().then((b: { requestId: string; code: string }) => {
        if (!pending.has(b.requestId)) return send(404, { error: 'unknown request' });
        if (b.code !== state.code) return send(401, { error: 'wrong code' });
        pending.delete(b.requestId);
        send(200, { token: state.token, server: state.info });
      });
    }
    if (req.headers.authorization !== `Bearer ${state.token}`) return send(401, { error: 'unauthorized' });
    if (url.pathname === '/v1/catalog') return send(200, { server: state.info, ...state.catalog });
    const key = `${url.searchParams.get('item')}|${url.searchParams.get('path')}`;
    if (url.pathname === '/v1/hash') {
      const f = state.files.get(key);
      if (!f) return send(404, { error: 'no such file' });
      return send(200, { sha256: state.hashOverride.get(key) ?? sha(f), size: f.length });
    }
    if (url.pathname === '/v1/file') {
      const f = state.files.get(key);
      if (!f) return send(404, { error: 'no such file' });
      const range = req.headers.range;
      if (range) {
        state.ranges.push(range);
        const start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
        res.writeHead(206, { 'Content-Length': f.length - start, 'Content-Range': `bytes ${start}-${f.length - 1}/${f.length}` });
        return res.end(f.subarray(start));
      }
      res.writeHead(200, { 'Content-Length': f.length });
      return res.end(f);
    }
    if (url.pathname === '/v1/saves') {
      const z = state.saves.get(url.searchParams.get('emulatorId') ?? '');
      if (!z) return send(404, { error: 'no saves' });
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': z.length });
      return res.end(z);
    }
    if (url.pathname === '/v1/setup') return state.setup ? send(200, state.setup) : send(404, {});
    send(404, { error: 'not found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return Object.assign(state, { port, close: () => new Promise<void>((r) => server.close(() => r())) });
}

function addGame(s: FakeServer, g: { id: string; title: string; systemId: string; serial?: string | null; folder: string; files: Record<string, Buffer> }): ShareGameItem {
  const item: ShareGameItem = {
    kind: 'game', id: g.id, title: g.title, systemId: g.systemId, region: null, serial: g.serial ?? null, folder: g.folder,
    files: Object.entries(g.files).map(([path, b]) => ({ path, size: b.length, mtimeMs: 0 })),
    sizeBytes: Object.values(g.files).reduce((n, b) => n + b.length, 0),
    coverThumb: null,
  };
  for (const [p, b] of Object.entries(g.files)) s.files.set(`${g.id}|${p}`, b);
  s.catalog.games.push(item);
  return item;
}

function addBios(s: FakeServer, b: { id: string; systemId: string; files: Record<string, Buffer> }): ShareBiosItem {
  const item: ShareBiosItem = { kind: 'bios', id: b.id, systemId: b.systemId, label: `${b.systemId.toUpperCase()} BIOS`, category: 'bios', files: Object.entries(b.files).map(([path, f]) => ({ path, size: f.length, mtimeMs: 0 })), sizeBytes: 0 };
  for (const [p, f] of Object.entries(b.files)) s.files.set(`${b.id}|${p}`, f);
  s.catalog.bios.push(item);
  return item;
}

// ------------------------------------------------------------- client PC

function fakeSaveRegistry(saveRoot: string) {
  const adapter = { manifest: { id: 'fakeemu', name: 'Fake Emu', implemented: true }, saveLocations: () => [{ label: 'Memory cards', path: join(saveRoot, 'cards') }] };
  return { implemented: () => [adapter], get: (id: string) => (id === 'fakeemu' ? adapter : undefined), require: () => adapter } as unknown as AdapterRegistry;
}

let pcN = 0;
function makeClientPc(opts: { games?: { id: number; system_id: string; title: string; serial: string | null }[]; discoverer?: Discoverer } = {}) {
  const base = join(t.dir, `client-${pcN++}`);
  const db = new Database(':memory:');
  migrate(db);
  const settings = new SettingsRepo(db);
  const ops = new OpsRepo(db);
  const paths = new AppPaths(join(base, 'userdata'), join(base, 'home'));
  paths.ensureBaseLayout();
  const saveRoot = join(base, 'emu-saves');
  mkdirSync(join(saveRoot, 'cards'), { recursive: true });
  const saves = new SaveService(fakeSaveRegistry(saveRoot), {} as EmulatorManager, paths, ops, settings, { computerName: 'Desk', installDir: join(base, 'Program Files') });
  const libPaths: { path: string }[] = [];
  const games = (opts.games ?? []).map((g) => ({ ...g, cover_thumb: null as string | null }));
  const now = new Date().toISOString();
  for (const g of games) db.prepare('INSERT INTO games(id, system_id, title, sort_title, serial, group_key, added_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)').run(g.id, g.system_id, g.title, g.title.toLowerCase(), g.serial, `k${g.id}`, now, now);
  const scans: number[] = [];
  const notifications: string[] = [];
  const installs: string[] = [];
  const savedEmu: Record<string, EmulatorSettings> = {};
  const emuDefaults: EmulatorSettings = { preset: 'balanced', resolutionScale: 1, renderer: 'auto', aspectRatio: '16:9', fullscreen: true, frameLimit: true, vsync: false, advanced: {} };
  const fakeEmulators = {
    isInstalled: (id: string) => id === 'dolphin',
    settingsFor: (id: string) => savedEmu[id] ?? structuredClone(emuDefaults),
    saveSettings: async (id: string, s: EmulatorSettings) => { savedEmu[id] = s; },
    install: (id: string) => { installs.push(id); return { jobId: `job-${id}` }; },
    applyControllerProfile: async () => ({ applied: [], skipped: [] }),
  };
  const backups: string[] = [];
  const setup = new SetupImporter({
    settings,
    emulators: fakeEmulators,
    isKnownEmulator: (id) => ['pcsx2', 'dolphin'].includes(id),
    ops,
    library: { allGames: () => games },
    backup: async () => { const p = join(base, 'db-backup.db'); backups.push(p); return p; },
  });
  const store = new Map<string, unknown>();
  const client = new ShareClient({
    store: { getInternal: <T,>(k: string, f: T) => (store.has(k) ? (store.get(k) as T) : f), setInternal: (k, v) => void store.set(k, structuredClone(v)) },
    identity: () => ({ deviceId: 'client-device', name: 'Desk' }),
    timeoutMs: 3000,
  });
  const jobs = new JobManager(new EventBus());
  const svc = new ShareCopyService({
    client,
    discoverer: opts.discoverer ?? { discover: async () => [] },
    jobs,
    paths: { systemBiosDir: (id) => paths.systemBiosDir(id), downloads: paths.downloads, thumbnails: paths.thumbnails },
    library: { listPaths: () => libPaths, allGames: () => games, setCoverThumb: (id, th) => { const g = games.find((x) => x.id === id); if (g) g.cover_thumb = th; } },
    addLibraryPath: async (p) => void libPaths.push({ path: p }),
    scanLibrary: async () => void scans.push(Date.now()),
    saves,
    setup,
    ops,
    notifications: { add: (_l, title) => void notifications.push(title) },
    documentsDir: join(base, 'home', 'Documents'),
  });
  return { base, db, settings, ops, paths, saves, saveRoot, svc, client, store, jobs, libPaths, games, scans, notifications, installs, savedEmu, backups };
}

async function pairWith(pc: ReturnType<typeof makeClientPc>, s: FakeServer): Promise<string> {
  const { requestId } = await pc.svc.pairStart('127.0.0.1', s.port);
  await pc.svc.pairFinish(requestId, s.code);
  return s.info.deviceId;
}

async function copy(pc: ReturnType<typeof makeClientPc>, deviceId: string, sel: Partial<Parameters<ShareCopyService['copy']>[1]>): Promise<CopySummary> {
  const { done } = pc.svc.copy(deviceId, { gameIds: [], biosIds: [], savesIds: [], setup: false, gamesDestination: null, ...sel });
  return done;
}

// ------------------------------------------------------------------ tests

let server: FakeServer;
beforeAll(async () => { server = await startFakeServer(); });
afterAll(async () => { await server.close(); });

describe('pairing', () => {
  it('pairs with the 6-digit code and stores the token; a wrong code is refused', async () => {
    const pc = makeClientPc();
    const info = await pc.svc.connect('127.0.0.1', server.port);
    expect(info.name).toBe('Living Room PC');
    const { requestId, server: srv } = await pc.svc.pairStart('127.0.0.1', server.port);
    expect(srv.deviceId).toBe(server.info.deviceId);
    await expect(pc.svc.pairFinish(requestId, '000000')).rejects.toMatchObject({ detail: { code: 'SHARE_WRONG_CODE' } });
    await expect(pc.svc.pairFinish(requestId, '12')).rejects.toMatchObject({ detail: { code: 'SHARE_WRONG_CODE' } });
    const ok = await pc.svc.pairFinish(requestId, server.code.slice(0, 3) + ' ' + server.code.slice(3));
    expect(ok.deviceId).toBe(server.info.deviceId);
    const stored = pc.store.get(PAIRED_SERVERS_KEY) as { deviceId: string; token: string; address: string; port: number }[];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ deviceId: server.info.deviceId, token: server.token, address: '127.0.0.1', port: server.port });
    expect(pc.svc.knownPcs()[0]).not.toHaveProperty('token');
    // The token is sent on authenticated requests (the fake server checks it).
    await expect(pc.client.catalog(server.info.deviceId)).resolves.toMatchObject({ games: [] });
    pc.svc.forget(server.info.deviceId);
    expect(pc.svc.knownPcs()).toEqual([]);
  });

  it('explains when pairing is closed and when the PC is not sharing', async () => {
    const pc = makeClientPc();
    server.info.pairingOpen = false;
    try {
      await expect(pc.svc.pairStart('127.0.0.1', server.port)).rejects.toMatchObject({ detail: { code: 'SHARE_PAIRING_CLOSED' } });
    } finally {
      server.info.pairingOpen = true;
    }
    const closed = await startFakeServer('Gone');
    const port = closed.port;
    await closed.close();
    await expect(pc.svc.connect('127.0.0.1', port)).rejects.toMatchObject({ detail: { code: 'SHARE_NOT_SHARING', whatHappened: "That PC isn't sharing right now." } });
  });

  it('a revoked token gives a clear "pair again" error', async () => {
    const pc = makeClientPc();
    const id = await pairWith(pc, server);
    const list = pc.store.get(PAIRED_SERVERS_KEY) as { token: string }[];
    list[0].token = 'token-revoked-revoked-revoked-revoked';
    pc.store.set(PAIRED_SERVERS_KEY, list);
    await expect(pc.client.catalog(id)).rejects.toMatchObject({ detail: { code: 'SHARE_NOT_PAIRED' } });
  });

  it('discovery lists announced PCs, updates moved paired PCs and ignores non-local answers', async () => {
    const pc = makeClientPc({
      discoverer: {
        discover: async () => [
          { kind: 'omnipc-announce', protocol: 1, deviceId: server.info.deviceId, name: 'Living Room PC', port: server.port, version: '1.4.0', address: '::ffff:127.0.0.1' },
          { kind: 'omnipc-announce', protocol: 1, deviceId: 'evil', name: 'Internet', port: 1, version: '1', address: '8.8.8.8' },
          { kind: 'omnipc-announce', protocol: 1, deviceId: 'other', name: 'Bedroom', port: 47632, version: '1.4.0', address: '192.168.1.40' },
        ],
      },
    });
    await pairWith(pc, server);
    const found = await pc.svc.discover();
    expect(found.map((f) => f.deviceId).sort()).toEqual([server.info.deviceId, 'other'].sort());
    expect(found.find((f) => f.deviceId === server.info.deviceId)).toMatchObject({ paired: true, address: '127.0.0.1' });
    expect(found.find((f) => f.deviceId === 'other')).toMatchObject({ paired: false });
  });
});

describe('non-local hosts', () => {
  it('refuses public addresses before any network request', async () => {
    let calls = 0;
    const client = new ShareClient({ store: { getInternal: (_k, f) => f, setInternal: () => undefined }, identity: () => ({ deviceId: 'x', name: 'x' }), fetchImpl: (async () => { calls++; throw new Error('should not fetch'); }) as unknown as typeof fetch });
    await expect(client.info('8.8.8.8', 47632)).rejects.toMatchObject({ detail: { code: 'SHARE_NOT_LOCAL' } });
    await expect(client.pairStart('203.0.113.5', 47632)).rejects.toMatchObject({ detail: { code: 'SHARE_NOT_LOCAL' } });
    await expect(client.info('2001:db8::1', 47632)).rejects.toMatchObject({ detail: { code: 'SHARE_NOT_LOCAL' } });
    await expect(resolveLocalHost('8.8.8.8')).rejects.toMatchObject({ detail: { code: 'SHARE_NOT_LOCAL' } });
    await expect(resolveLocalHost('bad host!')).rejects.toMatchObject({ detail: { code: 'SHARE_BAD_ADDRESS' } });
    expect(await resolveLocalHost('192.168.1.20')).toBe('192.168.1.20');
    expect(await resolveLocalHost('[fe80::1]')).toBe('fe80::1');
    expect(calls).toBe(0);
  });
});

describe('catalog and "already on this PC"', () => {
  it('flags games by system+serial or title, BIOS by name+size, and reports local save size', async () => {
    const s = await startFakeServer('Catalog PC');
    try {
      addGame(s, { id: 'g1', title: 'Final Fantasy X', systemId: 'ps2', serial: 'SLUS_203.12', folder: 'PS2', files: { 'ffx.iso': Buffer.from('ffx') } });
      addGame(s, { id: 'g2', title: 'Super Mario Sunshine!', systemId: 'gc', folder: 'GameCube', files: { 'sms.iso': Buffer.from('sms') } });
      addGame(s, { id: 'g3', title: 'Okami', systemId: 'ps2', folder: 'PS2', files: { 'okami.iso': Buffer.from('okami') } });
      addBios(s, { id: 'b1', systemId: 'ps2', files: { 'scph10000.bin': Buffer.from('bios-bytes') } });
      addBios(s, { id: 'b2', systemId: 'ps1', files: { 'scph1001.bin': Buffer.from('ps1-bios') } });
      s.catalog.saves.push({ kind: 'saves', id: 's1', emulatorId: 'fakeemu', emulatorName: 'Fake Emu', fileCount: 1, sizeBytes: 10, lastModified: null });
      const pc = makeClientPc({ games: [
        { id: 1, system_id: 'ps2', title: 'FFX (renamed locally)', serial: 'SLUS-20312' },
        { id: 2, system_id: 'gc', title: 'super mario sunshine', serial: null },
        { id: 3, system_id: 'ps1', title: 'Okami', serial: null }, // different system
      ] });
      mkdirSync(pc.paths.systemBiosDir('ps2'), { recursive: true });
      writeFileSync(join(pc.paths.systemBiosDir('ps2'), 'scph10000.bin'), 'bios-bytes');
      writeFileSync(join(pc.saveRoot, 'cards', 'card.ps2'), '12345');
      const id = await pairWith(pc, s);
      const view = await pc.svc.catalogView(id);
      expect(view.catalog.games).toHaveLength(3);
      expect(view.have.games).toEqual({ g1: true, g2: true, g3: false });
      expect(view.have.bios).toEqual({ b1: true, b2: false });
      expect(view.have.saves).toEqual({ s1: 5 });
    } finally {
      await s.close();
    }
  });
});

describe('copying games', () => {
  it('copies into <destination>/<folder>/<path>, adds the library folder and scans', async () => {
    const s = await startFakeServer('Games PC');
    try {
      const disc1 = Buffer.alloc(300_000, 7);
      const disc2 = Buffer.from('disc two');
      addGame(s, { id: 'g1', title: 'Two Disc Game', systemId: 'ps1', folder: 'PS1/Two Disc Game', files: { 'Disc 1.bin': disc1, 'sub/Disc 2.bin': disc2 } });
      addGame(s, { id: 'g2', title: 'Another', systemId: 'ps2', folder: 'PS2', files: { 'another.iso': Buffer.from('another') } });
      const pc = makeClientPc();
      const id = await pairWith(pc, s);
      const dest = join(pc.base, 'Games');
      const r = await copy(pc, id, { gameIds: ['g1', 'g2'], gamesDestination: dest });
      expect(r.failed).toEqual([]);
      expect(r.copied).toHaveLength(3);
      expect(readFileSync(join(dest, 'PS1', 'Two Disc Game', 'Disc 1.bin')).equals(disc1)).toBe(true);
      expect(readFileSync(join(dest, 'PS1', 'Two Disc Game', 'sub', 'Disc 2.bin'), 'utf8')).toBe('disc two');
      expect(readFileSync(join(dest, 'PS2', 'another.iso'), 'utf8')).toBe('another');
      expect(readdirSync(join(dest, 'PS2')).some((f) => f.endsWith('.omnipc-partial'))).toBe(false);
      expect(pc.libPaths.map((p) => p.path)).toEqual([dest]);
      expect(pc.scans).toHaveLength(1);
      expect(r.libraryPathAdded).toBe(dest);
      expect(pc.notifications[0]).toBe('Copied from Games PC');
      expect(pc.ops.changes(5).some((c) => c.kind === 'share.copy')).toBe(true);
      // Copying again skips identical files.
      const again = await copy(pc, id, { gameIds: ['g2'], gamesDestination: dest });
      expect(again.skipped).toHaveLength(1);
      expect(again.copied).toHaveLength(0);
      expect(pc.libPaths).toHaveLength(1);
      // The job is visible like any other.
      expect(pc.jobs.list().some((j) => j.kind === 'share.copy' && j.state === 'succeeded')).toBe(true);
    } finally {
      await s.close();
    }
  });

  it('resumes a partial file with a Range request', async () => {
    const s = await startFakeServer('Resume PC');
    try {
      const data = Buffer.from(Array.from({ length: 200_000 }, (_, i) => i % 251));
      addGame(s, { id: 'g1', title: 'Big', systemId: 'ps2', folder: 'PS2', files: { 'big.iso': data } });
      const pc = makeClientPc();
      const id = await pairWith(pc, s);
      const dest = join(pc.base, 'Games');
      mkdirSync(join(dest, 'PS2'), { recursive: true });
      writeFileSync(join(dest, 'PS2', 'big.iso.omnipc-partial'), data.subarray(0, 120_000));
      const r = await copy(pc, id, { gameIds: ['g1'], gamesDestination: dest });
      expect(r.failed).toEqual([]);
      expect(s.ranges).toEqual(['bytes=120000-']);
      expect(readFileSync(join(dest, 'PS2', 'big.iso')).equals(data)).toBe(true);
      expect(existsSync(join(dest, 'PS2', 'big.iso.omnipc-partial'))).toBe(false);
    } finally {
      await s.close();
    }
  });

  it('a hash mismatch fails the file and leaves no final (or partial) file', async () => {
    const s = await startFakeServer('Bad Hash PC');
    try {
      addGame(s, { id: 'g1', title: 'Corrupt', systemId: 'ps2', folder: 'PS2', files: { 'bad.iso': Buffer.from('actual bytes'), 'good.iso': Buffer.from('good') } });
      s.hashOverride.set('g1|bad.iso', sha(Buffer.from('other bytes!')));
      const pc = makeClientPc();
      const id = await pairWith(pc, s);
      const dest = join(pc.base, 'Games');
      const r = await copy(pc, id, { gameIds: ['g1'], gamesDestination: dest });
      expect(r.failed).toHaveLength(1);
      expect(r.failed[0]).toMatchObject({ item: 'Corrupt', file: 'bad.iso' });
      expect(r.failed[0].reason).toMatch(/checksum/);
      expect(existsSync(join(dest, 'PS2', 'bad.iso'))).toBe(false);
      expect(existsSync(join(dest, 'PS2', 'bad.iso.omnipc-partial'))).toBe(false);
      expect(readFileSync(join(dest, 'PS2', 'good.iso'), 'utf8')).toBe('good');
      expect(pc.notifications[0]).toMatch(/problems/);
    } finally {
      await s.close();
    }
  });

  it('rejects path traversal, absolute paths and drive letters from a malicious catalog', async () => {
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/Windows/evil.dll', 'C:evil', 'a\\..\\b', 'CON', 'ok/aux.txt', 'trailing.', '', 'a//b']) {
      expect(() => safeRelativePath(bad), bad).toThrow();
    }
    expect(safeRelativePath('PS2/Final Fantasy X/disc.iso')).toEqual(['PS2', 'Final Fantasy X', 'disc.iso']);
    const s = await startFakeServer('Evil PC');
    try {
      addGame(s, { id: 'g1', title: 'Evil folder', systemId: 'ps2', folder: '../../outside', files: { 'x.iso': Buffer.from('x') } });
      addGame(s, { id: 'g2', title: 'Evil files', systemId: 'ps2', folder: 'PS2', files: { '../../../escape.txt': Buffer.from('e'), '/abs.txt': Buffer.from('a'), 'C:/drive.txt': Buffer.from('d'), 'fine.iso': Buffer.from('fine') } });
      addBios(s, { id: 'b1', systemId: '../ps2', files: { 'x.bin': Buffer.from('x') } });
      addBios(s, { id: 'b2', systemId: 'ps2', files: { '../../escape.bin': Buffer.from('x') } });
      const pc = makeClientPc();
      const id = await pairWith(pc, s);
      const dest = join(pc.base, 'Games');
      const r = await copy(pc, id, { gameIds: ['g1', 'g2'], biosIds: ['b1', 'b2'], gamesDestination: dest });
      expect(r.failed.length).toBe(6);
      expect(r.copied.map((c) => c.file)).toEqual(['fine.iso']);
      expect(existsSync(join(pc.base, 'outside'))).toBe(false);
      expect(existsSync(join(pc.base, 'escape.txt'))).toBe(false);
      expect(existsSync(join(t.dir, 'escape.txt'))).toBe(false);
      expect(existsSync(join(pc.paths.bios, '..', 'escape.bin'))).toBe(false);
      expect(readdirSync(join(dest, 'PS2'))).toEqual(['fine.iso']);
    } finally {
      await s.close();
    }
  });

  it('keeps an existing different file and saves the copy as "name (from <PC>).ext"', async () => {
    const s = await startFakeServer('Office PC');
    try {
      addGame(s, { id: 'g1', title: 'Clash', systemId: 'ps2', folder: 'PS2', files: { 'game.iso': Buffer.from('from the other pc') } });
      const pc = makeClientPc();
      const id = await pairWith(pc, s);
      const dest = join(pc.base, 'Games');
      mkdirSync(join(dest, 'PS2'), { recursive: true });
      writeFileSync(join(dest, 'PS2', 'game.iso'), 'mine, different');
      const r = await copy(pc, id, { gameIds: ['g1'], gamesDestination: dest });
      expect(r.renamed).toHaveLength(1);
      expect(r.renamed[0].savedAs).toBe(join(dest, 'PS2', 'game (from Office PC).iso'));
      expect(readFileSync(join(dest, 'PS2', 'game.iso'), 'utf8')).toBe('mine, different');
      expect(readFileSync(join(dest, 'PS2', 'game (from Office PC).iso'), 'utf8')).toBe('from the other pc');
      // A second copy finds the renamed copy and skips.
      const again = await copy(pc, id, { gameIds: ['g1'], gamesDestination: dest });
      expect(again.skipped).toHaveLength(1);
      expect(again.renamed).toHaveLength(0);
    } finally {
      await s.close();
    }
  });
});

describe('BIOS, firmware and keys', () => {
  it('places files in the system BIOS folder, skips identical ones and never replaces a different one', async () => {
    const s = await startFakeServer('Bios PC');
    try {
      addBios(s, { id: 'b1', systemId: 'ps2', files: { 'scph10000.bin': Buffer.from('ps2 bios'), 'scph39001.bin': Buffer.from('second bios') } });
      addBios(s, { id: 'b2', systemId: 'switch', files: { 'prod.keys': Buffer.from('keys from other pc') } });
      const pc = makeClientPc();
      const id = await pairWith(pc, s);
      mkdirSync(pc.paths.systemBiosDir('ps2'), { recursive: true });
      writeFileSync(join(pc.paths.systemBiosDir('ps2'), 'scph39001.bin'), 'second bios');
      mkdirSync(pc.paths.systemBiosDir('switch'), { recursive: true });
      writeFileSync(join(pc.paths.systemBiosDir('switch'), 'prod.keys'), 'my own keys');
      const r = await copy(pc, id, { biosIds: ['b1', 'b2'] });
      expect(readFileSync(join(pc.paths.systemBiosDir('ps2'), 'scph10000.bin'), 'utf8')).toBe('ps2 bios');
      expect(r.copied.map((c) => c.file)).toEqual(['scph10000.bin']);
      expect(r.skipped.map((c) => c.file)).toEqual(['scph39001.bin']);
      expect(r.renamed.map((c) => c.file)).toEqual(['prod.keys']);
      expect(readFileSync(join(pc.paths.systemBiosDir('switch'), 'prod.keys'), 'utf8')).toBe('my own keys');
      expect(readFileSync(join(pc.paths.systemBiosDir('switch'), 'prod (from Bios PC).keys'), 'utf8')).toBe('keys from other pc');
      expect(pc.libPaths).toEqual([]); // no games: library untouched
    } finally {
      await s.close();
    }
  });
});

describe('saves', () => {
  it('restores into this PC\'s save folder after backing up the current saves first', async () => {
    // Make a real OmniPC save backup ZIP on "the other PC".
    const other = makeClientPc();
    writeFileSync(join(other.saveRoot, 'cards', 'Mcd001.ps2'), 'their save');
    const [made] = await other.saves.backup('fakeemu', 'manual');
    const s = await startFakeServer('Saves PC');
    try {
      s.saves.set('fakeemu', readFileSync(made.path));
      s.catalog.saves.push({ kind: 'saves', id: 'sv1', emulatorId: 'fakeemu', emulatorName: 'Fake Emu', fileCount: 1, sizeBytes: readFileSync(made.path).length, lastModified: null });
      const pc = makeClientPc();
      writeFileSync(join(pc.saveRoot, 'cards', 'Mcd001.ps2'), 'my save');
      const id = await pairWith(pc, s);
      const r = await copy(pc, id, { savesIds: ['sv1'] });
      expect(r.failed).toEqual([]);
      expect(readFileSync(join(pc.saveRoot, 'cards', 'Mcd001.ps2'), 'utf8')).toBe('their save');
      const backups = await pc.saves.list();
      const safety = backups.find((b) => b.kind === 'pre-restore');
      expect(safety).toBeDefined();
      expect(r.copied[0].reason).toContain(safety!.path);
      expect(readdirSync(pc.paths.downloads).filter((f) => f.startsWith('share-saves-'))).toEqual([]); // temp ZIP removed
      expect(pc.ops.changes(10).some((c) => c.kind === 'saves.restore' && c.summary.includes('Saves PC'))).toBe(true);
    } finally {
      await s.close();
    }
  });
});

describe('setup import', () => {
  it('merges settings without secrets or paths, configures emulators, queues installs and maps per-game profiles', async () => {
    const s = await startFakeServer('Setup PC');
    try {
      s.setup = {
        protocol: 1,
        exportedAt: new Date().toISOString(),
        from: s.info,
        settings: {
          reduceMotion: true,
          launchTimeoutSeconds: 45,
          defaultPreset: 'quality',
          aiApiKey: 'sk-secret',
          theGamesDbApiKey: 'tgdb-secret',
          retroAchievements: { enabled: true, username: 'someone', hardcore: true },
          startWithWindows: true,
          onboardingComplete: true,
          saveBackup: { schedule: 'weekly', afterPlay: false, beforeEmulatorUpdate: true, destination: 'D:\\OneDrive', keepPerEmulator: 4 },
        } as SetupExport['settings'],
        emulators: [
          { id: 'pcsx2', installed: true, settings: { preset: 'quality', resolutionScale: 3, renderer: 'vulkan', aspectRatio: '16:9', fullscreen: true, frameLimit: true, vsync: true, advanced: { 'EmuCore/GS/x': '1', 'Folders/Bios': 'C:\\Users\\them\\bios' } } },
          { id: 'dolphin', installed: true, settings: { preset: 'balanced', resolutionScale: 2, renderer: 'd3d12', aspectRatio: 'auto', fullscreen: false, frameLimit: true, vsync: false, advanced: {} } },
          { id: 'unknownemu', installed: true, settings: {} as EmulatorSettings },
        ],
        controllerProfile: { id: 9, name: 'Their pad', controllerKind: 'dualsense', deviceIndex: 0, mapping: { A: 'B' } as never, nintendoLayoutForNintendoSystems: true, rumble: false, deadzone: 0.2, perSystem: {}, updatedAt: '' },
        profiles: [
          { systemId: 'ps2', title: 'Whatever', serial: 'SLUS-20312', profile: { emulatorId: 'pcsx2', overrides: { resolutionScale: 4 }, customArgs: '--run-something', notes: 'by serial' } },
          { systemId: 'gc', title: 'Super Mario Sunshine!', serial: null, profile: { emulatorId: 'evil', overrides: {}, customArgs: null, notes: 'by title' } },
          { systemId: 'wii', title: 'Not Here', serial: null, profile: { emulatorId: null, overrides: {}, customArgs: null, notes: null } },
        ],
      };
      const pc = makeClientPc({ games: [{ id: 11, system_id: 'ps2', title: 'Final Fantasy X', serial: 'SLUS_203.12' }, { id: 12, system_id: 'gc', title: 'super mario sunshine', serial: null }] });
      const id = await pairWith(pc, s);
      const r = await copy(pc, id, { setup: true });
      expect(r.failed).toEqual([]);
      const setup = r.setup!;
      const st = pc.settings.getAll();
      expect(st.reduceMotion).toBe(true);
      expect(st.launchTimeoutSeconds).toBe(45);
      expect(st.defaultPreset).toBe('quality');
      expect(st.aiApiKey).toBe('');
      expect(st.theGamesDbApiKey).toBe('');
      expect(st.retroAchievements).toEqual(DEFAULT_SETTINGS.retroAchievements);
      expect(st.startWithWindows).toBe(false);
      expect(st.onboardingComplete).toBe(false);
      expect(st.saveBackup).toMatchObject({ schedule: 'weekly', afterPlay: false, keepPerEmulator: 4, destination: null });
      expect(setup.settingsApplied).not.toContain('aiApiKey');
      // Emulator settings saved, path-like advanced values dropped.
      expect(pc.savedEmu.pcsx2).toMatchObject({ resolutionScale: 3, renderer: 'vulkan', advanced: { 'EmuCore/GS/x': '1' } });
      expect(pc.savedEmu.pcsx2.advanced).not.toHaveProperty('Folders/Bios');
      expect(pc.savedEmu.dolphin).toMatchObject({ resolutionScale: 2 });
      // pcsx2 was installed there and not here: install queued. Dolphin is already here.
      expect(pc.installs).toEqual(['pcsx2']);
      expect(setup.installsQueued).toEqual([{ emulatorId: 'pcsx2', jobId: 'job-pcsx2' }]);
      // Controller profile applied.
      expect(pc.ops.getControllerProfile()).toMatchObject({ name: 'Their pad', controllerKind: 'dualsense', rumble: false });
      // Profiles matched by serial and by title; unknown emulator and custom args dropped.
      expect(setup.profilesMatched).toBe(2);
      expect(setup.profilesUnmatched).toBe(1);
      expect(pc.ops.getGameProfile(11)).toMatchObject({ emulatorId: 'pcsx2', customArgs: null, notes: 'by serial', overrides: { resolutionScale: 4 } });
      expect(pc.ops.getGameProfile(12)).toMatchObject({ emulatorId: null, notes: 'by title' });
      // Undo point taken before applying.
      expect(pc.backups).toHaveLength(1);
      expect(setup.backupPath).toBe(pc.backups[0]);
      expect(pc.settings.getInternal<{ settings: { reduceMotion: boolean } } | null>(SETUP_SNAPSHOT_KEY, null)?.settings.reduceMotion).toBe(false);
    } finally {
      await s.close();
    }
  });

  it('sanitizeSettings only keeps keys that are present', () => {
    expect(sanitizeSettings({ reduceMotion: true }, structuredClone(DEFAULT_SETTINGS))).toEqual({ reduceMotion: true });
    expect(sanitizeSettings({ launchTimeoutSeconds: 'x', updateChannel: 'evil', aiApiKey: 'k' }, structuredClone(DEFAULT_SETTINGS))).toEqual({});
  });
});
