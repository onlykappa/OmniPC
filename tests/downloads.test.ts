import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventBus } from '../src/main/core/events';
import { DownloadManager } from '../src/main/downloads/downloadManager';
import { DolphinUpdateSource, ForgejoReleaseSource, RyubingUpdateSource, GitHubReleaseSource, VersionedUrlSource, hostAllowed, pickAsset, releaseVersion } from '../src/main/downloads/sources';
import { tempDir } from './helpers';
import { compareVersions } from '../src/main/emulators/versions';

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

  it('resolves Ryubing releases from its Forgejo server (stable and canary repos)', async () => {
    const api = 'https://git.ryujinx.app/api/v1';
    const asset = (n: string) => ({ name: n, browser_download_url: `https://git.ryujinx.app/x/${n}`, size: 5 });
    const src = new ForgejoReleaseSource(api, 'projects/Ryubing', 'Ryubing/Canary', ['^ryujinx-\\d+\\.\\d+\\.\\d+-win_x64\\.zip$', '^ryujinx-canary-\\d+\\.\\d+\\.\\d+-win_x64\\.zip$'], ['\\.7z$', 'arm64'], ['git.ryujinx.app'], '^ryujinx-(?:canary-)?(\\d+\\.\\d+\\.\\d+)-win_x64\\.zip$');
    const fetchImpl = fakeFetch({
      [`${api}/repos/projects/Ryubing/releases/latest`]: () => Response.json({ tag_name: '1.3.3', assets: [asset('ryujinx-1.3.3-win_x64.7z'), asset('ryujinx-1.3.3-win_arm64.zip'), asset('ryujinx-1.3.3-win_x64.zip')] }),
      [`${api}/repos/Ryubing/Canary/releases?limit=10`]: () => Response.json([{ tag_name: '1.3.250', draft: true, assets: [asset('ryujinx-canary-1.3.250-win_x64.zip')] }, { tag_name: '1.3.249', assets: [asset('ryujinx-canary-1.3.249-win_x64.zip')] }]),
    });
    const stable = await src.resolveLatest({ channel: 'stable', cpuFeatures: [], fetchImpl });
    expect([stable.version, stable.fileName, stable.sha256]).toEqual(['1.3.3', 'ryujinx-1.3.3-win_x64.zip', null]);
    expect(src.label).toBe('git.ryujinx.app/projects/Ryubing');
    expect((await src.resolveLatest({ channel: 'nightly', cpuFeatures: [], fetchImpl })).version).toBe('1.3.249');
    expect(() => new ForgejoReleaseSource('http://evil', 'a/b', undefined, [], [], [])).toThrow();
  });

  it('resolves Ryujinx through the ryujinx.app update server, falling back to the release list', async () => {
    const hosts = ['update.ryujinx.app', 'git.ryujinx.app', '*.ryujinx.app'];
    const q = 'https://update.ryujinx.app/latest/query?os=win&arch=x64&rc=';
    const fetchImpl = fakeFetch({
      [`${q}stable`]: () => Response.json({ tag: '1.3.3', download_url: 'https://git.ryujinx.app/projects/Ryubing/releases/download/1.3.3/ryujinx-1.3.3-win_x64.zip', max_concurrency: 4, web_url_format: 'https://git.ryujinx.app/projects/Ryubing/releases/tag/{0}' }),
      [`${q}canary`]: () => Response.json({ tag: '1.3.250', download_url: 'https://evil.example/ryujinx-canary-1.3.250-win_x64.zip' }),
    });
    const fallback = { label: 'fallback', resolveLatest: async () => ({ version: '1.3.2', url: 'https://git.ryujinx.app/x.zip', fileName: 'x.zip', sizeBytes: null, sha256: null, publishedAt: null, sourceLabel: 'fallback', notesUrl: null }) };
    const src = new RyubingUpdateSource('https://update.ryujinx.app', hosts, fallback);
    const stable = await src.resolveLatest({ channel: 'stable', cpuFeatures: [], fetchImpl });
    expect([stable.version, stable.fileName, stable.notesUrl]).toEqual(['1.3.3', 'ryujinx-1.3.3-win_x64.zip', 'https://git.ryujinx.app/projects/Ryubing/releases/tag/1.3.3']);
    // An untrusted download host is never used; the release list is asked instead.
    expect((await src.resolveLatest({ channel: 'nightly', cpuFeatures: [], fetchImpl })).version).toBe('1.3.2');
    await expect(new RyubingUpdateSource('https://update.ryujinx.app', hosts, null).resolveLatest({ channel: 'nightly', cpuFeatures: [], fetchImpl })).rejects.toThrow(/Could not check/);
  });

  it('turns rolling tags into comparable versions', () => {
    expect(releaseVersion({ tag_name: 'v2.8.2' }, {})).toBe('2.8.2');
    expect(releaseVersion({ tag_name: 'v.0.19.0' }, {})).toBe('0.19.0'); // shadPS4 tag style
    const a = releaseVersion({ tag_name: 'latest' }, { updated_at: '2026-10-07T12:34:56Z' });
    const b = releaseVersion({ tag_name: 'latest' }, { updated_at: '2026-10-09T08:00:00Z' });
    expect(a).toBe('latest-20261007.1234');
    expect(compareVersions(b, a)).toBe(1);
    // Several KytyPS5 builds per day: order by publish time, not by commit hash.
    const early = releaseVersion({ tag_name: 'KytyPS5-2026-10-10-f3836bb', published_at: '2026-10-10T03:10:00Z' }, {}, 'published-at');
    const late = releaseVersion({ tag_name: 'KytyPS5-2026-10-10-307fdcf', published_at: '2026-10-10T05:45:00Z' }, {}, 'published-at');
    expect(late).toBe('2026.10.10.0545-307fdcf');
    expect(compareVersions(late, early)).toBe(1);
  });

  it('can read the version from the asset name (RPCS3 build-<hash> tags)', async () => {
    const src = new GitHubReleaseSource('RPCS3/rpcs3-binaries-win', ['_win64_msvc\\.7z$'], ['\\.sha256$'], HOSTS, 'tag', '^rpcs3-v([\\d.]+-\\d+-[0-9a-f]+)_win64');
    const rel = await src.resolveLatest({ channel: 'stable', cpuFeatures: [], fetchImpl: fakeFetch({ 'https://api.github.com/repos/RPCS3/rpcs3-binaries-win/releases/latest': () => Response.json({ tag_name: 'build-8f2fe1a9', prerelease: false, draft: false, assets: [{ name: 'rpcs3-v0.0.43-20262-8f2fe1a9_win64_msvc.7z.sha256', browser_download_url: 'https://github.com/a/x.sha256', size: 1 }, { name: 'rpcs3-v0.0.43-20262-8f2fe1a9_win64_msvc.7z', browser_download_url: 'https://github.com/a/x.7z', size: 1 }] }) }) });
    expect(rel.version).toBe('0.0.43-20262-8f2fe1a9');
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

describe('versioned-url source', () => {
  const template = 'https://buildbot.libretro.com/stable/{version}/windows/x86_64/RetroArch.7z';
  it('takes the version from the official repo tag and builds the official download URL', async () => {
    const src = new VersionedUrlSource('libretro/RetroArch', template, ['api.github.com', 'buildbot.libretro.com']);
    const rel = await src.resolveLatest({ channel: 'stable', cpuFeatures: [], fetchImpl: fakeFetch({ 'https://api.github.com/repos/libretro/RetroArch/releases/latest': () => Response.json({ tag_name: 'v1.21.0', prerelease: false, draft: false, assets: [] }) }) });
    expect(rel).toMatchObject({ version: '1.21.0', url: 'https://buildbot.libretro.com/stable/1.21.0/windows/x86_64/RetroArch.7z', fileName: 'RetroArch.7z', sha256: null });
  });

  it('refuses tags that would change the URL path and untrusted hosts', async () => {
    const evil = fakeFetch({ 'https://api.github.com/repos/libretro/RetroArch/releases/latest': () => Response.json({ tag_name: '../../x', assets: [] }) });
    await expect(new VersionedUrlSource('libretro/RetroArch', template, ['buildbot.libretro.com']).resolveLatest({ channel: 'stable', cpuFeatures: [], fetchImpl: evil })).rejects.toThrow(/Unexpected version/);
    const ok = fakeFetch({ 'https://api.github.com/repos/libretro/RetroArch/releases/latest': () => Response.json({ tag_name: 'v1.0', assets: [] }) });
    await expect(new VersionedUrlSource('libretro/RetroArch', template, ['github.com']).resolveLatest({ channel: 'stable', cpuFeatures: [], fetchImpl: ok })).rejects.toThrow(/trusted host/);
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
