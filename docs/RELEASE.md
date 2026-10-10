# Release process

1. Update `version` in `package.json` (`npm version X.Y.Z --no-git-tag-version`) and add a
   `## [X.Y.Z]` section to [CHANGELOG.md](../CHANGELOG.md).
2. Merge to the default branch with CI green (typecheck, tests, build on Ubuntu and Windows).
3. Test the installer from the CI artifact using [TESTING_CHECKLIST.md](TESTING_CHECKLIST.md).
4. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
   The **Release** workflow re-runs the tests, checks the tag matches `package.json`, builds
   `OmniDeck-Setup-X.Y.Z.exe`, writes `SHA256SUMS.txt`, and publishes a GitHub Release with the
   changelog section as release notes.
5. Optional: code-sign the installer by adding `CSC_LINK`/`CSC_KEY_PASSWORD` secrets and removing
   `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` from the workflow.

## Application updates

Version 1 uses manual updates (download the new installer; settings, library, emulators and
saves are kept because they live outside the program folder). The settings model already has
an update channel field; stable/beta/development channels for OmniDeck itself are planned.
