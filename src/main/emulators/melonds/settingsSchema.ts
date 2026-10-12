// melonDS settings shown in OmniPC's settings menu. Keys are dotted paths in
// melonDS.toml (melonDS 1.x; the legacy melonDS.ini is only migrated from),
// written by MelonDsAdapter.applyConfig through EmulatorSettings.advanced and,
// for per-game profiles, applied for the session by profileOverrides.
// Names, defaults and ranges follow src/frontend/qt_sdl/Config.cpp
// (DefaultInts/DefaultBools/IntRanges and the legacy-key table), the readers in
// EmuInstance.cpp, EmuInstanceAudio.cpp, EmuThread.cpp, Screen.cpp and
// Window.cpp, the enums in src/frontend/ScreenLayout.h, and the settings
// dialogs (VideoSettingsDialog, AudioSettingsDialog, EmuSettingsDialog.ui,
// FirmwareSettingsDialog.h, InterfaceSettingsDialog).
// Per-instance and per-window settings live under Instance0 / Instance0.Window0.
//
// melonDS's typed getters (Config.cpp Table::GetInt/GetBool) reset a value of
// the wrong TOML type to its default, so melondsTomlValue() converts menu
// strings to booleans/integers before writing.
//
// Not included: Emu.ConsoleType (DSi mode needs DSi BIOS/firmware/NAND that
// OmniPC does not set up), Emu.DirectBoot (OmniPC pins it; firmware boot needs
// a real DS BIOS), and the double-valued FPS settings (TargetFPS,
// FastForwardFPS), which must be TOML floats.

import type { SettingDef } from '@shared/emulatorSettings';
import type { HardwareProfile } from '@shared/models';

const W = 'Instance0.Window0';

export const MELONDS_SETTINGS: SettingDef[] = [
  // ---- graphics
  { key: '3D.GL.BetterPolygons', label: 'Improved polygon splitting', description: 'Fixes stretched or warped textures on some 3D models with the OpenGL renderer. Slightly slower.', category: 'graphics', kind: 'toggle', default: 'false' },
  { key: '3D.GL.HiresCoordinates', label: 'High-resolution coordinates', description: 'Uses more precise vertex positions when upscaling with OpenGL, reducing wobbly geometry. Turn off only if a game shows gaps.', category: 'graphics', kind: 'toggle', default: 'true' },
  { key: `${W}.ScreenFilter`, label: 'Screen filtering', description: 'Smooths the screens when they are scaled up (needs OpenGL display). Turn off for sharp pixels.', category: 'graphics', kind: 'toggle', default: 'false' },
  { key: `${W}.IntegerScaling`, label: 'Integer scaling', description: 'Scales the screens only by whole numbers for perfectly even pixels; may add borders.', category: 'graphics', kind: 'toggle', default: 'false' },
  { key: `${W}.ScreenLayout`, label: 'Screen layout', description: 'How the two DS screens are arranged in the window. Hybrid shows one screen large and both small beside it.', category: 'graphics', kind: 'select', default: '0', options: [{ value: '0', label: 'Natural' }, { value: '1', label: 'Vertical' }, { value: '2', label: 'Horizontal' }, { value: '3', label: 'Hybrid' }] },
  { key: `${W}.ScreenSizing`, label: 'Screen sizing', description: 'Which screen gets more space. "Top only" / "Bottom only" show a single screen.', category: 'graphics', kind: 'select', default: '0', options: [{ value: '0', label: 'Even' }, { value: '1', label: 'Emphasize top' }, { value: '2', label: 'Emphasize bottom' }, { value: '3', label: 'Auto' }, { value: '4', label: 'Top only' }, { value: '5', label: 'Bottom only' }] },
  { key: `${W}.ScreenRotation`, label: 'Screen rotation', description: 'Rotates both screens, for games played holding the DS sideways like a book.', category: 'graphics', kind: 'select', default: '0', options: [{ value: '0', label: '0°' }, { value: '1', label: '90°' }, { value: '2', label: '180°' }, { value: '3', label: '270°' }] },
  { key: `${W}.ScreenGap`, label: 'Screen gap', description: 'Space between the two screens in pixels, like the hinge on a real DS.', category: 'graphics', kind: 'number', min: 0, max: 500, step: 1, unit: 'px', default: '0' },
  { key: `${W}.ScreenSwap`, label: 'Swap screens', description: 'Shows the bottom screen on top and vice versa.', category: 'graphics', kind: 'toggle', default: 'false' },
  // ---- performance
  { key: '3D.Soft.Threaded', label: 'Threaded software renderer', description: 'Runs the software 3D renderer on its own CPU thread. A big speed-up on multi-core CPUs.', category: 'performance', kind: 'toggle', default: 'true' },
  { key: 'JIT.Enable', label: 'JIT recompiler', description: 'Translates DS CPU code to PC code for much higher speed. Very rarely causes glitches.', category: 'performance', kind: 'toggle', default: 'false', recommended: 'true', restartRequired: true },
  { key: 'JIT.MaxBlockSize', label: 'JIT maximum block size', description: 'How much code the JIT translates at once. Higher is faster; lower it only if a game misbehaves with the JIT.', category: 'performance', kind: 'slider', min: 1, max: 32, step: 1, default: '32', restartRequired: true },
  { key: 'JIT.BranchOptimisations', label: 'JIT branch optimisations', description: 'Speeds up jumps in game code. Turn off only to troubleshoot a JIT problem.', category: 'performance', kind: 'toggle', default: 'true', restartRequired: true },
  { key: 'JIT.LiteralOptimisations', label: 'JIT literal optimisations', description: 'Speeds up loading constants in game code. Turn off only to troubleshoot a JIT problem.', category: 'performance', kind: 'toggle', default: 'true', restartRequired: true },
  { key: 'JIT.FastMemory', label: 'JIT fast memory', description: 'Lets the JIT access DS memory directly for extra speed. Turn off only to troubleshoot crashes.', category: 'performance', kind: 'toggle', default: 'true', restartRequired: true },
  // ---- audio
  { key: 'Instance0.Audio.Volume', label: 'Volume', description: 'Game audio volume (256 = full).', category: 'audio', kind: 'slider', min: 0, max: 256, step: 8, default: '256' },
  { key: 'Audio.Interpolation', label: 'Audio interpolation', description: 'Smooths DS audio samples. "None" is accurate to the hardware; Cubic or Gaussian sound cleaner.', category: 'audio', kind: 'select', default: '0', options: [{ value: '0', label: 'None' }, { value: '1', label: 'Linear' }, { value: '2', label: 'Cosine' }, { value: '3', label: 'Cubic' }, { value: '4', label: 'Gaussian (SNES)' }] },
  { key: 'AudioSync', label: 'Audio sync', description: 'Paces emulation by the audio output to avoid crackling. Can cause small hitches.', category: 'audio', kind: 'toggle', default: 'false' },
  { key: 'MuteFastForward', label: 'Mute while fast-forwarding', description: 'Silences audio while fast-forward is held.', category: 'audio', kind: 'toggle', default: 'false', perGame: false },
  // ---- system
  { key: 'Instance0.Firmware.OverrideSettings', label: 'Override firmware settings', description: 'Uses the language and nickname below instead of those stored in the DS firmware.', category: 'system', kind: 'toggle', default: 'false', restartRequired: true },
  { key: 'Instance0.Firmware.Language', label: 'Console language', description: 'Language games use when firmware override is on. Many DS games pick their language from this.', category: 'system', kind: 'select', default: '1', restartRequired: true, options: [{ value: '0', label: 'Japanese' }, { value: '1', label: 'English' }, { value: '2', label: 'French' }, { value: '3', label: 'German' }, { value: '4', label: 'Italian' }, { value: '5', label: 'Spanish' }, { value: '6', label: 'Chinese' }] },
  { key: 'Instance0.Firmware.Username', label: 'Nickname', description: 'Player name games see when firmware override is on (up to 10 characters).', category: 'system', kind: 'text', default: 'melonDS', perGame: false, restartRequired: true },
  // ---- fixes
  { key: 'Instance0.EnableCheats', label: 'Cheats', description: 'Enables cheat codes from melonDS\'s cheat files (.mch).', category: 'fixes', kind: 'toggle', default: 'false' },
  // ---- interface
  { key: `${W}.ShowOSD`, label: 'On-screen messages', description: 'Shows messages such as "State saved" over the game.', category: 'interface', kind: 'toggle', default: 'true' },
  { key: 'PauseLostFocus', label: 'Pause when unfocused', description: 'Pauses the game when the melonDS window loses focus.', category: 'interface', kind: 'toggle', default: 'false', perGame: false },
  { key: 'Mouse.Hide', label: 'Hide mouse cursor', description: 'Hides the mouse cursor after a few seconds of inactivity.', category: 'interface', kind: 'toggle', default: 'false', perGame: false },
];

const DEFS = new Map(MELONDS_SETTINGS.map((d) => [d.key, d]));

/**
 * Converts a menu string to the TOML type melonDS expects: toggles become
 * booleans and numeric settings integers. Keys outside the schema follow the
 * type of the existing value (if any), else booleans/integers are inferred.
 */
export function melondsTomlValue(key: string, value: string, existing?: 'string' | 'int' | 'float' | 'bool'): string | number | boolean {
  const v = String(value).trim();
  const def = DEFS.get(key);
  if (def) {
    if (def.kind === 'toggle') return /^(true|1|yes|on)$/i.test(v);
    if (def.kind === 'text') return value;
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : Number(def.default);
  }
  if (existing === 'string') return value;
  if (existing === 'bool' || /^(true|false)$/.test(v)) return /^(true|1)$/i.test(v);
  if (existing === 'float' && v !== '' && Number.isFinite(Number(v))) return Number(v);
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  return value;
}

/** "Optimize for my PC" suggestions for melonDS. */
export function melondsOptimize(hw: HardwareProfile): { key: string; value: string; reason: string }[] {
  const out: { key: string; value: string; reason: string }[] = [];
  out.push({ key: 'JIT.Enable', value: 'true', reason: 'The JIT recompiler is several times faster than the interpreter on any x86-64 PC.' });
  if (hw.cpu.cores >= 2) out.push({ key: '3D.Soft.Threaded', value: 'true', reason: `Your CPU has ${hw.cpu.cores} cores, so 3D can render on its own thread.` });
  if (hw.tier !== 'low') out.push({ key: '3D.GL.BetterPolygons', value: 'true', reason: 'Your GPU can afford the more accurate polygon handling that fixes warped textures.' });
  return out;
}
