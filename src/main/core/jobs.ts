// Background job manager. Long operations (installs, scans, health checks,
// relocations) run as jobs that report step-by-step progress, can be cancelled
// where practical and never block the UI thread.

import { randomUUID } from 'node:crypto';
import type { JobStatus } from '@shared/models';
import type { EventBus } from './events';
import { errorMessage, OmniFailure } from './errors';
import { logger } from './logger';

const log = logger.scope('jobs');

export class JobCancelled extends Error {
  constructor() {
    super('Cancelled by user');
    this.name = 'JobCancelled';
  }
}

export interface JobContext {
  readonly signal: AbortSignal;
  readonly id: string;
  /** Mark a named step as running; previous running step becomes done. */
  step(label: string, detail?: string): void;
  stepDone(detail?: string): void;
  stepFailed(detail: string): void;
  stepSkipped(label: string, detail: string): void;
  progress(fraction: number | null, message?: string): void;
  message(message: string): void;
  throwIfCancelled(): void;
}

export class JobManager {
  private jobs = new Map<string, JobStatus>();
  private controllers = new Map<string, AbortController>();
  private exclusive = new Map<string, Promise<unknown>>();

  constructor(private readonly bus: EventBus) {}

  list(): JobStatus[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 50);
  }

  get(id: string): JobStatus | undefined {
    return this.jobs.get(id);
  }

  cancel(id: string): void {
    const job = this.jobs.get(id);
    if (!job || !job.cancellable) return;
    this.controllers.get(id)?.abort();
  }

  /** Waits until a job finishes (used by tests and chained flows). */
  async wait(id: string): Promise<JobStatus> {
    for (;;) {
      const j = this.jobs.get(id);
      if (!j) throw new Error(`unknown job ${id}`);
      if (j.state !== 'queued' && j.state !== 'running') return j;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /**
   * Starts a job. `lockKey` serialises jobs touching the same resource
   * (e.g. two installs of the same emulator never run concurrently).
   */
  start<T>(kind: string, label: string, run: (ctx: JobContext) => Promise<T>, opts: { cancellable?: boolean; lockKey?: string } = {}): { id: string; done: Promise<T> } {
    const id = randomUUID();
    const controller = new AbortController();
    const status: JobStatus = {
      id,
      kind,
      label,
      state: 'queued',
      progress: null,
      message: 'Queued',
      steps: [],
      cancellable: opts.cancellable ?? true,
      startedAt: new Date().toISOString(),
      endedAt: null,
      error: null,
    };
    this.jobs.set(id, status);
    this.controllers.set(id, controller);
    this.publish(status);

    const ctx: JobContext = {
      id,
      signal: controller.signal,
      step: (l, detail) => {
        for (const s of status.steps) if (s.state === 'running') s.state = 'done';
        status.steps.push({ label: l, state: 'running', detail });
        status.message = l;
        this.publish(status);
      },
      stepDone: (detail) => {
        const s = [...status.steps].reverse().find((x) => x.state === 'running');
        if (s) {
          s.state = 'done';
          if (detail) s.detail = detail;
        }
        this.publish(status);
      },
      stepFailed: (detail) => {
        const s = [...status.steps].reverse().find((x) => x.state === 'running');
        if (s) {
          s.state = 'failed';
          s.detail = detail;
        }
        this.publish(status);
      },
      stepSkipped: (l, detail) => {
        status.steps.push({ label: l, state: 'skipped', detail });
        this.publish(status);
      },
      progress: (fraction, message) => {
        status.progress = fraction;
        if (message) status.message = message;
        this.publish(status, true);
      },
      message: (m) => {
        status.message = m;
        this.publish(status, true);
      },
      throwIfCancelled: () => {
        if (controller.signal.aborted) throw new JobCancelled();
      },
    };

    const previous = opts.lockKey ? this.exclusive.get(opts.lockKey) ?? Promise.resolve() : Promise.resolve();
    const done = previous
      .catch(() => undefined)
      .then(async () => {
        status.state = 'running';
        status.message = 'Starting';
        this.publish(status);
        log.info(`job started: ${label}`, { id, kind });
        try {
          const result = await run(ctx);
          for (const s of status.steps) if (s.state === 'running') s.state = 'done';
          status.state = 'succeeded';
          status.progress = 1;
          status.message = 'Completed';
          return result;
        } catch (err) {
          const cancelled = err instanceof JobCancelled || controller.signal.aborted;
          for (const s of status.steps) if (s.state === 'running') s.state = cancelled ? 'skipped' : 'failed';
          status.state = cancelled ? 'cancelled' : 'failed';
          status.error = cancelled ? 'Cancelled' : errorMessage(err);
          status.message = cancelled ? 'Cancelled' : status.error;
          if (err instanceof OmniFailure && err.detail.userAction.length) status.message += ` — ${err.detail.userAction[0]}`;
          log[cancelled ? 'info' : 'error'](`job ${cancelled ? 'cancelled' : 'failed'}: ${label}`, err);
          throw err;
        } finally {
          status.endedAt = new Date().toISOString();
          status.cancellable = false;
          this.controllers.delete(id);
          this.publish(status);
        }
      });
    if (opts.lockKey) this.exclusive.set(opts.lockKey, done.catch(() => undefined));
    done.catch(() => undefined); // failures are reported through status
    return { id, done };
  }

  private lastPublish = new Map<string, number>();
  private publish(status: JobStatus, throttle = false): void {
    const now = Date.now();
    if (throttle && now - (this.lastPublish.get(status.id) ?? 0) < 100) return;
    this.lastPublish.set(status.id, now);
    this.bus.emit('job.update', structuredClone(status));
  }
}
