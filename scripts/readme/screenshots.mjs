// Takes the README screenshots: builds a demo library of fictional games (with
// original box art from covers.py), starts the built app against it with an
// isolated profile, and captures the main pages.
//
//   npm run build
//   python3 scripts/readme/covers.py <artDir> scripts/readme/demo-games.json
//   xvfb-run -s "-screen 0 1600x1000x24" node scripts/readme/screenshots.mjs <artDir> docs/images
import { _electron as electron } from 'playwright-core';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { nintendoHeader, ps1Bin, ps2Iso, sfo, write } from '../../tests/fixtures/builders.mjs';

const art = resolve(process.argv[2]);
const out = resolve(process.argv[3] ?? 'docs/images');
mkdirSync(out, { recursive: true });
const games = JSON.parse(readFileSync(new URL('./demo-games.json', import.meta.url), 'utf8'));
const home = mkdtempSync(join(tmpdir(), 'omnipc-readme-'));
const root = join(home, 'Games');

const xex = (titleId) => {
  const b = Buffer.alloc(0x200);
  b.write('XEX2', 0, 'latin1');
  b.writeUInt32BE(1, 0x14);
  b.writeUInt32BE(0x00040006, 0x18); b.writeUInt32BE(0x100, 0x1c);
  b.writeUInt32BE(titleId, 0x10c);
  return b;
};
const nsp = () => Buffer.concat([Buffer.from('PFS0', 'latin1'), Buffer.alloc(252)]);

// One file (or folder) per game, in system folders, with the cover next to it.
const FOLDER = { 'broken-ps1': 'PS1', switch: 'Switch', ps2: 'PS2', gc: 'GameCube', ps1: 'PS1', snes: 'SNES', x360: 'Xbox 360', nds: 'DS', n64: 'N64', gba: 'GBA', wii: 'Wii', ps3: 'PS3', gb: 'Game Boy' };
let n = 0;
for (const g of games) {
  const dir = join(root, FOLDER[g.sys]);
  let file;
  switch (g.sys) {
    case 'switch': file = join(dir, `${g.title}.nsp`); write(file, nsp()); break;
    case 'ps2': file = join(dir, `${g.title}.iso`); write(file, ps2Iso(`SLUS_2${String(10 + n).padStart(2, '0')}.${10 + n}`)); break;
    case 'gc': file = join(dir, `${g.title}.iso`); write(file, nintendoHeader(`G${String(n).padStart(2, 'Q')}E01`.slice(0, 6), g.title)); break;
    case 'wii': file = join(dir, `${g.title}.iso`); write(file, nintendoHeader('RFRE01', g.title, true)); break;
    case 'ps1': {
      file = join(dir, `${g.title}.cue`);
      write(join(dir, `${g.title}.bin`), ps1Bin(`SCUS_94${String(400 + n)}.00`.slice(0, 11)));
      write(file, `FILE "${g.title}.bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n`);
      break;
    }
    case 'x360': file = join(dir, g.title, 'default.xex'); write(file, xex(0x4f4d0000 + n)); break;
    case 'ps3': {
      const gameDir = join(dir, g.title, 'PS3_GAME');
      write(join(gameDir, 'PARAM.SFO'), sfo({ TITLE: g.title, TITLE_ID: `BLUS3${String(1000 + n)}` }));
      file = join(gameDir, 'USRDIR', 'EBOOT.BIN'); write(file, Buffer.alloc(64, 1));
      break;
    }
    case 'broken-ps1':
      // The CUE sheet names the track "(Track 1)" but the file is "(Track 01)": Fix games repairs it.
      write(join(dir, `${g.title} (Track 01).bin`), ps1Bin('SLUS_00999'));
      file = join(dir, `${g.title}.cue`);
      write(file, `FILE "${g.title} (Track 1).bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n`);
      break;
    default: file = join(dir, `${g.title}.${{ snes: 'sfc', nds: 'nds', n64: 'z64', gba: 'gba', gb: 'gb' }[g.sys]}`); write(file, Buffer.alloc(4096, n + 1));
  }
  g.file = file;
  n++;
}

const app = await electron.launch({
  executablePath: (await import('electron')).default,
  args: ['--no-sandbox', resolve('.'), `--user-data-dir=${join(home, 'userdata')}`],
  env: { ...process.env, HOME: home },
});
const page = await app.firstWindow();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(2500);
const inv = (m, ...a) => page.evaluate(([m, a]) => window.omni.invoke(m, ...a), [m, a]);
await inv('app.settings.set', { onboardingComplete: true, metadataOnline: false });
await inv('library.addPath', root);
await inv('library.scan', { full: true });
await page.waitForTimeout(4000);

// Covers, backgrounds and descriptions for the demo games.
const items = (await inv('library.query', { limit: 200, includeUnavailable: true })).items;
for (const g of games) {
  const it = items.find((i) => i.title.toLowerCase() === g.title.toLowerCase());
  if (!it) { console.log('not found', g.title); continue; }
  g.id = it.id;
  const cover = join(home, 'art', `${g.slug}-cover.png`);
  const bg = join(home, 'art', `${g.slug}-bg.png`);
  mkdirSync(join(home, 'art'), { recursive: true });
  copyFileSync(join(art, `${g.slug}-cover.png`), cover);
  copyFileSync(join(art, `${g.slug}-bg.png`), bg);
  await inv('metadata.update', it.id, { description: g.desc, developer: g.dev, publisher: g.dev, releaseYear: g.year, genre: g.genre, players: g.players });
  await inv('metadata.setArtwork', it.id, 'cover', cover);
  await inv('metadata.setArtwork', it.id, 'background', bg);
}
// A little play history so Home has "Continue playing".
await inv('library.setFavorite', games[0].id, true);
await inv('library.setFavorite', games[1].id, true);
await inv('doctor.run', 'full');
await page.waitForTimeout(4000);
await page.reload();
await page.waitForTimeout(2500);

const go = async (hash, wait = 1800) => { await page.evaluate((h) => (window.location.hash = h), hash); await page.waitForTimeout(wait); };
const shot = (name) => page.screenshot({ path: join(out, `${name}.png`) });
const scrollTo = async (selector) => {
  await page.evaluate((s) => {
    const el = document.querySelector(s);
    el?.scrollIntoView({ block: 'start' });
    // Leave room for the top bar so the panel header stays visible.
    let p = el?.parentElement;
    while (p && p.scrollHeight <= p.clientHeight) p = p.parentElement;
    p?.scrollBy(0, -90);
  }, selector);
  await page.waitForTimeout(500);
};
const panel = async (selector, name) => { await page.locator(selector).first().screenshot({ path: join(out, `${name}.png`) }); };

await go('/home'); await shot('home');
await go('/library'); await shot('library');
await go(`/game/${games[0].id}`, 2500); await shot('game');
await go('/emulators'); await shot('emulators');
await go('/emulators/pcsx2', 2500); await scrollTo('#all-settings'); await shot('emulator-settings');
await page.getByRole('button', { name: 'Optimize for my PC' }).first().click(); await page.waitForTimeout(1500); await shot('optimize');
await page.keyboard.press('Escape'); await page.waitForTimeout(500);
await go('/doctor', 2500); await shot('doctor');
await go('/doctor/games', 2500); await shot('fix-games');
await go('/settings', 2000); await panel('#achievements', 'retroachievements'); await panel('#saves', 'save-backups'); await panel('#steam', 'steam-panel');
await go('/controllers'); await shot('controllers');
await go('/share', 2000); await shot('share-copy');
await page.getByText('Share this PC', { exact: true }).first().click().catch(() => undefined); await page.waitForTimeout(800); await shot('share-this-pc');
await go('/systems'); await shot('systems');
await inv('app.setConsoleMode', true); await go('/home', 2500); await shot('console-mode');
await app.close();
console.log('screenshots written to', out);
