// PPSSPP settings shown in OmniPC's settings menu. Keys are "Section|Key" in
// memstick/PSP/SYSTEM/ppsspp.ini, written by PpssppAdapter.applyConfig and, per game,
// by its session overrides (profileOverrides).
// Names, sections and defaults follow Core/Config.cpp (generalSettings, cpuSettings,
// graphicsSettings, soundSettings, systemParamSettings, g_sectionMeta); enum values
// follow Core/ConfigValues.h (CPUCore, TextureFiltering, IOTIMING_*, SkipGPUReadbackMode,
// PSP_MODEL_*) and Core/HLE/sceUtility.h (PSP_SYSTEMPARAM_LANGUAGE_*, _BUTTON_*); option
// lists and ranges follow UI/GameSettingsScreen.cpp and UI/DeveloperToolsScreen.cpp.
// PPSSPP stores booleans as True/False and choices as integers.
//
// Not included: post-processing and GPU texture-upscaling shaders ([PostShaderList] and
// Graphics.TextureShader take shader names from assets/shaders/defaultshaders.ini, which
// is not in the reference clone) and the audio device (machine-specific).

import type { SettingDef } from '@shared/emulatorSettings';
import type { HardwareProfile } from '@shared/models';

const opts = (labels: string[], first = 0) => labels.map((label, i) => ({ value: String(i + first), label }));

export const PPSSPP_SETTINGS: SettingDef[] = [
  // ---- graphics
  { key: 'Graphics|TextureFiltering', label: 'Texture filtering', description: 'How textures are smoothed. "Auto" follows the game; "Linear" smooths everything; "Nearest" keeps pixels sharp.', category: 'graphics', kind: 'select', default: '1', options: opts(['Auto', 'Nearest', 'Linear', 'Auto (max quality)'], 1) },
  { key: 'Graphics|Smart2DTexFiltering', label: 'Smart 2D texture filtering', description: 'Avoids blurry edges on 2D backgrounds and sprites when using smooth filtering.', category: 'graphics', kind: 'toggle', default: 'false' },
  { key: 'Graphics|AnisotropyLevel', label: 'Anisotropic filtering', description: 'Keeps textures on floors and walls sharp at an angle. Cheap on modern GPUs.', category: 'graphics', kind: 'select', default: '4', options: opts(['Off', '2x', '4x', '8x', '16x']) },
  { key: 'Graphics|MultiSampleLevel', label: 'Anti-aliasing (MSAA)', description: 'Smooths jagged polygon edges. Costs GPU time; not available with "Skip buffer effects".', category: 'graphics', kind: 'select', default: '0', options: opts(['Off', '2x', '4x', '8x', '16x']) },
  { key: 'Graphics|TexScalingLevel', label: 'Texture upscaling', description: 'Upscales game textures on the CPU for a smoother, more detailed look. CPU heavy; may cause stutter.', category: 'graphics', kind: 'select', default: '1', options: opts(['Off', '2x', '3x', '4x', '5x'], 1) },
  { key: 'Graphics|TexScalingType', label: 'Texture upscaler', description: 'Algorithm used by texture upscaling. xBRZ suits cartoon-like art; Bicubic is softer.', category: 'graphics', kind: 'select', default: '0', options: opts(['xBRZ', 'Hybrid', 'Bicubic', 'Hybrid + Bicubic']) },
  { key: 'Graphics|TexDeposterize', label: 'Deposterize', description: 'Fixes colour banding in upscaled textures.', category: 'graphics', kind: 'toggle', default: 'false' },
  { key: 'Graphics|ReplaceTextures', label: 'Texture packs', description: 'Loads replacement textures from PPSSPP\'s TEXTURES folder when a game has a pack installed.', category: 'graphics', kind: 'toggle', default: 'true' },
  { key: 'Graphics|SplineBezierQuality', label: 'Curve quality', description: 'Smoothness of curved surfaces, used by only a few games. Lower it if those games run slowly.', category: 'graphics', kind: 'select', default: '2', options: opts(['Low', 'Medium', 'High']) },
  // ---- performance
  { key: 'Graphics|FrameSkip', label: 'Frame skipping', description: 'Skips drawing frames to keep the game at full speed on slow PCs. Makes motion choppy.', category: 'performance', kind: 'select', default: '0', options: opts(['Off', '1', '2', '3', '4', '5', '6', '7', '8']) },
  { key: 'Graphics|AutoFrameSkip', label: 'Auto frame skip', description: 'Skips frames only when the game would slow down.', category: 'performance', kind: 'toggle', default: 'false' },
  { key: 'Graphics|HardwareTransform', label: 'Hardware transform', description: 'Does 3D geometry on the GPU. Much faster; turn off only for a game with broken graphics.', category: 'performance', kind: 'toggle', default: 'true' },
  { key: 'Graphics|InflightFrames', label: 'Buffer graphics commands', description: 'Buffering one frame is faster but adds a little input lag.', category: 'performance', kind: 'select', default: '2', options: opts(['No buffer', 'Up to 1'], 1) },
  { key: 'Graphics|RenderDuplicateFrames', label: 'Render duplicate frames to 60 Hz', description: 'Makes motion smoother in games that run below 60 FPS.', category: 'performance', kind: 'toggle', default: 'false' },
  { key: 'Graphics|SkipBufferEffects', label: 'Skip buffer effects', description: 'Faster, but some games lose graphics or effects. Speed hack for weak PCs.', category: 'performance', kind: 'toggle', default: 'false', risky: true },
  { key: 'Graphics|SkipGPUReadbackMode', label: 'Skip GPU readbacks', description: 'Avoids slow copies from GPU to CPU. Faster, but can break effects in some games.', category: 'performance', kind: 'select', default: '0', risky: true, options: opts(['No', 'Skip', 'Copy to texture']) },
  { key: 'CPU|IOTimingMethod', label: 'I/O timing', description: 'How disc reads are timed. "Simulate UMD delays" fixes games that hang or crash during loading.', category: 'performance', kind: 'select', default: '0', options: opts(['Fast (lag on slow storage)', 'Host (bugs, less lag)', 'Simulate UMD delays', 'Simulate UMD slow reading speed']) },
  { key: 'CPU|FastMemoryAccess', label: 'Fast memory', description: 'Faster memory emulation. Turn off only if a game crashes.', category: 'performance', kind: 'toggle', default: 'true' },
  { key: 'CPU|CPUCore', label: 'CPU core', description: 'The JIT is by far the fastest. Use another core only to work around a game-specific bug.', category: 'performance', kind: 'select', default: '1', risky: true, options: opts(['Interpreter', 'Dynarec (JIT)', 'IR interpreter', 'JIT using IR']) },
  { key: 'CPU|CPUSpeed', label: 'CPU clock', description: 'Overrides the emulated PSP CPU speed in MHz (0 = automatic). Higher clocks can smooth slow games but can break them.', category: 'performance', kind: 'slider', min: 0, max: 1000, step: 1, unit: 'MHz', default: '0', risky: true },
  // ---- audio
  { key: 'Sound|Enable', label: 'Sound', description: 'Turns game audio on or off.', category: 'audio', kind: 'toggle', default: 'true' },
  { key: 'Sound|GameVolume', label: 'Volume', description: 'Game audio volume.', category: 'audio', kind: 'slider', min: 0, max: 100, step: 5, unit: '%', default: '100' },
  { key: 'Sound|ReverbRelativeVolume', label: 'Reverb volume', description: 'Volume of the PSP\'s reverb effect relative to the game audio.', category: 'audio', kind: 'slider', min: 0, max: 200, step: 5, unit: '%', default: '100' },
  // ---- system
  { key: 'SystemParam|GameLanguage', label: 'Game language', description: 'The PSP system language games use for text and audio, when they support it. Auto follows your PC\'s language.', category: 'system', kind: 'select', default: '-1', perGame: false, options: opts(['Auto', 'Japanese', 'English', 'French', 'Spanish', 'German', 'Italian', 'Dutch', 'Portuguese', 'Russian', 'Korean', 'Chinese (traditional)', 'Chinese (simplified)'], -1) },
  { key: 'SystemParam|ButtonPreference', label: 'Confirm button', description: 'Which button confirms in system menus and many games. Japanese games traditionally use O.', category: 'system', kind: 'select', default: '1', options: opts(['Use O to confirm', 'Use X to confirm']) },
  { key: 'SystemParam|PSPModel', label: 'PSP model', description: 'PSP-2000/3000 has more memory, which some games and mods need. Change only if a game requires PSP-1000.', category: 'system', kind: 'select', default: '1', restartRequired: true, options: opts(['PSP-1000', 'PSP-2000/3000']) },
  { key: 'General|RewindSnapshotInterval', label: 'Rewind snapshot interval', description: 'Seconds between rewind snapshots (0 = rewind off). Use the rewind hotkey to go back.', category: 'system', kind: 'slider', min: 0, max: 60, step: 1, unit: 's', default: '0' },
  // ---- fixes & hacks
  { key: 'General|EnableCheats', label: 'Cheats', description: 'Enables CWCheat codes from PPSSPP\'s cheats folder.', category: 'fixes', kind: 'toggle', default: 'false' },
  { key: 'Graphics|BloomHack', label: 'Lower resolution for effects', description: 'Renders bloom and blur effects at a lower resolution, fixing artifacts some games show when upscaled.', category: 'fixes', kind: 'select', default: '0', options: opts(['Off', 'Safe', 'Balanced', 'Aggressive']) },
];

const TOGGLES = new Set(PPSSPP_SETTINGS.filter((d) => d.kind === 'toggle').map((d) => d.key));

/** Encodes a menu value the way PPSSPP writes it (booleans as True/False). */
export function ppssppValue(key: string, value: string): string {
  if (TOGGLES.has(key)) {
    if (/^(true|1|yes|on)$/i.test(value.trim())) return 'True';
    if (/^(false|0|no|off)$/i.test(value.trim())) return 'False';
  }
  return value;
}

/** "Optimize for my PC" suggestions for PPSSPP. */
export function ppssppOptimize(hw: HardwareProfile): { key: string; value: string; reason: string }[] {
  const out: { key: string; value: string; reason: string }[] = [];
  const strong = hw.tier === 'high' || hw.tier === 'enthusiast';
  out.push({ key: 'Graphics|AnisotropyLevel', value: hw.tier === 'low' ? '2' : '4', reason: hw.tier === 'low' ? 'Sharper textures at a small cost on your GPU.' : 'Your GPU handles 16x anisotropic filtering with no noticeable cost.' });
  if (strong && hw.cpu.cores >= 6) out.push({ key: 'Graphics|TexScalingLevel', value: '3', reason: `Your ${hw.cpu.cores}-core CPU can upscale textures 3x without stutter.` });
  if (strong) out.push({ key: 'Graphics|MultiSampleLevel', value: '2', reason: 'Your GPU can smooth edges with 4x MSAA.' });
  if (hw.tier === 'low') out.push({ key: 'Graphics|AutoFrameSkip', value: 'true', reason: 'Auto frame skip keeps games at full speed when your PC cannot render every frame.' });
  return out;
}
