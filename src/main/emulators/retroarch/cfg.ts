// Order- and comment-preserving editor for RetroArch's config format
// (libretro-common/file/config_file.c): one `key = "value"` per line, no
// sections, `#` comments, `#include "file"` directives. Values are written
// quoted; RetroArch does not process escape sequences inside quotes, so
// Windows paths with backslashes are stored verbatim.

type CfgLine =
  | { kind: 'other'; raw: string }
  | { kind: 'entry'; key: string; value: string; raw: string }
  | { kind: 'invalid'; raw: string };

const ENTRY = /^\s*([^\s=#"]+)\s*=\s*(?:"([^"]*)"|([^\s#"]*))\s*(?:#.*)?$/;

export class CfgDocument {
  private constructor(private lines: CfgLine[], readonly eol: string) {}

  static parse(text: string): CfgDocument {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const raw = text.split(/\r?\n/);
    if (raw.length && raw[raw.length - 1] === '') raw.pop();
    return new CfgDocument(raw.map(parseLine), eol);
  }

  static empty(): CfgDocument {
    return new CfgDocument([], '\n');
  }

  get(key: string): string | undefined {
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const l = this.lines[i];
      if (l.kind === 'entry' && l.key === key) return l.value;
    }
    return undefined;
  }

  /** Sets a value; returns true when the document changed. */
  set(key: string, value: string | number | boolean): boolean {
    const v = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
    if (v.includes('"') || /[\r\n]/.test(v)) throw new Error(`RetroArch config values cannot contain quotes or newlines (${key})`);
    let found = false;
    let changed = false;
    for (let i = 0; i < this.lines.length; i++) {
      const l = this.lines[i];
      if (l.kind !== 'entry' || l.key !== key) continue;
      found = true;
      if (l.value !== v) {
        this.lines[i] = { kind: 'entry', key, value: v, raw: `${key} = "${v}"` };
        changed = true;
      }
    }
    if (!found) {
      this.lines.push({ kind: 'entry', key, value: v, raw: `${key} = "${v}"` });
      changed = true;
    }
    return changed;
  }

  delete(key: string): boolean {
    const before = this.lines.length;
    this.lines = this.lines.filter((l) => !(l.kind === 'entry' && l.key === key));
    return this.lines.length !== before;
  }

  keys(): string[] {
    return this.lines.filter((l): l is Extract<CfgLine, { kind: 'entry' }> => l.kind === 'entry').map((l) => l.key);
  }

  issues(): string[] {
    const out: string[] = [];
    this.lines.forEach((l, i) => {
      if (l.kind === 'invalid') out.push(`Line ${i + 1}: cannot parse "${l.raw.slice(0, 80)}"`);
    });
    return out;
  }

  toString(): string {
    return this.lines.map((l) => l.raw).join(this.eol) + (this.lines.length ? this.eol : '');
  }
}

function parseLine(raw: string): CfgLine {
  const t = raw.trim();
  if (t === '' || t.startsWith('#')) return { kind: 'other', raw };
  const m = ENTRY.exec(raw);
  if (m) return { kind: 'entry', key: m[1], value: m[2] ?? m[3] ?? '', raw };
  return { kind: 'invalid', raw };
}

export function checkCfg(text: string): { ok: boolean; issues: string[] } {
  if (text.includes('\u0000')) return { ok: false, issues: ['File contains NUL bytes (likely corrupted by a crash during write)'] };
  const issues = CfgDocument.parse(text).issues();
  return { ok: issues.length === 0, issues };
}
