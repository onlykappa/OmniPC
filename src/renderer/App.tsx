import { useEffect, useState } from 'react';
import { api, hasBridge, onEvent } from './lib/api';
import { back, navigate, useRoute } from './lib/router';
import { bootstrapStore, useStore } from './lib/store';
import { startGamepadLoop } from './lib/gamepad';
import { moveFocus } from './lib/spatial';
import { Layout, navPaths } from './components/Layout';
import { HomePage } from './pages/Home';
import { DuplicatesPage, LibraryPage } from './pages/Library';
import { GameDetailsPage } from './pages/GameDetails';
import { SystemsPage } from './pages/Systems';
import { EmulatorsPage } from './pages/Emulators';
import { EmulatorDetailsPage } from './pages/EmulatorDetails';
import { ControllersPage } from './pages/Controllers';
import { BiosPage } from './pages/Bios';
import { DownloadsPage } from './pages/Downloads';
import { AskPage, DoctorPage, FindingPage, RepairHistoryPage } from './pages/Doctor';
import { StoragePage } from './pages/Storage';
import { SettingsPage } from './pages/Settings';
import { AboutPage } from './pages/About';
import { DevPage } from './pages/Dev';
import { FailurePage } from './pages/Failure';
import { Onboarding } from './pages/Onboarding';
import { Spinner } from './components/ui';

function Router() {
  const r = useRoute();
  const [a, b, c] = r.parts;
  switch (a) {
    case 'library': return b === 'duplicates' ? <DuplicatesPage /> : <LibraryPage />;
    case 'game': return <GameDetailsPage key={b} id={Number(b)} />;
    case 'systems': return <SystemsPage />;
    case 'emulators': return b ? <EmulatorDetailsPage key={b} id={b} /> : <EmulatorsPage />;
    case 'controllers': return <ControllersPage />;
    case 'bios': return <BiosPage />;
    case 'downloads': return <DownloadsPage />;
    case 'doctor':
      if (b === 'finding') return <FindingPage id={decodeURIComponent(c ?? '')} />;
      if (b === 'history') return <RepairHistoryPage />;
      if (b === 'ask') return <AskPage />;
      return <DoctorPage />;
    case 'failure': return <FailurePage key={b} launchId={Number(b)} />;
    case 'storage': case 'saves': return <StoragePage />;
    case 'settings': return <SettingsPage />;
    case 'about': return <AboutPage />;
    case 'dev': return <DevPage />;
    default: return <HomePage />;
  }
}

export function App() {
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [health, setHealth] = useState({ problems: 0, warnings: 0 });
  const settings = useStore((s) => s.settings);
  const route = useRoute();

  useEffect(() => {
    if (!hasBridge()) {
      setFatal('The OmniPC backend is not available. Start the app through Electron (npm run dev).');
      return;
    }
    void bootstrapStore().then(() => setReady(true)).catch((e) => setFatal(String(e?.message ?? e)));
    void api('doctor.latest').then((r) => r && setHealth({ problems: r.counts.problems, warnings: r.counts.warnings }));
    const offs = [
      onEvent('doctor.report', (r) => r.scope !== 'emulator' && setHealth({ problems: r.counts.problems, warnings: r.counts.warnings })),
      // A crashed or failed session goes straight to failure recovery, never silently back to the library.
      onEvent('launch.ended', (e) => { if (e.needsAnalysis) navigate(`/failure/${e.launchId}`); }),
    ];
    return () => offs.forEach((o) => o());
  }, []);

  useEffect(() => {
    document.body.classList.toggle('reduce-motion', !!settings?.reduceMotion);
  }, [settings?.reduceMotion]);

  // Controller + keyboard navigation.
  useEffect(() => {
    const tab = (delta: number) => {
      const paths = navPaths(!!useStore.getState().settings?.devMode);
      const i = Math.max(0, paths.indexOf('/' + (window.location.hash.split('/')[1]?.split('?')[0] ?? 'home')));
      navigate(paths[(i + delta + paths.length) % paths.length]);
    };
    const stop = startGamepadLoop({
      back: () => {
        if (useStore.getState().paletteOpen) return useStore.getState().setPalette(false);
        const esc = new KeyboardEvent('keydown', { key: 'Escape' });
        if (document.querySelector('[data-modal]')) return void window.dispatchEvent(esc);
        back();
      },
      search: () => useStore.getState().setPalette(true),
      menu: () => navigate('/home'),
      tab,
      report: (list) => void api('controllers.reportGamepads', list).catch(() => undefined),
    });
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
      const dirs: Record<string, 'up' | 'down' | 'left' | 'right'> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
      if (dirs[e.key]) {
        e.preventDefault();
        moveFocus(dirs[e.key]);
      } else if (e.key === 'Backspace' && !document.querySelector('[data-modal]')) back();
    };
    window.addEventListener('keydown', onKey);
    return () => { stop(); window.removeEventListener('keydown', onKey); };
  }, []);

  if (fatal) return <div className="onboarding"><div className="frame"><h1>OmniPC could not start</h1><p className="muted">{fatal}</p></div></div>;
  if (!ready || !settings) return <div className="onboarding"><Spinner /></div>;
  if (!settings.onboardingComplete && route.parts[0] !== 'settings') return <Onboarding onDone={async () => { useStore.getState().setSettings(await api('app.settings.get')); navigate('/home'); }} />;
  return <Layout health={health}><Router /></Layout>;
}
