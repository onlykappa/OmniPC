// Import existing setups: standalone emulator installs and EmuDeck (Windows
// edition). Imports always copy; the original setup is never modified.

import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SetupImportCandidate } from '@shared/models';
import type { AdapterRegistry } from '../emulators/registry';
import type { EmulatorManager } from '../services/emulatorManager';
import type { LibraryRepo } from '../database/libraryRepo';
import type { OpsRepo } from '../database/opsRepo';
import type { BiosService } from '../services/biosService';
import type { AppPaths } from '../core/paths';
import { inspectPs2Bios } from '../bios/validators';
import { OmniFailure } from '../core/errors';
import { loadIni } from '../config/iniFile';

/** Reads $emulationPath from EmuDeck's settings.ps1 (a PowerShell assignment, parsed as text, never executed). */
export function parseEmuDeckSettings(text: string): { emulationPath: string | null } {
  const m = /^\s*\$emulationPath\s*=\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(text);
  return { emulationPath: m ? m[1].trim() : null };
}

async function copyTree(from: string, to: string, onlyMissing = true): Promise<number> {
  let n = 0;
  for (const e of await readdir(from, { withFileTypes: true }).catch(() => [])) {
    const s = join(from, e.name);
    const d = join(to, e.name);
    if (e.isDirectory()) n += await copyTree(s, d, onlyMissing);
    else if (e.isFile()) {
      if (onlyMissing && existsSync(d)) continue;
      await mkdir(to, { recursive: true });
      await copyFile(s, d);
      n++;
    }
  }
  return n;
}

export class ImportService {
  private cache = new Map<string, SetupImportCandidate>();

  constructor(private readonly registry: AdapterRegistry, private readonly emulators: EmulatorManager, private readonly library: LibraryRepo, private readonly ops: OpsRepo, private readonly bios: BiosService, private readonly paths: AppPaths) {}

  async detect(): Promise<SetupImportCandidate[]> {
    const out: SetupImportCandidate[] = [];
    for (const a of this.registry.implemented()) out.push(...(await a.detectExistingSetups().catch(() => [])));
    const emu = await this.detectEmuDeck();
    if (emu) out.push(emu);
    this.cache = new Map(out.map((c) => [c.id, c]));
    return out;
  }

  private async detectEmuDeck(): Promise<SetupImportCandidate | null> {
    const appdata = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    const root = join(appdata, 'EmuDeck');
    const settingsFile = join(root, 'settings.ps1');
    if (!existsSync(settingsFile)) return null;
    const { emulationPath } = parseEmuDeckSettings(await readFile(settingsFile, 'utf8'));
    const roms = emulationPath ? join(emulationPath, 'roms') : null;
    const biosDir = emulationPath ? join(emulationPath, 'bios') : null;
    const pcsx2Dir = join(root, 'Emulators', 'PCSX2-Qt');
    const dolphinUser = join(root, 'Emulators', 'Dolphin-x64', 'User');
    return {
      id: 'emudeck',
      source: 'emudeck',
      label: 'EmuDeck (Windows) installation',
      path: root,
      details: [
        `Emulation folder: ${emulationPath ?? 'not found in settings.ps1'}`,
        `ROMs: ${roms && existsSync(roms) ? roms : 'not found'}`,
        `BIOS: ${biosDir && existsSync(biosDir) ? biosDir : 'not found'}`,
        `PCSX2 data: ${existsSync(pcsx2Dir) ? pcsx2Dir : 'not installed'}`,
        `Dolphin data: ${existsSync(dolphinUser) ? dolphinUser : 'not installed'}`,
        'OmniPC copies what you select; your EmuDeck setup is not modified.',
      ],
      importable: { settings: false, saves: existsSync(pcsx2Dir) || existsSync(dolphinUser), bios: !!biosDir && existsSync(biosDir), romPaths: !!roms && existsSync(roms), useInstallation: false },
      romPaths: roms && existsSync(roms) ? [roms] : [],
    };
  }

  async apply(candidateId: string, what: { settings: boolean; saves: boolean; bios: boolean; romPaths: boolean; useInstallation: boolean }): Promise<{ summary: string[] }> {
    const c = this.cache.get(candidateId) ?? (await this.detect()).find((x) => x.id === candidateId);
    if (!c) throw new OmniFailure({ code: 'IMPORT_NOT_FOUND', whatHappened: 'That setup is no longer detected.' });
    const summary: string[] = [];
    if (what.romPaths) for (const p of c.romPaths) {
      this.library.addPath(p, null, null);
      summary.push(`Added game folder ${p} (scan the library to import games)`);
    }
    if (what.bios) summary.push(...(await this.importBios(c)));
    if (what.saves) summary.push(...(await this.importSaves(c)));
    if (what.settings) summary.push(...(await this.importSettings(c)));
    if (what.useInstallation && c.importable.useInstallation) {
      const emuId = c.source;
      const a = this.registry.require(emuId);
      const exe = await a.findExecutable(c.path);
      if (exe) {
        await this.emulators.useExisting(emuId, exe);
        summary.push(`${a.manifest.name}: using existing installation ${exe}`);
      }
    }
    this.ops.addChange('import', c.source, `Imported from ${c.label}: ${summary.length} item(s)`);
    return { summary };
  }

  private async importBios(c: SetupImportCandidate): Promise<string[]> {
    const out: string[] = [];
    if (c.biosDirs?.length) {
      for (const { dir, systemId } of c.biosDirs) {
        for (const f of existsSync(dir) ? await walkFiles(dir, 1) : []) {
          await this.bios.import(systemId as never, f).then(() => out.push(`BIOS imported for ${systemId}: ${f}`)).catch((e) => out.push(`Skipped ${f}: ${(e as Error).message}`));
        }
      }
      return out.length ? out : ['No BIOS files found to import'];
    }
    const dirs = c.source === 'emudeck' ? [join(c.details.find((d) => d.startsWith('BIOS: '))?.slice(6) ?? '')] : c.source === 'pcsx2' ? [await this.pcsx2BiosDir(c.path)] : [join(c.path, 'GC')];
    for (const dir of dirs) {
      if (!dir || !existsSync(dir)) continue;
      const files = await walkFiles(dir, 3);
      for (const f of files) {
        const st = await stat(f);
        if (st.size >= 2 * 1024 * 1024 && st.size <= 16 * 1024 * 1024 && (await inspectPs2Bios(f)).valid) {
          await this.bios.import('ps2', f).then(() => out.push(`PS2 BIOS imported: ${f}`)).catch((e) => out.push(`Skipped ${f}: ${(e as Error).message}`));
        } else if (/^ipl\.bin$/i.test(f.split(/[\\/]/).pop() ?? '') && st.size === 2 * 1024 * 1024) {
          await this.bios.import('gc', f).then(() => out.push(`GameCube IPL imported: ${f}`)).catch(() => undefined);
        }
      }
    }
    return out.length ? out : ['No BIOS files found to import'];
  }

  private async pcsx2BiosDir(docs: string): Promise<string> {
    const doc = await loadIni(join(docs, 'inis', 'PCSX2.ini'));
    const v = doc.get('Folders', 'Bios');
    return v ? (/^[a-zA-Z]:|^\//.test(v) ? v : join(docs, v)) : join(docs, 'bios');
  }

  private async importSaves(c: SetupImportCandidate): Promise<string[]> {
    const out: string[] = [];
    const pcsx2 = this.registry.get('pcsx2')!;
    const dolphin = this.registry.get('dolphin')!;
    const pcsx2Mem = pcsx2.saveLocations()[0].path;
    const dolphinGc = join(dolphin.paths().saves, 'GC');
    const dolphinWii = join(dolphin.paths().saves, 'Wii');
    const copies: [string, string, string][] = (c.saveCopies ?? []).map((s) => [s.from, s.to, s.label]);
    if (c.source === 'pcsx2') {
      const doc = await loadIni(join(c.path, 'inis', 'PCSX2.ini'));
      const v = doc.get('Folders', 'MemoryCards');
      copies.push([v ? (/^[a-zA-Z]:|^\//.test(v) ? v : join(c.path, v)) : join(c.path, 'memcards'), pcsx2Mem, 'PCSX2 memory cards']);
    } else if (c.source === 'dolphin') {
      copies.push([join(c.path, 'GC'), dolphinGc, 'Dolphin GameCube saves'], [join(c.path, 'Wii'), dolphinWii, 'Dolphin Wii NAND (saves)']);
    } else if (c.source === 'emudeck') {
      copies.push([join(c.path, 'Emulators', 'PCSX2-Qt', 'memcards'), pcsx2Mem, 'EmuDeck PCSX2 memory cards'], [join(c.path, 'Emulators', 'Dolphin-x64', 'User', 'GC'), dolphinGc, 'EmuDeck Dolphin GameCube saves'], [join(c.path, 'Emulators', 'Dolphin-x64', 'User', 'Wii'), dolphinWii, 'EmuDeck Dolphin Wii NAND']);
    }
    for (const [from, to, label] of copies) {
      if (!existsSync(from)) continue;
      const n = await copyTree(from, to, true);
      out.push(`${label}: ${n} file(s) copied (existing OmniPC files were not overwritten)`);
    }
    return out.length ? out : ['No saves found to import'];
  }

  private async importSettings(c: SetupImportCandidate): Promise<string[]> {
    // Only graphics-level preferences are imported; OmniPC keeps managing paths/controllers.
    if (c.source === 'pcsx2') {
      const doc = await loadIni(join(c.path, 'inis', 'PCSX2.ini'));
      const scale = Number(doc.get('EmuCore/GS', 'upscale_multiplier'));
      const s = this.emulators.settingsFor('pcsx2');
      if (scale >= 1 && scale <= 8) {
        await this.emulators.saveSettings('pcsx2', { ...s, resolutionScale: Math.round(scale) });
        return [`PCSX2 resolution scale ${scale}x imported`];
      }
    }
    if (c.source === 'dolphin') {
      const gfx = await loadIni(join(c.path, 'Config', 'GFX.ini'));
      const ir = Number(gfx.get('Settings', 'InternalResolution'));
      const s = this.emulators.settingsFor('dolphin');
      if (ir >= 1 && ir <= 8) {
        await this.emulators.saveSettings('dolphin', { ...s, resolutionScale: ir });
        return [`Dolphin internal resolution ${ir}x imported`];
      }
    }
    return ['No compatible settings found'];
  }
}

async function walkFiles(dir: string, depth: number): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory() && depth > 0) out.push(...(await walkFiles(p, depth - 1)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}
