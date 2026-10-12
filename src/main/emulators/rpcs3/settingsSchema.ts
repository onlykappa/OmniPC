// RPCS3 settings shown in OmniPC's settings menu. Keys are "Section|Key" (or
// "Section/Sub|Key" for nested nodes) in config/config.yml, written by
// Rpcs3Adapter.applyConfig/advancedValues through EmulatorSettings.advanced and,
// for per-game profiles, through the generated --config file.
// Names, ranges and defaults follow rpcs3/Emu/system_config.h (cfg_root nodes
// Core, Video, Video/Vulkan, Video/Performance Overlay, Audio, System,
// Miscellaneous); enum strings follow rpcs3/Emu/system_config_types.cpp
// (fmt_class_string<...>) and Emu/Cell/Modules/cellSysutil.cpp (CellSysutilLang,
// CellSysutilLicenseArea). Booleans are written as YAML true/false, which
// cfg::_bool::from_string accepts.
// Core settings (renderer, resolution scale, aspect ratio, VSync, frame limit,
// fullscreen) are left to OmniPC's own settings.

import type { SettingDef } from '@shared/emulatorSettings';
import type { HardwareProfile } from '@shared/models';

const opt = (...values: string[]) => values.map((v) => ({ value: v, label: v }));

const LANGUAGES = [
  'Japanese', 'English (US)', 'French', 'Spanish', 'German', 'Italian', 'Dutch', 'Portuguese (Portugal)', 'Russian', 'Korean',
  'Chinese (Traditional)', 'Chinese (Simplified)', 'Finnish', 'Swedish', 'Danish', 'Norwegian', 'Polish', 'English (UK)', 'Portuguese (Brazil)', 'Turkish',
];

export const RPCS3_SETTINGS: SettingDef[] = [
  // ---- graphics
  { key: 'Video|Anisotropic Filter Override', label: 'Anisotropic filtering', description: 'Keeps textures on floors and walls sharp at an angle. "Auto" uses what the game asks for; forcing 16x is cheap on modern GPUs.', category: 'graphics', kind: 'select', default: '0', recommended: '16', options: [{ value: '0', label: 'Auto' }, { value: '2', label: '2x' }, { value: '4', label: '4x' }, { value: '8', label: '8x' }, { value: '16', label: '16x' }] },
  { key: 'Video|MSAA', label: 'Anti-aliasing (MSAA)', description: 'Smooths jagged edges when the game uses multisampling. Turn off for more speed on weak GPUs.', category: 'graphics', kind: 'select', default: 'Auto', options: [{ value: 'Auto', label: 'Auto' }, { value: 'Disabled', label: 'Off' }] },
  { key: 'Video|Output Scaling Mode', label: 'Upscaling filter', description: 'How the image is stretched to your window or screen. FidelityFX Super Resolution (FSR) gives a sharper picture when scaling up.', category: 'graphics', kind: 'select', default: 'Bilinear', options: [{ value: 'Nearest', label: 'Nearest' }, { value: 'Bilinear', label: 'Bilinear' }, { value: 'FidelityFX Super Resolution', label: 'FidelityFX Super Resolution (FSR)' }] },
  { key: 'Video|FidelityFX CAS Sharpening Intensity', label: 'Sharpening (FSR/CAS)', description: 'How strongly the FSR upscaler sharpens the image. Only used when the upscaling filter is FSR.', category: 'graphics', kind: 'slider', min: 0, max: 100, step: 5, unit: '%', default: '50' },
  { key: 'Video|Shader Precision', label: 'Shader precision', description: 'Precision of the PS3 shader maths on your GPU. Lower is faster but can cause visual glitches.', category: 'graphics', kind: 'select', default: 'High', options: [{ value: 'Auto', label: 'Auto' }, { value: 'Ultra', label: 'Ultra' }, { value: 'High', label: 'High' }, { value: 'Low', label: 'Low' }] },
  { key: 'Video|Use full RGB output range', label: 'Full RGB range', description: 'Outputs colours in full range (0-255) as PC monitors expect. Turn off only if blacks look grey or crushed on a TV.', category: 'graphics', kind: 'toggle', default: 'true' },
  // ---- performance
  { key: 'Core|PPU Decoder', label: 'PPU decoder', description: 'How the PS3 main CPU is emulated. The LLVM recompiler is by far the fastest; the interpreter is only for troubleshooting.', category: 'performance', kind: 'select', default: 'Recompiler (LLVM)', restartRequired: true, options: opt('Recompiler (LLVM)', 'Interpreter (static)') },
  { key: 'Core|SPU Decoder', label: 'SPU decoder', description: 'How the PS3 Cell SPUs are emulated. LLVM is the fastest; ASMJIT compiles quicker but runs slower; interpreters are very slow.', category: 'performance', kind: 'select', default: 'Recompiler (LLVM)', restartRequired: true, options: opt('Recompiler (LLVM)', 'Recompiler (ASMJIT)', 'Interpreter (static)', 'Interpreter (dynamic)') },
  { key: 'Core|Preferred SPU Threads', label: 'Preferred SPU threads', description: 'How many CPU threads are reserved for heavy SPU work. "Auto" is right for most games; some games run better with a specific value.', category: 'performance', kind: 'select', default: '0', options: [{ value: '0', label: 'Auto' }, ...['1', '2', '3', '4', '5', '6'].map((v) => ({ value: v, label: v }))] },
  { key: 'Core|SPU Block Size', label: 'SPU block size', description: 'Size of the code blocks the SPU recompiler builds. Mega/Giga can be faster in some games but may cause crashes or glitches.', category: 'performance', kind: 'select', default: 'Safe', risky: true, restartRequired: true, options: opt('Safe', 'Mega', 'Giga') },
  { key: 'Core|SPU XFloat Accuracy', label: 'SPU XFloat accuracy', description: 'Accuracy of SPU floating-point maths. "Accurate" fixes some games (e.g. broken lighting) but is slower; lower settings are faster but can break games.', category: 'performance', kind: 'select', default: 'Approximate', risky: true, restartRequired: true, options: opt('Accurate', 'Approximate', 'Relaxed', 'Inaccurate') },
  { key: 'Core|Thread Scheduler Mode', label: 'Thread scheduler', description: 'Who decides which CPU cores run the emulator threads. RPCS3\'s own schedulers can help on CPUs with many cores or performance/efficiency cores.', category: 'performance', kind: 'select', default: 'Operating System', restartRequired: true, options: opt('Operating System', 'RPCS3 Scheduler', 'RPCS3 Alternative Scheduler') },
  { key: 'Core|LLVM Precompilation', label: 'PPU precompilation', description: 'Compiles all game code before it starts, so the first launch takes longer but later play has fewer stutters.', category: 'performance', kind: 'toggle', default: 'true', restartRequired: true },
  { key: 'Video|Shader Mode', label: 'Shader compilation', description: 'How shaders are built. "Async with shader interpreter" avoids stutter with no missing graphics; plain async is faster but objects can pop in briefly.', category: 'performance', kind: 'select', default: 'Async Recompiler with Shader Interpreter', options: opt('Async Recompiler with Shader Interpreter', 'Async Recompiler (multi-threaded)', 'Legacy Recompiler (single-threaded)', 'Shader Interpreter only') },
  { key: 'Video|Shader Compiler Threads', label: 'Shader compiler threads', description: 'How many CPU threads compile shaders. 0 lets RPCS3 decide.', category: 'performance', kind: 'number', min: 0, max: 16, step: 1, default: '0' },
  { key: 'Video|Multithreaded RSX', label: 'Multi-threaded RSX', description: 'Offloads part of the graphics work to another CPU thread. Can help on CPUs with many cores but breaks some games.', category: 'performance', kind: 'toggle', default: 'false', risky: true },
  { key: 'Video/Vulkan|Asynchronous Texture Streaming', label: 'Async texture streaming', description: 'Uploads textures in the background on Vulkan, reducing stutter. Can cause flickering in some games.', category: 'performance', kind: 'toggle', default: 'false' },
  { key: 'Video|Relaxed ZCULL Sync', label: 'Relaxed ZCULL sync', description: 'Waits less for occlusion results from the GPU. Faster, but some effects (e.g. lens flares) can flicker.', category: 'performance', kind: 'toggle', default: 'false', risky: true },
  // ---- audio
  { key: 'Audio|Master Volume', label: 'Volume', description: 'Game audio volume.', category: 'audio', kind: 'slider', min: 0, max: 200, step: 5, unit: '%', default: '100' },
  { key: 'Audio|Renderer', label: 'Audio backend', description: 'The audio system RPCS3 uses. Cubeb works everywhere; try XAudio2 if sound crackles.', category: 'audio', kind: 'select', default: 'Cubeb', options: [{ value: 'Cubeb', label: 'Cubeb' }, { value: 'XAudio2', label: 'XAudio2' }, { value: 'Null', label: 'None (silent)' }] },
  { key: 'Audio|Enable Buffering', label: 'Audio buffering', description: 'Keeps a small audio buffer to prevent crackling. Turning it off lowers latency but can cause dropouts.', category: 'audio', kind: 'toggle', default: 'true' },
  { key: 'Audio|Desired Audio Buffer Duration', label: 'Audio buffer size', description: 'Size of the audio buffer. Raise it if sound crackles when the game slows down; lower it for less delay.', category: 'audio', kind: 'slider', min: 4, max: 250, step: 1, unit: 'ms', default: '34' },
  { key: 'Audio|Enable Time Stretching', label: 'Time stretching', description: 'Stretches audio instead of crackling when the game runs below full speed. Needs audio buffering.', category: 'audio', kind: 'toggle', default: 'false' },
  { key: 'Audio|Audio Channel Layout', label: 'Speaker layout', description: 'Channel layout sent to your speakers. "Automatic" matches your audio device.', category: 'audio', kind: 'select', default: 'Automatic', options: opt('Automatic', 'Mono', 'Stereo', 'Stereo LFE', 'Quadraphonic', 'Quadraphonic LFE', 'Surround 5.1', 'Surround 7.1') },
  // ---- system
  { key: 'System|Language', label: 'System language', description: 'The PS3 system language. Multi-language games use it for their text and voices.', category: 'system', kind: 'select', default: 'English (US)', perGame: false, options: opt(...LANGUAGES) },
  { key: 'System|License Area', label: 'Console region', description: 'The PS3 license region the system reports. Rarely needs changing.', category: 'system', kind: 'select', default: 'SCEA', perGame: false, options: [{ value: 'SCEJ', label: 'Japan' }, { value: 'SCEA', label: 'America' }, { value: 'SCEE', label: 'Europe, Oceania, Middle East, Russia' }, { value: 'SCEH', label: 'Southeast Asia' }, { value: 'SCEK', label: 'Korea' }, { value: 'SCH', label: 'China' }, { value: 'Other', label: 'Other' }] },
  { key: 'System|Enter button assignment', label: 'Confirm button', description: 'Which button confirms in system dialogs: Cross (Western) or Circle (Japanese).', category: 'system', kind: 'select', default: 'Enter with cross', perGame: false, options: [{ value: 'Enter with cross', label: 'Cross' }, { value: 'Enter with circle', label: 'Circle' }] },
  // ---- fixes
  { key: 'Video|Write Color Buffers', label: 'Write color buffers', description: 'Copies rendered images back to PS3 memory. Fixes missing or black effects in some games, at a performance cost.', category: 'fixes', kind: 'toggle', default: 'false' },
  { key: 'Video|Read Color Buffers', label: 'Read color buffers', description: 'Lets the GPU read images the game wrote with the CPU. Needed by a few games for menus or videos; slower.', category: 'fixes', kind: 'toggle', default: 'false' },
  { key: 'Video|Strict Rendering Mode', label: 'Strict rendering mode', description: 'Follows the PS3 GPU more strictly. Fixes rare graphical bugs but is slower.', category: 'fixes', kind: 'toggle', default: 'false' },
  { key: 'Video|Accurate ZCULL stats', label: 'Accurate ZCULL stats', description: 'Exact occlusion query results. Turn off for a speed-up if a game does not need them.', category: 'fixes', kind: 'toggle', default: 'true' },
  { key: 'Video|Handle RSX Memory Tiling', label: 'Handle RSX memory tiling', description: 'Emulates PS3 tiled memory. Fixes corrupted textures or effects in some games.', category: 'fixes', kind: 'toggle', default: 'false' },
  // ---- interface
  { key: 'Video/Performance Overlay|Enabled', label: 'Performance overlay', description: 'Shows FPS, frame times and CPU usage on top of the game.', category: 'interface', kind: 'toggle', default: 'false' },
  { key: 'Miscellaneous|Show trophy popups', label: 'Trophy popups', description: 'Shows a notification when you earn a trophy.', category: 'interface', kind: 'toggle', default: 'true' },
  { key: 'Miscellaneous|Show shader compilation hint', label: 'Shader compilation hint', description: 'Shows a small notice while shaders are being compiled.', category: 'interface', kind: 'toggle', default: 'false' },
];

/** "Section/Sub|Key" -> YAML path. */
export function rpcs3SettingPath(key: string): string[] | null {
  const [section, name] = key.split('|');
  return section && name ? [...section.split('/'), name] : null;
}

/** "Optimize for my PC" suggestions for RPCS3. */
export function rpcs3Optimize(hw: HardwareProfile): { key: string; value: string; reason: string }[] {
  const out: { key: string; value: string; reason: string }[] = [];
  const strong = hw.tier === 'high' || hw.tier === 'enthusiast';
  out.push({ key: 'Video|Anisotropic Filter Override', value: hw.tier === 'low' ? '0' : '16', reason: hw.tier === 'low' ? 'Leaves filtering to the game to save GPU bandwidth.' : 'Your GPU handles 16x anisotropic filtering with no noticeable cost.' });
  if (strong) out.push({ key: 'Video|Output Scaling Mode', value: 'FidelityFX Super Resolution', reason: 'Your GPU can afford FSR for a sharper picture when scaling to your display.' });
  if (hw.tier === 'low') {
    out.push({ key: 'Video|Accurate ZCULL stats', value: 'false', reason: 'Approximate occlusion results save GPU time on your PC.' });
    out.push({ key: 'Audio|Enable Time Stretching', value: 'true', reason: 'Avoids crackling audio when a game runs below full speed.' });
  }
  return out;
}
