import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import sensible from '@fastify/sensible';
import fastifyStatic from '@fastify/static';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from './db/index.js';
import type { Config } from './config.js';
import { SessionService } from './auth/session.js';
import { OidcClientService } from './auth/oidc.js';
import { getOrCreateUser } from './auth/users.js';
import { S3StorageService } from './storage/s3.js';
import { ImageProcessor } from './services/image-processor.js';
import { GroupService } from './services/group-service.js';
import { ImageService } from './services/image-service.js';
import type { SubscriptionManager } from './services/subscription-manager.js';
import type { OutboxDispatcher } from './services/outbox-dispatcher.js';
import type { RetentionWorker } from './workers/retention-worker.js';
import { processBackchannelLogout } from './auth/backchannel.js';
import {
  mountOAuthMetadata,
  mountAuthorizationServer,
  MemoryAuthStore,
  DefaultUserStore,
  type AuthStore,
  type UserStore,
  type AuthorizationServerOptions,
} from './oauth/index.js';
import { mountMcpHttp } from './mcp/http.js';
import { registerChatGPTActionRoutes } from './adapters/chatgpt/routes.js';

export interface AppContext {
  config: Config;
  sessionService: SessionService;
  oidcService: OidcClientService;
  storageService: S3StorageService;
  processor: ImageProcessor;
  groupService: GroupService;
  imageService: ImageService;
  subscriptionManager?: SubscriptionManager;
  outboxDispatcher?: OutboxDispatcher;
  retentionWorker?: RetentionWorker;
  dbProbe?: () => Promise<void>;
  authStore?: AuthStore;
  userStore?: UserStore;
  authorizationOptions?: AuthorizationServerOptions;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      userId: string;
      oidcIssuer: string;
      oidcSub: string;
      email?: string;
      displayName?: string;
    };
  }
}

export function buildApp(ctx: AppContext): FastifyInstance {
  const isProd = ctx.config.nodeEnv === 'production';
  const isTest = ctx.config.nodeEnv === 'test';

  const app = Fastify({
    bodyLimit: ctx.config.imageMaxUploadBytes,
    requestIdHeader: 'x-request-id',
    genReqId: (req) => (req.headers['x-request-id'] as string) || randomUUID(),
    logger: isTest
      ? false
      : isProd
        ? {
            level: process.env.LOG_LEVEL || 'info',
            formatters: {
              level: (label) => ({ level: label }),
            },
          }
        : {
            level: process.env.LOG_LEVEL || 'info',
            transport: {
              target: 'pino-pretty',
              options: {
                translateTime: 'HH:MM:ss Z',
                ignore: 'pid,hostname',
              },
            },
          },
  });

  app.register(sensible);
  app.register(cors, {
    origin: true,
    credentials: true,
  });
  app.register(cookie, {
    secret: ctx.config.sessionSecret,
  });

  // Support URL-encoded forms for OAuth endpoints
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        const parsed = Object.fromEntries(new URLSearchParams(body as string));
        done(null, parsed);
      } catch (err: any) {
        done(err, undefined);
      }
    },
  );

  // Support JSON payloads, handling empty bodies gracefully
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      if (!body || (typeof body === 'string' && body.trim() === '')) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(body as string));
      } catch (err: any) {
        err.statusCode = 400;
        done(err, undefined);
      }
    },
  );

  // Support binary payloads for image uploads
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: ctx.config.imageMaxUploadBytes },
    (_req, body, done) => {
      done(null, body);
    },
  );
  app.addContentTypeParser(
    /^image\/.+/,
    { parseAs: 'buffer', bodyLimit: ctx.config.imageMaxUploadBytes },
    (_req, body, done) => {
      done(null, body);
    },
  );

  // Health check with DB probe
  app.get('/healthz', async (req, reply) => {
    try {
      if (ctx.dbProbe) {
        await ctx.dbProbe();
      } else {
        await db.execute(sql`SELECT 1`);
      }
      return reply.code(200).send({
        status: 'ok',
        database: 'connected',
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      req.log?.error?.(err, 'Healthcheck DB probe failed');
      return reply.code(503).send({
        status: 'degraded',
        database: 'disconnected',
        error: err.message || 'Database connection error',
        timestamp: new Date().toISOString(),
      });
    }
  });

  // OpenAPI spec
  app.get('/openapi.yaml', async (req, reply) => {
    const specPath = join(process.cwd(), 'docs', 'openapi.yaml');
    if (existsSync(specPath)) {
      reply.type('application/yaml').send(readFileSync(specPath, 'utf8'));
    } else {
      reply.notFound('OpenAPI specification not found');
    }
  });

  // Auth Decorator / Hook
  app.decorateRequest('user', undefined);
  app.addHook('preHandler', async (req) => {
    if (req.url.startsWith('/mcp')) {
      return;
    }

    const sessionCookie = req.cookies.imagehost_session;
    const authHeader = req.headers.authorization;

    let token = sessionCookie;
    if (!token && authHeader?.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }

    if (token && ctx.sessionService?.verifySession) {
      try {
        const payload = await ctx.sessionService.verifySession(token);
        if (payload) {
          req.user = payload;
        }
      } catch {
        // invalid session token
      }
    }
  });

  const requireAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) {
      return reply
        .code(401)
        .send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }
  };

  // --- Auth Routes ---
  app.get('/v1/auth/login', async (req, reply) => {
    try {
      const { url, state, nonce, codeVerifier } = await ctx.oidcService.startLogin();
      reply.setCookie('oidc_state', JSON.stringify({ state, nonce, codeVerifier }), {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 600,
      });
      return reply.redirect(url.toString());
    } catch (err: any) {
      return reply.internalServerError(`Failed to initiate OIDC login: ${err.message}`);
    }
  });

  app.get<{ Querystring: { code?: string; state?: string } }>(
    '/v1/auth/callback',
    async (req, reply) => {
      try {
        const stateCookie = req.cookies.oidc_state;
        if (!stateCookie) {
          return reply.badRequest('Missing OIDC state cookie');
        }
        const { state, nonce, codeVerifier } = JSON.parse(stateCookie);
        const cleanBaseUrl = ctx.config.baseUrl.replace(/\/+$/, '');
        const currentUrl = new URL(
          `${cleanBaseUrl}${req.url.startsWith('/') ? req.url : `/${req.url}`}`,
        );

        const claims = await ctx.oidcService.handleCallback(currentUrl, state, nonce, codeVerifier);
        const user = await getOrCreateUser(claims.issuer, claims.sub, {
          email: claims.email,
          displayName: claims.name,
        });

        const sessionToken = await ctx.sessionService.signSession({
          userId: user.id,
          oidcIssuer: user.oidcIssuer,
          oidcSub: user.oidcSub,
          email: user.email ?? undefined,
          displayName: user.displayName ?? undefined,
        });

        reply.clearCookie('oidc_state', { path: '/' });
        reply.setCookie('imagehost_session', sessionToken, {
          path: '/',
          httpOnly: true,
          sameSite: 'lax',
          maxAge: 30 * 24 * 3600,
        });

        const targetPath = ctx.config.domainPath ? `${ctx.config.domainPath}/` : '/';
        return reply.redirect(targetPath);
      } catch (err: any) {
        return reply.badRequest(`Authentication callback failed: ${err.message}`);
      }
    },
  );

  app.get('/v1/auth/me', { preHandler: [requireAuth] }, async (req) => {
    return req.user!;
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    reply.clearCookie('imagehost_session', { path: '/' });
    return { ok: true };
  });

  // --- OIDC Back-Channel Logout & Revocation (RFC 8417) ---
  const handleBackchannel = async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = (req.body as Record<string, unknown>) ?? {};
      const logoutToken =
        typeof body.logout_token === 'string'
          ? body.logout_token
          : typeof (req.query as any)?.logout_token === 'string'
            ? (req.query as any).logout_token
            : undefined;

      if (!logoutToken) {
        return reply.code(400).send({ error: 'invalid_request', message: 'Missing logout_token' });
      }

      const oidcIssuer =
        ctx.authorizationOptions?.oidcIssuerUrl !== undefined
          ? ctx.authorizationOptions.oidcIssuerUrl
          : ctx.config.oidcIssuerUrl;

      if (!oidcIssuer) {
        return reply
          .code(400)
          .send({ error: 'invalid_request', message: 'OIDC issuer not configured' });
      }

      await processBackchannelLogout(logoutToken.trim(), {
        oidcIssuer,
        jwksUri: ctx.authorizationOptions?.oidcJwksUri ?? ctx.config.oidcJwksUri,
        oidcClientId: ctx.config.oidcClientId,
        publicUrl: ctx.config.baseUrl,
        sessionService: ctx.sessionService,
        authStore,
        userStore,
        jwks: ctx.authorizationOptions?.jwks,
        resolveUser: ctx.authorizationOptions?.resolveUser,
      });

      return reply.code(200).send({ ok: true });
    } catch (err: any) {
      req.log?.warn?.({ err }, 'Back-channel logout failed');
      return reply.code(400).send({
        error: 'invalid_request',
        message: err.message || 'Back-channel logout failed',
      });
    }
  };

  app.post('/v1/auth/backchannel', handleBackchannel);
  app.post('/oidc/backchannel', handleBackchannel);
  app.post('/mcp/backchannel', handleBackchannel);

  // --- Group Routes ---
  app.get('/v1/groups', { preHandler: [requireAuth] }, async (req) => {
    const list = await ctx.groupService.listGroups(req.user!.userId);
    return { items: list };
  });

  app.post<{ Body: { name: string; description?: string; retentionHours?: number } }>(
    '/v1/groups',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const group = await ctx.groupService.createGroup(req.user!.userId, req.body);
      return reply.code(201).send(group);
    },
  );

  app.get<{ Params: { groupId: string } }>(
    '/v1/groups/:groupId',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const group = await ctx.groupService.getGroup(req.user!.userId, req.params.groupId);
      if (!group) return reply.notFound('Group not found');
      return group;
    },
  );

  app.patch<{
    Params: { groupId: string };
    Body: { name?: string; description?: string; retentionHours?: number };
  }>('/v1/groups/:groupId', { preHandler: [requireAuth] }, async (req, reply) => {
    const updated = await ctx.groupService.updateGroup(
      req.user!.userId,
      req.params.groupId,
      req.body,
    );
    if (!updated) return reply.notFound('Group not found');
    return updated;
  });

  app.get<{
    Params: { groupId: string };
    Querystring: { limit?: number; cursor?: number; includePendingDeletion?: boolean | string };
  }>('/v1/groups/:groupId/images', { preHandler: [requireAuth] }, async (req) => {
    const includePending =
      req.query.includePendingDeletion === true || req.query.includePendingDeletion === 'true';
    return await ctx.imageService.listGroupImages(req.user!.userId, req.params.groupId, {
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      cursor: req.query.cursor ? Number(req.query.cursor) : undefined,
      includePendingDeletion: includePending,
    });
  });

  app.get<{
    Querystring: {
      q?: string;
      groupId?: string;
      tags?: string | string[];
      limit?: number | string;
      cursor?: string;
      includePendingDeletion?: boolean | string;
    };
  }>('/v1/images/search', { preHandler: [requireAuth] }, async (req) => {
    const tagList = req.query.tags
      ? Array.isArray(req.query.tags)
        ? req.query.tags
        : [req.query.tags]
      : undefined;
    const includePending =
      req.query.includePendingDeletion === true || req.query.includePendingDeletion === 'true';

    return await ctx.imageService.searchImages(req.user!.userId, {
      query: req.query.q,
      groupId: req.query.groupId,
      tags: tagList,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      cursor: req.query.cursor,
      includePendingDeletion: includePending,
    });
  });

  // --- Image Routes ---
  app.post<{
    Params: { groupId: string };
    Body: {
      filename: string;
      mediaType: string;
      byteSize: number;
      description?: string;
      tags?: string[];
    };
  }>('/v1/groups/:groupId/uploads', { preHandler: [requireAuth] }, async (req, reply) => {
    const session = await ctx.imageService.createUploadSession(
      req.user!.userId,
      req.params.groupId,
      {
        filename: req.body.filename,
        mediaType: req.body.mediaType,
        byteSize: req.body.byteSize,
        description: req.body.description,
        tagsList: req.body.tags,
      },
    );
    return reply.code(201).send(session);
  });

  app.put<{
    Params: { uploadId: string };
    Querystring: { token?: string };
  }>('/v1/uploads/:uploadId/content', async (req, reply) => {
    let userId = req.user?.userId;

    if (!userId && req.query.token && ctx.sessionService) {
      const verified = await ctx.sessionService.verifyUploadToken(
        req.query.token,
        req.params.uploadId,
      );
      if (verified) {
        userId = verified.userId;
      }
    }

    if (!userId) {
      return reply
        .code(401)
        .send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    const bodyBuffer = req.body as Buffer;
    if (!bodyBuffer || !Buffer.isBuffer(bodyBuffer) || bodyBuffer.length === 0) {
      return reply
        .code(400)
        .send({ error: { code: 'BAD_REQUEST', message: 'Empty upload body' } });
    }

    try {
      const contentType = (req.headers['content-type'] || 'application/octet-stream')
        .split(';')[0]
        .trim();
      await ctx.imageService.saveUploadContent(
        userId,
        req.params.uploadId,
        bodyBuffer,
        contentType,
      );
      return reply.code(200).send({ ok: true });
    } catch (err: any) {
      req.log?.error?.(err, 'Failed to save upload content');
      return reply.code(500).send({ error: { code: 'UPLOAD_FAILED', message: err.message } });
    }
  });

  app.post<{ Params: { uploadId: string } }>(
    '/v1/uploads/:uploadId/complete',
    { preHandler: [requireAuth] },
    async (req) => {
      return await ctx.imageService.completeUpload(req.user!.userId, req.params.uploadId);
    },
  );

  app.get<{ Params: { imageId: string } }>(
    '/v1/images/:imageId',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const image = await ctx.imageService.getImage(req.user!.userId, req.params.imageId);
      if (!image) return reply.notFound('Image not found');
      return image;
    },
  );

  app.patch<{ Params: { imageId: string }; Body: { description?: string } }>(
    '/v1/images/:imageId',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const image = await ctx.imageService.updateDescription(
        req.user!.userId,
        req.params.imageId,
        req.body.description ?? '',
      );
      if (!image) return reply.notFound('Image not found');
      return image;
    },
  );

  app.post<{ Params: { imageId: string }; Body: { tags: string[] } }>(
    '/v1/images/:imageId/tags',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const image = await ctx.imageService.addTags(
        req.user!.userId,
        req.params.imageId,
        req.body.tags,
      );
      if (!image) return reply.notFound('Image not found');
      return image;
    },
  );

  app.delete<{ Params: { imageId: string }; Body: { tags: string[] } }>(
    '/v1/images/:imageId/tags',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const image = await ctx.imageService.removeTags(
        req.user!.userId,
        req.params.imageId,
        req.body.tags,
      );
      if (!image) return reply.notFound('Image not found');
      return image;
    },
  );

  app.post<{ Params: { imageId: string } }>(
    '/v1/images/:imageId/deletion',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const image = await ctx.imageService.requestDeletion(
        req.user!.userId,
        req.params.imageId,
        'user',
      );
      if (!image) return reply.notFound('Image not found');
      return image;
    },
  );

  app.post<{ Params: { imageId: string } }>(
    '/v1/images/:imageId/restore',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const image = await ctx.imageService.restoreImage(req.user!.userId, req.params.imageId);
      if (!image) return reply.notFound('Image not found');
      return image;
    },
  );

  app.get<{
    Params: { imageId: string };
    Querystring: { variant?: 'original' | 'thumbnail' | 'preview'; token?: string };
  }>('/v1/images/:imageId/content', async (req, reply) => {
    const variant = req.query.variant || 'preview';
    let userId = req.user?.userId;

    if (!userId && req.query.token && ctx.sessionService) {
      const verified = await ctx.sessionService.verifyDownloadToken(
        req.query.token,
        req.params.imageId,
        variant,
      );
      if (verified) {
        userId = verified.userId;
      }
    }

    if (!userId) {
      return reply
        .code(401)
        .send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    try {
      const { buffer, mediaType } = await ctx.imageService.getVariantBuffer(
        userId,
        req.params.imageId,
        variant,
      );
      return reply
        .code(200)
        .header('Content-Type', mediaType)
        .header('Cache-Control', 'private, max-age=86400, stale-while-revalidate=3600')
        .send(buffer);
    } catch (err: any) {
      if (err.message === 'Image not found' || err.message?.includes('not found')) {
        return reply.notFound(err.message);
      }
      req.log?.error?.(err, 'Failed to get image variant buffer');
      return reply.internalServerError(err.message);
    }
  });

  app.get<{
    Params: { imageId: string };
    Querystring: { variant?: 'original' | 'thumbnail' | 'preview' };
  }>('/v1/images/:imageId/download-url', { preHandler: [requireAuth] }, async (req) => {
    return await ctx.imageService.getDownloadUrl(
      req.user!.userId,
      req.params.imageId,
      req.query.variant ?? 'preview',
    );
  });

  app.post<{
    Body: { items: Array<{ imageId: string; variant?: 'original' | 'thumbnail' | 'preview' }> };
  }>('/v1/images/batch-download-urls', { preHandler: [requireAuth] }, async (req) => {
    const results = await ctx.imageService.getBatchDownloadUrls(req.user!.userId, req.body.items);
    return { results };
  });

  app.get<{ Querystring: { after?: number | string; limit?: number | string } }>(
    '/v1/changes',
    { preHandler: [requireAuth] },
    async (req) => {
      const afterCursor = req.query.after !== undefined ? Number(req.query.after) : 0;
      const limit = req.query.limit !== undefined ? Number(req.query.limit) : 100;
      return await ctx.imageService.getChanges(req.user!.userId, afterCursor, limit);
    },
  );

  app.get('/v1/config', async () => {
    return {
      brandName: ctx.config.brandName || 'ImageHost',
      baseUrl: ctx.config.baseUrl,
      domainPath: ctx.config.domainPath,
    };
  });

  // --- OAuth & MCP Endpoints ---
  const authStore = ctx.authStore ?? new MemoryAuthStore();
  const userStore = ctx.userStore ?? new DefaultUserStore();
  const jwtSecret = new TextEncoder().encode(ctx.config.sessionSecret);
  const publicUrl = ctx.config.baseUrl;
  const resource = `${publicUrl}/mcp`;

  const oidcIssuerUrl =
    ctx.authorizationOptions?.oidcIssuerUrl !== undefined
      ? ctx.authorizationOptions.oidcIssuerUrl
      : ctx.config.oidcIssuerUrl;
  const oidcJwksUri = ctx.authorizationOptions?.oidcJwksUri ?? ctx.config.oidcJwksUri;

  app.register(async (mcpApp) => {
    await mountOAuthMetadata(mcpApp, publicUrl, { oidcIssuerUrl });
    await mountAuthorizationServer(mcpApp, publicUrl, resource, jwtSecret, authStore, userStore, {
      ...ctx.authorizationOptions,
      oidcIssuerUrl,
      oidcJwksUri,
      brandName: ctx.config.brandName,
    });
    await mountMcpHttp(mcpApp, {
      groupService: ctx.groupService,
      imageService: ctx.imageService,
      subscriptionManager: ctx.subscriptionManager,
      publicUrl,
      jwtSecret,
      resource,
      oidcIssuerUrl,
      oidcJwksUri,
      jwks: ctx.authorizationOptions?.jwks,
      userStore,
      resolveUser: ctx.authorizationOptions?.resolveUser,
    });
  });

  // --- ChatGPT Actions Adapter ---
  registerChatGPTActionRoutes(app, ctx);

  // --- Static Assets (PWA) ---
  const webDist = join(process.cwd(), 'web', 'dist');
  if (existsSync(webDist)) {
    const indexPath = join(webDist, 'index.html');
    const rawIndexHtml = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '';
    const domainPath = ctx.config.domainPath ?? '';
    const baseHref = domainPath ? `${domainPath}/` : '/';
    const brandName = ctx.config.brandName || 'ImageHost';

    let renderedIndexHtml = rawIndexHtml;
    if (rawIndexHtml.includes('<base data-app-base')) {
      renderedIndexHtml = rawIndexHtml.replace(
        /<base data-app-base[^>]*>/,
        `<base data-app-base href="${baseHref}" />`,
      );
    } else if (rawIndexHtml.includes('<head>')) {
      renderedIndexHtml = rawIndexHtml.replace(
        '<head>',
        `<head>\n    <base data-app-base href="${baseHref}" />`,
      );
    }

    renderedIndexHtml = renderedIndexHtml.replace(
      /<title>[^<]*<\/title>/,
      `<title>${brandName} — Photo Library & MCP Bridge</title>`,
    );

    const scriptInjection = `<script>window.__BRAND_NAME__ = ${JSON.stringify(brandName)}; window.__APP_CONFIG__ = { brandName: ${JSON.stringify(brandName)} };</script>`;
    if (renderedIndexHtml.includes('</head>')) {
      renderedIndexHtml = renderedIndexHtml.replace('</head>', `  ${scriptInjection}\n  </head>`);
    } else {
      renderedIndexHtml += `\n${scriptInjection}`;
    }

    app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      index: false,
    });

    const sendIndex = (_req: FastifyRequest, reply: FastifyReply) => {
      reply
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-cache')
        .send(renderedIndexHtml);
    };

    app.get('/', sendIndex);

    app.get('/manifest.json', async (_req, reply) => {
      const manifestPath = join(webDist, 'manifest.json');
      if (existsSync(manifestPath)) {
        try {
          const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
          raw.name = `${brandName} Photo Library`;
          raw.short_name = brandName;
          return reply.type('application/manifest+json').send(JSON.stringify(raw));
        } catch {
          // fallback
        }
      }
      return reply.sendFile('manifest.json');
    });

    app.setNotFoundHandler((req, reply) => {
      if (
        req.url.startsWith('/v1/') ||
        req.url.startsWith('/oauth/') ||
        req.url.startsWith('/.well-known/') ||
        req.url.startsWith('/mcp')
      ) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
      }
      return sendIndex(req, reply);
    });
  }

  return app;
}
