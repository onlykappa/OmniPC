// Self-healing engine. Every repair:
//  - has a safety level (safe / low / high / never); "never" actions don't exist
//    as code at all (deleting saves, ROMs or BIOS is not something OmniPC does)
//  - backs up configuration before changing it
//  - is recorded in Repair History with details, and is undoable when feasible
// Only "safe" repairs run automatically; "low" needs approval and "high" needs
// explicit confirmation in the UI.

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import type { AppSettings, RepairRecord, RepairSafety } from '@shared/models';
import type BetterSqlite3 from 'better-sqlite3';
import type { OpsRepo, RepairUndo } from '../database/opsRepo';
import type { SettingsRepo } from '../database/settingsRepo';
import type { LibraryRepo } from '../database/libraryRepo';
import type { AdapterRegistry } from '../emulators/registry';
import type { EmulatorManager } from '../services/emulatorManager';
import type { ConfigBackupService } from '../config/backups';
import type { AppPaths } from '../core/paths';
import type { LibraryScanner } from '../library/scanner';
import type { MetadataService } from '../metadata/service';
import type { EventBus } from '../core/events';
import { OmniFailure, errorMessage } from '../core/errors';
import { logger } from '../core/logger';
import { IniDocument } from '../config/ini';
import { atomicWrite } from '../config/iniFile';
import { backupDatabase } from '../database/db';
import { DEFAULT_SETTINGS } from '../database/settingsRepo';
import { installVcRedist } from '../platform/vcredist';
import { applyCueRepair, applyM3uRebuild, extractGameArchive, planCueRepair, planM3uRebuild, restoreFiles, revalidateGame } from '../library/gameFix';

const log = logger.scope('repairs');

export interface RepairDeps {
  ops: OpsRepo;
  settings: SettingsRepo;
  library: LibraryRepo;
  registry: AdapterRegistry;
  emulators: EmulatorManager;
  backups: ConfigBackupService;
  paths: AppPaths;
  scanner: LibraryScanner;
  metadata: MetadataService;
  db: BetterSqlite3.Database;
  bus: EventBus;
  scanLibrary: () => Promise<unknown>;
  rescanHardware: () => Promise<unknown>;
}

export interface RepairOutcome {
  message: string;
  details: string[];
  backupIds: number[];
  undo: RepairUndo | null;
}

export interface RepairAction {
  id: string;
  label: string;
  safety: Exclude<RepairSafety, 'never'>;
  run(params: Record<string, unknown>, d: RepairDeps): Promise<RepairOutcome>;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The game file a game-fix repair acts on (must belong to the game). */
function requireGameFile(params: Record<string, unknown>, d: RepairDeps) {
  const gameId = num(params.gameId);
  const fileId = num(params.fileId);
  const file = gameId === null ? undefined : d.library.filesForGame(gameId).find((f) => f.id === fileId);
  if (gameId === null || !file) throw new OmniFailure({ code: 'REPAIR_PARAMS', whatHappened: 'The game file for this repair is no longer in your library. Rescan and try again.' });
  return { gameId, file };
}

function requireEmulator(params: Record<string, unknown>, d: RepairDeps) {
  const id = str(params.emulatorId);
  if (!id) throw new OmniFailure({ code: 'REPAIR_PARAMS', whatHappened: 'This repair needs an emulator to act on.' });
  return d.registry.require(id);
}

export const ACTIONS: RepairAction[] = [
  {
    id: 'folders.recreate',
    label: 'Recreate missing folders',
    safety: 'safe',
    async run(params, d) {
      const created: string[] = [];
      const dirs = [d.paths.emulators, d.paths.saves, d.paths.bios, d.paths.cache, d.paths.backups, d.paths.artwork, d.paths.thumbnails, d.paths.logs, d.paths.downloads];
      const emuId = str(params.emulatorId);
      for (const a of d.registry.implemented()) {
        if (emuId && a.manifest.id !== emuId) continue;
        if (!d.emulators.isInstalled(a.manifest.id)) continue;
        dirs.push(...a.saveLocations().map((s) => s.path), a.paths().data, a.paths().bios, a.paths().cache);
      }
      for (const dir of dirs) {
        if (!existsSync(dir)) {
          await mkdir(dir, { recursive: true });
          created.push(dir);
        }
      }
      return { message: created.length ? `Created ${created.length} folder(s)` : 'All folders already existed', details: created, backupIds: [], undo: null };
    },
  },
  {
    id: 'emulator.regenerateConfig',
    label: 'Regenerate emulator configuration',
    safety: 'low',
    async run(params, d) {
      const a = requireEmulator(params, d);
      const scope = (str(params.scope) ?? 'all') as 'all' | 'paths' | 'graphics' | 'controller';
      const b = await d.backups.create(a.manifest.id, `Before repair: regenerate ${scope}`, 'pre-repair', a.configTargets());
      const res = await a.applyConfig(d.emulators.configInput(a.manifest.id), scope);
      d.ops.addChange('config.repaired', a.manifest.id, `${a.manifest.name} configuration regenerated (${scope}, ${res.changed.length} values)`);
      return { message: `${a.manifest.name}: ${res.changed.length} setting(s) corrected`, details: res.changed, backupIds: [b.id], undo: { kind: 'restore-backups', backupIds: [b.id] } };
    },
  },
  {
    id: 'config.repairFormat',
    label: 'Repair malformed configuration file',
    safety: 'low',
    async run(params, d) {
      const a = requireEmulator(params, d);
      const b = await d.backups.create(a.manifest.id, 'Before repairing file format', 'pre-repair', a.configTargets());
      const details: string[] = [];
      for (const f of (await a.inspectConfig()).files) {
        if (!f.exists || f.parseOk) continue;
        const text = (await readFile(f.path, 'utf8')).replace(/\u0000/g, '');
        const doc = IniDocument.parse(text);
        const changes = doc.repair();
        await atomicWrite(f.path, doc.toString());
        details.push(...changes.map((c) => `${f.label}: ${c}`));
      }
      // Ensure OmniPC-managed values survived the cleanup.
      const res = await a.applyConfig(d.emulators.configInput(a.manifest.id), 'paths');
      details.push(...res.changed);
      d.ops.addChange('config.repaired', a.manifest.id, `${a.manifest.name} configuration file format repaired`);
      return { message: `Repaired ${a.manifest.name} configuration format`, details, backupIds: [b.id], undo: { kind: 'restore-backups', backupIds: [b.id] } };
    },
  },
  {
    id: 'emulator.setRenderer',
    label: 'Change renderer',
    safety: 'low',
    async run(params, d) {
      const a = requireEmulator(params, d);
      const renderer = str(params.renderer);
      if (!renderer || !a.renderers(null).some((r) => r.id === renderer)) throw new OmniFailure({ code: 'REPAIR_PARAMS', whatHappened: `Unknown renderer ${renderer}` });
      const gameId = num(params.gameId);
      if (gameId !== null) {
        const before = d.ops.getGameProfile(gameId);
        const prof = before ?? { gameId, emulatorId: null, overrides: {}, customArgs: null, notes: null };
        d.ops.saveGameProfile({ ...prof, overrides: { ...prof.overrides, renderer } });
        const title = d.library.getGame(gameId)?.title ?? `game ${gameId}`;
        d.ops.addChange('profile.changed', a.manifest.id, `${title}: renderer set to ${renderer} by OmniDoctor`);
        return { message: `${title} will now use ${renderer} in ${a.manifest.name}`, details: [`Per-game override renderer = ${renderer}`], backupIds: [], undo: { kind: 'restore-settings', settings: { gameProfile: before, gameId } } };
      }
      const prev = d.emulators.settingsFor(a.manifest.id);
      await d.emulators.saveSettings(a.manifest.id, { ...prev, renderer });
      return { message: `${a.manifest.name} renderer set to ${renderer}`, details: [`Previous: ${prev.renderer}`], backupIds: [], undo: { kind: 'restore-settings', emulatorId: a.manifest.id, settings: { emulatorSettings: prev } } };
    },
  },
  {
    id: 'emulator.repair',
    label: 'Repair emulator',
    safety: 'low',
    async run(params, d) {
      const a = requireEmulator(params, d);
      const { done } = d.emulators.repair(a.manifest.id);
      const r = (await done) as { ok: boolean; checks: { label: string; ok: boolean; detail: string }[] };
      return { message: `${a.manifest.name} repaired${r.ok ? ' and passed its health test' : ' but the health test still reports problems'}`, details: r.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.label}: ${c.detail}`), backupIds: [], undo: null };
    },
  },
  {
    id: 'emulator.installFirmware',
    label: 'Install console firmware',
    safety: 'low',
    async run(params, d) {
      const a = requireEmulator(params, d) as ReturnType<typeof requireEmulator> & { installFirmware?: (exe: string) => Promise<{ ok: boolean; installedVersion: string | null; notes: string[] }> };
      const exe = d.emulators.executableFor(a.manifest.id);
      if (!a.installFirmware || !exe) throw new OmniFailure({ code: 'NOT_SUPPORTED', whatHappened: `${a.manifest.name} has no firmware installer or is not installed.` });
      const r = await a.installFirmware(exe);
      if (!r.ok) throw new OmniFailure({ code: 'FIRMWARE_INSTALL_FAILED', whatHappened: `${a.manifest.name} firmware was not installed.`, detected: r.notes });
      return { message: `${a.manifest.name} firmware ${r.installedVersion ?? ''} installed`.replace(/\s+/g, ' '), details: r.notes, backupIds: [], undo: null };
    },
  },
  {
    id: 'emulator.reinstall',
    label: 'Reinstall emulator',
    safety: 'high',
    async run(params, d) {
      const a = requireEmulator(params, d);
      const { done } = d.emulators.install(a.manifest.id);
      const r = (await done) as { ok: boolean };
      return { message: `${a.manifest.name} reinstalled${r.ok ? '' : ' (health test reported problems)'}`, details: [], backupIds: [], undo: null };
    },
  },
  {
    id: 'emulator.install',
    label: 'Install emulator',
    safety: 'low',
    async run(params, d) {
      const a = requireEmulator(params, d);
      await d.emulators.install(a.manifest.id).done;
      return { message: `${a.manifest.name} installed`, details: [], backupIds: [], undo: null };
    },
  },
  {
    id: 'emulator.update',
    label: 'Update emulator',
    safety: 'low',
    async run(params, d) {
      const a = requireEmulator(params, d);
      await d.emulators.update(a.manifest.id).done;
      return { message: `${a.manifest.name} updated`, details: [], backupIds: [], undo: null };
    },
  },
  {
    id: 'emulator.rollback',
    label: 'Restore previous emulator version',
    safety: 'high',
    async run(params, d) {
      const a = requireEmulator(params, d);
      await d.emulators.rollback(a.manifest.id).done;
      return { message: `${a.manifest.name} restored to ${d.emulators.status(a.manifest.id).version}`, details: [], backupIds: [], undo: null };
    },
  },
  {
    id: 'emulator.recoverSession',
    label: 'Restore settings after interrupted session',
    safety: 'safe',
    async run(params, d) {
      const a = requireEmulator(params, d);
      const notes = await a.recoverSession();
      return { message: notes[0] ?? 'Nothing to restore', details: notes, backupIds: [], undo: null };
    },
  },
  {
    id: 'cache.clear',
    label: 'Clear shader cache',
    safety: 'high',
    async run(params, d) {
      const a = requireEmulator(params, d);
      const cleared: string[] = [];
      for (const c of a.cacheDirs()) {
        if (!existsSync(c.path) || !d.paths.isManagedPath(c.path)) continue;
        await rm(c.path, { recursive: true, force: true });
        cleared.push(`${c.label}: ${c.path}`);
      }
      d.ops.addChange('cache.cleared', a.manifest.id, `${a.manifest.name} caches cleared`);
      return { message: cleared.length ? `Cleared ${cleared.length} cache(s); they rebuild automatically` : 'No caches to clear', details: cleared, backupIds: [], undo: null };
    },
  },
  {
    id: 'controller.reapply',
    label: 'Rebuild controller mapping',
    safety: 'low',
    async run(params, d) {
      const profile = d.ops.getControllerProfile();
      if (profile && (num(params.deviceIndex) !== null || str(params.controllerKind))) {
        const { id: _id, updatedAt: _u, ...rest } = profile;
        d.ops.saveControllerProfile({ ...rest, deviceIndex: num(params.deviceIndex) ?? rest.deviceIndex, controllerKind: (str(params.controllerKind) as typeof rest.controllerKind) ?? rest.controllerKind });
      }
      const r = await d.emulators.applyControllerProfile({ force: false });
      const backups = d.ops.backups(null).filter((b) => b.reason === 'pre-controller').slice(0, r.applied.length).map((b) => b.id);
      return { message: `Controller mapping rebuilt for ${r.applied.length} emulator(s)`, details: [...r.applied, ...r.skipped.map((s) => `Skipped ${s.emulatorId}: ${s.reason}`)], backupIds: backups, undo: backups.length ? { kind: 'restore-backups', backupIds: backups } : null };
    },
  },
  {
    id: 'hotkeys.restoreDefaults',
    label: 'Restore default hotkeys',
    safety: 'low',
    async run(_params, d) {
      const prev = d.settings.get('hotkeys');
      d.settings.set({ hotkeys: structuredClone(DEFAULT_SETTINGS.hotkeys) });
      const r = await d.emulators.applyControllerProfile({ force: false });
      return { message: 'Default hotkeys restored', details: r.applied, backupIds: [], undo: { kind: 'restore-settings', settings: { app: { hotkeys: prev } } } };
    },
  },
  {
    id: 'library.rescan',
    label: 'Rescan library',
    safety: 'safe',
    async run(_p, d) {
      await d.scanLibrary();
      return { message: 'Library rescanned', details: [], backupIds: [], undo: null };
    },
  },
  {
    id: 'library.remapPaths',
    label: 'Re-detect game drives',
    safety: 'safe',
    async run(_p, d) {
      const r = await d.scanner.refreshAvailability();
      d.bus.emit('library.changed', { reason: 'drives' });
      return { message: r.remapped.length ? `Found ${r.remapped.length} drive(s) at a new letter` : r.available.length ? `${r.available.length} game folder(s) available again` : 'No changes: the drive is still not connected', details: [...r.remapped, ...r.available.map((p) => `Available: ${p}`), ...r.unavailable.map((p) => `Unavailable: ${p}`)], backupIds: [], undo: null };
    },
  },
  {
    id: 'game.revalidate',
    label: 'Check game files again',
    safety: 'safe',
    async run(params, d) {
      const gameId = num(params.gameId);
      if (gameId === null) throw new OmniFailure({ code: 'REPAIR_PARAMS', whatHappened: 'No game specified.' });
      const bad = await revalidateGame(d.library, gameId);
      d.bus.emit('library.changed', { reason: 'validation' });
      return { message: bad ? `${bad} file(s) still have a problem` : 'Game files look fine now', details: [], backupIds: [], undo: null };
    },
  },
  {
    id: 'game.revalidateAll',
    label: 'Check all problem games again',
    safety: 'safe',
    async run(_p, d) {
      const ids = (d.db.prepare("SELECT id FROM games WHERE validation IN ('invalid', 'warning') AND availability = 'available'").all() as { id: number }[]).map((r) => r.id);
      let fixed = 0;
      for (const id of ids) if ((await revalidateGame(d.library, id)) === 0) fixed++;
      d.bus.emit('library.changed', { reason: 'validation' });
      return { message: `Checked ${ids.length} game(s); ${fixed} are fine now`, details: [], backupIds: [], undo: null };
    },
  },
  {
    id: 'game.repairCue',
    label: 'Fix CUE sheet',
    safety: 'low',
    async run(params, d) {
      const { gameId, file } = requireGameFile(params, d);
      const plan = await planCueRepair(file.path);
      if (!plan.changes.length) throw new OmniFailure({ code: 'CUE_NO_MATCH', whatHappened: 'OmniPC could not find the missing track files under another name.', userAction: ['Copy the missing .bin track(s) next to the .cue sheet.'] });
      const backup = await applyCueRepair(file.path, plan);
      await revalidateGame(d.library, gameId);
      d.bus.emit('library.changed', { reason: 'validation' });
      return { message: `Fixed ${plan.changes.length} track reference(s) in the CUE sheet`, details: [...plan.changes.map((c) => `${c.from} → ${c.to}`), ...plan.unresolved.map((u) => `Still missing: ${u}`), `Backup: ${backup}`], backupIds: [], undo: { kind: 'restore-files', files: [{ path: file.path, backup }] } };
    },
  },
  {
    id: 'game.rebuildM3u',
    label: 'Rebuild multi-disc playlist',
    safety: 'low',
    async run(params, d) {
      const { gameId, file } = requireGameFile(params, d);
      const discs = await planM3uRebuild(file.path);
      if (!discs) throw new OmniFailure({ code: 'M3U_NO_DISCS', whatHappened: 'OmniPC could not find a complete set of disc files next to the playlist.', userAction: ['Put every disc of the game in the same folder as the .m3u.'] });
      const backup = await applyM3uRebuild(file.path, discs);
      await revalidateGame(d.library, gameId);
      d.bus.emit('library.changed', { reason: 'validation' });
      return { message: `Playlist rebuilt with ${discs.length} discs`, details: [...discs, `Backup: ${backup}`], backupIds: [], undo: { kind: 'restore-files', files: [{ path: file.path, backup }] } };
    },
  },
  {
    id: 'game.extractArchive',
    label: 'Extract zipped game',
    safety: 'low',
    async run(params, d) {
      const { gameId, file } = requireGameFile(params, d);
      const r = await extractGameArchive(file.path);
      await d.scanLibrary();
      await revalidateGame(d.library, gameId);
      return { message: `Extracted ${r.files} file(s); the archive was kept`, details: [`Extracted to ${r.folder}`, `You can delete ${file.path} yourself once the game works.`], backupIds: [], undo: null };
    },
  },
  {
    id: 'database.backup',
    label: 'Back up database',
    safety: 'safe',
    async run(_p, d) {
      const dest = await backupDatabase(d.db, d.paths.databaseBackups);
      return { message: 'Database backed up', details: [dest], backupIds: [], undo: null };
    },
  },
  {
    id: 'database.reindex',
    label: 'Rebuild database indexes',
    safety: 'safe',
    async run(_p, d) {
      await backupDatabase(d.db, d.paths.databaseBackups, 7, 'pre-reindex');
      d.db.exec('REINDEX; ANALYZE;');
      return { message: 'Database indexes rebuilt', details: [], backupIds: [], undo: null };
    },
  },
  {
    id: 'launch.resetCrashLoop',
    label: 'Allow launching again',
    safety: 'safe',
    async run(params, d) {
      const gameId = num(params.gameId);
      if (gameId === null) throw new OmniFailure({ code: 'REPAIR_PARAMS', whatHappened: 'No game specified.' });
      d.library.setFailureState(gameId, 0, false);
      return { message: 'Crash-loop pause cleared', details: [], backupIds: [], undo: null };
    },
  },
  {
    id: 'metadata.refreshAll',
    label: 'Fetch missing metadata',
    safety: 'safe',
    async run(_p, d) {
      const r = await d.metadata.refreshAll();
      d.bus.emit('library.changed', { reason: 'metadata' });
      return { message: `Metadata refreshed for ${r.processed} game(s)`, details: [], backupIds: [], undo: null };
    },
  },
  {
    id: 'hardware.scan',
    label: 'Scan this PC',
    safety: 'safe',
    async run(_p, d) {
      await d.rescanHardware();
      return { message: 'Hardware scan complete', details: [], backupIds: [], undo: null };
    },
  },
  {
    id: 'dependency.vcredist',
    label: 'Install Microsoft Visual C++ runtime',
    safety: 'high',
    async run(_p, d) {
      const r = await installVcRedist(d.paths.downloads);
      await d.rescanHardware();
      return { message: r.message, details: r.details, backupIds: [], undo: null };
    },
  },
];

export class RepairEngine {
  private actions = new Map(ACTIONS.map((a) => [a.id, a]));

  constructor(private readonly d: RepairDeps) {}

  get(id: string): RepairAction | undefined {
    return this.actions.get(id);
  }

  /**
   * Runs a repair. `confirmed` must be true for low/high safety actions; the
   * UI obtains approval (low) or explicit confirmation (high) first.
   */
  async run(actionId: string, params: Record<string, unknown>, opts: { confirmed: boolean; automatic?: boolean }): Promise<RepairRecord> {
    const action = this.actions.get(actionId);
    if (!action) throw new OmniFailure({ code: 'UNKNOWN_REPAIR', whatHappened: `Repair "${actionId}" is not available.` });
    if (action.safety !== 'safe' && !opts.confirmed) throw new OmniFailure({ code: 'REPAIR_NEEDS_CONFIRMATION', whatHappened: `"${action.label}" needs your approval before it runs.` });
    if (opts.automatic && action.safety !== 'safe') throw new OmniFailure({ code: 'REPAIR_NOT_AUTOMATIC', whatHappened: `"${action.label}" is never run automatically.` });
    const subject = (str(params.emulatorId) ?? (num(params.gameId) !== null ? `game:${params.gameId}` : null));
    try {
      const out = await action.run(params, this.d);
      const rec = this.d.ops.addRepair({ actionId, label: action.label, safety: action.safety, subject, status: 'succeeded', message: out.message, details: out.details, backupIds: out.backupIds, undo: out.undo, automatic: !!opts.automatic });
      this.d.ops.addChange('repair', subject, `${opts.automatic ? 'Automatic repair' : 'Repair'}: ${out.message}`);
      log.info('repair succeeded', { actionId, params, message: out.message });
      return rec;
    } catch (err) {
      const msg = errorMessage(err);
      log.error('repair failed', { actionId, params, error: msg });
      return this.d.ops.addRepair({ actionId, label: action.label, safety: action.safety, subject, status: 'failed', message: msg, details: err instanceof OmniFailure ? [...err.detail.detected, ...err.detail.userAction] : [], backupIds: [], undo: null, automatic: !!opts.automatic });
    }
  }

  async undo(repairId: number): Promise<RepairRecord> {
    const rec = this.d.ops.getRepair(repairId);
    const undo = this.d.ops.getRepairUndo(repairId);
    if (!rec || !undo || rec.status !== 'succeeded') throw new OmniFailure({ code: 'NOT_UNDOABLE', whatHappened: 'This repair cannot be undone.' });
    const details: string[] = [];
    if (undo.kind === 'restore-backups') {
      for (const id of undo.backupIds ?? []) {
        const r = await this.d.backups.restore(id);
        details.push(...r.restored);
      }
    } else if (undo.kind === 'restore-settings') {
      const s = undo.settings ?? {};
      if (s.emulatorSettings && undo.emulatorId) await this.d.emulators.saveSettings(undo.emulatorId, s.emulatorSettings as never);
      if ('gameProfile' in s && typeof s.gameId === 'number') {
        if (s.gameProfile) this.d.ops.saveGameProfile(s.gameProfile as never);
        else this.d.ops.deleteGameProfile(s.gameId);
      }
      if (s.app) {
        this.d.settings.set(s.app as Partial<AppSettings>);
        await this.d.emulators.applyControllerProfile({ force: false });
      }
      details.push('Previous settings restored');
    } else if (undo.kind === 'restore-files') {
      for (const p of await restoreFiles(undo.files ?? [])) details.push(`Restored ${p}`);
      if (rec.subject?.startsWith('game:')) await revalidateGame(this.d.library, Number(rec.subject.slice(5))).catch(() => undefined);
      this.d.bus.emit('library.changed', { reason: 'validation' });
    }
    this.d.ops.setRepairStatus(repairId, 'undone');
    this.d.ops.addChange('repair.undone', rec.subject, `Undid repair: ${rec.message}`);
    return this.d.ops.addRepair({ actionId: `undo:${rec.actionId}`, label: `Undo: ${rec.label}`, safety: 'safe', subject: rec.subject, status: 'succeeded', message: `Reverted "${rec.message}"`, details, backupIds: [], undo: null, automatic: false });
  }

  /** Runs every "safe" repair suggested by a report. */
  async runSafe(suggestions: { actionId: string; params: Record<string, unknown> }[], automatic: boolean): Promise<RepairRecord[]> {
    const out: RepairRecord[] = [];
    const seen = new Set<string>();
    for (const s of suggestions) {
      const action = this.actions.get(s.actionId);
      if (!action || action.safety !== 'safe') continue;
      const key = `${s.actionId}:${JSON.stringify(s.params)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(await this.run(s.actionId, s.params, { confirmed: true, automatic }));
    }
    return out;
  }
}
