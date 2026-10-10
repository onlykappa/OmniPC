// Electron main process entry: window, IPC bridge, artwork protocol, safe
// mode, console mode and lifecycle. Business logic lives in AppContainer.

import { app, BrowserWindow, dialog, ipcMain, nativeImage, net, protocol, screen, shell } from 'electron';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import type { DisplayInfo } from '@shared/models';
import type { IpcErrorPayload } from '@shared/ipc';
import { AppContainer } from './services/container';
import { createApi } from './ipc/handlers';
import { OmniFailure } from './core/errors';
import { logger } from './core/logger';

const log = logger.scope('main');
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

protocol.registerSchemesAsPrivileged([{ scheme: 'omni-art', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

// The app was renamed from "OmniDeck PC" to "OmniPC". Electron derives the
// userData folder from the product name, so keep using the old folder (it holds
// bootstrap.json, which points at the library/emulator root) when it exists.
{
  const legacyUserData = join(app.getPath('appData'), 'OmniDeck PC');
  if (!existsSync(app.getPath('userData')) && existsSync(legacyUserData)) app.setPath('userData', legacyUserData);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win: BrowserWindow | null = null;
let container: AppContainer | null = null;

/** Crash detection: a marker that survives an unclean exit. Two in a row -> safe mode. */
function decideSafeMode(): { safe: boolean; reason: string | null } {
  if (process.argv.includes('--safe-mode') || process.env.OMNIDECK_SAFE_MODE === '1') return { safe: true, reason: 'Requested' };
  const marker = join(app.getPath('userData'), 'running.marker');
  let unclean = 0;
  try {
    unclean = existsSync(marker) ? Number(readFileSync(marker, 'utf8')) || 1 : 0;
  } catch {
    unclean = 1;
  }
  writeFileSync(marker, String(unclean + 1));
  return unclean >= 2 ? { safe: true, reason: `OmniPC did not close cleanly ${unclean} times in a row` } : { safe: false, reason: null };
}

function displays(): DisplayInfo[] {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d) => ({
    width: Math.round(d.size.width * d.scaleFactor),
    height: Math.round(d.size.height * d.scaleFactor),
    refreshRate: d.displayFrequency || null,
    scaleFactor: d.scaleFactor,
    primary: d.id === primary,
  }));
}

async function thumbnailer(src: string, dest: string, width: number): Promise<boolean> {
  const img = nativeImage.createFromPath(src);
  if (img.isEmpty()) return false;
  const size = img.getSize();
  const resized = size.width > width ? img.resize({ width, quality: 'good' }) : img;
  writeFileSync(dest, resized.toJPEG(85));
  return true;
}

function serializeError(err: unknown): IpcErrorPayload {
  if (err instanceof OmniFailure) return { __omniError: true, code: err.detail.code, message: err.detail.whatHappened, detail: err.detail };
  const e = err as Error;
  const wrapped = OmniFailure.wrap(err, 'INTERNAL', e?.message || 'An internal error occurred.');
  return { __omniError: true, code: wrapped.detail.code, message: wrapped.detail.whatHappened, detail: wrapped.detail };
}

function createWindow(consoleMode: boolean, safeMode: boolean): BrowserWindow {
  const w = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0b0d12',
    title: safeMode ? 'OmniPC (Safe Mode)' : 'OmniPC',
    show: false,
    fullscreen: consoleMode,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  w.once('ready-to-show', () => w.show());
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost:') && !url.startsWith('file://')) e.preventDefault();
  });
  const devUrl = process.env.OMNIDECK_DEV_SERVER_URL;
  const query = new URLSearchParams({ console: consoleMode ? '1' : '0', safe: safeMode ? '1' : '0' }).toString();
  if (devUrl) void w.loadURL(`${devUrl}?${query}`);
  else void w.loadFile(join(__dirname, '../renderer/index.html'), { search: query });
  return w;
}

app.whenReady().then(async () => {
  const { safe, reason } = decideSafeMode();
  container = new AppContainer({
    userDataDir: app.getPath('userData'),
    homeDir: homedir(),
    safeMode: safe,
    host: {
      thumbnailer,
      displays,
      onSessionStart: () => win?.minimize(),
      onSessionEnd: () => {
        if (!win) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      },
    },
  });
  log.info('OmniPC starting', { version: app.getVersion(), safeMode: safe, reason });
  const c = container;

  protocol.handle('omni-art', async (req) => {
    const p = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, ''));
    if (!IMAGE_EXT.has(extname(p).toLowerCase()) || !existsSync(p)) return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(p).toString());
  });

  const consoleMode = !safe && c.settings.get('consoleModeOnStart');
  win = createWindow(consoleMode, safe);
  win.on('closed', () => (win = null));

  const api = createApi(c, {
    appInfo: () => ({ version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, platform: `${process.platform} ${process.arch}`, isPackaged: app.isPackaged }),
    openPath: (p) => void shell.openPath(p),
    openExternal: (url) => void shell.openExternal(url),
    pickFolder: async (title) => {
      const r = await dialog.showOpenDialog(win!, { title, properties: ['openDirectory', 'createDirectory'] });
      return r.canceled ? null : r.filePaths[0] ?? null;
    },
    pickFile: async (title, extensions) => {
      const r = await dialog.showOpenDialog(win!, { title, properties: ['openFile'], filters: extensions.length ? [{ name: 'Files', extensions: extensions.map((e) => e.replace(/^\./, '')) }] : [] });
      return r.canceled ? null : r.filePaths[0] ?? null;
    },
    relaunch: (safeMode) => {
      app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--safe-mode').concat(safeMode ? ['--safe-mode'] : []) });
      app.quit();
    },
    setConsoleMode: (enabled) => {
      win?.setFullScreen(enabled);
      c.bus.emit('app.consoleMode', { enabled });
    },
    setStartWithWindows: (enabled) => app.setLoginItemSettings({ openAtLogin: enabled, args: c.settings.get('consoleModeOnStart') ? ['--console'] : [] }),
  });

  ipcMain.handle('omni:invoke', async (event, method: string, args: unknown[]) => {
    if (event.sender !== win?.webContents) throw new Error('unknown sender');
    const fn = (api as Record<string, (...a: unknown[]) => unknown>)[method];
    if (!fn) return { __omniError: true, code: 'UNKNOWN_METHOD', message: `Unknown API method ${method}`, detail: null } satisfies IpcErrorPayload;
    try {
      return await fn(...(Array.isArray(args) ? args : []));
    } catch (err) {
      log.error(`api ${method} failed`, err);
      return serializeError(err);
    }
  });

  c.bus.onAny((name, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send('omni:event', name, payload);
  });

  if (safe && reason) c.notifications.add('warning', 'Started in Safe Mode', `${reason}. Background scanners, automatic repairs and auto-updates are disabled. Use Settings > Advanced to repair OmniPC, then restart normally.`);
  await c.startup().catch((e) => log.error('startup failed', e));
});

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.on('window-all-closed', () => app.quit());

app.on('will-quit', () => {
  container?.shutdown();
  try {
    rmSync(join(app.getPath('userData'), 'running.marker'), { force: true });
  } catch {
    /* ignore */
  }
});

process.on('uncaughtException', (err) => log.error('uncaught exception', err));
process.on('unhandledRejection', (err) => log.error('unhandled rejection', err));
