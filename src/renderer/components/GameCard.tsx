import { memo } from 'react';
import type { GameSummary } from '@shared/models';
import { getSystem } from '@shared/systems';
import { artUrl } from '../lib/api';
import { navigate } from '../lib/router';

export const GameCard = memo(function GameCard(props: { game: GameSummary }) {
  const g = props.game;
  const sys = getSystem(g.systemId);
  const img = artUrl(g.coverThumb);
  return (
    <button className={`card game-card ${g.availability !== 'available' ? 'unavailable' : ''}`} onClick={() => navigate(`/game/${g.id}`)} title={g.title}>
      <div className="art" style={!img ? { background: `linear-gradient(160deg, ${sys?.accent ?? '#1d2333'}55, #11141b)` } : undefined}>
        {img ? <img src={img} alt="" loading="lazy" decoding="async" /> : <div className="placeholder">{g.title}</div>}
      </div>
      <div className="corner">
        {g.favorite && <span className="chip" title="Favorite">★</span>}
        {g.availability === 'drive_unavailable' && <span className="chip warn" title="Game drive unavailable">Drive offline</span>}
        {g.validation === 'invalid' && <span className="chip bad" title="File failed validation">!</span>}
        {g.discCount > 1 && <span className="chip">{g.discCount} discs</span>}
      </div>
      <div className="meta">
        <div className="title">{g.title}</div>
        <div className="sys">{sys?.name ?? g.systemId}{g.region ? ` · ${g.region}` : ''}</div>
      </div>
    </button>
  );
});
