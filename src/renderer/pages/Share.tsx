// Share & Copy: copy games, BIOS/firmware/keys, saves and setup from another
// OmniPC on the home network, and share this PC with your other PCs.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { DiscoveredPc, ShareServerStatus } from '@shared/share';
import type { ShareCatalogView } from '@shared/shareCopy';
import { SHARE_DEFAULT_PORT } from '@shared/share';
import { getSystem } from '@shared/systems';
import { api, ApiError, onEvent } from '../lib/api';
import { useAction } from '../lib/hooks';
import { bytes, when } from '../lib/format';
import { useRoute, navigate } from '../lib/router';
import { useStore } from '../lib/store';
import { Button, Chip, Empty, JobSteps, Modal, Panel, Spinner, Toggle } from '../components/ui';

const PRIVACY_LINE = 'Only your own PCs on your home network can connect, after you pair them with a code. Games, BIOS, keys and saves never leave your devices.';

export function SharePage() {
  const route = useRoute();
  const [tab, setTab] = useState<'copy' | 'share'>(route.query.get('tab') === 'share' ? 'share' : 'copy');
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Share & Copy</h1>
          <p>{PRIVACY_LINE}</p>
        </div>
      </div>
      <div className="tabs">
        <button className={tab === 'copy' ? 'on' : ''} onClick={() => setTab('copy')}>Copy from another PC</button>
        <button className={tab === 'share' ? 'on' : ''} onClick={() => setTab('share')}>Share this PC</button>
      </div>
      {tab === 'copy' ? <CopyFromPc /> : <ShareThisPc />}
    </div>
  );
}

// ---------------------------------------------------------------- copy side

type Sel = { games: Set<string>; bios: Set<string>; saves: Set<string>; setup: boolean };
const emptySel = (): Sel => ({ games: new Set(), bios: new Set(), saves: new Set(), setup: false });

/**
 * The whole "copy from another PC" flow. Used on the Share & Copy page and in
 * the first-run wizard (with Setup + BIOS preselected).
 */
export function CopyFromPc(props: { preselect?: { setup?: boolean; bios?: boolean }; onFinished?: () => void; finishLabel?: string }) {
  const toast = useStore((s) => s.toast);
  const [pcs, setPcs] = useState<DiscoveredPc[]>([]);
  const [searched, setSearched] = useState(false);
  const [manual, setManual] = useState(false);
  const [pairing, setPairing] = useState<{ requestId: string; name: string; pc: DiscoveredPc } | null>(null);
  const [current, setCurrent] = useState<DiscoveredPc | null>(null);
  const [view, setView] = useState<ShareCatalogView | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<ApiError | null>(null);

  useEffect(() => { void api('share.knownPcs').then(setPcs).catch(() => undefined); }, []);

  const [find, finding] = useAction(async () => {
    const found = await api('share.discover');
    setPcs(found);
    setSearched(true);
  });

  const open = async (pc: DiscoveredPc) => {
    setCurrent(pc);
    setView(null);
    setLoadError(null);
    setLoading(true);
    try {
      setView(await api('share.catalog', pc.deviceId));
    } catch (e) {
      setLoadError(e as ApiError);
    } finally {
      setLoading(false);
    }
  };

  const startPair = async (pc: DiscoveredPc) => {
    try {
      const r = await api('share.pairStart', pc.address, pc.port);
      setPairing({ requestId: r.requestId, name: r.server.name, pc: { ...pc, deviceId: r.server.deviceId, name: r.server.name } });
    } catch (e) {
      const err = e as ApiError;
      toast('error', err.message, err.detail?.userAction?.[0] ?? '');
    }
  };

  const choose = (pc: DiscoveredPc) => (pc.paired ? void open(pc) : void startPair(pc));

  const forget = async (pc: DiscoveredPc) => {
    await api('share.forget', pc.deviceId);
    setPcs(pcs.map((p) => (p.deviceId === pc.deviceId ? { ...p, paired: false } : p)).filter((p) => p.paired || p.deviceId !== pc.deviceId || searched));
    if (current?.deviceId === pc.deviceId) { setCurrent(null); setView(null); }
  };

  if (current) {
    return (
      <div className="col" style={{ gap: 16 }}>
        <div className="row">
          <Button size="sm" variant="ghost" onClick={() => { setCurrent(null); setView(null); }}>← PCs</Button>
          <strong>{current.name}</strong>
          <span className="small faint">{current.address}</span>
          <span className="right" />
          <Button size="sm" onClick={() => void open(current)} disabled={loading}>Scan again</Button>
        </div>
        {loading && <Panel><div className="row"><Spinner /> Asking {current.name} what it shares…</div></Panel>}
        {loadError && (
          <Panel>
            <div style={{ color: 'var(--bad)' }}>{loadError.message}</div>
            {loadError.detail?.userAction?.[0] && <div className="small muted">{loadError.detail.userAction[0]}</div>}
            <div className="row">
              <Button onClick={() => void open(current)}>Try again</Button>
              {loadError.code === 'SHARE_NOT_PAIRED' && <Button variant="primary" onClick={() => void startPair(current)}>Pair again</Button>}
            </div>
          </Panel>
        )}
        {view && <CatalogView key={current.deviceId} pc={current} view={view} preselect={props.preselect} onFinished={props.onFinished} finishLabel={props.finishLabel} />}
        {pairing && <PairDialog pairing={pairing} onClose={() => setPairing(null)} onPaired={(pc) => { setPairing(null); void open(pc); }} />}
      </div>
    );
  }

  return (
    <div className="col" style={{ gap: 16 }}>
      <Panel title="Copy from another PC" actions={<><Button onClick={() => setManual(true)}>Enter address</Button><Button variant="primary" busy={finding} onClick={() => void find()} autoFocus>Find PCs</Button></>}>
        <p className="small muted">On the other PC, open Share & Copy › Share this PC and turn sharing on. Then find it here.</p>
        {pcs.length === 0 ? (
          <Empty title={searched ? 'No PCs found' : 'No PCs yet'}>
            {searched ? 'Make sure sharing is on and both PCs are on the same network. You can also enter its address.' : 'Click "Find PCs" to look on your home network.'}
          </Empty>
        ) : (
          <div className="list">
            {pcs.map((pc) => (
              <div key={pc.deviceId} className="list-item">
                <span className={`dot ${pc.paired ? 'ok' : ''}`} />
                <div className="grow">
                  <div><strong>{pc.name}</strong></div>
                  <div className="small faint">{pc.address}{pc.port !== SHARE_DEFAULT_PORT ? `:${pc.port}` : ''}{pc.version ? ` · OmniPC ${pc.version}` : ''}</div>
                </div>
                {pc.paired ? <Chip tone="ok">Paired</Chip> : <Chip>Not paired</Chip>}
                {pc.paired && <Button size="sm" variant="ghost" onClick={() => void forget(pc)}>Forget</Button>}
                <Button size="sm" variant="primary" onClick={() => choose(pc)}>{pc.paired ? 'Open' : 'Pair'}</Button>
              </div>
            ))}
          </div>
        )}
      </Panel>
      {manual && <ManualAddress onClose={() => setManual(false)} onFound={(pc) => { setManual(false); setPcs([...pcs.filter((p) => p.deviceId !== pc.deviceId), pc]); choose(pc); }} />}
      {pairing && <PairDialog pairing={pairing} onClose={() => setPairing(null)} onPaired={(pc) => { setPairing(null); setPcs(pcs.map((p) => (p.deviceId === pc.deviceId ? pc : p))); void open(pc); }} />}
    </div>
  );
}

function ManualAddress(props: { onClose: () => void; onFound: (pc: DiscoveredPc) => void }) {
  const [address, setAddress] = useState('');
  const [port, setPort] = useState(String(SHARE_DEFAULT_PORT));
  const [connect, busy] = useAction(async () => {
    const p = Number(port) || SHARE_DEFAULT_PORT;
    const info = await api('share.connect', address.trim(), p);
    const known = await api('share.knownPcs');
    const k = known.find((x) => x.deviceId === info.deviceId);
    props.onFound({ deviceId: info.deviceId, name: info.name, address: k?.address ?? address.trim(), port: p, version: info.version, paired: !!k });
  });
  return (
    <Modal onClose={props.onClose}>
      <h2>Enter the other PC's address</h2>
      <p className="small muted">It is shown on the other PC under Share & Copy › Share this PC (for example 192.168.1.20).</p>
      <label className="field">Address<input type="text" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="192.168.1.20" autoFocus onKeyDown={(e) => e.key === 'Enter' && address.trim() && void connect()} /></label>
      <label className="field">Port<input type="number" value={port} onChange={(e) => setPort(e.target.value)} /></label>
      <div className="row"><span className="right" /><Button onClick={props.onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!address.trim()} onClick={() => void connect()}>Connect</Button></div>
    </Modal>
  );
}

function PairDialog(props: { pairing: { requestId: string; name: string; pc: DiscoveredPc }; onClose: () => void; onPaired: (pc: DiscoveredPc) => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const info = await api('share.pairFinish', props.pairing.requestId, code);
      props.onPaired({ ...props.pairing.pc, deviceId: info.deviceId, name: info.name, version: info.version, paired: true });
    } catch (e) {
      const err = e as ApiError;
      setError(`${err.message}${err.detail?.userAction?.[0] ? ` ${err.detail.userAction[0]}` : ''}`);
      setCode('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={props.onClose}>
      <h2>Pair with {props.pairing.name}</h2>
      <p className="muted">Type the 6-digit code shown on {props.pairing.name}.</p>
      <input className="share-code-input" inputMode="numeric" maxLength={7} value={code} autoFocus onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ''))} onKeyDown={(e) => e.key === 'Enter' && code.replace(/\D/g, '').length === 6 && void submit()} placeholder="••••••" aria-label="6-digit code" />
      {error && <div className="small" style={{ color: 'var(--bad)' }}>{error}</div>}
      <p className="small faint">Pairing is needed once per PC. You can remove it later on either PC.</p>
      <div className="row"><span className="right" /><Button onClick={props.onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={code.replace(/\D/g, '').length !== 6} onClick={() => void submit()}>Pair</Button></div>
    </Modal>
  );
}

function CheckRow(props: { on: boolean; onToggle: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <div className={`share-row ${props.on ? 'on' : ''}`} role="checkbox" aria-checked={props.on} tabIndex={0} onClick={props.onToggle} onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && (e.preventDefault(), props.onToggle())}>
      <span className="box">{props.on ? '✓' : ''}</span>
      {props.children}
    </div>
  );
}

function toggled(set: Set<string>, id: string): Set<string> {
  const n = new Set(set);
  if (n.has(id)) n.delete(id);
  else n.add(id);
  return n;
}

function CatalogView(props: { pc: DiscoveredPc; view: ShareCatalogView; preselect?: { setup?: boolean; bios?: boolean }; onFinished?: () => void; finishLabel?: string }) {
  const { catalog, have } = props.view;
  const [tab, setTab] = useState<'games' | 'bios' | 'saves' | 'setup'>(props.preselect ? 'setup' : 'games');
  const [sel, setSel] = useState<Sel>(() => {
    const s = emptySel();
    if (props.preselect?.bios) for (const b of catalog.bios) if (!have.bios[b.id]) s.bios.add(b.id);
    if (props.preselect?.setup) s.setup = true;
    return s;
  });
  const [q, setQ] = useState('');
  const [dest, setDest] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useStore((s) => (jobId ? s.jobs[jobId] : undefined));
  const toast = useStore((s) => s.toast);
  useEffect(() => { void api('share.suggestDestination').then(setDest).catch(() => undefined); }, []);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const by = new Map<string, typeof catalog.games>();
    for (const g of catalog.games) {
      if (needle && !`${g.title} ${g.serial ?? ''} ${g.systemId}`.toLowerCase().includes(needle)) continue;
      by.set(g.systemId, [...(by.get(g.systemId) ?? []), g]);
    }
    return [...by.entries()].sort((a, b) => (getSystem(a[0])?.name ?? a[0]).localeCompare(getSystem(b[0])?.name ?? b[0]));
  }, [catalog.games, q]);

  const size = (catalog.games.filter((g) => sel.games.has(g.id)).reduce((n, g) => n + g.sizeBytes, 0))
    + catalog.bios.filter((b) => sel.bios.has(b.id)).reduce((n, b) => n + b.sizeBytes, 0)
    + catalog.saves.filter((s) => sel.saves.has(s.id)).reduce((n, s) => n + s.sizeBytes, 0);
  const count = sel.games.size + sel.bios.size + sel.saves.size + (sel.setup ? 1 : 0);
  const running = job && (job.state === 'running' || job.state === 'queued');

  const [start, starting] = useAction(async () => {
    const r = await api('share.copy', props.pc.deviceId, { gameIds: [...sel.games], biosIds: [...sel.bios], savesIds: [...sel.saves], setup: sel.setup, gamesDestination: sel.games.size ? dest : null });
    setJobId(r.jobId);
    toast('info', 'Copy started', 'Progress is also shown in Downloads.');
  });

  const tabs: { id: typeof tab; label: string; n: number }[] = [
    { id: 'games', label: 'Games', n: catalog.games.length },
    { id: 'bios', label: 'BIOS · Firmware · Keys', n: catalog.bios.length },
    { id: 'saves', label: 'Saves', n: catalog.saves.length },
    { id: 'setup', label: 'Setup', n: catalog.setup.emulators.length },
  ];

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="tabs">
        {tabs.map((t) => <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>{t.label} <span className="faint">{t.n}</span></button>)}
      </div>

      {tab === 'games' && (
        <Panel title={`${catalog.games.length} game(s) on ${props.pc.name}`} actions={<input type="search" placeholder="Search games…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 280 }} />}>
          {catalog.games.length === 0 && <Empty title="No games shared">{props.pc.name} does not share games, or has none in its library.</Empty>}
          {groups.map(([systemId, games]) => {
            const all = games.every((g) => sel.games.has(g.id));
            return (
              <div key={systemId} className="col" style={{ gap: 4 }}>
                <div className="row">
                  <strong>{getSystem(systemId)?.name ?? systemId}</strong>
                  <span className="small faint">{games.length} · {bytes(games.reduce((n, g) => n + g.sizeBytes, 0))}</span>
                  <span className="right" />
                  <Button size="sm" variant="ghost" onClick={() => setSel({ ...sel, games: (() => { const n = new Set(sel.games); for (const g of games) { if (all) n.delete(g.id); else if (!have.games[g.id]) n.add(g.id); } return n; })() })}>{all ? 'Select none' : 'Select all'}</Button>
                </div>
                {games.map((g) => (
                  <CheckRow key={g.id} on={sel.games.has(g.id)} onToggle={() => setSel({ ...sel, games: toggled(sel.games, g.id) })}>
                    {g.coverThumb ? <img className="share-thumb" alt="" src={g.coverThumb.startsWith('data:') ? g.coverThumb : `data:image/jpeg;base64,${g.coverThumb}`} /> : <span className="share-thumb" />}
                    <div className="grow">
                      <div>{g.title}</div>
                      <div className="small faint">{[g.region, g.serial, `${g.files.length} file(s)`].filter(Boolean).join(' · ')}</div>
                    </div>
                    {have.games[g.id] && <Chip tone="ok">Already on this PC</Chip>}
                    <span className="small muted">{bytes(g.sizeBytes)}</span>
                  </CheckRow>
                ))}
              </div>
            );
          })}
        </Panel>
      )}

      {tab === 'bios' && (
        <Panel title="BIOS · Firmware · Keys" actions={catalog.bios.length > 0 && <Button size="sm" variant="ghost" onClick={() => setSel({ ...sel, bios: sel.bios.size ? new Set() : new Set(catalog.bios.filter((b) => !have.bios[b.id]).map((b) => b.id)) })}>{sel.bios.size ? 'Select none' : 'Select all missing'}</Button>}>
          <p className="small muted">Copied into this PC's BIOS folders. A file you already have with different contents is kept; the copy is saved next to it with "(from {props.pc.name})" in its name.</p>
          {catalog.bios.length === 0 && <Empty title="Nothing shared">{props.pc.name} does not share BIOS, firmware or keys, or has none.</Empty>}
          {catalog.bios.map((b) => (
            <CheckRow key={b.id} on={sel.bios.has(b.id)} onToggle={() => setSel({ ...sel, bios: toggled(sel.bios, b.id) })}>
              <div className="grow">
                <div>{b.label}</div>
                <div className="small faint">{getSystem(b.systemId)?.name ?? b.systemId} · {b.files.map((f) => f.path).join(', ')}</div>
              </div>
              <Chip>{b.category}</Chip>
              {have.bios[b.id] && <Chip tone="ok">Already on this PC</Chip>}
              <span className="small muted">{bytes(b.sizeBytes)}</span>
            </CheckRow>
          ))}
        </Panel>
      )}

      {tab === 'saves' && (
        <Panel title="Saves">
          <p className="small muted">Saves are restored into this PC's save folders for each emulator. Your current saves are backed up first, so you can always go back (Storage › Save backups).</p>
          {catalog.saves.length === 0 && <Empty title="Nothing shared">{props.pc.name} does not share saves, or has none.</Empty>}
          {catalog.saves.map((s) => (
            <CheckRow key={s.id} on={sel.saves.has(s.id)} onToggle={() => setSel({ ...sel, saves: toggled(sel.saves, s.id) })}>
              <div className="grow">
                <div>{s.emulatorName}</div>
                <div className="small faint">{s.fileCount} file(s) · changed {when(s.lastModified)}</div>
              </div>
              <span className="small muted">Theirs {bytes(s.sizeBytes)} · This PC {have.saves[s.id] === null || have.saves[s.id] === undefined ? 'none' : bytes(have.saves[s.id])}</span>
            </CheckRow>
          ))}
        </Panel>
      )}

      {tab === 'setup' && (
        <Panel title="Setup">
          <CheckRow on={sel.setup} onToggle={() => setSel({ ...sel, setup: !sel.setup })}>
            <div className="grow">
              <div>Copy OmniPC's setup from {props.pc.name}</div>
              <div className="small faint">OmniPC backs up its own settings first, so this can be undone.</div>
            </div>
          </CheckRow>
          <div className="col" style={{ gap: 6 }}>
            <strong className="small">What is copied</strong>
            <ul className="small muted" style={{ margin: 0 }}>
              <li>Emulators: {catalog.setup.emulators.length ? catalog.setup.emulators.map((e) => `${e.name}${e.version ? ` ${e.version}` : ''}`).join(', ') : 'none'}. Emulators missing here are installed from their official sources.</li>
              <li>Each emulator's OmniPC settings (graphics, presets).</li>
              <li>OmniPC preferences such as hotkeys, quality preset and save backup schedule.</li>
              {catalog.setup.hasControllerProfile && <li>Your controller profile.</li>}
              <li>{catalog.setup.perGameProfiles} per-game profile(s), matched to the games on this PC.</li>
            </ul>
            <strong className="small">What is never copied</strong>
            <ul className="small muted" style={{ margin: 0 }}>
              <li>Passwords, API keys and sign-in tokens for online services (RetroAchievements, AI, TheGamesDB).</li>
              <li>Folders and other paths that only exist on {props.pc.name}.</li>
              <li>Custom launch arguments of per-game profiles.</li>
            </ul>
          </div>
        </Panel>
      )}

      {job && (
        <Panel title="Copying">
          <JobSteps job={job} />
          {running && job.cancellable && <div><Button size="sm" onClick={() => void api('jobs.cancel', job.id)}>Cancel</Button> <span className="small faint">Partly copied files are kept and resume next time.</span></div>}
          {!running && props.onFinished && <div className="row"><Button variant="primary" size="big" onClick={props.onFinished} autoFocus>{props.finishLabel ?? 'Continue'}</Button></div>}
        </Panel>
      )}

      <div className="copy-footer">
        <strong>{count} item{count === 1 ? '' : 's'} · {bytes(size)}</strong>
        {sel.games.size > 0 && (
          <span className="row small muted" style={{ gap: 8 }}>
            Games go to <code title={dest ?? ''}>{dest ?? '…'}</code>
            <Button size="sm" variant="ghost" onClick={async () => { const p = await api('app.pickFolder', 'Where should the games go?'); if (p) setDest(p); }}>Change…</Button>
          </span>
        )}
        <span className="right" />
        {props.onFinished && !job && <Button variant="ghost" onClick={props.onFinished}>Skip</Button>}
        <Button variant="primary" busy={starting || !!running} disabled={!count || (sel.games.size > 0 && !dest)} onClick={() => void start()}>Copy</Button>
      </div>
    </div>
  );
}

// --------------------------------------------------------------- share side

const SHARE_KINDS: { key: keyof ShareServerStatus['sharing']; label: string; description: string }[] = [
  { key: 'games', label: 'Games', description: 'Game files from your library folders.' },
  { key: 'bios', label: 'BIOS, firmware & keys', description: 'Files in OmniPC\'s BIOS folders.' },
  { key: 'saves', label: 'Saves', description: 'A fresh backup of each emulator\'s saves.' },
  { key: 'setup', label: 'Setup', description: 'Emulators and settings, never passwords, keys or tokens.' },
];

export function ShareThisPc() {
  const [st, setSt] = useState<ShareServerStatus | null>(null);
  const [, tick] = useState(0);
  const toast = useStore((s) => s.toast);
  useEffect(() => {
    void api('share.status').then(setSt).catch(() => undefined);
    const off = onEvent('share.changed', setSt);
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => { off(); clearInterval(t); };
  }, []);
  const run = async (p: Promise<ShareServerStatus>) => {
    try {
      setSt(await p);
    } catch (e) {
      const err = e as ApiError;
      toast('error', err.message, err.detail?.userAction?.[0] ?? '');
    }
  };
  if (!st) return <Panel><Spinner /></Panel>;
  const pending = st.pending.filter((p) => new Date(p.expiresAt).getTime() > Date.now());
  return (
    <div className="grid cols-2">
      <Panel title="Share this PC">
        <Toggle label="Share this PC on my home network" description={st.enabled ? `On · ${st.name}${st.addresses.length ? ` · ${st.addresses.join(', ')}` : ''}${st.port ? ` · port ${st.port}` : ''}` : 'Off. Nothing can connect.'} value={st.enabled} onChange={(v) => void run(api('share.setEnabled', v))} />
        {st.error && <div className="small" style={{ color: 'var(--bad)' }}>{st.error}</div>}
        <strong className="small">What to share</strong>
        {SHARE_KINDS.map((k) => <Toggle key={k.key} label={k.label} description={k.description} value={st.sharing[k.key]} onChange={(v) => void run(api('share.setSharing', { [k.key]: v }))} />)}
        <p className="small faint">Windows Firewall may ask once to allow OmniPC on private networks. Allow it so your other PCs can find this one.</p>
      </Panel>
      <div className="col" style={{ gap: 16 }}>
        <Panel title="Allow a new PC" actions={st.pairingOpen ? <Button size="sm" onClick={() => void run(api('share.closePairing'))}>Stop</Button> : <Button size="sm" variant="primary" disabled={!st.enabled} onClick={() => void run(api('share.openPairing', 10))}>Allow a new PC</Button>}>
          {!st.enabled && <p className="small muted">Turn sharing on first.</p>}
          {st.enabled && !st.pairingOpen && <p className="small muted">Opens pairing for 10 minutes. On the other PC, choose Copy from another PC and pick {st.name}.</p>}
          {st.pairingOpen && pending.length === 0 && <div className="row small muted"><Spinner /> Waiting for the other PC… (open for 10 minutes)</div>}
          {pending.map((p) => (
            <div key={p.requestId} className="col" style={{ gap: 6, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
              <div className="row"><strong>{p.name}</strong><span className="small faint">wants to copy from this PC</span><span className="right" /><Button size="sm" variant="danger" onClick={() => void run(api('share.rejectPending', p.requestId))}>Reject</Button></div>
              <div className="share-code" aria-label={`Code ${p.code.split('').join(' ')}`}>{p.code}</div>
              <div className="small faint">Type this code on {p.name}. Don't recognise it? Reject.</div>
            </div>
          ))}
        </Panel>
        <Panel title="Paired PCs">
          {st.paired.length === 0 ? <p className="small muted">No PCs paired yet.</p> : st.paired.map((d) => (
            <div key={d.deviceId} className="list-item">
              <div className="grow"><div>{d.name}</div><div className="small faint">Paired {when(d.pairedAt)} · last seen {when(d.lastSeenAt)}</div></div>
              <Button size="sm" variant="ghost" onClick={() => void run(api('share.revoke', d.deviceId))}>Remove</Button>
            </div>
          ))}
        </Panel>
      </div>
    </div>
  );
}

/** Small entry point used elsewhere (e.g. Settings). */
export function ShareLinkPanel() {
  return (
    <Panel id="share" title="Share & Copy">
      <p className="small muted">Copy games, BIOS, saves and setup from another PC with OmniPC on your home network, or share this PC.</p>
      <div className="row"><Button onClick={() => navigate('/share')}>Copy from another PC</Button><Button onClick={() => navigate('/share?tab=share')}>Share this PC</Button></div>
    </Panel>
  );
}
