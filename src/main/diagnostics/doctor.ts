// OmniDoctor engine: runs checks, computes the health score from real results,
// stores reports, and explains launch failures with evidence and confidence.

import { existsSync } from 'node:fs';
import type { CategoryScore, ChangeEvent, Confidence, DiagnosticCategory, FailureAnalysis, Finding, HealthReport, RepairSuggestion } from '@shared/models';
import { CHECKS, type CheckDeps, type HealthCheck } from './checks';
import { matchRules, type RuleMatch } from './rules';
import { excerpt, readLogSince } from './logs';
import { WINDOWS_EXIT_CODES, normaliseExitCode } from '../emulators/common';
import { logger } from '../core/logger';
import type { EventBus } from '../core/events';

const log = logger.scope('doctor');

export const CATEGORY_LABELS: Record<DiagnosticCategory, string> = {
  windows: 'Windows',
  graphics: 'Graphics',
  dependencies: 'Dependencies',
  controllers: 'Controllers',
  storage: 'Storage',
  library: 'Game library',
  bios: 'BIOS & firmware',
  emulators: 'Emulators',
  configuration: 'Configuration',
  saves: 'Save storage',
  database: 'Database',
  metadata: 'Metadata',
  updates: 'Updates',
};

const SEVERITY_WEIGHT = { pass: 1, info: 1, warning: 0.6, problem: 0 } as const;

/** Health score: per-category mean of finding weights; overall = mean of categories. */
export function scoreFindings(findings: Finding[]): { overall: number; categories: CategoryScore[] } {
  const byCat = new Map<DiagnosticCategory, Finding[]>();
  for (const x of findings) {
    if (!byCat.has(x.category)) byCat.set(x.category, []);
    byCat.get(x.category)!.push(x);
  }
  const categories: CategoryScore[] = [];
  for (const [category, list] of byCat) {
    const scored = list.filter((x) => x.severity !== 'info');
    const score = scored.length ? Math.round((scored.reduce((s, x) => s + SEVERITY_WEIGHT[x.severity], 0) / scored.length) * 100) : 100;
    categories.push({
      category,
      label: CATEGORY_LABELS[category],
      score,
      passed: list.filter((x) => x.severity === 'pass' || x.severity === 'info').length,
      warnings: list.filter((x) => x.severity === 'warning').length,
      problems: list.filter((x) => x.severity === 'problem').length,
    });
  }
  categories.sort((a, b) => a.score - b.score || a.label.localeCompare(b.label));
  const overall = categories.length ? Math.round(categories.reduce((s, c) => s + c.score, 0) / categories.length) : 100;
  return { overall, categories };
}

export interface DoctorDeps extends CheckDeps {
  bus: EventBus;
}

export class OmniDoctor {
  constructor(private readonly d: DoctorDeps, private readonly checks: HealthCheck[] = CHECKS) {}

  async run(scope: 'full' | 'quick', onProgress?: (fraction: number, label: string) => void): Promise<HealthReport> {
    const started = Date.now();
    const findings: Finding[] = [];
    const list = this.checks.filter((c) => scope === 'full' || c.quick);
    let i = 0;
    for (const c of list) {
      onProgress?.(i / list.length, c.label);
      try {
        findings.push(...(await c.run(this.d)));
      } catch (err) {
        log.error(`check ${c.id} crashed`, err);
        findings.push({ id: `${c.id}:error`, checkId: c.id, category: c.category, severity: 'warning', title: `${c.label}: check could not complete`, detail: (err as Error).message, subject: null, evidence: [], confidence: null, repair: null, manualSteps: [] });
      }
      i++;
    }
    const { overall, categories } = scoreFindings(findings);
    const report = this.d.ops.saveReport({
      runAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      scope,
      overall,
      categories,
      findings: findings.sort((a, b) => order(a.severity) - order(b.severity)),
      counts: {
        passed: findings.filter((x) => x.severity === 'pass').length,
        info: findings.filter((x) => x.severity === 'info').length,
        warnings: findings.filter((x) => x.severity === 'warning').length,
        problems: findings.filter((x) => x.severity === 'problem').length,
      },
    });
    this.d.bus.emit('doctor.report', report);
    log.info('health check complete', { scope, overall, counts: report.counts });
    return report;
  }

  /** Runs only the checks relevant to one emulator (used by the Emulator page). */
  async runForEmulator(emulatorId: string): Promise<HealthReport> {
    const ids = ['emulators.install', 'emulators.config', 'emulators.regression', 'bios.status', 'saves.locations'];
    const findings: Finding[] = [];
    for (const c of this.checks.filter((x) => ids.includes(x.id))) {
      const res = await c.run(this.d).catch(() => [] as Finding[]);
      findings.push(...res.filter((x) => !x.subject || x.subject.id === emulatorId || (x.subject.kind === 'system' && this.d.registry.get(emulatorId)?.manifest.systems.includes(x.subject.id as never))));
    }
    const smoke = await this.d.emulators.healthTest(emulatorId).catch(() => null);
    if (smoke) for (const c of smoke.checks) findings.push({ id: `smoke:${emulatorId}:${c.label}`, checkId: 'emulators.smoke', category: 'emulators', severity: c.ok ? 'pass' : 'problem', title: `${c.label}`, detail: c.detail, subject: { kind: 'emulator', id: emulatorId, label: emulatorId }, evidence: [c.detail], confidence: c.ok ? null : 'high', repair: c.ok ? null : { actionId: 'emulator.repair', label: 'Repair', safety: 'low', params: { emulatorId }, description: 'Re-applies configuration and re-tests.' }, manualSteps: [] });
    const { overall, categories } = scoreFindings(findings);
    return this.d.ops.saveReport({ runAt: new Date().toISOString(), durationMs: 0, scope: 'emulator', overall, categories, findings, counts: { passed: findings.filter((x) => x.severity === 'pass').length, info: findings.filter((x) => x.severity === 'info').length, warnings: findings.filter((x) => x.severity === 'warning').length, problems: findings.filter((x) => x.severity === 'problem').length } });
  }

  /**
   * Explains why a launch failed. Combines rule matches on the session's log
   * excerpt/stderr/exit code with targeted state checks and recent changes.
   * Confidence is only "high" when concrete evidence supports it.
   */
  async analyzeLaunch(launchId: number): Promise<FailureAnalysis> {
    const rec = this.d.launches.get(launchId);
    if (!rec) throw new Error(`Launch ${launchId} not found`);
    const adapter = this.d.registry.require(rec.emulatorId);
    const game = rec.gameId !== null ? this.d.library.getGame(rec.gameId) : undefined;
    const files = rec.gameId !== null ? this.d.library.filesForGame(rec.gameId) : [];
    const { logPath, logOffset } = this.d.launches.logInfo(launchId);
    const logText = logPath ? await readLogSince(logPath, logOffset) : null;
    const exitCode = normaliseExitCode(rec.exitCode);
    const text = [logText ?? '', rec.stderrTail ?? ''].join('\n');
    const matches = matchRules({ emulatorId: rec.emulatorId, exitCode, text });
    const findings: Finding[] = matches.map((m) => ruleFinding(m, rec.emulatorId, rec.gameId));
    const detected: string[] = [];
    const seconds = rec.durationMs !== null ? Math.round(rec.durationMs / 1000) : null;
    const name = adapter.manifest.name;
    const exitInfo = exitCode !== null ? WINDOWS_EXIT_CODES[exitCode] : undefined;
    if (rec.outcome === 'failed_to_start') detected.push(`${name} could not be started.`);
    else detected.push(`${name} exited ${seconds !== null ? `${seconds} second${seconds === 1 ? '' : 's'} after launch` : ''} with exit code ${exitCode ?? 'unknown'}${exitInfo ? ` — ${exitInfo.name}` : ''}.`);
    if (exitInfo) detected.push(exitInfo.meaning);

    // Targeted state checks with explicit evidence.
    const exe = this.d.emulators.executableFor(rec.emulatorId);
    if (!exe || !existsSync(exe)) findings.push(stateFinding('launch.exe', 'emulators', `${name} executable is missing`, `Expected at ${exe ?? '(not recorded)'}`, 'high', { actionId: 'emulator.reinstall', label: `Reinstall ${name}`, safety: 'high', params: { emulatorId: rec.emulatorId }, description: 'Reinstalls the emulator; settings and saves are kept.' }));
    for (const f of files) {
      if (!existsSync(f.path)) findings.push(stateFinding('launch.file', 'library', 'The game file is not available', `${f.path} does not exist (drive disconnected or file moved).`, 'high', { actionId: 'library.remapPaths', label: 'Look for the drive again', safety: 'safe', params: {}, description: 'Re-checks drives, including changed drive letters.' }));
      else if (f.validation === 'invalid') findings.push(stateFinding('launch.file', 'library', 'The game file looks damaged', f.validation_note ?? 'Failed validation', 'medium', null, ['This is a problem with the game file itself, not with the emulator. Re-copy or re-dump it.']));
    }
    if (game) {
      for (const b of await this.d.bios.status()) {
        if (b.systemId === game.system_id && b.required && b.status !== 'found') findings.push(stateFinding('launch.bios', 'bios', `${b.label} is ${b.status === 'missing' ? 'missing' : 'not valid'}`, `Checked ${b.expectedLocation}`, 'high', null, ['Import a BIOS dumped from your own console in Settings > BIOS & Firmware. OmniDeck cannot download BIOS files.']));
      }
    }
    const settings = this.d.emulators.settingsFor(rec.emulatorId);
    const profile = rec.gameId !== null ? this.d.ops.getGameProfile(rec.gameId) : null;
    const renderer = (profile?.overrides.renderer as string | undefined) ?? settings.renderer;
    const hw = this.d.hardware();
    if (hw?.isWindows && renderer === 'vulkan' && hw.graphicsApis.vulkan === false) findings.push(stateFinding('launch.renderer', 'graphics', 'Vulkan renderer selected but Vulkan is not installed', 'vulkan-1.dll is not present in System32.', 'high', { actionId: 'emulator.setRenderer', label: 'Switch this game to Direct3D 11', safety: 'low', params: { emulatorId: rec.emulatorId, gameId: rec.gameId, renderer: 'd3d11' }, description: 'Sets a per-game renderer override.' }));
    const insp = await adapter.inspectConfig().catch(() => null);
    for (const cf of insp?.files ?? []) if (cf.exists && !cf.parseOk) findings.push(stateFinding('launch.config', 'configuration', `${cf.label} is malformed`, cf.issues.slice(0, 3).join('; '), 'medium', { actionId: 'config.repairFormat', label: 'Repair configuration file', safety: 'low', params: { emulatorId: rec.emulatorId }, description: 'Backs up and repairs the file.' }));

    // Renderer-failure rules: make the suggested renderer different from the current one and scope it to this game.
    for (const fd of findings) {
      if (fd.repair?.actionId === 'emulator.setRenderer') {
        fd.repair = { ...fd.repair, params: { emulatorId: rec.emulatorId, gameId: rec.gameId, ...fd.repair.params, ...(fd.repair.params.renderer === renderer ? { renderer: renderer === 'd3d11' ? 'vulkan' : 'd3d11' } : {}) } };
        fd.repair.label = `${fd.repair.label.replace(/Switch to .*/, `Switch this game to ${fd.repair.params.renderer === 'd3d11' ? 'Direct3D 11' : fd.repair.params.renderer === 'vulkan' ? 'Vulkan' : String(fd.repair.params.renderer)}`)}`;
      }
      if (fd.repair && !('emulatorId' in fd.repair.params)) fd.repair = { ...fd.repair, params: { ...fd.repair.params, emulatorId: rec.emulatorId } };
    }

    // Change correlation: what changed shortly before this failure?
    const since = new Date(new Date(rec.startedAt).getTime() - 7 * 24 * 3600 * 1000).toISOString();
    const correlated: ChangeEvent[] = this.d.ops.changesBetween(since, rec.startedAt, rec.emulatorId).filter((c) => /emulator\.(updated|rollback)|config\.|controller\.|bios\./.test(c.kind)).slice(0, 8);
    const update = correlated.find((c) => c.kind === 'emulator.updated');
    if (update) {
      const before = this.d.launches.lastSuccessBefore(rec.emulatorId, update.at);
      if (before && (rec.gameId === null || before.gameId === rec.gameId || !findings.length)) {
        const st = this.d.emulators.status(rec.emulatorId);
        findings.push(stateFinding('launch.regression', 'emulators', 'This started after an emulator update', `${update.summary} at ${new Date(update.at).toLocaleString()}. The last successful launch (${new Date(before.startedAt).toLocaleString()}) was before it.`, matches.length ? 'low' : 'medium', st.rollbackVersion ? { actionId: 'emulator.rollback', label: `Restore ${name} ${st.rollbackVersion}`, safety: 'high', params: { emulatorId: rec.emulatorId }, description: 'Restores the previous version and its configuration.' } : null));
      }
    }

    const rank: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };
    const ordered = findings.sort((a, b) => order(a.severity) - order(b.severity) || rank[b.confidence ?? 'low'] - rank[a.confidence ?? 'low']);
    const primary = ordered[0] ?? null;
    const failures = game?.consecutive_failures ?? 0;
    const paused = !!game?.crash_loop_paused;
    const userAction = primary?.manualSteps.length ? primary.manualSteps : primary ? [] : ['Run a full health check from OmniDoctor.', `Open ${name}'s log from the Emulators page for details.`];
    return {
      launchId,
      gameTitle: game?.title ?? null,
      emulatorId: rec.emulatorId,
      headline: primary && primary.confidence !== 'low' ? 'We found the issue.' : primary ? 'We found a likely cause.' : "We couldn't pinpoint the cause.",
      whatHappened: rec.outcome === 'failed_to_start' ? `${name} could not be started.` : `${name} stopped ${seconds !== null && seconds < 30 ? 'right after launch' : 'unexpectedly'}.`,
      detected,
      probableCause: primary ? (primary.detail || primary.title) : exitInfo?.cause ?? null,
      confidence: primary?.confidence ?? null,
      evidence: primary?.evidence ?? [],
      findings: ordered,
      primaryRepair: primary?.repair ?? null,
      userAction,
      technical: { exitCode, durationMs: rec.durationMs, logPath, logExcerpt: logText ? excerpt(logText) : rec.stderrTail, args: rec.args },
      correlatedChanges: correlated,
      crashLoop: { failures, paused },
    };
  }
}

function order(s: Finding['severity']): number {
  return { problem: 0, warning: 1, info: 2, pass: 3 }[s];
}

function ruleFinding(m: RuleMatch, emulatorId: string, gameId: number | null): Finding {
  const r = m.rule;
  return {
    id: `rule:${r.id}`,
    checkId: 'launch.rules',
    category: r.category,
    severity: r.severity,
    title: r.title,
    detail: r.probableCause,
    subject: { kind: 'emulator', id: emulatorId, label: emulatorId },
    evidence: m.evidence,
    confidence: r.confidence,
    repair: r.fix ? { actionId: r.fix.actionId, label: r.fix.label, safety: r.fix.safety, params: { emulatorId, gameId, ...r.fix.params }, description: r.probableCause } : null,
    manualSteps: r.userSupplied ? [...r.manual, 'Automatic repair is unavailable because this file must be supplied by you.'] : r.manual,
    ruleId: r.id,
  };
}

function stateFinding(id: string, category: DiagnosticCategory, title: string, evidence: string, confidence: Confidence, repair: RepairSuggestion | null, manual: string[] = []): Finding {
  return { id: `${id}:${title}`, checkId: id, category, severity: 'problem', title, detail: evidence, subject: null, evidence: [evidence], confidence, repair, manualSteps: manual };
}
