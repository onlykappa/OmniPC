# Changelog

All notable changes to OmniPC. Versions follow [Semantic Versioning](https://semver.org).

## [Unreleased]

### Added
- **Add to Steam**: Settings > Steam adds your games (all, chosen systems, or one game from its
  page) to Steam as non-Steam games, with the cover as the library capsule and the background as
  the hero image. Steam starts `OmniPC.exe --launch-game=<id>`; when OmniPC was started just for
  that game it closes when the game exits. Steam must be closed while shortcuts change (OmniPC
  can close it); shortcuts.vdf is backed up first, and only OmniPC's own shortcuts and artwork
  are ever changed or removed.
- **Automatic save backups**: daily or weekly (checked hourly, never while a game is running),
  after playing a game, and before an emulator is updated or rolled back. Unchanged saves are not
  backed up again. OmniPC keeps the newest automatic backups per emulator (10 by default); manual
  backups and the backups made before a restore are never removed. Older backups keep working.
- **Save backups in a cloud folder**: choose a OneDrive, Google Drive or Dropbox folder (found
  automatically) or any other folder. Each PC writes to its own subfolder of
  `OmniPC Save Backups`, ZIPs are written completely before they appear, and backups made on your
  other PCs are listed and can be restored here.
- Save backups on the Storage page are grouped by emulator with date, kind and PC, plus
  "Restore an emulator from a date". Restores always back up the current saves first.
- OmniDoctor warns when saves have not been backed up for 14 days (one-click backup) and when the
  backup folder is missing or not writable.

## [1.1.1] - 2026-10-11

### Added
- **Switch game info and pictures**: icons, banners, screenshots, descriptions, publisher and
  release year from the eShop listings indexed by titledb. Games are matched by the title ID in
  the file name (`[0100…]`) or inside the NSP, or by name.
- **Xbox and Xbox 360 game info**: OmniPC reads the title ID and real game name from the disc
  (`default.xbe` / `default.xex`), so Xbox discs are told apart from Xbox 360 discs without a
  folder hint and messy file names still find their box art. Xbox 360 covers come from the Xbox
  Marketplace image service.
- Existing Xbox and Switch games are re-identified once after updating and get their artwork.
- **Switch updates and DLC stay with their game**: update and DLC files no longer show up as
  separate games. Before each launch OmniPC registers the newest update and your DLC with
  Ryujinx, so games start up to date (updates or DLC you chose in Ryujinx are kept).
- **Xbox 360 game folders**: extracted games (a folder with `default.xex`) are imported with their
  title ID and get box art.

### Changed
- Ryujinx is installed and updated through ryujinx.app's own update server
  (update.ryujinx.app, the source of the Download button on ryujinx.app), with the Ryubing
  release list as a fallback.

## [1.1.0] - 2026-10-11

### Added
- **Nintendo Switch** via Ryujinx (Ryubing, the maintained Ryujinx continuation), installed from
  its official release server. Keys (`prod.keys`, `title.keys`) are recognised by Scan for BIOS &
  keys and copied in before each launch; firmware is installed once from Ryujinx's Tools menu.
- **Box art, title screens and screenshots for every system** from the libretro-thumbnails
  collection (no account needed). Existing libraries get artwork automatically after updating.
- **OmniDoctor → Fix games**: lists games with file problems and fixes them: repairs CUE sheets
  pointing at renamed tracks, rebuilds multi-disc playlists, extracts zipped disc games (the
  archive is kept), clears crash-loop pauses. CUE/M3U changes are backed up and undoable.

### Fixed
- N64 `.z64` ROMs were wrongly flagged as broken ("Split ZIP ... missing its final .zip part").
  Flagged games are re-checked automatically after updating.

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
