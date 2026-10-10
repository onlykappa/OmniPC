// Validation helpers for emulator configuration formats.

import { readFile } from 'node:fs/promises';
import { IniDocument } from './ini';

export type ConfigFormat = 'ini' | 'json' | 'xml' | 'yaml' | 'other';

export interface FormatCheck {
  ok: boolean;
  issues: string[];
}

export function checkJson(text: string): FormatCheck {
  try {
    JSON.parse(text);
    return { ok: true, issues: [] };
  } catch (e) {
    return { ok: false, issues: [(e as Error).message] };
  }
}

/**
 * Lightweight well-formedness check for XML (tag balance, single root). It is
 * not a full validator but catches truncated / half-written files, which is the
 * failure mode that matters for emulator configs.
 */
export function checkXml(text: string): FormatCheck {
  const issues: string[] = [];
  const stripped = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<\?[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[^>]*>/gi, '');
  const stack: string[] = [];
  let roots = 0;
  const re = /<(\/?)([A-Za-z_][\w.\-:]*)([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) {
    const [, closing, name, , selfClosing] = m;
    if (closing) {
      const top = stack.pop();
      if (top !== name) {
        issues.push(`Unexpected closing tag </${name}>${top ? ` (expected </${top}>)` : ''}`);
        break;
      }
    } else if (!selfClosing) {
      if (stack.length === 0) roots++;
      stack.push(name);
    } else if (stack.length === 0) roots++;
  }
  if (stack.length) issues.push(`Unclosed tag <${stack[stack.length - 1]}> (file may be truncated)`);
  if (roots > 1) issues.push('More than one root element');
  if (roots === 0 && stripped.trim()) issues.push('No root element');
  return { ok: issues.length === 0, issues };
}

export function checkIni(text: string): FormatCheck {
  if (text.includes('\u0000')) return { ok: false, issues: ['File contains NUL bytes (likely corrupted by a crash during write)'] };
  const issues = IniDocument.parse(text).validate().map((i) => `Line ${i.line}: ${i.message}`);
  return { ok: issues.length === 0, issues };
}

export async function checkConfigFile(path: string, format: ConfigFormat): Promise<FormatCheck> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    return { ok: false, issues: [(e as Error).message] };
  }
  switch (format) {
    case 'ini': return checkIni(text);
    case 'json': return checkJson(text);
    case 'xml': return checkXml(text);
    default: return { ok: true, issues: [] };
  }
}
