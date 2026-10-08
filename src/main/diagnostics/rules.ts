// OmniDoctor knowledge base: structured, declarative rules (rules/*.rules.json)
// matched against emulator logs, stderr and exit codes. Rules are data, so
// new failure signatures are added without touching engine code.

import type { Confidence, DiagnosticCategory, RepairSafety, Severity } from '@shared/models';
import generic from './rules/generic.rules.json';
import pcsx2 from './rules/pcsx2.rules.json';
import dolphin from './rules/dolphin.rules.json';

export interface DiagnosticRule {
  id: string;
  title: string;
  category: DiagnosticCategory;
  severity: Exclude<Severity, 'pass'>;
  confidence: Confidence;
  exitCodes: number[];
  patterns: string[];
  probableCause: string;
  fix: { actionId: string; label: string; safety: RepairSafety; params: Record<string, unknown> } | null;
  manual: string[];
  references: string[];
  /** The fix requires something only the user can provide (BIOS, firmware, keys). */
  userSupplied?: boolean;
}

export interface RuleFile {
  emulatorId: string;
  description: string;
  rules: DiagnosticRule[];
}

export const RULE_FILES: RuleFile[] = [generic, pcsx2, dolphin] as unknown as RuleFile[];

export function validateRuleFile(f: RuleFile): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const r of f.rules) {
    if (ids.has(r.id)) errors.push(`duplicate rule id ${r.id}`);
    ids.add(r.id);
    if (!r.patterns.length && !r.exitCodes.length) errors.push(`${r.id}: needs patterns or exitCodes`);
    for (const p of r.patterns) {
      try { new RegExp(p, 'i'); } catch { errors.push(`${r.id}: invalid pattern ${p}`); }
    }
    if (r.fix && !['safe', 'low', 'high'].includes(r.fix.safety)) errors.push(`${r.id}: fix safety must be safe/low/high`);
  }
  return errors;
}

export interface RuleMatch {
  rule: DiagnosticRule;
  evidence: string[];
}

export interface MatchInput {
  emulatorId: string;
  exitCode: number | null;
  text: string;
}

/** Matches rules for an emulator (plus generic rules). Each match carries the exact log lines that triggered it. */
export function matchRules(input: MatchInput, files: RuleFile[] = RULE_FILES): RuleMatch[] {
  const lines = input.text.split(/\r?\n/);
  const out: RuleMatch[] = [];
  for (const f of files) {
    if (f.emulatorId !== '*' && f.emulatorId !== input.emulatorId) continue;
    for (const rule of f.rules) {
      const evidence: string[] = [];
      if (input.exitCode !== null && rule.exitCodes.includes(input.exitCode)) evidence.push(`Exit code ${input.exitCode} (0x${(input.exitCode >>> 0).toString(16).toUpperCase()})`);
      const regexes = rule.patterns.map((p) => new RegExp(p, 'i'));
      // Exit-code rules with patterns only need the exit code; pure pattern rules need a matching line.
      for (const line of lines) {
        if (regexes.some((r) => r.test(line))) {
          evidence.push(`Log: ${line.trim().slice(0, 300)}`);
          if (evidence.length >= 4) break;
        }
      }
      if (evidence.length) out.push({ rule, evidence });
    }
  }
  const rank = { high: 3, medium: 2, low: 1 } as const;
  return out.sort((a, b) => rank[b.rule.confidence] - rank[a.rule.confidence] || (b.rule.severity === 'problem' ? 1 : 0) - (a.rule.severity === 'problem' ? 1 : 0));
}
