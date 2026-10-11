// RetroAchievements: shared types between the main process and the renderer.
// The login token never crosses this boundary; only whether one is stored.

/** Where new players create a RetroAchievements account (opened externally). */
export const RA_CREATE_ACCOUNT_URL = 'https://retroachievements.org/createaccount.php';

export interface RetroAchievementsSettings {
  /** Achievements turned on in every supporting emulator. */
  enabled: boolean;
  /** Signed-in RetroAchievements user (as the server spells it), null when signed out. */
  username: string | null;
  /** Hardcore mode: no save states, rewind, slow motion or cheats; unlocks count as hardcore. */
  hardcore: boolean;
}

export type RaEmulatorStatus =
  /** Installed and its config holds the OmniPC sign-in. */
  | 'configured'
  /** Installed but its config is missing or out of date ("Apply to emulators" fixes it). */
  | 'not-configured'
  /** Not installed; configured automatically when it is. */
  | 'not-installed'
  /** OmniPC cannot store the sign-in for this emulator; sign in inside the emulator once. */
  | 'needs-sign-in'
  | 'error';

export interface RaEmulatorState {
  emulatorId: string;
  name: string;
  status: RaEmulatorStatus;
  detail: string;
}

export interface RaStatus {
  signedIn: boolean;
  username: string | null;
  enabled: boolean;
  hardcore: boolean;
  /** The token is encrypted with Windows (DPAPI via Electron safeStorage). */
  tokenProtected: boolean;
  /** A sign-in is recorded but its token cannot be read on this PC; sign in again. */
  needsSignIn: boolean;
  emulators: RaEmulatorState[];
}
