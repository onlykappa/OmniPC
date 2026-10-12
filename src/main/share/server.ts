// "Share this PC": the sharing side of "Copy from another PC" (protocol in
// src/shared/share.ts). An HTTP server on the local network, running only
// while the user has sharing turned on.
//
// Safety rules:
//  - Requests from addresses outside the local network are refused (403).
//  - Everything except /v1/info and pairing needs a paired device's token.
//    Only a SHA-256 hash of each token is stored; comparisons are constant time.
//  - Pairing is only accepted while the user has opened it on this PC. The
//    6-digit code is shown here and typed on the other PC. At most 5 pending
//    requests; a request is locked after 5 wrong codes; requests expire.
//  - Files are served only from the catalog: an (item id, relative path) pair
//    must match a file this PC listed. Client input is never joined onto a
//    folder, and symbolic links are never followed.
//  - Nothing received is executed or written to disk, except the paired
//    device's name (sanitized and length-limited) in settings.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, open, rm } from 'node:fs/promises';
import { hostname, networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppSettings, EmulatorSettings, GameProfile, UniversalControllerProfile } from '@shared/models';
import {
  SHARE_DEFAULT_PORT,
  SHARE_PROTOCOL_VERSION,
  isLocalAddress,
  type PairResult,
  type PairedDevice,
  type PendingPair,
  type SetupExport,
  type ShareCatalog,
  type ShareInfo,
  type ShareServerStatus,
} from '@shared/share';
import type { EventBus } from '../core/events';
import { logger } from '../core/logger';
import { errorMessage } from '../core/errors';
import { buildCatalog, type BuiltCatalog, type CatalogDeps } from './catalog';
import { DiscoveryResponder } from './discovery';

const log = logger.scope('share');

export const MAX_PENDING = 5;
export const MAX_CODE_ATTEMPTS = 5;
/** Wrong codes (all requests together) after which pairing closes until the user opens it again. */
export const MAX_FAILED_CODES_PER_WINDOW = 20;
export const PAIR_REQUEST_TTL_MS = 5 * 60 * 1000;
const CATALOG_TTL_MS = 5000;
const MAX_BODY = 4096;
const HASH_CACHE_MAX = 5000;

type Sharing = ShareServerStatus['sharing'];
const DEFAULT_SHARING: Sharing = { games: true, bios: true, saves: true, setup: true };

interface StoredDevice extends PairedDevice { tokenHash: string }
interface Pending { requestId: string; deviceId: string; name: string; code: string; expiresAt: number; attempts: number }

/** App settings copied by "Copy setup". Everything else (secrets, paths, machine/window state) stays on this PC. */
export const SETUP_SETTING_KEYS = [
  'reduceMotion',
  'autoRepairSafeIssues',
  'backgroundHealthChecks',
  'metadataOnline',
  'artworkProviders',
  'updateChannel',
  'checkUpdatesOnStart',
  'autoUpdateEmulators',
  'checkAppUpdatesOnStart',
  'defaultPreset',
  'launchTimeoutSeconds',
  'crashLoopThreshold',
  'hotkeys',
] as const satisfies readonly (keyof AppSettings)[];

export interface ShareDeps extends CatalogDeps {
  settings: {
    getAll(): AppSettings;
    getInternal<T>(key: string, fallback: T): T;
    setInternal(key: string, value: unknown): void;
  };
  bus: EventBus;
  appVersion: string;
  /** Emulators OmniPC knows (implemented adapters). */
  emulatorIds: () => string[];
  isInstalled: (id: string) => boolean;
  emulatorVersion: (id: string) => string | null;
  /** Settings OmniPC stores for an emulator (null when never set). */
  storedEmulatorSettings: (id: string) => EmulatorSettings | null;
  settingsFor: (id: string) => EmulatorSettings;
  controllerProfile: () => UniversalControllerProfile | null;
  gameProfile: (gameId: number) => GameProfile | null;
  /** Writes one emulator's saves as an OmniPC save backup ZIP (SaveService.exportZip). */
  exportSaves: (emulatorId: string, dest: string) => Promise<{ fileName: string; fileCount: number } | null>;
}

export interface ShareOptions {
  /** HTTP port to try first (default SHARE_DEFAULT_PORT; 0 = any free port). */
  port?: number;
  /** Bind address (default: all interfaces). */
  host?: string;
  /** UDP discovery port; null disables the responder (tests). */
  discoveryPort?: number | null;
  /** Computer name (default os.hostname()). */
  name?: string;
  tmpDir?: string;
}

/** Device names shown on this PC: printable, trimmed, at most 64 characters. */
export function sanitizeDeviceName(v: unknown): string {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 64) : '';
  return s || 'Unknown PC';
}

const DEVICE_ID_RE = /^[\w-]{1,64}$/;
const TOKEN_RE = /^Bearer\s+([0-9a-f]{64})$/i;

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

function sameCode(expected: string, given: string): boolean {
  const x = Buffer.from(expected.padEnd(16, '\0'));
  const y = Buffer.from(String(given).slice(0, 16).padEnd(16, '\0'));
  return timingSafeEqual(x, y) && given.length === expected.length;
}

/** Looks like an absolute path on this PC (Windows drive or UNC path, or a POSIX root path). */
export function looksLikeAbsolutePath(v: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(v) || /^\\\\/.test(v) || /^\//.test(v) || /[a-zA-Z]:\\/.test(v);
}

function stripPaths(advanced: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(advanced ?? {})) if (typeof v !== 'string' || !looksLikeAbsolutePath(v)) out[k] = v;
  return out;
}

/** Parses a single "bytes=a-b" range. null = no/unsupported header (send everything); 'invalid' = 416. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  if (m[1] === '' && m[2] === '') return 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || start >= size || end < start) return 'invalid';
  return { start, end };
}

function localAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal && isLocalAddress(i.address)) out.push(i.address);
  }
  return out;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class ShareServer {
  private server: Server | null = null;
  private discovery: DiscoveryResponder | null = null;
  private listeningPort: number | null = null;
  private lastError: string | null = null;
  private pending = new Map<string, Pending>();
  private locked = new Map<string, number>();
  private pairingUntil: number | null = null;
  private failedCodes = 0;
  private sweeper: NodeJS.Timeout | null = null;
  private catalog: BuiltCatalog | null = null;
  private catalogKey = '';
  private building: Promise<BuiltCatalog> | null = null;
  /** Kind of every item id ever listed, so ids of items no longer shared get 403, not 404. */
  private knownKinds = new Map<string, 'game' | 'bios'>();
  private hashCache = new Map<string, Promise<{ sha256: string; size: number }>>();
  private starting: Promise<void> | null = null;
  readonly name: string;

  constructor(private readonly deps: ShareDeps, private readonly opts: ShareOptions = {}) {
    this.name = sanitizeDeviceName(opts.name ?? hostname());
  }

  // ---------------------------------------------------------------- state

  get deviceId(): string {
    let id = this.deps.settings.getInternal<string | null>('share.deviceId', null);
    if (!id || !DEVICE_ID_RE.test(id)) {
      id = randomUUID();
      this.deps.settings.setInternal('share.deviceId', id);
    }
    return id;
  }

  get enabled(): boolean {
    return !!this.server;
  }

  /** Whether the user left sharing on (restored at startup). */
  wantsEnabled(): boolean {
    return this.deps.settings.getInternal<boolean>('share.enabled', false);
  }

  sharing(): Sharing {
    return { ...DEFAULT_SHARING, ...this.deps.settings.getInternal<Partial<Sharing>>('share.sharing', {}) };
  }

  private devices(): StoredDevice[] {
    const raw = this.deps.settings.getInternal<StoredDevice[]>('share.paired', []);
    return Array.isArray(raw) ? raw.filter((d) => d && typeof d.tokenHash === 'string' && typeof d.deviceId === 'string') : [];
  }

  private saveDevices(list: StoredDevice[]): void {
    this.deps.settings.setInternal('share.paired', list);
  }

  pairingOpen(): boolean {
    return this.enabled && this.pairingUntil !== null && Date.now() < this.pairingUntil;
  }

  info(): ShareInfo {
    return { protocol: SHARE_PROTOCOL_VERSION, deviceId: this.deviceId, name: this.name, version: this.deps.appVersion, pairingOpen: this.pairingOpen() };
  }

  status(): ShareServerStatus {
    this.sweep(false);
    return {
      enabled: this.enabled,
      port: this.listeningPort,
      name: this.name,
      deviceId: this.deviceId,
      addresses: this.enabled ? localAddresses() : [],
      pairingOpen: this.pairingOpen(),
      pending: [...this.pending.values()].map((p): PendingPair => ({ requestId: p.requestId, deviceId: p.deviceId, name: p.name, code: p.code, expiresAt: new Date(p.expiresAt).toISOString() })),
      paired: this.devices().map(({ tokenHash: _t, ...d }) => d),
      sharing: this.sharing(),
      error: this.lastError,
    };
  }

  private changed(): void {
    this.deps.bus.emit('share.changed', this.status());
  }

  // ------------------------------------------------------------- controls

  async setEnabled(on: boolean): Promise<ShareServerStatus> {
    if (on) {
      // A failure is reported in status.error (and sharing stays off).
      const ok = await this.start().then(() => true, () => false);
      this.deps.settings.setInternal('share.enabled', ok);
    } else {
      this.deps.settings.setInternal('share.enabled', false);
      await this.stop();
      this.lastError = null;
    }
    this.changed();
    return this.status();
  }

  setSharing(partial: Partial<Sharing>): ShareServerStatus {
    const next = { ...this.sharing() };
    for (const k of Object.keys(DEFAULT_SHARING) as (keyof Sharing)[]) if (typeof partial?.[k] === 'boolean') next[k] = partial[k]!;
    this.deps.settings.setInternal('share.sharing', next);
    this.catalog = null;
    this.changed();
    return this.status();
  }

  openPairing(minutes: number): ShareServerStatus {
    const m = Math.min(60, Math.max(1, Number.isFinite(minutes) ? minutes : 10));
    this.pairingUntil = Date.now() + m * 60_000;
    this.failedCodes = 0;
    this.changed();
    return this.status();
  }

  closePairing(): ShareServerStatus {
    this.pairingUntil = null;
    this.pending.clear();
    this.changed();
    return this.status();
  }

  revoke(deviceId: string): ShareServerStatus {
    this.saveDevices(this.devices().filter((d) => d.deviceId !== deviceId));
    this.changed();
    return this.status();
  }

  rejectPending(requestId: string): ShareServerStatus {
    this.pending.delete(requestId);
    this.changed();
    return this.status();
  }

  /** Starts the HTTP server (default port, else any free port) and the discovery responder. */
  async start(): Promise<void> {
    if (this.server) return;
    if (this.starting) return this.starting;
    this.starting = this.startUnlocked().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async startUnlocked(): Promise<void> {
    this.lastError = null;
    const server = createServer((req, res) => this.handle(req, res));
    server.on('clientError', (_err, socket) => socket.destroy());
    const listen = (port: number) => new Promise<void>((resolve, reject) => {
      const onErr = (e: Error) => { server.off('listening', onOk); reject(e); };
      const onOk = () => { server.off('error', onErr); resolve(); };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(port, this.opts.host);
    });
    const port = this.opts.port ?? SHARE_DEFAULT_PORT;
    try {
      try {
        await listen(port);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || port === 0) throw e;
        log.info(`port ${port} is in use; sharing on another port`);
        await listen(0);
      }
    } catch (e) {
      this.lastError = `Sharing could not start: ${errorMessage(e)}`;
      log.warn('share server failed to start', { error: errorMessage(e) });
      throw e;
    }
    server.on('error', (e) => log.warn('share server error', { error: errorMessage(e) }));
    this.server = server;
    const addr = server.address();
    this.listeningPort = typeof addr === 'object' && addr ? addr.port : null;
    if (this.opts.discoveryPort !== null) {
      this.discovery = new DiscoveryResponder({ port: this.opts.discoveryPort, announce: () => ({ deviceId: this.deviceId, name: this.name, port: this.listeningPort ?? 0, version: this.deps.appVersion }) });
      await this.discovery.start().catch((e) => {
        this.lastError = `Other PCs may not find this PC automatically: ${errorMessage(e)}`;
        log.warn('discovery responder failed', { error: errorMessage(e) });
        this.discovery = null;
      });
    }
    this.sweeper = setInterval(() => this.sweep(true), 5000);
    this.sweeper.unref?.();
    log.info('sharing on', { port: this.listeningPort });
  }

  /** Stops everything (also used at shutdown; does not change the saved on/off choice). */
  async stop(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    this.pending.clear();
    this.locked.clear();
    this.pairingUntil = null;
    this.catalog = null;
    const server = this.server;
    this.server = null;
    this.listeningPort = null;
    const d = this.discovery;
    this.discovery = null;
    await d?.stop();
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      log.info('sharing off');
    }
  }

  /** Drops expired pairing requests and closes pairing when its time is up. */
  private sweep(emit: boolean): void {
    const now = Date.now();
    let changed = false;
    for (const [id, p] of this.pending) if (p.expiresAt <= now) { this.pending.delete(id); changed = true; }
    for (const [id, until] of this.locked) if (until <= now) this.locked.delete(id);
    if (this.pairingUntil !== null && now >= this.pairingUntil) { this.pairingUntil = null; this.pending.clear(); changed = true; }
    if (changed && emit) this.changed();
  }

  // -------------------------------------------------------------- catalog

  /** Forces the next request to rebuild the catalog (e.g. after a library scan). */
  invalidateCatalog(): void {
    this.catalog = null;
  }

  private async builtCatalog(maxAgeMs = CATALOG_TTL_MS): Promise<BuiltCatalog> {
    const s = this.sharing();
    const key = `${s.games}|${s.bios}|${s.saves}`;
    if (this.catalog && this.catalogKey === key && Date.now() - this.catalog.builtAt < maxAgeMs) return this.catalog;
    if (this.building) return this.building;
    this.building = buildCatalog(this.deps, s).then((c) => {
      this.catalog = c;
      this.catalogKey = key;
      for (const [id, item] of c.index) this.knownKinds.set(id, item.kind);
      return c;
    }).finally(() => { this.building = null; });
    return this.building;
  }

  async catalogFor(): Promise<ShareCatalog> {
    const c = await this.builtCatalog();
    const s = this.sharing();
    return { server: this.info(), games: c.games, bios: c.bios, saves: c.saves, setup: s.setup ? this.setupSummary() : { emulators: [], perGameProfiles: 0, hasControllerProfile: false } };
  }

  private setupSummary(): ShareCatalog['setup'] {
    const exp = this.setupExport();
    return {
      emulators: exp.emulators.filter((e) => e.installed).map((e) => ({ id: e.id, name: this.deps.emulatorName(e.id), version: this.deps.emulatorVersion(e.id) })),
      perGameProfiles: exp.profiles.length,
      hasControllerProfile: !!exp.controllerProfile,
    };
  }

  setupExport(): SetupExport {
    const all = this.deps.settings.getAll();
    const settings: Partial<AppSettings> = {};
    for (const k of SETUP_SETTING_KEYS) (settings as Record<string, unknown>)[k] = structuredClone(all[k]);
    const emulators: SetupExport['emulators'] = [];
    for (const id of this.deps.emulatorIds()) {
      const installed = this.deps.isInstalled(id);
      if (!installed && !this.deps.storedEmulatorSettings(id)) continue;
      const s = this.deps.settingsFor(id);
      emulators.push({ id, installed, settings: { ...s, advanced: stripPaths(s.advanced) } });
    }
    const profiles: SetupExport['profiles'] = [];
    const seen = new Set<string>();
    for (const g of this.deps.library.allGames()) {
      const p = this.deps.gameProfile(g.id);
      if (!p) continue;
      const key = `${g.system_id}\0${g.title.toLowerCase()}\0${g.serial ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const { gameId: _g, ...rest } = p;
      profiles.push({
        systemId: g.system_id,
        title: g.title,
        serial: g.serial,
        profile: { ...rest, overrides: { ...rest.overrides, ...(rest.overrides?.advanced ? { advanced: stripPaths(rest.overrides.advanced) } : {}) }, customArgs: rest.customArgs && looksLikeAbsolutePath(rest.customArgs) ? null : rest.customArgs },
      });
    }
    return { protocol: SHARE_PROTOCOL_VERSION, exportedAt: new Date().toISOString(), from: this.info(), settings, emulators, controllerProfile: this.deps.controllerProfile(), profiles };
  }

  // ---------------------------------------------------------------- HTTP

  /** Request entry point (public so tests can drive it with a fake remote address). */
  handle(req: IncomingMessage, res: ServerResponse): void {
    this.route(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log.warn('share request failed', { url: req.url, error: errorMessage(err) });
      if (!res.headersSent) sendJson(res, status, { error: err instanceof HttpError ? err.message : 'Internal error' });
      else res.destroy();
    });
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const remote = req.socket?.remoteAddress ?? '';
    if (!isLocalAddress(remote)) {
      throw new HttpError(403, 'Only computers on the local network can connect.');
    }
    if (!this.enabled) throw new HttpError(503, 'Sharing is off.');
    const url = new URL(req.url ?? '/', 'http://omnipc.invalid');
    const route = `${req.method ?? 'GET'} ${url.pathname}`;
    switch (route) {
      case 'GET /v1/info': return sendJson(res, 200, this.info());
      case 'POST /v1/pair/request': return sendJson(res, 200, this.pairRequest(await readJson(req)));
      case 'POST /v1/pair/confirm': return sendJson(res, 200, this.pairConfirm(await readJson(req)));
      default: break;
    }
    if (!['GET /v1/catalog', 'GET /v1/file', 'GET /v1/hash', 'GET /v1/saves', 'GET /v1/setup'].includes(route)) {
      throw new HttpError(/^\/v1\/(catalog|file|hash|saves|setup)$/.test(url.pathname) ? 405 : 404, 'Not found.');
    }
    this.authenticate(req.headers.authorization);
    const s = this.sharing();
    switch (url.pathname) {
      case '/v1/catalog': return sendJson(res, 200, await this.catalogFor());
      case '/v1/setup':
        if (!s.setup) throw new HttpError(403, 'This PC does not share its setup.');
        return sendJson(res, 200, this.setupExport());
      case '/v1/file': return this.sendFile(req, res, await this.resolveFile(url));
      case '/v1/hash': return sendJson(res, 200, await this.hashFile(await this.resolveFile(url)));
      case '/v1/saves': return this.sendSaves(res, url.searchParams.get('emulatorId'));
    }
  }

  private authenticate(header: string | undefined): StoredDevice {
    const m = TOKEN_RE.exec(header ?? '');
    if (!m) throw new HttpError(401, 'Pair this PC first.');
    const h = hashToken(m[1].toLowerCase());
    let found: StoredDevice | null = null;
    const list = this.devices();
    for (const d of list) if (sameHex(d.tokenHash, h)) found = d; // no early exit: constant work per device
    if (!found) throw new HttpError(401, 'This PC is not paired (or was removed). Pair it again.');
    const now = Date.now();
    if (!found.lastSeenAt || now - Date.parse(found.lastSeenAt) > 60_000) {
      const at = new Date(now).toISOString();
      this.saveDevices(list.map((d) => (d.deviceId === found!.deviceId ? { ...d, lastSeenAt: at } : d)));
      found = { ...found, lastSeenAt: at };
      this.changed();
    }
    return found;
  }

  // -------------------------------------------------------------- pairing

  private pairRequest(body: Record<string, unknown>): { requestId: string } {
    this.sweep(false);
    if (!this.pairingOpen()) throw new HttpError(403, 'This PC is not accepting new PCs right now. On it, open "Share this PC" and choose "Allow new PC".');
    const deviceId = body.deviceId;
    if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) throw new HttpError(400, 'Invalid device id.');
    // A repeated request from the same PC replaces its earlier one.
    for (const [id, p] of this.pending) if (p.deviceId === deviceId) this.pending.delete(id);
    if (this.pending.size >= MAX_PENDING) throw new HttpError(429, 'Too many PCs are waiting to pair. Try again in a few minutes.');
    const p: Pending = { requestId: randomUUID(), deviceId, name: sanitizeDeviceName(body.name), code: String(randomInt(0, 1_000_000)).padStart(6, '0'), expiresAt: Date.now() + PAIR_REQUEST_TTL_MS, attempts: 0 };
    this.pending.set(p.requestId, p);
    log.info('pairing requested', { deviceId, name: p.name });
    this.changed();
    return { requestId: p.requestId };
  }

  private pairConfirm(body: Record<string, unknown>): PairResult {
    this.sweep(false);
    const requestId = typeof body.requestId === 'string' ? body.requestId : '';
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (this.locked.has(requestId)) throw new HttpError(429, 'Too many wrong codes. Start pairing again.');
    const p = this.pending.get(requestId);
    if (!p) throw new HttpError(404, 'This pairing request expired or was rejected. Start pairing again.');
    if (!sameCode(p.code, code)) {
      p.attempts++;
      if (++this.failedCodes >= MAX_FAILED_CODES_PER_WINDOW) {
        log.warn('too many wrong pairing codes; pairing closed');
        this.pairingUntil = null;
        this.pending.clear();
        this.changed();
        throw new HttpError(429, 'Too many wrong codes. Pairing was closed on the other PC.');
      }
      if (p.attempts >= MAX_CODE_ATTEMPTS) {
        this.pending.delete(requestId);
        this.locked.set(requestId, p.expiresAt);
        this.changed();
        throw new HttpError(429, 'Too many wrong codes. Start pairing again.');
      }
      throw new HttpError(403, 'Wrong code. Type the 6-digit code shown on the other PC.');
    }
    this.pending.delete(requestId);
    const token = randomBytes(32).toString('hex');
    const now = new Date().toISOString();
    const device: StoredDevice = { deviceId: p.deviceId, name: p.name, pairedAt: now, lastSeenAt: now, tokenHash: hashToken(token) };
    this.saveDevices([...this.devices().filter((d) => d.deviceId !== p.deviceId), device]);
    log.info('PC paired', { deviceId: p.deviceId, name: p.name });
    this.changed();
    return { token, server: this.info() };
  }

  // ---------------------------------------------------------------- files

  /** Maps (item, path) to a file this PC listed. Never builds a path from client input. */
  private async resolveFile(url: URL): Promise<string> {
    const item = url.searchParams.get('item') ?? '';
    const path = url.searchParams.get('path') ?? '';
    if (!/^[0-9a-f]{16}$/.test(item) || !path || path.length > 4096) throw new HttpError(404, 'Not found.');
    let c = await this.builtCatalog(Number.POSITIVE_INFINITY);
    if (!c.index.has(item)) c = await this.builtCatalog(0);
    const entry = c.index.get(item);
    if (!entry) {
      const kind = this.knownKinds.get(item);
      const s = this.sharing();
      if ((kind === 'game' && !s.games) || (kind === 'bios' && !s.bios)) throw new HttpError(403, 'This item is not shared.');
      throw new HttpError(404, 'Not found.');
    }
    const abs = entry.files.get(path);
    if (!abs) throw new HttpError(404, 'Not found.');
    const st = await lstat(abs).catch(() => null);
    if (!st || st.isSymbolicLink() || !st.isFile()) throw new HttpError(404, 'Not found.');
    return abs;
  }

  private async sendFile(req: IncomingMessage, res: ServerResponse, abs: string): Promise<void> {
    const fh = await open(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => null);
    if (!fh) throw new HttpError(404, 'Not found.');
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw new HttpError(404, 'Not found.');
      const size = st.size;
      const range = parseRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, size);
      if (range === 'invalid') {
        res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid range.' }));
        await fh.close();
        return;
      }
      const headers: Record<string, string | number> = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Last-Modified': st.mtime.toUTCString() };
      if (range) {
        res.writeHead(206, { ...headers, 'Content-Length': range.end - range.start + 1, 'Content-Range': `bytes ${range.start}-${range.end}/${size}` });
      } else {
        res.writeHead(200, { ...headers, 'Content-Length': size });
      }
      if (size === 0) {
        res.end();
        await fh.close();
        return;
      }
      const stream = fh.createReadStream(range ? { start: range.start, end: range.end } : {});
      await pipeStream(stream, res);
    } catch (e) {
      await fh.close().catch(() => undefined);
      throw e;
    }
  }

  private hashFile(abs: string): Promise<{ sha256: string; size: number }> {
    return lstat(abs).then((st) => {
      const key = `${abs}|${st.size}|${st.mtimeMs}`;
      let p = this.hashCache.get(key);
      if (!p) {
        p = open(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).then((fh) => new Promise<{ sha256: string; size: number }>((resolve, reject) => {
          const h = createHash('sha256');
          let size = 0;
          fh.createReadStream()
            .on('data', (c: Buffer | string) => { const b = typeof c === 'string' ? Buffer.from(c) : c; size += b.length; h.update(b); })
            .on('error', reject)
            .on('end', () => resolve({ sha256: h.digest('hex'), size }));
        }));
        p.catch(() => this.hashCache.delete(key));
        if (this.hashCache.size >= HASH_CACHE_MAX) this.hashCache.delete(this.hashCache.keys().next().value!);
        this.hashCache.set(key, p);
      }
      return p;
    });
  }

  private async sendSaves(res: ServerResponse, emulatorId: string | null): Promise<void> {
    if (!this.sharing().saves) throw new HttpError(403, 'This PC does not share its saves.');
    const c = await this.builtCatalog();
    const item = c.saves.find((s) => s.emulatorId === emulatorId);
    if (!item || !emulatorId) throw new HttpError(404, 'No saves for that emulator.');
    const tmp = join(this.opts.tmpDir ?? tmpdir(), `omnipc-share-${randomUUID()}.zip`);
    try {
      const made = await this.deps.exportSaves(item.emulatorId, tmp);
      if (!made) throw new HttpError(404, 'No saves for that emulator.');
      const st = await lstat(tmp);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': st.size, 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${made.fileName}"` });
      await pipeStream(createReadStream(tmp), res);
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined);
    }
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
  res.end(data);
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        if (!v || typeof v !== 'object' || Array.isArray(v)) return reject(new HttpError(400, 'Invalid request.'));
        resolve(v as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, 'Invalid request.'));
      }
    });
  });
}

function pipeStream(stream: NodeJS.ReadableStream & { destroy(): void }, res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = () => resolve();
    stream.on('error', (e: Error) => {
      log.warn('share stream failed', { error: e.message });
      res.destroy();
      done();
    });
    res.on('close', () => {
      stream.destroy();
      done();
    });
    res.on('finish', done);
    stream.pipe(res);
  });
}
