// Implementation of the typed OmniApi contract. Electron-specific actions
// (dialogs, shell, relaunch) arrive via `UiHost` so this module stays testable.

import { applySuggestions, optimizeSuggestions, settingsView } from '../emulators/settingsView';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { OmniApi, SystemSummary, HomeData, OnboardingInstallPlan, DevAdapterReport } from '@shared/ipc';
import type { AppInfo, GameDetails, SearchResult, SetupImportCandidate } from '@shared/models';
import { SYSTEMS, getSystem } from '@shared/systems';
import type { AppContainer } from '../services/container';
import { fileRowToDto } from '../database/libraryRepo';
import { SETTINGS_CATALOG, searchSettings } from '../services/settingsCatalog';
import { exportDiagnosticPackage } from '../services/diagnosticPackage';
import { buildAiContext, askAssistant } from '../ai/assistant';
import { OmniFailure } from '../core/errors';
import { logger } from '../core/logger';
import { readLogTail, excerpt } from '../diagnostics/logs';
import { RULE_FILES } from '../diagnostics/rules';

import { sourceForManifest } from '../downloads/sources';
import type { AppUpdateService } from '../services/appUpdater';

export interface UiHost {
  appInfo(): Omit<AppInfo, 'dataRoot' | 'databasePath' | 'logPath' | 'dbRecoveredFromBackup' | 'safeMode'>;
  openPath(p: string): void;
  openExternal(url: string): void;
  pickFolder(title: string): Promise<string | null>;
  pickFile(title: string, extensions: string[]): Promise<string | null>;
  relaunch(safeMode: boolean): void;
  setConsoleMode(enabled: boolean): void;
  setStartWithWindows(enabled: boolean): void;
  /** OmniPC self-update (electron-updater in the packaged app, "unsupported" otherwise). */
  updater: AppUpdateService;
}

type Impl = { [K in keyof OmniApi]: (...args: Parameters<OmniApi[K]>) => ReturnType<OmniApi[K]> | Promise<ReturnType<OmniApi[K]>> };

const ALLOWED_EXTERNAL = /^https:\/\/(aka\.ms|pcsx2\.net|dolphin-emu\.org|github\.com|learn\.microsoft\.com|dotnet\.microsoft\.com|thegamesdb\.net|www\.gametdb\.com|console\.anthropic\.com|[\w.-]+\.(org|com|info|net|app|jp))\//;

export function createApi(c: AppContainer, ui: UiHost): Impl {
  const systems = (): SystemSummary[] => {
    const counts = c.library.countBySystem();
    return SYSTEMS.map((s) => {
      const adapters = c.registry.forSystem(s.id);
      const installed = adapters.find((a) => a.manifest.implemented && c.emulators.isInstalled(a.manifest.id));
      const chosen = installed ?? adapters[0] ?? null;
      return {
        id: s.id,
        name: s.name,
        shortName: s.shortName,
        manufacturer: s.manufacturer,
        gameCount: counts[s.id] ?? 0,
        emulatorId: chosen?.manifest.id ?? null,
        emulatorName: chosen?.manifest.name ?? null,
        emulatorImplemented: !!chosen?.manifest.implemented,
        emulatorInstalled: !!installed,
        bios: s.bios === 'none' ? 'not_required' : s.bios === 'optional' ? 'optional' : 'missing',
        accent: s.accent,
      } satisfies SystemSummary;
    });
  };

  const withBios = async (list: SystemSummary[]): Promise<SystemSummary[]> => {
    const bios = await c.bios.status();
    return list.map((s) => {
      const b = bios.find((x) => x.systemId === s.id);
      if (!b || s.bios === 'not_required') return s;
      return { ...s, bios: b.status === 'found' ? 'found' : b.status === 'invalid' ? 'invalid' : s.bios === 'optional' ? 'optional' : 'missing' };
    });
  };

  const gameDetails = async (id: number): Promise<GameDetails | null> => {
    const s = c.library.summary(id);
    const g = c.library.getGame(id);
    if (!s || !g) return null;
    const files = c.library.filesForGame(id);
    const route = c.launcher.routeEmulator(id);
    const emuId = route.adapter?.manifest.id ?? null;
    return {
      ...s,
      files: files.map(fileRowToDto),
      primaryPath: files[0]?.path ?? '',
      metadata: c.library.getMetadata(id),
      compatibility: c.library.getCompatibility(id),
      emulatorId: emuId,
      emulatorOverride: g.emulator_override,
      profile: c.ops.getGameProfile(id),
      recentLaunches: c.launches.history({ gameId: id, limit: 10 }),
      crashLoopPaused: !!g.crash_loop_paused,
      saveLocations: emuId ? await c.saves.locations(emuId) : [],
    };
  };

  const appInfo = (): AppInfo => ({
    ...ui.appInfo(),
    safeMode: c.safeMode,
    dataRoot: c.paths.root,
    databasePath: c.paths.database,
    logPath: logger.filePath ?? c.paths.logs,
    dbRecoveredFromBackup: c.dbRecovery.recovered !== 'none',
  });

  const requirePath = (p: string) => {
    if (!p || !existsSync(p)) throw new OmniFailure({ code: 'PATH_NOT_FOUND', whatHappened: `${p || 'The folder'} does not exist.` });
  };

  return {
    // ---------------------------------------------------------------- app
    'app.info': appInfo,
    'app.update.state': () => ui.updater.state(),
    'app.update.check': () => ui.updater.check(),
    'app.update.download': () => ui.updater.download(),
    'app.update.install': () => ui.updater.install(),
    'app.settings.get': () => c.settings.getAll(),
    'app.settings.set': async (patch) => {
      const before = c.settings.getAll();
      const next = c.settings.set(patch);
      if (patch.startWithWindows !== undefined && patch.startWithWindows !== before.startWithWindows) ui.setStartWithWindows(patch.startWithWindows);
      if (patch.hotkeys) await c.emulators.applyControllerProfile({ force: false });
      if (patch.defaultPreset && patch.defaultPreset !== before.defaultPreset) c.ops.addChange('settings', null, `Default preset changed to ${patch.defaultPreset}`);
      return next;
    },
    'app.settings.catalog': () => SETTINGS_CATALOG,
    'app.search': (q) => {
      const query = q.trim().toLowerCase();
      if (!query) return [];
      const results: SearchResult[] = [];
      for (const g of c.library.query({ search: query, limit: 12, includeUnavailable: true }).items) results.push({ kind: 'game', id: String(g.id), title: g.title, subtitle: getSystem(g.systemId)?.name ?? g.systemId, route: `/game/${g.id}` });
      for (const s of SYSTEMS) if (`${s.name} ${s.shortName} ${s.manufacturer}`.toLowerCase().includes(query)) results.push({ kind: 'system', id: s.id, title: s.name, subtitle: s.manufacturer, route: `/library?system=${s.id}` });
      for (const a of c.registry.all()) if (`${a.manifest.name} ${a.manifest.id} ${a.manifest.systems.join(' ')}`.toLowerCase().includes(query)) results.push({ kind: 'emulator', id: a.manifest.id, title: a.manifest.name, subtitle: a.manifest.implemented ? 'Emulator' : 'Emulator (planned)', route: `/emulators/${a.manifest.id}` });
      for (const s of searchSettings(query)) results.push({ kind: 'setting', id: s.key, title: s.label, subtitle: `${s.section} · ${s.description}`, route: s.route });
      return results.slice(0, 40);
    },
    'app.openPath': (p) => {
      if (!existsSync(p)) throw new OmniFailure({ code: 'PATH_NOT_FOUND', whatHappened: `${p} does not exist.` });
      ui.openPath(p);
    },
    'app.openExternal': (url) => {
      if (!ALLOWED_EXTERNAL.test(url)) throw new OmniFailure({ code: 'URL_BLOCKED', whatHappened: 'OmniPC only opens https links to known project sites.' });
      ui.openExternal(url);
    },
    'app.pickFolder': (title) => ui.pickFolder(title),
    'app.pickFile': (title, ext) => ui.pickFile(title, ext),
    'app.exportDiagnosticPackage': async (opts) => {
      const hw = c.hardware();
      return exportDiagnosticPackage({ ...opts, extra: { app: appInfo(), hardware: hw, emulators: c.emulators.list(), libraryCount: c.library.countGames() } }, { paths: c.paths, registry: c.registry, ops: c.ops });
    },
    'app.factoryReset': async (kind) => {
      const summary: string[] = [];
      if (kind === 'settings' || kind === 'complete') {
        const keepOnboarding = kind === 'settings';
        c.settings.reset();
        if (keepOnboarding) c.settings.set({ onboardingComplete: true });
        summary.push('OmniPC settings reset to defaults.');
      }
      if (kind === 'emulator-configs' || kind === 'complete') {
        for (const a of c.registry.implemented()) {
          if (!c.emulators.isInstalled(a.manifest.id)) continue;
          await c.emulators.resetConfig(a.manifest.id).done.catch((e) => summary.push(`${a.manifest.name}: ${(e as Error).message}`));
          summary.push(`${a.manifest.name} configuration reset (backup kept in Backups).`);
        }
      }
      if (kind === 'repair-installation') {
        for (const a of c.registry.implemented()) {
          if (!c.emulators.isInstalled(a.manifest.id)) continue;
          await c.emulators.repair(a.manifest.id).done.catch((e) => summary.push(`${a.manifest.name}: ${(e as Error).message}`));
          summary.push(`${a.manifest.name} repaired.`);
        }
        await c.repairs.run('folders.recreate', {}, { confirmed: true });
        await c.repairs.run('database.reindex', {}, { confirmed: true });
        summary.push('Folders recreated and database indexes rebuilt.');
      }
      if (kind === 'complete') {
        c.db.exec('DELETE FROM game_profiles; DELETE FROM metadata; DELETE FROM game_files; DELETE FROM games; DELETE FROM library_paths; DELETE FROM notifications;');
        await rm(c.paths.artwork, { recursive: true, force: true });
        c.paths.ensureBaseLayout();
        summary.push('Library records, metadata cache and artwork cache cleared. Game files on disk were not touched.');
        summary.push('Preserved: your games, saves, BIOS files, emulator installations, and all backups.');
      }
      c.ops.addChange('factory-reset', null, `Reset performed: ${kind}`);
      c.bus.emit('library.changed', { reason: 'reset' });
      return { summary };
    },
    'app.relaunch': ({ safeMode }) => ui.relaunch(safeMode),
    'app.setConsoleMode': (enabled) => ui.setConsoleMode(enabled),
    'app.changes': (limit) => c.ops.changes(Math.min(limit, 500)),
    'app.logTail': (lines) => logger.tail(Math.min(lines, 2000)),

    // ---------------------------------------------------------- home/systems
    'home.get': async (): Promise<HomeData> => {
      const report = c.ops.latestReport();
      return {
        continuePlaying: c.library.query({ sort: 'recent', limit: 12 }).items.filter((g) => g.lastPlayedAt),
        recentlyAdded: c.library.query({ sort: 'added', limit: 12 }).items,
        favorites: c.library.query({ favoritesOnly: true, limit: 24 }).items,
        systems: (await withBios(systems())).filter((s) => s.gameCount > 0 || s.emulatorInstalled),
        emulators: c.emulators.list().filter((e) => e.installState !== 'not_installed'),
        health: { overall: report?.overall ?? null, problems: report?.counts.problems ?? 0, warnings: report?.counts.warnings ?? 0, lastRunAt: report?.runAt ?? null },
        activeSession: c.launcher.activeSession(),
        libraryCount: c.library.countGames(),
      };
    },
    'systems.list': async () => withBios(systems()),

    // -------------------------------------------------------------- hardware
    'hardware.get': () => c.hardware(),
    'hardware.scan': () => c.scanHardware(),

    // --------------------------------------------------------------- library
    'library.query': (q) => c.library.query(q),
    'library.game': (id) => gameDetails(id),
    'library.paths': () => c.library.listPaths(),
    'library.addPath': async (p) => {
      requirePath(p);
      const { driveInfoFor, driveOf } = await import('../platform/drives');
      const drive = await driveInfoFor(p);
      const lp = c.library.addPath(p, drive?.volumeSerial ?? null, driveOf(p));
      c.ops.addChange('library.path', null, `Game folder added: ${p}`);
      return lp;
    },
    'library.removePath': (id) => {
      const p = c.library.getPath(id);
      c.library.removePath(id);
      c.ops.addChange('library.path', null, `Game folder removed from library: ${p?.path ?? id} (files untouched)`);
      c.bus.emit('library.changed', { reason: 'paths' });
    },
    'library.preview': async (p) => {
      requirePath(p);
      return c.scanner.preview(p);
    },
    'library.scan': ({ full }) => ({ jobId: c.scanLibrary(full).id }),
    'library.setFavorite': (id, fav) => {
      c.library.setFavorite(id, fav);
      c.bus.emit('library.changed', { reason: 'favorite' });
    },
    'library.duplicates': () => c.library.duplicates(),
    'library.setEmulatorOverride': (id, emu) => {
      if (emu && !c.registry.get(emu)) throw new OmniFailure({ code: 'UNKNOWN_EMULATOR', whatHappened: `Unknown emulator ${emu}` });
      c.library.setEmulatorOverride(id, emu);
    },
    'library.revalidate': async (id) => {
      const { revalidateGame } = await import('../library/gameFix');
      if (!c.library.getGame(id)) return null;
      await revalidateGame(c.library, id);
      return gameDetails(id);
    },

    // -------------------------------------------------------------- metadata
    'metadata.refresh': (id) => c.metadata.refresh(id, { force: true }),
    'metadata.update': (id, patch) => c.metadata.update(id, patch),
    'metadata.setArtwork': (id, kind, file) => {
      requirePath(file);
      return c.metadata.setArtwork(id, kind, file);
    },
    'metadata.clear': (id) => c.metadata.clear(id),
    'metadata.refreshAll': () => ({ jobId: c.jobs.start('metadata.refresh', 'Refreshing metadata', async (ctx) => { const r = await c.metadata.refreshAll(ctx, { onlyMissing: false }); c.bus.emit('library.changed', { reason: 'metadata' }); return r; }, { lockKey: 'metadata' }).id }),

    // ------------------------------------------------------------- emulators
    'emulators.list': () => c.emulators.list(),
    'emulators.details': (id) => c.emulators.details(id),
    'emulators.install': (id) => ({ jobId: c.emulators.install(id).jobId }),
    'emulators.installForSystems': (sys) => {
      const ids = [...new Set(sys.map((s) => c.registry.forSystem(s)[0]?.manifest.id).filter((x): x is string => !!x))];
      return { jobId: c.emulators.installMany(ids, `Install support for ${sys.map((s) => getSystem(s)?.shortName ?? s).join(', ')}`).jobId };
    },
    'emulators.update': (id) => ({ jobId: c.emulators.update(id).jobId }),
    'emulators.updateAll': () => ({ jobId: c.emulators.updateAll().jobId }),
    'emulators.checkUpdates': () => c.emulators.checkUpdates(),
    'emulators.checkAndUpdateAll': () => ({ jobId: c.emulators.checkAndUpdateAll({ automatic: false, isBusy: () => !!c.launcher.activeSession() }).jobId }),
    'emulators.rollback': (id) => ({ jobId: c.emulators.rollback(id).jobId }),
    'emulators.repair': (id) => ({ jobId: c.emulators.repair(id).jobId }),
    'emulators.resetConfig': (id) => ({ jobId: c.emulators.resetConfig(id).jobId }),
    'emulators.uninstall': (id) => ({ jobId: c.emulators.uninstall(id).jobId }),
    'emulators.launchUi': (id) => c.launcher.launchEmulatorUi(id),
    'emulators.healthCheck': (id) => c.doctor.runForEmulator(id),
    'emulators.saveSettings': async (id, s) => {
      await c.emulators.saveSettings(id, s);
      return c.emulators.details(id);
    },
    'emulators.saveCustom': async (id, cs) => {
      c.emulators.saveCustom(id, cs);
      return c.emulators.details(id);
    },
    'emulators.renderers': (id) => c.registry.require(id).renderers(c.hardware()),
    'emulators.settingsView': (id) => settingsView(c.registry.require(id), c.emulators.settingsFor(id), c.emulators.isInstalled(id)),
    'emulators.optimizePreview': (id) => optimizeSuggestions(c.registry.require(id), c.emulators.settingsFor(id), c.hardware()),
    'emulators.optimizeApply': async (id, fields) => {
      const hw = c.hardware();
      if (!hw) throw new OmniFailure({ code: 'NO_HARDWARE_PROFILE', whatHappened: 'OmniPC has not scanned this PC yet.', userAction: ['Run a health check first.'] });
      await c.emulators.saveSettings(id, applySuggestions(c.registry.require(id), c.emulators.settingsFor(id), hw, fields));
      return c.emulators.details(id);
    },
    'emulators.optimizeAllPreview': () => c.registry.implemented()
      .filter((a) => c.emulators.isInstalled(a.manifest.id))
      .map((a) => ({ emulatorId: a.manifest.id, name: a.manifest.name, suggestions: optimizeSuggestions(a, c.emulators.settingsFor(a.manifest.id), c.hardware()) }))
      .filter((e) => e.suggestions.length),
    'emulators.optimizeAllApply': async (ids) => {
      const hw = c.hardware();
      if (!hw) throw new OmniFailure({ code: 'NO_HARDWARE_PROFILE', whatHappened: 'OmniPC has not scanned this PC yet.', userAction: ['Run a health check first.'] });
      const out: { emulatorId: string; changed: number }[] = [];
      for (const id of ids) {
        const a = c.registry.require(id);
        if (!c.emulators.isInstalled(id)) continue;
        const fields = optimizeSuggestions(a, c.emulators.settingsFor(id), hw).map((s) => s.field);
        if (!fields.length) continue;
        await c.emulators.saveSettings(id, applySuggestions(a, c.emulators.settingsFor(id), hw, fields));
        out.push({ emulatorId: id, changed: fields.length });
      }
      return out;
    },
    'emulators.useExisting': (id, exe) => c.emulators.useExisting(id, exe),

    // --------------------------------------------------------------- backups
    'backups.list': (emu) => c.ops.backups(emu),
    'backups.create': (emu, label) => c.backups.create(emu, label || 'Manual backup', 'manual', c.registry.require(emu).configTargets()),
    'backups.restore': async (id) => {
      const r = await c.backups.restore(id);
      const b = c.ops.getBackup(id);
      c.ops.addChange('config.restored', b?.emulatorId ?? null, `Configuration restored from backup "${b?.label}"`);
      return { restored: r.restored, safetyBackupId: r.safetyBackupId ?? 0 };
    },
    'backups.diff': (id) => c.backups.diff(id),
    'backups.delete': (id) => c.backups.delete(id),

    // ------------------------------------------------------------- launching
    'launch.game': (id, opts) => c.launcher.launchGame(id, opts ?? {}),
    'launch.active': () => c.launcher.activeSession(),
    'launch.stop': () => c.launcher.stop(),
    'launch.history': (opts) => c.launches.history(opts),
    'launch.analyze': (id) => c.doctor.analyzeLaunch(id),
    'launch.resetCrashLoop': (id) => c.library.setFailureState(id, 0, false),

    // -------------------------------------------------------------- profiles
    'profiles.get': (id) => c.ops.getGameProfile(id),
    'profiles.save': (p) => {
      const saved = c.ops.saveGameProfile(p);
      const title = c.library.getGame(p.gameId)?.title ?? `game ${p.gameId}`;
      c.ops.addChange('profile.changed', p.emulatorId, `${title}: per-game profile saved (${Object.keys(p.overrides).length} override(s))`);
      return saved;
    },
    'profiles.delete': (id) => c.ops.deleteGameProfile(id),

    // ---------------------------------------------------------------- doctor
    'doctor.latest': () => c.ops.latestReport(),
    'doctor.run': (scope) => ({ jobId: c.runHealthCheck(scope).id }),
    'doctor.finding': (fid) => {
      const report = c.ops.latestReport();
      const finding = report?.findings.find((f) => f.id === fid);
      return finding && report ? { finding, report } : null;
    },
    'doctor.repair': async (actionId, params, opts) => {
      const rec = await c.repairs.run(actionId, params, { confirmed: opts.confirmed });
      c.bus.emit('emulators.changed', { id: null });
      return rec;
    },
    'doctor.games': async () => (await import('../library/gameFix')).diagnoseGames(c.db, { limit: 500 }),
    'doctor.repairAllSafe': async () => {
      const report = c.ops.latestReport();
      const sugg = (report?.findings ?? []).filter((f) => f.repair && f.severity !== 'pass').map((f) => ({ actionId: f.repair!.actionId, params: f.repair!.params }));
      const out = await c.repairs.runSafe(sugg, false);
      await c.runHealthCheck('quick').done.catch(() => undefined);
      return out;
    },
    'doctor.history': (limit) => c.ops.repairs(limit),
    'doctor.undo': (id) => c.repairs.undo(id),
    'doctor.rules': () => RULE_FILES.map((f) => ({ emulatorId: f.emulatorId, rules: f.rules.map((r) => ({ id: r.id, title: r.title, severity: r.severity, fix: r.fix?.label ?? null })) })),
    'doctor.aiContext': async (q, gameId) => aiPreview(c, q, gameId),
    'doctor.aiAsk': async (q, gameId) => {
      const ctx = await aiPreview(c, q, gameId);
      return askAssistant(c.settings.getAll(), ctx);
    },

    // ----------------------------------------------------------- controllers
    'controllers.pnp': () => c.controllerState().pads,
    'controllers.reportGamepads': (pads) => c.reportGamepads(pads),
    'controllers.profile': () => c.controllerProfile(),
    'controllers.saveProfile': (p) => {
      const saved = c.ops.saveControllerProfile(p);
      c.ops.addChange('controller.profile', null, 'Universal controller profile updated');
      return saved;
    },
    'controllers.apply': () => c.emulators.applyControllerProfile({ force: false }),

    // ------------------------------------------------------- retroachievements
    'ra.status': () => c.achievements.status(),
    'ra.login': (username, password) => c.achievements.login(String(username ?? ''), String(password ?? '')),
    'ra.logout': () => c.achievements.logout(),
    'ra.setHardcore': (on) => c.achievements.setHardcore(!!on),
    'ra.apply': async () => (await c.achievements.apply()).status,

    // ------------------------------------------------------------------ bios
    'bios.status': () => c.bios.status(),
    'bios.scan': (roots) => {
      for (const r of roots ?? []) requirePath(r);
      return c.bios.scan(roots ?? c.library.listPaths().filter((p) => p.available).map((p) => p.path));
    },
    'bios.importFound': async (paths) => {
      for (const p of paths) requirePath(p);
      const r = await c.bios.importFound(paths);
      if (r.imported.length) {
        c.bus.emit('emulators.changed', { id: null });
        void c.runHealthCheck('quick');
      }
      return r;
    },
    'bios.import': (sys, file) => {
      requirePath(file);
      return c.bios.import(sys, file);
    },
    'bios.openFolder': async (sys) => {
      const { mkdir } = await import('node:fs/promises');
      const dir = c.paths.systemBiosDir(sys);
      await mkdir(dir, { recursive: true });
      ui.openPath(dir);
    },

    // ----------------------------------------------------------------- saves
    'saves.locations': () => c.saves.locations(),
    'saves.backup': (emu) => c.saves.backup(emu),
    'saves.backups': () => c.saves.list(),
    'saves.restore': (id) => c.saves.restore(id),
    'saves.settingsSuggestions': () => c.saves.suggestions(),
    'saves.setDestination': async (folder) => {
      const r = await c.saves.setDestination(folder);
      void c.runHealthCheck('quick').done.catch(() => undefined);
      return r;
    },
    'saves.destinationStatus': async () => ({ ...(await c.saves.destinationStatus()), activeFolder: c.saves.activeFolder().dir, computer: c.saves.computer }),
    'saves.openFolder': async (id) => ui.openPath(await c.saves.folderFor(id)),

    // --------------------------------------------------------------- storage
    'storage.locations': () => c.storage.locations(),
    'storage.relocate': (key, p) => {
      if (c.launcher.activeSession()) throw new OmniFailure({ code: 'GAME_RUNNING', whatHappened: 'Exit the running game before moving storage.' });
      return { jobId: c.jobs.start('storage.relocate', `Move ${key}`, (ctx) => c.storage.relocate(key, p, ctx), { lockKey: 'storage' }).id };
    },

    // ------------------------------------------------------------- downloads
    'downloads.list': () => c.downloads.list(),
    'downloads.pause': (id) => c.downloads.pause(id),
    'downloads.resume': (id) => c.downloads.resume(id),
    'downloads.cancel': (id) => c.downloads.cancel(id),
    'downloads.retry': (id) => c.downloads.retry(id),
    'jobs.list': () => c.jobs.list(),
    'jobs.cancel': (id) => c.jobs.cancel(id),

    // --------------------------------------------------------- notifications
    'notifications.list': () => c.ops.notifications(),
    'notifications.markRead': (ids) => c.ops.markRead(ids),

    // ------------------------------------------------------------ onboarding
    'onboarding.plan': (sys): OnboardingInstallPlan => {
      const ids = new Map<string, { id: string; name: string; implemented: boolean; note: string }>();
      for (const s of sys) {
        const a = c.registry.forSystem(s)[0];
        if (!a) continue;
        const prev = ids.get(a.manifest.id);
        const sysName = getSystem(s)?.shortName ?? s;
        ids.set(a.manifest.id, { id: a.manifest.id, name: a.manifest.name, implemented: a.manifest.implemented, note: prev ? `${prev.note}, ${sysName}` : a.manifest.implemented ? `Will install for ${sysName}` : `Planned — not installable yet (${sysName})` });
      }
      return { systems: sys, emulators: [...ids.values()], libraryPaths: c.library.listPaths().map((p) => p.path), preset: c.hardware()?.recommendedPreset ?? 'balanced' };
    },
    'onboarding.run': (plan) => {
      const job = c.jobs.start('onboarding', 'Setting up OmniPC', async (ctx) => {
        c.settings.set({ defaultPreset: plan.preset });
        for (const a of c.registry.implemented()) {
          if (!c.emuRepo.getSettings(a.manifest.id)) c.emuRepo.saveSettings(a.manifest.id, a.defaultSettings(c.hardware(), plan.preset));
        }
        const ids = plan.emulators.filter((e) => e.implemented).map((e) => e.id);
        const failures: string[] = [];
        for (const id of ids) {
          ctx.throwIfCancelled();
          const name = c.registry.require(id).manifest.name;
          ctx.step(`Installing ${name}`);
          try {
            await c.emulators.install(id).done;
            ctx.stepDone();
          } catch (e) {
            failures.push(`${name}: ${(e as Error).message}`);
            ctx.stepFailed((e as Error).message);
          }
        }
        for (const e of plan.emulators.filter((x) => !x.implemented)) ctx.stepSkipped(e.name, 'Integration planned; not installed');
        if (c.library.listPaths().length) {
          ctx.step('Scanning your games');
          await c.scanLibrary(false).done.catch((e) => failures.push(`Library scan: ${(e as Error).message}`));
        }
        ctx.step('Running a health check');
        await c.runHealthCheck('full').done.catch(() => undefined);
        c.settings.set({ onboardingComplete: true });
        c.ops.addChange('onboarding', null, `Onboarding completed (${ids.length} emulator(s), preset ${plan.preset})`);
        if (failures.length) throw new OmniFailure({ code: 'ONBOARDING_PARTIAL', whatHappened: 'Setup finished with some problems.', detected: failures, userAction: ['Open OmniDoctor or the Emulators page to retry.'] });
      }, { lockKey: 'onboarding' });
      return { jobId: job.id };
    },
    'import.detect': (): Promise<SetupImportCandidate[]> => c.importer.detect(),
    'import.apply': async (id, what) => {
      const r = await c.importer.apply(id, what);
      c.bus.emit('library.changed', { reason: 'import' });
      return r;
    },

    // ------------------------------------------------------------- developer
    // -------------------------------------------------------------- steam
    'steam.status': (userId) => c.steam.status(userId),
    'steam.sync': (opts) => {
      const job = c.jobs.start('steam.sync', 'Adding games to Steam', async (ctx) => {
        const r = await c.steam.sync(opts ?? {}, ctx).catch((err: unknown) => {
          c.notifications.add('error', "Couldn't update Steam shortcuts", err instanceof Error ? err.message : String(err), { link: '/steam' });
          throw err;
        });
        c.notifications.add('success', 'Steam shortcuts updated', `${r.added} added, ${r.updated} updated, ${r.removed} removed, ${r.artwork} image(s). Start Steam to see your games.`, { link: '/steam' });
        c.ops.addChange('steam.sync', null, `Steam shortcuts: ${r.added} added, ${r.updated} updated, ${r.removed} removed`);
        return r;
      }, { lockKey: 'steam' });
      return { jobId: job.id };
    },
    'steam.removeAll': async (opts) => {
      const r = await c.steam.removeAll(opts?.userId);
      c.ops.addChange('steam.removeAll', null, `Removed ${r.removed} OmniPC shortcut(s) from Steam`);
      return r;
    },
    'steam.closeSteam': () => c.steam.closeSteam(),

    'share.status': () => c.share.status(),
    'share.setEnabled': (on) => c.share.setEnabled(!!on),
    'share.setSharing': (partial) => c.share.setSharing(partial && typeof partial === 'object' ? partial : {}),
    'share.openPairing': (minutes) => c.share.openPairing(Number(minutes)),
    'share.closePairing': () => c.share.closePairing(),
    'share.revoke': (deviceId) => c.share.revoke(String(deviceId ?? '')),
    'share.rejectPending': (requestId) => c.share.rejectPending(String(requestId ?? '')),

    'dev.adapterReport': async (id): Promise<DevAdapterReport> => {
      const a = c.registry.require(id);
      const p = a.paths();
      const exe = c.emulators.executableFor(id);
      let latest: DevAdapterReport['latestVersion'] = null;
      if (a.manifest.implemented) {
        try {
          const rel = await sourceForManifest(a.manifest)!.resolveLatest({ channel: c.settings.get('updateChannel'), cpuFeatures: c.hardware()?.cpu.features ?? [] });
          latest = { version: rel.version, url: rel.url, source: rel.sourceLabel };
        } catch (e) {
          latest = { error: (e as Error).message };
        }
      }
      let sample: DevAdapterReport['sampleLaunchCommand'] = null;
      if (a.manifest.implemented) {
        try {
          const cmd = await a.buildLaunch({ gameId: null, path: '<game path>', systemId: a.manifest.systems[0], serial: null, title: 'Sample' }, exe ?? `<${a.manifest.executable}>`, c.emulators.settingsFor(id), null, c.emuRepo.get(id).version);
          sample = { command: cmd.command, args: cmd.args };
        } catch (e) {
          sample = { error: (e as Error).message };
        }
      }
      const logFile = a.logFile();
      const tail = logFile ? await readLogTail(logFile, 32 * 1024) : null;
      return {
        emulatorId: id,
        manifest: a.manifest,
        paths: { ...p, executable: exe ?? '(not installed)', log: logFile ?? '(none)' },
        installedVersion: c.emuRepo.get(id).version,
        latestVersion: latest,
        healthChecks: [await a.smokeTest(exe ?? '').catch((e) => ({ error: (e as Error).message })), await a.inspectConfig().catch((e) => ({ error: (e as Error).message }))],
        sampleLaunchCommand: sample,
        latestLog: logFile && tail ? { path: logFile, excerpt: excerpt(tail, 80) } : null,
      };
    },
  };
}

async function aiPreview(c: AppContainer, question: string, gameId: number | null) {
  const game = gameId !== null ? c.library.getGame(gameId) : undefined;
  const launches = c.launches.history({ gameId: gameId ?? undefined, limit: 8 });
  const lastFailure = launches.find((l) => ['crashed', 'early_exit', 'failed_to_start'].includes(l.outcome));
  const analysis = lastFailure ? await c.doctor.analyzeLaunch(lastFailure.id).catch(() => null) : null;
  const report = c.ops.latestReport();
  const route = gameId !== null ? c.launcher.routeEmulator(gameId).adapter?.manifest.id ?? null : null;
  return buildAiContext({
    question,
    hardware: c.hardware(),
    emulators: c.emulators.list().filter((e) => e.installState !== 'not_installed').map((e) => {
      const s = c.emulators.settingsFor(e.id);
      return { id: e.id, name: e.name, version: e.version, health: e.health, renderer: s.renderer, resolutionScale: s.resolutionScale, customConfig: e.customConfig };
    }),
    game: game ? { title: game.title, system: getSystem(game.system_id)?.name ?? game.system_id, serial: game.serial, emulator: route, compatibility: c.library.getCompatibility(game.id)?.label ?? null, profileOverrides: c.ops.getGameProfile(game.id)?.overrides ?? null } : null,
    recentLaunches: launches.map((l) => ({ at: l.startedAt, outcome: l.outcome, exitCode: l.exitCode, emulator: l.emulatorId })),
    latestFailure: analysis ? { headline: analysis.headline, probableCause: analysis.probableCause, evidence: analysis.evidence, logExcerpt: analysis.technical.logExcerpt } : null,
    recentChanges: c.ops.changes(15).map((ch) => ({ at: ch.at, summary: ch.summary })),
    healthProblems: (report?.findings ?? []).filter((f) => f.severity === 'problem' || f.severity === 'warning').map((f) => f.title).slice(0, 20),
  });
}

