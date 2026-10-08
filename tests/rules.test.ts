import { describe, expect, it } from 'vitest';
import { RULE_FILES, matchRules, validateRuleFile } from '../src/main/diagnostics/rules';
import { scoreFindings } from '../src/main/diagnostics/doctor';
import type { Finding } from '../src/shared/models';

describe('diagnostic knowledge base', () => {
  it('every rule file is valid', () => {
    for (const f of RULE_FILES) expect(validateRuleFile(f), f.emulatorId).toEqual([]);
  });

  it('matches PCSX2 missing BIOS from the log with evidence', () => {
    const m = matchRules({ emulatorId: 'pcsx2', exitCode: 1, text: 'Searching for a BIOS image in C:\\bios...\nUnable to auto locate a BIOS image\n' });
    expect(m[0].rule.id).toBe('pcsx2.bios-missing');
    expect(m[0].evidence[0]).toMatch(/Unable to auto locate/);
  });

  it('does not apply another emulator\'s rules', () => {
    expect(matchRules({ emulatorId: 'dolphin', exitCode: 1, text: 'Unable to auto locate a BIOS image' })).toEqual([]);
  });

  it('matches Windows exit codes generically', () => {
    const m = matchRules({ emulatorId: 'dolphin', exitCode: -1073741515, text: '' });
    expect(m.map((x) => x.rule.id)).toContain('generic.dll-not-found');
    expect(m[0].evidence[0]).toMatch(/0xC0000135/);
  });

  it('ranks high-confidence matches first', () => {
    const m = matchRules({ emulatorId: 'pcsx2', exitCode: -1073741819, text: 'Failed to create render device. This may be due to your GPU' });
    expect(m[0].rule.id).toBe('pcsx2.gs-init-failed');
    expect(m[m.length - 1].rule.confidence).toBe('low');
  });
});

describe('health score', () => {
  const f = (category: Finding['category'], severity: Finding['severity']): Finding => ({ id: Math.random().toString(), checkId: 'x', category, severity, title: '', detail: '', subject: null, evidence: [], confidence: null, repair: null, manualSteps: [] });
  it('is computed from real findings only', () => {
    expect(scoreFindings([]).overall).toBe(100);
    const s = scoreFindings([f('bios', 'pass'), f('bios', 'problem'), f('emulators', 'pass'), f('emulators', 'warning')]);
    expect(s.categories.find((c) => c.category === 'bios')!.score).toBe(50);
    expect(s.categories.find((c) => c.category === 'emulators')!.score).toBe(80);
    expect(s.overall).toBe(65);
  });
  it('ignores informational findings in the score', () => {
    expect(scoreFindings([f('metadata', 'info'), f('metadata', 'pass')]).overall).toBe(100);
  });
});
