import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';
import { useStore } from './store';

/** Loads data and reloads when any dependency (or a store version counter) changes. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: ApiError | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fnRef.current().then(
      (d) => { if (alive) { setData(d); setError(null); setLoading(false); } },
      (e) => { if (alive) { setError(e instanceof ApiError ? e : new ApiError('ERROR', String(e?.message ?? e), null)); setLoading(false); } },
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, loading, reload: useCallback(() => setN((x) => x + 1), []) };
}

/** Wraps an async action with busy state and error toasts. */
export function useAction<A extends unknown[], R>(fn: (...a: A) => Promise<R>, opts: { success?: string } = {}): [(...a: A) => Promise<R | undefined>, boolean] {
  const [busy, setBusy] = useState(false);
  const toast = useStore((s) => s.toast);
  const run = useCallback(async (...a: A) => {
    setBusy(true);
    try {
      const r = await fn(...a);
      if (opts.success) toast('success', opts.success);
      return r;
    } catch (e) {
      const err = e as ApiError;
      toast('error', err.message ?? 'Something went wrong', err.detail?.userAction?.[0] ?? err.detail?.probableCause ?? '');
      return undefined;
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fn]);
  return [run, busy];
}
