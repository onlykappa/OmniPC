import { useEffect, useState, type ReactNode } from 'react';
import type { SearchResult } from '@shared/models';
import { api } from '../lib/api';
import { navigate, useRoute } from '../lib/router';
import { useStore } from '../lib/store';
import { Button, Modal } from './ui';

const NAV: { path: string; label: string; icon: string; dev?: boolean }[] = [
  { path: '/home', label: 'Home', icon: '⌂' },
  { path: '/library', label: 'Library', icon: '▦' },
  { path: '/discover', label: 'Discover', icon: '✧' },
  { path: '/systems', label: 'Systems', icon: '◎' },
  { path: '/emulators', label: 'Emulators', icon: '⚙' },
  { path: '/controllers', label: 'Controllers', icon: '🎮' },
  { path: '/downloads', label: 'Downloads', icon: '⇩' },
  { path: '/share', label: 'Share & Copy', icon: '⇄' },
  { path: '/doctor', label: 'OmniDoctor', icon: '✚' },
  { path: '/settings', label: 'Settings', icon: '☰' },
  { path: '/dev', label: 'Developer', icon: '⌘', dev: true },
];

export function navPaths(devMode: boolean): string[] {
  return NAV.filter((n) => !n.dev || devMode).map((n) => n.path);
}

export function Layout(props: { children: ReactNode; health: { problems: number; warnings: number } }) {
  const route = useRoute();
  const settings = useStore((s) => s.settings);
  const consoleMode = useStore((s) => s.consoleMode);
  const session = useStore((s) => s.session);
  const jobs = useStore((s) => s.jobs);
  const safeMode = useStore((s) => s.safeMode);
  const setPalette = useStore((s) => s.setPalette);
  const running = Object.values(jobs).filter((j) => j.state === 'running' || j.state === 'queued');
  const current = '/' + (route.parts[0] ?? 'home');
  return (
    <div className={`app ${consoleMode ? 'console' : ''}`}>
      {!consoleMode && (
        <nav className="sidebar" aria-label="Main">
          <div className="brand"><span className="brand-mark" />OmniPC</div>
          {NAV.filter((n) => !n.dev || settings?.devMode).map((n) => (
            <button key={n.path} className={`nav-item ${current === n.path || (n.path === '/emulators' && current === '/bios') ? 'active' : ''}`} onClick={() => navigate(n.path)}>
              <span className="icon">{n.icon}</span>
              {n.label}
              {n.path === '/doctor' && props.health.problems > 0 && <span className="badge">{props.health.problems}</span>}
              {n.path === '/doctor' && !props.health.problems && props.health.warnings > 0 && <span className="badge warn">{props.health.warnings}</span>}
              {n.path === '/downloads' && running.length > 0 && <span className="badge warn">{running.length}</span>}
            </button>
          ))}
          <div className="nav-spacer" />
          {safeMode && <div className="chip warn" style={{ margin: '0 8px 8px' }}>Safe Mode</div>}
          <button className="nav-item" onClick={() => void api('app.setConsoleMode', !consoleMode)}><span className="icon">⛶</span>Console Mode</button>
          <button className="nav-item" onClick={() => navigate('/about')}><span className="icon">ⓘ</span>About</button>
        </nav>
      )}
      <main className="main" id="main-scroll">
        {session && (
          <div className="session-bar">
            <span className="spinner" />
            <strong>Playing {session.gameTitle ?? session.emulatorId}</strong>
            <span className="muted small">Exit with your universal hotkey ({settings ? `${settings.hotkeys.modifier} + ${settings.hotkeys.bindings.exit}` : '…'}) to return here.</span>
            <span className="right" />
            <Button size="sm" variant="danger" onClick={() => void api('launch.stop')}>Force close</Button>
          </div>
        )}
        <div className="topbar">
          {consoleMode && <button className="btn ghost" onClick={() => navigate('/home')}>⌂ Home</button>}
          {consoleMode && <button className="btn ghost" onClick={() => navigate('/library')}>Library</button>}
          {consoleMode && <button className="btn ghost" onClick={() => navigate('/discover')}>Discover</button>}
          {consoleMode && <button className="btn ghost" onClick={() => navigate('/doctor')}>OmniDoctor {props.health.problems ? `(${props.health.problems})` : ''}</button>}
          <button className="search-trigger" onClick={() => setPalette(true)}>
            ⌕ Search games, systems, emulators, settings <span className="right kbd">Ctrl K</span>
          </button>
          {running.length > 0 && (
            <button className="btn ghost sm" onClick={() => navigate('/downloads')}><span className="spinner" /> {running[0].label}{running.length > 1 ? ` +${running.length - 1}` : ''}</button>
          )}
          <span className="right" />
          <NotificationsButton />
          {consoleMode && <button className="btn ghost" onClick={() => void api('app.setConsoleMode', false)}>Exit Console Mode</button>}
        </div>
        {props.children}
      </main>
      <CommandPalette />
      <Toasts />
    </div>
  );
}

function NotificationsButton() {
  const notifications = useStore((s) => s.notifications);
  const [open, setOpen] = useState(false);
  const unread = notifications.filter((n) => !n.read).length;
  return (
    <>
      <button className="btn ghost sm" onClick={() => setOpen(true)} aria-label="Notifications">🔔{unread > 0 && <span className="badge">{unread}</span>}</button>
      {open && (
        <Modal onClose={() => { setOpen(false); void api('notifications.markRead', 'all'); useStore.setState({ notifications: notifications.map((n) => ({ ...n, read: true })) }); }}>
          <div className="row"><h2>Notifications</h2></div>
          {notifications.length === 0 && <p className="muted">Nothing yet.</p>}
          <div className="list">
            {notifications.map((n) => (
              <button key={n.id} className="list-item" style={{ background: 'none', border: 0, color: 'inherit', font: 'inherit', textAlign: 'left', cursor: n.link ? 'pointer' : 'default' }} onClick={() => { if (n.link) { navigate(n.link); setOpen(false); } }}>
                <span className={`dot ${n.level === 'success' ? 'ok' : n.level === 'warning' ? 'warn' : n.level === 'error' ? 'bad' : ''}`} />
                <div className="grow">
                  <div style={{ fontWeight: n.read ? 400 : 650 }}>{n.title}</div>
                  <div className="small muted">{n.body}</div>
                </div>
                <span className="tiny faint">{new Date(n.at).toLocaleString()}</span>
              </button>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}

function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const setOpen = useStore((s) => s.setPalette);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const t = setTimeout(() => void api('app.search', q).then((r) => alive && setResults(r)).catch(() => undefined), 120);
    return () => { alive = false; clearTimeout(t); };
  }, [q, open]);
  if (!open) return null;
  const go = (r: SearchResult) => {
    setOpen(false);
    setQ('');
    navigate(r.route);
  };
  const icon = { game: '▦', system: '◎', emulator: '⚙', setting: '☰', page: '→' } as const;
  return (
    <div className="modal-backdrop" data-modal onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="palette">
        <input type="search" autoFocus placeholder="Search games, systems, emulators and settings…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); if (e.key === 'Enter' && results[0]) go(results[0]); }} />
        <div className="results">
          {q && results.length === 0 && <div className="muted small" style={{ padding: 12 }}>No matches.</div>}
          {results.map((r) => (
            <button key={`${r.kind}:${r.id}`} className="result" onClick={() => go(r)}>
              <span style={{ width: 20 }}>{icon[r.kind]}</span>
              <div className="grow"><div>{r.title}</div><div className="small faint">{r.subtitle}</div></div>
              <span className="chip">{r.kind}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`} onClick={() => dismiss(t.id)}>
          <strong>{t.title}</strong>
          {t.body && <div className="small muted">{t.body}</div>}
        </div>
      ))}
    </div>
  );
}
