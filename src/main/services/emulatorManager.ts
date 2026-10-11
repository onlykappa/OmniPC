// Emulator lifecycle: install, update (with backup + health test + rollback),
// repair, reset, uninstall and status. Emulator-specific behaviour comes from
// adapters; this service holds the shared logic so no adapter duplicates it.

import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CustomEmulatorSettings, EmulatorDetailsDto, EmulatorSettings, EmulatorStatus, HardwareProfile, HealthState, HotkeyConfig, UniversalControllerProfile } from '@shared/models';
import type { AdapterRegistry } from '../emulators/registry';
import type { ComponentInstaller, EmulatorAdapter, SmokeTestResult } from '../emulators/adapter';
import { expandManifestPath } from '../emulators/adapter';
import type { EmulatorRepo } from '../database/emulatorRepo';
import type { OpsRepo } from '../database/opsRepo';
import type { SettingsRepo } from '../database/settingsRepo';
import type { DownloadManager } from '../downloads/downloadManager';
import { sourceForManifest, type ReleaseInfo } from '../downloads/sources';
import { extractArchive, findContentRoot } from '../downloads/archive';
import type { JobContext, JobManager } from '../core/jobs';
import type { ConfigBackupService } from '../config/backups';
import type { AppPaths } from '../core/paths';
import type { EventBus } from '../core/events';
import type { NotificationService } from './notifications';
import { OmniFailure, errorMessage } from '../core/errors';
import { logger } from '../core/logger';
import { freeSpace } from '../platform/drives';
import { isNewer } from '../emulators/versions';
import type { RaCredentials } from '../achievements/emulatorConfig';

const log = logger.scope('emulators');

export interface UpdateRunSummary {
  checked: number;
  updated: string[];
  rolledBack: string[];
  failed: string[];
  skipped: string[];
}

export interface EmulatorManagerDeps {
  registry: AdapterRegistry;
  emuRepo: EmulatorRepo;
  ops: OpsRepo;
  settings: SettingsRepo;
  downloads: DownloadManager;
  jobs: JobManager;
  backups: ConfigBackupService;
  paths: AppPaths;
  bus: EventBus;
  notifications: NotificationService;
  hardware: () => HardwareProfile | null;
  controllerProfile: () => UniversalControllerProfile;
  /** RetroAchievements sign-in written into supporting emulators' configs (null = leave them alone). */
  achievements?: () => RaCredentials | null;
  fetchImpl?: typeof fetch;
}

async function moveDir(from: string, to: string): Promise<void> {
  await mkdir(join(to, '..'), { recursive: true });
  try {
    await rename(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    await cp(from, to, { recursive: true });
    await rm(from, { recursive: true, force: true });
  }
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else total += (await stat(p).catch(() => ({ size: 0 }))).size;
    }
  };
  await walk(dir);
  return total;
}

/** Runs before an emulator build is replaced (e.g. to back up its saves). Must not throw; returns a short note. */
export type BeforeEmulatorChangeHook = (emulatorId: string, what: 'update' | 'rollback' | 'reinstall') => Promise<string>;

export class EmulatorManager {
  private beforeChange: BeforeEmulatorChangeHook | null = null;

  constructor(private readonly d: EmulatorManagerDeps) {}

  setBeforeChangeHook(hook: BeforeEmulatorChangeHook | null): void {
    this.beforeChange = hook;
  }

  /** Runs the before-change hook as its own job step; problems are logged, never fatal. */
  private async runBeforeChange(id: string, what: 'update' | 'rollback' | 'reinstall', ctx: JobContext): Promise<void> {
    if (!this.beforeChange) return;
    ctx.step('Backing up saves');
    try {
      ctx.stepDone(await this.beforeChange(id, what));
    } catch (err) {
      log.warn('before-change hook failed', { id, what, error: errorMessage(err) });
      ctx.stepDone(`Skipped: ${errorMessage(err)}`);
    }
  }

  // ------------------------------------------------------------------ status

  executableFor(id: string): string | null {
    const row = this.d.emuRepo.get(id);
    if (row.custom_executable) return row.custom_executable;
    return row.executable;
  }

  isInstalled(id: string): boolean {
    const row = this.d.emuRepo.get(id);
    return row.install_state !== 'not_installed' && !!this.executableFor(id);
  }

  settingsFor(id: string): EmulatorSettings {
    const stored = this.d.emuRepo.getSettings(id);
    if (stored) return stored;
    const a = this.d.registry.require(id);
    return a.defaultSettings(this.d.hardware(), this.d.settings.get('defaultPreset'));
  }

  hotkeys(): HotkeyConfig {
    return this.d.settings.get('hotkeys');
  }

  status(id: string): EmulatorStatus {
    const a = this.d.registry.require(id);
    const row = this.d.emuRepo.get(id);
    const exe = this.executableFor(id);
    const installed = row.install_state !== 'not_installed';
    let health: HealthState = installed ? row.health : 'not_installed';
    let healthNote = row.health_note;
    if (installed && exe && !existsSync(exe)) {
      health = 'error';
      healthNote = 'Executable is missing';
    }
    const rollback = this.d.emuRepo.rollbackCandidate(id);
    return {
      id,
      name: a.manifest.name,
      systems: a.manifest.systems,
      implemented: a.manifest.implemented,
      plannedNote: a.manifest.plannedNote ?? null,
      installState: row.install_state,
      version: row.version,
      latestVersion: row.latest_version,
      updateAvailable: installed && row.install_state === 'installed' && isNewer(row.latest_version, row.version),
      installDir: row.install_dir,
      executable: exe,
      health,
      healthNote,
      customConfig: !!row.custom_config_active || !!row.custom_executable || !!row.custom_args,
      lastHealthCheckAt: row.last_health_at,
      website: a.manifest.website,
      license: a.manifest.license,
      rollbackVersion: rollback && rollback.path && existsSync(rollback.path) ? rollback.version : null,
    };
  }

  list(): EmulatorStatus[] {
    return this.d.registry.all().map((a) => this.status(a.manifest.id)).sort((x, y) => Number(y.implemented) - Number(x.implemented) || x.name.localeCompare(y.name));
  }

  async details(id: string): Promise<EmulatorDetailsDto> {
    const a = this.d.registry.require(id);
    const p = a.paths();
    const bios = this.d.paths.bios;
    const mk = (items: { label: string; path: string }[]) => items.map((i) => ({ label: i.label, path: expandManifestPath(i.path, p, bios), exists: existsSync(expandManifestPath(i.path, p, bios)) }));
    return {
      ...this.status(id),
      manifest: a.manifest,
      configFiles: mk(a.manifest.configFiles),
      logFiles: mk(a.manifest.logFiles),
      saveDirs: mk(a.manifest.saveDirs),
      backups: this.d.ops.backups(id),
      settings: this.settingsFor(id),
      customSettings: this.d.emuRepo.getCustom(id),
      versionHistory: this.d.emuRepo.versions(id).map((v) => ({ version: v.version, installedAt: v.installed_at, source: v.source_url ?? 'unknown', status: v.status })),
    };
  }

  // ------------------------------------------------------------- operations

  private requireImplemented(id: string): EmulatorAdapter {
    const a = this.d.registry.require(id);
    if (!a.manifest.implemented) {
      throw new OmniFailure({ code: 'ADAPTER_NOT_IMPLEMENTED', whatHappened: `${a.manifest.name} support is planned but not implemented in this build.`, userAction: ['Watch for an OmniPC update.'] });
    }
    return a;
  }

  async resolveLatest(id: string): Promise<ReleaseInfo> {
    const a = this.requireImplemented(id);
    const source = sourceForManifest(a.manifest);
    if (!source) throw new OmniFailure({ code: 'NO_SOURCE', whatHappened: `${a.manifest.name} has no download source configured.` });
    const hw = this.d.hardware();
    return source.resolveLatest({ channel: this.d.settings.get('updateChannel'), cpuFeatures: hw?.cpu.features ?? [], fetchImpl: this.d.fetchImpl });
  }

  async checkUpdates(): Promise<EmulatorStatus[]> {
    for (const a of this.d.registry.implemented()) {
      const row = this.d.emuRepo.get(a.manifest.id);
      if (row.install_state !== 'installed') continue;
      try {
        const rel = await this.resolveLatest(a.manifest.id);
        this.d.emuRepo.setLatest(a.manifest.id, rel.version);
      } catch (err) {
        log.warn('update check failed', { id: a.manifest.id, error: errorMessage(err) });
      }
    }
    this.d.bus.emit('emulators.changed', { id: null });
    return this.list();
  }

  install(id: string): { jobId: string; done: Promise<unknown> } {
    const a = this.requireImplemented(id);
    const j = this.d.jobs.start('emulator.install', `Install ${a.manifest.name}`, (ctx) => this.performInstall(a, ctx, 'install'), { lockKey: `emu:${id}` });
    return { jobId: j.id, done: j.done };
  }

  update(id: string): { jobId: string; done: Promise<unknown> } {
    const a = this.requireImplemented(id);
    const j = this.d.jobs.start('emulator.update', `Update ${a.manifest.name}`, (ctx) => this.performInstall(a, ctx, 'update'), { lockKey: `emu:${id}` });
    return { jobId: j.id, done: j.done };
  }

  installMany(ids: string[], label: string): { jobId: string; done: Promise<unknown> } {
    const adapters = ids.map((id) => this.d.registry.require(id));
    const j = this.d.jobs.start('emulator.installMany', label, async (ctx) => {
      const results: string[] = [];
      for (const a of adapters) {
        ctx.throwIfCancelled();
        if (!a.manifest.implemented) {
          ctx.stepSkipped(a.manifest.name, 'Adapter not implemented yet');
          continue;
        }
        const reason = this.isInstalled(a.manifest.id) ? 'update' : 'install';
        try {
          await this.performInstall(a, ctx, reason);
          results.push(`${a.manifest.name}: ok`);
        } catch (err) {
          ctx.stepFailed(errorMessage(err));
          results.push(`${a.manifest.name}: ${errorMessage(err)}`);
        }
      }
      if (results.some((r) => !r.endsWith(': ok'))) throw new OmniFailure({ code: 'PARTIAL_INSTALL', whatHappened: 'Some emulators could not be installed.', detected: results });
      return results;
    }, { lockKey: 'emu:batch' });
    return { jobId: j.id, done: j.done };
  }

  /**
   * One-click "check and update everything": checks every OmniPC-managed
   * emulator, installs newer releases one by one (config backup, previous build
   * kept, health test) and automatically rolls back any update that fails its
   * health test. `isBusy` stops before each update while a game is running.
   */
  checkAndUpdateAll(opts: { automatic: boolean; isBusy?: () => boolean }): { jobId: string; done: Promise<UpdateRunSummary> } {
    const j = this.d.jobs.start('emulator.autoUpdate', opts.automatic ? 'Automatic emulator updates' : 'Check for and install emulator updates', async (ctx): Promise<UpdateRunSummary> => {
      const summary: UpdateRunSummary = { checked: 0, updated: [], rolledBack: [], failed: [], skipped: [] };
      const managed = this.d.registry.implemented().filter((a) => this.d.emuRepo.get(a.manifest.id).install_state === 'installed');
      ctx.step(`Checking ${managed.length} emulator(s) for updates`);
      const pending: { a: EmulatorAdapter; from: string | null; to: string }[] = [];
      for (const a of managed) {
        ctx.throwIfCancelled();
        const row = this.d.emuRepo.get(a.manifest.id);
        try {
          const rel = await this.resolveLatest(a.manifest.id);
          this.d.emuRepo.setLatest(a.manifest.id, rel.version);
          summary.checked++;
          if (isNewer(rel.version, row.version)) pending.push({ a, from: row.version, to: rel.version });
        } catch (err) {
          summary.failed.push(`${a.manifest.name}: could not check (${errorMessage(err)})`);
        }
      }
      this.d.bus.emit('emulators.changed', { id: null });
      ctx.stepDone(pending.length ? `${pending.length} update(s): ${pending.map((p) => `${p.a.manifest.name} ${p.from ?? '?'} → ${p.to}`).join(', ')}` : 'Everything is up to date');
      for (const { a, to } of pending) {
        ctx.throwIfCancelled();
        if (opts.isBusy?.()) {
          summary.skipped.push(`${a.manifest.name} ${to} (a game is running)`);
          ctx.stepSkipped(`Update ${a.manifest.name}`, 'A game is running; this update will be installed later');
          continue;
        }
        try {
          const r = await this.performInstall(a, ctx, 'update', { autoRollback: true });
          if (r.rolledBack) summary.rolledBack.push(`${a.manifest.name} ${to} (kept ${r.rolledBack})`);
          else summary.updated.push(`${a.manifest.name} ${to}`);
        } catch (err) {
          ctx.stepFailed(errorMessage(err));
          summary.failed.push(`${a.manifest.name}: ${errorMessage(err)}`);
        }
      }
      const changed = summary.updated.length + summary.rolledBack.length + summary.failed.length;
      if (!opts.automatic || changed) {
        const parts = [
          summary.updated.length ? `Updated: ${summary.updated.join(', ')}.` : '',
          summary.rolledBack.length ? `Rolled back after a failed health test: ${summary.rolledBack.join(', ')}.` : '',
          summary.skipped.length ? `Postponed: ${summary.skipped.join(', ')}.` : '',
          summary.failed.length ? `Problems: ${summary.failed.join('; ')}.` : '',
        ].filter(Boolean);
        this.d.notifications.add(summary.failed.length || summary.rolledBack.length ? 'warning' : 'success', pending.length ? 'Emulator updates finished' : 'Emulators are up to date', parts.join(' ') || (summary.checked ? `All ${summary.checked} installed emulator(s) are on the latest version.` : 'No OmniPC-managed emulators are installed yet.'), { link: '/emulators' });
      }
      return summary;
    }, { lockKey: 'emu:batch' });
    return { jobId: j.id, done: j.done as Promise<UpdateRunSummary> };
  }

  updateAll(): { jobId: string; done: Promise<unknown> } {
    const ids = this.list().filter((s) => s.updateAvailable).map((s) => s.id);
    return this.installMany(ids, ids.length ? `Update ${ids.length} emulator(s)` : 'Update emulators');
  }

  /**
   * Install or update. Steps match the "one-click install" contract:
   * resolve → space check → download+verify → extract → swap (keeping the
   * previous build for rollback) → folders → backup+config → controller → test.
   */
  private async performInstall(a: EmulatorAdapter, ctx: JobContext, reason: 'install' | 'update' | 'reinstall', opts: { autoRollback?: boolean } = {}): Promise<SmokeTestResult & { rolledBack?: string }> {
    const id = a.manifest.id;
    const p = a.paths();
    const row = this.d.emuRepo.get(id);
    if (row.install_state === 'external' && reason !== 'install') {
      throw new OmniFailure({ code: 'EXTERNAL_INSTALL', whatHappened: `${a.manifest.name} uses an existing installation that OmniPC does not manage, so it cannot be updated here.`, userAction: ['Update it with its own updater, or switch to an OmniPC-managed installation by installing it from the Emulators page.'] });
    }
    ctx.step(`Finding the latest ${a.manifest.name} release`);
    const rel = await this.resolveLatest(id);
    ctx.stepDone(`${rel.version} from ${rel.sourceLabel}`);
    if (reason === 'update' && row.version && !isNewer(rel.version, row.version)) {
      ctx.stepSkipped('Download', `Already on the latest version (${row.version})`);
      this.d.emuRepo.setLatest(id, rel.version);
      return this.healthTest(id, ctx);
    }

    ctx.step('Checking free disk space');
    await mkdir(this.d.paths.emulators, { recursive: true });
    const free = await freeSpace(this.d.paths.emulators);
    const need = (rel.sizeBytes ?? 150 * 1024 * 1024) * 4;
    if (free !== null && free < need) {
      throw new OmniFailure({ code: 'DISK_FULL', whatHappened: `Not enough free space to install ${a.manifest.name}.`, detected: [`Free: ${Math.round(free / 1048576)} MB`, `Needed: about ${Math.round(need / 1048576)} MB`], userAction: ['Free up space, or move the Emulators folder to another drive in Settings > Storage.'] });
    }
    ctx.stepDone();

    ctx.step(`Downloading ${a.manifest.name} ${rel.version}`);
    const dl = await this.d.downloads.download({ name: `${a.manifest.name} ${rel.version}`, url: rel.url, version: rel.version, sourceLabel: rel.sourceLabel, fileName: rel.fileName, allowedHosts: a.manifest.download.allowedHosts, expectedSha256: rel.sha256, expectedSize: rel.sizeBytes }, ctx.signal);
    ctx.stepDone(dl.verifiedAgainstUpstream ? 'SHA-256 verified against upstream' : `No upstream checksum available; SHA-256 ${dl.sha256.slice(0, 12)}… recorded`);
    ctx.throwIfCancelled();

    ctx.step('Extracting');
    const staging = join(this.d.paths.emulatorDir(id), `staging-${Date.now()}`);
    try {
      await extractArchive(dl.path, staging);
      const root = await findContentRoot(staging, a.manifest.executable);
      if (!root) {
        throw new OmniFailure({ code: 'BAD_ARCHIVE_LAYOUT', whatHappened: `The downloaded archive does not contain ${a.manifest.executable}.`, probableCause: 'The upstream package layout changed or the download is not a Windows build.', userAction: ['Check for an OmniPC update.'] });
      }
      ctx.stepDone();

      if (reason !== 'install' && this.isInstalled(id)) await this.runBeforeChange(id, reason, ctx);

      ctx.step('Backing up current configuration');
      const targets = a.configTargets().filter((t) => existsSync(t.path));
      if (targets.length) await this.d.backups.create(id, reason === 'update' ? `Before update to ${rel.version}` : `Before ${reason}`, `pre-${reason}`, a.configTargets());
      ctx.stepDone(targets.length ? `${targets.length} file(s)` : 'Nothing to back up yet');

      ctx.step('Installing files');
      const previousVersion = row.version;
      const active = this.d.emuRepo.activeVersion(id);
      // User data that portable-only emulators keep next to the executable:
      // from the outgoing build, or from what an uninstall preserved.
      let carryFrom: string | null = this.preservedDir(id);
      if (existsSync(p.app) && (await readdir(p.app)).length) {
        const rollbackDir = join(this.d.paths.emulatorRollbackDir(id), (previousVersion ?? 'previous').replace(/[^\w.\-]/g, '_'));
        await rm(rollbackDir, { recursive: true, force: true });
        await moveDir(p.app, rollbackDir);
        carryFrom = rollbackDir;
        if (active) this.d.emuRepo.setVersionStatus(active.id, 'rollback', rollbackDir);
        else if (previousVersion) this.d.emuRepo.addVersion({ emulator_id: id, version: previousVersion, installed_at: row.installed_at ?? new Date().toISOString(), source_url: null, sha256: null, status: 'rollback', path: rollbackDir });
        await this.pruneRollbacks(id, 2);
      }
      await moveDir(root, p.app);
      await this.carryPersistent(a, carryFrom, p.app);
      const exe = await a.findExecutable(p.app);
      if (!exe) throw new OmniFailure({ code: 'EXE_NOT_FOUND', whatHappened: `${a.manifest.executable} was not found after installation.` });
      if (a.prepareInstall) for (const n of await a.prepareInstall(p.app)) ctx.message(n);
      this.d.emuRepo.addVersion({ emulator_id: id, version: rel.version, installed_at: new Date().toISOString(), source_url: rel.url, sha256: dl.sha256, status: 'active', path: p.app });
      this.d.emuRepo.setInstalled(id, { state: 'installed', version: rel.version, installDir: p.app, executable: exe });
      this.d.emuRepo.setLatest(id, rel.version);
      this.d.ops.addChange(reason === 'update' ? 'emulator.updated' : 'emulator.installed', id, reason === 'update' ? `${a.manifest.name} updated ${previousVersion ?? '?'} → ${rel.version}` : `${a.manifest.name} ${rel.version} installed`, { version: rel.version, previousVersion, sha256: dl.sha256 });
      ctx.stepDone(exe);
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      await this.d.downloads.cleanup(dl.path);
    }

    ctx.step('Creating folders and recommended configuration');
    const custom = this.d.emuRepo.getCustom(id);
    const settings = this.settingsFor(id);
    this.d.emuRepo.saveSettings(id, settings);
    if (custom.customConfigActive && reason !== 'install') {
      await a.applyConfig(this.configInput(id), 'paths');
      ctx.stepDone('Custom configuration active: only OmniPC folder paths were updated');
    } else {
      const res = await a.applyConfig(this.configInput(id), 'all');
      if (res.changed.length) this.d.ops.addChange('config.generated', id, `${a.manifest.name} configuration ${reason === 'install' ? 'created' : 'refreshed'} (${res.changed.length} values)`);
      ctx.stepDone(`${res.changed.length} setting(s) written${res.notes.length ? ` — ${res.notes.join(' ')}` : ''}`);
    }

    if (a.installComponents) {
      ctx.step('Installing additional components');
      const notes = await a.installComponents(this.componentInstaller(a, ctx), this.configInput(id));
      ctx.stepDone(notes.join(' ') || 'Nothing else needed');
    }

    const result = await this.healthTest(id, ctx);
    const previous = this.status(id).rollbackVersion;
    if (!result.ok && reason === 'update' && previous && opts.autoRollback) {
      // Unattended update that broke the emulator: put the working version back.
      ctx.step(`Health test failed after updating to ${rel.version}; restoring ${previous}`);
      const restored = await this.performRollback(a, ctx);
      this.d.notifications.add('warning', `${a.manifest.name} update rolled back`, `${a.manifest.name} ${rel.version} failed its health test, so OmniPC restored ${previous}${restored.ok ? '' : ' (which also reports problems; open OmniDoctor)'}. It will be offered again with the next release.`, { link: `/emulators/${id}` });
      this.d.bus.emit('emulators.changed', { id });
      return { ...result, rolledBack: previous };
    }
    if (!result.ok && reason === 'update' && previous) {
      this.d.notifications.add('warning', `${a.manifest.name} update needs attention`, `The health test failed after updating to ${rel.version}. You can roll back to ${this.status(id).rollbackVersion} from the Emulators page.`, { link: `/emulators/${id}` });
    } else {
      this.d.notifications.add('success', `${a.manifest.name} ${reason === 'update' ? 'updated' : 'installed'}`, `${a.manifest.name} ${rel.version} is ${result.ok ? 'ready' : 'installed but the health test reported problems'}.`, { link: `/emulators/${id}` });
    }
    this.d.bus.emit('emulators.changed', { id });
    return result;
  }

  private async pruneRollbacks(id: string, keep: number): Promise<void> {
    const versions = this.d.emuRepo.versions(id).filter((v) => v.status === 'rollback');
    for (const v of versions.slice(keep)) {
      if (v.path && v.path.startsWith(this.d.paths.emulatorRollbackDir(id))) await rm(v.path, { recursive: true, force: true }).catch(() => undefined);
      this.d.emuRepo.setVersionStatus(v.id, 'removed', null);
    }
  }

  configInput(id: string) {
    return { settings: this.settingsFor(id), controller: this.d.controllerProfile(), hotkeys: this.hotkeys(), hardware: this.d.hardware(), achievements: this.d.achievements?.() ?? null };
  }

  /** Smoke test + record health. */
  async healthTest(id: string, ctx?: JobContext): Promise<SmokeTestResult> {
    const a = this.d.registry.require(id);
    ctx?.step(`Testing ${a.manifest.name}`);
    const exe = this.executableFor(id);
    if (!exe) {
      this.d.emuRepo.setHealth(id, 'not_installed', null);
      return { ran: false, ok: false, checks: [{ label: 'Installed', ok: false, detail: 'Not installed' }] };
    }
    const r = await a.smokeTest(exe);
    const failed = r.checks.filter((c) => !c.ok);
    this.d.emuRepo.setHealth(id, failed.length ? 'error' : r.ran ? 'ready' : 'ready', failed.length ? failed.map((c) => `${c.label}: ${c.detail}`).join('; ') : r.ran ? null : 'Launch test skipped (not running on Windows)');
    if (ctx) {
      if (failed.length) ctx.stepFailed(failed.map((c) => c.label).join(', '));
      else ctx.stepDone(r.checks.map((c) => c.label).join(' ✓ ') + ' ✓');
    }
    this.d.ops.addChange('emulator.health', id, `${a.manifest.name} health test ${failed.length ? 'failed' : 'passed'}`, r);
    this.d.bus.emit('emulators.changed', { id });
    return r;
  }

  rollback(id: string): { jobId: string; done: Promise<unknown> } {
    const a = this.requireImplemented(id);
    const j = this.d.jobs.start('emulator.rollback', `Roll back ${a.manifest.name}`, (ctx) => this.performRollback(a, ctx), { lockKey: `emu:${id}` });
    return { jobId: j.id, done: j.done };
  }

  /** Restores the previous build (kept at update time) and the config snapshot taken before the update. */
  private async performRollback(a: EmulatorAdapter, ctx: JobContext): Promise<SmokeTestResult> {
    const id = a.manifest.id;
    {
      const cand = this.d.emuRepo.rollbackCandidate(id);
      if (!cand?.path || !existsSync(cand.path)) throw new OmniFailure({ code: 'NO_ROLLBACK', whatHappened: `No previous ${a.manifest.name} version is available to restore.` });
      const p = a.paths();
      const row = this.d.emuRepo.get(id);
      await this.runBeforeChange(id, 'rollback', ctx);
      ctx.step('Backing up current configuration');
      await this.d.backups.create(id, `Before rollback to ${cand.version}`, 'pre-rollback', a.configTargets());
      ctx.step(`Restoring ${a.manifest.name} ${cand.version}`);
      const failedDir = join(this.d.paths.emulatorRollbackDir(id), `${(row.version ?? 'current').replace(/[^\w.\-]/g, '_')}-rolled-back`);
      await rm(failedDir, { recursive: true, force: true });
      if (existsSync(p.app)) await moveDir(p.app, failedDir);
      await moveDir(cand.path, p.app);
      await this.carryPersistent(a, failedDir, p.app);
      if (a.prepareInstall) await a.prepareInstall(p.app);
      const active = this.d.emuRepo.activeVersion(id);
      if (active) this.d.emuRepo.setVersionStatus(active.id, 'rollback', failedDir);
      this.d.emuRepo.setVersionStatus(cand.id, 'active', p.app);
      const exe = await a.findExecutable(p.app);
      this.d.emuRepo.setInstalled(id, { state: 'installed', version: cand.version, installDir: p.app, executable: exe });
      // Restore the configuration snapshot taken right before the update, if any.
      const pre = this.d.ops.backups(id).find((b) => b.reason === 'pre-update' && b.label.includes(row.version ?? '\u0000'));
      if (pre) {
        ctx.step('Restoring configuration from before the update');
        await this.d.backups.restore(pre.id, { safetyBackup: false });
      }
      this.d.ops.addChange('emulator.rollback', id, `${a.manifest.name} rolled back ${row.version ?? '?'} → ${cand.version}`);
      return this.healthTest(id, ctx);
    }
  }

  repair(id: string): { jobId: string; done: Promise<unknown> } {
    const a = this.requireImplemented(id);
    const j = this.d.jobs.start('emulator.repair', `Repair ${a.manifest.name}`, async (ctx) => {
      const exe = this.executableFor(id);
      if (!exe || !existsSync(exe)) {
        ctx.step('Executable missing — reinstalling');
        return this.performInstall(a, ctx, 'reinstall');
      }
      ctx.step('Backing up configuration');
      await this.d.backups.create(id, 'Before repair', 'pre-repair', a.configTargets());
      ctx.step('Recreating folders and OmniPC-managed settings');
      const custom = this.d.emuRepo.getCustom(id);
      const res = await a.applyConfig(this.configInput(id), custom.customConfigActive ? 'paths' : 'all');
      ctx.stepDone(`${res.changed.length} value(s) corrected`);
      if (a.installComponents) {
        ctx.step('Checking additional components');
        const notes = await a.installComponents(this.componentInstaller(a, ctx), this.configInput(id));
        ctx.stepDone(notes.join(' ') || 'All present');
      }
      if (res.changed.length) this.d.ops.addChange('config.repaired', id, `${a.manifest.name} configuration repaired (${res.changed.length} values)`, res.changed);
      return this.healthTest(id, ctx);
    }, { lockKey: `emu:${id}` });
    return { jobId: j.id, done: j.done };
  }

  /** One-click reset: backup → defaults → controller → paths → test. Saves, BIOS and games untouched. */
  resetConfig(id: string): { jobId: string; done: Promise<unknown> } {
    const a = this.requireImplemented(id);
    const j = this.d.jobs.start('emulator.reset', `Reset ${a.manifest.name} configuration`, async (ctx) => {
      ctx.step('Backing up existing configuration');
      const b = await this.d.backups.create(id, 'Before configuration reset', 'pre-reset', a.configTargets());
      ctx.stepDone(`Backup #${b.id}`);
      ctx.step('Removing current configuration files (backup kept)');
      for (const t of a.configTargets()) await rm(t.path, { force: true });
      ctx.step('Generating recommended defaults for this PC');
      const defaults = a.defaultSettings(this.d.hardware(), this.d.settings.get('defaultPreset'));
      this.d.emuRepo.saveSettings(id, defaults);
      this.d.emuRepo.saveCustom(id, { ...this.d.emuRepo.getCustom(id), customConfigActive: false });
      const res = await a.applyConfig(this.configInput(id), 'all');
      ctx.stepDone(`${res.changed.length} values written (paths, graphics, controller, hotkeys)`);
      this.d.ops.addChange('config.reset', id, `${a.manifest.name} configuration reset to recommended defaults (backup #${b.id})`);
      return this.healthTest(id, ctx);
    }, { lockKey: `emu:${id}` });
    return { jobId: j.id, done: j.done };
  }

  uninstall(id: string): { jobId: string; done: Promise<unknown> } {
    const a = this.requireImplemented(id);
    const j = this.d.jobs.start('emulator.uninstall', `Uninstall ${a.manifest.name}`, async (ctx) => {
      ctx.step('Backing up configuration');
      await this.d.backups.create(id, 'Before uninstall', 'pre-uninstall', a.configTargets());
      const row = this.d.emuRepo.get(id);
      if (row.install_state === 'installed') {
        ctx.step('Removing program files (settings, saves and BIOS are kept)');
        const kept = await this.preservePersistent(a);
        if (kept.length) ctx.message(`Kept user data from the program folder in ${this.preservedDir(id)}: ${kept.join(', ')}`);
        await rm(a.paths().app, { recursive: true, force: true });
      } else {
        ctx.stepSkipped('Remove program files', 'External installation left untouched');
      }
      this.d.emuRepo.setUninstalled(id);
      for (const v of this.d.emuRepo.versions(id)) if (v.status === 'active') this.d.emuRepo.setVersionStatus(v.id, 'removed', null);
      this.d.ops.addChange('emulator.uninstalled', id, `${a.manifest.name} uninstalled (data kept in ${a.paths().data})`);
      this.d.bus.emit('emulators.changed', { id });
    }, { lockKey: `emu:${id}` });
    return { jobId: j.id, done: j.done };
  }

  async useExisting(id: string, executable: string): Promise<EmulatorStatus> {
    const a = this.requireImplemented(id);
    if (!existsSync(executable)) throw new OmniFailure({ code: 'EXE_NOT_FOUND', whatHappened: `${executable} does not exist.` });
    const version = await a.detectVersion(executable);
    this.d.emuRepo.setInstalled(id, { state: 'external', version, installDir: join(executable, '..'), executable });
    await a.applyConfig(this.configInput(id), 'all');
    this.d.ops.addChange('emulator.external', id, `${a.manifest.name}: using existing installation ${executable}`);
    await this.healthTest(id);
    return this.status(id);
  }

  async saveSettings(id: string, s: EmulatorSettings): Promise<void> {
    const a = this.requireImplemented(id);
    await this.d.backups.create(id, 'Before settings change', 'pre-settings', a.configTargets());
    this.d.emuRepo.saveSettings(id, s);
    if (this.isInstalled(id)) {
      const res = await a.applyConfig(this.configInput(id), 'graphics');
      if (res.changed.length) this.d.ops.addChange('config.changed', id, `${a.manifest.name} settings changed: ${res.changed.slice(0, 4).join(', ')}${res.changed.length > 4 ? '…' : ''}`);
    }
  }

  saveCustom(id: string, c: CustomEmulatorSettings): void {
    this.d.emuRepo.saveCustom(id, c);
    this.d.ops.addChange('config.custom', id, `${this.d.registry.require(id).manifest.name}: custom settings ${c.customConfigActive || c.customExecutable || c.customArgs ? 'enabled' : 'cleared'}`);
  }

  /** Re-applies the universal controller profile to every installed emulator. */
  async applyControllerProfile(opts: { force: boolean }): Promise<{ applied: string[]; skipped: { emulatorId: string; reason: string }[] }> {
    const applied: string[] = [];
    const skipped: { emulatorId: string; reason: string }[] = [];
    for (const a of this.d.registry.implemented()) {
      const id = a.manifest.id;
      if (!this.isInstalled(id)) continue;
      if (this.d.emuRepo.getCustom(id).customConfigActive && !opts.force) {
        skipped.push({ emulatorId: id, reason: 'Custom configuration is active; OmniPC will not overwrite it without permission.' });
        continue;
      }
      await this.d.backups.create(id, 'Before controller profile update', 'pre-controller', a.configTargets());
      const res = await a.applyConfig(this.configInput(id), 'controller');
      applied.push(`${a.manifest.name}${res.notes.length ? ` (${res.notes.join(' ')})` : ''}`);
      if (res.changed.length) this.d.ops.addChange('controller.applied', id, `Controller profile applied to ${a.manifest.name} (${res.changed.length} bindings)`);
    }
    return { applied, skipped };
  }

  async recoverSessions(): Promise<string[]> {
    const notes: string[] = [];
    for (const a of this.d.registry.implemented()) notes.push(...(await a.recoverSession().catch(() => [])));
    return notes;
  }

  /** Where user data from the program folder is kept between uninstall and reinstall. */
  preservedDir(id: string): string {
    return join(this.d.registry.require(id).paths().data, 'preserved-app-data');
  }

  /** Copies portable user data (saves, config) from a previous app dir into the new one. */
  private async carryPersistent(a: EmulatorAdapter, from: string | null, to: string): Promise<void> {
    if (!from || !a.persistentAppPaths) return;
    for (const rel of a.persistentAppPaths()) {
      const src = join(from, rel);
      if (!existsSync(src)) continue;
      await cp(src, join(to, rel), { recursive: true, force: true });
    }
    if (from === this.preservedDir(a.manifest.id)) await rm(from, { recursive: true, force: true });
  }

  /** Moves portable user data out of the app dir before it is deleted. Never deletes it. */
  private async preservePersistent(a: EmulatorAdapter): Promise<string[]> {
    if (!a.persistentAppPaths) return [];
    const kept: string[] = [];
    const dest = this.preservedDir(a.manifest.id);
    for (const rel of a.persistentAppPaths()) {
      const src = join(a.paths().app, rel);
      if (!existsSync(src)) continue;
      await mkdir(join(dest, rel, '..'), { recursive: true });
      await cp(src, join(dest, rel), { recursive: true, force: true });
      kept.push(rel);
    }
    return kept;
  }

  private componentInstaller(a: EmulatorAdapter, ctx: JobContext): ComponentInstaller {
    return {
      download: async (o) => {
        const dl = await this.d.downloads.download({ name: o.name, url: o.url, version: 'component', sourceLabel: a.manifest.name, fileName: o.fileName, allowedHosts: a.manifest.download.allowedHosts, expectedSha256: o.expectedSha256 ?? null, expectedSize: null }, ctx.signal);
        return dl.path;
      },
      extract: async (archive, dest) => { await extractArchive(archive, dest); },
      cleanup: (f) => this.d.downloads.cleanup(f),
      progress: (m) => ctx.message(m),
      signal: ctx.signal,
    };
  }

  async installedSize(id: string): Promise<number> {
    return dirSize(this.d.registry.require(id).paths().app);
  }
}
