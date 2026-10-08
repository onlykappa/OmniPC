# Security

## Downloads

- Sources are fixed per emulator in its manifest (official GitHub Releases API of the
  official repository, Dolphin's official update endpoint). Only version strings, URLs and
  published hashes are read from responses — nothing is executed as a command.
- Every request and every redirect hop must be HTTPS to a host in the manifest's
  `allowedHosts`; anything else aborts the download.
- When upstream publishes a SHA-256 (GitHub asset `digest`), the file must match or it is
  discarded. Otherwise the computed hash is recorded and the UI states that no upstream
  checksum exists. Sizes are checked when known.
- Archives are listed before extraction; absolute paths, drive letters, `..` traversal and
  links are rejected, and the extracted tree is re-verified afterwards.
- No downloaded script (PowerShell or otherwise) is ever executed. The only downloaded
  executable OmniDeck runs is the Microsoft VC++ redistributable, after verifying a valid
  Authenticode signature from Microsoft Corporation, and only on explicit user confirmation.

## Processes

- Emulators are started with `spawn` and an argument array (`shell: false`); file names can
  never be interpreted as commands. User "custom arguments" are tokenised, never shelled.
- PowerShell is used only with scripts embedded in the source, passed via `-EncodedCommand`.

## Application

- Standard-user process; no blanket elevation.
- Renderer: `contextIsolation`, `sandbox`, no Node integration, strict CSP, navigation and
  new windows blocked, single typed IPC channel that only accepts the main window as sender.
- `app.openExternal` only opens HTTPS links to known project domains.
- The artwork protocol serves image files only.

## Privacy

- Diagnostic packages and AI context redact the user's home path and user name and never
  include games, BIOS, keys, saves or personal documents. The UI previews AI context first.
- The AI troubleshooter is off by default.

## Reporting

Please open a private security advisory on the repository.
