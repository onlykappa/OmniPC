// Registers a game's updates and DLC with Ryujinx before launch.
//
// Ryujinx keeps per-game choices in <data>/games/<titleid>/updates.json
// ({ "selected": path, "paths": [...] }) and dlc.json
// ([{ "path": nsp, "dlc_nca_list": [{ "path": "/<nca>", "title_id": n, "is_enabled": b }] }]),
// read when a game starts (NcaExtensions.GetUpdateData,
// PartitionFileSystemExtensions.TryLoad). Its own "autoload" folders are only
// scanned when the game list is shown, not when a game is launched directly,
// so OmniPC writes these files itself. Choices the user made in Ryujinx are kept.

import { existsSync } from 'node:fs';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

export interface ExtraContent { path: string; kind: 'update' | 'dlc' }

/** Version number from "[v131072]" in an update's file name. */
function fileVersion(path: string): number | null {
  const m = /\[v(\d+)\]/i.exec(basename(path));
  return m ? Number(m[1]) : null;
}

/** The newest update: highest [vNNN] in the name, else the most recently modified file. */
export async function newestUpdate(paths: string[]): Promise<string | null> {
  const scored = await Promise.all(paths.map(async (p) => ({ p, v: fileVersion(p), t: (await stat(p).catch(() => null))?.mtimeMs ?? 0 })));
  scored.sort((a, b) => (b.v ?? -1) - (a.v ?? -1) || b.t - a.t);
  return scored[0]?.p ?? null;
}

/** File names inside an NSP (PFS0) header. */
export async function nspEntries(path: string): Promise<string[]> {
  const fh = await open(path, 'r');
  try {
    const h = Buffer.alloc(16);
    await fh.read(h, 0, 16, 0);
    if (h.toString('latin1', 0, 4) !== 'PFS0') return [];
    const count = h.readUInt32LE(4);
    const strSize = h.readUInt32LE(8);
    if (!count || count > 4096 || strSize > 1 << 20) return [];
    const table = Buffer.alloc(strSize);
    await fh.read(table, 0, strSize, 16 + count * 24);
    return table.toString('latin1').split('\0').filter(Boolean);
  } finally {
    await fh.close();
  }
}

/**
 * The DLC content inside an NSP: its title ID (from the ticket name) and its
 * single data NCA. Returns null when the NSP holds several DLCs or no ticket,
 * which the user can still add in Ryujinx (Manage DLC).
 */
export async function dlcInNsp(path: string): Promise<{ titleId: bigint; nca: string } | null> {
  if (!/\.nsp$/i.test(path)) return null;
  const names = await nspEntries(path).catch(() => []);
  const tickets = [...new Set(names.map((n) => /^(0100[0-9a-f]{12})[0-9a-f]{16}\.tik$/i.exec(n)?.[1]?.toLowerCase()).filter(Boolean))] as string[];
  const ncas = names.filter((n) => /\.nca$/i.test(n) && !/\.cnmt\.nca$/i.test(n));
  if (tickets.length !== 1 || ncas.length !== 1) return null;
  return { titleId: BigInt(`0x${tickets[0]}`), nca: ncas[0] };
}

interface DlcContainer { path: string; dlc_nca_list: { path: string; title_id: string; is_enabled: boolean }[] }

/** Reads dlc.json keeping 64-bit title IDs exact (JSON numbers above 2^53 would be rounded). */
function parseDlcJson(text: string): DlcContainer[] {
  const quoted = text.replace(/("title_id"\s*:\s*)(\d+)/g, '$1"$2"');
  const v = JSON.parse(quoted) as DlcContainer[];
  return Array.isArray(v) ? v : [];
}

function stringifyDlcJson(list: DlcContainer[]): string {
  return JSON.stringify(list, null, 2).replace(/("title_id"\s*:\s*)"(\d+)"/g, '$1$2');
}

export async function registerContent(dataDir: string, baseTitleId: string | null, extra: ExtraContent[] | undefined): Promise<string[]> {
  const notes: string[] = [];
  if (!baseTitleId || !/^0100[0-9a-f]{12}$/i.test(baseTitleId) || !extra?.length) return notes;
  const dir = join(dataDir, 'games', baseTitleId.toLowerCase());
  await mkdir(dir, { recursive: true });

  const updates = extra.filter((e) => e.kind === 'update' && existsSync(e.path)).map((e) => e.path);
  if (updates.length) {
    const file = join(dir, 'updates.json');
    const cur = await readFile(file, 'utf8').then((t) => JSON.parse(t) as { selected?: string; paths?: string[] }).catch(() => null);
    const paths = [...new Set([...(cur?.paths ?? []).filter((p) => existsSync(p)), ...updates])];
    // Keep an update the user picked in Ryujinx that OmniPC does not know about; otherwise use the newest.
    const userPick = cur?.selected && existsSync(cur.selected) && !updates.includes(cur.selected) ? cur.selected : null;
    const selected = userPick ?? (await newestUpdate(updates)) ?? '';
    await writeFile(file, JSON.stringify({ selected, paths }, null, 2));
    notes.push(`Update: ${basename(selected)}`);
  }

  const dlcs = extra.filter((e) => e.kind === 'dlc' && existsSync(e.path));
  if (dlcs.length) {
    const file = join(dir, 'dlc.json');
    let list = await readFile(file, 'utf8').then(parseDlcJson).catch(() => [] as DlcContainer[]);
    list = list.filter((c) => existsSync(c.path));
    let added = 0;
    for (const d of dlcs) {
      if (list.some((c) => c.path === d.path)) continue;
      const info = await dlcInNsp(d.path).catch(() => null);
      if (!info) {
        notes.push(`Add ${basename(d.path)} in Ryujinx (Manage DLC); OmniPC could not read it.`);
        continue;
      }
      list.push({ path: d.path, dlc_nca_list: [{ path: `/${info.nca}`, title_id: info.titleId.toString(), is_enabled: true }] });
      added++;
    }
    await writeFile(file, stringifyDlcJson(list));
    if (added) notes.push(`${added} DLC enabled`);
  }
  return notes;
}
