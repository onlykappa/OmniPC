import { useEffect, useState } from 'react';
import type { AppSettings, SetupImportCandidate } from '@shared/models';
import { api } from '../lib/api';
import { useLoad } from '../lib/hooks';
import { navigate } from '../lib/router';
import { useStore } from '../lib/store';
import { Button, Chip, Modal, Panel, Segmented, Toggle } from '../components/ui';

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
          {[['local-files', 'Artwork next to your games (offline)'], ['emulator-databases', "Titles & compatibility from PCSX2/Dolphin's bundled databases (offline)"], ['gametdb', 'GameTDB covers for GameCube/Wii (art.gametdb.com)'], ['ps2-covers', 'PS2 covers from the community xlenore/ps2-covers repository']].map(([id, label]) => (
            <Toggle key={id} label={label} value={settings.artworkProviders.includes(id)} onChange={(v) => set({ artworkProviders: v ? [...settings.artworkProviders, id] : settings.artworkProviders.filter((x) => x !== id) })} />
          ))}
          <label className="field">TheGamesDB API key (optional, for descriptions)<input type="password" value={settings.theGamesDbApiKey} onChange={(e) => set({ theGamesDbApiKey: e.target.value })} /></label>
          <div className="row"><Button onClick={() => void api('metadata.refreshAll')}>Refresh all metadata</Button><Button onClick={() => navigate('/storage')}>Storage</Button></div>
        </Panel>
        <Panel id="updates" title="Updates">
          <div className="col"><span>Emulator update channel</span><Segmented value={settings.updateChannel} onChange={(v) => set({ updateChannel: v })} options={[{ value: 'stable', label: 'Stable' }, { value: 'nightly', label: 'Nightly / development' }]} /></div>
          <Toggle label="Check for updates at startup" value={settings.checkUpdatesOnStart} onChange={(v) => set({ checkUpdatesOnStart: v })} />
          <p className="small faint">OmniDeck app updates: this version uses manual updates (download the new installer). Emulators never auto-update without a backup and health test.</p>
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
      <p className="small muted">Detects PCSX2, Dolphin and EmuDeck (Windows) setups. OmniDeck copies what you choose and never modifies the original.</p>
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
    { kind: 'settings' as const, title: 'Reset Settings', body: 'Resets OmniDeck preferences to defaults. Library, emulators, saves and games are kept.' },
    { kind: 'emulator-configs' as const, title: 'Reset Emulator Configurations', body: 'Backs up and regenerates recommended configuration for every installed emulator. Saves, BIOS and games are kept.' },
    { kind: 'repair-installation' as const, title: 'Repair Installation', body: 'Re-applies OmniDeck folders and settings to every emulator, recreates folders and rebuilds database indexes.' },
    { kind: 'complete' as const, title: 'Complete OmniDeck Reset', body: 'Resets settings and emulator configurations, clears the library database records and artwork cache, and restarts onboarding. PRESERVED: your game files, saves, BIOS files, emulator installations and all backups.' },
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
