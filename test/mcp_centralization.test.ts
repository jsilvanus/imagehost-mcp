import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { generateKeyPair, SignJWT, type GenerateKeyPairResult } from 'jose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { MemoryAuthStore, DefaultUserStore } from '../src/oauth/storage.js';
import { SessionService } from '../src/auth/session.js';
import { issueAccessToken } from '../src/oauth/jwt.js';
import type { Config } from '../src/config.js';

describe('MCP Centralization & Back-Channel Revocation', () => {
  const publicUrl = 'http://127.0.0.1:3000';
  const oidcIssuerUrl = 'https://id.riihimaenseurakunta.fi/tunnus';
  const oidcClientId = 'kuvarasto';
  const sessionSecret = 'secret-session-secret-key-32-bytes-long!';
  const jwtSecret = new TextEncoder().encode(sessionSecret);

  let keyPair: GenerateKeyPairResult;
  let jwks: () => Promise<any>;
  let app: FastifyInstance;
  let authStore: MemoryAuthStore;
  let userStore: DefaultUserStore;
  let sessionService: SessionService;

  const mockGroupService: any = {
    async listGroups(userId: string) {
      return [{ id: 'group-1', name: 'Test Group', ownerId: userId }];
    },
    async getGroup(userId: string, groupId: string) {
      return { id: groupId, name: 'Test Group', ownerId: userId };
    },
  };

  const mockImageService: any = {
    async listGroupImages(userId: string, groupId: string) {
      return { items: [{ id: 'img-1', groupId, ownerId: userId, originalFilename: 'photo.jpg' }] };
    },
    async getImage(userId: string, imageId: string) {
      return { id: imageId, ownerId: userId, originalFilename: 'photo.jpg' };
    },
    async getDownloadUrl(userId: string, imageId: string, variant: string) {
      return { imageId, variant, url: 'https://s3.example.com/test.jpg' };
    },
    async getChanges(userId: string, afterCursor = 0, limit = 100) {
      return { changes: [], lastCursor: 0 };
    },
  };

  beforeAll(async () => {
    keyPair = await generateKeyPair('RS256');
    jwks = async () => keyPair.publicKey;
  });

  beforeEach(async () => {
    authStore = new MemoryAuthStore();
    userStore = new DefaultUserStore();
    sessionService = new SessionService(sessionSecret);

    userStore.createUser({
      id: 'local-user-uuid',
      name: 'Local User',
      email: 'local@example.com',
      createdAt: Date.now(),
    });

    const config: Config = {
      port: 0,
      host: '127.0.0.1',
      nodeEnv: 'test',
      baseUrl: publicUrl,
      databaseUrl: 'postgres://dummy',
      s3Endpoint: 'http://localhost:9000',
      s3Region: 'us-east-1',
      s3Bucket: 'test-bucket',
      s3AccessKeyId: 'test',
      s3SecretAccessKey: 'test',
      s3ForcePathStyle: true,
      oidcIssuerUrl,
      oidcClientId,
      oidcClientSecret: '',
      sessionSecret,
      imageMaxUploadBytes: 25000000,
      imageMaxPixels: 50000000,
      defaultDeletionRetentionHours: 72,
      signedUrlTtlSeconds: 3600,
    };

    app = buildApp({
      config,
      sessionService,
      oidcService: {} as any,
      storageService: {} as any,
      processor: {} as any,
      groupService: mockGroupService,
      imageService: mockImageService,
      authStore,
      userStore,
      authorizationOptions: {
        oidcIssuerUrl,
        jwks,
        resolveUser: async (sub: string) => (sub === 'tunnus-sub-123' ? 'resolved-user-id' : sub),
        fetchClientMetadata: async (clientId: string) => ({
          client_id: clientId,
          client_name: 'Test Client',
          redirect_uris: ['https://client.example/callback'],
        }),
      },
    });

    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  async function createTunnusToken(overrides: {
    sub?: string;
    aud?: string | string[];
    iss?: string;
    scope?: string;
    client_id?: string;
  } = {}) {
    return new SignJWT({
      scope: overrides.scope ?? 'mcp images:read',
      client_id: overrides.client_id ?? 'test-client',
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(overrides.iss ?? oidcIssuerUrl)
      .setAudience(overrides.aud ?? `${publicUrl}/mcp`)
      .setSubject(overrides.sub ?? 'tunnus-sub-123')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(keyPair.privateKey);
  }

  async function createLogoutToken(overrides: {
    sub?: string;
    sid?: string;
    aud?: string | string[];
    iss?: string;
    nonce?: string;
    events?: Record<string, unknown>;
  } = {}) {
    const builder = new SignJWT({
      events: overrides.events ?? {
        'http://schemas.openid.net/event/backchannel-logout': {},
      },
      ...(overrides.nonce ? { nonce: overrides.nonce } : {}),
      ...(overrides.sid ? { sid: overrides.sid } : {}),
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(overrides.iss ?? oidcIssuerUrl)
      .setAudience(overrides.aud ?? oidcClientId)
      .setIssuedAt()
      .setExpirationTime('5m');

    if (overrides.sub !== undefined) {
      builder.setSubject(overrides.sub);
    } else if (!overrides.sid) {
      builder.setSubject('tunnus-sub-123');
    }

    return builder.sign(keyPair.privateKey);
  }

  describe('Requirement 1: RFC 9728 Protected Resource Metadata', () => {
    it('advertises authorization_servers pointing to Tunnus when oidcIssuerUrl is configured', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/.well-known/oauth-protected-resource',
      });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.resource).toBe(`${publicUrl}/mcp`);
      expect(data.authorization_servers).toEqual([oidcIssuerUrl]);
      expect(data.scopes_supported).toContain('images:read');
      expect(data.scopes_supported).toContain('mcp');

      const resMcp = await app.inject({
        method: 'GET',
        url: '/.well-known/oauth-protected-resource/mcp',
      });
      expect(resMcp.statusCode).toBe(200);
      const dataMcp = resMcp.json();
      expect(dataMcp.resource).toBe(`${publicUrl}/mcp`);
      expect(dataMcp.authorization_servers).toEqual([oidcIssuerUrl]);
    });

    it('falls back to publicUrl when oidcIssuerUrl is unset', async () => {
      const fallbackApp = buildApp({
        config: {
          port: 0,
          host: '127.0.0.1',
          nodeEnv: 'test',
          baseUrl: publicUrl,
          databaseUrl: 'postgres://dummy',
          s3Endpoint: 'http://localhost:9000',
          s3Region: 'us-east-1',
          s3Bucket: 'test-bucket',
          s3AccessKeyId: 'test',
          s3SecretAccessKey: 'test',
          s3ForcePathStyle: true,
          oidcIssuerUrl: undefined,
          oidcClientId,
          sessionSecret,
          imageMaxUploadBytes: 25000000,
          imageMaxPixels: 50000000,
          defaultDeletionRetentionHours: 72,
          signedUrlTtlSeconds: 3600,
        },
        sessionService,
        oidcService: {} as any,
        storageService: {} as any,
        processor: {} as any,
        groupService: mockGroupService,
        imageService: mockImageService,
        authStore,
        userStore,
        authorizationOptions: {
          oidcIssuerUrl: undefined,
        },
      });
      await fallbackApp.ready();

      const res = await fallbackApp.inject({
        method: 'GET',
        url: '/.well-known/oauth-protected-resource',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().authorization_servers).toEqual([publicUrl]);

      await fallbackApp.close();
    });
  });

  describe('Requirement 2: Non-Destructive OAuth Relay', () => {
    it('redirects GET /oauth/authorize to Tunnus /auth preserving query params and adding resource', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/oauth/authorize?response_type=code&client_id=https://client.example/oauth/client.json&redirect_uri=https://client.example/callback&code_challenge=xyz&code_challenge_method=S256&scope=mcp&state=state-123',
      });

      expect(res.statusCode).toBe(302);
      const location = new URL(res.headers.location as string);
      expect(location.origin + location.pathname).toBe(`${oidcIssuerUrl}/auth`);
      expect(location.searchParams.get('client_id')).toBe('https://client.example/oauth/client.json');
      expect(location.searchParams.get('redirect_uri')).toBe('https://client.example/callback');
      expect(location.searchParams.get('code_challenge')).toBe('xyz');
      expect(location.searchParams.get('code_challenge_method')).toBe('S256');
      expect(location.searchParams.get('scope')).toBe('mcp');
      expect(location.searchParams.get('state')).toBe('state-123');
      expect(location.searchParams.get('resource')).toBe(`${publicUrl}/mcp`);
    });

    it('falls back to local sign-in page on GET /oauth/authorize when local=true is specified', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/oauth/authorize?response_type=code&client_id=https://client.example/oauth/client.json&redirect_uri=https://client.example/callback&code_challenge=xyz&code_challenge_method=S256&local=true',
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('Sign in to ImageHost');
    });

    it('relays POST /oauth/token to Tunnus when code is not in local store', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'tunnus-relayed-access-token',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/oauth/token',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'tunnus-issued-code',
          client_id: 'https://client.example/oauth/client.json',
          redirect_uri: 'https://client.example/callback',
          code_verifier: 'test-verifier',
        }).toString(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().access_token).toBe('tunnus-relayed-access-token');
      expect(fetchSpy).toHaveBeenCalled();
      const [calledUrl, calledOpts] = fetchSpy.mock.calls[0];
      expect(calledUrl).toBe(`${oidcIssuerUrl}/token`);
      expect((calledOpts?.body as string).includes('resource=')).toBe(true);
      fetchSpy.mockRestore();
    });

    it('exchanges POST /oauth/token locally if code exists in local authStore', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const verifier = 'test-verifier-string-12345';
      const challenge = createHash('sha256').update(verifier).digest('base64url');

      authStore.saveAuthorizationCode({
        code: 'local-code-abc',
        clientId: 'https://client.example/oauth/client.json',
        redirectUri: 'https://client.example/callback',
        challenge,
        subject: 'local-user-uuid',
        scope: 'images:read mcp',
        expires: Date.now() + 60000,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/oauth/token',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'local-code-abc',
          client_id: 'https://client.example/oauth/client.json',
          redirect_uri: 'https://client.example/callback',
          code_verifier: verifier,
        }).toString(),
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.access_token).toBeDefined();
      expect(data.refresh_token).toBeDefined();
      // Should not call remote fetch because code is local
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  });

  describe('Requirement 3: Dual-Layer Token Verification in /mcp', () => {
    it('accepts valid RS256 token from Tunnus (primary layer) and executes tool', async () => {
      const token = await createTunnusToken({
        sub: 'tunnus-sub-123',
        scope: 'mcp images:read',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'get_changes',
            arguments: { cursor: 0, limit: 10 },
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const text = res.body;
      const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
      expect(dataLine).toBeDefined();
      const message = JSON.parse(dataLine!.slice(6));
      expect(message.result).toBeDefined();
      expect(message.result.isError).toBeFalsy();
    });

    it('falls back to local HS256 token verification (fallback layer) and executes tool', async () => {
      const localToken = await issueAccessToken(
        jwtSecret,
        publicUrl,
        `${publicUrl}/mcp`,
        'local-user-uuid',
        'https://client.example/oauth/client.json',
        'images:read mcp',
      );

      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          authorization: `Bearer ${localToken}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        payload: {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'get_changes',
            arguments: { cursor: 0, limit: 10 },
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const text = res.body;
      const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
      expect(dataLine).toBeDefined();
      const message = JSON.parse(dataLine!.slice(6));
      expect(message.result).toBeDefined();
    });

    it('rejects token with invalid audience with 401', async () => {
      const wrongAudToken = await createTunnusToken({
        aud: 'https://other-service.example.com',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          authorization: `Bearer ${wrongAudToken}`,
          'content-type': 'application/json',
        },
        payload: { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      });

      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toContain('invalid_token');
    });

    it('rejects token signed with unknown RS256 key with 401', async () => {
      const rogueKeys = await generateKeyPair('RS256');
      const untrustedToken = await new SignJWT({ scope: 'mcp images:read' })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(oidcIssuerUrl)
        .setAudience(`${publicUrl}/mcp`)
        .setSubject('rogue-user')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(rogueKeys.privateKey);

      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          authorization: `Bearer ${untrustedToken}`,
          'content-type': 'application/json',
        },
        payload: { jsonrpc: '2.0', id: 4, method: 'tools/list' },
      });

      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toContain('invalid_token');
    });
  });

  describe('Requirement 4: OIDC Back-Channel Logout & Revocation (RFC 8417)', () => {
    it('verifies logout_token, returns 200 { ok: true }, and revokes web sessions & refresh tokens', async () => {
      // 1. Establish an active browser session token
      const sessionToken = await sessionService.signSession({
        userId: 'resolved-user-id',
        oidcIssuer: oidcIssuerUrl,
        oidcSub: 'tunnus-sub-123',
        email: 'user@example.com',
      });
      const validBefore = await sessionService.verifySession(sessionToken);
      expect(validBefore).not.toBeNull();

      // 2. Establish a refresh token in authStore
      authStore.saveRefreshToken({
        token: 'active-refresh-token-123',
        clientId: 'https://client.example/oauth/client.json',
        subject: 'resolved-user-id',
        scope: 'images:read mcp',
        expires: Date.now() + 30 * 86400000,
      });
      expect(authStore.getRefreshToken('active-refresh-token-123')).toBeDefined();

      // 3. Send OIDC backchannel logout token
      const logoutToken = await createLogoutToken({
        sub: 'tunnus-sub-123',
        aud: oidcClientId,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/backchannel',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ logout_token: logoutToken }).toString(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });

      // 4. Assert session is now revoked
      const validAfter = await sessionService.verifySession(sessionToken);
      expect(validAfter).toBeNull();

      // 5. Assert refresh token is now revoked
      expect(authStore.getRefreshToken('active-refresh-token-123')).toBeUndefined();
    });

    it('accepts tunnus mcp-revoke event in logout_token', async () => {
      const logoutToken = await createLogoutToken({
        sub: 'tunnus-sub-123',
        events: { 'https://tunnus.fi/event/mcp-revoke': {} },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/backchannel',
        headers: { 'Content-Type': 'application/json' },
        payload: { logout_token: logoutToken },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    });

    it('rejects logout_token containing a nonce (RFC 8417 section 2.4)', async () => {
      const logoutTokenWithNonce = await createLogoutToken({
        sub: 'tunnus-sub-123',
        nonce: 'forbidden-nonce',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/backchannel',
        headers: { 'Content-Type': 'application/json' },
        payload: { logout_token: logoutTokenWithNonce },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_request');
      expect(res.json().message).toContain('nonce');
    });

    it('rejects logout_token missing backchannel events claim', async () => {
      const invalidEventToken = await createLogoutToken({
        events: { 'http://example.com/other-event': {} },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/backchannel',
        headers: { 'Content-Type': 'application/json' },
        payload: { logout_token: invalidEventToken },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_request');
      expect(res.json().message).toContain('events');
    });

    it('rejects logout_token with wrong audience', async () => {
      const wrongAudLogoutToken = await createLogoutToken({
        aud: 'completely-wrong-client',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/backchannel',
        headers: { 'Content-Type': 'application/json' },
        payload: { logout_token: wrongAudLogoutToken },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_request');
    });

    it('supports alias endpoints /oidc/backchannel and /mcp/backchannel', async () => {
      const logoutToken = await createLogoutToken({ sub: 'tunnus-sub-123' });

      const resOidc = await app.inject({
        method: 'POST',
        url: '/oidc/backchannel',
        headers: { 'Content-Type': 'application/json' },
        payload: { logout_token: logoutToken },
      });
      expect(resOidc.statusCode).toBe(200);

      const resMcp = await app.inject({
        method: 'POST',
        url: '/mcp/backchannel',
        headers: { 'Content-Type': 'application/json' },
        payload: { logout_token: logoutToken },
      });
      expect(resMcp.statusCode).toBe(200);
    });
  });
});
