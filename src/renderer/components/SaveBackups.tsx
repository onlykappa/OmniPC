// Save backup settings (schedule, triggers, backup/sync folder, retention) and
// the backup list with restore. Used on the Storage page and in Settings.

import { useMemo, useState } from 'react';
import type { SaveBackup, SaveBackupKind, SaveBackupSettings } from '@shared/models';
import { api } from '../lib/api';
import { useLoad } from '../lib/hooks';
import { useStore } from '../lib/store';
import { bytes, clock, when } from '../lib/format';
import { Button, Chip, Modal, Segmented, Spinner, Toggle } from './ui';

export const KIND_LABEL: Record<SaveBackupKind, string> = {
  manual: 'Manual',
  auto: 'Scheduled',
  'after-play': 'After playing',
  'pre-update': 'Before emulator update',
  'pre-restore': 'Before restore',
};

/** Schedule, triggers, folder and retention. `onChanged` lets a backup list refresh after the folder changes. */
export function SaveBackupSettingsForm(props: { onChanged?: () => void }) {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const toast = useStore((s) => s.toast);
  const { data: suggestions } = useLoad(() => api('saves.settingsSuggestions'), []);
  const { data: status, reload: reloadStatus } = useLoad(() => api('saves.destinationStatus'), [settings?.saveBackup.destination]);
  const [busy, setBusy] = useState(false);
  if (!settings) return null;
  const sb = settings.saveBackup;
  const set = async (patch: Partial<SaveBackupSettings>) => setSettings(await api('app.settings.set', { saveBackup: { ...sb, ...patch } }));
  const setDestination = async (folder: string | null) => {
    setBusy(true);
    try {
      await api('saves.setDestination', folder);
      setSettings(await api('app.settings.get'));
      reloadStatus();
      props.onChanged?.();
      toast('success', folder ? 'Backup folder set' : "Using OmniPC's backups folder", folder ? `New backups go to ${folder}\\OmniPC Save Backups\\${status?.computer ?? 'this PC'}` : undefined);
    } catch (e) {
      toast('error', 'That folder cannot be used', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const unused = (suggestions ?? []).filter((s) => s.path !== sb.destination);
  return (
    <div className="col">
      <div className="col"><span>Automatic backups</span>
        <Segmented value={sb.schedule} onChange={(v) => void set({ schedule: v })} options={[{ value: 'off', label: 'Off' }, { value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }]} />
      </div>
      <Toggle label="Back up after playing" description="When a game closes, its emulator's saves are backed up if they changed." value={sb.afterPlay} onChange={(v) => void set({ afterPlay: v })} />
      <Toggle label="Back up before emulator updates" description="Before an emulator is updated or rolled back." value={sb.beforeEmulatorUpdate} onChange={(v) => void set({ beforeEmulatorUpdate: v })} />
      <label className="field">Automatic backups to keep per emulator
        <input type="number" min={1} max={1000} value={sb.keepPerEmulator} onChange={(e) => { const n = Math.round(Number(e.target.value)); if (n >= 1 && n <= 1000) void set({ keepPerEmulator: n }); }} style={{ maxWidth: 120 }} />
      </label>
      <p className="small faint">Unchanged saves are not backed up again. Only older automatic backups are removed; manual backups and the backups made before a restore are always kept.</p>
      <div className="col">
        <span>Backup folder</span>
        <div className="mono small">{sb.destination ?? "OmniPC's Backups folder (this PC only)"}</div>
        {status && <div className="tiny faint">New backups from this PC ({status.computer}) go to <span className="mono">{status.activeFolder}</span></div>}
        {status?.problem && <Chip tone="warn" title={status.problem}>{status.problem}</Chip>}
        <div className="row">
          <Button size="sm" busy={busy} onClick={async () => { const p = await api('app.pickFolder', 'Choose a folder for save backups (e.g. OneDrive, Google Drive or Dropbox)'); if (p) await setDestination(p); }}>Choose folder…</Button>
          {sb.destination && <Button size="sm" busy={busy} onClick={() => void setDestination(null)}>Use OmniPC's folder</Button>}
          <Button size="sm" variant="ghost" onClick={() => void api('saves.openFolder', null)}>Open</Button>
        </div>
        {unused.length > 0 && (
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <span className="small muted">Cloud folders found:</span>
            {unused.map((s) => <Button key={s.path} size="sm" busy={busy} title={s.path} onClick={() => void setDestination(s.path)}>Use {s.provider}</Button>)}
          </div>
        )}
        <p className="small faint">Pick a OneDrive, Google Drive or Dropbox folder to keep backups off this PC and share them between PCs. Each PC writes to its own subfolder, so PCs never overwrite each other's backups, and you can restore a backup made on another PC here.</p>
      </div>
    </div>
  );
}

/** Backups grouped by emulator, with "Back up now" and safety-first restore. */
export function SaveBackupList(props: { reloadKey?: number; onRestored?: () => void }) {
  const { data: backups, reload } = useLoad(() => api('saves.backups'), [props.reloadKey]);
  const toast = useStore((s) => s.toast);
  const [confirm, setConfirm] = useState<SaveBackup | null>(null);
  const [byDate, setByDate] = useState(false);
  const [busy, setBusy] = useState(false);
  const groups = useMemo(() => {
    const m = new Map<string, { name: string; items: SaveBackup[] }>();
    for (const b of backups ?? []) {
      if (!m.has(b.emulatorId)) m.set(b.emulatorId, { name: b.label.replace(/ saves.*$/, ''), items: [] });
      m.get(b.emulatorId)!.items.push(b);
    }
    return [...m.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  }, [backups]);
  const backupNow = async () => {
    setBusy(true);
    try {
      const r = await api('saves.backup', null);
      toast('success', r.length ? `Backed up saves of ${r.length} emulator(s)` : 'No saves to back up yet');
      reload();
    } catch (e) {
      toast('error', 'Backup failed', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const restore = async (b: SaveBackup) => {
    setConfirm(null);
    try {
      const r = await api('saves.restore', b.id);
      toast('success', 'Saves restored', `Your previous saves were backed up first: ${r.safetyBackup}`);
      reload();
      props.onRestored?.();
    } catch (e) {
      toast('error', 'Restore failed', (e as Error).message);
    }
  };
  return (
    <div className="col">
      <div className="row">
        <Button variant="primary" busy={busy} onClick={() => void backupNow()}>Back up now</Button>
        <Button disabled={!backups?.length} onClick={() => setByDate(true)}>Restore an emulator from a date…</Button>
        <Button variant="ghost" onClick={() => void api('saves.openFolder', null)}>Open backup folder</Button>
      </div>
      {!backups ? <Spinner /> : backups.length === 0 ? <p className="muted">No save backups yet.</p> : groups.map(([emuId, g]) => (
        <details key={emuId} open={groups.length <= 3}>
          <summary><b>{g.name}</b> <span className="small muted">· {g.items.length} backup(s), newest {when(g.items[0].createdAt)}</span></summary>
          {g.items.map((b) => (
            <div key={b.id} className="list-item">
              <div className="grow">
                <div>{clock(b.createdAt)}</div>
                <div className="tiny faint">{bytes(b.sizeBytes)} · {b.thisComputer ? 'This PC' : `From ${b.computer}`}{b.location === 'destination' ? ' · backup folder' : ''}</div>
              </div>
              <Chip tone={b.kind === 'manual' || b.kind === 'pre-restore' ? 'info' : undefined}>{KIND_LABEL[b.kind]}</Chip>
              {!b.thisComputer && <Chip tone="planned">{b.computer}</Chip>}
              <Button size="sm" onClick={() => setConfirm(b)}>Restore</Button>
              <Button size="sm" variant="ghost" onClick={() => void api('saves.openFolder', b.id)}>Show</Button>
            </div>
          ))}
        </details>
      ))}
      {confirm && <RestoreConfirm backup={confirm} onCancel={() => setConfirm(null)} onConfirm={() => void restore(confirm)} />}
      {byDate && backups && <RestoreByDate backups={backups} groups={groups} onClose={() => setByDate(false)} onPick={(b) => { setByDate(false); setConfirm(b); }} />}
    </div>
  );
}

function RestoreConfirm(props: { backup: SaveBackup; onCancel: () => void; onConfirm: () => void }) {
  const b = props.backup;
  return (
    <Modal onClose={props.onCancel}>
      <h2>Restore {b.label.replace(/ \(.*\)$/, '')}?</h2>
      <p>This puts back the saves from <b>{clock(b.createdAt)}</b>{b.thisComputer ? '' : <> (made on <b>{b.computer}</b>)</>} ({KIND_LABEL[b.kind].toLowerCase()} backup).</p>
      <p>Your current saves are backed up first, so you can undo this by restoring that backup. Files in the backup replace the same files in the save folders; other save files are left as they are. Close the emulator before restoring.</p>
      <div className="row right"><Button onClick={props.onCancel}>Cancel</Button><Button variant="primary" autoFocus onClick={props.onConfirm}>Back up current saves and restore</Button></div>
    </Modal>
  );
}

function RestoreByDate(props: { backups: SaveBackup[]; groups: [string, { name: string; items: SaveBackup[] }][]; onClose: () => void; onPick: (b: SaveBackup) => void }) {
  const [emu, setEmu] = useState(props.groups[0]?.[0] ?? '');
  const items = props.groups.find(([id]) => id === emu)?.[1].items ?? [];
  const [id, setId] = useState(items[0]?.id ?? '');
  const chosen = items.find((b) => b.id === id) ?? items[0];
  return (
    <Modal onClose={props.onClose}>
      <h2>Restore an emulator from a date</h2>
      <label className="field">Emulator
        <select value={emu} onChange={(e) => { setEmu(e.target.value); setId(''); }}>{props.groups.map(([gid, g]) => <option key={gid} value={gid}>{g.name}</option>)}</select>
      </label>
      <label className="field">Backup
        <select value={chosen?.id ?? ''} onChange={(e) => setId(e.target.value)}>{items.map((b) => <option key={b.id} value={b.id}>{new Date(b.createdAt).toLocaleString()} · {KIND_LABEL[b.kind]} · {b.thisComputer ? 'This PC' : b.computer}</option>)}</select>
      </label>
      <div className="row right"><Button onClick={props.onClose}>Cancel</Button><Button variant="primary" disabled={!chosen} onClick={() => chosen && props.onPick(chosen)}>Continue…</Button></div>
    </Modal>
  );
}
