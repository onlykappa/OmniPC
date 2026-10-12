// Cemu settings shown in OmniPC's settings menu. Keys are element paths below
// <content> in portable/settings.xml ("Graphic/AsyncCompile"), written by
// CemuAdapter.applyConfig through EmulatorSettings.advanced and, for per-game
// profiles, as session overrides restored when Cemu exits.
// Names, value encodings and defaults follow src/config/CemuConfig.cpp
// (CemuConfig::Load/Save; the Load defaults apply because OmniPC always creates
// settings.xml first), src/config/CemuConfig.h (UpscalingFilter, ScreenPosition,
// AudioChannels, CafeConsoleLanguage) and src/gui/wxgui/GeneralSettings2.cpp
// (labels, audio latency slider 0..23 blocks of 12 ms, overlay positions).
// Booleans are written as "true"/"false" like XMLConfigParser::set (fmt) and read
// with tinyxml2 BoolText; enums and numbers as integers.
// Not offered: graphics API, VSync and fullscreen scaling (OmniPC core settings),
// audio API (the saved audio device id is API-specific, so switching the API
// without picking a device makes CreateDeviceFromConfig fail) and CPU mode
// (only stored in Cemu's per-title gameProfiles, not in settings.xml).

import type { SettingDef } from '@shared/emulatorSettings';
import type { HardwareProfile } from '@shared/models';

const FILTERS = [{ value: '0', label: 'Bilinear' }, { value: '1', label: 'Bicubic' }, { value: '2', label: 'Hermite' }, { value: '3', label: 'Nearest neighbor' }];
const POSITIONS = [
  { value: '0', label: 'Disabled' }, { value: '1', label: 'Top left' }, { value: '2', label: 'Top center' }, { value: '3', label: 'Top right' },
  { value: '4', label: 'Bottom left' }, { value: '5', label: 'Bottom center' }, { value: '6', label: 'Bottom right' },
];
const LANGUAGES = ['Japanese', 'English', 'French', 'German', 'Italian', 'Spanish', 'Chinese', 'Korean', 'Dutch', 'Portuguese', 'Russian', 'Taiwanese'].map((label, i) => ({ value: String(i), label }));

export const CEMU_SETTINGS: SettingDef[] = [
  // ---- graphics
  { key: 'Graphic/UpscaleFilter', label: 'Upscale filter', description: 'Filter used when the game image is smaller than your window or screen. Hermite and Bicubic look smoother; Nearest keeps hard pixels.', category: 'graphics', kind: 'select', default: '2', options: FILTERS },
  { key: 'Graphic/DownscaleFilter', label: 'Downscale filter', description: 'Filter used when the game renders above your screen resolution (for example with a resolution graphic pack).', category: 'graphics', kind: 'select', default: '0', options: FILTERS },
  // ---- performance
  { key: 'Graphic/AsyncCompile', label: 'Async shader compile', description: 'Compiles shaders in the background on Vulkan, so the game does not freeze when it meets a new effect. Objects may appear a moment late.', category: 'performance', kind: 'toggle', default: 'true' },
  { key: 'Graphic/vkAccurateBarriers', label: 'Accurate barriers (Vulkan)', description: 'Strict GPU synchronisation on Vulkan. Turning it off is a little faster but can cause flickering or corrupted graphics.', category: 'performance', kind: 'toggle', default: 'true', risky: true },
  { key: 'Graphic/GX2DrawdoneSync', label: 'Full sync at GX2DrawDone', description: 'Waits for the GPU when games ask for it. Needed for correct graphics in many games; turning it off can be faster but may break effects.', category: 'performance', kind: 'toggle', default: 'true', risky: true },
  // ---- audio
  { key: 'Audio/TVVolume', label: 'TV volume', description: 'Volume of the TV audio (the main game sound).', category: 'audio', kind: 'slider', min: 0, max: 100, step: 5, unit: '%', default: '20' },
  { key: 'Audio/PadVolume', label: 'GamePad volume', description: 'Volume of the Wii U GamePad speaker. Off by default; some games play extra sounds there.', category: 'audio', kind: 'slider', min: 0, max: 100, step: 5, unit: '%', default: '0' },
  { key: 'Audio/delay', label: 'Audio latency', description: 'Amount of buffered audio (in 12 ms steps). Raise it if sound crackles when the game slows down; lower it for less delay.', category: 'audio', kind: 'slider', min: 0, max: 23, step: 1, unit: '× 12 ms', default: '2' },
  { key: 'Audio/TVChannels', label: 'TV speaker layout', description: 'Channel layout of the TV audio. Use Surround only with a 5.1 speaker setup.', category: 'audio', kind: 'select', default: '1', options: [{ value: '0', label: 'Mono' }, { value: '1', label: 'Stereo' }, { value: '2', label: 'Surround' }] },
  // ---- system
  { key: 'console_language', label: 'Console language', description: 'The Wii U system language. Games use it for their text and voices.', category: 'system', kind: 'select', default: '1', perGame: false, options: LANGUAGES },
  { key: 'disable_screensaver', label: 'Disable screen saver', description: 'Keeps the screen saver and display sleep away while a game runs.', category: 'system', kind: 'toggle', default: 'true', perGame: false },
  { key: 'play_boot_sound', label: 'Boot sound', description: 'Plays the Wii U boot sound while a game is starting.', category: 'system', kind: 'toggle', default: 'false', perGame: false },
  // ---- interface: overlay
  { key: 'Graphic/Overlay/Position', label: 'Info overlay', description: 'Shows performance information (FPS and more) in the chosen corner of the screen.', category: 'interface', kind: 'select', default: '0', options: POSITIONS },
  { key: 'Graphic/Overlay/FPS', label: 'Overlay: FPS', description: 'Shows the frame rate in the info overlay.', category: 'interface', kind: 'toggle', default: 'true' },
  { key: 'Graphic/Overlay/DrawCalls', label: 'Overlay: draw calls', description: 'Shows draw calls per frame in the info overlay.', category: 'interface', kind: 'toggle', default: 'false' },
  { key: 'Graphic/Overlay/CPUUsage', label: 'Overlay: CPU usage', description: 'Shows Cemu\'s CPU usage in the info overlay.', category: 'interface', kind: 'toggle', default: 'false' },
  { key: 'Graphic/Overlay/RAMUsage', label: 'Overlay: RAM usage', description: 'Shows memory usage in the info overlay.', category: 'interface', kind: 'toggle', default: 'false' },
  { key: 'Graphic/Overlay/VRAMUsage', label: 'Overlay: VRAM usage', description: 'Shows video memory usage in the info overlay.', category: 'interface', kind: 'toggle', default: 'false' },
  { key: 'Graphic/Overlay/TextScale', label: 'Overlay text size', description: 'Size of the info overlay text.', category: 'interface', kind: 'slider', min: 50, max: 300, step: 25, unit: '%', default: '100' },
  { key: 'Graphic/Notification/Position', label: 'Notifications', description: 'Where Cemu shows notifications (controller, shader compiling). "Disabled" hides them.', category: 'interface', kind: 'select', default: '1', options: POSITIONS },
  { key: 'Graphic/Notification/ShaderCompiling', label: 'Shader compiling notice', description: 'Shows a notice while shaders are being compiled.', category: 'interface', kind: 'toggle', default: 'true' },
];

/** "Optimize for my PC" suggestions for Cemu. */
export function cemuOptimize(hw: HardwareProfile): { key: string; value: string; reason: string }[] {
  const out: { key: string; value: string; reason: string }[] = [];
  if (hw.graphicsApis.vulkan !== false) out.push({ key: 'Graphic/AsyncCompile', value: 'true', reason: 'Compiling shaders in the background on Vulkan avoids freezes when new effects appear.' });
  if (hw.tier === 'low' || hw.cpu.cores <= 4) out.push({ key: 'Audio/delay', value: '3', reason: 'A slightly larger audio buffer avoids crackling when your PC cannot keep full speed.' });
  return out;
}
