// xemu settings shown in OmniPC's settings menu. Keys are dotted paths in
// xemu.toml, written by XemuAdapter.applyConfig through EmulatorSettings.advanced
// and, for per-game profiles, into the game's -config_path copy (profileOverrides).
// Names, types, enum values and defaults follow xemu's config_spec.yml
// (genconfig schema) and the settings UI in ui/xui/main-menu.cc / menubar.cc.
//
// xemuTomlValue() converts menu strings to the TOML type config_spec.yml
// declares: bool, integer, enum (always a string, e.g. sys.mem_limit '64'/'128')
// and number (audio.volume_limit, a 0-1 float shown here as a percentage).
//
// Not included: surface scale, renderer, vsync, fullscreen, aspect ratio/fit
// (OmniPC core settings); widescreen (an EEPROM setting, not in xemu.toml);
// hard-disk lock settings (not part of xemu.toml either).

import type { SettingDef } from '@shared/emulatorSettings';
import type { HardwareProfile } from '@shared/models';

export const XEMU_SETTINGS: SettingDef[] = [
  // ---- graphics
  { key: 'display.filtering', label: 'Display filtering', description: 'How the picture is scaled to the window: Linear is smooth, Nearest keeps hard pixel edges.', category: 'graphics', kind: 'select', default: 'linear', options: [{ value: 'linear', label: 'Linear (smooth)' }, { value: 'nearest', label: 'Nearest (sharp)' }] },
  { key: 'display.window.fullscreen_exclusive', label: 'Exclusive fullscreen', description: 'Takes over the display in fullscreen. May improve responsiveness, but makes switching windows slower.', category: 'graphics', kind: 'toggle', default: 'false' },
  // ---- performance
  { key: 'perf.cache_shaders', label: 'Cache shaders to disk', description: 'Saves compiled shaders so games stutter less the next time they are played.', category: 'performance', kind: 'toggle', default: 'true' },
  { key: 'perf.hard_fpu', label: 'Hard FPU emulation', description: 'Uses the PC\'s floating-point unit directly for speed. Turn off only if a game shows physics or geometry bugs.', category: 'performance', kind: 'toggle', default: 'true', restartRequired: true },
  // ---- audio
  { key: 'audio.volume_limit', label: 'Volume', description: 'Limits the output volume.', category: 'audio', kind: 'slider', min: 0, max: 100, step: 5, unit: '%', default: '100' },
  { key: 'audio.use_dsp', label: 'Real-time DSP processing', description: 'Emulates the Xbox audio DSP for more accurate sound effects (experimental, costs CPU).', category: 'audio', kind: 'toggle', default: 'false', risky: true },
  { key: 'audio.use_dsp_jit', label: 'DSP JIT engine', description: 'Speeds up real-time DSP processing with a JIT. Only matters when DSP processing is on.', category: 'audio', kind: 'toggle', default: 'false' },
  { key: 'audio.hrtf', label: 'HRTF filtering', description: 'Applies the Xbox\'s 3D positional audio filter. Turn off if audio sounds muffled.', category: 'audio', kind: 'toggle', default: 'true' },
  // ---- system
  { key: 'general.skip_boot_anim', label: 'Skip startup animation', description: 'Skips the Xbox boot animation so games start faster.', category: 'system', kind: 'toggle', default: 'false', recommended: 'true' },
  { key: 'sys.mem_limit', label: 'System memory', description: 'Retail Xbox has 64 MB. 128 MB (debug kit) is only needed by some homebrew and mods.', category: 'system', kind: 'select', default: '64', restartRequired: true, options: [{ value: '64', label: '64 MB (retail)' }, { value: '128', label: '128 MB (debug kit)' }] },
  { key: 'sys.avpack', label: 'AV pack', description: 'Which video cable the Xbox thinks is connected. HDTV enables 480p/720p/1080i modes in games that support them. "None" disables video.', category: 'system', kind: 'select', default: 'hdtv', restartRequired: true, risky: true, options: [{ value: 'scart', label: 'SCART' }, { value: 'hdtv', label: 'HDTV (component)' }, { value: 'vga', label: 'VGA' }, { value: 'rfu', label: 'RF' }, { value: 'svideo', label: 'S-Video' }, { value: 'composite', label: 'Composite' }, { value: 'none', label: 'None' }] },
  // ---- controls
  { key: 'input.background_input_capture', label: 'Background controller input', description: 'Keeps reading the controller while the xemu window is not focused.', category: 'controls', kind: 'toggle', default: 'false', perGame: false },
  // ---- interface
  { key: 'display.ui.show_notifications', label: 'Show notifications', description: 'Shows notifications in the top-right corner.', category: 'interface', kind: 'toggle', default: 'true', perGame: false },
  { key: 'display.ui.show_menubar', label: 'Show menu bar', description: 'Shows xemu\'s menu bar when the mouse moves.', category: 'interface', kind: 'toggle', default: 'true', perGame: false },
  { key: 'display.ui.hide_cursor', label: 'Hide mouse cursor', description: 'Hides the mouse cursor when it is not moving.', category: 'interface', kind: 'toggle', default: 'true', perGame: false },
  { key: 'display.ui.use_animations', label: 'Menu animations', description: 'Animates xemu\'s menus.', category: 'interface', kind: 'toggle', default: 'true', perGame: false },
  { key: 'display.window.startup_size', label: 'Window size', description: 'Window size when xemu starts in windowed mode.', category: 'interface', kind: 'select', default: '1280x960', perGame: false, options: ['last_used', '640x480', '720x480', '1280x720', '1280x800', '1280x960', '1920x1080', '2560x1440', '2560x1600', '2560x1920', '3840x2160'].map((v) => ({ value: v, label: v === 'last_used' ? 'Last used' : v })) },
];

const DEFS = new Map(XEMU_SETTINGS.map((d) => [d.key, d]));

/** Generic conversion used for keys outside the schema (unchanged behaviour). */
function inferred(v: string): string | number | boolean {
  if (v === 'true' || v === 'false') return v === 'true';
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  return v;
}

/** Converts a menu string to the TOML value xemu's config_spec.yml expects. */
export function xemuTomlValue(key: string, value: string): string | number | boolean {
  const def = DEFS.get(key);
  if (!def) return inferred(value);
  const v = String(value).trim();
  if (def.kind === 'toggle') return /^(true|1|yes|on)$/i.test(v);
  if (def.kind === 'select') return v; // enums are strings, including sys.mem_limit
  const n = Number(v);
  const num = Number.isFinite(n) ? n : Number(def.default);
  if (key === 'audio.volume_limit') return Math.round(Math.min(100, Math.max(0, num))) / 100;
  return Math.round(num);
}

/** Reverses xemuTomlValue for the menu (missing/invalid values -> undefined). */
export function xemuMenuValue(key: string, raw: unknown): string | undefined {
  if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') return undefined;
  if (key === 'audio.volume_limit') return typeof raw === 'number' ? String(Math.round(raw * 100)) : undefined;
  return String(raw);
}

/** "Optimize for my PC" suggestions for xemu. */
export function xemuOptimize(hw: HardwareProfile): { key: string; value: string; reason: string }[] {
  const out: { key: string; value: string; reason: string }[] = [];
  out.push({ key: 'perf.cache_shaders', value: 'true', reason: 'Caching shaders removes repeat stutter on any PC.' });
  out.push({ key: 'general.skip_boot_anim', value: 'true', reason: 'Games start several seconds faster.' });
  if (hw.tier === 'low') out.push({ key: 'audio.use_dsp', value: 'false', reason: 'Real-time DSP emulation is too CPU-heavy for your PC.' });
  else if (hw.cpu.cores >= 8 && (hw.tier === 'high' || hw.tier === 'enthusiast')) out.push({ key: 'audio.use_dsp_jit', value: 'true', reason: `Your ${hw.cpu.cores}-core CPU can run the DSP JIT for faster audio emulation when DSP processing is on.` });
  return out;
}
