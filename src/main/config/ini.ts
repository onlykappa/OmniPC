// Order- and comment-preserving INI document. Emulators (PCSX2, Dolphin) use
// INI; OmniDeck must change individual keys without destroying the user's other
// settings, comments or ordering.

export type IniLine =
  | { kind: 'blank'; raw: string }
  | { kind: 'comment'; raw: string }
  | { kind: 'section'; name: string; raw: string }
  | { kind: 'entry'; key: string; value: string; raw: string; sep: string }
  | { kind: 'invalid'; raw: string };

export interface IniIssue {
  line: number;
  message: string;
  text: string;
}

export class IniDocument {
  private lines: IniLine[] = [];
  readonly eol: string;
  readonly hadBom: boolean;

  private constructor(lines: IniLine[], eol: string, hadBom: boolean) {
    this.lines = lines;
    this.eol = eol;
    this.hadBom = hadBom;
  }

  static parse(text: string): IniDocument {
    const hadBom = text.charCodeAt(0) === 0xfeff;
    if (hadBom) text = text.slice(1);
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const raw = text.split(/\r?\n/);
    if (raw.length && raw[raw.length - 1] === '') raw.pop();
    const lines: IniLine[] = raw.map((r) => {
      const t = r.trim();
      if (t === '') return { kind: 'blank', raw: r };
      if (t.startsWith(';') || t.startsWith('#')) return { kind: 'comment', raw: r };
      const sec = /^\[(.*)\]\s*$/.exec(t);
      if (sec) return { kind: 'section', name: sec[1], raw: r };
      const eq = r.indexOf('=');
      if (eq > 0) {
        const key = r.slice(0, eq).trim();
        const value = r.slice(eq + 1).trim();
        const sep = /\s=\s/.test(r.slice(Math.max(0, eq - 1), eq + 2)) ? ' = ' : '=';
        if (key) return { kind: 'entry', key, value, raw: r, sep };
      }
      return { kind: 'invalid', raw: r };
    });
    return new IniDocument(lines, eol, hadBom);
  }

  static empty(eol = '\r\n'): IniDocument {
    return new IniDocument([], eol, false);
  }

  /** Lines that are neither sections, entries, comments nor blank. */
  validate(): IniIssue[] {
    const issues: IniIssue[] = [];
    const seen = new Map<string, number>();
    let section = '';
    this.lines.forEach((l, i) => {
      if (l.kind === 'invalid') issues.push({ line: i + 1, message: 'Line is not a valid "key = value" entry or [section] header', text: l.raw });
      if (l.kind === 'section') {
        section = l.name;
        const k = section.toLowerCase();
        if (seen.has(k)) issues.push({ line: i + 1, message: `Section [${section}] is declared twice (first on line ${seen.get(k)})`, text: l.raw });
        else seen.set(k, i + 1);
      }
      if (l.kind === 'entry' && !section && this.lines.some((x) => x.kind === 'section')) {
        issues.push({ line: i + 1, message: 'Entry appears before any [section] header', text: l.raw });
      }
    });
    return issues;
  }

  sections(): string[] {
    return this.lines.filter((l): l is Extract<IniLine, { kind: 'section' }> => l.kind === 'section').map((l) => l.name);
  }

  hasSection(section: string): boolean {
    return this.findSection(section) !== -1;
  }

  private findSection(section: string): number {
    const s = section.toLowerCase();
    return this.lines.findIndex((l) => l.kind === 'section' && l.name.toLowerCase() === s);
  }

  private sectionEnd(start: number): number {
    let i = start + 1;
    while (i < this.lines.length && this.lines[i].kind !== 'section') i++;
    return i;
  }

  private findEntry(section: string, key: string): number {
    const start = this.findSection(section);
    if (start === -1) return -1;
    const end = this.sectionEnd(start);
    const k = key.toLowerCase();
    for (let i = start + 1; i < end; i++) {
      const l = this.lines[i];
      if (l.kind === 'entry' && l.key.toLowerCase() === k) return i;
    }
    return -1;
  }

  get(section: string, key: string): string | undefined {
    const i = this.findEntry(section, key);
    return i === -1 ? undefined : (this.lines[i] as Extract<IniLine, { kind: 'entry' }>).value;
  }

  entries(section: string): Record<string, string> {
    const start = this.findSection(section);
    if (start === -1) return {};
    const out: Record<string, string> = {};
    for (let i = start + 1; i < this.sectionEnd(start); i++) {
      const l = this.lines[i];
      if (l.kind === 'entry') out[l.key] = l.value;
    }
    return out;
  }

  /** Sets a value, creating the section/key if needed. Returns true when the document changed. */
  set(section: string, key: string, value: string | number | boolean): boolean {
    const v = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
    const i = this.findEntry(section, key);
    if (i !== -1) {
      const l = this.lines[i] as Extract<IniLine, { kind: 'entry' }>;
      if (l.value === v) return false;
      this.lines[i] = { kind: 'entry', key: l.key, value: v, sep: l.sep, raw: `${l.key}${l.sep}${v}` };
      return true;
    }
    let start = this.findSection(section);
    if (start === -1) {
      if (this.lines.length && this.lines[this.lines.length - 1].kind !== 'blank') this.lines.push({ kind: 'blank', raw: '' });
      this.lines.push({ kind: 'section', name: section, raw: `[${section}]` });
      start = this.lines.length - 1;
    }
    let insertAt = this.sectionEnd(start);
    while (insertAt - 1 > start && this.lines[insertAt - 1].kind === 'blank') insertAt--;
    const sep = this.dominantSeparator();
    this.lines.splice(insertAt, 0, { kind: 'entry', key, value: v, sep, raw: `${key}${sep}${v}` });
    return true;
  }

  delete(section: string, key: string): boolean {
    const i = this.findEntry(section, key);
    if (i === -1) return false;
    this.lines.splice(i, 1);
    return true;
  }

  /** Removes lines that cannot be parsed and merges duplicate sections. Returns what was changed. */
  repair(): string[] {
    const changes: string[] = [];
    const kept: IniLine[] = [];
    for (const l of this.lines) {
      if (l.kind === 'invalid') {
        changes.push(`Removed unparseable line: ${l.raw.slice(0, 80)}`);
        continue;
      }
      kept.push(l);
    }
    this.lines = kept;
    // merge duplicate sections into the first occurrence
    const firstIndex = new Map<string, number>();
    for (let i = 0; i < this.lines.length; i++) {
      const l = this.lines[i];
      if (l.kind !== 'section') continue;
      const k = l.name.toLowerCase();
      if (!firstIndex.has(k)) {
        firstIndex.set(k, i);
        continue;
      }
      const end = this.sectionEnd(i);
      const body = this.lines.slice(i + 1, end).filter((x) => x.kind === 'entry') as Extract<IniLine, { kind: 'entry' }>[];
      this.lines.splice(i, end - i);
      for (const e of body) this.set(l.name, e.key, e.value);
      changes.push(`Merged duplicate section [${l.name}]`);
      i--;
    }
    return changes;
  }

  private dominantSeparator(): string {
    let spaced = 0;
    let tight = 0;
    for (const l of this.lines) if (l.kind === 'entry') (l.sep === ' = ' ? spaced++ : tight++);
    return spaced >= tight ? ' = ' : '=';
  }

  toString(): string {
    const body = this.lines.map((l) => l.raw).join(this.eol) + (this.lines.length ? this.eol : '');
    return (this.hadBom ? '﻿' : '') + body;
  }
}
