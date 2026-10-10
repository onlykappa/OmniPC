import type { AppNotification } from '@shared/models';
import type { OpsRepo } from '../database/opsRepo';
import type { EventBus } from '../core/events';

/** Notification center with de-duplication to avoid notification spam. */
export class NotificationService {
  constructor(private readonly ops: OpsRepo, private readonly bus: EventBus) {}

  add(level: AppNotification['level'], title: string, body: string, opts: { link?: string; dedupeMs?: number } = {}): AppNotification | null {
    if (opts.dedupeMs && this.ops.recentNotificationExists(title, opts.dedupeMs)) return null;
    const n = this.ops.addNotification({ level, title, body, link: opts.link ?? null });
    this.bus.emit('notification', n);
    return n;
  }
}
