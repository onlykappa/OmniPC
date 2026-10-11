// Stores the RetroAchievements login token (never the password). The token is
// encrypted with an injected cipher - Electron safeStorage (Windows DPAPI) in
// the app, a fake in tests - and kept out of the settings sent to the renderer.

export interface SecretCipher {
  /** False when the OS cannot encrypt (e.g. no keyring); the token is then stored unprotected. */
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

export interface StoredRaToken {
  v: 1;
  /** 'os' = encrypted by the cipher; 'plain' = base64 only (cipher unavailable). */
  scheme: 'os' | 'plain';
  data: string;
  username: string;
  /** Unix seconds of the sign-in (DuckStation/PCSX2 LoginTimestamp). */
  loginAt: number;
}

export interface TokenStore {
  read(): StoredRaToken | null;
  write(v: StoredRaToken | null): void;
}

export interface RaSecret {
  username: string;
  token: string;
  loginAt: number;
}

export class TokenVault {
  constructor(private readonly store: TokenStore, private readonly cipher: SecretCipher | null) {}

  save(username: string, token: string, loginAt = Math.floor(Date.now() / 1000)): StoredRaToken {
    const protect = !!this.cipher?.available();
    const data = protect ? this.cipher!.encrypt(token).toString('base64') : Buffer.from(token, 'utf8').toString('base64');
    const rec: StoredRaToken = { v: 1, scheme: protect ? 'os' : 'plain', data, username, loginAt };
    this.store.write(rec);
    return rec;
  }

  /** The stored record without decrypting it. */
  info(): { username: string; protected: boolean; loginAt: number } | null {
    const r = this.valid(this.store.read());
    return r ? { username: r.username, protected: r.scheme === 'os', loginAt: r.loginAt } : null;
  }

  /** Decrypted secret, or null when nothing is stored or it cannot be decrypted on this PC. */
  load(): RaSecret | null {
    const r = this.valid(this.store.read());
    if (!r) return null;
    try {
      const token = r.scheme === 'os' ? (this.cipher?.available() ? this.cipher.decrypt(Buffer.from(r.data, 'base64')) : null) : Buffer.from(r.data, 'base64').toString('utf8');
      return token ? { username: r.username, token, loginAt: r.loginAt } : null;
    } catch {
      return null;
    }
  }

  clear(): void {
    this.store.write(null);
  }

  private valid(r: StoredRaToken | null): StoredRaToken | null {
    return r && r.v === 1 && typeof r.data === 'string' && r.data && typeof r.username === 'string' && (r.scheme === 'os' || r.scheme === 'plain') ? r : null;
  }
}
