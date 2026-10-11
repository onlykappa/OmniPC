// OmniPC self-update. Uses electron-updater against the official GitHub
// Releases of the OmniPC repository: it reads latest.yml from the newest
// release, downloads the NSIS installer, verifies its SHA-512 from that file,
// and installs it on restart. User data lives outside the program folder, so
// library, settings, emulators and saves are untouched by an app update.

import type { AppUpdateState } from '@shared/models';

/** The subset of electron-updater's AppUpdater that OmniPC uses (injectable for tests). */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  on(event: 'download-progress', fn: (p: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
  checkForUpdates(): Promise<{ updateInfo: { version: string; releaseNotes?: unknown; releaseDate?: string }; isUpdateAvailable?: boolean } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface AppUpdateDeps {
  currentVersion: string;
  /** null when self-update is unavailable (development build, non-Windows, portable copy). */
  updater: UpdaterLike | null;
  unsupportedReason?: string;
  emit: (state: AppUpdateState) => void;
  notify: (title: string, body: string) => void;
  /** Installing restarts OmniPC, so it is refused while a game is running. */
  isBusy: () => boolean;
  /** Called right before quitAndInstall (e.g. to flush the database). */
  beforeInstall?: () => void;
}

function newer(a: string, b: string): boolean {
  const pa = a.replace(/^v/, '').split(/[.+-]/).map((x) => Number(x));
  const pb = b.replace(/^v/, '').split(/[.+-]/).map((x) => Number(x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) break;
    if (x !== y) return x > y;
  }
  return false;
}

/** Release notes arrive as HTML from GitHub; show them as plain text. */
function notesText(notes: unknown): string | null {
  const raw = typeof notes === 'string' ? notes : Array.isArray(notes) ? notes.map((n) => (n && typeof n === 'object' && 'note' in n ? String((n as { note: unknown }).note ?? '') : '')).join('\n') : '';
  const text = raw
    .replace(/<\/(p|li|h\d)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || null;
}

export class AppUpdateService {
  private s: AppUpdateState;

  constructor(private readonly d: AppUpdateDeps) {
    this.s = {
      status: d.updater ? 'idle' : 'unsupported',
      currentVersion: d.currentVersion,
      latestVersion: null,
      percent: null,
      notes: null,
      error: null,
      checkedAt: null,
      unsupportedReason: d.updater ? null : d.unsupportedReason ?? 'Automatic app updates are only available in the installed Windows version of OmniPC.',
    };
    const u = d.updater;
    if (u) {
      u.autoDownload = false;
      u.autoInstallOnAppQuit = false;
      u.allowPrerelease = false;
      u.allowDowngrade = false;
      u.on('download-progress', (p) => this.set({ status: 'downloading', percent: Math.round(p.percent) }));
      u.on('error', (err) => {
        // electron-updater reports errors both by rejection and by event; keep the first message.
        if (this.s.status === 'checking' || this.s.status === 'downloading') this.set({ status: 'error', error: friendly(err) });
      });
    }
  }

  state(): AppUpdateState {
    return { ...this.s };
  }

  private set(patch: Partial<AppUpdateState>): void {
    this.s = { ...this.s, ...patch };
    this.d.emit(this.state());
  }

  /** Looks for a newer OmniPC release. `quiet` (startup check) only notifies when one exists. */
  async check(opts: { quiet?: boolean } = {}): Promise<AppUpdateState> {
    const u = this.d.updater;
    if (!u) return this.state();
    if (this.s.status === 'checking' || this.s.status === 'downloading') return this.state();
    if (this.s.status === 'ready') return this.state();
    this.set({ status: 'checking', error: null });
    try {
      const r = await u.checkForUpdates();
      const latest = r?.updateInfo?.version ?? null;
      const checkedAt = new Date().toISOString();
      if (latest && newer(latest, this.d.currentVersion)) {
        this.set({ status: 'available', latestVersion: latest, notes: notesText(r?.updateInfo.releaseNotes), checkedAt, percent: null });
        this.d.notify(`OmniPC ${latest} is available`, 'Open Settings > Updates and click "Download and install". Your library, settings, emulators and saves are kept.');
      } else {
        this.set({ status: 'up-to-date', latestVersion: latest ?? this.d.currentVersion, checkedAt });
      }
    } catch (err) {
      this.set({ status: 'error', error: friendly(err), checkedAt: new Date().toISOString() });
      if (!opts.quiet) return this.state();
    }
    return this.state();
  }

  /** Downloads the installer for the available version (verified against latest.yml's SHA-512). */
  async download(): Promise<AppUpdateState> {
    const u = this.d.updater;
    if (!u) return this.state();
    if (this.s.status !== 'available' && this.s.status !== 'error') return this.state();
    if (!this.s.latestVersion || !newer(this.s.latestVersion, this.d.currentVersion)) return this.state();
    this.set({ status: 'downloading', percent: 0, error: null });
    try {
      await u.downloadUpdate();
      this.set({ status: 'ready', percent: 100 });
      this.d.notify(`OmniPC ${this.s.latestVersion} is ready`, 'Restart OmniPC to finish updating.');
    } catch (err) {
      this.set({ status: 'error', error: friendly(err), percent: null });
    }
    return this.state();
  }

  /** Restarts into the installer. Refused while a game is running. */
  install(): { ok: boolean; reason: string | null } {
    const u = this.d.updater;
    if (!u || this.s.status !== 'ready') return { ok: false, reason: 'No downloaded update is waiting to be installed.' };
    if (this.d.isBusy()) return { ok: false, reason: 'A game is running. Exit the game first; OmniPC restarts to install the update.' };
    this.d.beforeInstall?.();
    // Silent install (the user already chose to update), then relaunch OmniPC.
    u.quitAndInstall(true, true);
    return { ok: true, reason: null };
  }
}

function friendly(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::ERR_/i.test(msg)) return 'Could not reach GitHub. Check your internet connection and try again.';
  if (/404|latest\.yml/i.test(msg)) return 'The latest OmniPC release has no update information yet. Try again later, or download the installer from GitHub.';
  if (/sha512|checksum/i.test(msg)) return 'The downloaded update did not match its published checksum and was discarded. Try again.';
  return msg.split('\n')[0].slice(0, 300);
}
