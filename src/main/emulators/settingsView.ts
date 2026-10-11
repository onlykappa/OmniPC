// Backs the per-emulator settings menu: what an emulator offers (its schema),
// what its config file holds now, what OmniPC saved, and what "Optimize for
// my PC" would change.

import type { EmulatorSettings, HardwareProfile } from '@shared/models';
import { normaliseSetting, type EmulatorSettingsView, type OptimizeSuggestion } from '@shared/emulatorSettings';
import type { EmulatorAdapter } from './adapter';

export async function settingsView(a: EmulatorAdapter, saved: EmulatorSettings, installed: boolean): Promise<EmulatorSettingsView> {
  const defs = a.settingsSchema?.() ?? [];
  const keys = new Set(defs.map((d) => d.key));
  const raw = installed && a.readSettings ? await a.readSettings().catch(() => ({} as Record<string, string>)) : {};
  const current: Record<string, string> = {};
  for (const d of defs) if (raw[d.key] !== undefined) current[d.key] = normaliseSetting(d, raw[d.key]);
  const savedAdv: Record<string, string> = {};
  for (const [k, v] of Object.entries(saved.advanced ?? {})) if (keys.has(k)) savedAdv[k] = v;
  return { emulatorId: a.manifest.id, defs, current, saved: savedAdv };
}

const PRESET_LABEL: Record<string, string> = { performance: 'Performance', balanced: 'Balanced', quality: 'Quality', maximum: 'Maximum' };

/**
 * Settings OmniPC recommends for this PC that differ from what is saved: the
 * adapter's defaults for the hardware's recommended preset (resolution,
 * renderer, ...) plus the adapter's own advanced suggestions.
 */
export function optimizeSuggestions(a: EmulatorAdapter, saved: EmulatorSettings, hw: HardwareProfile | null): OptimizeSuggestion[] {
  if (!hw) return [];
  const out: OptimizeSuggestion[] = [];
  const target = a.defaultSettings(hw, hw.recommendedPreset);
  const why = `Recommended for your PC (${hw.tier} tier: ${hw.tierReason}).`;
  if (target.preset !== saved.preset) out.push({ field: 'preset', label: 'Graphics quality', from: PRESET_LABEL[saved.preset] ?? saved.preset, to: PRESET_LABEL[target.preset] ?? target.preset, reason: why });
  if (target.resolutionScale !== saved.resolutionScale) out.push({ field: 'resolutionScale', label: 'Resolution', from: `${saved.resolutionScale}x`, to: `${target.resolutionScale}x`, reason: why });
  if (target.renderer !== saved.renderer) {
    const names = new Map(a.renderers(hw).map((r) => [r.id, r.label]));
    out.push({ field: 'renderer', label: 'Renderer', from: names.get(saved.renderer) ?? saved.renderer, to: names.get(target.renderer) ?? target.renderer, reason: 'Best supported graphics API on your GPU.' });
  }
  const defs = new Map((a.settingsSchema?.() ?? []).map((d) => [d.key, d]));
  for (const s of a.optimize?.(hw) ?? []) {
    const def = defs.get(s.key);
    const cur = saved.advanced?.[s.key] ?? def?.default ?? '';
    const to = def ? normaliseSetting(def, s.value) : s.value;
    if (cur === to) continue;
    const label = (v: string) => (def?.kind === 'toggle' ? (v === 'true' ? 'On' : 'Off') : def?.options?.find((o) => o.value === v)?.label ?? v);
    out.push({ field: `advanced:${s.key}`, label: def?.label ?? s.key, from: label(cur), to: label(to), reason: s.reason });
  }
  return out;
}

/** Applies chosen suggestions to the saved settings. */
export function applySuggestions(a: EmulatorAdapter, saved: EmulatorSettings, hw: HardwareProfile, fields: string[]): EmulatorSettings {
  const target = a.defaultSettings(hw, hw.recommendedPreset);
  const next: EmulatorSettings = { ...saved, advanced: { ...saved.advanced } };
  const adv = new Map((a.optimize?.(hw) ?? []).map((s) => [s.key, s.value]));
  for (const f of fields) {
    if (f === 'preset') next.preset = target.preset;
    else if (f === 'resolutionScale') next.resolutionScale = target.resolutionScale;
    else if (f === 'renderer') next.renderer = target.renderer;
    else if (f.startsWith('advanced:') && adv.has(f.slice(9))) next.advanced[f.slice(9)] = adv.get(f.slice(9))!;
  }
  return next;
}
