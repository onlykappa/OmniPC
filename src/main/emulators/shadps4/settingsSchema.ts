// shadPS4 settings shown in OmniPC's settings menu. Keys are "Group.key" in
// user/config.json, written by Shadps4Adapter.applyConfig (and per game into
// user/custom_configs/<TITLE_ID>.json) through EmulatorSettings.advanced.
// Names, JSON types and defaults follow src/core/emulator_settings.h (GeneralSettings,
// NetworkSettings, InputSettings, AudioSettings, GPUSettings, VulkanSettings and their
// GetOverrideableFields lists); option lists and ranges follow the Big Picture settings
// dialog (src/imgui/big_picture/settings_dialog_imgui.cpp/.h). shadPS4 aborts while loading
// config.json when a value has the wrong JSON type, so every key's type is declared below.

import type { SettingDef } from '@shared/emulatorSettings';
import type { HardwareProfile } from '@shared/models';

/** JSON type each schema key must be written as (emulator_settings.h Setting<T>). */
export type Shadps4JsonType = 'boolean' | 'integer' | 'number' | 'string';

const LANGUAGES: [string, string][] = [
  ['0', 'Japanese'], ['1', 'English (United States)'], ['18', 'English (United Kingdom)'], ['2', 'French (France)'], ['22', 'French (Canada)'],
  ['3', 'Spanish (Spain)'], ['20', 'Spanish (Latin America)'], ['4', 'German'], ['5', 'Italian'], ['6', 'Dutch'], ['7', 'Portuguese (Portugal)'],
  ['17', 'Portuguese (Brazil)'], ['8', 'Russian'], ['9', 'Korean'], ['10', 'Traditional Chinese'], ['11', 'Simplified Chinese'], ['12', 'Finnish'],
  ['13', 'Swedish'], ['14', 'Danish'], ['15', 'Norwegian (Bokmaal)'], ['16', 'Polish'], ['19', 'Turkish'], ['21', 'Arabic'], ['23', 'Czech'],
  ['24', 'Hungarian'], ['25', 'Greek'], ['26', 'Romanian'], ['27', 'Thai'], ['28', 'Vietnamese'], ['29', 'Indonesian'], ['30', 'Ukrainian'],
];

export const SHADPS4_SETTINGS: SettingDef[] = [
  // ---- graphics
  { key: 'GPU.fsr_enabled', label: 'FSR upscaling', description: 'Upscales the game picture to your window or screen with AMD FidelityFX Super Resolution instead of plain stretching. Gives a sharper image when the window is larger than the game\'s resolution.', category: 'graphics', kind: 'toggle', default: 'false' },
  { key: 'GPU.rcas_enabled', label: 'FSR sharpening (RCAS)', description: 'Adds a sharpening pass after FSR upscaling. Only used when FSR upscaling is on.', category: 'graphics', kind: 'toggle', default: 'true' },
  { key: 'GPU.rcas_attenuation', label: 'Sharpening attenuation', description: 'How much the FSR sharpening is held back: 0 is the sharpest, higher values are softer. Only used when FSR sharpening is on.', category: 'graphics', kind: 'slider', min: 0, max: 3000, step: 50, default: '250' },
  { key: 'GPU.hdr_allowed', label: 'HDR output', description: 'Lets games that support HDR output it to an HDR display. Leave off on SDR monitors.', category: 'graphics', kind: 'toggle', default: 'false', restartRequired: true },
  // ---- performance
  { key: 'Vulkan.pipeline_cache_enabled', label: 'Shader cache', description: 'Saves compiled shaders to disk so later runs of a game stutter less. Still experimental in shadPS4.', category: 'performance', kind: 'toggle', default: 'false' },
  { key: 'Vulkan.pipeline_cache_archived', label: 'Compress shader cache', description: 'Stores the shader cache as one zip file instead of many small files. Only used when the shader cache is on.', category: 'performance', kind: 'toggle', default: 'false' },
  { key: 'GPU.readbacks_mode', label: 'GPU readbacks', description: 'Copies data the GPU writes back to emulated memory. Some games need it for correct graphics or to not freeze; it costs performance. "Precise" is the most accurate and the slowest.', category: 'performance', kind: 'select', default: '0', risky: true, options: [{ value: '0', label: 'Disabled' }, { value: '1', label: 'Relaxed' }, { value: '2', label: 'Precise' }] },
  { key: 'GPU.readback_linear_images_enabled', label: 'Readback linear images', description: 'Also copies linear images back from the GPU. Fixes some games that show black or missing images, at a performance cost.', category: 'performance', kind: 'toggle', default: 'false', risky: true },
  { key: 'GPU.direct_memory_access_enabled', label: 'Direct memory access', description: 'Lets shaders access emulated memory directly. Needed by a few games; can cause glitches or crashes in others.', category: 'performance', kind: 'toggle', default: 'false', risky: true },
  { key: 'GPU.copy_gpu_buffers', label: 'Copy GPU buffers', description: 'Copies GPU command buffers before running them. Works around crashes in some games, at a performance cost.', category: 'performance', kind: 'toggle', default: 'false', risky: true },
  { key: 'GPU.vblank_frequency', label: 'VBlank frequency', description: 'How often the emulated console signals a new frame (60 on a real PS4). Raising it can unlock higher frame rates in some games but makes others run too fast.', category: 'performance', kind: 'number', min: 30, max: 360, step: 1, unit: 'Hz', default: '60', risky: true },
  { key: 'General.extra_dmem_in_mbytes', label: 'Extra video memory', description: 'Gives the game more direct memory than a real PS4 has. Can help games that run out of memory with mods or high resolutions.', category: 'performance', kind: 'number', min: 0, max: 20000, step: 256, unit: 'MB', default: '0', risky: true, restartRequired: true },
  // ---- audio
  { key: 'General.volume_slider', label: 'Volume', description: 'Game audio volume.', category: 'audio', kind: 'slider', min: 0, max: 500, step: 5, unit: '%', default: '100' },
  { key: 'Audio.audio_backend', label: 'Audio backend', description: 'Audio library used for sound output. Try OpenAL if sound crackles or for surround/headphone (HRTF) options.', category: 'audio', kind: 'select', default: '0', options: [{ value: '0', label: 'SDL' }, { value: '1', label: 'OpenAL' }] },
  { key: 'Audio.openal_output_mode', label: 'OpenAL speaker setup', description: 'Speaker layout OpenAL outputs to. Only used with the OpenAL backend.', category: 'audio', kind: 'select', default: '0', options: [{ value: '0', label: 'Automatic' }, { value: '1', label: 'Stereo' }, { value: '2', label: 'Quadraphonic' }, { value: '3', label: '5.1 surround' }, { value: '4', label: '7.1 surround' }] },
  { key: 'Audio.openal_hrtf', label: 'OpenAL HRTF (3D headphone audio)', description: 'Binaural 3D sound for headphones. Only used with the OpenAL backend; "Automatic" turns it on for headphones.', category: 'audio', kind: 'select', default: '0', options: [{ value: '0', label: 'Automatic' }, { value: '1', label: 'On' }, { value: '2', label: 'Off' }] },
  // ---- system
  { key: 'General.console_language', label: 'Console language', description: 'System language reported to games; most games pick their text and voice language from it.', category: 'system', kind: 'select', default: '1', perGame: false, options: LANGUAGES.map(([value, label]) => ({ value, label })) },
  { key: 'Input.is_circle_enter', label: 'Circle confirms', description: 'Makes Circle the confirm button, like Japanese consoles. Off uses Cross to confirm.', category: 'system', kind: 'toggle', default: 'false' },
  { key: 'General.neo_mode', label: 'PS4 Pro mode', description: 'Reports the console as a PS4 Pro so supported games use their Pro graphics modes. Needs a stronger PC and can break some games.', category: 'system', kind: 'toggle', default: 'false', risky: true, restartRequired: true },
  { key: 'General.dev_kit_mode', label: 'Devkit mode', description: 'Reports the console as a development kit with more memory. Only for homebrew or games that need it.', category: 'system', kind: 'toggle', default: 'false', risky: true, restartRequired: true },
  { key: 'Network.connected_to_network', label: 'Report network connected', description: 'Tells games the console is online. Some games wait for or try online features when this is on; leave off unless a game needs it.', category: 'system', kind: 'toggle', default: 'false', risky: true },
  // ---- controls
  { key: 'Input.motion_controls_enabled', label: 'Motion controls', description: 'Passes your controller\'s gyro/accelerometer to games that use DualShock 4 motion.', category: 'controls', kind: 'toggle', default: 'true' },
  { key: 'Input.background_controller_input', label: 'Controller input in background', description: 'Keeps reading the controller when the shadPS4 window is not focused.', category: 'controls', kind: 'toggle', default: 'false' },
  // ---- interface
  { key: 'General.trophy_popup_disabled', label: 'Hide trophy pop-ups', description: 'Turns off the notification shown when you earn a trophy.', category: 'interface', kind: 'toggle', default: 'false' },
  { key: 'General.trophy_notification_side', label: 'Trophy pop-up position', description: 'Screen edge the trophy notification slides in from.', category: 'interface', kind: 'select', default: 'right', options: [{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }, { value: 'top', label: 'Top' }, { value: 'bottom', label: 'Bottom' }] },
  { key: 'General.trophy_notification_duration', label: 'Trophy pop-up duration', description: 'How long trophy notifications stay on screen.', category: 'interface', kind: 'slider', min: 0, max: 10, step: 0.5, unit: 's', default: '6' },
  { key: 'Input.cursor_state', label: 'Hide mouse cursor', description: 'When to hide the mouse pointer over the game window.', category: 'interface', kind: 'select', default: '1', options: [{ value: '0', label: 'Never' }, { value: '1', label: 'When idle' }, { value: '2', label: 'Always' }] },
];

/** JSON type of each schema key (integers for enums/ints/u32, number for doubles). */
export const SHADPS4_TYPES: Record<string, Shadps4JsonType> = Object.fromEntries(
  SHADPS4_SETTINGS.map((d) => [d.key, d.kind === 'toggle' ? 'boolean' : d.key === 'General.trophy_notification_duration' ? 'number' : d.kind === 'select' && d.options!.some((o) => !/^-?\d+$/.test(o.value)) ? 'string' : 'integer']),
);

/** "Optimize for my PC" suggestions for shadPS4. */
export function shadps4Optimize(hw: HardwareProfile): { key: string; value: string; reason: string }[] {
  const out: { key: string; value: string; reason: string }[] = [];
  const display = hw.displays.find((d) => d.primary) ?? hw.displays[0];
  if (display && display.height > 1080 && hw.tier !== 'low') {
    out.push({ key: 'GPU.fsr_enabled', value: 'true', reason: `Your display (${display.width}x${display.height}) is larger than the PS4's 1080p output; FSR upscales it more sharply.` });
  }
  if (hw.tier === 'low' || hw.cpu.cores <= 4) {
    out.push({ key: 'Vulkan.pipeline_cache_enabled', value: 'true', reason: 'Compiling shaders causes the most stutter on slower CPUs; the shader cache keeps them between runs.' });
  }
  return out;
}
