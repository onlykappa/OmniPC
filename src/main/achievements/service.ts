// RetroAchievements: sign in once in OmniPC, and every supporting emulator is
// configured with the login token. Emulator configs are written through the
// adapters' applyConfig (install/update/repair/reset keep them) and directly
// by apply()/logout() here, always after a configuration backup.

import { dirname } from 'node:path';
import type { RaEmulatorState, RaStatus, RetroAchievementsSettings } from '@shared/achievements';
import type { AdapterRegistry } from '../emulators/registry';
import type { EmulatorAdapter } from '../emulators/adapter';
import type { SettingsRepo } from '../database/settingsRepo';
import type { OpsRepo } from '../database/opsRepo';
import type { ConfigBackupService } from '../config/backups';
import { OmniFailure, errorMessage } from '../core/errors';
import { logger } from '../core/logger';
import { inspectAchievementsConfig, raFilePaths, writeAchievementsConfig, type RaCredentials } from './emulatorConfig';
import { loginToRetroAchievements } from './raApi';
import type { TokenVault } from './tokenVault';

const log = logger.scope('achievements');

export interface RaServiceDeps {
  settings: SettingsRepo;
  registry: AdapterRegistry;
  isInstalled: (emulatorId: string) => boolean;
  backups: ConfigBackupService;
  ops: OpsRepo;
  vault: TokenVault;
  fetchImpl: typeof fetch;
  userAgent: string;
}

export interface RaApplyResult {
  status: RaStatus;
  /** Change descriptions per emulator (token hidden). */
  changed: string[];
  backupIds: number[];
  failed: { emulatorId: string; error: string }[];
}

type RaAdapter = EmulatorAdapter & { achievements(): ReturnType<NonNullable<EmulatorAdapter['achievements']>> };

export class RetroAchievementsService {
  constructor(private readonly d: RaServiceDeps) {}

  private get prefs(): RetroAchievementsSettings {
    return this.d.settings.get('retroAchievements');
  }

  private savePrefs(patch: Partial<RetroAchievementsSettings>): void {
    this.d.settings.set({ retroAchievements: { ...this.prefs, ...patch } });
  }

  /** Emulators with RetroAchievements support (adapters implementing achievements()). */
  supporting(): RaAdapter[] {
    return this.d.registry.implemented().filter((a): a is RaAdapter => typeof a.achievements === 'function');
  }

  /** The sign-in to write into emulator configs, or null when signed out / token unreadable. */
  credentials(): RaCredentials | null {
    const p = this.prefs;
    if (!p.username) return null;
    const s = this.d.vault.load();
    if (!s || s.username.toLowerCase() !== p.username.toLowerCase()) return null;
    return { enabled: p.enabled, username: p.username, token: s.token, hardcore: p.hardcore, loginAt: s.loginAt };
  }

  async status(): Promise<RaStatus> {
    const p = this.prefs;
    const info = this.d.vault.info();
    const creds = this.credentials();
    const emulators: RaEmulatorState[] = [];
    for (const a of this.supporting()) {
      const base = { emulatorId: a.manifest.id, name: a.manifest.name };
      if (!this.d.isInstalled(a.manifest.id)) {
        emulators.push({ ...base, status: 'not-installed', detail: creds ? 'Signed in automatically when you install it.' : 'Not installed.' });
        continue;
      }
      if (!p.username) {
        emulators.push({ ...base, status: 'not-configured', detail: 'Not signed in.' });
        continue;
      }
      try {
        const issues = await inspectAchievementsConfig(a.achievements(), { username: p.username, enabled: p.enabled, hardcore: p.hardcore });
        emulators.push(issues.length ? { ...base, status: 'not-configured', detail: issues.join('; ') } : { ...base, status: 'configured', detail: `Signed in as ${p.username}${p.enabled ? '' : ' (achievements off)'}${p.hardcore ? ', hardcore' : ''}.` });
      } catch (e) {
        emulators.push({ ...base, status: 'error', detail: errorMessage(e) });
      }
    }
    return {
      signedIn: !!creds,
      username: p.username,
      enabled: p.enabled,
      hardcore: p.hardcore,
      tokenProtected: !!info?.protected,
      needsSignIn: !!p.username && !creds,
      emulators,
    };
  }

  async login(username: string, password: string): Promise<RaStatus> {
    const res = await loginToRetroAchievements(username, password, { fetchImpl: this.d.fetchImpl, userAgent: this.d.userAgent });
    this.d.vault.save(res.username, res.token);
    this.savePrefs({ enabled: true, username: res.username });
    this.d.ops.addChange('achievements.signin', null, `Signed in to RetroAchievements as ${res.username}`);
    log.info('signed in to RetroAchievements', { username: res.username });
    return (await this.apply()).status;
  }

  /** Signs out of OmniPC and removes the login from every emulator config. */
  async logout(): Promise<RaStatus> {
    const user = this.prefs.username;
    const r = await this.write(null, 'Before RetroAchievements sign-out');
    this.d.vault.clear();
    this.savePrefs({ enabled: false, username: null });
    this.d.ops.addChange('achievements.signout', null, `Signed out of RetroAchievements${user ? ` (${user})` : ''}${r.changed.length ? `; removed from ${r.touched.join(', ')}` : ''}`);
    log.info('signed out of RetroAchievements', { emulators: r.touched, failed: r.failed.length });
    return this.status();
  }

  async setHardcore(on: boolean): Promise<RaStatus> {
    this.savePrefs({ hardcore: on });
    this.d.ops.addChange('achievements.hardcore', null, `RetroAchievements hardcore mode ${on ? 'on' : 'off'}`);
    if (this.credentials()) return (await this.apply()).status;
    return this.status();
  }

  /** Writes the sign-in into every installed supporting emulator (idempotent). */
  async apply(): Promise<RaApplyResult> {
    const creds = this.credentials();
    if (!creds) {
      throw new OmniFailure({
        code: 'RA_NOT_SIGNED_IN',
        whatHappened: this.prefs.username ? 'The saved RetroAchievements sign-in cannot be read on this PC.' : 'You are not signed in to RetroAchievements.',
        userAction: ['Sign in under Settings > RetroAchievements.'],
      });
    }
    const r = await this.write(creds, 'Before RetroAchievements sign-in');
    if (r.changed.length) this.d.ops.addChange('achievements.applied', null, `RetroAchievements sign-in applied to ${r.touched.join(', ')}`, { changed: r.changed });
    return { status: await this.status(), changed: r.changed, backupIds: r.backupIds, failed: r.failed };
  }

  private async write(creds: RaCredentials | null, label: string): Promise<{ changed: string[]; touched: string[]; backupIds: number[]; failed: { emulatorId: string; error: string }[] }> {
    const changed: string[] = [];
    const touched: string[] = [];
    const backupIds: number[] = [];
    const failed: { emulatorId: string; error: string }[] = [];
    for (const a of this.supporting()) {
      const id = a.manifest.id;
      if (!this.d.isInstalled(id)) continue;
      const files = a.achievements();
      try {
        const b = await this.d.backups.create(id, label, 'pre-achievements', raFilePaths(files).map((path) => ({ path, root: dirname(path) })));
        const c = await writeAchievementsConfig(files, creds);
        if (c.length) {
          backupIds.push(b.id);
          touched.push(a.manifest.name);
          changed.push(...c.map((x) => `${a.manifest.name}: ${x}`));
        } else {
          // Nothing changed: drop the snapshot so repeated applies don't pile up backups.
          await this.d.backups.delete(b.id);
        }
      } catch (e) {
        log.warn('could not write RetroAchievements settings', { emulatorId: id, error: errorMessage(e) });
        failed.push({ emulatorId: id, error: errorMessage(e) });
      }
    }
    return { changed, touched, backupIds, failed };
  }
}
