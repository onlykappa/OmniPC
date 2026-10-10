# Architecture

## Decision: Electron + React + TypeScript, Node services, SQLite

| Option | Verdict |
|---|---|
| **Electron + React + TypeScript** (chosen) | One language across UI and backend; mature Windows packaging (electron-builder/NSIS); the Chromium Gamepad API gives XInput/HID controller input for UI navigation for free; Node `child_process` gives precise control over emulator processes; huge pool of contributors. Cost: larger install (~100 MB) and memory. |
| .NET 8 + WinUI 3 | Best native integration, but WinUI packaging (MSIX/unpackaged) and controller-driven navigation need more custom work, the UI toolkit is less suited to the "console" visual style, and testing on non-Windows CI is harder. |

Windows-specific integration (hardware, drives, VC++ runtime, Authenticode checks, window
detection) is done with small **static** PowerShell scripts embedded in the code (never
downloaded), executed with `-EncodedCommand` and returning JSON. SQLite via `better-sqlite3`
(N-API prebuilds — no native rebuild for Electron).

## Layering

```
Renderer (React)  ──typed IPC (src/shared/ipc.ts)──▶  Main process
                                                       ├─ ipc/handlers.ts      (OmniApi implementation)
                                                       ├─ services/container.ts (composition root, no Electron imports)
                                                       │   ├─ library/         scanner, identify, validate, names, iso9660
                                                       │   ├─ metadata/        providers, title databases, art cache
                                                       │   ├─ emulators/       adapter interface, registry, manifests, pcsx2/, dolphin/
                                                       │   ├─ services/        emulatorManager, bios, saves, storage, notifications…
                                                       │   ├─ launching/       launch router + process monitor + crash-loop
                                                       │   ├─ diagnostics/     OmniDoctor checks, rules (JSON), log analysis, scoring
                                                       │   ├─ repairs/         repair actions with safety levels, history, undo
                                                       │   ├─ downloads/       trusted sources, download manager, safe extraction
                                                       │   ├─ config/          INI editor, format checks, config backups, diff
                                                       │   ├─ database/        SQLite, migrations, repositories, backups/recovery
                                                       │   ├─ platform/        exec, PowerShell, hardware, drives, dependencies
                                                       │   └─ core/            paths, logger, events, jobs, errors
                                                       └─ index.ts / preload.ts (Electron shell)
```

The **composition root** (`AppContainer`) receives Electron capabilities through a small
`Host` interface (thumbnailer, displays, window hooks, and optionally fetch/spawn). This is
what lets the integration tests drive the *real* backend — database, installer, scanner,
launch router, OmniDoctor and repair engine — without Electron.

## The launch path

```
Game ─▶ LaunchService.routeEmulator()  (game override ▸ profile ▸ system preference ▸ installed)
     ─▶ preflight (drive, file, executable, required BIOS, crash-loop)
     ─▶ adapter.buildLaunch(target, exe, settings, profile, version)  → { command, args, prepare, cleanup, logFile }
     ─▶ spawn (no shell) ─▶ record pid/args/log offset ─▶ minimise OmniPC
     ─▶ exit ─▶ classify (ok / early_exit / crashed / failed_to_start / killed) ─▶ play time, crash-loop state
     ─▶ needsAnalysis? ─▶ UI opens Failure Recovery ─▶ OmniDoctor.analyzeLaunch()
```

Library items never know an executable path. Adapters own every emulator-specific detail.

## Emulator adapters

Each emulator = **manifest** (declarative JSON: source, hosts, executable, config/log/save
paths, BIOS requirements, documented assumptions) + **adapter class** implementing
`EmulatorAdapter` (paths, config generation, inspection, launch building, smoke test,
BIOS status, save locations, session recovery, existing-setup detection). Shared lifecycle
logic (install/update/rollback/repair/reset/uninstall) lives once in `EmulatorManager`.
Planned emulators use `PlannedAdapter`, which refuses every action with an explicit message.
See [ADAPTERS.md](ADAPTERS.md).

## OmniDoctor

- **Checks** (`diagnostics/checks.ts`): inspect state, return findings including passes.
- **Score**: per-category mean of finding weights (pass 1, warning 0.6, problem 0; info excluded);
  overall = mean of categories. No finding → no score; nothing is invented.
- **Rules** (`diagnostics/rules/*.rules.json`): log/exit-code signatures with severity,
  probable cause, confidence, a safe fix and manual steps.
- **Failure analysis**: rule matches on the session's log excerpt (read from the byte offset
  recorded at launch) + stderr + exit code, targeted state checks, and change correlation.
  "High" confidence only when concrete evidence exists.
- **Repairs** (`repairs/engine.ts`): `safe` (may run automatically), `low` (needs approval),
  `high` (explicit confirmation). Deleting saves/ROMs/BIOS is not implemented anywhere.
  Every repair is logged, backs up first, and records undo information when feasible.

## Storage layout (default `%USERPROFILE%\OmniPC`)

```
Emulators\<id>\app        program files (replaced on update)
Emulators\<id>\data       emulator config/data (PCSX2 -datapath, Dolphin -u)
Emulators\<id>\rollback   previous versions
Saves\<id>\…              memory cards, Wii NAND, save states
BIOS\<system>\…           user-supplied BIOS / firmware
Cache\<id>                shader caches
Backups\{configs,saves,database}
Artwork\…, Artwork\thumbs
Data\omnideck.db          SQLite
Logs\omnideck.log
```

A bootstrap file in Electron's `userData` remembers the root and per-folder overrides,
which is what makes storage relocation possible.

## Process & privilege model

- The app runs as a standard user (`requestedExecutionLevel: asInvoker`).
- The only elevation is installing the Microsoft VC++ runtime, done through Windows' own UAC
  prompt after verifying the installer's Microsoft Authenticode signature, and only after the
  user confirms a high-impact repair that explains why.
- Renderer: `contextIsolation`, `sandbox`, no Node integration, strict CSP, navigation blocked;
  all backend access goes through one typed `invoke` channel.

## Lessons from EmuDeck (reference only)

EmuDeck's Windows edition (PowerShell scripts + Electron frontend) proves the value of
automated configuration. Limitations OmniPC addresses: downloads are not verified,
configuration is overwritten by sed-style replacement without backups, there is no
structured health model or failure diagnosis, and emulator data lives inside program folders
so updates are risky. OmniPC uses verified downloads, key-level INI edits with backups,
separate data folders, version rollback, and OmniDoctor.
