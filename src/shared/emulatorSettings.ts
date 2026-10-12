// Declarative per-emulator settings shown in OmniPC's settings menu, so the
// common options of every emulator can be changed without opening it.
//
// Each setting is stored as a string in EmulatorSettings.advanced under its
// `key`, the same map adapters already write into the emulator's own config
// (and that per-game profiles override). The key format belongs to the
// adapter (e.g. "EmuCore/GS|Mipmap" for PCSX2), so only the adapter that
// declares a setting needs to know where it lives in the config file.

export type SettingCategory = 'graphics' | 'performance' | 'audio' | 'system' | 'controls' | 'fixes' | 'interface';

export const SETTING_CATEGORIES: { id: SettingCategory; label: string }[] = [
  { id: 'graphics', label: 'Graphics' },
  { id: 'performance', label: 'Performance' },
  { id: 'audio', label: 'Audio' },
  { id: 'system', label: 'System' },
  { id: 'controls', label: 'Controls' },
  { id: 'fixes', label: 'Fixes & hacks' },
  { id: 'interface', label: 'Interface' },
];

export type SettingKind = 'toggle' | 'select' | 'slider' | 'number' | 'text';

export interface SettingDef {
  /** Key in EmulatorSettings.advanced (adapter-specific format). */
  key: string;
  label: string;
  /** One or two plain sentences: what it does and when to change it. */
  description: string;
  category: SettingCategory;
  kind: SettingKind;
  /** select: the allowed values. */
  options?: { value: string; label: string }[];
  /** slider/number bounds. */
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** The emulator's own default ('true'/'false' for toggles). */
  default: string;
  /** What OmniPC recommends when it differs from the emulator's default. */
  recommended?: string;
  /** False when a per-game value makes no sense (e.g. UI language). Default true. */
  perGame?: boolean;
  /** Only takes effect after the emulator restarts (shown as a hint). */
  restartRequired?: boolean;
  /** Can cause glitches or crashes; shown with a warning. */
  risky?: boolean;
}

/** What OmniPC knows about one emulator's settings. */
export interface EmulatorSettingsView {
  emulatorId: string;
  defs: SettingDef[];
  /** Values currently in the emulator's config file (also picks up changes made inside the emulator). */
  current: Record<string, string>;
  /** Values OmniPC writes on every configure (EmulatorSettings.advanced). */
  saved: Record<string, string>;
}

/** One "Optimize for my PC" proposal. */
export interface OptimizeSuggestion {
  /** A key of EmulatorSettings (e.g. 'resolutionScale') or 'advanced:<key>'. */
  field: string;
  label: string;
  from: string;
  to: string;
  reason: string;
}

export const toBool = (v: string | undefined): boolean => v === 'true' || v === '1';

/** Normalises a value for a definition (unknown select values fall back to the default). */
export function normaliseSetting(def: SettingDef, value: string | undefined): string {
  if (value === undefined || value === null) return def.default;
  const v = String(value).trim();
  switch (def.kind) {
    case 'toggle':
      return /^(true|1|yes|on)$/i.test(v) ? 'true' : /^(false|0|no|off)$/i.test(v) ? 'false' : def.default;
    case 'select':
      return def.options?.some((o) => o.value === v) ? v : (def.options?.find((o) => o.value.toLowerCase() === v.toLowerCase())?.value ?? def.default);
    case 'slider':
    case 'number': {
      const n = Number(v);
      if (!Number.isFinite(n)) return def.default;
      const clamped = Math.min(def.max ?? Infinity, Math.max(def.min ?? -Infinity, n));
      return String(clamped);
    }
    default:
      return v;
  }
}

/** Checks a schema for mistakes (duplicate keys, defaults outside options). Used by tests. */
export function validateSchema(defs: SettingDef[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const d of defs) {
    if (seen.has(d.key)) errors.push(`duplicate key ${d.key}`);
    seen.add(d.key);
    if (!d.label || !d.description) errors.push(`${d.key}: missing label/description`);
    if (d.kind === 'select' && !d.options?.some((o) => o.value === d.default)) errors.push(`${d.key}: default "${d.default}" is not an option`);
    if (d.kind === 'select' && d.recommended !== undefined && !d.options?.some((o) => o.value === d.recommended)) errors.push(`${d.key}: recommended "${d.recommended}" is not an option`);
    if (d.kind === 'toggle' && !['true', 'false'].includes(d.default)) errors.push(`${d.key}: toggle default must be "true" or "false"`);
    if ((d.kind === 'slider' || d.kind === 'number') && (d.min === undefined || d.max === undefined || Number(d.default) < d.min || Number(d.default) > d.max)) errors.push(`${d.key}: default outside min/max`);
  }
  return errors;
}
