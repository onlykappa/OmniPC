import { useEffect, useRef, useState } from 'react';
import type { HotkeyAction, UniversalButton, UniversalControllerProfile } from '@shared/models';
import { api } from '../lib/api';
import { useLoad } from '../lib/hooks';
import { useStore } from '../lib/store';
import { STANDARD_BUTTONS, describePad, pads } from '../lib/gamepad';
import { Button, Chip, Modal, Panel, Spinner, Toggle } from '../components/ui';

function useLivePads(): Gamepad[] {
  const [, setTick] = useState(0);
  useEffect(() => {
    let raf = 0;
    const loop = () => { setTick((t) => (t + 1) % 1e6); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return pads();
}

const LABELS: Partial<Record<UniversalButton, string>> = { DPadUp: 'D-Up', DPadDown: 'D-Down', DPadLeft: 'D-Left', DPadRight: 'D-Right', Select: 'Select/Back', Guide: 'Guide' };

export function ControllersPage() {
  const live = useLivePads();
  const { data: profile, reload } = useLoad(() => api('controllers.profile'), []);
  const settings = useStore((s) => s.settings);
  const [remap, setRemap] = useState(false);
  const [applying, setApplying] = useState(false);
  const toast = useStore((s) => s.toast);
  if (!profile || !settings) return <div className="page"><Spinner /></div>;
  const save = async (p: Partial<UniversalControllerProfile>) => {
    const { id: _id, updatedAt: _u, ...rest } = profile;
    await api('controllers.saveProfile', { ...rest, ...p });
    reload();
  };
  const apply = async () => {
    setApplying(true);
    try {
      const r = await api('controllers.apply');
      toast('success', `Controller profile applied to ${r.applied.length} emulator(s)`, r.skipped.map((s) => `${s.emulatorId}: ${s.reason}`).join(' '));
    } finally { setApplying(false); }
  };
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Controllers</h1><p>Configure your controller once. OmniPC translates it into every emulator's own mapping.</p></div>
        <div className="row"><Button onClick={() => setRemap(true)}>Controller setup</Button><Button variant="primary" busy={applying} onClick={apply}>Apply to all emulators</Button></div>
      </div>
      <Panel title="Connected controllers">
        {live.length === 0 ? <p className="muted">No controller detected. Connect one by USB or Bluetooth and press any button (browsers only report controllers after a button press).</p> : live.map((p) => {
          const d = describePad(p);
          return (
            <div key={p.index} className="col" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 16 }}>
              <div className="row"><strong>Player {p.index + 1}: {d.name}</strong><Chip>{d.kind}</Chip><Chip>Input: {d.api}</Chip><Chip>Connection: {d.connection === 'Unknown' ? 'not reported by Windows' : d.connection}</Chip><Chip>Battery: not reported</Chip>{p.index === profile.deviceIndex && <Chip tone="ok">Player 1 profile</Chip>}</div>
              <div className="row" style={{ alignItems: 'flex-start', gap: 24 }}>
                <div className="pad-diagram grow">
                  {STANDARD_BUTTONS.map((b, i) => <div key={b} className={`pad-btn ${p.buttons[i]?.pressed ? 'on' : ''}`}>{LABELS[b] ?? b}{p.buttons[i] && p.buttons[i].value > 0 && p.buttons[i].value < 1 ? ` ${Math.round(p.buttons[i].value * 100)}%` : ''}</div>)}
                </div>
                <div className="row">
                  <div className="col" style={{ alignItems: 'center' }}><div className="stick"><span style={{ transform: `translate(${(p.axes[0] ?? 0) * 34}px, ${(p.axes[1] ?? 0) * 34}px)` }} /></div><span className="tiny faint">Left stick</span></div>
                  <div className="col" style={{ alignItems: 'center' }}><div className="stick"><span style={{ transform: `translate(${(p.axes[2] ?? 0) * 34}px, ${(p.axes[3] ?? 0) * 34}px)` }} /></div><span className="tiny faint">Right stick</span></div>
                </div>
              </div>
              <div className="tiny faint">Press buttons to test them. Raw id: {p.id}</div>
            </div>
          );
        })}
      </Panel>
      <div className="grid cols-2">
        <Panel title="Universal profile">
          <label className="field">Player 1 controller slot
            <select value={profile.deviceIndex} onChange={(e) => void save({ deviceIndex: Number(e.target.value) })}>
              {[0, 1, 2, 3].map((i) => <option key={i} value={i}>Slot {i + 1}{live.find((p) => p.index === i) ? ` — ${describePad(live.find((p) => p.index === i)!).name}` : ''}</option>)}
            </select>
          </label>
          <label className="field">Controller type (used for emulator device naming)
            <select value={profile.controllerKind} onChange={(e) => void save({ controllerKind: e.target.value as UniversalControllerProfile['controllerKind'] })}>
              <option value="xbox">Xbox / XInput</option><option value="dualsense">DualSense</option><option value="dualshock4">DualShock 4</option><option value="switch_pro">Switch Pro Controller</option><option value="generic">Generic</option>
            </select>
          </label>
          <Toggle label="Vibration" value={profile.rumble} onChange={(v) => void save({ rumble: v })} />
          <Toggle label="Nintendo button layout for Nintendo systems" description="Swaps A/B and X/Y for NES/SNES/N64/handhelds (not GameCube/Wii, which use positions)." value={profile.nintendoLayoutForNintendoSystems} onChange={(v) => void save({ nintendoLayoutForNintendoSystems: v })} />
          <label className="field">Stick deadzone: {Math.round(profile.deadzone * 100)}%<input type="range" min={0} max={0.5} step={0.01} value={profile.deadzone} onChange={(e) => void save({ deadzone: Number(e.target.value) })} /></label>
          <div className="small faint">Customised buttons: {Object.entries(profile.mapping).filter(([k, v]) => k !== v).map(([k, v]) => `${k}→${v}`).join(', ') || 'none (default layout)'}</div>
        </Panel>
        <HotkeysPanel />
      </div>
      {remap && <RemapWizard profile={profile} onClose={() => { setRemap(false); reload(); }} />}
    </div>
  );
}

const HOTKEY_LABELS: Record<HotkeyAction, string> = { exit: 'Exit game', saveState: 'Save state', loadState: 'Load state', volumeUp: 'Volume up', volumeDown: 'Volume down', menu: 'Emulator menu', fastForward: 'Fast forward', screenshot: 'Screenshot', fullscreen: 'Toggle fullscreen' };
const BUTTON_CHOICES: UniversalButton[] = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'L3', 'R3', 'Start', 'Select', 'Guide', 'DPadUp', 'DPadDown', 'DPadLeft', 'DPadRight'];

function HotkeysPanel() {
  const settings = useStore((s) => s.settings)!;
  const setSettings = useStore((s) => s.setSettings);
  const hk = settings.hotkeys;
  const update = async (next: typeof hk) => setSettings(await api('app.settings.set', { hotkeys: next }));
  return (
    <Panel id="hotkeys" title="Universal hotkeys">
      <p className="small muted">Hold the modifier and press a button. Each emulator gets the actions it supports; its page lists any it can't map. Note: Windows Game Bar captures the Guide button by default, so Select is the default modifier.</p>
      <label className="field">Modifier
        <select value={hk.modifier} onChange={(e) => void update({ ...hk, modifier: e.target.value as UniversalButton })}>{BUTTON_CHOICES.map((b) => <option key={b}>{b}</option>)}</select>
      </label>
      {(Object.keys(HOTKEY_LABELS) as HotkeyAction[]).map((a) => (
        <div key={a} className="row">
          <span className="grow">{HOTKEY_LABELS[a]}</span>
          <span className="small faint">{hk.modifier} +</span>
          <select value={hk.bindings[a]} style={{ maxWidth: 140 }} onChange={(e) => void update({ ...hk, bindings: { ...hk.bindings, [a]: e.target.value as UniversalButton } })}>{BUTTON_CHOICES.map((b) => <option key={b}>{b}</option>)}</select>
        </div>
      ))}
      <div className="row"><Button onClick={() => void api('doctor.repair', 'hotkeys.restoreDefaults', {}, { confirmed: true }).then(async () => setSettings(await api('app.settings.get')))}>Restore default hotkeys</Button></div>
    </Panel>
  );
}

const WIZARD_ORDER: UniversalButton[] = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Select', 'Start', 'L3', 'R3', 'DPadUp', 'DPadDown', 'DPadLeft', 'DPadRight'];

function RemapWizard(props: { profile: UniversalControllerProfile; onClose: () => void }) {
  const [i, setI] = useState(0);
  const [mapping, setMapping] = useState({ ...props.profile.mapping });
  const waitRelease = useRef(true);
  const toast = useStore((s) => s.toast);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const pad = pads().find((p) => p.index === props.profile.deviceIndex) ?? pads()[0];
      if (pad) {
        const pressed = pad.buttons.findIndex((b) => b.pressed);
        if (pressed === -1) waitRelease.current = false;
        else if (!waitRelease.current && i < WIZARD_ORDER.length && STANDARD_BUTTONS[pressed]) {
          waitRelease.current = true;
          setMapping((m) => ({ ...m, [WIZARD_ORDER[i]]: STANDARD_BUTTONS[pressed] }));
          setI((x) => x + 1);
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [i, props.profile.deviceIndex]);
  const done = i >= WIZARD_ORDER.length;
  return (
    <Modal onClose={props.onClose}>
      <h2>Controller setup</h2>
      {!done ? (
        <>
          <p>Press the button you want to use as <strong style={{ fontSize: 22 }}>{WIZARD_ORDER[i]}</strong></p>
          <p className="small faint">{i + 1} of {WIZARD_ORDER.length}. Sticks keep their natural directions. Skip to keep the default.</p>
          <div className="row"><Button onClick={() => setI(i + 1)}>Skip</Button><Button onClick={() => { setMapping({ ...props.profile.mapping }); setI(0); }}>Start over</Button></div>
        </>
      ) : (
        <>
          <p>Mapping complete.</p>
          <div className="small">{WIZARD_ORDER.map((b) => `${b}→${mapping[b]}`).join(' · ')}</div>
          <div className="row right">
            <Button onClick={props.onClose}>Cancel</Button>
            <Button variant="primary" autoFocus onClick={async () => {
              const { id: _id, updatedAt: _u, ...rest } = props.profile;
              await api('controllers.saveProfile', { ...rest, mapping });
              const r = await api('controllers.apply');
              toast('success', 'Controller profile saved', `Applied to ${r.applied.length} emulator(s).`);
              props.onClose();
            }}>Save & apply</Button>
          </div>
        </>
      )}
    </Modal>
  );
}
