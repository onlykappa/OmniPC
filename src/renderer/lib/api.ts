// Typed bridge to the main process. All backend calls go through `api()`.

import type { OmniApi, OmniEventName, OmniEvents, IpcErrorPayload } from '@shared/ipc';
import type { OmniError } from '@shared/models';

interface Bridge {
  invoke(method: string, ...args: unknown[]): Promise<unknown>;
  on(handler: (name: string, payload: unknown) => void): () => void;
  artUrl(path: string): string;
}

declare global {
  interface Window {
    omni?: Bridge;
  }
}

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly detail: OmniError | null) {
    super(message);
  }
}

function bridge(): Bridge {
  if (!window.omni) throw new ApiError('NO_BRIDGE', 'OmniPC backend is not available. Start the app with Electron.', null);
  return window.omni;
}

export async function api<M extends keyof OmniApi>(method: M, ...args: Parameters<OmniApi[M]>): Promise<Awaited<ReturnType<OmniApi[M]>>> {
  const res = (await bridge().invoke(method, ...args)) as unknown;
  if (res && typeof res === 'object' && (res as IpcErrorPayload).__omniError) {
    const e = res as IpcErrorPayload;
    throw new ApiError(e.code, e.message, e.detail);
  }
  return res as Awaited<ReturnType<OmniApi[M]>>;
}

type Handler<E extends OmniEventName> = (p: OmniEvents[E]) => void;
const handlers = new Map<OmniEventName, Set<Handler<any>>>();
let unsub: (() => void) | null = null;

export function onEvent<E extends OmniEventName>(name: E, fn: Handler<E>): () => void {
  if (!unsub && window.omni) {
    unsub = window.omni.on((n, p) => {
      for (const h of handlers.get(n as OmniEventName) ?? []) h(p as never);
    });
  }
  let set = handlers.get(name);
  if (!set) handlers.set(name, (set = new Set()));
  set.add(fn);
  return () => set!.delete(fn);
}

export function artUrl(path: string | null | undefined): string | null {
  if (!path || !window.omni) return null;
  return window.omni.artUrl(path);
}

export function hasBridge(): boolean {
  return !!window.omni;
}
