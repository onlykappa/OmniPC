// Client ("copy from another PC") side types shared by main and renderer.
// The wire protocol itself lives in ./share.ts.

import type { ShareCatalog } from './share';

/** The catalog of a paired PC, plus what this PC already has. */
export interface ShareCatalogView {
  catalog: ShareCatalog;
  have: {
    /** Game item id -> already in this PC's library (same system + serial, or same title). */
    games: Record<string, boolean>;
    /** BIOS item id -> every file already in this PC's BIOS folder (same name and size). */
    bios: Record<string, boolean>;
    /** Saves item id -> size of this PC's saves for that emulator (null = none). */
    saves: Record<string, number | null>;
  };
}

export interface CopyEntry {
  /** Item label (game title, BIOS label, emulator name, "Setup"). */
  item: string;
  /** File path inside the item, when the entry is about one file. */
  file?: string;
  /** Where the copy was saved when it was renamed. */
  savedAs?: string;
  reason?: string;
}

export interface SetupImportResult {
  settingsApplied: string[];
  emulatorSettingsApplied: string[];
  installsQueued: { emulatorId: string; jobId: string }[];
  controllerProfileApplied: boolean;
  profilesMatched: number;
  profilesUnmatched: number;
  /** Database backup made before anything was applied. */
  backupPath: string | null;
  notes: string[];
}

export interface CopySummary {
  from: string;
  copied: CopyEntry[];
  skipped: CopyEntry[];
  renamed: CopyEntry[];
  failed: CopyEntry[];
  bytesCopied: number;
  libraryPathAdded: string | null;
  setup: SetupImportResult | null;
}
