// "Add to Steam": OmniPC games as Steam non-Steam shortcuts. Types shared by
// the main process (src/main/steam) and the renderer (pages/Steam.tsx).

/** A Steam account that has signed in on this PC (a folder in Steam\userdata). */
export interface SteamUser {
  /** 32-bit account id, the userdata folder name. */
  id: string;
  name: string;
  /** The account Steam signed in with last (loginusers.vdf MostRecent). */
  mostRecent: boolean;
}

export interface SteamSyncResult {
  userId: string;
  added: number;
  updated: number;
  removed: number;
  /** Artwork files copied into Steam's grid folder. */
  artwork: number;
  /** Timestamped copy of shortcuts.vdf taken before writing (null when there was no file yet). */
  backup: string | null;
  at: string;
}

export interface SteamStatus {
  installed: boolean;
  steamPath: string | null;
  users: SteamUser[];
  /** User the counts refer to: the requested one, else the most recent. */
  userId: string | null;
  running: boolean;
  /** OmniPC shortcuts in the user's shortcuts.vdf. */
  shortcutsCount: number;
  /** Game ids that currently have an OmniPC shortcut for this user. */
  gameIds: number[];
  lastSync: SteamSyncResult | null;
  /** What Steam will run: OmniPC's executable and an example of the launch options. */
  launcher: { exe: string; launchOptions: string };
}

export interface SteamSyncOptions {
  userId?: string;
  /** Game ids, or 'all' for the whole library (also removes shortcuts of games no longer in it). */
  gameIds?: number[] | 'all';
  systems?: string[];
}
