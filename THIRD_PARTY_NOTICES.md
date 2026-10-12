# Third-party notices

OmniPC is MIT-licensed. It ships the following third-party software.

## Bundled in the OmniPC application

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

OmniPC does not distribute emulators. When you choose a system, OmniPC
downloads the emulator from its official release source and it remains under
its own license:

| Emulator | License | Source used by OmniPC |
|---|---|---|
| PCSX2 | GPL-3.0 | GitHub Releases of `PCSX2/pcsx2` |
| Dolphin | GPL-2.0-or-later | `https://dolphin-emu.org/update/latest/beta/` (official update service) |
| DuckStation | CC-BY-NC-ND-4.0 (source-available; official builds only, never redistributed) | GitHub Releases of `stenzek/duckstation` |
| PPSSPP | GPL-2.0-or-later | GitHub Releases of `hrydgard/ppsspp` |
| RPCS3 | GPL-2.0 | GitHub Releases of `RPCS3/rpcs3-binaries-win` |
| Cemu | MPL-2.0 | GitHub Releases of `cemu-project/Cemu` |
| melonDS | GPL-3.0 | GitHub Releases of `melonDS-emu/melonDS` |
| Xenia Canary | BSD-3-Clause | GitHub Releases of `xenia-canary/xenia-canary` |
| xemu | GPL-2.0 | GitHub Releases of `xemu-project/xemu` |
| RetroArch | GPL-3.0 (each libretro core has its own license) | `buildbot.libretro.com` (stable build; cores from the nightly core directory), version from `libretro/RetroArch` tags |
| shadPS4 | GPL-2.0-or-later | GitHub Releases of `shadps4-emu/shadPS4` (emulator core) |
| Ryujinx (Ryubing) | MIT | Official builds via update.ryujinx.app (ryujinx.app), hosted on `git.ryujinx.app/projects/Ryubing` |
| titledb | community index (blawar/titledb) | Switch eShop listing data downloaded on demand from GitHub; images are Nintendo's eShop pictures (img-eshop.cdn.nintendo.net); not bundled |
| Xbox Marketplace images | Microsoft | Xbox 360 box art fetched on demand from download.xbox.com; not bundled |
| libretro-thumbnails | community artwork collection | Box art and screenshots fetched on demand from `github.com/libretro-thumbnails`; not bundled |
| KytyPS5 | GPL-2.0 | GitHub Releases of `KytyPS5/KytyPS5` |

## Data read at runtime (not distributed)

- **PCSX2 `GameIndex.yaml`** and **Dolphin `Sys/wiitdb-*.txt`** are read from the user's
  installed emulator to show titles and compatibility ratings. They are part of those
  projects and are not copied into OmniPC.
- **Cover art** may be fetched (if enabled in Settings) from GameTDB (`art.gametdb.com`),
  the community `xlenore/ps2-covers` repository, or TheGamesDB (with the user's own API key).
  Artwork remains the property of its respective owners and is cached locally for display only.

## EmuDeck

OmniPC is an independent project and is not affiliated with EmuDeck. EmuDeck (GPL-3.0)
was studied as an architectural reference only; no EmuDeck code, configuration files,
artwork or branding are included. OmniPC can *read* an existing EmuDeck installation's
settings file to import paths and saves the user already owns.

## No console data

OmniPC never bundles, downloads or distributes games, BIOS images, system firmware,
or encryption keys. Users supply content they legally own.

## System logos

The console logos in `src/renderer/assets/systems/` are trademarks of Sony Interactive
Entertainment, Nintendo, Microsoft and Sega, used only to identify which system a game belongs
to. They come from Wikimedia Commons (public domain / CC0 as marked there; see
`src/renderer/assets/systems/SOURCES.md`) and are not covered by OmniPC's MIT licence. OmniPC is
not affiliated with or endorsed by these companies.

