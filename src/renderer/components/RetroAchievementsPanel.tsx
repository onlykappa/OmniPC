// Settings > RetroAchievements: sign in once; OmniPC configures every
// supporting emulator. The password lives only in this component's state for
// the duration of the sign-in request and is cleared right after.

import { useEffect, useState } from 'react';
import { RA_CREATE_ACCOUNT_URL, type RaEmulatorStatus, type RaStatus } from '@shared/achievements';
import { api, ApiError } from '../lib/api';
import { useStore } from '../lib/store';
import { Button, Chip, Panel, Toggle } from './ui';

const TONE: Record<RaEmulatorStatus, 'ok' | 'warn' | 'bad' | 'info' | 'planned'> = {
  configured: 'ok',
  'not-configured': 'warn',
  'not-installed': 'planned',
  'needs-sign-in': 'warn',
  error: 'bad',
};
const LABEL: Record<RaEmulatorStatus, string> = {
  configured: 'Signed in',
  'not-configured': 'Needs apply',
  'not-installed': 'Not installed',
  'needs-sign-in': 'Sign in inside the emulator',
  error: 'Error',
};

export function RetroAchievementsPanel() {
  const [st, setSt] = useState<RaStatus | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<null | 'login' | 'logout' | 'apply' | 'hardcore'>(null);
  const [error, setError] = useState<{ message: string; actions: string[] } | null>(null);
  const setSettings = useStore((s) => s.setSettings);
  const toast = useStore((s) => s.toast);

  useEffect(() => {
    void api('ra.status').then(setSt).catch(() => undefined);
  }, []);

  const run = async (kind: NonNullable<typeof busy>, fn: () => Promise<RaStatus>) => {
    setBusy(kind);
    setError(null);
    try {
      setSt(await fn());
      setSettings(await api('app.settings.get'));
    } catch (e) {
      setError(e instanceof ApiError && e.detail ? { message: e.detail.whatHappened, actions: e.detail.userAction } : { message: (e as Error).message, actions: [] });
    } finally {
      setBusy(null);
    }
  };

  const signIn = () => run('login', async () => {
    const pw = password;
    setPassword('');
    const s = await api('ra.login', username.trim(), pw);
    toast('success', `Signed in to RetroAchievements as ${s.username}`, 'Supporting emulators were configured.');
    return s;
  });

  if (!st) return <Panel id="achievements" title="RetroAchievements"><p className="small faint">Loading…</p></Panel>;

  return (
    <Panel id="achievements" title="RetroAchievements">
      <p className="small muted">Sign in once and OmniPC sets up achievements in RetroArch, DuckStation, PCSX2, PPSSPP and Dolphin, including emulators you install later.</p>
      {!st.signedIn ? (
        <form className="col" onSubmit={(e) => { e.preventDefault(); if (username.trim() && password) void signIn(); }}>
          {st.needsSignIn && <p className="small"><Chip tone="warn">Sign in again</Chip> The saved sign-in for {st.username} cannot be read on this PC.</p>}
          <label className="field">User name<input type="text" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder={st.username ?? ''} /></label>
          <label className="field">Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <div className="row">
            <Button type="submit" variant="primary" busy={busy === 'login'} disabled={!username.trim() || !password}>Sign in</Button>
            <a href="#" onClick={(e) => { e.preventDefault(); void api('app.openExternal', RA_CREATE_ACCOUNT_URL); }}>Create a free account</a>
          </div>
          <p className="small faint">Your password goes only to retroachievements.org and is never saved. OmniPC keeps only the login token RetroAchievements returns, encrypted by Windows.</p>
        </form>
      ) : (
        <div className="col">
          <div className="row"><span>Signed in as <b>{st.username}</b></span><Chip tone="ok">Connected</Chip>{!st.tokenProtected && <Chip tone="warn" title="Windows encryption was not available, so the token is stored without it.">Token not encrypted</Chip>}</div>
          <Toggle label="Hardcore mode" description="Unlocks count as hardcore. While playing, save states, rewind, slow motion and cheats are disabled in the emulators." value={st.hardcore} disabled={busy !== null} onChange={(v) => void run('hardcore', () => api('ra.setHardcore', v))} />
          <div className="col">
            <span className="small muted">Emulators</span>
            {st.emulators.map((e) => (
              <div key={e.emulatorId} className="list-item"><div className="grow"><div>{e.name}</div><div className="tiny faint">{e.detail}</div></div><Chip tone={TONE[e.status]}>{LABEL[e.status]}</Chip></div>
            ))}
          </div>
          <div className="row">
            <Button busy={busy === 'apply'} disabled={busy !== null} onClick={() => void run('apply', () => api('ra.apply'))} title="Writes the sign-in into every installed emulator (configuration is backed up first)">Apply to emulators</Button>
            <Button variant="ghost" busy={busy === 'logout'} disabled={busy !== null} onClick={() => void run('logout', () => api('ra.logout'))} title="Signs out of OmniPC and every emulator it configured">Sign out</Button>
          </div>
        </div>
      )}
      {error && <div className="col"><p className="small"><Chip tone="bad">Error</Chip> {error.message}</p>{error.actions.map((a) => <p key={a} className="tiny faint">{a}</p>)}</div>}
    </Panel>
  );
}
