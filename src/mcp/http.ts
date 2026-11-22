import type { IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { JWTVerifyGetKey } from 'jose';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createMcpServer, type McpServerOptions } from './server.js';
import { verifyAccessToken } from '../oauth/jwt.js';
import type { SubscriptionManager } from '../services/subscription-manager.js';
import type { UserStore } from '../oauth/storage.js';
import { verifyTunnusToken } from '../auth/jwt-verify.js';

export interface McpHttpOptions {
  groupService: McpServerOptions['groupService'];
  imageService: McpServerOptions['imageService'];
  publicUrl: string;
  jwtSecret: Uint8Array;
  resource: string;
  requireAuth?: boolean;
  subscriptionManager?: SubscriptionManager;
  oidcIssuerUrl?: string;
  oidcJwksUri?: string;
  jwks?: JWTVerifyGetKey;
  userStore?: UserStore;
  resolveUser?: (
    sub: string,
    issuer?: string,
    claims?: Record<string, unknown>,
  ) => Promise<string | null>;
}

export function wwwAuthenticate(publicUrl: string, error?: string): string {
  return (
    'Bearer resource_metadata="' +
    publicUrl +
    '/.well-known/oauth-protected-resource/mcp", scope="images:read"' +
    (error
      ? ', error="' +
        error +
        '", error_description="The access token is missing, expired or invalid."'
      : '')
  );
}

function methodNotAllowed() {
  return {
    jsonrpc: '2.0' as const,
    error: { code: -32000, message: 'Method not allowed.' },
    id: null,
  };
}

export async function mountMcpHttp(app: FastifyInstance, options: McpHttpOptions): Promise<void> {
  app.post('/mcp', async (request, reply) => {
    let authInfo: AuthInfo | undefined;
    const header = request.headers.authorization;

    const requireAuth = options.requireAuth ?? true;
    const challenge = (error?: string) =>
      reply
        .code(401)
        .header('WWW-Authenticate', wwwAuthenticate(options.publicUrl, error))
        .send({ error: error ?? 'unauthorized' });

    if (requireAuth && !header?.startsWith('Bearer ')) return challenge();

    if (header?.startsWith('Bearer ')) {
      const token = header.slice('Bearer '.length).trim();
      let verified = false;

      // 1. Primary layer: RS256 token verification via Tunnus OIDC if configured
      if (options.oidcIssuerUrl) {
        try {
          const tunnusAuth = await verifyTunnusToken(token, {
            oidcIssuer: options.oidcIssuerUrl,
            jwksUri: options.oidcJwksUri,
            publicUrl: options.publicUrl,
            jwks: options.jwks,
            userStore: options.userStore,
            resolveUser: options.resolveUser,
          });

          authInfo = {
            token,
            clientId: tunnusAuth.clientId,
            scopes: tunnusAuth.scopes,
            extra: {
              userId: tunnusAuth.userId,
              ...tunnusAuth.extra,
            },
          };
          verified = true;
        } catch {
          // RS256 failed or token is local HS256, fall through to local fallback
        }
      }

      // 2. Fallback layer: local HS256 token verification
      if (!verified) {
        try {
          const { payload } = await verifyAccessToken(
            options.jwtSecret,
            options.publicUrl,
            options.resource,
            token,
          );
          authInfo = {
            token,
            clientId: typeof payload.client_id === 'string' ? payload.client_id : 'oauth-client',
            scopes: typeof payload.scope === 'string' ? payload.scope.split(' ') : [],
            extra: {
              ...(typeof payload.sub === 'string' ? { userId: payload.sub } : {}),
            },
          };
        } catch {
          return challenge('invalid_token');
        }
      }
    }

    const server = createMcpServer({
      groupService: options.groupService,
      imageService: options.imageService,
      publicUrl: options.publicUrl,
      subscriptionManager: options.subscriptionManager,
    });
    const transport = new StreamableHTTPServerTransport({});
    await server.connect(transport as unknown as Transport);

    reply.hijack();
    reply.raw.on('close', () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });

    const rawRequest = request.raw as IncomingMessage & { auth?: AuthInfo };
    if (authInfo) rawRequest.auth = authInfo;
    await transport.handleRequest(rawRequest, reply.raw, request.body);
  });

  app.head('/mcp', async (_request, reply) => reply.code(200).send());
  app.get('/mcp', async (_request, reply) => reply.code(405).send(methodNotAllowed()));
  app.delete('/mcp', async (_request, reply) => reply.code(405).send(methodNotAllowed()));
}
