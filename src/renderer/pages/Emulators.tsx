import { getSystem } from '@shared/systems';
import { api } from '../lib/api';
import { useAction, useLoad } from '../lib/hooks';
import { navigate } from '../lib/router';
import { useStore } from '../lib/store';
import { useState } from 'react';
import type { OptimizeSuggestion } from '@shared/emulatorSettings';
import { Button, Chip, Modal, Panel, Spinner, healthTone } from '../components/ui';

export function EmulatorsPage() {
  const v = useStore((s) => s.emulatorsVersion);
  const { data, reload } = useLoad(() => api('emulators.list'), [v]);
  const [check, checking] = useAction(async () => { await api('emulators.checkUpdates'); reload(); });
  const [install] = useAction((id: string) => api('emulators.install', id), { success: 'Installation started — see Downloads for progress' });
  const [update] = useAction((id: string) => api('emulators.update', id), { success: 'Update started' });
  const [updateAll] = useAction(() => api('emulators.updateAll'), { success: 'Updating all emulators' });
  const [checkAndUpdate, checkingAndUpdating] = useAction(() => api('emulators.checkAndUpdateAll'), { success: 'Checking for updates — anything newer is installed automatically (see Downloads for progress)' });
  const anyInstalled = (data ?? []).some((e) => e.installState === 'installed');
  const [optimizing, setOptimizing] = useState<{ emulatorId: string; name: string; suggestions: OptimizeSuggestion[] }[] | null>(null);
  const toast = useStore((s) => s.toast);
  if (!data) return <div className="page"><Spinner /></div>;
  const updates = data.filter((e) => e.updateAvailable);
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Emulators</h1><p>Installed, configured and kept healthy by OmniPC. You rarely need to open them directly.</p></div>
        <div className="row"><Button onClick={() => navigate('/bios')}>BIOS & Firmware</Button><Button disabled={!anyInstalled} onClick={async () => setOptimizing(await api('emulators.optimizeAllPreview'))}>Optimize all for my PC</Button><Button busy={checking} onClick={() => void check()}>Check only</Button><Button variant="primary" busy={checkingAndUpdating} disabled={!anyInstalled} title={anyInstalled ? 'Checks every installed emulator and installs newer versions. Failed updates are rolled back automatically.' : 'Install an emulator first'} onClick={() => void checkAndUpdate()}>Check & update all</Button></div>
      </div>
      {updates.length > 0 && (
        <Panel title={`Updates available: ${updates.length}`} actions={<Button variant="primary" onClick={() => void updateAll()}>Update all</Button>}>
          <div className="row">{updates.map((u) => <Chip key={u.id} tone="info">{u.name} {u.version} → {u.latestVersion}</Chip>)}</div>
          <p className="small faint">Configuration is backed up before each update and a health test runs afterwards. With "Check & update all", an update that fails its health test is rolled back automatically.</p>
        </Panel>
      )}
      <div className="grid cols-auto" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
        {data.map((e) => (
          <div key={e.id} className="card emu-card">
            <div className="row"><h3>{e.name}</h3><span className="right" />{!e.implemented ? <Chip tone="planned">Planned</Chip> : e.installState === 'not_installed' ? <Chip>Not installed</Chip> : <Chip tone={healthTone(e.health)}>{e.health === 'ready' ? 'Healthy' : e.health === 'error' ? 'Needs attention' : e.health === 'unknown' ? 'Not tested' : e.health}</Chip>}</div>
            <div className="small muted">{e.systems.map((s) => getSystem(s)?.name).join(' · ')}</div>
            {e.installState !== 'not_installed' && <div className="small">Version {e.version ?? 'unknown'}{e.installState === 'external' ? ' · existing installation' : ''}{e.customConfig ? ' · custom configuration active' : ''}</div>}
            {e.healthNote && <div className="small" style={{ color: 'var(--warn)' }}>{e.healthNote}</div>}
            {!e.implemented && <div className="small faint">{e.plannedNote}</div>}
            <div className="row">
              {e.implemented && e.installState === 'not_installed' && <Button variant="primary" onClick={() => void install(e.id)}>Install</Button>}
              {e.updateAvailable && <Button variant="primary" onClick={() => void update(e.id)}>Update to {e.latestVersion}</Button>}
              {e.installState !== 'not_installed' && <Button onClick={() => void api('emulators.launchUi', e.id)}>Launch</Button>}
              <Button variant="ghost" onClick={() => navigate(`/emulators/${e.id}`)}>{e.installState !== 'not_installed' ? 'Configure' : 'Details'}</Button>
            </div>
          </div>
        ))}
      </div>
      {optimizing && <OptimizeAllModal items={optimizing} onClose={() => setOptimizing(null)} onApply={async (ids) => { const r = await api('emulators.optimizeAllApply', ids); setOptimizing(null); toast('success', `Optimized ${r.length} emulator${r.length === 1 ? '' : 's'} for this PC`, 'Each configuration was backed up first and can be restored from the emulator page.'); reload(); }} />}
    </div>
  );
}

function OptimizeAllModal(props: { items: { emulatorId: string; name: string; suggestions: OptimizeSuggestion[] }[]; onClose: () => void; onApply: (ids: string[]) => Promise<void> }) {
  const [picked, setPicked] = useState(() => new Set(props.items.map((i) => i.emulatorId)));
  const [busy, setBusy] = useState(false);
  return (
    <Modal onClose={props.onClose} wide>
      <h2>Optimize all emulators for this PC</h2>
      {props.items.length === 0 ? <p className="muted">Every installed emulator already uses the recommended settings for your hardware.</p> : (
        <>
          <p className="small muted">Based on your graphics card, processor and memory. Each emulator's configuration is backed up first; untick any emulator you want to leave alone.</p>
          {props.items.map((i) => (
            <label key={i.emulatorId} className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
              <input type="checkbox" checked={picked.has(i.emulatorId)} onChange={(e) => { const n = new Set(picked); if (e.target.checked) n.add(i.emulatorId); else n.delete(i.emulatorId); setPicked(n); }} />
              <span className="col" style={{ gap: 2 }}>
                <strong>{i.name}</strong>
                {i.suggestions.map((s) => <span key={s.field} className="small muted">{s.label}: {s.from} → {s.to}</span>)}
              </span>
            </label>
          ))}
        </>
      )}
      <div className="row right">
        <Button onClick={props.onClose}>Close</Button>
        {props.items.length > 0 && <Button variant="primary" busy={busy} disabled={!picked.size} onClick={async () => { setBusy(true); try { await props.onApply([...picked]); } finally { setBusy(false); } }}>Optimize {picked.size}</Button>}
      </div>
    </Modal>
  );
}
