// Structured error page: what happened / what we detected / probable cause /
// what OmniDeck can fix / what you need to do / technical details.

import { useState } from 'react';
import type { OmniError } from '@shared/models';
import { RepairButton } from './RepairButton';

export function OmniErrorView(props: { error: OmniError; onFixed?: () => void }) {
  const e = props.error;
  const [tech, setTech] = useState(false);
  return (
    <div className="col">
      <h2>{e.whatHappened}</h2>
      {e.detected.length > 0 && (
        <div>
          <div className="small faint">What OmniDeck detected</div>
          <ul>{e.detected.map((d, i) => <li key={i}>{d}</li>)}</ul>
        </div>
      )}
      {e.probableCause && (
        <div>
          <div className="small faint">What probably caused it</div>
          <p>{e.probableCause}</p>
        </div>
      )}
      {e.omniCanFix && (
        <div className="col">
          <div className="small faint">What OmniDeck can fix</div>
          <div className="row"><RepairButton suggestion={e.omniCanFix} onDone={props.onFixed} primary /></div>
        </div>
      )}
      {e.userAction.length > 0 && (
        <div>
          <div className="small faint">What you need to do</div>
          <ul>{e.userAction.map((d, i) => <li key={i}>{d}</li>)}</ul>
        </div>
      )}
      {e.technical && (
        <div>
          <button className="btn ghost sm" onClick={() => setTech(!tech)}>{tech ? 'Hide' : 'Show'} technical details</button>
          {tech && <pre>{`Code: ${e.code}\n${e.technical}`}</pre>}
        </div>
      )}
    </div>
  );
}
