// Launches the built Electron app with an isolated profile and captures
// screenshots of the main pages. Usage: xvfb-run node scripts/smoke-electron.mjs <outDir> [home]
import { _electron as electron } from 'playwright-core';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const out = resolve(process.argv[2] ?? 'smoke-shots');
mkdirSync(out, { recursive: true });
const home = process.argv[3] ?? mkdtempSync(join(tmpdir(), 'omnideck-home-'));
const electronPath = (await import('electron')).default;
const app = await electron.launch({
  executablePath: electronPath,
  args: ['--no-sandbox', resolve('.'), `--user-data-dir=${join(home, 'userdata')}`],
  env: { ...process.env, HOME: home, OMNIDECK_LOG_STDOUT: '1' },
});
const page = await app.firstWindow();
page.on('console', (m) => console.log('[renderer]', m.type(), m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(2500);
await page.screenshot({ path: join(out, '00-start.png') });
if (process.env.SMOKE_SEED) {
  // Drive the real backend through the preload bridge, exactly like the UI does.
  const inv = (m, ...a) => page.evaluate(([m, a]) => window.omni.invoke(m, ...a), [m, a]);
  await inv('app.settings.set', { onboardingComplete: true });
  await inv('library.addPath', process.env.SMOKE_SEED);
  await inv('library.scan', { full: false });
  await page.waitForTimeout(3000);
  await inv('doctor.run', 'full');
  await page.waitForTimeout(2500);
  await page.reload();
  await page.waitForTimeout(2000);
}
const routes = process.env.SMOKE_ROUTES?.split(',') ?? [];
for (const r of routes) {
  await page.evaluate((h) => (window.location.hash = h), r);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(out, `${r.replace(/[^\w]+/g, '_')}.png`) });
}
await app.close();
console.log('smoke ok', out);
