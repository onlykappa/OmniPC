// Development runner: builds main/preload, starts the Vite dev server, then launches Electron
// pointed at it. Restart the script after changing main-process code.
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await new Promise((ok, fail) => {
  const p = spawn(process.execPath, [resolve(root, 'scripts/build-main.mjs')], { stdio: 'inherit' });
  p.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`build-main exited ${code}`))));
});
const server = await createServer({ configFile: resolve(root, 'vite.config.ts') });
await server.listen();
const url = server.resolvedUrls.local[0];
const electronPath = (await import('electron')).default;
const child = spawn(electronPath, [root], { stdio: 'inherit', env: { ...process.env, OMNIDECK_DEV_SERVER_URL: url } });
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
