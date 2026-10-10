import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { identifyFile } from '../src/main/library/identify';
import { collectCandidates } from '../src/main/library/scanner';
import { sfo, write } from './fixtures/builders.mjs';
import { tempDir } from './helpers';

const t = tempDir();
afterAll(t.cleanup);
const root = join(t.dir, 'Games');

write(join(root, 'PS4', 'CUSA00001', 'eboot.bin'), Buffer.alloc(64, 1));
write(join(root, 'PS4', 'CUSA00001', 'sce_sys', 'param.sfo'), sfo({ TITLE: 'Test Game PS4', TITLE_ID: 'CUSA00001' }));
write(join(root, 'PS4', 'CUSA00001', 'data', 'stage1.bin'), Buffer.alloc(64, 2));
write(join(root, 'PS5', 'Homebrew', 'eboot.bin'), Buffer.alloc(64, 1));
write(join(root, 'PS5', 'Homebrew', 'sce_sys', 'param.json'), JSON.stringify({ titleId: 'PPSA00001', localizedParameters: { defaultLanguage: 'en-US', 'en-US': { titleName: 'Hello PS5' } } }));
write(join(root, 'PS3', 'Disc Game', 'PS3_GAME', 'USRDIR', 'EBOOT.BIN'), Buffer.alloc(64, 1));
write(join(root, 'PS3', 'Disc Game', 'PS3_GAME', 'USRDIR', 'data.bin'), Buffer.alloc(64, 3));
write(join(root, 'PS3', 'Disc Game', 'PS3_GAME', 'PARAM.SFO'), sfo({ TITLE: 'Disc Game PS3', TITLE_ID: 'BLUS30001' }));
write(join(root, 'PS3', 'NPUB30001', 'USRDIR', 'EBOOT.BIN'), Buffer.alloc(64, 1));
write(join(root, 'PS3', 'NPUB30001', 'PARAM.SFO'), sfo({ TITLE: 'PSN Game', TITLE_ID: 'NPUB30001' }));

describe('folder-format games', () => {
  it('identifies PS4, PS5 and PS3 folder games from their metadata', async () => {
    const ps4 = await identifyFile(join(root, 'PS4', 'CUSA00001', 'eboot.bin'), []);
    expect(ps4).toMatchObject({ systemId: 'ps4', title: 'Test Game PS4', serial: 'CUSA00001', confidence: 'high' });
    const ps5 = await identifyFile(join(root, 'PS5', 'Homebrew', 'eboot.bin'), []);
    expect(ps5).toMatchObject({ systemId: 'ps5', title: 'Hello PS5', serial: 'PPSA00001' });
    const disc = await identifyFile(join(root, 'PS3', 'Disc Game', 'PS3_GAME', 'USRDIR', 'EBOOT.BIN'), []);
    expect(disc).toMatchObject({ systemId: 'ps3', title: 'Disc Game PS3', serial: 'BLUS30001' });
    const psn = await identifyFile(join(root, 'PS3', 'NPUB30001', 'USRDIR', 'EBOOT.BIN'), []);
    expect(psn).toMatchObject({ systemId: 'ps3', title: 'PSN Game' });
  });

  it('adds only the boot executable of a folder game to the scan', async () => {
    const { files } = await collectCandidates(root);
    const rel = files.map((f) => f.path.slice(root.length + 1).replace(/\\/g, '/')).sort();
    expect(rel).toEqual([
      'PS3/Disc Game/PS3_GAME/USRDIR/EBOOT.BIN',
      'PS3/NPUB30001/USRDIR/EBOOT.BIN',
      'PS4/CUSA00001/eboot.bin',
      'PS5/Homebrew/eboot.bin',
    ]);
  });
});
