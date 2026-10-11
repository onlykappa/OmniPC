import { useEffect, useState } from 'react';
import type { SystemId } from '@shared/systems';
import { api } from '../lib/api';
import { useAction, useLoad } from '../lib/hooks';
import { navigate } from '../lib/router';
import { useStore } from '../lib/store';
import { Button, Chip, Empty, JobSteps, Modal, Panel, Spinner } from '../components/ui';
import { clock } from '../lib/format';

/** Settings > Steam: add OmniPC games to Steam as non-Steam shortcuts with artwork. */
export function SteamPage() {
  const [userId, setUserId] = useState<string | null>(null);
  const { data: status, reload } = useLoad(() => api('steam.status', userId), [userId]);
  const { data: systems } = useLoad(() => api('systems.list'), []);
  const [picked, setPicked] = useState<Set<SystemId>>(new Set());
  const [jobId, setJobId] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const job = useStore((s) => (jobId ? s.jobs[jobId] : undefined));
  const toast = useStore((s) => s.toast);
  const [closeSteam, closing] = useAction(async () => {
    const r = await api('steam.closeSteam');
    if (r.closed) toast('success', 'Steam closed');
    else toast('warning', 'Steam is still running', 'Exit Steam from its tray icon, then come back.');
    reload();
  });
  const [sync] = useAction(async (opts: { systems?: SystemId[] }) => {
    const r = await api('steam.sync', { userId: status?.userId ?? undefined, ...(opts.systems ? { systems: opts.systems } : { gameIds: 'all' }) });
    setJobId(r.jobId);
  });
  const [removeAll, removing] = useAction(async () => {
    const r = await api('steam.removeAll', { userId: status?.userId ?? undefined });
    toast('success', `Removed ${r.removed} OmniPC shortcut(s) from Steam`);
    reload();
  });
  useEffect(() => {
    if (job && job.state !== 'running' && job.state !== 'queued') reload();
  }, [job?.state, reload]);

  if (!status) return <div className="page"><Spinner /></div>;
  const busy = !!job && (job.state === 'running' || job.state === 'queued');
  const blocked = status.running || !status.userId || busy;
  const withGames = (systems ?? []).filter((s) => s.gameCount > 0);
  return (
    <div className="page">
      <div className="page-head"><div><h1>Steam</h1><p>Add your OmniPC games to Steam as non-Steam games, with box art, so they start from Steam, Big Picture and Steam Link. Steam runs OmniPC, which starts the game with its usual emulator and settings.</p></div><Button onClick={() => navigate('/settings')}>Settings</Button></div>
      {!status.installed ? (
        <Panel><Empty title="Steam was not found">Install Steam from store.steampowered.com and sign in once, then come back here.</Empty><div className="row"><Button onClick={reload}>Check again</Button></div></Panel>
      ) : (
        <div className="grid cols-2">
          <Panel title="Status" actions={<Button size="sm" variant="ghost" onClick={reload}>Refresh</Button>}>
            <dl className="kv">
              <dt>Steam folder</dt><dd className="mono small">{status.steamPath}</dd>
              <dt>Steam</dt><dd>{status.running ? <Chip tone="warn">Running</Chip> : <Chip tone="ok">Closed</Chip>}</dd>
              <dt>Account</dt>
              <dd>
                {status.users.length === 0 ? <span className="muted">No account has signed in yet</span> : (
                  <select value={status.userId ?? ''} onChange={(e) => setUserId(e.target.value)}>
                    {status.users.map((u) => <option key={u.id} value={u.id}>{u.name}{u.mostRecent ? ' (last signed in)' : ''}</option>)}
                  </select>
                )}
              </dd>
              <dt>OmniPC shortcuts</dt><dd>{status.shortcutsCount}</dd>
              {status.lastSync && <><dt>Last change</dt><dd className="small">{clock(status.lastSync.at)}: {status.lastSync.added} added, {status.lastSync.updated} updated, {status.lastSync.removed} removed, {status.lastSync.artwork} image(s)</dd></>}
            </dl>
            {status.running && (
              <div className="col">
                <p className="small">Steam has to be closed while OmniPC changes its shortcuts: Steam keeps the list in memory and writes it back when it exits, which would undo the changes.</p>
                <div className="row"><Button variant="primary" busy={closing} onClick={() => void closeSteam()}>Close Steam</Button></div>
              </div>
            )}
          </Panel>
          <Panel title="Add games">
            <div className="row">
              <Button variant="primary" disabled={blocked} onClick={() => void sync({})}>Add all games to Steam</Button>
              <Button variant="danger" disabled={blocked || status.shortcutsCount === 0} busy={removing} onClick={() => setConfirmRemove(true)}>Remove OmniPC shortcuts</Button>
            </div>
            <p className="small faint">"Add all" also removes shortcuts of games that are no longer in your library. Your other non-Steam games are never changed.</p>
            {withGames.length > 0 && (
              <div className="col">
                <span>Or only these systems:</span>
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  {withGames.map((s) => (
                    <label key={s.id} className="row small" style={{ gap: 4 }}>
                      <input type="checkbox" checked={picked.has(s.id)} onChange={(e) => { const n = new Set(picked); if (e.target.checked) n.add(s.id); else n.delete(s.id); setPicked(n); }} />
                      {s.shortName} ({s.gameCount})
                    </label>
                  ))}
                </div>
                <div className="row"><Button disabled={blocked || picked.size === 0} onClick={() => void sync({ systems: [...picked] })}>Add selected systems</Button></div>
              </div>
            )}
            {job && <JobSteps job={job} />}
          </Panel>
          <Panel title="How it works">
            <ul className="small">
              <li>Each game becomes a non-Steam shortcut tagged "OmniPC" and its system, with the cover as the library capsule and the background as the hero image. Pictures you set yourself in Steam are kept.</li>
              <li>Start Steam again afterwards: the games appear in your library (and in Big Picture).</li>
              <li>Steam starts <span className="mono">{status.launcher.exe}</span> with <span className="mono">{status.launcher.launchOptions}</span>. When OmniPC was started only for that game, it closes again when the game exits, so Steam shows the game as stopped.</li>
              <li>Before every change OmniPC backs up shortcuts.vdf to its Backups\steam folder. Nothing else in Steam's folders is changed.</li>
            </ul>
          </Panel>
        </div>
      )}
      {confirmRemove && (
        <Modal onClose={() => setConfirmRemove(false)}>
          <h2>Remove OmniPC shortcuts?</h2>
          <p>Removes the {status.shortcutsCount} shortcut(s) OmniPC added to Steam and the artwork OmniPC copied for them. Your other non-Steam games stay.</p>
          <div className="row right"><Button onClick={() => setConfirmRemove(false)}>Cancel</Button><Button variant="danger" autoFocus onClick={() => { setConfirmRemove(false); void removeAll(); }}>Remove</Button></div>
        </Modal>
      )}
    </div>
  );
}

/** "Add to Steam" for one game (game details page). */
export function AddToSteamButton(props: { gameId: number }) {
  const toast = useStore((s) => s.toast);
  const [add, busy] = useAction(async () => {
    const st = await api('steam.status');
    if (!st.installed) return toast('error', 'Steam was not found', 'Install Steam and sign in once.');
    if (st.running) {
      toast('warning', 'Close Steam first', 'Steam overwrites its shortcut list when it exits. Use Settings > Steam to close it.');
      return navigate('/steam');
    }
    await api('steam.sync', { gameIds: [props.gameId] });
    toast('info', 'Adding to Steam…', 'Start Steam afterwards to see the game.');
  });
  return <Button busy={busy} onClick={() => void add()} title="Add this game to Steam as a non-Steam game">Add to Steam</Button>;
}
