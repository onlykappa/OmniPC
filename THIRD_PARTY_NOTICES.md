# Third-party notices

OmniDeck PC is MIT-licensed. It ships the following third-party software.

## Bundled in the OmniDeck application

| Component | Version | License | Notes |
|---|---|---|---|
| Electron (Chromium, Node.js) | 43.7.5 | MIT (Chromium and Node.js components under their own licenses, listed in `LICENSES.chromium.html` inside the install folder) | Application runtime |
| React, React DOM | 19.x | MIT | UI |
| zustand | 5.x | MIT | UI state |
| @tanstack/react-virtual | 3.x | MIT | Virtualized library grid |
| better-sqlite3 | 13.x | MIT | SQLite bindings (prebuilt N-API binaries) |
| SQLite | bundled with better-sqlite3 | Public domain | Database engine |
| node-addon-api | 8.x | MIT | N-API helper used by better-sqlite3 |
| 7zip-bin | 5.x | MIT (wrapper) | Ships `7za` binaries |
| 7-Zip (`7za`) | via 7zip-bin | GNU LGPL 2.1 (7za contains no unRAR code) | Used only to extract emulator archives. Source: https://www.7-zip.org |
| yauzl / yazl | 3.x | MIT | ZIP extraction / creation |
| @anthropic-ai/sdk | 0.x | MIT | Optional AI troubleshooter; inactive unless enabled by the user |

## Not bundled — downloaded on request from official sources

OmniDeck does not distribute emulators. When you choose a system, OmniDeck
downloads the emulator from its official release source and it remains under
its own license:

| Emulator | License | Source used by OmniDeck |
|---|---|---|
| PCSX2 | GPL-3.0 | GitHub Releases of `PCSX2/pcsx2` |
| Dolphin | GPL-2.0-or-later | `https://dolphin-emu.org/update/latest/beta/` (official update service) |

Planned integrations (not downloaded by this version): RetroArch (GPL-3.0), DuckStation
(CC-BY-NC-ND-4.0, source-available), RPCS3 (GPL-2.0), PPSSPP (GPL-2.0+), Cemu (MPL-2.0),
melonDS (GPL-3.0), Xenia Canary (BSD-3-Clause), xemu (GPL-2.0).

## Data read at runtime (not distributed)

- **PCSX2 `GameIndex.yaml`** and **Dolphin `Sys/wiitdb-*.txt`** are read from the user's
  installed emulator to show titles and compatibility ratings. They are part of those
  projects and are not copied into OmniDeck.
- **Cover art** may be fetched (if enabled in Settings) from GameTDB (`art.gametdb.com`),
  the community `xlenore/ps2-covers` repository, or TheGamesDB (with the user's own API key).
  Artwork remains the property of its respective owners and is cached locally for display only.

## EmuDeck

OmniDeck is an independent project and is not affiliated with EmuDeck. EmuDeck (GPL-3.0)
was studied as an architectural reference only; no EmuDeck code, configuration files,
artwork or branding are included. OmniDeck can *read* an existing EmuDeck installation's
settings file to import paths and saves the user already owns.

## No console data

OmniDeck never bundles, downloads or distributes games, BIOS images, system firmware,
or encryption keys. Users supply content they legally own.
