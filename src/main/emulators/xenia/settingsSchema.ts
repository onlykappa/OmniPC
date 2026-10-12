// Xenia Canary settings shown in OmniPC's settings menu. Keys are
// "Category|cvar" in xenia-canary.config.toml, written by XeniaAdapter.applyConfig
// through EmulatorSettings.advanced and, for per-game profiles, as --cvar=value
// command-line overrides.
// Names, categories, types and defaults follow the DEFINE_* / UPDATE_from_*
// declarations (UPDATE_from_* names the OLD default) in src/xenia/gpu/gpu_flags.cc,
// gpu/command_processor.cc, gpu/d3d12/d3d12_render_target_cache.cc,
// gpu/vulkan/vulkan_render_target_cache.cc, app/emulator_window.cc (post-processing),
// ui/presenter.h (CAS/FSR ranges), apu/apu_flags.cc, apu/xma_decoder.cc,
// apu/audio_media_player.cc, app/xenia_main.cc, kernel/kernel_state.cc,
// kernel/xam/xam_content.cc, kernel/xam/achievement_manager.cc and
// patcher/patch_db.cc. Each cvar must be written
// with its TOML type: a mismatch makes Xenia warn and reset it
// (base/cvar.h ConfigVar::LoadConfigValue), so XENIA_CVAR_TYPES drives encoding.
// Not offered: console language/country (stored in the binary xconfig.settings,
// not a cvar, in this build), GPU backend, resolution scale, VSync, frame limit,
// fullscreen and letterboxing (OmniPC core settings).

import type { SettingDef } from '@shared/emulatorSettings';
import type { HardwareProfile } from '@shared/models';

export type XeniaCvarType = 'bool' | 'int' | 'double' | 'string';

export const XENIA_SETTINGS: SettingDef[] = [
  // ---- graphics
  { key: 'GPU|anisotropic_override', label: 'Anisotropic filtering', description: 'Forces sharper textures at oblique angles. Most GPUs handle 16x easily; in rare cases it causes artifacts.', category: 'graphics', kind: 'select', default: '-1', recommended: '5', options: [{ value: '-1', label: 'Game default' }, { value: '0', label: 'Off' }, { value: '1', label: '1x' }, { value: '2', label: '2x' }, { value: '3', label: '4x' }, { value: '4', label: '8x' }, { value: '5', label: '16x' }] },
  { key: 'Display|postprocess_antialiasing', label: 'Anti-aliasing (FXAA)', description: 'Smooths jagged edges of the final image. Recommended together with FSR or CAS sharpening.', category: 'graphics', kind: 'select', default: 'none', options: [{ value: 'none', label: 'Off' }, { value: 'fxaa', label: 'FXAA' }, { value: 'fxaa_extreme', label: 'FXAA (extreme quality)' }] },
  { key: 'Display|postprocess_scaling_and_sharpening', label: 'Upscaling and sharpening', description: 'How the picture is scaled to your screen. FSR gives the sharpest upscale; CAS only sharpens.', category: 'graphics', kind: 'select', default: 'bilinear', options: [{ value: 'bilinear', label: 'Bilinear' }, { value: 'cas', label: 'AMD FidelityFX CAS' }, { value: 'fsr', label: 'AMD FidelityFX FSR' }] },
  { key: 'Display|postprocess_ffx_cas_additional_sharpness', label: 'CAS extra sharpness', description: 'Additional sharpening when CAS is used. Higher is sharper.', category: 'graphics', kind: 'slider', min: 0, max: 1, step: 0.05, default: '0' },
  { key: 'Display|postprocess_ffx_fsr_sharpness_reduction', label: 'FSR softness', description: 'Reduces FSR sharpening (in stops). Lower is sharper.', category: 'graphics', kind: 'slider', min: 0, max: 2, step: 0.1, default: '0.2' },
  { key: 'Display|postprocess_ffx_fsr_max_upsampling_passes', label: 'FSR max passes', description: 'Each FSR pass upscales up to 2x. Lower it on 4K or larger screens if FSR costs too much speed.', category: 'graphics', kind: 'number', min: 1, max: 4, step: 1, default: '4' },
  { key: 'Display|postprocess_dither', label: 'Dithering', description: 'Smooths colour gradients when converting to 8-bit output. Can be turned off on 10-bit displays.', category: 'graphics', kind: 'toggle', default: 'true' },
  // ---- performance
  { key: 'GPU|async_shader_compilation', label: 'Async shader compilation', description: 'Compiles shaders in the background to avoid stutter; objects may briefly render wrongly while they are built.', category: 'performance', kind: 'toggle', default: 'true' },
  { key: 'GPU|readback_resolve', label: 'Resolve readback', description: 'Lets the CPU read rendered images back. "Fast" fixes effects in some games with a one-frame delay; "Full" is exact but slow; some games look better with it off.', category: 'performance', kind: 'select', default: 'none', options: [{ value: 'none', label: 'Off' }, { value: 'fast', label: 'Fast' }, { value: 'full', label: 'Full (slow)' }] },
  { key: 'GPU|occlusion_query', label: 'Occlusion queries', description: 'How lens flares, culling and auto-exposure visibility tests are answered. "Strict" is most accurate but slower; "Fake" is fastest.', category: 'performance', kind: 'select', default: 'fast', options: [{ value: 'fake', label: 'Fake' }, { value: 'fast', label: 'Fast' }, { value: 'fast-alt', label: 'Fast (alternative)' }, { value: 'strict', label: 'Strict' }] },
  { key: 'GPU|render_target_path_d3d12', label: 'Render target path (D3D12)', description: 'RTV is faster; ROV is more accurate (all pixel formats) but slower and can crash on AMD. "Any" lets Xenia choose.', category: 'performance', kind: 'select', default: 'any', risky: true, restartRequired: true, options: [{ value: 'any', label: 'Automatic' }, { value: 'rtv', label: 'RTV (fast)' }, { value: 'rov', label: 'ROV (accurate)' }] },
  { key: 'GPU|render_target_path_vulkan', label: 'Render target path (Vulkan)', description: 'FBO is faster; FSI is more accurate but slower. "Any" lets Xenia choose.', category: 'performance', kind: 'select', default: 'any', risky: true, restartRequired: true, options: [{ value: 'any', label: 'Automatic' }, { value: 'fbo', label: 'FBO (fast)' }, { value: 'fsi', label: 'FSI (accurate)' }] },
  { key: 'APU|use_dedicated_xma_thread', label: 'Dedicated audio decoding thread', description: 'Decodes game audio on its own CPU thread for speed. Turning it off can give better sound but is a little slower.', category: 'performance', kind: 'toggle', default: 'true' },
  // ---- audio
  { key: 'APU|mute', label: 'Mute', description: 'Silences all game audio.', category: 'audio', kind: 'toggle', default: 'false' },
  { key: 'APU|apu', label: 'Audio backend', description: 'The audio system Xenia uses. "Any" picks the best available; try SDL if XAudio2 has problems.', category: 'audio', kind: 'select', default: 'any', restartRequired: true, options: [{ value: 'any', label: 'Automatic' }, { value: 'xaudio2', label: 'XAudio2' }, { value: 'sdl', label: 'SDL' }, { value: 'nop', label: 'None (silent)' }] },
  { key: 'APU|xma_decoder', label: 'XMA audio decoder', description: 'Version of the game audio decoder. "New" is the most stable; try "Old" or "Master" if a game\'s audio breaks.', category: 'audio', kind: 'select', default: 'new', risky: true, restartRequired: true, options: [{ value: 'new', label: 'New' }, { value: 'old', label: 'Old' }, { value: 'master', label: 'Master' }, { value: 'fake', label: 'Fake (no audio)' }] },
  { key: 'APU|enable_xmp', label: 'Music player', description: 'Allows the Xbox 360 music player, which some games use for custom soundtracks.', category: 'audio', kind: 'toggle', default: 'true' },
  // ---- system
  { key: 'Content|license_mask', label: 'Arcade game license', description: 'Unlocks the full version of Xbox Live Arcade games that would otherwise run as a trial. "All licenses" can break games.', category: 'system', kind: 'select', default: '0', options: [{ value: '0', label: 'None (trial)' }, { value: '1', label: 'Full version' }, { value: '-1', label: 'All licenses' }] },
  { key: 'Kernel|apply_title_update', label: 'Apply title updates', description: 'Uses installed game updates (title updates) when a game starts.', category: 'system', kind: 'toggle', default: 'true' },
  { key: 'Storage|mount_cache', label: 'Mount cache partition', description: 'Gives games the console\'s cache partition. Some games need it to start.', category: 'system', kind: 'toggle', default: 'true', restartRequired: true },
  { key: 'Storage|mount_scratch', label: 'Mount scratch partition', description: 'Gives games the scratch partition some titles use for temporary data.', category: 'system', kind: 'toggle', default: 'false', restartRequired: true },
  // ---- fixes
  { key: 'General|apply_patches', label: 'Game patches', description: 'Applies the patch files in Xenia\'s patches folder (e.g. 60 FPS or resolution patches) to games that have them.', category: 'fixes', kind: 'toggle', default: 'true' },
  { key: 'GPU|readback_memexport', label: 'Memexport readback', description: 'Lets the CPU read data written by shaders. Needed by a few games but has a large performance cost.', category: 'fixes', kind: 'toggle', default: 'false' },
  { key: 'GPU|clear_memory_page_state', label: 'Clear memory page state', description: 'Fixes missing character models in Team Ninja games (e.g. Ninja Gaiden, Dead or Alive).', category: 'fixes', kind: 'toggle', default: 'false', risky: true },
  { key: 'GPU|mulsc_round_toward_zero', label: 'Volition geometry fix', description: 'Fixes broken geometry in Volition engine games (e.g. Saints Row, Red Faction).', category: 'fixes', kind: 'toggle', default: 'false', risky: true },
  // ---- interface
  { key: 'UI|show_achievement_notification', label: 'Achievement notifications', description: 'Shows a notification on screen when you unlock an achievement.', category: 'interface', kind: 'toggle', default: 'false' },
  { key: 'General|controller_hotkeys', label: 'Controller hotkeys', description: 'Enables Xenia\'s fixed Guide + button shortcuts on Xbox and PlayStation controllers.', category: 'interface', kind: 'toggle', default: 'false' },
];

/** TOML type of every cvar in the schema (DEFINE_bool/int32/uint32/double/string). */
export const XENIA_CVAR_TYPES: Record<string, XeniaCvarType> = {
  'GPU|anisotropic_override': 'int',
  'Display|postprocess_antialiasing': 'string',
  'Display|postprocess_scaling_and_sharpening': 'string',
  'Display|postprocess_ffx_cas_additional_sharpness': 'double',
  'Display|postprocess_ffx_fsr_sharpness_reduction': 'double',
  'Display|postprocess_ffx_fsr_max_upsampling_passes': 'int',
  'Display|postprocess_dither': 'bool',
  'GPU|async_shader_compilation': 'bool',
  'GPU|readback_resolve': 'string',
  'GPU|occlusion_query': 'string',
  'GPU|render_target_path_d3d12': 'string',
  'GPU|render_target_path_vulkan': 'string',
  'APU|use_dedicated_xma_thread': 'bool',
  'APU|mute': 'bool',
  'APU|apu': 'string',
  'APU|xma_decoder': 'string',
  'APU|enable_xmp': 'bool',
  'Content|license_mask': 'int',
  'Kernel|apply_title_update': 'bool',
  'Storage|mount_cache': 'bool',
  'Storage|mount_scratch': 'bool',
  'General|apply_patches': 'bool',
  'GPU|readback_memexport': 'bool',
  'GPU|clear_memory_page_state': 'bool',
  'GPU|mulsc_round_toward_zero': 'bool',
  'UI|show_achievement_notification': 'bool',
  'General|controller_hotkeys': 'bool',
};

/** String cvars where Xenia's default is "" (meaning the value OmniPC shows instead). */
export const XENIA_EMPTY_AS: Record<string, string> = {
  'Display|postprocess_antialiasing': 'none',
  'Display|postprocess_scaling_and_sharpening': 'bilinear',
  'GPU|render_target_path_d3d12': 'any',
  'GPU|render_target_path_vulkan': 'any',
};

/** "Optimize for my PC" suggestions for Xenia. */
export function xeniaOptimize(hw: HardwareProfile): { key: string; value: string; reason: string }[] {
  const out: { key: string; value: string; reason: string }[] = [];
  const strong = hw.tier === 'high' || hw.tier === 'enthusiast';
  out.push({ key: 'GPU|async_shader_compilation', value: 'true', reason: 'Compiling shaders in the background avoids stutter when new effects appear.' });
  out.push({ key: 'GPU|anisotropic_override', value: hw.tier === 'low' ? '3' : '5', reason: hw.tier === 'low' ? '4x keeps textures sharper at a small cost on your GPU.' : 'Your GPU handles 16x anisotropic filtering with no noticeable cost.' });
  if (strong) {
    out.push({ key: 'Display|postprocess_scaling_and_sharpening', value: 'fsr', reason: 'Your GPU can afford FSR for a sharper upscale to your display.' });
    out.push({ key: 'Display|postprocess_antialiasing', value: 'fxaa', reason: 'FXAA is recommended together with FSR and costs little on your GPU.' });
  }
  return out;
}
