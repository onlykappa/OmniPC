import { getSystem } from '@shared/systems';
import { api } from '../lib/api';
import { useAction, useLoad } from '../lib/hooks';
import { navigate } from '../lib/router';
import { useStore } from '../lib/store';
import { Button, Chip, Panel, Spinner, healthTone } from '../components/ui';

export function EmulatorsPage() {
  const v = useStore((s) => s.emulatorsVersion);
  const { data, reload } = useLoad(() => api('emulators.list'), [v]);
  const [check, checking] = useAction(async () => { await api('emulators.checkUpdates'); reload(); });
  const [install] = useAction((id: string) => api('emulators.install', id), { success: 'Installation started — see Downloads for progress' });
  const [update] = useAction((id: string) => api('emulators.update', id), { success: 'Update started' });
  const [updateAll] = useAction(() => api('emulators.updateAll'), { success: 'Updating all emulators' });
  if (!data) return <div className="page"><Spinner /></div>;
  const updates = data.filter((e) => e.updateAvailable);
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Emulators</h1><p>Installed, configured and kept healthy by OmniPC. You rarely need to open them directly.</p></div>
        <div className="row"><Button onClick={() => navigate('/bios')}>BIOS & Firmware</Button><Button busy={checking} onClick={() => void check()}>Check for updates</Button></div>
      </div>
      {updates.length > 0 && (
        <Panel title={`Updates available: ${updates.length}`} actions={<Button variant="primary" onClick={() => void updateAll()}>Update all</Button>}>
          <div className="row">{updates.map((u) => <Chip key={u.id} tone="info">{u.name} {u.version} → {u.latestVersion}</Chip>)}</div>
          <p className="small faint">Configuration is backed up before each update, a health test runs afterwards, and the previous version is kept for rollback.</p>
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
    </div>
  );
}
