# OmniDeck PC: Windows testing checklist

This is the file to work from when testing on your PC. Tick items off, write what you saw
next to anything that fails, and send back the **Report** section at the bottom.

Last updated: 2026-10-10. Branch `claude/omnideck-foundation`, PR #1.

---

## 0. Get the latest installer

1. Open PR #1 on GitHub → **Checks** tab (or the repo's **Actions** tab → latest **CI** run on
   `claude/omnideck-foundation`).
2. Scroll to **Artifacts** → download **OmniDeck-Setup** → unzip → run the `.exe`.
3. If you already have OmniDeck installed, installing over it keeps your library, settings and saves.

Note the commit shown on the run (e.g. `d165b17`) so we know which build you tested.

---

## 1. Where each emulator stands

| Emulator | Systems | State in this build | What you must supply |
|---|---|---|---|
| PCSX2 | PS2 | Ported. **Fixed** the "Timed out after 30s" health check | PS2 BIOS → `BIOS\ps2` |
| Dolphin | GameCube, Wii | Ported (already Healthy for you) | nothing (GC IPL optional) |
| DuckStation | PS1 | Ported | PS1 BIOS (512 KB) → `BIOS\ps1` |
| PPSSPP | PSP | Ported | nothing |
| RPCS3 | PS3 | Ported | `PS3UPDAT.PUP` from Sony → `BIOS\ps3`, then **Install PS3 firmware** |
| Cemu | Wii U | Ported | `keys.txt` → `BIOS\wiiu` (encrypted dumps only) |
| melonDS | Nintendo DS | Ported | nothing (bios7/bios9/firmware optional → `BIOS\nds`) |
| Xenia Canary | Xbox 360 | Ported | nothing |
| KytyPS5 | PS5 | Ported, **experimental** (limited compatibility) | nothing; needs a Vulkan 1.3 GPU |
| xemu | Xbox | In progress (shows "Planned") | MCPX boot ROM, BIOS, HDD image → `BIOS\xbox` |
| RetroArch | NES, SNES, N64, GB/GBC/GBA, Genesis, Arcade | In progress (shows "Planned") | nothing for most systems |
| — | PS4 | Games are recognised, **no emulator yet** (KytyPS5 is PS5-only) | — |

OmniDeck never downloads BIOS, firmware or keys. Use files from your own consoles.

---

## 2. Test each ported emulator

Do these for every row marked "Ported". It's fine to skip emulators you don't care about.

### A. Install and health
- [ ] Emulators page → **Install**. The job finishes without an error.
- [ ] The card shows **Healthy**. If it says **Needs attention**, open it and copy the failing check text.
- [ ] (PCSX2 only) If it was already installed: click **Repair** → it should now be **Healthy**.

### B. Launch a game
- [ ] Library → pick a game for that system → **Play**.
- [ ] The game starts **fullscreen** with **no pop-up** first (setup wizard, "update available",
      "settings failed to load", welcome box…). Any pop-up = note its exact text.
- [ ] The controller works in-game (D-pad, sticks, face buttons, triggers).
- [ ] Exit with the hotkey (default **Select + Start**) or by closing the window → you're back in OmniDeck.
- [ ] Play history shows the session.

### C. Saves
- [ ] Save in-game, exit, launch again, and check the save is still there.
- [ ] Emulator details page → **Files** panel: the save folders listed there exist and contain your save.

### D. Per-emulator extras
- **PCSX2:** health check no longer times out.
- **RPCS3:** put `PS3UPDAT.PUP` in `BIOS\ps3` → OmniDoctor shows "PS3 firmware found but not
  installed" → **Install PS3 firmware** → confirm in RPCS3's window → close RPCS3 when it says done →
  BIOS page shows the firmware version.
- **Cemu:** encrypted games need `keys.txt`. The Wii U GamePad's Home button is unmapped. Hotkeys
  that use the Guide button as modifier don't work in Cemu (use Select as modifier if you need them).
- **melonDS:** hotkeys are single buttons (fast-forward on RT). It has no exit hotkey, so close the window to exit.
- **Xenia:** a "No Profiles Found" notice inside Xenia is expected on first launch; the game
  should still start. No button remapping (Xbox pad is used as-is).
- **KytyPS5:** select a PS5 game *folder* (the one containing `eboot.bin` and `sce_sys\param.json`).
  A console window next to the game is normal. Many games won't boot yet; that's KytyPS5, not OmniDeck.
- **PPSSPP:** no volume hotkeys (PPSSPP has none).

---

## 3. Library checks
- [ ] Add your games folder (Settings → Library or onboarding). Games appear under the right systems.
- [ ] PS3 folder games (`PS3_GAME\USRDIR\EBOOT.BIN`) show with their real title.
- [ ] PS4/PS5 game folders show with their real title (PS4 has no emulator yet).
- [ ] `.pkg` files are **not** listed as PS3 games (expected).

---

## 4. OmniDoctor
- [ ] OmniDoctor → **Run full health check**. Note the score and any **Problem** findings.
- [ ] Try one suggested repair; it should succeed or explain why not.

---

## Report (copy this back to me)

```
Build commit: 
Windows version / GPU / CPU: 

Emulator | Installed? | Healthy? | Game launched? | Pop-ups? | Controller OK? | Saves OK? | Notes
PCSX2        |  |  |  |  |  |  |
Dolphin      |  |  |  |  |  |  |
DuckStation  |  |  |  |  |  |  |
PPSSPP       |  |  |  |  |  |  |
RPCS3        |  |  |  |  |  |  |
Cemu         |  |  |  |  |  |  |
melonDS      |  |  |  |  |  |  |
Xenia Canary |  |  |  |  |  |  |
KytyPS5      |  |  |  |  |  |  |

Exact text of any error / "Needs attention" check:

OmniDoctor score and problems:

Anything else odd:
```

Tip: for any failure, OmniDoctor → **Export diagnostic package** creates a zip of logs (no games,
BIOS, keys or saves) that you can attach.

---

## Still to do on my side
1. Finish and push **xemu** and **RetroArch** (in progress).
2. Update `docs/STATUS.md`, `THIRD_PARTY_NOTICES.md` and the user guide for the new emulators.
3. Fix whatever your report turns up.
