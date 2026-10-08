// Log access helpers: reading the part of an emulator log written during a
// specific launch, and redacting personal paths.

import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';

export async function fileSize(path: string): Promise<number | null> {
  try { return (await stat(path)).size; } catch { return null; }
}

/** Reads text appended after `offset` (or the tail if the log was truncated/rotated). */
export async function readLogSince(path: string, offset: number | null, maxBytes = 256 * 1024): Promise<string | null> {
  let size: number;
  try { size = (await stat(path)).size; } catch { return null; }
  let start = offset !== null && offset <= size ? offset : Math.max(0, size - maxBytes);
  if (size - start > maxBytes) start = size - maxBytes;
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

export async function readLogTail(path: string, maxBytes = 64 * 1024): Promise<string | null> {
  return readLogSince(path, null, maxBytes);
}

/** Picks the most relevant lines (errors/warnings) for display. */
export function excerpt(text: string, maxLines = 40): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const important = lines.filter((l) => /error|fail|fatal|panic|unable|cannot|could not|exception|warning|missing|not found/i.test(l));
  const picked = important.length ? important.slice(-maxLines) : lines.slice(-maxLines);
  return picked.join('\n');
}

/** Replaces the user's home folder and user name in text sent outside OmniDeck. */
export function redactPaths(text: string, extra: string[] = []): { text: string; redactions: string[] } {
  const redactions: string[] = [];
  let out = text;
  const home = homedir();
  const user = home.split(/[\\/]/).pop() ?? '';
  for (const [needle, repl] of [[home, '%USERPROFILE%'], ...extra.map((e) => [e, '<redacted>'])] as [string, string][]) {
    if (!needle) continue;
    const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    if (re.test(out)) {
      out = out.replace(re, repl);
      redactions.push(`${repl === '%USERPROFILE%' ? 'Home folder path' : 'Value'} replaced with ${repl}`);
    }
  }
  if (user.length > 2) {
    const re = new RegExp(`\\b${user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    if (re.test(out)) {
      out = out.replace(re, '<user>');
      redactions.push('Windows user name replaced with <user>');
    }
  }
  return { text: out, redactions };
}
