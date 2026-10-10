// Searchable catalog of settings and pages (Settings search + global search).

import type { SettingDescriptor } from '@shared/models';

export const SETTINGS_CATALOG: SettingDescriptor[] = [
  { key: 'consoleModeOnStart', section: 'Interface', label: 'Start in Console Mode', description: 'Open OmniDeck in fullscreen, controller-first mode.', keywords: ['fullscreen', 'big picture', 'tv', 'couch', 'controller'], route: '/settings#interface' },
  { key: 'startWithWindows', section: 'Interface', label: 'Start with Windows', description: 'Launch OmniDeck when you sign in to Windows.', keywords: ['startup', 'boot', 'autostart'], route: '/settings#interface' },
  { key: 'reduceMotion', section: 'Interface', label: 'Reduce motion', description: 'Turn off animations and transitions.', keywords: ['animation', 'accessibility'], route: '/settings#interface' },
  { key: 'defaultPreset', section: 'Graphics', label: 'Default quality preset', description: 'Performance, Balanced, Quality or Maximum for new emulator configurations.', keywords: ['graphics', 'resolution', 'upscale', 'quality', 'performance', 'vulkan', 'directx', 'renderer'], route: '/settings#graphics' },
  { key: 'hotkeys', section: 'Controllers', label: 'Universal hotkeys', description: 'Button combinations for exit, save state, load state, volume and menus.', keywords: ['controller', 'hotkey', 'exit', 'save state', 'guide', 'select'], route: '/controllers#hotkeys' },
  { key: 'controllerProfile', section: 'Controllers', label: 'Universal controller profile', description: 'Configure your controller once; OmniDeck maps it into every emulator.', keywords: ['controller', 'gamepad', 'xbox', 'dualsense', 'mapping', 'buttons', 'pcsx2', 'dolphin'], route: '/controllers' },
  { key: 'autoRepairSafeIssues', section: 'OmniDoctor', label: 'Fix safe issues automatically', description: 'Run SAFE repairs (like recreating empty folders) without asking.', keywords: ['repair', 'doctor', 'automatic', 'self-healing'], route: '/settings#doctor' },
  { key: 'backgroundHealthChecks', section: 'OmniDoctor', label: 'Background health checks', description: 'Run a quick health check at startup and periodically.', keywords: ['health', 'diagnostics', 'doctor'], route: '/settings#doctor' },
  { key: 'crashLoopThreshold', section: 'OmniDoctor', label: 'Crash-loop protection', description: 'Pause automatic launching after this many failures in a row.', keywords: ['crash', 'loop', 'failure'], route: '/settings#doctor' },
  { key: 'launchTimeoutSeconds', section: 'OmniDoctor', label: 'Launch timeout', description: 'Warn if an emulator has not opened a window after this many seconds.', keywords: ['timeout', 'launch', 'hang'], route: '/settings#doctor' },
  { key: 'aiEnabled', section: 'OmniDoctor', label: 'AI troubleshooter (optional)', description: 'Ask questions about failures using the Anthropic API. Off by default; never required.', keywords: ['ai', 'assistant', 'claude', 'ask'], route: '/settings#ai' },
  { key: 'metadataOnline', section: 'Library', label: 'Online metadata & artwork', description: 'Download cover art from enabled providers. Cached locally.', keywords: ['artwork', 'covers', 'metadata', 'boxart', 'gametdb'], route: '/settings#library' },
  { key: 'theGamesDbApiKey', section: 'Library', label: 'TheGamesDB API key', description: 'Optional key for descriptions and box art from TheGamesDB.', keywords: ['metadata', 'api key', 'thegamesdb'], route: '/settings#library' },
  { key: 'updateChannel', section: 'Updates', label: 'Emulator update channel', description: 'Stable releases or nightly builds.', keywords: ['update', 'nightly', 'stable', 'pcsx2', 'dolphin', 'beta'], route: '/settings#updates' },
  { key: 'checkUpdatesOnStart', section: 'Updates', label: 'Check for updates at startup', description: 'Look for new emulator versions when OmniDeck starts.', keywords: ['update'], route: '/settings#updates' },
  { key: 'devMode', section: 'Advanced', label: 'Developer mode', description: 'Show the developer diagnostics page (adapter status, raw checks, launch commands).', keywords: ['developer', 'debug', 'adapter', 'manifest'], route: '/settings#advanced' },
  { key: 'storage', section: 'Storage', label: 'Storage locations', description: 'See and move where emulators, saves, BIOS and cache are stored.', keywords: ['storage', 'folder', 'drive', 'move', 'relocate', 'disk'], route: '/storage' },
  { key: 'bios', section: 'BIOS & Firmware', label: 'BIOS & firmware', description: 'Check and import BIOS files for each system.', keywords: ['bios', 'firmware', 'ps2', 'ipl', 'keys', 'rpcs3', 'ps3'], route: '/bios' },
  { key: 'pcsx2', section: 'Emulators', label: 'PCSX2 settings', description: 'Renderer, resolution and advanced options for PCSX2 (PlayStation 2).', keywords: ['pcsx2', 'ps2', 'vulkan', 'direct3d', 'renderer', 'resolution'], route: '/emulators/pcsx2' },
  { key: 'dolphin', section: 'Emulators', label: 'Dolphin settings', description: 'Renderer, resolution and advanced options for Dolphin (GameCube/Wii).', keywords: ['dolphin', 'gamecube', 'wii', 'vulkan', 'direct3d', 'renderer', 'resolution'], route: '/emulators/dolphin' },
  { key: 'rpcs3', section: 'Emulators', label: 'RPCS3 settings', description: 'PlayStation 3: renderer, resolution and firmware.', keywords: ['rpcs3', 'ps3', 'firmware', 'pup'], route: '/emulators/rpcs3' },
  { key: 'duckstation', section: 'Emulators', label: 'DuckStation settings', description: 'PlayStation: renderer, resolution and BIOS.', keywords: ['duckstation', 'ps1', 'psx', 'playstation'], route: '/emulators/duckstation' },
  { key: 'ppsspp', section: 'Emulators', label: 'PPSSPP settings', description: 'PlayStation Portable: renderer and resolution.', keywords: ['ppsspp', 'psp'], route: '/emulators/ppsspp' },
  { key: 'cemu', section: 'Emulators', label: 'Cemu settings', description: 'Wii U: renderer, keys and game data.', keywords: ['cemu', 'wii u', 'wiiu', 'keys'], route: '/emulators/cemu' },
  { key: 'melonds', section: 'Emulators', label: 'melonDS settings', description: 'Nintendo DS: renderer and optional BIOS/firmware.', keywords: ['melonds', 'nds', 'ds'], route: '/emulators/melonds' },
  { key: 'xenia', section: 'Emulators', label: 'Xenia Canary settings', description: 'Xbox 360: renderer and resolution scale.', keywords: ['xenia', 'xbox 360', 'x360'], route: '/emulators/xenia' },
  { key: 'xemu', section: 'Emulators', label: 'xemu settings', description: 'Original Xbox: boot ROM, BIOS and hard disk image.', keywords: ['xemu', 'xbox', 'mcpx'], route: '/emulators/xemu' },
  { key: 'retroarch', section: 'Emulators', label: 'RetroArch settings', description: 'Retro systems: cores, renderer and hotkeys.', keywords: ['retroarch', 'cores', 'libretro', 'nes', 'snes', 'n64', 'gba', 'genesis', 'arcade'], route: '/emulators/retroarch' },
  { key: 'kyty', section: 'Emulators', label: 'Kyty (experimental)', description: 'PlayStation 4/5: experimental, runs only a few simple games and homebrew.', keywords: ['kyty', 'ps4', 'ps5'], route: '/emulators/kyty' },
  { key: 'factoryReset', section: 'Advanced', label: 'Reset & repair OmniDeck', description: 'Reset settings, reset emulator configurations, repair installation or full reset. Games and saves are preserved.', keywords: ['reset', 'factory', 'repair', 'clean'], route: '/settings#reset' },
  { key: 'safeMode', section: 'Advanced', label: 'Safe Mode', description: 'Restart with background services, animations and auto-updates disabled.', keywords: ['safe mode', 'troubleshoot', 'crash'], route: '/settings#advanced' },
  { key: 'diagnosticPackage', section: 'OmniDoctor', label: 'Export diagnostic package', description: 'Bundle logs and diagnostics (no games, BIOS, keys or saves).', keywords: ['logs', 'export', 'support', 'diagnostics'], route: '/doctor' },
  { key: 'import', section: 'Library', label: 'Import existing setup', description: 'Bring in PCSX2, Dolphin or EmuDeck folders, saves and BIOS.', keywords: ['import', 'emudeck', 'migrate', 'existing'], route: '/settings#import' },
];

export function searchSettings(q: string): SettingDescriptor[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return SETTINGS_CATALOG;
  return SETTINGS_CATALOG.filter((s) => {
    const hay = `${s.label} ${s.description} ${s.section} ${s.keywords.join(' ')}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}
