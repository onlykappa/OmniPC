# User guide

## First run

1. **Welcome** — Get started (or skip and configure later).
2. **Computer** — OmniPC scans CPU (incl. AVX2/SSE4), RAM, GPU/VRAM, DirectX 12, Vulkan,
   displays, drives and the Visual C++ runtime, and rates your PC.
3. **Systems** — choose what you play. PS2, GameCube and Wii are installable today.
4. **Games** — add your game folders (any drive). OmniPC previews what it found.
5. **Controller** — press a button to see it detected.
6. **Configuration** — pick Performance / Balanced / Quality / Maximum (recommended preselected).
7. **Install** — emulators are downloaded from official sources, verified, configured,
   controller-mapped and tested; your library is scanned and a health check runs.

### First-run checklist

- [ ] PCSX2 installed and "Healthy" on the Emulators page
- [ ] Your PS2 BIOS imported (Settings ▸ BIOS & Firmware) and shown as Found
- [ ] PS2 games appear with titles (and covers if online artwork is on)
- [ ] Play launches the game; Select + Start exits back to OmniPC
- [ ] Play time appears on the game page

## Everyday use

- **Home**: Continue Playing, Favorites, Recently Added, systems, emulator status, health.
- **Search**: `Ctrl+K` (or Y on a controller) finds games, systems, emulators and settings.
- **Game page**: Play, favourites, per-game settings (renderer, resolution, aspect, custom
  arguments), metadata correction, save folders, diagnostics.
- **Emulator updates**: **Emulators → Check & update all** checks every installed emulator and
  installs anything newer. Each update backs up the emulator's configuration, keeps the previous
  version, and runs a health test; if the test fails, the previous version is restored
  automatically. To do this without clicking, turn on **Settings → Updates → Install emulator
  updates automatically** (runs at startup and every 6 hours, never while a game is running).
- **Updating OmniPC**: **Settings → Updates** shows your version. **Check for OmniPC updates**
  finds a new release on GitHub, **Download** fetches it, and **Restart to update** installs it
  (your library, settings, emulators and saves are kept). **Update everything** does OmniPC and
  all emulators in one click. Versions before 1.0.1 must be updated once by downloading the
  installer from the GitHub release page.
- **Console Mode**: fullscreen and controller-only. D-pad/stick move, A select, B back,
  LB/RB switch sections, Y search, Start home.

## Hotkeys in games (defaults)

| Action | Buttons |
|---|---|
| Exit game | Select + Start |
| Save state | Select + RB |
| Load state | Select + LB |
| Volume up / down | Select + D-pad Up / Down |
| Emulator menu (PCSX2) | Select + Y |
| Fast forward | Select + RT |

The modifier can be changed to Guide; note that Windows Game Bar captures Guide by default.

## When something goes wrong

If a game fails, OmniPC shows what happened, what it detected, the likely cause with
confidence and evidence, and a fix button (e.g. "Switch this game to Direct3D 11 and retry").
After repeated failures automatic launching pauses to avoid crash loops.

Open **OmniDoctor** for a full health check, "Repair all safe issues", repair history with
undo, and to export a diagnostic package for support.

## Your data

Games, saves, BIOS files and screenshots are ordinary files. See **Storage** for where
everything lives and to move folders to another drive. Uninstalling OmniPC never deletes them.
