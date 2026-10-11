// RetroAchievements sign-in, done the way emulators do it through rcheevos
// (src/api/rc_api_user.c rc_api_init_login_request + rc_api_process_login_server_response):
//   POST https://retroachievements.org/dorequest.php
//   Content-Type: application/x-www-form-urlencoded
//   r=login2&u=<user>&p=<password>
// Success: {"Success":true,"User":"Name","Token":"...","Score":..,"SoftcoreScore":..,"Messages":..,"AvatarUrl":..}
// Failure: {"Success":false,"Error":"...","Code":"invalid_credentials"|"access_denied"|"expired_token"|...,"Status":401}
// The password is only ever placed in this request body. Errors never echo it.

import { OmniFailure } from '../core/errors';

export const RA_HOST = 'https://retroachievements.org';
export const RA_DOREQUEST_URL = `${RA_HOST}/dorequest.php`;

export interface RaLoginResult {
  /** Case-corrected user name from the server; use it everywhere afterwards. */
  username: string;
  token: string;
  score: number | null;
  softcoreScore: number | null;
}

export function raUserAgent(appVersion: string): string {
  return `OmniPC/${appVersion} rcheevos-compatible`;
}

export function buildLoginRequest(username: string, password: string, userAgent: string): { url: string; init: RequestInit } {
  const body = new URLSearchParams();
  body.set('r', 'login2');
  body.set('u', username);
  body.set('p', password);
  return {
    url: RA_DOREQUEST_URL,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgent, Accept: 'application/json' },
      body: body.toString(),
    },
  };
}

const NETWORK_ADVICE = ['Check that this PC is online, then try again.', 'If other sites work, RetroAchievements may be down; try again later.'];

/** Interprets the login2 response (HTTP status + body text). Throws OmniFailure with a friendly message. */
export function parseLoginResponse(httpStatus: number, text: string): RaLoginResult {
  let json: Record<string, unknown> | null = null;
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) json = v as Record<string, unknown>;
  } catch {
    json = null;
  }
  const serverError = typeof json?.Error === 'string' ? json.Error.slice(0, 300) : null;
  const code = typeof json?.Code === 'string' ? json.Code : null;
  if (json?.Success === true) {
    const username = typeof json.User === 'string' ? json.User : '';
    const token = typeof json.Token === 'string' ? json.Token : '';
    if (!username || !token) throw new OmniFailure({ code: 'RA_BAD_RESPONSE', whatHappened: 'RetroAchievements accepted the sign-in but did not return a login token.', userAction: ['Try again in a few minutes.'] });
    const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    return { username, token, score: num(json.Score), softcoreScore: num(json.SoftcoreScore) };
  }
  if (code === 'invalid_credentials' || (httpStatus === 401 && code !== 'access_denied')) {
    throw new OmniFailure({
      code: 'RA_BAD_LOGIN',
      whatHappened: 'Wrong RetroAchievements user name or password.',
      detected: serverError ? [`RetroAchievements: ${serverError}`] : [],
      userAction: ['Check the spelling (the password is case-sensitive) and try again.', 'Forgot it? Reset it on retroachievements.org.'],
    });
  }
  if (code === 'access_denied' || httpStatus === 403) {
    throw new OmniFailure({
      code: 'RA_ACCESS_DENIED',
      whatHappened: 'RetroAchievements refused the sign-in for this account.',
      detected: serverError ? [`RetroAchievements: ${serverError}`] : [],
      userAction: ['Sign in on retroachievements.org to see whether the account needs attention (for example an unconfirmed email address).'],
    });
  }
  if (httpStatus >= 500 || httpStatus === 429) {
    throw new OmniFailure({ code: 'RA_SERVER', whatHappened: 'RetroAchievements is not responding properly right now.', detected: [`HTTP ${httpStatus}`], userAction: ['Try again in a few minutes.'] });
  }
  if (!json) {
    throw new OmniFailure({ code: 'RA_BAD_RESPONSE', whatHappened: 'RetroAchievements sent an unexpected answer.', detected: [`HTTP ${httpStatus}`], probableCause: 'A proxy, captive portal (hotel/airport Wi-Fi) or the site itself returned a web page instead of data.', userAction: NETWORK_ADVICE });
  }
  throw new OmniFailure({ code: 'RA_LOGIN_FAILED', whatHappened: serverError ? `RetroAchievements: ${serverError}` : 'RetroAchievements did not accept the sign-in.', detected: code ? [`Code ${code}`] : [], userAction: ['Try again; if it keeps failing, sign in on retroachievements.org to check the account.'] });
}

export async function loginToRetroAchievements(username: string, password: string, opts: { fetchImpl: typeof fetch; userAgent: string; timeoutMs?: number }): Promise<RaLoginResult> {
  const user = username.trim();
  if (!user || !password) throw new OmniFailure({ code: 'RA_MISSING_FIELDS', whatHappened: 'Enter your RetroAchievements user name and password.' });
  const { url, init } = buildLoginRequest(user, password, opts.userAgent);
  let res: Response;
  try {
    res = await opts.fetchImpl(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs ?? 20000) });
  } catch (err) {
    const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new OmniFailure({
      code: 'RA_OFFLINE',
      whatHappened: timeout ? 'RetroAchievements did not answer in time.' : 'Could not reach RetroAchievements.',
      probableCause: 'This PC appears to be offline, or a firewall is blocking retroachievements.org.',
      userAction: NETWORK_ADVICE,
      // Only the error class/message (never the request) goes to technical details.
      technical: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
  }
  const text = await res.text().catch(() => '');
  return parseLoginResponse(res.status, text);
}
