import { describe, it, expect } from 'vitest';
import { normalizeDomainPath } from '../src/config.js';
import { buildApp } from '../src/app.js';

describe('Subpath UI and normalizeDomainPath', () => {
  it('normalizes DOMAIN_PATH correctly', () => {
    expect(normalizeDomainPath(undefined)).toBe('');
    expect(normalizeDomainPath('')).toBe('');
    expect(normalizeDomainPath('/')).toBe('');
    expect(normalizeDomainPath('/kuvarasto')).toBe('/kuvarasto');
    expect(normalizeDomainPath('/kuvarasto/')).toBe('/kuvarasto');
    expect(normalizeDomainPath(undefined, 'https://kehitys.riihimaenseurakunta.fi/kuvarasto')).toBe('/kuvarasto');
    expect(normalizeDomainPath(undefined, 'https://kehitys.riihimaenseurakunta.fi/kuvarasto/')).toBe('/kuvarasto');
    expect(normalizeDomainPath(undefined, 'http://localhost:3000')).toBe('');
    expect(normalizeDomainPath(undefined, 'http://localhost:3000/')).toBe('');
  });

  it('serves index.html with injected base tag for subpath', async () => {
    const app = buildApp({
      config: {
        port: 3000,
        host: '0.0.0.0',
        nodeEnv: 'development',
        baseUrl: 'https://kehitys.riihimaenseurakunta.fi/kuvarasto',
        domainPath: '/kuvarasto',
        databaseUrl: 'postgres://localhost/dummy',
        s3Endpoint: 'http://localhost:9000',
        s3Region: 'us-east-1',
        s3Bucket: 'test',
        s3AccessKeyId: 'test',
        s3SecretAccessKey: 'test',
        s3ForcePathStyle: true,
        sessionSecret: '0123456789012345678901234567890123456789',
        imageMaxUploadBytes: 1000,
        imageMaxPixels: 1000,
        defaultDeletionRetentionHours: 72,
        signedUrlTtlSeconds: 3600,
        retentionWorkerIntervalSeconds: 60,
        enableRetentionWorker: false,
        outboxDispatcherIntervalMs: 2000,
        enableOutboxDispatcher: false,
        oidcClientId: 'kuvarasto',
      },
      sessionService: {} as any,
      oidcService: {} as any,
      storageService: {} as any,
      processor: {} as any,
      groupService: {} as any,
      imageService: {} as any,
      subscriptionManager: {} as any,
      outboxDispatcher: {} as any,
      retentionWorker: {} as any,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<base data-app-base href="/kuvarasto/" />');

    // SPA fallback also serves injected HTML
    const spaRes = await app.inject({
      method: 'GET',
      url: '/some-spa-route',
    });
    expect(spaRes.statusCode).toBe(200);
    expect(spaRes.body).toContain('<base data-app-base href="/kuvarasto/" />');

    // Unknown API routes return 404 JSON, not HTML
    const apiRes = await app.inject({
      method: 'GET',
      url: '/v1/unknown-endpoint',
    });
    expect(apiRes.statusCode).toBe(404);
    expect(JSON.parse(apiRes.body)).toEqual({
      error: { code: 'NOT_FOUND', message: 'Not found' },
    });
  });
});
