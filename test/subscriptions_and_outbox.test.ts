import { describe, it, expect, vi } from 'vitest';
import { SubscriptionManager } from '../src/services/subscription-manager.js';
import { OutboxDispatcher, getAffectedUris } from '../src/services/outbox-dispatcher.js';
import { createMcpServer } from '../src/mcp/server.js';
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

describe('SubscriptionManager', () => {
  it('registers and tracks resource subscriptions per user', async () => {
    const sm = new SubscriptionManager();
    const userId = 'user-abc';
    const groupUri = 'photo://groups/grp-123/images';

    const subId = sm.subscribe(userId, groupUri);
    expect(subId).toBeDefined();
    expect(sm.hasSubscription(userId, groupUri)).toBe(true);
    expect(sm.getSubscriptions(userId)).toEqual([groupUri]);

    // Another user has no subscription
    expect(sm.hasSubscription('other-user', groupUri)).toBe(false);

    // Unsubscribe removes it
    const removed = sm.unsubscribe(subId);
    expect(removed).toBe(true);
    expect(sm.hasSubscription(userId, groupUri)).toBe(false);
  });

  it('broadcasts notifications only to targeted user subscribers', async () => {
    const sm = new SubscriptionManager();
    const userA = 'user-a';
    const userB = 'user-b';
    const uri = 'photo://images/img-456/metadata';

    const receivedA: string[] = [];
    const receivedB: string[] = [];

    sm.subscribe(userA, uri, async (u) => {
      receivedA.push(u);
    });
    sm.subscribe(userB, uri, async (u) => {
      receivedB.push(u);
    });

    const notifiedCount = await sm.notifyResourceUpdated(userA, uri);
    expect(notifiedCount).toBe(1);
    expect(receivedA).toEqual([uri]);
    expect(receivedB).toEqual([]); // userB not notified
  });

  it('allows unsubscribing by URI', () => {
    const sm = new SubscriptionManager();
    const userId = 'user-x';
    const uri = 'photo://groups';

    sm.subscribe(userId, uri);
    sm.subscribe(userId, uri);
    expect(sm.hasSubscription(userId, uri)).toBe(true);

    const count = sm.unsubscribeUri(userId, uri);
    expect(count).toBe(2);
    expect(sm.hasSubscription(userId, uri)).toBe(false);
  });
});

describe('OutboxDispatcher', () => {
  it('maps event to all affected resource URIs', () => {
    const uris = getAffectedUris({
      eventType: 'image.processing.completed',
      groupId: 'grp-99',
      imageId: 'img-88',
    });

    expect(uris).toContain('photo://groups/grp-99/images');
    expect(uris).toContain('photo://groups/grp-99');
    expect(uris).toContain('photo://groups');
    expect(uris).toContain('photo://library');
    expect(uris).toContain('photo://images/img-88/metadata');
    expect(uris).toContain('photo://images/img-88/thumbnail');
    expect(uris).toContain('photo://images/img-88/preview');
    expect(uris).toContain('photo://images/img-88/original');
  });

  it('dispatches unpublished outbox events and updates published_at timestamp', async () => {
    const sm = new SubscriptionManager();
    const userId = 'user-123';
    const groupId = 'grp-456';
    const uri = `photo://groups/${groupId}/images`;

    const receivedNotifications: string[] = [];
    sm.subscribe(userId, uri, async (notifiedUri) => {
      receivedNotifications.push(notifiedUri);
    });

    const sampleEvent = {
      cursor: 1,
      eventId: 'evt-1',
      eventType: 'image.uploaded',
      ownerId: userId,
      groupId,
      imageId: 'img-789',
      publishedAt: null,
      createdAt: new Date(),
    };

    const updatedEvents: any[] = [];
    let pendingEvents = [sampleEvent];

    const mockDb: any = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => pendingEvents,
            }),
          }),
        }),
      }),
      update: () => ({
        set: (data: any) => ({
          where: () => {
            updatedEvents.push(data);
            pendingEvents = []; // simulated mark published
            return Promise.resolve();
          },
        }),
      }),
    };

    const dispatcher = new OutboxDispatcher(sm, mockDb);
    const result = await dispatcher.dispatchPending();

    expect(result.processed).toBe(1);
    expect(result.notificationsSent).toBeGreaterThanOrEqual(1);
    expect(receivedNotifications).toContain(uri);
    expect(updatedEvents).toHaveLength(1);
    expect(updatedEvents[0].publishedAt).toBeInstanceOf(Date);

    // Second run should find 0 pending events
    const secondResult = await dispatcher.dispatchPending();
    expect(secondResult.processed).toBe(0);
  });
});

describe('MCP Subscriptions & Cursor Sync', () => {
  it('creates McpServer with resource subscription capability and handlers', async () => {
    const sm = new SubscriptionManager();
    const groupService: any = {
      getGroup: vi.fn(async (userId: string, groupId: string) => ({
        id: groupId,
        ownerId: userId,
        name: 'Test Group',
      })),
    };
    const imageService: any = {
      getImage: vi.fn(async (userId: string, imageId: string) => ({
        id: imageId,
        ownerId: userId,
        status: 'ready',
      })),
    };

    const server = createMcpServer({
      groupService,
      imageService,
      publicUrl: 'http://localhost:3000',
      subscriptionManager: sm,
    });

    expect(server).toBeDefined();

    // Verify capabilities
    const capabilities = server.server.getCapabilities();
    expect(capabilities.resources?.subscribe).toBe(true);

    // Test subscribing to group images resource
    const groupUri = 'photo://groups/grp-test/images';
    sm.subscribe('user-1', groupUri);
    expect(sm.hasSubscription('user-1', groupUri)).toBe(true);

    // Test unsubscribing
    sm.unsubscribeUri('user-1', groupUri);
    expect(sm.hasSubscription('user-1', groupUri)).toBe(false);
  });
});
