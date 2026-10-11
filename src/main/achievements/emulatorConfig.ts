// Writes the RetroAchievements sign-in into each supporting emulator's own
// config, using exactly the keys the emulators read (verified in their sources):
//
//  RetroArch   retroarch.cfg: cheevos_enable, cheevos_username, cheevos_token,
//              cheevos_password (left empty), cheevos_hardcore_mode_enable
//              (configuration.c). Newer builds move secrets into
//              retroarch-keychain.cfg next to retroarch.cfg and merge it over
//              retroarch.cfg at load, so stale cheevos_* entries there are removed.
//  DuckStation settings.ini [Cheevos] Enabled, Username, Token, LoginTimestamp,
//              ChallengeMode (core/achievements.cpp). Token is AES-128-CBC
//              encrypted with a key derived from the user name; in portable mode
//              (OmniPC's layout) no machine key is mixed in, so OmniPC can write it.
//  PCSX2       inis/PCSX2.ini [Achievements] Enabled, Username, LoginTimestamp,
//              ChallengeMode (Pcsx2Config.cpp, Achievements.cpp); Token in
//              inis/secrets.ini [Achievements] (current builds) and PCSX2.ini
//              (older builds; current builds migrate it to secrets.ini).
//  PPSSPP      PSP/SYSTEM/ppsspp.ini [Achievements] AchievementsEnable,
//              AchievementsUserName, AchievementsChallengeMode (Core/Config.cpp);
//              token in PSP/SYSTEM/ppsspp_retroachievements.dat, raw bytes
//              (UI/NativeApp.cpp NativeSaveSecret).
//  Dolphin     User/Config/RetroAchievements.ini [Achievements] Enabled, Username,
//              ApiToken, HardcoreEnabled (Core/Config/AchievementSettings.cpp).
//
// Change descriptions never contain the token.

import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicWrite, loadIni, saveIni } from '../config/iniFile';
import type { IniDocument } from '../config/ini';
import { CfgDocument } from '../emulators/retroarch/cfg';

export interface RaCredentials {
  enabled: boolean;
  username: string;
  token: string;
  hardcore: boolean;
  /** Unix seconds of the sign-in. */
  loginAt: number;
}

/** Where an emulator keeps its RetroAchievements settings (provided by its adapter). */
export type RaFiles =
  | { kind: 'retroarch'; cfg: string }
  | { kind: 'duckstation'; ini: string }
  | { kind: 'pcsx2'; ini: string }
  | { kind: 'ppsspp'; ini: string }
  | { kind: 'dolphin'; configDir: string };

const HIDDEN = '(hidden)';

export function retroArchKeychainPath(cfg: string): string {
  return join(dirname(cfg), 'retroarch-keychain.cfg');
}
export function pcsx2SecretsPath(ini: string): string {
  return join(dirname(ini), 'secrets.ini');
}
export function ppssppTokenPath(ini: string): string {
  return join(dirname(ini), 'ppsspp_retroachievements.dat');
}
export function dolphinRaIniPath(configDir: string): string {
  return join(configDir, 'RetroAchievements.ini');
}

/** Every file OmniPC may touch for this emulator (backed up before ra.apply / sign-out). */
export function raFilePaths(f: RaFiles): string[] {
  switch (f.kind) {
    case 'retroarch': return [f.cfg, retroArchKeychainPath(f.cfg)];
    case 'duckstation': return [f.ini];
    case 'pcsx2': return [f.ini, pcsx2SecretsPath(f.ini)];
    case 'ppsspp': return [f.ini, ppssppTokenPath(f.ini)];
    case 'dolphin': return [dolphinRaIniPath(f.configDir)];
  }
}

// ---------------------------------------------------------------- DuckStation token

function duckstationKey(username: string): Buffer {
  // GetLoginEncryptionKey(): SHA-256(username) then 100 extra SHA-256 rounds.
  // Portable mode skips the machine key, which is how OmniPC runs DuckStation.
  let key = createHash('sha256').update(username, 'utf8').digest();
  for (let i = 0; i < 100; i++) key = createHash('sha256').update(key).digest();
  return key;
}

/** DuckStation EncryptLoginToken (portable mode): AES-128-CBC, key = k[0..16], IV = k[16..32], zero padded, base64. */
export function duckstationEncryptToken(token: string, username: string): string {
  if (!token || !username) return '';
  const key = duckstationKey(username);
  const raw = Buffer.from(token, 'utf8');
  const data = Buffer.alloc(Math.ceil(raw.length / 16) * 16);
  raw.copy(data);
  const c = createCipheriv('aes-128-cbc', key.subarray(0, 16), key.subarray(16, 32));
  c.setAutoPadding(false);
  return Buffer.concat([c.update(data), c.final()]).toString('base64');
}

/** DuckStation DecryptLoginToken (portable mode); '' when it cannot be decrypted. */
export function duckstationDecryptToken(encrypted: string, username: string): string {
  if (!encrypted || !username) return '';
  const data = Buffer.from(encrypted, 'base64');
  if (!data.length || data.length % 16) return '';
  const key = duckstationKey(username);
  const d = createDecipheriv('aes-128-cbc', key.subarray(0, 16), key.subarray(16, 32));
  d.setAutoPadding(false);
  const out = Buffer.concat([d.update(data), d.final()]);
  const nul = out.indexOf(0);
  return out.subarray(0, nul === -1 ? out.length : nul).toString('utf8');
}

// ---------------------------------------------------------------- helpers

const truthy = (v: string | undefined) => v !== undefined && /^(true|1|yes|on)$/i.test(v.trim());

/** Sets a boolean unless the file already holds the same value in any spelling. */
function setBool(doc: IniDocument, s: string, k: string, v: boolean, style: 'lower' | 'title'): boolean {
  const cur = doc.get(s, k);
  if (cur !== undefined && /^(true|false|1|0)$/i.test(cur.trim()) && truthy(cur) === v) return false;
  return doc.set(s, k, style === 'title' ? (v ? 'True' : 'False') : v);
}

class Changes {
  readonly list: string[] = [];
  constructor(private readonly file: string) {}
  add(changed: boolean, key: string, shown: string | boolean | number): boolean {
    if (changed) this.list.push(`${this.file} ${key} = ${shown}`);
    return changed;
  }
}

async function loadCfg(path: string): Promise<CfgDocument> {
  return existsSync(path) ? CfgDocument.parse(await readFile(path, 'utf8')) : CfgDocument.empty();
}

async function readText(path: string): Promise<string | null> {
  return existsSync(path) ? readFile(path, 'utf8').catch(() => null) : null;
}

// ---------------------------------------------------------------- writers

/**
 * Writes `creds` into the emulator's config, or signs it out when `creds` is
 * null (credentials removed, achievements turned off). Idempotent: unchanged
 * files are not rewritten. Returns change descriptions (token hidden).
 */
export async function writeAchievementsConfig(f: RaFiles, creds: RaCredentials | null): Promise<string[]> {
  switch (f.kind) {
    case 'retroarch': return writeRetroArch(f.cfg, creds);
    case 'duckstation': return writeDuckStation(f.ini, creds);
    case 'pcsx2': return writePcsx2(f.ini, creds);
    case 'ppsspp': return writePpsspp(f.ini, creds);
    case 'dolphin': return writeDolphin(dolphinRaIniPath(f.configDir), creds);
  }
}

async function writeRetroArch(cfg: string, creds: RaCredentials | null): Promise<string[]> {
  const ch = new Changes('retroarch.cfg');
  if (creds || existsSync(cfg)) {
    const doc = await loadCfg(cfg);
    let dirty = false;
    const set = (k: string, v: string | boolean, shown: string | boolean = v) => (dirty = ch.add(doc.set(k, v), k, shown) || dirty);
    set('cheevos_enable', creds ? creds.enabled : false);
    set('cheevos_username', creds?.username ?? '');
    // Token login: RetroArch uses cheevos_token when cheevos_password is empty.
    set('cheevos_password', '', '""');
    set('cheevos_token', creds?.token ?? '', creds ? HIDDEN : '""');
    if (creds) set('cheevos_hardcore_mode_enable', creds.hardcore);
    if (dirty) await atomicWrite(cfg, doc.toString());
  }
  // retroarch-keychain.cfg (RetroArch 1.23+) is merged over retroarch.cfg; its
  // copies (possibly sealed) would override what OmniPC wrote, so drop them.
  // RetroArch moves the values back into it the next time it saves its config.
  const keychain = retroArchKeychainPath(cfg);
  if (existsSync(keychain)) {
    const kc = await loadCfg(keychain);
    let dirty = false;
    for (const k of ['cheevos_username', 'cheevos_password', 'cheevos_token']) if (kc.delete(k)) {
      dirty = true;
      ch.list.push(`retroarch-keychain.cfg ${k} removed`);
    }
    if (dirty) await atomicWrite(keychain, kc.toString());
  }
  return ch.list;
}

async function writeDuckStation(ini: string, creds: RaCredentials | null): Promise<string[]> {
  if (!creds && !existsSync(ini)) return [];
  const ch = new Changes('settings.ini');
  const doc = await loadIni(ini);
  let dirty = false;
  dirty = ch.add(setBool(doc, 'Cheevos', 'Enabled', creds ? creds.enabled : false, 'lower'), 'Cheevos.Enabled', creds ? creds.enabled : false) || dirty;
  if (creds) {
    dirty = ch.add(doc.set('Cheevos', 'Username', creds.username), 'Cheevos.Username', creds.username) || dirty;
    const current = doc.get('Cheevos', 'Token');
    // Keep an existing token that already decrypts to ours (DuckStation may have re-saved it).
    if (!current || duckstationDecryptToken(current, creds.username) !== creds.token) dirty = ch.add(doc.set('Cheevos', 'Token', duckstationEncryptToken(creds.token, creds.username)), 'Cheevos.Token', HIDDEN) || dirty;
    dirty = ch.add(doc.set('Cheevos', 'LoginTimestamp', String(creds.loginAt)), 'Cheevos.LoginTimestamp', creds.loginAt) || dirty;
    dirty = ch.add(setBool(doc, 'Cheevos', 'ChallengeMode', creds.hardcore, 'lower'), 'Cheevos.ChallengeMode', creds.hardcore) || dirty;
  } else {
    // Same keys DuckStation removes on logout (Achievements::Logout).
    for (const k of ['Username', 'Token', 'LoginTimestamp']) dirty = ch.add(doc.delete('Cheevos', k), `Cheevos.${k}`, '(removed)') || dirty;
  }
  if (dirty) await saveIni(ini, doc);
  return ch.list;
}

async function writePcsx2(ini: string, creds: RaCredentials | null): Promise<string[]> {
  const out: string[] = [];
  if (creds || existsSync(ini)) {
    const ch = new Changes('PCSX2.ini');
    const doc = await loadIni(ini);
    let dirty = false;
    dirty = ch.add(setBool(doc, 'Achievements', 'Enabled', creds ? creds.enabled : false, 'lower'), 'Achievements.Enabled', creds ? creds.enabled : false) || dirty;
    if (creds) {
      dirty = ch.add(doc.set('Achievements', 'Username', creds.username), 'Achievements.Username', creds.username) || dirty;
      // Current PCSX2 moves a Token found here into secrets.ini at start-up; older builds read it here.
      const secrets = await loadIni(pcsx2SecretsPath(ini));
      if (doc.get('Achievements', 'Token') !== creds.token && secrets.get('Achievements', 'Token') !== creds.token) dirty = ch.add(doc.set('Achievements', 'Token', creds.token), 'Achievements.Token', HIDDEN) || dirty;
      dirty = ch.add(doc.set('Achievements', 'LoginTimestamp', String(creds.loginAt)), 'Achievements.LoginTimestamp', creds.loginAt) || dirty;
      dirty = ch.add(setBool(doc, 'Achievements', 'ChallengeMode', creds.hardcore, 'lower'), 'Achievements.ChallengeMode', creds.hardcore) || dirty;
    } else {
      for (const k of ['Username', 'Token', 'LoginTimestamp']) dirty = ch.add(doc.delete('Achievements', k), `Achievements.${k}`, '(removed)') || dirty;
    }
    if (dirty) await saveIni(ini, doc);
    out.push(...ch.list);
  }
  const secretsPath = pcsx2SecretsPath(ini);
  if (creds || existsSync(secretsPath)) {
    const ch = new Changes('secrets.ini');
    const s = await loadIni(secretsPath);
    const changed = creds ? s.set('Achievements', 'Token', creds.token) : s.delete('Achievements', 'Token');
    if (ch.add(changed, 'Achievements.Token', creds ? HIDDEN : '(removed)')) await saveIni(secretsPath, s);
    out.push(...ch.list);
  }
  return out;
}

async function writePpsspp(ini: string, creds: RaCredentials | null): Promise<string[]> {
  const out: string[] = [];
  if (creds || existsSync(ini)) {
    const ch = new Changes('ppsspp.ini');
    const doc = await loadIni(ini);
    let dirty = false;
    dirty = ch.add(setBool(doc, 'Achievements', 'AchievementsEnable', creds ? creds.enabled : false, 'title'), 'Achievements.AchievementsEnable', creds ? creds.enabled : false) || dirty;
    dirty = ch.add(doc.set('Achievements', 'AchievementsUserName', creds?.username ?? ''), 'Achievements.AchievementsUserName', creds?.username ?? '""') || dirty;
    if (creds) dirty = ch.add(setBool(doc, 'Achievements', 'AchievementsChallengeMode', creds.hardcore, 'title'), 'Achievements.AchievementsChallengeMode', creds.hardcore) || dirty;
    if (dirty) await saveIni(ini, doc);
    out.push(...ch.list);
  }
  // NativeSaveSecret("retroachievements"): the raw token, no line ending.
  const tokenFile = ppssppTokenPath(ini);
  if (creds) {
    if ((await readText(tokenFile)) !== creds.token) {
      await atomicWrite(tokenFile, creds.token);
      out.push(`ppsspp_retroachievements.dat = ${HIDDEN}`);
    }
  } else if (existsSync(tokenFile)) {
    await rm(tokenFile, { force: true });
    out.push('ppsspp_retroachievements.dat removed');
  }
  return out;
}

async function writeDolphin(ini: string, creds: RaCredentials | null): Promise<string[]> {
  if (!creds && !existsSync(ini)) return [];
  const ch = new Changes('RetroAchievements.ini');
  const doc = await loadIni(ini);
  let dirty = false;
  dirty = ch.add(setBool(doc, 'Achievements', 'Enabled', creds ? creds.enabled : false, 'title'), 'Achievements.Enabled', creds ? creds.enabled : false) || dirty;
  dirty = ch.add(doc.set('Achievements', 'Username', creds?.username ?? ''), 'Achievements.Username', creds?.username ?? '""') || dirty;
  dirty = ch.add(doc.set('Achievements', 'ApiToken', creds?.token ?? ''), 'Achievements.ApiToken', creds ? HIDDEN : '""') || dirty;
  if (creds) dirty = ch.add(setBool(doc, 'Achievements', 'HardcoreEnabled', creds.hardcore, 'title'), 'Achievements.HardcoreEnabled', creds.hardcore) || dirty;
  if (dirty) await saveIni(ini, doc);
  return ch.list;
}

// ---------------------------------------------------------------- inspection

export interface RaExpectation {
  username: string;
  enabled: boolean;
  hardcore: boolean;
}

/** Differences between the emulator's config and the OmniPC sign-in (empty = configured). Never reads out the token. */
export async function inspectAchievementsConfig(f: RaFiles, want: RaExpectation): Promise<string[]> {
  const issues: string[] = [];
  const sameUser = (v: string | undefined) => !!v && v.trim().toLowerCase() === want.username.toLowerCase();
  const flag = (file: string, key: string, v: string | undefined, expected: boolean) => {
    if (truthy(v) !== expected) issues.push(`${file}: ${key} should be ${expected}`);
  };
  switch (f.kind) {
    case 'retroarch': {
      if (!existsSync(f.cfg)) return ['retroarch.cfg does not exist yet'];
      const doc = await loadCfg(f.cfg);
      const kc = existsSync(retroArchKeychainPath(f.cfg)) ? await loadCfg(retroArchKeychainPath(f.cfg)) : null;
      flag('retroarch.cfg', 'cheevos_enable', doc.get('cheevos_enable'), want.enabled);
      if (!sameUser(doc.get('cheevos_username')) && !(kc && sameUser(kc.get('cheevos_username')))) issues.push(`retroarch.cfg: not signed in as ${want.username}`);
      if (!doc.get('cheevos_token') && !kc?.get('cheevos_token')) issues.push('retroarch.cfg: login token missing');
      flag('retroarch.cfg', 'cheevos_hardcore_mode_enable', doc.get('cheevos_hardcore_mode_enable') ?? 'true', want.hardcore);
      break;
    }
    case 'duckstation': {
      if (!existsSync(f.ini)) return ['settings.ini does not exist yet'];
      const doc = await loadIni(f.ini);
      flag('settings.ini', 'Cheevos.Enabled', doc.get('Cheevos', 'Enabled'), want.enabled);
      if (!sameUser(doc.get('Cheevos', 'Username'))) issues.push(`settings.ini: not signed in as ${want.username}`);
      const tok = doc.get('Cheevos', 'Token');
      if (!tok || !duckstationDecryptToken(tok, doc.get('Cheevos', 'Username') ?? '')) issues.push('settings.ini: login token missing or unreadable');
      flag('settings.ini', 'Cheevos.ChallengeMode', doc.get('Cheevos', 'ChallengeMode'), want.hardcore);
      break;
    }
    case 'pcsx2': {
      if (!existsSync(f.ini)) return ['PCSX2.ini does not exist yet'];
      const doc = await loadIni(f.ini);
      const secrets = await loadIni(pcsx2SecretsPath(f.ini));
      flag('PCSX2.ini', 'Achievements.Enabled', doc.get('Achievements', 'Enabled'), want.enabled);
      if (!sameUser(doc.get('Achievements', 'Username'))) issues.push(`PCSX2.ini: not signed in as ${want.username}`);
      if (!doc.get('Achievements', 'Token') && !secrets.get('Achievements', 'Token')) issues.push('PCSX2: login token missing');
      flag('PCSX2.ini', 'Achievements.ChallengeMode', doc.get('Achievements', 'ChallengeMode'), want.hardcore);
      break;
    }
    case 'ppsspp': {
      if (!existsSync(f.ini)) return ['ppsspp.ini does not exist yet'];
      const doc = await loadIni(f.ini);
      flag('ppsspp.ini', 'Achievements.AchievementsEnable', doc.get('Achievements', 'AchievementsEnable'), want.enabled);
      if (!sameUser(doc.get('Achievements', 'AchievementsUserName'))) issues.push(`ppsspp.ini: not signed in as ${want.username}`);
      if (!(await readText(ppssppTokenPath(f.ini)))) issues.push('PPSSPP: login token file missing');
      flag('ppsspp.ini', 'Achievements.AchievementsChallengeMode', doc.get('Achievements', 'AchievementsChallengeMode') ?? 'true', want.hardcore);
      break;
    }
    case 'dolphin': {
      const ini = dolphinRaIniPath(f.configDir);
      if (!existsSync(ini)) return ['RetroAchievements.ini does not exist yet'];
      const doc = await loadIni(ini);
      flag('RetroAchievements.ini', 'Achievements.Enabled', doc.get('Achievements', 'Enabled'), want.enabled);
      if (!sameUser(doc.get('Achievements', 'Username'))) issues.push(`RetroAchievements.ini: not signed in as ${want.username}`);
      if (!doc.get('Achievements', 'ApiToken')) issues.push('RetroAchievements.ini: login token missing');
      flag('RetroAchievements.ini', 'Achievements.HardcoreEnabled', doc.get('Achievements', 'HardcoreEnabled') ?? 'true', want.hardcore);
      break;
    }
  }
  return issues;
}

// ---------------------------------------------------------------- redaction

const SECRET_LINES: RegExp[] = [
  /^([ \t]*cheevos_(?:token|password)[ \t]*=[ \t]*)(?=\S)(?!""[ \t]*$).*$/gm,
  /^([ \t]*(?:Token|ApiToken|AchievementsToken)[ \t]*=[ \t]*)(?=\S).*$/gm,
];

/** Hides RetroAchievements tokens/passwords in config text (diagnostic packages, backup diffs). */
export function redactAchievementSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_LINES) out = out.replace(re, '$1<redacted>');
  return out;
}

/** Like redactAchievementSecrets, also hiding token-only files (PPSSPP's ppsspp_retroachievements.dat). */
export function redactAchievementFile(fileName: string, text: string): string {
  if (/retroachievements\.dat$/i.test(fileName)) return text ? '<redacted>' : text;
  return redactAchievementSecrets(text);
}
