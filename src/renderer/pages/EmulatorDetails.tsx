import { useEffect, useState } from 'react';
import type { ConfigDiff, CustomEmulatorSettings, EmulatorSettings, HealthReport, RendererOption } from '@shared/models';
import { getSystem } from '@shared/systems';
import { api } from '../lib/api';
import { useAction, useLoad } from '../lib/hooks';
import { navigate } from '../lib/router';
import { useStore } from '../lib/store';
import { SettingsEditor } from '../components/SettingsEditor';
import { Button, Chip, Modal, Panel, SevIcon, Spinner, Toggle, healthTone } from '../components/ui';
import { RepairButton } from '../components/RepairButton';
import { bytes, clock } from '../lib/format';

export function EmulatorDetailsPage(props: { id: string }) {
  const v = useStore((s) => s.emulatorsVersion);
  const { data: emu, reload } = useLoad(() => api('emulators.details', props.id), [props.id, v]);
  const [renderers, setRenderers] = useState<RendererOption[]>([]);
  const [settings, setSettings] = useState<EmulatorSettings | null>(null);
  const [custom, setCustom] = useState<CustomEmulatorSettings | null>(null);
  const [report, setReport] = useState<HealthReport | null>(null);
  const [diff, setDiff] = useState<ConfigDiff | null>(null);
  const [confirm, setConfirm] = useState<null | { title: string; body: string; run: () => Promise<unknown> }>(null);
  const toast = useStore((s) => s.toast);
  useEffect(() => {
    void api('emulators.renderers', props.id).then(setRenderers).catch(() => setRenderers([]));
  }, [props.id]);
  useEffect(() => {
    if (emu) {
      setSettings(emu.settings);
      setCustom(emu.customSettings);
    }
  }, [emu]);
  const [save, saving] = useAction(async () => { if (settings) { await api('emulators.saveSettings', props.id, settings); reload(); } }, { success: 'Settings applied (previous configuration backed up)' });
  const [saveCustom, savingCustom] = useAction(async () => { if (custom) { await api('emulators.saveCustom', props.id, custom); reload(); } }, { success: 'Advanced settings saved' });
  const [health, checking] = useAction(async () => setReport(await api('emulators.healthCheck', props.id)));
  if (!emu || !settings || !custom) return <div className="page"><Spinner /></div>;
  const installed = emu.installState !== 'not_installed';
  const job = (fn: () => Promise<{ jobId: string }>, msg: string) => async () => { await fn(); toast('info', msg, 'Progress is shown in Downloads.'); };
  const caps = { aspectRatios: emu.id === 'dolphin' ? [{ id: 'auto', label: 'Auto' }, { id: '16:9', label: 'Force 16:9' }, { id: '4:3', label: 'Force 4:3' }, { id: 'stretch', label: 'Stretch' }] : [{ id: 'auto', label: 'Auto (4:3/3:2)' }, { id: '4:3', label: '4:3' }, { id: '16:9', label: '16:9' }, { id: 'stretch', label: 'Stretch' }], frameLimit: emu.id === 'dolphin', vsync: true, maxScale: 8 };
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="row"><h1>{emu.name}</h1>{!emu.implemented ? <Chip tone="planned">Planned</Chip> : installed ? <Chip tone={healthTone(emu.health)}>{emu.health}</Chip> : <Chip>Not installed</Chip>}{emu.customConfig && <Chip tone="info">Custom configuration active</Chip>}</div>
          <p>{emu.systems.map((s) => getSystem(s)?.name).join(' · ')} · {emu.license} · <a href="#" onClick={(e) => { e.preventDefault(); void api('app.openExternal', emu.website); }}>{emu.website}</a></p>
        </div>
        <div className="row"><Button onClick={() => navigate('/emulators')}>All emulators</Button></div>
      </div>
      {!emu.implemented && <Panel title="Not available yet"><p>{emu.plannedNote}</p></Panel>}
      {emu.implemented && (
        <Panel title={installed ? `Version ${emu.version ?? 'unknown'}` : 'Not installed'} actions={!installed ? <Button variant="primary" onClick={job(() => api('emulators.install', emu.id), `Installing ${emu.name}`)}>Install {emu.name}</Button> : undefined}>
          {installed && (
            <div className="row">
              <Button variant="primary" onClick={() => void api('emulators.launchUi', emu.id)}>Launch</Button>
              <Button onClick={() => { const el = document.getElementById('settings'); el?.scrollIntoView({ behavior: 'smooth' }); }}>Configure</Button>
              <Button disabled={!emu.updateAvailable || emu.installState !== 'installed'} title={emu.installState !== 'installed' ? 'External installations are updated outside OmniDeck' : undefined} onClick={job(() => api('emulators.update', emu.id), `Updating ${emu.name}`)}>{emu.updateAvailable ? `Update to ${emu.latestVersion}` : 'Up to date'}</Button>
              <Button onClick={job(() => api('emulators.repair', emu.id), `Repairing ${emu.name}`)}>Repair</Button>
              <Button onClick={() => setConfirm({ title: `Reset ${emu.name} configuration?`, body: 'OmniDeck backs up the current configuration, then generates recommended defaults for this PC, re-applies your controller profile, hotkeys and OmniDeck folders, and runs a health test. Saves, BIOS files and games are not touched.', run: () => api('emulators.resetConfig', emu.id) })}>Reset configuration</Button>
              <Button onClick={() => void api('app.openPath', emu.installDir ?? '')} disabled={!emu.installDir}>Open folder</Button>
              <Button busy={checking} onClick={() => void health()}>Health check</Button>
              {emu.rollbackVersion && <Button onClick={() => setConfirm({ title: `Restore ${emu.name} ${emu.rollbackVersion}?`, body: 'The current version is moved aside and the previous version is restored together with the configuration from before the update.', run: () => api('emulators.rollback', emu.id) })}>Roll back to {emu.rollbackVersion}</Button>}
              {emu.installState === 'installed' && <Button variant="danger" onClick={() => setConfirm({ title: `Uninstall ${emu.name}?`, body: 'Program files are removed. Settings, saves and BIOS files are kept so reinstalling restores everything.', run: () => api('emulators.uninstall', emu.id) })}>Uninstall</Button>}
            </div>
          )}
          {!installed && <div className="row"><Button onClick={async () => { const exe = await api('app.pickFile', `Choose ${emu.manifest.executable}`, ['exe']); if (exe) { await api('emulators.useExisting', emu.id, exe); reload(); } }}>Use an existing installation…</Button></div>}
          {emu.healthNote && <p className="small" style={{ color: 'var(--warn)' }}>{emu.healthNote}</p>}
        </Panel>
      )}
      {report && (
        <Panel title={`Health check: ${report.overall}%`}>
          {report.findings.map((f) => <div key={f.id} className="finding"><SevIcon severity={f.severity} /><div className="grow"><strong>{f.title}</strong>{f.detail && <div className="small muted">{f.detail}</div>}</div>{f.repair && <RepairButton suggestion={f.repair} onDone={() => void health()} />}</div>)}
        </Panel>
      )}
      {emu.implemented && (
        <div className="grid cols-2">
          <Panel id="settings" title="Settings" actions={<Button variant="primary" busy={saving} onClick={() => void save()}>Apply</Button>}>
            <SettingsEditor value={settings} renderers={renderers} caps={caps} onChange={(s) => setSettings({ ...settings, ...s } as EmulatorSettings)} />
          </Panel>
          <div className="col" style={{ gap: 16 }}>
            <Panel title="Configuration backups" actions={<Button size="sm" onClick={async () => { await api('backups.create', emu.id, 'Manual backup'); reload(); }} disabled={!installed}>Back up now</Button>}>
              {emu.backups.length === 0 ? <p className="muted">No backups yet. OmniDeck creates one automatically before every change.</p> : (
                <div className="list">
                  <div className="list-item"><strong className="grow">Current</strong></div>
                  {emu.backups.slice(0, 12).map((b) => (
                    <div key={b.id} className="list-item">
                      <div className="grow"><div>{b.label}</div><div className="tiny faint">{clock(b.createdAt)} · {b.files.length} file(s) · {bytes(b.sizeBytes)}</div></div>
                      <Button size="sm" onClick={async () => setDiff(await api('backups.diff', b.id))}>Compare</Button>
                      <Button size="sm" onClick={() => setConfirm({ title: 'Restore this backup?', body: `Restores "${b.label}". The current configuration is backed up first.`, run: () => api('backups.restore', b.id) })}>Restore</Button>
                      <Button size="sm" variant="ghost" onClick={async () => { await api('backups.delete', b.id); reload(); }}>Delete</Button>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
            <Panel title="Files">
              {[...emu.configFiles.map((f) => ({ ...f, kind: 'Config' })), ...emu.logFiles.map((f) => ({ ...f, kind: 'Log' })), ...emu.saveDirs.map((f) => ({ ...f, kind: 'Saves' }))].map((f) => (
                <div key={f.path} className="list-item"><Chip>{f.kind}</Chip><div className="grow"><div className="small">{f.label}</div><div className="mono tiny faint">{f.path}</div></div>{f.exists ? <Button size="sm" onClick={() => void api('app.openPath', f.path)}>Open</Button> : <span className="tiny faint">missing</span>}</div>
              ))}
            </Panel>
          </div>
          <Panel title="Advanced (custom executable, arguments, configuration)" actions={<Button busy={savingCustom} onClick={() => void saveCustom()}>Save</Button>}>
            <p className="small muted">Deviations are allowed. When "custom configuration active" is on, OmniDoctor treats differences as intentional and OmniDeck never overwrites your configuration automatically.</p>
            <label className="field">Custom emulator executable<input type="text" value={custom.customExecutable ?? ''} onChange={(e) => setCustom({ ...custom, customExecutable: e.target.value || null })} placeholder={emu.executable ?? ''} /></label>
            <label className="field">Extra launch arguments<input type="text" value={custom.customArgs ?? ''} onChange={(e) => setCustom({ ...custom, customArgs: e.target.value || null })} /></label>
            <label className="field">Note<input type="text" value={custom.customConfigNote ?? ''} onChange={(e) => setCustom({ ...custom, customConfigNote: e.target.value || null })} /></label>
            <Toggle label="Custom configuration active" value={custom.customConfigActive} onChange={(x) => setCustom({ ...custom, customConfigActive: x })} />
          </Panel>
          <Panel title="Version history">
            {emu.versionHistory.length === 0 ? <p className="muted">No versions recorded.</p> : emu.versionHistory.map((h, i) => (
              <div key={i} className="list-item"><strong>{h.version}</strong><Chip tone={h.status === 'active' ? 'ok' : h.status === 'rollback' ? 'info' : undefined}>{h.status}</Chip><span className="small faint grow">{clock(h.installedAt)}</span><span className="tiny faint mono" style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.source}</span></div>
            ))}
            <div className="small faint">Notes: {emu.manifest.notes.join(' ')}</div>
          </Panel>
        </div>
      )}
      {diff && (
        <Modal onClose={() => setDiff(null)} wide>
          <h2>Backup vs current</h2>
          {diff.files.map((f) => (
            <div key={f.relPath} className="col">
              <div className="row"><code>{f.relPath}</code><Chip tone={f.status === 'same' ? 'ok' : 'warn'}>{f.status}</Chip></div>
              {f.lines.length > 0 && <pre className="diff">{f.lines.map((l, i) => <div key={i} className={l.kind === '+' ? 'add' : l.kind === '-' ? 'del' : ''}>{l.kind} {l.text}</div>)}</pre>}
            </div>
          ))}
          <div className="row right"><Button onClick={() => setDiff(null)}>Close</Button></div>
        </Modal>
      )}
      {confirm && (
        <Modal onClose={() => setConfirm(null)}>
          <h2>{confirm.title}</h2>
          <p className="muted">{confirm.body}</p>
          <div className="row right"><Button onClick={() => setConfirm(null)}>Cancel</Button><Button variant="primary" autoFocus onClick={async () => { const c = confirm; setConfirm(null); try { await c.run(); toast('info', 'Started', 'Progress is shown in Downloads.'); reload(); } catch (e) { toast('error', (e as Error).message); } }}>Continue</Button></div>
        </Modal>
      )}
    </div>
  );
}
