import { useEffect, useRef, type ReactNode } from 'react';
import type { JobStatus, Severity } from '@shared/models';

export function Button(props: { children: ReactNode; onClick?: () => void; variant?: 'primary' | 'danger' | 'ghost'; size?: 'sm' | 'big'; disabled?: boolean; busy?: boolean; title?: string; autoFocus?: boolean; type?: 'button' | 'submit' }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (props.autoFocus) ref.current?.focus();
  }, [props.autoFocus]);
  return (
    <button ref={ref} type={props.type ?? 'button'} className={`btn ${props.variant ?? ''} ${props.size ?? ''}`} onClick={props.onClick} disabled={props.disabled || props.busy} title={props.title} data-autofocus={props.autoFocus ? '' : undefined}>
      {props.busy && <span className="spinner" />}
      {props.children}
    </button>
  );
}

export function Panel(props: { title?: ReactNode; actions?: ReactNode; children: ReactNode; flat?: boolean; id?: string }) {
  return (
    <section className={`panel ${props.flat ? 'flat' : ''}`} id={props.id}>
      {(props.title || props.actions) && (
        <div className="panel-title">
          {typeof props.title === 'string' ? <h3>{props.title}</h3> : props.title}
          {props.actions && <div className="row">{props.actions}</div>}
        </div>
      )}
      {props.children}
    </section>
  );
}

export function Chip(props: { children: ReactNode; tone?: 'ok' | 'warn' | 'bad' | 'info' | 'planned'; title?: string }) {
  return <span className={`chip ${props.tone ?? ''}`} title={props.title}>{props.children}</span>;
}

export function Toggle(props: { label: string; description?: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="toggle">
      <div>
        <div>{props.label}</div>
        {props.description && <div className="small faint">{props.description}</div>}
      </div>
      <button className={`switch ${props.value ? 'on' : ''}`} role="switch" aria-checked={props.value} aria-label={props.label} disabled={props.disabled} onClick={() => props.onChange(!props.value)} />
    </div>
  );
}

export function Segmented<T extends string | number>(props: { value: T; options: { value: T; label: string; disabled?: boolean; title?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="radiogroup">
      {props.options.map((o) => (
        <button key={String(o.value)} className={o.value === props.value ? 'on' : ''} disabled={o.disabled} title={o.title} role="radio" aria-checked={o.value === props.value} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Modal(props: { children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => {
      const root = document.querySelector('[data-modal]:last-of-type');
      (root?.querySelector<HTMLElement>('[data-autofocus]') ?? root?.querySelector<HTMLElement>('button, input, select'))?.focus();
    }, 30);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="modal-backdrop" data-modal onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" style={props.wide ? { width: 'min(980px, 94vw)' } : undefined} role="dialog" aria-modal="true">
        {props.children}
      </div>
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export function Empty(props: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{props.title}</h3>
      {props.children && <div className="muted">{props.children}</div>}
      {props.action}
    </div>
  );
}

export function HealthRing(props: { value: number | null; label?: string; size?: number }) {
  const v = props.value ?? 0;
  const color = props.value === null ? 'var(--faint)' : v >= 90 ? 'var(--ok)' : v >= 70 ? 'var(--warn)' : 'var(--bad)';
  return (
    <div className="health-ring" style={{ ['--p' as string]: v, ['--c' as string]: color }}>
      <div>
        <div>
          <strong>{props.value === null ? '—' : `${v}%`}</strong>
          <span className="tiny faint">{props.label ?? 'Health'}</span>
        </div>
      </div>
    </div>
  );
}

export function ProgressBar(props: { value: number | null; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className={`bar ${props.tone ?? ''}`}>
      <div style={{ width: props.value === null ? '30%' : `${Math.round(Math.max(0, Math.min(1, props.value)) * 100)}%` }} />
    </div>
  );
}

const SEV_ICON: Record<Severity, string> = { problem: '!', warning: '⚠', info: 'i', pass: '✓' };
export function SevIcon(props: { severity: Severity }) {
  return <span className={`sev ${props.severity}`}>{SEV_ICON[props.severity]}</span>;
}

export function healthTone(h: string): 'ok' | 'warn' | 'bad' | undefined {
  if (h === 'ready') return 'ok';
  if (h === 'attention') return 'warn';
  if (h === 'error') return 'bad';
  return undefined;
}

export function JobSteps(props: { job: JobStatus }) {
  const j = props.job;
  return (
    <div className="col">
      <div className="row">
        {j.state === 'running' || j.state === 'queued' ? <Spinner /> : j.state === 'succeeded' ? <Chip tone="ok">Done</Chip> : j.state === 'cancelled' ? <Chip>Cancelled</Chip> : <Chip tone="bad">Failed</Chip>}
        <strong>{j.label}</strong>
        <span className="muted small grow">{j.message}</span>
      </div>
      {(j.state === 'running' || j.progress !== null) && j.state !== 'succeeded' && <ProgressBar value={j.progress} />}
      <div className="steps">
        {j.steps.map((s, i) => (
          <div key={i} className={`step ${s.state}`}>
            <span className="ic">{s.state === 'done' ? '✓' : s.state === 'failed' ? '✗' : s.state === 'running' ? '•' : s.state === 'skipped' ? '–' : '○'}</span>
            <div>
              <div>{s.label}</div>
              {s.detail && <div className="small faint">{s.detail}</div>}
            </div>
          </div>
        ))}
      </div>
      {j.error && <div className="small" style={{ color: 'var(--bad)' }}>{j.error}</div>}
    </div>
  );
}
