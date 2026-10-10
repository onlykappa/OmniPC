import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameSummary, ImportPreview, LibraryPath, LibraryQuery } from '@shared/models';
import { SYSTEMS, getSystem, type SystemId } from '@shared/systems';
import { api } from '../lib/api';
import { useLoad } from '../lib/hooks';
import { navigate, useRoute } from '../lib/router';
import { useStore } from '../lib/store';
import { GameGrid } from '../components/GameGrid';
import { Button, Chip, Empty, Modal, Panel, Spinner } from '../components/ui';
import { when } from '../lib/format';

const PAGE = 400;

export function LibraryPage() {
  const route = useRoute();
  const v = useStore((s) => s.libraryVersion);
  const system = (route.query.get('system') as SystemId | null) ?? null;
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<LibraryQuery['sort']>((route.query.get('sort') as LibraryQuery['sort']) ?? 'title');
  const favoritesOnly = route.query.get('favorites') === '1';
  const [games, setGames] = useState<GameSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [manage, setManage] = useState(route.query.get('manage') === '1');
  const loadingMore = useRef(false);
  const scroller = document.getElementById('main-scroll');

  const base: LibraryQuery = { systemId: system, search, sort, favoritesOnly, includeUnavailable: true };
  useEffect(() => {
    let alive = true;
    setLoading(true);
    const t = setTimeout(() => {
      void api('library.query', { ...base, offset: 0, limit: PAGE }).then((r) => {
        if (!alive) return;
        setGames(r.items);
        setTotal(r.total);
        setLoading(false);
      });
    }, search ? 150 : 0);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [system, search, sort, favoritesOnly, v]);

  const loadMore = useCallback(() => {
    if (loadingMore.current || games.length >= total) return;
    loadingMore.current = true;
    void api('library.query', { ...base, offset: games.length, limit: PAGE }).then((r) => {
      setGames((g) => [...g, ...r.items]);
      loadingMore.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [games.length, total, system, search, sort, favoritesOnly]);

  const sys = system ? getSystem(system) : null;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{sys ? sys.name : favoritesOnly ? 'Favorites' : 'Library'}</h1>
          <p>{total} game{total === 1 ? '' : 's'}</p>
        </div>
        <div className="row">
          <Button onClick={() => setManage(true)}>Game folders</Button>
          <ScanButton />
        </div>
      </div>
      <div className="row">
        <input type="search" placeholder="Search this library…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 360 }} />
        <select value={system ?? ''} onChange={(e) => navigate(e.target.value ? `/library?system=${e.target.value}` : '/library')} style={{ maxWidth: 240 }}>
          <option value="">All systems</option>
          {SYSTEMS.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as LibraryQuery['sort'])} style={{ maxWidth: 200 }}>
          <option value="title">Title</option>
          <option value="recent">Recently played</option>
          <option value="added">Recently added</option>
          <option value="playtime">Most played</option>
        </select>
        <Button variant={favoritesOnly ? 'primary' : undefined} onClick={() => navigate(favoritesOnly ? '/library' : '/library?favorites=1')}>★ Favorites</Button>
        <Button onClick={() => navigate('/library/duplicates')}>Duplicates</Button>
      </div>
      {loading ? <Spinner /> : games.length === 0 ? (
        <Empty title={search ? 'No matches' : 'No games here yet'} action={!search ? <Button variant="primary" onClick={() => setManage(true)}>Add game folder</Button> : undefined}>
          {!search && 'Add the folders where your games are stored. OmniPC scans them recursively across all drives.'}
        </Empty>
      ) : (
        <GameGrid games={games} scrollParent={scroller} onNearEnd={loadMore} />
      )}
      {manage && <FoldersModal onClose={() => setManage(false)} />}
    </div>
  );
}

export function ScanButton() {
  const jobs = useStore((s) => s.jobs);
  const running = Object.values(jobs).find((j) => j.kind === 'library.scan' && (j.state === 'running' || j.state === 'queued'));
  return (
    <Button variant="primary" busy={!!running} onClick={() => void api('library.scan', { full: false })}>
      {running ? running.message : 'Scan library'}
    </Button>
  );
}

function FoldersModal(props: { onClose: () => void }) {
  const { data: paths, reload } = useLoad(() => api('library.paths'), []);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useStore((s) => s.toast);
  const add = async () => {
    const p = await api('app.pickFolder', 'Choose a folder with your games');
    if (!p) return;
    setBusy(true);
    try {
      setPreview(await api('library.preview', p));
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!preview) return;
    await api('library.addPath', preview.path);
    await api('library.scan', { full: false });
    setPreview(null);
    reload();
    toast('success', 'Folder added', 'Scanning in the background.');
  };
  return (
    <Modal onClose={props.onClose} wide>
      <div className="row"><h2>Game folders</h2><span className="right" /><Button variant="primary" onClick={add} busy={busy}>Add folder…</Button></div>
      <p className="muted small">Folders can be on any drive, including external drives. Removing a folder only removes it from OmniPC — files are never deleted.</p>
      {preview && (
        <Panel title={`Found ${preview.total} game${preview.total === 1 ? '' : 's'} in ${preview.path}`} flat>
          <div className="row">
            {Object.entries(preview.bySystem).sort((a, b) => b[1] - a[1]).map(([s, n]) => <Chip key={s}>{getSystem(s)?.shortName ?? s}: {n}</Chip>)}
            {preview.unrecognized > 0 && <Chip tone="warn">Other / unrecognized: {preview.unrecognized}</Chip>}
          </div>
          <div className="row right"><Button onClick={() => setPreview(null)}>Cancel</Button><Button variant="primary" onClick={confirm} autoFocus>Import these games</Button></div>
        </Panel>
      )}
      <div className="list">
        {(paths ?? []).map((p: LibraryPath) => (
          <div key={p.id} className="list-item">
            <span className={`dot ${p.available ? 'ok' : 'warn'}`} />
            <div className="grow">
              <div>{p.path}</div>
              <div className="small faint">{p.gameCount} {p.gameCount === 1 ? "game" : "games"} · {p.available ? `scanned ${when(p.lastScanAt)}` : 'Drive unavailable — games are kept and return when it is reconnected'}</div>
            </div>
            <Button size="sm" variant="ghost" onClick={async () => { await api('library.removePath', p.id); reload(); }}>Remove</Button>
          </div>
        ))}
        {paths && paths.length === 0 && <p className="muted">No folders yet.</p>}
      </div>
      <div className="row right"><Button onClick={() => void api('library.scan', { full: true })}>Full rescan</Button><Button onClick={props.onClose}>Close</Button></div>
    </Modal>
  );
}

export function DuplicatesPage() {
  const { data } = useLoad(() => api('library.duplicates'), []);
  return (
    <div className="page">
      <div className="page-head"><div><h1>Possible duplicates</h1><p>OmniPC never deletes duplicates. Review them and remove files yourself if you want.</p></div></div>
      {!data ? <Spinner /> : data.length === 0 ? <Empty title="No duplicates found" /> : data.map((g) => (
        <Panel key={g.key} title={g.reason === 'same_serial' ? `Same disc serial` : 'Same title'}>
          {g.games.map((x) => (
            <div key={x.id + x.path} className="list-item">
              <a href={`#/game/${x.id}`}>{x.title}</a>
              <span className="mono small faint grow">{x.path}</span>
              <Button size="sm" onClick={() => void api('app.openPath', x.path.replace(/[\\/][^\\/]*$/, ''))}>Open folder</Button>
            </div>
          ))}
        </Panel>
      ))}
    </div>
  );
}
