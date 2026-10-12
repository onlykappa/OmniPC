// DuckStation settings shown in OmniPC's settings menu. Keys are "Section|Key" in
// settings.ini, written by DuckStationAdapter.applyConfig and, per game, by its
// session overrides (profileOverrides).
// Names, sections and defaults follow src/core/settings.cpp (Settings::Load and the
// s_*_names tables: texture filter, dithering, line detection, CPU execution mode,
// console region), src/core/settings.h (DEFAULT_* values), src/util/audio_stream.cpp
// (audio backend names, Windows build) and the Qt widgets in src/duckstation-qt
// (consolesettingswidget.cpp/.ui: CD-ROM speedup values and CPU clock range,
// emulationsettingswidget.ui: runahead frames, audiosettingswidget.ui: volume range).
// DuckStation stores booleans as true/false and enums by name.
//
// "CPU|OverclockPercent" is not a DuckStation key: DuckStation stores the CPU clock as
// OverclockNumerator/OverclockDenominator (Settings::CPUOverclockPercentToFraction);
// the adapter converts between the two (see duckstationValues/readOverclockPercent).

import type { SettingDef } from '@shared/emulatorSettings';
import type { HardwareProfile } from '@shared/models';

const TEXTURE_FILTERS = [
  { value: 'Nearest', label: 'Nearest-neighbour' },
  { value: 'Bilinear', label: 'Bilinear' },
  { value: 'BilinearBinAlpha', label: 'Bilinear (no edge blending)' },
  { value: 'JINC2', label: 'JINC2 (slow)' },
  { value: 'JINC2BinAlpha', label: 'JINC2 (slow, no edge blending)' },
  { value: 'MonotonicCubic', label: 'Monotonic cubic (very slow)' },
  { value: 'MonotonicCubicBinAlpha', label: 'Monotonic cubic (very slow, no edge blending)' },
  { value: 'AdaptiveDiagonal', label: 'Adaptive diagonal (slow)' },
  { value: 'AdaptiveDiagonalBinAlpha', label: 'Adaptive diagonal (slow, no edge blending)' },
  { value: 'DCCI', label: 'DCCI (extremely slow)' },
  { value: 'DCCIBinAlpha', label: 'DCCI (extremely slow, no edge blending)' },
  { value: 'xBR', label: 'xBR (very slow)' },
  { value: 'xBRBinAlpha', label: 'xBR (very slow, no edge blending)' },
  { value: 'SharpBilinear', label: 'Sharp bilinear' },
  { value: 'Scale2x', label: 'Scale2x (EPX)' },
  { value: 'Scale3x', label: 'Scale3x (slow)' },
  { value: 'MMPX', label: 'MMPX (slow)' },
  { value: 'MMPXEnhanced', label: 'MMPX enhanced (slow)' },
  { value: 'MMPXAdvanced', label: 'MMPX advanced (very slow)' },
];

const CD_SPEEDUP = (none: string) => [
  { value: '1', label: none },
  { value: '2', label: '2x' },
  { value: '3', label: '3x' },
  { value: '4', label: '4x' },
  { value: '5', label: '5x' },
  { value: '6', label: '6x' },
  { value: '0', label: 'Maximum' },
];

export const DUCKSTATION_OVERCLOCK_KEY = 'CPU|OverclockPercent';

export const DUCKSTATION_SETTINGS: SettingDef[] = [
  // ---- graphics
  { key: 'GPU|TextureFilter', label: 'Texture filtering', description: 'Smooths 3D textures. Bilinear is a cheap, softer look; JINC2 and xBR are sharper but slower. Nearest keeps the original pixels.', category: 'graphics', kind: 'select', default: 'Nearest', options: TEXTURE_FILTERS },
  { key: 'GPU|SpriteTextureFilter', label: 'Sprite texture filtering', description: 'Filtering used for 2D sprites. Keeping sprites on Nearest avoids blurry edges while 3D textures are smoothed.', category: 'graphics', kind: 'select', default: 'Nearest', options: TEXTURE_FILTERS },
  { key: 'GPU|DitheringMode', label: 'Dithering / colour depth', description: 'True Color removes the PS1\'s dithering pattern for smooth gradients. Unscaled/Scaled keep the original look; Scaled makes the pattern finer at high resolutions.', category: 'graphics', kind: 'select', default: 'TrueColor', options: [{ value: 'Unscaled', label: 'Unscaled' }, { value: 'UnscaledShaderBlend', label: 'Unscaled (shader blending)' }, { value: 'Scaled', label: 'Scaled' }, { value: 'ScaledShaderBlend', label: 'Scaled (shader blending)' }, { value: 'TrueColor', label: 'True Color' }, { value: 'TrueColorFull', label: 'True Color (full)' }] },
  { key: 'GPU|Multisamples', label: 'Anti-aliasing (MSAA)', description: 'Smooths jagged polygon edges. Costs GPU time.', category: 'graphics', kind: 'select', default: '1', options: [{ value: '1', label: 'Off' }, { value: '2', label: '2x' }, { value: '4', label: '4x' }, { value: '8', label: '8x' }] },
  { key: 'GPU|PGXPEnable', label: 'PGXP geometry correction', description: 'Fixes the PS1\'s wobbly polygons and warped textures. Works with most 3D games; turn off if a game shows broken geometry.', category: 'graphics', kind: 'toggle', default: 'false', recommended: 'true' },
  { key: 'GPU|PGXPTextureCorrection', label: 'PGXP texture correction', description: 'Uses perspective-correct textures when PGXP is on, removing texture warping.', category: 'graphics', kind: 'toggle', default: 'true' },
  { key: 'GPU|PGXPCulling', label: 'PGXP culling correction', description: 'Uses PGXP\'s precise positions to hide back-facing polygons, removing holes in geometry.', category: 'graphics', kind: 'toggle', default: 'true' },
  { key: 'GPU|PGXPDepthBuffer', label: 'PGXP depth buffer', description: 'Adds a depth buffer to fix polygons drawn in the wrong order. Breaks some games.', category: 'graphics', kind: 'toggle', default: 'false', risky: true },
  { key: 'GPU|ScaledInterlacing', label: 'Scaled interlacing', description: 'Scales interlaced output to the internal resolution for a sharper image in interlaced games.', category: 'graphics', kind: 'toggle', default: 'true' },
  { key: 'GPU|ChromaSmoothing24Bit', label: 'FMV chroma smoothing', description: 'Smooths blocky colour in 24-bit full-motion videos.', category: 'graphics', kind: 'toggle', default: 'false' },
  { key: 'GPU|LineDetectMode', label: 'Line detection', description: 'Fixes gaps in lines drawn as thin polygons when upscaling. Try Quads first if a game shows broken lines.', category: 'graphics', kind: 'select', default: 'Disabled', options: [{ value: 'Disabled', label: 'Off' }, { value: 'Quads', label: 'Quads' }, { value: 'BasicTriangles', label: 'Triangles (basic)' }, { value: 'AggressiveTriangles', label: 'Triangles (aggressive)' }] },
  { key: 'TextureReplacements|EnableTextureReplacements', label: 'Texture replacements', description: 'Loads HD texture packs from DuckStation\'s textures folder. Needs the texture cache.', category: 'graphics', kind: 'toggle', default: 'false' },
  { key: 'GPU|EnableTextureCache', label: 'Texture cache', description: 'Caches PS1 textures on the GPU; required for texture replacements. Can cause glitches in some games.', category: 'graphics', kind: 'toggle', default: 'false' },
  // ---- performance
  { key: 'CPU|ExecutionMode', label: 'CPU execution mode', description: 'The recompiler is by far the fastest. Use an interpreter only to work around a game-specific bug.', category: 'performance', kind: 'select', default: 'Recompiler', options: [{ value: 'Interpreter', label: 'Interpreter (slowest)' }, { value: 'CachedInterpreter', label: 'Cached interpreter (faster)' }, { value: 'Recompiler', label: 'Recompiler (fastest)' }] },
  { key: 'CPU|OverclockEnable', label: 'CPU overclock', description: 'Enables the CPU clock speed below. Can make games that slow down on the console run smoothly, but breaks some games.', category: 'performance', kind: 'toggle', default: 'false', risky: true },
  { key: DUCKSTATION_OVERCLOCK_KEY, label: 'CPU clock speed', description: 'Emulated CPU speed when overclocking is on (100% = console speed).', category: 'performance', kind: 'slider', min: 10, max: 1000, step: 5, unit: '%', default: '100', risky: true },
  { key: 'GPU|UseThread', label: 'Threaded rendering', description: 'Runs graphics on a separate CPU thread. Faster on almost every PC.', category: 'performance', kind: 'toggle', default: 'true' },
  { key: 'CDROM|ReadSpeedup', label: 'CD-ROM read speedup', description: 'Reads the disc faster than the real drive for shorter loading. Some games break or play videos too fast.', category: 'performance', kind: 'select', default: '1', risky: true, options: CD_SPEEDUP('None (double speed)') },
  { key: 'CDROM|SeekSpeedup', label: 'CD-ROM seek speedup', description: 'Makes disc seeks faster for shorter loading. Some games break.', category: 'performance', kind: 'select', default: '1', risky: true, options: CD_SPEEDUP('None (normal speed)') },
  { key: 'CDROM|LoadImageToRAM', label: 'Preload disc image to RAM', description: 'Loads the whole game into memory, avoiding hitches from slow drives or network shares. Uses up to 700 MB of RAM.', category: 'performance', kind: 'toggle', default: 'false' },
  { key: 'Main|RunaheadFrameCount', label: 'Runahead', description: 'Reduces input lag by simulating frames ahead. Each frame needs a lot more CPU; disables rewind.', category: 'performance', kind: 'select', default: '0', options: [{ value: '0', label: 'Off' }, ...Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} frame${i ? 's' : ''}` }))] },
  { key: 'Main|RewindEnable', label: 'Rewind', description: 'Keeps recent snapshots so you can rewind gameplay with the rewind hotkey. Uses extra memory and CPU.', category: 'performance', kind: 'toggle', default: 'false' },
  // ---- audio
  { key: 'Audio|OutputVolume', label: 'Volume', description: 'Game audio volume.', category: 'audio', kind: 'slider', min: 0, max: 200, step: 5, unit: '%', default: '100' },
  { key: 'Audio|FastForwardVolume', label: 'Fast-forward volume', description: 'Audio volume while fast-forwarding.', category: 'audio', kind: 'slider', min: 0, max: 200, step: 5, unit: '%', default: '100' },
  { key: 'Audio|OutputMuted', label: 'Mute', description: 'Silences all game audio.', category: 'audio', kind: 'toggle', default: 'false' },
  { key: 'Audio|Backend', label: 'Audio backend', description: 'The audio output system. Cubeb works best on most PCs; try XAudio2 or SDL if audio crackles.', category: 'audio', kind: 'select', default: 'Cubeb', options: [{ value: 'Cubeb', label: 'Cubeb' }, { value: 'XAudio2', label: 'XAudio2' }, { value: 'SDL', label: 'SDL' }, { value: 'Null', label: 'No output' }] },
  // ---- system
  { key: 'Console|Region', label: 'Console region', description: 'Which PlayStation model to emulate. Auto-detect picks the game\'s region; force one only if a game does not boot.', category: 'system', kind: 'select', default: 'Auto', options: [{ value: 'Auto', label: 'Auto-detect' }, { value: 'NTSC-J', label: 'NTSC-J (Japan)' }, { value: 'NTSC-U', label: 'NTSC-U/C (US, Canada)' }, { value: 'PAL', label: 'PAL (Europe, Australia)' }] },
  { key: 'BIOS|PatchFastBoot', label: 'Fast boot', description: 'Skips the PlayStation logo when a game starts.', category: 'system', kind: 'toggle', default: 'false', recommended: 'true' },
  { key: 'BIOS|FastForwardBoot', label: 'Fast-forward boot', description: 'Fast-forwards through the boot logo instead of skipping it, for games that need the full boot.', category: 'system', kind: 'toggle', default: 'false' },
  { key: 'Console|Enable8MBRAM', label: '8 MB RAM (dev console)', description: 'Emulates a development console\'s extra memory. Only needed by some mods and homebrew; can break retail games.', category: 'system', kind: 'toggle', default: 'false', risky: true },
  // ---- fixes & hacks
  { key: 'GPU|WidescreenHack', label: 'Widescreen hack', description: 'Renders 3D games in 16:9 by widening the view. 2D elements may stretch and objects can pop in at the edges. Best with 16:9 aspect ratio.', category: 'fixes', kind: 'toggle', default: 'false', risky: true },
  { key: 'GPU|ForceRoundTextureCoordinates', label: 'Round upscaled texture coordinates', description: 'Fixes seams and gaps between textures in some games at higher resolutions.', category: 'fixes', kind: 'toggle', default: 'false' },
  { key: 'Display|Force4_3For24Bit', label: 'Force 4:3 for FMVs', description: 'Switches to 4:3 while full-motion videos play, so widescreen-hacked games show videos correctly.', category: 'fixes', kind: 'toggle', default: 'false' },
];

/** Section/key/value writes for one menu value (the clock speed becomes a numerator/denominator pair). */
export function duckstationValues(key: string, value: string): [string, string, string][] {
  if (key === DUCKSTATION_OVERCLOCK_KEY) {
    const percent = Math.max(1, Math.round(Number(value)) || 100);
    const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
    const g = gcd(percent, 100);
    return [['CPU', 'OverclockNumerator', String(percent / g)], ['CPU', 'OverclockDenominator', String(100 / g)]];
  }
  const [section, name] = key.split('|');
  return section && name ? [[section, name, value]] : [];
}

/** Settings::CPUOverclockFractionToPercent. */
export function readOverclockPercent(numerator: string | undefined, denominator: string | undefined): string | undefined {
  if (numerator === undefined && denominator === undefined) return undefined;
  const n = Math.max(1, Number(numerator ?? 1) || 1);
  const d = Math.max(1, Number(denominator ?? 1) || 1);
  return String(Math.floor((n * 100) / d));
}

/** "Optimize for my PC" suggestions for DuckStation. */
export function duckstationOptimize(hw: HardwareProfile): { key: string; value: string; reason: string }[] {
  const out: { key: string; value: string; reason: string }[] = [];
  const strong = hw.tier === 'high' || hw.tier === 'enthusiast';
  out.push({ key: 'GPU|PGXPEnable', value: 'true', reason: 'PGXP removes wobbly 3D geometry at almost no cost on any modern PC.' });
  if (hw.cpu.cores >= 2) out.push({ key: 'GPU|UseThread', value: 'true', reason: `Your CPU has ${hw.cpu.cores} cores, so graphics can run on a separate thread.` });
  out.push({ key: 'GPU|TextureFilter', value: hw.tier === 'low' ? 'Bilinear' : strong ? 'JINC2' : 'Bilinear', reason: strong ? 'Your GPU can afford the sharper JINC2 texture filter.' : 'Bilinear filtering smooths textures at very low cost.' });
  if (strong) out.push({ key: 'GPU|Multisamples', value: '4', reason: 'Your GPU can smooth polygon edges with 4x MSAA.' });
  return out;
}
