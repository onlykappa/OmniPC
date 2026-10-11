import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppPaths } from '../src/main/core/paths';
import { OmniFailure } from '../src/main/core/errors';
import { migrate } from '../src/main/database/migrations';
import { SettingsRepo, DEFAULT_SETTINGS } from '../src/main/database/settingsRepo';
import { OpsRepo } from '../src/main/database/opsRepo';
import { ConfigBackupService } from '../src/main/config/backups';
import { AdapterRegistry } from '../src/main/emulators/registry';
import { IniDocument } from '../src/main/config/ini';
import { CfgDocument } from '../src/main/emulators/retroarch/cfg';
import { defaultProfile } from '../src/main/controllers/translate';
import { CHECKS } from '../src/main/diagnostics/checks';
import { ACTIONS } from '../src/main/repairs/engine';
import { buildLoginRequest, loginToRetroAchievements, parseLoginResponse, RA_DOREQUEST_URL, raUserAgent } from '../src/main/achievements/raApi';
import { TokenVault, type SecretCipher, type StoredRaToken } from '../src/main/achievements/tokenVault';
import {
  dolphinRaIniPath, duckstationDecryptToken, duckstationEncryptToken, inspectAchievementsConfig, pcsx2SecretsPath, ppssppTokenPath,
  redactAchievementFile, redactAchievementSecrets, retroArchKeychainPath, writeAchievementsConfig, type RaCredentials,
} from '../src/main/achievements/emulatorConfig';
import { RetroAchievementsService } from '../src/main/achievements/service';
import { RA_CREATE_ACCOUNT_URL } from '../src/shared/achievements';
import type { ConfigInput, EmulatorAdapter } from '../src/main/emulators/adapter';
import { tempDir } from './helpers';

const t = tempDir();
afterAll(t.cleanup);

const TOKEN = 'AbCdEf0123456789';
const PASSWORD = 'hunter2-Secret!';
const UA = raUserAgent('1.2.3');
const ini = (p: string) => IniDocument.parse(readFileSync(p, 'utf8'));

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return handler(String(url), init ?? {});
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const okResponse = () => new Response(JSON.stringify({ Success: true, User: 'PlayerOne', AvatarUrl: 'https://media.retroachievements.org/UserPic/PlayerOne.png', Token: TOKEN, Score: 120, SoftcoreScore: 4, Messages: 0, Permissions: 1, AccountType: 'Registered' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const badPassword = () => new Response(JSON.stringify({ Success: false, Error: 'Invalid User/Password combination. Please try again', Code: 'invalid_credentials', Status: 401 }), { status: 401 });

/** Reversible fake for Electron safeStorage. */
const fakeCipher = (available = true): SecretCipher => ({
  available: () => available,
  encrypt: (s) => Buffer.from(`enc:${Buffer.from(s).toString('hex')}`),
  decrypt: (b) => Buffer.from(b.toString().slice(4), 'hex').toString(),
});

function memoryStore() {
  let v: StoredRaToken | null = null;
  return { read: () => v, write: (x: StoredRaToken | null) => void (v = x), peek: () => v };
}

describe('RetroAchievements login request (rcheevos rc_api_init_login_request)', () => {
  it('POSTs r=login2&u=&p= form data to dorequest.php with an OmniPC user agent', () => {
    const { url, init } = buildLoginRequest('Player One', 'p&ss=word', UA);
    expect(url).toBe('https://retroachievements.org/dorequest.php');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('OmniPC/1.2.3 rcheevos-compatible');
    const body = new URLSearchParams(String(init.body));
    expect([...body.keys()]).toEqual(['r', 'u', 'p']);
    expect(body.get('r')).toBe('login2');
    expect(body.get('u')).toBe('Player One');
    expect(body.get('p')).toBe('p&ss=word');
    // Credentials never go into the URL.
    expect(url).not.toContain('p=');
    expect(RA_CREATE_ACCOUNT_URL).toBe('https://retroachievements.org/createaccount.php');
  });

  it('parses a successful login and returns the case-corrected user name and token', async () => {
    const f = fakeFetch(() => okResponse());
    const r = await loginToRetroAchievements('playerone', PASSWORD, { fetchImpl: f.fn, userAgent: UA });
    expect(r).toEqual({ username: 'PlayerOne', token: TOKEN, score: 120, softcoreScore: 4 });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe(RA_DOREQUEST_URL);
  });

  it('reports a wrong password as RA_BAD_LOGIN without echoing the password', async () => {
    const f = fakeFetch(() => badPassword());
    const err = await loginToRetroAchievements('PlayerOne', PASSWORD, { fetchImpl: f.fn, userAgent: UA }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OmniFailure);
    expect((err as OmniFailure).detail.code).toBe('RA_BAD_LOGIN');
    expect((err as OmniFailure).message).toMatch(/wrong/i);
    expect(JSON.stringify((err as OmniFailure).detail)).not.toContain(PASSWORD);
  });

  it('reports network failures as RA_OFFLINE', async () => {
    const f = fakeFetch(() => { throw new TypeError('fetch failed'); });
    const err = await loginToRetroAchievements('PlayerOne', PASSWORD, { fetchImpl: f.fn, userAgent: UA }).catch((e: unknown) => e);
    expect((err as OmniFailure).detail.code).toBe('RA_OFFLINE');
    expect(JSON.stringify((err as OmniFailure).detail)).not.toContain(PASSWORD);
  });

  it('maps other server answers to friendly failures', () => {
    const code = (s: number, b: string) => { try { parseLoginResponse(s, b); return 'ok'; } catch (e) { return (e as OmniFailure).detail.code; } };
    expect(code(403, JSON.stringify({ Success: false, Error: 'Access denied.', Code: 'access_denied', Status: 403 }))).toBe('RA_ACCESS_DENIED');
    expect(code(503, '<html>maintenance</html>')).toBe('RA_SERVER');
    expect(code(200, '<html>captive portal</html>')).toBe('RA_BAD_RESPONSE');
    expect(code(200, JSON.stringify({ Success: true, User: 'X' }))).toBe('RA_BAD_RESPONSE');
    expect(code(200, JSON.stringify({ Success: false, Error: 'Something else' }))).toBe('RA_LOGIN_FAILED');
  });

  it('requires both fields before contacting the server', async () => {
    const f = fakeFetch(() => okResponse());
    await expect(loginToRetroAchievements('  ', PASSWORD, { fetchImpl: f.fn, userAgent: UA })).rejects.toMatchObject({ detail: { code: 'RA_MISSING_FIELDS' } });
    expect(f.calls).toHaveLength(0);
  });
});

describe('token vault', () => {
  it('encrypts the token with the injected cipher and never stores it in plain text', () => {
    const store = memoryStore();
    const v = new TokenVault(store, fakeCipher());
    v.save('PlayerOne', TOKEN, 1700000000);
    const rec = store.peek()!;
    expect(rec.scheme).toBe('os');
    expect(JSON.stringify(rec)).not.toContain(TOKEN);
    expect(Buffer.from(rec.data, 'base64').toString()).not.toContain(TOKEN);
    expect(v.load()).toEqual({ username: 'PlayerOne', token: TOKEN, loginAt: 1700000000 });
    expect(v.info()).toEqual({ username: 'PlayerOne', protected: true, loginAt: 1700000000 });
    v.clear();
    expect(v.load()).toBeNull();
  });

  it('falls back to an unprotected record when encryption is unavailable, and refuses to guess when it disappears', () => {
    const store = memoryStore();
    new TokenVault(store, fakeCipher(false)).save('PlayerOne', TOKEN);
    expect(store.peek()!.scheme).toBe('plain');
    expect(new TokenVault(store, null).load()?.token).toBe(TOKEN);
    const s2 = memoryStore();
    new TokenVault(s2, fakeCipher()).save('PlayerOne', TOKEN);
    expect(new TokenVault(s2, fakeCipher(false)).load()).toBeNull();
    expect(new TokenVault(s2, { ...fakeCipher(), decrypt: () => { throw new Error('bad key'); } }).load()).toBeNull();
  });
});

describe('DuckStation token encryption (achievements.cpp EncryptLoginToken, portable mode)', () => {
  it('round-trips with the user name as key and pads to the AES block size', () => {
    const enc = duckstationEncryptToken(TOKEN, 'PlayerOne');
    expect(Buffer.from(enc, 'base64')).toHaveLength(16);
    expect(enc).not.toContain(TOKEN);
    expect(duckstationDecryptToken(enc, 'PlayerOne')).toBe(TOKEN);
    expect(duckstationDecryptToken(enc, 'SomeoneElse')).not.toBe(TOKEN);
    const long = duckstationEncryptToken('x'.repeat(20), 'PlayerOne');
    expect(Buffer.from(long, 'base64')).toHaveLength(32);
    expect(duckstationDecryptToken(long, 'PlayerOne')).toBe('x'.repeat(20));
    // Deterministic, so re-applying does not rewrite settings.ini.
    expect(duckstationEncryptToken(TOKEN, 'PlayerOne')).toBe(enc);
  });
});

describe('emulator configuration', () => {
  const paths = new AppPaths(join(t.dir, 'ud'), t.dir);
  const registry = new AdapterRegistry(paths);
  const creds: RaCredentials = { enabled: true, username: 'PlayerOne', token: TOKEN, hardcore: true, loginAt: 1700000000 };
  const input = (id: string, achievements: RaCredentials | null): ConfigInput => {
    const a = registry.require(id);
    return { settings: a.defaultSettings(null, 'balanced'), controller: { ...defaultProfile(), id: 1, updatedAt: '' }, hotkeys: DEFAULT_SETTINGS.hotkeys, hardware: null, achievements };
  };
  const want = { username: 'PlayerOne', enabled: true, hardcore: true };

  it('RetroArch: cheevos_* keys in retroarch.cfg, password empty, keychain copies dropped', async () => {
    const a = registry.require('retroarch') as EmulatorAdapter & { cfgPath(): string };
    const files = a.achievements!();
    expect(files).toEqual({ kind: 'retroarch', cfg: a.cfgPath() });
    // Newer RetroArch merges retroarch-keychain.cfg over retroarch.cfg.
    mkdirSync(join(a.cfgPath(), '..'), { recursive: true });
    writeFileSync(retroArchKeychainPath(a.cfgPath()), 'keychain_version = "1"\ncheevos_username = "OldUser"\ncheevos_token = "sealed:abc"\nwebdav_password = "keep"\n');
    const res = await a.applyConfig(input('retroarch', creds), 'paths');
    expect(res.changed.join('\n')).not.toContain(TOKEN);
    const doc = CfgDocument.parse(readFileSync(a.cfgPath(), 'utf8'));
    expect(doc.get('cheevos_enable')).toBe('true');
    expect(doc.get('cheevos_username')).toBe('PlayerOne');
    expect(doc.get('cheevos_token')).toBe(TOKEN);
    expect(doc.get('cheevos_password')).toBe('');
    expect(doc.get('cheevos_hardcore_mode_enable')).toBe('true');
    const kc = CfgDocument.parse(readFileSync(retroArchKeychainPath(a.cfgPath()), 'utf8'));
    expect(kc.get('cheevos_username')).toBeUndefined();
    expect(kc.get('cheevos_token')).toBeUndefined();
    expect(kc.get('webdav_password')).toBe('keep');
    expect(await inspectAchievementsConfig(files, want)).toEqual([]);
    expect(await writeAchievementsConfig(files, creds)).toEqual([]);
  });

  it('DuckStation: [Cheevos] Enabled/Username/encrypted Token/LoginTimestamp/ChallengeMode in settings.ini', async () => {
    const a = registry.require('duckstation') as EmulatorAdapter & { iniPath(): string };
    await a.applyConfig(input('duckstation', creds), 'all');
    const doc = ini(a.iniPath());
    expect(doc.get('Cheevos', 'Enabled')).toBe('true');
    expect(doc.get('Cheevos', 'Username')).toBe('PlayerOne');
    expect(doc.get('Cheevos', 'Token')).not.toBe(TOKEN);
    expect(duckstationDecryptToken(doc.get('Cheevos', 'Token')!, 'PlayerOne')).toBe(TOKEN);
    expect(doc.get('Cheevos', 'LoginTimestamp')).toBe('1700000000');
    expect(doc.get('Cheevos', 'ChallengeMode')).toBe('true');
    expect(existsSync(join(a.paths().app, 'portable.txt'))).toBe(true);
    expect(await inspectAchievementsConfig(a.achievements!(), want)).toEqual([]);
    expect(await writeAchievementsConfig(a.achievements!(), creds)).toEqual([]);
  });

  it('PCSX2: [Achievements] in PCSX2.ini and the token in inis/secrets.ini', async () => {
    const a = registry.require('pcsx2') as EmulatorAdapter & { iniPath(): string };
    await a.applyConfig(input('pcsx2', creds), 'all');
    const doc = ini(a.iniPath());
    expect(doc.get('Achievements', 'Enabled')).toBe('true');
    expect(doc.get('Achievements', 'Username')).toBe('PlayerOne');
    expect(doc.get('Achievements', 'LoginTimestamp')).toBe('1700000000');
    expect(doc.get('Achievements', 'ChallengeMode')).toBe('true');
    expect(pcsx2SecretsPath(a.iniPath())).toBe(join(a.iniPath(), '..', 'secrets.ini'));
    expect(ini(pcsx2SecretsPath(a.iniPath())).get('Achievements', 'Token')).toBe(TOKEN);
    // Current PCSX2 moves PCSX2.ini's Token into secrets.ini; still configured afterwards.
    doc.delete('Achievements', 'Token');
    writeFileSync(a.iniPath(), doc.toString());
    expect(await inspectAchievementsConfig(a.achievements!(), want)).toEqual([]);
    expect(await writeAchievementsConfig(a.achievements!(), creds)).toEqual([]);
  });

  it('PPSSPP: [Achievements] in ppsspp.ini and the raw token in PSP/SYSTEM/ppsspp_retroachievements.dat', async () => {
    const a = registry.require('ppsspp') as EmulatorAdapter & { iniPath(): string; systemDir(): string };
    await a.applyConfig(input('ppsspp', { ...creds, hardcore: false }), 'all');
    const doc = ini(a.iniPath());
    expect(doc.get('Achievements', 'AchievementsEnable')).toBe('True');
    expect(doc.get('Achievements', 'AchievementsUserName')).toBe('PlayerOne');
    expect(doc.get('Achievements', 'AchievementsChallengeMode')).toBe('False');
    expect(ppssppTokenPath(a.iniPath())).toBe(join(a.systemDir(), 'ppsspp_retroachievements.dat'));
    expect(readFileSync(ppssppTokenPath(a.iniPath()), 'utf8')).toBe(TOKEN);
    expect(await inspectAchievementsConfig(a.achievements!(), { ...want, hardcore: false })).toEqual([]);
    expect(await inspectAchievementsConfig(a.achievements!(), want)).toEqual(['ppsspp.ini: Achievements.AchievementsChallengeMode should be true']);
  });

  it('Dolphin: User/Config/RetroAchievements.ini [Achievements] Enabled/Username/ApiToken/HardcoreEnabled', async () => {
    const a = registry.require('dolphin') as EmulatorAdapter & { configPath(n: string): string };
    await a.applyConfig(input('dolphin', creds), 'paths');
    const file = dolphinRaIniPath(join(a.configPath('x'), '..'));
    expect(file).toBe(a.configPath('RetroAchievements.ini'));
    const doc = ini(file);
    expect(doc.get('Achievements', 'Enabled')).toBe('True');
    expect(doc.get('Achievements', 'Username')).toBe('PlayerOne');
    expect(doc.get('Achievements', 'ApiToken')).toBe(TOKEN);
    expect(doc.get('Achievements', 'HardcoreEnabled')).toBe('True');
    expect(await writeAchievementsConfig(a.achievements!(), creds)).toEqual([]);
  });

  it('leaves RetroAchievements settings alone when OmniPC is not signed in, and only writes on all/paths', async () => {
    const a = registry.require('dolphin') as EmulatorAdapter & { configPath(n: string): string };
    const res = await a.applyConfig(input('dolphin', null), 'all');
    expect(res.changed.some((c) => c.includes('RetroAchievements'))).toBe(false);
    expect(ini(a.configPath('RetroAchievements.ini')).get('Achievements', 'ApiToken')).toBe(TOKEN);
    const g = await a.applyConfig(input('dolphin', { ...creds, hardcore: false }), 'graphics');
    expect(g.changed.some((c) => c.includes('RetroAchievements'))).toBe(false);
  });

  it('sign-out removes the login from every emulator (and is idempotent)', async () => {
    for (const id of ['retroarch', 'duckstation', 'pcsx2', 'ppsspp', 'dolphin']) {
      const files = registry.require(id).achievements!();
      expect((await writeAchievementsConfig(files, null)).length).toBeGreaterThan(0);
      expect(await writeAchievementsConfig(files, null)).toEqual([]);
      expect((await inspectAchievementsConfig(files, want)).length).toBeGreaterThan(0);
    }
    const ra = CfgDocument.parse(readFileSync((registry.require('retroarch') as unknown as { cfgPath(): string }).cfgPath(), 'utf8'));
    expect(ra.get('cheevos_enable')).toBe('false');
    expect(ra.get('cheevos_token')).toBe('');
    expect(ra.get('cheevos_username')).toBe('');
    const ds = ini((registry.require('duckstation') as unknown as { iniPath(): string }).iniPath());
    expect(ds.get('Cheevos', 'Enabled')).toBe('false');
    expect(ds.get('Cheevos', 'Token')).toBeUndefined();
    expect(ds.get('Cheevos', 'Username')).toBeUndefined();
    const ps2 = (registry.require('pcsx2') as unknown as { iniPath(): string }).iniPath();
    expect(ini(ps2).get('Achievements', 'Username')).toBeUndefined();
    expect(ini(pcsx2SecretsPath(ps2)).get('Achievements', 'Token')).toBeUndefined();
    const psp = (registry.require('ppsspp') as unknown as { iniPath(): string }).iniPath();
    expect(existsSync(ppssppTokenPath(psp))).toBe(false);
    expect(ini(psp).get('Achievements', 'AchievementsUserName')).toBe('');
    const dol = (registry.require('dolphin') as unknown as { configPath(n: string): string }).configPath('RetroAchievements.ini');
    expect(ini(dol).get('Achievements', 'ApiToken')).toBe('');
    expect(ini(dol).get('Achievements', 'Enabled')).toBe('False');
  });

  it('does not create config files just to sign out of an emulator that was never configured', async () => {
    const d = join(t.dir, 'fresh');
    expect(await writeAchievementsConfig({ kind: 'dolphin', configDir: d }, null)).toEqual([]);
    expect(await writeAchievementsConfig({ kind: 'ppsspp', ini: join(d, 'ppsspp.ini') }, null)).toEqual([]);
    expect(existsSync(d)).toBe(false);
  });
});

describe('redaction', () => {
  it('blanks tokens and passwords in config text and token files', () => {
    const text = `cheevos_username = "PlayerOne"\ncheevos_token = "${TOKEN}"\ncheevos_password = ""\n[Cheevos]\nToken = abc==\nUsername = PlayerOne\n[Achievements]\nApiToken = ${TOKEN}\n`;
    const r = redactAchievementSecrets(text);
    expect(r).not.toContain(TOKEN);
    expect(r).not.toContain('abc==');
    expect(r).toContain('cheevos_username = "PlayerOne"');
    expect(r).toContain('cheevos_password = ""');
    expect(r).toContain('Username = PlayerOne');
    expect(redactAchievementFile('memstick/PSP/SYSTEM/ppsspp_retroachievements.dat', TOKEN)).toBe('<redacted>');
  });
});

describe('RetroAchievements service', () => {
  const paths = new AppPaths(join(t.dir, 'svc'), join(t.dir, 'svc-home'));
  const db = new Database(':memory:');
  migrate(db);
  const settings = new SettingsRepo(db);
  const ops = new OpsRepo(db);
  const backups = new ConfigBackupService(join(t.dir, 'svc-backups'), ops);
  const registry = new AdapterRegistry(paths);
  const installed = new Set(['dolphin', 'ppsspp']);
  let fetchImpl = fakeFetch(() => okResponse());
  const vault = new TokenVault({ read: () => settings.getInternal<StoredRaToken | null>('retroAchievementsToken', null), write: (v) => settings.setInternal('retroAchievementsToken', v) }, fakeCipher());
  const svc = new RetroAchievementsService({ settings, registry, isInstalled: (id) => installed.has(id), backups, ops, vault, fetchImpl: ((u: string, i: RequestInit) => fetchImpl.fn(u, i)) as unknown as typeof fetch, userAgent: UA });
  const dolphinIni = () => (registry.require('dolphin') as unknown as { configPath(n: string): string }).configPath('RetroAchievements.ini');

  it('signs in, stores only user name + encrypted token, and configures installed emulators', async () => {
    const st = await svc.login('playerone', PASSWORD);
    expect(st.signedIn).toBe(true);
    expect(st.username).toBe('PlayerOne');
    expect(st.tokenProtected).toBe(true);
    expect(settings.getAll().retroAchievements).toEqual({ enabled: true, username: 'PlayerOne', hardcore: false });
    const dump = JSON.stringify(db.prepare('SELECT * FROM settings').all()) + JSON.stringify(ops.changes(100)) + JSON.stringify(ops.backups(null));
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain(PASSWORD);
    expect(JSON.stringify(settings.getAll())).not.toContain('retroAchievementsToken');
    expect(ini(dolphinIni()).get('Achievements', 'ApiToken')).toBe(TOKEN);
    const byId = Object.fromEntries(st.emulators.map((e) => [e.emulatorId, e.status]));
    expect(byId).toMatchObject({ dolphin: 'configured', ppsspp: 'configured', pcsx2: 'not-installed', duckstation: 'not-installed', retroarch: 'not-installed' });
    expect(ops.backups('dolphin').some((b) => b.reason === 'pre-achievements')).toBe(true);
  });

  it('apply is idempotent (no changes, no new backups)', async () => {
    const before = ops.backups(null).length;
    const r = await svc.apply();
    expect(r.changed).toEqual([]);
    expect(r.backupIds).toEqual([]);
    expect(ops.backups(null).length).toBe(before);
  });

  it('feeds the sign-in to adapters through credentials() and toggles hardcore everywhere', async () => {
    expect(svc.credentials()).toMatchObject({ username: 'PlayerOne', token: TOKEN, enabled: true, hardcore: false });
    const st = await svc.setHardcore(true);
    expect(st.hardcore).toBe(true);
    expect(ini(dolphinIni()).get('Achievements', 'HardcoreEnabled')).toBe('True');
    expect(st.emulators.find((e) => e.emulatorId === 'dolphin')?.status).toBe('configured');
  });

  it('OmniDoctor flags an installed emulator that lost the sign-in, and ra.apply repairs it', async () => {
    const check = CHECKS.find((c) => c.id === 'achievements.config')!;
    const deps = { settings, registry, emulators: { isInstalled: (id: string) => installed.has(id) } } as unknown as Parameters<typeof check.run>[0];
    expect((await check.run(deps)).map((f) => f.severity)).toEqual(['pass']);
    writeFileSync(dolphinIni(), '[Achievements]\nEnabled = False\n');
    const findings = await check.run(deps);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'warning', repair: { actionId: 'ra.apply', safety: 'safe' } });
    const action = ACTIONS.find((x) => x.id === 'ra.apply')!;
    const out = await action.run({}, { achievements: svc } as never);
    expect(out.backupIds.length).toBe(1);
    expect(out.details.join('\n')).not.toContain(TOKEN);
    expect((await check.run(deps)).map((f) => f.severity)).toEqual(['pass']);
  });

  it('a failed login keeps the existing sign-in', async () => {
    fetchImpl = fakeFetch(() => badPassword());
    await expect(svc.login('PlayerOne', 'wrong')).rejects.toMatchObject({ detail: { code: 'RA_BAD_LOGIN' } });
    expect((await svc.status()).signedIn).toBe(true);
  });

  it('sign-out clears the token from OmniPC and from emulator configs', async () => {
    const st = await svc.logout();
    expect(st.signedIn).toBe(false);
    expect(st.username).toBeNull();
    expect(settings.getInternal('retroAchievementsToken', 'gone')).toBeNull();
    expect(svc.credentials()).toBeNull();
    expect(ini(dolphinIni()).get('Achievements', 'ApiToken')).toBe('');
    const psp = (registry.require('ppsspp') as unknown as { iniPath(): string }).iniPath();
    expect(existsSync(ppssppTokenPath(psp))).toBe(false);
    await expect(svc.apply()).rejects.toMatchObject({ detail: { code: 'RA_NOT_SIGNED_IN' } });
  });
});
