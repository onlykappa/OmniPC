export interface CatalogPart {
  id: string; filename: string; url: string; browserUrl: string | null; browserRequired: boolean;
  sizeBytes: number | null; sha256: string | null; volume: string | null;
}
export interface CatalogSource {
  id: string; provider: string; version: string; label: string; format: string;
  archivePassword: string | null; parts: CatalogPart[];
}
export interface CatalogGame {
  id: string; title: string; platform: 'ps4' | 'ps5'; region: string; work: number | null;
  developer: string; publisher: string; releaseDate: string; genres: string[];
  cover: string | null; hero: string | null; screenshots: string[]; description: string;
  sizeGb: number | null; rating: number | null; sources: CatalogSource[];
}
export type CatalogDownloadState = 'downloading' | 'downloaded' | 'failed' | 'interrupted' | 'extracted';
export interface CatalogTransfer {
  id: string; gameId: string; sourceId: string; title: string; status: CatalogDownloadState;
  file: string | null; output: string | null; error: string | null; at: string;
}
export interface DiscoverCard extends Omit<CatalogGame, 'sources' | 'description' | 'screenshots'> {
  sourceCount: number; status: 'not-downloaded' | CatalogDownloadState | 'in-library'; libraryGameId: number | null;
}
export interface DiscoverQuery { search?: string; platform?: 'ps4' | 'ps5' | ''; status?: 'not-downloaded' | 'in-library' | ''; genre?: string; offset?: number; limit?: number }
export interface DiscoverPage { items: DiscoverCard[]; total: number; catalogCount: number; importedAt: string | null; version: string | null; genres: string[]; recoveryNote: string | null }
export interface DiscoverDetail { editions: {id: string; title: string; platform: 'ps4' | 'ps5'; region: string}[]; game: CatalogGame; libraryGameId: number | null; transfers: CatalogTransfer[] }
export interface CatalogSnapshot { version: string; importedAt: string; games: CatalogGame[] }
