// Adapter registry. The only place that knows which adapter class serves which
// emulator id. Everything else asks the registry.

import type { EmulatorManifest } from '@shared/models';
import { getSystem, type SystemId } from '@shared/systems';
import type { AppPaths } from '../core/paths';
import type { EmulatorAdapter } from './adapter';
import { Pcsx2Adapter } from './pcsx2/adapter';
import { DolphinAdapter } from './dolphin/adapter';
import { PlannedAdapter } from './planned';
import retroarch from './manifests/retroarch.json';
import duckstation from './manifests/duckstation.json';
import rpcs3 from './manifests/rpcs3.json';
import ppsspp from './manifests/ppsspp.json';
import cemu from './manifests/cemu.json';
import melonds from './manifests/melonds.json';
import xenia from './manifests/xenia.json';
import xemu from './manifests/xemu.json';
import kyty from './manifests/kyty.json';

const PLANNED = [retroarch, duckstation, rpcs3, ppsspp, cemu, melonds, xenia, xemu, kyty] as unknown as EmulatorManifest[];

export function validateManifest(m: EmulatorManifest): string[] {
  const errors: string[] = [];
  if (!/^[a-z0-9-]+$/.test(m.id)) errors.push('id must be lowercase alphanumeric');
  if (!m.name) errors.push('name is required');
  if (!Array.isArray(m.systems) || m.systems.length === 0) errors.push('systems must be a non-empty array');
  for (const s of m.systems ?? []) if (!getSystem(s)) errors.push(`unknown system ${s}`);
  if (!m.executable) errors.push('executable is required');
  if (m.implemented) {
    if (m.download.kind === 'none') errors.push('implemented adapters need a download source');
    if (!m.download.allowedHosts.length) errors.push('download.allowedHosts must list trusted hosts');
    for (const h of m.download.allowedHosts) if (/[/:]/.test(h)) errors.push(`allowedHosts entry "${h}" must be a bare host name`);
    if (m.download.kind === 'versioned-url' && (!/^[\w.-]+\/[\w.-]+$/.test(m.download.repo ?? '') || !/^https:\/\//.test(m.download.urlTemplate ?? ''))) errors.push('versioned-url needs repo and an https urlTemplate');
    if (m.download.kind === 'github-release' && !/^[\w.-]+\/[\w.-]+$/.test(m.download.repo ?? '')) errors.push('github-release needs repo "owner/name"');
    for (const p of m.download.assetPatterns ?? []) {
      try { new RegExp(p); } catch { errors.push(`invalid asset pattern ${p}`); }
    }
  }
  for (const c of m.configFiles ?? []) if (!/^\{(data|app|saves)\}/.test(c.path)) errors.push(`config path ${c.path} must start with a placeholder`);
  return errors;
}

export class AdapterRegistry {
  private adapters = new Map<string, EmulatorAdapter>();

  constructor(paths: AppPaths, extra: EmulatorAdapter[] = []) {
    const all: EmulatorAdapter[] = [new Pcsx2Adapter(paths), new DolphinAdapter(paths), ...PLANNED.map((m) => new PlannedAdapter(m, paths)), ...extra];
    for (const a of all) {
      const errors = validateManifest(a.manifest);
      if (errors.length) throw new Error(`Invalid manifest for ${a.manifest.id}: ${errors.join('; ')}`);
      this.adapters.set(a.manifest.id, a);
    }
  }

  get(id: string): EmulatorAdapter | undefined {
    return this.adapters.get(id);
  }

  require(id: string): EmulatorAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`Unknown emulator ${id}`);
    return a;
  }

  all(): EmulatorAdapter[] {
    return [...this.adapters.values()];
  }

  implemented(): EmulatorAdapter[] {
    return this.all().filter((a) => a.manifest.implemented);
  }

  /** Emulators that can run a system, in the system's preference order. */
  forSystem(systemId: SystemId): EmulatorAdapter[] {
    const sys = getSystem(systemId);
    const order = sys?.emulators ?? [];
    return this.all().filter((a) => a.manifest.systems.includes(systemId) || order.includes(a.manifest.id)).sort((a, b) => order.indexOf(a.manifest.id) - order.indexOf(b.manifest.id));
  }
}
