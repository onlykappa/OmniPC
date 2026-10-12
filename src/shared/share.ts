// Multi-PC sharing ("Copy from another PC"): the contract between the PC that
// shares (server) and the PC that copies (client). Both sides are OmniPC.
//
// Transport: HTTP on the local network only (private/link-local addresses;
// requests from anywhere else are refused). Discovery: a UDP broadcast.
// Nothing is reachable until the user turns sharing on, and every request
// except /v1/info and the pairing requests needs a paired device's token.
//
//   UDP  SHARE_DISCOVERY_PORT   client broadcasts DiscoveryProbe, servers answer DiscoveryAnnounce
//   GET  /v1/info               -> ShareInfo (no auth)
//   POST /v1/pair/request       PairRequest -> { requestId } (server shows a 6-digit code on screen)
//   POST /v1/pair/confirm       PairConfirm -> PairResult (token, once per device)
//   GET  /v1/catalog            -> ShareCatalog                      (auth)
//   GET  /v1/file?item=&path=   -> file bytes, supports Range          (auth)
//   GET  /v1/hash?item=&path=   -> { sha256, size }                    (auth)
//   GET  /v1/saves?emulatorId=  -> OmniPC save backup ZIP (made now)   (auth)
//   GET  /v1/setup              -> SetupExport                         (auth)
//   Authorization: Bearer <token>

import type { AppSettings, EmulatorSettings, GameProfile, UniversalControllerProfile } from './models';

export const SHARE_PROTOCOL_VERSION = 1;
export const SHARE_DISCOVERY_PORT = 47631;
export const SHARE_DEFAULT_PORT = 47632;

export interface DiscoveryProbe { kind: 'omnipc-probe'; protocol: number; deviceId: string }
export interface DiscoveryAnnounce { kind: 'omnipc-announce'; protocol: number; deviceId: string; name: string; port: number; version: string }

export interface ShareInfo {
  protocol: number;
  deviceId: string;
  /** Computer name, shown to the other PC. */
  name: string;
  version: string;
  /** Whether this PC currently accepts pairing requests. */
  pairingOpen: boolean;
}

export interface PairRequest { deviceId: string; name: string }
export interface PairConfirm { requestId: string; code: string }
export interface PairResult { token: string; server: ShareInfo }

/** A paired device as the sharing PC lists it (token never shown). */
export interface PairedDevice { deviceId: string; name: string; pairedAt: string; lastSeenAt: string | null }

/** A pairing request waiting for the user on the sharing PC. */
export interface PendingPair { requestId: string; deviceId: string; name: string; code: string; expiresAt: string }

export interface ShareFile {
  /** Path relative to the item's root, '/' separators (no '..', no drive letters). */
  path: string;
  size: number;
  mtimeMs: number;
}

export type ShareItemKind = 'game' | 'bios' | 'saves' | 'setup';

export interface ShareGameItem {
  kind: 'game';
  /** Opaque item id for /v1/file and /v1/hash. */
  id: string;
  title: string;
  systemId: string;
  region: string | null;
  serial: string | null;
  /** Suggested folder under the client's library root, e.g. "PS2" or "PS2/Final Fantasy X". */
  folder: string;
  files: ShareFile[];
  sizeBytes: number;
  /** Base64 JPEG thumbnail of the cover (small), when the sharing PC has one. */
  coverThumb: string | null;
}

export interface ShareBiosItem {
  kind: 'bios';
  id: string;
  systemId: string;
  /** e.g. "PlayStation 2 BIOS", "Switch keys", "PS3 firmware". */
  label: string;
  category: 'bios' | 'firmware' | 'keys';
  files: ShareFile[];
  sizeBytes: number;
}

export interface ShareSavesItem {
  kind: 'saves';
  id: string;
  emulatorId: string;
  emulatorName: string;
  fileCount: number;
  sizeBytes: number;
  lastModified: string | null;
}

export interface ShareCatalog {
  server: ShareInfo;
  games: ShareGameItem[];
  bios: ShareBiosItem[];
  saves: ShareSavesItem[];
  /** Summary of what "Copy setup" would bring over. */
  setup: { emulators: { id: string; name: string; version: string | null }[]; perGameProfiles: number; hasControllerProfile: boolean };
}

/**
 * Everything "Copy setup" applies. Secrets are never included: no
 * RetroAchievements token, API keys, Steam data or machine-specific paths.
 */
export interface SetupExport {
  protocol: number;
  exportedAt: string;
  from: ShareInfo;
  /** AppSettings minus secrets and machine-specific values (paths, window state, device ids). */
  settings: Partial<AppSettings>;
  emulators: { id: string; installed: boolean; settings: EmulatorSettings }[];
  controllerProfile: UniversalControllerProfile | null;
  /** Per-game profiles keyed by game identity (not database id). */
  profiles: { systemId: string; title: string; serial: string | null; profile: Omit<GameProfile, 'gameId'> }[];
}

/** What the client chose to copy. */
export interface CopySelection {
  gameIds: string[];
  biosIds: string[];
  savesIds: string[];
  setup: boolean;
  /** Library folder the games go into (created if needed; added to the library). */
  gamesDestination: string | null;
}

/** State of the "share this PC" side, for the UI. */
export interface ShareServerStatus {
  enabled: boolean;
  port: number | null;
  name: string;
  deviceId: string;
  addresses: string[];
  pairingOpen: boolean;
  pending: PendingPair[];
  paired: PairedDevice[];
  /** What is shared (the user can narrow it). */
  sharing: { games: boolean; bios: boolean; saves: boolean; setup: boolean };
  error: string | null;
}

/** A PC found on the network, for the client side UI. */
export interface DiscoveredPc { deviceId: string; name: string; address: string; port: number; version: string; paired: boolean }

/** True for addresses on the local network (RFC 1918, link-local, loopback, IPv6 ULA/link-local). */
export function isLocalAddress(addr: string): boolean {
  const a = addr.replace(/^::ffff:/i, '');
  if (/^127\./.test(a) || a === '::1') return true;
  if (/^10\./.test(a) || /^192\.168\./.test(a) || /^169\.254\./.test(a)) return true;
  const m = /^172\.(\d+)\./.exec(a);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(a) || /^fe80:/i.test(a)) return true;
  return false;
}
