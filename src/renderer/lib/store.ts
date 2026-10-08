// Global UI state: live jobs, downloads, notifications, active session, toasts.

import { create } from 'zustand';
import type { ActiveSession, AppNotification, AppSettings, DownloadItem, JobStatus } from '@shared/models';
import { api, onEvent } from './api';

export interface Toast {
  id: number;
  level: AppNotification['level'];
  title: string;
  body: string;
}

interface State {
  settings: AppSettings | null;
  jobs: Record<string, JobStatus>;
  downloads: Record<string, DownloadItem>;
  notifications: AppNotification[];
  session: ActiveSession | null;
  toasts: Toast[];
  libraryVersion: number;
  emulatorsVersion: number;
  consoleMode: boolean;
  safeMode: boolean;
  paletteOpen: boolean;
  setSettings(s: AppSettings): void;
  toast(level: Toast['level'], title: string, body?: string): void;
  dismissToast(id: number): void;
  setPalette(open: boolean): void;
  setConsoleMode(on: boolean): void;
}

let toastId = 0;

export const useStore = create<State>((set, get) => ({
  settings: null,
  jobs: {},
  downloads: {},
  notifications: [],
  session: null,
  toasts: [],
  libraryVersion: 0,
  emulatorsVersion: 0,
  consoleMode: new URLSearchParams(window.location.search).get('console') === '1',
  safeMode: new URLSearchParams(window.location.search).get('safe') === '1',
  paletteOpen: false,
  setSettings: (s) => set({ settings: s }),
  toast: (level, title, body = '') => {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { id, level, title, body }].slice(-4) });
    setTimeout(() => get().dismissToast(id), level === 'error' ? 9000 : 5000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setPalette: (open) => set({ paletteOpen: open }),
  setConsoleMode: (on) => set({ consoleMode: on }),
}));

export async function bootstrapStore(): Promise<void> {
  const s = useStore.getState();
  const [settings, jobs, downloads, notifications, session] = await Promise.all([api('app.settings.get'), api('jobs.list'), api('downloads.list'), api('notifications.list'), api('launch.active')]);
  useStore.setState({
    settings,
    jobs: Object.fromEntries(jobs.map((j) => [j.id, j])),
    downloads: Object.fromEntries(downloads.map((d) => [d.id, d])),
    notifications,
    session,
  });
  onEvent('job.update', (j) => {
    useStore.setState({ jobs: { ...useStore.getState().jobs, [j.id]: j } });
    if (j.state === 'failed') s.toast('error', `${j.label} failed`, j.error ?? '');
  });
  onEvent('download.update', (d) => useStore.setState({ downloads: { ...useStore.getState().downloads, [d.id]: d } }));
  onEvent('notification', (n) => {
    useStore.setState({ notifications: [n, ...useStore.getState().notifications].slice(0, 100) });
    useStore.getState().toast(n.level, n.title, n.body);
  });
  onEvent('launch.started', (sess) => useStore.setState({ session: sess }));
  onEvent('launch.ended', () => useStore.setState({ session: null }));
  onEvent('library.changed', () => useStore.setState({ libraryVersion: useStore.getState().libraryVersion + 1 }));
  onEvent('emulators.changed', () => useStore.setState({ emulatorsVersion: useStore.getState().emulatorsVersion + 1 }));
  onEvent('app.consoleMode', ({ enabled }) => useStore.setState({ consoleMode: enabled }));
}

/** Resolves when a job finishes; used for "Install" buttons that then refresh. */
export function waitForJob(jobId: string): Promise<JobStatus> {
  return new Promise((resolve) => {
    const check = () => {
      const j = useStore.getState().jobs[jobId];
      if (j && j.state !== 'queued' && j.state !== 'running') {
        unsub();
        resolve(j);
      }
    };
    const unsub = useStore.subscribe(check);
    check();
  });
}
