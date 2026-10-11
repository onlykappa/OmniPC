// OmniDoctor > Games: per-game problems with the game files themselves
// (missing tracks, zipped discs, broken playlists, crash loops) and the
// fixes OmniPC can apply. Game files are never deleted.

import { useEffect, useMemo, useState } from 'react';
import type { GameProblem } from '@shared/models';
import { getSystem, type SystemId } from '@shared/systems';
import { api, onEvent } from '../lib/api';
import { navigate } from '../lib/router';
import { RepairButton } from '../components/RepairButton';
import { Button, Chip, Empty, Panel, SevIcon, Spinner } from '../components/ui';

type Filter = 'all' | 'problem' | 'warning';

export function DoctorGamesPage() {
  const [games, setGames] = useState<GameProblem[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [systemId, setSystemId] = useState<string>('');
  const load = () => void api('doctor.games').then(setGames);
  useEffect(() => {
    load();
    return onEvent('library.changed', load);
  }, []);
  const systems = useMemo(() => [...new Set((games ?? []).map((g) => g.systemId))].sort(), [games]);
  const shown = (games ?? []).filter((g) => (!systemId || g.systemId === systemId) && (filter === 'all' || g.issues.some((i) => i.severity === filter)));
  const problems = (games ?? []).filter((g) => g.issues.some((i) => i.severity === 'problem')).length;
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Fix games</h1><p>Games that may not start because of their files (not the emulator), and what OmniPC can do about it. Your game files are never deleted.</p></div>
        <div className="row">
          <Button onClick={() => navigate('/doctor')}>Back to OmniDoctor</Button>
          <RepairButton suggestion={{ actionId: 'game.revalidateAll', label: 'Check all again', safety: 'safe', params: {}, description: '' }} onDone={load} />
        </div>
      </div>
      {!games ? <Spinner /> : !games.length ? (
        <Empty title="No game problems found">Every game in your library passed its file checks.</Empty>
      ) : (
        <>
          <div className="row">
            <Chip tone="bad">{problems} with problems</Chip>
            <Chip tone="warn">{games.length - problems} with warnings only</Chip>
            <span className="grow" />
            <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="Severity">
              <option value="all">All issues</option>
              <option value="problem">Problems</option>
              <option value="warning">Warnings</option>
            </select>
            <select value={systemId} onChange={(e) => setSystemId(e.target.value)} aria-label="System">
              <option value="">All systems</option>
              {systems.map((s) => <option key={s} value={s}>{getSystem(s as SystemId)?.name ?? s}</option>)}
            </select>
          </div>
          {shown.map((g) => <GameCard key={g.gameId} g={g} onFixed={load} />)}
        </>
      )}
    </div>
  );
}

function GameCard(props: { g: GameProblem; onFixed: () => void }) {
  const { g } = props;
  const folder = g.path.replace(/[\\/][^\\/]+$/, '');
  return (
    <Panel
      title={<span className="row"><span>{g.title}</span><Chip>{getSystem(g.systemId as SystemId)?.name ?? g.systemId}</Chip></span>}
      actions={<div className="row">
        <Button size="sm" variant="ghost" onClick={() => navigate(`/game/${g.gameId}`)}>Game page</Button>
        {folder && <Button size="sm" variant="ghost" onClick={() => void api('app.openPath', folder)}>Open folder</Button>}
      </div>}
    >
      <code className="small faint" style={{ wordBreak: 'break-all' }}>{g.path}</code>
      {g.issues.map((i, n) => (
        <div key={n} className="finding">
          <SevIcon severity={i.severity} />
          <div className="grow col" style={{ gap: 4 }}>
            <strong>{i.title}</strong>
            {i.detail && <div className="small muted" style={{ whiteSpace: 'pre-wrap' }}>{i.detail}</div>}
            {i.manualSteps.map((s) => <div key={s} className="small">• {s}</div>)}
          </div>
          <div className="row">{i.fixes.map((f) => <RepairButton key={f.actionId} suggestion={f} onDone={props.onFixed} />)}</div>
        </div>
      ))}
    </Panel>
  );
}
