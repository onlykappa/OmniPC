# Writing an emulator adapter

Adding an emulator must not require changes to the core. You add:

1. `src/main/emulators/manifests/<id>.json` — declarative facts.
2. `src/main/emulators/<id>/adapter.ts` — a class implementing `EmulatorAdapter`.
3. One line in `src/main/emulators/registry.ts` to register it (and remove it from `PLANNED`).
4. Optional: `src/main/diagnostics/rules/<id>.rules.json` and an import in `rules.ts`.
5. Tests: config generation, launch arguments, and an e2e install/launch using the fake emulator.

## Research first

Before writing an adapter, verify against **current upstream sources** (the source code is
the most reliable reference):

- release feed and asset naming (what a Windows x64 build is called)
- command-line options (batch/fullscreen/no-GUI modes, user/data directory options, per-game overrides)
- portable mode / data directory resolution
- configuration file format and the exact section/key names you will write
- controller binding syntax
- log file location and characteristic error strings

Record what you verified, and the version you verified it against, in the manifest's
`assumptions` array. Example (PCSX2): "-gamecfg only exists in v2.9 nightlies; stable 2.8.2
has -datapath, -logfile, -testconfig".

## Manifest fields

| Field | Purpose |
|---|---|
| `id`, `name`, `systems`, `website`, `repository`, `license` | Identity |
| `implemented` | `false` makes the UI show "planned" and every action refuse |
| `download.kind` | `github-release` / `dolphin-update` / `none` |
| `download.repo`, `assetPatterns`, `assetExclude` | Asset selection (patterns are tried in order; AVX2/SSE4 builds are skipped if the CPU lacks the feature) |
| `download.allowedHosts` | Every download hop must be HTTPS on one of these hosts |
| `executable` | File name located inside the extracted archive |
| `configFiles`, `logFiles`, `saveDirs` | `{data}`/`{saves}`/`{app}`/`{bios}` placeholders; shown in the UI and used by the diagnostic package |
| `biosRequirements` | Shown on BIOS & Firmware |
| `notes`, `assumptions` | Documentation shown in the app and developer page |

## Adapter responsibilities

| Method | Notes |
|---|---|
| `paths()` | Keep program files (`app`) separate from data (`data`) so updates/rollbacks never touch settings |
| `findExecutable`, `detectVersion` | |
| `renderers(hw)`, `defaultSettings(hw, preset)` | Use `resolutionScaleFor` / `preferredRenderer` from `emulators/common.ts` |
| `configTargets()` | Every file you may modify; they are backed up before each change |
| `applyConfig(input, scope)` | Load existing file, set only managed keys, save atomically. Scopes: `all`, `paths`, `graphics`, `controller`. Must be idempotent. |
| `inspectConfig()` | Parse checks + "drift" of managed values (OmniDoctor uses this) |
| `buildLaunch(...)` | Return command/args (never a shell string), optional `prepare`/`cleanup`, and the log file to analyse |
| `smokeTest(exe)` | Prove the executable starts without a game (e.g. `-testconfig`, `--version`) |
| `biosStatus()`, `saveLocations()`, `cacheDirs()` | |
| `recoverSession()` | Undo anything `prepare()` changed if OmniPC was closed mid-session |
| `detectExistingSetups()` | Power "Import existing setup" |

Use `controllers/translate.ts` (`physicalFor`, `hotkeyChords`) so the universal profile and
hotkeys work identically across adapters, and only map hotkeys the emulator supports
(declare them in `capabilities.hotkeys`).
