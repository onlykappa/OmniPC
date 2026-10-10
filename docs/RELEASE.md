# Release process

1. Update `version` in `package.json` (`npm version X.Y.Z --no-git-tag-version`) and add a
   `## [X.Y.Z]` section to [CHANGELOG.md](../CHANGELOG.md).
2. Merge to the default branch with CI green (typecheck, tests, build on Ubuntu and Windows).
3. Test the installer from the CI artifact using [TESTING_CHECKLIST.md](TESTING_CHECKLIST.md).
4. Publish: on GitHub open **Releases → Draft a new release**, type the new tag `vX.Y.Z`
   ("Create new tag on publish", target `main`), and click **Publish release**. Pushing a `vX.Y.Z`
   tag or running the **Release** workflow from the Actions tab works too.
   The **Release** workflow re-runs the tests, checks the tag matches `package.json`, builds
   `OmniPC-Setup-X.Y.Z.exe`, writes `SHA256SUMS.txt`, attaches both to the release and sets the
   release notes from the changelog section (about 10 minutes).
5. Optional: code-sign the installer by adding `CSC_LINK`/`CSC_KEY_PASSWORD` secrets and removing
   `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` from the workflow.

## Application updates

Version 1 uses manual updates (download the new installer; settings, library, emulators and
saves are kept because they live outside the program folder). The settings model already has
an update channel field; stable/beta/development channels for OmniPC itself are planned.
