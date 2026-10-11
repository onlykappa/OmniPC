// BIOS & firmware manager. OmniPC organises and validates files the user
// supplies; it never downloads BIOS, firmware or keys.

import { existsSync, statSync } from 'node:fs';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { BiosScanFound, BiosStatus } from '@shared/models';
import { SYSTEMS, getSystem, type SystemId } from '@shared/systems';
import type { AdapterRegistry } from '../emulators/registry';
import type { AppPaths } from '../core/paths';
import type { OpsRepo } from '../database/opsRepo';
import { OmniFailure } from '../core/errors';
import { inspectPs2Bios } from '../bios/validators';
import { identifyBiosFile, scanForBios, type BiosCandidate } from '../bios/scan';

export class BiosService {
  constructor(private readonly registry: AdapterRegistry, private readonly paths: AppPaths, private readonly ops: OpsRepo) {}

  async status(): Promise<BiosStatus[]> {
    const out: BiosStatus[] = [];
    const covered = new Set<string>();
    for (const a of this.registry.implemented()) {
      for (const s of await a.biosStatus()) {
        out.push(s);
        covered.add(s.systemId);
      }
    }
    // Systems no adapter reports on: show where files go and what is there.
    for (const sys of SYSTEMS) {
      if (covered.has(sys.id) || sys.bios === 'none') continue;
      const implemented = !!this.registry.get(sys.emulators[0])?.manifest.implemented;
      const dir = this.paths.systemBiosDir(sys.id);
      const files: BiosStatus['files'] = [];
      if (existsSync(dir)) {
        for (const f of await readdir(dir)) {
          const st = await stat(join(dir, f)).catch(() => null);
          if (st?.isFile()) files.push({ path: join(dir, f), sizeBytes: st.size, valid: st.size > 0, description: implemented ? 'Present (not validated)' : 'Present (not validated: emulator support is planned)' });
        }
      }
      out.push({
        systemId: sys.id,
        systemName: sys.name,
        label: sys.bios === 'firmware' ? `${sys.name} firmware / keys` : `${sys.name} BIOS`,
        required: sys.bios === 'required' || sys.bios === 'firmware',
        requirementKind: sys.bios === 'firmware' ? 'firmware' : 'bios',
        emulatorId: sys.emulators[0],
        expectedLocation: dir,
        status: files.length ? 'found' : sys.bios === 'optional' ? 'not_applicable' : 'missing',
        files,
        note: implemented ? sys.biosNote : `${sys.biosNote} (The ${sys.emulators[0]} integration is planned; OmniPC currently only records these files.)`,
      });
    }
    return out;
  }

  /** Validates and copies a user-supplied BIOS file into the managed BIOS folder. */
  async import(systemId: SystemId, filePath: string): Promise<BiosStatus> {
    const sys = getSystem(systemId);
    if (!sys) throw new OmniFailure({ code: 'UNKNOWN_SYSTEM', whatHappened: `Unknown system ${systemId}` });
    const st = await stat(filePath).catch(() => null);
    if (!st?.isFile()) throw new OmniFailure({ code: 'BIOS_NOT_FILE', whatHappened: `${filePath} is not a readable file.` });
    let description = 'Imported';
    if (systemId === 'ps2') {
      const info = await inspectPs2Bios(filePath);
      if (!info.valid) throw new OmniFailure({ code: 'BIOS_INVALID', whatHappened: 'That file is not a valid PlayStation 2 BIOS.', detected: [info.description], userAction: ['Choose the BIOS image dumped from your PS2 (usually a 4 MB .bin file).'] });
      description = info.description;
    }
    if (systemId === 'ps1' && st.size !== 512 * 1024) throw new OmniFailure({ code: 'BIOS_INVALID', whatHappened: 'A PlayStation BIOS must be exactly 512 KB.', detected: [`File size ${st.size} bytes`], userAction: ['Choose the BIOS image dumped from your PS1 (e.g. SCPH-1001.bin).'] });
    if (systemId === 'gc' && st.size !== 2 * 1024 * 1024) throw new OmniFailure({ code: 'BIOS_INVALID', whatHappened: 'A GameCube IPL must be exactly 2 MB.', detected: [`File size ${st.size} bytes`] });
    const dir = this.paths.systemBiosDir(systemId);
    await mkdir(dir, { recursive: true });
    let destName = systemId === 'gc' ? 'IPL.bin' : basename(filePath);
    let dest = join(dir, destName);
    if (existsSync(dest)) {
      const existing = await stat(dest);
      if (existing.size !== st.size) {
        destName = `${basename(filePath, extname(filePath))}-${Date.now()}${extname(filePath)}`;
        dest = join(dir, destName);
      }
    }
    await copyFile(filePath, dest);
    this.ops.addChange('bios.imported', systemId, `${sys.name} BIOS imported: ${destName} (${description})`);
    const all = await this.status();
    return all.find((b) => b.systemId === systemId)!;
  }

  /** Where a found file would be copied, and whether an identical-size copy is already there. */
  private target(c: Pick<BiosCandidate, 'systemId' | 'destName' | 'sizeBytes'>): { dest: string; alreadyImported: boolean } {
    const dest = join(this.paths.systemBiosDir(c.systemId), c.destName);
    let alreadyImported = false;
    try {
      alreadyImported = existsSync(dest) && statSync(dest).size === c.sizeBytes;
    } catch {
      /* treat as not imported */
    }
    return { dest, alreadyImported };
  }

  /**
   * Scans folders for BIOS, firmware and key files the user already owns
   * (like the game-folder scan). OmniPC's own BIOS folder is skipped.
   */
  async scan(roots: string[], signal?: AbortSignal): Promise<BiosScanFound> {
    const own = this.paths.bios.toLowerCase();
    const usable = roots.filter((r) => existsSync(r) && !r.toLowerCase().startsWith(own));
    const r = await scanForBios(usable, { signal });
    return {
      roots: usable,
      filesSeen: r.filesSeen,
      errors: r.errors.slice(0, 20),
      found: r.candidates.filter((c) => !c.path.toLowerCase().startsWith(own)).map((c) => ({ ...c, ...this.target(c) })),
    };
  }

  /**
   * Copies chosen files into BIOS/<system>. Each file is re-identified first,
   * so only files that really are what the scan said are copied. Originals
   * are never moved or changed; an existing file of a different size is kept
   * and the new one gets a numbered name.
   */
  async importFound(paths: string[]): Promise<{ imported: string[]; skipped: string[] }> {
    const imported: string[] = [];
    const skipped: string[] = [];
    for (const p of paths) {
      const st = await stat(p).catch(() => null);
      const id = st?.isFile() ? await identifyBiosFile(p, st.size).catch(() => null) : null;
      if (!st || !id) { skipped.push(`${p}: not recognised`); continue; }
      if (!id.valid) { skipped.push(`${p}: ${id.detail}`); continue; }
      let { dest, alreadyImported } = this.target({ ...id, sizeBytes: st.size });
      if (alreadyImported) { skipped.push(`${basename(p)}: already in ${dirname(dest)}`); continue; }
      if (existsSync(dest)) dest = join(dirname(dest), `${basename(id.destName, extname(id.destName))}-${Date.now()}${extname(id.destName)}`);
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(p, dest);
      imported.push(`${id.label}: ${basename(dest)}`);
      this.ops.addChange('bios.imported', id.systemId, `${id.label} imported from scan: ${basename(dest)}`);
    }
    return { imported, skipped };
  }
}

