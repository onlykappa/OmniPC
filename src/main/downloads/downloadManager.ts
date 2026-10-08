// Download manager for emulator archives from trusted upstream hosts.
// - every redirect hop is checked against the manifest's host allowlist
// - pause keeps the partial file and resumes with an HTTP Range request
// - completed files are verified against upstream SHA-256 when published;
//   otherwise the computed hash is recorded (trust on first use) and the UI
//   says so explicitly.

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DownloadItem } from '@shared/models';
import type { EventBus } from '../core/events';
import { OmniFailure } from '../core/errors';
import { logger } from '../core/logger';
import { hostAllowed } from './sources';

const log = logger.scope('downloads');

export interface DownloadRequest {
  name: string;
  url: string;
  version: string | null;
  sourceLabel: string;
  fileName: string;
  allowedHosts: string[];
  expectedSha256: string | null;
  expectedSize: number | null;
}

interface Internal {
  item: DownloadItem;
  req: DownloadRequest;
  partPath: string;
  finalPath: string;
  controller: AbortController | null;
  waiters: { resolve: (r: DownloadOutcome) => void; reject: (e: unknown) => void }[];
  sha256: string | null;
}

export interface DownloadOutcome {
  path: string;
  sha256: string;
  verifiedAgainstUpstream: boolean;
  sizeBytes: number;
}

export class DownloadManager {
  private items = new Map<string, Internal>();

  constructor(private readonly dir: string, private readonly bus: EventBus, private readonly fetchImpl: typeof fetch = fetch) {}

  list(): DownloadItem[] {
    return [...this.items.values()].map((i) => ({ ...i.item })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Starts a download and resolves when it completes and verifies. */
  download(req: DownloadRequest, signal?: AbortSignal): Promise<DownloadOutcome> {
    if (!hostAllowed(req.url, req.allowedHosts)) {
      return Promise.reject(new OmniFailure({ code: 'UNTRUSTED_SOURCE', whatHappened: `Refused to download ${req.name}: ${req.url} is not an approved source.`, detected: [`Allowed hosts: ${req.allowedHosts.join(', ')}`] }));
    }
    const id = randomUUID();
    const safeName = req.fileName.replace(/[^\w.\-]/g, '_');
    const internal: Internal = {
      item: { id, name: req.name, source: req.sourceLabel, url: req.url, version: req.version, totalBytes: req.expectedSize, receivedBytes: 0, bytesPerSecond: 0, status: 'queued', verification: null, error: null, createdAt: new Date().toISOString() },
      req,
      partPath: join(this.dir, `${id}-${safeName}.part`),
      finalPath: join(this.dir, `${id}-${safeName}`),
      controller: null,
      waiters: [],
      sha256: null,
    };
    this.items.set(id, internal);
    const p = new Promise<DownloadOutcome>((resolve, reject) => internal.waiters.push({ resolve, reject }));
    signal?.addEventListener('abort', () => this.cancel(id), { once: true });
    void this.run(internal);
    return p;
  }

  pause(id: string): void {
    const i = this.items.get(id);
    if (!i || i.item.status !== 'downloading') return;
    i.item.status = 'paused';
    i.controller?.abort();
    this.publish(i);
  }

  resume(id: string): void {
    const i = this.items.get(id);
    if (!i || (i.item.status !== 'paused' && i.item.status !== 'failed')) return;
    void this.run(i);
  }

  retry(id: string): void {
    this.resume(id);
  }

  cancel(id: string): void {
    const i = this.items.get(id);
    if (!i || ['completed', 'cancelled'].includes(i.item.status)) return;
    const wasActive = i.item.status === 'downloading';
    i.item.status = 'cancelled';
    i.controller?.abort();
    if (!wasActive) void this.finishCancelled(i);
    this.publish(i);
  }

  private async finishCancelled(i: Internal): Promise<void> {
    await rm(i.partPath, { force: true }).catch(() => undefined);
    const err = new OmniFailure({ code: 'DOWNLOAD_CANCELLED', whatHappened: `Download of ${i.req.name} was cancelled.` });
    for (const w of i.waiters.splice(0)) w.reject(err);
  }

  private async fetchFollowingTrusted(url: string, allowedHosts: string[], headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
    let current = url;
    for (let hop = 0; hop < 8; hop++) {
      if (!hostAllowed(current, allowedHosts)) {
        throw new OmniFailure({ code: 'UNTRUSTED_REDIRECT', whatHappened: `The download was redirected to an unapproved host and was stopped.`, detected: [current] });
      }
      const res = await this.fetchImpl(current, { headers, redirect: 'manual', signal });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location')!, current).toString();
        continue;
      }
      return res;
    }
    throw new OmniFailure({ code: 'TOO_MANY_REDIRECTS', whatHappened: 'The download server redirected too many times.' });
  }

  private async run(i: Internal): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    i.controller = new AbortController();
    i.item.status = 'downloading';
    i.item.error = null;
    this.publish(i);
    const startOffset = existsSync(i.partPath) ? statSync(i.partPath).size : 0;
    const headers: Record<string, string> = { 'User-Agent': 'OmniDeck-PC' };
    if (startOffset > 0) headers.Range = `bytes=${startOffset}-`;
    try {
      const res = await this.fetchFollowingTrusted(i.req.url, i.req.allowedHosts, headers, i.controller.signal);
      if (!res.ok && res.status !== 206) throw new OmniFailure({ code: 'HTTP_ERROR', whatHappened: `The server returned HTTP ${res.status} for ${i.req.name}.`, probableCause: res.status === 404 ? 'The release file no longer exists upstream.' : null });
      const resumed = res.status === 206 && startOffset > 0;
      const len = Number(res.headers.get('content-length') ?? 0) || null;
      i.item.totalBytes = len !== null ? len + (resumed ? startOffset : 0) : i.req.expectedSize;
      i.item.receivedBytes = resumed ? startOffset : 0;
      const out = createWriteStream(i.partPath, { flags: resumed ? 'a' : 'w' });
      let windowStart = Date.now();
      let windowBytes = 0;
      if (!res.body) throw new Error('empty response body');
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
        i.item.receivedBytes += value.byteLength;
        windowBytes += value.byteLength;
        const elapsed = Date.now() - windowStart;
        if (elapsed >= 500) {
          i.item.bytesPerSecond = Math.round((windowBytes * 1000) / elapsed);
          windowStart = Date.now();
          windowBytes = 0;
          this.publish(i, true);
        }
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
      i.item.status = 'verifying';
      i.item.bytesPerSecond = 0;
      this.publish(i);
      const outcome = await this.verify(i);
      i.item.status = 'completed';
      this.publish(i);
      log.info('download completed', { name: i.req.name, url: i.req.url, sha256: outcome.sha256, verified: outcome.verifiedAgainstUpstream });
      for (const w of i.waiters.splice(0)) w.resolve(outcome);
    } catch (err) {
      const status = i.item.status as DownloadItem['status'];
      if (status === 'paused') return;
      if (status === 'cancelled') {
        await this.finishCancelled(i);
        return;
      }
      i.item.status = 'failed';
      i.item.error = err instanceof OmniFailure ? err.detail.whatHappened : (err as Error).message;
      this.publish(i);
      log.error('download failed', { name: i.req.name, error: i.item.error });
      const failure = err instanceof OmniFailure ? err : OmniFailure.wrap(err, 'DOWNLOAD_FAILED', `Downloading ${i.req.name} failed.`, { userAction: ['Retry from the Downloads page once your connection is stable.'] });
      for (const w of i.waiters.splice(0)) w.reject(failure);
    } finally {
      i.controller = null;
    }
  }

  private async verify(i: Internal): Promise<DownloadOutcome> {
    const size = statSync(i.partPath).size;
    if (size === 0) throw new OmniFailure({ code: 'EMPTY_DOWNLOAD', whatHappened: `The download of ${i.req.name} was empty.` });
    if (i.req.expectedSize && size !== i.req.expectedSize) {
      await rm(i.partPath, { force: true });
      throw new OmniFailure({ code: 'SIZE_MISMATCH', whatHappened: `The downloaded file for ${i.req.name} has the wrong size and was discarded.`, detected: [`Expected ${i.req.expectedSize} bytes, got ${size}`], probableCause: 'The download was interrupted or modified in transit.', userAction: ['Retry the download.'] });
    }
    const sha = await sha256File(i.partPath);
    i.sha256 = sha;
    let verified = false;
    if (i.req.expectedSha256) {
      if (sha !== i.req.expectedSha256.toLowerCase()) {
        await rm(i.partPath, { force: true });
        i.item.verification = 'SHA-256 mismatch — file discarded';
        throw new OmniFailure({ code: 'HASH_MISMATCH', whatHappened: `The downloaded ${i.req.name} did not match the checksum published upstream and was discarded.`, detected: [`Expected ${i.req.expectedSha256}`, `Got ${sha}`], probableCause: 'Corrupted or tampered download.', userAction: ['Retry the download. If it keeps failing, report it to the OmniDeck project.'] });
      }
      verified = true;
      i.item.verification = 'SHA-256 matches upstream';
    } else {
      i.item.verification = `No upstream checksum published; recorded SHA-256 ${sha.slice(0, 16)}…`;
    }
    await rename(i.partPath, i.finalPath);
    return { path: i.finalPath, sha256: sha, verifiedAgainstUpstream: verified, sizeBytes: size };
  }

  async cleanup(path: string): Promise<void> {
    await rm(path, { force: true }).catch(() => undefined);
  }

  private last = new Map<string, number>();
  private publish(i: Internal, throttle = false): void {
    const now = Date.now();
    if (throttle && now - (this.last.get(i.item.id) ?? 0) < 250) return;
    this.last.set(i.item.id, now);
    this.bus.emit('download.update', { ...i.item });
  }
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}
