// Minimal, key-preserving TOML editor for Xenia's xenia-canary.config.toml.
//
// Xenia writes its config itself (src/xenia/config.cc SaveConfig): one
// `[Category]` table per cvar category, `name = value` lines with an aligned
// `\t# description` comment, and multi-line descriptions as extra comment-only
// lines. String values are TOML literal strings ('...'), or basic / multi-line
// strings when they contain special characters (base/cvar.cc EscapeString).
// This editor only replaces the value span of keys it sets, appends missing
// keys to the end of their table and never reorders or drops anything else.

export type TomlValue = string | number | boolean | { float: number };

interface Entry {
  table: string;
  key: string;
  /** Index of the line holding the key. */
  line: number;
  /** Value span on that line (single-line values only). */
  start: number;
  end: number;
  raw: string;
  multiline: boolean;
}

const KEY_RE = /^(\s*)([A-Za-z0-9_-]+|"[^"]*"|'[^']*')(\s*=\s*)/;

function unquoteKey(k: string): string {
  return (k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'")) ? k.slice(1, -1) : k;
}

/** Length of a single-line value token at the start of `s`, or -1 when malformed. */
function scanValue(s: string): number {
  if (s.startsWith("'")) {
    const i = s.indexOf("'", 1);
    return i < 0 ? -1 : i + 1;
  }
  if (s.startsWith('"')) {
    for (let i = 1; i < s.length; i++) {
      if (s[i] === '\\') i++;
      else if (s[i] === '"') return i + 1;
    }
    return -1;
  }
  if (s.startsWith('[') || s.startsWith('{')) {
    // Arrays / inline tables: Xenia never writes them for cvars; accept up to a matching close on the line.
    let depth = 0;
    let quote: string | null = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quote) {
        if (c === '\\' && quote === '"') i++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return -1;
  }
  const m = /^[^\s#]+/.exec(s);
  return m ? m[0].length : -1;
}

function decodeBasic(body: string): string {
  return body.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/g, (_, e: string) => {
    if (e[0] === 'u' || e[0] === 'U') return String.fromCodePoint(parseInt(e.slice(1), 16));
    return ({ b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' } as Record<string, string>)[e] ?? e;
  });
}

/** Decoded string for a raw TOML scalar (strings unquoted, everything else as written). */
export function decodeTomlScalar(raw: string): string {
  if (raw.startsWith("'''")) return raw.slice(3, -3).replace(/^\r?\n/, '');
  if (raw.startsWith('"""')) return decodeBasic(raw.slice(3, -3).replace(/^\r?\n/, '').replace(/\\\r?\n\s*/g, ''));
  if (raw.startsWith("'")) return raw.slice(1, -1);
  if (raw.startsWith('"')) return decodeBasic(raw.slice(1, -1));
  return raw;
}

export type TomlType = 'string' | 'integer' | 'float' | 'boolean' | 'other';

export function tomlTypeOf(raw: string): TomlType {
  if (/^('|")/.test(raw)) return 'string';
  if (raw === 'true' || raw === 'false') return 'boolean';
  if (/^[+-]?(\d[\d_]*|0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+)$/.test(raw)) return 'integer';
  if (/^[+-]?(\d[\d_]*)(\.\d[\d_]*)?([eE][+-]?\d+)?$/.test(raw) || /^[+-]?(inf|nan)$/.test(raw)) return 'float';
  return 'other';
}

/** Formats a value the way Xenia's toml++ reader expects it for the cvar's type. */
export function formatTomlValue(v: TomlValue): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(Math.trunc(v));
  if (typeof v === 'object') {
    const s = String(v.float);
    return /[.eE]|inf|nan/i.test(s) ? s : `${s}.0`;
  }
  // Literal string unless it contains a quote or control character (base/cvar.cc EscapeString).
  // eslint-disable-next-line no-control-regex
  if (!/['\u0000-\u001f\u007f]/.test(v)) return `'${v}'`;
  // eslint-disable-next-line no-control-regex
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/[\u0000-\u001f\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}`)}"`;
}

function sameValue(raw: string, v: TomlValue): boolean {
  const t = tomlTypeOf(raw);
  if (typeof v === 'boolean') return t === 'boolean' && raw === String(v);
  if (typeof v === 'number') return t === 'integer' && Number(raw.replace(/_/g, '')) === Math.trunc(v);
  if (typeof v === 'object') return t === 'float' && Number(raw.replace(/_/g, '')) === v.float;
  return t === 'string' && decodeTomlScalar(raw) === v;
}

export class TomlDocument {
  private lines: string[];
  private readonly eol: string;
  private entries: Entry[] = [];
  private tables: { name: string; line: number }[] = [];
  readonly issues: string[] = [];

  private constructor(text: string) {
    this.eol = text.includes('\r\n') ? '\r\n' : '\n';
    this.lines = text.length ? text.split(/\r?\n/) : [];
    if (this.lines.length && this.lines[this.lines.length - 1] === '') this.lines.pop();
    this.index();
  }

  static parse(text: string): TomlDocument {
    return new TomlDocument(text.replace(/^\uFEFF/, ''));
  }

  static empty(): TomlDocument {
    return new TomlDocument('');
  }

  private index(): void {
    this.entries = [];
    this.tables = [];
    this.issues.length = 0;
    let table = '';
    const seen = new Set<string>();
    const seenTables = new Set<string>();
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const h = /^\s*\[\s*([^\][]+?)\s*\]\s*(#.*)?$/.exec(line);
      if (h) {
        table = h[1].split('.').map((p) => unquoteKey(p.trim())).join('.');
        if (seenTables.has(table)) this.issues.push(`Line ${i + 1}: table [${table}] defined twice`);
        seenTables.add(table);
        this.tables.push({ name: table, line: i });
        continue;
      }
      if (trimmed.startsWith('[')) {
        this.issues.push(`Line ${i + 1}: malformed table header`);
        continue;
      }
      const k = KEY_RE.exec(line);
      if (!k) {
        this.issues.push(`Line ${i + 1}: expected "key = value"`);
        continue;
      }
      const key = unquoteKey(k[2]);
      const start = k[0].length;
      const rest = line.slice(start);
      const id = `${table}\u0000${key}`;
      if (seen.has(id)) this.issues.push(`Line ${i + 1}: duplicate key ${table ? `${table}.` : ''}${key}`);
      seen.add(id);
      const triple = rest.startsWith("'''") ? "'''" : rest.startsWith('"""') ? '"""' : null;
      if (triple) {
        const after = rest.slice(3);
        const closeSame = after.indexOf(triple);
        if (closeSame >= 0) {
          const raw = rest.slice(0, 3 + closeSame + 3);
          this.entries.push({ table, key, line: i, start, end: start + raw.length, raw, multiline: false });
          continue;
        }
        const parts = [rest];
        let j = i + 1;
        let closed = false;
        for (; j < this.lines.length; j++) {
          parts.push(this.lines[j]);
          if (this.lines[j].includes(triple)) {
            closed = true;
            break;
          }
        }
        if (!closed) {
          this.issues.push(`Line ${i + 1}: unterminated multi-line string (file may be truncated)`);
          break;
        }
        const joined = parts.join('\n');
        const raw = joined.slice(0, joined.lastIndexOf(triple) + 3);
        this.entries.push({ table, key, line: i, start, end: -1, raw, multiline: true });
        i = j;
        continue;
      }
      const len = scanValue(rest);
      if (len <= 0) {
        this.issues.push(`Line ${i + 1}: ${rest.trim() ? 'unterminated or invalid value' : 'missing value'} for ${key}`);
        continue;
      }
      const tail = rest.slice(len);
      if (tail.trim() && !tail.trim().startsWith('#')) this.issues.push(`Line ${i + 1}: unexpected text after value of ${key}`);
      this.entries.push({ table, key, line: i, start, end: start + len, raw: rest.slice(0, len), multiline: false });
    }
  }

  private find(table: string, key: string): Entry | undefined {
    return this.entries.find((e) => e.table === table && e.key === key);
  }

  /** Raw TOML text of a value (quotes included), or undefined. */
  raw(table: string, key: string): string | undefined {
    return this.find(table, key)?.raw;
  }

  /** Decoded value: strings unquoted, numbers/booleans as written. */
  get(table: string, key: string): string | undefined {
    const e = this.find(table, key);
    return e ? decodeTomlScalar(e.raw) : undefined;
  }

  type(table: string, key: string): TomlType | undefined {
    const e = this.find(table, key);
    return e ? tomlTypeOf(e.raw) : undefined;
  }

  has(table: string, key: string): boolean {
    return !!this.find(table, key);
  }

  keys(table: string): string[] {
    return this.entries.filter((e) => e.table === table).map((e) => e.key);
  }

  /** Sets a value; returns true when the file content changed. */
  set(table: string, key: string, value: TomlValue): boolean {
    const text = formatTomlValue(value);
    const e = this.find(table, key);
    if (e) {
      if (sameValue(e.raw, value)) return false;
      if (e.multiline) {
        const first = this.lines[e.line].slice(0, e.start);
        const lineCount = e.raw.split('\n').length;
        const lastLine = this.lines[e.line + lineCount - 1];
        const triple = e.raw.slice(0, 3);
        const tail = lastLine.slice(lastLine.lastIndexOf(triple) + 3);
        this.lines.splice(e.line, lineCount, first + text + tail);
      } else {
        const l = this.lines[e.line];
        this.lines[e.line] = l.slice(0, e.start) + text + l.slice(e.end);
      }
      this.index();
      return true;
    }
    const newLine = `${key} = ${text}`;
    const t = this.tables.find((x) => x.name === table);
    if (!table) {
      const firstTable = this.tables[0]?.line ?? this.lines.length;
      this.lines.splice(firstTable, 0, newLine);
    } else if (t) {
      // After the last entry (or header) of the table, before any following blank lines/next header.
      const next = this.tables.find((x) => x.line > t.line)?.line ?? this.lines.length;
      let at = t.line + 1;
      for (const en of this.entries) {
        if (en.table === table && en.line >= at) at = en.line + en.raw.split('\n').length;
      }
      // Keep multi-line description comments that belong to the last entry.
      while (at < next && /^\s+#/.test(this.lines[at])) at++;
      this.lines.splice(at, 0, newLine);
    } else {
      if (this.lines.length && this.lines[this.lines.length - 1].trim() !== '') this.lines.push('');
      this.lines.push(`[${table}]`, newLine);
    }
    this.index();
    return true;
  }

  toString(): string {
    return this.lines.length ? this.lines.join(this.eol) + this.eol : '';
  }
}

export function checkToml(text: string): { ok: boolean; issues: string[] } {
  if (text.includes('\u0000')) return { ok: false, issues: ['File contains NUL bytes (likely corrupted by a crash during write)'] };
  const issues = TomlDocument.parse(text).issues;
  return { ok: issues.length === 0, issues };
}
