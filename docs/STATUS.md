# Implementation status

This file is the honest map of what works. The UI follows the same rule: anything not
implemented is labelled *planned* or disabled, never a button that silently does nothing.

## Implemented (Version 1 foundation)

| Area | Status |
|---|---|
| App shell, desktop + Console Mode, controller/keyboard navigation, global search, notifications | ✅ |
| SQLite database, migrations, rotating backups, corruption recovery | ✅ |
| Hardware scan (CPU features, RAM, GPU/VRAM, DX12/Vulkan, displays, drives, VC++ runtime) | ✅ (Windows via PowerShell/CIM; partial on other OSes) |
| Library: multi-folder/multi-drive recursive incremental scan, content identification, validation, multi-disc grouping, duplicates, drive offline/return + letter remap | ✅ |
| Metadata: emulator databases (PCSX2 GameIndex, Dolphin GameTDB titles), GameTDB covers, PS2 covers, TheGamesDB (user key), local art, correction UI, thumbnails | ✅ |
| Emulator adapter architecture (manifest + adapter + shared lifecycle manager) | ✅ |
| **PCSX2**: install (GitHub, SHA-256), update, rollback, repair, reset, uninstall, use existing, config generation, controller + hotkeys, per-game profiles, smoke test, BIOS validation, log rules | ✅ |
| **Dolphin**: install (official update service), update, rollback, repair, reset, uninstall, config generation, GC pad + Wii Remote/Nunchuk, hotkeys, per-game `-C` overrides, smoke test, IPL handling, log rules | ✅ |
| **DuckStation** (PS1), **PPSSPP** (PSP), **RPCS3** (PS3, incl. firmware install), **Cemu** (Wii U), **melonDS** (DS), **Xenia Canary** (Xbox 360): install, update, rollback, repair, reset, uninstall, config generation with first-run prompts suppressed, controller + hotkeys (within each emulator's limits), save folders under OmniDeck, BIOS/firmware/keys status | ✅ (not yet run on Windows) |
| **xemu** (Xbox, user-supplied MCPX/BIOS/HDD) and **RetroArch** (NES, SNES, N64, GB/GBC/GBA, Genesis, Arcade; cores downloaded per system) | ✅ (not yet run on Windows) |
| **KytyPS5** (PS5, experimental upstream): install from daily releases, CLI launch of game folders, saves under OmniDeck, Vulkan check | ✅ (not yet run on Windows) |
| Folder-format games: PS3 `PS3_GAME/USRDIR/EBOOT.BIN`, PS4/PS5 `eboot.bin` + `sce_sys` | ✅ |
| Launch router, process monitoring, play history, crash-loop protection, failure recovery screen | ✅ |
| OmniDoctor: 16 checks, real health score, rule knowledge base, log analysis, change correlation, confidence/evidence, repairs with safety levels, repair history + undo, repair-all-safe, automatic safe repairs | ✅ |
| Config backups (compare/restore/delete), save backups/restore, storage relocation | ✅ |
| BIOS & firmware manager (validation for PS2 BIOS, GameCube IPL; file listing for other systems) | ✅ |
| Download manager (progress, speed, pause/resume via Range, retry, cancel, verification) | ✅ |
| Import existing setups: PCSX2 (Documents), Dolphin (AppData/Documents), standalone installs, EmuDeck for Windows (ROM paths, BIOS, saves) | ✅ |
| Export diagnostic package (redacted; excludes games/BIOS/keys/saves) | ✅ |
| Optional AI troubleshooter (Anthropic API, off by default, context preview) | ✅ |
| Safe Mode (manual or automatic after repeated unclean exits), factory reset options | ✅ |
| Developer page (manifest, paths, version source, raw checks, launch command, latest log, rules) | ✅ |
| Windows installer (NSIS via electron-builder), CI (Ubuntu + Windows tests, installer artifact) | ✅ |

## Verified where

- Automated tests: 101 tests, including end-to-end acceptance flows for PCSX2 and Dolphin
  against the real backend, with simulated network and stand-in emulator executables.
- The Electron app was launched headless (Linux/Xvfb) with a seeded library and every main page rendered.
- An unpacked Windows build (`electron-builder --win --dir`) was produced.

See [TESTING_CHECKLIST.md](TESTING_CHECKLIST.md) for the Windows test plan.

**Not yet verified on a physical Windows PC with the real emulators:** the actual PCSX2/Dolphin
downloads (the development sandbox could not reach GitHub/dolphin-emu.org), real controller
input inside the emulators, PowerShell hardware queries on real hardware, window-detection
timeouts and Windows exit codes from real crashes. The command-line options, config keys,
binding syntax and log strings were taken from the emulators' source code (see each
manifest's `assumptions`). Running the [first-run checklist](USER_GUIDE.md#first-run-checklist)
on Windows is the next milestone.

## Planned (declared, explicitly disabled in the UI)

- PS4: games are recognised, but no PS4 emulator is integrated (KytyPS5 runs PS5 titles only).
- In-game overlay drawn on top of emulators. Today: universal hotkeys map to each emulator's
  own features (exit, save/load state, volume, PCSX2 pause menu) and OmniDeck shows a session
  bar with "Force close" when focused.
- Steam shortcut export and EmulationStation-DE integration.
- Battery level and USB/Bluetooth connection type for controllers (the Gamepad API does not
  expose them; the UI says "not reported").
- OmniDeck self-update channels (stable/beta/dev). Version 1 updates manually via installer.
- Cloud save sync (save backups are local ZIPs).
- Achievements.
