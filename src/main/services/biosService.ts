// BIOS & firmware manager. OmniDeck organises and validates files the user
// supplies; it never downloads BIOS, firmware or keys.

import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { BiosStatus } from '@shared/models';
import { SYSTEMS, getSystem, type SystemId } from '@shared/systems';
import type { AdapterRegistry } from '../emulators/registry';
import type { AppPaths } from '../core/paths';
import type { OpsRepo } from '../database/opsRepo';
import { OmniFailure } from '../core/errors';
import { inspectPs2Bios } from '../bios/validators';

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
    // Systems whose adapters are planned: show where files go and what is there.
    for (const sys of SYSTEMS) {
      if (covered.has(sys.id) || sys.bios === 'none') continue;
      const dir = this.paths.systemBiosDir(sys.id);
      const files: BiosStatus['files'] = [];
      if (existsSync(dir)) {
        for (const f of await readdir(dir)) {
          const st = await stat(join(dir, f)).catch(() => null);
          if (st?.isFile()) files.push({ path: join(dir, f), sizeBytes: st.size, valid: st.size > 0, description: 'Present (not validated: emulator support is planned)' });
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
        note: `${sys.biosNote} (The ${sys.emulators[0]} integration is planned; OmniDeck currently only records these files.)`,
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
}
