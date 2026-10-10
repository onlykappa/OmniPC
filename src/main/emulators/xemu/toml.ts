// Minimal, key-preserving TOML editor for xemu.toml.
//
// xemu reads its settings with toml++ (genconfig cnode.h update_from_table) and
// rewrites the file on exit with only the values that differ from the defaults
// (CNode::generate_delta_toml): [table] headers, `key = value` lines, literal
// strings ('C:\path'), and arrays of inline tables for input.gamepad_mappings.
// This editor keeps every line it does not touch byte-for-byte (comments,
// unknown keys, ordering) and only rewrites the value of a key it sets.
//
// Supported: comments, [table] and [[array.of.tables]] headers, bare/quoted and
// dotted keys, basic/literal (multi-line) strings, integers, floats, booleans,
// (multi-line) arrays and inline tables. Dates are kept as raw text.
// Keys inside [[array.of.tables]] sections are read-only through this API.

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

export class TomlParseError extends Error {
  constructor(message: string, readonly line: number) {
    super(`line ${line}: ${message}`);
  }
}

interface Entry {
  kind: 'header' | 'kv' | 'other';
  text: string;
  /** Table the entry belongs to (for headers: the header path). */
  table: string[];
  /** Inside (or is) an [[array of tables]] section. */
  arrayTable: boolean;
  key?: string[];
  valueStart?: number;
  valueEnd?: number;
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

function isTable(v: TomlValue | undefined): v is TomlTable {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function samePath(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function startsWith(path: string[], prefix: string[]): boolean {
  return prefix.length <= path.length && prefix.every((x, i) => x === path[i]);
}

export function tomlEqual(a: TomlValue | undefined, b: TomlValue | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => tomlEqual(x, b[i]));
  if (isTable(a) && isTable(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && tomlEqual(a[k], b[k]));
  }
  return false;
}

function clone<T extends TomlValue>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

export function formatKey(k: string): string {
  return BARE_KEY.test(k) ? k : formatBasicString(k);
}

function formatBasicString(s: string): string {
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
  return `${out}"`;
}

/** Strings are written as literal strings when possible (as toml++ does for xemu's Windows paths). */
export function formatString(s: string): string {
  // eslint-disable-next-line no-control-regex
  return /['\u0000-\u0008\u000a-\u001f\u007f]/.test(s) ? formatBasicString(s) : `'${s}'`;
}

export function formatValue(v: TomlValue, depth = 0): string {
  if (typeof v === 'string') return formatString(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'nan';
    if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf';
    return String(v);
  }
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    if (v.some((x) => isTable(x) || Array.isArray(x))) {
      // Same layout as genconfig's generate_delta_toml for arrays of tables.
      const pad = '    '.repeat(depth + 1);
      return `[\n${v.map((x) => pad + formatValue(x, depth + 1)).join(',\n')}\n${pad}]`;
    }
    return `[${v.map((x) => formatValue(x, depth)).join(', ')}]`;
  }
  const keys = Object.keys(v);
  if (!keys.length) return '{}';
  return `{ ${keys.map((k) => `${formatKey(k)} = ${formatValue(v[k], depth)}`).join(', ')} }`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

class Scanner {
  pos = 0;
  constructor(readonly s: string) {}

  line(at = this.pos): number {
    let n = 1;
    for (let i = 0; i < at && i < this.s.length; i++) if (this.s[i] === '\n') n++;
    return n;
  }

  fail(msg: string, at = this.pos): never {
    throw new TomlParseError(msg, this.line(at));
  }

  peek(n = 0): string {
    return this.s[this.pos + n] ?? '';
  }

  startsWith(t: string): boolean {
    return this.s.startsWith(t, this.pos);
  }

  eof(): boolean {
    return this.pos >= this.s.length;
  }

  skipWs(): void {
    while (this.peek() === ' ' || this.peek() === '\t') this.pos++;
  }

  /** Whitespace, newlines and comments (inside arrays). */
  skipWsNl(): void {
    for (;;) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') this.pos++;
      else if (c === '#') this.skipComment();
      else return;
    }
  }

  skipComment(): void {
    while (!this.eof() && this.peek() !== '\n') this.pos++;
  }

  /** Rest of the line after a value/header: whitespace and an optional comment, then a newline or EOF. */
  endOfLine(): void {
    this.skipWs();
    if (this.peek() === '#') this.skipComment();
    if (this.peek() === '\r') this.pos++;
    if (this.eof()) return;
    if (this.peek() !== '\n') this.fail(`unexpected text "${this.s.slice(this.pos, this.pos + 12).split('\n')[0]}" after value`);
    this.pos++;
  }

  key(): string[] {
    const parts: string[] = [];
    for (;;) {
      this.skipWs();
      const c = this.peek();
      if (c === '"') parts.push(this.basicString());
      else if (c === "'") parts.push(this.literalString());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(this.s.slice(this.pos, this.pos + 256));
        if (!m) this.fail('expected a key');
        parts.push(m[0]);
        this.pos += m[0].length;
      }
      this.skipWs();
      if (this.peek() !== '.') return parts;
      this.pos++;
    }
  }

  basicString(): string {
    const start = this.pos;
    this.pos++;
    let out = '';
    for (;;) {
      const c = this.peek();
      if (this.eof() || c === '\n') this.fail('unterminated string', start);
      this.pos++;
      if (c === '"') return out;
      if (c === '\\') out += this.escape();
      else out += c;
    }
  }

  escape(): string {
    const e = this.peek();
    this.pos++;
    const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\', e: '\u001b' };
    if (e in simple) return simple[e];
    if (e === 'u' || e === 'U') {
      const len = e === 'u' ? 4 : 8;
      const hex = this.s.slice(this.pos, this.pos + len);
      if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== len) this.fail('invalid unicode escape');
      this.pos += len;
      return String.fromCodePoint(parseInt(hex, 16));
    }
    this.fail(`invalid escape \\${e}`);
  }

  literalString(): string {
    const start = this.pos;
    const end = this.s.indexOf("'", this.pos + 1);
    const nl = this.s.indexOf('\n', this.pos + 1);
    if (end < 0 || (nl >= 0 && nl < end)) this.fail('unterminated string', start);
    this.pos = end + 1;
    return this.s.slice(start + 1, end);
  }

  multiBasic(): string {
    const start = this.pos;
    this.pos += 3;
    if (this.startsWith('\r\n')) this.pos += 2;
    else if (this.peek() === '\n') this.pos++;
    let out = '';
    for (;;) {
      if (this.eof()) this.fail('unterminated multi-line string', start);
      if (this.startsWith('"""')) {
        // Up to two quotes may directly precede the closing delimiter.
        let extra = 0;
        while (this.peek(3 + extra) === '"' && extra < 2) extra++;
        out += '"'.repeat(extra);
        this.pos += 3 + extra;
        return out;
      }
      const c = this.peek();
      this.pos++;
      if (c === '\\') {
        if (/^[ \t]*\r?\n/.test(this.s.slice(this.pos, this.pos + 64))) {
          while (/[ \t\r\n]/.test(this.peek())) this.pos++;
        } else out += this.escape();
      } else out += c;
    }
  }

  multiLiteral(): string {
    const start = this.pos;
    this.pos += 3;
    if (this.startsWith('\r\n')) this.pos += 2;
    else if (this.peek() === '\n') this.pos++;
    const end = this.s.indexOf("'''", this.pos);
    if (end < 0) this.fail('unterminated multi-line string', start);
    let extra = 0;
    while (this.s[end + 3 + extra] === "'" && extra < 2) extra++;
    const out = this.s.slice(this.pos, end + extra);
    this.pos = end + 3 + extra;
    return out;
  }

  value(): TomlValue {
    const c = this.peek();
    if (this.startsWith('"""')) return this.multiBasic();
    if (this.startsWith("'''")) return this.multiLiteral();
    if (c === '"') return this.basicString();
    if (c === "'") return this.literalString();
    if (c === '[') return this.array();
    if (c === '{') return this.inlineTable();
    return this.scalar();
  }

  array(): TomlValue[] {
    const start = this.pos;
    this.pos++;
    const out: TomlValue[] = [];
    for (;;) {
      this.skipWsNl();
      if (this.eof()) this.fail('unterminated array', start);
      if (this.peek() === ']') {
        this.pos++;
        return out;
      }
      out.push(this.value());
      this.skipWsNl();
      if (this.peek() === ',') this.pos++;
      else if (this.peek() !== ']') this.fail('expected , or ] in array');
    }
  }

  inlineTable(): TomlTable {
    const start = this.pos;
    this.pos++;
    const out: TomlTable = {};
    this.skipWsNl();
    if (this.peek() === '}') {
      this.pos++;
      return out;
    }
    for (;;) {
      this.skipWsNl();
      const key = this.key();
      if (this.peek() !== '=') this.fail('expected = in inline table');
      this.pos++;
      this.skipWs();
      const v = this.value();
      let t = out;
      for (const k of key.slice(0, -1)) {
        if (t[k] === undefined) t[k] = {};
        const next = t[k];
        if (!isTable(next)) this.fail(`key ${key.join('.')} conflicts with a value`);
        t = next;
      }
      const last = key[key.length - 1];
      if (t[last] !== undefined) this.fail(`duplicate key ${key.join('.')}`);
      t[last] = v;
      this.skipWsNl();
      if (this.eof()) this.fail('unterminated inline table', start);
      if (this.peek() === ',') {
        this.pos++;
        continue;
      }
      if (this.peek() === '}') {
        this.pos++;
        return out;
      }
      this.fail('expected , or } in inline table');
    }
  }

  scalar(): TomlValue {
    const m = /^[^\s,\]}#]+/.exec(this.s.slice(this.pos, this.pos + 128));
    if (!m) this.fail('expected a value');
    const raw = m[0];
    this.pos += raw.length;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (/^[+-]?(inf|nan)$/.test(raw)) return raw.includes('nan') ? NaN : raw.startsWith('-') ? -Infinity : Infinity;
    const clean = raw.replace(/_/g, '');
    if (/^0x[0-9A-Fa-f]+$/.test(clean)) return parseInt(clean.slice(2), 16);
    if (/^0o[0-7]+$/.test(clean)) return parseInt(clean.slice(2), 8);
    if (/^0b[01]+$/.test(clean)) return parseInt(clean.slice(2), 2);
    if (/^[+-]?\d+$/.test(clean)) return parseInt(clean, 10);
    if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(clean)) return parseFloat(clean);
    // Offset date-times / local dates and times: kept as text.
    if (/^\d{4}-\d{2}-\d{2}|^\d{2}:\d{2}/.test(raw)) {
      // A date may continue with " HH:MM:SS" after a space.
      const more = /^ \d{2}:\d{2}[^\s,\]}#]*/.exec(this.s.slice(this.pos, this.pos + 64));
      if (more && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        this.pos += more[0].length;
        return raw + more[0];
      }
      return raw;
    }
    this.fail(`invalid value "${raw}"`);
  }
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export class TomlDocument {
  private constructor(private entries: Entry[], private readonly eol: string) {}

  static empty(): TomlDocument {
    return new TomlDocument([], '\n');
  }

  static parse(text: string): TomlDocument {
    const s = new Scanner(text.replace(/^\uFEFF/, ''));
    const entries: Entry[] = [];
    let table: string[] = [];
    let arrayTable = false;
    const defined = new Set<string>(); // explicitly defined tables and keys
    const headers = new Set<string>();
    const id = (p: string[]) => JSON.stringify(p);
    while (!s.eof()) {
      const start = s.pos;
      s.skipWs();
      const c = s.peek();
      if (c === '#' || c === '\n' || c === '\r' || s.eof()) {
        if (c === '#') s.skipComment();
        if (s.peek() === '\r') s.pos++;
        if (!s.eof() && s.peek() !== '\n') s.fail('unexpected character');
        if (!s.eof()) s.pos++;
        entries.push({ kind: 'other', text: s.s.slice(start, s.pos), table, arrayTable });
        continue;
      }
      if (c === '[') {
        const aot = s.peek(1) === '[';
        s.pos += aot ? 2 : 1;
        const path = s.key();
        if (aot ? !s.startsWith(']]') : s.peek() !== ']') s.fail('unterminated table header');
        s.pos += aot ? 2 : 1;
        s.endOfLine();
        if (!aot) {
          if (headers.has(id(path)) || defined.has(id(path))) s.fail(`table [${path.join('.')}] defined twice`, start);
          headers.add(id(path));
        }
        table = path;
        arrayTable = aot || [...entries].some((e) => e.kind === 'header' && e.arrayTable && startsWith(path, e.table) && path.length > e.table.length);
        entries.push({ kind: 'header', text: s.s.slice(start, s.pos), table: path, arrayTable });
        continue;
      }
      const key = s.key();
      if (s.peek() !== '=') s.fail(`expected = after key ${key.join('.')}`);
      s.pos++;
      s.skipWs();
      const valueStart = s.pos - start;
      s.value();
      const valueEnd = s.pos - start;
      s.endOfLine();
      if (!arrayTable) {
        const full = [...table, ...key];
        if (defined.has(id(full)) || headers.has(id(full))) s.fail(`duplicate key ${full.join('.')}`, start);
        defined.add(id(full));
      }
      entries.push({ kind: 'kv', text: s.s.slice(start, s.pos), table, arrayTable, key, valueStart, valueEnd });
    }
    const eol = /\r\n/.test(text) ? '\r\n' : '\n';
    return new TomlDocument(entries, eol);
  }

  toString(): string {
    return this.entries.map((e) => e.text).join('');
  }

  private rawValue(e: Entry): string {
    return e.text.slice(e.valueStart!, e.valueEnd!);
  }

  private parsedValue(e: Entry): TomlValue {
    const sc = new Scanner(this.rawValue(e));
    return sc.value();
  }

  private kvs(): (Entry & { full: string[] })[] {
    return this.entries.filter((e) => e.kind === 'kv' && !e.arrayTable).map((e) => Object.assign(e, { full: [...e.table, ...e.key!] }));
  }

  /** True when [[path]] array-of-tables sections exist (read-only for this editor). */
  hasArrayTables(path: string[]): boolean {
    return this.entries.some((e) => e.kind === 'header' && e.arrayTable && samePath(e.table, path));
  }

  get(path: string[]): TomlValue | undefined {
    for (const e of this.kvs()) {
      if (samePath(e.full, path)) return this.parsedValue(e);
      if (startsWith(path, e.full)) {
        let v: TomlValue | undefined = this.parsedValue(e);
        for (const k of path.slice(e.full.length)) v = isTable(v) ? v[k] : undefined;
        if (v !== undefined) return v;
      }
    }
    return undefined;
  }

  /** Sets a value, keeping everything else intact. Returns true if the document changed. */
  set(path: string[], value: TomlValue): boolean {
    if (!path.length) throw new Error('empty TOML path');
    for (const e of this.kvs()) {
      if (samePath(e.full, path)) {
        if (tomlEqual(this.parsedValue(e), value)) return false;
        this.replaceValue(e, value);
        return true;
      }
      if (startsWith(path, e.full)) {
        const root = this.parsedValue(e);
        if (!isTable(root)) throw new Error(`${e.full.join('.')} is not a table`);
        const next = clone(root);
        let t: TomlTable = next;
        for (const k of path.slice(e.full.length, -1)) {
          if (t[k] === undefined) t[k] = {};
          const child = t[k];
          if (!isTable(child)) throw new Error(`${path.join('.')} conflicts with an existing value`);
          t = child;
        }
        const last = path[path.length - 1];
        if (tomlEqual(t[last], value)) return false;
        t[last] = value;
        this.replaceValue(e, next);
        return true;
      }
      if (startsWith(e.full, path)) throw new Error(`${path.join('.')} is a table in this file`);
    }
    if (this.entries.some((e) => e.kind === 'header' && e.arrayTable && startsWith(path, e.table))) {
      throw new Error(`${path.join('.')} lives in an array of tables, which this editor does not modify`);
    }
    this.insert(path, value);
    return true;
  }

  private replaceValue(e: Entry, value: TomlValue): void {
    const depth = 0;
    e.text = e.text.slice(0, e.valueStart!) + formatValue(value, depth).replace(/\n/g, this.eol) + e.text.slice(e.valueEnd!);
    e.valueEnd = e.valueStart! + formatValue(value, depth).replace(/\n/g, this.eol).length;
  }

  private insert(path: string[], value: TomlValue): void {
    const parent = path.slice(0, -1);
    const headerIdx = (p: string[]) => this.entries.findIndex((e) => e.kind === 'header' && !e.arrayTable && samePath(e.table, p));
    // 1. The parent table has a header (or is the root table): add the key to that section.
    let section: string[] | null = parent.length === 0 || headerIdx(parent) >= 0 ? parent : null;
    let key = path.slice(-1);
    // 2. The parent table was created implicitly by dotted keys: add another dotted key next to them.
    if (!section) {
      // A sibling dotted key whose implicit table is a prefix of (or equal to) the parent.
      const sibling = this.kvs().find((e) => e.key!.length > 1 && startsWith(parent, e.full.slice(0, e.table.length + 1)));
      if (sibling) {
        section = sibling.table;
        key = path.slice(sibling.table.length);
      }
    }
    if (section) {
      this.insertInSection(section, key, value);
      return;
    }
    // 3. New [parent] section at the end of the file.
    this.ensureTrailingNewline();
    const blank = this.entries.length ? this.eol : '';
    const header: Entry = { kind: 'header', text: `${blank}[${parent.map(formatKey).join('.')}]${this.eol}`, table: parent, arrayTable: false };
    this.entries.push(header);
    this.entries.push(this.kvEntry(parent, key, value, ''));
  }

  private kvEntry(table: string[], key: string[], value: TomlValue, indent: string): Entry {
    const prefix = `${indent}${key.map(formatKey).join('.')} = `;
    const v = formatValue(value).replace(/\n/g, this.eol);
    return { kind: 'kv', text: `${prefix}${v}${this.eol}`, table, arrayTable: false, key, valueStart: prefix.length, valueEnd: prefix.length + v.length };
  }

  private insertInSection(section: string[], key: string[], value: TomlValue): void {
    let start = -1; // index of the header (or -1 for the root table)
    if (section.length) start = this.entries.findIndex((e) => e.kind === 'header' && !e.arrayTable && samePath(e.table, section));
    let end = this.entries.findIndex((e, i) => i > start && e.kind === 'header');
    if (end < 0) end = this.entries.length;
    let lastKv = -1;
    for (let i = start + 1; i < end; i++) if (this.entries[i].kind === 'kv') lastKv = i;
    const at = lastKv >= 0 ? lastKv + 1 : start + 1;
    const indent = lastKv >= 0 ? /^[ \t]*/.exec(this.entries[lastKv].text)![0] : '';
    if (at > 0) {
      const prev = this.entries[at - 1];
      if (!prev.text.endsWith('\n')) prev.text += this.eol;
    }
    this.entries.splice(at, 0, this.kvEntry(section, key, value, indent));
  }

  private ensureTrailingNewline(): void {
    const last = this.entries[this.entries.length - 1];
    if (last && !last.text.endsWith('\n')) last.text += this.eol;
  }
}

/** Parse check with toml++-like strictness for the subset xemu uses (duplicate keys/tables are errors). */
export function checkToml(text: string): { ok: boolean; issues: string[] } {
  try {
    TomlDocument.parse(text);
    return { ok: true, issues: [] };
  } catch (err) {
    return { ok: false, issues: [(err as Error).message] };
  }
}
