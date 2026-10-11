// PCSX2 settings shown in OmniPC's settings menu. Keys are "Section|Key" in
// PCSX2.ini, written by Pcsx2Adapter.applyConfig through EmulatorSettings.advanced.
// Names, ranges and defaults follow pcsx2/Pcsx2Config.cpp and pcsx2/Config.h
// (GSOptions, SpeedhackOptions, SPU2Options, EmuCore) and the Qt settings UI.

import type { SettingDef } from '@shared/emulatorSettings';
import type { HardwareProfile } from '@shared/models';

const GS = 'EmuCore/GS';

export const PCSX2_SETTINGS: SettingDef[] = [
  // ---- graphics
  { key: `${GS}|MaxAnisotropy`, label: 'Anisotropic filtering', description: 'Keeps textures on floors and walls sharp at an angle. Cheap on modern GPUs.', category: 'graphics', kind: 'select', default: '0', recommended: '16', options: [{ value: '0', label: 'Off' }, { value: '2', label: '2x' }, { value: '4', label: '4x' }, { value: '8', label: '8x' }, { value: '16', label: '16x' }] },
  { key: `${GS}|TriFilter`, label: 'Trilinear filtering', description: 'Smooths the transition between texture detail levels. "Automatic" lets PCSX2 decide per game.', category: 'graphics', kind: 'select', default: '-1', options: [{ value: '-1', label: 'Automatic' }, { value: '0', label: 'Off' }, { value: '1', label: 'Trilinear (PS2)' }, { value: '2', label: 'Trilinear (forced)' }] },
  { key: `${GS}|accurate_blending_unit`, label: 'Blending accuracy', description: 'How exactly PS2 transparency effects are reproduced. Higher fixes more effects but needs a stronger GPU.', category: 'graphics', kind: 'select', default: '1', options: [{ value: '0', label: 'Minimum' }, { value: '1', label: 'Basic' }, { value: '2', label: 'Medium' }, { value: '3', label: 'High' }, { value: '4', label: 'Full' }, { value: '5', label: 'Maximum' }] },
  { key: `${GS}|dithering_ps2`, label: 'Dithering', description: 'Reproduces the PS2\'s colour dithering. "Unscaled" looks most like the console.', category: 'graphics', kind: 'select', default: '2', options: [{ value: '0', label: 'Off' }, { value: '1', label: 'Scaled' }, { value: '2', label: 'Unscaled' }] },
  { key: `${GS}|deinterlace_mode`, label: 'Deinterlacing', description: 'Removes the shaking/combing of interlaced games. Leave on Automatic unless a game shimmers.', category: 'graphics', kind: 'select', default: '0', options: [{ value: '0', label: 'Automatic' }, { value: '1', label: 'Off' }, { value: '2', label: 'Weave (top first)' }, { value: '3', label: 'Weave (bottom first)' }, { value: '4', label: 'Bob (top first)' }, { value: '5', label: 'Bob (bottom first)' }, { value: '6', label: 'Blend (top first)' }, { value: '7', label: 'Blend (bottom first)' }, { value: '8', label: 'Adaptive (top first)' }] },
  { key: `${GS}|pcrtc_antiblur`, label: 'Anti-blur', description: 'Removes the blur filter many PS2 games apply to the whole screen.', category: 'graphics', kind: 'toggle', default: 'true' },
  { key: `${GS}|IntegerScaling`, label: 'Integer scaling', description: 'Scales the picture only by whole numbers for perfectly even pixels; may add black borders.', category: 'graphics', kind: 'toggle', default: 'false' },
  { key: `${GS}|fxaa`, label: 'FXAA', description: 'Light anti-aliasing applied to the final image. Slightly softens edges.', category: 'graphics', kind: 'toggle', default: 'false' },
  { key: `${GS}|CASMode`, label: 'Sharpening (AMD CAS)', description: 'Sharpens the final image. "Sharpen and resize" can also upscale.', category: 'graphics', kind: 'select', default: '0', options: [{ value: '0', label: 'Off' }, { value: '1', label: 'Sharpen only' }, { value: '2', label: 'Sharpen and resize' }] },
  { key: `${GS}|TVShader`, label: 'TV shader', description: 'Retro screen effects such as scanlines or a CRT look.', category: 'graphics', kind: 'select', default: '0', options: [{ value: '0', label: 'None' }, { value: '1', label: 'Scanlines' }, { value: '2', label: 'Diagonal' }, { value: '3', label: 'Triangular' }, { value: '4', label: 'Wave' }, { value: '5', label: 'Lottes CRT' }, { value: '6', label: '4x RGSS supersampling' }, { value: '7', label: 'Nx AGSS supersampling' }] },
  { key: `${GS}|LoadTextureReplacements`, label: 'Texture packs', description: 'Loads HD texture replacements from PCSX2\'s textures folder when a game has a pack installed.', category: 'graphics', kind: 'toggle', default: 'false' },
  // ---- performance
  { key: `${GS}|texture_preloading`, label: 'Texture preloading', description: 'Uploads whole textures to the GPU at once. "Full" is fastest on most PCs.', category: 'performance', kind: 'select', default: '2', options: [{ value: '0', label: 'Off' }, { value: '1', label: 'Partial' }, { value: '2', label: 'Full' }] },
  { key: 'EmuCore/Speedhacks|vuThread', label: 'Multi-threaded VU1 (MTVU)', description: 'Runs part of the PS2 on a separate CPU core. A big speed-up on CPUs with 4 or more cores; rarely breaks a game.', category: 'performance', kind: 'toggle', default: 'false', recommended: 'true' },
  { key: 'EmuCore/Speedhacks|EECycleRate', label: 'EE cycle rate', description: 'Overclocks or underclocks the PS2 CPU. Overclocking can smooth games that slow down on the console; underclocking helps weak PCs.', category: 'performance', kind: 'select', default: '0', risky: true, options: [{ value: '-3', label: '50% (underclock)' }, { value: '-2', label: '60% (underclock)' }, { value: '-1', label: '75% (underclock)' }, { value: '0', label: '100% (normal)' }, { value: '1', label: '130% (overclock)' }, { value: '2', label: '180% (overclock)' }, { value: '3', label: '300% (overclock)' }] },
  { key: 'EmuCore/Speedhacks|EECycleSkip', label: 'EE cycle skipping', description: 'Skips PS2 CPU cycles to gain speed on slow PCs. Can cause stutter or glitches.', category: 'performance', kind: 'select', default: '0', risky: true, options: [{ value: '0', label: 'Off' }, { value: '1', label: 'Mild' }, { value: '2', label: 'Moderate' }, { value: '3', label: 'Maximum' }] },
  // ---- audio
  { key: 'SPU2/Output|StandardVolume', label: 'Volume', description: 'Game audio volume.', category: 'audio', kind: 'slider', min: 0, max: 200, step: 5, unit: '%', default: '100' },
  { key: 'SPU2/Output|OutputMuted', label: 'Mute', description: 'Silences all game audio.', category: 'audio', kind: 'toggle', default: 'false' },
  // ---- system / fixes
  { key: 'EmuCore|EnableFastBoot', label: 'Fast boot', description: 'Skips the PS2 logo and BIOS screen when a game starts.', category: 'system', kind: 'toggle', default: 'true' },
  { key: 'EmuCore|EnableWideScreenPatches', label: 'Widescreen patches', description: 'Makes supported games render in true 16:9 instead of stretching. Best paired with 16:9 aspect ratio.', category: 'fixes', kind: 'toggle', default: 'false' },
  { key: 'EmuCore|EnableNoInterlacingPatches', label: 'No-interlacing patches', description: 'Removes interlacing in supported games for a sharper, steadier picture.', category: 'fixes', kind: 'toggle', default: 'false' },
  { key: 'EmuCore|EnableCheats', label: 'Cheats', description: 'Enables cheat files (.pnach) in PCSX2\'s cheats folder.', category: 'fixes', kind: 'toggle', default: 'false' },
  { key: `${GS}|hw_mipmap`, label: 'Hardware mipmapping', description: 'Emulates PS2 texture detail levels on the GPU. Turn off only if a game shows blurry or missing textures.', category: 'fixes', kind: 'toggle', default: 'true' },
];

/** "Optimize for my PC" suggestions for PCSX2. */
export function pcsx2Optimize(hw: HardwareProfile): { key: string; value: string; reason: string }[] {
  const out: { key: string; value: string; reason: string }[] = [];
  const cores = hw.cpu.cores;
  if (cores >= 4) out.push({ key: 'EmuCore/Speedhacks|vuThread', value: 'true', reason: `Your CPU has ${cores} cores, so PCSX2 can run VU1 on its own thread for a large speed-up.` });
  const strong = hw.tier === 'high' || hw.tier === 'enthusiast';
  out.push({ key: `${GS}|MaxAnisotropy`, value: hw.tier === 'low' ? '4' : '16', reason: hw.tier === 'low' ? 'Sharper textures at a small cost on your GPU.' : 'Your GPU handles 16x anisotropic filtering with no noticeable cost.' });
  out.push({ key: `${GS}|accurate_blending_unit`, value: strong ? '2' : '1', reason: strong ? 'Your GPU can afford more accurate transparency effects.' : 'Basic blending keeps games fast on your GPU.' });
  if (hw.tier === 'low') out.push({ key: `${GS}|texture_preloading`, value: '2', reason: 'Full texture preloading is the fastest option.' });
  return out;
}
