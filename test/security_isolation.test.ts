import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { SessionService } from '../src/auth/session.js';
import { MemoryAuthStore, DefaultUserStore } from '../src/oauth/storage.js';
import { issueAccessToken } from '../src/oauth/jwt.js';
import { SubscriptionManager } from '../src/services/subscription-manager.js';

describe('Security & Isolation', () => {
  let app: FastifyInstance;
  let base: string;
  const sessionSecret = '0123456789012345678901234567890123456789';
  const sessionService = new SessionService(sessionSecret);
  const jwtSecret = new TextEncoder().encode(sessionSecret);

  const mockGroups = new Map<string, any>();
  const mockImages = new Map<string, any>();
  const mockChanges: any[] = [];
  const mockDbProbe = vi.fn(async () => {});

  const mockGroupService: any = {
    groups: mockGroups,
    async listGroups(userId: string) {
      return Array.from(mockGroups.values()).filter((g: any) => g.ownerId === userId);
    },
    async createGroup(userId: string, data: any) {
      const id = 'grp-' + Math.random().toString(36).slice(2, 9);
      const group = {
        id,
        ownerId: userId,
        name: data.name,
        description: data.description ?? null,
        retentionHours: data.retentionHours ?? 72,
        status: 'active',
        nextSequenceNumber: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockGroups.set(id, group);
      return group;
    },
    async getGroup(userId: string, groupId: string) {
      const g = mockGroups.get(groupId);
      if (!g || g.ownerId !== userId) return null;
      return g;
    },
  };

  const mockImageService: any = {
    images: mockImages,
    async getImage(userId: string, imageId: string) {
      const img = mockImages.get(imageId);
      if (!img || img.ownerId !== userId) return null;
      return img;
    },
    async listGroupImages(userId: string, groupId: string) {
      const items = Array.from(mockImages.values()).filter(
        (img: any) => img.ownerId === userId && img.groupId === groupId,
      );
      return { items, nextCursor: null };
    },
    async requestDeletion(userId: string, imageId: string) {
      const img = await this.getImage(userId, imageId);
      if (!img) return null;
      img.deletionState = 'pending_deletion';
      return img;
    },
    async restoreImage(userId: string, imageId: string) {
      const img = await this.getImage(userId, imageId);
      if (!img) return null;
      img.deletionState = 'active';
      return img;
    },
    async getDownloadUrl(userId: string, imageId: string) {
      const img = await this.getImage(userId, imageId);
      if (!img) throw new Error('Image not found');
      return {
        imageId,
        variant: 'preview',
        url: 'https://s3.example.com/signed-url',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        expiresInSeconds: 3600,
        mediaType: 'image/webp',
        byteSize: 12345,
      };
    },
    async getChanges(userId: string, after = 0, limit = 100) {
      const userChanges = mockChanges.filter((c) => c.ownerId === userId && c.cursor > after);
      const page = userChanges.slice(0, limit);
      const lastCursor = page.length > 0 ? page[page.length - 1].cursor : after;
      return { changes: page, lastCursor };
    },
    async saveUploadContent(userId: string, imageId: string, content: Buffer, mediaType?: string) {
      const img = await this.getImage(userId, imageId);
      if (!img) throw new Error('Image not found');
      (img as any).content = content;
      (img as any).mediaType = mediaType;
    },
    async getVariantBuffer(userId: string, imageId: string, _variant: string) {
      const img = await this.getImage(userId, imageId);
      if (!img) throw new Error('Image not found');
      return {
        buffer: Buffer.from('fake-image-bytes'),
        mediaType: 'image/webp',
      };
    },
  };

  beforeAll(async () => {
    // Seed test data for User A
    const groupA = {
      id: 'grp-user-a',
      ownerId: 'user-a',
      name: 'User A Vacation',
      retentionHours: 72,
      status: 'active',
      nextSequenceNumber: 2,
    };
    mockGroups.set(groupA.id, groupA);

    const imageA = {
      id: 'img-user-a',
      groupId: groupA.id,
      ownerId: 'user-a',
      sequenceNumber: 1,
      originalFilename: 'beach.jpg',
      status: 'ready',
      deletionState: 'active',
    };
    mockImages.set(imageA.id, imageA);

    mockChanges.push(
      { cursor: 1, ownerId: 'user-a', eventType: 'group.created', groupId: groupA.id },
      { cursor: 2, ownerId: 'user-a', eventType: 'image.uploaded', imageId: imageA.id },
      { cursor: 3, ownerId: 'user-b', eventType: 'group.created', groupId: 'grp-user-b' },
    );

    app = buildApp({
      config: {
        nodeEnv: 'test',
        port: 0,
        host: '127.0.0.1',
        baseUrl: 'http://127.0.0.1',
        databaseUrl: '',
        s3Endpoint: '',
        s3Region: '',
        s3Bucket: '',
        s3AccessKeyId: '',
        s3SecretAccessKey: '',
        s3ForcePathStyle: true,
        oidcIssuerUrl: '',
        oidcClientId: '',
        sessionSecret,
        imageMaxUploadBytes: 1000000,
        imageMaxPixels: 1000000,
        defaultDeletionRetentionHours: 72,
        signedUrlTtlSeconds: 3600,
        retentionWorkerIntervalSeconds: 60,
        enableRetentionWorker: false,
        outboxDispatcherIntervalMs: 2000,
        enableOutboxDispatcher: false,
      },
      sessionService,
      oidcService: {} as any,
      storageService: {} as any,
      processor: {} as any,
      groupService: mockGroupService,
      imageService: mockImageService,
      subscriptionManager: new SubscriptionManager(),
      dbProbe: mockDbProbe,
      authStore: new MemoryAuthStore(),
      userStore: new DefaultUserStore(),
    });

    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    base = typeof address === 'string' ? address : `http://127.0.0.1:${address?.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('denies User B from accessing User A group', async () => {
    const sessionB = await sessionService.signSession({
      userId: 'user-b',
      oidcIssuer: 'https://issuer.test',
      oidcSub: 'sub-b',
    });

    const res = await fetch(`${base}/v1/groups/grp-user-a`, {
      headers: { cookie: `imagehost_session=${sessionB}` },
    });
    expect(res.status).toBe(404);
  });

  it('denies User B from accessing User A image metadata and download URL', async () => {
    const sessionB = await sessionService.signSession({
      userId: 'user-b',
      oidcIssuer: 'https://issuer.test',
      oidcSub: 'sub-b',
    });

    // Metadata
    const resMeta = await fetch(`${base}/v1/images/img-user-a`, {
      headers: { cookie: `imagehost_session=${sessionB}` },
    });
    expect(resMeta.status).toBe(404);

    // Download URL
    const resUrl = await fetch(`${base}/v1/images/img-user-a/download-url`, {
      headers: { cookie: `imagehost_session=${sessionB}` },
    });
    expect(resUrl.status).toBe(500); // ImageService throws 'Image not found'
  });

  it('denies User B from deleting User A image', async () => {
    const sessionB = await sessionService.signSession({
      userId: 'user-b',
      oidcIssuer: 'https://issuer.test',
      oidcSub: 'sub-b',
    });

    const res = await fetch(`${base}/v1/images/img-user-a/deletion`, {
      method: 'POST',
      headers: { cookie: `imagehost_session=${sessionB}` },
    });
    expect(res.status).toBe(404);
  });

  it('enforces OAuth scope bounds on MCP tools', async () => {
    // Token with ONLY images:read scope
    const readOnlyToken = await issueAccessToken(
      jwtSecret,
      'http://127.0.0.1',
      'http://127.0.0.1/mcp',
      'user-a',
      'client-1',
      'images:read',
    );

    // Call request_image_deletion tool (requires images:delete)
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${readOnlyToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'request_image_deletion',
          arguments: { image_id: 'img-user-a' },
        },
      }),
    });

    const text = await res.text();
    const data = text
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)));
    const message = data[0] ?? (text ? JSON.parse(text) : null);

    expect(message?.result?.isError).toBe(true);
    expect(message?.result?.content?.[0]?.text).toContain("requires 'images:delete'");
  });

  it('allows clients to catch up missed changes using monotonic cursor', async () => {
    const sessionA = await sessionService.signSession({
      userId: 'user-a',
      oidcIssuer: 'https://issuer.test',
      oidcSub: 'sub-a',
    });

    // First fetch from cursor 0
    const res1 = await fetch(`${base}/v1/changes?after=0`, {
      headers: { cookie: `imagehost_session=${sessionA}` },
    });
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as any;
    expect(body1.changes).toHaveLength(2); // user-a has 2 changes
    expect(body1.lastCursor).toBe(2);

    // Second fetch from cursor 2 (caught up)
    const res2 = await fetch(`${base}/v1/changes?after=2`, {
      headers: { cookie: `imagehost_session=${sessionA}` },
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as any;
    expect(body2.changes).toHaveLength(0);
    expect(body2.lastCursor).toBe(2);
  });

  it('healthz returns 200 when database probe succeeds', async () => {
    mockDbProbe.mockResolvedValueOnce(undefined);
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe('ok');
    expect(body.database).toBe('connected');
    expect(body.timestamp).toBeDefined();
  });

  it('healthz returns 503 when database probe fails', async () => {
    mockDbProbe.mockRejectedValueOnce(new Error('Connection refused: 5432'));
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as any;
    expect(body.status).toBe('degraded');
    expect(body.database).toBe('disconnected');
    expect(body.error).toContain('Connection refused');
  });

  it('allows content upload via signed upload token', async () => {
    const uploadToken = await sessionService.signUploadToken('user-a', 'img-user-a');
    const res = await fetch(
      `${base}/v1/uploads/img-user-a/content?token=${encodeURIComponent(uploadToken)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        body: Buffer.from('test-image-content'),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
  });

  it('rejects content upload with invalid token', async () => {
    const res = await fetch(`${base}/v1/uploads/img-user-a/content?token=invalid-token`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: Buffer.from('test-image-content'),
    });
    expect(res.status).toBe(401);
  });

  it('serves image content via signed download token', async () => {
    const downloadToken = await sessionService.signDownloadToken('user-a', 'img-user-a', 'preview');
    const res = await fetch(
      `${base}/v1/images/img-user-a/content?variant=preview&token=${encodeURIComponent(downloadToken)}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    const buf = await res.arrayBuffer();
    expect(Buffer.from(buf).toString()).toBe('fake-image-bytes');
  });

  it('rejects image content download with wrong variant in token', async () => {
    const downloadToken = await sessionService.signDownloadToken('user-a', 'img-user-a', 'preview');
    const res = await fetch(
      `${base}/v1/images/img-user-a/content?variant=original&token=${encodeURIComponent(downloadToken)}`,
    );
    expect(res.status).toBe(401);
  });

  it('accepts empty JSON body on POST without FST_ERR_CTP_EMPTY_JSON_BODY error', async () => {
    const res = await fetch(`${base}/v1/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
  });
});
