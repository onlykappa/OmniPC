// Typed event bus. Services emit; the IPC layer forwards events to renderer windows.

import type { OmniEventName, OmniEvents } from '@shared/ipc';

type Listener<E extends OmniEventName> = (payload: OmniEvents[E]) => void;

export class EventBus {
  private listeners = new Map<OmniEventName, Set<Listener<any>>>();
  private anyListeners = new Set<(name: OmniEventName, payload: unknown) => void>();

  on<E extends OmniEventName>(name: E, fn: Listener<E>): () => void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  onAny(fn: (name: OmniEventName, payload: unknown) => void): () => void {
    this.anyListeners.add(fn);
    return () => this.anyListeners.delete(fn);
  }

  emit<E extends OmniEventName>(name: E, payload: OmniEvents[E]): void {
    for (const fn of this.listeners.get(name) ?? []) {
      try { fn(payload); } catch { /* a listener must not break emitters */ }
    }
    for (const fn of this.anyListeners) {
      try { fn(name, payload); } catch { /* ignore */ }
    }
  }
}
