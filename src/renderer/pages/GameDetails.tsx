import { useEffect, useState } from 'react';
import type { EmulatorDetailsDto, GameDetails, GameMetadata, GameProfile, RendererOption } from '@shared/models';
import { getSystem } from '@shared/systems';
import { api, artUrl } from '../lib/api';
import { useLoad } from '../lib/hooks';
import { navigate, useRoute } from '../lib/router';
import { useStore } from '../lib/store';
import { PlayButton } from '../components/PlayButton';
import { SettingsEditor } from '../components/SettingsEditor';
import { Button, Chip, Empty, Panel, Spinner } from '../components/ui';
import { bytes, duration, when } from '../lib/format';

const TABS = ['overview', 'settings', 'information', 'saves', 'diagnostics'] as const;
type Tab = (typeof TABS)[number];

export function GameDetailsPage(props: { id: number }) {
  const route = useRoute();
  const v = useStore((s) => s.libraryVersion);
  const { data: game, reload } = useLoad(() => api('library.game', props.id), [props.id, v]);
  const [tab, setTab] = useState<Tab>((route.query.get('tab') as Tab) ?? 'overview');
  if (!game) return <div className="page"><Spinner /></div>;
  const sys = getSystem(game.systemId);
  const m = game.metadata;
  const bg = artUrl(m.backgroundPath ?? m.coverPath);
  const cover = artUrl(m.coverPath ?? game.coverThumb);
  return (
    <div className="page">
      <div className="hero">
        {bg && <div className="bg" style={{ backgroundImage: `url("${bg}")` }} />}
        <div className="shade" />
        <div className="content">
          <div className="cover">{cover ? <img src={cover} alt="" /> : null}</div>
          <div className="col grow" style={{ gap: 10 }}>
            <div className="row"><Chip>{sys?.name}</Chip>{game.region && <Chip>{game.region}</Chip>}{game.serial && <Chip>{game.serial}</Chip>}{game.discCount > 1 && <Chip>{game.discCount} discs</Chip>}</div>
            <h1 style={{ fontSize: 38 }}>{game.title}</h1>
            <div className="row small muted">
              <span>Last played: {when(game.lastPlayedAt)}</span>·<span>Play time: {duration(game.playTimeSeconds)}</span>·<span>Emulator: {game.emulatorId ?? 'none'}</span>
              {game.compatibility && <>·<Chip tone={['perfect', 'playable'].includes(game.compatibility.rating) ? 'ok' : game.compatibility.rating === 'ingame' ? 'warn' : 'bad'} title={`Source: ${game.compatibility.source}`}>Compatibility: {game.compatibility.label}</Chip></>}
            </div>
            <div className="row">
              <PlayButton gameId={game.id} disabled={game.availability !== 'available'} autoFocus />
              <Button onClick={async () => { await api('library.setFavorite', game.id, !game.favorite); reload(); }}>{game.favorite ? '★ Favorite' : '☆ Add to favorites'}</Button>
              {game.availability === 'drive_unavailable' && <Chip tone="warn">Game drive unavailable</Chip>}
              {game.crashLoopPaused && <Chip tone="bad">Paused after repeated crashes</Chip>}
            </div>
          </div>
        </div>
      </div>
      <div className="tabs">{TABS.map((t) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}</div>
      {tab === 'overview' && <Overview game={game} />}
      {tab === 'settings' && <GameSettings game={game} onSaved={reload} />}
      {tab === 'information' && <MetadataEditor game={game} onSaved={reload} />}
      {tab === 'saves' && <SavesTab game={game} />}
      {tab === 'diagnostics' && <GameDiagnostics game={game} onChanged={reload} />}
    </div>
  );
}

function Overview({ game }: { game: GameDetails }) {
  const m = game.metadata;
  return (
    <div className="grid cols-2">
      <Panel title="About">
        {m.description ? <p>{m.description}</p> : <p className="muted">No description cached. Add a TheGamesDB API key in Settings for descriptions, or edit the information tab.</p>}
        <dl className="kv">
          {m.releaseYear && <><dt>Released</dt><dd>{m.releaseYear}</dd></>}
          {m.developer && <><dt>Developer</dt><dd>{m.developer}</dd></>}
          {m.publisher && <><dt>Publisher</dt><dd>{m.publisher}</dd></>}
          {m.genre && <><dt>Genre</dt><dd>{m.genre}</dd></>}
          {m.players && <><dt>Players</dt><dd>{m.players}</dd></>}
          <dt>Metadata source</dt><dd>{m.source ?? 'None yet'}</dd>
        </dl>
        {game.compatibility && <p className="small faint">Compatibility rating from {game.compatibility.source}.{game.compatibility.notes ? ` ${game.compatibility.notes}` : ''}</p>}
      </Panel>
      <Panel title="Files">
        {game.files.map((f) => (
          <div key={f.path} className="col" style={{ gap: 2 }}>
            <div className="row"><span className="mono small grow">{f.path}</span>{f.discNumber && <Chip>Disc {f.discNumber}</Chip>}<Chip tone={f.validation === 'ok' ? 'ok' : f.validation === 'invalid' ? 'bad' : f.validation === 'warning' ? 'warn' : undefined}>{f.validation}</Chip></div>
            <div className="tiny faint">{bytes(f.sizeBytes)}{f.validationNote ? ` · ${f.validationNote}` : ''}</div>
          </div>
        ))}
      </Panel>
      <Panel title="Recent sessions">
        {game.recentLaunches.length === 0 ? <p className="muted">Not played yet.</p> : (
          <table className="table"><thead><tr><th>When</th><th>Emulator</th><th>Duration</th><th>Result</th><th /></tr></thead>
            <tbody>{game.recentLaunches.map((l) => (
              <tr key={l.id}><td>{new Date(l.startedAt).toLocaleString()}</td><td>{l.emulatorId} {l.emulatorVersion}</td><td>{l.durationMs !== null ? duration(l.durationMs / 1000) : '—'}</td>
                <td><Chip tone={l.outcome === 'ok' ? 'ok' : l.outcome === 'running' || l.outcome === 'killed' ? undefined : 'bad'}>{l.outcome.replace('_', ' ')}</Chip></td>
                <td>{['crashed', 'early_exit', 'failed_to_start'].includes(l.outcome) && <a href={`#/failure/${l.id}`}>Diagnose</a>}</td></tr>
            ))}</tbody></table>
        )}
      </Panel>
      <Panel title="Screenshots">
        {game.metadata.screenshots.length ? <div className="row">{game.metadata.screenshots.map((s) => <img key={s} src={artUrl(s) ?? ''} style={{ width: 200, borderRadius: 10 }} />)}</div> : <p className="muted">No screenshots cached.</p>}
        <p className="small faint">Achievements: not supported yet.</p>
      </Panel>
    </div>
  );
}

function GameSettings({ game, onSaved }: { game: GameDetails; onSaved: () => void }) {
  const emuId = game.emulatorOverride ?? game.profile?.emulatorId ?? game.emulatorId;
  const [emu, setEmu] = useState<EmulatorDetailsDto | null>(null);
  const [renderers, setRenderers] = useState<RendererOption[]>([]);
  const [overrides, setOverrides] = useState<GameProfile['overrides']>(game.profile?.overrides ?? {});
  const [args, setArgs] = useState(game.profile?.customArgs ?? '');
  const [busy, setBusy] = useState(false);
  const toast = useStore((s) => s.toast);
  const { data: emulators } = useLoad(() => api('emulators.list'), []);
  useEffect(() => {
    if (!emuId) return;
    void api('emulators.details', emuId).then(setEmu).catch(() => setEmu(null));
    void api('emulators.renderers', emuId).then(setRenderers).catch(() => setRenderers([]));
  }, [emuId]);
  const options = (emulators ?? []).filter((e) => e.systems.includes(game.systemId));
  const save = async () => {
    setBusy(true);
    try {
      await api('profiles.save', { gameId: game.id, emulatorId: game.profile?.emulatorId ?? null, overrides, customArgs: args.trim() || null, notes: game.profile?.notes ?? null });
      toast('success', 'Game profile saved', 'It overrides the global configuration for this game only.');
      onSaved();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid cols-2">
      <Panel title="Emulator">
        <p className="small muted">Which emulator runs this game. Default follows the system's recommended emulator.</p>
        <select value={game.emulatorOverride ?? ''} onChange={async (e) => { await api('library.setEmulatorOverride', game.id, e.target.value || null); onSaved(); }}>
          <option value="">Default ({game.emulatorId ?? 'none'})</option>
          {options.map((e) => <option key={e.id} value={e.id} disabled={!e.implemented}>{e.name}{e.implemented ? '' : ' (planned)'}</option>)}
        </select>
        {emu && <p className="small faint">Global {emu.name} settings: {emu.settings.renderer}, {emu.settings.resolutionScale}x. Per-game overrides: {emu.manifest.id === 'pcsx2' ? 'applied with -gamecfg on PCSX2 2.9+, otherwise for the session only (global config restored on exit).' : 'applied with Dolphin -C arguments; no files are changed.'}</p>}
      </Panel>
      <Panel title="Per-game profile" actions={<><Button onClick={async () => { await api('profiles.delete', game.id); setOverrides({}); setArgs(''); onSaved(); }}>Clear profile</Button><Button variant="primary" onClick={save} busy={busy}>Save profile</Button></>}>
        {emu ? (
          <SettingsEditor overrideMode base={emu.settings} value={overrides} renderers={renderers} caps={{ aspectRatios: emu.manifest.id === 'dolphin' ? [{ id: 'auto', label: 'Auto' }, { id: '16:9', label: '16:9' }, { id: '4:3', label: '4:3' }, { id: 'stretch', label: 'Stretch' }] : [{ id: 'auto', label: 'Auto' }, { id: '4:3', label: '4:3' }, { id: '16:9', label: '16:9' }, { id: 'stretch', label: 'Stretch' }], frameLimit: emu.manifest.id === 'dolphin', vsync: true, maxScale: 8 }} onChange={setOverrides} />
        ) : <p className="muted">Install the emulator to configure per-game settings.</p>}
        <label className="field">Custom launch arguments (advanced)
          <input type="text" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="e.g. -fastboot" />
        </label>
      </Panel>
    </div>
  );
}

function MetadataEditor({ game, onSaved }: { game: GameDetails; onSaved: () => void }) {
  const [m, setM] = useState<Partial<GameMetadata> & { title: string }>({ ...game.metadata, title: game.title });
  const [busy, setBusy] = useState(false);
  const toast = useStore((s) => s.toast);
  const field = (k: keyof GameMetadata, label: string, type = 'text') => (
    <label className="field">{label}<input type={type} value={(m[k] as string | number | null) ?? ''} onChange={(e) => setM({ ...m, [k]: type === 'number' ? (e.target.value ? Number(e.target.value) : null) : e.target.value || null })} /></label>
  );
  return (
    <div className="grid cols-2">
      <Panel title="Correct information" actions={<Button variant="primary" busy={busy} onClick={async () => { setBusy(true); try { await api('metadata.update', game.id, m); toast('success', 'Information saved', 'Locked against automatic refresh.'); onSaved(); } finally { setBusy(false); } }}>Save</Button>}>
        <label className="field">Title<input type="text" value={m.title} onChange={(e) => setM({ ...m, title: e.target.value })} /></label>
        <label className="field">Description<textarea rows={4} value={m.description ?? ''} onChange={(e) => setM({ ...m, description: e.target.value || null })} /></label>
        <div className="grid cols-2">{field('releaseYear', 'Release year', 'number')}{field('genre', 'Genre')}{field('developer', 'Developer')}{field('publisher', 'Publisher')}{field('players', 'Players')}{field('rating', 'Rating')}</div>
      </Panel>
      <Panel title="Metadata & artwork">
        <p className="small muted">Source: {game.metadata.source ?? 'none'} {game.metadata.locked && <Chip>Locked</Chip>} · fetched {when(game.metadata.fetchedAt)}</p>
        <div className="row">
          <Button onClick={async () => { await api('metadata.refresh', game.id); onSaved(); toast('success', 'Metadata refreshed'); }}>Refresh metadata</Button>
          <Button onClick={async () => { const f = await api('app.pickFile', 'Choose cover art', ['png', 'jpg', 'jpeg', 'webp']); if (f) { await api('metadata.setArtwork', game.id, 'cover', f); onSaved(); } }}>Change cover…</Button>
          <Button onClick={async () => { const f = await api('app.pickFile', 'Choose background art', ['png', 'jpg', 'jpeg', 'webp']); if (f) { await api('metadata.setArtwork', game.id, 'background', f); onSaved(); } }}>Change background…</Button>
          <Button variant="danger" onClick={async () => { await api('metadata.clear', game.id); onSaved(); }}>Remove metadata</Button>
        </div>
        <p className="small faint">To change the match, edit the title (and use Refresh metadata). Edited information is never overwritten automatically.</p>
      </Panel>
    </div>
  );
}

function SavesTab({ game }: { game: GameDetails }) {
  const toast = useStore((s) => s.toast);
  if (!game.saveLocations.length) return <Empty title="No save locations">Install the emulator for this system to see its save folders.</Empty>;
  return (
    <Panel title="Save data" actions={<Button onClick={async () => { const r = await api('saves.backup', game.saveLocations[0].emulatorId); toast('success', `Backed up ${r.length} save set(s)`); }}>Back up saves</Button>}>
      <p className="small muted">Emulators store saves per memory card or console NAND, not always per game. These are the folders used for this game's emulator. OmniDeck never deletes save data.</p>
      {game.saveLocations.map((s) => (
        <div key={s.path} className="list-item"><div className="grow"><div>{s.label}</div><div className="mono tiny faint">{s.path}</div></div><span className="small muted">{s.fileCount} files · {bytes(s.sizeBytes)}</span>{s.exists && <Button size="sm" onClick={() => void api('app.openPath', s.path)}>Open folder</Button>}</div>
      ))}
    </Panel>
  );
}

function GameDiagnostics({ game, onChanged }: { game: GameDetails; onChanged: () => void }) {
  const failures = game.recentLaunches.filter((l) => ['crashed', 'early_exit', 'failed_to_start'].includes(l.outcome));
  return (
    <div className="grid cols-2">
      <Panel title="Status">
        <dl className="kv">
          <dt>File validation</dt><dd>{game.validation}</dd>
          <dt>Recent failures</dt><dd>{failures.length}</dd>
          <dt>Crash-loop protection</dt><dd>{game.crashLoopPaused ? 'Paused' : 'Not triggered'}</dd>
        </dl>
        <div className="row">
          <Button onClick={async () => { await api('library.revalidate', game.id); onChanged(); }}>Re-validate files</Button>
          {game.crashLoopPaused && <Button onClick={async () => { await api('launch.resetCrashLoop', game.id); onChanged(); }}>Allow launching again</Button>}
          <Button onClick={() => navigate(`/doctor/ask?game=${game.id}`)}>Ask OmniDoctor</Button>
        </div>
      </Panel>
      <Panel title="Failed launches">
        {failures.length === 0 ? <p className="muted">No failed launches recorded.</p> : failures.map((l) => (
          <div key={l.id} className="list-item"><span className="grow">{new Date(l.startedAt).toLocaleString()} — {l.outcome.replace('_', ' ')} (exit {l.exitCode ?? '?'})</span><Button size="sm" onClick={() => navigate(`/failure/${l.id}`)}>View diagnosis</Button></div>
        ))}
      </Panel>
    </div>
  );
}
