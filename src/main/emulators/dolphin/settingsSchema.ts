// Dolphin settings shown in OmniPC's settings menu. Keys are "File|Section|Key"
// (Dolphin.ini or GFX.ini under User/Config), written by DolphinAdapter.applyConfig
// and, per game, as -C overrides through DolphinAdapter.profileArgs.
// Names, sections and defaults follow Source/Core/Core/Config/GraphicsSettings.cpp
// and Source/Core/Core/Config/MainSettings.cpp; enum values follow
// Source/Core/VideoCommon/VideoConfig.h (ShaderCompilationMode, TextureFilteringMode,
// AnisotropicFilteringMode, OutputResamplingMode). Dolphin stores booleans as
// True/False and enums as their integer value.
//
// Not included: Wii language and Wii widescreen (SYSCONF IPL.LNG / IPL.AR live in the
// Wii NAND's SYSCONF file, not in an INI), GameCube language (value mapping is in
// DiscIO, not in the reference clone) and the audio backend (names live in AudioCommon,
// also not in the clone).

import type { SettingDef } from '@shared/emulatorSettings';
import type { HardwareProfile } from '@shared/models';

const GFX = 'GFX.ini';
const MAIN = 'Dolphin.ini';

export const DOLPHIN_SETTINGS: SettingDef[] = [
  // ---- graphics
  { key: `${GFX}|Settings|MSAA`, label: 'Anti-aliasing (MSAA)', description: 'Smooths jagged polygon edges. Costs GPU time; 2x or 4x is a good balance.', category: 'graphics', kind: 'select', default: '1', options: [{ value: '1', label: 'Off' }, { value: '2', label: '2x' }, { value: '4', label: '4x' }, { value: '8', label: '8x' }] },
  { key: `${GFX}|Settings|SSAA`, label: 'Supersampling (SSAA)', description: 'Turns the MSAA setting into supersampling, which also smooths textures and shading. Much heavier than MSAA.', category: 'graphics', kind: 'toggle', default: 'false' },
  { key: `${GFX}|Enhancements|MaxAnisotropy`, label: 'Anisotropic filtering', description: 'Keeps textures on floors and walls sharp at an angle. "Default" uses what the game asks for.', category: 'graphics', kind: 'select', default: '-1', recommended: '4', options: [{ value: '-1', label: 'Default' }, { value: '0', label: '1x' }, { value: '1', label: '2x' }, { value: '2', label: '4x' }, { value: '3', label: '8x' }, { value: '4', label: '16x' }] },
  { key: `${GFX}|Enhancements|ForceTextureFiltering`, label: 'Texture filtering', description: 'Forces smooth (linear) or sharp (nearest) texture filtering. Leave on Default unless you want a pixelated or softer look.', category: 'graphics', kind: 'select', default: '0', options: [{ value: '0', label: 'Default' }, { value: '1', label: 'Force nearest' }, { value: '2', label: 'Force linear' }] },
  { key: `${GFX}|Enhancements|OutputResampling`, label: 'Output resampling', description: 'How the final image is scaled to your window. Sharp Bilinear or Area Sampling look cleaner when the window is not an exact multiple of the game resolution.', category: 'graphics', kind: 'select', default: '0', options: [{ value: '0', label: 'Default' }, { value: '1', label: 'Bilinear' }, { value: '2', label: 'B-Spline' }, { value: '3', label: 'Mitchell-Netravali' }, { value: '4', label: 'Catmull-Rom' }, { value: '5', label: 'Sharp Bilinear' }, { value: '6', label: 'Area sampling' }] },
  { key: `${GFX}|Enhancements|PostProcessingShader`, label: 'Post-processing shader', description: 'Name of a shader from Dolphin\'s Shaders folder (without the extension) applied to the final image, e.g. for a CRT look. Leave empty for none.', category: 'graphics', kind: 'text', default: '' },
  { key: `${GFX}|Enhancements|ForceTrueColor`, label: 'Force 24-bit colour', description: 'Renders in full colour instead of the console\'s 18-bit colour, removing banding. Turn off only if a game\'s colours look wrong.', category: 'graphics', kind: 'toggle', default: 'true' },
  { key: `${GFX}|Enhancements|DisableCopyFilter`, label: 'Disable copy filter', description: 'Skips the blur many games apply to copied frames, for a sharper image at higher resolutions.', category: 'graphics', kind: 'toggle', default: 'true' },
  { key: `${GFX}|Enhancements|ArbitraryMipmapDetection`, label: 'Arbitrary mipmap detection', description: 'Detects games that use special texture detail levels for effects (e.g. fog or water) and keeps them working at higher resolutions.', category: 'graphics', kind: 'toggle', default: 'false' },
  { key: `${GFX}|Settings|EnablePixelLighting`, label: 'Per-pixel lighting', description: 'Calculates lighting per pixel instead of per vertex for smoother lighting. Small GPU cost; can change how some games look.', category: 'graphics', kind: 'toggle', default: 'false' },
  { key: `${GFX}|Settings|HiresTextures`, label: 'Load custom textures', description: 'Loads HD texture packs from Dolphin\'s Load/Textures folder when a game has one installed.', category: 'graphics', kind: 'toggle', default: 'false' },
  // ---- performance
  { key: `${MAIN}|Core|CPUThread`, label: 'Dual core', description: 'Runs the emulated GPU on its own CPU thread. A big speed-up; a few games become unstable with it.', category: 'performance', kind: 'toggle', default: 'false', recommended: 'true', restartRequired: true },
  { key: `${GFX}|Settings|ShaderCompilationMode`, label: 'Shader compilation', description: 'How Dolphin handles new shaders. "Specialized" can stutter the first time an effect appears; the ubershader modes avoid stutter at a GPU cost.', category: 'performance', kind: 'select', default: '0', options: [{ value: '0', label: 'Specialized (default)' }, { value: '1', label: 'Exclusive ubershaders' }, { value: '2', label: 'Hybrid ubershaders' }, { value: '3', label: 'Skip drawing' }] },
  { key: `${GFX}|Settings|WaitForShadersBeforeStarting`, label: 'Compile shaders before starting', description: 'Builds all cached shaders before the game starts, so there is less stutter during play but a longer start.', category: 'performance', kind: 'toggle', default: 'false' },
  { key: `${GFX}|Settings|BackendMultithreading`, label: 'Graphics backend multithreading', description: 'Uses an extra CPU thread to submit graphics work (Vulkan/D3D12). Usually faster; turn off only to debug crashes.', category: 'performance', kind: 'toggle', default: 'true' },
  { key: `${GFX}|Settings|EnableGPUTextureDecoding`, label: 'GPU texture decoding', description: 'Decodes textures on the GPU instead of the CPU. Helps CPU-limited PCs; can be slower on weak GPUs.', category: 'performance', kind: 'toggle', default: 'false' },
  { key: `${MAIN}|Core|OverclockEnable`, label: 'CPU clock override', description: 'Enables the emulated CPU clock multiplier below. Can smooth games that slow down on the console, but breaks some games.', category: 'performance', kind: 'toggle', default: 'false', risky: true },
  { key: `${MAIN}|Core|Overclock`, label: 'CPU clock multiplier', description: 'Emulated CPU speed when the clock override is on (1 = normal). Higher needs a much faster PC.', category: 'performance', kind: 'slider', min: 0.5, max: 4, step: 0.25, unit: 'x', default: '1', risky: true },
  { key: `${MAIN}|Core|FastDiscSpeed`, label: 'Speed up disc transfer', description: 'Loads data from the disc faster than real hardware for shorter loading screens. Can break games that rely on disc timing.', category: 'performance', kind: 'toggle', default: 'false', risky: true },
  // ---- audio
  { key: `${MAIN}|DSP|Volume`, label: 'Volume', description: 'Game audio volume.', category: 'audio', kind: 'slider', min: 0, max: 100, step: 5, unit: '%', default: '100' },
  { key: `${MAIN}|DSP|Muted`, label: 'Mute', description: 'Silences all game audio.', category: 'audio', kind: 'toggle', default: 'false' },
  { key: `${MAIN}|Core|DSPHLE`, label: 'Fast audio emulation (HLE)', description: 'High-level audio emulation is much faster. Turn off (LLE) only for the few games with broken audio.', category: 'audio', kind: 'toggle', default: 'true', restartRequired: true },
  // ---- system
  { key: `${MAIN}|Core|SkipIPL`, label: 'Skip GameCube boot menu', description: 'Starts games directly instead of showing the GameCube boot animation (which needs an IPL dump).', category: 'system', kind: 'toggle', default: 'true' },
  // ---- fixes & hacks
  { key: `${GFX}|Settings|wideScreenHack`, label: 'Widescreen hack', description: 'Forces 16:9 rendering in 4:3 games by widening the view. Causes stretched or missing edges in many games; prefer widescreen cheats/patches when available.', category: 'fixes', kind: 'toggle', default: 'false', risky: true },
  { key: `${MAIN}|Core|EnableCheats`, label: 'Cheats', description: 'Enables Action Replay and Gecko codes set up in Dolphin\'s game properties.', category: 'fixes', kind: 'toggle', default: 'false' },
  { key: `${GFX}|Hacks|EFBAccessEnable`, label: 'EFB access from CPU', description: 'Lets the game read the frame buffer. Off ("skip EFB access") is faster but breaks some effects and features like targeting.', category: 'fixes', kind: 'toggle', default: 'false' },
  { key: `${GFX}|Hacks|EFBToTextureEnable`, label: 'Store EFB copies to texture only', description: 'Keeps frame copies on the GPU. Faster; turn off when a game shows missing or black effects.', category: 'fixes', kind: 'toggle', default: 'true' },
  { key: `${GFX}|Hacks|XFBToTextureEnable`, label: 'Store XFB copies to texture only', description: 'Keeps the final frame on the GPU. Faster; turn off only for games that draw directly into the frame (rare).', category: 'fixes', kind: 'toggle', default: 'true' },
  { key: `${GFX}|Hacks|DeferEFBCopies`, label: 'Defer EFB copies to RAM', description: 'Delays copying frames to emulated memory. Faster; turn off if a game shows flickering or stale images.', category: 'fixes', kind: 'toggle', default: 'true' },
  { key: `${GFX}|Hacks|ImmediateXFBEnable`, label: 'Immediately present XFB', description: 'Shows frames as soon as they are copied, lowering input lag. Can cause flicker or tearing in some games.', category: 'fixes', kind: 'toggle', default: 'false', risky: true },
  { key: `${GFX}|Hacks|BBoxEnable`, label: 'Bounding box emulation', description: 'Needed by a few games (e.g. Paper Mario). Slow; Dolphin enables it for those games automatically.', category: 'fixes', kind: 'toggle', default: 'false' },
  { key: `${GFX}|Hacks|VertexRounding`, label: 'Vertex rounding', description: 'Rounds 2D vertices to whole pixels, fixing lines and seams in some 2D games at higher resolutions.', category: 'fixes', kind: 'toggle', default: 'false' },
];

const TOGGLES = new Set(DOLPHIN_SETTINGS.filter((d) => d.kind === 'toggle').map((d) => d.key));

/** Encodes a menu value the way Dolphin writes it (booleans as True/False). */
export function dolphinValue(key: string, value: string): string {
  if (TOGGLES.has(key)) {
    if (/^(true|1|yes|on)$/i.test(value.trim())) return 'True';
    if (/^(false|0|no|off)$/i.test(value.trim())) return 'False';
  }
  return value;
}

/** "Optimize for my PC" suggestions for Dolphin. */
export function dolphinOptimize(hw: HardwareProfile): { key: string; value: string; reason: string }[] {
  const out: { key: string; value: string; reason: string }[] = [];
  const cores = hw.cpu.cores;
  if (cores >= 2) out.push({ key: `${MAIN}|Core|CPUThread`, value: 'true', reason: `Your CPU has ${cores} cores, so Dolphin can run the GPU emulation on its own thread (dual core) for a large speed-up.` });
  const strong = hw.tier === 'high' || hw.tier === 'enthusiast';
  out.push({ key: `${GFX}|Enhancements|MaxAnisotropy`, value: hw.tier === 'low' ? '2' : '4', reason: hw.tier === 'low' ? 'Sharper textures at a small cost on your GPU.' : 'Your GPU handles 16x anisotropic filtering with no noticeable cost.' });
  out.push({ key: `${GFX}|Settings|ShaderCompilationMode`, value: strong ? '2' : '0', reason: strong ? 'Hybrid ubershaders remove shader-compilation stutter and your GPU can afford them.' : 'Specialized shaders are the lightest option for your GPU.' });
  if (strong) out.push({ key: `${GFX}|Settings|MSAA`, value: '4', reason: 'Your GPU can smooth edges with 4x MSAA at little cost.' });
  if (hw.tier === 'low') out.push({ key: `${GFX}|Hacks|EFBAccessEnable`, value: 'false', reason: 'Skipping EFB access from the CPU is a notable speed-up on lower-end PCs.' });
  return out;
}
