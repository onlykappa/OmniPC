// The per-emulator settings menu: every setting an adapter declares, grouped
// in tabs, with plain-language descriptions, the emulator's default, OmniPC's
// recommendation, and what is in the emulator's config file right now (so
// changes made inside the emulator show up here).
//
// Global mode edits EmulatorSettings.advanced; override mode edits a game
// profile's advanced overrides on top of the global values.

import { useMemo, useState } from 'react';
import { SETTING_CATEGORIES, toBool, type EmulatorSettingsView, type SettingCategory, type SettingDef } from '@shared/emulatorSettings';
import { Chip, Segmented } from './ui';

export function EmulatorSettingsMenu(props: {
  view: EmulatorSettingsView;
  /** Values being edited (advanced map, or a game's advanced overrides). */
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  /** Game profile: only per-game settings, values fall back to the global ones. */
  overrideMode?: boolean;
  /** Override mode: the global advanced values. */
  base?: Record<string, string>;
}) {
  const { view } = props;
  const defs = useMemo(() => view.defs.filter((d) => !props.overrideMode || d.perGame !== false), [view.defs, props.overrideMode]);
  const tabs = SETTING_CATEGORIES.filter((c) => defs.some((d) => d.category === c.id));
  const [tab, setTab] = useState<SettingCategory | 'all'>(tabs[0]?.id ?? 'all');
  const [query, setQuery] = useState('');
  if (!defs.length) return <p className="muted small">This emulator has no extra settings in OmniPC yet. Use "Open emulator" for anything else.</p>;

  const q = query.trim().toLowerCase();
  const shown = defs.filter((d) => (q ? `${d.label} ${d.description}`.toLowerCase().includes(q) : tab === 'all' || d.category === tab));
  // Global value for a setting: what OmniPC saved, else what the emulator has now, else its default.
  const globalValue = (d: SettingDef) => (props.overrideMode ? props.base?.[d.key] : undefined) ?? view.saved[d.key] ?? view.current[d.key] ?? d.default;
  const effective = (d: SettingDef) => props.value[d.key] ?? globalValue(d);
  const set = (d: SettingDef, v: string) => props.onChange({ ...props.value, [d.key]: v });
  const clear = (d: SettingDef) => {
    const next = { ...props.value };
    delete next[d.key];
    props.onChange(next);
  };
  const changedCount = defs.filter((d) => effective(d) !== d.default).length;

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input type="search" placeholder="Search settings…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ maxWidth: 260 }} aria-label="Search settings" />
        {!q && <Segmented<SettingCategory | 'all'> value={tab} onChange={setTab} options={[...tabs.map((t) => ({ value: t.id, label: t.label })), { value: 'all', label: 'All' }]} />}
        <span className="grow" />
        {!props.overrideMode && <span className="small faint">{changedCount} changed from the emulator's defaults</span>}
      </div>
      {shown.length === 0 && <p className="muted small">No setting matches "{query}".</p>}
      {shown.map((d) => {
        const v = effective(d);
        const overridden = props.overrideMode && props.value[d.key] !== undefined;
        const inEmulator = !props.overrideMode && view.current[d.key] !== undefined && view.saved[d.key] !== undefined && view.current[d.key] !== view.saved[d.key];
        return (
          <div key={d.key} className="col" style={{ gap: 4, paddingBottom: 10, borderBottom: '1px solid var(--line, rgba(127,127,127,.15))' }}>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <strong className="grow">{d.label}</strong>
              {d.recommended !== undefined && v === d.recommended && <Chip tone="ok">Recommended</Chip>}
              {d.risky && <Chip tone="warn" title="Can cause glitches or crashes in some games">Advanced</Chip>}
              {d.restartRequired && <Chip title="Takes effect the next time the emulator starts">Restart</Chip>}
              {overridden && <Chip tone="info">This game</Chip>}
              {inEmulator && <Chip tone="info" title={`Changed inside the emulator to ${display(d, view.current[d.key])}; applying here sets it back to OmniPC's value.`}>Changed in emulator</Chip>}
            </div>
            <span className="small muted">{d.description}</span>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <Control def={d} value={v} onChange={(x) => set(d, x)} />
              <span className="grow" />
              {d.recommended !== undefined && v !== d.recommended && <button className="btn ghost sm" onClick={() => set(d, d.recommended!)}>Use recommended ({display(d, d.recommended)})</button>}
              {props.overrideMode
                ? overridden && <button className="btn ghost sm" onClick={() => clear(d)}>Use global ({display(d, globalValue(d))})</button>
                : v !== d.default && <button className="btn ghost sm" onClick={() => set(d, d.default)}>Default ({display(d, d.default)})</button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function display(d: SettingDef, v: string): string {
  if (d.kind === 'toggle') return toBool(v) ? 'On' : 'Off';
  if (d.kind === 'select') return d.options?.find((o) => o.value === v)?.label ?? v;
  return d.unit ? `${v} ${d.unit}` : v;
}

function Control(props: { def: SettingDef; value: string; onChange: (v: string) => void }) {
  const { def: d, value } = props;
  switch (d.kind) {
    case 'toggle':
      return (
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={toBool(value)} onChange={(e) => props.onChange(e.target.checked ? 'true' : 'false')} />
          <span className="small">{toBool(value) ? 'On' : 'Off'}</span>
        </label>
      );
    case 'select':
      return (d.options?.length ?? 0) <= 5
        ? <Segmented<string> value={value} onChange={props.onChange} options={(d.options ?? []).map((o) => ({ value: o.value, label: o.label }))} />
        : <select value={value} onChange={(e) => props.onChange(e.target.value)} aria-label={d.label}>{(d.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
    case 'slider':
      return (
        <div className="row" style={{ minWidth: 260 }}>
          <input type="range" min={d.min} max={d.max} step={d.step ?? 1} value={Number(value)} onChange={(e) => props.onChange(e.target.value)} aria-label={d.label} className="grow" />
          <span className="small mono" style={{ minWidth: 60 }}>{value}{d.unit ? ` ${d.unit}` : ''}</span>
        </div>
      );
    case 'number':
      return <input type="number" min={d.min} max={d.max} step={d.step ?? 1} value={value} onChange={(e) => props.onChange(e.target.value)} style={{ maxWidth: 140 }} aria-label={d.label} />;
    default:
      return <input type="text" value={value} onChange={(e) => props.onChange(e.target.value)} style={{ maxWidth: 320 }} aria-label={d.label} />;
  }
}
