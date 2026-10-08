// Runs a repair with the safety model enforced in the UI:
// SAFE runs immediately, LOW RISK asks for approval, HIGH IMPACT requires an
// explicit confirmation that names what will change.

import { useState } from 'react';
import type { RepairRecord, RepairSuggestion } from '@shared/models';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Button, Chip, Modal } from './ui';

const SAFETY_LABEL = { safe: 'Safe', low: 'Low risk', high: 'High impact', never: 'Never automatic' } as const;

export function SafetyChip(props: { safety: RepairSuggestion['safety'] }) {
  const tone = props.safety === 'safe' ? 'ok' : props.safety === 'low' ? 'info' : 'warn';
  return <Chip tone={tone}>{SAFETY_LABEL[props.safety]}</Chip>;
}

export function RepairButton(props: { suggestion: RepairSuggestion; onDone?: (r: RepairRecord) => void; primary?: boolean; label?: string }) {
  const s = props.suggestion;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RepairRecord | null>(null);
  const toast = useStore((x) => x.toast);
  const run = async () => {
    setConfirming(false);
    setBusy(true);
    try {
      const r = await api('doctor.repair', s.actionId, s.params, { confirmed: true });
      setResult(r);
      toast(r.status === 'succeeded' ? 'success' : 'error', r.status === 'succeeded' ? r.message : `Repair failed: ${r.message}`);
      props.onDone?.(r);
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant={props.primary ? 'primary' : undefined} busy={busy} onClick={() => (s.safety === 'safe' ? run() : setConfirming(true))}>
        {props.label ?? s.label}
      </Button>
      {result && result.status === 'succeeded' && <span className="small" style={{ color: 'var(--ok)' }}>✓ {result.message}</span>}
      {confirming && (
        <Modal onClose={() => setConfirming(false)}>
          <div className="row"><h2>{s.label}</h2><SafetyChip safety={s.safety} /></div>
          <p className="muted">{s.description}</p>
          {s.safety === 'high' && <p>This is a high-impact repair. OmniDeck backs up affected configuration first. Your games, saves and BIOS files are never deleted.</p>}
          {s.safety === 'low' && <p className="small faint">Configuration is backed up first and the change can be undone from Repair History.</p>}
          <div className="row right">
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="primary" onClick={run} autoFocus>{s.safety === 'high' ? 'Yes, do it' : 'Approve'}</Button>
          </div>
        </Modal>
      )}
    </>
  );
}
