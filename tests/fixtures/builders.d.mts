export function buildIso(opts: { systemId?: string; volumeId?: string; files?: Record<string, string | Buffer>; raw?: boolean; padSectors?: number }): Buffer;
export function ps2Iso(serial?: string, opts?: Record<string, unknown>): Buffer;
export function ps1Bin(serial?: string): Buffer;
export function nintendoHeader(id: string, title: string, wii?: boolean): Buffer;
export function rvz(id: string, title: string, wii?: boolean): Buffer;
export function ps2Bios(romver?: string): Buffer;
export function write(path: string, data: string | Buffer): void;
export function fakeEmulatorScript(): string;
