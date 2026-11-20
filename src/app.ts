import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import sensible from '@fastify/sensible';
import fastifyStatic from '@fastify/static';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import { SessionService } from './auth/session.js';
import { OidcClientService } from './auth/oidc.js';
import { getOrCreateUser } from './auth/users.js';
import { S3StorageService } from './storage/s3.js';
import { ImageProcessor } from './services/image-processor.js';
import { GroupService } from './services/group-service.js';
import { ImageService } from './services/image-service.js';
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

export interface AppContext {
  config: Config;
  sessionService: SessionService;
  oidcService: OidcClientService;
  storageService: S3StorageService;
  processor: ImageProcessor;
  groupService: GroupService;
  imageService: ImageService;
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
  const app = Fastify({ logger: ctx.config.nodeEnv !== 'test' });

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

  // Health check
  app.get('/healthz', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

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
        const currentUrl = new URL(req.url, ctx.config.baseUrl);

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

        return reply.redirect('/');
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

  app.get<{ Querystring: { after?: number; limit?: number } }>(
    '/v1/changes',
    { preHandler: [requireAuth] },
    async (req) => {
      return await ctx.imageService.getChanges(
        req.user!.userId,
        req.query.after ?? 0,
        req.query.limit ?? 100,
      );
    },
  );

  // --- OAuth & MCP Endpoints ---
  const authStore = ctx.authStore ?? new MemoryAuthStore();
  const userStore = ctx.userStore ?? new DefaultUserStore();
  const jwtSecret = new TextEncoder().encode(ctx.config.sessionSecret);
  const publicUrl = ctx.config.baseUrl;
  const resource = `${publicUrl}/mcp`;

  app.register(async (mcpApp) => {
    await mountOAuthMetadata(mcpApp, publicUrl);
    await mountAuthorizationServer(
      mcpApp,
      publicUrl,
      resource,
      jwtSecret,
      authStore,
      userStore,
      ctx.authorizationOptions,
    );
    await mountMcpHttp(mcpApp, {
      groupService: ctx.groupService,
      imageService: ctx.imageService,
      publicUrl,
      jwtSecret,
      resource,
    });
  });

  // --- Static Assets (PWA) ---
  const webDist = join(process.cwd(), 'web', 'dist');
  if (existsSync(webDist)) {
    app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
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
      return reply.sendFile('index.html');
    });
  }

  return app;
}
