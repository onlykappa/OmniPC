// "Simple settings" editor shared by emulator settings and per-game profiles.
// Only the fields an adapter actually supports are enabled.

import { useState } from 'react';
import type { EmulatorSettings, PerformancePreset, RendererOption } from '@shared/models';
import { Segmented, Toggle } from './ui';

export interface Capabilities {
  aspectRatios: { id: string; label: string }[];
  frameLimit: boolean;
  vsync: boolean;
  maxScale: number;
}

const RES_LABEL = (n: number) => (n === 1 ? 'Native' : `${n}x (~${n * 480}p)`);

export function SettingsEditor(props: {
  value: Partial<EmulatorSettings>;
  base?: EmulatorSettings;
  renderers: RendererOption[];
  caps: Capabilities;
  onChange: (v: Partial<EmulatorSettings>) => void;
  overrideMode?: boolean;
}) {
  const [advanced, setAdvanced] = useState(false);
  const v = { ...(props.base ?? {}), ...props.value } as EmulatorSettings;
  const set = (patch: Partial<EmulatorSettings>) => props.onChange({ ...props.value, ...patch });
  const overridden = (k: keyof EmulatorSettings) => props.overrideMode && props.value[k] !== undefined;
  const clear = (k: keyof EmulatorSettings) => {
    const next = { ...props.value };
    delete next[k];
    props.onChange(next);
  };
  const Label = ({ k, children }: { k: keyof EmulatorSettings; children: string }) => (
    <div className="row" style={{ justifyContent: 'space-between' }}>
      <span>{children}{overridden(k) && <span className="chip info" style={{ marginLeft: 8 }}>Override</span>}</span>
      {overridden(k) && <button className="btn ghost sm" onClick={() => clear(k)}>Use global</button>}
    </div>
  );
  return (
    <div className="col" style={{ gap: 18 }}>
      {!props.overrideMode && (
        <div className="col">
          <span>Graphics quality</span>
          <Segmented<PerformancePreset> value={v.preset} onChange={(p) => set({ preset: p })} options={[{ value: 'performance', label: 'Performance' }, { value: 'balanced', label: 'Balanced' }, { value: 'quality', label: 'Quality' }, { value: 'maximum', label: 'Maximum' }]} />
          <span className="small faint">Changing the preset here only labels your choice; adjust resolution below. Presets are applied automatically when OmniDeck generates a configuration.</span>
        </div>
      )}
      <div className="col">
        <Label k="resolutionScale">Resolution</Label>
        <Segmented<number> value={v.resolutionScale} onChange={(n) => set({ resolutionScale: n })} options={Array.from({ length: props.caps.maxScale }, (_, i) => i + 1).filter((n) => n <= 6 || n === props.caps.maxScale).map((n) => ({ value: n, label: RES_LABEL(n) }))} />
      </div>
      <div className="col">
        <Label k="renderer">Renderer</Label>
        <Segmented<string> value={v.renderer} onChange={(r) => set({ renderer: r })} options={props.renderers.map((r) => ({ value: r.id, label: r.label, disabled: !r.available, title: r.note }))} />
      </div>
      {props.caps.aspectRatios.length > 0 && (
        <div className="col">
          <Label k="aspectRatio">Aspect ratio</Label>
          <Segmented<string> value={v.aspectRatio} onChange={(a) => set({ aspectRatio: a })} options={props.caps.aspectRatios.map((a) => ({ value: a.id, label: a.label }))} />
        </div>
      )}
      <div>
        <Toggle label="Fullscreen" value={v.fullscreen} onChange={(x) => set({ fullscreen: x })} />
        <Toggle label="VSync" description={props.caps.vsync ? undefined : 'Not supported by this emulator integration'} value={v.vsync} onChange={(x) => set({ vsync: x })} disabled={!props.caps.vsync} />
        <Toggle label="Frame limit" description={props.caps.frameLimit ? 'Run at normal speed' : 'Not exposed by this emulator integration yet'} value={v.frameLimit} onChange={(x) => set({ frameLimit: x })} disabled={!props.caps.frameLimit} />
      </div>
      <div>
        <button className="btn ghost sm" onClick={() => setAdvanced(!advanced)}>{advanced ? 'Hide' : 'Show'} advanced settings</button>
        {advanced && <AdvancedEditor value={props.value.advanced ?? v.advanced ?? {}} onChange={(a) => set({ advanced: a })} />}
      </div>
    </div>
  );
}

function AdvancedEditor(props: { value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const [key, setKey] = useState('');
  const [val, setVal] = useState('');
  const entries = Object.entries(props.value);
  return (
    <div className="col" style={{ marginTop: 10 }}>
      <p className="small faint">Advanced values are written straight into the emulator configuration. Keys use <code>Section|Key</code> for PCSX2 (e.g. <code>EmuCore/GS|TriFilter</code>) and <code>File|Section|Key</code> for Dolphin (e.g. <code>GFX.ini|Enhancements|MaxAnisotropy</code>).</p>
      {entries.map(([k, v]) => (
        <div key={k} className="row">
          <code className="grow">{k} = {v}</code>
          <button className="btn ghost sm" onClick={() => { const n = { ...props.value }; delete n[k]; props.onChange(n); }}>Remove</button>
        </div>
      ))}
      <div className="row">
        <input type="text" placeholder="Section|Key" value={key} onChange={(e) => setKey(e.target.value)} style={{ maxWidth: 320 }} />
        <input type="text" placeholder="Value" value={val} onChange={(e) => setVal(e.target.value)} style={{ maxWidth: 200 }} />
        <button className="btn sm" disabled={!key.includes('|')} onClick={() => { props.onChange({ ...props.value, [key]: val }); setKey(''); setVal(''); }}>Add</button>
      </div>
    </div>
  );
}
