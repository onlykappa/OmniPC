// Application logger. Writes JSON-lines-free human readable logs with rotation
// (omnideck.log -> omnideck.1.log ...), keeps an in-memory ring buffer for the
// UI/dev panel, and never throws (logging must not crash the app).

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogEntry {
  at: string;
  level: LogLevel;
  scope: string;
  message: string;
  data?: unknown;
}

export class Logger {
  private ring: LogEntry[] = [];
  private file: string | null = null;
  private minLevel: LogLevel = 'info';
  private readonly maxBytes = 5 * 1024 * 1024;
  private readonly keep = 5;
  private listeners = new Set<(e: LogEntry) => void>();

  configure(opts: { dir?: string; level?: LogLevel }): void {
    if (opts.level) this.minLevel = opts.level;
    if (opts.dir) {
      try {
        mkdirSync(opts.dir, { recursive: true });
        this.file = join(opts.dir, 'omnideck.log');
      } catch {
        this.file = null;
      }
    }
  }

  get filePath(): string | null {
    return this.file;
  }

  scope(scope: string): ScopedLogger {
    return new ScopedLogger(this, scope);
  }

  onEntry(fn: (e: LogEntry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  recent(n = 200): LogEntry[] {
    return this.ring.slice(-n);
  }

  tail(lines: number): string {
    if (!this.file || !existsSync(this.file)) return this.ring.slice(-lines).map(format).join('\n');
    try {
      const text = readFileSync(this.file, 'utf8');
      return text.split(/\r?\n/).slice(-lines - 1).join('\n');
    } catch {
      return '';
    }
  }

  write(level: LogLevel, scope: string, message: string, data?: unknown): void {
    const entry: LogEntry = { at: new Date().toISOString(), level, scope, message, data: sanitize(data) };
    this.ring.push(entry);
    if (this.ring.length > 1000) this.ring.splice(0, this.ring.length - 1000);
    for (const l of this.listeners) {
      try { l(entry); } catch { /* ignore */ }
    }
    if (ORDER[level] < ORDER[this.minLevel]) return;
    if (process.env.OMNIDECK_LOG_STDOUT === '1') console.log(format(entry));
    if (!this.file) return;
    try {
      this.rotateIfNeeded();
      appendFileSync(this.file, format(entry) + '\n');
    } catch {
      /* disk full / permissions: keep running */
    }
  }

  private rotateIfNeeded(): void {
    if (!this.file || !existsSync(this.file)) return;
    if (statSync(this.file).size < this.maxBytes) return;
    for (let i = this.keep - 1; i >= 1; i--) {
      const from = this.file.replace(/\.log$/, `.${i}.log`);
      const to = this.file.replace(/\.log$/, `.${i + 1}.log`);
      if (existsSync(from)) renameSync(from, to);
    }
    renameSync(this.file, this.file.replace(/\.log$/, '.1.log'));
  }
}

function format(e: LogEntry): string {
  const data = e.data === undefined ? '' : ' ' + safeJson(e.data);
  return `${e.at} [${e.level.toUpperCase()}] ${e.scope}: ${e.message}${data}`;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function sanitize(data: unknown): unknown {
  if (data instanceof Error) return { name: data.name, message: data.message, stack: data.stack?.split('\n').slice(0, 6).join('\n') };
  return data;
}

export class ScopedLogger {
  constructor(private readonly root: Logger, private readonly name: string) {}
  debug(msg: string, data?: unknown): void { this.root.write('debug', this.name, msg, data); }
  info(msg: string, data?: unknown): void { this.root.write('info', this.name, msg, data); }
  warn(msg: string, data?: unknown): void { this.root.write('warn', this.name, msg, data); }
  error(msg: string, data?: unknown): void { this.root.write('error', this.name, msg, data); }
}

export const logger = new Logger();
