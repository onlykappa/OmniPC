# OmniDeck PC

**One Windows app for your whole emulation setup.** OmniDeck installs and configures
emulators for you, builds one library from all your game folders, maps your controller
once for every emulator, launches games, and — when something breaks — diagnoses the
problem with evidence and repairs what it safely can.

> Status: Version 1 foundation. **PlayStation 2 (PCSX2)**, **GameCube and Wii (Dolphin)**
> are fully integrated end to end. Other systems are recognised in your library and their
> adapters are declared, but they are explicitly marked *planned* in the UI and cannot be
> installed or launched yet. See [docs/STATUS.md](docs/STATUS.md).

## What it does

- **One-click emulator install** from official sources (GitHub Releases for PCSX2, Dolphin's
  official update service), SHA-256 verified when upstream publishes a digest, safely extracted,
  configured for your hardware, and health-tested.
- **Unified library** across drives: recursive incremental scanning, content-based
  identification (PS2 `SYSTEM.CNF`, GameCube/Wii disc headers incl. RVZ/WIA/WBFS/GCZ/CISO,
  PSP `PARAM.SFO`, CHD media type), multi-disc grouping, duplicate detection, file validation,
  and drive-unavailable handling with automatic re-mapping when a drive returns on a new letter.
- **Metadata & artwork**: titles and compatibility ratings from the emulators' own bundled
  databases (offline), optional cover art (GameTDB, PS2 covers, TheGamesDB with your key),
  cached thumbnails, manual correction that is never overwritten.
- **Universal controller profile & hotkeys** translated into PCSX2 SDL bindings and Dolphin
  XInput/SDL bindings; live controller test and remap wizard.
- **Launch router** with per-game profiles (PCSX2 `-gamecfg` / session overrides, Dolphin `-C`),
  play history, crash-loop protection and failure recovery.
- **OmniDoctor**: 16 health checks, a health score computed only from real results, a JSON
  rule knowledge base matched against emulator logs and Windows exit codes, evidence and
  confidence for every diagnosis, change correlation ("this started after the update"),
  repairs with safety levels, backups, history and undo.
- **Backups everywhere**: config snapshots before every change (compare/restore/delete),
  save backups, rotating database backups with automatic corruption recovery,
  emulator rollback to the previous version.
- **Console Mode**: fullscreen, controller-only navigation of the whole app.

## Quick start (development)

Requirements: Node.js 22+, npm 10+. Windows 10/11 x64 for the full experience; the app and
test-suite also run on Linux/macOS (Windows-only features report themselves as unavailable).

```bash
npm install
npm run dev          # Vite + Electron with hot reload for the UI
npm test             # unit, integration and end-to-end tests (vitest)
npm run typecheck
npm run build        # bundles main/preload (esbuild) and renderer (Vite) into dist/
npm run dist         # Windows installer: release/OmniDeck-Setup-<version>.exe
```

## Documentation

| Topic | |
|---|---|
| Architecture & decisions | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Development setup & building | [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) |
| Writing an emulator adapter | [docs/ADAPTERS.md](docs/ADAPTERS.md) |
| OmniDoctor rules | [docs/DIAGNOSTIC_RULES.md](docs/DIAGNOSTIC_RULES.md) |
| Database | [docs/DATABASE.md](docs/DATABASE.md) |
| Security | [docs/SECURITY.md](docs/SECURITY.md) |
| Licensing | [docs/LICENSING.md](docs/LICENSING.md) |
| Release process | [docs/RELEASE.md](docs/RELEASE.md) |
| User guide | [docs/USER_GUIDE.md](docs/USER_GUIDE.md) |
| Troubleshooting | [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) |
| What works today | [docs/STATUS.md](docs/STATUS.md) |

## Legal

OmniDeck never downloads or distributes games, BIOS files, firmware or encryption keys.
You supply content you legally own. Emulators are downloaded from their official sources and
remain under their own licenses. OmniDeck is not affiliated with EmuDeck or any console maker.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
