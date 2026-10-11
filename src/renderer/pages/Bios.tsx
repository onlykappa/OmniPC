import { useState } from 'react';
import type { BiosScanFound } from '@shared/models';
import { getSystem } from '@shared/systems';
import { api } from '../lib/api';
import { useLoad } from '../lib/hooks';
import { useStore } from '../lib/store';
import { Button, Chip, Panel, Spinner } from '../components/ui';
import { bytes } from '../lib/format';

export function BiosPage() {
  const { data, reload } = useLoad(() => api('bios.status'), []);
  const toast = useStore((s) => s.toast);
  if (!data) return <div className="page"><Spinner /></div>;
  return (
    <div className="page">
      <div className="page-head"><div><h1>BIOS & Firmware</h1><p>Some consoles need system files dumped from your own hardware. OmniPC organises and validates them; it never downloads BIOS, firmware or keys.</p></div></div>
      <ScanPanel onImported={reload} />
      <div className="grid cols-2">
        {data.map((b) => (
          <Panel key={`${b.systemId}:${b.label}`} title={b.systemName} actions={<Chip tone={b.status === 'found' ? 'ok' : b.status === 'missing' ? (b.required ? 'bad' : undefined) : b.status === 'invalid' ? 'bad' : undefined}>{b.status === 'found' ? 'Found' : b.status === 'missing' ? 'Missing' : b.status === 'invalid' ? 'Invalid' : 'Optional'}</Chip>}>
            <div className="row"><strong>{b.label}</strong><span className="small faint">{b.required ? (b.requirementKind === 'firmware' ? 'Firmware required' : 'BIOS required') : 'Optional'}</span></div>
            <dl className="kv"><dt>Expected location</dt><dd className="mono small">{b.expectedLocation}</dd><dt>Emulator</dt><dd>{b.emulatorId}</dd></dl>
            {b.files.length > 0 && (
              <div className="list">
                {b.files.map((f) => <div key={f.path} className="list-item"><span className={`dot ${f.valid ? 'ok' : 'bad'}`} /><div className="grow"><div className="mono small">{f.path.split(/[\\/]/).pop()}</div><div className="tiny faint">{f.description} · {bytes(f.sizeBytes)}</div></div></div>)}
              </div>
            )}
            <p className="small muted">{b.note}</p>
            <div className="row">
              <Button onClick={async () => {
                const f = await api('app.pickFile', `Select your ${b.label}`, []);
                if (!f) return;
                try { await api('bios.import', b.systemId, f); toast('success', 'BIOS imported and validated'); reload(); } catch (e) { toast('error', (e as Error).message, (e as { detail?: { detected?: string[] } }).detail?.detected?.[0] ?? ''); }
              }}>Import file…</Button>
              <Button variant="ghost" onClick={() => void api('bios.openFolder', b.systemId)}>Open folder</Button>
            </div>
          </Panel>
        ))}
      </div>
    </div>
  );
}

/** "Scan for BIOS & keys": like the game-folder scan, but for system files. */
function ScanPanel(props: { onImported: () => void }) {
  const toast = useStore((s) => s.toast);
  const [scan, setScan] = useState<BiosScanFound | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'scan' | 'import' | null>(null);
  const run = async (roots: string[] | null) => {
    setBusy('scan');
    try {
      const r = await api('bios.scan', roots);
      setScan(r);
      setPicked(new Set(r.found.filter((f) => f.valid && !f.alreadyImported).map((f) => f.path)));
      if (!r.roots.length) toast('info', 'No folders to scan', 'Add a game folder in the Library first, or choose a folder.');
    } finally { setBusy(null); }
  };
  const importPicked = async () => {
    setBusy('import');
    try {
      const r = await api('bios.importFound', [...picked]);
      toast(r.imported.length ? 'success' : 'info', r.imported.length ? `${r.imported.length} file(s) copied into OmniPC` : 'Nothing new to import', [...r.imported, ...r.skipped].slice(0, 4).join(' · '));
      props.onImported();
      if (scan) await run(scan.roots);
    } finally { setBusy(null); }
  };
  const toggle = (p: string) => setPicked((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  return (
    <Panel title="Scan for BIOS & keys" actions={<div className="row">
      <Button busy={busy === 'scan'} onClick={() => void run(null)} title="Looks through the folders in your library">Scan my game folders</Button>
      <Button onClick={async () => { const d = await api('app.pickFolder', 'Choose a folder with your BIOS, firmware or key files'); if (d) await run([d]); }}>Scan a folder…</Button>
    </div>}>
      <p className="small muted">Finds BIOS, firmware and key files you already have, works out which system each belongs to, checks them, and copies them into the right folder. Your original files are never moved or changed.</p>
      {scan && (scan.found.length === 0
        ? <p className="small">No BIOS, firmware or key files found in {scan.filesSeen} file(s) checked{scan.roots.length ? ` (${scan.roots.join(', ')})` : ''}.</p>
        : <>
          <div className="list">
            {scan.found.map((f) => (
              <label key={f.path} className="list-item" style={{ cursor: f.valid && !f.alreadyImported ? 'pointer' : 'default' }}>
                <input type="checkbox" checked={picked.has(f.path)} disabled={!f.valid || f.alreadyImported} onChange={() => toggle(f.path)} />
                <div className="grow">
                  <div><strong>{f.label}</strong> <span className="small faint">· {getSystem(f.systemId)?.name ?? f.systemId}</span></div>
                  <div className="mono tiny faint">{f.path}</div>
                  <div className="tiny faint">{/\d\s*(KB|MB|bytes)\b/.test(f.detail) ? f.detail : `${f.detail} · ${bytes(f.sizeBytes)}`}</div>
                </div>
                {f.alreadyImported ? <Chip tone="ok">Already imported</Chip> : f.valid ? <Chip tone="info">New</Chip> : <Chip tone="bad">Not valid</Chip>}
              </label>
            ))}
          </div>
          <div className="row"><Button variant="primary" busy={busy === 'import'} disabled={!picked.size} onClick={() => void importPicked()}>Copy {picked.size} into OmniPC</Button><span className="small faint">{scan.filesSeen} file(s) checked</span></div>
        </>)}
    </Panel>
  );
}
