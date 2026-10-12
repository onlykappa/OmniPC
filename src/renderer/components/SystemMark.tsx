// A system's badge: an original outline drawing of the kind of device plus its
// short name, in the system's accent colour. Deliberately not the manufacturers'
// logos (trademarks of Sony, Nintendo, Microsoft, Sega; OmniPC is independent).

import type { ReactElement } from 'react';
import type { SystemId } from '@shared/systems';

type Device = 'console' | 'cartridge' | 'handheld' | 'wide' | 'clamshell' | 'hybrid' | 'arcade';

const DEVICE: Record<SystemId, Device> = {
  ps1: 'console', ps2: 'console', ps3: 'console', ps4: 'console', ps5: 'console',
  gc: 'console', wii: 'console', wiiu: 'console', xbox: 'console', x360: 'console',
  nes: 'cartridge', snes: 'cartridge', n64: 'cartridge', genesis: 'cartridge',
  gb: 'handheld', gbc: 'handheld', psp: 'wide', gba: 'wide',
  nds: 'clamshell', switch: 'hybrid', arcade: 'arcade',
};

const GLYPH: Record<Device, ReactElement> = {
  console: <><rect x="3" y="8" width="18" height="9" rx="2" /><path d="M7 12.5h5M16.5 12.5h.01" /></>,
  cartridge: <><rect x="3" y="11" width="18" height="8" rx="2" /><path d="M8 11V6h8v5M7 15h3M16.5 15h.01" /></>,
  handheld: <><rect x="6" y="2.5" width="12" height="19" rx="2" /><rect x="8.5" y="5" width="7" height="6" rx="1" /><path d="M9 16h2M10 15v2M15 16h.01" /></>,
  wide: <><rect x="2" y="7" width="20" height="10" rx="4" /><rect x="7.5" y="9" width="9" height="6" rx="1" /><path d="M4.5 12h1.5M5.25 11.25v1.5M18.5 12h.01" /></>,
  clamshell: <><rect x="5" y="2.5" width="14" height="9" rx="1.5" /><rect x="5" y="12.5" width="14" height="9" rx="1.5" /><rect x="8" y="4.5" width="8" height="5" /><rect x="8" y="14.5" width="8" height="5" /></>,
  hybrid: <><rect x="6.5" y="6" width="11" height="12" rx="1" /><path d="M6.5 6H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h1.5M17.5 6H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-1.5M4.75 10h.01M19.25 14h.01" /></>,
  arcade: <><path d="M7 21V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v17" /><rect x="9" y="5.5" width="6" height="5" /><path d="M6 14h12v7H6zM10 17.5h.01M13 17.5h2" /></>,
};

export function SystemMark(props: { system: { id: SystemId; shortName: string; accent: string }; size?: number }) {
  const { system: s, size = 44 } = props;
  return (
    <span className="system-mark" style={{ ['--accent' as string]: s.accent }} aria-hidden="true">
      <span className="system-mark-icon" style={{ width: size, height: size }}>
        <svg viewBox="0 0 24 24" width={size * 0.6} height={size * 0.6} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          {GLYPH[DEVICE[s.id] ?? 'console']}
        </svg>
      </span>
      <span className="system-mark-label">{s.shortName}</span>
    </span>
  );
}
