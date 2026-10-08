# Development setup & building

## Prerequisites

- Node.js 22 or newer, npm 10+
- Windows 10/11 x64 for full functionality. Linux/macOS work for UI and backend development;
  Windows-only checks report "only checked on Windows" instead of guessing.

## Commands

| Command | What it does |
|---|---|
| `npm install` | Installs dependencies (Electron binary, prebuilt SQLite) |
| `npm run dev` | Builds main/preload, starts Vite, launches Electron pointed at it |
| `npm test` | Runs all vitest suites (unit, integration, end-to-end) |
| `npm run typecheck` | `tsc` for main (Node) and renderer (DOM) projects |
| `npm run build` | `dist/main` (esbuild, CJS) + `dist/renderer` (Vite) |
| `npm start` | Runs the built app with Electron |
| `npm run smoke` | Builds and launches the real app headless (Xvfb), captures screenshots into `smoke-shots/` |
| `npm run dist` | Windows NSIS installer in `release/` |
| `npm run dist:dir` | Unpacked Windows build in `release/win-unpacked` |

Useful environment variables:

| Variable | Effect |
|---|---|
| `OMNIDECK_SAFE_MODE=1` or `--safe-mode` | Start in Safe Mode |
| `OMNIDECK_LOG_STDOUT=1` | Mirror the app log to stdout |
| `OMNIDECK_DEV_SERVER_URL` | Set by `npm run dev` |

## Project layout

```
src/shared      types shared by both processes (models, IPC contract, system catalog)
src/main        Electron main process (see ARCHITECTURE.md)
src/renderer    React UI (pages/, components/, lib/)
tests/          vitest suites; tests/fixtures builds synthetic disc images, BIOS stubs and a fake emulator
scripts/        build-main, dev runner, Electron smoke test
docs/           documentation
```

## Tests

- **Unit**: INI editor, filename parsing, identification (synthetic ISO9660/GameCube/Wii/RVZ
  images), validation, PS2 BIOS ROMDIR parsing, rule matching, health score, manifests, archive safety.
- **Integration**: migrations and corruption recovery, config backups/diff/restore, the
  library scanner (multi-disc, incremental, drive loss/return, drive-letter remap, 12k-game
  query), adapters (generated INI keys, bindings, launch arguments, per-game overrides),
  downloads (trusted redirects, SHA-256 verification, untrusted hosts, resume).
- **End-to-end** (`tests/e2e.test.ts`): the acceptance flows from the specification run against
  the real backend: install PCSX2 from a (simulated) GitHub release, configure, scan, BIOS,
  launch, play history, deliberate breakage → detection → explanation → repair → relaunch,
  crash-loop protection, update → regression detection → rollback, then the same with Dolphin.
  Network and emulator executables are simulated (fake `fetch`, Node-script emulators).

## Fixtures are synthetic

`tests/fixtures/builders.mjs` builds minimal files containing only the header structures
OmniDeck reads (ISO9660 volume descriptor + `SYSTEM.CNF`, Nintendo disc headers, a PS2 ROMDIR
table). They contain no game or BIOS code.
