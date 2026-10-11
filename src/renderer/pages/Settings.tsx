import { useEffect, useState } from 'react';
import type { AppSettings, AppUpdateState, SetupImportCandidate } from '@shared/models';
import { api, onEvent } from '../lib/api';
import { useLoad } from '../lib/hooks';
import { navigate } from '../lib/router';
import { useStore } from '../lib/store';
import { Button, Chip, Modal, Panel, ProgressBar, Segmented, Toggle } from '../components/ui';

export function SettingsPage() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const [q, setQ] = useState('');
  const { data: catalog } = useLoad(() => api('app.settings.catalog'), []);
  useEffect(() => {
    const hash = window.location.hash.split('#')[2];
    if (hash) setTimeout(() => document.getElementById(hash)?.scrollIntoView({ behavior: 'smooth' }), 100);
  }, []);
  if (!settings) return null;
  const set = async (patch: Partial<AppSettings>) => setSettings(await api('app.settings.set', patch));
  const matches = q.trim() ? (catalog ?? []).filter((c) => `${c.label} ${c.description} ${c.section} ${c.keywords.join(' ')}`.toLowerCase().includes(q.toLowerCase())) : [];
  return (
    <div className="page">
      <div className="page-head"><div><h1>Settings</h1></div><input type="search" placeholder="Search settings (e.g. controller, RPCS3, Vulkan)…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 420 }} /></div>
      {q.trim() && (
        <Panel title={`${matches.length} matching setting(s)`}>
          {matches.map((m) => <button key={m.key} className="list-item" style={{ background: 'none', border: 0, color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer' }} onClick={() => { setQ(''); if (m.route.startsWith('/settings#')) { document.getElementById(m.route.split('#')[1])?.scrollIntoView({ behavior: 'smooth' }); } else navigate(m.route); }}><div className="grow"><div>{m.label}</div><div className="small faint">{m.section} · {m.description}</div></div><span>→</span></button>)}
        </Panel>
      )}
      <div className="grid cols-2">
        <Panel id="interface" title="Interface">
          <Toggle label="Start in Console Mode" description="Fullscreen, controller-first interface." value={settings.consoleModeOnStart} onChange={(v) => set({ consoleModeOnStart: v })} />
          <Toggle label="Start with Windows" value={settings.startWithWindows} onChange={(v) => set({ startWithWindows: v })} />
          <Toggle label="Reduce motion" value={settings.reduceMotion} onChange={(v) => set({ reduceMotion: v })} />
        </Panel>
        <Panel id="graphics" title="Graphics">
          <div className="col"><span>Default quality preset for new configurations</span>
            <Segmented value={settings.defaultPreset} onChange={(p) => set({ defaultPreset: p })} options={[{ value: 'performance', label: 'Performance' }, { value: 'balanced', label: 'Balanced' }, { value: 'quality', label: 'Quality' }, { value: 'maximum', label: 'Maximum' }]} />
          </div>
          <p className="small faint">Per-emulator renderer and resolution live on each emulator's page; per-game overrides on each game's Settings tab.</p>
        </Panel>
        <Panel id="doctor" title="OmniDoctor">
          <Toggle label="Fix safe issues automatically" description="Only SAFE repairs (e.g. recreating an empty folder). Everything else asks first." value={settings.autoRepairSafeIssues} onChange={(v) => set({ autoRepairSafeIssues: v })} />
          <Toggle label="Background health checks" value={settings.backgroundHealthChecks} onChange={(v) => set({ backgroundHealthChecks: v })} />
          <label className="field">Crash-loop protection: pause after {settings.crashLoopThreshold} failures<input type="range" min={2} max={10} value={settings.crashLoopThreshold} onChange={(e) => set({ crashLoopThreshold: Number(e.target.value) })} /></label>
          <label className="field">Launch timeout warning: {settings.launchTimeoutSeconds} s<input type="range" min={5} max={120} value={settings.launchTimeoutSeconds} onChange={(e) => set({ launchTimeoutSeconds: Number(e.target.value) })} /></label>
          <div className="row"><Button onClick={() => navigate('/doctor/history')}>Repair history</Button><Button onClick={() => navigate('/bios')}>BIOS & Firmware</Button></div>
        </Panel>
        <Panel id="ai" title="AI troubleshooter (optional)">
          <p className="small muted">Off by default. When enabled, "Ask OmniDoctor" sends a redacted diagnostic summary (you can preview it) to the Anthropic API. ROMs, BIOS, saves and keys are never sent. All local diagnostics and repairs work without it.</p>
          <Toggle label="Enable AI troubleshooter" value={settings.aiEnabled} onChange={(v) => set({ aiEnabled: v, aiProvider: v ? 'anthropic' : 'none' })} />
          <label className="field">Anthropic API key<input type="password" value={settings.aiApiKey} onChange={(e) => set({ aiApiKey: e.target.value })} placeholder="sk-ant-…" /></label>
          <label className="field">Model<input type="text" value={settings.aiModel} onChange={(e) => set({ aiModel: e.target.value })} /></label>
        </Panel>
        <Panel id="library" title="Library & metadata">
          <Toggle label="Online metadata & artwork" description="Fetched once, cached locally. The library works fully offline." value={settings.metadataOnline} onChange={(v) => set({ metadataOnline: v })} />
          {[['local-files', 'Artwork next to your games (offline)'], ['emulator-databases', "Titles & compatibility from PCSX2/Dolphin's bundled databases (offline)"], ['gametdb', 'GameTDB covers for GameCube/Wii (art.gametdb.com)'], ['ps2-covers', 'PS2 covers from the community xlenore/ps2-covers repository'], ['switch-titledb', 'Switch icons, banners, screenshots & descriptions (eShop listings via titledb; downloads a ~90 MB list once a month when you have Switch games)'], ['xbox-marketplace', 'Xbox 360 box art from the Xbox Marketplace image service'], ['libretro-thumbnails', 'Box art & screenshots for all systems (libretro-thumbnails on GitHub, no account needed)']].map(([id, label]) => (
            <Toggle key={id} label={label} value={settings.artworkProviders.includes(id)} onChange={(v) => set({ artworkProviders: v ? [...settings.artworkProviders, id] : settings.artworkProviders.filter((x) => x !== id) })} />
          ))}
          <label className="field">TheGamesDB API key (optional, for descriptions)<input type="password" value={settings.theGamesDbApiKey} onChange={(e) => set({ theGamesDbApiKey: e.target.value })} /></label>
          <p className="small faint">Box art and screenshots work without a key. For descriptions, release year and player counts, request a free personal API key on the TheGamesDB forum (forums.thegamesdb.net) and paste it here, then click "Refresh all metadata".</p>
          <div className="row"><Button onClick={() => void api('metadata.refreshAll')}>Refresh all metadata</Button><Button onClick={() => navigate('/storage')}>Storage</Button></div>
        </Panel>
        <Panel id="updates" title="Updates">
          <AppUpdateSection autoCheck={settings.checkAppUpdatesOnStart} onAutoCheck={(v) => void set({ checkAppUpdatesOnStart: v })} />
          <div className="col"><span>Emulator update channel</span><Segmented value={settings.updateChannel} onChange={(v) => set({ updateChannel: v })} options={[{ value: 'stable', label: 'Stable' }, { value: 'nightly', label: 'Nightly / development' }]} /></div>
          <Toggle label="Check for emulator updates at startup" value={settings.checkUpdatesOnStart} onChange={(v) => set({ checkUpdatesOnStart: v })} />
          <Toggle label="Install emulator updates automatically" description="At startup and every 6 hours, never while a game is running. Each update backs up the configuration and is health-tested; if the test fails, the previous version is restored automatically." value={settings.autoUpdateEmulators} onChange={(v) => set({ autoUpdateEmulators: v })} />
          <p className="small faint">OmniPC updates itself from its official GitHub releases (the download is checked against the published SHA-512). Emulators never update without a configuration backup and a health test. Your library, settings, emulators and saves live outside the program folder and are kept.</p>
        </Panel>
        <ImportPanel />
        <ResetPanel />
        <Panel id="advanced" title="Advanced">
          <Toggle label="Developer mode" description="Adds the Developer page (adapter status, raw checks, launch commands, logs)." value={settings.devMode} onChange={(v) => set({ devMode: v })} />
          <div className="row"><Button onClick={() => void api('app.relaunch', { safeMode: true })}>Restart in Safe Mode</Button><Button onClick={() => void api('app.relaunch', { safeMode: false })}>Restart normally</Button></div>
          <p className="small faint">Optional integrations — Steam shortcuts and EmulationStation-DE — are not implemented in this version.</p>
        </Panel>
      </div>
    </div>
  );
}

function ImportPanel() {
  const [candidates, setCandidates] = useState<SetupImportCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<SetupImportCandidate | null>(null);
  const [summary, setSummary] = useState<string[] | null>(null);
  const [what, setWhat] = useState({ settings: true, saves: true, bios: true, romPaths: true, useInstallation: false });
  return (
    <Panel id="import" title="Import existing setup">
      <p className="small muted">Detects PCSX2, Dolphin and EmuDeck (Windows) setups. OmniPC copies what you choose and never modifies the original.</p>
      <Button busy={busy} onClick={async () => { setBusy(true); try { setCandidates(await api('import.detect')); } finally { setBusy(false); } }}>Detect existing setups</Button>
      {candidates && candidates.length === 0 && <p className="muted">Nothing found.</p>}
      {candidates?.map((c) => (
        <div key={c.id} className="list-item"><div className="grow"><div>{c.label}</div><div className="tiny faint">{c.details.join(' · ')}</div></div><Button size="sm" onClick={() => { setSel(c); setWhat({ settings: c.importable.settings, saves: c.importable.saves, bios: c.importable.bios, romPaths: c.importable.romPaths, useInstallation: false }); setSummary(null); }}>Import…</Button></div>
      ))}
      {sel && (
        <Modal onClose={() => setSel(null)}>
          <h2>Import from {sel.label}</h2>
          {(['settings', 'saves', 'bios', 'romPaths', 'useInstallation'] as const).map((k) => (
            <label key={k} className="row" style={{ opacity: sel.importable[k] ? 1 : 0.4 }}><input type="checkbox" disabled={!sel.importable[k]} checked={what[k] && sel.importable[k]} onChange={(e) => setWhat({ ...what, [k]: e.target.checked })} />{{ settings: 'Import settings (resolution)', saves: 'Copy saves', bios: 'Copy BIOS files', romPaths: 'Add game folders', useInstallation: 'Use this existing installation' }[k]}</label>
          ))}
          {summary && <pre>{summary.join('\n')}</pre>}
          <div className="row right"><Button onClick={() => setSel(null)}>Close</Button>{!summary && <Button variant="primary" onClick={async () => setSummary((await api('import.apply', sel.id, what)).summary)}>Import</Button>}</div>
        </Modal>
      )}
    </Panel>
  );
}

function ResetPanel() {
  const [confirm, setConfirm] = useState<null | { kind: 'settings' | 'emulator-configs' | 'repair-installation' | 'complete'; title: string; body: string }>(null);
  const [result, setResult] = useState<string[] | null>(null);
  const toast = useStore((s) => s.toast);
  const options = [
    { kind: 'settings' as const, title: 'Reset Settings', body: 'Resets OmniPC preferences to defaults. Library, emulators, saves and games are kept.' },
    { kind: 'emulator-configs' as const, title: 'Reset Emulator Configurations', body: 'Backs up and regenerates recommended configuration for every installed emulator. Saves, BIOS and games are kept.' },
    { kind: 'repair-installation' as const, title: 'Repair Installation', body: 'Re-applies OmniPC folders and settings to every emulator, recreates folders and rebuilds database indexes.' },
    { kind: 'complete' as const, title: 'Complete OmniPC Reset', body: 'Resets settings and emulator configurations, clears the library database records and artwork cache, and restarts onboarding. PRESERVED: your game files, saves, BIOS files, emulator installations and all backups.' },
  ];
  return (
    <Panel id="reset" title="Reset & repair">
      {options.map((o) => <div key={o.kind} className="list-item"><div className="grow"><div>{o.title}</div><div className="small faint">{o.body}</div></div><Button size="sm" variant={o.kind === 'complete' ? 'danger' : undefined} onClick={() => setConfirm(o)}>{o.title.split(' ')[0]}</Button></div>)}
      {confirm && (
        <Modal onClose={() => { setConfirm(null); setResult(null); }}>
          <h2>{confirm.title}</h2>
          <p>{confirm.body}</p>
          {result && <pre>{result.join('\n')}</pre>}
          <div className="row right"><Button onClick={() => { setConfirm(null); setResult(null); }}>Close</Button>{!result && <Button variant={confirm.kind === 'complete' ? 'danger' : 'primary'} onClick={async () => { try { const r = await api('app.factoryReset', confirm.kind); setResult(r.summary); if (confirm.kind === 'complete') setTimeout(() => window.location.reload(), 2500); } catch (e) { toast('error', (e as Error).message); } }}>Confirm</Button>}</div>
        </Modal>
      )}
      <Chip>Games and saves are always preserved</Chip>
    </Panel>
  );
}

/** OmniPC self-update plus a one-click "Update everything" (app + all emulators). */
function AppUpdateSection(props: { autoCheck: boolean; onAutoCheck: (v: boolean) => void }) {
  const [st, setSt] = useState<AppUpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const toast = useStore((s) => s.toast);
  useEffect(() => {
    void api('app.update.state').then(setSt);
    return onEvent('app.update', setSt);
  }, []);
  if (!st) return null;
  const supported = st.status !== 'unsupported';
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setMsg(null);
    try { await fn(); } finally { setBusy(false); }
  };
  const updateEverything = () => run(async () => {
    await api('emulators.checkAndUpdateAll');
    toast('info', 'Updating emulators', 'Anything newer is installed; progress is under Downloads.');
    if (!supported) return;
    let s = await api('app.update.check');
    if (s.status === 'available') s = await api('app.update.download');
    if (s.status === 'ready') setMsg(`OmniPC ${s.latestVersion} is downloaded. Click "Restart to update" when you're ready.`);
  });
  const restart = async () => {
    const r = await api('app.update.install');
    if (!r.ok) setMsg(r.reason);
  };
  const line =
    st.status === 'unsupported' ? st.unsupportedReason
    : st.status === 'checking' ? 'Checking GitHub for a newer OmniPC…'
    : st.status === 'up-to-date' ? `You have the latest version (${st.currentVersion}).`
    : st.status === 'available' ? `OmniPC ${st.latestVersion} is available (you have ${st.currentVersion}).`
    : st.status === 'downloading' ? `Downloading OmniPC ${st.latestVersion}… ${st.percent ?? 0}%`
    : st.status === 'ready' ? `OmniPC ${st.latestVersion} is ready. Restart to finish updating.`
    : st.status === 'error' ? `Update check failed: ${st.error}`
    : `OmniPC ${st.currentVersion}`;
  return (
    <div className="col">
      <div className="row"><span><b>OmniPC {st.currentVersion}</b></span>{st.status === 'available' && <Chip tone="info">Update available</Chip>}{st.status === 'ready' && <Chip tone="ok">Ready to install</Chip>}</div>
      <p className="small muted">{line}</p>
      {st.status === 'downloading' && <ProgressBar value={st.percent !== null ? st.percent / 100 : null} />}
      {st.status === 'available' && st.notes && <details className="small"><summary>What's new in {st.latestVersion}</summary><pre className="small" style={{ whiteSpace: 'pre-wrap' }}>{st.notes}</pre></details>}
      <div className="row">
        <Button variant="primary" busy={busy} onClick={() => void updateEverything()} title="Checks OmniPC and every installed emulator, and installs anything newer">Update everything</Button>
        {supported && (st.status === 'idle' || st.status === 'up-to-date' || st.status === 'error') && <Button busy={busy} onClick={() => void run(() => api('app.update.check'))}>Check for OmniPC updates</Button>}
        {st.status === 'available' && <Button onClick={() => void run(() => api('app.update.download'))}>Download {st.latestVersion}</Button>}
        {st.status === 'ready' && <Button variant="primary" onClick={() => void restart()}>Restart to update</Button>}
      </div>
      {msg && <p className="small">{msg}</p>}
      {supported && <Toggle label="Check for OmniPC updates at startup" description="Only checks and notifies; downloading and installing stay one click. Your library, settings, emulators and saves are kept." value={props.autoCheck} onChange={props.onAutoCheck} />}
    </div>
  );
}
