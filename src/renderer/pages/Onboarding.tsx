// First-time setup: Welcome -> Computer scan -> Systems -> Game folder ->
// Controller -> Recommended configuration -> Install everything.

import { useEffect, useState } from 'react';
import type { OnboardingInstallPlan } from '@shared/ipc';
import type { HardwareProfile, ImportPreview, PerformancePreset } from '@shared/models';
import { getSystem, type SystemId } from '@shared/systems';
import { api } from '../lib/api';
import { describePad, pads } from '../lib/gamepad';
import { useStore } from '../lib/store';
import { Button, Chip, JobSteps, Panel, Segmented, Spinner } from '../components/ui';

const CHOICES: { id: SystemId; note?: string }[] = [
  { id: 'ps2' }, { id: 'gc' }, { id: 'wii' }, { id: 'ps3', note: 'planned' }, { id: 'psp', note: 'planned' }, { id: 'wiiu', note: 'planned' }, { id: 'x360', note: 'planned' }, { id: 'nds', note: 'planned' }, { id: 'ps1', note: 'planned' }, { id: 'snes', note: 'Retro (planned)' },
];
const STEPS = ['Welcome', 'Computer', 'Systems', 'Games', 'Controller', 'Configuration', 'Install'];

export function Onboarding(props: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [hw, setHw] = useState<HardwareProfile | null>(null);
  const [scanning, setScanning] = useState(false);
  const [systems, setSystems] = useState<SystemId[]>(['ps2', 'gc', 'wii']);
  const [folders, setFolders] = useState<ImportPreview[]>([]);
  const [preset, setPreset] = useState<PerformancePreset>('balanced');
  const [plan, setPlan] = useState<OnboardingInstallPlan | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useStore((s) => (jobId ? s.jobs[jobId] : undefined));
  const [, tick] = useState(0);
  const toast = useStore((s) => s.toast);

  useEffect(() => {
    if (step === 1 && !hw && !scanning) {
      setScanning(true);
      void api('hardware.scan').then((h) => { setHw(h); setPreset(h.recommendedPreset); }).finally(() => setScanning(false));
    }
    if (step === 4) {
      const t = setInterval(() => tick((x) => x + 1), 250);
      return () => clearInterval(t);
    }
    if (step === 5) void api('onboarding.plan', systems).then(setPlan);
  }, [step, hw, scanning, systems]);

  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));
  const prev = () => setStep((s) => Math.max(0, s - 1));
  const connected = step === 4 ? pads() : [];

  return (
    <div className="onboarding">
      <div className="frame">
        <div className="progress-dots">{STEPS.map((s, i) => <span key={s} className={i <= step ? 'on' : ''} title={s} />)}</div>
        {step === 0 && (
          <div className="col" style={{ gap: 18 }}>
            <div className="brand" style={{ padding: 0, fontSize: 22 }}><span className="brand-mark" />OmniDeck PC</div>
            <h1 style={{ fontSize: 44 }}>One place for all your games.</h1>
            <p className="muted" style={{ fontSize: 18, maxWidth: 720 }}>OmniDeck installs and configures emulators for you, organises your library with artwork, maps your controller once for everything, and diagnoses and repairs problems on its own.</p>
            <p className="small faint">You supply your own games and console BIOS files. OmniDeck never downloads games, BIOS, firmware or keys.</p>
            <div className="row"><Button variant="primary" size="big" onClick={next} autoFocus>Get started</Button><Button onClick={async () => { await api('app.settings.set', { onboardingComplete: true }); props.onDone(); }}>Skip setup</Button></div>
          </div>
        )}
        {step === 1 && (
          <Panel title="Scanning this PC">
            {!hw ? <div className="row"><Spinner /> Detecting CPU, GPU, memory, graphics APIs, displays and drives…</div> : (
              <dl className="kv">
                <dt>Windows</dt><dd>{hw.osName}</dd>
                <dt>CPU</dt><dd>{hw.cpu.model} ({hw.cpu.cores} cores / {hw.cpu.threads} threads) · {hw.cpu.features.join(', ') || 'features unknown'}</dd>
                <dt>Memory</dt><dd>{Math.round(hw.ramMB / 1024)} GB</dd>
                <dt>Graphics</dt><dd>{hw.gpus.map((g) => `${g.name}${g.vramMB ? ` (${Math.round(g.vramMB / 1024)} GB)` : ''}`).join(', ') || 'No GPU driver detected'}</dd>
                <dt>DirectX 12 / Vulkan</dt><dd>{String(hw.graphicsApis.directx12 ?? 'unknown')} / {String(hw.graphicsApis.vulkan ?? 'unknown')}</dd>
                <dt>Display</dt><dd>{hw.displays.map((d) => `${d.width}×${d.height}${d.refreshRate ? ` @ ${d.refreshRate} Hz` : ''}`).join(', ')}</dd>
                <dt>Storage</dt><dd>{hw.drives.map((d) => `${d.letter} ${d.freeBytes !== null ? Math.round(d.freeBytes / 1024 ** 3) + ' GB free' : ''}`).join(' · ')}</dd>
                <dt>Runtime</dt><dd>{hw.dependencies.map((d) => `${d.name}: ${d.installed === null ? 'unknown' : d.installed ? 'OK' : 'missing'}`).join(' · ')}</dd>
                <dt>Assessment</dt><dd><Chip tone="info">{hw.tier} tier</Chip> {hw.tierReason}</dd>
              </dl>
            )}
          </Panel>
        )}
        {step === 2 && (
          <div className="col">
            <h2>Which systems do you want to play?</h2>
            <p className="muted">PlayStation 2, GameCube and Wii are fully supported in this version. Others are shown so you know what's coming; they won't be installed yet.</p>
            <div className="grid cols-2">
              {CHOICES.map((c) => {
                const on = systems.includes(c.id);
                const s = getSystem(c.id)!;
                return (
                  <button key={c.id} className={`check-tile ${on ? 'on' : ''}`} onClick={() => setSystems(on ? systems.filter((x) => x !== c.id) : [...systems, c.id])}>
                    <span className="box">{on ? '✓' : ''}</span>
                    <div className="grow"><strong>{s.name}</strong><div className="small faint">{s.manufacturer}</div></div>
                    {c.note && <Chip tone="planned">{c.note}</Chip>}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {step === 3 && (
          <div className="col">
            <h2>Where are your games?</h2>
            <p className="muted">Choose one or more folders (for example D:\Emulation\Games). Sub-folders on any drive are scanned.</p>
            <div><Button variant="primary" onClick={async () => { const p = await api('app.pickFolder', 'Choose your games folder'); if (!p) return; try { const pv = await api('library.preview', p); await api('library.addPath', p); setFolders([...folders.filter((f) => f.path !== p), pv]); } catch (e) { toast('error', (e as Error).message); } }} autoFocus>Add folder…</Button></div>
            {folders.map((f) => <Panel key={f.path} flat title={f.path}><div className="row">{Object.entries(f.bySystem).map(([s, n]) => <Chip key={s}>{getSystem(s)?.shortName ?? s}: {n}</Chip>)}{f.total === 0 && <span className="muted small">No games recognised yet.</span>}</div></Panel>)}
            <p className="small faint">You can skip this and add folders later in the Library.</p>
          </div>
        )}
        {step === 4 && (
          <Panel title="Controller">
            {connected.length === 0 ? <p className="muted">No controller detected yet. Connect one and press any button. You can also continue with keyboard and mouse.</p> : connected.map((p) => <div key={p.index} className="row"><span className="dot ok" /><strong>{describePad(p).name}</strong><Chip>{describePad(p).api}</Chip><span className="small faint">Press buttons to test: {p.buttons.filter((b) => b.pressed).length ? 'input received ✓' : 'waiting…'}</span></div>)}
            <p className="small faint">OmniDeck creates a universal profile and maps it into PCSX2 and Dolphin automatically. Default exit combo: Select + Start.</p>
          </Panel>
        )}
        {step === 5 && (
          <div className="col">
            <h2>Recommended configuration</h2>
            <p className="muted">{hw ? `Based on your ${hw.tier}-tier PC (${hw.tierReason}).` : 'Based on defaults.'} You can change this any time.</p>
            <Segmented value={preset} onChange={setPreset} options={[{ value: 'performance', label: 'Performance' }, { value: 'balanced', label: 'Balanced' }, { value: 'quality', label: 'Quality' }, { value: 'maximum', label: 'Maximum' }]} />
            {!plan ? <Spinner /> : (
              <Panel title="OmniDeck will">
                {plan.emulators.map((e) => <div key={e.id} className="row"><span className={`dot ${e.implemented ? 'ok' : ''}`} /><strong>{e.name}</strong><span className="small muted">{e.note}</span></div>)}
                <div className="small muted">· Download each emulator from its official source and verify it · create folders and recommended settings · configure your controller and hotkeys · scan {plan.libraryPaths.length} game folder(s) · run a health check</div>
              </Panel>
            )}
          </div>
        )}
        {step === 6 && (
          <Panel title="Installing">
            {!job ? <Spinner /> : <JobSteps job={job} />}
            {job && job.state !== 'running' && job.state !== 'queued' && <div className="row"><Button variant="primary" size="big" onClick={props.onDone} autoFocus>{job.state === 'succeeded' ? 'Start playing' : 'Continue to OmniDeck'}</Button></div>}
          </Panel>
        )}
        {step > 0 && step < 6 && (
          <div className="row">
            <Button onClick={prev}>Back</Button>
            <span className="right" />
            {step < 5 && <Button variant="primary" onClick={next} disabled={step === 1 && !hw} autoFocus={step !== 3}>Continue</Button>}
            {step === 5 && <Button variant="primary" disabled={!plan} onClick={async () => { const r = await api('onboarding.run', { ...plan!, preset }); setJobId(r.jobId); next(); }} autoFocus>Install everything</Button>}
          </div>
        )}
      </div>
    </div>
  );
}
