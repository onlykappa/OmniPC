// Tiny hash router (no dependency). Routes look like "#/game/12?tab=settings".

import { useEffect, useState } from 'react';

export interface Route {
  path: string;
  parts: string[];
  query: URLSearchParams;
}

function parse(): Route {
  const raw = window.location.hash.replace(/^#/, '') || '/home';
  const [path, qs] = raw.split('?');
  return { path, parts: path.split('/').filter(Boolean), query: new URLSearchParams(qs ?? '') };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function navigate(to: string): void {
  const target = to.startsWith('#') ? to : `#${to.startsWith('/') ? to : '/' + to}`;
  if (window.location.hash !== target) window.location.hash = target;
}

export function back(): void {
  if (window.history.length > 1) window.history.back();
  else navigate('/home');
}
