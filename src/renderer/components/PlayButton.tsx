// Play button + launch error handling. Launch failures before a process starts
// show a structured explanation; crashes after start route to the failure
// recovery page (handled globally in App).

import { useState } from 'react';
import type { LaunchResult } from '@shared/models';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { useStore } from '../lib/store';
import { OmniErrorView } from './OmniErrorView';
import { Button, Modal } from './ui';

export function PlayButton(props: { gameId: number; disabled?: boolean; discIndex?: number; label?: string; autoFocus?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LaunchResult | null>(null);
  const session = useStore((s) => s.session);
  const launch = async (ignoreCrashLoop = false) => {
    setBusy(true);
    try {
      const r = await api('launch.game', props.gameId, { discIndex: props.discIndex, ignoreCrashLoop });
      if (!r.ok) setResult(r);
      else if (r.preflight?.length) useStore.getState().toast('warning', r.preflight[0].title, r.preflight[0].detail);
    } catch (e) {
      useStore.getState().toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant="primary" size="big" busy={busy} disabled={props.disabled || !!session} onClick={() => launch()} autoFocus={props.autoFocus}>▶ {props.label ?? 'Play'}</Button>
      {result?.error && (
        <Modal onClose={() => setResult(null)}>
          <div className="tiny faint">{result.blockedByCrashLoop ? 'Crash-loop protection' : "We couldn't start this game"}</div>
          <OmniErrorView error={result.error} onFixed={() => setResult(null)} />
          <div className="row right">
            {result.blockedByCrashLoop && result.launchId === null && <Button onClick={() => navigate(`/game/${props.gameId}?tab=diagnostics`)}>View diagnosis</Button>}
            {result.blockedByCrashLoop && <Button variant="danger" onClick={() => { setResult(null); void launch(true); }}>Try again anyway</Button>}
            {result.launchId !== null && <Button onClick={() => navigate(`/failure/${result.launchId}`)}>Diagnose</Button>}
            <Button onClick={() => setResult(null)} autoFocus>Close</Button>
          </div>
        </Modal>
      )}
    </>
  );
}
