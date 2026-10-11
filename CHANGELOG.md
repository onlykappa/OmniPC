# Changelog

All notable changes to OmniPC. Versions follow [Semantic Versioning](https://semver.org).

## [1.0.1] - 2026-10-11

### Added
- **Check & update all** on the Emulators page: checks every installed emulator and installs
  newer releases in one go. An update that fails its health test is rolled back automatically.
- **Install emulator updates automatically** (Settings → Updates, off by default): runs at
  startup and every 6 hours, postponed while a game is running.
- **OmniPC updates itself**: Settings → Updates shows the installed version, checks GitHub
  Releases, downloads the new installer (verified against the published SHA-512) and installs it
  with **Restart to update**. OmniPC checks at startup and notifies you; nothing installs without
  your click, and never during a game.
- **Update everything**: one button that updates OmniPC and every installed emulator.
- **Scan for BIOS & keys** (Emulators → BIOS & Firmware): like the game-folder scan, it finds
  BIOS, firmware and key files in your game folders or any folder you choose, recognises which
  system each belongs to (PS1, PS2, PS3 firmware, PS4 modules, GameCube IPL, DS, GBA, FDS,
  Wii U keys, Xbox MCPX/BIOS/HDD), checks them, and copies the ones you tick into the right
  BIOS folder. Originals are never moved or changed; nothing is ever downloaded.
- This is the last version you need to download by hand: from 1.0.1 on, updates are one click.

## [1.0.0] - 2026-10-10

First public release.

### Emulators
- **12 integrated emulators**, each installed from its official source, configured for your
  hardware, health-tested, updatable with one-click rollback:
  PCSX2 (PS2), Dolphin (GameCube/Wii), DuckStation (PS1), PPSSPP (PSP), RPCS3 (PS3),
  Cemu (Wii U), melonDS (DS), Xenia Canary (Xbox 360), xemu (Xbox),
  RetroArch (NES, SNES, N64, GB/GBC/GBA, Genesis, Arcade), shadPS4 (PS4) and KytyPS5
  (PS5, experimental).
- First-run wizards, update prompts and exit confirmations are suppressed so games launch
  fullscreen and return to OmniPC when closed.
- Saves, memory cards and states live in one OmniPC Saves folder that survives updates;
  emulators that keep data next to their executable have it carried across updates and
  preserved on uninstall.
- RPCS3 firmware install from your `PS3UPDAT.PUP`; RetroArch cores downloaded per system.

### Library
- Multi-folder, multi-drive incremental scanning with content-based identification,
  multi-disc grouping, duplicates, validation and drive-letter remapping.
- PS3 (`PS3_GAME/USRDIR/EBOOT.BIN`) and PS4/PS5 (`eboot.bin` + `sce_sys`) folder games.

### Controllers
- One universal controller profile and hotkey set translated into every emulator's own format,
  with an optional Nintendo button layout.

### OmniDoctor
- Health checks with a real score, log analysis, change correlation, evidence and confidence for
  every finding, repairs with safety levels, backups, history and undo.

### Known limitations
- PS4 and PS5 compatibility varies a lot per game (shadPS4 and KytyPS5 are young projects).
- KytyPS5 compatibility is limited and changes between upstream builds.
- The installer is not code-signed yet, so Windows SmartScreen may warn on first run.
