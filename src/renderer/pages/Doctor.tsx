import { useEffect, useState } from 'react';
import type { AiContextPreview, Finding, HealthReport, RepairRecord } from '@shared/models';
import { api, onEvent } from '../lib/api';
import { useLoad } from '../lib/hooks';
import { navigate, useRoute } from '../lib/router';
import { useStore } from '../lib/store';
import { RepairButton, SafetyChip } from '../components/RepairButton';
import { Button, Chip, Empty, HealthRing, Modal, Panel, ProgressBar, SevIcon, Spinner } from '../components/ui';
import { clock } from '../lib/format';

export function DoctorPage() {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [loaded, setLoaded] = useState(false);
  const jobs = useStore((s) => s.jobs);
  const running = Object.values(jobs).find((j) => j.kind === 'doctor.run' && (j.state === 'running' || j.state === 'queued'));
  const { data: changes } = useLoad(() => api('app.changes', 12), [report?.id]);
  const [exporting, setExporting] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const toast = useStore((s) => s.toast);
  useEffect(() => {
    void api('doctor.latest').then((r) => { setReport(r); setLoaded(true); });
    return onEvent('doctor.report', (r) => { if (r.scope !== 'emulator') setReport(r); });
  }, []);
  const issues = (report?.findings ?? []).filter((f) => f.severity === 'problem' || f.severity === 'warning');
  const safeCount = issues.filter((f) => f.repair?.safety === 'safe').length;
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>OmniDoctor</h1><p>Continuously checks your emulation setup, explains problems with evidence, and repairs what it safely can.</p></div>
        <div className="row">
          <Button onClick={() => navigate('/doctor/games')}>Fix games</Button>
          <Button onClick={() => navigate('/doctor/history')}>Repair history</Button>
          <Button onClick={() => navigate('/doctor/ask')}>Ask OmniDoctor</Button>
          <Button busy={exporting} onClick={() => setExporting(true)}>Export diagnostic package</Button>
          <Button variant="primary" busy={!!running} onClick={() => void api('doctor.run', 'full')} autoFocus>Run full health check</Button>
        </div>
      </div>
      {running && <Panel><div className="row"><Spinner /><strong>{running.label}</strong><span className="muted small">{running.message}</span></div><ProgressBar value={running.progress} /></Panel>}
      {!loaded ? <Spinner /> : !report ? (
        <Empty title="No health check yet" action={<Button variant="primary" onClick={() => void api('doctor.run', 'full')}>Run full health check</Button>} />
      ) : (
        <>
          <div className="grid" style={{ gridTemplateColumns: '320px 1fr' }}>
            <Panel>
              <div className="row" style={{ justifyContent: 'center' }}><HealthRing value={report.overall} label="Overall health" /></div>
              <div className="row" style={{ justifyContent: 'center' }}><Chip tone="ok">{report.counts.passed} passed</Chip><Chip tone="warn">{report.counts.warnings} warnings</Chip><Chip tone="bad">{report.counts.problems} problems</Chip></div>
              <div className="small faint" style={{ textAlign: 'center' }}>{report.scope === 'full' ? 'Full' : 'Quick'} check · {clock(report.runAt)} · {report.durationMs} ms</div>
              {safeCount > 0 && <Button variant="primary" busy={repairing} onClick={async () => { setRepairing(true); try { const r = await api('doctor.repairAllSafe'); toast('success', `${r.filter((x) => x.status === 'succeeded').length} safe repair(s) applied`); } finally { setRepairing(false); } }}>Repair all safe issues ({safeCount})</Button>}
            </Panel>
            <Panel title="Categories">
              <div className="grid cols-2" style={{ gap: 12 }}>
                {report.categories.map((c) => (
                  <div key={c.category} className="col" style={{ gap: 6 }}>
                    <div className="row"><span className={`dot ${c.problems ? 'bad' : c.warnings ? 'warn' : 'ok'}`} /><span className="grow">{c.label}</span><strong>{c.score}%</strong></div>
                    <ProgressBar value={c.score / 100} tone={c.problems ? 'bad' : c.warnings ? 'warn' : 'ok'} />
                  </div>
                ))}
              </div>
            </Panel>
          </div>
          <Panel title={issues.length ? `Detected issues (${issues.length})` : 'No issues detected'}>
            {issues.map((f) => <FindingRow key={f.id} f={f} />)}
            {!issues.length && <p className="muted">Everything OmniDoctor checks is healthy.</p>}
          </Panel>
          <div className="grid cols-2">
            <Panel title="Passed checks">
              <div className="list">{report.findings.filter((f) => f.severity === 'pass' || f.severity === 'info').map((f) => <div key={f.id} className="list-item"><SevIcon severity={f.severity} /><span className="grow small">{f.title}</span><span className="tiny faint">{f.category}</span></div>)}</div>
            </Panel>
            <Panel title="Latest activity">
              {(changes ?? []).map((c) => <div key={c.id} className="list-item"><span className="tiny faint" style={{ width: 150, flexShrink: 0 }}>{clock(c.at)}</span><span className="small">{c.summary}</span></div>)}
            </Panel>
          </div>
        </>
      )}
      {exporting && <ExportModal onClose={() => setExporting(false)} />}
    </div>
  );
}

function FindingRow({ f }: { f: Finding }) {
  return (
    <div className="finding">
      <SevIcon severity={f.severity} />
      <div className="grow col" style={{ gap: 4 }}>
        <strong>{f.title}</strong>
        {f.detail && <div className="small muted" style={{ whiteSpace: 'pre-wrap' }}>{f.detail}</div>}
        {f.confidence && f.severity !== 'pass' && <div className="tiny faint">Confidence: {f.confidence}</div>}
      </div>
      <div className="row">
        {f.repair && <RepairButton suggestion={f.repair} />}
        {f.category === 'library' && f.checkId === 'library.files' && <Button size="sm" onClick={() => navigate('/doctor/games')}>Fix games</Button>}
        <Button size="sm" variant="ghost" onClick={() => navigate(`/doctor/finding/${encodeURIComponent(f.id)}`)}>Details</Button>
      </div>
    </div>
  );
}

function ExportModal(props: { onClose: () => void }) {
  const [logs, setLogs] = useState(true);
  const [configs, setConfigs] = useState(true);
  const [result, setResult] = useState<{ path: string; files: string[]; excluded: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal onClose={props.onClose}>
      <h2>Export diagnostic package</h2>
      <p className="muted">Creates a ZIP with OmniPC logs, the latest health report, repair history and system summary. Your user folder path and Windows user name are redacted.</p>
      <p><strong>Never included:</strong> games/ROMs, BIOS & firmware, keys, saves, personal documents.</p>
      <label className="row"><input type="checkbox" checked={logs} onChange={(e) => setLogs(e.target.checked)} /> Include emulator logs (may mention game titles)</label>
      <label className="row"><input type="checkbox" checked={configs} onChange={(e) => setConfigs(e.target.checked)} /> Include emulator configuration files</label>
      {result && <Panel flat title="Package created"><code className="small">{result.path}</code><div className="small faint">{result.files.length} files</div><Button onClick={() => void api('app.openPath', result.path.replace(/[\\/][^\\/]+$/, ''))}>Open folder</Button></Panel>}
      <div className="row right"><Button onClick={props.onClose}>Close</Button><Button variant="primary" busy={busy} onClick={async () => { setBusy(true); try { setResult(await api('app.exportDiagnosticPackage', { includeEmulatorLogs: logs, includeConfigs: configs })); } finally { setBusy(false); } }}>Create package</Button></div>
    </Modal>
  );
}

export function FindingPage(props: { id: string }) {
  const { data } = useLoad(() => api('doctor.finding', props.id), [props.id]);
  if (data === null) return <div className="page"><Empty title="This issue is no longer in the latest report" action={<Button onClick={() => navigate('/doctor')}>Back to OmniDoctor</Button>} /></div>;
  if (!data) return <div className="page"><Spinner /></div>;
  const f = data.finding;
  return (
    <div className="page">
      <div className="page-head"><div><div className="row"><SevIcon severity={f.severity} /><Chip>{f.category}</Chip>{f.ruleId && <Chip>Rule {f.ruleId}</Chip>}</div><h1 style={{ marginTop: 10 }}>{f.title}</h1></div><Button onClick={() => navigate('/doctor')}>Back</Button></div>
      <div className="grid cols-2">
        <Panel title="What OmniDoctor found">
          {f.detail && <p style={{ whiteSpace: 'pre-wrap' }}>{f.detail}</p>}
          {f.subject && <dl className="kv"><dt>Affects</dt><dd>{f.subject.label} ({f.subject.kind})</dd></dl>}
          {f.confidence && <dl className="kv"><dt>Confidence</dt><dd>{f.confidence}</dd></dl>}
          {f.evidence.length > 0 && <><div className="small faint">Evidence</div><pre>{f.evidence.join('\n')}</pre></>}
        </Panel>
        <Panel title="How to fix it">
          {f.repair ? <div className="col"><div className="row"><SafetyChip safety={f.repair.safety} /></div><p>{f.repair.description}</p><div className="row"><RepairButton suggestion={f.repair} primary /></div></div> : <p className="muted">No automatic repair is available.</p>}
          {f.manualSteps.length > 0 && <><div className="small faint">Manual steps</div><ul>{f.manualSteps.map((s, i) => <li key={i}>{s}</li>)}</ul></>}
        </Panel>
      </div>
    </div>
  );
}

export function RepairHistoryPage() {
  const { data, reload } = useLoad(() => api('doctor.history', 200), []);
  const [detail, setDetail] = useState<RepairRecord | null>(null);
  const toast = useStore((s) => s.toast);
  return (
    <div className="page">
      <div className="page-head"><div><h1>Repair history</h1><p>Every repair OmniPC performed, automatic or approved, with details and undo where possible.</p></div><Button onClick={() => navigate('/doctor')}>Back</Button></div>
      {!data ? <Spinner /> : data.length === 0 ? <Empty title="No repairs yet" /> : (
        <Panel>
          {data.map((r) => (
            <div key={r.id} className="list-item">
              <span className="tiny faint" style={{ width: 160, flexShrink: 0 }}>{clock(r.startedAt)}</span>
              <div className="grow"><div>{r.message}</div><div className="tiny faint">{r.label}{r.subject ? ` · ${r.subject}` : ''}{r.automatic ? ' · automatic' : ''}</div></div>
              <SafetyChip safety={r.safety} />
              <Chip tone={r.status === 'succeeded' ? 'ok' : r.status === 'failed' ? 'bad' : undefined}>{r.status}</Chip>
              <Button size="sm" onClick={() => setDetail(r)}>View details</Button>
              {r.undoable && <Button size="sm" onClick={async () => { try { await api('doctor.undo', r.id); toast('success', 'Repair undone'); reload(); } catch (e) { toast('error', (e as Error).message); } }}>Undo</Button>}
            </div>
          ))}
        </Panel>
      )}
      {detail && (
        <Modal onClose={() => setDetail(null)}>
          <h2>{detail.label}</h2>
          <p>{detail.message}</p>
          {detail.details.length > 0 && <pre>{detail.details.join('\n')}</pre>}
          {detail.backupIds.length > 0 && <BackupLinks ids={detail.backupIds} />}
          <div className="row right"><Button onClick={() => setDetail(null)}>Close</Button></div>
        </Modal>
      )}
    </div>
  );
}

function BackupLinks(props: { ids: number[] }) {
  const { data } = useLoad(() => api('backups.list', null), []);
  const list = (data ?? []).filter((b) => props.ids.includes(b.id));
  return (
    <div className="col">
      <div className="small faint">Backups taken before this repair</div>
      {list.map((b) => <div key={b.id} className="row"><span className="grow small">{b.label}</span><Button size="sm" onClick={() => void api('app.openPath', b.path)}>Open backup</Button></div>)}
    </div>
  );
}

export function AskPage() {
  const route = useRoute();
  const gameId = route.query.get('game') ? Number(route.query.get('game')) : null;
  const settings = useStore((s) => s.settings);
  const [q, setQ] = useState('');
  const [preview, setPreview] = useState<AiContextPreview | null>(null);
  const [answer, setAnswer] = useState<{ answer: string; provider: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useStore((s) => s.toast);
  const enabled = settings?.aiEnabled && settings.aiProvider === 'anthropic' && !!settings.aiApiKey;
  return (
    <div className="page">
      <div className="page-head"><div><h1>Ask OmniDoctor</h1><p>Optional AI explanations built on OmniDoctor's local diagnostics. Diagnosis and repair never depend on it.</p></div><Button onClick={() => navigate('/doctor')}>Back</Button></div>
      {!enabled && <Panel title="AI troubleshooter is off"><p className="muted">Turn it on and add an Anthropic API key in <a href="#/settings#ai">Settings</a>. You can still preview what would be sent.</p></Panel>}
      <Panel>
        <textarea rows={3} placeholder="e.g. Why does this game keep crashing?" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="row">
          <Button onClick={async () => setPreview(await api('doctor.aiContext', q, gameId))} disabled={!q.trim()}>Preview what would be sent</Button>
          <Button variant="primary" busy={busy} disabled={!enabled || !q.trim()} onClick={async () => { setBusy(true); try { setAnswer(await api('doctor.aiAsk', q, gameId)); } catch (e) { toast('error', (e as Error).message); } finally { setBusy(false); } }}>Ask</Button>
        </div>
      </Panel>
      {preview && <Panel title={`Context preview (${preview.bytes} bytes)`}><p className="small muted">Only this structured summary is sent. ROMs, BIOS, saves and keys are never sent.{preview.redactions.length ? ` Redactions: ${preview.redactions.join('; ')}.` : ''}</p><pre>{preview.json}</pre></Panel>}
      {answer && <Panel title="Answer"><p style={{ whiteSpace: 'pre-wrap' }}>{answer.answer}</p><div className="tiny faint">{answer.provider}</div></Panel>}
    </div>
  );
}
