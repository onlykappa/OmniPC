// "Copy from another PC", client side: talks to another OmniPC that shares
// (see src/shared/share.ts for the protocol). Only local-network addresses are
// ever contacted, every authenticated request carries the paired token, and
// nothing received is executed: responses are parsed as JSON or written to
// files the caller chose.

import { createWriteStream } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  SHARE_PROTOCOL_VERSION,
  isLocalAddress,
  type PairResult,
  type SetupExport,
  type ShareCatalog,
  type ShareInfo,
} from '@shared/share';
import { OmniFailure } from '../core/errors';
import { logger } from '../core/logger';

const log = logger.scope('share-client');

/** A sharing PC this PC paired with. The token is never sent to the renderer. */
export interface PairedServer {
  deviceId: string;
  name: string;
  address: string;
  port: number;
  token: string;
  version: string;
  pairedAt: string;
}

export interface ClientIdentity {
  deviceId: string;
  name: string;
}

export interface ShareClientStore {
  getInternal<T>(key: string, fallback: T): T;
  setInternal(key: string, value: unknown): void;
}

export interface ShareClientOptions {
  store: ShareClientStore;
  identity: () => ClientIdentity;
  fetchImpl?: typeof fetch;
  /** Timeout for small JSON requests (ms). */
  timeoutMs?: number;
  /** A file transfer fails when no data arrives for this long (ms). */
  idleTimeoutMs?: number;
}

export const PAIRED_SERVERS_KEY = 'share.pairedServers';
const PAIR_REQUEST_TTL_MS = 10 * 60 * 1000;

const notSharing = (detail?: string) =>
  new OmniFailure({
    code: 'SHARE_NOT_SHARING',
    whatHappened: "That PC isn't sharing right now.",
    detected: detail ? [detail] : [],
    probableCause: 'Sharing is turned off on that PC, it is asleep or off, or Windows Firewall is blocking OmniPC.',
    userAction: ['On the other PC, open Share & Copy and turn on "Share this PC". Both PCs must be on the same home network.'],
  });

const notLocal = (host: string) =>
  new OmniFailure({
    code: 'SHARE_NOT_LOCAL',
    whatHappened: `${host} is not on your home network. OmniPC only connects to PCs on your local network.`,
    userAction: ['Enter the address shown on the other PC under Share & Copy (for example 192.168.1.20).'],
  });

/** Formats an address for a URL (IPv6 in brackets, zone id escaped). */
function hostForUrl(address: string): string {
  return isIP(address) === 6 ? `[${address.replace(/%/g, '%25')}]` : address;
}

function validPort(port: unknown): number {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new OmniFailure({ code: 'SHARE_BAD_PORT', whatHappened: 'That port number is not valid.' });
  return p;
}

/** Resolves a manually entered host to a local IP address, refusing anything outside the local network. */
export async function resolveLocalHost(input: string): Promise<string> {
  const host = String(input ?? '').trim().replace(/^\[(.*)\]$/, '$1');
  if (!host) throw new OmniFailure({ code: 'SHARE_BAD_ADDRESS', whatHappened: 'Enter the address of the other PC.' });
  if (isIP(host)) {
    if (!isLocalAddress(host)) throw notLocal(host);
    return host;
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(host)) throw new OmniFailure({ code: 'SHARE_BAD_ADDRESS', whatHappened: `"${host}" is not a valid PC name or address.` });
  const found = await lookup(host, { all: true }).catch(() => [] as { address: string }[]);
  const local = found.find((a) => isLocalAddress(a.address));
  if (local) return local.address;
  if (found.length) throw notLocal(host);
  throw new OmniFailure({ code: 'SHARE_NOT_FOUND', whatHappened: `No PC called "${host}" was found on your network.`, userAction: ['Use the IP address shown on the other PC under Share & Copy.'] });
}

interface RequestOpts {
  method?: 'GET' | 'POST';
  body?: unknown;
  token?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Time allowed until response headers arrive. */
  timeoutMs?: number;
  /** Who we are talking to, for messages. */
  peerName?: string;
}

interface OpenResponse {
  res: Response;
  /** Restarts the inactivity timer (call when data arrives). */
  touch: () => void;
  /** Stops the timer. */
  done: () => void;
}

export class ShareClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly idleTimeoutMs: number;
  private pending = new Map<string, { address: string; port: number; info: ShareInfo; expires: number }>();

  constructor(private readonly opts: ShareClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 30000;
  }

  // ------------------------------------------------------------ paired list

  paired(): PairedServer[] {
    const list = this.opts.store.getInternal<PairedServer[]>(PAIRED_SERVERS_KEY, []);
    return Array.isArray(list) ? list.filter((s) => s && typeof s.deviceId === 'string' && typeof s.token === 'string') : [];
  }

  server(deviceId: string): PairedServer {
    const s = this.paired().find((p) => p.deviceId === deviceId);
    if (!s) throw new OmniFailure({ code: 'SHARE_NOT_PAIRED', whatHappened: 'This PC is not paired with that PC yet.', userAction: ['Find the PC again and pair it with the 6-digit code.'] });
    return s;
  }

  private savePaired(list: PairedServer[]): void {
    this.opts.store.setInternal(PAIRED_SERVERS_KEY, list);
  }

  forget(deviceId: string): void {
    this.savePaired(this.paired().filter((p) => p.deviceId !== deviceId));
  }

  /** Remembers a new address for a paired PC (discovery found it elsewhere). */
  updateAddress(deviceId: string, address: string, port: number, name?: string): void {
    if (!isLocalAddress(address)) return;
    const list = this.paired();
    const s = list.find((p) => p.deviceId === deviceId);
    if (!s || (s.address === address && s.port === port && (!name || s.name === name))) return;
    s.address = address;
    s.port = port;
    if (name) s.name = name;
    this.savePaired(list);
  }

  // --------------------------------------------------------------- requests

  private async open(address: string, port: number, path: string, o: RequestOpts = {}): Promise<OpenResponse> {
    if (!isLocalAddress(address)) throw notLocal(address);
    const url = `http://${hostForUrl(address)}:${validPort(port)}${path}`;
    const controller = new AbortController();
    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;
    const arm = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, ms);
    };
    const onAbort = () => controller.abort();
    if (o.signal?.aborted) controller.abort();
    o.signal?.addEventListener('abort', onAbort, { once: true });
    const done = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      o.signal?.removeEventListener('abort', onAbort);
    };
    arm(o.timeoutMs ?? this.timeoutMs);
    const headers: Record<string, string> = { 'User-Agent': 'OmniPC-Share', Accept: 'application/json', ...(o.headers ?? {}) };
    if (o.token) headers.Authorization = `Bearer ${o.token}`;
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: o.method ?? 'GET', headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined, redirect: 'manual', signal: controller.signal });
    } catch (err) {
      done();
      if (o.signal?.aborted && !timedOut) throw err;
      log.info('share request failed', { url, error: String((err as Error)?.message ?? err) });
      throw notSharing(timedOut ? 'No answer in time.' : String((err as { cause?: { code?: string } })?.cause?.code ?? (err as Error)?.message ?? err));
    }
    if (res.status >= 300 && res.status < 400) {
      done();
      throw new OmniFailure({ code: 'SHARE_REDIRECT', whatHappened: 'The other PC answered with a redirect, which OmniPC does not follow.' });
    }
    return { res, touch: () => arm(this.idleTimeoutMs), done };
  }

  private async json<T>(address: string, port: number, path: string, o: RequestOpts & { errors?: Record<number, () => OmniFailure> } = {}): Promise<T> {
    const r = await this.open(address, port, path, o);
    try {
      if (!r.res.ok) {
        const text = await r.res.text().catch(() => '');
        throw this.httpError(r.res.status, text, o);
      }
      return (await r.res.json()) as T;
    } catch (err) {
      if (err instanceof OmniFailure) throw err;
      if (o.signal?.aborted) throw err;
      throw notSharing('The answer could not be read.');
    } finally {
      r.done();
    }
  }

  private httpError(status: number, body: string, o: RequestOpts & { errors?: Record<number, () => OmniFailure> }): OmniFailure {
    const custom = o.errors?.[status];
    if (custom) return custom();
    let serverMessage = '';
    try {
      const j = JSON.parse(body) as { error?: unknown; message?: unknown };
      serverMessage = typeof j.error === 'string' ? j.error : typeof j.message === 'string' ? j.message : '';
    } catch {
      serverMessage = body.slice(0, 200);
    }
    const who = o.peerName ?? 'The other PC';
    if (status === 401) return new OmniFailure({ code: 'SHARE_NOT_PAIRED', whatHappened: `${who} no longer recognises this PC.`, probableCause: 'This PC was removed from its paired PCs.', userAction: ['Pair again with the 6-digit code.'], technical: serverMessage || null });
    if (status === 403) return new OmniFailure({ code: 'SHARE_FORBIDDEN', whatHappened: `${who} is not sharing that.`, probableCause: 'The other PC narrowed what it shares.', technical: serverMessage || null });
    if (status === 404) return new OmniFailure({ code: 'SHARE_GONE', whatHappened: `${who} no longer has that item.`, userAction: ['Scan the other PC again.'], technical: serverMessage || null });
    if (status === 503) return notSharing(serverMessage || 'HTTP 503');
    return new OmniFailure({ code: 'SHARE_HTTP', whatHappened: `${who} answered with an error (HTTP ${status}).`, technical: serverMessage || null });
  }

  // ------------------------------------------------------------- endpoints

  /** GET /v1/info on any local address (no pairing needed). */
  async info(address: string, port: number, signal?: AbortSignal): Promise<ShareInfo> {
    const info = await this.json<ShareInfo>(address, port, '/v1/info', { signal });
    if (!info || typeof info !== 'object' || typeof info.deviceId !== 'string' || typeof info.name !== 'string') throw notSharing('The answer is not from OmniPC.');
    if (info.protocol !== SHARE_PROTOCOL_VERSION) {
      throw new OmniFailure({
        code: 'SHARE_VERSION',
        whatHappened: `${info.name} runs a ${info.protocol > SHARE_PROTOCOL_VERSION ? 'newer' : 'older'} version of OmniPC that this PC cannot copy from.`,
        userAction: ['Update OmniPC on both PCs to the same version.'],
      });
    }
    return info;
  }

  /** Step 1 of pairing: the other PC shows a 6-digit code on its screen. */
  async pairStart(address: string, port: number): Promise<{ requestId: string; server: ShareInfo }> {
    const info = await this.info(address, port);
    if (!info.pairingOpen) {
      throw new OmniFailure({
        code: 'SHARE_PAIRING_CLOSED',
        whatHappened: `${info.name} isn't accepting new PCs right now.`,
        userAction: [`On ${info.name}, open Share & Copy and click "Allow a new PC", then try again.`],
      });
    }
    const me = this.opts.identity();
    const closed = () => new OmniFailure({ code: 'SHARE_PAIRING_CLOSED', whatHappened: `${info.name} isn't accepting new PCs right now.`, userAction: [`On ${info.name}, click "Allow a new PC", then try again.`] });
    const busy = () => new OmniFailure({ code: 'SHARE_PAIRING_BUSY', whatHappened: `${info.name} has too many PCs waiting to pair.`, userAction: [`On ${info.name}, reject the requests you don't recognise, then try again.`] });
    const r = await this.json<{ requestId?: unknown }>(address, port, '/v1/pair/request', { method: 'POST', body: { deviceId: me.deviceId, name: me.name }, peerName: info.name, errors: { 403: closed, 409: closed, 423: closed, 429: busy } });
    if (typeof r?.requestId !== 'string' || !r.requestId) throw notSharing('No pairing request id.');
    this.pending.set(r.requestId, { address, port, info, expires: Date.now() + PAIR_REQUEST_TTL_MS });
    return { requestId: r.requestId, server: info };
  }

  /** Step 2: the code the user read off the other PC's screen. Stores the token. */
  async pairFinish(requestId: string, code: string): Promise<ShareInfo> {
    const p = this.pending.get(requestId);
    if (!p || p.expires < Date.now()) {
      this.pending.delete(requestId);
      throw new OmniFailure({ code: 'SHARE_PAIR_EXPIRED', whatHappened: 'That pairing request has expired.', userAction: ['Start pairing again.'] });
    }
    const digits = String(code ?? '').replace(/\D/g, '');
    if (digits.length !== 6) throw new OmniFailure({ code: 'SHARE_WRONG_CODE', whatHappened: 'Wrong code. Type the 6 digits shown on the other PC.' });
    const wrong = () => new OmniFailure({ code: 'SHARE_WRONG_CODE', whatHappened: 'Wrong code.', userAction: [`Type the 6-digit code shown on ${p.info.name}.`] });
    const expired = () => { this.pending.delete(requestId); return new OmniFailure({ code: 'SHARE_PAIR_EXPIRED', whatHappened: `The pairing request expired or was rejected on ${p.info.name}.`, userAction: ['Start pairing again.'] }); };
    const tooMany = () => { this.pending.delete(requestId); return new OmniFailure({ code: 'SHARE_PAIR_LOCKED', whatHappened: 'Too many wrong codes. Pairing was stopped for safety.', userAction: ['Start pairing again.'] }); };
    const r = await this.json<PairResult>(p.address, p.port, '/v1/pair/confirm', { method: 'POST', body: { requestId, code: digits }, peerName: p.info.name, errors: { 400: wrong, 401: wrong, 403: wrong, 404: expired, 410: expired, 429: tooMany } });
    if (!r || typeof r.token !== 'string' || r.token.length < 16) throw notSharing('Pairing answer without a token.');
    const server = r.server && typeof r.server.deviceId === 'string' ? r.server : p.info;
    if (server.deviceId !== p.info.deviceId) throw new OmniFailure({ code: 'SHARE_PAIR_MISMATCH', whatHappened: 'A different PC answered the pairing request. Nothing was saved.' });
    this.pending.delete(requestId);
    const list = this.paired().filter((s) => s.deviceId !== server.deviceId);
    list.push({ deviceId: server.deviceId, name: server.name, address: p.address, port: p.port, token: r.token, version: server.version, pairedAt: new Date().toISOString() });
    this.savePaired(list);
    return server;
  }

  private authed<T>(deviceId: string, path: string, o: RequestOpts = {}): Promise<T> {
    const s = this.server(deviceId);
    return this.json<T>(s.address, s.port, path, { ...o, token: s.token, peerName: s.name });
  }

  async catalog(deviceId: string, signal?: AbortSignal): Promise<ShareCatalog> {
    const c = await this.authed<ShareCatalog>(deviceId, '/v1/catalog', { signal, timeoutMs: 60000 });
    if (!c || !Array.isArray(c.games) || !Array.isArray(c.bios) || !Array.isArray(c.saves)) throw notSharing('The list of shared items could not be read.');
    c.setup ??= { emulators: [], perGameProfiles: 0, hasControllerProfile: false };
    return c;
  }

  async hash(deviceId: string, itemId: string, path: string, signal?: AbortSignal): Promise<{ sha256: string; size: number }> {
    // Hashing a large game on the other PC takes a while.
    const r = await this.authed<{ sha256?: unknown; size?: unknown }>(deviceId, `/v1/hash?${new URLSearchParams({ item: itemId, path })}`, { signal, timeoutMs: 15 * 60 * 1000 });
    if (typeof r?.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(r.sha256) || typeof r.size !== 'number' || !Number.isSafeInteger(r.size) || r.size < 0) throw notSharing('The file checksum could not be read.');
    return { sha256: r.sha256.toLowerCase(), size: r.size };
  }

  async setup(deviceId: string, signal?: AbortSignal): Promise<SetupExport> {
    const r = await this.authed<SetupExport>(deviceId, '/v1/setup', { signal, timeoutMs: 30000 });
    if (!r || typeof r !== 'object') throw notSharing('The setup could not be read.');
    return r;
  }

  /**
   * Downloads one shared file into `partPath`, resuming from its current size
   * with a Range request. Returns the size of the partial file afterwards.
   */
  async downloadFile(deviceId: string, itemId: string, path: string, partPath: string, offset: number, o: { signal?: AbortSignal; onBytes?: (n: number) => void; onRestart?: (dropped: number) => void } = {}): Promise<number> {
    const s = this.server(deviceId);
    const headers: Record<string, string> = { Accept: '*/*' };
    if (offset > 0) headers.Range = `bytes=${offset}-`;
    const r = await this.open(s.address, s.port, `/v1/file?${new URLSearchParams({ item: itemId, path })}`, { token: s.token, signal: o.signal, headers, peerName: s.name, timeoutMs: 60000 });
    try {
      if (r.res.status === 416 && offset > 0) {
        // Partial is already complete (or longer than the file); let the caller verify.
        return offset;
      }
      if (!r.res.ok) throw this.httpError(r.res.status, await r.res.text().catch(() => ''), { peerName: s.name });
      const resumed = offset > 0 && r.res.status === 206;
      if (offset > 0 && !resumed) o.onRestart?.(offset);
      return await this.streamTo(r, partPath, resumed ? 'a' : 'w', resumed ? offset : 0, o);
    } finally {
      r.done();
    }
  }

  /** Downloads a save backup ZIP of one emulator (made on the other PC now). */
  async downloadSaves(deviceId: string, emulatorId: string, dest: string, o: { signal?: AbortSignal; onBytes?: (n: number) => void } = {}): Promise<number> {
    const s = this.server(deviceId);
    const r = await this.open(s.address, s.port, `/v1/saves?${new URLSearchParams({ emulatorId })}`, { token: s.token, signal: o.signal, headers: { Accept: 'application/zip' }, peerName: s.name, timeoutMs: 5 * 60 * 1000 });
    try {
      if (!r.res.ok) throw this.httpError(r.res.status, await r.res.text().catch(() => ''), { peerName: s.name });
      return await this.streamTo(r, dest, 'w', 0, o);
    } finally {
      r.done();
    }
  }

  private async streamTo(r: OpenResponse, file: string, flags: 'a' | 'w', start: number, o: { signal?: AbortSignal; onBytes?: (n: number) => void }): Promise<number> {
    if (!r.res.body) throw notSharing('Empty answer.');
    const out = createWriteStream(file, { flags });
    const closed = new Promise<void>((resolve, reject) => { out.on('close', () => resolve()); out.on('error', reject); });
    let size = start;
    try {
      const reader = r.res.body.getReader();
      r.touch();
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (err) {
          if (o.signal?.aborted) throw err;
          throw notSharing('The connection was interrupted. Copying again resumes where it stopped.');
        }
        if (chunk.done) break;
        r.touch();
        size += chunk.value.byteLength;
        if (!out.write(chunk.value)) await new Promise<void>((res) => out.once('drain', () => res()));
        o.onBytes?.(chunk.value.byteLength);
      }
    } finally {
      out.end();
      await closed;
    }
    return size;
  }
}
