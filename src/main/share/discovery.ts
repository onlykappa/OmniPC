// LAN discovery for "Copy from another PC". The copying PC broadcasts a
// DiscoveryProbe on SHARE_DISCOVERY_PORT; every PC with sharing on answers
// with a DiscoveryAnnounce (unicast back to the sender). Only local-network
// senders are answered and anything that is not a well-formed probe is
// ignored. Nothing received here is ever executed or stored.

import { createSocket, type Socket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SHARE_DISCOVERY_PORT, SHARE_PROTOCOL_VERSION, isLocalAddress, type DiscoveredPc, type DiscoveryAnnounce, type DiscoveryProbe } from '@shared/share';
import { logger } from '../core/logger';

const log = logger.scope('share');
const MAX_PACKET = 2048;

function parse(buf: Buffer): Record<string, unknown> | null {
  if (buf.length > MAX_PACKET) return null;
  try {
    const v = JSON.parse(buf.toString('utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const ID_RE = /^[\w-]{1,64}$/;

export function parseProbe(buf: Buffer): DiscoveryProbe | null {
  const v = parse(buf);
  if (!v || v.kind !== 'omnipc-probe' || typeof v.protocol !== 'number' || typeof v.deviceId !== 'string' || !ID_RE.test(v.deviceId)) return null;
  return { kind: 'omnipc-probe', protocol: v.protocol, deviceId: v.deviceId };
}

export function parseAnnounce(buf: Buffer): DiscoveryAnnounce | null {
  const v = parse(buf);
  if (!v || v.kind !== 'omnipc-announce' || typeof v.protocol !== 'number') return null;
  if (typeof v.deviceId !== 'string' || !ID_RE.test(v.deviceId)) return null;
  if (typeof v.name !== 'string' || typeof v.version !== 'string') return null;
  if (typeof v.port !== 'number' || !Number.isInteger(v.port) || v.port < 1 || v.port > 65535) return null;
  return { kind: 'omnipc-announce', protocol: v.protocol, deviceId: v.deviceId, name: v.name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64), port: v.port, version: v.version.slice(0, 32) };
}

export interface ResponderOptions {
  /** Defaults to SHARE_DISCOVERY_PORT (tests pass another). */
  port?: number;
  /** Bind address (default all interfaces). */
  host?: string;
  announce: () => Omit<DiscoveryAnnounce, 'kind' | 'protocol'>;
}

/** Answers probes while sharing is on. */
export class DiscoveryResponder {
  private sock: Socket | null = null;

  constructor(private readonly opts: ResponderOptions) {}

  get port(): number | null {
    try {
      return this.sock?.address().port ?? null;
    } catch {
      return null;
    }
  }

  start(): Promise<void> {
    if (this.sock) return Promise.resolve();
    const sock = createSocket({ type: 'udp4', reuseAddr: true });
    this.sock = sock;
    sock.on('message', (msg, rinfo) => {
      if (!isLocalAddress(rinfo.address)) return;
      const probe = parseProbe(msg);
      if (!probe) return;
      const me = this.opts.announce();
      if (probe.deviceId === me.deviceId) return;
      const reply: DiscoveryAnnounce = { kind: 'omnipc-announce', protocol: SHARE_PROTOCOL_VERSION, ...me };
      sock.send(Buffer.from(JSON.stringify(reply)), rinfo.port, rinfo.address, (err) => {
        if (err) log.debug('discovery reply failed', { error: err.message });
      });
    });
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        this.sock = null;
        try { sock.close(); } catch { /* ignore */ }
        reject(err);
      };
      sock.once('error', onError);
      sock.bind({ port: this.opts.port ?? SHARE_DISCOVERY_PORT, address: this.opts.host, exclusive: false }, () => {
        sock.off('error', onError);
        sock.on('error', (err) => log.warn('discovery socket error', { error: err.message }));
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    const sock = this.sock;
    this.sock = null;
    if (!sock) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        sock.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }
}

/** IPv4 broadcast addresses of this PC's network interfaces (address | ~netmask). */
export function interfaceBroadcasts(): string[] {
  const out = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal || !i.netmask) continue;
      const a = i.address.split('.').map(Number);
      const m = i.netmask.split('.').map(Number);
      if (a.length !== 4 || m.length !== 4) continue;
      out.add(a.map((x, k) => (x | (~m[k] & 255)) & 255).join('.'));
    }
  }
  return [...out];
}

export interface DiscoverOptions {
  /** Port the servers listen on (default SHARE_DISCOVERY_PORT). */
  port?: number;
  /** Where to send the probe. Default: 255.255.255.255 plus every interface broadcast address. */
  targets?: string[];
  /** This PC's deviceId; its own announce is ignored. */
  deviceId?: string;
}

/**
 * Client helper: broadcasts a probe and collects announces for `timeoutMs`.
 * Results are deduplicated by deviceId (first answer wins). `paired` is
 * always false here; the caller fills it in from its own paired list.
 */
export function discover(timeoutMs = 1500, opts: DiscoverOptions = {}): Promise<DiscoveredPc[]> {
  const port = opts.port ?? SHARE_DISCOVERY_PORT;
  const targets = opts.targets ?? ['255.255.255.255', ...interfaceBroadcasts()];
  const me = opts.deviceId ?? randomUUID();
  const found = new Map<string, DiscoveredPc>();
  return new Promise((resolve) => {
    const sock = createSocket({ type: 'udp4', reuseAddr: true });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      try { sock.close(); } catch { /* ignore */ }
      resolve([...found.values()]);
    };
    sock.on('error', (err) => {
      log.warn('discovery failed', { error: err.message });
      finish();
    });
    sock.on('message', (msg, rinfo) => {
      if (!isLocalAddress(rinfo.address)) return;
      const a = parseAnnounce(msg);
      if (!a || a.deviceId === me || found.has(a.deviceId)) return;
      found.set(a.deviceId, { deviceId: a.deviceId, name: a.name, address: rinfo.address.replace(/^::ffff:/i, ''), port: a.port, version: a.version, paired: false });
    });
    sock.bind(0, () => {
      try { sock.setBroadcast(true); } catch { /* sending to unicast targets still works */ }
      const probe: DiscoveryProbe = { kind: 'omnipc-probe', protocol: SHARE_PROTOCOL_VERSION, deviceId: me };
      const buf = Buffer.from(JSON.stringify(probe));
      for (const t of targets) sock.send(buf, port, t, (err) => { if (err) log.debug('probe send failed', { target: t, error: err.message }); });
      setTimeout(finish, timeoutMs);
    });
  });
}
