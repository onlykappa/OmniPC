import type { GameSummary } from '@shared/models';
import { api } from '../lib/api';
import { useLoad } from '../lib/hooks';
import { navigate } from '../lib/router';
import { useStore } from '../lib/store';
import { GameCard } from '../components/GameCard';
import { Button, Chip, Empty, HealthRing, healthTone } from '../components/ui';
import { when } from '../lib/format';

function Shelf(props: { title: string; games: GameSummary[]; more?: string }) {
  if (!props.games.length) return null;
  return (
    <section>
      <div className="section-title"><h2>{props.title}</h2>{props.more && <a href={`#${props.more}`} className="small">See all</a>}</div>
      <div className="shelf">{props.games.map((g) => <GameCard key={g.id} game={g} />)}</div>
    </section>
  );
}

export function HomePage() {
  const v = useStore((s) => s.libraryVersion + s.emulatorsVersion);
  const { data } = useLoad(() => api('home.get'), [v]);
  if (!data) return <div className="page"><div className="spinner" /></div>;
  const h = data.health;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Welcome back</h1>
          <p>{data.libraryCount ? `${data.libraryCount} games across ${data.systems.filter((s) => s.gameCount).length} systems` : 'Your library is empty. Add a game folder to get started.'}</p>
        </div>
        <button className="card" style={{ padding: 16, display: 'flex', gap: 16, alignItems: 'center' }} onClick={() => navigate('/doctor')}>
          <HealthRing value={h.overall} label="System health" />
          <div className="col" style={{ gap: 4 }}>
            <strong>OmniDoctor</strong>
            <span className="small muted">{h.lastRunAt === null ? 'No health check yet' : h.problems ? `${h.problems} problem${h.problems > 1 ? 's' : ''} detected` : h.warnings ? `${h.warnings} warning${h.warnings > 1 ? 's' : ''}` : 'Everything looks good'}</span>
            <span className="tiny faint">Checked {when(h.lastRunAt)}</span>
          </div>
        </button>
      </div>
      {!data.libraryCount && (
        <Empty title="No games yet" action={<Button variant="primary" onClick={() => navigate('/library?manage=1')} autoFocus>Add game folder</Button>}>
          Point OmniDeck at the folders where your games live. It scans them, identifies each system and fetches artwork.
        </Empty>
      )}
      <Shelf title="Continue Playing" games={data.continuePlaying} more="/library?sort=recent" />
      <Shelf title="Favorites" games={data.favorites} more="/library?favorites=1" />
      <Shelf title="Recently Added" games={data.recentlyAdded} more="/library?sort=added" />
      {data.systems.length > 0 && (
        <section>
          <div className="section-title"><h2>Systems</h2><a href="#/systems" className="small">All systems</a></div>
          <div className="grid cols-auto" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
            {data.systems.map((s) => (
              <button key={s.id} className="card system-card" onClick={() => navigate(`/library?system=${s.id}`)}>
                <span className="stripe" style={{ background: s.accent }} />
                <span className="tiny faint">{s.manufacturer}</span>
                <strong style={{ fontSize: 17 }}>{s.name}</strong>
                <span className="small muted">{s.gameCount} game{s.gameCount === 1 ? '' : 's'}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      <section>
        <div className="section-title"><h2>Installed Emulators</h2><a href="#/emulators" className="small">Manage</a></div>
        {data.emulators.length === 0 ? (
          <p className="muted">No emulators installed. <a href="#/systems">Choose a system</a> to install support for it.</p>
        ) : (
          <div className="row">
            {data.emulators.map((e) => (
              <button key={e.id} className="chip" style={{ cursor: 'pointer', padding: '8px 14px', fontSize: 14 }} onClick={() => navigate(`/emulators/${e.id}`)}>
                <span className={`dot ${healthTone(e.health) ?? ''}`} />
                {e.name} {e.health === 'ready' ? 'Ready' : e.health === 'error' ? 'Needs attention' : e.health === 'attention' ? 'Needs attention' : 'Not tested'}
                {e.updateAvailable && <Chip tone="info">Update</Chip>}
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
