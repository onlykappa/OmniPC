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
