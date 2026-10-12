// RetroArch settings shown in OmniPC's settings menu. Keys are "cfg|<key>":
// RetroArchAdapter.applyConfig writes them into retroarch.cfg and per-game
// profiles append them for the session via --appendconfig (profileOverrides).
// Key names, defaults and ranges follow RetroArch's configuration.c,
// config.def.h and the settings/settings_def_*.h tables (video_smooth,
// video_output_misc, shader_preset, frame_delay, black_frame_insertion,
// rewind, run_ahead_frames, audio_state, audio_latency, frame_throttle_general,
// menu_appearance, saving, notification_views/widgets, video_sync) plus the
// documented sample retroarch.cfg.
//
// Deliberately not included: video_driver / video_vsync / video_fullscreen /
// aspect_ratio_index (OmniPC core settings), and a CRT shader preset path:
// current RetroArch no longer reads a plain "video_shader" key from
// retroarch.cfg (presets load from the config folder's global/core/game
// .slangp files), so a preset cannot be selected safely from here.

import type { SettingDef } from '@shared/emulatorSettings';
import type { HardwareProfile } from '@shared/models';

const off = { value: '0', label: 'Off' };

export const RETROARCH_SETTINGS: SettingDef[] = [
  // ---- graphics
  { key: 'cfg|video_smooth', label: 'Bilinear filtering', description: 'Slightly blurs the picture to soften hard pixel edges. Leave off for sharp pixels or when using shaders.', category: 'graphics', kind: 'toggle', default: 'false' },
  { key: 'cfg|video_scale_integer', label: 'Integer scaling', description: 'Scales the picture only by whole numbers so every pixel is the same size; may add black borders.', category: 'graphics', kind: 'toggle', default: 'false' },
  { key: 'cfg|video_shader_enable', label: 'Video shaders', description: 'Applies the shader preset you chose in RetroArch (e.g. a CRT look). Turn off to disable all shaders quickly.', category: 'graphics', kind: 'toggle', default: 'true' },
  { key: 'cfg|video_crop_overscan', label: 'Crop overscan', description: 'Hides the garbage some consoles draw at the screen edges that old TVs never showed.', category: 'graphics', kind: 'toggle', default: 'true', restartRequired: true },
  { key: 'cfg|video_black_frame_insertion', label: 'Black frame insertion', description: 'Inserts black frames between game frames on high-refresh monitors to greatly reduce motion blur, at the cost of brightness. Use 1 at 120 Hz, 2 at 180 Hz, 3 at 240 Hz. Can flicker.', category: 'graphics', kind: 'select', default: '0', risky: true, options: [off, { value: '1', label: '1 frame (120 Hz)' }, { value: '2', label: '2 frames (180 Hz)' }, { value: '3', label: '3 frames (240 Hz)' }] },
  // ---- performance / latency
  { key: 'cfg|run_ahead_enabled', label: 'Run-ahead', description: 'Runs the game a few frames ahead and rolls back to remove the built-in input lag of the original console. Costs CPU; not every core supports it.', category: 'performance', kind: 'toggle', default: 'false' },
  { key: 'cfg|run_ahead_frames', label: 'Run-ahead frames', description: 'How many frames to run ahead. 1 suits most games; more removes more lag but can cause jitter if it exceeds the game\'s own lag.', category: 'performance', kind: 'slider', min: 1, max: 4, step: 1, default: '1' },
  { key: 'cfg|run_ahead_secondary_instance', label: 'Run-ahead second instance', description: 'Uses a second copy of the core for run-ahead, which avoids audio glitches. Turn off if a core misbehaves with it.', category: 'performance', kind: 'toggle', default: 'true' },
  { key: 'cfg|preemptive_frames_enable', label: 'Preemptive frames', description: 'A lighter alternative to run-ahead that only re-runs frames when your input changes. Do not combine with run-ahead.', category: 'performance', kind: 'toggle', default: 'false' },
  { key: 'cfg|video_frame_delay', label: 'Frame delay', description: 'Waits this many milliseconds after vsync before running the core, reducing input lag. Too high causes stutter; raise slowly on a fast PC.', category: 'performance', kind: 'slider', min: 0, max: 15, step: 1, unit: 'ms', default: '0' },
  { key: 'cfg|video_frame_delay_auto', label: 'Automatic frame delay', description: 'Lowers the frame delay automatically when it would cause stutter.', category: 'performance', kind: 'toggle', default: 'false' },
  { key: 'cfg|video_threaded', label: 'Threaded video', description: 'Runs video output on its own thread. Can help slow PCs but adds latency and stutter; usually best left off.', category: 'performance', kind: 'toggle', default: 'false' },
  { key: 'cfg|video_hard_sync', label: 'Hard GPU sync', description: 'Forces the CPU and GPU to stay in lockstep to reduce input lag (OpenGL only). Costs performance.', category: 'performance', kind: 'toggle', default: 'false' },
  { key: 'cfg|fastforward_ratio', label: 'Fast-forward speed', description: 'Maximum speed while fast-forwarding, e.g. 4 = four times normal. 0 means as fast as your PC can go.', category: 'performance', kind: 'number', min: 0, max: 50, step: 0.5, unit: 'x', default: '0' },
  { key: 'cfg|fastforward_frameskip', label: 'Fast-forward frame skipping', description: 'Skips drawing frames while fast-forwarding so it runs faster.', category: 'performance', kind: 'toggle', default: 'true' },
  { key: 'cfg|rewind_enable', label: 'Rewind', description: 'Lets you rewind gameplay with the rewind hotkey. Uses extra CPU and memory and is not supported by every core.', category: 'performance', kind: 'toggle', default: 'false' },
  { key: 'cfg|rewind_granularity', label: 'Rewind frames', description: 'How many frames each rewind step goes back. Higher rewinds faster and is cheaper on slow PCs.', category: 'performance', kind: 'number', min: 1, max: 32768, step: 1, default: '1' },
  // ---- audio
  { key: 'cfg|audio_volume', label: 'Volume gain', description: 'Audio gain in decibels. 0 is normal volume; negative values are quieter.', category: 'audio', kind: 'slider', min: -80, max: 12, step: 1, unit: 'dB', default: '0' },
  { key: 'cfg|audio_mute_enable', label: 'Mute', description: 'Silences all audio.', category: 'audio', kind: 'toggle', default: 'false' },
  { key: 'cfg|audio_latency', label: 'Audio latency', description: 'Audio buffer size in milliseconds. Lower reduces delay but can crackle; raise it if audio stutters.', category: 'audio', kind: 'number', min: 0, max: 512, step: 8, unit: 'ms', default: '64', perGame: false },
  // ---- system
  { key: 'cfg|savestate_auto_save', label: 'Auto save state on exit', description: 'Saves a state automatically when you close a game.', category: 'system', kind: 'toggle', default: 'false' },
  { key: 'cfg|savestate_auto_load', label: 'Auto load state on start', description: 'Resumes from the automatic save state when a game starts.', category: 'system', kind: 'toggle', default: 'false' },
  { key: 'cfg|savestate_auto_index', label: 'Increment save state slot', description: 'Saves each new state into the next free slot instead of overwriting the current one.', category: 'system', kind: 'toggle', default: 'false' },
  // ---- interface
  { key: 'cfg|menu_driver', label: 'Menu style', description: 'Look of the RetroArch menu: Ozone (default), XMB (PlayStation-style), RGUI (retro, lightweight) or MaterialUI (touch).', category: 'interface', kind: 'select', default: 'ozone', perGame: false, restartRequired: true, options: [{ value: 'ozone', label: 'Ozone' }, { value: 'xmb', label: 'XMB' }, { value: 'rgui', label: 'RGUI' }, { value: 'glui', label: 'MaterialUI' }] },
  { key: 'cfg|menu_pause_libretro', label: 'Pause when menu is open', description: 'Pauses the game while the RetroArch menu is shown.', category: 'interface', kind: 'toggle', default: 'true', perGame: false },
  { key: 'cfg|fps_show', label: 'Show FPS', description: 'Shows the current frame rate on screen.', category: 'interface', kind: 'toggle', default: 'false' },
  { key: 'cfg|video_font_enable', label: 'On-screen notifications', description: 'Shows messages such as "State saved" on screen.', category: 'interface', kind: 'toggle', default: 'true' },
];

/** "Optimize for my PC" suggestions for RetroArch. */
export function retroarchOptimize(hw: HardwareProfile): { key: string; value: string; reason: string }[] {
  const out: { key: string; value: string; reason: string }[] = [];
  const strong = hw.tier === 'high' || hw.tier === 'enthusiast';
  if (strong && hw.cpu.cores >= 4) {
    out.push({ key: 'cfg|run_ahead_enabled', value: 'true', reason: `Your ${hw.cpu.cores}-core CPU can run the game a frame ahead to remove the original console's input lag.` });
    out.push({ key: 'cfg|video_frame_delay_auto', value: 'true', reason: 'Lets RetroArch lower input lag further while staying stutter-free on your PC.' });
  }
  if (hw.tier === 'low') {
    out.push({ key: 'cfg|run_ahead_enabled', value: 'false', reason: 'Run-ahead doubles the CPU work per frame, which is too much for your PC.' });
    out.push({ key: 'cfg|rewind_enable', value: 'false', reason: 'Rewind costs CPU time every frame; keeping it off helps slower PCs.' });
  }
  return out;
}
