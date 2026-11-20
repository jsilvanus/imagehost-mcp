import { EventEmitter } from 'node:events';

export interface SubscriptionRecord {
  id: string;
  userId: string;
  uri: string;
  notify?: (uri: string) => Promise<void>;
  createdAt: Date;
}

export class SubscriptionManager {
  private subscriptions = new Map<string, SubscriptionRecord>();
  private userSubscriptions = new Map<string, Set<string>>(); // userId -> Set of subscription IDs
  private events = new EventEmitter();

  constructor() {
    this.events.setMaxListeners(100);
  }

  /**
   * Registers a subscription for a user and resource URI.
   * Returns a unique subscription ID.
   */
  subscribe(userId: string, uri: string, notify?: (uri: string) => Promise<void>): string {
    const id = `${userId}:${uri}:${Math.random().toString(36).slice(2, 10)}`;
    const record: SubscriptionRecord = {
      id,
      userId,
      uri,
      notify,
      createdAt: new Date(),
    };

    this.subscriptions.set(id, record);

    let userSet = this.userSubscriptions.get(userId);
    if (!userSet) {
      userSet = new Set<string>();
      this.userSubscriptions.set(userId, userSet);
    }
    userSet.add(id);

    return id;
  }

  /**
   * Unsubscribes a specific subscription by its ID.
   */
  unsubscribe(subscriptionId: string): boolean {
    const record = this.subscriptions.get(subscriptionId);
    if (!record) return false;

    this.subscriptions.delete(subscriptionId);
    const userSet = this.userSubscriptions.get(record.userId);
    if (userSet) {
      userSet.delete(subscriptionId);
      if (userSet.size === 0) {
        this.userSubscriptions.delete(record.userId);
      }
    }
    return true;
  }

  /**
   * Unsubscribes all subscriptions for a specific user and URI.
   */
  unsubscribeUri(userId: string, uri: string): number {
    const userSet = this.userSubscriptions.get(userId);
    if (!userSet) return 0;

    let removed = 0;
    for (const subId of Array.from(userSet)) {
      const record = this.subscriptions.get(subId);
      if (record && record.uri === uri) {
        this.unsubscribe(subId);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Checks if a user has an active subscription to a resource URI.
   */
  hasSubscription(userId: string, uri: string): boolean {
    const userSet = this.userSubscriptions.get(userId);
    if (!userSet) return false;

    for (const subId of userSet) {
      const record = this.subscriptions.get(subId);
      if (record && record.uri === uri) {
        return true;
      }
    }
    return false;
  }

  /**
   * Returns all active unique subscribed URIs for a user.
   */
  getSubscriptions(userId: string): string[] {
    const userSet = this.userSubscriptions.get(userId);
    if (!userSet) return [];

    const uris = new Set<string>();
    for (const subId of userSet) {
      const record = this.subscriptions.get(subId);
      if (record) {
        uris.add(record.uri);
      }
    }
    return Array.from(uris);
  }

  /**
   * Broadcasts resource-updated notification to all active subscribers for the given user & URI.
   */
  async notifyResourceUpdated(userId: string, uri: string): Promise<number> {
    this.events.emit('notification', { userId, uri });

    const userSet = this.userSubscriptions.get(userId);
    if (!userSet) return 0;

    let notifiedCount = 0;
    const notifyPromises: Promise<void>[] = [];

    for (const subId of userSet) {
      const record = this.subscriptions.get(subId);
      if (record && record.uri === uri && record.notify) {
        notifiedCount++;
        notifyPromises.push(
          record.notify(uri).catch((err) => {
            console.warn(`Error dispatching notification to subscriber ${subId}:`, err);
          }),
        );
      }
    }

    await Promise.all(notifyPromises);
    return notifiedCount;
  }

  /**
   * Attaches a listener for notifications (useful for tests and telemetry).
   */
  onNotification(listener: (data: { userId: string; uri: string }) => void): () => void {
    this.events.on('notification', listener);
    return () => this.events.off('notification', listener);
  }

  /**
   * Clears all subscriptions (e.g. for testing teardown).
   */
  clear(): void {
    this.subscriptions.clear();
    this.userSubscriptions.clear();
  }
}
