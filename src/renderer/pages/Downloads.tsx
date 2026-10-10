import { useStore } from '../lib/store';
import { api } from '../lib/api';
import { Button, Chip, Empty, JobSteps, Panel, ProgressBar } from '../components/ui';
import { bytes } from '../lib/format';

export function DownloadsPage() {
  const downloads = Object.values(useStore((s) => s.downloads)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const jobs = Object.values(useStore((s) => s.jobs)).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return (
    <div className="page">
      <div className="page-head"><div><h1>Downloads & activity</h1><p>Emulator downloads come only from each project's official release source and are verified before installation.</p></div></div>
      <Panel title="Downloads">
        {downloads.length === 0 ? <Empty title="No downloads this session" /> : downloads.map((d) => {
          const remaining = d.totalBytes ? d.totalBytes - d.receivedBytes : null;
          return (
            <div key={d.id} className="col" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 14 }}>
              <div className="row"><strong>{d.name}</strong>{d.version && <Chip>{d.version}</Chip>}<Chip tone={d.status === 'completed' ? 'ok' : d.status === 'failed' ? 'bad' : d.status === 'paused' ? 'warn' : undefined}>{d.status}</Chip>
                <span className="right" />
                {d.status === 'downloading' && <Button size="sm" onClick={() => void api('downloads.pause', d.id)}>Pause</Button>}
                {d.status === 'paused' && <Button size="sm" onClick={() => void api('downloads.resume', d.id)}>Resume</Button>}
                {d.status === 'failed' && <Button size="sm" onClick={() => void api('downloads.retry', d.id)}>Retry</Button>}
                {['downloading', 'paused', 'queued', 'failed'].includes(d.status) && <Button size="sm" variant="ghost" onClick={() => void api('downloads.cancel', d.id)}>Cancel</Button>}
              </div>
              <div className="small faint">Source: {d.source}</div>
              <ProgressBar value={d.totalBytes ? d.receivedBytes / d.totalBytes : null} tone={d.status === 'failed' ? 'bad' : d.status === 'completed' ? 'ok' : undefined} />
              <div className="row small muted"><span>{bytes(d.receivedBytes)} of {bytes(d.totalBytes)}</span>{d.status === 'downloading' && <span>{bytes(d.bytesPerSecond)}/s</span>}{remaining !== null && d.status === 'downloading' && <span>{bytes(remaining)} remaining</span>}{d.verification && <span>· {d.verification}</span>}</div>
              {d.error && <div className="small" style={{ color: 'var(--bad)' }}>{d.error}</div>}
            </div>
          );
        })}
      </Panel>
      <Panel title="Background tasks">
        {jobs.length === 0 ? <Empty title="Nothing running" /> : jobs.map((j) => (
          <div key={j.id} className="col" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 14 }}>
            <JobSteps job={j} />
            {j.cancellable && (j.state === 'running' || j.state === 'queued') && <div><Button size="sm" onClick={() => void api('jobs.cancel', j.id)}>Cancel</Button></div>}
          </div>
        ))}
      </Panel>
    </div>
  );
}
