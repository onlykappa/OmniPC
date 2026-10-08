import { useState } from 'react';
import type { DevAdapterReport } from '@shared/ipc';
import { api } from '../lib/api';
import { useLoad } from '../lib/hooks';
import { Button, Panel, Spinner } from '../components/ui';

export function DevPage() {
  const { data: emus } = useLoad(() => api('emulators.list'), []);
  const { data: rules } = useLoad(() => api('doctor.rules'), []);
  const [id, setId] = useState('pcsx2');
  const [report, setReport] = useState<DevAdapterReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState('');
  return (
    <div className="page">
      <div className="page-head"><div><h1>Developer diagnostics</h1><p>Adapter internals: manifest, resolved paths, version sources, raw checks, launch command and latest log.</p></div></div>
      <Panel>
        <div className="row">
          <select value={id} onChange={(e) => setId(e.target.value)} style={{ maxWidth: 260 }}>{(emus ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}{e.implemented ? '' : ' (planned)'}</option>)}</select>
          <Button variant="primary" busy={busy} onClick={async () => { setBusy(true); try { setReport(await api('dev.adapterReport', id)); } finally { setBusy(false); } }}>Inspect adapter</Button>
          <Button onClick={async () => setLog(await api('app.logTail', 300))}>OmniDeck log tail</Button>
        </div>
      </Panel>
      {busy && <Spinner />}
      {report && (
        <div className="grid cols-2">
          <Panel title="Paths"><pre>{JSON.stringify(report.paths, null, 2)}</pre></Panel>
          <Panel title="Versions"><pre>{JSON.stringify({ installed: report.installedVersion, latest: report.latestVersion }, null, 2)}</pre></Panel>
          <Panel title="Launch command (sample)"><pre>{JSON.stringify(report.sampleLaunchCommand, null, 2)}</pre></Panel>
          <Panel title="Raw health checks"><pre>{JSON.stringify(report.healthChecks, null, 2)}</pre></Panel>
          <Panel title="Latest log">{report.latestLog ? <><code className="small">{report.latestLog.path}</code><pre>{report.latestLog.excerpt}</pre></> : <p className="muted">No log yet.</p>}</Panel>
          <Panel title="Manifest"><pre>{JSON.stringify(report.manifest, null, 2)}</pre></Panel>
        </div>
      )}
      {log && <Panel title="OmniDeck log"><pre>{log}</pre></Panel>}
      <Panel title="Diagnostic knowledge base">
        {(rules ?? []).map((f) => <div key={f.emulatorId} className="col"><strong>{f.emulatorId === '*' ? 'Generic' : f.emulatorId}</strong>{f.rules.map((r) => <div key={r.id} className="small"><code>{r.id}</code> — {r.title} ({r.severity}){r.fix ? ` → ${r.fix}` : ''}</div>)}</div>)}
      </Panel>
    </div>
  );
}
