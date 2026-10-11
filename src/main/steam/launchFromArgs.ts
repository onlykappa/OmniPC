// Starting a game from outside OmniPC (Steam shortcut: `OmniPC.exe --launch-game=<id>`).
//
// Behaviour:
//  - The game goes through the normal LaunchService, exactly like the Play button.
//  - Cold start (OmniPC was started just for this launch): when the game exits
//    normally OmniPC quits too, so Steam sees the session end. If the game
//    crashed or failed, OmniPC stays open on the failure screen instead.
//  - Already running (argv forwarded by `second-instance`): the game starts and
//    OmniPC stays open afterwards.
//  - If the launch is refused (emulator missing, BIOS missing, another game
//    running…) the window is shown and a notification explains why.

import type { AppContainer } from '../services/container';
import { getSystem } from '@shared/systems';
import { logger } from '../core/logger';

const log = logger.scope('steam');

export interface ExternalLaunchHost {
  showWindow(): void;
  quit(): void;
}

export async function launchFromCommandLine(c: Pick<AppContainer, 'launcher' | 'library' | 'notifications' | 'bus'>, gameId: number, opts: { coldStart: boolean }, host: ExternalLaunchHost): Promise<void> {
  const game = c.library.getGame(gameId);
  log.info('launch requested from command line', { gameId, coldStart: opts.coldStart, found: !!game });
  const r = await c.launcher.launchGame(gameId).catch((err: unknown) => ({ ok: false, launchId: null, error: { whatHappened: (err as Error)?.message ?? String(err), userAction: [] as string[] } }));
  if (!r.ok || r.launchId === null) {
    host.showWindow();
    const name = game ? `${game.title} (${getSystem(game.system_id)?.shortName ?? game.system_id})` : `Game #${gameId}`;
    c.notifications.add('error', `Couldn't start ${name} from Steam`, [r.error?.whatHappened, r.error?.userAction?.[0]].filter(Boolean).join(' '), { link: game ? `/game/${gameId}` : '/library' });
    return;
  }
  if (!opts.coldStart) return;
  const launchId = r.launchId;
  const off = c.bus.on('launch.ended', (e) => {
    if (e.launchId !== launchId) return;
    off();
    if (e.needsAnalysis) {
      host.showWindow();
      return;
    }
    log.info('game started from Steam ended; quitting OmniPC', { launchId, outcome: e.outcome });
    // Give the renderer and database a moment to settle before quitting.
    setTimeout(() => host.quit(), 500);
  });
}
