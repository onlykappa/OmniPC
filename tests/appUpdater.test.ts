import { describe, expect, it } from 'vitest';
import { AppUpdateService, type UpdaterLike } from '../src/main/services/appUpdater';
import type { AppUpdateState } from '../src/shared/models';

function fakeUpdater(opts: { latest?: string; checkError?: Error; downloadError?: Error } = {}) {
  const handlers: Record<string, (x: never) => void> = {};
  const calls = { download: 0, install: [] as [boolean | undefined, boolean | undefined][] };
  const u: UpdaterLike = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: true,
    allowDowngrade: true,
    on: (event: string, fn: (x: never) => void) => { handlers[event] = fn; return u; },
    checkForUpdates: async () => {
      if (opts.checkError) throw opts.checkError;
      return { updateInfo: { version: opts.latest ?? '1.0.1', releaseNotes: '<p>Check &amp; update all</p>' } };
    },
    downloadUpdate: async () => {
      calls.download++;
      (handlers['download-progress'] as (p: { percent: number }) => void)?.({ percent: 42.4 } as never);
      if (opts.downloadError) throw opts.downloadError;
      return [];
    },
    quitAndInstall: (silent, run) => { calls.install.push([silent, run]); },
  } as UpdaterLike;
  return { u, calls };
}

function service(u: UpdaterLike | null, busy = false) {
  const states: AppUpdateState[] = [];
  const notes: string[] = [];
  let flushed = false;
  const s = new AppUpdateService({ currentVersion: '1.0.0', updater: u, emit: (st) => states.push(st), notify: (t) => notes.push(t), isBusy: () => busy, beforeInstall: () => { flushed = true; } });
  return { s, states, notes, flushed: () => flushed };
}

describe('OmniPC self-update', () => {
  it('never downloads or installs on its own', () => {
    const { u } = fakeUpdater();
    service(u);
    expect(u).toMatchObject({ autoDownload: false, autoInstallOnAppQuit: false, allowPrerelease: false, allowDowngrade: false });
  });

  it('check → download (with progress) → restart to install', async () => {
    const { u, calls } = fakeUpdater({ latest: '1.0.1' });
    const t = service(u);
    expect((await t.s.check()).status).toBe('available');
    expect(t.s.state()).toMatchObject({ latestVersion: '1.0.1', notes: 'Check & update all' });
    expect(t.notes).toEqual(['OmniPC 1.0.1 is available']);
    const after = await t.s.download();
    expect(after).toMatchObject({ status: 'ready', percent: 100 });
    expect(t.states.some((st) => st.status === 'downloading' && st.percent === 42)).toBe(true);
    expect(t.s.install()).toEqual({ ok: true, reason: null });
    expect(t.flushed()).toBe(true);
    expect(calls.install).toEqual([[true, true]]);
  });

  it('reports up to date and refuses to download an older or equal version', async () => {
    const { u, calls } = fakeUpdater({ latest: '1.0.0' });
    const t = service(u);
    expect((await t.s.check()).status).toBe('up-to-date');
    await t.s.download();
    expect(calls.download).toBe(0);
    expect(t.s.install().ok).toBe(false);
  });

  it('does not restart while a game is running', async () => {
    const { u, calls } = fakeUpdater({ latest: '2.0.0' });
    const t = service(u, true);
    await t.s.check();
    await t.s.download();
    expect(t.s.install()).toMatchObject({ ok: false, reason: expect.stringMatching(/game is running/) });
    expect(calls.install).toEqual([]);
  });

  it('explains network and checksum failures in plain language', async () => {
    const offline = service(fakeUpdater({ checkError: new Error('net::ERR_INTERNET_DISCONNECTED') }).u);
    expect((await offline.s.check()).error).toMatch(/internet connection/);
    const bad = service(fakeUpdater({ latest: '1.1.0', downloadError: new Error('sha512 checksum mismatch') }).u);
    await bad.s.check();
    expect(await bad.s.download()).toMatchObject({ status: 'error', error: expect.stringMatching(/checksum/) });
  });

  it('is clearly unavailable in development / non-installed builds', async () => {
    const t = service(null);
    expect(t.s.state()).toMatchObject({ status: 'unsupported' });
    expect((await t.s.check()).status).toBe('unsupported');
    expect(t.s.install().ok).toBe(false);
  });
});
