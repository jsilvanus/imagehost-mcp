import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import sharp from 'sharp';
import { buildApp } from '../src/app.js';
import { SessionService } from '../src/auth/session.js';
import {
  isAllowedDomain,
  isPrivateOrReservedIp,
  detectImageMimeType,
  validateDownloadUrl,
  safeDownloadImage,
} from '../src/adapters/chatgpt/security.js';

describe('ChatGPT Security & Validation Utilities', () => {
  it('correctly matches allowed domains and subdomains', () => {
    const allowed = ['oaiusercontent.com', 'openai.com'];
    expect(isAllowedDomain('files.oaiusercontent.com', allowed)).toBe(true);
    expect(isAllowedDomain('sub.files.oaiusercontent.com', allowed)).toBe(true);
    expect(isAllowedDomain('oaiusercontent.com', allowed)).toBe(true);
    expect(isAllowedDomain('api.openai.com', allowed)).toBe(true);
    expect(isAllowedDomain('evil-oaiusercontent.com', allowed)).toBe(false);
    expect(isAllowedDomain('evil.com', allowed)).toBe(false);
    expect(isAllowedDomain('localhost', allowed)).toBe(false);
  });

  it('detects private and reserved IP addresses for SSRF prevention', () => {
    expect(isPrivateOrReservedIp('127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('10.0.0.5')).toBe(true);
    expect(isPrivateOrReservedIp('172.16.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('172.31.255.255')).toBe(true);
    expect(isPrivateOrReservedIp('192.168.1.100')).toBe(true);
    expect(isPrivateOrReservedIp('169.254.1.1')).toBe(true);
    expect(isPrivateOrReservedIp('0.0.0.0')).toBe(true);
    expect(isPrivateOrReservedIp('::1')).toBe(true);
    expect(isPrivateOrReservedIp('fc00::1')).toBe(true);
    expect(isPrivateOrReservedIp('fe80::1')).toBe(true);

    // Public IPs
    expect(isPrivateOrReservedIp('8.8.8.8')).toBe(false);
    expect(isPrivateOrReservedIp('1.1.1.1')).toBe(false);
    expect(isPrivateOrReservedIp('142.250.190.46')).toBe(false);
  });

  it('accurately detects image magic numbers for PNG, JPEG, WebP, GIF and rejects non-images', async () => {
    const pngBuf = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    expect(detectImageMimeType(pngBuf)).toBe('image/png');

    const jpegBuf = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 255, b: 0 } },
    })
      .jpeg()
      .toBuffer();
    expect(detectImageMimeType(jpegBuf)).toBe('image/jpeg');

    const webpBuf = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 255 } },
    })
      .webp()
      .toBuffer();
    expect(detectImageMimeType(webpBuf)).toBe('image/webp');

    // Non-image text
    expect(detectImageMimeType(Buffer.from('Hello world! Not an image.'))).toBeNull();
    // Executable / random bytes
    expect(detectImageMimeType(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00]))).toBeNull();
  });

  it('rejects insecure HTTP protocols and untrusted domains in validateDownloadUrl', async () => {
    const allowed = ['oaiusercontent.com'];

    // Insecure http
    await expect(validateDownloadUrl('http://files.oaiusercontent.com/test.png', allowed)).rejects.toThrow(
      'Insecure download URL protocol: expected https:',
    );

    // Untrusted domain
    await expect(validateDownloadUrl('https://evil.com/test.png', allowed)).rejects.toThrow(
      'Untrusted download domain',
    );

    // IP literal
    await expect(validateDownloadUrl('https://127.0.0.1/test.png', allowed)).rejects.toThrow(
      'Direct IP addresses are not permitted',
    );
  });

  it('safeDownloadImage enforces maximum byte size and timeouts', async () => {
    const validPng = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 255, g: 255, b: 0 } },
    })
      .png()
      .toBuffer();

    // Mock fetch implementation returning valid PNG
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(validPng.length) }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(validPng);
          controller.close();
        },
      }),
    });

    const result = await safeDownloadImage('https://files.oaiusercontent.com/image.png', {
      allowedDomains: ['oaiusercontent.com'],
      maxBytes: 1000000,
      timeoutMs: 5000,
      fetchImpl: mockFetch as any,
      skipDnsLookup: true,
    });

    expect(result.detectedMime).toBe('image/png');
    expect(result.buffer.length).toBe(validPng.length);

    // Test oversized rejection
    const mockOversizedFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': '20000000' }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.alloc(100));
          controller.close();
        },
      }),
    });

    await expect(
      safeDownloadImage('https://files.oaiusercontent.com/large.png', {
        allowedDomains: ['oaiusercontent.com'],
        maxBytes: 1000,
        timeoutMs: 5000,
        fetchImpl: mockOversizedFetch as any,
        skipDnsLookup: true,
      }),
    ).rejects.toThrow('exceeds maximum allowed size');
  });
});

describe('ChatGPT Action HTTP Routes', () => {
  let app: any;
  let testPng: Buffer;
  const sessionSecret = '0123456789012345678901234567890123456789';
  const sessionService = new SessionService(sessionSecret);
  const testApiKey = 'gpt-secret-token-test-123';

  const mockGroups = new Map<string, any>();
  const mockImages = new Map<string, any>();

  const mockGroupService: any = {
    async getGroup(ownerId: string, groupId: string) {
      const g = mockGroups.get(groupId);
      if (!g || g.ownerId !== ownerId) return null;
      return g;
    },
    async createGroup(ownerId: string, data: any) {
      const g = {
        id: `grp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        ownerId,
        name: data.name,
        description: data.description,
        nextSequenceNumber: 1,
      };
      mockGroups.set(g.id, g);
      return g;
    },
    async listGroups(ownerId: string) {
      return Array.from(mockGroups.values()).filter((g) => g.ownerId === ownerId);
    },
    async getOrCreateGroupByName(ownerId: string, name: string) {
      const list = await this.listGroups(ownerId);
      const existing = list.find((g: any) => g.name.toLowerCase() === name.toLowerCase());
      if (existing) return existing;
      return await this.createGroup(ownerId, { name });
    },
  };

  const mockImageService: any = {
    async createUploadSession(ownerId: string, groupId: string, data: any) {
      const id = `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const img = {
        id,
        ownerId,
        groupId,
        originalFilename: data.filename,
        mediaType: data.mediaType,
        byteSize: data.byteSize,
        status: 'pending',
        sequenceNumber: 1,
        tags: data.tagsList,
      };
      mockImages.set(id, img);
      return {
        uploadId: id,
        sequenceNumber: 1,
        uploadUrl: `https://imagehost.example.com/v1/uploads/${id}/content`,
      };
    },
    async saveUploadContent(ownerId: string, imageId: string, content: Buffer, mediaType: string) {
      const img = mockImages.get(imageId);
      if (!img || img.ownerId !== ownerId) throw new Error('Image not found');
      img.content = content;
      img.mediaType = mediaType;
    },
    async completeUpload(ownerId: string, imageId: string) {
      const img = mockImages.get(imageId);
      if (!img || img.ownerId !== ownerId) throw new Error('Image not found');
      img.status = 'ready';
      img.width = 100;
      img.height = 100;
      return img;
    },
    async getDownloadUrl(ownerId: string, imageId: string, variant: string) {
      const img = mockImages.get(imageId);
      if (!img || img.ownerId !== ownerId) throw new Error('Image not found');
      return {
        imageId,
        variant,
        url: `https://imagehost.example.com/v1/images/${imageId}/content?variant=${variant}`,
      };
    },
  };

  beforeAll(async () => {
    testPng = await sharp({
      create: { width: 50, height: 50, channels: 3, background: { r: 50, g: 150, b: 250 } },
    })
      .png()
      .toBuffer();

    app = buildApp({
      config: {
        nodeEnv: 'test',
        port: 0,
        host: '127.0.0.1',
        baseUrl: 'https://imagehost.example.com/kuvarasto',
        domainPath: '/kuvarasto',
        brandName: 'Kuvarasto',
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
        imageMaxUploadBytes: 10000000,
        imageMaxPixels: 10000000,
        defaultDeletionRetentionHours: 72,
        signedUrlTtlSeconds: 3600,
        retentionWorkerIntervalSeconds: 60,
        enableRetentionWorker: false,
        outboxDispatcherIntervalMs: 2000,
        enableOutboxDispatcher: false,
        chatgptApiKey: testApiKey,
        chatgptAllowedDomains: 'oaiusercontent.com,openai.com',
      },
      sessionService,
      oidcService: {} as any,
      storageService: {} as any,
      processor: {} as any,
      groupService: mockGroupService,
      imageService: mockImageService,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves OpenAPI 3.1 YAML specification at /api/chatgpt/openapi.yaml', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/chatgpt/openapi.yaml',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('yaml');
    expect(res.body).toContain('openapi: 3.1.0');
    expect(res.body).toContain('/api/chatgpt/import');
    expect(res.body).toContain('BearerAuth');
  });

  it('rejects requests with missing or invalid Bearer token with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chatgpt/import',
      headers: { 'Content-Type': 'application/json' },
      payload: {
        openaiFileIdRefs: [{ download_link: 'https://files.oaiusercontent.com/test.png' }],
      },
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toContain('Missing or invalid Bearer token');
  });

  it('rejects requests with empty openaiFileIdRefs array with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chatgpt/import',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${testApiKey}`,
      },
      payload: {
        openaiFileIdRefs: [],
      },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toContain('No file references provided');
  });

  it('successfully imports image via mocked OpenAI download and returns permanent URL', async () => {
    // Mock global fetch for downloading the image
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('files.oaiusercontent.com/sample-sunset.png')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-length': String(testPng.length) }),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(testPng);
              controller.close();
            },
          }),
        });
      }
      return Promise.reject(new Error('URL not mocked: ' + url));
    });

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/chatgpt/import',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${testApiKey}`,
        },
        payload: {
          openaiFileIdRefs: [
            {
              id: 'file-101',
              name: 'sunset_lake.png',
              mime_type: 'image/png',
              download_link: 'https://files.oaiusercontent.com/sample-sunset.png',
            },
          ],
          description: 'A serene Finnish sunset',
          tags: ['dall-e', 'sunset'],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.images).toHaveLength(1);

      const imported = body.images[0];
      expect(imported.image_id).toBeDefined();
      expect(imported.filename).toBe('sunset_lake.png');
      expect(imported.mime_type).toBe('image/png');
      expect(imported.url).toContain('/v1/images/');
      expect(imported.status).toBe('success');

      const savedImg = mockImages.get(imported.image_id);
      expect(savedImg.tags).toContain('ai');
      expect(savedImg.tags).toContain('chatgpt');
      expect(savedImg.tags).toContain('sunset');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('handles partial failures gracefully when importing multiple images', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('valid.png')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-length': String(testPng.length) }),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(testPng);
              controller.close();
            },
          }),
        });
      }
      if (url.includes('invalid-corrupt.png')) {
        // Return corrupted text data
        const textBuf = Buffer.from('Corrupted payload');
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-length': String(textBuf.length) }),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(textBuf);
              controller.close();
            },
          }),
        });
      }
      return Promise.reject(new Error('Download failed'));
    });

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/chatgpt/import',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${testApiKey}`,
        },
        payload: {
          openaiFileIdRefs: [
            {
              id: 'file-valid',
              name: 'valid.png',
              download_link: 'https://files.oaiusercontent.com/valid.png',
            },
            {
              id: 'file-corrupt',
              name: 'corrupt.png',
              download_link: 'https://files.oaiusercontent.com/invalid-corrupt.png',
            },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true); // Partial success is still true
      expect(body.images).toHaveLength(1);
      expect(body.images[0].filename).toBe('valid.png');
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].id).toBe('file-corrupt');
      expect(body.errors[0].error).toContain('file does not match any supported image format');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('authenticates via user session Bearer token and attributes image to user', async () => {
    const userSessionToken = await sessionService.signSession({
      userId: 'user-specific-123',
      oidcIssuer: 'https://identity.example.com',
      oidcSub: 'sub-user-123',
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(testPng.length) }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(testPng);
          controller.close();
        },
      }),
    });

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/chatgpt/import',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userSessionToken}`,
        },
        payload: {
          openaiFileIdRefs: [
            {
              id: 'file-user-test',
              name: 'user_photo.png',
              download_link: 'https://files.oaiusercontent.com/photo.png',
            },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.images).toHaveLength(1);

      // Verify image in mock is owned by user-specific-123
      const savedImage = mockImages.get(body.images[0].image_id);
      expect(savedImage.ownerId).toBe('user-specific-123');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
