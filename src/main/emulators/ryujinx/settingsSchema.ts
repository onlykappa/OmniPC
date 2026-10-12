// Ryujinx (Ryubing) settings shown in OmniPC's settings menu. Keys are top-level snake_case
// Config.json keys, written by RyujinxAdapter.applyConfig (and, per game, as session
// overrides restored when Ryujinx exits) through EmulatorSettings.advanced.
// Names, JSON types and defaults follow src/Ryujinx/Systems/Configuration/ConfigurationFileFormat.cs
// and ConfigurationState.cs (LoadDefault); enum values follow
// src/Ryujinx.Common/Configuration/{AntiAliasing,ScalingFilter,BackendThreading,MemoryManagerMode}.cs,
// src/Ryujinx/Systems/Configuration/{AudioBackend,System/Language,System/Region}.cs,
// src/Ryujinx/Systems/Configuration/UI/FocusLostType.cs and src/Ryujinx.HLE/MemoryConfiguration.cs;
// ranges and option lists follow src/Ryujinx/UI/ViewModels/SettingsViewModel.cs and the
// settings views (src/Ryujinx/UI/Views/Settings/*.axaml), wording follows assets/Locales.
// A value of the wrong JSON type makes Ryujinx discard the whole Config.json, so every key's
// encoding is declared in RYUJINX_ENCODING.

import type { SettingDef } from '@shared/emulatorSettings';
import type { HardwareProfile } from '@shared/models';

const opts = (...values: [string, string][]) => values.map(([value, label]) => ({ value, label }));

export const RYUJINX_SETTINGS: SettingDef[] = [
  // ---- graphics
  { key: 'max_anisotropy', label: 'Anisotropic filtering', description: 'Keeps textures on floors and walls sharp at an angle. "Auto" uses what the game asks for; 16x is cheap on modern GPUs.', category: 'graphics', kind: 'select', default: '-1', recommended: '16', options: opts(['-1', 'Auto'], ['2', '2x'], ['4', '4x'], ['8', '8x'], ['16', '16x']) },
  { key: 'anti_aliasing', label: 'Anti-aliasing', description: 'Smooths jagged edges. FXAA is cheap but slightly blurry; SMAA looks better and costs more at higher levels.', category: 'graphics', kind: 'select', default: 'None', options: opts(['None', 'Off'], ['Fxaa', 'FXAA'], ['SmaaLow', 'SMAA Low'], ['SmaaMedium', 'SMAA Medium'], ['SmaaHigh', 'SMAA High'], ['SmaaUltra', 'SMAA Ultra']) },
  { key: 'scaling_filter', label: 'Scaling filter', description: 'How the picture is stretched to your window. FSR sharpens upscaled images, Nearest keeps hard pixels, Area is best when downscaling.', category: 'graphics', kind: 'select', default: 'Bilinear', options: opts(['Bilinear', 'Bilinear'], ['Nearest', 'Nearest'], ['Fsr', 'AMD FSR'], ['Area', 'Area']) },
  { key: 'scaling_filter_level', label: 'FSR sharpness', description: 'Sharpening strength of the FSR scaling filter. Only used when the scaling filter is FSR.', category: 'graphics', kind: 'slider', min: 0, max: 100, step: 1, unit: '%', default: '80' },
  { key: 'enable_texture_recompression', label: 'Texture recompression', description: 'Compresses ASTC textures to save video memory. Turn on for GPUs with 4 GB of VRAM or less if games run out of memory; slightly lowers texture quality.', category: 'graphics', kind: 'toggle', default: 'false' },
  // ---- performance
  { key: 'enable_shader_cache', label: 'Shader cache', description: 'Saves compiled shaders to disk so games stutter less the next time. Leave on.', category: 'performance', kind: 'toggle', default: 'true' },
  { key: 'enable_ptc', label: 'PPTC (CPU code cache)', description: 'Saves translated CPU code so games load much faster after the first run. Leave on.', category: 'performance', kind: 'toggle', default: 'true', restartRequired: true },
  { key: 'enable_low_power_ptc', label: 'Low-power PPTC loading', description: 'Loads the PPTC cache using a third of your CPU cores. Helps laptops and weak CPUs that overheat while loading.', category: 'performance', kind: 'toggle', default: 'false', restartRequired: true },
  { key: 'backend_threading', label: 'Graphics backend multithreading', description: 'Runs graphics commands on a second thread. Speeds up shader compilation and reduces stutter. Leave on Auto unless told otherwise.', category: 'performance', kind: 'select', default: 'Auto', options: opts(['Auto', 'Auto'], ['Off', 'Off'], ['On', 'On']), restartRequired: true },
  { key: 'enable_macro_hle', label: 'Macro HLE', description: 'Emulates GPU macro code at a high level for speed. Turn off only if a game has graphical glitches that it fixes.', category: 'performance', kind: 'toggle', default: 'true' },
  { key: 'memory_manager_mode', label: 'Memory manager mode', description: 'How Switch memory is mapped. "Host unchecked" is fastest; "Host" adds safety checks; "Software" is slowest and only for troubleshooting.', category: 'performance', kind: 'select', default: 'HostMappedUnsafe', options: opts(['HostMappedUnsafe', 'Host unchecked (fastest)'], ['HostMapped', 'Host (checked)'], ['SoftwarePageTable', 'Software (slowest)']), restartRequired: true },
  // ---- audio
  { key: 'audio_volume', label: 'Volume', description: 'Game audio volume.', category: 'audio', kind: 'slider', min: 0, max: 100, step: 5, unit: '%', default: '100' },
  { key: 'audio_backend', label: 'Audio backend', description: 'Audio library used for sound output. Try OpenAL or SoundIO if sound crackles; "Dummy" mutes all audio.', category: 'audio', kind: 'select', default: 'SDL3', options: opts(['SDL3', 'SDL3'], ['OpenAl', 'OpenAL'], ['SoundIo', 'SoundIO'], ['Dummy', 'None (dummy)']), restartRequired: true },
  // ---- system
  { key: 'docked_mode', label: 'Docked mode', description: 'Runs the Switch as if it were docked to a TV, which raises graphics quality in most games. Turn off for handheld mode (lower resolution, better performance).', category: 'system', kind: 'toggle', default: 'true' },
  { key: 'system_language', label: 'System language', description: 'Switch system language; games pick their text and voice language from it when they support it.', category: 'system', kind: 'select', default: 'AmericanEnglish', perGame: false, options: opts(['Japanese', 'Japanese'], ['AmericanEnglish', 'English (US)'], ['BritishEnglish', 'English (UK)'], ['French', 'French'], ['CanadianFrench', 'French (Canada)'], ['German', 'German'], ['Italian', 'Italian'], ['Spanish', 'Spanish'], ['LatinAmericanSpanish', 'Spanish (Latin America)'], ['Chinese', 'Chinese'], ['SimplifiedChinese', 'Chinese (Simplified)'], ['TraditionalChinese', 'Chinese (Traditional)'], ['Taiwanese', 'Taiwanese'], ['Korean', 'Korean'], ['Dutch', 'Dutch'], ['Portuguese', 'Portuguese'], ['BrazilianPortuguese', 'Portuguese (Brazil)'], ['Russian', 'Russian'], ['Polish', 'Polish'], ['Thai', 'Thai']) },
  { key: 'system_region', label: 'System region', description: 'Switch console region. Some games choose their language list or content by region.', category: 'system', kind: 'select', default: 'USA', perGame: false, options: opts(['Japan', 'Japan'], ['USA', 'USA'], ['Europe', 'Europe'], ['Australia', 'Australia'], ['China', 'China'], ['Korea', 'Korea'], ['Taiwan', 'Taiwan']) },
  { key: 'dram_size', label: 'DRAM size', description: 'Gives the emulated Switch more memory, like a development unit. Only useful for high-resolution texture packs or 4K mods; does not improve performance.', category: 'system', kind: 'select', default: '0', risky: true, restartRequired: true, options: opts(['0', '4 GiB (retail)'], ['1', '6 GiB'], ['2', '8 GiB'], ['3', '12 GiB']) },
  { key: 'ignore_missing_services', label: 'Ignore missing services', description: 'Ignores unimplemented Switch system services. May get some games past a crash at boot, but can cause other problems.', category: 'fixes', kind: 'toggle', default: 'false', risky: true },
  // ---- interface
  { key: 'hide_cursor', label: 'Hide mouse cursor', description: 'When to hide the mouse pointer over the game window.', category: 'interface', kind: 'select', default: '1', options: opts(['0', 'Never'], ['1', 'When idle'], ['2', 'Always']) },
  { key: 'focus_lost_action_type', label: 'When the window loses focus', description: 'What Ryujinx does when you switch to another window: nothing, block input, mute, or pause the game.', category: 'interface', kind: 'select', default: 'DoNothing', perGame: false, options: opts(['DoNothing', 'Do nothing'], ['BlockInput', 'Block input'], ['MuteAudio', 'Mute audio'], ['BlockInputAndMuteAudio', 'Block input and mute'], ['PauseEmulation', 'Pause emulation']) },
];

/** How each schema value is stored in Config.json: JSON type plus a scale for percent sliders. */
export const RYUJINX_ENCODING: Record<string, { type: 'boolean' | 'integer' | 'number' | 'string'; scale?: number }> = Object.fromEntries(
  RYUJINX_SETTINGS.map((d) => {
    if (d.key === 'audio_volume') return [d.key, { type: 'number', scale: 100 }]; // float 0..1 (SettingsViewModel: Volume = AudioVolume * 100)
    if (d.key === 'max_anisotropy') return [d.key, { type: 'number' }]; // float, -1 = auto
    if (d.kind === 'toggle') return [d.key, { type: 'boolean' }];
    if (d.kind === 'select' && d.options!.some((o) => !/^-?\d+$/.test(o.value))) return [d.key, { type: 'string' }];
    return [d.key, { type: 'integer' }]; // dram_size, hide_cursor (no string converter), scaling_filter_level
  }),
);

/** Converts a menu value to its Config.json value, or undefined when it cannot be encoded. */
export function encodeRyujinx(key: string, raw: string): boolean | number | string | undefined {
  const enc = RYUJINX_ENCODING[key];
  const v = String(raw).trim();
  if (!enc) return undefined;
  if (enc.type === 'boolean') return /^(true|1)$/i.test(v) ? true : /^(false|0)$/i.test(v) ? false : undefined;
  if (enc.type === 'string') return v;
  const n = Number(v);
  if (v === '' || !Number.isFinite(n)) return undefined;
  const scaled = enc.scale ? n / enc.scale : n;
  return enc.type === 'integer' ? Math.round(scaled) : scaled;
}

/** Converts a Config.json value back to the menu's string form. */
export function decodeRyujinx(key: string, v: unknown): string | undefined {
  const enc = RYUJINX_ENCODING[key];
  if (!enc || (typeof v !== 'boolean' && typeof v !== 'number' && typeof v !== 'string')) return undefined;
  if (enc.scale && typeof v === 'number') return String(Math.round(v * enc.scale));
  return String(v);
}

/** "Optimize for my PC" suggestions for Ryujinx. */
export function ryujinxOptimize(hw: HardwareProfile): { key: string; value: string; reason: string }[] {
  const out: { key: string; value: string; reason: string }[] = [];
  const vram = Math.max(0, ...hw.gpus.map((g) => g.vramMB ?? 0));
  if (hw.tier !== 'low') out.push({ key: 'max_anisotropy', value: '16', reason: 'Sharper textures at a negligible cost on your GPU.' });
  if (vram > 0 && vram <= 4096) out.push({ key: 'enable_texture_recompression', value: 'true', reason: `Your GPU has ${vram} MB of video memory; recompressing textures avoids running out in large games.` });
  return out;
}
