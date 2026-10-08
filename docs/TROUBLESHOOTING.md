# Troubleshooting

| Symptom | What to do |
|---|---|
| "PlayStation 2 BIOS missing" | Import a BIOS dumped from your own PS2 in Settings ▸ BIOS & Firmware. OmniDeck validates the file's ROM directory. |
| Emulator exits immediately with 0xC0000135 | Visual C++ runtime missing. OmniDoctor offers to install it from Microsoft (signature-verified, asks for admin). |
| 0xC000001D (illegal instruction) | The build needs CPU features you don't have. Reinstall from the Emulators page; OmniDeck picks a compatible build. |
| Black screen / renderer error | Open the failure screen or the game's Settings tab and switch renderer (Direct3D 11 is the most compatible). |
| "Game drive unavailable" | Reconnect the drive. Games return automatically, even if Windows assigns a new letter. |
| Buttons don't work in Dolphin with a PlayStation controller | Dolphin names non-Xbox pads by driver name. Controllers ▸ Apply to all emulators; if it persists set the controller type correctly. |
| A game keeps crashing | OmniDoctor pauses launching after 3 failures. Read the diagnosis, change settings, then "Try again anyway". |
| Something broke after an emulator update | OmniDoctor detects it and offers "Restore previous version". |
| OmniDeck itself crashes at startup | After two unclean exits it starts in Safe Mode automatically. Use Settings ▸ Reset & repair ▸ Repair Installation, then restart normally. |
| Database damaged | Restored automatically from the newest backup (`Backups\database`). Your game files are never touched. |

Logs: `%USERPROFILE%\OmniDeck\Logs\omnideck.log`. Emulator logs are linked from each emulator's page.
