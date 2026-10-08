// Preload bridge. Exposes a minimal, typed surface: one invoke function and an
// event subscription. No Node APIs reach the renderer.

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('omni', {
  invoke: (method: string, ...args: unknown[]) => ipcRenderer.invoke('omni:invoke', method, args),
  on: (handler: (name: string, payload: unknown) => void) => {
    const listener = (_e: unknown, name: string, payload: unknown) => handler(name, payload);
    ipcRenderer.on('omni:event', listener);
    return () => ipcRenderer.removeListener('omni:event', listener);
  },
  artUrl: (path: string) => `omni-art://local/${encodeURIComponent(path)}`,
});
