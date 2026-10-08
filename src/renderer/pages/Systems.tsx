import { api } from '../lib/api';
import { useAction, useLoad } from '../lib/hooks';
import { navigate } from '../lib/router';
import { useStore } from '../lib/store';
import { Button, Chip, Spinner } from '../components/ui';

export function SystemsPage() {
  const v = useStore((s) => s.emulatorsVersion + s.libraryVersion);
  const { data } = useLoad(() => api('systems.list'), [v]);
  const [install] = useAction((id: string) => api('emulators.installForSystems', [id as never]), { success: 'Installation started' });
  if (!data) return <div className="page"><Spinner /></div>;
  return (
    <div className="page">
      <div className="page-head"><div><h1>Systems</h1><p>One place for every console. OmniDeck picks and manages the emulator underneath.</p></div></div>
      <div className="grid cols-auto">
        {data.map((s) => (
          <div key={s.id} className="card system-card" style={{ cursor: 'default' }}>
            <span className="stripe" style={{ background: s.accent }} />
            <div className="row"><span className="tiny faint">{s.manufacturer}</span><span className="right small muted">{s.gameCount} games</span></div>
            <strong style={{ fontSize: 18 }}>{s.name}</strong>
            <div className="row">
              {s.emulatorName ? <Chip tone={s.emulatorInstalled ? 'ok' : s.emulatorImplemented ? undefined : 'planned'}>{s.emulatorName}{s.emulatorInstalled ? ' · installed' : s.emulatorImplemented ? '' : ' · planned'}</Chip> : <Chip>No emulator</Chip>}
              {s.bios === 'found' && <Chip tone="ok">BIOS found</Chip>}
              {s.bios === 'missing' && <Chip tone="warn">BIOS missing</Chip>}
              {s.bios === 'invalid' && <Chip tone="bad">BIOS invalid</Chip>}
              {s.bios === 'optional' && <Chip>BIOS optional</Chip>}
            </div>
            <div className="row">
              <Button size="sm" onClick={() => navigate(`/library?system=${s.id}`)}>Games</Button>
              {!s.emulatorInstalled && s.emulatorImplemented && <Button size="sm" variant="primary" onClick={() => void install(s.id)}>Install {s.shortName} support</Button>}
              {s.emulatorId && <Button size="sm" variant="ghost" onClick={() => navigate(`/emulators/${s.emulatorId}`)}>Emulator</Button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
