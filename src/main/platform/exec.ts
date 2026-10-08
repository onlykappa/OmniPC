// Process execution without a shell. Arguments are passed as an array so file
// names with spaces/quotes can never be interpreted as commands.

import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error: NodeJS.ErrnoException | null;
}

export function runProcess(command: string, args: string[], opts: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv; input?: string; maxOutput?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const max = opts.maxOutput ?? 4 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let child;
    try {
      child = spawn(command, args, { cwd: opts.cwd, env: opts.env ?? process.env, windowsHide: true, shell: false });
    } catch (error) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, error: error as NodeJS.ErrnoException });
      return;
    }
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, opts.timeoutMs)
      : null;
    child.stdout?.on('data', (d: Buffer) => { if (stdout.length < max) stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { if (stderr.length < max) stderr += d.toString('utf8'); });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr, timedOut, error });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, error: null });
    });
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}
