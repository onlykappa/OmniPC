// Game failure recovery: "We couldn't start this game. Checking the problem…"
// followed by OmniDoctor's evidence-based explanation and a one-click fix.

import { useEffect, useState } from 'react';
import type { FailureAnalysis } from '@shared/models';
import { api } from '../lib/api';
import { back, navigate } from '../lib/router';
import { useStore } from '../lib/store';
import { RepairButton } from '../components/RepairButton';
import { Button, Chip, Panel, SevIcon, Spinner } from '../components/ui';

export function FailurePage(props: { launchId: number }) {
  const [a, setA] = useState<FailureAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tech, setTech] = useState(false);
  const toast = useStore((s) => s.toast);
  useEffect(() => {
    const t = setTimeout(() => void api('launch.analyze', props.launchId).then(setA).catch((e) => setError((e as Error).message)), 600);
    return () => clearTimeout(t);
  }, [props.launchId]);
  const retry = async () => {
    if (!a || a.gameId === null) return;
    const r = await api('launch.game', a.gameId, { ignoreCrashLoop: true });
    if (!r.ok) toast('error', r.error?.whatHappened ?? 'Launch failed');
  };
  if (error) return <div className="page"><h1>Diagnosis failed</h1><p className="muted">{error}</p><Button onClick={back}>Back</Button></div>;
  if (!a) return (
    <div className="page" style={{ alignItems: 'center', paddingTop: 120 }}>
      <h1>We couldn't start this game.</h1>
      <div className="row muted"><Spinner /> Checking the problem…</div>
    </div>
  );
  const primary = a.findings[0];
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="tiny faint">{a.gameTitle ?? 'Game'} · {a.emulatorId}</div>
          <h1>{a.headline}</h1>
          <p>{a.whatHappened}</p>
        </div>
        <div className="row"><Button onClick={back}>Back</Button></div>
      </div>
      {a.crashLoop.paused && (
        <Panel title={`${a.gameTitle ?? 'This game'} has failed ${a.crashLoop.failures} times.`}>
          <p>OmniPC has paused automatic launching to prevent a crash loop. Apply a fix below, then try again.</p>
        </Panel>
      )}
      <div className="grid cols-2">
        <Panel title="Detected">
          <ul>{a.detected.map((d, i) => <li key={i}>{d}</li>)}</ul>
          {a.probableCause && (
            <div className="col" style={{ gap: 4 }}>
              <div className="small faint">Most likely cause</div>
              <strong>{primary?.title ?? a.probableCause}</strong>
              {primary?.detail && <p className="muted">{primary.detail}</p>}
              <div className="row"><span className="small faint">Confidence</span><Chip tone={a.confidence === 'high' ? 'ok' : a.confidence === 'medium' ? 'warn' : undefined}>{a.confidence ?? 'unknown'}</Chip></div>
            </div>
          )}
          {a.evidence.length > 0 && <><div className="small faint">Evidence</div><pre>{a.evidence.join('\n')}</pre></>}
        </Panel>
        <Panel title="Fix">
          {a.primaryRepair ? (
            <div className="col">
              <p>{a.primaryRepair.description}</p>
              <div className="row">
                <RepairButton suggestion={a.primaryRepair} primary label={`${a.primaryRepair.label} and retry`} onDone={(r) => { if (r.status === 'succeeded') void retry(); }} />
                <RepairButton suggestion={a.primaryRepair} label="Fix only" />
              </div>
            </div>
          ) : <p className="muted">Automatic repair is unavailable for this problem.</p>}
          {a.userAction.length > 0 && <><div className="small faint">What you need to do</div><ul>{a.userAction.map((x, i) => <li key={i}>{x}</li>)}</ul></>}
          <div className="row">
            <Button onClick={() => void retry()}>Try again</Button>
            <Button onClick={() => navigate('/doctor')}>Run full health check</Button>
            <Button onClick={() => navigate(`/doctor/ask?launch=${a.launchId}`)}>Ask OmniDoctor</Button>
          </div>
        </Panel>
      </div>
      {a.findings.length > 1 && (
        <Panel title="Other possible causes">
          {a.findings.slice(1).map((f) => (
            <div key={f.id} className="finding"><SevIcon severity={f.severity} /><div className="grow"><strong>{f.title}</strong><div className="small muted">{f.detail}</div>{f.confidence && <div className="tiny faint">Confidence: {f.confidence}</div>}</div>{f.repair && <RepairButton suggestion={f.repair} />}</div>
          ))}
        </Panel>
      )}
      {a.correlatedChanges.length > 0 && (
        <Panel title="Recent changes before this failure">
          {a.correlatedChanges.map((c) => <div key={c.id} className="list-item"><span className="small faint" style={{ width: 170 }}>{new Date(c.at).toLocaleString()}</span><span>{c.summary}</span></div>)}
        </Panel>
      )}
      <Panel title="Technical details" actions={<Button size="sm" onClick={() => setTech(!tech)}>{tech ? 'Hide' : 'Show'}</Button>}>
        {tech && (
          <>
            <dl className="kv"><dt>Exit code</dt><dd>{a.technical.exitCode ?? '—'}</dd><dt>Duration</dt><dd>{a.technical.durationMs !== null ? `${(a.technical.durationMs / 1000).toFixed(1)} s` : '—'}</dd><dt>Log</dt><dd className="mono">{a.technical.logPath ?? '—'}</dd><dt>Arguments</dt><dd className="mono">{a.technical.args.join(' ')}</dd></dl>
            {a.technical.logExcerpt && <pre>{a.technical.logExcerpt}</pre>}
          </>
        )}
      </Panel>
    </div>
  );
}
