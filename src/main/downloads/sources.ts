// Trusted upstream sources. Each emulator manifest names its source kind and the
// hosts it may download from. Resolution only ever talks to the official
// project endpoints (GitHub Releases API of the official repo, the official
// project update endpoint). Nothing returned is executed as a command; we only
// read version strings, download URLs and published hashes.

import type { EmulatorManifest } from '@shared/models';
import { OmniFailure } from '../core/errors';

export interface ReleaseInfo {
  version: string;
  url: string;
  fileName: string;
  sizeBytes: number | null;
  /** Upstream-published SHA-256 when the source provides one. */
  sha256: string | null;
  publishedAt: string | null;
  sourceLabel: string;
  notesUrl: string | null;
}

export interface SourceContext {
  channel: 'stable' | 'nightly';
  cpuFeatures: string[];
  fetchImpl?: typeof fetch;
}

export interface TrustedSource {
  readonly label: string;
  resolveLatest(ctx: SourceContext): Promise<ReleaseInfo>;
}

export function hostAllowed(url: string, allowedHosts: string[]): boolean {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowedHosts.some((h) => host === h || (h.startsWith('*.') && host.endsWith(h.slice(1))));
}

interface GhAsset { name: string; browser_download_url: string; size: number; digest?: string | null }
interface GhRelease { tag_name: string; name?: string; prerelease: boolean; draft: boolean; published_at?: string; html_url?: string; assets: GhAsset[] }

function compilePatterns(patterns: string[] | undefined): RegExp[] {
  return (patterns ?? []).map((p) => new RegExp(p, 'i'));
}

/**
 * Picks the best asset. Patterns are tried in order (e.g. AVX2 build first,
 * then generic), and CPU-feature-specific builds are skipped when the CPU lacks
 * the feature.
 */
export function pickAsset(assets: GhAsset[], patterns: string[], exclude: string[], cpuFeatures: string[]): GhAsset | null {
  const ex = compilePatterns(exclude);
  const usable = assets.filter((a) => !ex.some((r) => r.test(a.name)));
  for (const p of compilePatterns(patterns)) {
    const hit = usable.find((a) => p.test(a.name) && cpuOk(a.name, cpuFeatures));
    if (hit) return hit;
  }
  return null;
}

function cpuOk(name: string, features: string[]): boolean {
  if (/avx2/i.test(name)) return features.length === 0 || features.includes('avx2');
  if (/sse4/i.test(name)) return features.length === 0 || features.includes('sse41');
  return true;
}

export class GitHubReleaseSource implements TrustedSource {
  readonly label: string;
  constructor(private readonly repo: string, private readonly patterns: string[], private readonly exclude: string[], private readonly allowedHosts: string[]) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`invalid GitHub repo ${repo}`);
    this.label = `GitHub Releases (github.com/${repo})`;
  }

  async resolveLatest(ctx: SourceContext): Promise<ReleaseInfo> {
    const f = ctx.fetchImpl ?? fetch;
    const base = `https://api.github.com/repos/${this.repo}/releases`;
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'OmniDeck-PC', 'X-GitHub-Api-Version': '2022-11-28' };
    let releases: GhRelease[];
    try {
      if (ctx.channel === 'stable') {
        const r = await f(`${base}/latest`, { headers });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        releases = [(await r.json()) as GhRelease];
      } else {
        const r = await f(`${base}?per_page=10`, { headers });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        releases = ((await r.json()) as GhRelease[]).filter((x) => !x.draft);
      }
    } catch (err) {
      throw new OmniFailure({
        code: 'SOURCE_UNREACHABLE',
        whatHappened: `Could not check ${this.label} for the latest release.`,
        detected: [(err as Error).message],
        probableCause: 'You may be offline, GitHub may be unreachable, or the unauthenticated GitHub API rate limit (60 requests/hour) was reached.',
        userAction: ['Check your internet connection and try again in a few minutes.'],
        technical: String(err),
      });
    }
    for (const rel of releases) {
      const asset = pickAsset(rel.assets, this.patterns, this.exclude, ctx.cpuFeatures);
      if (!asset) continue;
      if (!hostAllowed(asset.browser_download_url, this.allowedHosts)) continue;
      const digest = asset.digest && /^sha256:[0-9a-f]{64}$/i.test(asset.digest) ? asset.digest.slice(7).toLowerCase() : null;
      return {
        version: rel.tag_name.replace(/^v/, ''),
        url: asset.browser_download_url,
        fileName: asset.name,
        sizeBytes: asset.size ?? null,
        sha256: digest,
        publishedAt: rel.published_at ?? null,
        sourceLabel: this.label,
        notesUrl: rel.html_url ?? null,
      };
    }
    throw new OmniFailure({
      code: 'NO_MATCHING_ASSET',
      whatHappened: `The latest release on ${this.label} has no Windows x64 download OmniDeck recognises.`,
      probableCause: 'The project may have changed its release file naming. The adapter manifest needs an update.',
      userAction: ['Check for an OmniDeck update.', 'Advanced: point OmniDeck at an existing installation with "Use existing installation".'],
    });
  }
}

interface DolphinLatest { shortrev?: string; hash?: string; artifacts?: { system?: string; url?: string }[]; changelog?: unknown }

/** Dolphin's official update endpoint: https://dolphin-emu.org/update/latest/<track>/ */
export class DolphinUpdateSource implements TrustedSource {
  readonly label = 'dolphin-emu.org official update service';
  constructor(private readonly track: string, private readonly allowedHosts: string[]) {}

  async resolveLatest(ctx: SourceContext): Promise<ReleaseInfo> {
    const f = ctx.fetchImpl ?? fetch;
    const track = ctx.channel === 'nightly' ? 'master' : this.track;
    let data: DolphinLatest;
    try {
      const r = await f(`https://dolphin-emu.org/update/latest/${encodeURIComponent(track)}/`, { headers: { 'User-Agent': 'OmniDeck-PC', Accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      data = (await r.json()) as DolphinLatest;
    } catch (err) {
      throw new OmniFailure({
        code: 'SOURCE_UNREACHABLE',
        whatHappened: 'Could not contact the Dolphin update service.',
        detected: [(err as Error).message],
        probableCause: 'You may be offline or dolphin-emu.org is unreachable.',
        userAction: ['Check your internet connection and try again.'],
        technical: String(err),
      });
    }
    const art = (data.artifacts ?? []).find((a) => (a.system ?? '').toLowerCase() === 'windows x64' && a.url);
    if (!art?.url || !hostAllowed(art.url, this.allowedHosts)) {
      throw new OmniFailure({
        code: 'NO_MATCHING_ASSET',
        whatHappened: 'The Dolphin update service did not offer a Windows x64 build from a trusted host.',
        detected: art?.url ? [`Offered URL: ${art.url}`] : [],
        userAction: ['Try again later or check for an OmniDeck update.'],
      });
    }
    const fileName = decodeURIComponent(new URL(art.url).pathname.split('/').pop() ?? 'dolphin.7z');
    const version = data.shortrev ?? /dolphin-([\w.-]+?)-x64/i.exec(fileName)?.[1] ?? 'unknown';
    return { version, url: art.url, fileName, sizeBytes: null, sha256: null, publishedAt: null, sourceLabel: this.label, notesUrl: 'https://dolphin-emu.org/download/' };
  }
}

export function sourceForManifest(m: EmulatorManifest): TrustedSource | null {
  const d = m.download;
  if (d.kind === 'github-release' && d.repo) return new GitHubReleaseSource(d.repo, d.assetPatterns ?? [], d.assetExclude ?? [], d.allowedHosts);
  if (d.kind === 'dolphin-update') return new DolphinUpdateSource(d.track ?? 'beta', d.allowedHosts);
  return null;
}
