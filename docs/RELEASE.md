# Release process

1. Update `version` in `package.json` and add release notes.
2. Ensure CI is green (typecheck, tests, build on Ubuntu and Windows).
3. The `installer` CI job builds `OmniDeck-Setup-<version>.exe` on `windows-latest` and uploads
   it as a workflow artifact.
4. Smoke-test the installer on a clean Windows 11 VM following the acceptance checklist in
   [USER_GUIDE.md](USER_GUIDE.md#first-run-checklist).
5. Code-sign the installer (configure `CSC_LINK`/`CSC_KEY_PASSWORD` secrets) and attach it to a
   GitHub release.

## Application updates

Version 1 uses manual updates (download the new installer; settings, library, emulators and
saves are kept because they live outside the program folder). The settings model already has
an update channel field; stable/beta/development channels for OmniDeck itself are planned.
