// Exercises the real Electron renderer and backend with fictional catalog data.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron } from 'playwright-core';
import yazl from 'yazl';

const home = mkdtempSync(join(tmpdir(), 'omnipc-discover-smoke-'));
const userData = join(home, 'userdata');
mkdirSync(userData);
writeFileSync(join(userData, 'bootstrap.json'), JSON.stringify({dataRoot: join(home, 'OmniPC'), overrides: {}}));
const fixture = join(home, 'fixture-release.zip');
const zip = new yazl.ZipFile();
const games = [{id: 'PPSA00001', title: 'Discover regression fixture', platform: 'ps5', genres: ['Adventure']}];
zip.addBuffer(Buffer.from(`native/data/catalog.js\nvar games = ${JSON.stringify(games)};\nvar twins = [];`), 'PPSA99058/eboot.bin');
zip.addBuffer(Buffer.from(JSON.stringify({about: ['Fixture description'], shots: []})), 'PPSA99058/data/pages/PPSA00001.json');
zip.addBuffer(Buffer.from(JSON.stringify([{id: 'fixture-source', record: 'fixture', provider: 'Example host', format: 'zip', version: '1.0', filename: 'fixture.zip', url: 'https://example.com/fixture.zip', requiresBrowser: true}])), 'PPSA99058/data/releases/PPSA00001.json');
const chunks = [];
zip.outputStream.on('data', chunk => chunks.push(chunk));
const zipped = new Promise((resolve, reject) => {zip.outputStream.on('end', resolve);zip.outputStream.on('error', reject);});
zip.end();
await zipped;
writeFileSync(fixture, Buffer.concat(chunks));

let app;
const errors = [];
try {
  app = await electron.launch({executablePath: (await import('electron')).default,
    args: ['--no-sandbox', resolve('.'), `--user-data-dir=${userData}`],
    env: {...process.env}, timeout: 60000});
  const page = await app.firstWindow();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => {if(m.type() === 'error') errors.push(m.text());});
  const invoke = (method, ...args) => page.evaluate(([method, args]) => window.omni.invoke(method, ...args), [method, args]);
  await page.waitForFunction(() => !!window.omni);
  const settings = await invoke('app.settings.set', {onboardingComplete: true});
  assert.ok(!settings?.__omniError, JSON.stringify(settings));
  await page.reload();
  await page.locator('.nav-item').filter({hasText: 'Discover'}).click();
  await page.getByRole('heading', {name: 'Discover', exact: true}).waitFor();
  await page.getByRole('button', {name: 'Load Overdrive catalog', exact: true}).waitFor();
  await page.getByText('Your catalog starts here', {exact: true}).waitFor();
  await page.waitForTimeout(500);
  assert.deepEqual(errors, [], 'The empty Discover page must not crash');

  // Replace only the file picker in this isolated test process. The actual import,
  // job events, persistent catalog and renderer all run normally.
  await app.evaluate(({dialog}, fixture) => {dialog.showOpenDialog = async () => ({canceled: false, filePaths: [fixture]});}, fixture);
  await page.getByRole('button', {name: 'Import release ZIP', exact: true}).click();
  await page.getByRole('button', {name: /Discover regression fixture, PS5, Not downloaded/}).waitFor();
  const query = await invoke('discover.query', {});
  assert.equal(query.catalogCount, 1);
  await page.getByRole('button', {name: /Discover regression fixture, PS5, Not downloaded/}).click();
  await page.getByRole('dialog').getByRole('heading', {name: 'Discover regression fixture', exact: true}).waitFor();
  await page.getByRole('dialog').locator('summary').click();
  await page.getByRole('button', {name: 'Open source', exact: true}).waitFor();
  assert.equal(await page.getByRole('button', {name: 'Download file', exact: true}).count(), 0);
  await page.getByRole('button', {name: '← Discover', exact: true}).click();
  await page.getByRole('textbox', {name: 'Search Discover'}).fill('missing fixture');
  await page.getByText('No matching games', {exact: true}).waitFor();
  await page.getByRole('textbox', {name: 'Search Discover'}).fill('');
  await page.getByRole('button', {name: /Discover regression fixture, PS5, Not downloaded/}).waitFor();
  await page.reload();
  await page.getByRole('button', {name: /Discover regression fixture, PS5, Not downloaded/}).waitFor();
  assert.deepEqual(errors, [], 'Discover must remain mounted through job events and reload');
  console.log('Discover UI smoke passed: empty state, import, job updates, detail, source controls, search, reload.');
} finally {
  if (app) await app.close();
  rmSync(home, {recursive: true, force: true});
}
