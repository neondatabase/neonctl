/**
 * Async multiplexer for NOTICE / NOTIFY (WP-02).
 *
 * `PgConnection` keeps a single NoticeMultiplexer that all incoming
 * NoticeResponse and NotificationResponse messages flow through. Subscribers
 * (e.g. the REPL, query runner, an external observer) register handlers and
 * receive a disposer function — the same shape upstream pg uses.
 *
 * We don't use Node's `EventEmitter` because:
 *   - The Connection interface (frozen WP-00) returns disposers from
 *     `onNotice` / `onNotification`, not subscription objects.
 *   - We want exceptions in one handler to be isolated from the rest.
 */

import type { Notice } from '../types/connection.js';

export type NoticeHandler = (notice: Notice) => void;
export type NotificationHandler = (
  channel: string,
  payload: string,
  pid: number,
) => void;

export class NoticeMultiplexer {
  private readonly noticeHandlers = new Set<NoticeHandler>();
  private readonly notificationHandlers = new Set<NotificationHandler>();

  /** Subscribe to NoticeResponse. Returns a disposer. */
  public onNotice(handler: NoticeHandler): () => void {
    this.noticeHandlers.add(handler);
    return () => this.noticeHandlers.delete(handler);
  }

  /** Subscribe to NotificationResponse (LISTEN/NOTIFY). Returns a disposer. */
  public onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  public emit(notice: Notice): void {
    for (const h of this.noticeHandlers) {
      // Isolate handler failures: one bad subscriber must not break the
      // whole connection. We swallow + record via `lastHandlerError` so a
      // test can observe it without us pulling in a logger.
      try {
        h(notice);
      } catch (err) {
        this.lastHandlerError = err;
      }
    }
  }

  public emitNotification(channel: string, payload: string, pid: number): void {
    for (const h of this.notificationHandlers) {
      try {
        h(channel, payload, pid);
      } catch (err) {
        this.lastHandlerError = err;
      }
    }
  }

  /** Last error thrown by a handler. Exposed for diagnostics / tests. */
  public lastHandlerError: unknown = undefined;

  /** Drop every subscriber. Called by Connection.close(). */
  public clear(): void {
    this.noticeHandlers.clear();
    this.notificationHandlers.clear();
  }
}
