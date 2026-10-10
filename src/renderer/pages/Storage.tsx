import { useState } from 'react';
import type { StorageKey } from '@shared/models';
import { api } from '../lib/api';
import { useLoad } from '../lib/hooks';
import { useStore } from '../lib/store';
import { Button, Modal, Panel, Spinner } from '../components/ui';
import { bytes, clock } from '../lib/format';

export function StoragePage() {
  const { data, reload } = useLoad(() => api('storage.locations'), []);
  const { data: saves, reload: reloadSaves } = useLoad(() => api('saves.locations'), []);
  const { data: backups, reload: reloadBackups } = useLoad(() => api('saves.backups'), []);
  const { data: paths } = useLoad(() => api('library.paths'), []);
  const [move, setMove] = useState<{ key: StorageKey; to: string } | null>(null);
  const toast = useStore((s) => s.toast);
  return (
    <div className="page">
      <div className="page-head"><div><h1>Storage</h1><p>Where everything lives. Your games, saves, BIOS and screenshots stay ordinary files you can open any time.</p></div></div>
      <Panel title="Locations">
        {!data ? <Spinner /> : (
          <table className="table">
            <thead><tr><th>What</th><th>Location</th><th>Size</th><th>Free on drive</th><th /></tr></thead>
            <tbody>
              {(paths ?? []).map((p) => <tr key={`g${p.id}`}><td>Games</td><td className="mono small">{p.path}</td><td>{p.gameCount} {p.gameCount === 1 ? "game" : "games"}</td><td>—</td><td><Button size="sm" onClick={() => void api('app.openPath', p.path)} disabled={!p.available}>Open</Button></td></tr>)}
              {data.map((l) => (
                <tr key={l.key}>
                  <td>{l.label}</td><td className="mono small">{l.path}</td><td>{l.sizeBytes === null ? 'large' : bytes(l.sizeBytes)}</td><td>{bytes(l.freeBytes)}</td>
                  <td className="row"><Button size="sm" onClick={() => void api('app.openPath', l.path)}>Open</Button>{l.relocatable && <Button size="sm" onClick={async () => { const to = await api('app.pickFolder', `Move ${l.label} to…`); if (to) setMove({ key: l.key, to }); }}>Move…</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <div className="grid cols-2">
        <Panel title="Save data" actions={<Button onClick={async () => { const r = await api('saves.backup', null); toast('success', `Created ${r.length} save backup(s)`); reloadBackups(); }}>Back up all saves</Button>}>
          {(saves ?? []).map((s) => <div key={s.path} className="list-item"><div className="grow"><div>{s.label}</div><div className="mono tiny faint">{s.path}</div></div><span className="small muted">{s.fileCount} files · {bytes(s.sizeBytes)}</span>{s.exists && <Button size="sm" onClick={() => void api('app.openPath', s.path)}>Open</Button>}</div>)}
          {saves && saves.length === 0 && <p className="muted">Install an emulator to see its save folders.</p>}
          <p className="small faint">Cloud sync is not part of this version; backups are local ZIP files you can copy anywhere.</p>
        </Panel>
        <Panel title="Save backups">
          {(backups ?? []).length === 0 ? <p className="muted">No save backups yet.</p> : backups!.map((b) => (
            <div key={b.id} className="list-item"><div className="grow"><div>{b.label}</div><div className="tiny faint">{clock(b.createdAt)} · {bytes(b.sizeBytes)}</div></div>
              <Button size="sm" onClick={async () => { const r = await api('saves.restore', b.id); toast('success', 'Saves restored', `Previous saves were backed up first: ${r.safetyBackup}`); reloadSaves(); reloadBackups(); }}>Restore</Button>
              <Button size="sm" variant="ghost" onClick={() => void api('app.openPath', b.path.replace(/[\\/][^\\/]+$/, ''))}>Show</Button>
            </div>
          ))}
        </Panel>
      </div>
      {move && (
        <Modal onClose={() => setMove(null)}>
          <h2>Move {move.key}?</h2>
          <p>OmniPC copies everything to <code>{move.to}</code>, verifies the copy, switches OmniPC and emulator configurations to the new location, and leaves the original folder in place for you to delete once you're satisfied.</p>
          <div className="row right"><Button onClick={() => setMove(null)}>Cancel</Button><Button variant="primary" autoFocus onClick={async () => { const m = move; setMove(null); try { await api('storage.relocate', m.key, m.to); toast('info', 'Moving…', 'Progress is shown in Downloads.'); setTimeout(reload, 1500); } catch (e) { toast('error', (e as Error).message); } }}>Move</Button></div>
        </Modal>
      )}
    </div>
  );
}
