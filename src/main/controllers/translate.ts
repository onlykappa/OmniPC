// Universal controller profile -> emulator binding translation helpers.

import type { HotkeyAction, HotkeyConfig, UniversalButton, UniversalControllerProfile } from '@shared/models';
import type { SystemId } from '@shared/systems';

export const UNIVERSAL_BUTTONS: UniversalButton[] = [
  'A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'L3', 'R3', 'Start', 'Select', 'Guide',
  'DPadUp', 'DPadDown', 'DPadLeft', 'DPadRight',
  'LeftStickUp', 'LeftStickDown', 'LeftStickLeft', 'LeftStickRight',
  'RightStickUp', 'RightStickDown', 'RightStickLeft', 'RightStickRight',
];

export function identityMapping(): Record<UniversalButton, UniversalButton> {
  return Object.fromEntries(UNIVERSAL_BUTTONS.map((b) => [b, b])) as Record<UniversalButton, UniversalButton>;
}

export function defaultProfile(): Omit<UniversalControllerProfile, 'id' | 'updatedAt'> {
  return {
    name: 'Player 1',
    controllerKind: 'xbox',
    deviceIndex: 0,
    mapping: identityMapping(),
    nintendoLayoutForNintendoSystems: false,
    rumble: true,
    deadzone: 0.15,
    perSystem: {},
  };
}

const NINTENDO_SYSTEMS: SystemId[] = ['nes', 'snes', 'n64', 'gb', 'gbc', 'gba', 'nds', 'wiiu'];

/**
 * Returns the physical button that should trigger `logical` for `system`,
 * applying per-system overrides and the optional Nintendo A/B X/Y swap.
 */
export function physicalFor(profile: Pick<UniversalControllerProfile, 'mapping' | 'perSystem' | 'nintendoLayoutForNintendoSystems'>, system: SystemId, logical: UniversalButton): UniversalButton {
  let l = logical;
  if (profile.nintendoLayoutForNintendoSystems && NINTENDO_SYSTEMS.includes(system)) {
    const swap: Partial<Record<UniversalButton, UniversalButton>> = { A: 'B', B: 'A', X: 'Y', Y: 'X' };
    l = swap[l] ?? l;
  }
  const override = profile.perSystem[system]?.[l];
  if (override) return override;
  return profile.mapping[l] ?? l;
}

/** Hotkey chords supported by an emulator: action -> [modifier, button]. */
export function hotkeyChords(cfg: HotkeyConfig, supported: HotkeyAction[]): { action: HotkeyAction; buttons: [UniversalButton, UniversalButton] }[] {
  return supported.filter((a) => cfg.bindings[a]).map((a) => ({ action: a, buttons: [cfg.modifier, cfg.bindings[a]] }));
}
