// "Export Diagnostic Package": app + emulator logs, config files (optional),
// latest health report and system summary. ROMs, BIOS, keys, saves and personal
// documents are never included; paths are redacted.

import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import yazl from 'yazl';
import type { AdapterRegistry } from '../emulators/registry';
import type { AppPaths } from '../core/paths';
import type { OpsRepo } from '../database/opsRepo';
import { redactPaths } from '../diagnostics/logs';
import { expandManifestPath } from '../emulators/adapter';
import { redactAchievementSecrets } from '../achievements/emulatorConfig';

const EXCLUDED_EXT = /\.(iso|bin|chd|cso|rvz|wbfs|gcz|wia|nkit|img|zip|7z|rar|ps2|raw|gci|sav|srm|p2s|sstate|state|keys?|pup|dat|dmp)$/i;

export async function exportDiagnosticPackage(opts: { includeEmulatorLogs: boolean; includeConfigs: boolean; extra: Record<string, unknown> }, d: { paths: AppPaths; registry: AdapterRegistry; ops: OpsRepo }): Promise<{ path: string; files: string[]; excluded: string[] }> {
  await mkdir(d.paths.diagnosticsExports, { recursive: true });
  const dest = join(d.paths.diagnosticsExports, `omnideck-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`);
  const zip = new yazl.ZipFile();
  const files: string[] = [];
  const excluded = ['Game files (ROMs/ISOs)', 'BIOS & firmware', 'Encryption keys', 'Save data, memory cards and save states', 'Personal documents', 'RetroAchievements login tokens'];
  const addText = (name: string, text: string) => {
    zip.addBuffer(Buffer.from(redactPaths(text).text), name);
    files.push(name);
  };
  for (const f of (await readdir(d.paths.logs).catch(() => [])).filter((x) => x.endsWith('.log'))) addText(`omnideck/${f}`, await readFile(join(d.paths.logs, f), 'utf8'));
  const report = d.ops.latestReport();
  if (report) addText('omnideck/latest-health-report.json', JSON.stringify(report, null, 2));
  addText('omnideck/repairs.json', JSON.stringify(d.ops.repairs(200), null, 2));
  addText('omnideck/changes.json', JSON.stringify(d.ops.changes(500), null, 2));
  addText('omnideck/system.json', JSON.stringify(opts.extra, null, 2));
  for (const a of d.registry.implemented()) {
    const p = a.paths();
    if (opts.includeEmulatorLogs) for (const l of a.manifest.logFiles) {
      const path = expandManifestPath(l.path, p, d.paths.bios);
      if (existsSync(path)) addText(`${a.manifest.id}/logs/${basename(path)}`, (await readFile(path, 'utf8')).slice(-2_000_000));
    }
    if (opts.includeConfigs) for (const c of a.manifest.configFiles) {
      const path = expandManifestPath(c.path, p, d.paths.bios);
      // RetroAchievements login tokens are blanked; the OmniPC token itself is never in a file.
      if (existsSync(path) && !EXCLUDED_EXT.test(path)) addText(`${a.manifest.id}/config/${basename(path)}`, redactAchievementSecrets(await readFile(path, 'utf8')));
    }
  }
  addText('README.txt', `OmniPC diagnostic package\nCreated ${new Date().toISOString()}\n\nIncluded: ${files.join(', ')}\n\nNever included: ${excluded.join(', ')}.\nUser folder paths and user name were redacted.\n`);
  await new Promise<void>((resolve, reject) => {
    zip.outputStream.pipe(createWriteStream(dest)).on('close', () => resolve()).on('error', reject);
    zip.end();
  });
  return { path: dest, files, excluded };
}
