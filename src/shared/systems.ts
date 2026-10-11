// Catalog of game systems OmniPC understands. This is pure data shared by the
// main process (library scanning, launch routing) and the renderer (UI).
//
// `extensions` drive library classification. Ambiguous extensions (e.g. .iso,
// .bin, .chd are used by several disc-based systems) are resolved by content
// sniffing in src/main/library/identify.ts and by folder-name hints.

export type SystemId =
  | 'ps1'
  | 'ps2'
  | 'ps3'
  | 'ps4'
  | 'ps5'
  | 'psp'
  | 'gc'
  | 'wii'
  | 'wiiu'
  | 'switch'
  | 'nds'
  | 'xbox'
  | 'x360'
  | 'nes'
  | 'snes'
  | 'n64'
  | 'gb'
  | 'gbc'
  | 'gba'
  | 'genesis'
  | 'arcade';

export type BiosRequirement = 'required' | 'optional' | 'none' | 'firmware';

export interface SystemDefinition {
  id: SystemId;
  name: string;
  shortName: string;
  manufacturer: string;
  /** Release year of the console, used for sorting the Systems page. */
  year: number;
  extensions: string[];
  /** Folder names commonly used for this system; used as a classification hint. */
  folderHints: string[];
  bios: BiosRequirement;
  biosNote: string;
  /** Emulator ids in order of preference. The first implemented+installed one is used. */
  emulators: string[];
  accent: string;
  /** Extensions that are shared with other systems and need content sniffing. */
  ambiguousExtensions?: string[];
  /** Multi-disc capable (affects grouping in the library). */
  multiDisc?: boolean;
  /** Games are folders booted through eboot.bin rather than single image files. */
  folderGames?: boolean;
}

export const SYSTEMS: SystemDefinition[] = [
  {
    id: 'ps1',
    name: 'PlayStation',
    shortName: 'PS1',
    manufacturer: 'Sony',
    year: 1994,
    extensions: ['.cue', '.chd', '.pbp', '.m3u', '.ecm', '.bin', '.iso', '.img'],
    ambiguousExtensions: ['.chd', '.bin', '.iso', '.img', '.cue', '.m3u'],
    folderHints: ['ps1', 'psx', 'playstation', 'playstation1', 'psone'],
    bios: 'required',
    biosNote: 'A PlayStation BIOS dumped from your own console (e.g. SCPH-1001).',
    emulators: ['duckstation'],
    accent: '#8b9bb4',
    multiDisc: true,
  },
  {
    id: 'ps2',
    name: 'PlayStation 2',
    shortName: 'PS2',
    manufacturer: 'Sony',
    year: 2000,
    extensions: ['.iso', '.chd', '.cso', '.zso', '.gz', '.bin', '.cue', '.mdf', '.nrg', '.img', '.elf', '.m3u'],
    ambiguousExtensions: ['.iso', '.chd', '.bin', '.cue', '.img', '.m3u', '.gz'],
    folderHints: ['ps2', 'playstation2', 'playstation 2', 'pcsx2'],
    bios: 'required',
    biosNote: 'A PlayStation 2 BIOS dumped from your own console. PCSX2 cannot boot games without it.',
    emulators: ['pcsx2'],
    accent: '#3d63d6',
    multiDisc: true,
  },
  {
    id: 'ps3',
    name: 'PlayStation 3',
    shortName: 'PS3',
    manufacturer: 'Sony',
    year: 2006,
    extensions: ['.iso', '.bin'],
    ambiguousExtensions: ['.iso', '.bin'],
    folderHints: ['ps3', 'playstation3', 'playstation 3', 'rpcs3'],
    bios: 'firmware',
    biosNote: 'Official PS3 system software (PS3UPDAT.PUP) installed into RPCS3. Obtain it from Sony.',
    // Disc/PSN folders are added through PS3_GAME/USRDIR/EBOOT.BIN.
    folderGames: true,
    emulators: ['rpcs3'],
    accent: '#2b2f3a',
  },
  {
    id: 'ps4',
    name: 'PlayStation 4',
    shortName: 'PS4',
    manufacturer: 'Sony',
    year: 2013,
    // Folder-format games: the library adds <game>/eboot.bin when <game>/sce_sys/param.sfo exists.
    extensions: [],
    folderHints: ['ps4', 'playstation4', 'playstation 4', 'shadps4'],
    bios: 'optional',
    biosNote: 'Optional: PS4 firmware modules (.sprx) and system fonts dumped from your own console. shadPS4 runs many games without them.',
    emulators: ['shadps4'],
    accent: '#00439c',
    folderGames: true,
  },
  {
    id: 'ps5',
    name: 'PlayStation 5',
    shortName: 'PS5',
    manufacturer: 'Sony',
    year: 2020,
    // Folder-format homebrew: <game>/eboot.bin with <game>/sce_sys/param.json.
    extensions: [],
    folderHints: ['ps5', 'playstation5', 'playstation 5', 'kytyps5'],
    bios: 'none',
    biosNote: 'KytyPS5 needs no firmware files. Compatibility is limited and changes between builds.',
    emulators: ['kyty'],
    accent: '#e6e6e6',
    folderGames: true,
  },
  {
    id: 'psp',
    name: 'PlayStation Portable',
    shortName: 'PSP',
    manufacturer: 'Sony',
    year: 2004,
    extensions: ['.iso', '.cso', '.pbp', '.chd', '.elf'],
    ambiguousExtensions: ['.iso', '.cso', '.chd', '.pbp'],
    folderHints: ['psp'],
    bios: 'none',
    biosNote: 'No BIOS required.',
    emulators: ['ppsspp'],
    accent: '#5c6b7a',
  },
  {
    id: 'gc',
    name: 'GameCube',
    shortName: 'GC',
    manufacturer: 'Nintendo',
    year: 2001,
    extensions: ['.iso', '.gcm', '.gcz', '.rvz', '.wia', '.ciso', '.dol', '.elf', '.tgc', '.m3u'],
    ambiguousExtensions: ['.iso', '.gcz', '.rvz', '.wia', '.ciso', '.dol', '.elf', '.m3u'],
    folderHints: ['gc', 'gamecube', 'ngc'],
    bios: 'optional',
    biosNote: 'Optional GameCube IPL (boot ROM). Dolphin runs games without it.',
    emulators: ['dolphin'],
    accent: '#6a4fb3',
    multiDisc: true,
  },
  {
    id: 'wii',
    name: 'Wii',
    shortName: 'Wii',
    manufacturer: 'Nintendo',
    year: 2006,
    extensions: ['.iso', '.wbfs', '.rvz', '.wia', '.gcz', '.ciso', '.wad', '.dol', '.elf'],
    ambiguousExtensions: ['.iso', '.gcz', '.rvz', '.wia', '.ciso', '.dol', '.elf'],
    folderHints: ['wii'],
    bios: 'none',
    biosNote: 'No BIOS required. A Wii NAND backup is optional for system-menu features.',
    emulators: ['dolphin'],
    accent: '#5fb4e6',
  },
  {
    id: 'wiiu',
    name: 'Wii U',
    shortName: 'Wii U',
    manufacturer: 'Nintendo',
    year: 2012,
    extensions: ['.wud', '.wux', '.wua', '.rpx', '.wuhb'],
    folderHints: ['wiiu', 'wii u', 'cemu'],
    bios: 'firmware',
    biosNote: 'Console keys (keys.txt) dumped from your own Wii U for encrypted images.',
    emulators: ['cemu'],
    accent: '#0aa5c9',
  },
  {
    id: 'switch',
    name: 'Nintendo Switch',
    shortName: 'Switch',
    manufacturer: 'Nintendo',
    year: 2017,
    extensions: ['.nsp', '.xci', '.nca', '.nro', '.nso'],
    folderHints: ['switch', 'ns', 'nintendo switch', 'nintendoswitch'],
    bios: 'firmware',
    biosNote: 'prod.keys (and optional title.keys) and the system firmware dumped from your own Switch. OmniPC never downloads keys or firmware.',
    emulators: ['ryujinx'],
    accent: '#e60012',
  },
  {
    id: 'nds',
    name: 'Nintendo DS',
    shortName: 'DS',
    manufacturer: 'Nintendo',
    year: 2004,
    extensions: ['.nds', '.dsi', '.ids', '.srl'],
    folderHints: ['nds', 'ds', 'nintendods'],
    bios: 'optional',
    biosNote: 'Optional DS BIOS/firmware (bios7.bin, bios9.bin, firmware.bin). melonDS can use built-in replacements.',
    emulators: ['melonds'],
    accent: '#c7c7c7',
  },
  {
    id: 'xbox',
    name: 'Xbox',
    shortName: 'Xbox',
    manufacturer: 'Microsoft',
    year: 2001,
    extensions: ['.iso', '.xiso'],
    ambiguousExtensions: ['.iso'],
    folderHints: ['xbox', 'xemu'],
    bios: 'required',
    biosNote: 'MCPX boot ROM, flash BIOS and HDD image from your own console (xemu).',
    emulators: ['xemu'],
    accent: '#3b9a3b',
  },
  {
    id: 'x360',
    name: 'Xbox 360',
    shortName: '360',
    manufacturer: 'Microsoft',
    year: 2005,
    extensions: ['.iso', '.xex', '.zar', '.god'],
    ambiguousExtensions: ['.iso'],
    folderHints: ['xbox360', 'x360', 'xbox 360', 'xenia'],
    bios: 'none',
    biosNote: 'No BIOS required.',
    emulators: ['xenia'],
    accent: '#7ac143',
  },
  {
    id: 'nes',
    name: 'Nintendo Entertainment System',
    shortName: 'NES',
    manufacturer: 'Nintendo',
    year: 1983,
    extensions: ['.nes', '.fds', '.unf', '.unif'],
    folderHints: ['nes', 'famicom'],
    bios: 'none',
    biosNote: 'Famicom Disk System games need disksys.rom.',
    emulators: ['retroarch'],
    accent: '#c0392b',
  },
  {
    id: 'snes',
    name: 'Super Nintendo',
    shortName: 'SNES',
    manufacturer: 'Nintendo',
    year: 1990,
    extensions: ['.sfc', '.smc', '.fig', '.swc', '.bs'],
    folderHints: ['snes', 'superfamicom', 'sfc'],
    bios: 'none',
    biosNote: 'No BIOS required.',
    emulators: ['retroarch'],
    accent: '#7b5ea7',
  },
  {
    id: 'n64',
    name: 'Nintendo 64',
    shortName: 'N64',
    manufacturer: 'Nintendo',
    year: 1996,
    extensions: ['.z64', '.n64', '.v64'],
    folderHints: ['n64', 'nintendo64'],
    bios: 'none',
    biosNote: 'No BIOS required.',
    emulators: ['retroarch'],
    accent: '#2e8b57',
  },
  {
    id: 'gb',
    name: 'Game Boy',
    shortName: 'GB',
    manufacturer: 'Nintendo',
    year: 1989,
    extensions: ['.gb'],
    folderHints: ['gb', 'gameboy'],
    bios: 'none',
    biosNote: 'No BIOS required.',
    emulators: ['retroarch'],
    accent: '#8bac0f',
  },
  {
    id: 'gbc',
    name: 'Game Boy Color',
    shortName: 'GBC',
    manufacturer: 'Nintendo',
    year: 1998,
    extensions: ['.gbc'],
    folderHints: ['gbc', 'gameboycolor'],
    bios: 'none',
    biosNote: 'No BIOS required.',
    emulators: ['retroarch'],
    accent: '#9b59b6',
  },
  {
    id: 'gba',
    name: 'Game Boy Advance',
    shortName: 'GBA',
    manufacturer: 'Nintendo',
    year: 2001,
    extensions: ['.gba'],
    folderHints: ['gba', 'gameboyadvance'],
    bios: 'optional',
    biosNote: 'Optional gba_bios.bin for higher accuracy.',
    emulators: ['retroarch'],
    accent: '#4b3f9e',
  },
  {
    id: 'genesis',
    name: 'Sega Genesis / Mega Drive',
    shortName: 'Genesis',
    manufacturer: 'Sega',
    year: 1988,
    extensions: ['.md', '.gen', '.smd', '.32x'],
    folderHints: ['genesis', 'megadrive', 'md'],
    bios: 'none',
    biosNote: 'No BIOS required.',
    emulators: ['retroarch'],
    accent: '#1f1f1f',
  },
  {
    id: 'arcade',
    name: 'Arcade',
    shortName: 'Arcade',
    manufacturer: 'Various',
    year: 1978,
    extensions: ['.zip', '.7z'],
    folderHints: ['arcade', 'mame', 'fbneo', 'fba'],
    bios: 'optional',
    biosNote: 'Some arcade sets need their BIOS sets (e.g. neogeo.zip) next to the game.',
    emulators: ['retroarch'],
    accent: '#e67e22',
  },
];

const byId = new Map(SYSTEMS.map((s) => [s.id, s]));

export function getSystem(id: string): SystemDefinition | undefined {
  return byId.get(id as SystemId);
}

export function isSystemId(id: string): id is SystemId {
  return byId.has(id as SystemId);
}

/** Systems whose extension list contains `ext` (lowercase, with dot). */
export function systemsForExtension(ext: string): SystemDefinition[] {
  const e = ext.toLowerCase();
  return SYSTEMS.filter((s) => s.extensions.includes(e));
}

/** Systems a folder name hints at, e.g. "D:\\Games\\PS2" -> ps2. */
export function systemsForFolderName(name: string): SystemDefinition[] {
  const n = name.toLowerCase().replace(/[\s_\-.]/g, '');
  return SYSTEMS.filter((s) => s.folderHints.some((h) => h.replace(/[\s_\-.]/g, '') === n));
}
