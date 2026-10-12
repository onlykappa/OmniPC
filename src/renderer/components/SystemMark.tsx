/// <reference types="vite/client" />
// A system's badge: the console's logo on a light panel (most logos are dark ink
// made for light backgrounds). Logos are bundled with the app (never fetched at
// runtime) and are trademarks of their owners, used only to identify the system;
// sources and licences are listed in src/renderer/assets/systems/SOURCES.md.
// Systems without a logo file (Arcade) get an outline drawing and their name.

import type { ReactElement } from 'react';
import type { SystemId } from '@shared/systems';

const LOGOS = import.meta.glob<string>('../assets/systems/*.svg', { eager: true, query: '?url', import: 'default' });
const logoFor = (id: SystemId): string | null => LOGOS[`../assets/systems/${id}.svg`] ?? null;

const ARCADE: ReactElement = <><path d="M7 21V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v17" /><rect x="9" y="5.5" width="6" height="5" /><path d="M6 14h12v7H6zM10 17.5h.01M13 17.5h2" /></>;

export function SystemMark(props: { system: { id: SystemId; name: string; shortName: string; accent: string }; height?: number }) {
  const { system: s, height = 64 } = props;
  const logo = logoFor(s.id);
  return (
    <span className="system-logo" style={{ height, ['--accent' as string]: s.accent }}>
      {logo ? (
        <img src={logo} alt={s.name} draggable={false} />
      ) : (
        <span className="system-logo-fallback">
          <svg viewBox="0 0 24 24" width={28} height={28} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ARCADE}</svg>
          {s.shortName}
        </span>
      )}
    </span>
  );
}
