// Ryujinx (Ryubing) Config.json model.
//
// Ryujinx serialises ConfigurationFileFormat with System.Text.Json and a snake_case
// naming policy (src/Ryujinx.Common/Utilities/JsonHelper.cs SnakeCaseNamingPolicy:
// an underscore is inserted before an upper-case letter that follows a non-upper-case
// character, so "GCLowLatency" -> "gclow_latency", "UseHDRumble" -> "use_hdrumble").
// Enums with [JsonConverter(JsonStringEnumConverter)] are strings; HideCursorMode,
// VSyncMode, MemoryConfiguration and MultiplayerMode have no converter and are numbers.
//
// ConfigurationState.Load (src/Ryujinx/Systems/Configuration/ConfigurationState.Migration.cs)
// copies every field from the file without null checks (e.g. cff.GameDirs is iterated,
// cff.Hotkeys is used as-is), so a partial Config.json crashes or misbehaves. OmniPC
// therefore creates a COMPLETE file (mirroring ConfigurationState.LoadDefault +
// ToFileFormat, src/Ryujinx/Systems/Configuration/ConfigurationState.cs) when none exists,
// and otherwise only changes individual keys of the existing file.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

/** ConfigurationFileFormat.CurrentVersion in Ryubing master (2026-08, ConfigurationFileFormat.cs). */
export const RYUJINX_CONFIG_VERSION = 73;

/** InputConfig.CurrentVersion (src/Ryujinx.Common/Configuration/Hid/InputConfig.cs). */
export const RYUJINX_INPUT_CONFIG_VERSION = 1;

/** HideCursorMode enum (numeric in JSON): Never = 0, OnIdle = 1, Always = 2. */
export const HIDE_CURSOR = { never: 0, onIdle: 1, always: 2 } as const;
/** VSyncMode enum (numeric in JSON): Switch = 0 (60 Hz, vsync), Unbounded = 1, Custom = 2. */
export const VSYNC_MODE = { switch: 0, unbounded: 1, custom: 2 } as const;

/** Default keyboard input for player 1 (ConfigurationState.LoadDefault / InputConfigDefaults.CreateDefaultKeyboardConfiguration). */
export function defaultKeyboardInput(): JsonObject {
  return {
    left_joycon_stick: { stick_up: 'W', stick_down: 'S', stick_left: 'A', stick_right: 'D', stick_button: 'F' },
    right_joycon_stick: { stick_up: 'I', stick_down: 'K', stick_left: 'J', stick_right: 'L', stick_button: 'H' },
    left_joycon: {
      button_minus: 'Minus', button_l: 'E', button_zl: 'Q', button_sl: 'Unbound', button_sr: 'Unbound',
      dpad_up: 'Up', dpad_down: 'Down', dpad_left: 'Left', dpad_right: 'Right',
    },
    right_joycon: {
      button_plus: 'Plus', button_r: 'U', button_zr: 'O', button_sl: 'Unbound', button_sr: 'Unbound',
      button_x: 'C', button_b: 'X', button_y: 'V', button_a: 'Z',
    },
    version: RYUJINX_INPUT_CONFIG_VERSION,
    backend: 'WindowKeyboard',
    id: '0',
    name: 'Keyboard',
    controller_type: 'ProController',
    player_index: 'Player1',
    enable_dynamic_gamepad_swap: false,
  };
}

/**
 * A complete Config.json equal to what Ryujinx writes on first start on Windows
 * (LoadDefault + ToFileFormat), except for the prompt/telemetry values OmniPC
 * always manages (update checker off, no exit confirmation, no console window,
 * no Discord presence). Graphics/path values are then applied on top by the adapter.
 */
export function defaultRyujinxConfig(): JsonObject {
  return {
    version: RYUJINX_CONFIG_VERSION,
    enable_file_log: true,
    backend_threading: 'Auto',
    res_scale: 1,
    res_scale_custom: 1,
    max_anisotropy: -1,
    aspect_ratio: 'Fixed16x9',
    anti_aliasing: 'None',
    scaling_filter: 'Bilinear',
    scaling_filter_level: 80,
    graphics_shaders_dump_path: '',
    logging_enable_debug: false,
    logging_enable_stub: true,
    logging_enable_info: true,
    logging_enable_warn: true,
    logging_enable_error: true,
    logging_enable_trace: false,
    logging_enable_guest: true,
    logging_enable_fs_access_log: false,
    logging_enable_net_log: false,
    logging_enable_avalonia: false,
    logging_filtered_classes: [],
    logging_graphics_debug_level: 'None',
    system_language: 'AmericanEnglish',
    system_region: 'USA',
    system_time_zone: 'UTC',
    system_time_offset: 0,
    match_system_time: false,
    use_input_global_config: false,
    docked_mode: true,
    enable_discord_integration: false,
    check_updates_on_start: false,
    update_checker_type: 'Off',
    focus_lost_action_type: 'DoNothing',
    show_confirm_exit: false,
    ignore_applet: false,
    skip_user_profiles: false,
    remember_window_state: true,
    show_title_bar: false,
    enable_hardware_acceleration: true,
    hide_cursor: HIDE_CURSOR.onIdle,
    vsync_mode: VSYNC_MODE.switch,
    enable_custom_vsync_interval: false,
    custom_vsync_interval: 120,
    enable_shader_cache: true,
    enable_texture_recompression: false,
    enable_macro_hle: true,
    enable_color_space_passthrough: false,
    enable_ptc: true,
    enable_low_power_ptc: false,
    // ConfigurationState.Migration.cs migration 68 default (turbo-mode speed, percent).
    tick_scalar: 200,
    enable_internet_access: false,
    enable_fs_integrity_checks: true,
    fs_global_access_log_mode: 0,
    audio_backend: 'SDL3',
    audio_volume: 1,
    memory_manager_mode: 'HostMappedUnsafe',
    dram_size: 0,
    ignore_missing_services: false,
    gui_columns: {
      fav_column: true, icon_column: true, app_column: true, dev_column: true, version_column: true, ldn_info_column: false,
      time_played_column: true, last_played_column: true, file_ext_column: true, file_size_column: true, path_column: true,
    },
    column_sort: { sort_column_id: 0, sort_ascending: false },
    game_dirs: [],
    autoload_dirs: [],
    shown_file_types: { nsp: true, pfs0: true, xci: true, nca: true, nro: true, nso: true },
    window_startup: { window_size_width: 1280, window_size_height: 760, window_position_x: 0, window_position_y: 0, window_maximized: false },
    language_code: 'en_US',
    base_style: 'Dark',
    game_list_view_mode: 0,
    show_names: true,
    grid_size: 2,
    application_sort: 0,
    is_ascending_order: true,
    start_fullscreen: false,
    start_no_ui: false,
    show_console: false,
    enable_keyboard: false,
    enable_mouse: false,
    disable_input_when_out_of_focus: false,
    hotkeys: {
      toggle_vsync_mode: 'F1', screenshot: 'F8', show_ui: 'F4', pause: 'F5', toggle_mute: 'F2',
      res_scale_up: 'Unbound', res_scale_down: 'Unbound', volume_up: 'Unbound', volume_down: 'Unbound',
      custom_vsync_interval_increment: 'Unbound', custom_vsync_interval_decrement: 'Unbound',
      turbo_mode: 'Unbound', turbo_mode_while_held: false,
    },
    input_config: [defaultKeyboardInput()],
    player_input_assignments: [{ player_index: 'Player1', enable_dynamic_input_swap: false, devices: [{ type: 'Keyboard', id: '0', profile_name: null }] }],
    allow_duplicate_device_assignment: false,
    rainbow_speed: 1,
    graphics_backend: 'Vulkan',
    preferred_gpu: '',
    multiplayer_mode: 0,
    multiplayer_lan_interface_id: '0',
    multiplayer_disable_p2p: false,
    multiplayer_ldn_passphrase: '',
    ldn_server: '',
    use_hypervisor: true,
    gclow_latency: false,
    enable_gdb_stub: false,
    gdb_stub_port: 55555,
    debugger_suspend_on_start: false,
    show_dirty_hacks: false,
    dirty_hacks: [],
    pause_emulation_while_scanning_amiibo: true,
  };
}

/**
 * Top-level keys whose JSON type OmniPC checks: a wrong type makes System.Text.Json throw,
 * TryLoad returns false and Ryujinx renames the file to Config.json.<date>.invalid and
 * starts with defaults (Program.ReloadConfig, ConfigurationFileFormat.RenameInvalidConfigFile).
 */
export const MANAGED_TYPES: Record<string, 'string' | 'boolean' | 'integer' | 'number' | 'array' | 'object'> = {
  version: 'integer',
  res_scale: 'integer',
  res_scale_custom: 'number',
  aspect_ratio: 'string',
  graphics_backend: 'string',
  vsync_mode: 'integer',
  docked_mode: 'boolean',
  start_fullscreen: 'boolean',
  show_confirm_exit: 'boolean',
  update_checker_type: 'string',
  check_updates_on_start: 'boolean',
  show_console: 'boolean',
  logging_enable_trace: 'boolean',
  graphics_shaders_dump_path: 'string',
  enable_file_log: 'boolean',
  skip_user_profiles: 'boolean',
  ignore_applet: 'boolean',
  game_dirs: 'array',
  autoload_dirs: 'array',
  input_config: 'array',
  hotkeys: 'object',
  gui_columns: 'object',
  shown_file_types: 'object',
  window_startup: 'object',
};

/** Keys ConfigurationState.Load dereferences without a null check (missing => crash / NullReferenceException). */
export const REQUIRED_KEYS = ['version', 'game_dirs', 'hotkeys', 'gui_columns', 'column_sort', 'shown_file_types', 'window_startup', 'system_time_zone', 'language_code', 'base_style'];

export function isObject(v: Json | undefined): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function hasType(v: Json, t: (typeof MANAGED_TYPES)[string]): boolean {
  switch (t) {
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'number': return typeof v === 'number';
    case 'array': return Array.isArray(v);
    case 'object': return isObject(v);
    default: return typeof v === t;
  }
}

/** Sets a top-level key; returns true when the value changed. */
export function setKey(doc: JsonObject, key: string, v: Json): boolean {
  if (JSON.stringify(doc[key]) === JSON.stringify(v)) return false;
  doc[key] = v;
  return true;
}

/** Ryujinx writes 2-space indented JSON (JsonHelper.GetDefaultSerializerOptions WriteIndented). */
export function serializeConfig(doc: JsonObject): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function parseConfig(text: string): JsonObject | null {
  try {
    // Ryujinx reads with AllowTrailingCommas and comment skipping; OmniPC accepts plain JSON
    // only (it never writes either), stripping a UTF-8 BOM.
    const j = JSON.parse(text.replace(/^﻿/, '')) as Json;
    return isObject(j) ? j : null;
  } catch {
    return null;
  }
}
