import type BetterSqlite3 from 'better-sqlite3';
import type { AppSettings } from '@shared/models';

export const DEFAULT_SETTINGS: AppSettings = {
  onboardingComplete: false,
  consoleModeOnStart: false,
  startWithWindows: false,
  reduceMotion: false,
  theme: 'dark',
  autoRepairSafeIssues: true,
  backgroundHealthChecks: true,
  metadataOnline: true,
  artworkProviders: ['local-files', 'emulator-databases', 'gametdb', 'ps2-covers', 'switch-titledb', 'xbox-marketplace', 'libretro-thumbnails'],
  theGamesDbApiKey: '',
  updateChannel: 'stable',
  checkUpdatesOnStart: true,
  autoUpdateEmulators: false,
  checkAppUpdatesOnStart: true,
  defaultPreset: 'balanced',
  launchTimeoutSeconds: 20,
  crashLoopThreshold: 3,
  aiEnabled: false,
  aiProvider: 'none',
  aiApiKey: '',
  aiModel: 'claude-opus-5-5',
  hotkeys: {
    modifier: 'Select',
    bindings: {
      exit: 'Start',
      saveState: 'RB',
      loadState: 'LB',
      volumeUp: 'DPadUp',
      volumeDown: 'DPadDown',
      menu: 'Y',
      fastForward: 'RT',
      screenshot: 'X',
      fullscreen: 'A',
    },
  },
  devMode: false,
};

export class SettingsRepo {
  constructor(private readonly db: BetterSqlite3.Database) {}

  getAll(): AppSettings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const out: Record<string, unknown> = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>;
    for (const r of rows) {
      if (!(r.key in DEFAULT_SETTINGS)) continue;
      try {
        out[r.key] = JSON.parse(r.value);
      } catch {
        /* keep default for a corrupt value; OmniDoctor reports it */
      }
    }
    return out as unknown as AppSettings;
  }

  get<K extends keyof AppSettings>(key: K): AppSettings[K] {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return structuredClone(DEFAULT_SETTINGS[key]);
    try {
      return JSON.parse(row.value) as AppSettings[K];
    } catch {
      return structuredClone(DEFAULT_SETTINGS[key]);
    }
  }

  set(patch: Partial<AppSettings>): AppSettings {
    const stmt = this.db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    this.db.transaction(() => {
      for (const [k, v] of Object.entries(patch)) {
        if (!(k in DEFAULT_SETTINGS) || v === undefined) continue;
        stmt.run(k, JSON.stringify(v));
      }
    })();
    return this.getAll();
  }

  reset(): void {
    this.db.prepare('DELETE FROM settings').run();
  }

  /** Arbitrary internal key/value (not user settings), e.g. last scan cursor. */
  getInternal<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(`internal:${key}`) as { value: string } | undefined;
    if (!row) return fallback;
    try { return JSON.parse(row.value) as T; } catch { return fallback; }
  }

  setInternal(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`internal:${key}`, JSON.stringify(value));
  }
}
