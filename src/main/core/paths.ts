// OmniPC storage layout. Everything OmniPC manages lives under one root
// (default: %USERPROFILE%\OmniPC) so users can find, back up and move it.
// A tiny bootstrap file in Electron's userData directory remembers where the
// root is, which is what makes storage relocation possible.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { StorageKey } from '@shared/models';

export interface BootstrapConfig {
  dataRoot: string;
  /** Per-key overrides when a single location was relocated (e.g. Saves to another drive). */
  overrides: Partial<Record<StorageKey, string>>;
}

export class AppPaths {
  readonly bootstrapFile: string;
  private config: BootstrapConfig;

  constructor(readonly userDataDir: string, homeDir: string) {
    this.bootstrapFile = join(userDataDir, 'bootstrap.json');
    this.config = AppPaths.readBootstrap(this.bootstrapFile) ?? { dataRoot: AppPaths.defaultRoot(homeDir), overrides: {} };
  }

  /**
   * %USERPROFILE%\OmniPC. Installs from before the rename to OmniPC keep using
   * their existing %USERPROFILE%\OmniDeck folder so nothing is orphaned.
   */
  static defaultRoot(homeDir: string): string {
    const current = join(homeDir, 'OmniPC');
    const legacy = join(homeDir, 'OmniDeck');
    return !existsSync(current) && existsSync(legacy) ? legacy : current;
  }

  private static readBootstrap(file: string): BootstrapConfig | null {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<BootstrapConfig>;
      if (typeof raw.dataRoot !== 'string' || raw.dataRoot.length === 0) return null;
      return { dataRoot: raw.dataRoot, overrides: raw.overrides ?? {} };
    } catch {
      return null;
    }
  }

  get root(): string {
    return this.config.dataRoot;
  }

  get overrides(): Partial<Record<StorageKey, string>> {
    return { ...this.config.overrides };
  }

  private loc(key: StorageKey, sub: string): string {
    return this.config.overrides[key] ?? join(this.root, sub);
  }

  get emulators(): string { return this.loc('emulators', 'Emulators'); }
  get saves(): string { return this.loc('saves', 'Saves'); }
  get bios(): string { return this.loc('bios', 'BIOS'); }
  get cache(): string { return this.loc('cache', 'Cache'); }
  get backups(): string { return this.loc('backups', 'Backups'); }
  get artwork(): string { return this.loc('artwork', 'Artwork'); }
  get downloads(): string { return this.loc('downloads', 'Downloads'); }
  get logs(): string { return this.loc('logs', 'Logs'); }
  /** Database + application state. Not relocatable separately from the root. */
  get data(): string { return join(this.root, 'Data'); }
  get database(): string { return join(this.data, 'omnideck.db'); }
  get databaseBackups(): string { return join(this.backups, 'database'); }
  get configBackups(): string { return join(this.backups, 'configs'); }
  get saveBackups(): string { return join(this.backups, 'saves'); }
  get thumbnails(): string { return join(this.artwork, 'thumbs'); }
  get diagnosticsExports(): string { return join(this.root, 'Exports'); }

  get(key: StorageKey): string {
    switch (key) {
      case 'emulators': return this.emulators;
      case 'saves': return this.saves;
      case 'bios': return this.bios;
      case 'cache': return this.cache;
      case 'backups': return this.backups;
      case 'artwork': return this.artwork;
      case 'downloads': return this.downloads;
      case 'logs': return this.logs;
    }
  }

  /** Per-emulator directories. */
  emulatorDir(id: string): string { return join(this.emulators, id); }
  emulatorAppDir(id: string): string { return join(this.emulatorDir(id), 'app'); }
  emulatorDataDir(id: string): string { return join(this.emulatorDir(id), 'data'); }
  emulatorRollbackDir(id: string): string { return join(this.emulatorDir(id), 'rollback'); }
  emulatorSaveDir(id: string): string { return join(this.saves, id); }
  systemBiosDir(systemId: string): string { return join(this.bios, systemId); }
  emulatorCacheDir(id: string): string { return join(this.cache, id); }

  ensureBaseLayout(): void {
    for (const dir of [this.root, this.data, this.emulators, this.saves, this.bios, this.cache, this.backups, this.artwork, this.thumbnails, this.downloads, this.logs, this.databaseBackups, this.configBackups, this.saveBackups]) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /** Atomically persist a new root or override. */
  update(next: Partial<BootstrapConfig>): void {
    this.config = { dataRoot: next.dataRoot ?? this.config.dataRoot, overrides: { ...this.config.overrides, ...(next.overrides ?? {}) } };
    mkdirSync(this.userDataDir, { recursive: true });
    const tmp = this.bootstrapFile + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.config, null, 2));
    renameSync(tmp, this.bootstrapFile);
  }

  /** True when `p` is inside any OmniPC-managed location (used by safety checks). */
  isManagedPath(p: string): boolean {
    const target = resolve(p).toLowerCase();
    const roots = [this.root, ...Object.values(this.config.overrides)].map((r) => resolve(r).toLowerCase());
    return roots.some((r) => target === r || target.startsWith(r + (process.platform === 'win32' ? '\\' : '/')));
  }

  static exists(p: string): boolean {
    return existsSync(p);
  }
}
