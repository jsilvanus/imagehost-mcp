import { eq, isNull, asc } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import { eventOutbox } from '../db/schema.js';
import type { SubscriptionManager } from './subscription-manager.js';

export function getAffectedUris(event: {
  eventType: string;
  groupId?: string | null;
  imageId?: string | null;
}): string[] {
  const uris = new Set<string>();

  if (event.groupId) {
    uris.add(`photo://groups/${event.groupId}/images`);
    uris.add(`photo://groups/${event.groupId}`);
    uris.add('photo://groups');
    uris.add('photo://library');
  }

  if (event.imageId) {
    uris.add(`photo://images/${event.imageId}/metadata`);
    uris.add(`photo://images/${event.imageId}/thumbnail`);
    uris.add(`photo://images/${event.imageId}/preview`);
    uris.add(`photo://images/${event.imageId}/original`);
  }

  return Array.from(uris);
}

export class OutboxDispatcher {
  private timer?: NodeJS.Timeout;
  private isRunning = false;
  private db: typeof defaultDb;

  constructor(
    private subscriptionManager: SubscriptionManager,
    dbInstance?: typeof defaultDb,
  ) {
    this.db = dbInstance ?? defaultDb;
  }

  /**
   * Scans event_outbox for unpublished events (published_at IS NULL),
   * maps them to affected resource URIs, dispatches notifications,
   * and marks the events as published.
   */
  async dispatchPending(limit = 100): Promise<{ processed: number; notificationsSent: number }> {
    if (this.isRunning) {
      return { processed: 0, notificationsSent: 0 };
    }

    this.isRunning = true;
    let processed = 0;
    let notificationsSent = 0;

    try {
      const pendingEvents = await this.db
        .select()
        .from(eventOutbox)
        .where(isNull(eventOutbox.publishedAt))
        .orderBy(asc(eventOutbox.cursor))
        .limit(limit);

      for (const event of pendingEvents) {
        const uris = getAffectedUris({
          eventType: event.eventType,
          groupId: event.groupId,
          imageId: event.imageId,
        });

        for (const uri of uris) {
          const sent = await this.subscriptionManager.notifyResourceUpdated(event.ownerId, uri);
          notificationsSent += sent;
        }

        await this.db
          .update(eventOutbox)
          .set({ publishedAt: new Date() })
          .where(eq(eventOutbox.cursor, event.cursor));

        processed++;
      }
    } catch (err) {
      console.error('Error dispatching outbox events:', err);
    } finally {
      this.isRunning = false;
    }

    return { processed, notificationsSent };
  }

  /**
   * Starts periodic polling of the outbox.
   */
  start(intervalMs = 2000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.dispatchPending().catch((err) => {
        console.error('OutboxDispatcher background tick error:', err);
      });
    }, intervalMs);
  }

  /**
   * Stops periodic polling.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
