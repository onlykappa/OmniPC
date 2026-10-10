// Minimal, format-preserving editor for the YAML files RPCS3 writes
// (config.yml, vfs.yml, input_configs/*.yml). RPCS3 serialises its cfg::node
// trees with yaml-cpp as nested block mappings (Utilities/Config.cpp
// cfg::encode), so a line-based editor that understands block mappings,
// treats lists / flow collections as opaque values and keeps every other line
// untouched is enough to merge OmniDeck-managed keys without clobbering user
// settings. RPCS3 itself ignores unknown keys and keeps defaults for missing
// ones (cfg::decode with strict=false), so partial files are valid input.

interface KeyLine {
  index: number;
  indent: number;
  key: string;
  /** Raw text after "key:" (trimmed, comment included), '' for a parent node. */
  rawValue: string;
}

const PLAIN_SAFE = /^[^\s\-?:,[\]{}#&*!|>'"%@`][^#]*$/;

function needsQuote(s: string): boolean {
  if (s === '') return true;
  if (!PLAIN_SAFE.test(s) && !/^-?\d/.test(s)) return true;
  if (/:\s|:$|\s#|^\s|\s$/.test(s)) return true;
  if (/^(~|null|Null|NULL)$/.test(s)) return true;
  return false;
}

/** Encodes a scalar the way yaml-cpp would accept it (single quotes when needed, no escapes). */
export function encodeScalar(v: string | number | boolean): string {
  const s = String(v);
  if (!needsQuote(s)) return s;
  if (s === '') return '""';
  return `'${s.replace(/'/g, "''")}'`;
}

function encodeKey(k: string): string {
  return needsQuote(k) ? `'${k.replace(/'/g, "''")}'` : k;
}

/** Decodes a scalar value (plain, 'single' or "double" quoted); comments are stripped. */
export function decodeScalar(raw: string): string {
  const t = raw.trim();
  if (t.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'/.exec(t);
    return m ? m[1].replace(/''/g, "'") : t.slice(1);
  }
  if (t.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"/.exec(t);
    if (!m) return t.slice(1);
    return m[1].replace(/\\(["\\/nrt0]|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4})/g, (_, e: string) => {
      switch (e[0]) {
        case 'n': return '\n';
        case 'r': return '\r';
        case 't': return '\t';
        case '0': return '\0';
        case 'x': case 'u': return String.fromCharCode(parseInt(e.slice(1), 16));
        default: return e;
      }
    });
  }
  const hash = t.search(/\s#/);
  return (hash >= 0 ? t.slice(0, hash) : t).trim();
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isIgnorable(line: string): boolean {
  const t = line.trim();
  return t === '' || t.startsWith('#') || t === '---' || t === '...';
}

function parseKeyLine(line: string, index: number): KeyLine | null {
  const indent = indentOf(line);
  const t = line.slice(indent);
  if (t.startsWith('- ') || t === '-') return null;
  let key: string;
  let rest: string;
  if (t.startsWith("'") || t.startsWith('"')) {
    const q = t[0];
    const re = q === "'" ? /^'((?:[^']|'')*)'\s*:(\s|$)/ : /^"((?:[^"\\]|\\.)*)"\s*:(\s|$)/;
    const m = re.exec(t);
    if (!m) return null;
    key = decodeScalar(t.slice(0, m[0].indexOf(':')).trim());
    rest = t.slice(m[0].length);
  } else {
    const m = /:(\s|$)/.exec(t);
    if (!m) return null;
    key = t.slice(0, m.index).trimEnd();
    rest = t.slice(m.index + 1);
  }
  return { index, indent, key, rawValue: rest.trim() };
}

export interface YamlIssue {
  line: number;
  message: string;
}

export class YamlDocument {
  private lines: string[];
  private readonly eol: string;
  private readonly hadBom: boolean;

  private constructor(text: string) {
    this.hadBom = text.charCodeAt(0) === 0xfeff;
    const body = this.hadBom ? text.slice(1) : text;
    this.eol = body.includes('\r\n') ? '\r\n' : '\n';
    this.lines = body.length ? body.split(/\r?\n/) : [];
    while (this.lines.length && this.lines[this.lines.length - 1] === '') this.lines.pop();
  }

  static parse(text: string): YamlDocument {
    return new YamlDocument(text);
  }

  static empty(): YamlDocument {
    return new YamlDocument('');
  }

  /** End (exclusive) of the block that belongs to the key at `index` with `indent`. */
  private blockEnd(index: number, indent: number): number {
    let i = index + 1;
    let last = index;
    for (; i < this.lines.length; i++) {
      const l = this.lines[i];
      if (isIgnorable(l)) continue;
      const ind = indentOf(l);
      // yaml-cpp may emit sequence items at the same indent as their key.
      if (ind < indent || (ind === indent && !l.trimStart().startsWith('-'))) break;
      last = i;
    }
    return last + 1;
  }

  /** Direct child key lines within [start, end). */
  private children(start: number, end: number): KeyLine[] {
    let childIndent = -1;
    const out: KeyLine[] = [];
    for (let i = start; i < end; i++) {
      const l = this.lines[i];
      if (isIgnorable(l)) continue;
      const ind = indentOf(l);
      if (childIndent < 0) childIndent = ind;
      if (ind !== childIndent) continue;
      const k = parseKeyLine(l, i);
      if (k) out.push(k);
    }
    return out;
  }

  private find(path: string[]): KeyLine | null {
    let start = 0;
    let end = this.lines.length;
    let node: KeyLine | null = null;
    for (const seg of path) {
      node = this.children(start, end).find((c) => c.key === seg) ?? null;
      if (!node) return null;
      start = node.index + 1;
      end = this.blockEnd(node.index, node.indent);
    }
    return node;
  }

  has(path: string[]): boolean {
    return this.find(path) !== null;
  }

  /** Scalar value at `path`, or undefined when missing or not a scalar. */
  get(path: string[]): string | undefined {
    const n = this.find(path);
    if (!n) return undefined;
    if (n.rawValue === '') return this.blockEnd(n.index, n.indent) > n.index + 1 ? undefined : '';
    if (/^[[{|>&*!]/.test(n.rawValue)) return undefined;
    return decodeScalar(n.rawValue);
  }

  /** Top-level / nested keys directly below `path` (root when empty). */
  keys(path: string[] = []): string[] {
    if (!path.length) return this.children(0, this.lines.length).map((c) => c.key);
    const n = this.find(path);
    if (!n) return [];
    return this.children(n.index + 1, this.blockEnd(n.index, n.indent)).map((c) => c.key);
  }

  /** Sets a scalar, creating parent mappings as needed. Returns true when the file changed. */
  set(path: string[], value: string | number | boolean): boolean {
    if (!path.length) throw new Error('empty YAML path');
    const encoded = encodeScalar(value);
    const existing = this.find(path);
    if (existing) {
      const current = this.get(path);
      if (current === String(value)) return false;
      const end = this.blockEnd(existing.index, existing.indent);
      this.lines.splice(existing.index, end - existing.index, `${' '.repeat(existing.indent)}${encodeKey(path[path.length - 1])}: ${encoded}`);
      return true;
    }
    // Find the deepest existing ancestor.
    let depth = path.length - 1;
    let parent: KeyLine | null = null;
    while (depth > 0) {
      parent = this.find(path.slice(0, depth));
      if (parent) break;
      depth--;
    }
    let insertAt: number;
    let indent: number;
    if (parent) {
      const end = this.blockEnd(parent.index, parent.indent);
      const kids = this.children(parent.index + 1, end);
      if (parent.rawValue !== '') {
        // Parent was a scalar / flow value ("{}"): turn it into a block mapping.
        this.lines[parent.index] = `${' '.repeat(parent.indent)}${encodeKey(path[depth - 1])}:`;
        parent = { ...parent, rawValue: '' };
      }
      indent = kids.length ? kids[0].indent : parent.indent + 2;
      insertAt = end;
    } else {
      depth = 0;
      const top = this.children(0, this.lines.length);
      indent = top.length ? top[0].indent : 0;
      insertAt = this.lines.length;
    }
    const added: string[] = [];
    for (let i = depth; i < path.length; i++) {
      const pad = ' '.repeat(indent + (i - depth) * 2);
      added.push(i === path.length - 1 ? `${pad}${encodeKey(path[i])}: ${encoded}` : `${pad}${encodeKey(path[i])}:`);
    }
    this.lines.splice(insertAt, 0, ...added);
    return true;
  }

  delete(path: string[]): boolean {
    const n = this.find(path);
    if (!n) return false;
    this.lines.splice(n.index, this.blockEnd(n.index, n.indent) - n.index);
    return true;
  }

  /** Structural problems that would make yaml-cpp reject the file (best effort). */
  validate(): YamlIssue[] {
    const issues: YamlIssue[] = [];
    const stack: number[] = [-1];
    let expectChild = false;
    for (let i = 0; i < this.lines.length; i++) {
      const l = this.lines[i];
      if (l.includes('\u0000')) {
        issues.push({ line: i + 1, message: 'File contains NUL bytes (likely corrupted by a crash during write)' });
        break;
      }
      if (isIgnorable(l)) continue;
      if (/^[ ]*\t/.test(l)) {
        issues.push({ line: i + 1, message: 'Tab characters are not allowed for YAML indentation' });
        continue;
      }
      const ind = indentOf(l);
      const t = l.trim();
      if (expectChild) {
        if (ind > stack[stack.length - 1]) stack.push(ind);
        expectChild = false;
      }
      while (stack.length > 1 && ind < stack[stack.length - 1]) stack.pop();
      if (ind > stack[stack.length - 1] && stack[stack.length - 1] >= 0 && !t.startsWith('-')) {
        issues.push({ line: i + 1, message: 'Unexpected indentation' });
        continue;
      }
      if (stack.length === 1 && stack[0] === -1) stack[0] = ind;
      if (t.startsWith('-')) continue;
      const k = parseKeyLine(l, i);
      if (!k) {
        issues.push({ line: i + 1, message: `Expected "key: value", found "${t.slice(0, 60)}"` });
        continue;
      }
      const v = k.rawValue;
      if ((v.startsWith('"') && !/^"((?:[^"\\]|\\.)*)"\s*(#.*)?$/.test(v)) || (v.startsWith("'") && !/^'((?:[^']|'')*)'\s*(#.*)?$/.test(v))) {
        issues.push({ line: i + 1, message: 'Unterminated quoted value (file may be truncated)' });
      }
      if (v.startsWith('[') && !v.includes(']')) issues.push({ line: i + 1, message: 'Unterminated [list] (file may be truncated)' });
      if (v.startsWith('{') && !v.includes('}')) issues.push({ line: i + 1, message: 'Unterminated {map} (file may be truncated)' });
      if (v === '') expectChild = true;
    }
    return issues;
  }

  toString(): string {
    const body = this.lines.join(this.eol) + (this.lines.length ? this.eol : '');
    return (this.hadBom ? '﻿' : '') + body;
  }
}

export function checkYaml(text: string): { ok: boolean; issues: string[] } {
  const issues = YamlDocument.parse(text).validate().map((i) => `Line ${i.line}: ${i.message}`);
  return { ok: issues.length === 0, issues };
}
