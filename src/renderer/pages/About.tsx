import { api } from '../lib/api';
import { useLoad } from '../lib/hooks';
import { Button, Panel, Spinner } from '../components/ui';

export function AboutPage() {
  const { data } = useLoad(() => api('app.info'), []);
  const { data: hw } = useLoad(() => api('hardware.get'), []);
  if (!data) return <div className="page"><Spinner /></div>;
  return (
    <div className="page">
      <div className="page-head"><div><h1>OmniPC</h1><p>Version {data.version}{data.safeMode ? ' · Safe Mode' : ''}</p></div></div>
      <div className="grid cols-2">
        <Panel title="This build">
          <dl className="kv"><dt>Electron</dt><dd>{data.electron}</dd><dt>Chromium</dt><dd>{data.chrome}</dd><dt>Node</dt><dd>{data.node}</dd><dt>Platform</dt><dd>{data.platform}</dd><dt>Data folder</dt><dd className="mono small">{data.dataRoot}</dd><dt>Database</dt><dd className="mono small">{data.databasePath}</dd><dt>Log</dt><dd className="mono small">{data.logPath}</dd></dl>
          <div className="row"><Button onClick={() => void api('app.openPath', data.dataRoot)}>Open data folder</Button></div>
        </Panel>
        <Panel title="This PC" actions={<Button size="sm" onClick={() => void api('hardware.scan').then(() => window.location.reload())}>Rescan</Button>}>
          {!hw ? <p className="muted">Not scanned yet.</p> : (
            <dl className="kv"><dt>Windows</dt><dd>{hw.osName} {hw.osBuild ? `(build ${hw.osBuild})` : ''}</dd><dt>CPU</dt><dd>{hw.cpu.model} · {hw.cpu.cores} cores / {hw.cpu.threads} threads</dd><dt>Instruction sets</dt><dd>{hw.cpu.features.join(', ') || 'unknown'}</dd><dt>RAM</dt><dd>{Math.round(hw.ramMB / 1024)} GB</dd><dt>GPU</dt><dd>{hw.gpus.map((g) => `${g.name} (${g.vramMB ? Math.round(g.vramMB / 1024) + ' GB' : 'VRAM unknown'})`).join(', ') || 'none detected'}</dd><dt>APIs</dt><dd>DirectX 12: {String(hw.graphicsApis.directx12)}, Vulkan: {String(hw.graphicsApis.vulkan)}</dd><dt>Displays</dt><dd>{hw.displays.map((d) => `${d.width}×${d.height}${d.refreshRate ? ` @${d.refreshRate} Hz` : ''}`).join(', ')}</dd><dt>Tier</dt><dd>{hw.tier} — {hw.tierReason}</dd></dl>
          )}
        </Panel>
        <Panel title="Legal">
          <p className="small">OmniPC is an independent project, not affiliated with EmuDeck, Sony, Nintendo, Microsoft or any emulator project. Emulators are downloaded from their official sources and remain under their own licenses. OmniPC never provides games, BIOS files, firmware or encryption keys; you supply content you legally own.</p>
          <p className="small faint">See THIRD_PARTY_NOTICES.md shipped with the app for third-party licenses.</p>
        </Panel>
      </div>
    </div>
  );
}
