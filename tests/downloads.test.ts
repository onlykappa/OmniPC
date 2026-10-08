import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventBus } from '../src/main/core/events';
import { DownloadManager } from '../src/main/downloads/downloadManager';
import { DolphinUpdateSource, GitHubReleaseSource, hostAllowed, pickAsset } from '../src/main/downloads/sources';
import { tempDir } from './helpers';

const t = tempDir();
afterAll(t.cleanup);

const HOSTS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'api.github.com'];

function fakeFetch(routes: Record<string, (init?: RequestInit) => Response>): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const h = routes[url];
    if (!h) return new Response('not found', { status: 404 });
    return h(init);
  }) as typeof fetch;
}

describe('trusted sources', () => {
  it('only allows https on listed hosts', () => {
    expect(hostAllowed('https://github.com/x', HOSTS)).toBe(true);
    expect(hostAllowed('http://github.com/x', HOSTS)).toBe(false);
    expect(hostAllowed('https://github.com.evil.io/x', HOSTS)).toBe(false);
    expect(hostAllowed('https://dl.dolphin-emu.org/a.7z', ['*.dolphin-emu.org'])).toBe(true);
  });

  it('picks the CPU-appropriate PCSX2 asset and ignores symbols', () => {
    const assets = [
      { name: 'pcsx2-v2.8.2-windows-x64-Qt-symbols.7z', browser_download_url: 'https://github.com/a/s.7z', size: 1 },
      { name: 'pcsx2-v2.8.2-windows-x64-AVX2-Qt.7z', browser_download_url: 'https://github.com/a/avx2.7z', size: 1 },
      { name: 'pcsx2-v2.8.2-windows-x64-SSE4-Qt.7z', browser_download_url: 'https://github.com/a/sse4.7z', size: 1 },
    ];
    const patterns = ['-windows-x64-AVX2-Qt\\.7z$', '-windows-x64-Qt\\.7z$', '-windows-x64-SSE4-Qt\\.7z$'];
    expect(pickAsset(assets, patterns, ['symbols'], ['sse41', 'avx2'])!.name).toMatch(/AVX2/);
    expect(pickAsset(assets, patterns, ['symbols'], ['sse41'])!.name).toMatch(/SSE4/);
  });

  it('resolves the latest GitHub release with its published SHA-256 digest', async () => {
    const digest = 'a'.repeat(64);
    const src = new GitHubReleaseSource('PCSX2/pcsx2', ['-windows-x64-Qt\\.7z$'], ['symbols'], HOSTS);
    const rel = await src.resolveLatest({ channel: 'stable', cpuFeatures: [], fetchImpl: fakeFetch({ 'https://api.github.com/repos/PCSX2/pcsx2/releases/latest': () => Response.json({ tag_name: 'v2.8.2', prerelease: false, draft: false, assets: [{ name: 'pcsx2-v2.8.2-windows-x64-Qt.7z', browser_download_url: 'https://github.com/PCSX2/pcsx2/releases/download/v2.8.2/pcsx2-v2.8.2-windows-x64-Qt.7z', size: 10, digest: `sha256:${digest}` }] }) }) });
    expect(rel.version).toBe('2.8.2');
    expect(rel.sha256).toBe(digest);
  });

  it('reports offline errors in plain language', async () => {
    const src = new GitHubReleaseSource('PCSX2/pcsx2', ['x'], [], HOSTS);
    await expect(src.resolveLatest({ channel: 'stable', cpuFeatures: [], fetchImpl: (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch })).rejects.toThrow(/Could not check/);
  });

  it('reads Dolphin\'s official update endpoint', async () => {
    const src = new DolphinUpdateSource('beta', ['dolphin-emu.org', 'dl.dolphin-emu.org']);
    const rel = await src.resolveLatest({ channel: 'stable', cpuFeatures: [], fetchImpl: fakeFetch({ 'https://dolphin-emu.org/update/latest/beta/': () => Response.json({ shortrev: '2509', hash: 'abc', artifacts: [{ system: 'macOS', url: 'https://dl.dolphin-emu.org/x.dmg' }, { system: 'Windows x64', url: 'https://dl.dolphin-emu.org/releases/2509/dolphin-2509-x64.7z' }] }) }) });
    expect(rel.version).toBe('2509');
    expect(rel.fileName).toBe('dolphin-2509-x64.7z');
  });
});

describe('download manager', () => {
  const body = Buffer.from('emulator archive bytes'.repeat(1000));
  const sha = createHash('sha256').update(body).digest('hex');
  const base = { name: 'Test', version: '1', sourceLabel: 'test', fileName: 'a.7z', allowedHosts: HOSTS, expectedSize: body.length };

  it('downloads through trusted redirects and verifies the SHA-256', async () => {
    const dm = new DownloadManager(join(t.dir, 'dl'), new EventBus(), fakeFetch({
      'https://github.com/a.7z': () => new Response(null, { status: 302, headers: { location: 'https://objects.githubusercontent.com/a.7z' } }),
      'https://objects.githubusercontent.com/a.7z': () => new Response(body, { headers: { 'content-length': String(body.length) } }),
    }));
    const r = await dm.download({ ...base, url: 'https://github.com/a.7z', expectedSha256: sha });
    expect(r.verifiedAgainstUpstream).toBe(true);
    expect(readFileSync(r.path)).toEqual(body);
    expect(dm.list()[0].verification).toMatch(/matches upstream/);
  });

  it('discards a download whose hash does not match', async () => {
    const dm = new DownloadManager(join(t.dir, 'dl2'), new EventBus(), fakeFetch({ 'https://github.com/b.7z': () => new Response(body) }));
    await expect(dm.download({ ...base, url: 'https://github.com/b.7z', expectedSha256: 'f'.repeat(64) })).rejects.toThrow(/checksum/);
    expect(dm.list()[0].status).toBe('failed');
  });

  it('refuses redirects to untrusted hosts', async () => {
    const dm = new DownloadManager(join(t.dir, 'dl3'), new EventBus(), fakeFetch({ 'https://github.com/c.7z': () => new Response(null, { status: 302, headers: { location: 'https://evil.example/c.7z' } }) }));
    await expect(dm.download({ ...base, url: 'https://github.com/c.7z', expectedSha256: null })).rejects.toThrow(/unapproved host/);
  });

  it('refuses untrusted URLs outright', async () => {
    const dm = new DownloadManager(join(t.dir, 'dl4'), new EventBus(), fakeFetch({}));
    await expect(dm.download({ ...base, url: 'https://mirror.example/a.7z', expectedSha256: null })).rejects.toThrow(/not an approved source/);
  });

  it('records a computed hash when upstream publishes none, and resumes paused downloads with Range', async () => {
    let calls = 0;
    const dm = new DownloadManager(join(t.dir, 'dl5'), new EventBus(), (async (_u: string, init?: RequestInit) => {
      calls++;
      const range = (init?.headers as Record<string, string>)?.Range;
      if (range) {
        const from = Number(/bytes=(\d+)-/.exec(range)![1]);
        return new Response(body.subarray(from), { status: 206, headers: { 'content-length': String(body.length - from) } });
      }
      return new Response(body, { headers: { 'content-length': String(body.length) } });
    }) as typeof fetch);
    const r = await dm.download({ ...base, url: 'https://github.com/d.7z', expectedSha256: null });
    expect(r.verifiedAgainstUpstream).toBe(false);
    expect(r.sha256).toBe(sha);
    expect(dm.list()[0].verification).toMatch(/No upstream checksum/);
    expect(existsSync(r.path)).toBe(true);
    expect(calls).toBe(1);
  });
});
