// KytyPS5 settings shown in OmniPC's settings menu. KytyPS5 has no config file: every
// option is a command-line flag. Keys are the option name without the leading dashes,
// stored in omnideck-kyty.json managed.options by KytyAdapter.applyConfig and turned into
// arguments at launch (per-game profiles override them for that launch).
// Names, value syntax and defaults follow src/main.cpp (PrintUsage, ParseArgs, ParseBool,
// ParseConsoleLanguage) and src/common/emulatorConfig.h (ConfigOptions); ranges, the
// language list and wording follow the Qt launcher (src/launcher/forms/configuration_edit_dialog.ui,
// src/launcher/src/configurationEditDialog.cpp CONSOLE_LANGUAGE_NAMES).

import type { SettingDef } from '@shared/emulatorSettings';
import type { HardwareProfile } from '@shared/models';

const LANGUAGES = [
  'Japanese', 'English (United States)', 'French (France)', 'Spanish (Spain)', 'German', 'Italian', 'Dutch', 'Portuguese (Portugal)',
  'Russian', 'Korean', 'Chinese (Traditional)', 'Chinese (Simplified)', 'Finnish', 'Swedish', 'Danish', 'Norwegian', 'Polish',
  'Portuguese (Brazil)', 'English (United Kingdom)', 'Turkish', 'Spanish (Latin America)', 'Arabic', 'French (Canada)', 'Czech',
  'Hungarian', 'Greek', 'Romanian', 'Thai', 'Vietnamese', 'Indonesian',
];

export const KYTY_SETTINGS: SettingDef[] = [
  // ---- graphics
  { key: 'tessellation', label: 'Tessellation (experimental)', description: 'Draws tessellated geometry, which is skipped by default. Can restore missing detail in some games; unsupported tessellation may crash.', category: 'graphics', kind: 'toggle', default: 'false', risky: true },
  { key: 'readback-linear-images', label: 'Linear image readback', description: 'Reads writable linear images back from the GPU after each submit. Fixes some missing or stale images, at a performance cost.', category: 'graphics', kind: 'toggle', default: 'false' },
  { key: 'sync-raw-image-buffers', label: 'Accurate texture synchronization', description: 'Can fix missing textures and incorrect transparency in some games. May reduce performance.', category: 'graphics', kind: 'toggle', default: 'false' },
  // ---- performance
  { key: 'shader-optimization-type', label: 'Shader optimization', description: 'How KytyPS5 optimizes the shaders it translates. "Performance" can raise frame rates but takes longer to compile.', category: 'performance', kind: 'select', default: 'None', options: [{ value: 'None', label: 'None' }, { value: 'Size', label: 'Size' }, { value: 'Performance', label: 'Performance' }] },
  { key: 'vblank-frequency', label: 'VBlank frequency', description: 'Refresh rate of the virtual display used for frame pacing (60 on a real console). Higher values can unlock frame rates in some games but make others run too fast.', category: 'performance', kind: 'number', min: 30, max: 360, step: 1, unit: 'Hz', default: '60', risky: true },
  // ---- audio
  { key: 'controller-volume', label: 'Controller speaker volume', description: 'Volume of sounds games play through the DualSense speaker.', category: 'audio', kind: 'slider', min: 0, max: 100, step: 5, unit: '%', default: '50' },
  // ---- system
  { key: 'console-language', label: 'Console language', description: 'System language reported to games; most games pick their text and voice language from it.', category: 'system', kind: 'select', default: '1', perGame: false, options: LANGUAGES.map((label, i) => ({ value: String(i), label })) },
  { key: 'skip-notice-screen', label: 'Skip boot logos', description: 'Skips startup logos and notices in games that support it.', category: 'system', kind: 'toggle', default: 'false' },
  // ---- fixes
  { key: 'amd-cpu', label: 'AMD CPU patch (experimental)', description: 'Patches CPU instructions that behave differently between the console\'s AMD CPU and yours. Try it if a game crashes early.', category: 'fixes', kind: 'toggle', default: 'false', risky: true },
  { key: 'redzone', label: 'Red zone crash protection (experimental)', description: 'Helps prevent crashes in some games on Windows.', category: 'fixes', kind: 'toggle', default: 'false', risky: true },
  { key: 'playgo-hack', label: 'PlayGo fallback', description: 'Uses a stub fallback for the console\'s PlayGo (install chunk) system. Only for games that hang waiting for their data to "install".', category: 'fixes', kind: 'toggle', default: 'false', risky: true },
  // ---- interface
  { key: 'trophy-notifications', label: 'Trophy notifications', description: 'Shows a pop-up and plays a sound when you unlock a trophy.', category: 'interface', kind: 'toggle', default: 'true' },
  { key: 'hide-cursor', label: 'Auto-hide cursor', description: 'Hides the mouse pointer after 2 seconds without movement. OmniPC turns this on in fullscreen unless you set it here.', category: 'interface', kind: 'toggle', default: 'false' },
];

/** "Optimize for my PC" suggestions for KytyPS5. */
export function kytyOptimize(hw: HardwareProfile): { key: string; value: string; reason: string }[] {
  const out: { key: string; value: string; reason: string }[] = [];
  if (hw.tier === 'high' || hw.tier === 'enthusiast') {
    out.push({ key: 'shader-optimization-type', value: 'Performance', reason: 'Your PC is fast enough to spend a little longer compiling shaders in exchange for faster ones.' });
  }
  return out;
}
