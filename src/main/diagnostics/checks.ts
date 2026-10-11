// OmniDoctor health checks. Every check inspects real state and returns
// findings (including passes, which feed the health score). Checks never
// modify anything; repairs are separate actions with safety levels.

import { existsSync } from 'node:fs';
import { access, constants, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DetectedController, DiagnosticCategory, Finding, HardwareProfile, RepairSuggestion, Severity } from '@shared/models';
import { getSystem } from '@shared/systems';
import type BetterSqlite3 from 'better-sqlite3';
import type { AdapterRegistry } from '../emulators/registry';
import type { EmulatorManager } from '../services/emulatorManager';
import type { EmulatorRepo } from '../database/emulatorRepo';
import type { LibraryRepo } from '../database/libraryRepo';
import type { LaunchRepo } from '../database/launchRepo';
import type { OpsRepo } from '../database/opsRepo';
import type { SettingsRepo } from '../database/settingsRepo';
import type { AppPaths } from '../core/paths';
import { freeSpace } from '../platform/drives';
import { newestBackupAgeHours } from '../database/db';
import type { BiosService } from '../services/biosService';
import type { SaveService } from '../services/saveService';

export interface CheckDeps {
  registry: AdapterRegistry;
  emulators: EmulatorManager;
  emuRepo: EmulatorRepo;
  library: LibraryRepo;
  launches: LaunchRepo;
  ops: OpsRepo;
  settings: SettingsRepo;
  paths: AppPaths;
  db: BetterSqlite3.Database;
  bios: BiosService;
  hardware: () => HardwareProfile | null;
  controllers: () => { pads: DetectedController[]; reportedAt: number | null };
  saves?: SaveService;
}

export interface HealthCheck {
  id: string;
  category: DiagnosticCategory;
  label: string;
  quick: boolean;
  run(d: CheckDeps): Promise<Finding[]>;
}

type FindingInit = Partial<Finding> & { title: string; severity: Severity };

function f(checkId: string, category: DiagnosticCategory, init: FindingInit, subjectKey = ''): Finding {
  return {
    id: `${checkId}${subjectKey ? ':' + subjectKey : ''}`,
    checkId,
    category,
    severity: init.severity,
    title: init.title,
    detail: init.detail ?? '',
    subject: init.subject ?? null,
    evidence: init.evidence ?? [],
    confidence: init.confidence ?? (init.severity === 'pass' ? null : 'high'),
    repair: init.repair ?? null,
    manualSteps: init.manualSteps ?? [],
    ruleId: init.ruleId,
  };
}

function repair(actionId: string, label: string, safety: RepairSuggestion['safety'], params: Record<string, unknown>, description: string): RepairSuggestion {
  return { actionId, label, safety, params, description };
}

const GB = 1024 ** 3;

export const CHECKS: HealthCheck[] = [
  {
    id: 'windows.version',
    category: 'windows',
    label: 'Windows version',
    quick: true,
    async run(d) {
      const hw = d.hardware();
      if (!hw) return [f(this.id, this.category, { severity: 'warning', title: 'Computer has not been scanned', detail: 'Run the computer scan so OmniPC can tailor settings to your hardware.', repair: repair('hardware.scan', 'Scan this PC', 'safe', {}, 'Reads CPU, GPU, RAM, displays and drives.'), confidence: 'high' })];
      if (!hw.isWindows) return [f(this.id, this.category, { severity: 'warning', title: `Running on ${hw.osName}`, detail: 'OmniPC targets Windows 10/11 x64. Emulator installation and launching only work on Windows.' })];
      const build = Number(hw.osBuild ?? 0);
      if (build && build < 19041) return [f(this.id, this.category, { severity: 'warning', title: `Windows build ${build} is old`, detail: 'Windows 10 version 2004 (build 19041) or newer is recommended. Newer emulator builds may not start.', evidence: [hw.osName] })];
      return [f(this.id, this.category, { severity: 'pass', title: `${hw.osName} (build ${hw.osBuild ?? '?'})` })];
    },
  },
  {
    id: 'graphics.apis',
    category: 'graphics',
    label: 'Graphics APIs',
    quick: true,
    async run(d) {
      const hw = d.hardware();
      if (!hw?.isWindows) return [];
      const out: Finding[] = [];
      if (!hw.gpus.length) out.push(f('graphics.gpu', this.category, { severity: 'problem', title: 'No graphics adapter detected', detail: 'Windows reports no usable GPU driver (only a basic display adapter). Emulators need a proper GPU driver.', manualSteps: ['Install the driver from NVIDIA, AMD or Intel.'] }));
      else out.push(f('graphics.gpu', this.category, { severity: 'pass', title: hw.gpus.map((g) => g.name).join(', '), evidence: hw.gpus.map((g) => `${g.name}: driver ${g.driverVersion ?? '?'}, VRAM ${g.vramMB ?? '?'} MB`) }));
      out.push(f('graphics.d3d12', this.category, hw.graphicsApis.directx12 ? { severity: 'pass', title: 'Direct3D 12 available' } : { severity: 'warning', title: 'Direct3D 12 not available', detail: 'd3d12.dll was not found. Direct3D 11 or Vulkan will be used instead.' }));
      // Vulkan matters only if an emulator is configured to use it.
      const usesVulkan = d.registry.implemented().filter((a) => d.emulators.isInstalled(a.manifest.id) && d.emulators.settingsFor(a.manifest.id).renderer === 'vulkan');
      if (hw.graphicsApis.vulkan) out.push(f('graphics.vulkan', this.category, { severity: 'pass', title: 'Vulkan available' }));
      else out.push(f('graphics.vulkan', this.category, {
        severity: usesVulkan.length ? 'problem' : 'info',
        title: usesVulkan.length ? `Vulkan is selected for ${usesVulkan.map((a) => a.manifest.name).join(', ')} but not installed` : 'Vulkan not available',
        detail: 'vulkan-1.dll was not found in System32.',
        repair: usesVulkan.length ? repair('emulator.setRenderer', 'Switch to Direct3D 11', 'low', { emulatorId: usesVulkan[0].manifest.id, renderer: 'd3d11' }, 'Changes the renderer in the emulator configuration (backup first).') : null,
      }));
      return out;
    },
  },
  {
    id: 'dependencies.runtime',
    category: 'dependencies',
    label: 'Runtime dependencies',
    quick: true,
    async run(d) {
      const hw = d.hardware();
      if (!hw?.isWindows) return [];
      return hw.dependencies.filter((x) => x.id === 'vcredist-x64').map((dep) =>
        f(this.id, this.category, dep.installed
          ? { severity: 'pass', title: `${dep.name} ${dep.version ?? ''}`.trim() }
          : { severity: dep.installed === false ? 'problem' : 'warning', title: `${dep.name} missing or outdated`, detail: dep.detail, repair: repair('dependency.vcredist', 'Install Visual C++ runtime', 'high', {}, 'Downloads the official installer from Microsoft (aka.ms), verifies its Microsoft signature and runs it. Windows will ask for administrator permission.'), manualSteps: dep.fixUrl ? [`Download from ${dep.fixUrl}`] : [] }, dep.id));
    },
  },
  {
    id: 'storage.locations',
    category: 'storage',
    label: 'OmniPC folders',
    quick: true,
    async run(d) {
      const out: Finding[] = [];
      const locs: [string, string][] = [['Emulators', d.paths.emulators], ['Saves', d.paths.saves], ['BIOS', d.paths.bios], ['Cache', d.paths.cache], ['Backups', d.paths.backups], ['Artwork', d.paths.artwork], ['Logs', d.paths.logs]];
      const missing = locs.filter(([, p]) => !existsSync(p));
      if (missing.length) out.push(f(this.id, this.category, { severity: 'warning', title: `${missing.length} OmniPC folder(s) missing`, detail: missing.map(([n, p]) => `${n}: ${p}`).join('\n'), evidence: missing.map(([, p]) => p), repair: repair('folders.recreate', 'Recreate folders', 'safe', {}, 'Creates the missing empty folders.') }, 'missing'));
      else out.push(f(this.id, this.category, { severity: 'pass', title: 'All OmniPC folders exist' }, 'missing'));
      for (const [name, p] of locs.filter(([, p]) => existsSync(p))) {
        const probe = join(p, `.omnideck-write-test-${process.pid}`);
        try {
          await writeFile(probe, 'ok');
          await rm(probe, { force: true });
        } catch (e) {
          out.push(f('storage.writable', this.category, { severity: 'problem', title: `Cannot write to the ${name} folder`, detail: `${p}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`, evidence: [p], manualSteps: ['Check folder permissions and that the drive is not read-only.', 'If you use Controlled Folder Access (Windows Security), allow OmniPC.'], confidence: 'high' }, name));
        }
      }
      const free = await freeSpace(d.paths.root);
      if (free !== null) {
        if (free < 2 * GB) out.push(f('storage.free', this.category, { severity: 'problem', title: `Only ${(free / GB).toFixed(1)} GB free on the OmniPC drive`, detail: 'Installs, updates, shader caches and save states may fail.', evidence: [d.paths.root], manualSteps: ['Free up space or move OmniPC storage in Settings > Storage.'] }));
        else if (free < 10 * GB) out.push(f('storage.free', this.category, { severity: 'warning', title: `${(free / GB).toFixed(1)} GB free on the OmniPC drive`, detail: 'Consider freeing space; emulator updates and shader caches need room.' }));
        else out.push(f('storage.free', this.category, { severity: 'pass', title: `${(free / GB).toFixed(0)} GB free on the OmniPC drive` }));
      }
      return out;
    },
  },
  {
    id: 'library.paths',
    category: 'library',
    label: 'Game folders',
    quick: true,
    async run(d) {
      const out: Finding[] = [];
      const paths = d.library.listPaths();
      if (!paths.length) return [f(this.id, this.category, { severity: 'info', title: 'No game folders added yet', detail: 'Add the folder where your games are stored in Library > Game folders.' }, 'none')];
      for (const p of paths) {
        if (existsSync(p.path)) {
          try {
            await access(p.path, constants.R_OK);
            out.push(f(this.id, this.category, { severity: 'pass', title: `${p.path} (${p.gameCount} games)` }, String(p.id)));
          } catch {
            out.push(f(this.id, this.category, { severity: 'problem', title: `Game folder is not readable: ${p.path}`, subject: { kind: 'path', id: String(p.id), label: p.path }, manualSteps: ['Check folder permissions.'] }, String(p.id)));
          }
        } else {
          out.push(f(this.id, this.category, {
            severity: 'warning',
            title: `Game drive unavailable: ${p.path}`,
            detail: `${p.gameCount} game(s) are kept in your library and will become available again automatically when the drive is reconnected.`,
            subject: { kind: 'path', id: String(p.id), label: p.path },
            repair: repair('library.remapPaths', 'Look for the drive again', 'safe', {}, 'Re-checks connected drives, including drives that came back with a different letter.'),
          }, String(p.id)));
        }
      }
      return out;
    },
  },
  {
    id: 'library.files',
    category: 'library',
    label: 'Game file validation',
    quick: false,
    async run(d) {
      const rows = d.db.prepare("SELECT g.id, g.title, f.path, f.validation, f.validation_note FROM game_files f JOIN games g ON g.id = f.game_id WHERE f.validation = 'invalid' AND g.availability = 'available' LIMIT 50").all() as { id: number; title: string; path: string; validation: string; validation_note: string | null }[];
      if (!rows.length) return [f(this.id, this.category, { severity: 'pass', title: 'No invalid game files detected' })];
      return [f(this.id, this.category, {
        severity: 'warning',
        title: `${rows.length} game file(s) look damaged or incomplete`,
        detail: 'These files failed basic validation (empty, unreadable, unfinished downloads or missing tracks). This is a game file problem, not an emulator problem.',
        evidence: rows.slice(0, 10).map((r) => `${r.title}: ${r.validation_note ?? r.path}`),
        repair: { actionId: 'game.revalidateAll', label: 'Check these games again', safety: 'safe', params: {}, description: 'Re-runs the file checks for every game with a problem.' },
        manualSteps: ['Open OmniDoctor > Games to see each game and the fixes OmniPC can apply.', 'Re-copy or re-dump games OmniPC cannot fix. OmniPC never deletes game files.'],
      })];
    },
  },
  {
    id: 'bios.status',
    category: 'bios',
    label: 'BIOS & firmware',
    quick: true,
    async run(d) {
      const out: Finding[] = [];
      const counts = d.library.countBySystem();
      for (const s of await d.bios.status()) {
        const relevant = s.required && (d.emulators.isInstalled(s.emulatorId) || (counts[s.systemId] ?? 0) > 0);
        if (!relevant && s.status !== 'invalid') continue;
        const subject = { kind: 'system' as const, id: s.systemId, label: s.systemName };
        if (s.status === 'found') out.push(f(this.id, this.category, { severity: 'pass', title: `${s.label}: found`, evidence: s.files.filter((x) => x.valid).map((x) => `${x.path} — ${x.description}`), subject }, s.systemId));
        else if (s.status === 'invalid') out.push(f(this.id, this.category, { severity: s.required ? 'problem' : 'warning', title: `${s.label}: file(s) present but not valid`, detail: s.files.map((x) => `${x.path}: ${x.description}`).join('\n'), subject, manualSteps: ['Re-dump the BIOS from your own console.'] }, s.systemId));
        else if (s.status === 'missing') out.push(f(this.id, this.category, {
          // A missing BIOS only blocks play once the system's emulator integration exists.
          severity: d.registry.get(s.emulatorId)?.manifest.implemented ? 'problem' : 'warning',
          title: `${s.label} missing`,
          // The adapter's note says where this particular file comes from (e.g. PS3 firmware from Sony).
          detail: `${getSystem(s.systemId)?.name} games cannot start without it. ${s.note || 'OmniPC cannot download BIOS files; you must supply one dumped from your own console.'}`,
          subject,
          evidence: [`Expected in ${s.expectedLocation}`],
          manualSteps: ['Open Emulators > BIOS & Firmware and click "Scan my game folders" or "Scan a folder…" to find and copy your BIOS/firmware/key files, or use "Import file…".'],
        }, s.systemId));
      }
      return out;
    },
  },
  {
    id: 'emulators.install',
    category: 'emulators',
    label: 'Emulator installations',
    quick: true,
    async run(d) {
      const out: Finding[] = [];
      for (const a of d.registry.implemented()) {
        const id = a.manifest.id;
        const st = d.emulators.status(id);
        if (st.installState === 'not_installed') continue;
        const subject = { kind: 'emulator' as const, id, label: a.manifest.name };
        const exe = st.executable;
        if (!exe || !existsSync(exe)) {
          const appDirExists = existsSync(a.paths().app);
          out.push(f(this.id, this.category, {
            severity: 'problem',
            title: `${a.manifest.name} executable is missing`,
            detail: appDirExists ? 'The program folder exists but the executable is gone. Security software sometimes quarantines emulator executables.' : 'The program folder is missing.',
            subject,
            evidence: [exe ?? 'no executable recorded'],
            confidence: appDirExists ? 'medium' : 'high',
            repair: st.installState === 'installed' ? repair('emulator.reinstall', `Reinstall ${a.manifest.name}`, 'high', { emulatorId: id }, 'Downloads and reinstalls the emulator. Settings and saves are kept.') : null,
            manualSteps: appDirExists ? ['Check your antivirus quarantine for the emulator executable.'] : [],
          }, id));
          continue;
        }
        if (st.health === 'error') {
          out.push(f(this.id, this.category, { severity: 'problem', title: `${a.manifest.name} failed its last health test`, detail: st.healthNote ?? '', subject, evidence: st.healthNote ? [st.healthNote] : [], repair: repair('emulator.repair', `Repair ${a.manifest.name}`, 'low', { emulatorId: id }, 'Recreates folders, re-applies OmniPC settings (with backup) and re-tests.') }, id));
        } else {
          out.push(f(this.id, this.category, { severity: 'pass', title: `${a.manifest.name} ${st.version ?? ''} installed`.trim(), subject }, id));
        }
        out.push(...(await a.validateEnvironment(d.hardware(), exe)));
      }
      return out;
    },
  },
  {
    id: 'emulators.config',
    category: 'configuration',
    label: 'Emulator configuration',
    quick: true,
    async run(d) {
      const out: Finding[] = [];
      for (const a of d.registry.implemented()) {
        const id = a.manifest.id;
        if (!d.emulators.isInstalled(id)) continue;
        const subject = { kind: 'emulator' as const, id, label: a.manifest.name };
        const custom = d.emuRepo.getCustom(id);
        const insp = await a.inspectConfig();
        const missing = insp.files.filter((x) => !x.exists);
        const broken = insp.files.filter((x) => x.exists && !x.parseOk);
        if (missing.length) out.push(f(this.id, this.category, { severity: 'problem', title: `${a.manifest.name}: ${missing.length} configuration file(s) missing`, subject, evidence: missing.map((x) => x.path), repair: repair('emulator.regenerateConfig', 'Regenerate configuration', 'low', { emulatorId: id, scope: 'all' }, 'Creates the recommended configuration (existing files are backed up first).') }, `${id}:missing`));
        if (broken.length) out.push(f(this.id, this.category, { severity: 'problem', title: `${a.manifest.name}: configuration file is malformed`, detail: 'The emulator may ignore or reset these settings.', subject, evidence: broken.flatMap((x) => x.issues.slice(0, 5).map((i) => `${x.label}: ${i}`)), repair: repair('config.repairFormat', 'Repair file format', 'low', { emulatorId: id }, 'Backs up the file, removes unparseable lines and merges duplicate sections.') }, `${id}:format`));
        if (insp.drift.length) {
          if (custom.customConfigActive) out.push(f(this.id, this.category, { severity: 'info', title: `${a.manifest.name}: custom configuration active`, detail: `${insp.drift.length} value(s) differ from OmniPC's defaults. Treated as intentional.`, subject, evidence: insp.drift.map((x) => `${x.key}: ${x.actual ?? '(unset)'} (OmniPC: ${x.expected})`) }, `${id}:drift`));
          else out.push(f(this.id, this.category, {
            severity: insp.drift.some((x) => x.critical) ? 'problem' : 'warning',
            title: `${a.manifest.name}: folder settings point to the wrong place`,
            detail: 'BIOS, save or cache folders in the emulator configuration no longer match OmniPC. Saves may be written somewhere unexpected.',
            subject,
            evidence: insp.drift.map((x) => `${x.key} = ${x.actual ?? '(unset)'}; expected ${x.expected}`),
            repair: repair('emulator.regenerateConfig', 'Correct folder paths', 'low', { emulatorId: id, scope: 'paths' }, 'Rewrites only the folder paths (backup first).'),
          }, `${id}:drift`));
        }
        if (!missing.length && !broken.length && !insp.drift.length) out.push(f(this.id, this.category, { severity: 'pass', title: `${a.manifest.name} configuration OK`, subject }, `${id}:ok`));
        const journal = insp.files.find((x) => existsSync(`${x.path}.omnideck-session`));
        if (journal) out.push(f(this.id, this.category, { severity: 'warning', title: `${a.manifest.name}: a per-game session override was not restored`, detail: 'OmniPC closed while a game with a custom profile was running.', subject, repair: repair('emulator.recoverSession', 'Restore global settings', 'safe', { emulatorId: id }, 'Restores the configuration saved before the session.') }, `${id}:session`));
      }
      return out;
    },
  },
  {
    id: 'emulators.regression',
    category: 'emulators',
    label: 'Problems after updates',
    quick: true,
    async run(d) {
      const out: Finding[] = [];
      for (const a of d.registry.implemented()) {
        const id = a.manifest.id;
        const update = d.ops.changes(20, id).find((c) => c.kind === 'emulator.updated');
        if (!update) continue;
        const after = d.launches.outcomesSince(id, update.at).filter((l) => l.gameId !== null);
        const failures = after.filter((l) => ['crashed', 'early_exit', 'failed_to_start'].includes(l.outcome));
        const successes = after.filter((l) => l.outcome === 'ok');
        const before = d.launches.lastSuccessBefore(id, update.at);
        if (failures.length >= 2 && successes.length === 0 && before) {
          const st = d.emulators.status(id);
          out.push(f(this.id, this.category, {
            severity: 'problem',
            title: `${a.manifest.name} games started failing after the update`,
            detail: `${update.summary}. Since then ${failures.length} launch(es) failed and none succeeded; the last successful launch was before the update.`,
            subject: { kind: 'emulator', id, label: a.manifest.name },
            evidence: [`Update recorded ${update.at}`, `Last success before update: ${before.startedAt}`, ...failures.slice(0, 3).map((l) => `${l.startedAt}: ${l.outcome} (exit ${l.exitCode ?? '?'})`)],
            confidence: failures.length >= 3 ? 'high' : 'medium',
            repair: st.rollbackVersion ? repair('emulator.rollback', `Restore ${a.manifest.name} ${st.rollbackVersion}`, 'high', { emulatorId: id }, 'Restores the previous version and the configuration from before the update.') : null,
          }, id));
        }
      }
      return out;
    },
  },
  {
    id: 'controllers.detected',
    category: 'controllers',
    label: 'Controllers',
    quick: true,
    async run(d) {
      const { pads, reportedAt } = d.controllers();
      const profile = d.ops.getControllerProfile();
      if (reportedAt === null) return [f(this.id, this.category, { severity: 'info', title: 'Controller status not reported yet', detail: 'Open the Controllers page or press a button on your controller.' })];
      if (!pads.length) {
        const known = d.ops.knownControllers();
        return [f(this.id, this.category, {
          severity: known.length ? 'warning' : 'info',
          title: known.length ? 'Your controller is disconnected' : 'No controller detected',
          detail: known.length ? `Last seen: ${known[0].name}. Reconnect it or press a button to wake it.` : 'Connect a controller by USB or Bluetooth. Games also work with keyboard defaults inside each emulator.',
          manualSteps: ['Wireless controllers: press the Guide/PS button to wake them.', 'Check Bluetooth settings if pairing was lost.'],
        })];
      }
      const out = [f(this.id, this.category, { severity: 'pass', title: `${pads.length} controller(s) connected`, evidence: pads.map((p) => `${p.name} (${p.api}, ${p.connection})`) })];
      if (profile && profile.deviceIndex >= pads.length) out.push(f('controllers.profile', this.category, { severity: 'warning', title: 'Player 1 is mapped to a controller slot that is not connected', detail: `The universal profile uses device ${profile.deviceIndex + 1}, but only ${pads.length} controller(s) are connected.`, repair: repair('controller.reapply', 'Re-detect and rebuild mapping', 'low', { deviceIndex: 0 }, 'Sets Player 1 to the first connected controller and re-applies bindings to all emulators (backup first).') }));
      const kind = pads[0].kind;
      if (profile && profile.controllerKind !== kind && pads.length === 1) out.push(f('controllers.kind', this.category, { severity: 'info', title: `Connected controller (${pads[0].name}) differs from the profile (${profile.controllerKind})`, detail: 'Some emulators name controllers by type; re-applying the profile updates them.', repair: repair('controller.reapply', 'Re-apply controller profile', 'low', { controllerKind: kind }, 'Updates emulator controller bindings for the connected controller.') }));
      return out;
    },
  },
  {
    id: 'saves.locations',
    category: 'saves',
    label: 'Save folders',
    quick: true,
    async run(d) {
      const out: Finding[] = [];
      for (const a of d.registry.implemented()) {
        if (!d.emulators.isInstalled(a.manifest.id)) continue;
        const missing = a.saveLocations().filter((s) => !existsSync(s.path));
        if (missing.length) out.push(f(this.id, this.category, { severity: 'warning', title: `${a.manifest.name}: ${missing.length} save folder(s) missing`, evidence: missing.map((m) => m.path), subject: { kind: 'emulator', id: a.manifest.id, label: a.manifest.name }, repair: repair('folders.recreate', 'Recreate save folders', 'safe', { emulatorId: a.manifest.id }, 'Creates the missing empty folders. Existing saves are never touched.') }, a.manifest.id));
        else out.push(f(this.id, this.category, { severity: 'pass', title: `${a.manifest.name} save folders OK` }, a.manifest.id));
      }
      return out;
    },
  },
  {
    id: 'saves.backups',
    category: 'saves',
    label: 'Save backups',
    quick: true,
    async run(d) {
      if (!d.saves) return [];
      const out: Finding[] = [];
      const dest = await d.saves.destinationStatus();
      if (dest.destination && dest.problem) {
        out.push(f('saves.backupFolder', this.category, { severity: 'warning', title: 'Save backup folder is unavailable', detail: dest.problem, evidence: [dest.destination], manualSteps: ['Reconnect the drive or start your cloud app (OneDrive, Google Drive, Dropbox), or choose another folder under Settings > Save backups.'] }));
      } else if (dest.destination) {
        out.push(f('saves.backupFolder', this.category, { severity: 'pass', title: 'Save backup folder is available' }));
      }
      const status = await d.saves.protectionStatus();
      if (!status.length) return out;
      const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
      const stale = status.filter((s) => !s.upToDate && (!s.lastBackupAt || Date.parse(s.lastBackupAt) < cutoff));
      if (stale.length) {
        out.push(f(this.id, this.category, {
          severity: 'warning',
          title: `No save backup in the last 14 days (${stale.map((s) => s.name).join(', ')})`,
          detail: 'These emulators have saves that changed since their last backup, and that backup is more than 14 days old (or there is none).',
          evidence: stale.map((s) => `${s.name}: last backup ${s.lastBackupAt ?? 'never'}`),
          repair: repair('saves.backupAll', 'Back up saves now', 'safe', {}, 'Creates a ZIP backup of every emulator\'s saves. Nothing is overwritten or deleted.'),
        }));
      } else {
        out.push(f(this.id, this.category, { severity: 'pass', title: 'Saves are backed up' }));
      }
      return out;
    },
  },
  {
    id: 'database.integrity',
    category: 'database',
    label: 'OmniPC database',
    quick: false,
    async run(d) {
      const out: Finding[] = [];
      const res = d.db.pragma('quick_check', { simple: true });
      out.push(f(this.id, this.category, res === 'ok' ? { severity: 'pass', title: 'Database integrity OK' } : { severity: 'problem', title: 'Database integrity check failed', evidence: [String(res)], repair: repair('database.reindex', 'Rebuild indexes', 'safe', {}, 'Rebuilds database indexes. If that fails OmniPC restores the newest backup on next start.') }));
      const age = newestBackupAgeHours(d.paths.databaseBackups);
      if (age === null || age > 72) out.push(f('database.backup', this.category, { severity: 'info', title: age === null ? 'No database backup yet' : `Last database backup ${Math.round(age)} hours ago`, repair: repair('database.backup', 'Back up now', 'safe', {}, 'Creates a database backup (keeps the newest 7).') }));
      else out.push(f('database.backup', this.category, { severity: 'pass', title: `Database backed up ${Math.round(age)} hour(s) ago` }));
      return out;
    },
  },
  {
    id: 'metadata.coverage',
    category: 'metadata',
    label: 'Game metadata',
    quick: false,
    async run(d) {
      const total = d.library.countGames();
      if (!total) return [];
      const missing = d.library.gamesNeedingMetadata(100000).length;
      if (missing === 0) return [f(this.id, this.category, { severity: 'pass', title: 'Metadata cached for all games' })];
      return [f(this.id, this.category, { severity: 'info', title: `${missing} of ${total} games have no metadata yet`, repair: repair('metadata.refreshAll', 'Fetch metadata', 'safe', {}, 'Looks up titles and artwork using the enabled metadata providers.') })];
    },
  },
  {
    id: 'launch.crashloops',
    category: 'emulators',
    label: 'Crash-loop protection',
    quick: true,
    async run(d) {
      const rows = d.db.prepare('SELECT id, title, consecutive_failures FROM games WHERE crash_loop_paused = 1').all() as { id: number; title: string; consecutive_failures: number }[];
      return rows.map((r) => f(this.id, this.category, {
        severity: 'warning',
        title: `${r.title}: automatic launching paused after ${r.consecutive_failures} failures`,
        subject: { kind: 'game', id: String(r.id), label: r.title },
        repair: repair('launch.resetCrashLoop', 'Allow launching again', 'safe', { gameId: r.id }, 'Clears the crash-loop pause for this game.'),
      }, String(r.id)));
    },
  },
  {
    id: 'updates.available',
    category: 'updates',
    label: 'Updates',
    quick: true,
    async run(d) {
      const ups = d.emulators.list().filter((s) => s.updateAvailable);
      if (!ups.length) return [f(this.id, this.category, { severity: 'pass', title: 'Installed emulators are up to date (as of the last check)' })];
      return ups.map((u) => f(this.id, this.category, { severity: 'info', title: `${u.name} ${u.latestVersion} is available (installed ${u.version})`, subject: { kind: 'emulator', id: u.id, label: u.name }, repair: repair('emulator.update', `Update ${u.name}`, 'low', { emulatorId: u.id }, 'Backs up configuration, updates, runs a health test, and keeps the old version for rollback.') }, u.id));
    },
  },
];

export async function ensureDir(p: string): Promise<void> {
  await mkdir(p, { recursive: true });
}
