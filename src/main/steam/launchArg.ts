// Command-line contract used by Steam shortcuts: `OmniPC.exe --launch-game=<gameId>`.

export const LAUNCH_GAME_ARG = '--launch-game';

/** Game id from argv (`--launch-game=12` or `--launch-game 12`), or null. */
export function parseLaunchGameArg(argv: readonly string[]): number | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let value: string | undefined;
    if (a.startsWith(`${LAUNCH_GAME_ARG}=`)) value = a.slice(LAUNCH_GAME_ARG.length + 1);
    else if (a === LAUNCH_GAME_ARG) value = argv[i + 1];
    else continue;
    const v = (value ?? '').trim().replace(/^"|"$/g, '');
    if (/^\d+$/.test(v) && Number(v) > 0 && Number.isSafeInteger(Number(v))) return Number(v);
    return null;
  }
  return null;
}
