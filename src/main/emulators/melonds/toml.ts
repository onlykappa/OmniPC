// Minimal, format-preserving TOML editor for melonDS.toml.
// melonDS (src/frontend/qt_sdl/Config.cpp) keeps its whole configuration in one
// toml11 v4 value tree and rewrites the file with `file << RootTable` on every
// Config::Save(), so in practice the file holds [table] / [table.sub] headers
// with `key = value` lines. This editor nevertheless understands the full TOML
// statement syntax (dotted and quoted keys, all string forms, multi-line
// arrays, inline tables, comments) so it can locate and replace single values
// while leaving every other byte untouched. Values inside inline tables and
// arrays of tables are readable but treated as read-only.
//
// A parse check matters more than usual here: Config::Load() catches
// toml::syntax_error and starts from an EMPTY table, and the next Config::Save()
// (e.g. when the window closes) overwrites the user's file with defaults.

export type TomlScalar = string | number | boolean;
export type TomlValue = TomlScalar | TomlValue[] | { [k: string]: TomlValue } | { datetime: string };

export class TomlError extends Error {
  constructor(message: string, readonly line: number) {
    super(`line ${line}: ${message}`);
  }
}

interface Parsed {
  kind: 'string' | 'int' | 'float' | 'bool' | 'datetime' | 'array' | 'table';
  value: TomlValue;
}

interface Header {
  path: string[];
  arrayOfTables: boolean;
  /** Offset just after the header line's newline (or end of text). */
  lineEnd: number;
}

interface KeyValue {
  /** Section index (-1 = root) the statement belongs to. */
  section: number;
  fullPath: string[];
  relPath: string[];
  valueStart: number;
  valueEnd: number;
  lineEnd: number;
  parsed: Parsed;
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

function pathEq(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function isPrefix(prefix: string[], of: string[]): boolean {
  return prefix.length <= of.length && prefix.every((x, i) => x === of[i]);
}

export function encodeKey(k: string): string {
  return BARE_KEY.test(k) ? k : encodeString(k);
}

export function encodeString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 0x20 || c === 0x7f) out += `\\u${c.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out + '"';
}

export function encodeValue(v: TomlScalar): string {
  if (typeof v === 'string') return encodeString(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (!Number.isFinite(v)) return Number.isNaN(v) ? 'nan' : v > 0 ? 'inf' : '-inf';
  return String(v);
}

function kindOf(v: TomlScalar): Parsed['kind'] {
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'bool';
  return Number.isInteger(v) ? 'int' : 'float';
}

class Parser {
  pos = 0;
  readonly headers: Header[] = [];
  readonly kvs: KeyValue[] = [];

  constructor(private readonly s: string) {}

  private line(at = this.pos): number {
    let n = 1;
    for (let i = 0; i < at && i < this.s.length; i++) if (this.s[i] === '\n') n++;
    return n;
  }

  private fail(msg: string, at = this.pos): never {
    throw new TomlError(msg, this.line(at));
  }

  private peek(o = 0): string {
    return this.s[this.pos + o] ?? '';
  }

  private skipWs(): void {
    while (this.peek() === ' ' || this.peek() === '\t') this.pos++;
  }

  /** Skips whitespace, newlines and comments (inside arrays). */
  private skipWsNl(): void {
    for (;;) {
      this.skipWs();
      const c = this.peek();
      if (c === '\n' || (c === '\r' && this.peek(1) === '\n')) this.pos += c === '\r' ? 2 : 1;
      else if (c === '#') this.skipComment();
      else return;
    }
  }

  private skipComment(): void {
    while (this.pos < this.s.length && this.peek() !== '\n') this.pos++;
  }

  /** Consumes optional whitespace/comment and the end of line; returns the offset after it. */
  private endOfLine(): number {
    this.skipWs();
    if (this.peek() === '#') this.skipComment();
    if (this.peek() === '\r' && this.peek(1) === '\n') this.pos += 2;
    else if (this.peek() === '\n') this.pos++;
    else if (this.pos < this.s.length) this.fail(`unexpected "${this.peek()}" after statement`);
    return this.pos;
  }

  parse(): void {
    let section = -1;
    const seenKeys = new Set<string>();
    const seenHeaders = new Set<string>();
    while (this.pos < this.s.length) {
      this.skipWs();
      const c = this.peek();
      if (c === '' ) break;
      if (c === '\n' || (c === '\r' && this.peek(1) === '\n') || c === '#') {
        this.endOfLine();
        continue;
      }
      if (c === '[') {
        const aot = this.peek(1) === '[';
        this.pos += aot ? 2 : 1;
        this.skipWs();
        const path = this.parseKey();
        this.skipWs();
        if (this.peek() !== ']' || (aot && this.peek(1) !== ']')) this.fail('unterminated table header');
        this.pos += aot ? 2 : 1;
        const lineEnd = this.endOfLine();
        const id = JSON.stringify(path);
        if (!aot && seenHeaders.has(id)) this.fail(`table [${path.join('.')}] defined twice`);
        if (!aot) seenHeaders.add(id);
        this.headers.push({ path, arrayOfTables: aot, lineEnd });
        section = this.headers.length - 1;
        continue;
      }
      const relPath = this.parseKey();
      this.skipWs();
      if (this.peek() !== '=') this.fail('expected "=" after key');
      this.pos++;
      this.skipWs();
      const valueStart = this.pos;
      const parsed = this.parseValue();
      const valueEnd = this.pos;
      const lineEnd = this.endOfLine();
      const base = section >= 0 ? this.headers[section].path : [];
      const fullPath = [...base, ...relPath];
      // Keys under an array of tables repeat legitimately; only check plain tables.
      const inAot = section >= 0 && this.headers[section].arrayOfTables;
      const id = JSON.stringify(fullPath);
      if (!inAot) {
        if (seenKeys.has(id)) this.fail(`duplicate key ${fullPath.join('.')}`, valueStart);
        seenKeys.add(id);
      }
      this.kvs.push({ section, fullPath, relPath, valueStart, valueEnd, lineEnd, parsed });
    }
  }

  private parseKey(): string[] {
    const parts: string[] = [];
    for (;;) {
      this.skipWs();
      const c = this.peek();
      if (c === '"') parts.push(this.parseBasicString());
      else if (c === "'") parts.push(this.parseLiteralString());
      else {
        const start = this.pos;
        while (/[A-Za-z0-9_-]/.test(this.peek())) this.pos++;
        if (start === this.pos) this.fail('expected a key');
        parts.push(this.s.slice(start, this.pos));
      }
      this.skipWs();
      if (this.peek() !== '.') return parts;
      this.pos++;
    }
  }

  private parseBasicString(): string {
    if (this.s.startsWith('"""', this.pos)) return this.parseMultiBasic();
    this.pos++;
    let out = '';
    for (;;) {
      const c = this.peek();
      if (c === '' || c === '\n') this.fail('unterminated string');
      this.pos++;
      if (c === '"') return out;
      if (c === '\\') out += this.parseEscape();
      else out += c;
    }
  }

  private parseEscape(): string {
    const e = this.peek();
    this.pos++;
    const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };
    if (e in simple) return simple[e];
    if (e === 'u' || e === 'U' || e === 'x') {
      const len = e === 'u' ? 4 : e === 'U' ? 8 : 2;
      const hex = this.s.slice(this.pos, this.pos + len);
      if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== len) this.fail('invalid unicode escape');
      this.pos += len;
      return String.fromCodePoint(parseInt(hex, 16));
    }
    return this.fail(`invalid escape \\${e}`);
  }

  private parseMultiBasic(): string {
    this.pos += 3;
    if (this.peek() === '\n') this.pos++;
    else if (this.peek() === '\r' && this.peek(1) === '\n') this.pos += 2;
    let out = '';
    for (;;) {
      if (this.pos >= this.s.length) this.fail('unterminated multi-line string');
      if (this.s.startsWith('"""', this.pos)) {
        // Up to two extra quotes may close the string ("""a"""" -> a").
        let q = 3;
        while (this.s[this.pos + q] === '"' && q < 5) q++;
        out += '"'.repeat(q - 3);
        this.pos += q;
        return out;
      }
      const c = this.peek();
      this.pos++;
      if (c === '\\') {
        // Line-ending backslash trims the newline and following whitespace.
        let j = this.pos;
        while (this.s[j] === ' ' || this.s[j] === '\t') j++;
        if (this.s[j] === '\n' || (this.s[j] === '\r' && this.s[j + 1] === '\n')) {
          this.pos = j;
          while (/[ \t\r\n]/.test(this.peek())) this.pos++;
          continue;
        }
        out += this.parseEscape();
      } else out += c;
    }
  }

  private parseLiteralString(): string {
    if (this.s.startsWith("'''", this.pos)) {
      this.pos += 3;
      if (this.peek() === '\n') this.pos++;
      else if (this.peek() === '\r' && this.peek(1) === '\n') this.pos += 2;
      const end = this.s.indexOf("'''", this.pos);
      if (end < 0) this.fail('unterminated multi-line literal string');
      let q = 3;
      while (this.s[end + q] === "'" && q < 5) q++;
      const out = this.s.slice(this.pos, end) + "'".repeat(q - 3);
      this.pos = end + q;
      return out;
    }
    this.pos++;
    const start = this.pos;
    while (this.peek() !== "'") {
      if (this.peek() === '' || this.peek() === '\n') this.fail('unterminated literal string');
      this.pos++;
    }
    const out = this.s.slice(start, this.pos);
    this.pos++;
    return out;
  }

  private parseValue(): Parsed {
    const c = this.peek();
    if (c === '"') return { kind: 'string', value: this.parseBasicString() };
    if (c === "'") return { kind: 'string', value: this.parseLiteralString() };
    if (c === '[') {
      this.pos++;
      const arr: TomlValue[] = [];
      for (;;) {
        this.skipWsNl();
        if (this.peek() === ']') {
          this.pos++;
          return { kind: 'array', value: arr };
        }
        arr.push(this.parseValue().value);
        this.skipWsNl();
        if (this.peek() === ',') this.pos++;
        else if (this.peek() !== ']') this.fail('expected "," or "]" in array');
      }
    }
    if (c === '{') {
      this.pos++;
      const tbl: { [k: string]: TomlValue } = {};
      this.skipWs();
      if (this.peek() === '}') {
        this.pos++;
        return { kind: 'table', value: tbl };
      }
      for (;;) {
        this.skipWs();
        const key = this.parseKey();
        this.skipWs();
        if (this.peek() !== '=') this.fail('expected "=" in inline table');
        this.pos++;
        this.skipWs();
        const v = this.parseValue().value;
        let t = tbl;
        for (const k of key.slice(0, -1)) t = (t[k] ??= {}) as { [k: string]: TomlValue };
        t[key[key.length - 1]] = v;
        this.skipWs();
        if (this.peek() === ',') this.pos++;
        else if (this.peek() === '}') {
          this.pos++;
          return { kind: 'table', value: tbl };
        } else this.fail('expected "," or "}" in inline table');
      }
    }
    const start = this.pos;
    // Datetimes may contain one space between date and time.
    while (this.pos < this.s.length && !/[,\]}\s#]/.test(this.peek())) this.pos++;
    if (this.peek() === ' ' && /^\d{4}-\d{2}-\d{2}$/.test(this.s.slice(start, this.pos)) && /\d/.test(this.peek(1))) {
      this.pos++;
      while (this.pos < this.s.length && !/[,\]}\s#]/.test(this.peek())) this.pos++;
    }
    const tok = this.s.slice(start, this.pos);
    if (!tok) this.fail('expected a value');
    if (tok === 'true' || tok === 'false') return { kind: 'bool', value: tok === 'true' };
    if (/^[+-]?(0|[1-9](_?\d)*)$/.test(tok)) return { kind: 'int', value: Number(tok.replace(/_/g, '')) };
    const radix = /^0([xob])([0-9A-Fa-f_]+)$/.exec(tok);
    if (radix) return { kind: 'int', value: parseInt(radix[2].replace(/_/g, ''), radix[1] === 'x' ? 16 : radix[1] === 'o' ? 8 : 2) };
    if (/^[+-]?(inf|nan)$/.test(tok)) return { kind: 'float', value: tok.endsWith('nan') ? NaN : tok.startsWith('-') ? -Infinity : Infinity };
    if (/^[+-]?(0|[1-9](_?\d)*)(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/.test(tok)) return { kind: 'float', value: Number(tok.replace(/_/g, '')) };
    if (/^\d{4}-\d{2}-\d{2}|^\d{2}:\d{2}/.test(tok)) return { kind: 'datetime', value: { datetime: tok } };
    return this.fail(`invalid value "${tok}"`, start);
  }
}

export class TomlDocument {
  private text: string;
  private headers: Header[] = [];
  private kvs: KeyValue[] = [];

  private constructor(text: string) {
    this.text = text;
    this.reparse();
  }

  /** Parses `text`; throws TomlError on invalid TOML. */
  static parse(text: string): TomlDocument {
    return new TomlDocument(text);
  }

  static empty(): TomlDocument {
    return new TomlDocument('');
  }

  private reparse(): void {
    const p = new Parser(this.text);
    p.parse();
    this.headers = p.headers;
    this.kvs = p.kvs;
  }

  private get eol(): string {
    return this.text.includes('\r\n') ? '\r\n' : '\n';
  }

  toString(): string {
    return this.text;
  }

  /** Reads a value by key path (e.g. ['Instance0', 'Joystick', 'A']). */
  get(path: string[]): TomlValue | undefined {
    const exact = this.kvs.find((k) => pathEq(k.fullPath, path));
    if (exact) return exact.parsed.value;
    // Descend into inline tables.
    for (const kv of this.kvs) {
      if (kv.parsed.kind !== 'table' || !isPrefix(kv.fullPath, path)) continue;
      let v: TomlValue | undefined = kv.parsed.value;
      for (const k of path.slice(kv.fullPath.length)) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
        v = (v as Record<string, TomlValue>)[k];
      }
      return v;
    }
    return undefined;
  }

  /** Returns a value only when it has the expected TOML type (as melonDS's typed getters require). */
  getTyped(path: string[], kind: 'string' | 'int' | 'float' | 'bool'): TomlScalar | undefined {
    const kv = this.kvs.find((k) => pathEq(k.fullPath, path));
    return kv && kv.parsed.kind === kind ? (kv.parsed.value as TomlScalar) : undefined;
  }

  /**
   * Sets a scalar value, replacing only its text when the key exists. Returns
   * true when the document changed (same type and value = no change).
   */
  set(path: string[], value: TomlScalar): boolean {
    if (path.length === 0) throw new Error('empty key path');
    const kind = kindOf(value);
    const existing = this.kvs.find((k) => pathEq(k.fullPath, path));
    if (existing) {
      const pv = existing.parsed.value;
      // melonDS's typed getters reset a value of the wrong TOML type to its default,
      // so a type mismatch (e.g. "2" vs 2) is always rewritten.
      if (existing.parsed.kind === kind &&(pv === value || (typeof pv === 'number' && typeof value === 'number' && Number.isNaN(pv) && Number.isNaN(value)))) return false;
      const sec = existing.section >= 0 ? this.headers[existing.section] : null;
      if (sec?.arrayOfTables) throw new Error(`cannot edit ${path.join('.')} inside an array of tables`);
      this.text = this.text.slice(0, existing.valueStart) + encodeValue(value) + this.text.slice(existing.valueEnd);
      this.reparse();
      return true;
    }
    const blocker = this.kvs.find((k) => isPrefix(k.fullPath, path));
    if (blocker) throw new Error(`cannot set ${path.join('.')}: ${blocker.fullPath.join('.')} is already a value (${blocker.parsed.kind})`);
    const table = path.slice(0, -1);
    const key = path[path.length - 1];
    const eol = this.eol;

    // 1. A [table] header for exactly this table: append after its last key.
    const hIdx = this.headers.findIndex((h) => !h.arrayOfTables && pathEq(h.path, table));
    if (hIdx >= 0 || table.length === 0) {
      const own = this.kvs.filter((k) => k.section === (table.length === 0 ? -1 : hIdx));
      let at: number;
      if (own.length) at = own[own.length - 1].lineEnd;
      else if (table.length === 0) at = this.headers.length ? this.firstHeaderStart() : this.text.length;
      else at = this.headers[hIdx].lineEnd;
      this.insertLine(at, `${encodeKey(key)} = ${encodeValue(value)}`, eol);
      return true;
    }
    // 2. The table exists through dotted keys in some section: add another dotted key there.
    const dotted = this.kvs.filter((k) => isPrefix(table, k.fullPath) && k.fullPath.length > table.length && k.relPath.length > 1);
    for (let i = dotted.length - 1; i >= 0; i--) {
      const d = dotted[i];
      const secPath = d.section >= 0 ? this.headers[d.section].path : [];
      if (d.section >= 0 && this.headers[d.section].arrayOfTables) continue;
      if (!isPrefix(secPath, table)) continue;
      const rel = [...table.slice(secPath.length), key].map(encodeKey).join('.');
      this.insertLine(d.lineEnd, `${rel} = ${encodeValue(value)}`, eol);
      return true;
    }
    // 3. New table at the end of the file.
    let tail = this.text;
    if (tail.length && !tail.endsWith('\n')) tail += eol;
    const sep = tail.length ? eol : '';
    this.text = `${tail}${sep}[${table.map(encodeKey).join('.')}]${eol}${encodeKey(key)} = ${encodeValue(value)}${eol}`;
    this.reparse();
    return true;
  }

  /** Removes a single-line `key = value` statement. Returns true if it existed. */
  delete(path: string[]): boolean {
    const kv = this.kvs.find((k) => pathEq(k.fullPath, path));
    if (!kv) return false;
    let start = kv.valueStart;
    while (start > 0 && this.text[start - 1] !== '\n') start--;
    this.text = this.text.slice(0, start) + this.text.slice(kv.lineEnd);
    this.reparse();
    return true;
  }

  private firstHeaderStart(): number {
    // Start of the line holding the first header.
    const first = this.headers[0];
    let i = first.lineEnd - 1;
    if (this.text[i] === '\n') i--;
    while (i > 0 && this.text[i - 1] !== '\n') i--;
    return i;
  }

  private insertLine(at: number, line: string, eol: string): void {
    let before = this.text.slice(0, at);
    if (before.length && !before.endsWith('\n')) before += eol;
    this.text = `${before}${line}${eol}${this.text.slice(at)}`;
    this.reparse();
  }
}

export function checkToml(text: string): { ok: boolean; issues: string[] } {
  try {
    TomlDocument.parse(text);
    return { ok: true, issues: [] };
  } catch (e) {
    return { ok: false, issues: [(e as Error).message] };
  }
}
