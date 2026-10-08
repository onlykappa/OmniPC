# OmniDoctor diagnostic rules

Rules live in `src/main/diagnostics/rules/*.rules.json`. Each file has an `emulatorId`
(`*` for generic rules) and a list of rules:

```json
{
  "id": "pcsx2.gs-init-failed",
  "title": "PCSX2's graphics renderer failed to start",
  "category": "graphics",
  "severity": "problem",
  "confidence": "high",
  "exitCodes": [],
  "patterns": ["Failed to create render device", "Failed to initialize GS"],
  "probableCause": "The selected renderer is not supported by your GPU or driver.",
  "fix": { "actionId": "emulator.setRenderer", "label": "Switch to Direct3D 11", "safety": "low", "params": { "renderer": "d3d11" } },
  "userSupplied": false,
  "manual": ["Update your graphics driver."],
  "references": []
}
```

| Field | Meaning |
|---|---|
| `patterns` | Case-insensitive regular expressions matched line by line against the log written *during the failed session* plus captured stderr |
| `exitCodes` | Signed 32-bit exit codes (Windows NTSTATUS values such as `-1073741515` = `0xC0000135`) |
| `confidence` | `high` only if the signature unambiguously identifies the cause |
| `fix.actionId` | A repair action from `repairs/engine.ts`. For renderer fixes the engine scopes the change to the failing game and avoids "switching" to the renderer already in use |
| `userSupplied` | The fix needs something only the user can provide (BIOS/firmware/keys) — OmniDeck says automatic repair is unavailable |

Rules are validated by `tests/rules.test.ts` (unique ids, valid regexes, a pattern or exit
code, valid safety). Prefer strings copied from the emulator's source code; note the version
you verified in the file's `description`.

## Available repair actions

`folders.recreate` (safe), `emulator.regenerateConfig` (low), `config.repairFormat` (low),
`emulator.setRenderer` (low), `emulator.repair` (low), `emulator.install` (low),
`emulator.update` (low), `emulator.reinstall` (high), `emulator.rollback` (high),
`emulator.recoverSession` (safe), `cache.clear` (high), `controller.reapply` (low),
`hotkeys.restoreDefaults` (low), `library.rescan` (safe), `library.remapPaths` (safe),
`database.backup` (safe), `database.reindex` (safe), `launch.resetCrashLoop` (safe),
`metadata.refreshAll` (safe), `hardware.scan` (safe), `dependency.vcredist` (high).
